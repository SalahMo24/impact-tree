'use strict';
// Tier A: build the impact tree for a pull request without checking it out.
//
// Everything comes from the GitHub API -- the file list, the patch, and the head and
// base text of each changed file. Nothing is read from the worktree, so the branch
// you are on is irrelevant and nothing is written.
//
// The result deliberately has the same shape as analyze()'s, so the tree provider,
// decorations and review state all work unchanged. The one thing that differs is
// `tierA: true` and `coverage`, which the view uses to say out loud that callers
// outside the PR are invisible here.
const path = require('path');
const { createHash } = require('crypto');
const { score } = require('./signature');
const { changedSymbolKeys } = require('./changed-symbols');
// TypeScript/JavaScript only (gate L2): the symbols come from the TypeScript provider.
const { changedSymbolsWith } = require('../languages/typescript/provider');
const { createSyntacticIndex } = require('./syntactic-index');
const { createSyntacticResolver } = require('./resolver-syntactic');
const { hunkRangesFromPatch, hunkDeletionsFromPatch } = require('./patch');
const { diffLinesFromPatch } = require('./diff-lines');
const { isTestPath, isTestFile } = require('./diff');
// The preview analyses TypeScript/JavaScript (gate L2), and the languages that can be read
// from their text alone (`prepareSyntactic`: Python; changed functions and kinds, callers
// not computed, A4). A file of another language (Go) is listed as a file that was not
// analysed, with the reason (`notAnalysed`), so it never reads as a file with no impact.
const { typescriptRules } = require('../languages/typescript/rules');
const isSourcePath = typescriptRules.handles;
const { languageFor } = require('../languages');
/**
 * The language that reads a non-TypeScript file from its text, or null.
 * @param {string} filePath
 */
const textLanguageOf = (filePath) => {
  if (isSourcePath(filePath)) return null;
  const language = languageFor(filePath);
  return language && language.prepareSyntactic ? language : null;
};
const { seedRoots, nestedIds } = require('./forest');
const { registerVirtualText, readLineOfOffset } = require('./textpos');
const { classifyCallSiteUpdates, classifyCallerUpdateState } = require('./call-sites');
const { mapLimit } = require('./concurrency');
const { validateConcurrency, validateTierAMaxFiles, validateReachDepth } = require('./settings');
const { walkTestReach, DEFAULT_REACH_BUDGET } = require('./test-reach');
const { throwIfCancelled } = require('./cancellation');

// GitHub's file status is not the engine's. `removed` is a deletion, `copied` is a
// new path, `changed` is a mode-only edit. Anything else (including `unchanged`)
// is left as-is so it does not pick up a badge it did not earn.
const normaliseStatus = (s) => {
  if (s === 'removed') return 'deleted';
  if (s === 'copied') return 'added';
  if (s === 'changed') return 'modified';
  return s;
};

/**
 * Builds a pull request's impact tree from the GitHub API alone; see the file comment.
 *
 * `signal` cancels the preview. It is checked after every request and between caller
 * queries, and no further file fetch starts once it is aborted; requests already sent
 * are not interrupted (deadlines and abortable requests belong to the GitHub boundary).
 * @param {object} args
 * @param {object} args.ts The TypeScript module that parses the PR's files.
 * @param {object} args.gh GitHub client: `listPullRequestFiles` and `fileAtRef`, with
 *   optional `getPullRequest` and `mergeBase`.
 * @param {object} args.slug `{ owner, repo }` of the repository.
 * @param {object} args.pr The pull request; refreshed through `gh.getPullRequest` when available.
 * @param {string} args.repoRoot Absolute path the PR's repository-relative paths are joined to.
 * @param {number} [args.maxFiles=300] Files listed at most, 1..3000; an invalid value warns and
 *   uses 300, one above 3000 warns and uses 3000.
 * @param {number} [args.concurrency] Parallel file fetches, 1..32; an invalid value warns and uses 8.
 * @param {(event: {phase: string, message: string, done?: number, total?: number}) => void} [args.onProgress]
 * @param {(result: object) => Promise<void>|void} [args.onPrepared] Changed rows and pinned
 *   diff texts, published before configuration fetching and caller analysis.
 * @param {(message: string) => void} [args.trace]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<object>} The same shape as analyze()'s result, with `tierA: true`; `outside`
 *   (see analyze()) is computed from the PR's patch and fetched texts. `diffLines` comes
 *   from GitHub's patches as they are, for every listed file with a patch, tests and
 *   non-source files included.
 * @throws {import('./cancellation').AnalysisCancelledError} `signal` was aborted. No result is returned.
 */
