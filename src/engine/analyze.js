'use strict';
const fs = require('fs');
const path = require('path');
const { makeGit, resolveBaseAsync } = require('./git');
const {
  changedFiles, untrackedFiles, worktreeFiles, allHunks, wholeFileRange, isTestPath, isSourcePath,
  projectRootOf, projectConfigIn, clearProjectCache, projectLabel, INFERRED_PROJECT,
} = require('./diff');
const { makeSymbols } = require('./symbols');
const { score } = require('./signature');
const { changedSymbolsIn, changedSymbolKeys } = require('./changed-symbols');
const { createTsResolver } = require('./resolver-ts');
const { createModuleCallers, withModuleCallers } = require('./module-callers');
const { seedRoots, nestedIds, blastRadius, buildTree } = require('./forest');
const { readLineOfOffset, clearVirtualText } = require('./textpos');
const { classifyCallSiteUpdates, classifyCallerUpdateState } = require('./call-sites');
const { mapLimit } = require('./concurrency');
const { validateConcurrency, validateReachDepth } = require('./settings');
const { throwIfCancelled } = require('./cancellation');
const { walkTestReach, DEFAULT_REACH_BUDGET } = require('./test-reach');

// Prefer the project's own TypeScript so analysis matches what the editor sees; fall
// back to the repo root, then to whatever this extension was installed with.
// Prefer the repo's OWN TypeScript so we parse with the version the project compiles
// with, and fall back to the copy shipped with the extension. A monorepo commonly has
// no install at its root -- every package has its own -- so the repo root alone is not
// a sufficient place to look.
function loadTypeScript(repo, projectDir) {
  // TypeScript 7 is the native rewrite: its package exports only `unstable/*` plus a
  // version stub, with no createSourceFile and no createLanguageService. Loading it
  // and discovering that three call frames later produces a baffling error, so any
  // candidate that does not expose the compiler API is rejected and we keep looking.
  const usable = (m) => !!m && typeof m.createSourceFile === 'function'
    && typeof m.createLanguageService === 'function';
  const rejected = [];
  const tryAt = (base) => {
    if (!base) return null;
    let m = null;
    try { m = require(require.resolve('typescript', { paths: [base] })); } catch { return null; }
    if (usable(m)) return m;
    if (m && m.version) rejected.push(`${m.version} at ${base}`);
    return null;
  };
  for (const base of [projectDir, repo]) {
    const hit = tryAt(base);
    if (hit) return hit;
  }
  // Two levels of subdirectory: `packages/foo`, `components/bar`, `apps/web`.
  if (repo) {
    const kids = (d) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
          .map((e) => path.join(d, e.name));
      } catch { return []; }
    };
    for (const a of kids(repo)) {
      if (fs.existsSync(path.join(a, 'node_modules'))) { const hit = tryAt(a); if (hit) return hit; }
      for (const b of kids(a)) {
        if (!fs.existsSync(path.join(b, 'node_modules'))) continue;
        const hit = tryAt(b);
        if (hit) return hit;
      }
    }
  }
  const own = tryAt(__dirname);
  if (own) return own;
  try { return require('typescript'); } catch { /* not bundled */ }
  throw new Error('typescript not resolvable — install it in the project or the repo, '
    + 'or reinstall the extension (it ships its own copy)'
    + (rejected.length ? `. Rejected: ${rejected.join(', ')} (no classic compiler API)` : ''));
}

// One `git diff` for every file, split only so a huge PR stays under the OS argument
// limit. A rename's two paths always travel in the same chunk: git can only pair them
// when both are in the pathspec.
function rangesFor(git, baseSha, headRev, files, { maxChars = 60000, deletionsOut } = {}) {
  const groups = files.map((f) => (f.oldPath && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]));
  const out = {};
  let chunk = [], size = 0;
  const flush = () => {
    if (!chunk.length) return;
    Object.assign(out, allHunks(git, baseSha, headRev, chunk, deletionsOut));
    chunk = []; size = 0;
  };
  for (const g of groups) {
    const len = g.reduce((n, p) => n + p.length + 1, 0);
    if (chunk.length && size + len > maxChars) flush();
    chunk.push(...g); size += len;
  }
  flush();
  return out;
}

// Each mode pins the diff base through the same call: (git, opts, warnings) -> { ref, sha, notes }.
// `branch` and `pr` share one strategy. A new mode has to name its own; it cannot inherit this one by falling through.
function headBase(git) {
  return { ref: 'HEAD', sha: git.revParse('HEAD'), notes: [] };
}

