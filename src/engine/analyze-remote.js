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
const { makeSymbols } = require('./symbols');
const { score } = require('./signature');
const { changedSymbolsIn, changedSymbolKeys } = require('./changed-symbols');
const { createSyntacticIndex } = require('./syntactic-index');
const { createSyntacticResolver } = require('./resolver-syntactic');
const { hunkRangesFromPatch } = require('./patch');
const { isSourcePath, isTestPath, isTestFile } = require('./diff');
const { seedRoots, nestedIds } = require('./forest');
const { registerVirtualText, readLineOfOffset } = require('./textpos');
const { classifyCallSiteUpdates, classifyCallerUpdateState } = require('./call-sites');
const { mapLimit, validateConcurrency } = require('./concurrency');
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
 * @param {number} [args.maxFiles=300] Files listed at most.
 * @param {number} [args.concurrency] Parallel file fetches, 1..32; an invalid value warns and uses 8.
 * @param {(event: {phase: string, message: string, done?: number, total?: number}) => void} [args.onProgress]
 * @param {(message: string) => void} [args.trace]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<object>} The same shape as analyze()'s result, with `tierA: true`.
 * @throws {import('./cancellation').AnalysisCancelledError} `signal` was aborted. No result is returned.
 */
async function analyzeRemote({
  ts, gh, slug, pr, repoRoot,
  maxFiles = 300, concurrency, onProgress = () => {}, trace = () => {}, signal,
}) {
  if (!ts) throw new Error('Tier A needs TypeScript to parse the PR files');
  throwIfCancelled(signal);
  const warnings = [];
  const workers = validateConcurrency(concurrency, warnings);
  if (gh.getPullRequest) pr = await gh.getPullRequest(slug, pr.number);
  throwIfCancelled(signal);
  const mergeBaseSha = pr.mergeBaseSha || (gh.mergeBase && await gh.mergeBase(slug, pr.baseSha, pr.headSha));
  throwIfCancelled(signal);
  if (!mergeBaseSha) throw new Error('Cannot preview this PR without its merge base');
  pr = { ...pr, mergeBaseSha };


  trace(`PR #${pr.number}  head=${String(pr.headSha).slice(0, 8)}  base=${pr.baseRef}@${String(pr.baseSha || '?').slice(0, 8)}`);
  onProgress({ phase: 'files', message: `listing files in #${pr.number}` });
  const listed = await gh.listPullRequestFiles(slug, pr.number, { max: maxFiles });
  throwIfCancelled(signal);
  if (gh.getPullRequest) {
    const after = await gh.getPullRequest(slug, pr.number);
    throwIfCancelled(signal);
    if (after.headSha !== pr.headSha || after.baseSha !== pr.baseSha) {
      throw new Error('The PR changed while its files were loading. Refresh to analyse the new revision.');
    }
  }
  if (listed.truncated || pr.changedFiles > listed.files.length) {
    warnings.push(`PR has ${pr.changedFiles ?? `${listed.totalIsLowerBound ? "at least " : ""}${listed.total}`} files; analysing the first ${maxFiles} (impactTree.tierA.maxFiles)`);
  }

  trace(`${listed.files.length} file(s) listed${listed.truncated ? ' (truncated)' : ''}`);
  const sourceFiles = listed.files.filter((f) => isSourcePath(f.path) && !isTestPath(f.path));
  trace(`${sourceFiles.length} analysable source file(s); ${listed.files.length - sourceFiles.length} other`);
  // Nothing of these files is fetched, so their review identity comes from what GitHub
  // listed: the blob id and the patch. `contentId` is null when it gave neither.
  const otherFiles = listed.files
    .filter((f) => !sourceFiles.includes(f))
    .map((f) => ({ path: f.path, status: normaliseStatus(f.status), contentId: listedContentId(f) }));

  if (!sourceFiles.length) {
    return emptyResult(pr, listed, otherFiles, warnings, workers);
  }

  // ---- fetch head and base text -------------------------------------------------
  // Two requests per file. Added files have no base; deleted files have no head.
  onProgress({ phase: 'fetch', message: `fetching ${sourceFiles.length} file(s)`, done: 0, total: sourceFiles.length });
  let fetched = 0;
  // One catch around both sides would blame the head fetch for a base failure and
  // null them together -- which is what turned every modified file into an "added"
  // one with no signature to diff against, hence no findings at all.
  const grab = async (which, filePath, ref) => {
    if (!ref) { warnings.push(`${filePath}: no ${which} ref to fetch from`); return null; }
    try {
      const t = await gh.fileAtRef(slug, filePath, ref);
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
    onProgress({ phase: 'fetch', message: 'fetching files', done: ++fetched, total: sourceFiles.length });
    return { ...f, status, headText, baseText };
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

  // Absolute-looking paths keyed off the workspace root keep every downstream
  // consumer (decorations, review ids, the tree's rel()) working unchanged, even
  // though these files may not exist on disk at these paths.
  const abs = (rel) => path.join(repoRoot, rel);
  const usable = contents.filter((f) => f.headText != null || f.status === 'deleted');
  for (const f of usable) if (f.headText != null) registerVirtualText(abs(f.path), f.headText);

  // ---- symbols -------------------------------------------------------------------
  const S = makeSymbols(ts);
  const changedRanges = {};
  const changed = [];
  const deleted = [];
  for (const f of usable) {
    const ranges = hunkRangesFromPatch(f.patch);
    changedRanges[f.path] = ranges;
    if (!ranges.length && f.status !== 'deleted' && !f.patch && f.headText !== f.baseText) {
      warnings.push(`${f.path}: GitHub returned no patch (binary or too large) — symbols not mapped`);
    }
    const r = changedSymbolsIn(ts, S, {
      absPath: abs(f.path), relPath: f.path, status: f.status,
      headText: f.headText, baseText: f.baseText,
      hunkRanges: ranges,
      component: 'pull request', projectRoot: null,
    });
    changed.push(...r.changed);
    deleted.push(...r.deleted);
    trace(`${f.path}: ${ranges.length} hunk(s), `
      + `head=${f.headText ? f.headText.length : 0}b base=${f.baseText ? f.baseText.length : 0}b `
      + `-> ${r.changed.length} changed, ${r.deleted.length} deleted symbol(s)`);
  }

  // ---- callers, from the PR's own files only --------------------------------------
  trace(`total ${changed.length} changed symbol(s), ${deleted.length} deleted`);
  onProgress({ phase: 'index', message: `indexing ${usable.length} file(s)` });
  const moduleOptions = await require('./remote-config').remoteOptions(
    ts, gh, slug, pr.headSha, repoRoot, usable.map((f) => f.path), warnings);
  throwIfCancelled(signal);
  const packages = await require('./remote-config').remotePackages(gh, slug, pr.headSha, repoRoot, usable.map(f => f.path), warnings);
  throwIfCancelled(signal);
  const idx = createSyntacticIndex(ts,
    usable.filter((f) => f.headText != null).map((f) => ({ path: abs(f.path), text: f.headText })),
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
    const cs = await resolver.callerState(c.file, c.namePos, { isConstructor: c.isConstructor });
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
    c.tests = [];
    c.testState = 'not-computed';         // test reach needs the whole repo
    onProgress({ phase: 'resolve', message: 'resolving callers', done: ++done, total: changed.length });
  }

  throwIfCancelled(signal);

  // ---- roots and nesting, same rules as the local path ----------------------------
  const ranked = seedRoots(changed, changedKeys).sort((a, b) => b.score - a.score);
  const nested = nestedIds(changed);
  for (const c of changed) c.isRoot = !nested.has(`${c.file}#${c.namePos}`);

  // A module file, a barrel, a const map of error codes: real changes with no changed
  // callable. Analysing them yields nothing, and until now they then appeared nowhere
  // at all -- a PR review tool that silently omits changed files is worse than one
  // that shows them plainly, so they join the file list.
  const withSymbols = new Set([...changed, ...deleted].map((c) => c.relPath));
  const noCallable = usable
    .filter((f) => !withSymbols.has(f.path))
    .map((f) => ({ path: f.path, status: f.status, noCallable: true }));
  if (noCallable.length) trace(`${noCallable.length} changed source file(s) have no changed callable`);
  otherFiles.push(...noCallable);

  // The fetched text is the only copy of these revisions we have; the diff views read
  // it back rather than the worktree, which is on an unrelated branch.
  const texts = new Map();
  for (const f of usable) texts.set(f.path, { head: f.headText, base: f.baseText });

  return {
    tierA: true,
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
    changedRanges,
    unanalysable: [],
    components: [{ component: 'pull request', changed, deleted, roots: ranked, forest: [], stats: resolver.stats() }],
    findings: changed.filter((c) => c.kinds.some((k) => k.id !== 'body')).sort((a, b) => b.score - a.score),
    deleted,
    untested: [],
    testReachComputed: false,
    unknownCallers: changed.filter((c) => c.callerState === 'unknown'),
    resolver,
  };
}

function listedContentId(f) {
  const parts = [];
  if (f.sha) parts.push(`blob:${f.sha}`);
  if (f.patch != null) parts.push(`patch:${createHash('sha256').update(f.patch).digest('hex')}`);
  return parts.length ? parts.join('|') : null;
}

function emptyResult(pr, listed, otherFiles, warnings, concurrency) {
  return {
    tierA: true, pr, texts: new Map(), coverage: 'pr-files-only', prNumber: pr.number, headSha: pr.headSha,
    allChanged: [], nestedCount: 0, otherFiles,
    mode: 'pr-preview', requestedMode: 'pr-preview', modeDesc: `PR #${pr.number} without a checkout`,
    dirtyCount: 0, base: { ref: pr.baseRef, sha: pr.mergeBaseSha },
    warnings: warnings.concat('no analysable source files in this pull request'), concurrency,
    changedFileCount: 0, changedPaths: [],
    fileStatus: Object.fromEntries(listed.files.map((f) => [f.path, normaliseStatus(f.status)])),
    changedRanges: {},
    unanalysable: [], components: [], findings: [], deleted: [], untested: [],
    testReachComputed: false, unknownCallers: [], resolver: null,
  };
}

module.exports = { analyzeRemote, normaliseStatus };
