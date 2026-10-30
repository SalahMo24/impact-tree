// @ts-check
'use strict';
// The default way a language finds callers: the server's call hierarchy at the symbol's
// name, then, when it lists none, the server's references to tell "no use at all" from
// "used as a value" (a callback passed by name has no incoming call but has a reference).
// It asks only `LanguageServices`, so it serves every language and every environment; a
// provider wraps it for its blind spots through the hooks of `callersFromHierarchy`.

/**
 * @typedef {import('./types').LanguageServices} LanguageServices
 * @typedef {import('./types').DocRef} DocRef
 * @typedef {import('../engine/caller-contract').CallerRow} CallerRow
 * @typedef {import('../engine/caller-contract').CallerAnswer} CallerAnswer
 * @typedef {import('../engine/caller-contract').CallerState} CallerState
 */

/**
 * How one call-hierarchy query ended. `ready`: the server listed the incoming calls
 * (`rows`, possibly none). Otherwise `reason` says why not; `retryable` when the server
 * did not answer in time or was not ready. `reason` can be empty when a provider failed
 * without a message.
 * @typedef {{ ready: true, rows: CallerRow[] } | { ready: false, reason: string, retryable: boolean }} HierarchyQuery
 */

// The reason of a query whose `incomingCalls` answered `null` (nothing listed at that
// position; VS Code's command turns the same answer into `[]`).
const NO_INCOMING_RESULT = 'no incoming-call result';

/** @param {unknown} e */
const reasonOf =(e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : '');
/** @param {unknown} e */
const isRetryable = (e) => !!e && typeof e === 'object' && 'retryable' in e && e.retryable === true;

/**
 * A first-come queue that lets at most `limit` caller queries run at once; the others wait
 * (queued, never dropped or failed) until one settles. Used for a language whose server fails
 * under parallel caller queries (Java: `EditorCallerExtras.queryGate`). The queue lives as
 * long as its owner (one per language's extras, so per resolver); a query that rejects frees
 * its slot like one that resolves. A slot is held until the query settles; the services bound
 * that with their per-command deadlines, so a hung server cannot hold a slot forever.
 * @param {number} limit A positive integer.
 * @returns {<T>(run: () => Promise<T>) => Promise<T>}
 */
function createQueryGate(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`createQueryGate needs a positive integer limit, got ${limit}`);
  let running = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  return async (run) => {
    if (running >= limit) await new Promise((resolve) => { waiting.push(() => resolve(undefined)); });
    else running++;
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next(); // the slot passes to the next query, so `running` stays
      else running--;
    }
  };
}

/**
 * Asks for the incoming calls at `pos`: one `prepareCallHierarchy` and the `incomingCalls`
 * of its first item, run as one caller query when the services schedule those. A rejection
 * is kept as the reason, never read as "no callers". The incoming calls are always asked
 * when an item is listed, which the editor's prepared-hierarchy budget relies on; a retried
 * attempt prepares and asks again as one pair. `retryRejected` (a language's
 * `EditorCallerExtras.retryRejected`): a rejection that is not already retryable and whose
 * reason it accepts is asked once more, and that second answer is kept, whatever it is.
 * `gate` (a language's `EditorCallerExtras.queryGate`): each attempt runs through it, so
 * at most its limit of this language's queries are in flight; absent: no extra limit.
 * @param {LanguageServices} services
 * @param {DocRef} doc
 * @param {number} pos UTF-16 offset of the symbol's name.
 * @param {{ retryRejected?: ((reason: string) => boolean)|null, gate?: (<T>(run: () => Promise<T>) => Promise<T>)|null }} [options]
 * @returns {Promise<HierarchyQuery>}
 */
async function queryHierarchy(services, doc, pos, { retryRejected = null, gate = null } = {}) {
  /** @param {LanguageServices} scope @returns {Promise<HierarchyQuery>} */
  const run = async (scope) => {
    const items = await scope.prepareCallHierarchy(doc, pos);
    // No item (or no answer): whether the server supports this symbol is unproven.
    if (!items || !items.length) return { ready: false, reason: 'no call hierarchy item', retryable: false };
    const rows = await scope.incomingCalls(items[0]);
    if (!Array.isArray(rows)) return { ready: false, reason: NO_INCOMING_RESULT, retryable: false };
    return { ready: true, rows };
  };
  const send = () => (services.callerQuery ? services.callerQuery(run) : run(services));
  const ask = () => (gate ? gate(send) : send());
  try {
    return await ask();
  } catch (e) {
    if (!retryRejected || isRetryable(e) || !retryRejected(reasonOf(e))) return { ready: false, reason: reasonOf(e), retryable: isRetryable(e) };
  }
  try {
    return await ask();
  } catch (e) {
    return { ready: false, reason: reasonOf(e), retryable: isRetryable(e) };
  }
}

