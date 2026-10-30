// @ts-check
'use strict';
const path = require('path');
const models = require('./tree-row-models');
const { needsAttention, changeIdOf, collectCountingRows, NO_AGENT_ATTENTION, GROUP_CARD, GROUP_OTHERS } = require('./review-tree-model');

// The By card order of the review tree (docs/UX_PLAN.md L4): the same change rows the Files
// order draws, grouped under the cards the engine found (or the cards the user's agent
// made of them) instead of under their files. Pure: nothing here reads session state or the
// editor, and the rows handed in are never copied, so a tick, a count, a filter and a walk
// see the same objects in both orders.
//
// A card is a group row (`type: 'card'`) with `rows`, the counting rows it holds. A change
// is drawn under one card only, the first in display order, so every counting row of the
// review is under exactly one group: a card, or the "Other changes" container
// (`type: 'others'`), which holds the files no card touches and the rows of a file that a
// card left out. What a card establishes is bounded by the analysis it was built from
// (docs/CODING_STYLE.md section 1): entry points in its hover are "at least" whenever a path
// is a lower bound or a search did not finish.

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/**
 * One card to draw, from the engine's cards or the agent's.
 * @typedef {object} OrderCard
 * @property {string} id Unique among the cards of one review.
 * @property {string} title
 * @property {boolean} agent Whether the user's agent made this card.
 * @property {boolean} sweep Whether it is a sweep (one edit repeated), drawn after the cards.
 * @property {boolean} testHelpers Whether the engine says it only changes test helpers.
 * @property {string[]} ids The change ids it holds: `relPath#namePos`, with `!deleted` for a deleted function sharing a position.
 * @property {any} engine The engine card it was made from (an agent card: the first it draws from), or null.
 * @property {string} [summary] The agent's summary of the card.
 * @property {string} [reason] Why the agent grouped these changes.
 */

/** Fewer changes than this and cards say nothing a list does not (AI plan, AI2). */
const MIN_CHANGES_FOR_CARDS = 4;

// Display limits for a card's hover. Owner: this module. Unit: lines. Exhaustion: the line
// ends with "… +N"; the analysis is complete, only the hover is cut.
const MAX_FILES = 6;
const MAX_ENTRIES = 5;
const MAX_SEAMS = 5;

const DELETED_SUFFIX = '!deleted';

/** @param {number} n @param {string} one @param {string} [many] @returns {string} */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** @param {string[]} list @param {number} max @returns {string} */
const shortList = (list, max) => (list.length > max ? `${list.slice(0, max).join(', ')}, … +${list.length - max}` : list.join(', '));

/**
 * The name an engine card shows: its label, with "and N related" written "+ N related".
 * @param {any} c A cluster, or a sweep (whose label is shown as it is).
 * @returns {string}
 */
const cardName = (c) => String(c.label).replace(/ and (\d+) related$/, ' + $1 related');

/**
 * The cards to draw: the agent's when its result fits the engine's cards and is shown (they
 * place every change once), else the engine's clusters then its sweeps.
 * @param {{ clusters?: any[], sweeps?: any[] }|null} engine The engine's cards, or null when there are none.
 * @param {ReadonlyArray<import('../../agent/agent-cards').AgentCard>|null} agentCards
 * @returns {OrderCard[]}
 */
function orderCardsOf(engine, agentCards) {
  const clusters = (engine && engine.clusters) || [];
  const sweeps = (engine && engine.sweeps) || [];
  /** @type {Map<string, any>} */
  const byId = new Map([...clusters, ...sweeps].map((c) => [c.id, c]));
  if (agentCards && agentCards.length) {
    return agentCards.map((a, i) => ({
      id: `agent:A${i + 1}`, title: a.title, agent: true, sweep: false, testHelpers: false, ids: a.ids,
      engine: byId.get(a.covers[0] && a.covers[0].id) || null,
      ...(a.summary ? { summary: a.summary } : {}), ...(a.reason ? { reason: a.reason } : {}),
    }));
  }
  return [
    ...clusters.map((/** @type {any} */ c) => ({ id: c.id, title: cardName(c), agent: false, sweep: false, testHelpers: Boolean(c.testHelpers), ids: c.members || [], engine: c })),
    ...sweeps.map((/** @type {any} */ s) => ({ id: s.id, title: `${s.id} · ${s.label}`, agent: false, sweep: true, testHelpers: false, ids: s.members || [], engine: s })),
  ];
}

