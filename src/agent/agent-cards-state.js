// @ts-check
'use strict';

// What the Cards view remembers about "Analyse with my agent", in memory only: whether it is
// waiting for the agent's cards (and since when), which head the shown analysis has, and
// whether the user asked for the engine's cards while an agent result exists. Each method
// returns whether the view should be redrawn. Pure: the caller passes the time.

/**
 * @typedef {object} Waiting
 * @property {string} head The head commit the prompt was made for.
 * @property {number} askedAt Epoch milliseconds.
 */

function createAgentCardsState() {
  /** @type {string|null} The head of the analysis shown, or null while there is none (or no checkout review). */
  let head = null;
  /** @type {Waiting|null} */
  let waiting = null;
  let showEngine = false;

  return {
    get head() { return head; },
    get waiting() { return waiting ? { ...waiting } : null; },
    get showEngine() { return showEngine; },
    /** A hand-off succeeded for `forHead`. @param {string} forHead @param {number} now @returns {boolean} */
    asked(forHead, now) { waiting = { head: forHead, askedAt: now }; return true; },
    /** The user stopped waiting. @returns {boolean} */
    cancel() { const was = waiting !== null; waiting = null; return was; },
    /** The analysis head changed (null: none). Waiting for another head ends. @param {string|null} next @returns {boolean} */
    headChanged(next) {
      if (next === head) return false;
      head = next;
      if (waiting && waiting.head !== next) waiting = null;
      return true;
    },
    /** A result was stored. A cards result for the awaited head ends the wait and shows the new cards. @param {{ kind: string, head: string }} e @returns {boolean} */
    stored(e) {
      if (e.kind !== 'cards') return false;
      if (waiting && waiting.head === e.head) waiting = null;
      showEngine = false;
      return true;
    },
    /** @returns {boolean} */
    toggle() { showEngine = !showEngine; return true; },
  };
}

module.exports = { createAgentCardsState };
