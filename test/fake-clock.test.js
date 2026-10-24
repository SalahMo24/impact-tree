'use strict';
// The fake clock (test/fake-clock.js) the time-dependent tests use, and the delay
// validation it shares with the real clock (src/engine/clock.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClock } = require('./fake-clock');
const { realClock, MAX_DELAY_MS } = require('../src/engine/clock');

test('timers run in due-time order, then in the order set, with now at each one\'s time', async () => {
  const clock = createFakeClock({ startMs: 1000 });
  const ran = [];
  clock.setTimeout(() => ran.push(['c', clock.now()]), 30);
  clock.setTimeout(() => ran.push(['a', clock.now()]), 10);
  clock.setTimeout(() => ran.push(['b', clock.now()]), 10);
  clock.setTimeout(() => ran.push(['late', clock.now()]), 31);
  assert.equal(clock.pending(), 4);
  assert.equal(await clock.advance(30), 3);
  assert.deepEqual(ran, [['a', 1010], ['b', 1010], ['c', 1030]]);
  assert.equal(clock.now(), 1030);
  assert.equal(clock.pending(), 1, 'the one due after the advance is still set');
  await clock.advance(0);
  assert.equal(ran.length, 3, 'advancing by 0 runs nothing that is not yet due');
  await clock.advance(1);
  assert.deepEqual(ran.at(-1), ['late', 1031]);
  assert.equal(clock.pending(), 0);
});

test('a zero delay runs on the next advance, even advance(0)', async () => {
  const clock = createFakeClock();
  let ran = false;
  clock.setTimeout(() => { ran = true; }, 0);
  await clock.advance(0);
  assert.equal(ran, true);
});

test('intervals re-arm each period until cleared', async () => {
  const clock = createFakeClock();
  const at = [];
  const handle = clock.setInterval(() => at.push(clock.now()), 100);
  await clock.advance(350);
  assert.deepEqual(at, [100, 200, 300]);
  assert.equal(clock.now(), 350);
  clock.clearInterval(handle);
  await clock.advance(1000);
  assert.deepEqual(at, [100, 200, 300]);
  assert.equal(clock.pending(), 0);
});

test('a cleared timer never runs; clearing an unknown or spent handle is ignored', async () => {
  const clock = createFakeClock();
  let ran = 0;
  const handle = clock.setTimeout(() => { ran++; }, 10);
  const spent = clock.setTimeout(() => { ran++; }, 5);
  await clock.advance(5);
  clock.clearTimeout(handle);
  clock.clearTimeout(spent);
  clock.clearTimeout(undefined);
  clock.clearTimeout(null);
  await clock.advance(100);
  assert.equal(ran, 1);
  assert.equal(handle.unref(), handle, 'handles have unref, as Node timers do');
});

test('a timer set by a timer runs in the same advance when it falls due within it', async () => {
  const clock = createFakeClock();
  const at = [];
  clock.setTimeout(() => { at.push(clock.now()); clock.setTimeout(() => at.push(clock.now()), 20); }, 10);
  await clock.advance(30);
  assert.deepEqual(at, [10, 30]);
  clock.setTimeout(() => { clock.setTimeout(() => at.push(clock.now()), 20); }, 10);
  await clock.advance(25);
  assert.deepEqual(at, [10, 30], 'due at 60, after this advance');
  await clock.advance(5);
  assert.deepEqual(at, [10, 30, 60]);
});

test('a promise chain a timer starts can set the next timer before it is looked for', async () => {
  const clock = createFakeClock();
  const at = [];
  // Several promise hops between one wait and the next, as an awaited provider call makes.
  const answer = async () => { await Promise.resolve(); return Promise.resolve(clock.now()); };
  async function poll() {
    for (let i = 0; i < 3; i++) {
      await clock.sleep(100);
      at.push(await answer().then((x) => x));
    }
  }
  const done = poll();
  await clock.advance(300);
  await done;
  assert.deepEqual(at, [100, 200, 300]);
});

test('sleep resolves only once its time has passed', async () => {
  const clock = createFakeClock();
  let woke = false;
  const slept = clock.sleep(50).then(() => { woke = true; });
  await clock.advance(49);
  assert.equal(woke, false);
  await clock.advance(1);
  await slept;
  assert.equal(woke, true);
});

test('runAll runs everything in order, and a bound stops an interval left running', async () => {
  const clock = createFakeClock();
  const at = [];
  clock.setTimeout(() => at.push(clock.now()), 500);
  clock.setTimeout(() => { at.push(clock.now()); clock.setTimeout(() => at.push(clock.now()), 5); }, 100);
  assert.equal(await clock.runAll(), 3);
  assert.deepEqual(at, [100, 105, 500]);
  clock.setInterval(() => {}, 10);
  await assert.rejects(clock.runAll({ maxTimers: 50 }), /ran more than 50 timers/);
  await assert.rejects(clock.advance(10000, { maxTimers: 5 }), /ran more than 5 timers/);
});

test('delays are validated by both clocks', async () => {
  const clock = createFakeClock();
  for (const c of [clock, realClock]) {
    for (const bad of [-1, NaN, Infinity, '10', MAX_DELAY_MS + 1]) {
      assert.throws(() => c.setTimeout(() => {}, bad), RangeError, String(bad));
      assert.throws(() => c.sleep(bad), RangeError, String(bad));
    }
    assert.throws(() => c.setInterval(() => {}, 0), RangeError, 'an interval needs a period');
  }
  await assert.rejects(clock.advance(-1), RangeError);
});

test('the real clock reads Date.now and its timers can be cleared and unref\'d', async () => {
  const before = Date.now();
  const now = realClock.now();
  assert.ok(now >= before && now <= Date.now());
  let ran = false;
  const handle = realClock.setTimeout(() => { ran = true; }, 0);
  realClock.unref(handle);
  realClock.clearTimeout(handle);
  await realClock.sleep(0);
  await new Promise(setImmediate);
  assert.equal(ran, false);
  const interval = realClock.setInterval(() => {}, 1000);
  realClock.clearInterval(interval);
});
