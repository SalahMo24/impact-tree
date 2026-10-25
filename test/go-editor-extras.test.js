'use strict';
// Go's caller extras (src/languages/go/editor-extras.js, G4): value uses are dropped or
// split off, a value use makes the answer incomplete, and a file outside the active build
// is explained. No editor: caller texts are supplied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGoEditorExtras, filterValueUses, explainGoIncomplete, isMethodAt, NOT_IN_BUILD_REASON, OUTSIDE_INTERFACE_REASON, MAX_CALLER_FILE_BYTES } = require('../src/languages/go/editor-extras');
const { goProvider } = require('../src/languages/go/provider');
const textpos = require('../src/engine/textpos');

/** A caller row in `file` with a site at each listed occurrence of `name` in `text`. */
function callerIn(file, text, name, label = 'caller') {
  const callSites = [];
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) callSites.push({ start: i, end: i + name.length });
  return { label, file, pos: 0, test: false, sites: callSites.length, callSites };
}

const texts = {
  '/r/calls.go': 'func a() { run(1) }',
  '/r/values.go': 'func b() { register(run); h := run; _ = h }',
  '/r/mixed.go': 'func c() {\n\trun(1)\n\tregister(run)\n}',
  '/r/unreadable.go': null,
};
const readText = (/** @type {string} */ file) => (file in texts ? texts[/** @type {keyof typeof texts} */ (file)] : null);
const rows = () => Object.entries(texts).map(([file, text]) => callerIn(file, text ?? 'func d() { run() }', 'run', path.basename(file, '.go')));

test('filter drops a caller that only uses the function as a value, and keeps a caller that calls it', () => {
  const [calls, values] = rows();
  const { kept, dropped, valueUses } = filterValueUses([calls, values], readText);
  assert.deepEqual(kept, [calls], 'the caller that calls it is kept unchanged');
  assert.equal(dropped, 1);
  assert.equal(valueUses, 2);
});

test('filter keeps a caller with calls and value uses with only its calls', () => {
  const mixed = rows()[2];
  assert.equal(mixed.sites, 2);
  const { kept, dropped } = filterValueUses([mixed], readText);
  assert.equal(dropped, 0);
  assert.equal(kept.length, 1);
  const text = /** @type {string} */ (texts['/r/mixed.go']);
  assert.deepEqual(kept[0].callSites.map((s) => text.slice(s.start, s.end + 3)), ['run(1)']);
  assert.equal(kept[0].sites, 1);
  assert.equal(mixed.sites, 2, 'the input row is not changed');
});

test('a caller whose file cannot be read keeps all its sites, and so does a caller with no sites', () => {
  const unreadable = rows()[3];
  const noSites = { ...rows()[0], sites: 0, callSites: [] };
  const { kept, dropped, valueUses } = filterValueUses([unreadable, noSites], readText);
  assert.deepEqual(kept, [unreadable, noSites]);
  assert.equal(dropped, 0);
  assert.equal(valueUses, 0);
});

test('a value use makes the answer incomplete as referenced-as-value; without one there is nothing to add', async () => {
  const extras = createGoEditorExtras({ readText });
  const [calls, values, mixed] = rows();

  const plain = extras.query('/r/t.go', 5);
  assert.equal(plain.isSuppressed(), false);
  assert.deepEqual(plain.filter([calls]), { kept: [calls], dropped: 0 });
  assert.deepEqual(await /** @type {Function} */ (plain.moreCallers)(), { callers: [], incompleteReason: null });

  const onlyValues = extras.query('/r/t.go', 5);
  assert.deepEqual(onlyValues.filter([values]), { kept: [], dropped: 1 });
  assert.deepEqual(await /** @type {Function} */ (onlyValues.moreCallers)(), { callers: [], incompleteReason: 'referenced-as-value' });

  const split = extras.query('/r/t.go', 5);
  assert.equal(split.filter([calls, mixed]).kept.length, 2);
  assert.equal((await /** @type {Function} */ (split.moreCallers)()).incompleteReason, 'referenced-as-value');

  // Each query keeps its own evidence: the next one starts with none.
  const next = extras.query('/r/t.go', 5);
  assert.equal((await /** @type {Function} */ (next.moreCallers)()).incompleteReason, null);
  assert.equal(await extras.unseenUsers('/r/t.go', 5), null);
});

