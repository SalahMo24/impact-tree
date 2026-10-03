'use strict';
const path = require('path');
const { changedSymbolKeys } = require('./engine/changed-symbols');
const { createReadiness } = require('./readiness');
const { withModuleCallers } = require('./engine/module-callers');
const { classifyCallSiteUpdates } = require('./engine/call-sites');
const { readLineOfOffset } = require('./engine/textpos');
const { AnalysisCancelledError, isAnalysisCancelled, throwIfCancelled } = require('./engine/cancellation');

// A run that is cancelled stops waiting for `promise` and rejects with the cancellation
// error. The work behind `promise` is not stopped: it belongs to whoever started it.
function untilCancelled(signal, promise) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AnalysisCancelledError());
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

/**
 * Review session for one editor window. It owns the analysis lifecycle: which run is
 * current, whether a checkout holds the worktree, and the view-facing result. Entry
 * points request transitions through the operations below and never assign lifecycle
 * state. `vscode` is passed in so a cached copy of this module cannot capture a
 * previous stub.
 *
 * The lifecycle is in exactly one state:
 * - `starting`: nothing has prepared or run yet.
 * - `preparing`: the current run is warming the language server, or prewarm is and no
 *   run or checkout owns the phase.
 * - `analysing`: the current run is analysing.
 * - `checkingOut`: a checkout owns the worktree; analysis requests are refused.
 * - `ready`: idle.
 * - `disposed`: the window closed. Operations do nothing and late completions publish
 *   nothing, not even a log line.
 *
 * Admission is cancel and replace: a new analysis request aborts the current run and
 * takes its place. Every replacement, checkout and disposal aborts the replaced run's
 * signal synchronously, so a run whose signal is not aborted is still the current one.
 *
 * @param {*} vscode
 * @param {{ log: (m: string) => void, review: object, checkpoint?: string }} opts
 *   `checkpoint` is the review checkpoint restored from the workspace.
 */
