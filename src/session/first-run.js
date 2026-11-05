// @ts-check
'use strict';

// The window's first review runs by itself. When the extension starts in a repository whose
// branch is ahead of its base, the branch is reviewed with no mode to pick: the Review view
// then shows that review alone, the worst row is selected with its explanation in Details,
// and the first time ever a one-line hint says what red means. A detached HEAD ahead of the
// base (a checked-out pull request) counts. Nothing runs on a branch with no commits of its
// own or an unknown base: the view's picker is the way in there. The `impactTree.analyseOnStartup` setting turns this off (`never`) or widens it to
// every window (`always`); its old boolean values still mean what they did.

const { resolveBase } = require('../engine/git');

/** Global state: the hint was shown once, on the first result ever. */
const HINTED_KEY = 'impactTree.firstRun.hinted';
const HINT = 'Red: a caller wasn\'t updated. Start there.';
/** Delay before the branch is checked, so activation stays quick. Unit: ms. */
const START_DELAY_MS = 1500;
/** Selecting the worst row races the tree's repaint for the result: tries, and the gap between them. Unit: tries, ms. */
const SELECT_TRIES = 3;
const SELECT_RETRY_MS = 300;

/**
 * @typedef {'branch'|'always'|'never'} Policy
 * @typedef {{ run: boolean, reason: 'ahead'|'always'|'never'|'not-ahead'|'no-base'|'no-repo'|'held' }} Decision
 */

/**
 * The startup policy a setting value means. `true` and `false` are the setting's old
 * boolean form (analyse every window / never by itself).
 * @param {unknown} raw
 * @returns {Policy}
 */
function startupPolicy(raw) {
  if (raw === true || raw === 'always') return 'always';
  if (raw === false || raw === 'never') return 'never';
  return 'branch';
}

/**
 * Whether HEAD has commits its base does not have (a branch of its own, or a checked-out
 * pull request). Two git commands, no fetch; any failure reads as unknown (`ahead: null`),
 * never as "not ahead".
 * @param {any} git From `makeGit`.
 * @param {{ base: string, remote: string }} o `base`: the base branch setting ('' for the remote's default).
 * @returns {{ ahead: number|null, reason: 'ahead'|'not-ahead'|'no-base' }}
 */
function branchAheadOfBase(git, { base, remote }) {
  /** @type {string} */
  let baseSha;
  try {
    baseSha = resolveBase(git, base, { fetch: false, remote }).sha;
  } catch {
    return { ahead: null, reason: 'no-base' };
  }
  const count = git.tryRaw(['rev-list', '--count', `${baseSha}..HEAD`]);
  const ahead = count === null ? NaN : Number(count.trim());
  if (!Number.isSafeInteger(ahead)) return { ahead: null, reason: 'no-base' };
  return { ahead, reason: ahead > 0 ? 'ahead' : 'not-ahead' };
}

/**
 * Whether to review by itself now.
 * @param {{ policy: Policy, repoStatus: string, held: boolean, ahead: () => ReturnType<typeof branchAheadOfBase> }} o
 *   `held`: a review is already shown or running. `ahead` is asked only when it decides.
 * @returns {Decision}
 */
function decideAutoReview({ policy, repoStatus, held, ahead }) {
  if (policy === 'never') return { run: false, reason: 'never' };
  if (repoStatus !== 'ok') return { run: false, reason: 'no-repo' };
  if (held) return { run: false, reason: 'held' };
  if (policy === 'always') return { run: true, reason: 'always' };
  const a = ahead();
  return { run: a.reason === 'ahead', reason: a.reason };
}

/**
 * @param {any} vscode
 * @param {{
 *   session: { refresh: () => Promise<unknown>, repoStatus: () => string, repoRoot: () => string, baseRemote: () => { name: string|null },
 *     state: any, isBusy: () => boolean },
 *   provider: { nextUnreviewed: (after: null) => any, reviewCounts: () => { attention: number }|null,
 *     onDidChangePresentation: (l: (e: { reason: string }) => void) => { dispose(): void } },
 *   rowId: (row: any) => string|null|undefined,
 *   view: { reveal: (row: any, o: object) => PromiseLike<void>|void, selection: readonly any[] },
 *   treeRead: () => Promise<unknown>,
 *   globalState: { get: (k: string) => unknown, update: (k: string, v: unknown) => PromiseLike<void> }|null,
 *   makeGit: (repo: string) => any, log: (m: string) => void,
 *   clock: { setTimeout: (f: () => void, ms: number) => any, clearTimeout: (t: any) => void },
 *   telemetry?: { event: (name: string, props?: Record<string, unknown>) => void },
 * }} deps `rowId`: a row's tree id (review-tree-model.js `treeItemId`). `treeRead`: settles once the Review view has read its root for the shown result
 *   (review-sidebar.js `hostRow`), so a row selected before the repaint is not lost to it.
 */
