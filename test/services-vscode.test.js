'use strict';
// The editor's LanguageServices (src/services-vscode.js) and the shared caller default
// built on them (src/languages/callers-from-hierarchy.js), over a stubbed command API:
// - a deadline that runs out and the outstanding-request cap reject, retryable;
// - while cold, caller queries go one at a time within a budget, and a new analysis
//   drops the ones still queued;
// - malformed answers, and base-side documents without a scratch folder, are "no answer",
//   never "nothing";
// - base-side symbols are asked through a temporary copy, removed even when the request
//   fails; a text above the limit is refused; stale leftovers are swept;
// - document symbols come back as offsets; an empty call hierarchy is "none" only when no
//   reference outside the declaration exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscodeStub = require('./vscode-stub');
const {
  createVscodeServices, sweepBaseCopies, MAX_OUTSTANDING_REQUESTS, MAX_BASE_TEXT_CHARS, STALE_BASE_COPY_MS,
} = require('../src/services-vscode');
const { callersFromHierarchy, queryHierarchy } = require('../src/languages/callers-from-hierarchy');
const { createFakeClock } = require('./fake-clock');

const flush = () => new Promise(setImmediate);
const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
};
const until = async (cond, what) => {
  for (let i = 0; i < 2000 && !cond(); i++) await flush();
  assert.ok(cond(), what);
};
/** `promise`, recording the fake clock's time when it settles (`at`, null until then). */
const timed = (clock, promise) => {
  const t = { at: null, value: undefined, error: undefined };
  t.done = promise.then((value) => { t.value = value; t.at = clock.now(); }, (error) => { t.error = error; t.at = clock.now(); });
  return t;
};

/** A repository with one source file; `answer(name, ...args)` plays the editor's commands. */
function setup(t, answer, text = 'export function target() {}\nexport function other() { target(); }\n') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-services-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.ts');
  fs.writeFileSync(file, text);
  const sent = [];
  const vscode = {
    Uri: vscodeStub.Uri,
    Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    commands: { executeCommand: async (name, ...args) => { sent.push(name); return answer(name, ...args); } },
  };
  const create = (options = {}) => createVscodeServices({ vscode, repoRoot: dir, ...options });
  return { dir, file, sent, create, doc: { file, side: 'head' } };
}

const range = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

test('a command past its deadline rejects as retryable, with the deadline in its reason', async (t) => {
  const clock = createFakeClock();
  const { create, doc } = setup(t, () => new Promise(() => {}));
  const services = create({ queryTimeoutMs: 20, clock });
  const asked = timed(clock, services.references(doc, 16));
  await clock.advance(19);
  assert.equal(asked.at, null, 'still waiting one millisecond before the deadline');
  await clock.advance(1);
  await asked.done;
  assert.equal(asked.at, 20, 'rejected at the deadline');
  assert.equal(asked.error.message, 'vscode.executeReferenceProvider timed out after 20 ms');
  assert.equal(asked.error.retryable, true);
  assert.equal(clock.pending(), 0);
});

test(`at most ${MAX_OUTSTANDING_REQUESTS} requests are outstanding; the next is refused, retryable, until one settles`, async (t) => {
  const pending = [];
  const { create, doc, sent } = setup(t, () => { const d = deferred(); pending.push(d); return d.promise; });
  const services = create({ queryTimeoutMs: 120000 });
  const admitted = [];
  for (let i = 0; i < MAX_OUTSTANDING_REQUESTS; i++) admitted.push(services.references(doc, 16));
  await until(() => sent.length === MAX_OUTSTANDING_REQUESTS, 'the first 32 reached the server');
  const refused = await services.references(doc, 16).then(() => null, (e) => e);
  assert.equal(refused.message, 'language server has 32 outstanding requests — retry when it responds');
  assert.equal(refused.retryable, true);
  assert.equal(sent.length, MAX_OUTSTANDING_REQUESTS, 'the refused request was never sent');
  pending[0].resolve([]);
  assert.deepEqual(await admitted[0], []);
  const next = services.references(doc, 16);
  await until(() => sent.length === MAX_OUTSTANDING_REQUESTS + 1, 'a settled request frees a place');
  pending[MAX_OUTSTANDING_REQUESTS].resolve([]);
  assert.deepEqual(await next, []);
  for (const d of pending.slice(1, MAX_OUTSTANDING_REQUESTS)) d.resolve([]);
  await Promise.all(admitted);
});

