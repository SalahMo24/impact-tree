'use strict';
// Warm-up and first-index progress for Java (J5, docs/MULTI_LANGUAGE_PLAN.md; the shared code
// is Go's, G5): a review whose changed files include Java and no TypeScript warms the
// editor's jdtls at the first method or constructor it lists in the first changed Java file
// (`javaProvider.warmUpTarget`, asked by src/session/readiness.js), searching into types because jdtls
// lists methods as their type's children and a field may come first. The first-run message
// names that server. The shared wording has no per-language note, so it does not say that a
// first Maven or Gradle import can take over a minute. The session runs through
// test/extension-env.js (its one symbols hook is called `serverSymbols`, for every language)
// with a fake clock and hand-released gates.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { withEnv, localResult, finding, JAVA_SOURCE, JAVA_SYMBOLS } = require('./extension-env');
const { createFakeClock } = require('./fake-clock');
const { javaProvider } = require('../src/languages/java/provider');

const flush = () => new Promise(setImmediate);
const until = async (cond, what) => {
  for (let i = 0; i < 2000 && !cond(); i++) await flush();
  assert.ok(cond(), typeof what === 'function' ? what() : what);
};
const WARM_AT = JAVA_SOURCE.indexOf('warm(');
const javaChange = (env) => (o) => localResult(o, { findings: [finding('warm', path.join(env.dir, 'T.java'), WARM_AT)] });
const windowProgress = (env) => env.seen.progress.filter((p) => p.options.location === env.vscode.ProgressLocation.Window);
const withJava = (body, extra = {}) => withEnv((env) => {
  env.hooks.warm = false;
  env.hooks.localPrepared = javaChange(env);
  env.hooks.serverSymbols = () => JAVA_SYMBOLS;
  return body(env);
}, { changedSource: 'java', ...extra });

test('a Java-only review warms jdtls at the first method, inside its class, naming the server while the first run waits', async () => {
  const clock = createFakeClock();
  await withJava(async (env) => {
    const warm = env.holds.warmUp.next();
    const running = env.refresh();
    await warm.reached;
    assert.deepEqual(env.seen.warmUpAt.map((w) => [path.basename(w.file), w.pos]), [['T.java', WARM_AT]], 'the method, not the class');
    assert.deepEqual(env.seen.servicesAsked.map(([what, a, b]) => [what, what === 'available' ? a : path.basename(a), b]),
      [['available', 'java', undefined], ['documentSymbols', 'T.java', 'head']]);
    assert.match(env.view().message, /(^| · )Waiting for the Java language server \(jdtls\)… 0 s$/);
    await clock.advance(12000);
    assert.match(env.view().message, /(^| · )Waiting for the Java language server \(jdtls\)… 12 s$/);
    assert.equal(windowProgress(env)[0].messages.at(-1), 'Waiting for the Java language server (jdtls)… 12 s');
    assert.ok(!windowProgress(env)[0].messages.some((m) => /Indexing the workspace/.test(m)), 'never TypeScript\'s wording');
    warm.release();
    await running;
    assert.ok(!/Waiting for/.test(env.view().message ?? ''), 'the message is cleared');
  }, { clock });
});

test('a failed symbol request is logged and the analysis goes on without warming', async () => {
  await withJava(async (env) => {
    env.hooks.localResult = javaChange(env);
    env.hooks.serverSymbols = () => { throw new Error('jdtls crashed'); };
    await env.refresh();
    await until(() => env.seen.analyze.length === 1, 'the analysis ran');
    assert.deepEqual(env.seen.warmUps, []);
    assert.ok(env.seen.log.some((m) => m.includes('warm-up: no Java target — jdtls crashed')), env.seen.log.join('\n'));
    assert.deepEqual(env.seen.errors, []);
    assert.deepEqual(env.seen.warnings, []);
    assert.equal((await env.changeRows())[0].label, 'warm', 'the result is shown');
  });
});

test('an editor without Java support is not warmed and gets no second notice', async () => {
  await withJava(async (env) => {
    env.hooks.serverAvailable = () => ({ ok: false, reason: 'the editor has no support for java installed' });
    await env.refresh();
    await until(() => env.seen.analyze.length === 1, 'the analysis ran');
    assert.deepEqual(env.seen.servicesAsked, [['available', 'java']], 'no symbols are asked for');
    assert.deepEqual(env.seen.warmUps, []);
    assert.equal(env.seen.log.filter((m) => m.includes('warm-up: Java skipped — the editor has no support for java installed')).length, 1);
    assert.deepEqual(env.seen.warnings, [], 'no popup: the analysis says it once, as a warning row');
  });
});

