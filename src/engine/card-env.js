// @ts-check
'use strict';

// One finished analysis and its cards, indexed for reading: the changes by id, the cards and
// sweeps, their seams and hints, and the impact facts summed per card. The MCP tools
// (src/mcp/tools.js), the facts "Analyse with my agent" hands over (./card-facts.js) and the
// review tab read the analysis through it, so the change ids and facts agree everywhere.
//
// Pure apart from reading files at the head (`readText`) and the file diffs (`diffOf`); both
// are injectable.

const fs = require('fs');
const path = require('path');
const { indexChanges, lineStarts, lineOf } = require('./agent-results');

/** Diff text kept per change. Unit: characters. */
const MAX_HUNK_CHARS = 6000;

/**
 * @typedef {object} CardEnvInput
 * @property {string} repo Absolute repository root.
 * @property {any} result The analysis result (`--json` shape) with `impactPaths`.
 * @property {{ clusters: any[], sweeps?: any[], seams?: any[], hints?: any[], hintNotes?: string[] }} cards From `buildCards`.
 * @property {any[]} [units] Live resolvers, passed through for the MCP tools.
 * @property {(abs: string) => string|null} [readText] Text of an absolute path at the head, or null.
 * @property {(relPath: string, oldPath: string|undefined) => string|null} [diffOf] Unified diff text of one file.
 * @property {string[]} [notes] Analysis-wide limits to report (startup caps).
 */

/**
 * @template {CardEnvInput} T
 * @param {T} ctx Kept as `env.ctx`, so a caller's own fields stay typed.
 */
function makeEnv(ctx) {
  const { repo, result } = ctx;
  const readText = ctx.readText || ((/** @type {string} */ abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } });
  const rel = (/** @type {string} */ abs) => path.relative(repo, abs).split(path.sep).join('/');
  const abs = (/** @type {string} */ relPath) => path.resolve(repo, relPath);
  /** @type {Map<string, number[]>} */
  const startsCache = new Map();
  const changes = indexChanges(result, rel);
  const allCards = [
    ...ctx.cards.clusters.map((c) => ({ ...c, kind: 'card' })),
    ...(ctx.cards.sweeps || []).map((s) => ({ ...s, kind: 'sweep' })),
  ];
  return {
    ctx, repo, result, readText, rel, abs, changes, allCards,
    cardById: new Map(allCards.map((c) => [c.id, c])),
    hints: ctx.cards.hints || [],
    seams: ctx.cards.seams || [],
    units: ctx.units || [],
    notes: [...(ctx.notes || []), ...(ctx.cards.hintNotes || [])],
    paths: result.impactPaths || {},
    /** 1-based line of a UTF-16 offset in a file, or null when the file cannot be read. @param {string} file @param {number} offset */
    lineAt(file, offset) {
      if (!startsCache.has(file)) { const t = readText(file); startsCache.set(file, t === null ? [] : lineStarts(t)); }
      const starts = /** @type {number[]} */ (startsCache.get(file));
      return starts.length ? lineOf(starts, offset) : null;
    },
    /** @type {Map<string, string|null>} Diff text per file; one diff per file. */
    diffCache: new Map(),
    /** Text of a repository-relative file at the head. @param {string} relPath */
    readRel: (relPath) => readText(abs(relPath)),
  };
}

/**
 * @template {CardEnvInput} [T=CardEnvInput]
 * @typedef {Omit<ReturnType<typeof makeEnv>, 'ctx'> & { ctx: T }} CardEnv
 */

/**
 * Impact facts of a set of changes, summed from their impact paths.
 * @param {CardEnv} env @param {string[]} members
 */
function impactOf(env, members) {
  const entries = new Map();
  /** @type {Record<string, number>} */
  const ends = {};
  /** @type {Map<string, number>} */
  const reasons = new Map();
  /** @type {any[]} */
  const top = [];
  let walked = 0;
  let complete = 0;
  let testOnly = 0;
  for (const id of members) {
    const p = env.paths[id];
    if (!p) continue;
    walked++;
    if (p.complete) complete++;
    if (p.testOnly) testOnly++;
    for (const e of p.entries || []) entries.set(`${e.type}|${e.name}`, { type: e.type, name: e.name, file: e.file, depth: e.depth, via: e.via });
    for (const [k, v] of Object.entries((p.summary && p.summary.ends) || {})) ends[k] = (ends[k] || 0) + /** @type {number} */ (v);
    for (const r of p.incompleteReasons || []) reasons.set(r, (reasons.get(r) || 0) + 1);
    for (const t of p.topPaths || []) top.push({ from: id, ...t });
  }
  const rank = (/** @type {any} */ t) => (t.throughStale ? 0 : 10) + (t.end === 'entry' ? 0 : 1);
  top.sort((a, b) => rank(a) - rank(b) || a.via.length - b.via.length);
  /** @type {Record<string, number>} */
  const entryTypes = {};
  for (const e of entries.values()) entryTypes[e.type] = (entryTypes[e.type] || 0) + 1;
  return {
    entryPoints: [...entries.values()], entryTypes, pathEnds: ends, topPaths: top.slice(0, 5), walked, testOnlyMembers: testOnly,
    complete: walked === members.length && complete === walked,
    reasons: [...(walked < members.length ? [`${members.length - walked} member(s) have no impact paths (deleted or not walked)`] : []),
      ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} (×${n})`)],
  };
}

/** The seams that involve a card. @param {CardEnv} env @param {string} id */
const seamsOf = (env, id) => env.seams.filter((/** @type {any} */ s) => (s.clusters || []).includes(id));

/** A change as a short row. @param {CardEnv} env @param {string} id */
function nameOf(env, id) {
  const c = env.changes.get(id);
  if (!c) return { id, label: id };
  return {
    id, label: c.label, file: c.relPath || env.rel(c.file), lines: c.deletedFn ? null : [c.startLine, c.endLine],
    kinds: c.deletedFn ? ['deleted'] : (c.kinds || []).map((/** @type {any} */ k) => k.id), ...(c.added ? { added: true } : {}),
  };
}

/**
 * The hunks of the file diff that overlap the function's lines.
 * @param {{ ctx: { diffOf?: CardEnvInput['diffOf']|null }, diffCache: Map<string, string|null> }} env
 *   A CardEnv, or just a diff source and a cache of one diff per file.
 * @param {any} c
 * @returns {{ text: string|null, complete: boolean }}
 */
function hunkFor(env, c) {
  const diffOf = env.ctx.diffOf;
  if (!diffOf) return { text: null, complete: false };
  const cache = env.diffCache;
  if (!cache.has(c.relPath)) cache.set(c.relPath, diffOf(c.relPath, c.oldPath));
  const diff = cache.get(c.relPath);
  if (diff === null || diff === undefined) return { text: null, complete: false };
  const out = [];
  for (const h of diff.split(/\n(?=@@ )/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h);
    if (!m) continue;
    const start = Number(m[1]);
    const end = start + Math.max(0, Number(m[2] ?? 1) - 1);
    if (end >= c.startLine && start <= c.endLine) out.push(h);
  }
  const text = out.join('\n');
  return text.length > MAX_HUNK_CHARS ? { text: `${text.slice(0, MAX_HUNK_CHARS)}\n… (cut at ${MAX_HUNK_CHARS} characters)`, complete: false } : { text, complete: true };
}

module.exports = { makeEnv, impactOf, seamsOf, nameOf, hunkFor, MAX_HUNK_CHARS };