async function analyzeRemote({
  ts, gh, slug, pr, repoRoot,
  maxFiles, concurrency, onProgress = () => {}, onPrepared, trace = () => {}, signal,
}) {
  if (!ts) throw new Error('Preview needs TypeScript to parse the PR files');
  throwIfCancelled(signal);
  const warnings = [];
  const fileLimit = validateTierAMaxFiles(maxFiles, warnings);
  const workers = validateConcurrency(concurrency, warnings);
  const reachDepth = validateReachDepth(undefined, warnings);
  if (gh.getPullRequest) pr = await gh.getPullRequest(slug, pr.number, { signal });
  throwIfCancelled(signal);
  const mergeBaseSha = pr.mergeBaseSha || (gh.mergeBase && await gh.mergeBase(slug, pr.baseSha, pr.headSha, { signal }));
  throwIfCancelled(signal);
  if (!mergeBaseSha) throw new Error('Cannot preview this PR without its merge base');
  pr = { ...pr, mergeBaseSha };


  trace(`PR #${pr.number}  head=${String(pr.headSha).slice(0, 8)}  base=${pr.baseRef}@${String(pr.baseSha || '?').slice(0, 8)}`);
  onProgress({ phase: 'files', message: `listing files in #${pr.number}` });
  const listed = await gh.listPullRequestFiles(slug, pr.number, { max: fileLimit, signal });
  throwIfCancelled(signal);
  if (gh.getPullRequest) {
    const after = await gh.getPullRequest(slug, pr.number, { signal });
    throwIfCancelled(signal);
    if (after.headSha !== pr.headSha || after.baseSha !== pr.baseSha) {
      throw new Error('The PR changed while its files were loading. Refresh to analyse the new revision.');
    }
  }
  if (listed.truncated || pr.changedFiles > listed.files.length) {
    warnings.push(`PR has ${pr.changedFiles ?? `${listed.totalIsLowerBound ? "at least " : ""}${listed.total}`} files; analysing the first ${fileLimit} (impactTree.tierA.maxFiles)`);
  }

  trace(`${listed.files.length} file(s) listed${listed.truncated ? ' (truncated)' : ''}`);
  const sourceFiles = listed.files.filter((f) => (isSourcePath(f.path) || textLanguageOf(f.path)) && !isTestPath(f.path));
  // Test files the PR changed are read at the head only, to be indexed as callers. They are
  // never diffed, so no symbol of theirs becomes a change (as locally), and they stay in
  // `otherFiles`. They are already within the listed-file budget; tests the PR does not
  // touch are never fetched.
  const testFiles = listed.files.filter((f) => isSourcePath(f.path) && isTestPath(f.path) && normaliseStatus(f.status) !== 'deleted');
  trace(`${sourceFiles.length} analysable source file(s); ${testFiles.length} test file(s) read as callers; ${listed.files.length - sourceFiles.length} other`);
  // Nothing of these files is fetched, so their review identity comes from what GitHub
  // listed: the blob id and the patch. `contentId` is null when it gave neither.
  const otherFiles = listed.files
    .filter((f) => !sourceFiles.includes(f))
    .map((f) => ({ path: f.path, status: normaliseStatus(f.status), contentId: listedContentId(f), ...notAnalysedIn(f.path) }));
  // Every tab needs the pre-rename base path, including docs/config-only previews
  // whose files are fetched on demand rather than parsed by this analysis.
  const basePaths = Object.fromEntries(listed.files.filter((f) => f.oldPath && f.oldPath !== f.path).map((f) => [f.path, f.oldPath]));
  // The lines of GitHub's own hunks, where review comments can go, for every listed file
  // GitHub gave a patch for (none for a binary file or one too large to diff).
  const diffLines = Object.fromEntries(listed.files.filter((f) => f.patch).map((f) => [f.path, diffLinesFromPatch(f.patch)]));

  if (!sourceFiles.length) {
    // Nothing changed to find callers of, so there is no test to look for either.
    return { ...emptyResult(pr, listed, otherFiles, warnings, workers, basePaths), diffLines };
  }

  // ---- fetch head and base text -------------------------------------------------
  // Two requests per file. Added files have no base; deleted files have no head.
  const fetchTotal = sourceFiles.length + testFiles.length;
  onProgress({ phase: 'fetch', message: `fetching ${fetchTotal} file(s)`, done: 0, total: fetchTotal });
  let fetched = 0;
  // One catch around both sides would blame the head fetch for a base failure and
  // null them together -- which is what turned every modified file into an "added"
  // one with no signature to diff against, hence no findings at all.
  const grab = async (which, filePath, ref) => {
    if (!ref) { warnings.push(`${filePath}: no ${which} ref to fetch from`); return null; }
    try {
      const t = await gh.fileAtRef(slug, filePath, ref, { signal });
      if (t == null) trace(`${which} 404  ${filePath}@${String(ref).slice(0, 8)}`);
      else trace(`${which} ${String(t.length).padStart(7)}b  ${filePath}@${String(ref).slice(0, 8)}`);
      return t;
    } catch (e) {
      warnings.push(`${filePath}: ${which} fetch failed — ${e.message}`);
      trace(`${which} FAIL ${filePath}: ${e.message}`);
      return null;
    }
  };

  const contents = await mapLimit(sourceFiles, workers, async (f) => {
    const status = normaliseStatus(f.status);
    const [headText, baseText] = await Promise.all([
      status === 'deleted' ? null : grab('head', f.path, pr.headSha),
      status === 'added' ? null : grab('base', f.oldPath || f.path, mergeBaseSha),
    ]);
    onProgress({ phase: 'fetch', message: 'fetching files', done: ++fetched, total: fetchTotal });
    return { ...f, status, headText, baseText };
  }, { signal });
  const testContents = await mapLimit(testFiles, workers, async (f) => {
    const headText = await grab('head', f.path, pr.headSha);
    onProgress({ phase: 'fetch', message: 'fetching files', done: ++fetched, total: fetchTotal });
    return { path: f.path, headText };
  }, { signal });
  // Checked again before anything is registered: this run may have been replaced while
  // the last fetch was resolving, and its text must not stand in for the newer run's.
  throwIfCancelled(signal);

  // Without base text a modified file looks brand new, so every symbol collapses to a
  // body-only change and the Findings section comes back empty. That is a failure, not
  // a result, and it has to be said rather than inferred from an empty tree.
  const missingBase = contents.filter((f) => f.status === 'modified' && f.baseText == null);
  if (missingBase.length) {
    warnings.push(`${missingBase.length} modified file(s) had no base revision — `
      + 'signature changes cannot be detected for them, so they show as body-only edits');
  }
  const missingHead = contents.filter((f) => f.status !== 'deleted' && f.headText == null);
  if (missingHead.length) {
    warnings.push(`${missingHead.length} file(s) could not be fetched at the PR head and were skipped`);
  }

  const missingTests = testContents.filter((f) => f.headText == null);
  if (missingTests.length) {
    warnings.push(`${missingTests.length} test file(s) in the PR could not be fetched at the PR head — callers in them are not shown`);
  }

  // Absolute-looking paths keyed off the workspace root keep every downstream
  // consumer (decorations, review ids, the tree's rel()) working unchanged, even
  // though these files may not exist on disk at these paths.
  const abs = (rel) => path.join(repoRoot, rel);
  const changedRanges = {};
  const usable = contents.filter((f) => f.headText != null || f.status === 'deleted');
  for (const f of usable) if (f.headText != null) registerVirtualText(abs(f.path), f.headText);
  const readTests = testContents.filter((f) => f.headText != null);
  for (const f of readTests) registerVirtualText(abs(f.path), f.headText);
  for (const f of testFiles) changedRanges[f.path] = hunkRangesFromPatch(f.patch);

  // ---- symbols -------------------------------------------------------------------
  const symbolsOf = changedSymbolsWith(ts);
  const changed = [];
  const deleted = [];
  const outside = [];
  // Rows of a language read from its text, and the resolver that answers for them
  // (callers not computed); every other row is answered by the PR's syntactic index.
  const rowResolvers = new Map();
  const reviewSymbols = new Map();
  const callersNotComputed = [];
  const byTextLanguage = new Map();
  for (const f of usable) {
    const ranges = hunkRangesFromPatch(f.patch);
    changedRanges[f.path] = ranges;
    if (!ranges.length && f.status !== 'deleted' && !f.patch && f.headText !== f.baseText) {
      warnings.push(`${f.path}: GitHub returned no patch (binary or too large) — symbols not mapped`);
    }
    const textLanguage = textLanguageOf(f.path);
    if (textLanguage) {
      if (!byTextLanguage.has(textLanguage)) byTextLanguage.set(textLanguage, []);
      byTextLanguage.get(textLanguage).push(f);
      continue;
    }
    const r = symbolsOf({
      absPath: abs(f.path), relPath: f.path, status: f.status,
      headText: f.headText, baseText: f.baseText,
      hunkRanges: ranges, hunkDeletions: hunkDeletionsFromPatch(f.patch),
      component: 'pull request', projectRoot: null,
    });
    changed.push(...r.changed);
    deleted.push(...r.deleted);
    if (r.outside.length) outside.push({ file: abs(f.path), relPath: f.path, ranges: r.outside });
    trace(`${f.path}: ${ranges.length} hunk(s), `
      + `head=${f.headText ? f.headText.length : 0}b base=${f.baseText ? f.baseText.length : 0}b `
      + `-> ${r.changed.length} changed, ${r.deleted.length} deleted symbol(s)`);
  }

  const notAnalysedPaths = new Set();
  for (const [language, own] of byTextLanguage) {
    throwIfCancelled(signal);
    const unanalysable = new Map();
    const notAnalysedFiles = new Map();
    const answer = await language.prepareSyntactic({
      repo: repoRoot, git: null,
      files: own.map((f) => ({ path: f.path, status: f.status, ...(f.oldPath && f.oldPath !== f.path ? { oldPath: f.oldPath } : {}) })),
      baseTexts: new Map(own.filter((f) => f.baseText != null).map((f) => [f.oldPath || f.path, f.baseText])),
      headTexts: new Map(own.filter((f) => f.headText != null).map((f) => [f.path, f.headText])),
      changedRanges: Object.fromEntries(own.map((f) => [f.path, changedRanges[f.path]])),
      deletions: Object.fromEntries(own.map((f) => [f.path, hunkDeletionsFromPatch(f.patch)])),
      warnings, unanalysable, notAnalysedFiles, report: () => {}, signal, hooks: {},
      unit: { component: 'pull request', projectRoot: '' },
    });
    for (const unit of answer.units) {
      for (const c of unit.changed) rowResolvers.set(c, unit.resolver);
      changed.push(...unit.changed);
      deleted.push(...unit.deleted);
      outside.push(...unit.outside);
    }
    for (const [relPath, sides] of (answer.extras && answer.extras.reviewSymbols) || []) reviewSymbols.set(relPath, sides);
    for (const [p, reason] of notAnalysedFiles) {
      notAnalysedPaths.add(p);
      const f = own.find((x) => x.path === p);
      otherFiles.push({ path: p, status: f ? f.status : 'modified', notAnalysed: { language: language.displayName, reason } });
    }
    if (answer.units.length) callersNotComputed.push(language.displayName);
    trace(`${own.length} ${language.displayName} file(s) read from their text; callers not computed`);
  }

  // A module file, a barrel, a const map of error codes: real changes with no changed
  // callable. Analysing them yields nothing, and until now they then appeared nowhere
  // at all -- a PR review tool that silently omits changed files is worse than one
  // that shows them plainly, so they join the file list.
  const withSymbols = new Set([...changed, ...deleted].map((c) => c.relPath));
  const noCallable = usable
    .filter((f) => !withSymbols.has(f.path) && !notAnalysedPaths.has(f.path))
    .map((f) => ({ path: f.path, status: f.status, noCallable: true }));
  if (noCallable.length) trace(`${noCallable.length} changed source file(s) have no changed callable`);
  otherFiles.push(...noCallable);

  // The fetched text is the only copy of these revisions we have; the diff views read
  // it back rather than the worktree, which is on an unrelated branch.
  const texts = new Map();
  for (const f of usable) texts.set(f.path, { head: f.headText, base: f.baseText });

  require('./pending-analysis').initialisePending(changed);
  if (onPrepared) {
    await onPrepared(require('./pending-analysis').snapshot(makeResult(true, null)));
    throwIfCancelled(signal);
  }

  // ---- callers, from the PR's own files only --------------------------------------
  trace(`total ${changed.length} changed symbol(s), ${deleted.length} deleted`);
  const indexed = [...usable.filter((f) => f.headText != null && isSourcePath(f.path)), ...readTests];
  onProgress({ phase: 'index', message: `indexing ${indexed.length} file(s)` });
  const config = require('./remote-config');
  const [moduleOptions, packages] = await Promise.all([
    config.remoteOptions(ts, gh, slug, pr.headSha, repoRoot, indexed.map(f => f.path), warnings, signal),
    config.remotePackages(gh, slug, pr.headSha, repoRoot, indexed.map(f => f.path), warnings, signal),
  ]);
  throwIfCancelled(signal);
  const idx = createSyntacticIndex(ts,
    indexed.map((f) => ({ path: abs(f.path), text: f.headText })),
    { baseDirs: [repoRoot], moduleOptions, packages });
  const hints = new Map();
  for (const c of changed) {
    hints.set(`${c.file}#${c.namePos}`, {
      className: c.nested ? null : c.className || null,
      name: c.isConstructor ? 'constructor' : c.simpleName,
    });
  }
  const resolver = createSyntacticResolver(idx, { isTestPath: (file) => isTestFile(repoRoot, file), hints });

  const changedKeys = changedSymbolKeys(changed);
  const relOf = (file) => path.relative(repoRoot, file).split(path.sep).join('/');

  onProgress({ phase: 'resolve', message: 'resolving callers', done: 0, total: changed.length });
  let done = 0;
  for (const c of changed) {
    throwIfCancelled(signal);
    const own = rowResolvers.get(c) || resolver;
    const cs = await own.callerState(c.file, c.namePos, { isConstructor: c.isConstructor });
    c.callerState = cs.state;
    c.callersComplete = cs.complete === true;
    c.callersIncompleteReason = c.callersComplete ? null : cs.reason ?? null;
    c.callers = cs.callers;
    for (const x of c.callers) {
      x.callSiteUpdates = classifyCallSiteUpdates({
        callSites: x.callSites, changedLineRanges: changedRanges[relOf(x.file)],
        lineOfOffset: (offset) => readLineOfOffset(x.file, offset),
      });
      x.callState = classifyCallerUpdateState({
        callSiteUpdates: x.callSiteUpdates, callerChanged: changedKeys.has(`${x.file}#${x.pos}`),
      });
    }
    c.stale = c.callers.filter((x) => !x.test && x.callState !== 'updated-at-call');
    c.staleCallers = c.stale.length;
    c.staleChangedElsewhere = c.stale.filter((x) => x.callState === 'changed-elsewhere').length;
    c.score = score(c);
    // The walk sees only the PR's own files, so a finished walk that finds no test has not
    // searched the repository's tests: that is 'unknown' with the reason, never 'uncovered'.
    const reach = await walkTestReach(own, { file: c.file, pos: c.namePos }, { depth: reachDepth, budget: DEFAULT_REACH_BUDGET, signal });
    c.tests = reach.tests;
    c.testState = reach.state === 'uncovered' ? 'unknown' : reach.state;
    c.testReachIncompleteReason = reach.state === 'covered' ? null
      : reach.incompleteReason || `a preview reads only the pull request's own files, so tests outside it are not searched${missingTests.length ? `; ${missingTests.length} test file(s) in the PR could not be fetched` : ''}`;
    onProgress({ phase: 'resolve', message: 'resolving callers', done: ++done, total: changed.length });
  }

  throwIfCancelled(signal);

  return makeResult(false, resolver);

  function makeResult(callersPending, resolver) {
    // ---- roots and nesting, same rules as the local path ----------------------------
    const ranked = seedRoots(changed, changedSymbolKeys(changed)).sort((a, b) => b.score - a.score);
    const nested = nestedIds(changed);
    for (const c of changed) c.isRoot = !nested.has(`${c.file}#${c.namePos}`);

    const result = {
      callersPending,
      tierA: true,
      callersNotComputed,
      texts,
      coverage: 'pr-files-only',
      prNumber: pr.number,
      headSha: pr.headSha,
      pr,
      allChanged: changed.slice().sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)),
      nestedCount: nested.size,
      otherFiles,
      mode: 'pr-preview',
      requestedMode: 'pr-preview',
      modeDesc: `PR #${pr.number} without a checkout`,
      dirtyCount: 0,
      base: { ref: pr.baseRef, sha: pr.mergeBaseSha },
      warnings,
      concurrency: workers,
      changedFileCount: usable.length,
      changedPaths: usable.map((f) => f.path),
      fileStatus: Object.fromEntries(listed.files.map((f) => [f.path, normaliseStatus(f.status)])),
      basePaths,
      changedRanges,
      diffLines,
      outside,
      unanalysable: [],
      components: [{ component: 'pull request', changed, deleted, roots: ranked, forest: [], stats: resolver ? resolver.stats() : {} }],
      findings: changed.filter((c) => c.kinds.some((k) => k.id !== 'body')).sort((a, b) => b.score - a.score),
      deleted,
      untested: [],
      testReachComputed: !callersPending && changed.length > 0,
      reachDepth,
      unknownCallers: changed.filter((c) => c.callerState === 'unknown'),
      resolver,
    };
    // The symbols of the files read from their text, for the review identity (as analyze()'s).
    // Not enumerable: not part of the JSON result.
    Object.defineProperty(result, 'reviewSymbols', { value: reviewSymbols, enumerable: false });
    return result;
  }
}

