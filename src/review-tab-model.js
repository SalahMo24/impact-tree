// @ts-check
'use strict';

// The review tab's page as data: an overview (counts, the agent's summary, a board of card
// tiles in three columns) and, for each card, its changes with the agent's line, the
// engine's verdict and the diff hunk, and for each change the context a reviewer needs
// (before / after / when, who it affects, its callers and entry points). Pure: the panel
// (review-tab-panel.js) supplies the session's analysis and cards, the agent's stored
// result, the hunks and line numbers; nothing here reads the editor or the disk.
//
// Cards are the agent's when its result fits these cards (src/agent-cards.js), else the
// engine's. The board's columns:
// - Needs your attention: a card holding a change the agent named in `attention`; with no
//   agent result, a change the engine marks red or amber (level 0 or 1).
// - Behaviour changes: a card with a change the agent calls changed, may-change or new;
//   with no agent result, every other card ("Other changes").
// - No behaviour change: the rest (agent result only).

const { classifyChangeVerdict } = require('./tree-row-models');
const { resolveAgentResult } = require('./agent-cards');

/** Display limits. Unit: items or lines. The tab says how many more there are. */
const MAX_CHIPS = 3;
const MAX_HUNK_LINES = 30;
const MAX_CALLERS = 20;
const MAX_ENTRIES = 8;
const KINDS = ['changed', 'may-change', 'new', 'same'];

/**
 * @typedef {{ text: string, tone: 'danger'|'warning'|'plain' }} Chip
 * @typedef {{ id: string, n: number, title: string, sentence: string, chips: Chip[], attention: boolean, column: string, changes: string[], why: string|null }} CardModel
 * @typedef {{ label: string, file: string, line: number|null, state: string, test: boolean, index: number }} CallerModel
 * @typedef {{ id: string, name: string, file: string, line: number|null, deleted: boolean, kind: string|null, what: string|null,
 *   before: string|null, after: string|null, when: string|null, affects: Array<{ name: string, how: string }>,
 *   verdict: { text: string, level: number }, hunk: { lines: Array<{ t: string, s: string }>, more: number }|null,
 *   callers: CallerModel[], callersMore: number, callersComplete: boolean, entries: string[], entriesMore: number }} ChangeModel
 * @typedef {{ title: string, preview: boolean, counts: { changes: number, cards: number }, agent: boolean, summary: string|null,
 *   note: string|null, columns: Array<{ id: string, label: string, cards: string[] }>, cards: CardModel[], changes: Record<string, ChangeModel> }} TabModel
 */

/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Context lines kept around a function's own lines. Unit: lines. */
const AROUND = 2;

/**
 * The lines of a hunk to show: the `@@`-headed text cut to the function's own lines (and
 * AROUND lines of context; a new file's single hunk otherwise starts at its imports), then
 * at most MAX_HUNK_LINES of them, and how many more.
 * @param {string|null|undefined} text
 * @param {number} [start] First line of the function at the head (1-based); with `end`, the cut.
 * @param {number} [end]
 * @returns {{ lines: Array<{ t: string, s: string }>, more: number }|null}
 */
function hunkLines(text, start, end) {
  if (!text) return null;
  let all = String(text).split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |similarity |rename |new file|deleted file|\\ No newline)/.test(l));
  while (all.length && all[all.length - 1] === '') all.pop();
  if (start && end) {
    /** @type {string[]} */
    const kept = [];
    let line = 0;
    let header = null;
    for (const l of all) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (m) { line = Number(m[1]); header = l; continue; }
      const at = line;
      if (l[0] !== '-') line++;
      if (at < start - AROUND || at > end + AROUND) continue;
      if (header) { kept.push(header); header = null; }
      kept.push(l);
    }
    if (kept.length) all = kept;
  }
  const lines = all.slice(0, MAX_HUNK_LINES).map((s) => ({ t: s.startsWith('@@') ? '@' : s[0] === '+' ? '+' : s[0] === '-' ? '-' : ' ', s }));
  return lines.length ? { lines, more: Math.max(0, all.length - MAX_HUNK_LINES) } : null;
}

/**
 * @param {object} input
 * @param {any} input.result The shown analysis (`analyze()` or `analyzeRemote()`), with `impactPaths` when asked for.
 * @param {any} input.cards The engine's cards (`buildCards` output).
 * @param {unknown} [input.agentPayload] The latest stored agent `cards` result for the shown head, or null.
 * @param {string} [input.title] The review's name: "PR #4284 feat: …" or the branch.
 * @param {(change: any) => string|null} [input.hunkOf] The diff hunk text of a changed function, or null.
 * @param {(file: string, pos: number) => number|null} [input.lineAt] 1-based line of an offset in a file.
 * @param {(file: string) => string} [input.rel] Repository-relative path of an absolute file.
 * @returns {TabModel}
 */