test('a timed-out Java caller search names jdtls while the retry waits', () => withEnv(async (env) => {
  const file = path.join(env.dir, 'T.java');
  const timedOut = { ...finding('warm', file, WARM_AT), throwsAdded: [], callerState: 'unknown', callersComplete: false,
    callersIncompleteReason: 'vscode.provideIncomingCalls timed out after 5000 ms', callersRetryable: true, testState: 'not-computed' };
  env.hooks.localResult = (o) => localResult(o, { findings: [timedOut] });
  const wait = env.holds.warmUp.next();
  await env.refresh();
  await wait.reached;
  assert.match(env.view().message, /1 caller search timed out — retrying when the Java language server \(jdtls\) has loaded… \d+ s$/);
  wait.release(false);
}, { changedSource: 'java' }));

test('the Java warm-up target, without an editor: first method or constructor of the first file only', async () => {
  const sym = (name, kind, start, children = []) => ({ name, detail: '', kind, range: { start, end: start + 10 }, selectionRange: { start: start + 4, end: start + 4 + name.length }, children });
  const answers = {
    'Fields.java': [sym('K', 5, 0, [sym('x', 8, 6), sym('m()', 6, 20)])],
    'Ctor.java': [sym('K', 5, 0, [sym('K()', 9, 10), sym('m()', 6, 30)])],
    'Nested.java': [sym('A', 5, 0, [sym('B', 11, 5, [sym('deep()', 6, 9)])])],
    'Enum.java': [sym('E', 10, 0, [sym('A', 22, 5), sym('go()', 6, 30)])],
    'Local.java': [sym('K', 5, 0, [sym('m()', 6, 20, [sym('Inner', 5, 30, [sym('hidden()', 6, 40)])])])],
    'None.java': [sym('K', 5, 0, [sym('x', 8, 6)]), sym('V', 14, 40)],
    'Empty.java': null,
  };
  const asked = [];
  const services = {
    available: async () => ({ ok: true }),
    documentSymbols: async (doc) => { asked.push(path.basename(doc.file)); return answers[path.basename(doc.file)]; },
  };
  const log = () => {};
  const target = (files) => javaProvider.warmUpTarget({ repo: '/r', files, services, log });
  assert.deepEqual(await target(['Fields.java']), { file: path.join('/r', 'Fields.java'), pos: 24 }, 'the method, not the field before it');
  assert.deepEqual(await target(['Ctor.java']), { file: path.join('/r', 'Ctor.java'), pos: 14 }, 'a constructor counts');
  assert.deepEqual(await target(['Nested.java']), { file: path.join('/r', 'Nested.java'), pos: 13 }, 'through a nested interface');
  assert.deepEqual(await target(['Enum.java']), { file: path.join('/r', 'Enum.java'), pos: 34 }, 'past the enum constants');
  assert.deepEqual(await target(['Local.java']), { file: path.join('/r', 'Local.java'), pos: 24 }, 'the method, not a class local to it');
  assert.equal(await target(['None.java']), null, 'fields only: none');
  assert.equal(await target(['Empty.java']), null, 'no answer: none');
  asked.length = 0;
  await target(['None.java', 'Fields.java']);
  assert.deepEqual(asked, ['None.java'], 'only the first changed Java file is asked');
  assert.equal(await javaProvider.warmUpTarget({ repo: '/r', files: ['A.java'], services: null, log }), null, 'no services: none');
  const logged = [];
  const unavailable = { available: async () => ({ ok: false, reason: 'no java extension' }), documentSymbols: async () => assert.fail('not asked') };
  assert.equal(await javaProvider.warmUpTarget({ repo: '/r', files: ['A.java'], services: unavailable, log: (m) => logged.push(m) }), null);
  assert.deepEqual(logged, ['warm-up: Java skipped — no java extension']);
  const failing = { available: async () => ({ ok: true }), documentSymbols: async () => { throw new Error('boom'); } };
  await assert.rejects(javaProvider.warmUpTarget({ repo: '/r', files: ['A.java'], services: failing, log }), /boom/, 'a rejection propagates to readiness');
  assert.equal(javaProvider.serverLabel, 'the Java language server (jdtls)');
});
