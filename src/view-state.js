// @ts-check
'use strict';

// What the Changes view is in, as one word. Pure: the tree decides its placeholder rows
// from it and the extension publishes it as the `impactTree.state` context key, which the
// `viewsWelcome` entries in package.json test. One function feeds both, so a welcome
// screen can never disagree with the rows (and an empty tree can never read as "no impact").

/**
 * - `noFolder`, `noGit`: nothing can be analysed here; the view is empty and says why.
 * - `busy`: a spinner row is shown (preparing, analysing, checking out).
 * - `problem`: message rows explain why a mode cannot run (e.g. no checkpoint).
 * - `error`: an analysis failed; the error is a row.
 * - `idle`: nothing has been analysed yet; the view is empty and offers the three ways in.
 * - `noTypeScript`: every changed source file was left unanalysed because TypeScript could
 *   not be loaded; the view is empty and says to install dependencies.
 * - `nothingChanged`: the analysis completed and found no change in its mode.
 * - `shown`: a result with something to review.
 * @typedef {'noFolder'|'noGit'|'busy'|'problem'|'error'|'idle'|'noTypeScript'|'nothingChanged'|'shown'} ViewState
 */

/**
 * Whether the working repository can be analysed. Decided by the session
 * (`session.repoStatus()`), which looks at the workspace.
 * @typedef {'ok'|'noFolder'|'noGit'} RepoStatus
 */

/**
 * True when the run established nothing about any change because the TypeScript compiler
 * could not be loaded: every changed source file is unanalysed and nothing else is listed.
 * A partial failure is not this: the files that were analysed still have a tree, and the
 * warning rows say which were not.
 * @param {any} result
 * @returns {boolean}
 */
function allUnanalysable(result) {
  const unanalysed = (result.unanalysable || []).reduce((/** @type {number} */ n, /** @type {{ count: number }} */ u) => n + u.count, 0);
  if (unanalysed === 0 || unanalysed < result.changedFileCount || result.allChanged.length > 0) return false;
  const unanalysedPaths = new Set(result.changedPaths || []);
  return (result.otherFiles || []).every((/** @type {{ path: string }} */ f) => unanalysedPaths.has(f.path));
}

/**
 * True when an analysis completed and the mode shows no change at all: no changed symbol,
 * deletion or other file. A Preview is not judged here.
 * @param {any} result
 * @returns {boolean}
 */
function isNothingChanged(result) {
  return !result.tierA && !result.callersPending && result.allChanged.length === 0
    && (result.deleted || []).length === 0 && (result.otherFiles || []).length === 0;
}

/**
 * @param {{ repo?: RepoStatus, phase: string, busy: boolean, state: any }} view `state` is
 *   the session state; `phase` and `busy` the lifecycle's.
 * @returns {ViewState}
 */
function viewStateOf({ repo = 'ok', phase, busy, state }) {
  if (repo !== 'ok') return repo;
  const result = state && state.result;
  // A prepared result belongs to the current run and is safe to review while callers load.
  if ((phase === 'analysing' || phase === 'preparing' || busy) && result && result.callersPending) return 'shown';
  if (phase === 'starting' || phase === 'preparing' || phase === 'analysing' || phase === 'checkingOut' || busy) return 'busy';
  if (state && state.problem) return 'problem';
  if (!state || (!result && !state.error)) return 'idle';
  if (state.error) return 'error';
  if (allUnanalysable(result)) return 'noTypeScript';
  if (isNothingChanged(result)) return 'nothingChanged';
  return 'shown';
}

/**
 * The context keys the welcome screens test. `impactTree.resultMode` is the mode the
 * shown result was requested in (`pr`, `branch`, `working`, `checkpoint`) while it shows
 * nothing changed, else empty.
 * @param {{ repo?: RepoStatus, phase: string, busy: boolean, state: any }} view
 * @returns {{ 'impactTree.state': ViewState, 'impactTree.resultMode': string }}
 */
function contextKeysOf(view) {
  const state = viewStateOf(view);
  const mode = state === 'nothingChanged' ? view.state.result.requestedMode : '';
  return { 'impactTree.state': state, 'impactTree.resultMode': typeof mode === 'string' ? mode : '' };
}

module.exports = { viewStateOf, contextKeysOf, isNothingChanged, allUnanalysable };