function checkpointBase(git, opts) {
  if (!opts.checkpoint) throw new Error('checkpoint mode requires opts.checkpoint');
  // `rev-parse <40 hex>` echoes any well-formed sha back, existing or not, so a stale
  // checkpoint surfaced as a raw `git diff` failure. Ask for a commit specifically.
  const sha = git.revParse(`${opts.checkpoint}^{commit}`);
  if (!sha) {
    const err = new Error(`checkpoint ${String(opts.checkpoint).slice(0, 12)} is not a commit in this repository — record a new checkpoint`);
    err.code = 'NO_CHECKPOINT';
    throw err;
  }
  return { ref: opts.checkpoint, sha, notes: [] };
}

function missingMergeBase(git, ref) {
  // Falling back to the base TIP diffed every commit the base gained since the
  // branch point, in reverse -- other people's work shown as this branch deleting it.
  const shallow = git.isShallow();
  const err = new Error(shallow
    ? `no common ancestor of ${ref} and HEAD in this clone — it is shallow, so the branch point was never fetched. Run 'git fetch --unshallow' (or fetch with more depth) and refresh.`
    : `${ref} and HEAD share no history — a branch diff against it is meaningless. Choose another base branch.`);
  err.code = 'NO_MERGE_BASE';
  return err;
}

async function branchMergeBase(git, opts, warnings) {
  const resolved = await resolveBaseAsync(git, opts.base || 'main', {
    fetch: !!opts.fetch, allowLocal: !!opts.allowLocalBase, timeoutMs: opts.fetchTimeoutMs,
  });
  warnings.push(...resolved.notes);
  const mergeBase = git.mergeBase(resolved.sha, 'HEAD');
  if (!mergeBase) throw missingMergeBase(git, resolved.ref);
  return { ...resolved, sha: mergeBase };
}

const MODES = {
  working:    { desc: 'uncommitted changes only (agent review)', headRev: null,   requireClean: false, resolveBase: headBase },
  checkpoint: { desc: 'since a recorded checkpoint',            headRev: null,   requireClean: false, resolveBase: checkpointBase },
  branch:     { desc: 'whole branch vs base (includes uncommitted)', headRev: null, requireClean: false, resolveBase: branchMergeBase },
  pr:         { desc: 'committed branch state vs base (PR semantics)', headRev: 'HEAD', requireClean: true, resolveBase: branchMergeBase },
};

function resolveEffectiveMode(mode, cfg, dirty, onDirty, warnings) {
  if(!(cfg.requireClean && dirty.length)) return { effectiveMode: mode, effectiveCfg: cfg };
    // Erroring to a blank view the moment someone edits a file is hostile. Fall back
    // to 'branch' (which includes uncommitted work) and say loudly that we did.
    if(onDirty !== 'fallback') {
      const err = new Error(`working tree is dirty — a PR diff would be contaminated by ${dirty.length} uncommitted change(s). Commit, stash, or use mode 'branch'.`);
      err.dirty = dirty;
      throw err;
    }
    warnings.push(`${dirty.length} uncommitted change(s) — showing 'branch' (includes your edits) instead of 'pr'. Commit or stash for a true PR diff.`);
   

  return { effectiveMode: 'branch', effectiveCfg: MODES.branch };
}

function tryLoadTypeScript(repo, dir, warnings, unanalysable, comp, compFiles) {
  try { return { ts: loadTypeScript(repo, dir), ok: true }; }
  catch (e) {
    unanalysable.set(comp, (unanalysable.get(comp) || 0) + compFiles.length);
    warnings.push(`${compFiles.length} changed file(s) in '${comp}' NOT analysed — ${e.message}`);
    return { ts: null, ok: false };
  }
}

/**
 * One path from `git diff --name-status`, or an untracked file appended for a worktree diff.
 * `path` and `oldPath` are repository-relative.
 * @typedef {object} ChangedPath
 * @property {'added'|'deleted'|'modified'|'renamed'} status
 * @property {string} path Path on the new side. For a deletion this is the removed path.
 * @property {string|null} oldPath Previous path of a rename. The same as `path` for a modification or deletion, and `null` for an add.
 * @property {number|null} [similarity] Rename similarity reported by Git, present when `status` is `'renamed'`.
 * @property {true} [untracked] Set when the path was never `git add`ed and was appended for a worktree diff.
 */

/**
 * Append untracked paths to a diff. `git diff` never lists a file nobody has `git add`ed.
 * Those files are part of the change only when `headRev` is `null` (the worktree). Against a
 * commit they are omitted, and so are callers the language service finds inside them.
 * @param {ChangedPath[]} changes
 * @param {Set<string>} untracked Repository-relative paths from `git ls-files --others`.
 * @param {string|null} headRev A commit to diff, such as `'HEAD'`. `null` means the worktree.
 * @returns {ChangedPath[]} `changes` when `headRev` is a commit or every untracked path is already
 *   listed. Otherwise a new array with each missing path appended as
 *   `{ status: 'added', oldPath: null, untracked: true }`.
 */
