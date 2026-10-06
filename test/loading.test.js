'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const ts = require('typescript');
const { analyze } = require('../src/engine/analyze');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { createModuleCallerPool } = require('../src/module-caller-pool');
const { makeGit } = require('../src/engine/git');
const { withEnv, localResult, previewResult, finding, pull, deferred } = require('./extension-env');
const flush = () => new Promise(setImmediate);

function temporaryRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-loading-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'a.js'), 'function target(a) { return a; }\nmodule.exports = { target };\n');
  fs.writeFileSync(path.join(dir, 'b.js'), "const { target } = require('./a');\nfunction caller() { target(1); }\n");
  git('add', '.'); git('commit', '-qm', 'base');
  return { dir, git, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const pendingFinding = (label, file, pos) => ({ ...finding(label, file, pos),
  throwsAdded: [],
  callerState: 'unknown', callersComplete: false, callersIncompleteReason: 'caller analysis is still running',
  testState: 'not-computed' });

test('local rows and diff commands are usable during warm-up; ticks survive final caller publication', () => withEnv(async env => {
  const changed = pendingFinding('warm', path.join(env.dir, 'a.ts'), 16);
  env.hooks.localPrepared = o => ({ ...localResult(o, { findings: [changed] }), callersPending: true });
  env.hooks.localResult = o => ({ ...localResult(o, { findings: [{ ...changed, callerState: 'none', callersComplete: true }] }), callersPending: false });
  const warm = env.holds.warmUp.next();
  const run = env.refresh();
  await warm.reached;
  assert.match(env.view().message, /against main/);
  assert.ok((await env.tree().getChildren()).some(row => row.label === 'Resolving callers…'));
  const [row] = await env.changeRows();
  env.tick(row, true);
  await env.run('impactTree.openChange', row);
  assert.ok(env.seen.executed.some(([name]) => name === 'vscode.diff'));
  warm.release(true);
  await run;
  const [final] = await env.changeRows();
  assert.equal(env.tree().getTreeItem(final).checkboxState, env.vscode.TreeItemCheckboxState.Checked);
  assert.ok(!(await env.tree().getChildren()).some(row => row.label === 'Resolving callers…'));
  assert.deepEqual(env.seen.errors, []);
}, { changedSource: true }));

test('a replacement hides the older prepared result and discards its late completion', () => withEnv(async env => {
  env.hooks.localPrepared = o => ({ ...localResult(o, { findings: [pendingFinding('old', path.join(env.dir, 'a.ts'), 5)] }), callersPending: true });
  const old = env.holds.analyze.next();
  const first = env.refresh(); await old.reached;
  assert.equal((await env.changeRows())[0].label, 'old');
  env.hooks.localPrepared = null;
  env.hooks.localResult = o => localResult(o, { findings: [finding('new', path.join(env.dir, 'a.ts'), 9)] });
  const next = env.holds.analyze.next();
  const second = env.refresh(); await next.reached;
  assert.deepEqual((await env.tree().getChildren()).map(row => row.label), ['Analysing…']);
  next.release(); await second;
  old.release(); await first;
  assert.equal((await env.changeRows())[0].label, 'new');
  assert.deepEqual(env.seen.errors, []);
}));

test('PR preview rows and pinned diff texts are published before metadata analysis finishes', () => withEnv(async env => {
  const result = pr => ({ ...previewResult(pr), allChanged: [pendingFinding('preview', path.join(env.dir, 'a.ts'), 9)],
    texts: new Map([['a.ts', { head: 'new revision', base: 'old revision' }]]) });
  env.hooks.remotePrepared = pr => ({ ...result(pr), callersPending: true });
  env.hooks.remoteResult = result;
  const held = env.holds.remote.next();
  const run = env.preview(pull(7)); await held.reached;
  const [row] = await env.changeRows();
  await env.run('impactTree.openChange', row);
  const diff = env.seen.executed.find(([name]) => name === 'vscode.diff');
  assert.match(diff[2].query, /head-of-7/);
  env.tick(row, true);
  held.release(); await run;
  assert.equal(env.tree().getTreeItem((await env.changeRows())[0]).checkboxState, env.vscode.TreeItemCheckboxState.Checked);
  assert.deepEqual(env.seen.errors, []);
}));

test('local engine prepares all symbols before querying callers and keeps the pending snapshot immutable', async () => {
  const repo = temporaryRepo();
  try {
    fs.writeFileSync(path.join(repo.dir, 'tsconfig.json'), '{"include":["*.js"],"compilerOptions":{"allowJs":true}}');
    fs.writeFileSync(path.join(repo.dir, 'a.js'), 'function target(a, b) { return a + b; }\nmodule.exports = { target };\n');
    const held = deferred(), reached = deferred();
    let prepared, queries = 0;
    const run = analyze(repo.dir, { mode: 'working', deferTestReach: true, skipForest: true,
      makeResolver: () => ({ callerState: async () => { queries++; reached.resolve(); await held.promise; return { state: 'none', callers: [], complete: true }; } }),
      makeModuleCallers: () => ({ appliesTo: () => null, hint() {}, notes: () => [] }),
      onPrepared: result => { prepared = result; assert.equal(queries, 0); },
    });
    await reached.promise;
    assert.equal(prepared.callersPending, true);
    assert.equal(prepared.allChanged.length, 1);
    assert.equal(prepared.allChanged[0].callerState, 'unknown');
    held.resolve();
    const final = await run;
    assert.equal(final.callersPending, false);
    assert.equal(final.allChanged[0].callerState, 'none');
    assert.equal(prepared.allChanged[0].callerState, 'unknown');
  } finally { repo.remove(); }
});

test('remote engine prepares changes before configuration requests, and cancellation starts no metadata work', async () => {
  const controller = new AbortController();
  const calls = [];
  let pending;
  const gh = {
    listPullRequestFiles: async () => ({ files: [{ path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }] }),
    fileAtRef: async (_, file, ref) => { calls.push(file); return ref === 'head' ? 'export function a(x: number) {}' : 'export function a() {}'; },
  };
  await assert.rejects(analyzeRemote({ ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: '/remote', signal: controller.signal,
    onPrepared: result => { pending = result; controller.abort(); },
  }), e => e.code === 'ANALYSIS_CANCELLED');
  assert.equal(pending.callersPending, true);
  assert.equal(pending.allChanged.length, 1);
  assert.deepEqual(calls, ['src/a.ts', 'src/a.ts']);
});

test('worker resolves real cross-file callers, yields the host, reuses unchanged index and invalidates edits/adds/deletes/HEAD', async () => {
  const repo = temporaryRepo();
  const pool = createModuleCallerPool(repo.dir);
  const file = path.join(repo.dir, 'a.js');
  const pos = fs.readFileSync(file, 'utf8').indexOf('target');
  const query = async () => {
    const adapter = pool.forAnalysis(ts, makeGit(repo.dir), new AbortController().signal);
    adapter.hint({ file, namePos: pos, simpleName: 'target' });
    let completed = false;
    const answerPromise = adapter.incomingWithStatus(file, pos);
    answerPromise.then(() => { completed = true; });
    await flush();
    // For the cold worker, the host advances before TypeScript/index loading finishes.
    if (!adapter.stats().builds) assert.equal(completed, false);
    const answer = await answerPromise;
    adapter.complete();
    assert.equal(answer.complete, true, answer.reason);
    return { answer, builds: adapter.stats().builds };
  };
  try {
    const first = await query();
    assert.ok(first.answer.callers.some(c => c.label === 'caller'));
    assert.equal(first.builds, 1);
    assert.equal((await query()).builds, 1);
    fs.writeFileSync(path.join(repo.dir, 'b.js'), "const { target } = require('./a');\nfunction edited() { target(2); }\n");
    const edit = await query(); assert.equal(edit.builds, 2);
    assert.ok(edit.answer.callers.some(c => c.label === 'edited'));
    fs.writeFileSync(path.join(repo.dir, 'c.js'), "const { target } = require('./a');\nfunction added() { target(3); }\n");
    const add = await query(); assert.equal(add.builds, 3);
    assert.ok(add.answer.callers.some(c => c.label === 'added'));
    fs.unlinkSync(path.join(repo.dir, 'c.js'));
    const deletion = await query(); assert.equal(deletion.builds, 4);
    assert.ok(!deletion.answer.callers.some(c => c.label === 'added'));
    repo.git('add', '.'); repo.git('commit', '-qm', 'edit');
    assert.equal((await query()).builds, 5);
    fs.writeFileSync(path.join(repo.dir, 'package.json'), '{"name":"changed-package"}');
    assert.equal((await query()).builds, 6);
  } finally { pool.dispose(); repo.remove(); }
});

class HeldWorker extends EventEmitter {
  constructor() { super(); this.messages = []; this.terminated = 0; }
  postMessage(message) { this.messages.push(message); }
  ref() {} unref() {}
  async terminate() { this.terminated++; }
}

test('worker deadlines terminate stalled indexing and report incomplete coverage without starting more work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new HeldWorker();
  const pool = createModuleCallerPool('/repo', { timeoutMs: 20, makeWorker: () => worker });
  const adapter = pool.forAnalysis(ts, {}, new AbortController().signal);
  const run = adapter.incomingWithStatus('/repo/a.js', 0);
  t.mock.timers.tick(20);
  const answer = await run;
  assert.equal(answer.complete, false);
  assert.match(answer.reason, /exceeded 20 ms/);
  assert.equal(worker.terminated, 1);
  assert.equal((await adapter.incomingWithStatus('/repo/a.js', 0)).complete, false);
  assert.equal(worker.messages.length, 1);
  pool.dispose();
});

