// @ts-check
'use strict';
// Impact paths: from a changed function, walk its production callers upward until each
// path reaches an entry point of the application (./entry-points.js), or says why it
// stopped. Facts for a reviewer or an agent to explain, so every path carries how it ended,
// and a walk that could not finish says so (docs/CODING_STYLE.md §1).

const path = require('path');
const { realClock } = require('./clock');
const { withDeadline } = require('./deadline');
const { throwIfCancelled } = require('./cancellation');
const { entryLanguageOf, declarationEntry, callSiteEntry } = require('./entry-points');

/** @typedef {import('./entry-points').EntryInfo} EntryInfo */
/** @typedef {import('./entry-points').EntryFacts} EntryFacts */
/** @typedef {import('./caller-contract').CallerRow} CallerRow */

/**
 * Limits of one walk. Owner: `impactPathsFor`'s caller (`analyze`, from `opts.impactPaths`).
 * - `maxDepth`, in caller levels, the changed function at level 0: a node at level
 *   `maxDepth` that is not an entry is not queried and its path ends `budget`. 1..32,
 *   default 8.
 * - `maxNodes`, in distinct callers admitted to one changed function's walk (the changed
 *   function itself not counted). A caller is admitted before it is queued; the first one
 *   refused ends its path `budget`. 1..10000, default 300.
 * - `deadlineMs`, in milliseconds of wall time for every walk of one analysis together,
 *   counted from the first walk. Checked before each caller query; each query is also
 *   bounded by the time left. Once it passes, every path still open ends `budget`.
 *   1..600000, default 30000.
 */
/** @typedef {{ maxDepth: number, maxNodes: number, deadlineMs: number }} WalkLimits */
/** @type {Readonly<WalkLimits>} */
const DEFAULT_LIMITS = Object.freeze({ maxDepth: 8, maxNodes: 300, deadlineMs: 30000 });
const LIMIT_RANGES = Object.freeze({ maxDepth: [1, 32], maxNodes: [1, 10000], deadlineMs: [1, 600000] });
// Paths kept in `topPaths`. Unit: paths.
const TOP_PATHS = 3;
// Source files one analysis keeps in memory for entry detection. Unit: files. Past it, a
// node's file is read again each time it is needed (slower, not wrong).
const MAX_CACHED_TEXTS = 2000;

/**
 * @param {Partial<WalkLimits>|undefined} given
 * @returns {WalkLimits}
 * @throws {RangeError} A limit that is not an integer in its range.
 */
function validateLimits(given) {
  /** @type {WalkLimits} */
  const out = { ...DEFAULT_LIMITS };
  for (const key of /** @type {Array<keyof WalkLimits>} */ (Object.keys(DEFAULT_LIMITS))) {
    const value = given ? given[key] : undefined;
    if (value === undefined) continue;
    const [lo, hi] = LIMIT_RANGES[key];
    if (!Number.isSafeInteger(value) || value < lo || value > hi) throw new RangeError(`impact paths: ${key} must be an integer from ${lo} to ${hi}`);
    out[key] = value;
  }
  return out;
}

/**
 * @typedef {object} PathEnd
 * @property {'entry'|'top-unidentified'|'budget'|'unknown'} end
 * @property {EntryInfo} [entry] When `end` is `'entry'`.
 * @property {string} [reason] When `end` is `'budget'` or `'unknown'`.
 * @property {'module'|'function'|'test-only'|'app-start'} [topKind] When `end` is
 *   `'top-unidentified'`: module-level code (runs at import), a function nothing calls, a
 *   function only tests call, or a package `bin` file's module code (program start).
 * @property {string} [bin] The command name, when `topKind` is `'app-start'`.
 * @property {string[]} via Labels from the changed function to the last node, both included.
 * @property {string} file Repository-relative path of the last node.
 * @property {number} depth Caller levels from the changed function to the last node.
 * @property {boolean} throughStale The first caller is one not updated by this change, and
 *   the change is to the signature or throws (not body only); a changed caller does not count.
 * @property {boolean} lowerBound Some answer on the path came from a resolver whose
 *   answers are lower bounds (a syntax-only index): callers may be missing anywhere on it.
 */