function includeUntrackedFiles(changes, untracked, headRev) {
  if (headRev !== null) return changes;
  const listed = new Set(changes.map((file) => file.path));
  const added = [];
  for (const filePath of untracked) {
    if (listed.has(filePath)) continue;
    added.push({ status: 'added', oldPath: null, path: filePath, untracked: true });
  }
  return added.length ? changes.concat(added) : changes;
}

/**
 * Hide callers in untracked files from every query a resolver answers. Against a commit
 * those files are not part of the change, so the caller list, the test-reach walk and the
 * tree must all see the same callers; filtering only one of them reported "no callers"
 * next to "covered by a test".
 * @param {object} resolver
 * @param {(caller: {file: string}) => boolean} isUntracked
 * @param {(count: number) => void} onDropped Called with the number of direct callers removed
 *   from one `callerState` answer.
 * @returns {object} `resolver` with `incoming`, `incomingWithStatus` (when present) and
 *   `callerState` filtered.
 */
function withoutUntrackedCallers(resolver, isUntracked, onDropped) {
  const keep = (caller) => !isUntracked(caller);
  const wrapped = {
    ...resolver,
    incoming: async (...args) => (await resolver.incoming(...args)).filter(keep),
    callerState: async (...args) => {
      const cs = await resolver.callerState(...args);
      const kept = cs.callers.filter(keep);
      if (kept.length === cs.callers.length) return cs;
      onDropped(cs.callers.length - kept.length);
      if (kept.length || cs.state !== 'resolved') return { ...cs, callers: kept };
      // Every caller found was untracked. Only a finished search shows nothing in the
      // commit calls it; an unfinished one may have missed a committed caller.
      return { ...cs, callers: kept, state: cs.complete ? 'none' : 'unknown' };
    },
  };
  if (resolver.incomingWithStatus) {
    wrapped.incomingWithStatus = async (...args) => {
      const answer = await resolver.incomingWithStatus(...args);
      return { ...answer, callers: answer.callers.filter(keep) };
    };
  }
  return wrapped;
}

/**
 * Changed source files grouped by the project the TypeScript server would put them in.
 * Tests are left out of both results.
 * @param {string} repo Absolute filesystem path of the repository root.
 * @param {ChangedPath[]} changes
 * @returns {{
 *   files: ChangedPath[],
 *   byComponent: Map<string, {root: string, config: string|null, files: ChangedPath[]}>
 * }} `byComponent` is keyed by `'(root)'`, the repository-relative project directory, or
 *   `INFERRED_PROJECT` for files no tsconfig.json or jsconfig.json claims. `root` is `''`
 *   for the repository root and that directory otherwise; `config` is the config file
 *   name, `null` for the inferred project.
 */
function changedSourceByProject(repo, changes) {
  const files = changes.filter((file) => isSourcePath(file.path) && !isTestPath(file.path));
  const byComponent = new Map();
  for (const file of files) {
    const root = projectRootOf(repo, file.path);
    const label = root === null ? INFERRED_PROJECT : projectLabel(root);
    let entry = byComponent.get(label);
    if (!entry) {
      entry = root === null
        ? { root: '', config: null, files: [] }
        : { root, config: projectConfigIn(path.join(repo, root)), files: [] };
      byComponent.set(label, entry);
    }
    entry.files.push(file);
  }
  return { files, byComponent };
}

/**
 * Absolute paths of the worktree's source files that no config claims: the members of
 * the inferred project. `null` when git could not list the files.
 */
function inferredProjectFiles(repo, git) {
  const listed = worktreeFiles(git);
  if (listed == null) return null;
  return listed.filter((rel) => isSourcePath(rel) && projectRootOf(repo, rel) === null
    && fs.existsSync(path.join(repo, rel))).map((rel) => path.join(repo, rel));
}

