// @ts-check
'use strict';

// "Comment on this call", on a caller row's context menu in the change tree. It starts a
// comment about the call: on the call's line when that line can take one, else on the
// change the caller is under, naming the caller. For a pull request under review it is a
// GitHub review comment (`createReviewComments`); for a review of the files on disk it is a
// feedback draft for the agent (`createFeedbackComments`). A checked-out pull request has
// both, and the pull request's comment wins, as the caller's 💬 in Details did.

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/** @typedef {import('./review-comments-model').CallerContext} CallerContext */

const COMMAND = 'impactTree.commentOnCall';

/**
 * What the command asks of each comment kind.
 * @typedef {{ commentOnCaller: (row: TreeRow, caller: CallerContext) => Promise<unknown> }} CallerCommenter
 */

/**
 * Registers the command.
 * @param {any} vscode
 * @param {{
 *   provider: { getParent: (row: TreeRow) => TreeRow|undefined|null,
 *     threadsView: () => { status: string, message?: string } },
 *   getState: () => { result: any, rel: (file: string) => string }|null,
 *   lineOf: (file: string, offset: number) => number|null,
 *   reviewComments: () => CallerCommenter|null,
 *   feedbackComments: () => (CallerCommenter & { available: () => boolean })|null,
 * }} deps `lineOf` gives the 1-based line of an offset in a file, or null when it cannot be
 *   read. `threadsView().status` is `none` when no pull request is under review.
 * @returns {{ dispose(): any }}
 */
function createCallerComment(vscode, { provider, getState, lineOf, reviewComments, feedbackComments }) {
  /** @param {string} text */
  const tell = (text) => vscode.window.showWarningMessage(`Impact Tree: ${text}`);

  /**
   * The change a direct caller calls: the row above it, or above its file group. A caller
   * of a caller has none, since its call is to another caller, not to the change.
   * @param {TreeRow} row
   * @returns {TreeRow|null}
   */
  function changeOf(row) {
    let up = provider.getParent(row);
    if (up && up.type === 'callerFile') up = provider.getParent(up);
    return up && up.type === 'finding' ? up : null;
  }

  /**
   * The caller as a comment names it, with the line of its call; null (after saying why)
   * when the line cannot be read.
   * @param {TreeRow} caller
   * @param {{ rel: (file: string) => string }} state
   * @returns {CallerContext|null}
   */
  function contextOf(caller, state) {
    const offset = caller.callSites && caller.callSites[0] ? caller.callSites[0].start : caller.pos;
    const siteLine = typeof offset === 'number' ? lineOf(caller.file, offset) : null;
    const relPath = caller.relPath ?? state.rel(caller.file);
    if (siteLine == null || !relPath) {
      tell(`the line of ${caller.label}'s call could not be read, so a comment about it cannot be started.`);
      return null;
    }
    return { label: caller.label, test: !!caller.test, relPath, siteLine, callState: caller.callState };
  }

  /** @param {unknown} arg The caller row, from the tree's context menu. */
  async function commentOnCall(arg) {
    const caller = /** @type {TreeRow|null} */ (arg && typeof arg === 'object' ? arg : null);
    if (!caller || caller.type !== 'caller' || typeof caller.file !== 'string') return;
    const state = getState();
    if (!state || !state.result) return;
    const change = changeOf(caller);
    if (!change) { tell(`${caller.label} calls another caller, not a change. Comment on the direct caller instead.`); return; }
    const threads = provider.threadsView();
    if (threads.status === 'loading') { tell('the pull request review is still loading. Try again in a moment.'); return; }
    if (threads.status === 'failed') { tell(`the pull request review could not be loaded: ${threads.message}. Refresh to try again.`); return; }
    const review = threads.status === 'none' ? null : reviewComments();
    const feedback = review ? null : feedbackComments();
    if (!review && !(feedback && feedback.available())) { tell('comments can be started on a pull request under review or a review of local changes.'); return; }
    const context = contextOf(caller, state);
    if (!context) return;
    await /** @type {CallerCommenter} */ (review || feedback).commentOnCaller(change, context);
  }

  return vscode.commands.registerCommand(COMMAND, commentOnCall);
}

module.exports = { createCallerComment, COMMAND };