test('cancelling a worker request terminates it; late responses cannot publish into its replacement', async () => {
  const workers = [];
  const pool = createModuleCallerPool('/repo', { makeWorker: () => { const w = new HeldWorker(); workers.push(w); return w; } });
  const controller = new AbortController();
  const first = pool.forAnalysis(ts, {}, controller.signal);
  const older = first.incomingWithStatus('/repo/a.js', 0);
  controller.abort();
  await assert.rejects(older, e => e.code === 'ANALYSIS_CANCELLED');
  assert.equal(workers[0].terminated, 1);
  const next = pool.forAnalysis(ts, {}, new AbortController().signal);
  const run = next.incomingWithStatus('/repo/a.js', 0);
  workers[0].emit('message', { id: workers[0].messages[0].id, value: { builds: 99 } });
  workers[1].emit('message', { id: workers[1].messages[0].id, value: { builds: 1 } });
  await flush();
  workers[1].emit('message', { id: workers[1].messages[1].id, value: { answer: { callers: [], complete: true }, notes: [] } });
  assert.equal((await run).complete, true);
  assert.equal(next.stats().builds, 1);
  next.complete(); pool.dispose();
});

async function withResolver(executeCommand, fn) {
  const editor = require('./vscode-stub');
  const original = Module._load;
  const id = require.resolve('../src/resolver-vscode');
  const previous = require.cache[id];
  Module._load = function(name, ...args) { return name === 'vscode' ? { ...editor,
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    commands: { executeCommand } } : original.call(this, name, ...args); };
  try {
    delete require.cache[id];
    const { createVscodeResolver } = require(id);
    await fn(createVscodeResolver);
  } finally { Module._load = original; delete require.cache[id]; if (previous) require.cache[id] = previous; }
}

