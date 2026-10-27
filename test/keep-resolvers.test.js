// @ts-check
'use strict';
// analyze({ keepResolvers: true }): the caller resolvers stay alive after the analysis as the
// non-enumerable `result.liveResolvers` and the caller disposes them; on failure or
// cancellation analyze disposes them itself. Off by default: the result is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');

/** A committed change to `count` exported functions. */
function repoWithChangedFunctions(count = 3) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-keep-')));
  const sh = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q', '--initial-branch=main'); sh('config', 'user.name', 'Test'); sh('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'commonjs' }, include: ['src'] }));
  fs.mkdirSync(path.join(dir, 'src'));
  const source = (/** @type {string} */ extra) => Array.from({ length: count }, (_, i) => `export function f${i}(a: number${extra}) {\n  return a;\n}\n`).join('');
  fs.writeFileSync(path.join(dir, 'src/a.ts'), source(''));
  sh('add', '-A'); sh('commit', '-qm', 'base');
  const base = sh('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'src/a.ts'), source(', strict?: boolean'));
  sh('add', '-A'); sh('commit', '-qm', 'change');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(dir, 'node_modules', 'typescript'));
  return { dir, base, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A resolver that counts its disposals; `onCallerState` can abort or throw. */
function countingResolver({ onCallerState = () => {} } = {}) {
  const state = { disposed: 0, queries: 0 };
  const resolver = {
    callerState: async () => { state.queries++; onCallerState(); return { state: 'none', callers: [], complete: true }; },
    incoming: async () => [],
    stats: () => ({}),
    dispose: () => { state.disposed++; },
  };
  return { state, resolver };
}

const options = (/** @type {any} */ repo, /** @type {any} */ resolver, /** @type {any} */ extra = {}) => ({
  mode: 'checkpoint', checkpoint: repo.base, skipForest: true, deferTestReach: true, concurrency: 1, makeResolver: () => resolver, ...extra,
});

test('off by default: no liveResolvers, and the resolver is disposed by analyze', async () => {
  const repo = repoWithChangedFunctions();
  try {
    const { state, resolver } = countingResolver();
    const result = /** @type {any} */ (await analyze(repo.dir, options(repo, resolver)));
    assert.equal(result.liveResolvers, undefined);
    assert.equal(state.disposed, 1);
  } finally { repo.remove(); }
});

test('on: the resolvers outlive analyze, stay out of the JSON, and dispose() releases them once', async () => {
  const repo = repoWithChangedFunctions();
  try {
    const plain = countingResolver();
    const baseline = /** @type {any} */ (await analyze(repo.dir, options(repo, plain.resolver)));
    const { state, resolver } = countingResolver();
    const result = /** @type {any} */ (await analyze(repo.dir, options(repo, resolver, { keepResolvers: true })));
    assert.equal(state.disposed, 0, 'still alive for the caller');
    assert.ok(result.liveResolvers);
    assert.equal(result.liveResolvers.units.length, 1);
    assert.equal(typeof result.liveResolvers.units[0].resolver.dispose, 'function');
    assert.deepEqual(result.liveResolvers.units[0].files.map((/** @type {string} */ f) => path.basename(f)), ['a.ts', 'a.ts', 'a.ts']);
    assert.equal(Object.keys(result).includes('liveResolvers'), false, 'not enumerable');
    assert.equal(JSON.stringify(result), JSON.stringify(baseline), 'the output is the same with and without');
    const again = await resolver.callerState();
    assert.equal(again.state, 'none', 'and it can still be queried');
    result.liveResolvers.dispose();
    result.liveResolvers.dispose();
    assert.equal(state.disposed, 1, 'dispose is idempotent');
    assert.equal(result.liveResolvers.units.length, 0);
  } finally { repo.remove(); }
});

test('on, cancelled mid-run: analyze disposes the resolvers itself and rejects as cancelled', async () => {
  const repo = repoWithChangedFunctions();
  try {
    const controller = new AbortController();
    const { state, resolver } = countingResolver({ onCallerState: () => controller.abort() });
    await assert.rejects(analyze(repo.dir, options(repo, resolver, { keepResolvers: true, signal: controller.signal })),
      (/** @type {any} */ e) => e.name === 'AnalysisCancelledError');
    assert.equal(state.queries, 1, 'stopped after the query that was running');
    assert.equal(state.disposed, 1, 'nothing is left alive');
  } finally { repo.remove(); }
});

test('on, already cancelled: nothing is left alive either', async () => {
  const repo = repoWithChangedFunctions();
  try {
    const controller = new AbortController();
    controller.abort();
    const { state, resolver } = countingResolver();
    await assert.rejects(analyze(repo.dir, options(repo, resolver, { keepResolvers: true, signal: controller.signal })),
      (/** @type {any} */ e) => e.name === 'AnalysisCancelledError');
    assert.equal(state.queries, 0);
    assert.ok(state.disposed <= 1, 'disposed at most once');
  } finally { repo.remove(); }
});

test('on, a failure after the resolvers exist: it propagates and the resolvers are disposed', async () => {
  const repo = repoWithChangedFunctions();
  try {
    const { state, resolver } = countingResolver();
    const onPrepared = () => { throw new Error('the caller failed'); };
    await assert.rejects(analyze(repo.dir, options(repo, resolver, { keepResolvers: true, onPrepared })), /the caller failed/);
    assert.equal(state.disposed, 1);
  } finally { repo.remove(); }
});
