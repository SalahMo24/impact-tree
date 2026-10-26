// @ts-check
'use strict';

// The Cards view as plain data: cards (clusters of related changes), sweeps (one edit
// repeated), what each card reaches, and the evidence that two cards belong together. Pure:
// no editor, no I/O, no clock. The provider (cards-provider.js) turns nodes into tree items
// and runs `target`s.
//
// What a card establishes is bounded by the analysis it was built from (docs/CODING_STYLE.md
// section 1): entry points are "at least" whenever a path is a lower bound or a search did
// not finish, and "none found" never reads as "none exist". Callers and entry points of a
// preview come from the pull request's own files only; its merge hints have no
// repository-wide token counts.

const { previewLimitsNote } = require('./tree-row-models');

/**
 * What activating a node does, as data.
 * - `change`: open the existing change row of a changed function (`impactTree.openChange`).
 * - `deleted`: open what the Changes view opens for a deleted function (`impactTree.openFile`).
 * - `card`: select another card or sweep in this view.
 * @typedef {{ kind: 'change', relPath: string, namePos: number }
 *   | { kind: 'deleted', relPath: string, namePos: number }
 *   | { kind: 'card', id: string }} CardTarget
 */

/**
 * @typedef {object} CardNode
 * @property {string} id Unique in one model; stable across rebuilds of the same cards.
 * @property {string} label
 * @property {string} [description]
 * @property {string} [tooltip] Plain lines.
 * @property {string} icon A codicon id.
 * @property {string} contextValue
 * @property {CardNode[]} [children]
 * @property {CardTarget} [target]
 */

/** Fewer changes than this and cards say nothing a list does not (AI plan, AI2). */
const MIN_CHANGES_FOR_CARDS = 4;

// Display limits, in rows per list. Owner: this module. Unit: rows. Exhaustion: the list
// ends with a "…and N more" row; the analysis is complete, only the presentation is cut
// (the Changes view lists every change).
const MAX_MEMBERS = 200;
const MAX_ENTRIES = 50;
const MAX_SEAMS = 25;
const MAX_HINTS = 10;
const MAX_EVIDENCE = 4;

/** @param {number} n @param {string} one @param {string} [many] @returns {string} */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {string} id
 * @param {string} label
 * @param {string} icon
 * @param {Partial<CardNode>} [more]
 * @returns {CardNode}
 */
const leaf = (id, label, icon, more = {}) => ({ id, label, icon, contextValue: 'cardsNote', ...more });

/**
 * The first `max` of `list` as nodes, and a closing row saying how many were left out.
 * @template T
 * @param {string} id Id of the closing row.
 * @param {T[]} list
 * @param {number} max
 * @param {(item: T) => CardNode} toNode
 * @returns {CardNode[]}
 */
function capped(id, list, max, toNode) {
  const nodes = list.slice(0, max).map(toNode);
  if (list.length > max) nodes.push(leaf(id, `…and ${list.length - max} more`, 'ellipsis', { tooltip: 'Not listed here; the Changes view lists every change.' }));
  return nodes;
}

// ---- looking changes up ------------------------------------------------------------------

/**
 * @param {any} result
 * @returns {{ changed: Map<string, any>, deleted: Map<string, any> }} The result's changed and
 *   deleted functions by `relPath#namePos`, the id the cards use for them.
 */
function indexFunctions(result) {
  const changed = new Map(), deleted = new Map();
  for (const c of result.allChanged || []) changed.set(`${c.relPath}#${c.namePos}`, c);
  for (const d of result.deleted || []) deleted.set(`${d.relPath || d.file}#${d.namePos}`, d);
  return { changed, deleted };
}

const DELETED_SUFFIX = '!deleted';

/**
 * One member of a card or sweep. A changed function opens its change row; a deleted one
 * (shown "−label") opens what the Changes view opens for a deletion.
 * @param {string} parentId
 * @param {string} memberId A node id of the cards: `relPath#namePos`, with `!deleted` when
 *   a deleted function shares the position of a changed one.
 * @param {ReturnType<typeof indexFunctions>} index
 * @returns {CardNode}
 */