test('a method sharing an interface with code outside the repository may be missing callers (G7)', async () => {
  // cli/cli PR #14104: `(telemetryDisablerTransport).RoundTrip` implements net/http's
  // RoundTripper; gopls listed its direct callers only, and the answer read complete.
  const methodText = 'package api\n\nfunc (t *transport) RoundTrip(r *Request) (*Response, error) { return nil, nil }\n';
  const funcText = 'package api\n\nfunc helper() {}\n';
  const files = /** @type {Record<string, string>} */ ({ '/repo/api/t.go': methodText, '/repo/api/f.go': funcText });
  const methodPos = methodText.indexOf('RoundTrip');
  /** @type {Array<[string, number]>} */
  const asked = [];
  /** @param {(() => Promise<any>)} answer */
  const servicesAnswering = (answer) => /** @type {any} */ ({ implementations: async (/** @type {any} */ doc, /** @type {number} */ pos) => { asked.push([doc.file, pos]); return answer(); } });
  const more = async (/** @type {any} */ services, file = '/repo/api/t.go', pos = methodPos) => {
    const extras = createGoEditorExtras({ readText: (f) => files[f] ?? null, services, repoRoot: '/repo' });
    const query = extras.query(file, pos);
    query.filter([]);
    return (await /** @type {Function} */ (query.moreCallers)()).incompleteReason;
  };

  const outside = servicesAnswering(async () => [{ file: '/repo/api/other.go', start: 1, end: 2 }, { file: '/goroot/src/net/http/client.go', start: 1, end: 2 }]);
  assert.equal(await more(outside), OUTSIDE_INTERFACE_REASON);
  assert.deepEqual(asked, [['/repo/api/t.go', methodPos]]);
  assert.equal(await more(servicesAnswering(async () => [{ file: '/repo/api/other.go', start: 1, end: 2 }])), null, 'only repository interfaces: gopls lists those calls');
  assert.equal(await more(servicesAnswering(async () => [])), null);
  assert.equal(await more(servicesAnswering(async () => null)), 'the interfaces it implements could not be listed (no answer)');
  assert.equal(await more(servicesAnswering(async () => { throw new Error('timed out'); })), 'the interfaces it implements could not be listed: timed out');
  asked.length = 0;
  assert.equal(await more(outside, '/repo/api/f.go', funcText.indexOf('helper')), null, 'a function is not asked');
  assert.equal(await more(outside, '/repo/api/missing.go', 5), null, 'an unreadable target is not asked');
  assert.deepEqual(asked, []);
  assert.equal(await more(null), null, 'no services: nothing is checked');

  // A value use is the stronger reason; the interfaces are not asked.
  const extras = createGoEditorExtras({ readText: (f) => files[f] ?? texts[/** @type {keyof typeof texts} */ (f)] ?? null, services: outside, repoRoot: '/repo' });
  const query = extras.query('/repo/api/t.go', methodPos);
  query.filter([rows()[1]]);
  assert.equal((await /** @type {Function} */ (query.moreCallers)()).incompleteReason, 'referenced-as-value');
  assert.deepEqual(asked, []);
  assert.equal(isMethodAt('func (c *Config) Reload() error', 17), true);
  assert.equal(isMethodAt('func Reload() error', 5), false);
});

