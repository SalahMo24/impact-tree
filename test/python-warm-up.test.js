'use strict';
// Warm-up and first-index progress for Python (P5, docs/MULTI_LANGUAGE_PLAN.md; the shared
// code is Go's, G5): a review whose changed files include Python and no TypeScript warms
// the editor's Pyright at the first function or method it lists in the first changed Python
// file (`pythonProvider.warmUpTarget`, asked by src/readiness.js), searching into classes
// because Pyright lists methods as their class's children. The first-run message names that
// server. The session runs through test/extension-env.js (its one symbols hook is called
// `serverSymbols`, for every language) with a fake clock and hand-released gates.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { withEnv, localResult, finding, PY_SOURCE, PY_SYMBOLS } = require('./extension-env');
const { createFakeClock } = require('./fake-clock');
const { pythonProvider } = require('../src/languages/python/provider');

const flush = () => new Promise(setImmediate);
const until = async (cond, what) => {
  for (let i = 0; i < 2000 && !cond(); i++) await flush();
  assert.ok(cond(), typeof what === 'function' ? what() : what);
};
const WARM_AT = PY_SOURCE.indexOf('warm(');
const pyChange = (env) => (o) => localResult(o, { findings: [finding('warm', path.join(env.dir, 'a.py'), WARM_AT)] });
const windowProgress = (env) => env.seen.progress.filter((p) => p.options.location === env.vscode.ProgressLocation.Window);
const withPython = (body, extra = {}) => withEnv((env) => {
  env.hooks.warm = false;
  env.hooks.localPrepared = pyChange(env);
  env.hooks.serverSymbols = () => PY_SYMBOLS;
  return body(env);
}, { changedSource: 'python', ...extra });

test('a Python-only review warms Pyright at the first method, inside its class, naming the server while the first run waits', async () => {
  const clock = createFakeClock();
  await withPython(async (env) => {
    const warm = env.holds.warmUp.next();
    const running = env.refresh();
    await warm.reached;
    assert.deepEqual(env.seen.warmUpAt.map((w) => [path.basename(w.file), w.pos]), [['a.py', WARM_AT]], 'the method, not the class');
    assert.deepEqual(env.seen.servicesAsked.map(([what, a, b]) => [what, what === 'available' ? a : path.basename(a), b]),
      [['available', 'python', undefined], ['documentSymbols', 'a.py', 'head']]);
    assert.match(env.view().message, /(^| · )Waiting for the Python language server \(Pyright\)… 0 s$/);
    await clock.advance(12000);
    assert.match(env.view().message, /(^| · )Waiting for the Python language server \(Pyright\)… 12 s$/);
    assert.equal(windowProgress(env)[0].messages.at(-1), 'Waiting for the Python language server (Pyright)… 12 s');
    assert.ok(!windowProgress(env)[0].messages.some((m) => /Indexing the workspace/.test(m)), 'never TypeScript\'s wording');
    warm.release();
    await running;
    assert.ok(!/Waiting for/.test(env.view().message ?? ''), 'the message is cleared');
  }, { clock });
});

test('a failed symbol request is logged and the analysis goes on without warming', async () => {
  await withPython(async (env) => {
    env.hooks.localResult = pyChange(env);
    env.hooks.serverSymbols = () => { throw new Error('Pyright crashed'); };
    await env.refresh();
    await until(() => env.seen.analyze.length === 1, 'the analysis ran');
    assert.deepEqual(env.seen.warmUps, []);
    assert.ok(env.seen.log.some((m) => m.includes('warm-up: no Python target — Pyright crashed')), env.seen.log.join('\n'));
    assert.deepEqual(env.seen.errors, []);
    assert.deepEqual(env.seen.warnings, []);
    assert.equal((await env.changeRows())[0].label, 'warm', 'the result is shown');
  });
});