function createSession(vscode, { log: logToChannel, review, checkpoint }) {
  // Required here rather than at module load: tests intercept analyze/git per activate.
  const { analyze, loadTypeScript } = require('./engine/analyze');

  const session = {
    state: { checkpoint },
    resolver: null,
    // session.resolver plus the cross-file callers the last local analysis added.
    localResolver: null,
    resolverOverride: null,
    readyPromise: null,
    review,
    decorate: null,
    provider: null,
    previewPullRequest: null,
    checkoutAndAnalyse: null,
  };

  // The one lifecycle record. `run` is the current analysis's private record and
  // `checkout` the checkout holding the worktree; `state` says which of them, if any,
  // owns the phase. `generation` identifies the analysis whose result the view may show:
  // it moves on whenever a run begins or a checkout takes the worktree, so work started
  // for an earlier generation (a lazy expansion, a late result) is stale.
  const lifecycle = { state: 'starting', run: null, checkout: null, generation: 0 };
  // Every run begun and not yet released, current or not, so release can settle it.
  const records = new Map();
  const disposed = () => lifecycle.state === 'disposed';
  const log = (m) => { if (!disposed()) logToChannel(m); };

  function repoRoot() {
    const f = vscode.workspace.workspaceFolders;
    if (!f || !f.length) throw new Error('Impact Tree: no workspace folder open');
    return f[0].uri.fsPath;
  }

  const isTierA = () => !!(session.state && session.state.result && session.state.result.tierA);

  // Classifies the call sites a caller row has in one file, as the pipelines did when the
  // result was built. Reads line positions through textpos, so it touches disk.
  function classifyCallSiteUpdatesFor(result, repo) {
    return (file, callSites) => classifyCallSiteUpdates({
      callSites,
      changedLineRanges: (result.changedRanges || {})[path.relative(repo, file).split(path.sep).join('/')],
      lineOfOffset: (offset) => readLineOfOffset(file, offset),
    });
  }

  function viewStateFromResult(result, repo, extra = {}) {
    const cfg = vscode.workspace.getConfiguration('impactTree');
    session.state = {
      ...session.state, result,
      changedKeys: changedSymbolKeys(result.allChanged),
      changedPaths: new Set(result.changedPaths || []),
      classifyCallSiteUpdates: classifyCallSiteUpdatesFor(result, repo),
      rel: (f) => path.relative(repo, f).split(path.sep).join('/'),
      absPath: (p2) => path.join(repo, p2),
      iconMode: cfg.get('iconMode', 'file'),
      rowDetail: cfg.get('rowDetail', 'hover'),
      fileListLayout: cfg.get('fileListLayout', 'tree'),
      error: null,
      ...extra,
    };
  }

  const owns = (run) => lifecycle.run !== null && lifecycle.run.handle === run;

  /**
   * Admits a new analysis, cancelling and replacing the current one: the newest request
   * wins. Refused with a warning while a checkout holds the worktree, and silently once
   * disposed. Records `source`, which Refresh repeats, even if the run later fails.
   * @param {{ source: { kind: 'local' } | { kind: 'pr', pr: object }, stage: 'preparing'|'analysing' }} request
   *   `stage` is the phase the run starts in; a local run prepares the language server first.
   * @returns {{ id: number, signal: AbortSignal } | null} The run's handle, or null when refused.
   *   The signal is aborted when the run is replaced, a checkout starts, or the session is disposed.
   */
  function beginAnalysisRun({ source, stage }) {
    if (disposed()) return null;
    if (lifecycle.checkout) {
      vscode.window.showWarningMessage(`Impact Tree: PR #${lifecycle.checkout.prNumber} is being checked out — try again when it finishes`);
      return null;
    }
    if (lifecycle.run) {
      log('a newer request replaces the running analysis — cancelling it');
      lifecycle.run.controller.abort();
    }
    const controller = new AbortController();
    const handle = Object.freeze({ id: ++lifecycle.generation, signal: controller.signal });
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const record = { handle, controller, source, settled, settle };
    records.set(handle, record);
    lifecycle.run = record;
    lifecycle.state = stage;
    if (source.kind === 'local') session.resolverOverride = null;     // leaving a PR preview
    session.state = { ...session.state, source };
    session.decorate.clear();
    session.provider.refresh();
    return handle;
  }

  /**
   * Moves the current run from preparing to analysing. Does nothing for a run that is
   * no longer current.
   * @param {{ id: number }} run
   * @returns {void}
   */
  function beginAnalysingStage(run) {
    if (owns(run)) lifecycle.state = 'analysing';
  }

  /**
   * Publishes a finished run's result, but only while the run is still current. The
   * caller performs its remaining publication (log lines, status bar, review identity)
   * only when this returns true, and synchronously, so nothing can replace the run in
   * between.
   * @param {{ id: number }} run
   * @param {{ result: object, repo: string, expansionResolver: object|null, source?: object, viewExtras?: object }} publication
   *   `expansionResolver` answers the tree's lazy caller queries for this result.
   *   `source` replaces the one recorded at begin, for a PR whose details were refreshed.
   * @returns {boolean} False for a replaced or cancelled run, or after dispose; then nothing changed.
   */
  function completeAnalysisRun(run, { result, repo, expansionResolver, source, viewExtras = {} }) {
    if (!owns(run)) return false;
    if (lifecycle.run.source.kind === 'pr') session.resolverOverride = expansionResolver;
    else session.localResolver = expansionResolver;
    if (source) session.state = { ...session.state, source };
    viewStateFromResult(result, repo, viewExtras);
    return true;
  }

  /**
   * Publishes a run's failure: the view shows `viewError`, the log gets the stack, and
   * an error pops up. A cancellation, a replaced run and a disposed session publish
   * nothing.
   * @param {{ id: number }} run
   * @param {Error} error
   * @param {{ viewError?: string, logLabel?: string }} [shown]
   * @returns {boolean} Whether the failure was published.
   */
  function failAnalysisRun(run, error, { viewError = error.message, logLabel = 'ERROR' } = {}) {
    if (!owns(run) || isAnalysisCancelled(error)) return false;
    session.state = { ...session.state, result: null, error: viewError };
    log(`${logLabel} ${error.stack || error.message}`);
    vscode.window.showErrorMessage(`Impact Tree: ${error.message}`);
    return true;
  }

  /**
   * Ends a run's lifetime; call it from the run's `finally`. Aborts its signal so
   * anything still holding it stops, and settles it for a checkout waiting on it. Only
   * the current run returns the session to ready: an older run's release never touches
   * a newer run's state.
   * @param {{ id: number }} run
   * @returns {void}
   */
  function releaseAnalysisRunResources(run) {
    const record = records.get(run);
    if (!record) return;
    records.delete(run);
    record.controller.abort();
    if (lifecycle.run === record) {
      lifecycle.run = null;
      lifecycle.state = 'ready';
      session.provider.refresh();
    }
    record.settle();
  }

  /**
   * Whether `id` still names the analysis the view may show. Lazy work captures
   * getAnalysisId() before it awaits and checks this afterwards.
   * @param {number} id
   * @returns {boolean}
   */
  const isCurrentAnalysis = (id) => !disposed() && id === lifecycle.generation;

  /**
   * Claims the worktree for a checkout. The claim is made before the first await, so an
   * analysis requested from then on is refused. Cancels the running analysis and
   * resolves only once that run has settled: git checkout must never run under it.
   * @param {number} prNumber
   * @returns {Promise<{ prNumber: number } | null>} The checkout's handle, or null when the
   *   session is or became disposed.
   * @throws {Error} A checkout is already in progress; callers check checkoutInProgress() first.
   */
  async function beginCheckout(prNumber) {
    if (disposed()) return null;
    if (lifecycle.checkout) throw new Error(`PR #${lifecycle.checkout.prNumber} is already being checked out`);
    const checkout = Object.freeze({ prNumber });
    const previous = lifecycle.run;
    lifecycle.checkout = checkout;
    lifecycle.run = null;
    lifecycle.state = 'checkingOut';
    lifecycle.generation++;          // the worktree is about to move under the shown result
    session.provider.refresh();
    if (previous) {
      log(`checking out PR #${prNumber} — cancelling the running analysis`);
      previous.controller.abort();
      await previous.settled;
    }
    return disposed() ? null : checkout;
  }

  /**
   * Releases the worktree. Does nothing for a checkout that no longer holds it.
   * @param {{ prNumber: number }|null} checkout
   * @returns {void}
   */
  function endCheckout(checkout) {
    if (!checkout || lifecycle.checkout !== checkout) return;
    lifecycle.checkout = null;
    lifecycle.state = 'ready';
  }

  /** @returns {number|null} The PR being checked out, if any. */
  const checkoutInProgress = () => (lifecycle.checkout ? lifecycle.checkout.prNumber : null);
  /** @returns {boolean} Whether an analysis run is in progress. */
  const isBusy = () => lifecycle.run !== null;
  /** @returns {string} The lifecycle state, for display. */
  const getPhase = () => lifecycle.state;
  /** @returns {number} The id lazy work captures; see isCurrentAnalysis. */
  const getAnalysisId = () => lifecycle.generation;

  function logLocalRun(result, repo, tStart) {
    log(`run mode=${result.mode}${result.requestedMode !== result.mode ? ` (requested ${result.requestedMode})` : ''} base=${result.base.ref}@${String(result.base.sha).slice(0, 10)} files=${result.changedFileCount} findings=${result.findings.length}`);
    result.warnings.forEach((w) => log(`  warn: ${w}`));
    const st = session.resolver.stats();
    const wall = (Date.now() - tStart) / 1000;
    if (st.warmUpMs) log(`  server warm-up ${(st.warmUpMs / 1000).toFixed(1)}s (paid once per window)`);
    log(`  WALL ${wall.toFixed(1)}s   (query time sums to ${(st.incomingMs / 1000).toFixed(1)}s across ${result.concurrency} workers — overlapping, not additive)`);
    log(`  queries: ${st.incomingCalls}  min ${st.minMs}ms / median ${st.medianMs}ms / max ${st.maxMs}ms`);
    log(`  ${st.cacheHits} cache hits · ${st.warmupRetries} warmup retries · ${st.skipped} unresolved · ${st.resolvedEmpty} resolved-but-empty`);
    log(`  cqrs: +${st.cqrsEdges} edges / ${st.cqrsSuppressed} handlers de-noised`);
    if (st.inheritedDropped) log(`  precision: -${st.inheritedDropped} inherited-member over-report(s) (sibling subclasses the call hierarchy wrongly attributes to an override)`);
    if (st.slowest) log(`  slowest query ${st.slowest.ms}ms -> ${path.relative(repo, st.slowest.file)}@${st.slowest.pos}`);
    if (st.resolvedEmpty) {
      log(`  NOTE: ${st.resolvedEmpty} symbol(s) returned no callers:`);
      for (const e of st.emptyAt || []) {
        const { offsetToPosition } = require('./engine/textpos');
        const p3 = offsetToPosition(e.file, e.pos);
        log(`    - ${path.relative(repo, e.file)}:${p3 ? p3.line + 1 : '?'}`);
      }
      log('    If one is in a component whose TS project the editor has not loaded, that is under-reporting, not an answer.');
    }
  }

  // Analyses the working repository for `run` and publishes the result if the run is
  // still current. Throws on failure, including the cancellation error.
  async function analyseLocalRun(run, mode, progress, opts) {
    // A replaced run must not clear the resolver a newer run is using.
    throwIfCancelled(run.signal);
    const repo = repoRoot();
    const cfg = vscode.workspace.getConfiguration('impactTree');
    session.resolver.clear();
    session.localResolver = null;
    const tStart = Date.now();
    const report = (m) => { if (progress) progress.report({ message: m }); };
    // vscode.commands.executeCommand takes no cancellation token, so the language
    // server cannot be told to stop. The signal stops new queries; one already sent
    // finishes in the server and its answer is dropped with the cancelled run.
    const result = await analyze(repo, {
      onProgress: (p2) => {
        if (p2.phase === 'component') report(`analysing ${p2.component}…`);
        else if (p2.total) report(`${p2.component}: resolving callers ${p2.done}/${p2.total}`);
      },
      mode, base: opts.base || cfg.get('baseBranch', 'main'), fetch: cfg.get('fetchBase', true),
      checkpoint: session.state && session.state.checkpoint,
      depth: cfg.get('reachDepth', 2),
      skipForest: true,                      // the tree resolves callers on expand
      deferTestReach: !(session.state && session.state.wantTestReach), // only one section needs it
      concurrency: cfg.get('concurrency', 8),
      onDirty: 'fallback',                   // never blank the view because a file is edited
      makeResolver: () => session.resolver,
      signal: run.signal,
    });
    const expansionResolver = withModuleCallers(session.resolver, result.moduleCallers);
    if (!completeAnalysisRun(run, { result, repo, expansionResolver })) return;
    logLocalRun(result, repo, tStart);
    if (review) {
      const { makeGit } = require('./engine/git');
      const git = makeGit(repo);
      const { createReviewIdentity, localRevisions } = require('./review-identity');
      const identity = createReviewIdentity(loadTypeScript(repo, repo), repo, localRevisions(repo, result, git));
      review.configure(`v2:${repo}:${git.currentBranch()}:${result.mode}:${opts.base || cfg.get('baseBranch', 'main')}`, identity);
    }
    const stale = result.findings.reduce((n, f) => n + f.staleCallers, 0);
    vscode.window.setStatusBarMessage(
      `Impact Tree: ${result.findings.length} finding(s), ${stale} un-updated caller(s), base ${result.base.ref}`, 8000);
  }

  /**
   * Analyses the working repository, replacing any running analysis. Never rejects: a
   * failure is published through failAnalysisRun.
   * @param {string} [mode] Defaults to the `impactTree.mode` setting.
   * @param {{ base?: string }} [opts]
   * @returns {Promise<void>} Settles when this run has ended, whether it completed,
   *   failed, was refused or was replaced.
   */
  async function refresh(mode, opts = {}) {
    const run = beginAnalysisRun({ source: { kind: 'local' }, stage: 'preparing' });
    if (!run) return;
    try {
      await vscode.window.withProgress(
        { location: { viewId: 'impactTree.changes' }, title: 'Impact Tree' },
        async (progress) => {
          await untilCancelled(run.signal, session.ensureReady(progress));
          beginAnalysingStage(run);
          session.provider.refresh();
          await analyseLocalRun(run, mode || vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'), progress, opts);
        });
    } catch (e) {
      failAnalysisRun(run, e);
    } finally {
      releaseAnalysisRunResources(run);
    }
  }

  /**
   * Asks this and every later local analysis to compute test reachability, then runs one.
   * @returns {Promise<void>} As refresh().
   */
  function refreshWithTestReach() {
    session.state = { ...session.state, wantTestReach: true };
    return refresh();
  }

  /**
   * Records the commit that `checkpoint` mode diffs against.
   * @param {string} sha
   * @returns {void}
   */
  function setCheckpoint(sha) {
    session.state = { ...session.state, checkpoint: sha };
  }

  /**
   * Prepares the language server in the background so the first analysis is fast.
   * Shows `preparing` only when no run or checkout owns the phase, and gives the phase
   * back only if it still holds it. A failure is logged, never shown as an analysis
   * error.
   * @returns {Promise<void>} Rejects only if refreshing the view throws.
   */
  async function prewarmInBackground() {
    if (disposed()) return;
    const ownsPhase = lifecycle.state === 'starting' || lifecycle.state === 'ready';
    if (ownsPhase) {
      lifecycle.state = 'preparing';
      session.provider.refresh();
    }
    try {
      if (await session.ensureReady()) log('ready');
    } catch (e) {
      log(`prewarm failed: ${e && e.message}`);
    } finally {
      if (ownsPhase && lifecycle.state === 'preparing' && !lifecycle.run) lifecycle.state = 'ready';
      if (!disposed()) session.provider.refresh();
    }
  }

  /**
   * Ends the session: cancels the running analysis, forgets the resolvers and the
   * result, and makes every later operation and late completion a no-op. A checkout
   * already running git is not interrupted; it just publishes nothing.
   * @returns {void}
   */
  function dispose() {
    if (disposed()) return;
    const run = lifecycle.run;
    lifecycle.state = 'disposed';
    lifecycle.run = null;
    lifecycle.checkout = null;
    if (run) run.controller.abort();
    session.resolver = null;
    session.localResolver = null;
    session.resolverOverride = null;
    session.readyPromise = null;
    session.state = null;
  }

  // Lets an expanded row say its caller query failed rather than show no callers.
  const current = () => session.resolverOverride || session.localResolver || session.resolver;
  const treeResolver = {
    incoming: (...a) => {
      const r = current();
      return r ? r.incoming(...a) : Promise.resolve([]);
    },
    incomingWithStatus: async (...a) => {
      const r = current();
      if (!r) return { callers: [], complete: false, reason: 'no analysis has run in this window' };
      if (r.incomingWithStatus) return r.incomingWithStatus(...a);
      // A resolver that cannot say whether its search finished is not evidence that it did.
      return { callers: await r.incoming(...a), complete: false, reason: 'this resolver does not report whether its caller search finished' };
    },
  };

  Object.assign(session, {
    repoRoot, isTierA, viewStateFromResult, refresh, refreshWithTestReach, setCheckpoint,
    beginAnalysisRun, beginAnalysingStage, completeAnalysisRun, failAnalysisRun, releaseAnalysisRunResources,
    isCurrentAnalysis, getAnalysisId, beginCheckout, endCheckout, checkoutInProgress, isBusy, getPhase,
    prewarmInBackground, dispose, treeResolver,
  });
  const { ensureReady } = createReadiness(vscode, session, { log });
  session.ensureReady = ensureReady;
  return session;
}

module.exports = { createSession };
