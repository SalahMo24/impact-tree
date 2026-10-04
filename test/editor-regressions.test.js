'use strict';
// Editor resolver, tree messages, readiness, and command-level preview regressions.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createTreeProvider } = require('../src/tree-provider');
const { clearVirtualText } = require('../src/engine/textpos');
const { ts, root, response } = require('./bug-regressions-helpers');

test('editor commands refresh the selected PR, preserve preview documents, and restore workspace checkpoints', async () => {
  const Module = require('module');
  const originalLoad = Module._load, originalFetch = global.fetch;
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-editor-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const state = new Map(), commands = new Map(), providers = new Map(), errors = [], diffs = [], updates = [];
  const baseStub = require('./vscode-stub');
  let head = 'h1', quickPick = { id: 'preview' }, tickListener;
  const cfg = { get: (name, fallback) => ({ prewarm: false, analyseOnStartup: false, fetchBase: false })[name] ?? fallback,
    update: async (...args) => updates.push(args) };
  const disposable = () => ({ dispose() {} });
  const stub = { ...baseStub, ConfigurationTarget: { Workspace: 2 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(...args) { this.args = args; } },
    authentication: { getSession: async () => ({ accessToken: 'test' }) },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {}, show() {} }),
      registerFileDecorationProvider: disposable,
      createTreeView: () => ({ dispose() {}, onDidChangeCheckboxState: (fn) => { tickListener = fn; return disposable(); } }),
      withProgress: async (_, fn) => fn({ report() {} }),
      showQuickPick: async () => quickPick,
      showWarningMessage: async () => undefined,
      showErrorMessage: (e) => errors.push(e), showInformationMessage() {}, setStatusBarMessage() {},
      visibleTextEditors: [],
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); },
      executeCommand: async (name, ...args) => {
        if (name === 'vscode.prepareCallHierarchy') return [{}];
        if (name === 'vscode.provideIncomingCalls' || name === 'vscode.executeReferenceProvider') return [];
        if (name === 'vscode.diff') diffs.push(args);
        return commands.get(name)?.(...args);
      },
    },
    workspace: { workspaceFolders: [{ uri: baseStub.Uri.file(dir) }], getConfiguration: () => cfg,
      registerTextDocumentContentProvider: (scheme, p) => { providers.set(scheme, p); return disposable(); } },
  };
  const context = () => ({ subscriptions: [], workspaceState: { get: (k) => state.get(k), update: async (k,v) => state.set(k,v) } });
  try {
    git('init', '-q', '--initial-branch=main'); git('config','user.name','Test'); git('config','user.email','test@example.com');
    fs.writeFileSync(path.join(dir,'README.md'),'test');
    fs.writeFileSync(path.join(dir,'tsconfig.json'), '{"include":["*.ts"]}');
    const originalSource = 'export function renamed(){\n const x=1;\n const y=x+2;\n return y;\n}\n';
    fs.writeFileSync(path.join(dir,'old.ts'), originalSource);
    git('add','.'); git('commit','-qm','base');
    git('remote','add','origin','https://github.com/example/repo.git');
    global.fetch = async (url) => {
      const u = new URL(url);
      const pr = { number: 7, title: 'test', head: { ref: 'feature', sha: head }, base: { ref: 'main', sha: 'base-tip' }, changed_files: 1 };
      if (u.pathname.endsWith('/pulls')) return response(200, [pr]);
      if (u.pathname.endsWith('/pulls/7')) return response(200, pr);
      if (u.pathname.includes('/compare/')) return response(200, { merge_base_commit: { sha: 'merge' } });
      if (u.pathname.endsWith('/files')) return response(200, [{ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }]);
      if (u.pathname.endsWith('tsconfig.json')) return response(404, {});
      if (u.pathname.endsWith('/contents/src/a.ts')) {
        const ref = u.searchParams.get('ref');
        return response(200, ref === 'merge' ? 'export function a() {}' : `export function a(x: string) { return '${ref}'; }`, 'text/plain');
      }
      throw new Error('Unexpected request '+url);
    };
    Module._load = function(name, ...args) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...args); };
    for (const name of ['../src/extension','../src/resolver-vscode']) delete require.cache[require.resolve(name)];
    const extension = require('../src/extension');
    const first = context(); extension.activate(first);
    await commands.get('impactTree.openPullRequest')({ number: 7, title: 'test', headSha: 'stale' });
    assert.deepEqual(errors, []);
    const finding = { finding: { relPath: 'src/a.ts', file: path.join(dir,'src/a.ts'), startLine: 1 } };
    await commands.get('impactTree.openChange')(finding);
    const oldUri = diffs.at(-1)[1];
    assert.match(await providers.get('impacttree-pr').provideTextDocumentContent(oldUri), /h1/);
    head = 'h2';
    await commands.get('impactTree.refresh')();
    await commands.get('impactTree.openChange')(finding);
    const newUri = diffs.at(-1)[1];
    assert.notEqual(newUri.query, oldUri.query);
    assert.match(await providers.get('impacttree-pr').provideTextDocumentContent(newUri), /h2/);
    // The first preview is no longer held; its tab is rebuilt from GitHub at its own commit.
    assert.match(await providers.get('impacttree-pr').provideTextDocumentContent(oldUri), /h1/);
    await commands.get('impactTree.computeTestReach')();
    await commands.get('impactTree.openChange')(finding);
    assert.equal(diffs.at(-1)[1].scheme, 'impacttree-pr');
    await commands.get('impactTree.setCheckpoint')();
    assert.equal(state.get('impactTree.checkpoint'), git('rev-parse','HEAD'));
    first.subscriptions.forEach((s) => s.dispose()); extension.deactivate();
    git('mv','old.ts','new.ts');
    fs.writeFileSync(path.join(dir,'new.ts'), originalSource.replace('x=1','x=2'));
    git('add','-A');
    const second = context(); extension.activate(second);
    quickPick = { label: 'checkpoint' };
    await commands.get('impactTree.selectMode')();
    assert.deepEqual(errors, []);
    assert.deepEqual(updates.at(-1), ['mode','checkpoint',2]);
    await commands.get('impactTree.openChange')({ finding: { relPath: 'new.ts', file: path.join(dir,'new.ts'), startLine: 1 } });
    assert.equal(providers.get('impacttree-base').provideTextDocumentContent(diffs.at(-1)[0]), originalSource);
    await commands.get('impactTree.openFile')({relPath:'new.ts',status:'renamed'});
    assert.equal(providers.get('impacttree-base').provideTextDocumentContent(diffs.at(-1)[0]), originalSource);
    // an "Outside functions" row opens its file's diff at the first changed line
    await commands.get('impactTree.openFile')({ type: 'outside', relPath: 'new.ts', status: 'renamed', ranges: [[6.5, 6.5], [9, 12]] });
    assert.deepEqual(diffs.at(-1)[3].selection.args, [6, 0, 6, 0]);
    await commands.get('impactTree.openFile')({ type: 'outside', relPath: 'new.ts', status: 'renamed', ranges: [[2, 4]] });
    assert.deepEqual(diffs.at(-1)[3].selection.args, [1, 0, 1, 0]);
    await commands.get('impactTree.openCaller')({file:path.join(dir,'new.ts'),pos:16});
    assert.equal(providers.get('impacttree-base').provideTextDocumentContent(diffs.at(-1)[0]), originalSource);
    assert.equal(typeof tickListener, 'function');
    second.subscriptions.forEach((s) => s.dispose()); extension.deactivate();
  } finally {
    Module._load = originalLoad; global.fetch = originalFetch;
    for (const name of ['../src/extension','../src/resolver-vscode']) delete require.cache[require.resolve(name)];
    fs.rmSync(dir, { recursive: true, force: true }); clearVirtualText();
  }
});

test('editor resolver resets per-run statistics and classifies tests relative to the repository', async () => {
  const Module = require('module'), originalLoad = Module._load;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-resolver-'));
  const repo = path.join(dir,'tests','project'); fs.mkdirSync(repo, { recursive: true });
  const file = path.join(repo,'source.ts'); fs.writeFileSync(file,'function caller() { target(); }');
  try {
    const stub = { ...require('./vscode-stub'), Position: class {}, commands: { executeCommand: async (name) => {
      if (name === 'vscode.prepareCallHierarchy') return [{}];
      if (name === 'vscode.provideIncomingCalls') return [{ from: { uri: { fsPath: file }, name: 'caller', selectionRange: { start: { line: 0, character: 9 } } }, fromRanges: [{ start: { line: 0, character: 20 }, end: { line: 0, character: 26 } }] }];
      return [];
    } } };
    Module._load = function(name, ...args) { return name === 'vscode' ? stub : originalLoad.call(this,name,...args); };
    delete require.cache[require.resolve('../src/resolver-vscode')];
    const resolver = require('../src/resolver-vscode').createVscodeResolver({ repoRoot: repo });
    assert.equal((await resolver.incoming(file,0))[0].test, false);
    assert.equal(resolver.stats().incomingCalls,1);
    resolver.clear();
    assert.equal(resolver.stats().incomingCalls,0); assert.deepEqual(resolver.stats().emptyAt,[]);
    assert.equal(resolver.isWarm(),true);
  } finally { Module._load = originalLoad; delete require.cache[require.resolve('../src/resolver-vscode')]; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('editor distinguishes no references, callbacks, failed queries, and unsupported providers', async () => {
  const Module = require('module'), original = Module._load;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'it-empty-'));
  const file = path.join(dir,'a.ts'); fs.writeFileSync(file,'function target() {}');
  let mode='none';
  const stub = { ...require('./vscode-stub'), Position: class { constructor(line,character){ Object.assign(this,{line,character}); } },
    commands: { executeCommand: async name => {
      if(mode==='failed') throw Error('failed');
      if(name==='vscode.prepareCallHierarchy') return mode==='unsupported'?[]:[{}];
      if(name==='vscode.provideIncomingCalls') return mode==='no-result'?undefined:[];
      if(name==='vscode.executeReferenceProvider') {
        if(mode==='refs-failed') throw Error('failed');
        const declaration={uri:{fsPath:file},range:{start:{line:0,character:9},end:{line:0,character:15}}};
        return mode==='callback'?[declaration,{uri:{fsPath:path.join(dir,'other.ts')},range:declaration.range}]:[declaration];
      }
    } } };
  try {
    Module._load=function(name,...args){return name==='vscode'?stub:original.call(this,name,...args);};
    delete require.cache[require.resolve('../src/resolver-vscode')];
    const {createVscodeResolver}=require('../src/resolver-vscode');
    for(const [m,expected] of [['none','none'],['callback','unknown'],['failed','unknown'],['refs-failed','unknown'],['unsupported','unknown'],['no-result','unknown']]) {
      mode=m; const resolver=createVscodeResolver({repoRoot:dir,retries:0});
      assert.equal((await resolver.callerState(file,9)).state,expected,m);
    }
  } finally { Module._load=original; delete require.cache[require.resolve('../src/resolver-vscode')]; fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a finding with no callers found is not shown as updated', () => {
  const provider = createTreeProvider(require('./vscode-stub'), { getState: () => ({ rowDetail: 'hover' }), resolver: {} });
  const finding = (callerState) => ({ type: 'finding', label: 'target', name: 'target', file: '/review/t.ts', pos: 1,
    finding: { label: 'target', relPath: 't.ts', startLine: 1, component: '(root)', kinds: [{ id: 'optional-param', short: '+optional param' }],
      callerState, staleCallers: 0, stale: [], throwsAdded: [], score: 1 } });
  const none = provider.getTreeItem(finding('none'));
  assert.equal(none.description, '✓');
  assert.match(none.tooltip.value, /Nothing calls it/);
  assert.doesNotMatch(none.tooltip.value, /Every caller was updated/);
  assert.match(provider.getTreeItem(finding('resolved')).tooltip.value, /Every caller was updated/);
  assert.match(provider.getTreeItem(finding(undefined)).tooltip.value, /callers could not be found/);
});

test('an expansion whose caller query failed or did not finish says so', async () => {
  const expand = (resolver) => createTreeProvider(require('./vscode-stub'), { getState: () => ({ rel: (f) => path.relative(root, f) }), resolver })
    .getChildren({ type: 'caller', file: '/review/t.ts', pos: 1 });
  const caller = { file: '/review/c.ts', pos: 1, label: 'caller' };
  const failed = await expand({ incoming: async () => { throw new Error('tsserver crashed'); } });
  assert.deepEqual(failed.map((r) => [r.type, r.label, r.tooltip]), [['message', 'Callers could not be loaded', 'tsserver crashed']]);
  const notReady = await expand({ incomingWithStatus: async () => ({ callers: [], complete: false, reason: 'language server not ready' }) });
  assert.deepEqual(notReady.map((r) => [r.type, r.label]), [['message', 'Callers could not be loaded']]);
  const partial = await expand({ incomingWithStatus: async () => ({ callers: [caller], complete: false, reason: 'command-bus callers unavailable' }) });
  assert.deepEqual(partial.map((r) => [r.type, r.label]), [['caller', 'caller'], ['message', 'More callers may be missing']]);
  const complete = await expand({ incomingWithStatus: async () => ({ callers: [], complete: true }) });
  assert.deepEqual(complete, []);
  // A resolver that cannot report completion does not get to look complete.
  const silent = await expand({ incoming: async () => [caller] });
  assert.deepEqual(silent.map((r) => [r.type, r.label]), [['caller', 'caller'], ['message', 'More callers may be missing']]);
});

test('editor caller queries report whether they completed, and retry incomplete ones', async () => {
  const Module = require('module'), original = Module._load;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-status-'));
  const file = path.join(dir, 'a.ts'); fs.writeFileSync(file, 'function target() {}');
  const cqrsId = require.resolve('../src/engine/edges-cqrs');
  const realCqrs = require.cache[cqrsId];
  let mode = 'failed', cqrsFails = false;
  const stub = { ...require('./vscode-stub'), Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    commands: { executeCommand: async (name) => {
      if (mode === 'failed') throw Error('server down');
      if (name === 'vscode.prepareCallHierarchy') return [{}];
      if (name === 'vscode.provideIncomingCalls') return [];
      if (name === 'vscode.executeReferenceProvider') return [{ uri: { fsPath: file }, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } } }];
    } } };
  const fakeCqrs = new Module(cqrsId); fakeCqrs.loaded = true;
  fakeCqrs.exports = { makeCqrsEdges: () => ({ isHandlerExecute: () => false,
    extraCallers: async () => { if (cqrsFails) throw new Error('index unavailable'); return []; } }) };
  try {
    Module._load = function (name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
    require.cache[cqrsId] = fakeCqrs;
    delete require.cache[require.resolve('../src/resolver-vscode')];
    const { createVscodeResolver } = require('../src/resolver-vscode');
    const resolver = createVscodeResolver({ repoRoot: dir, retries: 0, ts, filterInherited: false });
    const first = await resolver.incomingWithStatus(file, 9);
    assert.equal(first.complete, false);
    assert.equal((await resolver.callerState(file, 9)).state, 'unknown');
    mode = 'ok';
    assert.deepEqual(await resolver.incomingWithStatus(file, 9), { callers: [], complete: true }, 'an incomplete answer is not cached');
    const cqrsResolver = createVscodeResolver({ repoRoot: dir, retries: 0, ts, filterInherited: false });
    cqrsFails = true;
    const partial = await cqrsResolver.incomingWithStatus(file, 9);
    assert.equal(partial.complete, false);
    assert.match(partial.reason, /command-bus callers unavailable — index unavailable/);
    assert.equal((await cqrsResolver.callerState(file, 9)).state, 'unknown', 'a failed command-bus lookup is not "no callers"');
    cqrsFails = false;
    assert.equal((await cqrsResolver.callerState(file, 9)).state, 'none');
  } finally {
    Module._load = original;
    if (realCqrs) require.cache[cqrsId] = realCqrs; else delete require.cache[cqrsId];
    delete require.cache[require.resolve('../src/resolver-vscode')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- readiness: a failed warm-up must be retried, not remembered ---------------------
test('ensureReady retries after a failed prepare, shares a running one, and keeps a successful one', async () => {
  const analyzeModule = require('../src/engine/analyze');
  const resolverPath = require.resolve('../src/resolver-vscode');
  const realLoad = analyzeModule.loadTypeScript, realResolver = require.cache[resolverPath];
  let creations = 0, failNext = true;
  analyzeModule.loadTypeScript = () => ts;
  require.cache[resolverPath] = { id: resolverPath, filename: resolverPath, loaded: true, exports: {
    createVscodeResolver: () => {
      creations++;
      if (failNext) { failNext = false; throw new Error('resolver exploded'); }
      return { isWarm: () => true, warmUp: async () => true };
    },
  } };
  try {
    const { createReadiness } = require('../src/readiness');
    const vscodeStub = { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
    const logs = [];
    const session = { repoRoot: () => os.tmpdir(), phase: 'idle', resolver: null, readyPromise: null };
    const { ensureReady } = createReadiness(vscodeStub, session, { log: (m) => logs.push(m) });

    assert.equal(await ensureReady(), false, 'the failed prepare reports failure');
    assert.equal(session.resolver, null);
    assert.equal(session.phase, 'idle', 'readiness leaves the displayed phase to the session lifecycle');
    assert.ok(logs.some((m) => m.includes('resolver exploded')));

    // the next call prepares afresh; two calls during that prepare share one promise
    const first = ensureReady();
    const second = ensureReady();
    assert.equal(first, second, 'concurrent callers share the running promise');
    assert.equal(await first, true);
    assert.ok(session.resolver, 'the retry created the resolver');
    assert.equal(creations, 2, 'one failed prepare plus exactly one retry');

    // success is cached: a further call neither re-runs nor builds another resolver
    assert.equal(await ensureReady(), true);
    assert.equal(creations, 2);
  } finally {
    analyzeModule.loadTypeScript = realLoad;
    if (realResolver) require.cache[resolverPath] = realResolver; else delete require.cache[resolverPath];
  }
});
