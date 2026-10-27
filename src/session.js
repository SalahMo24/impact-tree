'use strict';
const path = require('path');
const { changedSymbolKeys } = require('./engine/changed-symbols');
const { createReadiness } = require('./readiness');
const { withModuleCallers } = require('./engine/module-callers');
const { classifyCallSiteUpdates } = require('./engine/call-sites');
const { readLineOfOffset } = require('./engine/textpos');
const { AnalysisCancelledError, isAnalysisCancelled, throwIfCancelled } = require('./engine/cancellation');
const { realClock } = require('./engine/clock');

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
 * @param {{ log: (m: string) => void, review: object, checkpoint?: string, indexingTickMs?: number, callerRetryWaitMs?: number,
 *   getObjectDirs?: () => string[], getTempDir?: () => string|undefined, getScratchDir?: () => string|null,
 *   clock?: import('./engine/clock').Clock }} opts
 *   `checkpoint` is the review checkpoint restored from the workspace. `indexingTickMs` is
 *   how often the first-index elapsed time is refreshed; tests shorten it. `callerRetryWaitMs`
 *   bounds the wait for the language server before timed-out caller searches are retried
 *   (1..120000; see scheduleCallerRetry). `getObjectDirs` returns
 *   the absolute snapshot object directories that reading the checkpoint revision needs; it is
 *   asked at each use, so a snapshot taken after startup is visible. `getTempDir` names the
 *   folder for an analysis's temporary index (the snapshot store's, so its startup sweep
 *   removes what a crash leaves); undefined uses the OS temp folder. `getScratchDir` names the
 *   absolute folder for the language services' temporary base-side copies (asked once, when
 *   the resolver is created; see src/services-vscode.js); null serves no base-side symbols.
 *   `clock` (src/engine/clock.js) times the elapsed-seconds ticks, the caller-retry wait and
 *   the logged durations, and is handed to the resolver and the cross-file caller pool.
 */