function memberNode(parentId, memberId, index) {
  const id = `${parentId}/member:${memberId}`;
  const isDeleted = memberId.endsWith(DELETED_SUFFIX);
  const key = isDeleted ? memberId.slice(0, -DELETED_SUFFIX.length) : memberId;
  const change = isDeleted ? null : index.changed.get(key);
  const gone = change ? null : index.deleted.get(key);
  if (change) {
    const kinds = (change.kinds || []).filter((/** @type {any} */ k) => k.id !== 'body').map((/** @type {any} */ k) => k.short || k.label);
    return { id, label: change.label, description: [...kinds, change.relPath].join(' · '), icon: 'symbol-method', contextValue: 'cardMember',
      tooltip: `${change.relPath}:${change.startLine}`, target: { kind: 'change', relPath: change.relPath, namePos: change.namePos } };
  }
  if (gone) {
    return { id, label: `−${gone.label}`, description: `deleted · ${gone.relPath || gone.file}`, icon: 'trash', contextValue: 'cardMember',
      tooltip: `${gone.label} was deleted from ${gone.relPath || gone.file}`, target: { kind: 'deleted', relPath: gone.relPath || gone.file, namePos: gone.namePos } };
  }
  return { id, label: memberId, description: 'not in this analysis', icon: 'question', contextValue: 'cardMember' };
}

/**
 * @param {string} parentId
 * @param {string[]} memberIds
 * @param {ReturnType<typeof indexFunctions>} index
 * @returns {CardNode}
 */
function membersNode(parentId, memberIds, index) {
  return { id: `${parentId}/members`, label: `Members (${memberIds.length})`, icon: 'list-flat', contextValue: 'cardMembers',
    children: capped(`${parentId}/members/more`, memberIds, MAX_MEMBERS, (m) => memberNode(parentId, m, index)) };
}

// ---- impact ------------------------------------------------------------------------------

/**
 * How many of a card's changes are signature or throw changes, and what is left stale. A
 * "not updated" call line only means something for those changes (clusters.js `stats`).
 * @param {any} stats A card's `stats`.
 * @returns {string}
 */
function impactText(stats) {
  const parts = [];
  if (!stats.risky) parts.push('no signature or throw changes');
  else {
    parts.push(`${plural(stats.risky, 'signature or throw change')}${stats.riskyAllUpdated === stats.risky ? ', all callers updated' : ''}`);
    const outside = stats.notUpdatedOutside ?? stats.notUpdated ?? 0, inside = stats.notUpdatedInside ?? 0;
    if (outside) parts.push(`${plural(outside, 'caller')} not updated outside this card`);
    if (inside) parts.push(`${inside} inside it`);
  }
  // A caller search that did not finish: the counts are a lower bound.
  if (stats.incomplete) parts.push(`callers possibly missing for ${stats.incomplete} of ${stats.members}`);
  return parts.join(', ');
}

/** @param {string} id @param {any} stats @returns {CardNode} */
function impactNode(id, stats) {
  return leaf(`${id}/impact`, impactText(stats), 'pulse', {
    description: `${plural(stats.callers || 0, 'caller')} outside, ${plural(stats.tests || 0, 'test')}`,
    tooltip: [`${plural(stats.callers || 0, 'production caller')} outside this card; ${plural(stats.tests || 0, 'test')} call into it.`,
      stats.incomplete ? `The caller search did not finish for ${stats.incomplete} of ${stats.members} changes, so these counts are at least.` : 'The caller search finished for every change.'].join('\n'),
  });
}

/**
 * The entry points the members' impact paths reach, merged (port of the prototype's
 * `cardImpact`). `incomplete`: some path is a lower bound, some walk did not finish, or a
 * changed member has no walk at all; the entries are then "at least". `computed`: false when
 * the result carries no impact paths, so nothing was searched.
 * @param {string[]} memberIds
 * @param {Record<string, any>|undefined} paths `result.impactPaths`
 * @param {ReturnType<typeof indexFunctions>} index
 * @returns {{ computed: boolean, entries: any[], incomplete: boolean, testOnly: string[] }}
 */
function entryPointsOf(memberIds, paths, index) {
  if (!paths) return { computed: false, entries: [], incomplete: true, testOnly: [] };
  /** @type {Map<string, any>} */
  const entries = new Map();
  /** @type {string[]} */
  const testOnly = [];
  let incomplete = false;
  for (const id of memberIds) {
    if (id.endsWith(DELETED_SUFFIX) || !index.changed.has(id)) continue;     // a deleted function is not walked
    const p = paths[id];
    if (!p) { incomplete = true; continue; }
    if (p.complete === false) incomplete = true;
    if (p.testOnly) testOnly.push(id);
    for (const e of p.entries || []) if (!entries.has(`${e.type}|${e.name}`)) entries.set(`${e.type}|${e.name}`, { ...e, path: null });
    for (const t of p.topPaths || []) {
      if (t.lowerBound) incomplete = true;
      const entry = t.end === 'entry' && t.entry ? entries.get(`${t.entry.type}|${t.entry.name}`) : null;
      if (entry && (!entry.path || (t.via || []).length < entry.path.length)) entry.path = t.via || [];
    }
  }
  const sorted = [...entries.values()].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { computed: true, entries: sorted, incomplete, testOnly };
}