function createFirstRun(vscode, { session, provider, view, treeRead, rowId, globalState, makeGit, log, clock, telemetry }) {
  /** @type {{ dispose(): void }|null} */
  let waiting = null;
  let timer = /** @type {any} */ (null);

  /** Whether the view's selection is `row` (by tree id: a repaint rebuilds the row objects). @param {any} row */
  const selected = (row) => {
    const id = rowId(row);
    return id != null && (view.selection || []).some((r) => rowId(r) === id);
  };

  /** Selects the worst row once the tree has read the result, trying again when a repaint dropped it. */
  async function selectWorst() {
    await treeRead();
    for (let i = 0; i < SELECT_TRIES; i++) {
      const row = provider.nextUnreviewed(null);
      if (!row) return;
      await Promise.resolve(view.reveal(row, { select: true, focus: false, expand: true }));
      if (selected(row)) { log(`first run: selected ${row.label}`); return; }
      await new Promise((r) => clock.setTimeout(() => r(undefined), SELECT_RETRY_MS));
    }
    log('first run: the worst row could not be kept selected');
  }

  /** Once the auto-run's result is complete: select its worst row, and hint the first time ever. */
  function onResult() {
    const result = session.state && session.state.result;
    if (!result || result.callersPending) return;
    if (waiting) { waiting.dispose(); waiting = null; }
    selectWorst().catch((e) => log(`first run: could not select the worst row: ${e && e.message}`));
    const counts = provider.reviewCounts();
    if (!globalState || globalState.get(HINTED_KEY) || !counts || counts.attention === 0) return;
    void Promise.resolve(globalState.update(HINTED_KEY, true)).then(undefined, () => {});
    void vscode.window.showInformationMessage(`Impact Tree: ${HINT}`);
  }

  /** The decision and, when it says so, the run. */
  function start() {
    const cfg = vscode.workspace.getConfiguration('impactTree');
    const decision = decideAutoReview({
      policy: startupPolicy(cfg.get('analyseOnStartup')),
      repoStatus: session.repoStatus(),
      held: Boolean(session.state && (session.state.result || session.state.error)) || session.isBusy(),
      ahead: () => {
        try {
          const remote = session.baseRemote().name;
          if (remote === null) return { ahead: null, reason: 'no-base' };
          return branchAheadOfBase(makeGit(session.repoRoot()), { base: cfg.get('baseBranch', ''), remote });
        } catch (e) {
          log(`first run: could not read the branch: ${e && /** @type {any} */ (e).message}`);
          return { ahead: null, reason: 'no-base' };
        }
      },
    });
    if (telemetry) telemetry.event('startup.review', { ran: decision.run, reason: decision.reason });
    if (!decision.run) { log(`first run: not reviewing by itself (${decision.reason})`); return; }
    log(`first run: reviewing the branch by itself (${decision.reason})`);
    // The result lands as a presentation change of the tree (reason `analysis`); the
    // session's own analysis event fires when a run begins, not when it finishes.
    waiting = provider.onDidChangePresentation((e) => { if (e && e.reason === 'analysis') onResult(); });
    session.refresh().catch((e) => log(`first run: the review failed: ${e && e.message}`));
  }

  return {
    /** Checks the branch after a short delay, so activation stays quick. */
    schedule() { timer = clock.setTimeout(() => { timer = null; start(); }, START_DELAY_MS); },
    start,
    dispose() {
      if (timer !== null) clock.clearTimeout(timer);
      if (waiting) waiting.dispose();
      timer = null; waiting = null;
    },
  };
}

module.exports = { createFirstRun, decideAutoReview, branchAheadOfBase, startupPolicy, HINT, HINTED_KEY, START_DELAY_MS };