/**
 * The counting rows of a review by the id the cards use for them. A change row is its
 * `relPath#namePos`; a deleted row the same, or with `!deleted` when a changed function
 * has that id too.
 * @param {TreeRow[]} files The rows from `buildFileRows`.
 * @returns {Map<string, TreeRow>}
 */
function rowsById(files) {
  /** @type {Map<string, TreeRow>} */
  const byId = new Map();
  const counting = collectCountingRows(files);
  for (const row of counting) if (row.type === 'finding') byId.set(/** @type {string} */ (changeIdOf(row)), row);
  for (const row of counting) {
    const id = changeIdOf(row);
    if (row.type === 'deleted' && id !== null) byId.set(byId.has(id) ? `${id}${DELETED_SUFFIX}` : id, row);
  }
  return byId;
}

/**
 * The rows of one card worst first: those the attention set or the engine flags, then by
 * verdict level; rows equal in both keep the card's order.
 * @param {TreeRow[]} rows
 * @param {import('./review-tree-model').AgentAttention} attention
 * @returns {TreeRow[]}
 */
const worstFirst = (rows, attention) => rows
  .map((row, i) => ({ row, i, flagged: needsAttention(row, attention) ? 0 : 1, level: models.classifyRowVerdict(row).level }))
  .sort((a, b) => a.flagged - b.flagged || a.level - b.level || a.i - b.i)
  .map((e) => e.row);

/**
 * The rows a card holds, each once, in the card's own order.
 * @param {OrderCard} card
 * @param {Map<string, TreeRow>} byId
 * @returns {TreeRow[]}
 */
function rowsOfCard(card, byId) {
  /** @type {Set<TreeRow>} */
  const seen = new Set();
  for (const id of card.ids) {
    const row = byId.get(id) || byId.get(id.endsWith(DELETED_SUFFIX) ? id : `${id}${DELETED_SUFFIX}`);
    if (row) seen.add(row);
  }
  return [...seen];
}

/**
 * The By card order's groups over the rows of a review.
 * @param {TreeRow[]} files The rows from `buildFileRows`.
 * @param {OrderCard[]} cards From `orderCardsOf`.
 * @param {import('./review-tree-model').AgentAttention} [attention] The change ids the agent named.
 * @returns {{ groups: TreeRow[], others: TreeRow|null, leftFiles: TreeRow[], leftRows: TreeRow[] }}
 *   `groups`: the `card` rows that hold at least one row, cards that hold an attention change
 *   first, then by size, sweeps last, each with its rows worst first. `others`: the
 *   container of the rest, null when every row is in a card; `leftFiles` the file rows none
 *   of whose rows is in a card, and `leftRows` the other rows nobody holds (a file
 *   partly in cards: its top-level lines, say).
 */
function buildCardGroups(files, cards, attention = NO_AGENT_ATTENTION) {
  const byId = rowsById(files);
  const held = cards.map((card, index) => {
    const rows = rowsOfCard(card, byId);
    return { card, index, rows, flagged: rows.some((r) => needsAttention(r, attention)) };
  });
  held.sort((a, b) => Number(a.card.sweep) - Number(b.card.sweep) || Number(b.flagged) - Number(a.flagged)
    || b.rows.length - a.rows.length || a.index - b.index);
  /** @type {Set<TreeRow>} */
  const drawn = new Set();
  /** @type {TreeRow[]} */
  const groups = [];
  for (const { card, rows } of held) {
    const mine = worstFirst(rows.filter((r) => !drawn.has(r)), attention);
    for (const r of mine) drawn.add(r);
    if (mine.length) groups.push({ type: GROUP_CARD, cardId: card.id, label: card.title, rows: mine, files: mine, card, expanded: false });
  }
  const leftFiles = files.filter((f) => collectCountingRows([f]).every((r) => !drawn.has(r)));
  const leftover = new Set(leftFiles);
  const leftRows = files.filter((f) => !leftover.has(f)).flatMap((f) => collectCountingRows([f])).filter((r) => !drawn.has(r));
  // in the order of the files, as the container draws them
  const rows = files.flatMap((f) => collectCountingRows([f]).filter((r) => !drawn.has(r)));
  const others = rows.length ? { type: GROUP_OTHERS, label: 'Other changes', rows, files: rows, fileCount: countLeftFiles(leftFiles, leftRows), expanded: false } : null;
  return { groups, others, leftFiles, leftRows };
}

/**
 * The files an "Other changes" container names: those it holds whole and those it holds
 * rows of.
 * @param {TreeRow[]} leftFiles
 * @param {TreeRow[]} leftRows
 * @returns {number}
 */
const countLeftFiles = (leftFiles, leftRows) => new Set([...leftFiles.map((f) => f.relPath), ...leftRows.map((r) => r.relPath ?? r.finding?.relPath)]).size;