/**
 * Analyse one repository from disk: diff it, find the changed callables, and
 * resolve their callers. PR preview without a checkout is `analyzeRemote`, which
 * returns this same top-level shape.
 *
 * `mode` selects the diff. `pr` compares committed `HEAD` with the merge base and
 * throws on a dirty tree unless `onDirty` is `'fallback'`, in which case the run
 * continues as `branch`: `mode` in the result is `'branch'` and `requestedMode`
 * stays `'pr'`. `working` and `checkpoint` diff the worktree. `headRev` overrides
 * the mode: `null` includes untracked files, `'HEAD'` does not. `base.sha` is the
 * pinned commit the diff was taken against; `base.ref` is the name that was asked for.
 *
 * Each changed symbol then carries:
 *
 * - `callerState` `'resolved'` when at least one caller came back, `'none'` when
 *   the query finished and found none, `'unknown'` when the query failed, the file
 *   is outside the program, or the symbol is only referenced as a value, and
 *   `'di'` for a constructor with no direct call.
 * - `testState` `'covered'` when a test is statically reachable (not proof that it runs
 *   or asserts anything), `'uncovered'` when the walk finished within its depth and
 *   budget and found none (within `reachDepth` caller levels, not beyond), `'unknown'`
 *   when no test was found and the walk could not finish (a caller query failed or was
 *   incomplete, the budget stopped it, or `callerState` is `'unknown'` or `'di'`), and
 *   `'not-computed'` when `deferTestReach` skipped the walk. `testReachIncompleteReason` says why a state is `'unknown'` and is
 *   `null` otherwise. See `walkTestReach`.
 * - `callersComplete` `true` when the caller search finished, `false` when it was cut
 *   short and `callers` may be missing some; `callersIncompleteReason` says why, or is
 *   `null` when complete. A `'resolved'` symbol can be incomplete.
 * - `callState` on each caller: `'updated-at-call'` when a hunk covers the call
 *   site, `'changed-elsewhere'` when that caller symbol also changed, and
 *   `'unchanged'` otherwise. A caller with an edited call site and an untouched or
 *   unlocatable one is not `'updated-at-call'`; its `callSiteUpdates` holds the
 *   `{updated, untouched, unknown}` sites behind the label. `staleCallers` counts
 *   non-test callers that are not `'updated-at-call'`.
 *
 * `depth` bounds only the test-reach walk, with the changed symbol at depth 0. It is the
 * declared scope: a test deeper than `depth` caller levels is out of scope, and a walk
 * that finds none within it is `'uncovered'`, not `'unknown'`.
 * Blast radius uses `blastDepth`. The rendered forest uses `treeDepth` and
 * `maxChildren`, and is omitted when `skipForest` is set. `changedRanges` values
 * are 1-based inclusive `[startLine, endLine]` pairs on the new side of the diff,
 * keyed by repository-relative path. A pure deletion is the gap marker
 * `[N + 0.5, N + 0.5]`, between lines N and N + 1, so bounds need not be integers.
 * `outside` has one entry per changed source file with at least one changed or deleted
 * symbol, holding the changed lines (same range format, deletion markers included) that
 * no changed callable's span contains: imports, top-level constants, types, class fields,
 * the comment above a function. A deletion that only removed a deleted symbol, with its
 * blank and comment lines, is not listed; the deleted row stands for it. A file with no
 * changed or deleted symbol has no entry: it is in `otherFiles` with `noCallable`.
 * A replacement that removes outside text but adds only callable lines is represented
 * by a deletion marker before its added lines, even when that gap is inside a callable.
 * `baseTexts` holds the base-side text of every changed source path that existed at
 * the base, keyed by its base path (`basePaths` maps a rename).
 *
 * @param {string} repo Absolute filesystem path of the repository root.
 * @param {object} [opts]
 * @param {'working'|'checkpoint'|'branch'|'pr'} [opts.mode='pr']
 * @param {string} [opts.base='main'] Base branch or revision for `pr` and `branch`.
 * @param {string} [opts.checkpoint] Required for `checkpoint`. Must resolve to a commit.
 * @param {boolean} [opts.fetch] Fetch the base before resolving it.
 * @param {boolean} [opts.allowLocalBase] Allow a local base ref when the remote-tracking ref is missing.
 * @param {number} [opts.fetchTimeoutMs] Deadline for that fetch, in milliseconds.
 * @param {string|null} [opts.headRev] `'HEAD'` for the commit, `null` for the worktree. Defaults from the mode.
 * @param {'fallback'} [opts.onDirty] In `pr` mode, continue as `branch` instead of throwing.
 * @param {number} [opts.depth=2] How far the test-reach walk may go, 1..6; the changed symbol
 *   is depth 0. An invalid value warns and uses 2; one above 6 warns and uses 6.
 * @param {number} [opts.reachBudget=120] Distinct callers one test-reach walk may visit
 *   before it stops as `'unknown'`. The changed symbol does not count.
 * @param {boolean} [opts.deferTestReach] Leave every `testState` as `'not-computed'`.
 * @param {number} [opts.concurrency=8] Parallel caller queries per project, 1..32; an invalid value warns and uses 8.
 * @param {boolean} [opts.skipForest] Skip blast radius and the caller tree. Roots are still chosen.
 * @param {number} [opts.rankedRoots=6] How many roots receive a blast radius and a tree.
 * @param {number} [opts.blastDepth=1] Depth of the blast-radius walk.
 * @param {number} [opts.treeDepth=2] Depth of each rendered tree.
 * @param {number} [opts.maxChildren=8] Callers shown under one tree node. Further callers are counted as truncated.
 * @param {(event: {phase: string, component?: string, done?: number, total?: number, label?: string}) => void} [opts.onProgress]
 * @param {(ctx: {ts: object, componentDir: string, component: string, repoRoot: string}) => object|null} [opts.makeResolver]
 *   Editor resolver for this project. When omitted, a language service is created per project.
 *   Returning null skips the project.
 * @param {(result: object) => Promise<void>|void} [opts.onPrepared] Publishes a detached
 *   snapshot of changed rows before caller queries. Coverage is explicitly pending.
 * @param {(ctx: {ts: object, repo: string, git: object}) => object} [opts.makeModuleCallers]
 *   Editor-owned worker index; omitted for the CLI's synchronous index.
 * @param {AbortSignal} [opts.signal] Stops the run: no caller query starts once it is
 *   aborted. A query already running is awaited, because the resolvers' services are
 *   disposed when the run ends; the editor's language server cannot be told to stop, so
 *   its query finishes there and its answer is discarded.
 * @returns {Promise<{
 *   mode: string,
 *   requestedMode: string,
 *   modeDesc: string,
 *   base: {ref: string, sha: string, notes?: string[]},
 *   warnings: string[],
 *   concurrency: number,
 *   reachDepth: number,
 *   dirtyCount: number,
 *   changedFileCount: number,
 *   changedPaths: string[],
 *   fileStatus: Record<string, string>,
 *   basePaths: Record<string, string>,
 *   changedRanges: Record<string, Array<[number, number]>>,
 *   outside: Array<{file: string, relPath: string, ranges: Array<[number, number]>}>,
 *   baseTexts: Map<string, string|null>,
 *   excludedCallerPaths: string[],
 *   otherFiles: Array<{path: string, status: string, noCallable?: true}>,
 *   unanalysable: Array<{component: string, count: number}>,
 *   components: object[],
 *   allChanged: object[],
 *   findings: object[],
 *   deleted: object[],
 *   nestedCount: number,
 *   untested: object[],
 *   testUnknown: object[],
 *   unknownCallers: object[],
 *   testReachComputed: boolean
 * }>} `findings` are changed symbols whose diff is more than a body edit.
 *   `untested` is the `testState` `'uncovered'` subset and `testUnknown` the `'unknown'`
 *   one. `unknownCallers` is the `callerState` `'unknown'` subset.
 *   `testReachComputed` is false only when every symbol was left `'not-computed'`.
 *   `concurrency` is the worker count actually used after validating `opts.concurrency`;
 *   `reachDepth` is the same for `opts.depth`.
 * @throws {Error} Unknown `mode`.
 * @throws {Error} `checkpoint` mode without `opts.checkpoint`, or a checkpoint that is
 *   not a commit (`code === 'NO_CHECKPOINT'`).
 * @throws {Error} `pr` or `branch` with no merge base (`code === 'NO_MERGE_BASE'`).
 * @throws {Error} Dirty tree in `pr` mode when `onDirty` is not `'fallback'`. `err.dirty` lists the entries.
 * @throws {import('./cancellation').AnalysisCancelledError} `opts.signal` was aborted. No result is returned.
 */