function reviewTabModel({ result, cards, agentPayload = null, title = '', hunkOf = () => null, lineAt = () => null, rel = (f) => f }) {
  const preview = result.tierA === true;
  /** @type {Map<string, any>} */
  const changed = new Map();
  for (const c of result.allChanged || []) changed.set(`${c.relPath}#${c.namePos}`, c);
  /** @type {Map<string, any>} */
  const deleted = new Map();
  for (const d of result.deleted || []) deleted.set(`${d.relPath || d.file}#${d.namePos}`, d);
  const paths = result.impactPaths || {};

  const resolved = agentPayload ? resolveAgentResult(agentPayload, cards) : { ok: false };
  const agent = resolved.ok ? /** @type {Extract<ReturnType<typeof resolveAgentResult>, { ok: true }>} */ (resolved) : null;
  const said = (/** @type {string} */ id) => (agent ? agent.changes.get(id) || null : null);

  /** @type {Record<string, ChangeModel>} */
  const changes = {};
  /** @param {string} raw A member id (`relPath#namePos`, with `!deleted` for a deleted one sharing a position). */
  const changeOf = (raw) => {
    const id = raw.endsWith('!deleted') ? raw.slice(0, -'!deleted'.length) : raw;
    if (changes[id]) return id;
    const c = raw.endsWith('!deleted') ? null : changed.get(id);
    const d = c ? null : deleted.get(id);
    const b = said(id);
    const verdict = c ? classifyChangeVerdict(c) : { text: d ? 'deleted' : 'not in this analysis', level: 2 };
    const callers = c ? (c.callers || []) : [];
    const entries = ((paths[id] && paths[id].entries) || []).map((/** @type {any} */ e) => `${e.type === 'public-api' ? 'public API' : e.type}: ${e.name}`);
    changes[id] = {
      id, name: c ? c.label : d ? `−${d.label}` : id, file: c ? c.relPath : d ? (d.relPath || d.file) : '', line: c ? c.startLine : null, deleted: !c,
      kind: b ? b.kind : null, what: b ? b.what : null, before: (b && b.before) || null, after: (b && b.after) || null, when: (b && b.when) || null,
      affects: (b && b.affects) || [], verdict: { text: verdict.text, level: verdict.level },
      hunk: c ? hunkLines(hunkOf(c), c.startLine, c.endLine) : null,
      callers: callers.slice(0, MAX_CALLERS).map((/** @type {any} */ x, /** @type {number} */ index) => ({
        label: x.label, file: rel(x.file), line: lineAt(x.file, x.pos), state: x.callState || 'unknown', test: !!x.test, index })),
      callersMore: Math.max(0, callers.length - MAX_CALLERS), callersComplete: !c || c.callersComplete !== false,
      entries: entries.slice(0, MAX_ENTRIES), entriesMore: Math.max(0, entries.length - MAX_ENTRIES),
    };
    return id;
  };

  // The cards: the agent's, in its reading order, else the engine's clusters then sweeps.
  /** @type {Array<{ title: string, sentence: string, ids: string[], why: string|null }>} */
  const raw = agent
    ? agent.cards.map((a) => ({ title: a.title, sentence: a.summary || '', ids: a.ids, why: a.reason || null }))
    : [...(cards.clusters || []), ...(cards.sweeps || [])].map((/** @type {any} */ c) => ({ title: c.label, sentence: '', ids: c.members || [], why: null }));
  const attentionIds = new Set(agent ? agent.attention : []);
  /** @type {CardModel[]} */
  const cardModels = raw.map((r, i) => {
    const ids = r.ids.map(changeOf);
    const rank = (/** @type {string} */ id) => { const k = changes[id].kind; return k ? KINDS.indexOf(k) : 9; };
    const ordered = agent ? [...ids].sort((a, b) => rank(a) - rank(b)) : [...ids].sort((a, b) => changes[a].verdict.level - changes[b].verdict.level);
    const count = (/** @type {string} */ k) => ids.filter((id) => changes[id].kind === k).length;
    const stale = ids.reduce((n, id) => { const c = changed.get(id); return n + (c ? c.staleCallers || 0 : 0); }, 0);
    const api = ids.flatMap((id) => changes[id].entries).find((e) => e.startsWith('public API')) || ids.flatMap((id) => changes[id].entries)[0];
    const attention = agent ? ids.some((id) => attentionIds.has(id)) : ids.some((id) => changes[id].verdict.level <= 1 && !changes[id].deleted);
    const moved = agent ? ids.some((id) => ['changed', 'may-change', 'new'].includes(String(changes[id].kind))) : true;
    /** @type {Chip[]} */
    const chips = [];
    if (count('changed')) chips.push({ text: `${count('changed')} changed`, tone: 'warning' });
    if (stale) chips.push({ text: plural(stale, 'caller not updated', 'callers not updated'), tone: 'danger' });
    if (api) chips.push({ text: api, tone: 'plain' });
    if (count('may-change')) chips.push({ text: `${count('may-change')} may change`, tone: 'warning' });
    if (count('new')) chips.push({ text: `${count('new')} new`, tone: 'plain' });
    const sentence = r.sentence || `${plural(ids.length, 'change')} in ${plural(new Set(ids.map((id) => changes[id].file)).size, 'file')}`;
    return { id: `c${i + 1}`, n: i + 1, title: r.title, sentence, chips: chips.slice(0, MAX_CHIPS), attention,
      column: attention ? 'attention' : moved ? 'changes' : 'none', changes: ordered, why: r.why };
  });

  const columns = agent
    ? [{ id: 'attention', label: 'Needs your attention' }, { id: 'changes', label: 'Behaviour changes' }, { id: 'none', label: 'No behaviour change' }]
    : [{ id: 'attention', label: 'Needs your attention' }, { id: 'changes', label: 'Other changes' }];
  return {
    title, preview,
    counts: { changes: (result.allChanged || []).length + (result.deleted || []).length, cards: cardModels.length },
    agent: !!agent, summary: agent && agent.summary ? agent.summary : null,
    note: agent ? null : preview ? null : 'Run "Analyse with my agent" for what each change does to behaviour.',
    columns: columns.map((c) => ({ ...c, cards: cardModels.filter((m) => m.column === c.id).map((m) => m.id) })),
    cards: cardModels, changes,
  };
}

module.exports = { reviewTabModel, hunkLines, MAX_HUNK_LINES, MAX_CALLERS, MAX_CHIPS };
