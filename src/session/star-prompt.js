'use strict';
// Asks, after the user's second review, whether they would star the repository on
// GitHub. A review is one review key (src/session/review-state.js): a local branch or a PR.
// Refreshing the same review does not count again. State lives in the editor's global
// state, so the count spans every window and repository. Answering either button ends it
// for good; closing the notification without an answer asks again after 5 more reviews.

const STATE_KEY = 'impactTree.starPrompt';
/** Distinct reviews finished before the question is first asked. */
const REVIEWS_BEFORE_ASKING = 2;
/** More distinct reviews before asking again after a prompt closed without an answer. */
const REVIEWS_BEFORE_ASKING_AGAIN = 5;
const REPO_URL = 'https://github.com/SalahMo24/impact-tree';
const STAR = 'Star on GitHub';
const NO_THANKS = 'No thanks';

/**
 * @typedef {{ get: (key: string) => unknown, update: (key: string, value: unknown) => PromiseLike<void> }} Memento
 * @typedef {{ reviews: string[], asked: boolean, need: number }} StarState
 *   `reviews`: distinct review keys counted toward the next question; `need`: how many
 *   `reviews` must hold to ask; `asked`: answered, never ask again.
 */

/** @param {unknown} raw @returns {StarState} */
function readState(raw) {
  const r = /** @type {any} */ (raw);
  if (!r || typeof r !== 'object') return { reviews: [], asked: false, need: REVIEWS_BEFORE_ASKING };
  const reviews = Array.isArray(r.reviews) ? r.reviews.filter((k) => typeof k === 'string') : [];
  const need = Number.isSafeInteger(r.need) && r.need > 0 ? r.need : REVIEWS_BEFORE_ASKING;
  return { reviews, asked: r.asked === true, need };
}

/**
 * The state after a review finished, and whether to ask now. Keys are stored only until
 * the count is reached, so the state stays a few short strings. While the question is
 * open the state says `asked`, so no second one starts; `afterDismissed` reopens it.
 * @param {StarState} state @param {string} key
 * @returns {{ state: StarState, ask: boolean }}
 */
function afterReview(state, key) {
  if (state.asked || !key || state.reviews.includes(key)) return { state, ask: false };
  const reviews = [...state.reviews, key];
  if (reviews.length < state.need) return { state: { ...state, reviews }, ask: false };
  return { state: { reviews: [key], asked: true, need: state.need }, ask: true };
}

/**
 * The state after the question closed without an answer: ask again once 5 more distinct
 * reviews finish. The review that triggered the question stays in `reviews`, so running
 * it again does not count.
 * @param {StarState} state @returns {StarState}
 */
function afterDismissed(state) {
  return { reviews: state.reviews, asked: false, need: state.reviews.length + REVIEWS_BEFORE_ASKING_AGAIN };
}

/**
 * @param {*} vscode
 * @param {{ globalState: Memento|null|undefined, log?: (m: string) => void,
 *   telemetry?: { event: (name: string, props?: Record<string, unknown>) => void } }} deps
 *   Without global state (a test harness) nothing is counted or asked.
 * @returns {{ reviewFinished: (key: string) => void }}
 */
function createStarPrompt(vscode, { globalState, log = () => {}, telemetry }) {
  // One question at a time even if two reviews finish together.
  let busy = false;
  async function reviewFinished(key) {
    if (!globalState || busy) return;
    busy = true;
    try {
      const { state, ask } = afterReview(readState(globalState.get(STATE_KEY)), key);
      await globalState.update(STATE_KEY, state);
      if (!ask) return;
      const pick = await vscode.window.showInformationMessage(
        'Impact Tree: enjoying it? A star on GitHub helps other reviewers find it.', STAR, NO_THANKS);
      if (telemetry) telemetry.event('starPrompt.answered', { answer: pick === STAR ? 'star' : pick === NO_THANKS ? 'no' : 'dismissed' });
      if (pick === undefined) await globalState.update(STATE_KEY, afterDismissed(state));
      else if (pick === STAR) await vscode.env.openExternal(vscode.Uri.parse(REPO_URL));
    } catch (e) {
      log(`star prompt: ${e && /** @type {any} */ (e).message}`);
    } finally {
      busy = false;
    }
  }
  return { reviewFinished: (key) => { void reviewFinished(key); } };
}

module.exports = { createStarPrompt, afterReview, afterDismissed, readState, STATE_KEY, REPO_URL };
