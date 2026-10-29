'use strict';
// The retention policy (pure) and the review-progress usage bookkeeping it relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planCleanup, summarize, formatBytes } = require('../src/storage/storage-cleanup');
const { createReviewState, listReviewKeys, deleteReviewKeys, META_KEY, META_MAX_ENTRIES } = require('../src/session/review-state');

const DAY = 86400000;
const NOW = 1_800_000_000_000;
const snap = (id, ageDays, extra = {}) => ({
  id, sha: `sha-${id}`, objectsDir: `/s/${id}`, createdAtMs: NOW - ageDays * DAY,
  branch: null, headSha: null, round: null, bytes: 100, ...extra,
});
const plan = (over) => planCleanup({
  nowMs: NOW, snapshots: [], currentCheckpointSha: null, liveBranches: new Set(['main']), reviewKeys: [], ...over,
});
const ids = (p) => p.snapshots.map((d) => d.record.id);
const reasonOf = (p, id) => p.snapshots.find((d) => d.record.id === id).reason;

test('the current checkpoint is never deleted, however old or branchless', () => {
  const s = snap('cur', 400, { round: 1, branch: 'gone' });
  const p = plan({ snapshots: [s], currentCheckpointSha: 'sha-cur', keepRounds: 0 });
  assert.deepEqual(p.snapshots, []);
  assert.equal(p.clearCheckpoint, false);
});

test('includeCurrent deletes the current checkpoint and clears the id', () => {
  const p = plan({ snapshots: [snap('cur', 1, { round: 1 })], currentCheckpointSha: 'sha-cur', includeCurrent: true });
  assert.deepEqual(ids(p), ['cur']);
  assert.equal(reasonOf(p, 'cur'), 'current checkpoint');
  assert.equal(p.clearCheckpoint, true);
});

test('clearCheckpoint stays false when no record has the current sha', () => {
  assert.equal(plan({ snapshots: [snap('a', 1, { round: 1 })], currentCheckpointSha: 'nope', includeCurrent: true }).clearCheckpoint, false);
});

test('keepRounds: the two newest rounds stay whatever their age; older ones go only for age or branch', () => {
  const snapshots = [
    snap('r1', 200, { round: 1 }), snap('r2', 100, { round: 2 }), snap('r3', 50, { round: 3 }),
    snap('r4', 5, { round: 4 }), snap('r5', 10, { round: 5 }),
  ];
  const p = plan({ snapshots });
  assert.deepEqual(ids(p).sort(), ['r1', 'r2', 'r3']);
  assert.equal(reasonOf(p, 'r1'), 'older than 30 days');
  // A third round that is recent and on a live branch is kept.
  const q = plan({ snapshots: [snap('a', 1, { round: 1 }), snap('b', 2, { round: 2 }), snap('c', 3, { round: 3 })] });
  assert.deepEqual(q.snapshots, []);
  const r = plan({ snapshots: [snap('a', 1, { round: 1 }), snap('b', 2, { round: 2 }), snap('c', 3, { round: 3, branch: 'gone' })] });
  assert.deepEqual(ids(r), ['c']);
  assert.equal(reasonOf(r, 'c'), 'branch deleted');
});

test('the current round counts among the newest rounds', () => {
  const snapshots = [snap('a', 1, { round: 3 }), snap('b', 2, { round: 2 }), snap('c', 40, { round: 1 })];
  const p = plan({ snapshots, currentCheckpointSha: 'sha-a', keepRounds: 2 });
  assert.deepEqual(ids(p), ['c']);
});

test('kept rounds survive a deleted branch', () => {
  assert.deepEqual(plan({ snapshots: [snap('a', 1, { round: 1, branch: 'gone' })] }).snapshots, []);
});

test('a non-round, non-current snapshot is replaced', () => {
  const p = plan({ snapshots: [snap('m', 1), snap('cur', 0)], currentCheckpointSha: 'sha-cur' });
  assert.deepEqual(ids(p), ['m']);
  assert.equal(reasonOf(p, 'm'), 'replaced');
});

test('a non-round snapshot under an hour old is kept: its checkpoint may still be being recorded', () => {
  const at = (id, msAgo) => ({ ...snap(id, 0), createdAtMs: NOW - msAgo });
  const p = plan({ snapshots: [at('new', 3600000), at('old', 3600001)], currentCheckpointSha: null });
  assert.deepEqual(ids(p), ['old']);
});

test('liveBranches null deletes nothing for the branch reason', () => {
  const snapshots = [snap('a', 1, { round: 1 }), snap('b', 2, { round: 2 }), snap('c', 3, { round: 3, branch: 'gone' })];
  const keys = [{ key: 'impactTree.reviewed.x', lastUsedMs: NOW, branch: 'gone' }];
  const p = plan({ snapshots, reviewKeys: keys, liveBranches: null });
  assert.deepEqual(p.snapshots, []);
  assert.deepEqual(p.reviewKeys, []);
});

