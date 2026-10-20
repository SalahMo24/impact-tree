'use strict';
// Snapshot checkpoints (F2) on throwaway repositories: what a snapshot holds, that it never
// touches the user's .git, that checkpoint mode reads it through an intent-to-add index, and
// that a missing or damaged store is reported rather than half-trusted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createLocalHarness } = require('./local-repo');
const { analyze } = require('../src/engine/analyze');
const { makeGit } = require('../src/engine/git');
const { createSnapshotStore } = require('../src/engine/snapshot-store');

const H = createLocalHarness();
const FN = (n, v) => `export function ${n}() {\n  return ${v};\n}\n`;

test.after(() => fs.rmSync(H.TMP, { recursive: true, force: true }));

// A repo with: committed.ts + mod.ts + keep.ts committed; then mod.ts edited, staged.ts
// staged, untracked.ts + steady.ts untracked, debug.log ignored, and a file under .impact-tree.
function fixture() {
  const repo = H.mkRepo({
    '.gitignore': 'node_modules\n*.log\n',
    'src/committed.ts': FN('committed', 1),
    'src/mod.ts': FN('mod', 1),
  });
  H.write(repo, {
    'src/mod.ts': FN('mod', 2),
    'src/staged.ts': FN('staged', 1),
    'src/untracked.ts': FN('untracked', 1),
    'src/steady.ts': FN('steady', 1),
    'debug.log': 'noise\n',
    '.impact-tree/feedback/one.md': 'draft\n',
  });
  H.run(repo, ['add', 'src/staged.ts']);
  const root = fs.mkdtempSync(path.join(H.TMP, 'store-'));
  return { repo, root, store: createSnapshotStore({ root, repo }) };
}

const lsTree = (repo, record) => makeGit(repo, { objectDirs: [record.objectsDir] })
  .raw(['ls-tree', '-r', '--name-only', record.sha]).split('\n').filter(Boolean).sort();

const countFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);

