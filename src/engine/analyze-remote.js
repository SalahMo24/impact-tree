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
const assert = require('node:assert/strict');
const { hunkRangesFromPatch, hunkDeletionsFromPatch } = require('./patch');
const { diffLinesFromPatch } = require('./diff-lines');
const { isTestPath } = require('./diff');
// The preview analyses the languages that can be read from their text alone, the providers
// with `prepareSyntactic` (TypeScript/JavaScript, Python): their changed functions and kinds,
// and callers from a syntax-only index of the PR's own files of that language. A file of
// another language (Go) is listed as a file that was not analysed, with the reason
// (`notAnalysed`), so it never reads as a file with no impact.
const { languageFor, registeredLanguages } = require('../languages');
/**
 * The language that reads a file in a preview, or null: the provider that handles it, when
 * it has `prepareSyntactic`.
 * @param {string} filePath
 */
const analysedLanguageOf = (filePath) => {
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
 * @param {object} args.ts The TypeScript module that parses the PR's TypeScript/JavaScript files
 *   (handed to the providers as `PrepareContext.remote`).
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
 * @param {true|object} [args.impactPaths] Impact paths of every changed function
 *   (./impact-paths.js): `true` for the default limits, or the walk limits. Off by default: the
 *   result is then unchanged. Adds `impactPaths` and `impactPathsMeta` to the result. No request
 *   is made for it: it reads only the PR's own fetched files, so a path that leaves them ends
 *   without an entry point (a warning says so).
 * @returns {Promise<object>} The same shape as analyze()'s result, with `tierA: true` and
 *   `callersScope` (see `callersScopeOf`; empty when nothing was analysed); `outside`
 *   (see analyze()) is computed from the PR's patch and fetched texts. `diffLines` comes
 *   from GitHub's patches as they are, for every listed file with a patch, tests and
 *   non-source files included.
 * @throws {import('./cancellation').AnalysisCancelledError} `signal` was aborted. No result is returned.
 */
async function analyzeRemote({
  ts, gh, slug, pr, repoRoot,
  maxFiles, concurrency, onProgress = () => {}, onPrepared, trace = () => {}, signal, impactPaths,
}) {
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
  const sourceFiles = listed.files.filter((f) => analysedLanguageOf(f.path) && !isTestPath(f.path));
  // Test files the PR changed are read at the head only, to be indexed as callers. They are
  // never diffed, so no symbol of theirs becomes a change (as locally), and they stay in
  // `otherFiles`. They are already within the listed-file budget; tests the PR does not
  // touch are never fetched.
  const testFiles = listed.files.filter((f) => analysedLanguageOf(f.path) && isTestPath(f.path) && normaliseStatus(f.status) !== 'deleted');
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

  // ---- symbols, by language ------------------------------------------------------
  for (const f of usable) {
    const ranges = hunkRangesFromPatch(f.patch);
    changedRanges[f.path] = ranges;
    if (!ranges.length && f.status !== 'deleted' && !f.patch && f.headText !== f.baseText) {
      warnings.push(`${f.path}: GitHub returned no patch (binary or too large) — symbols not mapped`);
    }
  }
  const changed = [];
  const deleted = [];
  const outside = [];
  const reviewSymbols = new Map();
  const notAnalysedPaths = new Set();
  // Every language the preview reads is asked, in registry order (TypeScript first), even
  // with no changed file of its own, so its changed tests are still indexed. Its rows follow
  // the PR's listing order within the language.
  const prepared = [];
  for (const language of registeredLanguages().filter((l) => l.prepareSyntactic)) {
    throwIfCancelled(signal);
    const own = usable.filter((f) => analysedLanguageOf(f.path) === language);
    const ownTests = readTests.filter((f) => analysedLanguageOf(f.path) === language);
    const notAnalysedFiles = new Map();
    const answer = await language.prepareSyntactic({
      repo: repoRoot, git: null,
      files: own.map((f) => ({ path: f.path, status: f.status, ...(f.oldPath && f.oldPath !== f.path ? { oldPath: f.oldPath } : {}) })),
      baseTexts: new Map(own.filter((f) => f.baseText != null).map((f) => [f.oldPath || f.path, f.baseText])),
      headTexts: new Map(own.filter((f) => f.headText != null).map((f) => [f.path, f.headText])),
      changedRanges: Object.fromEntries(own.map((f) => [f.path, changedRanges[f.path]])),
      deletions: Object.fromEntries(own.map((f) => [f.path, hunkDeletionsFromPatch(f.patch)])),
      warnings, unanalysable: new Map(), notAnalysedFiles, report: () => {}, signal, hooks: {},
      unit: { component: 'pull request', projectRoot: '' },
      // Its callers come from the PR's own files of the language: changed and changed tests.
      syntacticSources: [...own, ...ownTests].filter((f) => f.headText != null).map((f) => ({ path: f.path, text: f.headText })),
      remote: { ts, gh, slug, headSha: pr.headSha, onProgress, trace },
    });
    assert.ok(answer && Array.isArray(answer.units), `${language.id} prepareSyntactic returned no units`);
    prepared.push({ language, answer });
    for (const unit of answer.units) {
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
    if (own.length) trace(`${own.length} ${language.displayName} file(s) read from their text; callers from their syntax`);
  }
  const callersScope = callersScopeOf(prepared);

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
  // The second phase of a language that fetches what its callers need (TypeScript's
  // configuration), only now that the changed rows are out.
  for (const { answer } of prepared) {
    throwIfCancelled(signal);
    if (answer.extras && answer.extras.indexCallers) await answer.extras.indexCallers();
  }
  throwIfCancelled(signal);
  // One resolver per language, from its units: a row's callers, and a caller's own when it
  // is expanded, are asked of the resolver of the file's language.
  const resolvers = new Map();
  for (const { language, answer } of prepared) {
    for (const unit of answer.units) {
      const known = resolvers.get(language);
      assert.ok(!known || known === unit.resolver, `${language.id}: a preview needs one resolver per language, its units have several`);
      resolvers.set(language, unit.resolver);
    }
  }
  const resolverOf = (relPath) => {
    const own = resolvers.get(analysedLanguageOf(relPath));
    assert.ok(own, `${relPath}: a changed row of no prepared language`);
    return own;
  };
  const changedKeys = changedSymbolKeys(changed);
  const relOf = (file) => path.relative(repoRoot, file).split(path.sep).join('/');

  onProgress({ phase: 'resolve', message: 'resolving callers', done: 0, total: changed.length });
  let done = 0;
  for (const c of changed) {
    throwIfCancelled(signal);
    const own = resolverOf(c.relPath);
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

  const finalResult = makeResult(false, routedResolver(resolvers));
  if (impactPaths) {
    const headTexts = new Map([...usable, ...readTests].filter((f) => f.headText != null).map((f) => [f.path, f.headText]));
    await addImpactPaths(finalResult, {
      config: impactPaths, repoRoot, changed, headTexts, prepared, signal, warnings,
    });
  }
  return finalResult;

  function makeResult(callersPending, resolver) {
    // ---- roots and nesting, same rules as the local path ----------------------------
    const ranked = seedRoots(changed, changedSymbolKeys(changed)).sort((a, b) => b.score - a.score);
    const nested = nestedIds(changed);
    for (const c of changed) c.isRoot = !nested.has(`${c.file}#${c.namePos}`);

    const result = {
      callersPending,
      tierA: true,
      callersScope,
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
 * Impact paths over the PR's own fetched files only (no further request): the entry-point
 * facts and the text of every node come from `headTexts`, so a path that leaves the PR's
 * files ends without an entry point, which the warning says. Every caller query is a lower
 * bound (the preview's resolvers search the PR's files). Adds `impactPaths` and
 * `impactPathsMeta` to `result`, and warnings to `result.warnings`.
 * @param {any} result The preview result, with its routed `resolver`.
 * @param {{ config: true|object, repoRoot: string, changed: any[], headTexts: Map<string, string>,
 *   prepared: Array<{ language: any, answer: any }>, signal: AbortSignal|undefined, warnings: string[] }} input
 *   `headTexts`: head text of each fetched file by repository-relative path.
 */
async function addImpactPaths(result, { config, repoRoot, changed, headTexts, prepared, signal, warnings }) {
  const { createImpactWalker } = require('./impact-paths');
  const { gatherEntryFacts } = require('./entry-facts');
  const { entryLanguageOf } = require('./entry-points');
  const toRel = (file) => path.relative(repoRoot, file).split(path.sep).join('/');
  const languages = new Set(changed.map((c) => entryLanguageOf(c.file)).filter(Boolean));
  const { facts, notes } = gatherEntryFacts({
    repo: repoRoot, languages, readRel: (rel) => headTexts.get(rel) ?? null,
    git: { tryRaw: (args) => (args[0] === 'ls-files' ? [...headTexts.keys()].join('\0') : null) },
  });
  warnings.push(...notes);
  warnings.push("impact paths in a preview see only the pull request's own files, so a path that leaves them ends without an entry point");
  // The resolver's own methods, marked as a lower bound without touching the shared object.
  const resolver = Object.create(result.resolver, { callersLowerBound: { value: true } });
  const walker = createImpactWalker({
    repo: repoRoot, facts, limits: config === true ? undefined : config, signal,
    readText: (file) => headTexts.get(toRel(file)) ?? null,
  });
  for (const { language, answer } of prepared) {
    const own = changed.filter((c) => analysedLanguageOf(c.relPath) === language);
    await walker.walk(resolver, own, { scopeNote: answer.extras && answer.extras.scopeNote });
  }
  result.impactPaths = walker.byId;
  result.impactPathsMeta = { limits: walker.limits, walkMs: walker.walkMs() };
}

/**
 * How each language's callers were searched, where that differs from what the preview's
 * notice says of all of them (callers outside the PR are not searched): `not-computed` for a
 * language whose resolver searches nothing (`callersNotComputed`, its reason as the note),
 * `pr-files` for one whose syntax-only search of the PR's files has its own scope note
 * (`extras.scopeNote`: Python's and Go's, each saying what its syntax index does not
 * resolve), with `unresolved`, what it does not resolve (`extras.unresolved`). TypeScript has
 * no entry: its search is the one the notice describes. One entry per language, in the
 * order the languages were prepared.
 * @param {Array<{ language: import('../languages/types').LanguageProvider, answer: import('../languages/types').PreparedLanguage }>} prepared
 * @returns {Array<{ language: string, scope: 'pr-files'|'not-computed', note: string, unresolved?: string }>}
 */
function callersScopeOf(prepared) {
  const out = [];
  for (const { language, answer } of prepared) {
    if (!answer.units.length) continue;
    const notComputed = answer.units.find((unit) => /** @type {any} */ (unit.resolver).callersNotComputed);
    if (notComputed) out.push({ language: language.displayName, scope: /** @type {const} */ ('not-computed'), note: /** @type {any} */ (notComputed.resolver).callersNotComputed });
    else if (answer.extras && answer.extras.scopeNote) out.push({
      language: language.displayName, scope: /** @type {const} */ ('pr-files'), note: answer.extras.scopeNote,
      ...(answer.extras.unresolved ? { unresolved: answer.extras.unresolved } : {}),
    });
  }
  return out;
}

/**
 * The preview's resolver: each query goes to the resolver of its file's language, the first
 * language's (TypeScript's: the registry's first, always prepared) for a file of none, so
 * expanding a Python caller asks the Python index. With one language, its resolver itself.
 * `stats` are the first language's, with each other language's under its id; a language
 * whose callers are not computed has none.
 * @param {Map<any, any>} byLanguage Language provider → its resolver, in registry order.
 */
function routedResolver(byLanguage) {
  const [base, ...others] = byLanguage.values();
  if (!others.length) return base;
  const pick = (file) => byLanguage.get(analysedLanguageOf(file)) || base;
  const counted = [...byLanguage].slice(1).filter(([, r]) => !r.callersNotComputed);
  return {
    kind: base.kind,
    incoming: (file, ...rest) => pick(file).incoming(file, ...rest),
    incomingWithStatus: (file, ...rest) => pick(file).incomingWithStatus(file, ...rest),
    callerState: (file, ...rest) => pick(file).callerState(file, ...rest),
    stats: () => Object.assign(base.stats(), ...counted.map(([language, r]) => ({ [language.id]: r.stats() }))),
    invalidate() { for (const r of byLanguage.values()) if (r.invalidate) r.invalidate(); },
    clear() { for (const r of byLanguage.values()) if (r.clear) r.clear(); },
    dispose() { for (const r of byLanguage.values()) if (r.dispose) r.dispose(); },
  };
}

/**
 * The reason a listed file of another known language was not analysed, as an `otherFiles`
 * property; nothing for a file of no known language (docs, config), which has no analysis
 * to miss.
 * @param {string} filePath
 * @returns {{ notAnalysed: { language: string, reason: string } }|{}}
 */
function notAnalysedIn(filePath) {
  // A language the preview reads; its tests are read as callers and listed, as a test is
  // locally.
  if (analysedLanguageOf(filePath)) return {};
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
    tierA: true, callersScope: [], pr, texts: new Map(), coverage: 'pr-files-only', prNumber: pr.number, headSha: pr.headSha,
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