test('age boundary: exactly 30 days is kept, one millisecond more is deleted', () => {
  const at = (ms) => plan({
    snapshots: [snap('x', 0, { round: 1, createdAtMs: NOW - 30 * DAY - ms }), snap('y', 0, { round: 2 }), snap('z', 0, { round: 3 })],
    keepRounds: 2,
  });
  assert.deepEqual(ids(at(0)), []);
  assert.deepEqual(ids(at(1)), ['x']);
  const custom = plan({ snapshots: [snap('x', 8, { round: 1 }), snap('y', 0, { round: 2 })], keepRounds: 1, snapshotMaxAgeDays: 7 });
  assert.equal(reasonOf(custom, 'x'), 'older than 7 days');
});

test('review keys: legacy null lastUsed kept, active kept, branch gone and stale deleted', () => {
  const k = (name, lastUsedMs, branch = null) => ({ key: `impactTree.reviewed.${name}`, lastUsedMs, branch });
  const p = plan({
    activeReviewKey: 'impactTree.reviewed.active',
    reviewKeys: [
      k('legacy', null), k('active', NOW - 500 * DAY, 'gone'), k('fresh', NOW - 90 * DAY), k('stale', NOW - 90 * DAY - 1),
      k('gone', NOW, 'old-branch'), k('live', NOW, 'main'), k('legacy-gone', null, 'old-branch'),
    ],
  });
  assert.deepEqual(p.reviewKeys, [
    { key: 'impactTree.reviewed.stale', reason: 'unused for 90 days' },
    { key: 'impactTree.reviewed.gone', reason: 'branch deleted' },
    { key: 'impactTree.reviewed.legacy-gone', reason: 'branch deleted' },
  ]);
});

test('invalid internal input throws RangeError', () => {
  const bad = (over) => assert.throws(() => plan(over), RangeError);
  bad({ nowMs: NaN });
  bad({ nowMs: '1' });
  bad({ keepRounds: -1 });
  bad({ keepRounds: 51 });
  bad({ keepRounds: 1.5 });
  bad({ snapshotMaxAgeDays: 0 });
  bad({ snapshotMaxAgeDays: 3651 });
  bad({ reviewMaxAgeDays: 2.5 });
  bad({ liveBranches: ['main'] });
  bad({ snapshots: null });
  bad({ snapshots: [{ sha: 'a' }] });
  bad({ reviewKeys: [{}] });
  assert.doesNotThrow(() => plan({ keepRounds: 0, snapshotMaxAgeDays: 3650, reviewMaxAgeDays: 1 }));
});

test('formatBytes boundaries', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1024 * 1024 - 1), '1024 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
});

test('summarize groups by reason, sums sizes and omits empty rows', () => {
  const snapshots = [
    snap('o1', 90, { round: 1, bytes: 1024 }), snap('o2', 80, { round: 2, bytes: 1024 }),
    snap('o3', 70, { round: 3, bytes: 1024 }), snap('o4', 60, { round: 4, bytes: 1024 }),
    snap('n1', 0, { round: 5 }), snap('n2', 0, { round: 6 }),
  ];
  const p = plan({
    snapshots,
    reviewKeys: [
      { key: 'impactTree.reviewed.a', lastUsedMs: NOW, branch: 'gone' },
      { key: 'impactTree.reviewed.b', lastUsedMs: NOW, branch: 'gone' },
    ],
  });
  const rows = summarize(p, { reviewKeys: new Map([['impactTree.reviewed.a', 50], ['impactTree.reviewed.b', 70]]) });
  assert.deepEqual(rows, [
    { label: 'Checkpoints from older feedback rounds (4)', group: 'Checkpoints from older feedback rounds', count: 4, bytes: 4096 },
    { label: 'Review progress for deleted branches (2)', group: 'Review progress for deleted branches', count: 2, bytes: 120 },
  ]);
  assert.deepEqual(summarize(plan({})), []);
});

// ---- review progress usage bookkeeping ----

const memento = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m, get: (k) => m.get(k), keys: () => [...m.keys()],
    update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); return Promise.resolve(); },
  };
};

test('loading a review stamps its last use and branch', () => {
  const mem = memento();
  let t = 1000;
  const rs = createReviewState(mem, { now: () => t });
  rs.configure('v2:/r:feat:branch:abc', null, { branch: 'feat' });
  t = 2000;
  rs.configure('v2:/r:pr:7', null);
  assert.deepEqual(mem.get(META_KEY), {
    version: 1,
    keys: {
      'v2:/r:feat:branch:abc': { lastUsedMs: 1000, branch: 'feat' },
      'v2:/r:pr:7': { lastUsedMs: 2000, branch: null },
    },
  });
  rs.set('x', true);
  rs.configure('v2:/r:feat:branch:abc', null, { branch: 'feat' });
  rs.set('y', true);
  // A review with no stored ticks is not listed: there is nothing to delete.
  assert.deepEqual(listReviewKeys(mem).map((k) => k.key), ['impactTree.reviewed.v2:/r:pr:7', 'impactTree.reviewed.v2:/r:feat:branch:abc']);
});