test('while cold, caller queries run one at a time; a new analysis drops a queued one unasked', async (t) => {
  const { create, doc, sent } = setup(t, (name) => (name === 'vscode.prepareCallHierarchy' ? [{}] : []));
  const services = create();
  const gate = deferred();
  const order = [];
  const first = services.callerQuery(async (scope) => { order.push('first'); await gate.promise; return scope.prepareCallHierarchy(doc, 7); });
  const second = services.callerQuery(async () => { order.push('second'); return 'second'; });
  await flush(); await flush();
  assert.deepEqual(order, ['first'], 'the second waits for the first');
  services.beginAnalysis();
  gate.resolve();
  assert.equal((await first).length, 1);
  const dropped = await second.then(() => null, (e) => e);
  assert.equal(dropped.message, 'caller query belongs to an earlier analysis');
  assert.notEqual(dropped.retryable, true);
  assert.deepEqual(order, ['first'], 'the dropped query asked nothing');
  assert.deepEqual(sent, ['vscode.prepareCallHierarchy']);
});

test('the cold phase ends with its budget: each cold query gets what is left, then queries are warm again', async (t) => {
  // A server that never has an item: not up.
  const { create, doc } = setup(t, (name) => (name === 'vscode.prepareCallHierarchy' ? [] : []));
  let retries = 0;
  // The server answers at once, so all the time is the polling waits: 250 ms, then what is
  // left of the query's deadline. The second query has only the 50 ms left of the budget.
  const clock = createFakeClock();
  const services = create({ coldQueryTimeoutMs: 300, coldBudgetMs: 350, retries: 0, onRetry: () => { retries++; }, clock });
  const first = timed(clock, queryHierarchy(services, doc, 7));
  await clock.advance(299);
  assert.equal(first.at, null, 'the first cold query is still polling before its deadline');
  await clock.advance(1);
  await first.done;
  assert.deepEqual(first.value, { ready: false, reason: 'language server not ready after 0 s', retryable: true });
  assert.equal(first.at, 300, 'the first cold query had its full deadline');
  assert.equal(retries, 2, 'asked at 0 and 250 ms');
  const second = timed(clock, queryHierarchy(services, doc, 7));
  await clock.advance(50);
  await second.done;
  assert.equal(second.value.retryable, true);
  assert.equal(second.at - 300, 50, 'the second had only what was left of the budget');
  // The budget is spent: the ordinary path, which with no retries gives up at once.
  const third = timed(clock, queryHierarchy(services, doc, 7));
  await clock.advance(0);
  await third.done;
  assert.deepEqual(third.value, { ready: false, reason: 'language server not ready', retryable: true });
  assert.equal(third.at, 350, 'without waiting');
  assert.ok(retries > 0);
  assert.equal(services.isWarm(), false);
  // A new analysis gets the whole budget again.
  services.beginAnalysis();
  const again = timed(clock, queryHierarchy(services, doc, 7));
  await clock.advance(300);
  await again.done;
  assert.equal(again.value.reason, 'language server not ready after 0 s');
  assert.equal(again.at - 350, 300);
  assert.equal(clock.pending(), 0, 'no timer left behind');
});

test('a server that is up with no item at the symbol gives "no call hierarchy item"', async (t) => {
  let up = false;
  const { create, doc } = setup(t, (name) => (name === 'vscode.prepareCallHierarchy' ? (up ? [] : [{}]) : []));
  const services = create();
  assert.equal((await queryHierarchy(services, doc, 7)).ready, true, 'a first answer makes the server warm');
  up = true;
  assert.deepEqual(await queryHierarchy(services, doc, 40), { ready: false, reason: 'no call hierarchy item', retryable: false });
});

