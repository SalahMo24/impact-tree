'use strict';
// The "Feedback round N" group's controller (docs/UX_PLAN.md F4): shown only while the
// checkpoint is a sent round's snapshot and a local review is shown; a superseded refresh
// publishes nothing; the tree shows the group above the drafts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSnapshotStore } = require('../src/engine/snapshot-store');
const { createFeedbackRoundView } = require('../src/feedback/feedback-round-view');
const { saveRound } = require('../src/feedback/feedback-send');
const { withSentRound, ROUNDS_KEY } = require('../src/feedback/feedback-round-model');
const { buildRoundGroup } = require('../src/feedback/feedback-tree');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function fixture(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-roundview-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  const store = createSnapshotStore({ root: path.join(tmp, 'store'), repo });
  const item = { id: 'i1', file: 'a.ts', line: 1, symbol: 'a', caller: null, quote: 'export const a = 1;', body: 'Rename a', createdAtMs: 1 };
  const sent = await saveRound({ repo, store, items: [item], branch: 'main', reviewed: 'Uncommitted (agent)' });
  const values = new Map([[ROUNDS_KEY, withSentRound([], {
    round: sent.round, relPath: sent.relPath, checkpointSha: sent.checkpointSha, sentAtMs: 0,
    items: [{ id: 'i1', file: 'a.ts', line: 1, symbol: 'a', summary: 'Rename a' }],
  })]]);
  const session = { state: { checkpoint: sent.checkpointSha, source: { kind: 'local' } }, repoRoot: () => repo };
  let changes = 0;
  const view = createFeedbackRoundView({
    workspaceState: { get: (k) => values.get(k) }, session, getSnapshotStore: () => store,
    onChange: () => { changes++; }, log: () => {}, formatTime: () => '14:32',
  });
  return { repo, sent, session, view, changes: () => changes };
}

test('after the agent acts, the group says what it wrote and that the code changed', async (t) => {
  const f = await fixture(t);
  await f.view.refresh();
  assert.equal(f.view.current().items[0].description, 'No status written · No code change');
  fs.writeFileSync(path.join(f.repo, 'a.ts'), 'export const renamed = 1;\nexport const b = 2;\n');
  fs.writeFileSync(f.sent.absPath, fs.readFileSync(f.sent.absPath, 'utf8').replace(/^Status:$/m, 'Status: done'));
  await f.view.refresh();
  const group = buildRoundGroup(f.view.current());
  assert.equal(group.label, 'Feedback round 1');
  assert.equal(group.desc, 'sent 14:32');
  assert.deepEqual(group.children.map((c) => [c.label, c.desc, c.attention]), [['a.ts:1 · a', 'Agent: done · Code changed', false]]);
  assert.equal(f.changes(), 2);
});

test('no group while a pull request is shown or the checkpoint is not a round', async (t) => {
  const f = await fixture(t);
  f.session.state = { checkpoint: f.sent.checkpointSha, source: { kind: 'checkout' } };
  await f.view.refresh();
  assert.equal(f.view.current(), null);
  f.session.state = { checkpoint: 'f'.repeat(40), source: { kind: 'local' } };
  await f.view.refresh();
  assert.equal(f.view.current(), null);
});

test('a superseded refresh publishes nothing; disposal stops publishing', async (t) => {
  const f = await fixture(t);
  const first = f.view.refresh();
  f.session.state = { checkpoint: null, source: { kind: 'local' } };
  const second = f.view.refresh();
  await Promise.all([first, second]);
  assert.equal(f.view.current(), null, 'the older refresh did not overwrite the newer answer');
  assert.equal(f.changes(), 0);
  f.view.dispose();
  f.session.state = { checkpoint: f.sent.checkpointSha, source: { kind: 'local' } };
  await f.view.refresh();
  assert.equal(f.view.current(), null);
});
