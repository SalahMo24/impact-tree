'use strict';
// J6 pass 2: Java's caller-query cap (2 in flight), an empty answer for an override or an
// overridable method read incomplete, and the Java language server's import state
// (src/languages/java/server-status.js) making answers incomplete. No editor or jdtls.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJavaEditorExtras, maskJava, JAVA_CALLER_QUERY_LIMIT, EMPTY_ANSWER_REASON } = require('../src/languages/java/editor-extras');
const { applyCallerExtras, queryHierarchy, createQueryGate } = require('../src/languages/callers-from-hierarchy');
const { createJavaServerStatus, IMPORTING_REASON, LIGHTWEIGHT_REASON, BUILD_FILE_REASON } = require('../src/languages/java/server-status');

const ROOT = '/r';
const tick = () => new Promise((r) => setImmediate(r));

/** Services whose every incomingCalls waits until the test releases it. */
function heldServices() {
  let inFlight = 0;
  const seen = { peak: 0 };
  /** @type {Array<() => void>} */
  const held = [];
  const services = {
    prepareCallHierarchy: async () => [{ name: 'm' }],
    incomingCalls: () => new Promise((resolve) => {
      inFlight++;
      seen.peak = Math.max(seen.peak, inFlight);
      held.push(() => { inFlight--; resolve([]); });
    }),
  };
  return { services, seen, held, inFlight: () => inFlight };
}

/** The answer of `extras` for the target `name` in `file`, the server listing `rows`. */
async function answerFor(extras, texts, file, name, rows) {
  const pos = new RegExp(`\\b${name}\\s*\\(`).exec(maskJava(texts[file])).index;
  const applied = await applyCallerExtras(/** @type {any} */ ({ ready: true, rows }), { extras, query: extras.query(file, pos), file, pos, withTests: true });
  return /** @type {any} */ (applied).answer;
}

test('cap: Java caller queries run at most 2 at once, the rest queued and all answered; without a gate (other languages) all 6 run', async () => {
  assert.equal(JAVA_CALLER_QUERY_LIMIT, 2);
  const java = heldServices();
  const gate = createJavaEditorExtras({ readText: () => null }).queryGate;
  const runs = Array.from({ length: 6 }, (_, i) => queryHierarchy(/** @type {any} */ (java.services), { file: `/r/F${i}.java`, side: 'head' }, 0, { gate }));
  for (let i = 0; i < 6; i++) {
    await tick(); await tick();
    assert.ok(java.inFlight() <= 2, `in flight ${java.inFlight()}`);
    /** @type {() => void} */ (java.held.shift())();
  }
  const answers = await Promise.all(runs);
  assert.equal(java.seen.peak, 2);
  assert.ok(answers.every((a) => a.ready));
  const other = heldServices();
  const free = Array.from({ length: 6 }, (_, i) => queryHierarchy(/** @type {any} */ (other.services), { file: `/r/f${i}.go`, side: 'head' }, 0));
  await tick(); await tick();
  assert.equal(other.inFlight(), 6);
  while (other.held.length) /** @type {() => void} */ (other.held.shift())();
  await Promise.all(free);
});

test('cap: a rejected query frees its slot, and the -32603 retry runs through the gate', async () => {
  const gate = createQueryGate(2);
  let calls = 0;
  const services = {
    prepareCallHierarchy: async () => [{ name: 'm' }],
    incomingCalls: async () => { calls++; if (calls === 1) throw new Error('Internal error. (code -32603)'); return []; },
  };
  const a = await queryHierarchy(/** @type {any} */ (services), { file: '/r/A.java', side: 'head' }, 0, { gate, retryRejected: () => true });
  assert.equal(a.ready, true);
  assert.equal(calls, 2);
  for (let i = 0; i < 3; i++) {
    const b = await queryHierarchy(/** @type {any} */ ({ prepareCallHierarchy: async () => { throw new Error('boom'); } }), { file: '/r/B.java', side: 'head' }, 0, { gate });
    assert.equal(b.ready, false);
  }
  assert.equal((await queryHierarchy(/** @type {any} */ (services), { file: '/r/C.java', side: 'head' }, 0, { gate })).ready, true);
  assert.throws(() => createQueryGate(0), RangeError);
});

test('empty answer: an override or an overridable method with no caller is incomplete; a private method stays complete', async () => {
  const file = '/r/src/E.java';
  const texts = { [file]: 'class E {\n  @Override public String toString() { return ""; }\n  public void open() {}\n  private void hidden() {}\n}\n' };
  const extras = createJavaEditorExtras({ readText: (f) => texts[f] ?? null, services: /** @type {any} */ ({ implementations: async () => [] }), repoRoot: ROOT });
  for (const name of ['toString', 'open']) {
    const answer = await answerFor(extras, texts, file, name, []);
    assert.equal(answer.complete, false, name);
    assert.ok(answer.reason.includes(EMPTY_ANSWER_REASON), name);
  }
  assert.equal((await answerFor(extras, texts, file, 'hidden', [])).complete, true);
});

