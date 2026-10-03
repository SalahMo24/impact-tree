// @ts-check
'use strict';
// Test reachability: does ANY test sit in the upward closure of a changed symbol.
//
// "A test is reachable" is a positive finding. The absence of one is only a finding when
// the walk looked everywhere it was asked to; a query that failed or did not finish, or
// a budget that cut the walk short, leaves it `'unknown'`, never `'uncovered'`. Depth is
// different: it is the scope the caller asked for, so `'uncovered'` means "no test within
// that many caller levels", and the UI says so.

/** @typedef {import('./caller-contract').CallerRow} CallerRow */

// Visited callers one walk may admit (see `walkTestReach`). One walk runs per changed
// symbol and each admitted caller can cost a language-server query, so this bounds the
// work a single symbol causes. Not a user setting: `analyze` takes `opts.reachBudget`.
const DEFAULT_REACH_BUDGET = 120;

/**
 * Walk the callers of a symbol upward until a test is found.
 *
 * Limits, both checked where the work is done:
 * - `budget`, in visited nodes: distinct callers admitted to the walk. The start symbol
 *   does not count, nor does a caller that is the start symbol (self-recursion). A caller
 *   is admitted before it is inserted, so a graph of exactly `budget` callers finishes and
 *   one needing the next is refused, which stops the walk. Any integer >= 0; the caller
 *   (`analyze`) passes DEFAULT_REACH_BUDGET unless overridden.
 * - `depth`, in caller levels, with the start symbol at level 0: callers at levels 1 to
 *   `depth` are searched. A node at level `depth` is not queried. Depth is the declared
 *   scope, not a budget, so stopping there is not a failure to finish: a walk with no test
 *   in those levels is `'uncovered'` within that scope.
 *
 * The result is `'covered'` as soon as any answer holds a test, whatever else failed.
 * Otherwise it is `'unknown'` when a query threw or was incomplete, when the budget
 * stopped the walk, or when it was cancelled, and `'uncovered'` (within `depth` levels)
 * when none of those happened. `incompleteReason` is the first cause, or null.
 *
 * Every query asks for tests: a test found at any searched level counts. At the default
 * depth of 2 this is the same set of queries as before; only a user who raises
 * `impactTree.reachDepth` pays for test-program work on the deeper levels.
 *
 * @param {{
 *   incoming: (file: string, pos: number, withTests?: boolean) => Promise<CallerRow[]>,
 *   incomingWithStatus?: (file: string, pos: number, withTests?: boolean) => Promise<import('./caller-contract').CallerAnswer>,
 * }} resolver Used through `incomingWithStatus` when present, so an incomplete answer is
 *   known to be incomplete; otherwise through `incoming`, whose answers are taken as complete.
 * @param {{ file: string, pos: number }} start The symbol whose callers are searched.
 * @param {{ depth: number, budget: number, signal?: AbortSignal }} limits
 * @returns {Promise<{ tests: string[], state: 'covered'|'uncovered'|'unknown', incompleteReason: string|null }>}
 *   `tests` holds the label of the first test found, if any.
 */
async function walkTestReach(resolver, start, { depth, budget, signal }) {
  const idOf = (/** @type {{file: string, pos: number}} */ n) => `${n.file}#${n.pos}`;
  const seen = new Set([idOf(start)]);
  let admitted = 0;
  /** @type {string|null} */
  let reason = null;
  const note = (/** @type {string} */ why) => { if (reason === null) reason = why; };
  const unknown = () => ({ tests: [], state: /** @type {'unknown'} */ ('unknown'), incompleteReason: reason });
  /** @type {Array<[string, number, number]>} */
  const stack = [[start.file, start.pos, 0]];
  while (stack.length) {
    // A cancelled walk claims nothing; mapLimit then rejects, so its answer is never used.
    if (signal && signal.aborted) { note('the analysis was cancelled'); return unknown(); }
    const [file, pos, d] = /** @type {[string, number, number]} */ (stack.pop());
    if (d >= depth) continue;
    /** @type {{ callers: CallerRow[], complete: boolean, reason?: string }} */
    let answer;
    try {
      answer = resolver.incomingWithStatus
        ? await resolver.incomingWithStatus(file, pos, true)
        : { callers: await resolver.incoming(file, pos, true), complete: true };
    } catch (e) {
      note(`a caller query failed: ${(e && /** @type {Error} */ (e).message) || 'unknown error'}`);
      continue;
    }
    if (!answer.complete) note(answer.reason || 'a caller query did not finish');
    // A test already in hand is found whatever the budget has left.
    const test = answer.callers.find((k) => k.test);
    if (test) return { tests: [test.label], state: 'covered', incompleteReason: null };
    for (const k of answer.callers) {
      const id = idOf(k);
      if (seen.has(id)) continue;
      if (admitted >= budget) { note(`the budget of ${budget} visited callers stopped the walk`); return unknown(); }
      seen.add(id);
      admitted++;
      stack.push([k.file, k.pos, d + 1]);
    }
  }
  return reason === null
    ? { tests: [], state: 'uncovered', incompleteReason: null }
    : unknown();
}

module.exports = { walkTestReach, DEFAULT_REACH_BUDGET };
