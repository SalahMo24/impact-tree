'use strict';
// J6 pass 3: a build file changed while the Java language server was not running. The status
// (src/languages/java/server-status.js) compares the build files with its record of the last
// import it saw, at creation and at serverReady(), and keeps Java answers incomplete until an
// import event, or for good (with its reason) once the deadline passes. No editor or jdtls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFakeClock } = require('./fake-clock');
const {
  createJavaServerStatus, stampBuildFiles, IMPORT_CONFIRM_DEADLINE_MS, IMPORT_SETTLE_MS, BUILD_FILE_SINCE_IMPORT_REASON,
  BUILD_FILE_FIRST_REASON, BUILD_FILE_SETTLING_REASON, BUILD_FILES_UNKNOWN_REASON,
} = require('../src/languages/java/server-status');

const tick = () => new Promise((r) => setImmediate(r));

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-java-record-'));
  fs.writeFileSync(path.join(dir, 'pom.xml'), '<project>1</project>');
  fs.mkdirSync(path.join(dir, 'extras'));
  fs.writeFileSync(path.join(dir, 'extras', 'pom.xml'), '<project>extras</project>');
  fs.mkdirSync(path.join(dir, 'target', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'target', 'x', 'pom.xml'), 'ignored');
  return dir;
}

/** A status over `dir` with a fake redhat.java API whose ready and events the test drives. */
function setup(dir, record, { stamp, watcher } = {}) {
  const clock = createFakeClock();
  /** @type {Record<string, Function>} */
  const on = {};
  let resolveReady = () => {};
  const store = { value: record, get() { return this.value; }, set(v) { this.value = v; } };
  const api = {
    serverMode: 'Standard',
    serverReady: () => new Promise((r) => { resolveReady = () => r(undefined); }),
    onDidProjectsImport: (fn) => { on.imported = fn; return { dispose() {} }; },
    onDidClasspathUpdate: (fn) => { on.classpath = fn; return { dispose() {} }; },
  };
  const status = createJavaServerStatus({ api, clock, ...(watcher ? { watch: () => watcher } : {}), buildFiles: { folders: () => [dir], store, ...(stamp ? { stamp } : {}) } });
  return { status, on, store, clock, ready: async () => { await tick(); resolveReady(); await tick(); await tick(); } };
}

test('a build file changed since the record: incomplete until an import event, which records it', async () => {
  const dir = workspace();
  const before = stampBuildFiles([dir]);
  fs.writeFileSync(path.join(dir, 'extras', 'pom.xml'), '<project>extras 2</project>');
  const s = setup(dir, { version: 1, stamp: before.stamp });
  await s.ready();
  assert.equal(s.status.busyReason(), BUILD_FILE_SINCE_IMPORT_REASON);
  const e0 = s.status.epoch();
  s.on.imported([]);
  assert.equal(s.status.busyReason(), null);
  assert.ok(s.status.epoch() > e0);
  assert.equal(s.store.value.stamp, stampBuildFiles([dir]).stamp);
  await s.clock.advance(IMPORT_CONFIRM_DEADLINE_MS + 1);
  assert.equal(s.status.busyReason(), null, 'the deadline was cancelled by the import');
});

test('unchanged build files: complete once settled, with no import event; target/ and dot-folders are not stamped', async () => {
  const dir = workspace();
  const rec = { version: 1, stamp: stampBuildFiles([dir]).stamp };
  fs.writeFileSync(path.join(dir, 'target', 'x', 'pom.xml'), 'changed, ignored');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'pom.xml'), 'ignored');
  const s = setup(dir, rec);
  assert.notEqual(s.status.busyReason(), null, 'before ready: importing');
  await s.ready();
  assert.equal(s.status.busyReason(), BUILD_FILE_SETTLING_REASON);
  await s.clock.advance(IMPORT_SETTLE_MS - 1);
  assert.equal(s.status.busyReason(), BUILD_FILE_SETTLING_REASON);
  const e0 = s.status.epoch();
  await s.clock.advance(1);
  assert.equal(s.status.busyReason(), null);
  assert.ok(s.status.epoch() > e0);
  await s.clock.advance(IMPORT_CONFIRM_DEADLINE_MS + 1);
  assert.equal(s.status.busyReason(), null);
});

test('no record (first run, or an unknown format): incomplete until settled after ready, then recorded', async () => {
  for (const record of [undefined, { version: 2, stamp: 'x' }]) {
    const dir = workspace();
    const s = setup(dir, record);
    s.on.imported([]); // before ready: jdtls may still be on its old -data; not recorded
    await s.clock.advance(IMPORT_SETTLE_MS); // time before ready does not count
    await s.ready();
    assert.equal(s.status.busyReason(), BUILD_FILE_FIRST_REASON);
    assert.equal(s.store.value, record);
    await s.clock.advance(IMPORT_SETTLE_MS);
    assert.equal(s.status.busyReason(), null);
    assert.equal(s.store.value.stamp, stampBuildFiles([dir]).stamp);
  }
});

