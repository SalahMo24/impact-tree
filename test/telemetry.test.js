'use strict';
// Telemetry (src/telemetry/telemetry.js): what may leave the machine, how events are batched
// to PostHog, and that nothing is sent outside a production install or without a key.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeClock } = require('./fake-clock');
const { createTelemetry, cleanProps, framesOf, createPostHogSender } = require('../src/telemetry/telemetry');
const { analysisFinishedProps } = require('../src/telemetry/telemetry-events');

const ROOT = '/ext/impact-tree';

/** A vscode stand-in whose telemetry logger calls the sender as the editor does when telemetry is on. */
function fakeVscode({ enabled = true } = {}) {
  const loggers = [];
  return {
    loggers,
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    env: {
      machineId: 'm-1',
      createTelemetryLogger(sender) {
        const logger = {
          logUsage: (name, data) => { if (enabled) sender.sendEventData(`SalahMo24.impact-tree/${name}`, { 'common.os': 'darwin', ...data }); },
          logError: (error, data) => { if (enabled) sender.sendErrorData(error, { 'common.os': 'darwin', ...data }); },
          dispose: () => { if (sender.flush) return sender.flush(); },
        };
        loggers.push(logger);
        return logger;
      },
    },
  };
}

function fakeFetch({ ok = true } = {}) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); if (ok === 'throw') throw new Error('offline'); return { ok, status: ok ? 200 : 500 }; };
  return Object.assign(fn, { calls });
}

test('cleanProps keeps numbers, booleans and short words, and drops paths, long text and odd keys', () => {
  assert.deepEqual(cleanProps({
    files: 3, ok: true, mode: 'pr', agent: 'claude-vscode', bad: NaN,
    path: 'src/a.ts', abs: '/Users/x/repo', long: 'x'.repeat(41), spaced: 'two words', 'bad key': 1, obj: { a: 1 },
  }), { files: 3, ok: true, mode: 'pr', agent: 'claude-vscode' });
});

test('framesOf keeps the extension\'s own frames, oldest first, and hides every other path', () => {
  const stack = [
    'TypeError: cannot read x of /Users/me/secret-repo/a.ts',
    `    at analyse (${ROOT}/src/engine/analyze.js:10:5)`,
    `    at ${ROOT}/node_modules/zod/index.js:1:2`,
    '    at Object.run (/Users/me/secret-repo/tools/x.js:3:4)',
    '    at node:internal/process:1:1',
  ].join('\n');
  const frames = framesOf(stack, ROOT);
  assert.deepEqual(frames.map((f) => f.filename), ['<external>', '<external>', 'node_modules/zod/index.js', 'src/engine/analyze.js']);
  assert.deepEqual(frames.at(-1), { filename: 'src/engine/analyze.js', function: 'analyse', lineno: 10, colno: 5, in_app: true, platform: 'node:javascript' });
  assert.equal(frames[2].in_app, false, 'a dependency is not our code');
  assert.ok(!JSON.stringify(frames).includes('secret-repo'));
});

test('events are batched to PostHog with the machine id and no person profile', async () => {
  const fetchImpl = fakeFetch();
  const clock = createFakeClock({ startMs: 0 });
  const vscode = fakeVscode();
  const t = createTelemetry(vscode, { context: { extensionMode: 1, extensionPath: ROOT }, log: () => {}, fetchImpl, clock, config: { key: 'phc_test', host: 'https://ph.example/' } });
  t.event('activated');
  t.event('analysis.finished', { files: 2, path: 'src/a.ts' });
  assert.equal(fetchImpl.calls.length, 0, 'nothing is sent before the minute is up');
  await clock.advance(60_000);
  assert.equal(fetchImpl.calls.length, 1);
  const { url, body } = fetchImpl.calls[0];
  assert.equal(url, 'https://ph.example/batch/');
  assert.equal(body.api_key, 'phc_test');
  assert.deepEqual(body.batch.map((e) => e.event), ['activated', 'analysis.finished']);
  assert.deepEqual(body.batch[1].properties, { distinct_id: 'm-1', $process_person_profile: false, 'common.os': 'darwin', files: 2 });
  t.dispose();
  assert.equal(clock.pending(), 0, 'dispose stops the flush timer');
});

