'use strict';
// Cancellation reaching the engine: once an analysis's AbortSignal is aborted, the worker
// pool schedules nothing new, both analysers stop issuing queries, and each rejects with
// the cancellation error rather than a failure. Every abort is triggered from inside a
// stubbed query, so the point at which work stops is exact; nothing waits on a timer.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ts = require('typescript');
const { analyze } = require('../src/engine/analyze');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { mapLimit } = require('../src/engine/concurrency');
const { clearVirtualText } = require('../src/engine/textpos');

const isCancellation = (e) => e && e.name === 'AnalysisCancelledError' && e.code === 'ANALYSIS_CANCELLED';
const flush = () => new Promise(setImmediate);
const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve) => { d.resolve = resolve; });
  return d;
};

test('the cancellation error is one exported class that callers can recognise', () => {
  const { AnalysisCancelledError, isAnalysisCancelled, throwIfCancelled } = require('../src/engine/cancellation');
  const e = new AnalysisCancelledError();
  assert.ok(e instanceof Error);
  assert.ok(isCancellation(e));
  assert.equal(isAnalysisCancelled(e), true);
  assert.equal(isAnalysisCancelled(new Error('analysis cancelled')), false, 'a failure with the same words is still a failure');
  assert.equal(isAnalysisCancelled(null), false);
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfCancelled(controller.signal));
  assert.doesNotThrow(() => throwIfCancelled(undefined), 'no signal means the operation cannot be cancelled');
  controller.abort();
  assert.throws(() => throwIfCancelled(controller.signal), isCancellation);
});

// ---- mapLimit ---------------------------------------------------------------------
test('mapLimit with an already-aborted signal runs nothing and rejects as cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(mapLimit([1, 2, 3], 2, async () => { calls++; }, { signal: controller.signal }), isCancellation);
  assert.equal(calls, 0);
});

test('mapLimit stops scheduling items once its signal is aborted', async () => {
  // The abort lands synchronously inside the item that triggers it, so exactly `abortAt`
  // items start whatever the limit: workers that look for more work afterwards find none.
  for (const [items, limit, abortAt] of [[5, 1, 2], [8, 1, 1], [6, 3, 4], [6, 3, 1]]) {
    const controller = new AbortController();
    const started = [];
    await assert.rejects(mapLimit(Array.from({ length: items }, (_, i) => i), limit, async (item) => {
      started.push(item);
      if (started.length === abortAt) controller.abort();
      await flush();
    }, { signal: controller.signal }), isCancellation);
    assert.equal(started.length, abortAt, `${items} items, limit ${limit}, abort at item ${abortAt}`);
  }
});

test('mapLimit settles the items already running before it rejects', async () => {
  const controller = new AbortController();
  const holds = [deferred(), deferred()];
  let calls = 0;
  let settled = false;
  const run = mapLimit([0, 1, 2, 3], 2, async (i) => { calls++; await holds[i].promise; }, { signal: controller.signal });
  run.catch(() => {}).finally(() => { settled = true; });
  controller.abort();
  await flush();
  assert.equal(settled, false, 'two items are still running, so the pool has not settled');
  holds[0].resolve();
  await flush();
  assert.equal(settled, false);
  holds[1].resolve();
  await assert.rejects(run, isCancellation);
  assert.equal(calls, 2, 'items 2 and 3 never started');
});

test('mapLimit without a signal, or with one never aborted, behaves as before', async () => {
  assert.deepEqual(await mapLimit([1, 2, 3], 2, async (x) => x * 2), [2, 4, 6]);
  assert.deepEqual(await mapLimit([1, 2, 3], 1, async (x) => x + 1, { signal: new AbortController().signal }), [2, 3, 4]);
});