test('without a scratch folder, base-side documents have no answer, and nothing is asked for them', async (t) => {
  const { create, file, sent } = setup(t, () => assert.fail('nothing is sent for the base side'));
  const services = create();
  const base = { file, side: 'base', text: 'export function target() {}\n' };
  assert.equal(await services.documentSymbols(base), null);
  assert.equal(await services.prepareCallHierarchy(base, 16), null);
  assert.equal(await services.references(base, 16), null);
  assert.equal(await services.implementations(base, 16), null);
  assert.equal(await services.definitions(base, 16), null);
  assert.equal(await services.callerQuery((scope) => scope.prepareCallHierarchy(base, 16)), null);
  assert.equal(await services.warmUp(base, 16, { timeoutMs: 10 }), false);
  assert.deepEqual(sent, []);
});

test('malformed answers are no answer, with the reasons the resolver has always given', async (t) => {
  let incoming = {};
  let refs = {};
  const { create, doc } = setup(t, (name) => {
    if (name === 'vscode.prepareCallHierarchy') return [{}];
    if (name === 'vscode.provideIncomingCalls') return incoming;
    if (name === 'vscode.executeReferenceProvider') return refs;
    return [];
  });
  const services = create();
  assert.deepEqual(await queryHierarchy(services, doc, 16), { ready: false, reason: 'no incoming-call result', retryable: false });
  assert.equal(services.isWarm(), false, 'a malformed answer does not prove the project is loaded');
  assert.deepEqual(await callersFromHierarchy(services, { doc, pos: 16 }),
    { state: 'unknown', callers: [], complete: false, reason: 'no incoming-call result' });
  incoming = [{ from: { name: 'caller' } }];          // a call without a place
  assert.equal((await queryHierarchy(services, doc, 16)).reason, 'no incoming-call result');
  incoming = [];
  assert.deepEqual(await callersFromHierarchy(services, { doc, pos: 16 }),
    { state: 'unknown', reason: 'no reference result', callers: [], complete: false });
  refs = [{ uri: { fsPath: doc.file } }];             // a location without a range
  assert.equal(await services.references(doc, 16), null);
});

test('document symbols come back as UTF-16 offsets with LSP kinds, children nested', async (t) => {
  const text = 'const s = "é😀";\nclass C {\n  m() {}\n}\n';
  const { create, doc } = setup(t, (name) => {
    assert.equal(name, 'vscode.executeDocumentSymbolProvider');
    return [
      { name: 's', detail: '', kind: 12, range: range(0, 0, 0, 16), selectionRange: range(0, 6, 0, 7), children: [] },
      { name: 'C', kind: 4, range: range(1, 0, 3, 1), selectionRange: range(1, 6, 1, 7),
        children: [{ name: 'm', detail: '()', kind: 5, range: range(2, 2, 2, 8), selectionRange: range(2, 2, 2, 3), children: [] }] },
    ];
  }, text);
  const symbols = await create().documentSymbols(doc);
  const line2 = text.indexOf('  m()');
  assert.deepEqual(symbols, [
    { name: 's', detail: '', kind: 13, range: { start: 0, end: 16 }, selectionRange: { start: 6, end: 7 }, children: [] },
    { name: 'C', detail: '', kind: 5, range: { start: 17, end: text.length - 1 }, selectionRange: { start: 23, end: 24 },
      children: [{ name: 'm', detail: '()', kind: 6, range: { start: line2 + 2, end: line2 + 8 }, selectionRange: { start: line2 + 2, end: line2 + 3 }, children: [] }] },
  ]);
  assert.equal(text.slice(symbols[0].range.start, symbols[0].range.end), 'const s = "é😀";');
  assert.equal(text.slice(symbols[1].children[0].selectionRange.start, symbols[1].children[0].selectionRange.end), 'm');
});