test('provider query deadlines retain unknown coverage and observe late rejection; the next query can succeed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = temporaryRepo();
  const held = deferred();
  let hanging = true;
  try {
    await withResolver(async name => name === 'vscode.prepareCallHierarchy' ? [{}]
      : hanging ? held.promise : [], async create => {
      const resolver = create({ repoRoot: repo.dir, queryTimeoutMs: 20, filterInherited: false });
      const run = resolver.callerState(path.join(repo.dir, 'a.js'), 9);
      await flush();
      t.mock.timers.tick(20);
      const answer = await run;
      assert.equal(answer.state, 'unknown'); assert.equal(answer.complete, false);
      assert.match(answer.reason, /timed out/);
      held.reject(new Error('late provider failure'));
      hanging = false;
      assert.equal((await resolver.callerState(path.join(repo.dir, 'a.js'), 9)).state, 'none');
      assert.equal(resolver.stats().cacheHits, 0, 'timeout was never cached');
    });
  } finally { repo.remove(); }
});

test('warm-up total deadline bounds an in-flight command and drops its late answer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const repo = temporaryRepo(), held = deferred();
  try {
    await withResolver(() => held.promise, async create => {
      const resolver = create({ repoRoot: repo.dir, filterInherited: false });
      const run = resolver.warmUp(path.join(repo.dir, 'a.js'), 9, { timeoutMs: 20 });
      await flush(); t.mock.timers.tick(20);
      assert.equal(await run, false);
      held.resolve([{}]); await flush();
      assert.equal(resolver.isWarm(), false);
    });
  } finally { repo.remove(); }
});