/**
 * The callers in a query's rows: one per caller (a caller listed twice is kept once) and,
 * without `withTests`, none from test files.
 * @param {CallerRow[]} rows
 * @param {boolean} withTests
 * @returns {CallerRow[]}
 */
function callerRows(rows, withTests) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const id = `${row.file}#${row.pos}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!withTests && row.test) continue;
    out.push(row);
  }
  return out;
}

/**
 * A query as a CallerAnswer.
 * @param {HierarchyQuery} query
 * @param {boolean} withTests
 * @returns {CallerAnswer}
 */
function answerOf(query, withTests) {
  if (!query.ready) {
    return { callers: [], complete: false, reason: query.reason || 'caller query did not complete', ...(query.retryable ? { retryable: true } : {}) };
  }
  return { callers: callerRows(query.rows, withTests), complete: true };
}

/**
 * The verdict when the call hierarchy completed with no caller. Empty call hierarchies also
 * occur for value-passed callbacks, so "none" needs a successful reference query with no
 * use outside the declaration's name.
 * @param {LanguageServices} services
 * @param {DocRef} doc
 * @param {number} pos
 * @param {(() => Promise<string|null>)} [unseenUsers] Before "none": the reason the answer
 *   is unknown after all (uses the server cannot see), or null.
 * @returns {Promise<CallerState>}
 */
async function referenceVerdict(services, doc, pos, unseenUsers) {
  try {
    const refs = await services.references(doc, pos);
    if (!Array.isArray(refs)) return { state: 'unknown', reason: 'no reference result', callers: [], complete: false };
    // A reference whose offsets could not be read is a use we cannot place: it counts.
    const used = refs.some((r) => r.file !== doc.file || r.start == null || r.end == null || !(r.start <= pos && pos < r.end));
    if (used) return { state: 'unknown', reason: 'referenced-as-value', callers: [], complete: false };
    const unseen = unseenUsers ? await unseenUsers() : null;
    return unseen
      ? { state: 'unknown', reason: unseen, callers: [], complete: false }
      : { state: 'none', callers: [], complete: true };
  } catch (e) {
    return { state: 'unknown', reason: reasonOf(e) || 'reference query failed', callers: [], complete: false, ...(isRetryable(e) ? { retryable: true } : {}) };
  }
}

/**
 * The callers of the symbol at `pos`, with a verdict on what an empty list means.
 * Hooks, for a provider (or the editor resolver) that adds what its language needs:
 * - `incoming`: replaces the default caller search (`queryHierarchy` read by `answerOf`),
 *   for one that caches, filters or adds callers. Must return a CallerAnswer.
 * - `settle`: called when the search completed with no caller, before any other verdict;
 *   a CallerState it returns is the answer, null goes on.
 * - `unseenUsers`: asked before "none", as `referenceVerdict` says.
 * A constructor with no caller is `'di'`: something builds it that the search cannot see.
 * @param {LanguageServices} services
 * @param {object} query
 * @param {DocRef} query.doc
 * @param {number} query.pos UTF-16 offset of the symbol's name.
 * @param {boolean} [query.withTests] Default true.
 * @param {boolean} [query.isConstructor] Default false.
 * @param {() => Promise<CallerAnswer>} [query.incoming]
 * @param {() => CallerState|null} [query.settle]
 * @param {() => Promise<string|null>} [query.unseenUsers]
 * @returns {Promise<CallerState>}
 */
async function callersFromHierarchy(services, { doc, pos, withTests = true, isConstructor = false, incoming, settle, unseenUsers }) {
  const answer = incoming ? await incoming() : answerOf(await queryHierarchy(services, doc, pos), withTests);
  const { callers, ...coverage } = answer;
  if (callers.length) return { state: 'resolved', callers, ...coverage };
  if (!coverage.complete) return { state: 'unknown', callers: [], ...coverage };
  const settled = settle ? settle() : null;
  if (settled) return settled;
  if (isConstructor) return { state: 'di', callers: [], complete: true };
  return referenceVerdict(services, doc, pos, unseenUsers);
}

// How many caller targets (`EditorCallerExtras.callerTargets`) one query asks besides its
// own position. Unit: positions, each one call-hierarchy query. Owner: this module; enforced
// in `applyCallerExtras` before any target is asked. Python gives at most one (a class for
// its `__init__`); 4 leaves room for a language with a few aliases. Exhaustion: the first
// MAX_CALLER_TARGETS are asked and the answer is incomplete, naming how many were not.
const MAX_CALLER_TARGETS = 4;

/**
 * The rows of several queries as one list: each caller (file#pos) once, its call sites the
 * union of every query's (a site, start:end, once). When a caller is listed twice and one
 * of its rows has no `callSites`, the larger `sites` count is kept (their overlap is not
 * known). Pure; the input rows are not changed.
 * @param {CallerRow[][]} lists
 * @returns {CallerRow[]}
 */
function mergeCallerRows(lists) {
  /** @type {Map<string, CallerRow>} */
  const byId = new Map();
  for (const rows of lists) {
    for (const r of rows) {
      const id = `${r.file}#${r.pos}`;
      const had = byId.get(id);
      if (!had) { byId.set(id, r); continue; }
      if (!Array.isArray(had.callSites) || !Array.isArray(r.callSites)) {
        byId.set(id, { ...had, sites: Math.max(had.sites || 0, r.sites || 0) });
        continue;
      }
      const seen = new Set(had.callSites.map((s) => `${s.start}:${s.end}`));
      const added = r.callSites.filter((s) => !seen.has(`${s.start}:${s.end}`));
      if (added.length) {
        const callSites = had.callSites.concat(added);
        byId.set(id, { ...had, callSites, sites: callSites.length });
      }
    }
  }
  return [...byId.values()];
}

