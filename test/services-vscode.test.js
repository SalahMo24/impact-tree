'use strict';
// The editor's LanguageServices (src/services-vscode.js) and the shared caller default
// built on them (src/languages/callers-from-hierarchy.js), over a stubbed command API:
// - a deadline that runs out and the outstanding-request cap reject, retryable;
// - while cold, caller queries go one at a time within a budget, and a new analysis
//   drops the ones still queued;
// - base-side documents and malformed answers are "no answer", never "nothing";
// - document symbols come back as offsets; an empty call hierarchy is "none" only when no
//   reference outside the declaration exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscodeStub = require('./vscode-stub');
const { createVscodeServices, MAX_OUTSTANDING_REQUESTS } = require('../src/services-vscode');
const { callersFromHierarchy, queryHierarchy } = require('../src/languages/callers-from-hierarchy');

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
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { create, doc } = setup(t, () => new Promise(() => {}));
  const services = create({ queryTimeoutMs: 20 });
  const asked = services.references(doc, 16).then(() => assert.fail('a stalled server must not answer'), (e) => e);
  await flush();
  t.mock.timers.tick(20);
  const error = await asked;
  assert.equal(error.message, 'vscode.executeReferenceProvider timed out after 20 ms');
  assert.equal(error.retryable, true);
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
  // The second query has 50 ms of budget left against a 300 ms deadline, so the bound below
  // has a wide margin: it fails only if the second query is given the full deadline, not
  // when a busy machine runs slowly.
  const services = create({ coldQueryTimeoutMs: 300, coldBudgetMs: 350, retries: 0, onRetry: () => { retries++; } });
  const started = Date.now();
  const first = await queryHierarchy(services, doc, 7);
  assert.deepEqual(first, { ready: false, reason: 'language server not ready after 0 s', retryable: true });
  assert.ok(Date.now() - started >= 300, 'the first cold query had its full deadline');
  const secondStarted = Date.now();
  const second = await queryHierarchy(services, doc, 7);
  assert.equal(second.retryable, true);
  assert.ok(Date.now() - secondStarted < 250, 'the second had only what was left of the budget');
  // The budget is spent: the ordinary path, which with no retries gives up at once.
  assert.deepEqual(await queryHierarchy(services, doc, 7), { ready: false, reason: 'language server not ready', retryable: true });
  assert.ok(retries > 0);
  assert.equal(services.isWarm(), false);
  // A new analysis gets the whole budget again.
  services.beginAnalysis();
  const again = await queryHierarchy(services, doc, 7);
  assert.equal(again.reason, 'language server not ready after 0 s');
});

test('a server that is up with no item at the symbol gives "no call hierarchy item"', async (t) => {
  let up = false;
  const { create, doc } = setup(t, (name) => (name === 'vscode.prepareCallHierarchy' ? (up ? [] : [{}]) : []));
  const services = create();
  assert.equal((await queryHierarchy(services, doc, 7)).ready, true, 'a first answer makes the server warm');
  up = true;
  assert.deepEqual(await queryHierarchy(services, doc, 40), { ready: false, reason: 'no call hierarchy item', retryable: false });
});

test('base-side documents have no answer yet, and nothing is asked for them', async (t) => {
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
