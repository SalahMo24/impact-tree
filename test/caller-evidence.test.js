'use strict';
// What a caller row and a finding row may claim. Two sets of evidence reach them:
//   - call sites: a caller that edited one call and left another is not updated;
//   - coverage: callers found by a search that did not finish are not "all updated".
// Both are checked through the public pipelines, adapters and tree, not their internals.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');
const ts = require('typescript');
const vscodeStub = require('./vscode-stub');
const { analyze } = require('../src/engine/analyze');
const { createTreeProvider } = require('../src/tree-provider');
const { createDecorationProvider } = require('../src/decorations');
const { createSyntacticIndex } = require('../src/engine/syntactic-index');
const { createSyntacticResolver } = require('../src/engine/resolver-syntactic');
const { createTsResolver } = require('../src/engine/resolver-ts');
const { withModuleCallers } = require('../src/engine/module-callers');
const { registerVirtualText, clearVirtualText } = require('../src/engine/textpos');

const REMOTE_ROOT = '/review';

// ---- call sites ------------------------------------------------------------------------
// Four callers of `target`, which gains a parameter. Calls are on separate lines so each
// one can be edited or left alone.
const CALLERS_BASE = [
  'import { target } from "./a";',
  'export function mixed() {',
  '  const first = target(1);',
  '  const gap = 0;',
  '  return first + gap + target(2);',
  '}',
  'export function mixedLate() {',
  '  const first = target(1);',
  '  const gap = 0;',
  '  return first + gap + target(2);',
  '}',
  'export function allUpdated() {',
  '  const first = target(1);',
  '  const gap = 0;',
  '  return first + gap + target(2);',
  '}',
  'export function untouched() {',
  '  return target(3);',
  '}',
  '',
];
// mixed: first call edited. mixedLate: second call edited. allUpdated: both edited.
const editLines = (lines, edited) => lines.map((l, i) => (edited.includes(i + 1) ? l.replace(/\)/, ', 5)') : l));
const CALLERS_HEAD = editLines(CALLERS_BASE, [3, 10, 13, 15]);
const EXPECTED_STATES = {
  mixed: 'changed-elsewhere', mixedLate: 'changed-elsewhere', allUpdated: 'updated-at-call', untouched: 'unchanged',
};
const callStates = (target) => Object.fromEntries(target.callers.map((c) => [c.label, c.callState]));

function assertMixedCallersAreStale(target) {
  assert.deepEqual(callStates(target), EXPECTED_STATES);
  assert.deepEqual(target.stale.map((c) => c.label).sort(), ['mixed', 'mixedLate', 'untouched']);
  assert.equal(target.staleCallers, 3);
  assert.equal(target.staleChangedElsewhere, 2);
  const byLabel = Object.fromEntries(target.callers.map((c) => [c.label, c.callSiteUpdates]));
  assert.deepEqual(['mixed', 'mixedLate', 'allUpdated', 'untouched'].map((l) => {
    const u = byLabel[l];
    return [u.updated.length, u.untouched.length, u.unknown.length];
  }), [[1, 1, 0], [1, 1, 0], [2, 0, 0], [0, 1, 0]]);
}