/** @param {string} id @param {ReturnType<typeof entryPointsOf>} ep @returns {CardNode} */
function entryPointsNode(id, ep) {
  const nodeId = `${id}/entries`;
  if (!ep.computed) {
    return leaf(nodeId, 'Entry points: not computed', 'circle-slash', { tooltip: 'This analysis did not compute impact paths, so the entry points a change reaches are unknown.' });
  }
  if (!ep.entries.length) {
    return leaf(nodeId, 'Entry points (0)', 'debug-start', {
      description: ep.incomplete ? 'none found — search incomplete' : 'none found',
      tooltip: ep.incomplete
        ? 'No entry point was found, but the search did not finish or only has syntax-level evidence: one may exist.'
        : 'The search finished and found no entry point within its scope (callers in the searched files, supported call forms).',
    });
  }
  return { id: nodeId, label: `Entry points (${ep.entries.length})`, icon: 'debug-start', contextValue: 'cardEntries',
    description: ep.incomplete ? 'at least' : undefined,
    tooltip: ep.incomplete ? 'At least these: some paths are lower bounds or some searches did not finish.' : undefined,
    children: capped(`${nodeId}/more`, ep.entries, MAX_ENTRIES, (e) => leaf(`${nodeId}/${e.type}|${e.name}`, e.name, 'symbol-event', {
      description: e.type,
      tooltip: [e.how, e.file, e.path && e.path.length ? `via ${e.path.join(' ← ')}` : null].filter(Boolean).join('\n') || undefined,
    })) };
}

// ---- seams and hints ---------------------------------------------------------------------

/**
 * @param {any} id a function's card id
 * @param {ReturnType<typeof indexFunctions>} index
 * @returns {string}
 */
function nameOf(id, index) {
  const key = String(id).replace(DELETED_SUFFIX, '');
  const c = index.changed.get(key);
  if (c) return c.label;
  const d = index.deleted.get(key);
  return d ? `−${d.label}` : String(id);
}

/** @param {string[]} list @param {number} max @returns {string} */
const shortList = (list, max) => (list.length > max ? `${list.slice(0, max).join(', ')}, … +${list.length - max}` : list.join(', '));

/**
 * What a seam says between this card and `other`.
 * @param {any} seam
 * @param {ReturnType<typeof indexFunctions>} index
 * @returns {string}
 */
function seamText(seam, index) {
  switch (seam.type) {
    case 'call': return `call: ${shortList((seam.via || []).map((/** @type {any} */ v) => `${nameOf(v.caller, index)} → ${nameOf(v.callee, index)}`), 2)}${seam.viaCount > (seam.via || []).length ? ` (${seam.viaCount} links)` : ''}`;
    case 'meeting': return `both reach ${seam.at.label} (${seam.at.relPath}), a caller this change leaves unchanged`;
    case 'type': return `shared type (approximate): ${shortList(seam.types || [], 3)}`;
    case 'mirror': return `duplicate of each other${seam.dirs && seam.dirs.length ? ` in ${shortList(seam.dirs, 2)}` : ''}`;
    default: return String(seam.type);
  }
}

/**
 * The seams that involve card `id`, one node per other card; activating it selects that card.
 * @param {string} id
 * @param {any[]} seams
 * @param {Map<string, any>} byId cards by id
 * @param {ReturnType<typeof indexFunctions>} index
 * @returns {CardNode|null}
 */
function seamsNode(id, seams, byId, index) {
  /** @type {Array<{ other: string, seam: any }>} */
  const mine = [];
  for (const seam of seams) {
    if (!(seam.clusters || []).includes(id)) continue;
    for (const other of seam.clusters) if (other !== id && byId.has(other)) mine.push({ other, seam });
  }
  if (!mine.length) return null;
  return { id: `${id}/seams`, label: `Seams (${mine.length})`, icon: 'git-compare', contextValue: 'cardSeams',
    children: capped(`${id}/seams/more`, mine, MAX_SEAMS, ({ other, seam }) => ({
      id: `${id}/seam:${seam.type}:${other}:${seam.at ? `${seam.at.relPath}#${seam.at.label}` : ''}`,
      label: `${other} · ${byId.get(other).label}`, description: seamText(seam, index), icon: 'link', contextValue: 'cardSeam',
      tooltip: seam.type === 'type' ? 'A signature in one card names a type the other card changes; this does not show the first uses the second\'s behaviour.' : undefined,
      target: { kind: 'card', id: other },
    })) };
}