test('timed-out provider commands keep their admission slots until the provider actually settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = temporaryRepo(), held = deferred();
  let calls = 0, hanging = true;
  try {
    await withResolver(async name => {
      calls++;
      if (hanging) return held.promise;
      return name === 'vscode.prepareCallHierarchy' ? [{}] : [];
    }, async create => {
      const resolver = create({ repoRoot: repo.dir, queryTimeoutMs: 20, filterInherited: false });
      const file = path.join(repo.dir, 'a.js');
      const running = Array.from({ length: 32 }, () => resolver.incomingWithStatus(file, 9));
      await flush();
      assert.equal(calls, 32);
      const blocked = await resolver.incomingWithStatus(file, 9);
      assert.equal(blocked.complete, false);
      assert.match(blocked.reason, /32 outstanding requests/);
      t.mock.timers.tick(20);
      assert.ok((await Promise.all(running)).every(answer => !answer.complete));
      resolver.clear();
      assert.match((await resolver.incomingWithStatus(file, 9)).reason, /32 outstanding requests/);
      assert.equal(calls, 32, 'clear/timeouts do not create more uncancellable provider requests');
      held.resolve([{}]); await flush(); hanging = false;
      assert.equal((await resolver.incomingWithStatus(file, 9)).complete, true);
    });
  } finally { repo.remove(); }
});

test('cancellation during parallel remote metadata loading stops scheduling further ancestors', async () => {
  const controller = new AbortController(), held = deferred(), reached = deferred();
  const metadata = [];
  const gh = {
    listPullRequestFiles: async () => ({ files: [{ path: 'a/b/c/d/e/f/g/h/i/j/k/source.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export function changed() {}' }] }),
    fileAtRef: async (_, file) => {
      if (file.endsWith('source.ts')) return 'export function changed() {}';
      metadata.push(file); reached.resolve();
      await held.promise;
      return null;
    },
  };
  const run = analyzeRemote({ ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: '/remote', signal: controller.signal });
  // Attach rejection ownership immediately, before triggering cancellation.
  const cancelled = assert.rejects(run, e => e.code === 'ANALYSIS_CANCELLED');
  await reached.promise; await flush();
  const started = metadata.length;
  assert.ok(started > 1, 'config and package lookups overlap');
  controller.abort(); held.resolve();
  await cancelled; await flush();
  assert.equal(metadata.length, started, 'no further directory is requested after cancellation');
});