test('base-side symbols are asked through a temporary copy of the text, removed afterwards', async (t) => {
  // The base text differs from the file on disk: offsets must come from the text.
  const baseText = '// base\nexport function target() {}\n';
  let seen = null;
  const { create, file, dir } = setup(t, (name, uri) => {
    assert.equal(name, 'vscode.executeDocumentSymbolProvider');
    assert.notEqual(uri.fsPath, file, 'the head file on disk is not what is asked');
    seen = { path: uri.fsPath, exists: fs.existsSync(uri.fsPath), text: fs.readFileSync(uri.fsPath, 'utf8') };
    return [{ name: 'target', detail: '', kind: 11, range: range(1, 0, 1, 28), selectionRange: range(1, 16, 1, 22), children: [] }];
  });
  const scratchDir = path.join(dir, 'scratch');
  const services = create({ scratchDir });
  const symbols = await services.documentSymbols({ file, side: 'base', text: baseText });
  assert.equal(seen.exists, true, 'the copy exists while the server is asked');
  assert.equal(seen.text, baseText);
  assert.equal(path.basename(seen.path), 'a.ts', 'with the same file name');
  assert.equal(path.dirname(path.dirname(seen.path)), scratchDir, 'in its own subdirectory of the scratch folder');
  assert.ok(path.basename(path.dirname(seen.path)).startsWith('base-'));
  assert.equal(fs.existsSync(seen.path), false, 'and is removed afterwards');
  assert.deepEqual(fs.readdirSync(scratchDir), []);
  assert.deepEqual(symbols, [{ name: 'target', detail: '', kind: 12, range: { start: 8, end: 36 }, selectionRange: { start: 24, end: 30 }, children: [] }]);
  assert.equal(baseText.slice(symbols[0].selectionRange.start, symbols[0].selectionRange.end), 'target');
  // Other base-side questions still have no answer.
  assert.equal(await services.references({ file, side: 'base', text: baseText }, 24), null);
});

test('the temporary copy is removed when the request fails, and concurrent requests have their own', async (t) => {
  const asked = [];
  const pending = [];
  const { create, file, dir } = setup(t, (name, uri) => {
    asked.push(uri.fsPath);
    const d = deferred();
    pending.push(d);
    return d.promise;
  });
  // Whatever an assertion leaves unanswered is answered when the test ends, so a failure
  // reports at once instead of waiting out the 120 s deadline.
  t.after(() => { for (const d of pending) d.resolve([]); });
  const scratchDir = path.join(dir, 'scratch');
  const services = create({ scratchDir, coldQueryTimeoutMs: 120000 });
  const first = services.documentSymbols({ file, side: 'base', text: 'one\n' }).then(() => assert.fail('it failed'), (e) => e);
  const second = services.documentSymbols({ file, side: 'base', text: 'two\n' });
  await until(() => asked.length === 2, 'both were asked');
  // The two requests write their copies concurrently, so either may reach the editor first:
  // tell them apart by what their copy holds, not by order.
  const index = Object.fromEntries(asked.map((copy, i) => [fs.readFileSync(copy, 'utf8'), i]));
  const one = index['one\n'], two = index['two\n'];
  assert.deepEqual([one, two].sort(), [0, 1], 'each copy holds its own text');
  assert.notEqual(path.dirname(asked[one]), path.dirname(asked[two]), 'each request has its own subdirectory');
  pending[one].reject(new Error('the provider failed'));
  const error = await first;
  assert.equal(error.message, 'the provider failed');
  assert.equal(fs.existsSync(asked[one]), false, 'removed although the request failed');
  assert.equal(fs.existsSync(asked[two]), true, 'the other request still has its copy');
  pending[two].resolve([]);
  assert.deepEqual(await second, []);
  assert.deepEqual(fs.readdirSync(scratchDir), []);
});

