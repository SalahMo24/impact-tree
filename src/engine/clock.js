// @ts-check
'use strict';

// The source of time for every decision that depends on it: deadlines, budgets, retry
// waits, polling and periodic ticks. Modules take a `clock` (default `realClock`) instead
// of reading Date.now or the global timers, so a test can pass a fake clock
// (test/fake-clock.js) and move time forward instead of waiting for it. Measurements that
// are only logged, user-visible timestamps, subprocess timeouts (enforced by the OS) and
// `setTimeout(…, 0)` batching of event-loop work are outside its scope.

/** The longest delay Node's timers honour; a longer one silently becomes 1 ms. */
const MAX_DELAY_MS = 2147483647;

/**
 * An opaque timer handle: pass it back to the clock that made it.
 * @typedef {unknown} TimerHandle
 */

/**
 * @typedef {object} Clock
 * @property {() => number} now Milliseconds since the Unix epoch, as Date.now.
 * @property {(fn: () => void, ms: number) => TimerHandle} setTimeout Runs `fn` once after
 *   `ms` (0..MAX_DELAY_MS).
 * @property {(handle: TimerHandle) => void} clearTimeout A handle that already ran, was
 *   cleared, or is null/undefined is ignored.
 * @property {(fn: () => void, ms: number) => TimerHandle} setInterval Runs `fn` every `ms`
 *   (1..MAX_DELAY_MS) until cleared.
 * @property {(handle: TimerHandle) => void} clearInterval As clearTimeout.
 * @property {(ms: number) => Promise<void>} sleep Resolves after `ms` (0..MAX_DELAY_MS).
 * @property {(handle: TimerHandle) => void} [unref] Lets the process exit while the timer
 *   is pending; a clock without it has no process to hold open.
 */

/**
 * A delay in milliseconds, checked where it enters a clock. Node would turn a negative, NaN or
 * oversized delay into 1 ms without a word; here it is a programming error.
 * @param {unknown} ms
 * @param {number} [minimum] 0 for a one-shot timer, 1 for an interval.
 * @returns {number}
 */
function validateDelayMs(ms, minimum = 0) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < minimum || ms > MAX_DELAY_MS) {
    throw new RangeError(`timer delay must be a number of milliseconds from ${minimum} to ${MAX_DELAY_MS}, got ${String(ms)}`);
  }
  return ms;
}

/** @type {Clock} */
const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, validateDelayMs(ms)),
  clearTimeout: (handle) => clearTimeout(/** @type {NodeJS.Timeout|undefined} */ (handle)),
  setInterval: (fn, ms) => setInterval(fn, validateDelayMs(ms, 1)),
  clearInterval: (handle) => clearInterval(/** @type {NodeJS.Timeout|undefined} */ (handle)),
  sleep: (ms) => {
    validateDelayMs(ms);
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  },
  unref: (handle) => { /** @type {NodeJS.Timeout} */ (handle).unref?.(); },
};

module.exports = { realClock, validateDelayMs, MAX_DELAY_MS };