test('local analysis: a caller with an edited and an untouched call is stale', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-callsites-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  try {
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    write('tsconfig.json', JSON.stringify({ include: ['src'] }));
    write('.gitignore', 'node_modules\n');
    write('src/a.ts', 'export function target(n: number) { return n; }\n');
    write('src/b.ts', CALLERS_BASE.join('\n'));
    git('add', '-A'); git('commit', '-qm', 'base');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(repo, 'node_modules', 'typescript'));
    write('src/a.ts', 'export function target(n: number, m = 0) { return n + m; }\n');
    write('src/b.ts', CALLERS_HEAD.join('\n'));

    const r = await analyze(repo, { mode: 'working', skipForest: true, deferTestReach: true });
    assertMixedCallersAreStale(r.allChanged.find((c) => c.label === 'target'));
    assert.equal(r.findings.find((c) => c.label === 'target').staleCallers, 3, 'the finding counts them');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('PR preview: a caller with an edited and an untouched call is stale', async () => {
  clearVirtualText();
  const { analyzeRemote } = require('../src/engine/analyze-remote');
  const hunk = (line) => `@@ -${line} +${line} @@\n-old\n+new`;
  const texts = {
    'lib/target.ts@base': 'export function target() { return 0; }\n',
    'lib/target.ts@head': 'export function target(required: string) { return 1; }\n',
    'lib/use.ts@base': CALLERS_BASE.join('\n'),
    'lib/use.ts@head': CALLERS_HEAD.join('\n'),
  };
  // use.ts imports from "./a"; the preview file is lib/a.ts
  texts['lib/a.ts@base'] = texts['lib/target.ts@base'];
  texts['lib/a.ts@head'] = texts['lib/target.ts@head'];
  const patches = { 'lib/a.ts': hunk(1), 'lib/use.ts': [3, 10, 13, 15].map(hunk).join('\n') };
  const gh = {
    listPullRequestFiles: async () => ({ total: 2, files: ['lib/a.ts', 'lib/use.ts'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch: patches[p] })) }),
    fileAtRef: async (_, p, ref) => texts[`${p}@${ref}`] ?? null,
  };
  try {
    const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 2, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: REMOTE_ROOT });
    const target = r.allChanged.find((c) => c.label === 'target');
    assertMixedCallersAreStale(target);
    assert.equal(r.findings.find((c) => c.label === 'target').staleCallers, 3);
  } finally { clearVirtualText(); }
});

// ---- the view of a mixed caller --------------------------------------------------------
// Real session wiring (state.classifyCallSiteUpdates comes from the result's changedRanges),
// over virtual text so nothing is read from disk.
function withVscodeModule(stub, fn) {
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
  delete require.cache[require.resolve('../src/resolver-vscode')];
  delete require.cache[require.resolve('../src/session')];
  try { return fn(); } finally {
    Module._load = original;
    delete require.cache[require.resolve('../src/resolver-vscode')];
    delete require.cache[require.resolve('../src/session')];
  }
}

test('tree: a mixed caller expands as not updated and says how many calls were', () => {
  const repo = '/review';
  const file = path.join(repo, 'src/use.ts');
  const text = CALLERS_HEAD.join('\n');
  const siteOf = (fn, nth) => {
    const from = text.indexOf(`function ${fn}`);
    const start = text.indexOf('target(', from) + (nth ? text.slice(text.indexOf('target(', from) + 1).indexOf('target(') + 1 : 0);
    return { start, end: start + 'target'.length };
  };
  const callers = ['mixed', 'allUpdated', 'untouched'].map((fn) => ({
    label: fn, file, pos: text.indexOf(`function ${fn}`) + 9, test: false,
    callSites: fn === 'untouched' ? [siteOf(fn, 0)] : [siteOf(fn, 0), siteOf(fn, 1)],
  })).map((c) => ({ ...c, sites: c.callSites.length }));
  const stub = { ...vscodeStub, workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
  return withVscodeModule(stub, async () => {
    registerVirtualText(file, text);
    try {
      const { createSession } = require('../src/session');
      const session = createSession(stub, { log() {}, review: null });
      const changedRanges = { 'src/use.ts': [[3, 3], [13, 13], [15, 15]] };
      session.viewStateFromResult({ allChanged: callers.map((c) => ({ file: c.file, namePos: c.pos })), changedPaths: [], changedRanges }, repo);
      const provider = createTreeProvider(stub, {
        getState: () => session.state,
        resolver: { incomingWithStatus: async () => ({ callers, complete: true }) },
        decorate: createDecorationProvider(stub),
      });
      const [group] = await provider.getChildren({ type: 'finding', file: '/review/src/a.ts', pos: 1 });
      assert.equal(group.type, 'callerFile');
      const rows = Object.fromEntries(group.callers.map((c) => [c.label, c]));
      assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([l, c]) => [l, c.callState])),
        { mixed: 'changed-elsewhere', allUpdated: 'updated-at-call', untouched: 'changed-elsewhere' });
      assert.equal(rows.mixed.callSiteUpdates.updated.length, 1);
      assert.equal(rows.mixed.callSiteUpdates.untouched.length, 1);
      assert.match(provider.getTreeItem(rows.mixed).tooltip.value, /1 of 2 call sites updated/);
      assert.doesNotMatch(provider.getTreeItem(rows.allUpdated).tooltip.value, /call sites updated/, 'fully updated: nothing to qualify');
      assert.doesNotMatch(provider.getTreeItem(rows.untouched).tooltip.value, /call sites updated/, 'no call updated: nothing to count');
    } finally { clearVirtualText(); }
  });
});

