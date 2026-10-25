'use strict';
// Warm-up and first-index progress for Go (G5, docs/MULTI_LANGUAGE_PLAN.md): a review whose
// changed files include Go and no TypeScript warms the editor's Go server at the first
// function gopls lists in the first changed Go file (`goProvider.warmUpTarget`, asked by
// src/readiness.js), and the first-run message names that server. A failed request is
// logged and the analysis goes on; an editor without Go support gets no second notice
// (the analysis reports it once, see server-symbols.test.js). The session runs through
// test/extension-env.js with a fake clock and hand-released gates.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { withEnv, localResult, finding, GO_SOURCE } = require('./extension-env');
const { createFakeClock } = require('./fake-clock');
const { goProvider } = require('../src/languages/go/provider');

const flush = () => new Promise(setImmediate);
const until = async (cond, what) => {
  for (let i = 0; i < 2000 && !cond(); i++) await flush();
  assert.ok(cond(), typeof what === 'function' ? what() : what);
};
const goChange = (env) => (o) => localResult(o, { findings: [finding('Warm', path.join(env.dir, 'a.go'), GO_SOURCE.indexOf('Warm('))] });
const windowProgress = (env) => env.seen.progress.filter((p) => p.options.location === env.vscode.ProgressLocation.Window);

test('a Go-only review warms the Go server at the first function, naming it while the first run waits', async () => {
  const clock = createFakeClock();
  await withEnv(async (env) => {
    env.hooks.warm = false;
    env.hooks.localPrepared = goChange(env);
    const warm = env.holds.warmUp.next();
    const running = env.refresh();
    await warm.reached;
    assert.deepEqual(env.seen.warmUpAt.map((w) => [path.basename(w.file), w.pos]), [['a.go', GO_SOURCE.indexOf('Warm(')]],
      'the function, not the type declared before it');
    assert.deepEqual(env.seen.servicesAsked.map(([what, a, b]) => [what, what === 'available' ? a : path.basename(a), b]),
      [['available', 'go', undefined], ['documentSymbols', 'a.go', 'head']]);
    assert.match(env.view().message, /(^| · )Waiting for the Go language server \(gopls\)… 0 s$/);
    await clock.advance(12000);
    assert.match(env.view().message, /(^| · )Waiting for the Go language server \(gopls\)… 12 s$/);
    assert.equal(windowProgress(env)[0].messages.at(-1), 'Waiting for the Go language server (gopls)… 12 s');
    assert.ok(!windowProgress(env)[0].messages.some((m) => /Indexing the workspace/.test(m)), 'never TypeScript\'s wording');
    warm.release();
    await running;
    assert.ok(!/Waiting for/.test(env.view().message ?? ''), 'the message is cleared');
  }, { changedSource: 'go', clock });
});

test('a failed symbol request is logged and the analysis goes on without warming', async () => {
  await withEnv(async (env) => {
    env.hooks.warm = false;
    env.hooks.localPrepared = goChange(env);
    env.hooks.localResult = goChange(env);
    env.hooks.goSymbols = () => { throw new Error('gopls crashed'); };
    await env.refresh();
    await until(() => env.seen.analyze.length === 1, 'the analysis ran');
    assert.deepEqual(env.seen.warmUps, []);
    assert.ok(env.seen.log.some((m) => m.includes('warm-up: no Go target — gopls crashed')), env.seen.log.join('\n'));
    assert.ok(env.seen.log.some((m) => m.includes('no changed file to warm the language server with — skipping warm-up')));
    assert.deepEqual(env.seen.errors, []);
    assert.deepEqual(env.seen.warnings, []);
    assert.equal((await env.changeRows())[0].label, 'Warm', 'the result is shown');
  }, { changedSource: 'go' });
});

test('an editor without Go support is not warmed and gets no second notice', async () => {
  await withEnv(async (env) => {
    env.hooks.warm = false;
    env.hooks.localPrepared = goChange(env);
    env.hooks.goAvailable = () => ({ ok: false, reason: 'the editor has no support for go installed' });
    await env.refresh();
    await until(() => env.seen.analyze.length === 1, 'the analysis ran');
    assert.deepEqual(env.seen.servicesAsked, [['available', 'go']], 'no symbols are asked for');
    assert.deepEqual(env.seen.warmUps, []);
    assert.equal(env.seen.log.filter((m) => m.includes('warm-up: Go skipped — the editor has no support for go installed')).length, 1);
    assert.deepEqual(env.seen.warnings, [], 'no popup: the analysis says it once, as a warning row');
  }, { changedSource: 'go' });
});

test('a TypeScript review keeps its own warm-up and wording, and asks the Go services nothing', async () => {
  const clock = createFakeClock();
  await withEnv(async (env) => {
    env.hooks.warm = false;
    env.hooks.localPrepared = (o) => localResult(o, { findings: [finding('warm', path.join(env.dir, 'a.ts'), 1)] });
    const warm = env.holds.warmUp.next();
    const running = env.refresh();
    await warm.reached;
    assert.deepEqual(env.seen.warmUpAt.map((w) => path.basename(w.file)), ['a.ts']);
    assert.match(env.view().message, /(^| · )Indexing the workspace, first run only — usually 10–35 s… 0 s$/);
    warm.release();
    await running;
    assert.deepEqual(env.seen.servicesAsked, []);
  }, { changedSource: true, clock });
});

test('a timed-out Go caller search names the Go server while the retry waits', () => withEnv(async (env) => {
  const file = path.join(env.dir, 'a.go');
  const timedOut = { ...finding('Warm', file, GO_SOURCE.indexOf('Warm(')), throwsAdded: [], callerState: 'unknown', callersComplete: false,
    callersIncompleteReason: 'vscode.provideIncomingCalls timed out after 5000 ms', callersRetryable: true, testState: 'not-computed' };
  env.hooks.localResult = (o) => localResult(o, { findings: [timedOut] });
  const wait = env.holds.warmUp.next();
  await env.refresh();
  await wait.reached;
  assert.match(env.view().message, /1 caller search timed out — retrying when the Go language server \(gopls\) has loaded… \d+ s$/);
  wait.release(false);
}, { changedSource: 'go' }));

test('the Go warm-up target, without an editor: first function of the first file only; nothing without services', async () => {
  const asked = [];
  const services = {
    available: async () => ({ ok: true }),
    documentSymbols: async (doc) => { asked.push(path.basename(doc.file)); return []; },
  };
  const log = () => {};
  assert.equal(await goProvider.warmUpTarget({ repo: '/r', files: ['a.go', 'b.go'], services, log }), null, 'a file with no function: none');
  assert.deepEqual(asked, ['a.go'], 'only the first changed Go file is asked');
  assert.equal(await goProvider.warmUpTarget({ repo: '/r', files: ['a.go'], services: null, log }), null);
  assert.equal(goProvider.serverLabel, 'the Go language server (gopls)');
});
