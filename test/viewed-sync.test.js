'use strict';
// Viewed sync (L6): the real tree provider and review state, with the review store
// replaced by a fake whose writes settle only when the test says so (controlled promises,
// no timers). Each test names one behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const baseVscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');
const { renderTreeItem } = require('../src/tree-item-renderer');
const { createReviewState } = require('../src/review-state');
const { createViewedSync, recordWant, nextWrite, finishWrite, noteFor } = require('../src/viewed-sync');

// The shared stub's emitter delivers nothing; these tests need real events.
class Emitter {
  constructor() { this.listeners = new Set(); this.event = (l) => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }; }
  fire(e) { for (const l of [...this.listeners]) l(e); }
  dispose() { this.listeners.clear(); }
}
const vscode = { ...baseVscode, EventEmitter: Emitter };

const BODY = { id: 'body', label: 'body' };
const change = (relPath, label, startLine) => ({
  file: `/r/${relPath}`, relPath, label, namePos: startLine * 10, startLine, endLine: startLine + 3, component: '(root)',
  kinds: [BODY], throwsAdded: [], stale: [], staleCallers: 0, callerState: 'none', callers: [], score: 1,
  testState: 'covered', tests: ['spec'],
});
const resultOf = (extra = {}) => ({
  allChanged: [], findings: [], deleted: [], outside: [], otherFiles: [], warnings: [], unanalysable: [], untested: [], testUnknown: [],
  testReachComputed: true, reachDepth: 2, mode: 'branch', requestedMode: 'branch', base: { ref: 'origin/main', sha: '0123456789' },
  changedFileCount: 1, fileStatus: {}, ...extra,
});
const TARGET = Object.freeze({ owner: 'o', name: 'r', number: 7, headOid: 'a'.repeat(40) });

// The store as the adapter sees it: state, change events, and setViewed whose promise the
// test settles. `github` is what the pretend GitHub holds; a finished write updates it and
// announces the reload the real store performs before it resolves.
function fakeStore({ target = TARGET, github = {} } = {}) {
  const emitter = new Emitter();
  let viewed = new Map(Object.entries(github));
  let state = target ? { kind: 'ready', target, model: { viewed } } : { kind: 'none' };
  const calls = [];
  const store = {
    getState: () => state,
    onDidChange: (l) => emitter.event(l),
    setViewed: (request) => new Promise((resolve) => { calls.push({ ...request, resolve }); }),
  };
  return {
    store, calls, emitter,
    /** GitHub's state changed (a load): announce it. */
    load(next, paths = null) {
      viewed = new Map(Object.entries(next));
      state = { kind: 'ready', target: state.target || TARGET, model: { viewed } };
      emitter.fire({ paths });
    },
    /** A write succeeded on GitHub: reload shows it, then the store's promise resolves. */
    succeed(call) {
      viewed = new Map(viewed);
      viewed.set(call.path, call.viewed ? 'VIEWED' : 'UNVIEWED');
      state = { kind: 'ready', target: state.target, model: { viewed } };
      emitter.fire({ paths: [call.path] });
      call.resolve({ ok: true });
    },
    fail(call, message = 'boom') { call.resolve({ ok: false, error: new Error(message) }); },
    retarget(target) { state = target ? { kind: 'loading', target, previous: null } : { kind: 'none' }; emitter.fire({ paths: null }); },
    githubOf: (path) => viewed.get(path),
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// A provider over `result` with a real review state, a viewed-sync adapter and a log of what
// the tree was told to repaint (undefined = the whole tree).
function setup(result, { github = {}, target = TARGET, maxQueuedWrites } = {}) {
  const backing = new Map();
  const review = createReviewState({ get: (k) => backing.get(k), update: (k, v) => backing.set(k, v) });
  review.configure('pr', null);
  let sync = null;
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review,
    viewedOf: (relPath, all) => (sync ? sync.statusOf(relPath, all) : null),
  });
  const fake = fakeStore({ github, target });
  const repaints = [];
  provider.onDidChangeTreeData((row) => repaints.push(row ? row.relPath : undefined));
  let presentations = 0;
  provider.onDidChangePresentation(() => presentations++);
  const make = () => { sync = createViewedSync({ provider, store: fake.store, maxQueuedWrites }); return sync; };
  const views = {
    provider, fake, repaints, review, make, sync: () => sync,
    get presentations() { return presentations; },
    files: async () => (await provider.getChildren()).filter((r) => r.type === 'reviewFile' || r.type === 'file'),
    file: async (relPath) => (await views.files()).find((f) => f.relPath === relPath),
    rows: async (relPath) => provider.changeRowsOf(relPath),
    item: (row) => provider.getTreeItem(row),
    description: async (relPath) => views.item(await views.file(relPath)).description,
  };
  return views;
}

