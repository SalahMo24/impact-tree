// @ts-check
'use strict';
// One worker-pool helper, shared by the local and the pull-request pipelines. Its
// setting, impactTree.concurrency, is validated in settings.js.
const { throwIfCancelled } = require('./cancellation');
const { validateConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } = require('./settings');

/** @param {unknown} v @returns {string} */
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * Run fn over items with at most `limit` in flight; results keep input order. `limit`
 * must already be validated: zero workers would resolve having done nothing.
 *
 * Once `signal` is aborted no further item starts. Items already running are left to
 * finish, because they may still be using resources the caller disposes once this
 * settles; then the pool rejects with the cancellation error, never a partial result.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit A positive integer; anything else throws a RangeError.
 * @param {(item: T, index: number) => Promise<R>|R} fn
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<R[]>} Results in input order.
 * @throws {import('./cancellation').AnalysisCancelledError} When `signal` was aborted.
 */
async function mapLimit(items, limit, fn, { signal } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`mapLimit needs a positive integer limit, got ${show(limit)}`);
  }
  throwIfCancelled(signal);
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!(signal && signal.aborted)) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  throwIfCancelled(signal);
  return out;
}

module.exports = { mapLimit, validateConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY };
