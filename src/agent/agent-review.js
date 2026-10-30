// @ts-check
'use strict';

// What the user's agent said, as the review tree reads it: the notes on each change, the one
// attention set (docs/UX_PLAN.md gate G15), the cards the agent made, and the state of the
// hand-off (waiting, a result for another state of the branch). One value per stored result,
// so the tree's rows, its counts and its By card order cannot disagree about what the agent
// said. Pure: the caller passes the stored results and the engine's cards.

const { resolveAgentResult, latestCardsResult } = require('./agent-cards');
const { agentNotes } = require('./agent-notes');

/**
 * @typedef {object} AgentReview
 * @property {import('./agent-notes').AgentNotes|null} notes The agent's note on each change; null with no result or while the engine's cards are shown.
 * @property {ReadonlySet<string>} attention The change ids the agent named in `attention`: empty with no result, a stale one, or while the engine's cards are shown.
 * @property {ReadonlyArray<import('./agent-cards').AgentCard>|null} cards The agent's cards, null when the engine's are shown or the result is stale.
 * @property {string|null} summary The agent's summary, null when not shown.
 * @property {boolean} hasResult A result is stored for the shown head (whether shown or not).
 * @property {boolean} showEngine The user asked for the engine's cards although a result exists.
 * @property {boolean} stale The stored result does not fit this analysis's cards, so none of it is shown as cards or attention.
 * @property {string|null} resultKey The stored result's key, for Undo.
 * @property {string|null} storedAtText When it was stored (`10:07`).
 * @property {{ askedAtText: string }|null} waiting A hand-off is waiting for the agent.
 */

/** @type {AgentReview} */
const NO_AGENT_REVIEW = Object.freeze({
  notes: null, attention: new Set(), cards: null, summary: null, hasResult: false, showEngine: false, stale: false,
  resultKey: null, storedAtText: null, waiting: null,
});

/** @param {number} ms @returns {string} The local time as HH:MM. */
function clockText(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * @param {{ waiting: { askedAt: number }|null, showEngine: boolean,
 *   results: Array<{ kind: string, key: string, payload: unknown, storedAt: number }> }|null} source
 *   The agent's part of the session, or null while agents are off.
 * @param {{ clusters?: any[], sweeps?: any[] }|null} cards The engine's cards for the analysis shown.
 * @returns {AgentReview}
 */
function agentReviewOf(source, cards) {
  if (!source) return NO_AGENT_REVIEW;
  const waiting = source.waiting ? { askedAtText: clockText(source.waiting.askedAt) } : null;
  const latest = latestCardsResult(source.results);
  if (!latest) return { ...NO_AGENT_REVIEW, waiting, showEngine: source.showEngine };
  const base = { ...NO_AGENT_REVIEW, waiting, hasResult: true, showEngine: source.showEngine, resultKey: latest.key, storedAtText: clockText(latest.storedAt) };
  if (source.showEngine) return base;
  const notes = agentNotes(latest.payload);
  const resolved = resolveAgentResult(latest.payload, cards);
  if (!resolved.ok) return { ...base, notes, stale: true };
  return { ...base, notes, attention: new Set(resolved.attention), cards: resolved.cards, summary: resolved.summary || null };
}

module.exports = { agentReviewOf, NO_AGENT_REVIEW, clockText };