/**
 * The reason a listed file of another known language was not analysed, as an `otherFiles`
 * property; nothing for a file of no known language (docs, config), which has no analysis
 * to miss.
 * @param {string} filePath
 * @returns {{ notAnalysed: { language: string, reason: string } }|{}}
 */
function notAnalysedIn(filePath) {
  // The preview analyses TypeScript/JavaScript, including its tests (read as callers), and
  // reads Python from its text (a Python test is listed, as a test is locally).
  if (isSourcePath(filePath) || textLanguageOf(filePath)) return {};
  const language = languageFor(filePath);
  if (!language) return {};
  return { notAnalysed: { language: language.displayName, reason: `a preview cannot analyse ${language.displayName}; check out the pull request to analyse it in the editor` } };
}

function listedContentId(f) {
  const parts = [];
  if (f.sha) parts.push(`blob:${f.sha}`);
  if (f.patch != null) parts.push(`patch:${createHash('sha256').update(f.patch).digest('hex')}`);
  return parts.length ? parts.join('|') : null;
}

function emptyResult(pr, listed, otherFiles, warnings, concurrency, basePaths) {
  return {
    tierA: true, pr, texts: new Map(), coverage: 'pr-files-only', prNumber: pr.number, headSha: pr.headSha,
    allChanged: [], nestedCount: 0, otherFiles,
    mode: 'pr-preview', requestedMode: 'pr-preview', modeDesc: `PR #${pr.number} without a checkout`,
    dirtyCount: 0, base: { ref: pr.baseRef, sha: pr.mergeBaseSha },
    warnings: warnings.concat('no analysable source files in this pull request'), concurrency,
    changedFileCount: 0, changedPaths: [],
    fileStatus: Object.fromEntries(listed.files.map((f) => [f.path, normaliseStatus(f.status)])),
    basePaths,
    changedRanges: {}, outside: [],
    unanalysable: [], components: [], findings: [], deleted: [], untested: [],
    testReachComputed: false, unknownCallers: [], resolver: null,
  };
}

module.exports = { analyzeRemote, normaliseStatus };