/**
 * @typedef {object} ImpactPaths
 * @property {string} id `relPath#namePos` of the changed function.
 * @property {Array<{ type: string, name: string, file: string, depth: number, via: string[], how: string, method?: string, route?: string }>} entries
 *   Distinct entry points reached (by type, name and file), each at its shortest depth.
 * @property {{ ends: Record<string, number>, entryTypes: Record<string, number>, visited: number, testCallers: number }} summary
 *   `ends` counts paths by how they ended; `entryTypes` counts distinct entries by type;
 *   `visited` the callers admitted; `testCallers` the changed function's direct test
 *   callers (tests are not walked).
 * @property {PathEnd[]} topPaths Up to TOP_PATHS paths: through a caller not updated
 *   first, then ending at an entry, then shortest.
 * @property {boolean} testOnly Every path ends at a function only tests call.
 * @property {boolean} complete True only when every path ended at an entry or at a top
 *   with no callers, from answers that were complete and not lower bounds.
 * @property {string[]} incompleteReasons Distinct reasons, when not complete.
 * @property {number} walkMs Wall time of this walk (log-only).
 */

/**
 * A shared deadline for every walk of one analysis.
 * @param {number} deadlineMs @param {import('./clock').Clock} clock
 */
function makeDeadline(deadlineMs, clock) {
  const end = clock.now() + deadlineMs;
  return { left: () => end - clock.now(), deadlineMs, clock };
}

/**
 * A walker for one analysis: every `walk` shares the limits, the deadline (counted from
 * the walker's creation) and the file-text cache. Owner: `analyze`, for one run.
 * @param {object} input
 * @param {string} input.repo Absolute repository root.
 * @param {EntryFacts} [input.facts]
 * @param {Partial<WalkLimits>} [input.limits]
 * @param {AbortSignal} [input.signal]
 * @param {import('./clock').Clock} [input.clock]
 * @param {(file: string) => string|null} [input.readText] Text of an absolute path, or null.
 * @throws {RangeError} Invalid `limits`.
 */
function createImpactWalker({ repo, facts = {}, limits, signal, clock = realClock, readText }) {
  const valid = validateLimits(limits);
  const deadline = makeDeadline(valid.deadlineMs, clock);
  const texts = makeTextCache(readText);
  /** @type {Record<string, ImpactPaths>} */
  const byId = {};
  let walkMs = 0;
  return {
    limits: valid,
    byId,
    /** Total wall time spent walking, log-only. */
    walkMs: () => walkMs,
    /**
     * Walk every changed function of one unit with that unit's resolver.
     * @param {any} resolver @param {any[]} changed
     * @param {{ scopeNote?: string }} [unit] `scopeNote`: the scope a lower-bound resolver
     *   (a syntax-only index) starts every incomplete reason with. That part only restates
     *   the scope, which `lowerBound` already carries; what follows it is a real gap.
     * @throws {import('./cancellation').AnalysisCancelledError} `signal` was aborted.
     */
    async walk(resolver, changed, unit = {}) {
      for (const c of changed) {
        throwIfCancelled(signal);
        const result = await walkOne({ resolver, changed: c, repo, facts, limits: valid, deadline, signal, texts, scopeNote: unit.scopeNote });
        byId[result.id] = result;
        walkMs += result.walkMs;
      }
    },
  };
}

/**
 * The impact paths of every changed function, unit by unit (tests and scripts).
 * @param {{ units: Array<{ resolver: any, changed: any[] }> } & Parameters<typeof createImpactWalker>[0]} input
 * @returns {Promise<{ byId: Record<string, ImpactPaths>, limits: WalkLimits, walkMs: number }>}
 */
async function impactPathsFor({ units, ...rest }) {
  const walker = createImpactWalker(rest);
  for (const { resolver, changed } of units) await walker.walk(resolver, changed);
  return { byId: walker.byId, limits: walker.limits, walkMs: walker.walkMs() };
}

/** @param {((file: string) => string|null)|undefined} readText */
function makeTextCache(readText) {
  const read = readText || ((/** @type {string} */ file) => {
    try { return require('fs').readFileSync(file, 'utf8'); } catch { return null; }
  });
  /** @type {Map<string, string|null>} */
  const cache = new Map();
  return (/** @type {string} */ file) => {
    if (cache.has(file)) return /** @type {string|null} */ (cache.get(file));
    const text = read(file);
    if (cache.size < MAX_CACHED_TEXTS) cache.set(file, text);
    return text;
  };
}

/**
 * @typedef {object} WalkNode
 * @property {string} file Absolute path.
 * @property {number} pos
 * @property {string} label
 * @property {number} depth
 * @property {WalkNode|null} parent
 * @property {boolean} lowerBound
 * @property {boolean} throughStale
 */