async function analyze(repo, opts = {}) {
  const mode = opts.mode || 'pr';
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`unknown mode '${mode}' (expected ${Object.keys(MODES).join('|')})`);
  const { signal } = opts;
  throwIfCancelled(signal);
  const git = makeGit(repo);
  const warnings = [];
  const depth = validateReachDepth(opts.depth, warnings);
  const concurrency = validateConcurrency(opts.concurrency, warnings);
  // Per-run caches. The extension host lives for hours: a tsconfig added since the last
  // run must be seen, and text a Tier A preview registered for a PR must not stand in
  // for the file on disk (it moved every call-site line of a local run).
  clearProjectCache();
  clearVirtualText();

  const base = await cfg.resolveBase(git, opts, warnings);
  throwIfCancelled(signal);

  const dirty = git.isDirty(null);

  const { effectiveMode, effectiveCfg } = resolveEffectiveMode(mode, cfg, dirty, opts.onDirty, warnings);


  const headRev = opts.headRev !== undefined ? opts.headRev : effectiveCfg.headRev;
  const untracked = new Set(untrackedFiles(git));
  const everything = includeUntrackedFiles(changedFiles(git, base.sha, headRev, null), untracked, headRev);
  const { files, byComponent } = changedSourceByProject(repo, everything);
  const unanalysable = new Map();

  // relPath -> [[startLine, endLine], ...] of the new-side changed ranges
  const changedRanges = {};
  const tracked = files.filter((f) => !f.untracked);
  const deletions = {};
  const ranges = tracked.length ? rangesFor(git, base.sha, headRev, tracked, { deletionsOut: deletions }) : {};
  for (const f of files) {
    changedRanges[f.path] = f.untracked ? wholeFileRange(path.join(repo, f.path)) : (ranges[f.path] || []);
  }
  // every base-side blob in one process, not a `git show` per file. Changed tests and
  // sources outside a project are included: review identities need their base side too.
  const baseTexts = git.showMany(base.sha, everything
    .filter((f) => f.status !== 'added' && isSourcePath(f.path)).map((f) => f.oldPath || f.path));

  const relOf = (abs) => path.relative(repo, abs).split(path.sep).join('/');

  const components = [];
  const outside = [];
  let droppedUntracked = 0;
  const outsideProgram = new Set();
  // Cache: language services and document registries shared by the projects of this
  // run. Owner: this `analyze()` call. Key: TypeScript version and config path for a
  // service, the TypeScript module for a registry; the config is read once, and a file's
  // version is its mtime, so an edit during the run is seen by the service. Invalidation:
  // none; the next run builds a new pool. Disposal: the `finally` below disposes every
  // service, including on failure and cancellation.
  const servicePool = { services: new Map(), registries: new Map() };
  let workspaceGraph;
  // Shared by every project: the index it builds on first use covers the whole worktree.
  let moduleCallers = null;
  const plans = [];
  let compIndex = 0;
  const report = opts.onProgress || (() => {});
  try {
    for (const [comp, entry] of byComponent) {
      throwIfCancelled(signal);
      const compFiles = entry.files;
      report({
        phase: 'component',
        component: comp,
        done: compIndex++,
        total: byComponent.size,
      });
      const dir = path.join(repo, entry.root);
      // A project can have node_modules without typescript in it. Aborting the whole run
      // for one such project blanks the view; report it and analyse the rest.
      const { ts, ok } = tryLoadTypeScript(repo, dir, warnings, unanalysable, comp, compFiles);
      if (!ok) continue;

      const S = makeSymbols(ts);
      if (!moduleCallers) moduleCallers = opts.makeModuleCallers
        ? opts.makeModuleCallers({ ts, repo, git }) : createModuleCallers(ts, repo, git);
      if (entry.config === null) {
        warnings.push(`${compFiles.length} changed file(s) have no tsconfig.json or jsconfig.json — analysed as one inferred JavaScript project, as the editor does; callers in other files come from static import and require() statements`);
      }
      let projectResolver;
      if (opts.makeResolver) {
        projectResolver = opts.makeResolver({ ts, componentDir: dir, component: comp, repoRoot: repo });
      } else if (entry.config === null) {
        const members = inferredProjectFiles(repo, git);
        projectResolver = members && createTsResolver(ts, dir, { repoRoot: repo, servicePool, inferredFiles: members });
      } else {
        if (!workspaceGraph) workspaceGraph = require('./workspace-projects').workspaceProjects(ts, repo);
        projectResolver = createTsResolver(ts, dir, { tsconfig: entry.config, repoRoot: repo, workspaceGraph, servicePool });
      }
      if (!projectResolver) { warnings.push(`'${comp}': no TypeScript project could be loaded — skipped`); continue; }
      const withModules = withModuleCallers(projectResolver, moduleCallers);
      const resolver = headRev !== null && untracked.size
        ? withoutUntrackedCallers(withModules, (x) => untracked.has(relOf(x.file)), (n) => { droppedUntracked += n; })
        : withModules;
      const changed = [], deleted = [];
      for (const f of compFiles) {
        const abs = path.join(repo, f.path);
        let headText = null;
        if (f.status !== 'deleted') {
          try { headText = fs.readFileSync(abs, 'utf8'); } catch { headText = null; }
        }
        // One file the parser or symbol walk chokes on must not blank the whole view.
        try {
          const r = changedSymbolsIn(ts, S, {
            absPath: abs, relPath: f.path, oldPath: f.oldPath, status: f.status,
            headText,
            baseText: f.status === 'added' ? null : baseTexts.get(f.oldPath || f.path) ?? null,
            hunkRanges: changedRanges[f.path] || [],
            hunkDeletions: deletions[f.path] || [],
            component: comp,
            projectRoot: entry.root,
          });
          changed.push(...r.changed);
          deleted.push(...r.deleted);
          if (r.outside.length) outside.push({ file: abs, relPath: f.path, ranges: r.outside });
        } catch (e) {
          warnings.push(`${f.path}: could not be analysed — ${e && e.message}`);
        }
      }

      for (const c of changed) moduleCallers.hint(c);
      require('./pending-analysis').initialisePending(changed);
      plans.push({ comp, changed, deleted, resolver });
    }
    if (opts.onPrepared) {
      const pendingComponents = plans.map(({ comp, changed, deleted }) => ({
        component: comp, changed, deleted, roots: seedRoots(changed), forest: [], stats: {},
      }));
      await opts.onPrepared(require('./pending-analysis').snapshot(makeResult(pendingComponents, true)));
      throwIfCancelled(signal);
    }
    for (const { comp, changed, deleted, resolver } of plans) {
      throwIfCancelled(signal);
      const changedKeys = changedSymbolKeys(changed);
      const deferReach = opts.deferTestReach === true;
      let done = 0;
      report({ phase: 'resolve', component: comp, done: 0, total: changed.length });
      await mapLimit(changed, concurrency, async (c) => {
        let cs;
        try {
          cs = await resolver.callerState(c.file, c.namePos, { isConstructor: c.isConstructor });
        } catch (e) {
          cs = { state: 'unknown', callers: [], complete: false, reason: (e && e.message) || 'caller resolution failed' };
          warnings.push(`caller resolution failed for ${c.label} (${c.relPath}): ${e && e.message}`);
        }
        if (cs.reason === 'not-in-program') outsideProgram.add(`${comp}\u0000${c.relPath}`);
        c.callerState = cs.state;
        c.callersComplete = cs.complete === true;
        c.callersIncompleteReason = c.callersComplete ? null : cs.reason ?? null;
        c.callers = cs.callers;
        for (const x of cs.callers) {
          x.callSiteUpdates = classifyCallSiteUpdates({
            callSites: x.callSites, changedLineRanges: changedRanges[relOf(x.file)],
            lineOfOffset: (offset) => readLineOfOffset(x.file, offset),
          });
          x.callState = classifyCallerUpdateState({
            callSiteUpdates: x.callSiteUpdates, callerChanged: changedKeys.has(`${x.file}#${x.pos}`),
          });
        }
        // stale = the call was not updated, whatever else happened in that caller
        c.stale = cs.callers.filter((x) => !x.test && x.callState !== 'updated-at-call');
        c.staleCallers = c.stale.length;
        c.staleChangedElsewhere = c.stale.filter((x) => x.callState === 'changed-elsewhere').length;
        c.score = score(c);
        // Test reachability: does ANY test sit in the upward closure. Deferred by default
        // -- it only feeds one section, and computing it for every symbol multiplies the
        // query count for information the reviewer may never open.
        c.tests = [];
        c.testState = 'not-computed';
        c.testReachIncompleteReason = null;
        if (!deferReach) {
          const reach = await walkTestReach(resolver, { file: c.file, pos: c.namePos }, {
            depth, budget: opts.reachBudget ?? DEFAULT_REACH_BUDGET, signal,
          });
          c.tests = reach.tests;
          c.testState = reach.state;
          c.testReachIncompleteReason = reach.incompleteReason;
          // A finished walk found nothing, but a symbol whose callers are unknown or
          // DI-built has callers the walk could not see.
          if (reach.state === 'uncovered' && (c.callerState === 'unknown' || c.callerState === 'di')) {
            c.testState = 'unknown';
            c.testReachIncompleteReason = c.callersIncompleteReason
              || (c.callerState === 'di' ? 'a DI container builds this class, so its callers are not visible' : 'its callers are unknown');
          }
        }
        report({ phase: 'resolve', component: comp, done: ++done, total: changed.length, label: c.label });
      }, { signal });

      // Blast radius is only computed for roots we will actually show: at depth 4 with
      // 90-node closures it was the single largest cost in the run (234s -> see README).
      const ranked = seedRoots(changed).sort((a, b) => b.score - a.score);
      const roots = [];
      if (opts.skipForest) {
        components.push({ component: comp, changed, deleted, roots: ranked, forest: [], stats: resolver.stats ? resolver.stats() : {} });
        if (resolver.dispose) resolver.dispose();
        continue;
      }
      for (let i = 0; i < ranked.length; i++) {
        const r = ranked[i];
        if (i >= (opts.rankedRoots ?? 6)) { roots.push({ ...r, blast: null, blastCapped: false }); continue; }
        throwIfCancelled(signal);
        const b = await blastRadius(resolver, r.file, r.namePos, opts.blastDepth ?? 1);
        roots.push({ ...r, blast: b.count, blastCapped: b.capped });
      }
      roots.sort((a, b) => b.score - a.score || (b.blast || 0) - (a.blast || 0));
      const forest = [];
      for (const r of roots.slice(0, opts.rankedRoots ?? 6)) {
        throwIfCancelled(signal);
        forest.push(await buildTree(resolver, r, {
          depth: opts.treeDepth ?? 2, maxChildren: opts.maxChildren ?? 8,
          isChanged: (id) => changedKeys.has(id),
        }));
      }

      components.push({ component: comp, changed, deleted, roots, forest, stats: resolver.stats ? resolver.stats() : {} });
      if (resolver.dispose) resolver.dispose();
    }

  } finally {
    for (const svc of servicePool.services.values()) svc.dispose();
  }
  throwIfCancelled(signal);

  for (const k of outsideProgram) {
    const [comp, rel] = k.split('\u0000');
    warnings.push(`${rel} is not included by the tsconfig.json or jsconfig.json in '${comp}' — its callers are unknown`);
  }
  if (moduleCallers) warnings.push(...moduleCallers.notes());
  if (droppedUntracked) warnings.push(`${droppedUntracked} caller(s) in untracked files ignored — they are not part of the committed change`);
  return makeResult(components, false);

  function makeResult(components, callersPending) {
    const all = components.flatMap((c) => c.changed);
    const allChangedKeys = changedSymbolKeys(all);
    // A caller may belong to a different component whose symbols were parsed later.
    for (const c of all) {
      for (const caller of c.callers) {
        caller.callState = classifyCallerUpdateState({
          callSiteUpdates: caller.callSiteUpdates, callerChanged: allChangedKeys.has(`${caller.file}#${caller.pos}`),
        });
      }
      c.staleChangedElsewhere = c.stale.filter(caller => caller.callState === 'changed-elsewhere').length;
    }
    const markTree = node => {
      if (node.file != null && node.pos != null) node.changed = allChangedKeys.has(`${node.file}#${node.pos}`);
      for (const child of node.children || []) markTree(child);
    };
    for (const component of components) for (const tree of component.forest) markTree(tree);
    const nested = nestedIds(all);
    for (const c of all) c.isRoot = !nested.has(`${c.file}#${c.namePos}`);
    // Same rule as the Tier A path: a source file we analysed but which produced no
    // changed callable still changed, and must stay visible somewhere in the view.
    const withSymbols = new Set([
      ...all.map((c) => c.relPath),
      ...components.flatMap((c) => c.deleted).map((d) => d.relPath),
    ]);
    const analysedPaths = new Set(files.map((f) => f.path).filter((p2) => withSymbols.has(p2)));
    const otherFiles = everything
      .filter((f) => !analysedPaths.has(f.path))
      .map((f) => ({ path: f.path, status: f.status, noCallable: withSymbols.has(f.path) ? undefined : true }));
    const result = {
      callersPending,
      allChanged: all.slice().sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)),
      nestedCount: nested.size,
      otherFiles,
      mode: effectiveMode, requestedMode: mode, modeDesc: effectiveCfg.desc, dirtyCount: dirty.length, base, warnings, concurrency, reachDepth: depth,
      changedFileCount: files.length,
      changedPaths: files.map((f) => f.path),
      fileStatus: Object.fromEntries(everything.map((f) => [f.path, f.status])),
      basePaths: Object.fromEntries(everything.filter(f => f.oldPath).map(f => [f.path, f.oldPath])),
      changedRanges,
      outside,
      baseTexts,
      excludedCallerPaths: headRev !== null ? [...untracked] : [],
      unanalysable: [...unanalysable].map(([component, count]) => ({ component, count })),
      components,
      findings: all.filter((c) => c.kinds.some((k) => k.id !== 'body')).sort((a, b) => b.score - a.score),
      deleted: components.flatMap((c) => c.deleted),
      untested: all.filter((c) => c.testState === 'uncovered'),
      testUnknown: all.filter((c) => c.testState === 'unknown'),
      testReachComputed: all.length === 0 || all.some((c) => c.testState !== 'not-computed'),
      unknownCallers: all.filter((c) => c.callerState === 'unknown'),
    };
    // The editor expands rows lazily through its own resolver; it must add the same
    // module callers. Not enumerable: it is a live object, not part of the JSON result.
    Object.defineProperty(result, 'moduleCallers', { value: moduleCallers, enumerable: false });
    return result;
  }
}
module.exports = { analyze, MODES, loadTypeScript, rangesFor, withoutUntrackedCallers };