test('settling: an import event or a build-file change after ready restarts the quiet period', async () => {
  /** @type {Record<string, Function>} */
  const w = {};
  const watcher = { onDidChange: (fn) => { w.change = fn; return { dispose() {} }; }, onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };
  const dir = workspace();
  const s = setup(dir, undefined, { watcher });
  await s.ready();
  await s.clock.advance(11700); // the stale start's first post-ready event (J6 pass 3)
  s.on.classpath({});
  assert.equal(s.status.busyReason(), BUILD_FILE_FIRST_REASON, 'an event while settling does not end it');
  assert.equal(s.store.value, undefined);
  await s.clock.advance(IMPORT_SETTLE_MS - 1);
  assert.equal(s.status.busyReason(), BUILD_FILE_FIRST_REASON);
  s.on.imported([]);
  await s.clock.advance(IMPORT_SETTLE_MS - 1);
  assert.equal(s.status.busyReason(), BUILD_FILE_FIRST_REASON);
  await s.clock.advance(1);
  assert.equal(s.status.busyReason(), null);
  // A later change (not settling any more): incomplete until an import event, as before.
  w.change();
  assert.match(String(s.status.busyReason()), /build file changed/);
  s.on.imported([]);
  assert.equal(s.status.busyReason(), null);
});

test('events that keep coming: past the deadline it says not confirmed, and still settles after', async () => {
  const dir = workspace();
  const s = setup(dir, undefined);
  await s.ready();
  for (let t = 0; t <= IMPORT_CONFIRM_DEADLINE_MS; t += IMPORT_SETTLE_MS / 2) { s.on.classpath({}); await s.clock.advance(IMPORT_SETTLE_MS / 2); }
  assert.match(String(s.status.busyReason()), /no import .* not confirmed within 120 s/);
  await s.clock.advance(IMPORT_SETTLE_MS);
  assert.equal(s.status.busyReason(), null);
});

test('no import event within the deadline: stays incomplete, saying it was not confirmed', async () => {
  const dir = workspace();
  const s = setup(dir, { version: 1, stamp: 'old' });
  await s.ready();
  await s.clock.advance(IMPORT_CONFIRM_DEADLINE_MS - 1);
  assert.equal(s.status.busyReason(), BUILD_FILE_SINCE_IMPORT_REASON);
  await s.clock.advance(1);
  assert.match(String(s.status.busyReason()), /build file changed since .*; the re-import was not confirmed within 120 s/);
  await s.clock.advance(10 * IMPORT_CONFIRM_DEADLINE_MS);
  assert.match(String(s.status.busyReason()), /not confirmed/);
  s.on.imported([]);
  assert.equal(s.status.busyReason(), null, 'a late import event still ends it');
});

test('a cap reached: the files are not known, so incomplete until an import event', async () => {
  const dir = workspace();
  const limits = { maxFiles: 2, maxDepth: 8, maxDirs: 5000, maxFileBytes: 1024 };
  assert.ok(stampBuildFiles([dir], { limits }).stamp, 'exactly at the file cap: known');
  fs.mkdirSync(path.join(dir, 'metrics'));
  fs.writeFileSync(path.join(dir, 'metrics', 'build.gradle'), 'x');
  const over = stampBuildFiles([dir], { limits });
  assert.equal(over.stamp, null);
  assert.match(over.reason, /more than 2 build files/);
  assert.match(String(stampBuildFiles([dir], { limits: { ...limits, maxDepth: 0 } }).reason), /deeper than 0/);
  assert.match(String(stampBuildFiles([dir], { limits: { ...limits, maxDirs: 2 } }).reason), /more than 2 folders/);
  assert.match(String(stampBuildFiles([dir], { limits: { ...limits, maxFileBytes: 5 } }).reason), /over 5 bytes/);
  const s = setup(dir, { version: 1, stamp: stampBuildFiles([dir]).stamp }, { stamp: (folders) => stampBuildFiles(folders, { limits }) });
  await s.ready();
  assert.match(String(s.status.busyReason()), new RegExp(`^${BUILD_FILES_UNKNOWN_REASON} \\(more than 2 build files\\)$`));
  s.on.imported([]);
  assert.equal(s.status.busyReason(), null);
  assert.match(String(stampBuildFiles([path.join(dir, 'missing')]).reason), /could not all be read \(ENOENT/);
});