test('an editor without Python support is not warmed and gets no second notice', async () => {
  await withPython(async (env) => {
    env.hooks.serverAvailable = () => ({ ok: false, reason: 'the editor has no support for python installed' });
    await env.refresh();
    await until(() => env.seen.analyze.length === 1, 'the analysis ran');
    assert.deepEqual(env.seen.servicesAsked, [['available', 'python']], 'no symbols are asked for');
    assert.deepEqual(env.seen.warmUps, []);
    assert.equal(env.seen.log.filter((m) => m.includes('warm-up: Python skipped — the editor has no support for python installed')).length, 1);
    assert.deepEqual(env.seen.warnings, [], 'no popup: the analysis says it once, as a warning row');
  });
});

test('a timed-out Python caller search names Pyright while the retry waits', () => withEnv(async (env) => {
  const file = path.join(env.dir, 'a.py');
  const timedOut = { ...finding('warm', file, WARM_AT), throwsAdded: [], callerState: 'unknown', callersComplete: false,
    callersIncompleteReason: 'vscode.provideIncomingCalls timed out after 5000 ms', callersRetryable: true, testState: 'not-computed' };
  env.hooks.localResult = (o) => localResult(o, { findings: [timedOut] });
  const wait = env.holds.warmUp.next();
  await env.refresh();
  await wait.reached;
  assert.match(env.view().message, /1 caller search timed out — retrying when the Python language server \(Pyright\) has loaded… \d+ s$/);
  wait.release(false);
}, { changedSource: 'python' }));

test('the Python warm-up target, without an editor: first function or method of the first file only', async () => {
  const sym = (name, kind, start, children = []) => ({ name, detail: '', kind, range: { start, end: start + 10 }, selectionRange: { start: start + 4, end: start + 4 + name.length }, children });
  const answers = {
    'class_only.py': [sym('K', 5, 0, [sym('x', 13, 6), sym('m', 6, 20)])],
    'plain.py': [sym('V', 13, 0), sym('f', 12, 30, [sym('inner', 12, 40)])],
    'nested_class.py': [sym('A', 5, 0, [sym('B', 5, 5, [sym('deep', 6, 9)])])],
    'none.py': [sym('K', 5, 0, [sym('x', 13, 6)]), sym('V', 13, 40)],
    'empty.py': null,
  };
  const asked = [];
  const services = {
    available: async () => ({ ok: true }),
    documentSymbols: async (doc) => { asked.push(path.basename(doc.file)); return answers[path.basename(doc.file)]; },
  };
  const log = () => {};
  const target = (files) => pythonProvider.warmUpTarget({ repo: '/r', files, services, log });
  assert.deepEqual(await target(['class_only.py']), { file: path.join('/r', 'class_only.py'), pos: 24 }, 'a method of a class-only file');
  assert.deepEqual(await target(['plain.py']), { file: path.join('/r', 'plain.py'), pos: 34 }, 'the function, not its nested def');
  assert.deepEqual(await target(['nested_class.py']), { file: path.join('/r', 'nested_class.py'), pos: 13 }, 'through nested classes');
  assert.equal(await target(['none.py']), null, 'classes and variables only: none');
  assert.equal(await target(['empty.py']), null, 'no answer: none');
  asked.length = 0;
  await target(['none.py', 'plain.py']);
  assert.deepEqual(asked, ['none.py'], 'only the first changed Python file is asked');
  assert.equal(await pythonProvider.warmUpTarget({ repo: '/r', files: ['a.py'], services: null, log }), null, 'no services: none');
  const logged = [];
  const unavailable = { available: async () => ({ ok: false, reason: 'no python extension' }), documentSymbols: async () => assert.fail('not asked') };
  assert.equal(await pythonProvider.warmUpTarget({ repo: '/r', files: ['a.py'], services: unavailable, log: (m) => logged.push(m) }), null);
  assert.deepEqual(logged, ['warm-up: Python skipped — no python extension']);
  const failing = { available: async () => ({ ok: true }), documentSymbols: async () => { throw new Error('boom'); } };
  await assert.rejects(pythonProvider.warmUpTarget({ repo: '/r', files: ['a.py'], services: failing, log }), /boom/, 'a rejection propagates to readiness');
  assert.equal(pythonProvider.serverLabel, 'the Python language server (Pyright)');
});