test('"no package metadata" is explained as a file outside the active build; other failures are not', () => {
  const raw = 'no package metadata for file file:///repo/internal/debug/config_enabled.go';
  assert.equal(explainGoIncomplete(raw), NOT_IN_BUILD_REASON);
  assert.equal(NOT_IN_BUILD_REASON, 'not in the active build (build tags); callers were not searched');
  assert.equal(explainGoIncomplete('language server not ready'), null);
  assert.equal(explainGoIncomplete(''), null);
  assert.equal(createGoEditorExtras().explainIncomplete, explainGoIncomplete);
});

test('the Go provider registers these extras for the editor', () => {
  assert.equal(typeof goProvider.editorCallers, 'function');
  const extras = /** @type {Function} */ (goProvider.editorCallers)({ ts: null, services: null, repoRoot: '/r', trace() {}, filterInherited: true, onWarmupRetry() {} });
  assert.equal(extras.explainIncomplete, explainGoIncomplete);
});

test('caller files are read through textpos, as their offsets were, and not past the size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-go-extras-'));
  try {
    const small = path.join(dir, 'small.go');
    fs.writeFileSync(small, 'func b() { register(run) }');
    const caller = callerIn(small, fs.readFileSync(small, 'utf8'), 'run');
    const extras = createGoEditorExtras();
    assert.deepEqual(extras.query(small, 0).filter([caller]), { kept: [], dropped: 1 }, 'read from disk');

    const big = path.join(dir, 'big.go');
    const text = `func b() { register(run) }\n//${'x'.repeat(MAX_CALLER_FILE_BYTES)}\n`;
    fs.writeFileSync(big, text);
    const bigCaller = callerIn(big, 'func b() { register(run) }', 'run');
    assert.deepEqual(extras.query(big, 0).filter([bigCaller]), { kept: [bigCaller], dropped: 0 }, 'too large to read: unknown, kept');

    // Registered text (a PR preview's) is what offsets refer to, and it shadows the disk.
    textpos.registerVirtualText(small, 'func b() { run() }');
    const virtualCaller = callerIn(small, 'func b() { run() }', 'run');
    assert.deepEqual(extras.query(small, 0).filter([virtualCaller]), { kept: [virtualCaller], dropped: 0 });
  } finally {
    textpos.clearVirtualText();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTextOfOffsets validates its limit', () => {
  assert.throws(() => textpos.readTextOfOffsets('/nowhere', { maxBytes: 0 }), RangeError);
  assert.throws(() => textpos.readTextOfOffsets('/nowhere', { maxBytes: 1.5 }), RangeError);
  assert.equal(textpos.readTextOfOffsets('/nowhere/at/all.go', { maxBytes: 10 }), null);
});