/**
 * @param {any} e one piece of hint evidence
 * @returns {string}
 */
function evidenceText(e) {
  switch (e.type) {
    case 'commit': return `commit "${e.subject}"`;
    case 'token': return `token ${e.token}`;
    case 'test': return `${plural(e.count || (e.callers || []).length, 'test')} call both`;
    case 'folder': return `folder ${e.dir}`;
    case 'pattern': return `same edit ${e.pattern}${e.sharedBy ? ` ×${e.sharedBy}` : ''}`;
    case 'signature-change': return `same signature change ${e.delta}`;
    default: return [e.type, e.token || e.subject || e.key || e.delta || e.dir].filter(Boolean).join(' ');
  }
}

/**
 * "May belong with K3: …" rows for the hints of strength 1 or more that involve card `id`.
 * @param {string} id
 * @param {any[]} hints
 * @param {Map<string, any>} byId
 * @returns {CardNode[]}
 */
function hintNodes(id, hints, byId) {
  const mine = hints.filter((h) => h.strength >= 1 && (h.clusters || []).includes(id)).sort((a, b) => b.strength - a.strength);
  return capped(`${id}/hints/more`, mine, MAX_HINTS, (h) => {
    const other = h.clusters.find((/** @type {string} */ c) => c !== id) || id;
    const evidence = (h.evidence || []).filter((/** @type {any} */ e) => !e.broad).map(evidenceText);
    return { id: `${id}/hint:${h.clusters.join('+')}`, label: `May belong with ${other}: ${shortList(evidence, MAX_EVIDENCE)}`,
      description: `strength ${h.strength}`, icon: 'lightbulb', contextValue: 'cardHint',
      tooltip: 'Evidence that the two cards are one change (shared commit, tokens, tests, folder). It does not prove they are.',
      ...(byId.has(other) ? { target: { kind: 'card', id: other } } : {}) };
  });
}

// ---- cards and sweeps --------------------------------------------------------------------

/** @param {any} c a cluster @returns {string[]} */
function tagsOf(c) {
  return [
    c.mirrorOf || (c.mirrorMembers || []).length ? 'mirrored into generated dir' : null,
    (c.moved || []).length ? 'moved' : null,
    c.generated ? 'generated' : null,
    c.hub ? 'hub' : null,
    c.siblings ? 'same function in sibling folders' : null,
  ].filter((t) => t !== null);
}

/** @param {any} c a cluster @returns {string} */
function cardTooltip(c) {
  const lines = [`Files: ${shortList(c.files || [], 6)}`, `Module: ${c.module || '(root)'}`];
  if (c.mirrorOf) lines.push(`${plural((c.mirrorMembers || []).length, 'copy', 'copies')} in generated ${c.mirrorOf.dirs ? c.mirrorOf.dirs.join(', ') : c.mirrorOf.dir}`);
  if ((c.moved || []).length) lines.push(`Moved: ${plural(c.moved.length, 'function')}`);
  if (c.generated) lines.push(`Generated code in ${c.generated.dir}`);
  if (c.hub) lines.push('Hub: links several other cards.');
  if (c.siblings) lines.push('The same function changed in sibling folders.');
  if ((c.joined || []).length) lines.push(`${c.joined.length} joined by location`);
  return lines.join('\n');
}

/**
 * @param {any} c a cluster
 * @param {{ result: any, cards: any, byId: Map<string, any>, index: ReturnType<typeof indexFunctions> }} ctx
 * @returns {CardNode}
 */
function cardNode(c, { result, cards, byId, index }) {
  const ep = entryPointsOf(c.members || [], result.impactPaths, index);
  const children = [impactNode(c.id, c.stats || {}), entryPointsNode(c.id, ep)];
  const seams = seamsNode(c.id, cards.seams || [], byId, index);
  if (seams) children.push(seams);
  if (ep.testOnly.length) {
    children.push(leaf(`${c.id}/test-only`, `Used only by tests: ${ep.testOnly.length} of ${c.members.length}`, 'beaker', {
      tooltip: ep.testOnly.slice(0, 10).map((m) => nameOf(m, index)).join('\n'),
    }));
  }
  children.push(...hintNodes(c.id, cards.hints || [], byId), membersNode(c.id, c.members || [], index));
  const tags = tagsOf(c);
  return { id: c.id, label: `${c.id} · ${c.label}`, description: [plural(c.stats && c.stats.members != null ? c.stats.members : (c.members || []).length, 'change'), ...tags].join(' · '),
    tooltip: cardTooltip(c), icon: c.testHelpers ? 'beaker' : 'layers', contextValue: 'card', children };
}