const twoFiles = () => resultOf({
  allChanged: [change('src/a.ts', 'one', 1), change('src/a.ts', 'two', 10), change('src/b.ts', 'solo', 1)],
  fileStatus: { 'src/a.ts': 'modified', 'src/b.ts': 'modified' },
});

test('ticking the last unticked row marks the file viewed; earlier ticks write nothing', async () => {
  const v = setup(twoFiles());
  v.make();
  await v.files();
  const [one, two] = await v.rows('src/a.ts');
  v.provider.setChecked(one, true);
  assert.equal(v.fake.calls.length, 0);
  v.provider.setChecked(two, true);
  assert.deepEqual(v.fake.calls.map(({ path, viewed }) => ({ path, viewed })), [{ path: 'src/a.ts', viewed: true }]);
});

test('unticking one row of a viewed, fully ticked file unmarks it', async () => {
  const v = setup(twoFiles(), { github: { 'src/a.ts': 'VIEWED' } });
  v.make();
  await v.files();
  const rows = await v.rows('src/a.ts');
  v.provider.setCheckedBatch(rows.map((row) => ({ row, on: true })));
  assert.equal(v.fake.calls.length, 0, 'ticking what GitHub already shows viewed writes nothing');
  v.provider.setChecked(rows[0], false);
  assert.deepEqual(v.fake.calls.map(({ path, viewed }) => ({ path, viewed })), [{ path: 'src/a.ts', viewed: false }]);
});

test('the file checkbox ticks all rows and marks, then unmarks', async () => {
  const v = setup(twoFiles());
  v.make();
  const file = await v.file('src/a.ts');
  v.provider.setChecked(file, true);
  assert.equal(v.fake.calls.length, 1);
  assert.equal(v.fake.calls[0].viewed, true);
  v.fake.succeed(v.fake.calls[0]);
  await flush();
  v.provider.setChecked(file, false);
  assert.equal(v.fake.calls.length, 2);
  assert.equal(v.fake.calls[1].viewed, false);
});

test('a file without a call graph is one counting row: ticking it marks it viewed', async () => {
  const v = setup(resultOf({ otherFiles: [{ path: 'notes.md', status: 'added' }], fileStatus: { 'notes.md': 'added' } }));
  v.make();
  const notes = await v.file('notes.md');
  assert.equal(notes.type, 'file');
  v.provider.setChecked(notes, true);
  assert.deepEqual(v.fake.calls.map(({ path, viewed }) => ({ path, viewed })), [{ path: 'notes.md', viewed: true }]);
});

test('a local or agent review (no pull request in the store) never writes and never ticks', async () => {
  const v = setup(twoFiles(), { target: null });
  v.make();
  const file = await v.file('src/a.ts');
  v.provider.setChecked(file, true);
  assert.equal(v.fake.calls.length, 0);
  v.fake.load({ 'src/a.ts': 'VIEWED' });   // data without a target is not a pull request's
  assert.equal(v.provider.isReviewed((await v.rows('src/b.ts'))[0]), false);
  assert.equal(await v.description('src/a.ts'), '2/2  ·  src');
});

test('GitHub VIEWED ticks the file rows through the provider, repaints that file once, and writes nothing back', async () => {
  const v = setup(twoFiles());
  v.make();
  await v.files();
  v.repaints.length = 0;
  v.fake.load({ 'src/a.ts': 'VIEWED' });
  await flush();
  assert.ok((await v.rows('src/a.ts')).every((r) => v.provider.isReviewed(r)));
  assert.equal(v.provider.isReviewed((await v.rows('src/b.ts'))[0]), false, 'other files are untouched');
  assert.equal(v.fake.calls.length, 0, 'no write echo');
  assert.deepEqual(v.repaints, ['src/a.ts'], 'one file repaint, no full refresh');
  assert.equal(v.presentations, 0);
  v.fake.load({ 'src/a.ts': 'VIEWED' });   // the same data again changes nothing
  assert.deepEqual(v.repaints, ['src/a.ts']);
});

