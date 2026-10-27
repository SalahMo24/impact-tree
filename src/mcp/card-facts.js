// @ts-check
'use strict';

// The facts an agent needs to title, summarise and merge the cards in one pass: every card
// with its members, each member's signature change, added throws and callers (with how each
// call site was updated), the entry points it reaches, its seams and its merge-hint evidence.
// "Analyse with my agent" hands these over with the prompt (inline or as a file), so the
// agent answers with one `submit_cards` call instead of reading the MCP tools card by card.
//
// Built from the same analysis shape as the MCP tools (src/mcp/tools.js), so the change ids
// are the ones `submit_cards` checks. No diff hunks: they are most of the size and the
// titles do not need them (get_change still has them).
//
// Every string from the code or the history (names, paths, commit subjects) is one line and
// length-capped: it is data the prompt marks as data. Pure apart from `readText` (line numbers
// of call sites), which is injectable.

const { makeEnv, impactOf, nameOf, seamsOf } = require('./tools').internals;

/** A member as id, name, file and kinds only: the smallest form. @param {import('./tools').Env} env @param {string} id */
const shortRow = (env, id) => {
  const r = /** @type {any} */ (nameOf(env, id));
  return { id, name: one(r.label), ...(r.file ? { file: one(r.file, 300) } : {}), ...(r.kinds ? { kinds: r.kinds.map((/** @type {unknown} */ k) => one(k, 40)) } : {}) };
};

/** Caps. Unit: items per list, or characters per string. */
const MAX_CALLERS_LISTED = 8;
const MAX_ENTRY_POINTS = 8;
const MAX_EVIDENCE = 4;
const MAX_HINTS = 4;
const MAX_SEAMS = 10;
const MAX_STR = 160;
const MAX_SIG = 240;
/** Longest facts text built. Unit: characters. Over it, callers then entry points are cut further. */
const MAX_FACTS_CHARS = 150000;

