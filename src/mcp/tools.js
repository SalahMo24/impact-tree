// @ts-check
'use strict';

// The MCP tools of Impact Tree: facts about one analysed pull request (cards, callers,
// references, impact paths), checks an agent can run on its own answer, read access to the
// code at the PR's commits, and two write-back tools. Plain definitions over a finished
// analysis; src/mcp/server.js registers them with the MCP SDK. Nothing here reads standard
// input or output.
//
// Every answer that may be incomplete carries `complete` and `reasons` (docs/CODING_STYLE.md
// §1): `complete: false` means the list is a lower bound, and `reasons` says why. Results are
// kept under MAX_TEXT_CHARS; lists page with `page`/`pageSize`.
//
// Pure apart from reading files at the head (`readText`), running `git diff` for hunks
// (`diffOf`) and the caller searches of the live resolvers; all three are injectable.

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { ToolError, intArg, paged, fitObject, MAX_PAGE_SIZE, MAX_PAGE, DEFAULT_PAGE_SIZE } = require('./paging');
const {
  validateSubmission, checkEvidence, indexChanges, isRelativePath, lineStarts, lineOf, escapeRe, MAX_LINE, IDENTIFIER,
} = require('../engine/agent-results');

// Lines one get_source call returns at most. Unit: lines.
const MAX_SOURCE_LINES = 400;
// search_code hits at most. Unit: matching lines.
const MAX_SEARCH_HITS = 200;
// Diff text kept per change. Unit: characters.
const MAX_HUNK_CHARS = 6000;
// Deadline for one `impact_paths` call. Unit: ms.
const QUERY_DEADLINE_MS = 10000;
// Caller rows shown by get_card's merge hints and seams. Unit: items.
// list_cards with detail: members and entry points listed per card (more: get_card). Unit: items.
const MAX_DETAIL_MEMBERS = 40;
const MAX_DETAIL_ENTRIES = 8;
const MAX_HINTS_SHOWN = 15;
const MAX_SEAMS_SHOWN = 20;
const MAX_FILES_SHOWN = 30;

const NO_EDITOR_REASON = 'no editor connected: checked, not saved';

/** @param {string} f the language of a source path, as far as callers are searched per language */
const langOf = (f) => (/\.(?:[cm]?[jt]sx?)$/.test(f) ? 'ts' : /\.go$/.test(f) ? 'go' : /\.pyi?$/.test(f) ? 'python' : /\.java$/.test(f) ? 'java' : null);

/**
 * @typedef {object} Unit One analysed project and its live caller resolver.
 * @property {string} component
 * @property {any} resolver
 * @property {string} [scopeNote]
 * @property {string[]} files Absolute paths of the project's changed files.
 */

/**
 * @typedef {object} ToolDef
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {z.ZodObject<any>} inputSchema
 * @property {{ readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }} annotations
 * @property {(args: any) => Promise<any>} run Runs after the SDK has checked `inputSchema`; still
 *   refuses what a schema cannot express (a path with `..`, a line that is not in the file).
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Submissions replace the earlier submission of the same kind for the same head: repeating one is safe.
const WRITE_BACK = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const pageShape = {
  page: z.number().int().min(1).max(MAX_PAGE).optional().describe('Page number, from 1.'),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Items per page (default ${DEFAULT_PAGE_SIZE}).`),
};
const locShape = {
  file: z.string().min(1).max(1024).describe('Repository-relative path of the file, as at the PR head.'),
  line: z.number().int().min(1).max(MAX_LINE).describe('1-based line holding the function name (its declaration).'),
  name: z.string().min(1).max(200).describe('The function or method name as written on that line (without its class).'),
};

/**
 * The tool set over one analysed PR.
 * @param {object} ctx
 * @param {string} ctx.repo Absolute repository root.
 * @param {any} ctx.result The analysis result (`--json` shape) with `impactPaths`.
 * @param {{ clusters: any[], sweeps?: any[], seams?: any[], hints?: any[], hintNotes?: string[] }} ctx.cards From `buildCards`.
 * @param {Unit[]} [ctx.units] Live resolvers.
 * @param {import('../engine/entry-points').EntryFacts} [ctx.facts]
 * @param {(abs: string) => string|null} [ctx.readText] Text of an absolute path at the head, or null.
 * @param {(relPath: string, oldPath: string|undefined) => string|null} [ctx.diffOf] Unified diff text of one file.
 * @param {string[]} [ctx.notes] Analysis-wide limits to report (startup caps).
 * @param {import('./code-source').CodeSource} [ctx.source] Code at the PR head and base, for
 *   get_source, list_files and search_code; without it those tools say they are not available.
 * @param {(kind: 'cards'|'callers', normalised: any) => Promise<{ stored: boolean, reason?: string, errors?: string[] }>} [ctx.forward]
 *   Hands a checked submission to the editor; absent when no editor is connected.
 * @param {AbortSignal} [ctx.signal] Stops a running `impact_paths` walk.
 */