// Through the editor's resolver (src/resolver-vscode.js) with the vscode stub: what the
// reviewer ends up with for a Go target.
test('the editor resolver applies the Go extras: value uses, mixed callers and build tags', async () => {
  const Module = require('module'), original = Module._load;
  const { createFakeClock } = require('./fake-clock');
  const { classifyCallSiteUpdates, classifyCallerUpdateState } = require('../src/engine/call-sites');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-go-resolver-'));
  const target = path.join(dir, 'run.go');
  fs.writeFileSync(target, 'package p\n\nfunc run(n int) {}\n');
  const valuesFile = path.join(dir, 'values.go');
  fs.writeFileSync(valuesFile, 'package p\n\nfunc b() {\n\tregister(run)\n}\n');
  const mixedFile = path.join(dir, 'mixed.go');
  fs.writeFileSync(mixedFile, 'package p\n\nfunc c() {\n\trun(1)\n\tregister(run)\n}\n');
  /** An incoming call from `name` in `file`, with a site at each `run` in it. */
  const incoming = (/** @type {string} */ file, /** @type {string} */ name) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    /** @type {object[]} */
    const fromRanges = [];
    lines.forEach((line, i) => {
      for (let c = line.indexOf('run'); c >= 0; c = line.indexOf('run', c + 1)) {
        fromRanges.push({ start: { line: i, character: c }, end: { line: i, character: c + 3 } });
      }
    });
    return { from: { uri: { fsPath: file }, name, selectionRange: { start: { line: 2, character: 5 } } }, fromRanges };
  };
  let mode = 'values';
  const stub = { ...require('./vscode-stub'), Position: class { constructor(/** @type {number} */ line, /** @type {number} */ character) { Object.assign(this, { line, character }); } },
    commands: { executeCommand: async (/** @type {string} */ name) => {
      if (name === 'vscode.prepareCallHierarchy') {
        if (mode === 'build-tags') throw new Error(`no package metadata for file file://${target}`);
        return [{}];
      }
      if (name === 'vscode.provideIncomingCalls') return mode === 'values' ? [incoming(valuesFile, 'b')] : [incoming(mixedFile, 'c')];
      if (name === 'vscode.executeReferenceProvider') return [];
      return undefined;
    } } };
  try {
    Module._load = function (/** @type {string} */ name, /** @type {any[]} */ ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
    delete require.cache[require.resolve('../src/resolver-vscode')];
    const { createVscodeResolver } = require('../src/resolver-vscode');
    const namePos = fs.readFileSync(target, 'utf8').indexOf('run');
    const ask = async () => {
      const clock = createFakeClock();
      const resolver = createVscodeResolver({ repoRoot: dir, retries: 0, clock });
      const state = resolver.callerState(target, namePos);
      await clock.advance(120000);
      return { state: await state, resolver };
    };

    // Only value uses: no caller is left, and that is not "no callers".
    const values = await ask();
    assert.deepEqual(values.state, { state: 'unknown', callers: [], complete: false, reason: 'referenced-as-value' });
    assert.equal(values.resolver.stats().valueUsesDropped, 1);
    assert.equal(values.resolver.stats().inheritedDropped, 0);

    // A caller that calls it and passes it on: kept with its call only, still incomplete.
    mode = 'mixed';
    const mixed = (await ask()).state;
    assert.equal(mixed.state, 'resolved');
    assert.equal(mixed.complete, false);
    assert.equal(mixed.reason, 'referenced-as-value');
    assert.equal(mixed.callers.length, 1);
    const [caller] = mixed.callers;
    assert.equal(caller.sites, 1);
    const mixedText = fs.readFileSync(mixedFile, 'utf8');
    assert.deepEqual(caller.callSites.map((/** @type {{ start: number, end: number }} */ s) => mixedText.slice(s.start, s.end + 1)), ['run(']);
    // Its update state comes from that call: a diff that edited the call's line (4) and not
    // the line passing it on (5) has updated it at the call. With the value use left in,
    // the untouched line 5 would read as a call not updated.
    const lineOfOffset = (/** @type {number} */ offset) => textpos.readLineOfOffset(mixedFile, offset);
    const updates = classifyCallSiteUpdates({ callSites: caller.callSites, changedLineRanges: [[4, 4]], lineOfOffset });
    assert.equal(classifyCallerUpdateState({ callSiteUpdates: updates, callerChanged: true }), 'updated-at-call');
    const valueSite = { start: mixedText.lastIndexOf('run'), end: mixedText.lastIndexOf('run') + 3 };
    const withValueUse = classifyCallSiteUpdates({ callSites: [caller.callSites[0], valueSite], changedLineRanges: [[4, 4]], lineOfOffset });
    assert.equal(classifyCallerUpdateState({ callSiteUpdates: withValueUse, callerChanged: true }), 'changed-elsewhere');

    // A file outside the active build: explained, incomplete, not retryable.
    mode = 'build-tags';
    const excluded = await ask();
    assert.deepEqual(excluded.state, { state: 'unknown', callers: [], complete: false, reason: NOT_IN_BUILD_REASON });
    const answer = await excluded.resolver.incomingWithStatus(target, namePos);
    assert.deepEqual(answer, { callers: [], complete: false, reason: NOT_IN_BUILD_REASON });
  } finally {
    Module._load = original;
    delete require.cache[require.resolve('../src/resolver-vscode')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