/**
 * The language's caller targets for `file`/`pos`: other positions whose incoming calls are
 * also this target's callers, de-duplicated, without `pos` itself, up to MAX_CALLER_TARGETS.
 * @param {import('./types').EditorCallerExtras|null} extras
 * @param {string} file @param {number} pos
 * @returns {{ targets: Array<{ file: string, pos: number }>, notAsked: number }}
 */
function callerTargetsOf(extras, file, pos) {
  const given = extras && extras.callerTargets ? extras.callerTargets(file, pos) || [] : [];
  const seen = new Set([`${file}#${pos}`]);
  /** @type {Array<{ file: string, pos: number }>} */
  const all = [];
  for (const t of given) {
    const id = `${t.file}#${t.pos}`;
    if (seen.has(id)) continue;
    seen.add(id);
    all.push({ file: t.file, pos: t.pos });
  }
  return { targets: all.slice(0, MAX_CALLER_TARGETS), notAsked: Math.max(0, all.length - MAX_CALLER_TARGETS) };
}

/**
 * A call-hierarchy query's answer with one language's caller extras applied, in the one
 * order the editor's resolver (src/session/resolver-vscode.js) and the test harness
 * (test/lsp-harness/harness-languages.js) both use, so the harness's verifications check
 * the editor's own composition:
 * 1. Caller targets (`callerTargets`): each other position is asked through `askAt` (at most
 *    MAX_CALLER_TARGETS; past it the answer is incomplete). The answer is made of every
 *    part: the callers of all answered parts, merged (`mergeCallerRows`), and incomplete
 *    when any part was not answered, with each part's reason ("; "-joined). Retryable only
 *    when every unanswered part is retryable and none was explained.
 * 2. The main query not answered: the language may explain the failure
 *    (`explainIncomplete`); an explained failure is a lasting condition, not retryable, and
 *    keeps the answer incomplete (the targets' callers are still listed). An unexplained
 *    `null` incoming-call result (NO_INCOMING_RESULT) at a position that has caller targets
 *    is read as no calls at that position: the language said where its calls are listed
 *    (Pyright: an `__init__`'s constructions at its class, and `null` at the `__init__`
 *    when nothing calls it by that name), and VS Code turns that same `null` into `[]`, so
 *    the editor and the harness read it alike; a target's own `null` is read the same way
 *    (Pyright: a class nothing constructs by name). A rejection, a missing item or a
 *    timeout, at the target or at a caller target, stays incomplete with its reason.
 * 3. The callers (`callerRows`), then `filter` when there is at least one: `kept` replaces
 *    the list (a kept caller may be a copy with fewer call sites).
 * 4. `moreCallers`, when the language has one and every part was answered: its callers are
 *    added once each (tests left out without `withTests`), and its `incompleteReason` makes
 *    the answer incomplete.
 * Nothing here turns a failure into an empty complete answer.
 * @param {HierarchyQuery} hierarchy The main query, at `pos`.
 * @param {object} options
 * @param {import('./types').EditorCallerExtras|null} options.extras The language's extras.
 * @param {import('./types').EditorCallerQuery|null} options.query `extras.query(file, pos)`,
 *   taken when the caller query started.
 * @param {string} options.file Absolute path of the target.
 * @param {number} options.pos UTF-16 offset of the target's name.
 * @param {boolean} options.withTests
 * @param {(file: string, pos: number) => Promise<HierarchyQuery>} [options.askAt] Asks the
 *   call hierarchy at a caller target (both resolvers: `queryHierarchy` on the head side).
 *   Absent: targets are not asked and, when there are any, the answer is incomplete.
 * @param {() => boolean} [options.isStale] Asked after the targets and after `moreCallers`
 *   settle: true when the query belongs to an earlier analysis, so its answer is not built.
 * @returns {Promise<{ stale: true } | { stale: false, answer: CallerAnswer, ready: boolean, explainedReason: string|null, dropped: number, added: number, targetsAsked: number }>}
 *   `ready`: every part answered (the main `null` read through targets counts as answered);
 *   `explainedReason`: the language's explanation of an unanswered main query, or null;
 *   `dropped`: callers `filter` removed; `added`: callers `moreCallers` gave (before
 *   de-duplication); `targetsAsked`: caller-target queries asked.
 */
async function applyCallerExtras(hierarchy, { extras, query, file, pos, withTests, askAt, isStale = () => false }) {
  const { targets, notAsked } = callerTargetsOf(extras, file, pos);
  /** @type {string[]} */
  const reasons = [];
  let retryable = true;
  /** @type {string|null} */
  let explainedReason = null;
  /** @type {CallerRow[][]} */
  const lists = [];
  if (hierarchy.ready) {
    lists.push(hierarchy.rows);
  } else {
    explainedReason = extras && extras.explainIncomplete ? extras.explainIncomplete(hierarchy.reason, file, pos) : null;
    const readAsNone = !explainedReason && hierarchy.reason === NO_INCOMING_RESULT && targets.length > 0 && !!askAt;
    if (!readAsNone) {
      reasons.push(explainedReason || hierarchy.reason || 'caller query did not complete');
      if (explainedReason || !hierarchy.retryable) retryable = false;
    }
  }
  let targetsAsked = 0;
  if (targets.length && !askAt) {
    reasons.push(`${targets.length} other position${targets.length === 1 ? '' : 's'} of its callers not asked`);
    retryable = false;
  } else if (targets.length && askAt) {
    const ask = askAt;
    targetsAsked = targets.length;
    const answers = await Promise.all(targets.map((t) => ask(t.file, t.pos).catch((e) => /** @type {HierarchyQuery} */ ({ ready: false, reason: reasonOf(e), retryable: isRetryable(e) }))));
    if (isStale()) return { stale: true };
    for (const a of answers) {
      if (a.ready) { lists.push(a.rows); continue; }
      // A target's `null`: no calls there, as the editor's `[]` for it (step 2).
      if (a.reason === NO_INCOMING_RESULT) continue;
      reasons.push(`at another position of its callers: ${a.reason || 'caller query did not complete'}`);
      if (!a.retryable) retryable = false;
    }
  }
  if (notAsked) {
    reasons.push(`${notAsked} more position${notAsked === 1 ? '' : 's'} of its callers not asked (limit ${MAX_CALLER_TARGETS})`);
    retryable = false;
  }
  const ready = !reasons.length;
  let out = callerRows(targets.length ? mergeCallerRows(lists) : (lists[0] || []), withTests);
  let dropped = 0;
  if (query && out.length) {
    const filtered = query.filter(out);
    // A copy: `kept` may be `out` itself, and `out` is added to below.
    out = filtered.kept.slice();
    dropped = filtered.dropped;
  }
  if (!ready) {
    const answer = { callers: out, complete: false, reason: reasons.join('; '), ...(retryable ? { retryable: true } : {}) };
    return { stale: false, answer, ready, explainedReason, dropped, added: 0, targetsAsked };
  }
  let added = 0;
  /** @type {string|null} */
  let incompleteReason = null;
  if (query && query.moreCallers) {
    const more = await query.moreCallers();
    if (isStale()) return { stale: true };
    incompleteReason = more.incompleteReason;
    added = more.callers.length;
    const have = new Set(out.map((c) => `${c.file}#${c.pos}`));
    for (const e of more.callers) {
      if (have.has(`${e.file}#${e.pos}`)) continue;
      if (!withTests && e.test) continue;
      out.push(e);
    }
  }
  const answer = incompleteReason ? { callers: out, complete: false, reason: incompleteReason } : { callers: out, complete: true };
  return { stale: false, answer, ready, explainedReason: null, dropped, added, targetsAsked };
}

module.exports = {
  callersFromHierarchy, queryHierarchy, createQueryGate, callerRows, answerOf, referenceVerdict, applyCallerExtras, mergeCallerRows,
  MAX_CALLER_TARGETS, NO_INCOMING_RESULT,
};