function repoState(repo) {
  const g = (args) => H.run(repo, args);
  return {
    status: g(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2']),
    refs: g(['for-each-ref']),
    stash: g(['stash', 'list']),
    objects: countFiles(path.join(repo, '.git', 'objects')),
  };
}
const indexHash = (repo) => crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex');

test('a snapshot holds committed, modified, staged and untracked files, not ignored or .impact-tree', async () => {
  const { repo, store } = fixture();
  const rec = await store.take();
  assert.deepEqual(lsTree(repo, rec), [
    '.gitignore', 'src/committed.ts', 'src/mod.ts', 'src/staged.ts', 'src/steady.ts', 'src/untracked.ts',
  ]);
  const read = (p) => makeGit(repo, { objectDirs: [rec.objectsDir] }).show(rec.sha, p);
  assert.equal(read('src/mod.ts'), FN('mod', 2), 'uncommitted edit is in the snapshot');
  assert.equal(read('src/untracked.ts'), FN('untracked', 1));
  assert.equal(rec.headSha, H.headOf(repo));
  assert.equal(rec.branch, 'main');
  assert.equal(rec.round, null);
  assert.ok(rec.bytes > 0);
  assert.deepEqual(store.find(rec.sha), rec);
  assert.deepEqual(store.list(), [rec]);
  assert.deepEqual(store.objectDirs(), [rec.objectsDir]);
});

test('take() leaves the repository exactly as it was', async () => {
  const { repo, store } = fixture();
  H.run(repo, ['stash', 'push', '-q', '-m', 'keep', '--', 'src/mod.ts']);
  H.write(repo, { 'src/mod.ts': FN('mod', 3) });
  repoState(repo);   // the first `git status` may refresh the index; settle it, then compare
  const beforeIndex = indexHash(repo);
  const before = repoState(repo);
  assert.equal(indexHash(repo), beforeIndex, 'reading status did not rewrite the index');
  await store.take();
  assert.equal(indexHash(repo), beforeIndex, 'index bytes');
  assert.deepEqual(repoState(repo), before, 'status, refs, stash and object count');
});

test('a snapshot of a repository with detached HEAD and with no index yet', async () => {
  const { repo, store } = fixture();
  H.run(repo, ['checkout', '-q', '--detach']);
  assert.equal((await store.take()).branch, null);
  const bare = H.mkRepo({ 'a.txt': 'x\n' }, { ts: false });
  fs.rmSync(path.join(bare, '.git', 'index'));
  H.write(bare, { 'b.txt': 'y\n' });
  const rec = await createSnapshotStore({ root: fs.mkdtempSync(path.join(H.TMP, 'store-')), repo: bare }).take();
  assert.deepEqual(lsTree(bare, rec), ['.gitignore', 'a.txt', 'b.txt']);
  assert.equal(fs.existsSync(path.join(bare, '.git', 'index')), false, 'no index was created in .git');
});

test('checkpoint mode against a snapshot: untracked files are not "deleted"', async () => {
  const { repo, root, store } = fixture();
  const rec = await store.take();
  const tempDir = fs.mkdtempSync(path.join(H.TMP, 'tmp-'));
  H.write(repo, {
    'src/untracked.ts': FN('untracked', 2),            // untracked at snapshot time, edited since
    'src/new.ts': FN('fresh', 1),                      // new untracked file
    '.impact-tree/feedback/two.ts': FN('own', 1),      // our own folder: never a change
  });
  const r = await analyze(repo, { ...H.since(rec.sha), objectDirs: store.objectDirs(), tempDir });
  assert.equal(r.fileStatus['src/untracked.ts'], 'modified', JSON.stringify(r.fileStatus));
  assert.equal(r.fileStatus['src/new.ts'], 'added');
  assert.equal(r.fileStatus['src/steady.ts'], undefined, 'unchanged untracked file');
  assert.equal(r.fileStatus['src/mod.ts'], undefined, 'edit made before the snapshot');
  assert.equal(r.fileStatus['src/staged.ts'], undefined);
  assert.deepEqual(Object.keys(r.fileStatus).filter((p) => p.startsWith('.impact-tree')), []);
  assert.deepEqual(Object.values(r.fileStatus).filter((s) => s === 'deleted'), []);
  assert.deepEqual(r.allChanged.map((c) => c.label).sort(), ['fresh', 'untracked']);
  assert.deepEqual(fs.readdirSync(tempDir), [], 'the temporary index is gone after analyze');
  assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), [], 'and so is the take() scratch space');
  // a real deletion since the snapshot still reads as deleted
  fs.rmSync(path.join(repo, 'src/steady.ts'));
  const r2 = await analyze(repo, { ...H.since(rec.sha), objectDirs: store.objectDirs(), tempDir });
  assert.equal(r2.fileStatus['src/steady.ts'], 'deleted');
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test('the temporary index is removed when the analysis fails', async () => {
  const { repo, store } = fixture();
  const rec = await store.take();
  const tempDir = fs.mkdtempSync(path.join(H.TMP, 'tmp-'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(analyze(repo, { ...H.since(rec.sha), objectDirs: store.objectDirs(), tempDir, signal: aborted.signal }));
  // a throw while the index exists: the diff cannot read the snapshot without its objects
  H.write(repo, { 'src/new.ts': FN('fresh', 1) });
  await assert.rejects(analyze(repo, { ...H.since(rec.sha), objectDirs: [], tempDir }), (e) => e.code === 'NO_CHECKPOINT');
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test('a failing take() leaves no snapshot, manifest entry or temporary file', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root can read any file');
  const { repo, root, store } = fixture();
  const ok = await store.take();
  const locked = path.join(repo, 'src/locked.ts');
  fs.writeFileSync(locked, FN('locked', 1));
  fs.chmodSync(locked, 0);
  try {
    await assert.rejects(store.take());
  } finally {
    fs.chmodSync(locked, 0o644);
  }
  assert.deepEqual(store.list(), [ok], 'manifest unchanged');
  assert.deepEqual(fs.readdirSync(path.join(root, 'snapshots')), [ok.id], 'no half-written folder');
  assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), [], 'no temporary index');
});

test('take() fails cleanly outside a repository', async () => {
  const root = fs.mkdtempSync(path.join(H.TMP, 'store-'));
  const notRepo = fs.mkdtempSync(path.join(H.TMP, 'plain-'));
  const store = createSnapshotStore({ root, repo: notRepo });
  await assert.rejects(store.take());
  assert.deepEqual(store.list(), []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'snapshots')), []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
});

test('remove(id) deletes the snapshot and checkpoint mode then reports NO_CHECKPOINT', async () => {
  const { repo, root, store } = fixture();
  const rec = await store.take();
  assert.equal(await store.remove(rec.id), true);
  assert.equal(await store.remove(rec.id), false);
  assert.equal(await store.remove('../escape'), false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.objectDirs(), []);
  assert.equal(fs.existsSync(path.join(root, 'snapshots', rec.id)), false);
  await assert.rejects(
    analyze(repo, { ...H.since(rec.sha), objectDirs: store.objectDirs() }),
    (e) => e.code === 'NO_CHECKPOINT');
});

test('a corrupt or unknown-version manifest is empty and reported once', () => {
  for (const text of ['{not json', JSON.stringify({ version: 2, snapshots: [] }), JSON.stringify([])]) {
    const root = fs.mkdtempSync(path.join(H.TMP, 'store-'));
    fs.writeFileSync(path.join(root, 'manifest.json'), text);
    const logs = [];
    const store = createSnapshotStore({ root, repo: H.TMP, log: (m) => logs.push(m) });
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.objectDirs(), []);
    assert.equal(logs.length, 1, logs.join('\n'));
  }
});