// ---- analyze() ----------------------------------------------------------------------
// A committed change to `count` exported functions, so analyze() has `count` symbols to resolve.
function repoWithChangedFunctions(count) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-cancel-')));
  const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q', '--initial-branch=main'); sh('config', 'user.name', 'Test'); sh('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'commonjs' }, include: ['src'] }));
  fs.mkdirSync(path.join(dir, 'src'));
  const source = (extra) => Array.from({ length: count }, (_, i) => `export function f${i}(a: number${extra}) {\n  return a;\n}\n`).join('');
  fs.writeFileSync(path.join(dir, 'src/a.ts'), source(''));
  sh('add', '-A'); sh('commit', '-qm', 'base');
  const base = sh('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'src/a.ts'), source(', strict?: boolean'));
  sh('add', '-A'); sh('commit', '-qm', 'change');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(dir, 'node_modules', 'typescript'));
  return { dir, base, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Counts the queries analyze() sends to the resolver it was given. `incoming` answers with
// a fresh non-test caller each time, so an uncancelled test-reach walk keeps climbing.
function countingResolver({ onCallerState = () => {}, onIncoming = () => {} } = {}) {
  const counts = { callerState: 0, incoming: 0 };
  const resolver = {
    callerState: async () => { counts.callerState++; onCallerState(counts); return { state: 'none', callers: [], complete: true }; },
    incoming: async (file) => {
      counts.incoming++;
      onIncoming(counts);
      return [{ label: `up${counts.incoming}`, file, pos: 100000 + counts.incoming, test: false }];
    },
    stats: () => ({}),
  };
  return { counts, resolver };
}

const localOptions = (repo, resolver, signal, extra = {}) => ({
  mode: 'checkpoint', checkpoint: repo.base, skipForest: true, deferTestReach: true, concurrency: 1,
  makeResolver: () => resolver, signal, ...extra,
});

test('analyze() with an already-aborted signal sends no resolver query and rejects as cancelled', async () => {
  const repo = repoWithChangedFunctions(3);
  try {
    const controller = new AbortController();
    controller.abort();
    const { counts, resolver } = countingResolver();
    await assert.rejects(analyze(repo.dir, localOptions(repo, resolver, controller.signal)), isCancellation);
    assert.deepEqual(counts, { callerState: 0, incoming: 0 });
  } finally { repo.remove(); }
});

test('analyze() stops resolving callers once aborted mid-run', async () => {
  for (const symbols of [2, 4]) {
    const repo = repoWithChangedFunctions(symbols);
    try {
      const controller = new AbortController();
      const { counts, resolver } = countingResolver({ onCallerState: () => controller.abort() });
      await assert.rejects(analyze(repo.dir, localOptions(repo, resolver, controller.signal)), isCancellation);
      assert.equal(counts.callerState, 1, `${symbols} symbols: only the query that was running when the abort landed`);
    } finally { repo.remove(); }
  }
});

test('analyze() stops a test-reach walk once aborted, and walks it fully when not', async () => {
  const repo = repoWithChangedFunctions(3);
  try {
    const free = countingResolver();
    const result = await analyze(repo.dir, localOptions(repo, free.resolver, new AbortController().signal, { deferTestReach: false }));
    assert.equal(result.allChanged.length, 3);
    assert.deepEqual(free.counts, { callerState: 3, incoming: 6 }, 'uncancelled: two levels for each of three symbols');

    const controller = new AbortController();
    const cut = countingResolver({ onIncoming: () => controller.abort() });
    await assert.rejects(analyze(repo.dir, localOptions(repo, cut.resolver, controller.signal, { deferTestReach: false })), isCancellation);
    assert.deepEqual(cut.counts, { callerState: 1, incoming: 1 });
  } finally { repo.remove(); }
});

// ---- analyzeRemote() ------------------------------------------------------------------
const REMOTE_ROOT = '/remote';
const remoteFiles = ['a.ts', 'b.ts', 'c.ts'];
function countingGitHub({ onFileAtRef = () => {} } = {}) {
  const calls = { listPullRequestFiles: 0, fileAtRef: 0 };
  const gh = {
    listPullRequestFiles: async () => {
      calls.listPullRequestFiles++;
      return { total: remoteFiles.length, files: remoteFiles.map((p) => ({ path: p, oldPath: p, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' })) };
    },
    fileAtRef: async (_, p, ref) => {
      calls.fileAtRef++;
      onFileAtRef(calls);
      if (!remoteFiles.includes(p)) return null;
      const name = path.basename(p, '.ts');
      return ref === 'head' ? `export function ${name}(x: string) { return 1; }\n` : `export function ${name}() { return 0; }\n`;
    },
  };
  return { calls, gh };
}
const remoteOptions = (gh, signal, extra = {}) => ({
  ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: REMOTE_ROOT, concurrency: 1, signal, ...extra,
});

test('analyzeRemote() with an already-aborted signal makes no request and rejects as cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, gh } = countingGitHub();
  try {
    await assert.rejects(analyzeRemote(remoteOptions(gh, controller.signal)), isCancellation);
    assert.deepEqual(calls, { listPullRequestFiles: 0, fileAtRef: 0 });
  } finally { clearVirtualText(); }
});

test('analyzeRemote() stops fetching files once aborted mid-fetch', async () => {
  const controller = new AbortController();
  const { calls, gh } = countingGitHub({ onFileAtRef: () => controller.abort() });
  try {
    await assert.rejects(analyzeRemote(remoteOptions(gh, controller.signal)), isCancellation);
    assert.equal(calls.fileAtRef, 2, 'the head and base of the first file, already requested together; no other file');
  } finally { clearVirtualText(); }
});

test('analyzeRemote() stops resolving callers once aborted, and resolves all of them when not', async () => {
  const resolvedCount = (events) => events.filter((e) => e.phase === 'resolve' && e.done > 0).length;
  try {
    const free = [];
    const result = await analyzeRemote(remoteOptions(countingGitHub().gh, new AbortController().signal, { onProgress: (e) => free.push(e) }));
    assert.equal(result.allChanged.length, 3);
    assert.equal(resolvedCount(free), 3, 'uncancelled: one caller query per changed symbol');

    const controller = new AbortController();
    const cut = [];
    const onProgress = (e) => { cut.push(e); if (e.phase === 'resolve' && e.done === 1) controller.abort(); };
    await assert.rejects(analyzeRemote(remoteOptions(countingGitHub().gh, controller.signal, { onProgress })), isCancellation);
    assert.equal(resolvedCount(cut), 1, 'no caller query after the abort');
  } finally { clearVirtualText(); }
});