/**
 * The entry points the changes of a card reach, for its hover: at least this many when a
 * search did not finish, and "none found" never reads as "none exist".
 * @param {string[]} ids Change ids of the card.
 * @param {Record<string, any>|undefined} paths `result.impactPaths`; undefined when none were computed.
 * @returns {{ computed: boolean, names: string[], incomplete: boolean }}
 */
function entryPointsOf(ids, paths) {
  if (!paths) return { computed: false, names: [], incomplete: true };
  /** @type {Map<string, string>} */
  const names = new Map();
  let incomplete = false;
  for (const id of ids) {
    if (id.endsWith(DELETED_SUFFIX)) continue;      // a deleted function is not walked
    const p = paths[id];
    if (!p) { incomplete = true; continue; }
    if (p.complete === false || (p.topPaths || []).some((/** @type {any} */ t) => t.lowerBound)) incomplete = true;
    for (const e of p.entries || []) if (!names.has(`${e.type}|${e.name}`)) names.set(`${e.type}|${e.name}`, `${e.name} (${e.type})`);
  }
  return { computed: true, names: [...names.values()].sort(), incomplete };
}

/**
 * The hover of a card: its files and module, the entry points it reaches (the first few),
 * the cards it shares a seam with, and for an agent's card its summary and why the changes
 * were grouped.
 * @param {OrderCard} card
 * @param {{ result?: any, cards?: { clusters?: any[], sweeps?: any[], seams?: any[] }|null }} [facts] The analysis and the engine's cards.
 * @returns {string[]} Plain lines.
 */
function cardTooltipLines(card, { result = null, cards = null } = {}) {
  const c = card.engine;
  const lines = [];
  if (card.agent) {
    if (card.summary) lines.push(card.summary, '');
    if (card.reason) lines.push(`Why grouped: ${card.reason}`, '');
    lines.push('Written by your agent; the facts below come from the engine.', '');
  }
  if (c) {
    lines.push(`Files: ${shortList(c.files || [], MAX_FILES)}`);
    if (!card.sweep) lines.push(`Module: ${c.module || '(root)'}`);
    if (c.pattern) lines.push(`Pattern: ${c.pattern}`);
  }
  if (result && !card.sweep) {
    const ep = entryPointsOf(card.ids, result.impactPaths);
    if (!ep.computed) lines.push('Entry points: not computed');
    else if (!ep.names.length) lines.push(ep.incomplete ? 'Entry points: none found, but the search is incomplete' : 'Entry points: none found in the searched files');
    else lines.push(`Entry points${ep.incomplete ? ' (at least)' : ''}: ${shortList(ep.names, MAX_ENTRIES)}`);
  }
  if (c && cards && !card.agent) {
    const others = [...(cards.clusters || []), ...(cards.sweeps || [])];
    const named = (cards.seams || []).filter((/** @type {any} */ s) => (s.clusters || []).includes(c.id))
      .flatMap((/** @type {any} */ s) => s.clusters.filter((/** @type {string} */ o) => o !== c.id)).map((/** @type {string} */ o) => others.find((x) => x.id === o)).filter(Boolean).map(cardName);
    if (named.length) lines.push(`Seams: ${shortList([...new Set(named)], MAX_SEAMS)}`);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The description of a card row: how many changes it holds and how many of them still need
 * attention, then `tests` for a card that only changes test helpers.
 * @param {TreeRow} group A `card` row.
 * @param {{ isReviewed: (row: TreeRow) => boolean, attention: import('./review-tree-model').AgentAttention }} how
 * @returns {string}
 */
function describeCard(group, { isReviewed, attention }) {
  const left = group.rows.filter((/** @type {TreeRow} */ r) => !isReviewed(r) && needsAttention(r, attention));
  return [plural(group.rows.length, 'change'), left.length ? models.attentionCountText(left.length) : null, group.card.testHelpers ? 'tests' : null]
    .filter(Boolean).join(' · ');
}

/**
 * The description of the "Other changes" container.
 * @param {TreeRow} others
 * @returns {string}
 */
const describeOthers = (others) => plural(others.fileCount ?? 0, 'file');

/** @param {string} relPath @returns {string} The file name a change row names at its end in this order. */
const fileNote = (relPath) => path.basename(relPath);

module.exports = {
  MIN_CHANGES_FOR_CARDS, orderCardsOf, buildCardGroups, countLeftFiles, cardTooltipLines, describeCard, describeOthers, fileNote, cardName, entryPointsOf,
};