function createSession(vscode, { log: logToChannel, review, checkpoint, indexingTickMs = 1000, callerRetryWaitMs = 120000,
  getObjectDirs = () => [], getTempDir = () => undefined, getScratchDir = () => null, clock = realClock }) {
  if (!Number.isSafeInteger(callerRetryWaitMs) || callerRetryWaitMs < 1 || callerRetryWaitMs > 120000) throw new RangeError('callerRetryWaitMs must be 1..120000');
  // Required here rather than at module load: tests intercept analyze/git per activate.
  const { analyze } = require('./engine/analyze');

  const session = {
    state: { checkpoint },
    // Cache owners. `resolver` is the editor resolver with its caller cache; it is created
    // once by src/readiness.js, emptied by `resolver.clear()` at the start of every local
    // analysis, and dropped by `dispose()`. `localResolver` wraps it with the cross-file
    // callers the last local analysis found; it is reset at the start of the next one.
    // `resolverOverride` is a PR preview's syntactic resolver, set when the preview
    // completes and cleared when any other kind of analysis begins. `readyPromise` is the
    // shared warm-up; a failed one is forgotten so the next call prepares again.
    resolver: null,
    localResolver: null,
    resolverOverride: null,
    readyPromise: null,
    review,
    decorate: null,
    provider: null,
    previewPullRequest: null,
    // Set by extension.js: opens the Pull Request tab once PR `number`'s review is loading.
    // Returns a function that stops waiting.
    /** @type {((number: number) => () => void) | null} */
    openPullRequestTabWhenLoaded: null,
    checkoutAndAnalyse: null,
    // The PR review store (src/pr-review-store.js). Set and disposed by extension.js,
    // which owns it; kept here only so later consumers can reach it.
    reviewStore: null,
    // The git remote the base branch is read from, or the problem that leaves none.
    // extension.js replaces it with the chosen GitHub remote (github-remote.js baseRemoteOf).
    /** @type {() => ({ name: string, problem: null } | { name: null, problem: string })} */
    baseRemote: () => ({ name: 'origin', problem: null }),
  };

  // The one lifecycle record. `run` is the current analysis's private record and
  // `checkout` the checkout holding the worktree; `state` says which of them, if any,
  // owns the phase. `generation` identifies the analysis whose result the view may show:
  // it moves on whenever a run begins or a checkout takes the worktree, so work started
  // for an earlier generation (a lazy expansion, a late result) is stale.
  const lifecycle = { state: 'starting', run: null, checkout: null, generation: 0 };
  // Every run begun and not yet released, current or not, so release can settle it.
  const records = new Map();
  // Worker index belongs to this session. Completed runs may reuse it after the
  // worker validates worktree metadata; cancellation and disposal terminate it.
  let modulePool = null;
  let moduleRepo = null;
  const disposed = () => lifecycle.state === 'disposed';
  const log = (m) => { if (!disposed()) logToChannel(m); };

  // Listeners told that the analysis generation, its source, or the checkout claim
  // changed, so state keyed on "what is being reviewed" (the PR review store) can follow.
  // Owner: this session; each subscription's dispose removes it, and dispose() clears all.
  const analysisListeners = new Set();
  function notifyAnalysisChanged() {
    for (const listener of [...analysisListeners]) {
      try { listener(); } catch (e) { log(`an analysis listener failed: ${e && e.message}`); }
    }
  }
  /**
   * @param {() => void} listener Called synchronously after the change; reads the session.
   * @returns {{ dispose: () => void }}
   */
  function onDidChangeAnalysis(listener) {
    if (disposed()) return { dispose() {} };
    analysisListeners.add(listener);
    return { dispose: () => analysisListeners.delete(listener) };
  }

  // ---- cards (impactTree.cards.enabled) ----
  // Listeners told that `session.state.cards`, `hintsPending` or `cardsError` changed. Cards
  // arrive after the result, so they have their own event: notifyAnalysisChanged would make
  // the PR review store and the comment controllers re-sync for a change of cards alone.
  // Owner: this session; each subscription's dispose removes it, and dispose() clears all.
  const cardsListeners = new Set();
  function notifyCardsChanged() {
    for (const listener of [...cardsListeners]) {
      try { listener(); } catch (e) { log(`a cards listener failed: ${e && e.message}`); }
    }
  }
  /**
   * @param {() => void} listener Called synchronously after the cards of the shown result changed.
   * @returns {{ dispose: () => void }}
   */
  function onDidChangeCards(listener) {
    if (disposed()) return { dispose() {} };
    cardsListeners.add(listener);
    return { dispose: () => cardsListeners.delete(listener) };
  }

  /** @returns {boolean} Whether the Cards view is switched on. Off means no extra option and no extra work. */
  const cardsEnabled = () => vscode.workspace.getConfiguration('impactTree').get('cards.enabled', false) === true;

  // The merge-hint search running in the background for the shown result, if any. Owner: this
  // session. It outlives the run that started it (a run's own signal aborts when the run is
  // released), so it has its own controller, aborted when another run begins, a checkout
  // starts, or the session is disposed. It publishes only while it is still the one running.
  /** @type {AbortController|null} */
  let hintsController = null;
  function abortHints() {
    if (hintsController) hintsController.abort();
    hintsController = null;
  }

  /**
   * Publishes `patch` on the shown state, only while it still shows `result`.
   * @param {object} result
   * @param {{ cards?: object|null, hintsPending: boolean, cardsError: string|null }} patch
   * @returns {boolean} Whether it was published.
   */
  function publishCardsState(result, patch) {
    if (disposed() || !session.state || session.state.result !== result) return false;
    session.state = { ...session.state, ...patch };
    notifyCardsChanged();
    return true;
  }

  /**
   * Builds the cards of `result` and publishes them, then finds the merge hints in the
   * background and publishes the cards again with them. Called from a run that has published
   * `result`, before the run is released: the facts are gathered under the run's signal. A
   * failure becomes a note on the view (`cardsError`), never a rejection; the shown result is
   * untouched. A run that is no longer current publishes nothing.
   * @param {{ id: number, signal: AbortSignal }} run
   * @param {{ result: any,
   *   gatherFacts: (signal: AbortSignal) => Promise<any>,
   *   hintsOptions: { repo?: string, head: string },
   *   report?: (message: string) => void }} job
   *   `gatherFacts`: reads what the cards need beyond the result (git history locally, the pull
   *   request's files in a preview). `hintsOptions`: the repository and revision the hints read;
   *   a preview has no `repo`.
   * @returns {Promise<void>}
   */
  async function publishCards(run, { result, gatherFacts, hintsOptions, report = () => {} }) {
    abortHints();
    const controller = new AbortController();
    hintsController = controller;
    const live = () => isCurrentAnalysis(run.id) && hintsController === controller && !controller.signal.aborted;
    try {
      report('cards: reading the change history…');
      const facts = await gatherFacts(run.signal);
      if (!live()) return;
      const { buildCardsFromFacts } = require('./engine/cards');
      const cards = buildCardsFromFacts(result, facts);
      if (!publishCardsState(result, { cards, hintsPending: true, cardsError: null })) return;
      // Deliberate background work: findHints handles its own rejection and checks `live`.
      findHints({ result, facts, cards, hintsOptions, controller, live }).catch((e) => log(`cards: ${e && e.stack ? e.stack : e}`));
    } catch (e) {
      if (isAnalysisCancelled(e) || !live()) return;
      log(`cards failed: ${e && e.stack ? e.stack : e}`);
      publishCardsState(result, { cards: null, hintsPending: false, cardsError: e && e.message ? e.message : String(e) });
    }
  }

  // The background half of publishCards: hints for cards already shown. Never rejects for an
  // engine failure (it becomes `cardsError`, the cards without hints stay); resolves quietly
  // when it was replaced.
  async function findHints({ result, facts, cards, hintsOptions, controller, live }) {
    try {
      const { addHints } = require('./engine/cards');
      const withHints = await addHints(cards, facts, { ...hintsOptions, signal: controller.signal });
      if (!live()) return;
      publishCardsState(result, { cards: withHints, hintsPending: false, cardsError: null });
    } catch (e) {
      if (isAnalysisCancelled(e) || !live()) return;
      log(`cards: merge hints failed: ${e && e.stack ? e.stack : e}`);
      publishCardsState(result, { cards, hintsPending: false, cardsError: `merge hints could not be found: ${e && e.message ? e.message : e}` });
    } finally {
      if (hintsController === controller) hintsController = null;
    }
  }

  function repoRoot() {
    const f = vscode.workspace.workspaceFolders;
    if (!f || !f.length) throw new Error('Impact Tree: no workspace folder open');
    return f[0].uri.fsPath;
  }

  /**
   * Whether the window has a repository to analyse. Cheap (one `rev-parse`), and asked
   * again when a run begins, so a `git init` followed by Refresh is noticed.
   * @returns {'ok'|'noFolder'|'noGit'}
   */
  let repoStatusCache = { stamp: null, value: null };
  function repoStatus() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return 'noFolder';
    const { makeGit, repoStamp } = require('./engine/git');
    const folder = folders[0].uri.fsPath;
    const stamp = `${folder}|${repoStamp(folder)}`;
    if (repoStatusCache.stamp === stamp) return repoStatusCache.value;
    const inside = makeGit(folder).tryRaw(['rev-parse', '--is-inside-work-tree']);
    const value = inside !== null && inside.trim() === 'true' ? 'ok' : 'noGit';
    repoStatusCache = { stamp, value };
    return value;
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
      iconMode: cfg.get('iconMode', 'symbol'),
      rowDetail: cfg.get('rowDetail', 'hover'),
      error: null,
      problem: null,
      retryingCallers: false,
      ...extra,
    };
  }

  const owns = (run) => lifecycle.run !== null && lifecycle.run.handle === run;

  /**
   * Admits a new analysis, cancelling and replacing the current one: the newest request
   * wins. Refused with a warning while a checkout holds the worktree, and silently once
   * disposed. Records `source`, which Refresh repeats, even if the run later fails. A
   * `checkout` source is a PR whose head `sha` is checked out; it is analysed locally,
   * against the PR's base, until a request with another source replaces it.
   * @param {{ source: { kind: 'local' } | { kind: 'pr', pr: object } | { kind: 'checkout', pr: object, sha: string },
   *   stage: 'preparing'|'analysing', keepResult?: boolean }} request
   *   `stage` is the phase the run starts in. Local/checkout runs publish changed rows
   *   before warming the language server and resolving their callers. `keepResult`: the
   *   shown result stays reviewable until the run publishes its own (a caller retry,
   *   which only refines it); the view does not go back to "Analysing…".
   * @returns {{ id: number, signal: AbortSignal } | null} The run's handle, or null when refused.
   *   The signal is aborted when the run is replaced, a checkout starts, or the session is disposed.
   */
  function beginAnalysisRun({ source, stage, keepResult = false }) {
    if (disposed()) return null;
    if (lifecycle.checkout) {
      vscode.window.showWarningMessage(`Impact Tree: PR #${lifecycle.checkout.prNumber} is being checked out — try again when it finishes`);
      return null;
    }
    if (lifecycle.run) {
      log('a newer request replaces the running analysis — cancelling it');
      lifecycle.run.controller.abort();
    }
    abortHints();
    const controller = new AbortController();
    const handle = Object.freeze({ id: ++lifecycle.generation, signal: controller.signal });
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const record = { handle, controller, source, settled, settle };
    records.set(handle, record);
    lifecycle.run = record;
    lifecycle.state = stage;
    if (source.kind !== 'pr') session.resolverOverride = null;     // leaving a PR preview
    if (keepResult && session.state && session.state.result) {
      session.state = { ...session.state, source, retryingCallers: true, hintsPending: false };
    } else {
      session.state = { ...session.state, source, result: null, error: null, problem: null, retryingCallers: false,
        cards: null, hintsPending: false, cardsError: null };
      session.decorate.clear();
    }
    session.provider.refresh();
    notifyAnalysisChanged();
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
   * Publishes a prepared or finished run's result, only while the run is current. The
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
    if (source) notifyAnalysisChanged();     // a refreshed PR may have a new head commit
    return true;
  }

  /**
   * Publishes a run's failure: the view shows `viewError`, the log gets the stack, and
   * an error pops up. A cancellation, a replaced run and a disposed session publish
   * nothing. A checkpoint that is missing or no longer a commit (`NO_CHECKPOINT`) is not
   * a failure of the tool but a mode that cannot run yet: the view says so and offers
   * "Set checkpoint now" (publishRunProblem), and nothing pops up.
   * @param {{ id: number }} run
   * @param {Error} error
   * @param {{ viewError?: string, logLabel?: string }} [shown]
   * @returns {boolean} Whether the failure was published.
   */
  function failAnalysisRun(run, error, { viewError = error.message, logLabel = 'ERROR' } = {}) {
    if (!owns(run) || isAnalysisCancelled(error)) return false;
    if (/** @type {any} */ (error).code === 'NO_CHECKPOINT') {
      return publishRunProblem(run, session.state.checkpoint
        ? { kind: 'checkpointGone', detail: error.message } : { kind: 'noCheckpoint' });
    }
    session.state = { ...session.state, result: null, error: viewError, problem: null };
    log(`${logLabel} ${error.stack || error.message}`);
    vscode.window.showErrorMessage(`Impact Tree: ${error.message}`);
    return true;
  }

  /**
   * Publishes why the run's mode cannot run, only while the run is current: the view shows
   * the matching rows (tree-row-models buildProblemRows). An obsolete run publishes nothing,
   * so a late answer never replaces what a newer run shows.
   * @param {{ id: number }} run
   * @param {{ kind: 'noCheckpoint'|'checkpointGone', detail?: string }} problem
   * @returns {boolean} Whether the problem was published.
   */
  function publishRunProblem(run, problem) {
    if (!owns(run)) return false;
    session.state = { ...session.state, result: null, error: null, problem };
    log(`${problem.kind}${problem.detail ? `: ${problem.detail}` : ''}`);
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
      if (session.state && session.state.retryingCallers) session.state = { ...session.state, retryingCallers: false };
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
   * analysis requested from then on is refused. Cancels every outstanding analysis,
   * including replaced runs, and waits for all of them to settle before git can move.
   * @param {number} prNumber
   * @returns {Promise<{ prNumber: number } | null>} The checkout's handle, or null when the
   *   session is or became disposed.
   * @throws {Error} A checkout is already in progress; callers check checkoutInProgress() first.
   */
  async function beginCheckout(prNumber) {
    if (disposed()) return null;
    if (lifecycle.checkout) throw new Error(`PR #${lifecycle.checkout.prNumber} is already being checked out`);
    const checkout = Object.freeze({ prNumber });
    const pending = [...records.values()];
    lifecycle.checkout = checkout;
    lifecycle.run = null;
    lifecycle.state = 'checkingOut';
    lifecycle.generation++;          // the worktree is about to move under the shown result
    abortHints();
    session.provider.refresh();
    notifyAnalysisChanged();
    if (pending.length) {
      log(`checking out PR #${prNumber} — waiting for outstanding analyses`);
      for (const record of pending) record.controller.abort();
      await Promise.all(pending.map((record) => record.settled));
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
    const wall = (clock.now() - tStart) / 1000;
    if (st.warmUpMs) log(`  server warm-up ${(st.warmUpMs / 1000).toFixed(1)}s (paid once per window)`);
    log(`  WALL ${wall.toFixed(1)}s   (query time sums to ${(st.incomingMs / 1000).toFixed(1)}s across ${result.concurrency} workers — overlapping, not additive)`);
    log(`  queries: ${st.incomingCalls}  min ${st.minMs}ms / median ${st.medianMs}ms / max ${st.maxMs}ms`);
    log(`  ${st.cacheHits} cache hits · ${st.warmupRetries} warmup retries · ${st.skipped} unresolved · ${st.resolvedEmpty} resolved-but-empty${st.unseenUsers ? ` · ${st.unseenUsers} used in files the editor does not search` : ''}`);
    log(`  cqrs: +${st.cqrsEdges} edges / ${st.cqrsSuppressed} handlers de-noised`);
    if (st.valueUsesDropped) log(`  precision: -${st.valueUsesDropped} caller(s) that only use the function as a value, not call it (Go, Python)`);
    if (st.inheritedDropped) log(`  precision: -${st.inheritedDropped} inherited-member over-report(s) (sibling subclasses the call hierarchy wrongly attributes to an override)`);
    if (st.slowest) log(`  slowest query ${st.slowest.ms}ms -> ${path.relative(repo, st.slowest.file)}@${st.slowest.pos}`);
    if (st.resolvedEmpty) {
      log(`  NOTE: ${st.resolvedEmpty} symbol(s) the language server listed no callers for (before each language's own checks, which may still read them as incomplete):`);
      for (const e of st.emptyAt || []) {
        const { offsetToPosition } = require('./engine/textpos');
        const p3 = offsetToPosition(e.file, e.pos);
        log(`    - ${path.relative(repo, e.file)}:${p3 ? p3.line + 1 : '?'}`);
      }
      log('    For TypeScript, a component whose project the editor has not loaded under-reports here; the row\'s own state is the answer.');
    }
  }

  function configureLocalReview(source, repo, result, base) {
    if (!review) return;
    const { makeGit } = require('./engine/git');
    const { createReviewIdentity, localRevisions } = require('./review-identity');
    // A review without TypeScript or JavaScript files does not load the compiler here; the
    // identity loads it only if a row ever needs it.
    const { loadTypeScriptIfUsed } = require('./languages/typescript/load');
    const ts = loadTypeScriptIfUsed(repo, Object.keys(result.fileStatus || {}));
    const identity = createReviewIdentity(ts, repo, localRevisions(repo, result, makeGit(repo, { objectDirs: getObjectDirs() })));
    const { key, replaces, branch } = reviewKeys(source, repo, result, base);
    review.configure(key, identity, { migrateFrom: replaces, branch });
  }

  // Which review the result belongs to, and the key it replaces. A checked-out PR is
  // identified by its number alone: its worktree is a detached HEAD, which names no
  // branch, and a push must not start the review over (row ids carry the content, so a
  // changed row is unticked anyway). The mode is the one requested, so a `pr` run that
  // fell back to `branch` over a dirty tree stays the same review. Earlier builds keyed on
  // the head commit as well, and before that on `HEAD` (every checked-out PR alike) with
  // the effective mode; `replaces` lists those keys, best first, for review.configure to
  // copy ticks from the first time the new key loads.
  function reviewKeys(source, repo, result, base) {
    const key = (who, mode) => `v2:${repo}:${who}:${mode}:${base}`;
    const who = source.kind === 'checkout'
      ? `pr-checkout:${source.pr.number}`
      : require('./engine/git').makeGit(repo).currentBranch();
    const current = key(who, result.requestedMode);
    const replaced = source.kind === 'checkout'
      ? [key(`${who}@${source.sha}`, result.requestedMode), key('HEAD', result.mode)]
      : [key(who, result.mode)];
    // Cleanup's branch: the checked-out branch of a local review; none for a PR checkout
    // (identified by number) or a detached HEAD.
    const branch = source.kind === 'checkout' || !who || who === 'HEAD' ? null : who;
    return { key: current, replaces: replaced.filter((k) => k !== current), branch };
  }

  // The first-index status of the current user-started run, for the Changes view's message.
  // Owner: the run named in `run`; only that run sets or clears it, and only while current.
  const indexing = { run: null, text: null };
  const indexingListeners = new Set();
  const setIndexing = (run, text) => {
    indexing.run = text === null ? null : run;
    indexing.text = text;
    for (const listener of [...indexingListeners]) {
      try { listener(); } catch (e) { log(`an indexing listener failed: ${e && e.message}`); }
    }
  };
  /**
   * @param {() => void} listener Called when the indexing text changes; read it with getIndexingText().
   * @returns {{ dispose: () => void }}
   */
  function onDidChangeIndexing(listener) {
    if (disposed()) return { dispose() {} };
    indexingListeners.add(listener);
    return { dispose: () => indexingListeners.delete(listener) };
  }
  /**
   * @returns {string|null} While a run waits for the first index, what it waits for with the
   *   elapsed time: "Indexing the workspace…" for TypeScript, "Waiting for <server>…" for a
   *   language that names its server (`serverLabel`, such as Go's).
   */
  const getIndexingText = () => indexing.text;

  /**
   * Waits for the language server to be ready on behalf of a user-started run. While the
   * first index is being built it shows a hideable status-bar progress (window location)
   * and the Changes view message, both with the elapsed seconds, refreshed every
   * `indexingTickMs`. There is deliberately no percentage: the language server reports no
   * progress, so any figure would be invented, and an invented figure is a claim the tool
   * cannot back. Prewarm never calls this, so background warm-up stays silent.
   * The timer is cleared in `finally` (completion, failure, cancellation, replacement); it
   * only publishes while the run is current, and an older run's cleanup leaves a newer
   * run's text alone.
   * @param {{ id: number, signal: AbortSignal }} run
   * @param {Promise<boolean>} ready The shared warm-up (`session.ensureReady`).
   * @returns {Promise<boolean>}
   */
  async function untilReady(run, ready) {
    if (!session.isIndexing()) return untilCancelled(run.signal, ready);
    const since = clock.now();
    let timer = null;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Impact Tree' },
        async (windowProgress) => {
          const tick = () => {
            if (!owns(run)) return;
            const seconds = Math.floor((clock.now() - since) / 1000);
            const server = session.indexingServer();
            const text = server
              ? `Waiting for ${server}… ${seconds} s`
              : `Indexing the workspace, first run only — usually 10–35 s… ${seconds} s`;
            windowProgress.report({ message: text });
            setIndexing(run, text);
          };
          tick();
          timer = clock.setInterval(tick, indexingTickMs);
          return untilCancelled(run.signal, ready);
        });
    } finally {
      clock.clearInterval(timer);
      if (indexing.run === run) setIndexing(run, null);
    }
  }

  // Analyses the working repository for `run` and publishes the result if the run is
  // still current. Throws on failure, including the cancellation error.
  // `retry`: a caller retry (see scheduleCallerRetry). It keeps the resolver's answers, so
  // only what did not finish is asked again, publishes no early rows (the shown result
  // stays), does not fetch, and schedules no further retry.
  async function analyseLocalRun(run, source, mode, progress, { retry = false } = {}) {
    // A replaced run must not clear the resolver a newer run is using.
    throwIfCancelled(run.signal);
    const repo = repoRoot();
    const cfg = vscode.workspace.getConfiguration('impactTree');
    const baseRemote = session.baseRemote();
    if (baseRemote.name === null) throw new Error(`Cannot resolve the base branch: ${baseRemote.problem}`);
    // An empty setting is the remote's default branch, named here: the name is part of the
    // review key, so a repository whose default is `main` keeps the key (and ticks) it had
    // when the setting defaulted to `main`.
    const { makeGit, remoteDefaultBranch } = require('./engine/git');
    const base = source.kind === 'checkout' ? source.pr.baseRef
      : (cfg.get('baseBranch', '') || remoteDefaultBranch(makeGit(repo), baseRemote.name) || 'main');
    if (!retry) {
      session.resolver.clear();
      session.localResolver = null;
    }
    const tStart = clock.now();
    const report = (m) => { if (!run.signal.aborted && progress) progress.report({ message: m }); };
    // Read once per run: the cards of this run follow the setting as it was when the run began.
    const withCards = cardsEnabled();
    // vscode.commands.executeCommand takes no cancellation token, so the language
    // server cannot be told to stop. The signal stops new queries; one already sent
    // finishes in the server and its answer is dropped with the cancelled run.
    const result = await analyze(repo, {
      onPrepared: retry ? undefined : async (pending) => {
        if (!completeAnalysisRun(run, { result: pending, repo, expansionResolver: null })) return;
        configureLocalReview(source, repo, pending, base);
        session.provider.refresh();
        log(`changed files ready in ${clock.now() - tStart}ms; caller analysis continues`);
        if (pending.allChanged.length) await untilReady(run, session.ensureReady(progress));
      },
      onProgress: (p2) => {
        if (p2.phase === 'component') report(`analysing ${p2.component}…`);
        else if (p2.total) report(`${p2.component}: resolving callers ${p2.done}/${p2.total}`);
      },
      mode, base, remote: baseRemote.name, fetch: !retry && cfg.get('fetchBase', true),
      checkpoint: session.state && session.state.checkpoint,
      objectDirs: getObjectDirs(),
      tempDir: getTempDir(),
      depth: cfg.get('reachDepth', 2),
      skipForest: true,                      // the tree resolves callers on expand
      deferTestReach: !(session.state && session.state.wantTestReach), // only one section needs it
      concurrency: cfg.get('concurrency', 8),
      onDirty: 'fallback',                   // never blank the view because a file is edited
      ...(withCards ? { impactPaths: true } : {}),   // the entry points the cards show
      makeResolver: () => session.resolver,
      // The same services the resolver asks: server-backed languages (Go) read their
      // symbols through them, under the same request cap and deadlines.
      languageServices: session.resolver.services,
      makeModuleCallers: ({ ts, git }) => {
        if (!modulePool || moduleRepo !== repo) {
          modulePool?.dispose();
          moduleRepo = repo;
          modulePool = require('./module-caller-pool').createModuleCallerPool(repo, { clock });
        }
        return modulePool.forAnalysis(ts, git, run.signal);
      },
      signal: run.signal,
    });
    throwIfCancelled(run.signal);
    result.moduleCallers?.complete?.();
    const expansionResolver = withModuleCallers(session.resolver, result.moduleCallers);
    if (!completeAnalysisRun(run, { result, repo, expansionResolver })) return;
    logLocalRun(result, repo, tStart);
    configureLocalReview(source, repo, result, base);
    const stale = result.findings.reduce((n, f) => n + f.staleCallers, 0);
    vscode.window.setStatusBarMessage(
      `Impact Tree: ${result.findings.length} finding(s), ${stale} caller(s) not updated, base ${result.base.ref}`, 8000);
    if (withCards) {
      await publishCards(run, {
        result, report, hintsOptions: { repo, head: 'HEAD' },
        gatherFacts: (signal) => require('./engine/cards').gatherLocalCardFacts({ repo, base: result.base.sha, head: 'HEAD', signal }),
      });
    }
    const unanswered = result.allChanged.filter((c) => c.callersRetryable).length;
    if (retry) log(`caller retry: ${unanswered} search(es) still did not finish`);
    else if (unanswered) void scheduleCallerRetry(run, source, mode, result, unanswered);
  }

  /**
   * Caller searches that timed out or met a server still loading are asked again once:
   * after waiting (at most callerRetryWaitMs) until the language server answers a caller
   * query, a retry run re-asks only them (the answers that finished are kept), and the
   * shown result stays reviewable meanwhile. Skipped when anything else has been shown
   * since, or the session ends. Owner: the result it was scheduled for; a newer run or
   * result makes it do nothing. Never rejects.
   * @param {{ id: number }} run The run that published `result`; the retry starts after it ended.
   * @param {object} source @param {string} mode @param {any} result @param {number} count
   * @returns {Promise<void>}
   */
  async function scheduleCallerRetry(run, source, mode, result, count) {
    const id = lifecycle.generation;
    const ended = records.get(run) ? records.get(run).settled : Promise.resolve();
    const stillShown = () => !disposed() && isCurrentAnalysis(id) && session.state && session.state.result === result;
    const target = result.allChanged.find((c) => c.callersRetryable);
    const searches = `${count} caller search${count === 1 ? '' : 'es'}`;
    // The server the retry waits for: the target's language's (Go's names gopls), else TypeScript.
    const { languageFor } = require('./languages');
    const targetLanguage = target.relPath ? languageFor(target.relPath) : null;
    const waitFor = (targetLanguage && targetLanguage.serverLabel) || 'TypeScript';
    log(`${searches} did not finish (the language server did not answer in time); retrying once it answers`);
    const token = {};
    const since = clock.now();
    const tick = () => {
      if (stillShown()) setIndexing(token, `${searches} timed out — retrying when ${waitFor} has loaded… ${Math.floor((clock.now() - since) / 1000)} s`);
      else if (indexing.run === token) setIndexing(token, null);
    };
    tick();
    const timer = clock.setInterval(tick, indexingTickMs);
    let ready = false;
    try {
      ready = await session.resolver.warmUp(target.file, target.namePos, { timeoutMs: callerRetryWaitMs });
    } catch (e) {
      log(`caller retry: waiting for the language server failed: ${e && e.message}`);
    } finally {
      clock.clearInterval(timer);
      if (indexing.run === token) setIndexing(token, null);
    }
    await ended;
    if (!stillShown() || lifecycle.run) return;
    if (!ready) {
      log(`caller retry: the language server did not answer within ${Math.round(callerRetryWaitMs / 1000)} s — press Refresh to try again`);
      return;
    }
    log(`caller retry: the language server answers now; asking ${searches} again`);
    await analyseLocally(source, mode, { retry: true });
  }

  // Runs a local analysis of `source` in `mode`; never rejects.
  async function analyseLocally(source, mode, { retry = false } = {}) {
    const run = beginAnalysisRun({ source, stage: 'analysing', keepResult: retry });
    if (!run) return;
    try {
      // Nothing to analyse here is not an error: the view says why and what to do (the
      // welcome screens in package.json), so no popup.
      const repo = repoStatus();
      if (repo !== 'ok') { log(`not analysing: ${repo}`); return; }
      // Checkpoint mode has no base until a checkpoint is recorded. Say so instead of
      // starting an analysis that can only fail; a recorded one that is no longer a commit
      // is found by the analysis itself and arrives through failAnalysisRun.
      if (mode === 'checkpoint' && !(session.state && session.state.checkpoint)) {
        publishRunProblem(run, { kind: 'noCheckpoint' });
        return;
      }
      await vscode.window.withProgress(
        { location: { viewId: 'impactTree.changes' }, title: 'Impact Tree' },
        async (progress) => {
          session.ensureResolver();
          beginAnalysingStage(run);
          session.provider.refresh();
          await analyseLocalRun(run, source, mode, progress, { retry });
        });
    } catch (e) {
      // A failed retry leaves the result it was refining: that one is still true.
      if (retry) { if (!isAnalysisCancelled(e)) log(`caller retry failed: ${e && e.message}`); } else failAnalysisRun(run, e);
    } finally {
      releaseAnalysisRunResources(run);
    }
  }

  /**
   * Analyses the working repository, replacing any running analysis. Never rejects: a
   * failure is published through failAnalysisRun. Without `mode` it repeats the current
   * source: a checked-out PR against its own base, otherwise the `impactTree.mode`
   * setting. Naming a `mode` picks a local analysis, which leaves a checked-out PR.
   * @param {string} [mode]
   * @returns {Promise<void>} Settles when this run has ended, whether it completed,
   *   failed, was refused or was replaced.
   */
  function refresh(mode) {
    const held = session.state && session.state.source;
    if (!mode && held && held.kind === 'checkout') return analyseCheckedOutPr(held.pr, held.sha);
    return analyseLocally({ kind: 'local' }, mode || vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'));
  }

  /**
   * The worktree just moved (a checkout): the language server reloads its projects, so it
   * is treated as cold again and the next analysis warms it up first.
   * @returns {void}
   */
  function languageServerMayReload() {
    if (session.resolver && session.resolver.expectReload) session.resolver.expectReload();
    session.readyPromise = null;
  }

  /**
   * Analyses the worktree as PR `pr` checked out at `sha`, against the PR's base, and
   * makes that PR the session source: every later plain refresh repeats it until another
   * source is picked. Replaces any running analysis; never rejects.
   * @param {{ number: number, baseRef: string }} pr
   * @param {string} sha The head commit that was checked out.
   * @returns {Promise<void>} As refresh().
   */
  function analyseCheckedOutPr(pr, sha) {
    return analyseLocally({ kind: 'checkout', pr, sha }, 'pr');
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
    abortHints();
    modulePool?.dispose();
    modulePool = null;
    session.resolver = null;
    session.localResolver = null;
    session.resolverOverride = null;
    session.readyPromise = null;
    session.state = null;
    analysisListeners.clear();
    cardsListeners.clear();
    indexingListeners.clear();
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
    repoRoot, repoStatus, isTierA, viewStateFromResult, onDidChangeIndexing, getIndexingText, refresh, analyseCheckedOutPr, languageServerMayReload, refreshWithTestReach, setCheckpoint,
    beginAnalysisRun, beginAnalysingStage, completeAnalysisRun, failAnalysisRun, releaseAnalysisRunResources,
    isCurrentAnalysis, getAnalysisId, beginCheckout, endCheckout, checkoutInProgress, isBusy, getPhase,
    prewarmInBackground, dispose, treeResolver, onDidChangeAnalysis,
    onDidChangeCards, cardsEnabled, publishCards,
  });
  const { ensureReady, ensureResolver, isIndexing, indexingServer } = createReadiness(vscode, session, { log, getScratchDir, clock });
  session.ensureReady = ensureReady;
  session.ensureResolver = ensureResolver;
  session.isIndexing = isIndexing;
  session.indexingServer = indexingServer;
  return session;
}

module.exports = { createSession };
