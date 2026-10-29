// @ts-check
'use strict';

// The facts an agent needs to review a pull request's behaviour changes and group them in one
// pass: every card with its members, each member's diff hunk, signature change, added throws
// and callers (with how each call site was updated), the entry points it reaches, its seams
// and its merge-hint evidence. "Analyse with my agent" hands these over with the prompt
// (inline or as a file), so the agent answers with one `submit_cards` call instead of reading
// the MCP tools card by card.
//
// Built on the same index of the analysis as the MCP tools (./card-env.js), so the change ids
// are the ones `submit_cards` checks. Diff hunks are on a budget: changes outside test files
// first, each hunk cut to MAX_HUNK_CHARS; a member past the budget says `diff: "omitted"`
// and get_change has its hunk.
//
// Every string from the code or the history (names, paths, commit subjects) is one line and
// length-capped: it is data the prompt marks as data. Pure apart from `readText` (line numbers
// of call sites), which is injectable.

const { makeEnv, impactOf, nameOf, seamsOf, hunkFor } = require('./card-env');

/** A member as id, name, file and kinds only: the smallest form. @param {import('./card-env').CardEnv} env @param {string} id */
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
/** Longest diff hunk kept per change. Unit: characters. */
const MAX_HUNK_CHARS = 1200;
/** Diff text kept over all changes. Unit: characters. */
const DIFF_BUDGET_CHARS = 100000;
/** Longest facts text built. Unit: characters. Over it, diffs, then callers, then entry points are cut further. */
const MAX_FACTS_CHARS = 250000;
/** A test file, by its path: its changes get diff budget last. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;

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
 * @param {import('./card-env').CardEnv} env @param {string} id @param {number} callerCap
 * @param {Map<string, string>} diffs The hunks kept, by change id.
 */
function memberFacts(env, id, callerCap, diffs) {
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
    diff: diffs.has(id) ? diffs.get(id) : 'omitted',
  };
}

/**
 * The diff hunks to give, by change id: changes outside test files first, in card order,
 * each cut to MAX_HUNK_CHARS, until `budget` characters are used.
 * @param {import('./card-env').CardEnv} env @param {number} budget
 * @returns {Map<string, string>}
 */
function pickDiffs(env, budget) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (budget <= 0 || !env.ctx.diffOf) return out;
  const ids = env.allCards.flatMap((c) => c.members || []).filter((id) => { const c = env.changes.get(id); return c && !c.deletedFn; });
  const isTest = (/** @type {string} */ id) => TEST_PATH.test(env.changes.get(id).relPath || '');
  let used = 0;
  for (const id of [...ids.filter((id) => !isTest(id)), ...ids.filter(isTest)]) {
    if (out.has(id)) continue;
    const h = hunkFor(env, env.changes.get(id)).text;
    if (!h) continue;
    const text = h.length > MAX_HUNK_CHARS ? `${h.slice(0, MAX_HUNK_CHARS)}\n… (cut; get_change has all of it)` : h;
    if (used + text.length > budget) break;
    out.set(id, text);
    used += text.length;
  }
  return out;
}

/**
 * @param {{ repo: string, result: any, cards: any, readText?: (abs: string) => string|null,
 *   diffOf?: (relPath: string, oldPath: string|undefined) => string|null }} input
 *   `result`: an analysis with `impactPaths`; `cards`: from buildCards (with hints when found).
 *   `diffOf`: the unified diff of one file between base and head; without it no hunks are given.
 * @param {{ head: string, base: string, baseRef?: string|null, pr?: number|null }} review The
 *   review the facts are for; the agent passes `head` and `base` back to `submit_cards`.
 * @returns {{ facts: any, text: string, cut: boolean }} `text`: compact JSON, at most MAX_FACTS_CHARS
 *   (unless even the smallest form is larger; `cut` then stays true and the agent is told to use the tools).
 */
function buildCardFacts(input, review) {
  const env = makeEnv({ repo: input.repo, result: input.result, cards: input.cards, readText: input.readText, diffOf: input.diffOf });
  /** @type {Map<number, Map<string, string>>} */
  const diffsBy = new Map();
  const diffsFor = (/** @type {number} */ budget) => { if (!diffsBy.has(budget)) diffsBy.set(budget, pickDiffs(env, budget)); return /** @type {Map<string, string>} */ (diffsBy.get(budget)); };
  const build = (/** @type {number} */ callerCap, /** @type {number} */ entryCap, /** @type {number} */ budget) => ({
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
        members: members.map((/** @type {string} */ m) => (callerCap < 0 ? shortRow(env, m) : memberFacts(env, m, callerCap, diffsFor(budget)))),
      };
    }),
  });
  // Shrink until it fits: half the diffs, fewer callers and entry points, no diffs, then members as short rows.
  const steps = [[MAX_CALLERS_LISTED, MAX_ENTRY_POINTS, DIFF_BUDGET_CHARS], [MAX_CALLERS_LISTED, MAX_ENTRY_POINTS, DIFF_BUDGET_CHARS / 2],
    [3, 4, DIFF_BUDGET_CHARS / 4], [0, 2, 0], [-1, 2, 0]];
  for (const [callerCap, entryCap, budget] of steps) {
    const facts = build(callerCap, entryCap, budget);
    const text = JSON.stringify(facts);
    if (text.length <= MAX_FACTS_CHARS) return { facts, text, cut: callerCap !== MAX_CALLERS_LISTED || budget !== DIFF_BUDGET_CHARS };
    if (callerCap === -1) return { facts, text, cut: true };
  }
  throw new Error('unreachable');
}

/**
 * A whole `git diff` split per file, as `diffOf` wants it: the text of each file's section by
 * its new path (and its old path, for a rename).
 * @param {string} text @returns {(relPath: string, oldPath: string|undefined) => string|null}
 */
function splitDiff(text) {
  /** @type {Map<string, string>} */
  const byPath = new Map();
  for (const part of String(text || '').split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\/(.+?)\n/.exec(part);
    if (!m) continue;
    byPath.set(m[2], part);
    if (!byPath.has(m[1])) byPath.set(m[1], part);
  }
  return (relPath, oldPath) => byPath.get(relPath) ?? (oldPath ? byPath.get(oldPath) ?? null : null);
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
    // A member's diff goes on a line of its own (JSON allows the line break), so no line is long.
    const member = (/** @type {any} */ m) => {
      const { diff, ...fields } = m;
      return diff === undefined ? JSON.stringify(m) : `${JSON.stringify(fields).slice(0, -1)},\n"diff":${JSON.stringify(diff)}}`;
    };
    return `${JSON.stringify(rest).slice(0, -1)},"members":[\n${members.map(member).join(',\n')}\n]}`;
  };
  return `${top},"cards":[\n${cards.map(cardText).join(',\n')}\n]}\n`;
}

module.exports = { buildCardFacts, factsFileText, splitDiff, MAX_FACTS_CHARS, MAX_CALLERS_LISTED, MAX_HUNK_CHARS, DIFF_BUDGET_CHARS };