test('a load after the analysis result was shown ticks VIEWED files (rows built later)', async () => {
  const v = setup(twoFiles(), { github: { 'src/b.ts': 'VIEWED' } });
  v.make();                                     // data already there when the adapter starts
  assert.equal(v.provider.isReviewed((await v.rows('src/b.ts'))[0]), true);
});

test('UNVIEWED never unticks local progress, and a fully ticked file is not written after a load', async () => {
  const v = setup(twoFiles(), { github: { 'src/a.ts': 'VIEWED' } });
  v.make();
  await v.files();
  assert.ok((await v.rows('src/a.ts')).every((r) => v.provider.isReviewed(r)));
  v.fake.load({ 'src/a.ts': 'UNVIEWED' });
  await flush();
  assert.ok((await v.rows('src/a.ts')).every((r) => v.provider.isReviewed(r)), 'local ticks stay');
  assert.equal(v.fake.calls.length, 0, 'a load does not write, whatever the local state');
  // the next local change decides
  v.provider.setChecked((await v.rows('src/a.ts'))[0], false);
  assert.equal(v.fake.calls.length, 0, 'GitHub is already unviewed');
  v.provider.setChecked((await v.rows('src/a.ts'))[0], true);
  assert.deepEqual(v.fake.calls.map((c) => c.viewed), [true]);
});

test('DISMISSED keeps ticked rows, shows 👁 changed until all are ticked, then marks viewed again', async () => {
  const v = setup(twoFiles(), { github: { 'src/a.ts': 'DISMISSED' } });
  v.make();
  const [one, two] = await v.rows('src/a.ts');
  v.provider.setChecked(one, true);                    // a row whose content is unchanged, ticked before
  v.repaints.length = 0;
  assert.equal(await v.description('src/a.ts'), '1/2  ·  👁 changed  ·  src');
  assert.equal(v.fake.calls.length, 0);
  v.provider.setChecked(two, true);
  assert.equal(v.fake.calls.length, 1);
  assert.equal(v.fake.calls[0].viewed, true);
  assert.match(await v.description('src/a.ts'), /2\/2  ·  👁 …/);
  v.fake.succeed(v.fake.calls[0]);
  await flush();
  assert.equal(await v.description('src/a.ts'), '2/2  ·  src');
});

test('a failed write keeps the ticks, shows "viewed not synced" and Retry re-sends the current state', async () => {
  const v = setup(twoFiles());
  const sync = v.make();
  const file = await v.file('src/a.ts');
  v.provider.setChecked(file, true);
  v.repaints.length = 0;
  v.fake.fail(v.fake.calls[0]);
  await flush();
  assert.ok((await v.rows('src/a.ts')).every((r) => v.provider.isReviewed(r)), 'ticks are kept');
  const item = v.item(await v.file('src/a.ts'));
  assert.match(item.description, /viewed not synced/);
  assert.equal(item.contextValue, 'reviewFileViewedFailed');
  assert.deepEqual(v.repaints, ['src/a.ts']);
  // a reload that still shows the old mark does not undo the local ticks
  v.fake.load({ 'src/a.ts': 'UNVIEWED' });
  assert.ok((await v.rows('src/a.ts')).every((r) => v.provider.isReviewed(r)));
  assert.equal(sync.retry('src/a.ts'), true);
  assert.equal(v.fake.calls.length, 2);
  assert.equal(v.fake.calls[1].viewed, true);
  assert.match(await v.description('src/a.ts'), /👁 …/);
  v.fake.succeed(v.fake.calls[1]);
  await flush();
  const after = v.item(await v.file('src/a.ts'));
  assert.equal(after.description, '2/2  ·  src');
  assert.equal(after.contextValue, 'reviewFile');
  assert.equal(sync.retry('src/a.ts'), false, 'nothing failed any more');
});