test('listReviewKeys joins ticks with meta, treats unstamped keys as null, and skips the meta key', () => {
  const mem = memento({
    'impactTree.reviewed.a': ['x'], 'impactTree.reviewed.legacy': ['y'], 'impactTree.checkpoint': 'sha',
    [META_KEY]: { version: 1, keys: { a: { lastUsedMs: 5, branch: 'b' } } },
  });
  assert.deepEqual(listReviewKeys(mem), [
    { key: 'impactTree.reviewed.a', lastUsedMs: 5, branch: 'b' },
    { key: 'impactTree.reviewed.legacy', lastUsedMs: null, branch: null },
  ]);
});

test('listReviewKeys returns [] for a memento without keys()', () => {
  assert.deepEqual(listReviewKeys({ get: () => undefined }), []);
  assert.deepEqual(listReviewKeys(null), []);
});

test('invalid meta is ignored and logged', () => {
  for (const bad of ['text', { version: 2, keys: {} }, { version: 1, keys: [] }, { version: 1 }, null]) {
    const logs = [];
    const mem = memento({ 'impactTree.reviewed.a': [], [META_KEY]: bad });
    assert.deepEqual(listReviewKeys(mem, (m) => logs.push(m)), [{ key: 'impactTree.reviewed.a', lastUsedMs: null, branch: null }]);
    assert.equal(logs.length, 1);
  }
  const mem = memento({
    [META_KEY]: { version: 1, keys: { ok: { lastUsedMs: 1, branch: null }, nan: { lastUsedMs: 'x', branch: null }, b: { lastUsedMs: 2, branch: 3 } } },
    'impactTree.reviewed.ok': [], 'impactTree.reviewed.nan': [], 'impactTree.reviewed.b': [],
  });
  assert.deepEqual(listReviewKeys(mem).map((k) => k.lastUsedMs), [1, null, null]);
});

test('stamping logs unreadable meta once and rewrites it', () => {
  const logs = [];
  const mem = memento({ [META_KEY]: 'junk' });
  const rs = createReviewState(mem, { now: () => 9, log: (m) => logs.push(m) });
  rs.configure('k1', null);
  rs.configure('k2', null);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(mem.get(META_KEY).keys), ['k1', 'k2']);
});

test('the meta is capped at 1000 entries, dropping the least recently used', () => {
  const keys = {};
  for (let i = 0; i < META_MAX_ENTRIES; i++) keys[`k${i}`] = { lastUsedMs: 100 + i, branch: null };
  const mem = memento({ [META_KEY]: { version: 1, keys } });
  const rs = createReviewState(mem, { now: () => 5000 });
  rs.configure('fresh', null);
  const stored = mem.get(META_KEY).keys;
  assert.equal(Object.keys(stored).length, META_MAX_ENTRIES);
  assert.ok(stored.fresh);
  assert.equal(stored.k0, undefined);
  assert.ok(stored.k1);
});

test('useBase keeps a known branch; migration still copies ticks once', () => {
  const mem = memento({ 'impactTree.reviewed.old': ['t'] });
  const rs = createReviewState(mem, { now: () => 1 });
  rs.configure('new', null, { migrateFrom: 'old', branch: 'feat' });
  assert.equal(rs.isReviewed('t'), true);
  rs.useBase('sha1');
  rs.useBase('new');
  assert.equal(mem.get(META_KEY).keys.new.branch, 'feat');
});

test('deleteReviewKeys removes ticks and meta, ignoring keys outside the prefix', async () => {
  const mem = memento({
    'impactTree.reviewed.a': ['x'], 'impactTree.reviewed.b': ['y'], 'impactTree.checkpoint': 'sha',
    [META_KEY]: { version: 1, keys: { a: { lastUsedMs: 1, branch: null }, b: { lastUsedMs: 2, branch: null } } },
  });
  await deleteReviewKeys(mem, ['impactTree.reviewed.a', 'impactTree.checkpoint', META_KEY]);
  assert.equal(mem.get('impactTree.reviewed.a'), undefined);
  assert.deepEqual(mem.get('impactTree.reviewed.b'), ['y']);
  assert.equal(mem.get('impactTree.checkpoint'), 'sha');
  assert.deepEqual(mem.get(META_KEY), { version: 1, keys: { b: { lastUsedMs: 2, branch: null } } });
});
