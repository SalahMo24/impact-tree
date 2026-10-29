'use strict';
// A language server that is still loading (after the window opens or a checkout) must not
// turn most caller searches into "callers unknown" for good:
// - the resolver counts as ready only once a caller query answered;
// - until then its queries go one at a time with a long deadline, within a budget;
// - what still timed out is retried once the server answers, keeping the shown result.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vscodeStub = require('./vscode-stub');
const { withEnv, localResult, finding, deferred, pull } = require('./extension-env');

const { createFakeClock } = require('./fake-clock');

const flush = () => new Promise(setImmediate);
const until = async (cond, what) => {
  for (let i = 0; i < 2000 && !cond(); i++) await flush();
  assert.ok(cond(), typeof what === 'function' ? what() : what);
};

// ---- the resolver ------------------------------------------------------------------------

/**
 * Runs `fn` with the editor resolver over a stubbed provider: prepareCallHierarchy always
 * answers an item; provideIncomingCalls answers `incoming()`.
 */
async function withResolver(incoming, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-retry-')));
  const file = path.join(dir, 'a.ts');
  fs.writeFileSync(file, 'export function target() {}\nexport function other() {}\nexport function third() {}\n');
  const calls = { incoming: 0 };
  const stub = { ...vscodeStub, Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    commands: { executeCommand: async (name) => {
      if (name === 'vscode.prepareCallHierarchy') return [{}];
      if (name === 'vscode.provideIncomingCalls') { calls.incoming++; return incoming(); }
      return [];
    } } };
  const id = require.resolve('../src/session/resolver-vscode');
  const original = Module._load;
  Module._load = function (name, ...rest) { return name === 'vscode' ? stub : original.call(this, name, ...rest); };
  try {
    delete require.cache[id];
    const { createVscodeResolver } = require(id);
    await fn({ create: (o) => createVscodeResolver({ repoRoot: dir, filterInherited: false, ...o }), file, calls });
  } finally {
    Module._load = original;
    delete require.cache[id];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('while cold, caller queries go one at a time; once one answers, the rest go together', async () => {
  const answers = [];
  await withResolver(() => { const d = deferred(); answers.push(d); return d.promise; }, async ({ create, file, calls }) => {
    const resolver = create({});
    assert.equal(resolver.isWarm(), false);
    const queries = [7, 35, 63].map((pos) => resolver.incomingWithStatus(file, pos));
    await until(() => calls.incoming === 1, 'the first query reached the server');
    await flush(); await flush();
    assert.equal(calls.incoming, 1, 'the others wait for it');
    answers[0].resolve([]);
    await until(() => calls.incoming === 3, 'both waiting queries were sent');
    answers[1].resolve([]); answers[2].resolve([]);
    assert.ok((await Promise.all(queries)).every((a) => a.complete));
    assert.equal(resolver.isWarm(), true, 'a caller answer makes it ready');
  });
});

test('a cold query gets the long deadline; one that still times out is retryable', async () => {
  const clock = createFakeClock();
  await withResolver(() => new Promise(() => {}), async ({ create, file }) => {
    const resolver = create({ queryTimeoutMs: 20, coldQueryTimeoutMs: 1000, clock });
    let settled = false;
    const answer = resolver.callerState(file, 16).then((a) => { settled = true; return a; });
    await flush(); await clock.advance(20); await flush();
    assert.equal(settled, false, 'the warm deadline does not apply while cold');
    await clock.advance(1000);
    const cs = await answer;
    assert.deepEqual([cs.state, cs.complete, cs.retryable], ['unknown', false, true]);
    assert.match(cs.reason, /timed out/);
  });
});

test('past the cold budget, queries run in parallel again', async () => {
  const clock = createFakeClock();
  await withResolver(() => new Promise(() => {}), async ({ create, file, calls }) => {
    const resolver = create({ queryTimeoutMs: 20, coldQueryTimeoutMs: 30, coldBudgetMs: 30, clock });
    const queries = [7, 35, 63].map((pos) => resolver.incomingWithStatus(file, pos));
    await flush(); await flush();
    assert.equal(calls.incoming, 1);
    await clock.advance(30);
    await until(() => calls.incoming === 3, 'the budget is spent: the waiting two go together');
    await clock.advance(20);
    const answers = await Promise.all(queries);
    assert.ok(answers.every((a) => !a.complete && a.retryable === true));
  });
});

test('a query waiting its cold turn when the analysis is cleared asks nothing', async () => {
  const first = deferred();
  await withResolver(() => first.promise, async ({ create, file, calls }) => {
    const resolver = create({});
    const a = resolver.incomingWithStatus(file, 7);
    const b = resolver.incomingWithStatus(file, 35);
    await until(() => calls.incoming === 1, 'the first query was sent');
    resolver.clear();
    first.resolve([]);
    await Promise.all([a, b]);
    assert.equal(calls.incoming, 1, 'the cleared query was never sent');
  });
});

test('warm-up needs a caller answer, and a checkout makes the server cold again', async () => {
  const clock = createFakeClock();
  let hang = true;
  await withResolver(() => (hang ? new Promise(() => {}) : []), async ({ create, file }) => {
    const resolver = create({ clock });
    const warming = resolver.warmUp(file, 16, { timeoutMs: 50 });
    await flush(); await clock.advance(50);
    assert.equal(await warming, false, 'a hierarchy item alone is not ready');
    assert.equal(resolver.isWarm(), false);
    hang = false;
    assert.equal(await resolver.warmUp(file, 16, { timeoutMs: 50 }), true);
    assert.equal(resolver.isWarm(), true);
    resolver.expectReload();
    assert.equal(resolver.isWarm(), false);
  });
});

// ---- the session -------------------------------------------------------------------------

const timedOut = (label, file) => ({ ...finding(label, file, 16), throwsAdded: [], callerState: 'unknown', callersComplete: false,
  callersIncompleteReason: 'vscode.provideIncomingCalls timed out after 5000 ms', callersRetryable: true, testState: 'not-computed' });
const answered = (label, file) => ({ ...timedOut(label, file), callerState: 'none', callersComplete: true, callersIncompleteReason: null, callersRetryable: false });

test('timed-out searches are retried once the server answers; the result stays reviewable meanwhile', () => withEnv(async (env) => {
  const file = path.join(env.dir, 'a.ts');
  env.hooks.localResult = (o, n) => localResult(o, { findings: [n === 1 ? timedOut('slow', file) : answered('slow', file)] });
  const wait = env.holds.warmUp.next();
  await env.refresh();
  await wait.reached;
  assert.match(env.view().message, /1 caller search timed out — retrying when TypeScript has loaded… \d+ s$/);
  const [row] = await env.changeRows();
  assert.equal(row.label, 'slow');
  env.tick(row, true);
  const retry = env.holds.analyze.next();
  wait.release(true);
  await retry.reached;
  assert.equal((await env.changeRows())[0].label, 'slow', 'the result is still shown while the retry runs');
  assert.ok(!(await env.tree().getChildren()).some((r) => r.label === 'Analysing…'));
  retry.release();
  await until(() => env.seen.log.some((m) => m.includes('caller retry: 0 search(es)')), () => `the retry finished:\n${env.seen.log.slice(-8).join('\n')}`);
  assert.deepEqual(env.seen.analyzeOptions.map((o) => o.early), [true, false], 'the retry publishes no early rows');
  assert.equal(env.seen.analyzeOptions[1].fetch, false, 'and does not fetch');
  const [final] = await env.changeRows();
  assert.equal(final.finding.callerState, 'none');
  assert.equal(env.tree().getTreeItem(final).checkboxState, env.vscode.TreeItemCheckboxState.Checked, 'the tick survives');
  assert.doesNotMatch(env.view().message || '', /retrying/);
  await flush();
  assert.equal(env.seen.analyze.length, 2, 'retried once, not again');
}));

test('a server that never answers gets no retry; the log says to press Refresh', () => withEnv(async (env) => {
  const file = path.join(env.dir, 'a.ts');
  env.hooks.localResult = (o) => localResult(o, { findings: [timedOut('slow', file)] });
  const wait = env.holds.warmUp.next();
  await env.refresh();
  await wait.reached;
  wait.release(false);
  await until(() => env.seen.log.some((m) => /did not answer within .* press Refresh/.test(m)), 'it gave up');
  assert.equal(env.seen.analyze.length, 1);
}));

test('a retry is dropped when another analysis replaced the result meanwhile', () => withEnv(async (env) => {
  const file = path.join(env.dir, 'a.ts');
  env.hooks.localResult = (o, n) => localResult(o, { findings: [n === 1 ? timedOut('slow', file) : answered('slow', file)] });
  const wait = env.holds.warmUp.next();
  await env.refresh();
  await wait.reached;
  await env.refresh();
  wait.release(true);
  await flush(); await flush();
  assert.equal(env.seen.analyze.length, 2, 'only the user\'s own refresh ran');
}));

test('after a checkout the language server is treated as loading again', () => withEnv(async (env) => {
  await env.refresh();
  assert.equal(env.seen.reloads, undefined);
  await env.openPullRequest(pull(7), 'analyse');
  assert.equal(env.seen.reloads, 1);
  assert.deepEqual(env.seen.errors, []);
}));