test('Retry sends what is wanted now, not what failed: unticking after a failure retries the unmark', async () => {
  const v = setup(twoFiles(), { github: { 'src/a.ts': 'VIEWED' } });
  const sync = v.make();
  await v.files();
  v.provider.setChecked((await v.rows('src/a.ts'))[0], false);
  v.fake.fail(v.fake.calls[0]);
  await flush();
  assert.equal(sync.retry('src/a.ts'), true);
  assert.equal(v.fake.calls[1].viewed, false);
});

test('a newer state supersedes while a write runs: tick, untick, tick sends nothing extra when it matches GitHub', async () => {
  const v = setup(twoFiles());
  v.make();
  await v.files();
  const [one, two] = await v.rows('src/a.ts');
  v.provider.setCheckedBatch([{ row: one, on: true }, { row: two, on: true }]);   // want viewed: in flight
  v.provider.setChecked(one, false);                                              // want unviewed (queued behind it)
  v.provider.setChecked(one, true);                                               // want viewed again
  assert.equal(v.fake.calls.length, 1);
  v.fake.succeed(v.fake.calls[0]);
  await flush();
  assert.equal(v.fake.calls.length, 1, 'the final state is what GitHub now has: no follow-up');
});

test('tick, untick while a write runs: exactly one follow-up carrying the final state', async () => {
  const v = setup(twoFiles());
  v.make();
  await v.files();
  const [one, two] = await v.rows('src/a.ts');
  v.provider.setCheckedBatch([{ row: one, on: true }, { row: two, on: true }]);
  v.provider.setChecked(one, false);
  v.provider.setChecked(one, true);
  v.provider.setChecked(one, false);
  assert.equal(v.fake.calls.length, 1, 'one write in flight per file');
  v.fake.succeed(v.fake.calls[0]);
  await flush();
  assert.deepEqual(v.fake.calls.map((c) => c.viewed), [true, false]);
  v.fake.succeed(v.fake.calls[1]);
  await flush();
  assert.equal(v.fake.calls.length, 2);
  assert.equal(await v.description('src/a.ts'), '1/2  ·  src');
});

test('a burst across many files issues one write per file, one at a time', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
  const v = setup(resultOf({
    allChanged: names.map((n) => change(n, 'fn', 1)),
    fileStatus: Object.fromEntries(names.map((n) => [n, 'modified'])),
  }));
  v.make();
  const files = await v.files();
  v.provider.setCheckedBatch(files.map((row) => ({ row, on: true })));
  assert.equal(v.fake.calls.length, 1, 'the next file waits for the one in flight');
  for (let i = 0; i < names.length; i++) {
    assert.equal(v.fake.calls.length, i + 1);
    v.fake.succeed(v.fake.calls[i]);
    await flush();
  }
  assert.deepEqual(v.fake.calls.map((c) => c.path).sort(), [...names].sort());
  assert.ok(v.fake.calls.every((c) => c.viewed === true));
});

test('a queued file whose state returns to what GitHub holds is never written', async () => {
  const v = setup(twoFiles());
  v.make();
  const [fa, fb] = [await v.file('src/a.ts'), await v.file('src/b.ts')];
  v.provider.setCheckedBatch([{ row: fa, on: true }, { row: fb, on: true }]);   // a in flight, b queued
  v.provider.setChecked(fb, false);                                             // b back to GitHub's state
  v.fake.succeed(v.fake.calls[0]);
  await flush();
  assert.deepEqual(v.fake.calls.map((c) => c.path), ['src/a.ts']);
});