/** @param {unknown} v @param {number} [max] @returns {string} */
function one(v, max = MAX_STR) {
  const s = Array.from(String(v ?? ''), (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One merge-hint evidence item as a short phrase. @param {any} e */
function evidenceText(e) {
  if (!e || typeof e !== 'object') return '';
  if (e.type === 'commit') return `commit ${one(e.sha, 64).slice(0, 12)}: ${one(e.subject, 120)}${e.weak ? ' (weak subject)' : ''}${e.large ? ' (large commit)' : ''}`;
  if (e.type === 'token') return `shared name ${one(e.token, 60)} in ${Number(e.files) || 0} files`;
  if (e.type === 'test') return `${Number(e.count) || 0} shared tests`;
  if (e.type === 'folder') return `same folder ${one(e.dir, 100)}`;
  return one(e.type, 40);
}

/**
 * One changed function's facts.
 * @param {import('./tools').Env} env @param {string} id @param {number} callerCap
 */
function memberFacts(env, id, callerCap) {
  const c = env.changes.get(id);
  if (!c) return { id, name: one(id) };
  if (c.deletedFn) return { id, name: one(c.label), file: one(c.relPath, 300), deleted: true, before: c.baseSig || c.sig ? one(c.baseSig || c.sig, MAX_SIG) : null };
  /** @type {Array<{ x: any, state: string, test: boolean }>} */
  const callers = (c.callers || []).map((/** @type {any} */ x) => ({ x, state: x.callState || 'unknown', test: !!x.test }));
  // The callers a reviewer cares about first: not updated, then the rest; tests last.
  const rank = (/** @type {{ state: string, test: boolean }} */ r) => (r.test ? 10 : 0) + (r.state === 'unchanged' ? 0 : r.state === 'changed-elsewhere' ? 1 : 2);
  callers.sort((a, b) => rank(a) - rank(b));
  /** @type {Record<string, number>} */
  const byState = {};
  for (const r of callers) byState[r.state] = (byState[r.state] || 0) + 1;
  const sigChanged = (c.baseSig ?? null) !== (c.headSig ?? null);
  return {
    id,
    name: one(c.label),
    file: one(c.relPath || env.rel(c.file), 300),
    lines: [c.startLine, c.endLine],
    ...(c.added ? { added: true } : {}),
    kinds: (c.kinds || []).map((/** @type {any} */ k) => one(k.id, 40)),
    ...(sigChanged ? { before: c.baseSig ? one(c.baseSig, MAX_SIG) : null, after: c.headSig ? one(c.headSig, MAX_SIG) : null } : {}),
    ...((c.throwsAdded || []).length ? { throwsAdded: c.throwsAdded.slice(0, 4).map((/** @type {unknown} */ t) => one(t, 80)) } : {}),
    callers: {
      total: callers.length,
      byState,
      tests: callers.filter((r) => r.test).length,
      complete: c.callersComplete === true,
      ...(c.callersComplete === true ? {} : { reason: one(c.callersIncompleteReason || 'callers may be missing') }),
      list: callers.slice(0, callerCap).map((r) => `${one(r.x.label, 80)} ${one(env.rel(r.x.file), 200)}:${env.lineAt(r.x.file, r.x.pos) ?? '?'} ${r.state}${r.test ? ' (test)' : ''}`),
    },
    tests: c.testState || null,
  };
}

/**
 * @param {{ repo: string, result: any, cards: any, readText?: (abs: string) => string|null }} input
 *   `result`: an analysis with `impactPaths`; `cards`: from buildCards (with hints when found).
 * @param {{ head: string, base: string, baseRef?: string|null, pr?: number|null }} review The
 *   review the facts are for; the agent passes `head` and `base` back to `submit_cards`.
 * @returns {{ facts: any, text: string, cut: boolean }} `text`: compact JSON, at most MAX_FACTS_CHARS
 *   (unless even the smallest form is larger; `cut` then stays true and the agent is told to use the tools).
 */
function buildCardFacts(input, review) {
  const env = makeEnv({ repo: input.repo, result: input.result, cards: input.cards, readText: input.readText });
  const build = (/** @type {number} */ callerCap, /** @type {number} */ entryCap) => ({
    review: { head: one(review.head, 64), base: one(review.base, 64), ...(review.baseRef ? { baseRef: one(review.baseRef, 100) } : {}), ...(review.pr ? { pr: review.pr } : {}) },
    changed: env.changes.size,
    notes: env.notes.slice(0, 6).map((n) => one(n, 200)),
    cards: env.allCards.map((c) => {
      const members = c.members || [];
      const im = impactOf(env, members);
      const hints = env.hints.filter((/** @type {any} */ h) => h.clusters.includes(c.id) && h.strength >= 1).slice(0, MAX_HINTS);
      return {
        id: c.id, kind: c.kind, label: one(c.label),
        ...(c.files ? { files: c.files.length } : {}),
        entryPoints: im.entryPoints.slice(0, entryCap).map((e) => `${one(e.type, 30)} ${one(e.name, 100)}`),
        entryPointsTotal: im.entryPoints.length,
        ...(im.complete ? {} : { impactIncomplete: im.reasons.slice(0, 2).map((r) => one(r)) }),
        seamsWith: [...new Set(seamsOf(env, c.id).flatMap((/** @type {any} */ s) => s.clusters).filter((/** @type {string} */ k) => k !== c.id))].slice(0, MAX_SEAMS),
        mergeHints: hints.map((/** @type {any} */ h) => ({ cards: h.clusters, strength: h.strength, evidence: (h.evidence || []).slice(0, MAX_EVIDENCE).map(evidenceText) })),
        ...((c.mirrorMembers || []).length ? { mirrored: c.mirrorMembers.length } : {}),
        members: members.map((/** @type {string} */ m) => (callerCap < 0 ? shortRow(env, m) : memberFacts(env, m, callerCap))),
      };
    }),
  });
  // Shrink until it fits: fewer callers listed, fewer entry points, then members as short rows.
  for (const [callerCap, entryCap] of [[MAX_CALLERS_LISTED, MAX_ENTRY_POINTS], [3, 4], [0, 2], [-1, 2]]) {
    const facts = build(callerCap, entryCap);
    const text = JSON.stringify(facts);
    if (text.length <= MAX_FACTS_CHARS) return { facts, text, cut: callerCap !== MAX_CALLERS_LISTED };
    if (callerCap === -1) return { facts, text, cut: true };
  }
  throw new Error('unreachable');
}

/**
 * The facts as JSON for a file: the same value, one card header and one member per line, so
 * an agent whose file reader cuts long lines or large reads can read it in parts by line.
 * @param {any} facts From buildCardFacts. @returns {string}
 */
function factsFileText(facts) {
  const { cards, ...head } = facts;
  const top = JSON.stringify(head).slice(0, -1);
  const cardText = (/** @type {any} */ c) => {
    const { members, ...rest } = c;
    return `${JSON.stringify(rest).slice(0, -1)},"members":[\n${members.map((/** @type {any} */ m) => JSON.stringify(m)).join(',\n')}\n]}`;
  };
  return `${top},"cards":[\n${cards.map(cardText).join(',\n')}\n]}\n`;
}

module.exports = { buildCardFacts, factsFileText, MAX_FACTS_CHARS, MAX_CALLERS_LISTED };