test('a base text above the limit is refused with its size, before anything is written', async (t) => {
  const { create, file, dir, sent } = setup(t, () => assert.fail('nothing is asked'));
  const scratchDir = path.join(dir, 'scratch');
  const services = create({ scratchDir });
  const text = 'x'.repeat(MAX_BASE_TEXT_CHARS + 1);
  await assert.rejects(services.documentSymbols({ file, side: 'base', text }),
    { message: `its base version has ${MAX_BASE_TEXT_CHARS + 1} characters, above the ${MAX_BASE_TEXT_CHARS} a temporary copy may have` });
  assert.deepEqual(sent, []);
  assert.equal(fs.existsSync(scratchDir), false);
  // Exactly at the limit is asked.
  const atLimit = setup(t, () => []);
  assert.deepEqual(await atLimit.create({ scratchDir: path.join(atLimit.dir, 'scratch') })
    .documentSymbols({ file: atLimit.file, side: 'base', text: 'x'.repeat(MAX_BASE_TEXT_CHARS) }), []);
});

test('without a scratch folder base-side symbols have no answer; a relative one is refused', async (t) => {
  const { create, file, sent } = setup(t, () => assert.fail('nothing is asked'));
  assert.equal(await create().documentSymbols({ file, side: 'base', text: 'x' }), null);
  assert.deepEqual(sent, []);
  assert.throws(() => create({ scratchDir: 'relative/dir' }), /absolute path/);
});

test('leftover copies older than the sweep age are removed; fresh ones and other files stay', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['base-old', 'base-new', 'keep-old']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'a.go'), 'package a\n');
  }
  fs.writeFileSync(path.join(dir, 'base-file'), 'not a directory');
  const nowMs = Date.now();
  const old = new Date(nowMs - STALE_BASE_COPY_MS - 60000);
  fs.utimesSync(path.join(dir, 'base-old'), old, old);
  fs.utimesSync(path.join(dir, 'keep-old'), old, old);
  assert.equal(await sweepBaseCopies(dir, { nowMs }), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['base-file', 'base-new', 'keep-old']);
  assert.equal(await sweepBaseCopies(path.join(dir, 'missing')), 0, 'a missing folder is nothing to sweep');
});

test('an empty call hierarchy is "none" only when no reference lies outside the declaration', async (t) => {
  let refs = [];
  const { create, doc, dir } = setup(t, (name) => {
    if (name === 'vscode.prepareCallHierarchy') return [{}];
    if (name === 'vscode.provideIncomingCalls') return [];
    if (name === 'vscode.executeReferenceProvider') return refs;
    return [];
  });
  const services = create();
  const declaration = { uri: { fsPath: doc.file }, range: range(0, 16, 0, 22) };
  refs = [declaration];
  assert.deepEqual(await callersFromHierarchy(services, { doc, pos: 16 }), { state: 'none', callers: [], complete: true });
  refs = [declaration, { uri: { fsPath: doc.file }, range: range(1, 26, 1, 32) }];
  assert.deepEqual(await callersFromHierarchy(services, { doc, pos: 16 }),
    { state: 'unknown', reason: 'referenced-as-value', callers: [], complete: false });
  refs = [declaration, { uri: { fsPath: path.join(dir, 'b.ts') }, range: range(0, 0, 0, 6) }];
  assert.equal((await callersFromHierarchy(services, { doc, pos: 16 })).reason, 'referenced-as-value',
    'a reference in a file that cannot be read still counts as a use');
  refs = [declaration];
  assert.deepEqual(await callersFromHierarchy(services, { doc, pos: 16, unseenUsers: async () => 'used where the server cannot see' }),
    { state: 'unknown', reason: 'used where the server cannot see', callers: [], complete: false });
  assert.deepEqual(await callersFromHierarchy(services, { doc, pos: 16, isConstructor: true }), { state: 'di', callers: [], complete: true });
});

