'use strict';
// Sending a round (docs/UX_PLAN.md F3): the snapshot is taken first and the file second; a
// file that cannot be written removes the snapshot again, so nothing is half-sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSnapshotStore } = require('../src/engine/snapshot-store');
const { saveRound, reviewedLabel } = require('../src/feedback/feedback-send');
const { parseRound } = require('../src/feedback/feedback-file');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-send-')));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  return { tmp, repo, store: createSnapshotStore({ root: path.join(tmp, 'store'), repo }) };
}
const item = { id: 'i1', file: 'a.ts', line: 1, symbol: 'a', caller: null, quote: 'export const a = 2;', body: 'Name it better', createdAtMs: 1 };

test('a round is a snapshot plus a file whose header names that snapshot', async (t) => {
  const { tmp, repo, store } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const sent = await saveRound({ repo, store, items: [item], branch: 'main', reviewed: 'Uncommitted (agent)' });
  assert.equal(sent.round, 1);
  assert.equal(sent.relPath.startsWith('.impact-tree/feedback/'), true);
  const parsed = parseRound(fs.readFileSync(sent.absPath, 'utf8'));
  assert.equal(parsed.ok && parsed.checkpointSha, sent.checkpointSha);
  const [record] = store.list();
  assert.equal(record.sha, sent.checkpointSha);
  assert.equal(record.round, 1);
  // The second round gets the next number and its own snapshot.
  const again = await saveRound({ repo, store, items: [item], branch: 'main', reviewed: 'Since checkpoint' });
  assert.equal(again.round, 2);
  assert.equal(store.list().length, 2);
});

test('a file that cannot be written removes the snapshot and throws', async (t) => {
  const { tmp, repo, store } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // A plain file where the folder should be makes the write fail.
  fs.writeFileSync(path.join(repo, '.impact-tree'), 'not a folder');
  await assert.rejects(saveRound({ repo, store, items: [item], branch: 'main', reviewed: 'x' }));
  assert.deepEqual(store.list(), []);
});

test('without a store the round is saved with no checkpoint', async (t) => {
  const { tmp, repo } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Dated by the injected `now`: noon UTC is the same calendar day in nearly every zone.
  const sent = await saveRound({ repo, store: null, items: [item], branch: null, reviewed: 'x', now: () => Date.UTC(2026, 9, 20, 12) });
  assert.equal(sent.checkpointSha, null);
  assert.match(sent.relPath, /2026-10-20/);
  const parsed = parseRound(fs.readFileSync(sent.absPath, 'utf8'));
  assert.equal(parsed.ok && parsed.checkpointSha, null);
});

test('a round sent from a checked-out pull request names the pull request', () => {
  assert.equal(reviewedLabel({ kind: 'checkout', pr: { number: 42 }, sha: 'a' }, 'pr'), 'Pull request #42 (checked out)');
  assert.equal(reviewedLabel({ kind: 'local' }, 'pr'), 'Branch vs base');
  assert.equal(reviewedLabel(undefined, 'working'), 'Uncommitted (agent)');
});
