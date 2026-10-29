// @ts-check
'use strict';

// What an agent's stored cards say, matched against the engine's cards of the analysis the
// editor shows now. The stored result is data from outside (written by the user's agent,
// kept in workspace state, possibly made for another state of the branch), so it is checked
// again here against the current cards before anything is shown from it: a result that does
// not place every current change exactly once, or names an id the analysis does not have, is
// "stale" and is not shown (docs/CODING_STYLE.md section 3). Pure.

const { validateSubmission, cardIds } = require('../engine/agent-results');

/**
 * @typedef {object} AgentCover One engine card an agent card draws members from.
 * @property {string} id The engine card's id.
 * @property {string[]} taken The members of that engine card this agent card holds.
 * @property {number} total How many members the engine card has.
 * @property {boolean} whole Whether the agent card holds all of them.
 */
/**
 * @typedef {object} AgentCard
 * @property {string} title
 * @property {string} [summary]
 * @property {string} [reason]
 * @property {number} count Distinct changes in this card.
 * @property {AgentCover[]} covers In order of first appearance among the card's members.
 * @property {string[]} ids The card's change ids, in the order the agent listed them.
 */
/**
 * @typedef {object} AgentChange What the agent says one change does to behaviour.
 * @property {string} id
 * @property {'changed'|'may-change'|'same'|'new'} kind
 * @property {string} what One line.
 * @property {string} [before]
 * @property {string} [after]
 * @property {string} [when]
 * @property {Array<{ name: string, how: string }>} [affects]
 */

/**
 * @param {unknown} payload A stored `cards` result: `{ summary?, cards: [{ title, summary?, members, reason? }] }`.
 * @param {{ clusters?: any[], sweeps?: any[] }|null} cards The engine's cards for the analysis shown.
 * @returns {{ ok: true, summary?: string, cards: AgentCard[], changes: Map<string, AgentChange>, attention: string[] } | { ok: false }}
 *   `ok: false`: the payload does not fit these cards (another state of the branch, or damaged).
 */
function resolveAgentResult(payload, cards) {
  if (!cards || !Array.isArray(cards.clusters)) return { ok: false };
  const engine = { clusters: cards.clusters, sweeps: cards.sweeps || [] };
  let verdict;
  try { verdict = validateSubmission('cards', payload, { result: {}, cards: engine }); } catch { return { ok: false }; }
  if (!verdict || !verdict.ok || !verdict.normalised || !Array.isArray(verdict.normalised.cards)) return { ok: false };
  const { required, aliases } = cardIds(engine);
  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const c of [...engine.clusters, ...engine.sweeps]) {
    byId.set(c.id, c);
    for (const m of c.members || []) owner.set(m, c.id);
  }
  /** @type {AgentCard[]} */
  const out = [];
  for (const a of verdict.normalised.cards) {
    /** @type {Map<string, Set<string>>} */
    const taken = new Map();
    /** @type {string[]} */
    const ids = [];
    for (const m of a.members) {
      const id = required.has(m) ? m : aliases.get(m);
      const home = id === undefined ? undefined : owner.get(id);
      if (id === undefined || home === undefined) return { ok: false };
      if (!ids.includes(id)) ids.push(id);
      if (!taken.has(home)) taken.set(home, new Set());
      /** @type {Set<string>} */ (taken.get(home)).add(id);
    }
    const covers = [...taken].map(([id, set]) => {
      const total = (byId.get(id).members || []).length;
      return { id, taken: [...set], total, whole: set.size === total };
    });
    out.push({ title: a.title, ...(a.summary ? { summary: a.summary } : {}), ...(a.reason ? { reason: a.reason } : {}),
      count: covers.reduce((n, c) => n + c.taken.length, 0), covers, ids });
  }
  /** @type {Map<string, AgentChange>} */
  const changes = new Map((verdict.normalised.changes || []).map((/** @type {AgentChange} */ c) => [c.id, c]));
  return { ok: true, ...(verdict.normalised.summary ? { summary: verdict.normalised.summary } : {}), cards: out, changes, attention: verdict.normalised.attention || [] };
}

/**
 * The latest `cards` result of a head's stored results: the greatest `storedAt`, the last stored on a tie.
 * @template {{ kind: string, storedAt: number }} T
 * @param {T[]} results
 * @returns {T|null}
 */
function latestCardsResult(results) {
  /** @type {T|null} */
  let best = null;
  for (const r of results) if (r.kind === 'cards' && (!best || r.storedAt >= best.storedAt)) best = r;
  return best;
}

module.exports = { resolveAgentResult, latestCardsResult };