/**
 * One changed function's walk. Breadth first with a global visited set: each caller is
 * walked once, at its shortest depth, so a diamond's second arm and a cycle's back edge
 * add no path (cycles cut). A worklist, not recursion: depth and breadth are both bounded.
 * @param {{ resolver: any, changed: any, repo: string, facts: EntryFacts, limits: WalkLimits,
 *   deadline: ReturnType<typeof makeDeadline>, signal: AbortSignal|undefined,
 *   texts: (file: string) => string|null, scopeNote: string|undefined }} input
 * @returns {Promise<ImpactPaths>}
 */
async function walkOne({ resolver, changed, repo, facts, limits, deadline, signal, texts, scopeNote }) {
  // wall-clock: log-only — this walk's time for the report
  const t0 = Date.now();
  const rel = (/** @type {string} */ f) => path.relative(repo, f).split(path.sep).join('/');
  const id = `${changed.relPath || rel(changed.file)}#${changed.namePos}`;
  const lowerBoundResolver = resolver.callersLowerBound === true;
  /** @type {PathEnd[]} */
  const ends = [];
  /** @type {Set<string>} */
  const reasons = new Set();
  // The tree's rule (src/tree-row-models.js, classifyChangeVerdict): a caller not updated
  // matters only when the signature or throws changed; a body-only edit leaves callers
  // untouched as a matter of course. A caller that is itself a changed member
  // (`changed-elsewhere`) is part of the change, not a caller left behind.
  const risky = (changed.kinds || []).some((/** @type {{ id: string }} */ k) => k.id !== 'body');
  const staleIds = new Set(risky ? (changed.stale || [])
    .filter((/** @type {any} */ s) => s.callState !== 'changed-elsewhere')
    .map((/** @type {CallerRow} */ s) => `${s.file}#${s.pos}`) : []);
  const testCallers = (changed.callers || []).filter((/** @type {CallerRow} */ x) => x.test).length;

  const viaOf = (/** @type {WalkNode} */ n) => { const out = []; for (let k = /** @type {WalkNode|null} */ (n); k; k = k.parent) out.push(k.label); return out.reverse(); };
  const finish = (/** @type {WalkNode} */ n, /** @type {Omit<PathEnd, 'via'|'file'|'depth'|'throughStale'|'lowerBound'>} */ e) => {
    ends.push({ ...e, via: viaOf(n), file: rel(n.file), depth: n.depth, throughStale: n.throughStale, lowerBound: n.lowerBound });
    if (e.end === 'unknown' || e.end === 'budget') reasons.add(/** @type {string} */ (e.reason));
  };

  /** @type {WalkNode} */
  const start = { file: changed.file, pos: changed.namePos, label: changed.label, depth: 0, parent: null, lowerBound: lowerBoundResolver, throughStale: false };
  const seen = new Set([`${start.file}#${start.pos}`]);
  let admitted = 0;
  let nodeBudgetHit = false;
  /** @type {WalkNode[]} */
  const queue = [];

  const own = entryOfNode(start, null, facts, texts, repo);
  if (own) finish(start, { end: 'entry', entry: own });
  else queue.push(start);

  let head = 0;
  while (head < queue.length) {
    throwIfCancelled(signal);
    const node = queue[head++];
    // Module-level code (the resolver names it after its file, at offset 0) runs when the
    // module is loaded; imports are not traced, so it is a top of the call graph.
    if (isModuleLevel(node)) {
      // A package `bin` file's module code is where the program starts: a known top.
      const bin = facts.binFiles ? facts.binFiles.get(rel(node.file)) : undefined;
      if (bin !== undefined) { finish(node, { end: 'top-unidentified', topKind: 'app-start', bin }); continue; }
      finish(node, { end: 'top-unidentified', topKind: 'module' });
      reasons.add('module-level code on a path: what loads the module is not traced');
      continue;
    }
    // Module code is not queried, so the depth limit (which stops queries) applies after it.
    if (node.depth >= limits.maxDepth) { finish(node, { end: 'budget', reason: `depth limit of ${limits.maxDepth} caller levels` }); continue; }
    const left = deadline.left();
    if (left <= 0) { finish(node, { end: 'budget', reason: `deadline of ${deadline.deadlineMs} ms for all impact paths` }); continue; }
    /** @type {{ callers: CallerRow[], complete: boolean, reason?: string }} */
    let answer;
    try {
      answer = withoutScopeNote(await withDeadline(() => queryCallers(resolver, node), left, 'impact path caller query', deadline.clock),
        lowerBoundResolver ? scopeNote : undefined);
    } catch (e) {
      const message = (e && /** @type {Error} */ (e).message) || 'unknown error';
      // The query outlived the time left (withDeadline): the deadline, not a failure.
      if (deadline.left() <= 0) finish(node, { end: 'budget', reason: `deadline of ${deadline.deadlineMs} ms for all impact paths` });
      else finish(node, { end: 'unknown', reason: `a caller query failed: ${message}` });
      continue;
    }
    const prod = answer.callers.filter((x) => !x.test);
    if (!answer.complete) finish(node, { end: 'unknown', reason: answer.reason || 'a caller query did not finish' });
    if (!prod.length) {
      const wrapped = answer.complete ? wrapperOf(node, texts) : null;
      if (wrapped) { finish(node, { end: 'unknown', reason: `passed to ${wrapped}(): uses of what it returns are not traced` }); continue; }
      if (answer.complete) {
        // An empty answer from a resolver without coverage (TypeScript's `incoming`) is
        // checked against `callerState`, which tells "nothing calls it" from "it is passed
        // as a value" (a handler registered somewhere the text does not show).
        const top = await topState(resolver, node);
        // Only tests call it: a top for production, and the reason a card says "tests only".
        if (top.complete) finish(node, { end: 'top-unidentified', topKind: top.testCallers ? 'test-only' : 'function' });
        else finish(node, { end: 'unknown', reason: top.reason });
      }
      continue;
    }
    for (const caller of prod) {
      const key = `${caller.file}#${caller.pos}`;
      if (seen.has(key)) continue;
      if (admitted >= limits.maxNodes) { nodeBudgetHit = true; break; }
      seen.add(key);
      admitted++;
      /** @type {WalkNode} */
      const next = {
        file: caller.file, pos: caller.pos, label: caller.label, depth: node.depth + 1, parent: node,
        lowerBound: node.lowerBound || lowerBoundResolver,
        throughStale: node.depth === 0 ? staleIds.has(key) : node.throughStale,
      };
      const entry = entryOfNode(next, caller, facts, texts, repo);
      if (entry) finish(next, { end: 'entry', entry });
      else queue.push(next);
    }
    if (nodeBudgetHit) {
      finish(node, { end: 'budget', reason: `node limit of ${limits.maxNodes} callers per changed function` });
      // Every node still queued is an open path the budget cut.
      for (let k = head; k < queue.length; k++) finish(queue[k], { end: 'budget', reason: `node limit of ${limits.maxNodes} callers per changed function` });
      break;
    }
  }
  if (lowerBoundResolver) reasons.add('callers come from a syntax-only index: each answer is a lower bound');
  const lang = entryLanguageOf(changed.file);
  if (!lang) reasons.add('entry points are not recognised for this language');
  // wall-clock: log-only — this walk's time for the report
  return summarise({ id, ends, reasons, admitted, testCallers, walkMs: Date.now() - t0, lowerBoundResolver });
}

