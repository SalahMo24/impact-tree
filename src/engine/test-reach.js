// @ts-check
'use strict';
// Test reachability: does ANY test sit in the upward closure of a changed symbol.

/**
 * Walk the callers of a symbol upward until a test is found.
 *
 * The root sits at depth 0 and is not counted by the budget. A node at `depth` is not
 * expanded. The resolver is injected so the walk can be driven by any caller graph.
 *
 * @param {{ incoming: (file: string, pos: number, withTests?: boolean) => Promise<Array<{file: string, pos: number, label: string, test: boolean}>> }} resolver
 * @param {{ file: string, pos: number }} start The symbol whose callers are searched.
 * @param {{ depth: number, budget: number, signal?: AbortSignal }} limits
 * @returns {Promise<{ tests: string[], state: 'covered'|'uncovered'|'unknown', incompleteReason: string|null }>}
 */
async function walkTestReach(resolver, start, { depth, budget, signal }) {
  /** @type {string[]} */
  const tests = [];
  const seen = new Set();
  /** @type {Array<[string, number, number]>} */
  const stack = [[start.file, start.pos, 0]];
  outer: while (stack.length) {
    // A cancelled walk stops here; mapLimit then rejects, so its partial answer is never used.
    if (signal && signal.aborted) break;
    const [f, p, d] = /** @type {[string, number, number]} */ (stack.pop());
    if (d >= depth || seen.size > budget) continue;
    /** @type {Awaited<ReturnType<typeof resolver.incoming>>} */
    let ups;
    try { ups = await resolver.incoming(f, p, d <= 1); } catch { ups = []; }
    for (const k of ups) {
      const id = `${k.file}#${k.pos}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (k.test) { tests.push(k.label); break outer; }
      stack.push([k.file, k.pos, d + 1]);
    }
  }
  return { tests, state: tests.length ? 'covered' : 'uncovered', incompleteReason: null };
}

module.exports = { walkTestReach };