test('callers are rows with offsets, deduplicated, and test callers marked', async (t) => {
  const { create, doc, dir } = setup(t, (name) => {
    if (name === 'vscode.prepareCallHierarchy') return [{}];
    if (name === 'vscode.provideIncomingCalls') {
      const from = { uri: { fsPath: doc.file }, name: 'other', detail: 'mod', selectionRange: { start: { line: 1, character: 16 } } };
      return [{ from, fromRanges: [range(1, 26, 1, 32)] }, { from, fromRanges: [] },
        { from: { uri: { fsPath: path.join(dir, 'a.test.ts') }, name: 't', selectionRange: range(0, 0, 0, 1) }, fromRanges: [] }];
    }
    return [];
  });
  fs.writeFileSync(path.join(dir, 'a.test.ts'), 't();\n');
  const services = create();
  const callers = await callersFromHierarchy(services, { doc, pos: 16 });
  const line1 = 'export function target() {}\n'.length;
  assert.deepEqual(callers, { state: 'resolved', complete: true, callers: [
    { label: 'mod.other', file: doc.file, pos: line1 + 16, test: false, sites: 1, callSites: [{ start: line1 + 26, end: line1 + 32 }] },
    { label: 't', file: path.join(dir, 'a.test.ts'), pos: 0, test: true, sites: 0, callSites: [] },
  ] });
  assert.deepEqual((await callersFromHierarchy(services, { doc, pos: 16, withTests: false })).callers.map((c) => c.label), ['mod.other']);
  assert.equal(services.isWarm(), true);
});

// VS Code's executeDocumentSymbolProvider answers objects with both forms: a `location`
// holding the whole declaration, and the hierarchical `range` / `selectionRange`. The name
// callers are asked at is `selectionRange`; reading `location` put it at `func`.
test('document symbols in VS Code\'s merged form take the name from selectionRange, not the location', async (t) => {
  const text = 'package a\n\nfunc Target() {}\n';
  const { create, doc } = setup(t, () => [{
    name: 'Target', detail: 'func()', kind: 11,
    location: { uri: { fsPath: 'ignored' }, range: range(2, 0, 2, 16) },
    range: range(2, 0, 2, 16), selectionRange: range(2, 5, 2, 11), children: [],
  }], text);
  const [symbol] = await create().documentSymbols(doc);
  assert.equal(text.slice(symbol.selectionRange.start, symbol.selectionRange.end), 'Target');
  assert.equal(text.slice(symbol.range.start, symbol.range.end), 'func Target() {}');
  assert.equal(symbol.kind, 12, 'LSP Function');
});

// While a language's extension is still starting its server, VS Code answers `undefined`
// (no provider yet). That is "not ready", not "no symbols".
test('document symbols are asked again while the server starts, then an empty answer means none', async (t) => {
  const symbol = { name: 'f', kind: 11, range: range(0, 0, 0, 5), selectionRange: range(0, 0, 0, 1), children: [] };
  let listFrom = 3;
  const { create, doc, sent } = setup(t, () => (sent.length < listFrom ? undefined : [symbol]), 'f() {}\n');
  let retries = 0;
  const clock = createFakeClock();
  const services = create({ onRetry: () => { retries++; }, clock });
  const listed = timed(clock, services.documentSymbols(doc));
  await clock.advance(250);
  assert.equal(sent.length, 2, 'asked again after 250 ms');
  assert.equal(listed.at, null);
  await clock.advance(500);
  await listed.done;
  assert.equal(listed.value.length, 1, 'the third answer is the list');
  assert.equal(listed.at, 750, 'after waiting 250 ms, then 500 ms');
  assert.equal(sent.length, 3);
  assert.equal(retries, 2);
  listFrom = Infinity;
  assert.deepEqual(await services.documentSymbols(doc), [], 'once a list has come, undefined is no symbols');
  assert.equal(sent.length, 4, 'asked once, not polled');
});

test('a server that never lists symbols within the cold deadline is reported, retryable, not as no symbols', async (t) => {
  const { create, doc } = setup(t, () => undefined, 'f() {}\n');
  const clock = createFakeClock();
  const services = create({ coldQueryTimeoutMs: 300, clock });
  const asked = timed(clock, services.documentSymbols(doc));
  await clock.advance(299);
  assert.equal(asked.at, null, 'still asking before the deadline');
  await clock.advance(1);
  await asked.done;
  assert.equal(asked.at, 300, 'gave up at the deadline');
  assert.match(asked.error.message, /listed no symbols within 0 s; it may still be starting/);
  assert.equal(asked.error.retryable, true);
  assert.equal(clock.pending(), 0);
});