/**
 * An answer whose only incompleteness is the scope note of a lower-bound resolver reads as
 * complete within that scope; extra reasons after the note stay, without the note.
 * @param {{ callers: CallerRow[], complete: boolean, reason?: string }} answer
 * @param {string|undefined} scopeNote
 */
function withoutScopeNote(answer, scopeNote) {
  if (answer.complete || !scopeNote || !answer.reason || !answer.reason.startsWith(scopeNote)) return answer;
  const rest = answer.reason.slice(scopeNote.length).replace(/^;\s*/, '');
  return rest ? { ...answer, reason: rest } : { ...answer, complete: true, reason: undefined };
}

/** @param {WalkNode} node */
function isModuleLevel(node) {
  return node.pos === 0 && node.label === path.basename(node.file);
}

/**
 * The call a function expression is passed to, when the function is declared as one
 * (`const X = memo(function X() {…})`): the wrapper's result is what the code uses, and the
 * walk does not follow it. Null otherwise.
 * @param {WalkNode} node @param {(file: string) => string|null} texts
 * @returns {string|null}
 */
function wrapperOf(node, texts) {
  const text = texts(node.file);
  if (!text || node.pos <= 0) return null;
  const m = /([A-Za-z_$][\w$.]*)\s*\(\s*(?:async\s+)?function\s*\*?\s*$/.exec(text.slice(Math.max(0, node.pos - 200), node.pos));
  return m ? m[1] : null;
}

/**
 * Callers of a node with coverage, production only.
 * @param {any} resolver @param {WalkNode} node
 * @returns {Promise<{ callers: CallerRow[], complete: boolean, reason?: string }>}
 */
async function queryCallers(resolver, node) {
  if (resolver.callersNotComputed) return { callers: [], complete: false, reason: resolver.callersNotComputed };
  if (resolver.incomingWithStatus) return resolver.incomingWithStatus(node.file, node.pos, false);
  return { callers: await resolver.incoming(node.file, node.pos, false), complete: true };
}

/**
 * Whether a node with no production caller is a real top. `callerState` searches tests too:
 * a node only tests call is still a top for production.
 * @param {any} resolver @param {WalkNode} node
 * @returns {Promise<{ complete: boolean, reason?: string, testCallers?: number }>}
 *   `testCallers`: test functions that call it (a complete answer only).
 */
async function topState(resolver, node) {
  const testsIn = (/** @type {CallerRow[]} */ rows) => rows.filter((x) => x.test).length;
  try {
    if (resolver.incomingWithStatus) return { complete: true, testCallers: testsIn((await resolver.incomingWithStatus(node.file, node.pos, true)).callers) };
    if (typeof resolver.callerState !== 'function') return { complete: true, testCallers: 0 };
    const cs = await resolver.callerState(node.file, node.pos, {});
    if (cs.state === 'none' || cs.state === 'resolved') return { complete: true, testCallers: testsIn(cs.callers || []) };
    if (cs.state === 'di') return { complete: false, reason: 'a DI container builds this class, so its callers are not visible' };
    return { complete: false, reason: cs.reason === 'referenced-as-value' ? 'referenced as a value (passed or registered), never called directly' : (cs.reason || 'its callers are unknown') };
  } catch (e) {
    return { complete: false, reason: `a caller query failed: ${(e && /** @type {Error} */ (e).message) || 'unknown error'}` };
  }
}

/**
 * The entry point a node is, by its declaration or, for a caller, by the call site of the
 * function below it on the path. Null when neither matches or the file cannot be read.
 * @param {WalkNode} node @param {CallerRow|null} row @param {EntryFacts} facts
 * @param {(file: string) => string|null} texts @param {string} repo
 * @returns {EntryInfo|null}
 */
function entryOfNode(node, row, facts, texts, repo) {
  const language = entryLanguageOf(node.file);
  if (!language) return null;
  const text = texts(node.file);
  if (text === null) return null;
  const relPath = path.relative(repo, node.file).split(path.sep).join('/');
  const own = declarationEntry({ language, text, pos: node.pos, label: node.label, relPath, facts });
  if (own) return own;
  for (const site of (row && row.callSites) || []) {
    const hit = callSiteEntry({ language, text, callerPos: node.pos, callSiteStart: site.start, relPath, callerLabel: node.label, facts });
    if (hit) return hit;
  }
  return null;
}

const END_ORDER = { entry: 0, 'top-unidentified': 1, unknown: 2, budget: 3 };

/**
 * @param {{ id: string, ends: PathEnd[], reasons: Set<string>, admitted: number, testCallers: number, walkMs: number, lowerBoundResolver: boolean }} input
 * @returns {ImpactPaths}
 */
function summarise({ id, ends, reasons, admitted, testCallers, walkMs, lowerBoundResolver }) {
  /** @type {Record<string, number>} */
  const endCounts = { entry: 0, 'top-unidentified': 0, budget: 0, unknown: 0 };
  /** @type {Map<string, ImpactPaths['entries'][number]>} */
  const entries = new Map();
  for (const e of ends) {
    endCounts[e.end]++;
    if (e.end !== 'entry' || !e.entry) continue;
    const key = `${e.entry.type}\u0000${e.entry.name}\u0000${e.file}`;
    const prior = entries.get(key);
    if (!prior || e.depth < prior.depth) entries.set(key, { ...e.entry, file: e.file, depth: e.depth, via: e.via });
  }
  /** @type {Record<string, number>} */
  const entryTypes = {};
  for (const e of entries.values()) entryTypes[e.type] = (entryTypes[e.type] || 0) + 1;
  const topPaths = ends.slice().sort((a, b) => Number(b.throughStale) - Number(a.throughStale)
    || END_ORDER[a.end] - END_ORDER[b.end] || a.depth - b.depth).slice(0, TOP_PATHS);
  const complete = !lowerBoundResolver && reasons.size === 0 && endCounts.unknown === 0 && endCounts.budget === 0;
  // Every path ends at a function only tests call: the change matters to tests alone (within
  // the search's scope; `complete` and `lowerBound` say how far that goes).
  const testOnly = ends.length > 0 && ends.every((e) => e.end === 'top-unidentified' && e.topKind === 'test-only');
  return {
    id,
    testOnly,
    entries: [...entries.values()].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
    summary: { ends: endCounts, entryTypes, visited: admitted, testCallers },
    topPaths,
    complete,
    incompleteReasons: complete ? [] : [...reasons],
    walkMs,
  };
}

module.exports = { withoutScopeNote, impactPathsFor, createImpactWalker, validateLimits, DEFAULT_LIMITS };