test('a record that fails validation is skipped and logged, valid ones are kept', async () => {
  const { root, repo } = fixture();
  const logs = [];
  const store = createSnapshotStore({ root, repo, log: (m) => logs.push(m) });
  const good = await store.take();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  manifest.snapshots.push({ ...good, id: 'evil', sha: 'nothex' }, { ...good, id: 'other', objectsDir: '/elsewhere/objects' }, 7);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual(store.list(), [good]);
  store.list();
  assert.equal(logs.length, 3, logs.join('\n'));
});

test('two take() calls at once both land in the manifest', async () => {
  const { root, store } = fixture();
  const [a, b] = await Promise.all([store.take({ round: 1 }), store.take({ round: 2 })]);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(store.list().map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(store.list().map((r) => r.round), [1, 2]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version, 1);
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), []);
});

test('sweepTemp removes leftovers; withDiffIndex always removes its index', async () => {
  const { root, store } = fixture();
  fs.mkdirSync(path.join(root, 'tmp', 'take-stale'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'take-stale', 'index'), 'x');
  await store.sweepTemp();
  assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
  let seen;
  await store.withDiffIndex((env) => { seen = env.GIT_INDEX_FILE; assert.ok(fs.existsSync(seen)); });
  assert.equal(fs.existsSync(seen), false);
  await assert.rejects(store.withDiffIndex((env) => { seen = env.GIT_INDEX_FILE; throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(seen), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), []);
});

test('an old-style checkpoint (an ordinary commit) still analyses', async () => {
  const { repo } = fixture();
  const sha = H.headOf(repo);
  H.write(repo, { 'src/committed.ts': FN('committed', 9) });
  const r = await analyze(repo, H.since(sha));
  assert.equal(r.fileStatus['src/committed.ts'], 'modified');
  assert.equal(r.fileStatus['src/mod.ts'], 'modified', 'uncommitted work since the commit');
  assert.equal(r.fileStatus['src/untracked.ts'], 'added', 'untracked file is a new file');
  assert.equal(r.fileStatus['.impact-tree/feedback/one.md'], undefined);
});

test('an unknown checkpoint is NO_CHECKPOINT', async () => {
  const { repo } = fixture();
  await assert.rejects(analyze(repo, H.since('0'.repeat(40))), (e) => e.code === 'NO_CHECKPOINT');
});

test('makeGit objectDirs: absolute paths only, joined into GIT_ALTERNATE_OBJECT_DIRECTORIES', () => {
  const { repo } = fixture();
  assert.throws(() => makeGit(repo, { objectDirs: ['relative/objects'] }), TypeError);
  const dirs = [path.join(H.TMP, 'a'), path.join(H.TMP, 'b')];
  const env = makeGit(repo, { objectDirs: dirs }).raw(['var', 'GIT_AUTHOR_IDENT']);   // runs with the env set
  assert.ok(env);
  assert.equal(makeGit(repo, { objectDirs: dirs, env: { GIT_AUTHOR_NAME: 'Zed', GIT_AUTHOR_EMAIL: 'z@z' } })
    .raw(['var', 'GIT_AUTHOR_IDENT']).startsWith('Zed <z@z>'), true);
  assert.equal(os.platform() === 'win32' ? ';' : ':', path.delimiter);
});
