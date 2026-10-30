// @ts-check
'use strict';

// What the user's agent said about the changes, for the views that show it next to the
// engine's own facts: the Changes view (a change row's line and tooltip, a caller row's
// "how") and the notes beside the code in the review diff (`agent-threads.js`). Built from
// the latest stored `cards` result of the shown head (its `changes`), which the bridge
// checked when it stored it. The engine's
// verdicts, order and counts never depend on it: the agent's text is added after them. Pure.

/** The marker of each kind, read before the agent's one line. */
const MARK = Object.freeze({ changed: '⚠', 'may-change': '?', new: '+', same: '=' });
const WORD = Object.freeze({ changed: 'Changed', 'may-change': 'May change', new: 'New', same: 'Same behaviour, new way' });

/**
 * @typedef {{ id: string, kind: 'changed'|'may-change'|'same'|'new', what: string, before?: string, after?: string, when?: string,
 *   affects?: Array<{ name: string, how: string }> }} AgentChange
 * @typedef {{ change: (id: string) => AgentChange|null, how: (changeId: string, callerLabel: string) => string|null }} AgentNotes
 */

/** A name the agent wrote names this caller: one holds the other, ignoring case (as the check that stored it). @param {string} a @param {string} b */
const sameName = (a, b) => {
  const x = a.toLowerCase(); const y = b.toLowerCase();
  return x.length > 1 && y.length > 1 && (x.includes(y) || y.includes(x));
};

/**
 * @param {unknown} payload A stored `cards` result, or null.
 * @returns {AgentNotes|null} null when it holds no behaviour entries.
 */
function agentNotes(payload) {
  const list = payload && typeof payload === 'object' && Array.isArray(/** @type {any} */ (payload).changes) ? /** @type {any[]} */ (/** @type {any} */ (payload).changes) : [];
  /** @type {Map<string, AgentChange>} */
  const byId = new Map();
  for (const c of list) {
    if (c && typeof c.id === 'string' && typeof c.what === 'string' && Object.prototype.hasOwnProperty.call(MARK, c.kind) && !byId.has(c.id)) byId.set(c.id, c);
  }
  if (!byId.size) return null;
  return {
    change: (id) => byId.get(id) || null,
    how(changeId, callerLabel) {
      const c = byId.get(changeId);
      const hit = c && Array.isArray(c.affects) ? c.affects.find((a) => a && typeof a.name === 'string' && sameName(a.name, callerLabel)) : null;
      return hit && typeof hit.how === 'string' ? hit.how : null;
    },
  };
}

/** The one line a row shows after the engine's text. @param {AgentChange} c */
const rowLine = (c) => `${MARK[c.kind]} ${c.what}`;

/**
 * The tooltip section of a change: kind and line, then before / after / when / affects.
 * @param {AgentChange} c @param {(s: string) => string} [esc] Escapes text for markdown.
 * @returns {string[]} Markdown lines.
 */
function tooltipLines(c, esc = (s) => s) {
  return [
    `**Your agent — ${WORD[c.kind]}:** ${esc(c.what)}`,
    ...(c.before ? ['', `Before: ${esc(c.before)}`] : []),
    ...(c.after ? ['', `After: ${esc(c.after)}`] : []),
    ...(c.when ? ['', `When: ${esc(c.when)}`] : []),
    ...((c.affects || []).length ? ['', 'Affects:', ...(c.affects || []).map((a) => `- ${esc(a.name)} — ${esc(a.how)}`)] : []),
  ];
}

/**
 * The change id a direct caller row calls: its row's `path[0]` is `file#offset` with an
 * absolute file, the id is `relPath#offset`.
 * @param {string} key @param {((file: string) => string)|null|undefined} rel
 * @returns {string}
 */
function callerChangeId(key, rel) {
  const at = key.lastIndexOf('#');
  const file = key.slice(0, at);
  return `${rel ? rel(file) : file}#${key.slice(at + 1)}`;
}

module.exports = { agentNotes, rowLine, tooltipLines, callerChangeId, sameName, MARK, WORD };
