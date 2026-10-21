'use strict';
// Read-back of a sent round against a real snapshot (docs/UX_PLAN.md F4): code changes
// near each item since the snapshot, untracked files included, and statuses from the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSnapshotStore } = require('../src/engine/snapshot-store');
const { codeChangesFor, statusesOf } = require('../src/feedback-readback');
const { renderRound } = require('../src/feedback-file');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lines = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

function fixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-readback-')));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), lines(40));
  fs.writeFileSync(path.join(repo, 'b.txt'), lines(10));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(repo, 'new.txt'), lines(5, 'new'));   // untracked at send time
  const store = createSnapshotStore({ root: path.join(tmp, 'store'), repo });
  return { tmp, repo, store };
}

test('code changes near each item since the snapshot, including a file untracked at send time', async (t) => {
  const { tmp, repo, store } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const snap = await store.take({ round: 1 });
  const items = [
    { id: 'near', file: 'a.txt', line: 10, symbol: null, summary: '' },
    { id: 'far', file: 'a.txt', line: 35, symbol: null, summary: '' },
    { id: 'untouched', file: 'b.txt', line: 3, symbol: null, summary: '' },
    { id: 'newfile', file: 'new.txt', line: 2, symbol: null, summary: '' },
    { id: 'gone', file: 'missing.txt', line: 1, symbol: null, summary: '' },
  ];
  const round = { round: 1, relPath: '.impact-tree/feedback/2026-10-20-1.md', checkpointSha: snap.sha, sentAtMs: 1, items };
  const a = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').split('\n');
  a[11] = 'edited line 12';                                       // within 3 lines of line 10
  fs.writeFileSync(path.join(repo, 'a.txt'), a.join('\n'));
  fs.writeFileSync(path.join(repo, 'new.txt'), lines(5, 'new').replace('new 2', 'new two'));
  const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));
  const changes = await codeChangesFor({ repo, round, objectDirs: store.objectDirs(), withDiffIndex: store.withDiffIndex });
  assert.deepEqual(Object.fromEntries(changes), {
    near: 'changed', far: 'unchanged', untouched: 'unchanged', newfile: 'changed', gone: 'unchanged',
  });
  assert.ok(indexBefore.equals(fs.readFileSync(path.join(repo, '.git', 'index'))), 'the real index is not touched');
});

test('a snapshot git cannot read gives unknown, never unchanged', async (t) => {
  const { tmp, repo, store } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const round = { round: 1, relPath: '.impact-tree/feedback/x.md', checkpointSha: 'b'.repeat(40), sentAtMs: 1,
    items: [{ id: 'x', file: 'a.txt', line: 1, symbol: null, summary: '' }] };
  const changes = await codeChangesFor({ repo, round, objectDirs: [], withDiffIndex: store.withDiffIndex });
  assert.equal(changes.get('x'), 'unknown');
});

test('a superseded read-back stops diffing; the rest read unknown', async (t) => {
  const { tmp, repo, store } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const snap = await store.take({ round: 1 });
  const round = { round: 1, relPath: '.impact-tree/feedback/x.md', checkpointSha: snap.sha, sentAtMs: 1,
    items: [{ id: 'x', file: 'a.txt', line: 1, symbol: null, summary: '' }] };
  const changes = await codeChangesFor({ repo, round, objectDirs: store.objectDirs(), withDiffIndex: store.withDiffIndex, isCurrent: () => false });
  assert.equal(changes.get('x'), 'unknown');
});

test('statuses come from the round file; a missing file makes every item unreadable', async (t) => {
  const { tmp, repo } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const items = [{ id: 'a1', file: 'a.txt', line: 3, symbol: null, caller: null, quote: 'line 3', body: 'Fix', createdAtMs: 1 }];
  const relPath = '.impact-tree/feedback/2026-10-20-1.md';
  const round = { round: 1, relPath, checkpointSha: 'c'.repeat(40), sentAtMs: 1, items: [{ id: 'a1', file: 'a.txt', line: 3, symbol: null, summary: 'Fix' }] };
  assert.deepEqual(Object.fromEntries(await statusesOf({ repo, round })), { a1: { status: 'unreadable', reason: 'file missing' } });
  fs.mkdirSync(path.join(repo, '.impact-tree', 'feedback'), { recursive: true });
  const text = renderRound({ round: 1, sentAtMs: 0, branch: 'main', modeLabel: 'Since checkpoint', checkpointSha: 'c'.repeat(40), items, timeZone: 'UTC' })
    .replace(/^Status:$/m, 'Status: done');
  fs.writeFileSync(path.join(repo, relPath), text);
  assert.deepEqual(Object.fromEntries(await statusesOf({ repo, round })), { a1: { status: 'done', reason: null } });
});
