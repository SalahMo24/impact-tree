'use strict';
// A Clock (src/engine/clock.js) whose time moves only when a test moves it, so a test of a
// deadline, budget, retry wait or polling loop runs at once and always the same way.
//
// - `now()` starts at `startMs` and changes only inside advance()/runAll().
// - Timers due at the same time run in the order they were set.
// - advance(ms) runs, in due-time order, every timer due up to now + ms, setting now to
//   each timer's time before running it, and leaves now at now + ms. Before the first timer
//   and after each one it lets the microtask queue drain and one macrotask turn pass, so a
//   promise chain a timer starts can set the next timer before it is looked for. Work that
//   needs more turns than that (real disk or network I/O) must be awaited by the test
//   before advancing.
// - An interval re-arms at its due time + its period; a timer set while advancing runs in
//   the same advance if it falls due within it.
// - Both are bounded (CODING_STYLE §2): more than `maxTimers` timer runs in one call throws,
//   which is what an interval left running under runAll() does.
const { validateDelayMs } = require('../src/engine/clock');

const DEFAULT_MAX_TIMERS = 10000;
const turn = () => new Promise(setImmediate);

/**
 * @param {{ startMs?: number }} [options]
 */
function createFakeClock({ startMs = 0 } = {}) {
  if (!Number.isSafeInteger(startMs)) throw new RangeError('startMs must be a safe integer');
  let nowMs = startMs;
  let order = 0;
  /** @type {Map<number, { at: number, order: number, fn: () => void, periodMs: number|null }>} */
  const timers = new Map();
  let nextId = 1;

  function add(fn, ms, periodMs) {
    if (typeof fn !== 'function') throw new TypeError('timer callback must be a function');
    const id = nextId++;
    timers.set(id, { at: nowMs + ms, order: order++, fn, periodMs });
    // Shaped like Node's Timeout where callers touch it, so `.unref?.()` keeps working.
    return { id, unref() { return this; }, ref() { return this; }, hasRef: () => false };
  }
  function clear(handle) {
    if (handle && typeof handle === 'object' && 'id' in handle) timers.delete(handle.id);
  }
  /** The id of the next timer due at or before `limit`, or null. */
  function nextDue(limit) {
    let best = null;
    for (const [id, timer] of timers) {
      if (timer.at > limit) continue;
      const b = best === null ? null : timers.get(best);
      if (b === null || timer.at < b.at || (timer.at === b.at && timer.order < b.order)) best = id;
    }
    return best;
  }
  /** Runs the timer `id`: moves now to its time, re-arms or removes it, calls it. */
  function fire(id) {
    const timer = timers.get(id);
    nowMs = timer.at;
    if (timer.periodMs === null) timers.delete(id);
    else timers.set(id, { ...timer, at: timer.at + timer.periodMs, order: order++ });
    timer.fn();
  }
  function checkBudget(maxTimers) {
    if (!Number.isSafeInteger(maxTimers) || maxTimers < 1) throw new RangeError('maxTimers must be a positive integer');
  }

  const clock = {
    now: () => nowMs,
    setTimeout: (fn, ms) => add(fn, validateDelayMs(ms), null),
    clearTimeout: clear,
    setInterval: (fn, ms) => add(fn, validateDelayMs(ms, 1), ms),
    clearInterval: clear,
    sleep: (ms) => {
      validateDelayMs(ms);
      return new Promise((resolve) => { add(resolve, ms, null); });
    },
    unref: () => {},

    /**
     * Moves time forward by `ms`, running the timers due on the way (see above).
     * @param {number} ms
     * @param {{ maxTimers?: number }} [options]
     * @returns {Promise<number>} How many timer runs it made.
     */
    async advance(ms, { maxTimers = DEFAULT_MAX_TIMERS } = {}) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new RangeError(`advance needs a finite, non-negative number of ms, got ${String(ms)}`);
      checkBudget(maxTimers);
      const target = nowMs + ms;
      let ran = 0;
      await turn();
      for (let id = nextDue(target); id !== null; id = nextDue(target)) {
        if (ran >= maxTimers) throw new Error(`advance(${ms}) ran more than ${maxTimers} timers`);
        fire(id);
        ran++;
        await turn();
      }
      nowMs = target;
      return ran;
    },

    /**
     * Runs timers, moving time to each, until none is pending.
     * @param {{ maxTimers?: number }} [options]
     * @returns {Promise<number>} How many timer runs it made.
     */
    async runAll({ maxTimers = DEFAULT_MAX_TIMERS } = {}) {
      checkBudget(maxTimers);
      let ran = 0;
      await turn();
      for (let id = nextDue(Infinity); id !== null; id = nextDue(Infinity)) {
        if (ran >= maxTimers) throw new Error(`runAll ran more than ${maxTimers} timers; is an interval still set?`);
        fire(id);
        ran++;
        await turn();
      }
      return ran;
    },

    /** How many timers and intervals are set and not yet run or cleared. */
    pending: () => timers.size,
  };
  return clock;
}

module.exports = { createFakeClock };