test('the write queue is bounded: a file past the budget shows "viewed not synced", and Retry works once there is room', async () => {
  const names = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
  const v = setup(resultOf({ allChanged: names.map((n) => change(n, 'fn', 1)), fileStatus: Object.fromEntries(names.map((n) => [n, 'modified'])) }),
    { maxQueuedWrites: 1 });
  const sync = v.make();
  const [fa, fb, fc] = await Promise.all(names.map((n) => v.file(n)));
  v.provider.setCheckedBatch([fa, fb, fc].map((row) => ({ row, on: true })));   // a in flight, b queued, c over budget
  assert.equal(v.fake.calls.length, 1);
  assert.match(await v.description('src/c.ts'), /viewed not synced/);
  assert.equal((await v.rows('src/c.ts')).every((r) => v.provider.isReviewed(r)), true, 'its ticks are kept');
  assert.equal(sync.retry('src/b.ts'), false, 'b is queued, not failed');
  assert.equal(sync.retry('src/c.ts'), false, 'still no room');
  v.fake.succeed(v.fake.calls[0]);
  await flush();                                   // b is now in flight, the queue is empty
  assert.equal(sync.retry('src/c.ts'), true);
  v.fake.succeed(v.fake.calls[1]);
  await flush();
  assert.deepEqual(v.fake.calls.map((c) => c.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.throws(() => createViewedSync({ provider: v.provider, store: v.fake.store, maxQueuedWrites: 0 }), RangeError);
});

test('results for a pull request no longer under review are ignored', async () => {
  const v = setup(twoFiles());
  v.make();
  const file = await v.file('src/a.ts');
  v.provider.setChecked(file, true);
  const [old] = v.fake.calls;
  v.fake.retarget({ ...TARGET, number: 8 });
  v.repaints.length = 0;
  v.fake.fail(old);
  await flush();
  assert.equal(v.fake.calls.length, 1, 'no follow-up, no retry state for the old review');
  assert.doesNotMatch(await v.description('src/a.ts'), /viewed not synced|👁/);
  assert.deepEqual(v.repaints.filter((r) => r), []);
  // and the new review starts clean
  v.fake.load({});
  v.provider.setChecked(await v.file('src/b.ts'), true);
  assert.equal(v.fake.calls.length, 2);
});

test('a success for the old pull request does not tick or write for the new one', async () => {
  const v = setup(twoFiles());
  v.make();
  v.provider.setChecked(await v.file('src/a.ts'), true);
  const [old] = v.fake.calls;
  v.fake.retarget({ ...TARGET, number: 8 });
  old.resolve({ ok: true });
  await flush();
  assert.equal(v.fake.calls.length, 1);
});

test('tick events of an analysis that is no longer current write nothing', async () => {
  const v = setup(twoFiles());
  let current = true;
  const sync = createViewedSync({ provider: v.provider, store: v.fake.store, isCurrentAnalysis: () => current });
  assert.ok(sync);
  current = false;
  v.provider.setChecked(await v.file('src/a.ts'), true);
  assert.equal(v.fake.calls.length, 0);
});

test('dispose stops listening, drops the queue and ignores a write still in flight', async () => {
  const v = setup(twoFiles());
  const sync = v.make();
  const [fa, fb] = [await v.file('src/a.ts'), await v.file('src/b.ts')];
  v.provider.setCheckedBatch([{ row: fa, on: true }, { row: fb, on: true }]);
  const [inflight] = v.fake.calls;
  sync.dispose();
  v.repaints.length = 0;
  v.fake.succeed(inflight);
  await flush();
  assert.equal(v.fake.calls.length, 1, 'the queued file is never sent');
  assert.deepEqual(v.repaints.filter((r) => r !== undefined), []);
  v.provider.setChecked(fa, false);
  v.fake.load({ 'src/b.ts': 'VIEWED' });
  assert.equal(v.fake.calls.length, 1);
  assert.equal(v.fake.emitter.listeners.size, 0);
  assert.equal(sync.statusOf('src/a.ts', true), null);
  assert.equal(sync.retry('src/a.ts'), false);
  sync.dispose();                                  // twice is fine
});

test('a tick storm repaints only the touched file rows, never the whole tree', async () => {
  const v = setup(twoFiles());
  v.make();
  const [one, two] = await v.rows('src/a.ts');
  await v.files();
  v.repaints.length = 0;
  v.provider.setChecked(one, true);
  v.provider.setChecked(two, true);
  v.fake.succeed(v.fake.calls[0]);
  await flush();
  assert.ok(v.repaints.length > 0);
  assert.ok(v.repaints.every((r) => r === 'src/a.ts'), `repainted ${JSON.stringify(v.repaints)}`);
  assert.equal(v.presentations, 0);
});

test('a hidden file (filter) is not repainted by a viewed change', async () => {
  const v = setup(twoFiles());
  v.make();
  await v.files();
  v.provider.toggleFilter('unreviewed');
  v.provider.setCheckedBatch((await v.rows('src/b.ts')).map((row) => ({ row, on: true })));
  v.repaints.length = 0;
  v.fake.load({ 'src/b.ts': 'DISMISSED' });
  await flush();
  assert.deepEqual(v.repaints, [], 'b is filtered out, so there is nothing to repaint');
});

test('the viewed note sits after progress and before the folder; a file without a call graph shows it too', () => {
  const view = (note) => ({ rowDetail: 'hover', iconMode: 'symbol', checkedOf: () => false, viewedOf: () => note });
  const fileRow = { type: 'reviewFile', label: 'a.ts', relPath: 'src/a.ts', rows: [{ type: 'finding', label: 'x', finding: change('src/a.ts', 'x', 1), file: '/r/src/a.ts', pos: 1 }], level: 4, attention: 0 };
  assert.match(renderTreeItem(vscode, fileRow, view('changed')).description, /^0\/1  ·  👁 changed  ·  src$/);
  assert.match(renderTreeItem(vscode, fileRow, view('syncing')).description, /^0\/1  ·  👁 …  ·  src$/);
  assert.equal(renderTreeItem(vscode, fileRow, view(null)).description, '0/1  ·  src');
  assert.equal(renderTreeItem(vscode, fileRow, { rowDetail: 'hover', iconMode: 'symbol', checkedOf: () => false }).description, '0/1  ·  src');
  const plain = { type: 'file', label: 'notes.md', relPath: 'docs/notes.md', status: 'added', absPath: '/r/docs/notes.md' };
  const failed = renderTreeItem(vscode, plain, view('failed'));
  assert.equal(failed.description, 'no call graph  ·  viewed not synced  ·  docs');
  assert.equal(failed.contextValue, 'fileViewedFailed');
});

// ---- the pure core ----------------------------------------------------------------------
test('core: nextWrite sends only a differing desire, and never while one is in flight', () => {
  assert.equal(nextWrite({ want: null, sent: null, failed: false }, 'VIEWED'), null);
  assert.equal(nextWrite(recordWant(undefined, true), 'VIEWED'), null);
  assert.equal(nextWrite(recordWant(undefined, true), 'UNVIEWED'), true);
  assert.equal(nextWrite(recordWant(undefined, true), 'DISMISSED'), true);
  assert.equal(nextWrite(recordWant(undefined, false), 'DISMISSED'), null, 'DISMISSED is already not viewed');
  assert.equal(nextWrite(recordWant(undefined, false), 'VIEWED'), false);
  assert.equal(nextWrite({ want: false, sent: true, failed: false }, 'UNVIEWED'), null);
});

test('core: finishWrite settles, supersedes or fails', () => {
  const inflight = { want: true, sent: true, failed: false };
  assert.equal(finishWrite(inflight, true, 'VIEWED'), null);
  assert.equal(finishWrite(inflight, true, 'UNVIEWED'), null, 'a stale reload does not chase the write that succeeded');
  assert.deepEqual(finishWrite({ want: false, sent: true, failed: false }, true, 'VIEWED'), { want: false, sent: null, failed: false });
  assert.equal(finishWrite({ want: false, sent: true, failed: false }, true, 'UNVIEWED'), null);
  assert.deepEqual(finishWrite(inflight, false, 'UNVIEWED'), { want: true, sent: null, failed: true });
  assert.equal(finishWrite(inflight, false, 'VIEWED'), null, 'GitHub already agrees');
});

test('core: noteFor ranks failed, then syncing, then changed', () => {
  assert.equal(noteFor({ want: true, sent: null, failed: true }, 'DISMISSED', false), 'failed');
  assert.equal(noteFor({ want: true, sent: true, failed: false }, 'DISMISSED', false), 'syncing');
  assert.equal(noteFor(undefined, 'DISMISSED', false), 'changed');
  assert.equal(noteFor(undefined, 'DISMISSED', true), null);
  assert.equal(noteFor(undefined, 'VIEWED', false), null);
  assert.equal(noteFor(undefined, undefined, false), null);
});