test('an error report carries the type, where it happened and our frames — never the message', async () => {
  const fetchImpl = fakeFetch();
  const clock = createFakeClock({ startMs: 0 });
  const t = createTelemetry(fakeVscode(), { context: { extensionMode: 1, extensionPath: ROOT }, log: () => {}, fetchImpl, clock, config: { key: 'k', host: 'https://ph.example' } });
  const e = new RangeError('PR "secret title" in /Users/me/secret-repo failed');
  e.stack = `RangeError: ${e.message}\n    at run (${ROOT}/src/session/session.js:5:6)`;
  t.error('analysis', e, { source: 'local' });
  await t.dispose();
  const [event] = fetchImpl.calls[0].body.batch;
  assert.equal(event.event, '$exception');
  assert.equal(event.properties.where, 'analysis');
  assert.equal(event.properties.source, 'local');
  assert.deepEqual(event.properties.$exception_list[0].type, 'RangeError');
  assert.equal(event.properties.$exception_list[0].mechanism.handled, true);
  assert.ok(!JSON.stringify(event).includes('secret'), 'no part of the message or the user\'s paths is sent');
});

test('an unhandled error the editor reports is marked unhandled', async () => {
  const fetchImpl = fakeFetch();
  const sender = createPostHogSender({ key: 'k', host: 'https://ph.example', distinctId: 'm', root: ROOT, log: () => {}, fetchImpl, clock: createFakeClock({ startMs: 0 }) });
  sender.sendErrorData(new Error('boom'), {});
  await sender.flush();
  sender.dispose();
  const ex = fetchImpl.calls[0].body.batch[0].properties.$exception_list[0];
  assert.equal(ex.value, 'unhandled');
  assert.equal(ex.mechanism.handled, false);
});

test('a failed send is logged once and dropped', async () => {
  for (const ok of [false, 'throw']) {
    const logged = [];
    const fetchImpl = fakeFetch({ ok });
    const sender = createPostHogSender({ key: 'k', host: 'https://ph.example', distinctId: 'm', root: ROOT, log: (m) => logged.push(m), fetchImpl, clock: createFakeClock({ startMs: 0 }) });
    sender.sendEventData('x/a', {});
    await sender.flush();
    sender.sendEventData('x/b', {});
    await sender.flush();
    sender.dispose();
    assert.equal(fetchImpl.calls.length, 2, 'the next batch is still tried');
    assert.equal(logged.length, 1);
  }
});

test('telemetry turned off in the editor sends nothing', async () => {
  const fetchImpl = fakeFetch();
  const t = createTelemetry(fakeVscode({ enabled: false }), { context: { extensionMode: 1, extensionPath: ROOT }, log: () => {}, fetchImpl, clock: createFakeClock({ startMs: 0 }), config: { key: 'k', host: 'https://ph.example' } });
  t.event('activated');
  t.error('analysis', new Error('x'));
  await t.dispose();
  assert.equal(fetchImpl.calls.length, 0);
});

test('a development host or a build without a key only logs what it would send', async () => {
  for (const [extensionMode, key] of [[2, 'k'], [3, 'k'], [1, '']]) {
    const logged = [];
    const fetchImpl = fakeFetch();
    const t = createTelemetry(fakeVscode(), { context: { extensionMode, extensionPath: ROOT }, log: (m) => logged.push(m), fetchImpl, clock: createFakeClock({ startMs: 0 }), config: { key, host: 'https://ph.example' } });
    t.event('activated', { files: 1 });
    t.error('cards', new TypeError('secret'));
    await t.dispose();
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(logged, ['telemetry (not sent): activated {"common.os":"darwin","files":1}', 'telemetry (not sent): error TypeError at cards']);
  }
});

test('an editor without the telemetry logger gets a telemetry that does nothing', () => {
  const t = createTelemetry({ env: {} }, { context: {}, log: () => assert.fail('nothing is logged') });
  t.event('activated');
  t.error('x', new Error('y'));
  t.dispose();
});

test('analysisFinishedProps counts changed symbols per language and names no file', () => {
  const props = analysisFinishedProps({
    mode: 'pr', changedFileCount: 3, warnings: ['w'],
    allChanged: [{ relPath: 'a/b.ts' }, { relPath: 'c.tsx' }, { relPath: 'd.go' }, { relPath: 'Makefile' }],
    findings: [{ staleCallers: 2 }, { staleCallers: 1 }],
  }, { source: 'local', durationMs: 1234.6 });
  assert.deepEqual(props, {
    source: 'local', mode: 'pr', files: 3, symbols: 4, findings: 2, staleCallers: 3, warnings: 1, durationMs: 1235,
    'lang.ts': 2, 'lang.go': 1, 'lang.other': 1,
  });
  assert.deepEqual(cleanProps(props), props, 'every property survives the privacy filter');
});

test('the extension\'s own source files resolve under the extension folder', () => {
  // Guards framesOf's relative-path rule against the real layout.
  const root = path.resolve(__dirname, '..');
  const frames = framesOf(`Error: x\n    at f (${path.join(root, 'src', 'extension.js')}:1:1)`, root);
  assert.equal(frames[0].filename, 'src/extension.js');
});