// ---- caller completeness: every adapter's callerState ----------------------------------
test('TypeScript resolver: callerState says whether every service answered', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-ts-complete-')));
  try {
    const files = {
      'tsconfig.json': '{"include":["a.ts","b.ts"]}',
      'tsconfig.test.json': '{"include":["a.ts"]}',
      'a.ts': 'export function target() {}\nexport function lonely() {}\nexport function other() {}\n',
      'b.ts': "import { target } from './a'; export function caller() { target(); }\n",
    };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const file = path.join(dir, 'a.ts');
    const at = (name) => files['a.ts'].indexOf(`function ${name}`) + 'function '.length;
    // The real compiler, with the second project's service (the test program) failing on demand.
    let failing = false, created = 0;
    const flaky = { ...ts, createLanguageService: (...a) => {
      const ls = ts.createLanguageService(...a);
      if (created++ === 1) {
        const real = ls.provideCallHierarchyIncomingCalls.bind(ls);
        ls.provideCallHierarchyIncomingCalls = (...args) => { if (failing) throw new Error('test program crashed'); return real(...args); };
      }
      return ls;
    } };
    const resolver = createTsResolver(flaky, dir, { filterInherited: false });
    assert.equal(created, 2, 'the fixture has a production and a test program');

    failing = true;
    const partial = await resolver.callerState(file, at('target'));
    assert.deepEqual([partial.state, partial.complete, partial.reason], ['resolved', false, 'query-failed']);
    assert.deepEqual(partial.callers.map((c) => c.label), ['caller']);

    failing = false;
    const whole = await resolver.callerState(file, at('target'));
    assert.deepEqual([whole.state, whole.complete, whole.reason], ['resolved', true, undefined]);
    const none = await resolver.callerState(file, at('lonely'));
    assert.deepEqual([none.state, none.complete, none.reason], ['none', true, undefined]);

    failing = true;
    const crashed = await resolver.callerState(file, at('other'));
    assert.deepEqual([crashed.state, crashed.complete, crashed.reason], ['unknown', false, 'query-failed']);
    resolver.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('syntactic resolver: callerState passes the index answer through, scoped to the PR files', async () => {
  const idx = createSyntacticIndex(ts, [
    { path: '/review/t.ts', text: 'export function target() {}\nexport class Svc { constructor() {} }\nexport function lonely() {}' },
    { path: '/review/c.ts', text: "import { target } from './t'; export function caller() { target(); }" },
  ], { baseDirs: ['/review'] });
  const resolver = createSyntacticResolver(idx);
  const at = (name) => 'export function target() {}\nexport class Svc { constructor() {} }\nexport function lonely() {}'.indexOf(name);
  const found = await resolver.callerState('/review/t.ts', at('target'));
  assert.deepEqual([found.state, found.complete, found.reason], ['resolved', true, undefined]);
  // Finding nothing in the PR files is not finding nothing: callers may sit in files the PR does not touch.
  const scoped = await resolver.callerState('/review/t.ts', at('lonely'));
  assert.deepEqual([scoped.state, scoped.complete, scoped.reason], ['unknown', false, 'pr-files-only']);
  const constructed = await resolver.callerState('/review/t.ts', at('constructor'), { isConstructor: true });
  assert.deepEqual([constructed.state, constructed.complete, constructed.reason], ['di', false, 'pr-files-only']);
  const missing = await resolver.callerState('/review/t.ts', 9999);
  assert.deepEqual([missing.state, missing.complete, missing.reason], ['unknown', false, 'symbol not found in the PR index']);
});

test('editor resolver: callerState keeps the completeness of the answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-vscode-complete-'));
  const file = path.join(dir, 'a.ts'); fs.writeFileSync(file, 'function target() {}');
  const caller = path.join(dir, 'b.ts'); fs.writeFileSync(caller, 'function user() { target(); }');
  const cqrsId = require.resolve('../src/engine/edges-cqrs');
  const realCqrs = require.cache[cqrsId];
  let mode = 'ok', cqrsFails = false;
  const incoming = [{ from: { uri: { fsPath: caller }, name: 'user', selectionRange: { start: { line: 0, character: 9 } } },
    fromRanges: [{ start: { line: 0, character: 16 }, end: { line: 0, character: 22 } }] }];
  const stub = { ...vscodeStub, Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    commands: { executeCommand: async (name) => {
      if (mode === 'down') throw Error('server down');
      if (name === 'vscode.prepareCallHierarchy') return [{}];
      if (name === 'vscode.provideIncomingCalls') return mode === 'found' ? incoming : [];
      if (name === 'vscode.executeReferenceProvider') return [{ uri: { fsPath: file }, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } } }];
    } } };
  const fakeCqrs = new Module(cqrsId); fakeCqrs.loaded = true;
  fakeCqrs.exports = { makeCqrsEdges: () => ({ isHandlerExecute: () => false,
    extraCallers: async () => { if (cqrsFails) throw new Error('index unavailable'); return []; } }) };
  require.cache[cqrsId] = fakeCqrs;
  try {
    await withVscodeModule(stub, async () => {
      const { createVscodeResolver } = require('../src/resolver-vscode');
      const answer = async () => {
        const cs = await createVscodeResolver({ repoRoot: dir, retries: 0, ts, filterInherited: false }).callerState(file, 9);
        return [cs.state, cs.complete, cs.reason];
      };
      mode = 'found';
      assert.deepEqual(await answer(), ['resolved', true, undefined]);
      cqrsFails = true;
      const [state, complete, reason] = await answer();
      assert.deepEqual([state, complete], ['resolved', false], 'callers were found, but the command-bus lookup failed');
      assert.match(reason, /command-bus callers unavailable — index unavailable/);
      cqrsFails = false;
      mode = 'ok';
      assert.deepEqual(await answer(), ['none', true, undefined]);
      mode = 'down';
      const [downState, downComplete, downReason] = await answer();
      assert.deepEqual([downState, downComplete, typeof downReason], ['unknown', false, 'string']);
    });
  } finally {
    if (realCqrs) require.cache[cqrsId] = realCqrs; else delete require.cache[cqrsId];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('module-caller wrapper: complete only when both the wrapped answer and the module index are', async () => {
  const found = { file: '/r/own.ts', pos: 1, label: 'own' }, viaModule = { file: '/r/mod.ts', pos: 2, label: 'mod' };
  const wrap = (own, extra) => withModuleCallers(
    { callerState: async () => own },
    { appliesTo: () => ({}), incomingWithStatus: async () => extra });
  const run = async (own, extra) => {
    const cs = await wrap(own, extra).callerState('/r/t.ts', 0, {});
    return [cs.state, cs.callers.map((c) => c.label), cs.complete, cs.reason];
  };
  const resolvedOwn = (complete, reason) => ({ state: 'resolved', callers: [found], complete, ...(reason && { reason }) });
  const noneOwn = (complete, reason) => ({ state: complete ? 'none' : 'unknown', callers: [], complete, ...(reason && { reason }) });
  const extra = (callers, complete, reason) => ({ callers, complete, ...(reason && { reason }) });

  assert.deepEqual(await run(resolvedOwn(true), extra([viaModule], true)), ['resolved', ['own', 'mod'], true, undefined]);
  assert.deepEqual(await run(resolvedOwn(false, 'query-failed'), extra([viaModule], true)), ['resolved', ['own', 'mod'], false, 'query-failed']);
  assert.deepEqual(await run(resolvedOwn(true), extra([viaModule], false, 'index truncated')), ['resolved', ['own', 'mod'], false, 'index truncated']);
  assert.deepEqual(await run(resolvedOwn(false, 'query-failed'), extra([], false, 'index truncated')), ['resolved', ['own'], false, 'query-failed']);
  assert.deepEqual(await run(noneOwn(true), extra([viaModule], true)), ['resolved', ['mod'], true, undefined]);
  assert.deepEqual(await run(noneOwn(true), extra([], true)), ['none', [], true, undefined]);
  assert.deepEqual(await run(noneOwn(true), extra([], false, 'index truncated')), ['unknown', [], false, 'index truncated']);
  assert.deepEqual(await run(noneOwn(false, 'query-failed'), extra([], true)), ['unknown', [], false, 'query-failed']);
  // a file the module index does not serve is the wrapped answer, untouched
  const bypass = withModuleCallers({ callerState: async () => resolvedOwn(false, 'query-failed') },
    { appliesTo: () => null, incomingWithStatus: async () => assert.fail('not asked') });
  assert.deepEqual(await bypass.callerState('/r/t.ts', 0, {}), resolvedOwn(false, 'query-failed'));
});

// ---- caller completeness: the pipelines -----------------------------------------------
test('local analysis records whether each symbol\'s callers are complete', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-complete-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  try {
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    write('tsconfig.json', JSON.stringify({ include: ['src'] }));
    write('.gitignore', 'node_modules\n');
    write('src/a.ts', 'export function partial(n: number) { return n; }\nexport function whole(n: number) { return n; }\nexport function broken(n: number) { return n; }\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(repo, 'node_modules', 'typescript'));
    write('src/a.ts', 'export function partial(n: number, m = 0) { return n; }\nexport function whole(n: number, m = 0) { return n; }\nexport function broken(n: number, m = 0) { return n; }\n');
    const callers = [{ label: 'user', file: path.join(repo, 'src/b.ts'), pos: 0, test: false, sites: 0, callSites: [] }];
    const answers = {
      partial: { state: 'resolved', callers, complete: false, reason: 'command-bus callers unavailable' },
      whole: { state: 'resolved', callers, complete: true },
      broken: null,
    };
    const resolver = {
      callerState: async (file, pos) => {
        const name = /function (\w+)/.exec(fs.readFileSync(file, 'utf8').slice(pos - 9))[1];
        if (!answers[name]) throw new Error('language server crashed');
        return answers[name];
      },
      incoming: async () => [], stats: () => ({}), dispose() {},
    };
    const r = await analyze(repo, { mode: 'working', skipForest: true, deferTestReach: true, makeResolver: () => resolver });
    const of = (label) => r.allChanged.find((c) => c.label === label);
    assert.deepEqual([of('partial').callerState, of('partial').callersComplete, of('partial').callersIncompleteReason],
      ['resolved', false, 'command-bus callers unavailable']);
    assert.deepEqual([of('whole').callerState, of('whole').callersComplete, of('whole').callersIncompleteReason], ['resolved', true, null]);
    assert.deepEqual([of('broken').callerState, of('broken').callersComplete, of('broken').callersIncompleteReason],
      ['unknown', false, 'language server crashed']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('PR preview records whether each symbol\'s callers are complete', async () => {
  const id = require.resolve('../src/engine/resolver-syntactic');
  const remoteId = require.resolve('../src/engine/analyze-remote');
  const realSyntactic = require.cache[id];
  const fake = new Module(id); fake.loaded = true;
  const callers = [{ label: 'user', file: '/review/lib/use.ts', pos: 0, test: false, sites: 0, callSites: [] }];
  let answer;
  fake.exports = { createSyntacticResolver: () => ({ callerState: async () => answer, stats: () => ({}) }) };
  require.cache[id] = fake;
  delete require.cache[remoteId];
  try {
    const { analyzeRemote } = require('../src/engine/analyze-remote');
    const gh = {
      listPullRequestFiles: async () => ({ total: 1, files: [{ path: 'lib/t.ts', oldPath: 'lib/t.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }] }),
      fileAtRef: async (_, p, ref) => (ref === 'base' ? 'export function target() {}\n' : 'export function target(required: string) {}\n'),
    };
    const run = async (resolved) => {
      answer = resolved; clearVirtualText();
      const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 2, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: REMOTE_ROOT });
      const t = r.allChanged.find((c) => c.label === 'target');
      return [t.callerState, t.callersComplete, t.callersIncompleteReason];
    };
    assert.deepEqual(await run({ state: 'resolved', callers, complete: false, reason: 'partial index' }), ['resolved', false, 'partial index']);
    assert.deepEqual(await run({ state: 'resolved', callers, complete: true }), ['resolved', true, null]);
    assert.deepEqual(await run({ state: 'unknown', callers: [], complete: false, reason: 'symbol not found in the PR index' }),
      ['unknown', false, 'symbol not found in the PR index']);
  } finally {
    clearVirtualText();
    if (realSyntactic) require.cache[id] = realSyntactic; else delete require.cache[id];
    delete require.cache[remoteId];
  }
});

// ---- caller completeness: what the finding row claims ----------------------------------
test('finding rows never read as fully updated when the caller search was incomplete', () => {
  const provider = createTreeProvider(vscodeStub, { getState: () => ({ rowDetail: 'hover' }), resolver: {} });
  const row = (finding) => ({ type: 'finding', label: 'target', file: '/review/t.ts', pos: 1,
    finding: { label: 'target', relPath: 't.ts', startLine: 1, component: '(root)', kinds: [{ id: 'param', short: 'param' }],
      callerState: 'resolved', staleCallers: 0, stale: [], throwsAdded: [], score: 1, ...finding } });
  const item = (finding) => provider.getTreeItem(row(finding));

  const complete = item({ callersComplete: true });
  assert.equal(complete.description, '✓');
  assert.match(complete.tooltip.value, /Every caller was updated/);
  const oldShape = item({});
  assert.equal(oldShape.description, '✓', 'a result without the field is read as complete');
  assert.match(oldShape.tooltip.value, /Every caller was updated/);

  const incomplete = item({ callersComplete: false, callersIncompleteReason: 'command-bus callers unavailable' });
  assert.equal(incomplete.description, '?');
  assert.doesNotMatch(incomplete.tooltip.value, /Every caller was updated/);
  assert.match(incomplete.tooltip.value, /callers found so far are updated, but more may be missing/);
  assert.match(incomplete.tooltip.value, /command-bus callers unavailable/);
  assert.equal(item({ callersComplete: false, callersIncompleteReason: null }).description, '?', 'a missing reason does not hide it');

  const staleCallers = [{ label: 'a', callState: 'unchanged' }, { label: 'b', callState: 'unchanged' }];
  const stale = item({ callersComplete: false, callersIncompleteReason: 'query-failed', staleCallers: 2, stale: staleCallers, callers: staleCallers });
  assert.equal(stale.description, '⛔');
  assert.match(stale.tooltip.value, /2 of 2 callers were not changed on the call line/);
  assert.match(stale.tooltip.value, /More callers may be missing/);
  assert.match(stale.tooltip.value, /query-failed/);
  assert.doesNotMatch(item({ staleCallers: 2, stale: [{ label: 'a' }, { label: 'b' }], callersComplete: true }).tooltip.value, /may be missing/);

  // the other states already say they are not an answer; completeness does not rewrite them
  assert.match(item({ callerState: 'none', callersComplete: true }).tooltip.value, /Nothing calls it/);
  assert.match(item({ callerState: 'unknown', callersComplete: false }).tooltip.value, /callers could not be found/);
});

test('an incomplete finding ranks as a warning inside a group, never as ok', async () => {
  const change = (label, extra) => ({ file: '/repo/src/x.js', relPath: 'src/x.js', label, namePos: label.length, start: label.length * 10, end: label.length * 10 + 5,
    startLine: 1, component: '(root)', kinds: [{ id: 'body', label: 'body' }], throwsAdded: [], callers: [], stale: [], staleCallers: 0,
    callerState: 'resolved', score: 1, ...extra });
  // a risky kind: a body-only change with callers leads with ●, so only a risky one can show the warning
  const partial = change('partial', { kinds: [{ id: 'param', label: 'param' }], callersComplete: false, callersIncompleteReason: 'query-failed' });
  const fine = change('fine', { callersComplete: true });
  const result = { allChanged: [fine, partial], findings: [], deleted: [], warnings: [], unanalysable: [], otherFiles: [], untested: [],
    mode: 'working', base: { ref: 'HEAD', sha: '0' }, testReachComputed: true };
  const provider = createTreeProvider(vscodeStub, { getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/repo/', '') }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) } });
  const sections = await provider.getChildren();
  const [fileRow] = await provider.getChildren(sections.find((s) => s.key === 'other'));
  assert.equal(fileRow.type, 'changeFile');
  assert.ok(provider.getTreeItem(fileRow).description.startsWith('?'), 'the group leads with its worst member');
});