test('import state: busy at the start or the end of a query, or an import in between, makes the answer incomplete', async () => {
  const file = '/r/src/P.java';
  const callsFile = '/r/src/C.java';
  const texts = { [file]: 'final class P {\n  void run() {}\n}\n', [callsFile]: 'class C { void a(P p) { p.run(); } }' };
  const at = texts[callsFile].indexOf('run');
  const rows = [{ label: 'a', file: callsFile, pos: 0, test: false, sites: 1, callSites: [{ start: at, end: at + 3 }] }];
  /** @type {string|null} */
  let busy = IMPORTING_REASON;
  let epoch = 0;
  const extras = createJavaEditorExtras({ readText: (f) => texts[f] ?? null, repoRoot: ROOT, serverStatus: { busyReason: () => busy, epoch: () => epoch } });
  const pos = texts[file].indexOf('run');
  const ask = async (during = () => {}) => {
    const query = extras.query(file, pos);
    during();
    return /** @type {any} */ (await applyCallerExtras(/** @type {any} */ ({ ready: true, rows }), { extras, query, file, pos, withTests: true })).answer;
  };
  let a = await ask();
  assert.equal(a.complete, false);
  assert.match(a.reason, /still importing/);
  a = await ask(() => { busy = null; });
  assert.equal(a.complete, false, 'busy when the query started');
  a = await ask(() => { epoch++; });
  assert.equal(a.complete, false, 'an import ended during the query');
  assert.match(a.reason, /re-imported the project while the query ran/);
  a = await ask();
  assert.equal(a.complete, true, 'idle before and after');
  assert.equal(a.callers.length, 1);
});

test('server status from redhat.java\'s API: not ready, lightweight, a changed pom until the next import, a broken build path', async () => {
  /** @type {Record<string, Function>} */
  const on = {};
  let resolveReady = () => {};
  const api = {
    serverMode: 'Standard',
    serverReady: () => new Promise((r) => { resolveReady = () => r(undefined); }),
    onDidProjectsImport: (/** @type {Function} */ fn) => { on.imported = fn; return { dispose() {} }; },
    onDidClasspathUpdate: (/** @type {Function} */ fn) => { on.classpath = fn; return { dispose() {} }; },
    onDidServerModeChange: (/** @type {Function} */ fn) => { on.mode = fn; return { dispose() {} }; },
  };
  const watcher = {
    onDidChange: (/** @type {Function} */ fn) => { on.pom = fn; return { dispose() {} }; },
    onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {},
  };
  /** @type {any[]} */
  let diags = [];
  const s = createJavaServerStatus({ api, watch: () => watcher, diagnostics: () => diags, hasBuildFile: (f) => f !== '/r/gone' });
  await tick();
  assert.equal(s.busyReason(), IMPORTING_REASON);
  resolveReady(); await tick(); await tick();
  assert.equal(s.busyReason(), null);
  const e0 = s.epoch();
  on.pom();
  assert.equal(s.busyReason(), BUILD_FILE_REASON);
  assert.ok(s.epoch() > e0);
  on.imported([]);
  assert.equal(s.busyReason(), null);
  api.serverMode = 'LightWeight';
  assert.equal(s.busyReason(), LIGHTWEIGHT_REASON);
  api.serverMode = 'Hybrid';
  assert.equal(s.busyReason(), IMPORTING_REASON);
  api.serverMode = 'Standard';
  diags = [[{ path: '/r/A.java', fsPath: '/r/A.java' }, [{ message: 'Build path specifies execution environment' }]]];
  assert.equal(s.busyReason(), null, 'a .java file\'s diagnostics are not the project\'s');
  diags.push([{ path: '/r/extras', fsPath: '/r/extras' }, [{ message: 'Build path specifies execution environment JavaSE-1.6. There are no JREs installed in the workspace that are strictly compatible with this environment.' }]]);
  assert.match(String(s.busyReason()), /broken build path for \/r\/extras/);
  diags = [[{ path: '/r/extras', fsPath: '/r/extras' }, [{ message: 'Build path specifies execution environment JavaSE-1.7. There are no JREs installed in the workspace that are strictly compatible with this environment.' }]]];
  assert.equal(s.busyReason(), null, 'Java 7: jdtls lists the calls (measured)');
  diags = [[{ path: '/r/gone', fsPath: '/r/gone' }, [{ message: 'Build path specifies execution environment JavaSE-1.6. There are no JREs installed' }]]];
  assert.equal(s.busyReason(), null, 'a project whose build file is gone is stale');
  diags = [[{ path: '/r/extras', fsPath: '/r/extras' }, []]];
  assert.equal(s.busyReason(), null);
  assert.equal(createJavaServerStatus({ api: null }).busyReason(), null);
});
