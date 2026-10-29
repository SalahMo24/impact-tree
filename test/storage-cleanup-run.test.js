'use strict';
// Carrying out the retention policy (docs/UX_PLAN.md F5): the automatic run never touches
// the current checkpoint; the command lists what it would delete, deletes only what was
// ticked after a confirmation, and can also drop the current checkpoint when asked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoCleanup, createCleanupCommand } = require('../src/storage/storage-cleanup-run');

const DAY = 86400000;
const NOW = 100 * DAY;
const rec = (id, ageDays, extra = {}) => ({ id, sha: id.padEnd(40, '0'), objectsDir: `/s/${id}`, createdAtMs: NOW - ageDays * DAY, branch: null, headSha: null, round: null, bytes: 1024, ...extra });

function harness({ snapshots, checkpoint = null, keys = {}, meta = undefined }) {
  const removed = [];
  const store = { list: () => snapshots.filter((s) => !removed.includes(s.id)), remove: async (id) => { removed.push(id); return true; } };
  const values = new Map(Object.entries(keys));
  if (meta) values.set('impactTree.reviewedMeta', meta);
  const workspaceState = {
    get: (k) => values.get(k),
    update: async (k, v) => { if (v === undefined) values.delete(k); else values.set(k, v); },
    keys: () => [...values.keys()],
  };
  const session = { state: { checkpoint }, repoRoot: () => { throw new Error('no folder'); }, setCheckpoint: (sha) => { session.state.checkpoint = sha; }, refresh: async () => {} };
  const deps = { getSnapshotStore: () => store, workspaceState, session, review: { activeKey: () => 'impactTree.reviewed.active' }, log: () => {}, now: () => NOW };
  return { deps, removed, values, session };
}

test('the automatic run applies the policy and keeps the current checkpoint', async () => {
  const h = harness({
    snapshots: [rec('cur', 400), rec('old', 2), rec('fresh', 0)],
    checkpoint: 'cur'.padEnd(40, '0'),
    keys: { 'impactTree.reviewed.stale': ['x'], 'impactTree.reviewed.active': ['y'] },
    meta: { version: 1, keys: { stale: { lastUsedMs: NOW - 91 * DAY, branch: null }, active: { lastUsedMs: NOW - 400 * DAY, branch: null } } },
  });
  await createAutoCleanup(h.deps)();
  assert.deepEqual(h.removed, ['old']);   // 'fresh' is within the hour's grace; 'cur' is current
  assert.equal(h.values.has('impactTree.reviewed.stale'), false);
  assert.equal(h.values.has('impactTree.reviewed.active'), true);
  assert.equal(h.session.state.checkpoint, 'cur'.padEnd(40, '0'));
});

function vscodeStub({ pick, confirm }) {
  const shown = [];
  return {
    shown,
    window: {
      showInformationMessage: async (m) => { shown.push(m); },
      showQuickPick: async (items) => { shown.push(items.map((i) => `${i.label}|${i.description}|${i.picked}`)); return pick(items); },
      showWarningMessage: async (m) => { shown.push(m); return confirm; },
    },
  };
}

test('the command lists what it would delete and deletes only the ticked groups after confirming', async () => {
  const h = harness({ snapshots: [rec('cur', 1, { round: 3 }), rec('old', 2)], checkpoint: 'cur'.padEnd(40, '0') });
  const vscode = vscodeStub({ pick: (items) => items.filter((i) => i.picked), confirm: 'Delete' });
  await createCleanupCommand(vscode, h.deps)();
  assert.deepEqual(vscode.shown[0], [
    'Checkpoints replaced by a newer checkpoint (1)|1 KB|true',
    'Also delete the current checkpoint|1 KB|false',
  ]);
  assert.match(vscode.shown[1], /Delete 1 KB of Impact Tree data.*Feedback files are kept/);
  assert.deepEqual(h.removed, ['old']);
  assert.equal(h.session.state.checkpoint, 'cur'.padEnd(40, '0'));
});

test('ticking "Also delete the current checkpoint" clears it; cancelling deletes nothing', async () => {
  const h = harness({ snapshots: [rec('cur', 1, { round: 3 })], checkpoint: 'cur'.padEnd(40, '0') });
  await createCleanupCommand(vscodeStub({ pick: (items) => items, confirm: undefined }), h.deps)();
  assert.deepEqual(h.removed, []);
  await createCleanupCommand(vscodeStub({ pick: (items) => items, confirm: 'Delete' }), h.deps)();
  assert.deepEqual(h.removed, ['cur']);
  assert.equal(h.session.state.checkpoint, undefined);
});

test('nothing to delete says so and mentions feedback files are kept', async () => {
  const h = harness({ snapshots: [] });
  const vscode = vscodeStub({ pick: () => [], confirm: 'Delete' });
  await createCleanupCommand(vscode, h.deps)();
  assert.match(vscode.shown[0], /nothing to clean up\. Feedback files are never deleted/);
});
