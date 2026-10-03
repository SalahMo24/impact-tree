// @ts-check
'use strict';
// Test reachability: does ANY test sit in the upward closure of a changed symbol.
//
// "A test is reachable" is a positive finding. The absence of one is only a finding when
// the walk looked everywhere it was asked to; a query that failed or did not finish, or
// a budget or depth that cut the walk short, leaves it `'unknown'`, never `'uncovered'`.

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
 * - `depth`, in call levels, with the start symbol at 0. A node at `depth` is not
 *   expanded. Whether it has callers is unknown without a query, so reaching one with no
 *   test found is treated like exhausting the budget: the walk was cut short.
 *
 * The result is `'covered'` as soon as any answer holds a test, whatever else failed.
 * Otherwise it is `'unknown'` when a query threw or was incomplete, when a limit stopped
 * the walk, or when it was cancelled, and `'uncovered'` only when none of those happened.
 * `incompleteReason` is the first cause, or null.
 *
 * Tests are asked for only on the first two levels (`withTests` is false below that) so
 * a large test program is not scanned for every deep node. A deeper test is not seen.
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
    if (d >= depth) { note(`the depth limit of ${depth} stopped the walk`); continue; }
    /** @type {{ callers: CallerRow[], complete: boolean, reason?: string }} */
    let answer;
    try {
      answer = resolver.incomingWithStatus
        ? await resolver.incomingWithStatus(file, pos, d <= 1)
        : { callers: await resolver.incoming(file, pos, d <= 1), complete: true };
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