function createImpactTools(ctx) {
  const env = makeEnv(ctx);
  /** @type {ToolDef[]} */
  const tools = [];
  addCardTools(tools, env);
  addLocationTools(tools, env);
  addCheckTools(tools, env);
  addCodeTools(tools, env);
  addSubmitTools(tools, env);
  return {
    tools,
    /** @param {string} name @param {any} args @returns {Promise<any|null>} null for an unknown tool */
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      return tool ? tool.run(args || {}) : null;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Shared state of one tool set

/**
 * @param {Parameters<typeof createImpactTools>[0]} ctx
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

/** @typedef {ReturnType<typeof makeEnv>} Env */

/**
 * Impact facts of a set of changes, summed from their impact paths.
 * @param {Env} env @param {string[]} members
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

/** The seams that involve a card. @param {Env} env @param {string} id */
const seamsOf = (env, id) => env.seams.filter((/** @type {any} */ s) => (s.clusters || []).includes(id));

/** A change as a short row. @param {Env} env @param {string} id */
function nameOf(env, id) {
  const c = env.changes.get(id);
  if (!c) return { id, label: id };
  return {
    id, label: c.label, file: c.relPath || env.rel(c.file), lines: c.deletedFn ? null : [c.startLine, c.endLine],
    kinds: c.deletedFn ? ['deleted'] : (c.kinds || []).map((/** @type {any} */ k) => k.id), ...(c.added ? { added: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Facts about cards and changes

/** @param {ToolDef[]} tools @param {Env} env */
function addCardTools(tools, env) {
  tools.push({
    name: 'list_cards', title: 'List cluster cards', annotations: READ_ONLY,
    description: 'The PR\'s changes grouped into cards (and repeated-edit sweeps). Per card: id, label, member count, caller stats, entry-point types its changes reach, and a seam summary. '
      + 'With detail: true, also each card\'s members (id, name, file, change kinds), its entry points, the cards it has seams with, and its merge hints: usually enough to title, summarise and merge every card without get_card. Paged.',
    inputSchema: z.object({
      ...pageShape,
      detail: z.boolean().optional().describe('Add members, entry points, seams and merge hints to each card (fewer calls than get_card per card).'),
    }).strict(),
    run: async (args) => {
      const items = env.allCards.map((c) => {
        const im = impactOf(env, c.members || []);
        /** @type {Record<string, number>} */
        const seamTypes = {};
        for (const s of seamsOf(env, c.id)) seamTypes[s.type] = (seamTypes[s.type] || 0) + 1;
        const item = {
          id: c.id, kind: c.kind, label: c.label, members: (c.members || []).length, mirrored: (c.mirrorMembers || []).length,
          stats: c.stats, entryTypes: im.entryTypes, testOnlyMembers: im.testOnlyMembers, seams: seamTypes, impactComplete: im.complete,
        };
        if (args.detail !== true) return item;
        const members = (c.members || []).map((/** @type {string} */ m) => nameOf(env, m));
        return {
          ...item,
          memberList: members.slice(0, MAX_DETAIL_MEMBERS), membersShown: Math.min(members.length, MAX_DETAIL_MEMBERS),
          entryPoints: im.entryPoints.slice(0, MAX_DETAIL_ENTRIES).map((e) => ({ type: e.type, name: e.name })), entryPointsTotal: im.entryPoints.length,
          seamsWith: [...new Set(seamsOf(env, c.id).flatMap((/** @type {any} */ s) => s.clusters).filter((/** @type {string} */ k) => k !== c.id))].slice(0, MAX_SEAMS_SHOWN),
          mergeHints: env.hints.filter((/** @type {any} */ h) => h.clusters.includes(c.id) && h.strength >= 1).slice(0, 3)
            .map((/** @type {any} */ h) => ({ cards: h.clusters, strength: h.strength })),
          impactReasons: im.complete ? [] : im.reasons.slice(0, 2),
        };
      });
      return paged({ pr: { base: env.result.base && env.result.base.ref, changed: env.changes.size, cards: env.allCards.length }, limits: env.notes }, 'cards', items, args);
    },
  });

  tools.push({
    name: 'get_card', title: 'Get one card', annotations: READ_ONLY,
    description: 'One card: its members (names, kinds, files, lines), impact facts (entry points, path ends, top paths, completeness), seams with other cards, and merge hints with their evidence. Members page with page/pageSize.',
    inputSchema: z.object({ id: z.string().min(1).max(100).describe('Card id from list_cards, such as K3.'), ...pageShape }).strict(),
    run: async (args) => {
      const c = env.cardById.get(String(args.id));
      if (!c) throw new ToolError(`unknown card id ${args.id}; call list_cards for the ids`);
      const im = impactOf(env, c.members || []);
      const mergeHints = env.hints.filter((/** @type {any} */ h) => h.clusters.includes(c.id)).slice(0, MAX_HINTS_SHOWN)
        .map((/** @type {any} */ h) => ({ cards: h.clusters, strength: h.strength, evidence: (h.evidence || []).slice(0, 6) }));
      const base = {
        id: c.id, kind: c.kind, label: c.label, files: (c.files || []).slice(0, MAX_FILES_SHOWN), module: c.module, stats: c.stats,
        mirrored: (c.mirrorMembers || []).length ? { count: c.mirrorMembers.length, of: c.mirrorOf } : null,
        moved: c.moved || [], generated: c.generated || null, hub: !!c.hub,
        impact: im, complete: im.complete, reasons: im.reasons,
        seams: seamsOf(env, c.id).slice(0, MAX_SEAMS_SHOWN).map((/** @type {any} */ s) => ({ type: s.type, cards: s.clusters, at: s.at, viaCount: s.viaCount, types: s.types })),
        mergeHints,
      };
      return paged(base, 'members', (c.members || []).map((/** @type {string} */ m) => nameOf(env, m)), args);
    },
  });

  tools.push({
    name: 'get_change', title: 'Get one changed function', annotations: READ_ONLY,
    description: 'One changed (or deleted) function by id (relPath#offset, from get_card): before/after signatures, change kinds, added throws, the diff hunk of that function, its callers with call-site update state, tests reaching it, and its impact paths.',
    inputSchema: z.object({ id: z.string().min(1).max(2000).describe('Change id such as src/a.ts#1234.') }).strict(),
    run: async (args) => getChange(env, String(args.id)),
  });
}

/** @param {Env} env @param {string} id */
function getChange(env, id) {
  const c = env.changes.get(id);
  if (!c) throw new ToolError(`unknown change id ${id}`);
  if (c.deletedFn) return { id, label: c.label, file: c.relPath, deleted: true, baseSig: c.baseSig || c.sig || null, complete: false, reasons: ['former callers of a deleted function are not searched'] };
  const callers = (c.callers || []).map((/** @type {any} */ x) => ({
    label: x.label, file: env.rel(x.file), line: env.lineAt(x.file, x.pos), test: !!x.test, callState: x.callState || null,
    callSiteLines: (x.callSites || []).slice(0, 5).map((/** @type {any} */ s) => env.lineAt(x.file, s.start)),
  }));
  const hunk = hunkFor(env, c);
  return fitObject({
    id, label: c.label, file: c.relPath, lines: [c.startLine, c.endLine], added: !!c.added,
    baseSig: c.baseSig ?? null, headSig: c.headSig ?? null,
    kinds: (c.kinds || []).map((/** @type {any} */ k) => ({ id: k.id, label: k.label })), throwsAdded: c.throwsAdded || [],
    hunk: hunk.text, hunkComplete: hunk.complete,
    callerState: c.callerState, callers,
    tests: { state: c.testState, found: c.tests || [], incompleteReason: c.testReachIncompleteReason || null },
    impactPaths: env.paths[id] || null,
    complete: c.callersComplete === true, reasons: c.callersComplete ? [] : [c.callersIncompleteReason || 'callers may be missing'],
  });
}

/**
 * The hunks of the file diff that overlap the function's lines.
 * @param {Env} env @param {any} c
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

// ---------------------------------------------------------------------------------------
// Facts about any function

/**
 * The resolver and name offset for a (file, line, name) query.
 * @param {Env} env @param {{ file: unknown, line: unknown, name: unknown }} args
 */
function locate(env, args) {
  if (!isRelativePath(args.file)) throw new ToolError('file must be a repository-relative path');
  const relPath = /** @type {string} */ (args.file);
  if (!Number.isSafeInteger(args.line) || /** @type {number} */ (args.line) < 1 || /** @type {number} */ (args.line) > MAX_LINE) throw new ToolError(`line must be an integer from 1 to ${MAX_LINE}`);
  const line = /** @type {number} */ (args.line);
  if (typeof args.name !== 'string' || !IDENTIFIER.test(args.name)) throw new ToolError('name must be a single identifier');
  const name = args.name;
  const file = env.abs(relPath);
  const text = env.readText(file);
  if (text === null) throw new ToolError(`cannot read ${relPath} at the PR head`);
  const starts = lineStarts(text);
  if (line > starts.length) throw new ToolError(`${relPath} has ${starts.length} lines`);
  const lineText = text.slice(starts[line - 1], line < starts.length ? starts[line] - 1 : text.length);
  const m = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`).exec(lineText);
  if (!m) throw new ToolError(`${name} is not on line ${line} of ${relPath}: ${lineText.trim().slice(0, 120)}`);
  const lang = langOf(file);
  const { unit, reasons } = unitFor(env, file, lang);
  return { file, relPath, line, pos: starts[line - 1] + m.index, lang, unit, reasons, name };
}

/**
 * The analysed project whose resolver answers for a file, and why it may not.
 * @param {Env} env @param {string} file @param {string|null} lang
 * @returns {{ unit: Unit|null, reasons: string[] }}
 */
function unitFor(env, file, lang) {
  const candidates = env.units.filter((u) => u.files.some((f) => langOf(f) === lang));
  /** @type {string[]} */
  const reasons = [];
  /** @type {Unit|null} */
  let unit;
  if (lang === 'ts' && candidates.some((u) => typeof u.resolver.program === 'function')) {
    unit = candidates.find((u) => { try { return u.resolver.program && u.resolver.program().getSourceFile(file); } catch { return false; } }) || null;
    if (!unit && candidates.length) { unit = candidates[0]; reasons.push('the file is in no analysed TypeScript program, so the search found nothing it could trust'); }
  } else unit = candidates[0] || null;
  if (!unit) reasons.push(`no ${lang || 'supported'} analysis is loaded for this PR (only languages with changed files are analysed)`);
  return { unit, reasons };
}

/** @param {Env} env @param {any} x */
const callerRow = (env, x) => ({
  label: x.label, file: env.rel(x.file), line: env.lineAt(x.file, x.pos), test: !!x.test,
  callSiteLines: (x.callSites || []).slice(0, 5).map((/** @type {any} */ s) => env.lineAt(x.file, s.start)),
});

/** @param {ToolDef[]} tools @param {Env} env */
function addLocationTools(tools, env) {
  tools.push({
    name: 'callers_of', title: 'Callers of any function', annotations: READ_ONLY,
    description: 'Functions that call the function declared at file:line (any function, not only changed ones). TypeScript/JavaScript: the TypeScript language service (call hierarchy). Go and Python: a syntax-only index of the repository, so the list is a lower bound (calls through interfaces, function values and untyped receivers are missed). Carries complete and reasons. Paged.',
    inputSchema: z.object({ ...locShape, ...pageShape }).strict(),
    run: async (args) => {
      const loc = locate(env, args);
      const target = { file: loc.relPath, line: loc.line, name: loc.name };
      if (!loc.unit) return { target, callers: [], complete: false, reasons: loc.reasons };
      const cs = await loc.unit.resolver.callerState(loc.file, loc.pos, {});
      const reasons = [...loc.reasons, ...(cs.complete ? [] : [cs.reason || 'the search did not finish'])];
      if (loc.unit.resolver.callersLowerBound) reasons.push('syntax-only index: a lower bound');
      return paged({ target, state: cs.state, complete: cs.complete === true && !loc.unit.resolver.callersLowerBound && !loc.reasons.length, reasons },
        'callers', (cs.callers || []).map((/** @type {any} */ x) => callerRow(env, x)), args);
    },
  });

  tools.push({
    name: 'find_references', title: 'References to any function', annotations: READ_ONLY,
    description: 'Every reference (calls and other uses: passed as a value, imported, assigned) to the function declared at file:line. TypeScript/JavaScript: the language service\'s findReferences over the analysed programs. Go and Python: NOT distinguishable from callers_of: the syntax index records call sites only, so this returns the same call sites and says so (referencesAreCallSitesOnly). Carries complete and reasons. Paged.',
    inputSchema: z.object({ ...locShape, ...pageShape }).strict(),
    run: async (args) => findReferences(env, locate(env, args), args),
  });

  tools.push({
    name: 'impact_paths', title: 'Impact paths of any function', annotations: READ_ONLY,
    description: `Walk callers upward from the function at file:line to the application's entry points (HTTP routes, CLI commands, mains, public API, UI routes, …). Each path ends as entry, top-unidentified, unknown (with the reason) or budget. Limits: 8 levels, 300 callers, ${QUERY_DEADLINE_MS} ms.`,
    inputSchema: z.object({ ...locShape }).strict(),
    run: async (args) => {
      const loc = locate(env, args);
      const target = { file: loc.relPath, line: loc.line, name: loc.name };
      if (!loc.unit) return { target, complete: false, reasons: loc.reasons };
      const { createImpactWalker } = require('../engine/impact-paths');
      const walker = createImpactWalker({ repo: env.repo, facts: env.ctx.facts || {}, limits: { deadlineMs: QUERY_DEADLINE_MS }, readText: env.readText, signal: env.ctx.signal });
      await walker.walk(loc.unit.resolver, [{ label: loc.name, file: loc.file, relPath: loc.relPath, namePos: loc.pos, callers: [], kinds: [] }], { scopeNote: loc.unit.scopeNote });
      const r = walker.byId[`${loc.relPath}#${loc.pos}`];
      return fitObject({ target, ...r, reasons: [...loc.reasons, ...r.incompleteReasons], complete: r.complete && !loc.reasons.length });
    },
  });
}

/**
 * @param {Env} env @param {ReturnType<typeof locate>} loc @param {{ page?: unknown, pageSize?: unknown }} args
 */
async function findReferences(env, loc, args) {
  const target = { file: loc.relPath, line: loc.line, name: loc.name };
  if (!loc.unit) return { target, refs: [], complete: false, reasons: loc.reasons };
  const r = loc.unit.resolver;
  if (typeof r.findReferences === 'function') {
    const found = r.findReferences(loc.file, loc.pos);
    const refs = found.refs.map((/** @type {any} */ x) => {
      const t = env.readText(x.file);
      const line = env.lineAt(x.file, x.start);
      const lt = t && line ? t.split('\n')[line - 1] : '';
      return { file: env.rel(x.file), line, text: (lt || '').trim().slice(0, 160) };
    });
    const reasons = [...loc.reasons, ...(found.failed ? ['a language service query failed: the list may be short'] : []),
      'searched the TypeScript programs of the analysed projects only'];
    return paged({ target, referencesAreCallSitesOnly: false, complete: !found.failed && !loc.reasons.length, reasons }, 'refs', refs, args);
  }
  const cs = await r.callerState(loc.file, loc.pos, {});
  const refs = [];
  for (const x of cs.callers || []) for (const s of x.callSites || []) refs.push({ file: env.rel(x.file), line: env.lineAt(x.file, s.start), in: x.label });
  return paged({ target, referencesAreCallSitesOnly: true, complete: false,
    reasons: [...loc.reasons, 'syntax-only index: call sites only, other references are not recorded', ...(cs.complete ? [] : [cs.reason || 'the search did not finish'])] }, 'refs', refs, args);
}

// ---------------------------------------------------------------------------------------
// Checks the agent can run on its own answer

/** @param {ToolDef[]} tools @param {Env} env */
function addCheckTools(tools, env) {
  const cardsAnswer = z.object({
    summary: z.string().optional(),
    cards: z.array(z.object({
      title: z.string(), summary: z.string().optional(), members: z.array(z.string()), reason: z.string().optional(),
    })),
  });
  tools.push({
    name: 'validate_cards', title: 'Validate a card answer', annotations: READ_ONLY,
    description: 'Check a proposed card set: every change id exactly once (mirrored, moved and generated ids count as their card\'s), no unknown ids, non-empty titles. Returns ok and errors[]; fix and resubmit until ok. Nothing is saved: submit_cards saves.',
    inputSchema: z.object({ answer: cardsAnswer }).strict(),
    run: async (args) => {
      const check = validateSubmission('cards', args.answer, submissionContext(env));
      return { ok: check.ok, errors: check.errors, cards: Array.isArray(args.answer && args.answer.cards) ? args.answer.cards.length : 0 };
    },
  });

  tools.push({
    name: 'check_evidence', title: 'Check a call on a line', annotations: READ_ONLY,
    description: 'Does file:line (±1 line) at the PR head contain a call or reference to callee? Returns ok and the lines read.',
    inputSchema: z.object({
      file: locShape.file, line: z.number().int().min(1).max(MAX_LINE),
      callee: z.string().min(1).max(400).describe('Name of the called function (last segment, e.g. save for repo.save).'),
    }).strict(),
    run: async (args) => {
      if (!isRelativePath(args.file)) throw new ToolError('file must be a repository-relative path');
      const line = args.line;
      if (!Number.isSafeInteger(line) || line < 1 || line > MAX_LINE) throw new ToolError(`line must be an integer from 1 to ${MAX_LINE}`);
      const callee = String(args.callee || '').split('.').pop() || '';
      if (!IDENTIFIER.test(callee)) throw new ToolError('callee must be an identifier');
      const text = env.readRel(args.file);
      if (text === null) throw new ToolError(`cannot read ${args.file} at the PR head`);
      return checkEvidence({ text, file: args.file, line, callee });
    },
  });
}

/** @param {Env} env */
function submissionContext(env) {
  return { result: env.result, cards: { clusters: env.ctx.cards.clusters, sweeps: env.ctx.cards.sweeps || [] }, readText: env.readRel };
}

// ---------------------------------------------------------------------------------------
// Code access

/** @param {ToolDef[]} tools @param {Env} env */
function addCodeTools(tools, env) {
  const needSource = () => {
    if (!env.ctx.source) throw new ToolError('code access is not available in this mode');
    return env.ctx.source;
  };
  /** @param {unknown} v @param {string} what @returns {string} */
  const relArg = (v, what) => {
    if (!isRelativePath(v)) throw new ToolError(`${what} must be a repository-relative path`);
    return /** @type {string} */ (v).replace(/^\.\//, '');
  };

  tools.push({
    name: 'get_source', title: 'Read source lines', annotations: READ_ONLY,
    description: `Lines of a file at the PR head (side "head", default) or at its base (side "base"), read from git objects. At most ${MAX_SOURCE_LINES} lines per call; lines are 1-based and inclusive.`,
    inputSchema: z.object({
      file: locShape.file, side: z.enum(['head', 'base']).optional().describe('Which revision (default head).'),
      startLine: z.number().int().min(1).max(MAX_LINE).optional().describe('First line (default 1).'),
      endLine: z.number().int().min(1).max(MAX_LINE).optional().describe(`Last line (default startLine + ${MAX_SOURCE_LINES - 1}).`),
    }).strict(),
    run: async (args) => {
      const src = needSource();
      const file = relArg(args.file, 'file');
      const side = args.side === undefined ? 'head' : args.side;
      if (side !== 'head' && side !== 'base') throw new ToolError('side must be "head" or "base"');
      const text = src.show(side, file);
      if (text === null) throw new ToolError(`${file} does not exist at the ${side} (${(side === 'head' ? src.headSha : src.baseSha).slice(0, 10)})`);
      const lines = text.split('\n');
      const start = intArg(args.startLine, 1, MAX_LINE, 'startLine');
      const end = Math.min(lines.length, intArg(args.endLine, start + MAX_SOURCE_LINES - 1, MAX_LINE, 'endLine'), start + MAX_SOURCE_LINES - 1);
      if (start > lines.length) throw new ToolError(`${file} has ${lines.length} lines at the ${side}`);
      const body = [];
      for (let n = start; n <= end; n++) body.push(`${n}: ${lines[n - 1]}`);
      return fitObject({ file, side, startLine: start, endLine: end, totalLines: lines.length, text: body.join('\n'), more: end < lines.length });
    },
  });

  tools.push({
    name: 'list_files', title: 'List files', annotations: READ_ONLY,
    description: 'Repository-relative paths at the PR head that start with prefix (empty for all). Paged.',
    inputSchema: z.object({ prefix: z.string().max(1024).optional().describe('Path prefix such as src/ (default: all).'), ...pageShape }).strict(),
    run: async (args) => {
      const src = needSource();
      const prefix = args.prefix === undefined || args.prefix === '' ? '' : relArg(args.prefix, 'prefix');
      const all = src.list().filter((f) => f.startsWith(prefix));
      return paged({ prefix, ref: src.headSha }, 'files', all, { page: args.page, pageSize: args.pageSize ?? 200 });
    },
  });

  tools.push({
    name: 'search_code', title: 'Search the code', annotations: READ_ONLY,
    description: `Fixed-string (not regex) search of every file at the PR head, optionally under pathPrefix; at most ${MAX_SEARCH_HITS} matching lines. It is \`git grep\` over the head commit, so it is complete for the head tree (binary files are skipped).`,
    inputSchema: z.object({
      pattern: z.string().min(2).max(1000).describe('The exact text to find.'),
      pathPrefix: z.string().max(1024).optional().describe('Only paths starting with this.'),
    }).strict(),
    run: async (args) => {
      const src = needSource();
      if (typeof args.pattern !== 'string' || args.pattern.length < 2 || args.pattern.includes('\n')) throw new ToolError('pattern must be one line of at least 2 characters');
      const prefix = args.pathPrefix === undefined || args.pathPrefix === '' ? '' : relArg(args.pathPrefix, 'pathPrefix');
      const { hits, capped } = src.grep(args.pattern, prefix, MAX_SEARCH_HITS);
      return fitObject({ pattern: args.pattern, pathPrefix: prefix, ref: src.headSha, hits, complete: !capped,
        reasons: capped ? [`stopped at ${MAX_SEARCH_HITS} matching lines; narrow the pattern or pathPrefix`] : [] });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Write-back

/**
 * Check a submission and hand it to the editor.
 * @param {Env} env @param {'cards'|'callers'} kind @param {unknown} payload
 * @returns {Promise<{ stored: boolean, reason?: string }>}
 * @throws {ToolError} listing what to fix, when the submission or the editor rejects it
 */
async function submit(env, kind, payload) {
  const check = validateSubmission(kind, payload, submissionContext(env));
  if (!check.ok) throw new ToolError(`submit_${kind} rejected; fix these and submit again:\n- ${check.errors.join('\n- ')}`);
  if (!env.ctx.forward) return { stored: false, reason: NO_EDITOR_REASON };
  const sent = await env.ctx.forward(kind, check.normalised);
  if (sent.errors && sent.errors.length) throw new ToolError(`the editor rejected the ${kind} submission:\n- ${sent.errors.join('\n- ')}`);
  return { stored: sent.stored === true, ...(sent.reason ? { reason: sent.reason } : {}) };
}

/** @param {ToolDef[]} tools @param {Env} env */
function addSubmitTools(tools, env) {
  tools.push({
    name: 'submit_cards', title: 'Submit refined cards', annotations: WRITE_BACK,
    description: 'Submit your card set (names, summaries, merges and splits as members lists). It is checked like validate_cards; on errors nothing is saved and the errors say what to fix. When it passes it is handed to the editor, which shows it marked as from the agent. Returns stored and, when not stored, the reason (for example no editor connected).',
    inputSchema: z.object({
      answer: z.object({
        summary: z.string().optional().describe('One paragraph on the whole PR.'),
        cards: z.array(z.object({
          title: z.string(), summary: z.string().optional(), members: z.array(z.string()),
          reason: z.string().optional().describe('Why these members belong together; required in spirit when you merged or split.'),
        })),
      }),
    }).strict(),
    run: async (args) => submit(env, 'cards', args.answer),
  });

  tools.push({
    name: 'submit_callers', title: 'Submit callers of a function', annotations: WRITE_BACK,
    description: 'Submit the callers you found for one function (a change id from get_card, or file + line + name). Every caller\'s file must exist at the PR head and its line (±1) must mention the function, as check_evidence checks. On errors nothing is saved. Returns stored and, when not stored, the reason.',
    inputSchema: z.object({
      answer: z.object({
        function: z.union([
          z.string().describe('Change id such as src/a.ts#1234.'),
          z.object({ file: z.string(), line: z.number().int(), name: z.string() }),
        ]),
        callers: z.array(z.object({
          file: z.string().describe('Repository-relative path of the calling file.'),
          line: z.number().int().describe('1-based line of the call.'),
          name: z.string().optional().describe('The calling function, if any.'),
          kind: z.enum(['call', 'registration', 'reference']).optional().describe('Default call.'),
          note: z.string().optional(),
        })),
      }),
    }).strict(),
    run: async (args) => submit(env, 'callers', args.answer),
  });
}

module.exports = {
  createImpactTools, NO_EDITOR_REASON, MAX_SOURCE_LINES, MAX_SEARCH_HITS, QUERY_DEADLINE_MS,
};
