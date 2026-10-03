// @ts-check
'use strict';
// One worker-pool helper and one validator for impactTree.concurrency, shared by the
// local and the pull-request pipelines so a bad setting cannot behave differently in each.

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;

/** @param {unknown} v @returns {string} */
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * Turn a supplied setting into a worker count mapLimit accepts. Omitted (undefined or
 * null) means the default. Anything unusable falls back to the default and pushes a
 * warning onto `warnings`; a value above the maximum is clamped, also with a warning.
 * @param {unknown} value The raw setting.
 * @param {string[]} warnings Receives one message per correction.
 * @returns {number} An integer from 1 to MAX_CONCURRENCY.
 */
function validateConcurrency(value, warnings) {
  if (value === undefined || value === null) return DEFAULT_CONCURRENCY;
  const whole = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!(whole >= 1)) {
    warnings.push(`impactTree.concurrency is ${show(value)}, which is not a number from 1 to ${MAX_CONCURRENCY}; using ${DEFAULT_CONCURRENCY}`);
    return DEFAULT_CONCURRENCY;
  }
  if (whole > MAX_CONCURRENCY) {
    warnings.push(`impactTree.concurrency is ${show(value)}, above the maximum; using ${MAX_CONCURRENCY}`);
    return MAX_CONCURRENCY;
  }
  return whole;
}

/**
 * Run fn over items with at most `limit` in flight; results keep input order. `limit`
 * must already be validated: zero workers would resolve having done nothing.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit A positive integer; anything else throws a RangeError.
 * @param {(item: T, index: number) => Promise<R>|R} fn
 * @returns {Promise<R[]>} Results in input order.
 */
async function mapLimit(items, limit, fn) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`mapLimit needs a positive integer limit, got ${show(limit)}`);
  }
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { mapLimit, validateConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY };
