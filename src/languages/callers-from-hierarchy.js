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

/** @param {unknown} e */
const reasonOf = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : '');
/** @param {unknown} e */
const isRetryable = (e) => !!e && typeof e === 'object' && 'retryable' in e && e.retryable === true;

/**
 * Asks for the incoming calls at `pos`: one `prepareCallHierarchy` and the `incomingCalls`
 * of its first item, run as one caller query when the services schedule those. A rejection
 * is kept as the reason, never read as "no callers".
 * @param {LanguageServices} services
 * @param {DocRef} doc
 * @param {number} pos UTF-16 offset of the symbol's name.
 * @returns {Promise<HierarchyQuery>}
 */
async function queryHierarchy(services, doc, pos) {
  /** @param {LanguageServices} scope @returns {Promise<HierarchyQuery>} */
  const run = async (scope) => {
    const items = await scope.prepareCallHierarchy(doc, pos);
    // No item (or no answer): whether the server supports this symbol is unproven.
    if (!items || !items.length) return { ready: false, reason: 'no call hierarchy item', retryable: false };
    const rows = await scope.incomingCalls(items[0]);
    if (!Array.isArray(rows)) return { ready: false, reason: 'no incoming-call result', retryable: false };
    return { ready: true, rows };
  };
  try {
    return await (services.callerQuery ? services.callerQuery(run) : run(services));
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

/**
 * A call-hierarchy query's answer with one language's caller extras applied, in the one
 * order the editor's resolver (src/resolver-vscode.js) and the test harness
 * (test/lsp-harness/harness-languages.js) both use, so the harness's verifications check
 * the editor's own composition:
 * 1. A query the server did not answer: the language may explain the failure
 *    (`explainIncomplete`); an explained failure is a lasting condition, not retryable.
 * 2. The callers (`callerRows`), then `filter` when there is at least one: `kept` replaces
 *    the list (a kept caller may be a copy with fewer call sites).
 * 3. `moreCallers`, when the language has one: its callers are added once each (tests left
 *    out without `withTests`), and its `incompleteReason` makes the answer incomplete.
 * Nothing here turns a failure into an empty complete answer.
 * @param {HierarchyQuery} hierarchy
 * @param {object} options
 * @param {import('./types').EditorCallerExtras|null} options.extras The language's extras.
 * @param {import('./types').EditorCallerQuery|null} options.query `extras.query(file, pos)`,
 *   taken when the caller query started.
 * @param {string} options.file Absolute path of the target.
 * @param {number} options.pos UTF-16 offset of the target's name.
 * @param {boolean} options.withTests
 * @param {() => boolean} [options.isStale] Asked after `moreCallers` settles: true when the
 *   query belongs to an earlier analysis, so its answer is not built.
 * @returns {Promise<{ stale: true } | { stale: false, answer: CallerAnswer, explainedReason: string|null, dropped: number, added: number }>}
 *   `explainedReason`: the language's explanation of an unanswered query, or null;
 *   `dropped`: callers `filter` removed; `added`: callers `moreCallers` gave (before
 *   de-duplication).
 */
async function applyCallerExtras(hierarchy, { extras, query, file, pos, withTests, isStale = () => false }) {
  if (!hierarchy.ready) {
    const explainedReason = extras && extras.explainIncomplete ? extras.explainIncomplete(hierarchy.reason, file, pos) : null;
    const retryable = !explainedReason && hierarchy.retryable;
    const reason = explainedReason || hierarchy.reason || 'caller query did not complete';
    return { stale: false, answer: { callers: [], complete: false, reason, ...(retryable ? { retryable: true } : {}) }, explainedReason, dropped: 0, added: 0 };
  }
  let out = callerRows(hierarchy.rows, withTests);
  let dropped = 0;
  if (query && out.length) {
    const filtered = query.filter(out);
    // A copy: `kept` may be `out` itself, and `out` is added to below.
    out = filtered.kept.slice();
    dropped = filtered.dropped;
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
  return { stale: false, answer, explainedReason: null, dropped, added };
}

module.exports = { callersFromHierarchy, queryHierarchy, callerRows, answerOf, referenceVerdict, applyCallerExtras };