/** @param {any} s a sweep @param {ReturnType<typeof indexFunctions>} index @returns {CardNode} */
function sweepNode(s, index) {
  return { id: s.id, label: `${s.id} · ${s.label}`, description: plural((s.members || []).length, 'change'), icon: 'versions', contextValue: 'cardSweep',
    tooltip: [s.pattern ? `Pattern: ${s.pattern}` : null, `Files: ${shortList(s.files || [], 6)}`].filter(Boolean).join('\n'),
    children: [membersNode(s.id, s.members || [], index)] };
}

/**
 * Removes the fields set to undefined, so a node holds only what it says (and equals its own JSON).
 * @param {CardNode[]} nodes Changed in place; a tree built by this module, so its depth is bounded by the model.
 * @returns {CardNode[]}
 */
function pruned(nodes) {
  for (const n of nodes) {
    for (const k of Object.keys(n)) if (/** @type {any} */ (n)[k] === undefined) delete /** @type {any} */ (n)[k];
    if (n.children) pruned(n.children);
  }
  return nodes;
}

// ---- the model ---------------------------------------------------------------------------

/**
 * @param {any} result
 * @returns {CardNode}
 */
function previewNotice(result) {
  const lines = [
    `${previewLimitsNote(result)} Entry points are found from the pull request's own files too.`,
    'Merge hints are found without repository-wide token counts, so fewer are found than after a checkout.',
    ...(result.warnings || []),
  ];
  return leaf('notice:preview', 'Preview — cards see the PR\'s own files only', 'eye', {
    description: 'callers and entry points from the PR\'s files; hints without repo-wide counts', tooltip: lines.join('\n') });
}

/**
 * The Cards view's tree.
 * @param {{ result: any, cards: any|null, hintsPending?: boolean, preview?: boolean, error?: string|null }} input
 *   `result`: an `analyze()` or `analyzeRemote()` result, with `impactPaths` when they were asked
 *   for. `cards`: `buildCardsFromFacts` or `addHints` output, or null before they exist.
 *   `hintsPending`: merge hints are still being found. `preview`: the result is a pull request
 *   preview. `error`: why cards or hints could not be built, shown as a note.
 * @returns {CardNode[]}
 */
function cardsViewModel({ result, cards, hintsPending = false, preview = false, error = null }) {
  const changes = (result.allChanged || []).length + (result.deleted || []).length;
  if (changes < MIN_CHANGES_FOR_CARDS) {
    return [leaf('notice:small', `Cards appear for pull requests with ${MIN_CHANGES_FOR_CARDS} or more changes.`, 'info')];
  }
  /** @type {CardNode[]} */
  const top = preview ? [previewNotice(result)] : [];
  if (error) top.push(leaf('notice:error', `Cards are incomplete: ${error}`, 'warning', { tooltip: error }));
  if (!cards) {
    if (!error) top.push(leaf('notice:waiting', 'Cards are built when the analysis finishes.', 'loading~spin', { tooltip: 'If cards were just switched on, refresh to analyse again with impact paths.' }));
    return pruned(top);
  }
  const notes = cards.hintNotes || [];
  if (hintsPending) top.push(leaf('notice:hints-loading', 'Merge hints loading…', 'loading~spin', { tooltip: 'Which cards may belong together is still being worked out.' }));
  else if (notes.length) top.push(leaf('notice:hint-notes', 'Merge hints are incomplete', 'warning', { description: `${plural(notes.length, 'note')}`, tooltip: notes.join('\n') }));
  const index = indexFunctions(result);
  const byId = new Map((cards.clusters || []).map((/** @type {any} */ c) => [c.id, c]));
  for (const s of cards.sweeps || []) byId.set(s.id, s);
  const ctx = { result, cards, byId, index };
  const nodes = [...(cards.clusters || []).map((/** @type {any} */ c) => cardNode(c, ctx)), ...(cards.sweeps || []).map((/** @type {any} */ s) => sweepNode(s, index))];
  if (!nodes.length) nodes.push(leaf('notice:none', 'No cards: the changes did not group.', 'info'));
  return pruned([...top, ...nodes]);
}

module.exports = { cardsViewModel, MIN_CHANGES_FOR_CARDS, MAX_MEMBERS, MAX_ENTRIES, MAX_SEAMS, MAX_HINTS };
