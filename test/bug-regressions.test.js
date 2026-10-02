'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ts = require('typescript');
const { createSyntacticIndex } = require('../src/engine/syntactic-index');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { createGitHub } = require('../src/github');
const { createReviewState } = require('../src/review-state');
const { createReviewIdentity } = require('../src/review-identity');
const { createTreeProvider } = require('../src/tree-provider');
const { createPrDocuments, prQuery } = require('../src/pr-documents');
const { registerVirtualText, clearVirtualText } = require('../src/engine/textpos');
const { createInheritanceFilter } = require('../src/engine/inheritance');
const root = '/review';
const build = (files) => createSyntacticIndex(ts, Object.entries(files).map(([p, text]) => ({ path: path.join(root, p), text })), { baseDirs: [root] });

for (const [name, source, extra] of [
  ['renamed import', "import { target as run } from './target'; export function caller() { run(); }"],
  ['namespace import', "import * as api from './target'; export function caller() { api.target(); }"],
  ['ESM extension', "import { target } from './target.js'; export function caller() { target(); }"],
  ['default import', "import run from './target'; export function caller() { run(); }"],
  ['require namespace', "const api = require('./target'); export function caller() { api.target(); }"],
  ['require destructuring', "const { target: run } = require('./target'); export function caller() { run(); }"],
  ['renamed barrel', "import { run } from './barrel'; export function caller() { run(); }", { 'barrel.ts': "export { target as run } from './target';" }],
]) test(`syntax resolution: ${name}`, () => {
  const idx = build({ 'target.ts': 'export default function target() {}', 'caller.ts': source, ...extra });
  assert.deepEqual(idx.callersOf({ file: '/review/target.ts', name: 'target' }).map((c) => c.label), ['caller']);
});

test('lexical shadowing and reused parameter names do not invent or lose calls', () => {
  const idx = build({
    'target.ts': 'export function target() {} export class Store { save() {} } export class Other { save() {} }',
    'caller.ts': "import { target, Store, Other } from './target'; function first(repo: Store) { repo.save(); } function second(repo: Other) { repo.save(); } function shadow(target: () => void) { target(); }",
  });
  assert.deepEqual(idx.callersOf({ file: '/review/target.ts', className: 'Store', name: 'save' }).map((c) => c.label), ['first']);
  assert.deepEqual(idx.callersOf({ file: '/review/target.ts', name: 'target' }), []);
});

test('inheritance filter keeps scoped, shadowed, namespaced, and inherited-alias callers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-inheritance-regression-'));
  try {
    const files = {
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
      'base.ts': 'export class Base { save() {} }',
      'mine.ts': "import { Base } from './base'; export class Mine extends Base { save() {} }",
      'other.ts': "import { Base } from './base'; export class Other extends Base {}",
      'mid.ts': "import { Mine } from './mine'; export class Mid extends Mine {}",
      'leaf.ts': "import { Mid } from '@lib/mid'; export class Leaf extends Mid {}",
      'ns.ts': "import * as m from './mine'; export class NS extends m.Mine {}",
      'caller.ts': "import { Mine } from './mine'; import { Other } from './other'; import { Leaf } from './leaf'; import { NS } from './ns'; function a(repo: Other) { repo.save(1); } function b(repo: Mine) { repo.save(2); } function c(repo: Leaf) { repo.save(3); } function d(repo: NS) { repo.save(4); } function e(repo: Other) { { const repo = factory(); repo.save(5); } }",
    };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const filter = createInheritanceFilter(ts);
    const target = { file: path.join(dir, 'mine.ts'), className: 'Mine', name: 'save' };
    const caller = path.join(dir, 'caller.ts');
    for (let i = 1; i <= 5; i++) {
      const start = files['caller.ts'].indexOf(`save(${i})`);
      assert.equal(filter.isSiblingDispatch(target, { file: caller, callSites: [{ start }] }), i === 1);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const response = (status, data, contentType = 'application/json') => ({ status, ok: status >= 200 && status < 300,
  headers: { get: () => contentType }, json: async () => data, text: async () => typeof data === 'string' ? data : JSON.stringify(data) });
const client = async () => { const gh = createGitHub({ authentication: { getSession: async () => ({ accessToken: 'test' }) } }); await gh.signIn(); return gh; };
test('GitHub pagination, exact caps, rate limits, and unsupported file encoding', async () => {
  const original = global.fetch;
  try {
    const gh = await client();
    global.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      const total = url.includes('/files?') ? 450 : 123;
      return response(200, Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => ({ number: (page - 1) * 100 + i, filename: `f${i}.ts` })));
    };
    assert.equal((await gh.listOpenPullRequests({ owner: 'o', repo: 'r' })).length, 123);
    const files = await gh.listPullRequestFiles({ owner: 'o', repo: 'r' }, 1);
    assert.equal(files.files.length, 300); assert.equal(files.truncated, true);
    global.fetch = async (url) => response(200, Number(new URL(url).searchParams.get('page')) <= 3 ? Array.from({ length: 100 }, () => ({ filename: 'a.ts' })) : []);
    assert.equal((await gh.listPullRequestFiles({ owner: 'o', repo: 'r' }, 1)).truncated, false);
    global.fetch = async () => response(403, {});
    await assert.rejects(gh.listOpenPullRequests({ owner: 'o', repo: 'r' }), /403/);
    assert.equal(gh.isSignedIn(), true);
    global.fetch = async () => response(200, { encoding: 'none', content: '', size: 2000000 });
    await assert.rejects(gh.fileAtRef({ owner: 'o', repo: 'r' }, 'large.ts', 'head'), /JSON/);
    global.fetch = async () => response(200, { encoding: 'base64', content: Buffer.from('source').toString('base64') });
    assert.equal(await gh.fileAtRef({ owner: 'o', repo: 'r' }, 'a.ts', 'head'), 'source');
    global.fetch = async () => response(401, {});
    await assert.rejects(gh.listOpenPullRequests({ owner: 'o', repo: 'r' }));
    assert.equal(gh.isSignedIn(), false);
  } finally { global.fetch = original; }
});

test('PR analysis uses fresh head and merge base, including remote config inheritance', async () => {
  clearVirtualText();
  const calls = [];
  const pr = { number: 2, headSha: 'fresh', baseSha: 'tip', baseRef: 'main' };
  const texts = {
    'lib/target.ts@merge': 'export function target() { return 0; }\n',
    'lib/target.ts@fresh': 'export function target(required: string) { return 1; }\n',
    'lib/use.ts@fresh': "import { target } from '@lib/target.js'; export function caller() { target(); }\n",
    'lib/use.ts@merge': "import { target } from '@lib/target.js'; export function caller() { target(); }\n",
    'tsconfig.json@fresh': '{"extends":"./tsconfig.base.json"}',
    'tsconfig.base.json@fresh': '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}',
  };
  const gh = {
    getPullRequest: async () => pr,
    mergeBase: async (_, base, head) => { assert.equal(base, 'tip'); assert.equal(head, 'fresh'); return 'merge'; },
    listPullRequestFiles: async () => ({ total: 2, files: ['lib/target.ts','lib/use.ts'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' })) }),
    fileAtRef: async (_, p, ref) => { calls.push(`${p}@${ref}`); return texts[`${p}@${ref}`] ?? null; },
  };
  const result = await analyzeRemote({ ts, gh, slug: {}, pr: { ...pr, headSha: 'stale' }, repoRoot: root });
  assert.equal(result.headSha, 'fresh'); assert.equal(result.base.sha, 'merge');
  assert.equal(calls.some((c) => c.endsWith('@tip') || c.endsWith('@stale')), false);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.allChanged.find((c) => c.label === 'target').callers.map((c) => c.label), ['caller']);
  let reads = 0;
  gh.getPullRequest = async () => ++reads === 1 ? pr : { ...pr, headSha: 'pushed-again' };
  await assert.rejects(analyzeRemote({ ts, gh, slug: {}, pr, repoRoot: root }), /changed while/);
  clearVirtualText();
});

test('remote roots retain separate recursive components beside an ordinary root', async () => {
  const text = 'export function a() { b(); }\nexport function b() { a(); }\nexport function c() { d(); }\nexport function d() { c(); }\nexport function solo() {}\n';
  const gh = { listPullRequestFiles: async () => ({ files: [{ path: 'a.ts', status: 'added', patch: '@@ -0,0 +1,5 @@\n'+text.trimEnd().split('\n').map((l) => '+'+l).join('\n') }] }), fileAtRef: async (_, p) => p === 'a.ts' ? text : null };
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: root });
  assert.equal(r.allChanged.filter((c) => c.isRoot).length, 3);
  assert.equal(r.allChanged.find((c) => c.label === 'solo').isRoot, true);
  clearVirtualText();
});

test('preview documents keep old PRs and revisions separate, including punctuation in paths', () => {
  const docs = createPrDocuments();
  const a = { prNumber: 1, headSha: 'one', base: { sha: 'base' }, texts: new Map([['a?#.ts', { head: 'first', base: null }]]) };
  const b = { ...a, prNumber: 2, texts: new Map([['a?#.ts', { head: 'second' }]]) };
  const c = { ...a, headSha: 'pushed', texts: new Map([['a?#.ts', { head: 'updated' }]]) };
  [a,b,c].forEach((r) => docs.add(r));
  assert.deepEqual([a,b,c].map((r) => docs.read({ path: '/a?#.ts', query: prQuery(r, 'head') })), ['first','second','updated']);
  assert.equal(docs.read({ path: '/a?#.ts', query: prQuery(a, 'base') }), '');
});

test('review ticks survive offset/base movement, invalidate edited symbols, and remain parent-scoped', async () => {
  const store = new Map();
  const memento = { get: (k) => store.get(k), update: (k,v) => store.set(k,v) };
  const review = createReviewState(memento);
  const base = 'export function target() { return 0; }\nexport function caller() { target(); }\n';
  let head = base.replace('return 0', 'return 1');
  const file = '/review/a.ts';
  const configure = (baseText = base) => {
    registerVirtualText(file, head);
    review.configure('branch-review', createReviewIdentity(ts, root, { headText: () => head, baseText: () => baseText, fileRevision: () => null }));
  };
  const node = (name, type = 'finding', reviewParent) => ({ type, file, label: name, pos: head.indexOf(name+'('), reviewParent });
  configure();
  let target = node('target');
  let caller = node('caller', 'caller', review.id(target));
  review.set(review.id(target), true); review.set(review.id(caller), true);
  assert.notEqual(review.id(caller), review.id(node('caller')));
  assert.notEqual(review.id(caller), review.id(node('caller', 'caller', 'another-parent')));
  head = "import 'new-package';\n" + head;
  configure("import 'base-update';\n" + base);
  target = node('target'); caller = node('caller', 'caller', review.id(target));
  assert.equal(review.isReviewed(review.id(target)), true);
  assert.equal(review.isReviewed(review.id(caller)), true);
  const finding = { ...target, finding: { label: 'target', relPath: 'a.ts', startLine: 2, component: 'root', kinds: [], throwsAdded: [], score: 0, callers: [{ file, pos: caller.pos, label: 'caller' }] } };
  const provider = createTreeProvider(require('./vscode-stub'), { getState: () => ({ rowDetail: 'hover' }), resolver: {}, review });
  assert.match(provider.getTreeItem(finding).tooltip.value, /all callers reviewed/);
  review.set(review.id(caller), false);
  assert.match(provider.getTreeItem(finding).tooltip.value, /1\/1 callers left/);
  head = head.replace('return 1', 'return 2'); configure();
  assert.equal(review.isReviewed(review.id(node('target'))), false);
  assert.equal(review.isReviewed(review.id(node('caller','caller', review.id(node('target'))))), false);
  clearVirtualText();
});

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
    assert.match(providers.get('impacttree-pr').provideTextDocumentContent(oldUri), /h1/);
    head = 'h2';
    await commands.get('impactTree.refresh')();
    await commands.get('impactTree.openChange')(finding);
    const newUri = diffs.at(-1)[1];
    assert.notEqual(newUri.query, oldUri.query);
    assert.match(providers.get('impacttree-pr').provideTextDocumentContent(newUri), /h2/);
    assert.match(providers.get('impacttree-pr').provideTextDocumentContent(oldUri), /h1/);
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

test('CQRS edges apply only to entry methods and include every declared event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'it-cqrs-'));
  try {
    const files = {
      'tsconfig.json': '{"compilerOptions":{"experimentalDecorators":true},"include":["*.ts"]}',
      'types.ts': 'export const CommandHandler = (c: any) => (t: any) => t; export const EventsHandler = (...c: any[]) => (t: any) => t; export class Command {} export class Created {} export class Removed {}',
      'handler.ts': "import { CommandHandler, EventsHandler, Command, Created, Removed } from './types';\n@CommandHandler(Command) export class Handler { execute(c: Command) { return this.helper(); } helper() { return 1; } }\n@EventsHandler(Created, Removed) export class Events { handle(e: Created | Removed) {} execute() {} }",
      'caller.ts': "import { Command, Created, Removed } from './types'; export function command() { dispatch(new Command()); } export function create() { dispatch(new Created()); } export function remove() { dispatch(new Removed()); } declare function dispatch(x: any): void;",
    };
    for (const [f,s] of Object.entries(files)) fs.writeFileSync(path.join(dir,f),s);
    const resolver = require('../src/engine/resolver-ts').createTsResolver(ts,dir);
    const file = path.join(dir,'handler.ts');
    const syms = require('../src/engine/symbols').makeSymbols(ts).collect(ts.createSourceFile(file,files['handler.ts'],ts.ScriptTarget.ES2021,true));
    const callers = async (label) => (await resolver.incoming(file,syms.find((s) => s.label === label).namePos)).map((c) => c.label).sort();
    assert.deepEqual(await callers('Handler.execute'), ['command']);
    assert.deepEqual(await callers('Handler.helper'), ['Handler.execute']);
    assert.deepEqual(await callers('Events.handle'), ['create','remove']);
    assert.deepEqual(await callers('Events.execute'), []);
    resolver.dispose();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('async git operations yield to the event loop and enforce their timeout', async () => {
  const { makeGit } = require('../src/engine/git');
  const git = makeGit(__dirname);
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 5);
  await assert.rejects(git.rawAsync(['-c','alias.delay=!sleep 0.3','delay'], { timeoutMs: 50 }), /timed out/);
  clearTimeout(timer);
  assert.equal(ticked, true);
});

test('Windows PR paths preserve updated-call classification', () => {
  require('child_process').execFileSync(process.execPath, [path.join(__dirname,'windows-preview.js')]);
});

test('changed nested helpers and anonymous defaults resolve through the remote pipeline', async () => {
  const text = 'export class K { run() { const helper = () => 1; return helper(); } }\nexport default () => 1;\n';
  const use = "import build from './a'; export function use() { return build(); }\n";
  const gh = {
    listPullRequestFiles: async () => ({ files: ['a.ts','use.ts'].map((p) => ({ path: p, status: 'added', patch: '@@ -0,0 +1,2 @@\n+'+(p==='a.ts'?text:use).trimEnd().split('\n').join('\n+') })) }),
    fileAtRef: async (_,p) => p==='a.ts'?text:p==='use.ts'?use:null,
  };
  const r = await analyzeRemote({ts,gh,slug:{},pr:{number:1,headSha:'head',mergeBaseSha:'base'},repoRoot:root});
  assert.deepEqual(r.allChanged.find((c) => c.simpleName==='helper').callers.map((c) => c.label),['K.run']);
  assert.deepEqual(r.allChanged.find((c) => c.simpleName==='default').callers.map((c) => c.label),['use']);
  clearVirtualText();
});

test('constructor aliases nest consistently and lazy expansion keeps untracked callers out of committed reviews', async () => {
  const { nestedIds } = require('../src/engine/forest');
  const a = { file: '/review/a.ts', namePos: 10, callers: [{ file: '/review/b.ts', pos: 5 }] };
  const b = { file: '/review/b.ts', namePos: 20, classNamePos: 5, isConstructor: true, callers: [] };
  assert.deepEqual([...nestedIds([a,b])], ['/review/b.ts#20']);
  assert.equal(require('../src/engine/changed-symbols').changedSymbolKeys([a,b]).has('/review/b.ts#5'),true);
  const provider = createTreeProvider(require('./vscode-stub'), {
    getState: () => ({ result: { excludedCallerPaths: ['scratch.ts'] }, rel: (f) => path.relative(root,f) }),
    resolver: { incomingWithStatus: async () => ({ callers: [{file:'/review/scratch.ts',pos:1,label:'scratch'},{file:'/review/committed.ts',pos:1,label:'kept'}], complete: true }) },
  });
  const rows = await provider.getChildren({ type:'finding', file:a.file, pos:10 });
  assert.deepEqual(rows.map((r) => r.label),['kept']);
});

test('aliased and namespace class imports resolve receivers and constructors', () => {
  const idx = build({
    'store.ts': 'export class Store { constructor() {} save() {} }',
    'use.ts': "import { Store as Renamed } from './store'; import * as api from './store'; function named(repo: Renamed) { repo.save(); } function namespaced(repo: api.Store) { repo.save(); } function construct() { return new api.Store(); }",
  });
  assert.deepEqual(idx.callersOf({file:'/review/store.ts',className:'Store',name:'save'}).map((c)=>c.label), ['named','namespaced']);
  assert.deepEqual(idx.callersOf({file:'/review/store.ts',className:'Store',name:'constructor'}).map((c)=>c.label), ['construct']);
});

test('throws belong to their own callable and parameter edits retain their direction', () => {
  const { makeSymbols } = require('../src/engine/symbols');
  const { diffSignature } = require('../src/engine/signature');
  const collect = (text) => makeSymbols(ts).collect(ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true));
  const syms = collect('function outer(){ const inner=()=>{throw new Error("inner");}; return inner; }');
  assert.deepEqual([...syms[0].throws], []);
  assert.equal(syms[1].throws.size, 1);
  const kinds = (a,b) => diffSignature(collect(`function f(${a}){}`)[0], collect(`function f(${b}){}`)[0]).map(k=>k.id);
  assert.deepEqual(kinds('a:number','a?:number'), ['optional-param-changed']);
  assert.deepEqual(kinds('a:number','a:number=1'), ['optional-param-changed']);
  assert.deepEqual(kinds('a?:number','a:number'), ['required-param']);
  assert.deepEqual(kinds('a:number,b?:string','a:number,x:boolean,b?:string'), ['required-param']);
  assert.deepEqual(kinds('a:number,b:string','a:number'), ['param-removed']);
  assert.deepEqual(kinds('a:number','renamed:number'), []);
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

test('workspace package exports connect preview callers without guessing unrelated names', () => {
  const files = [
    {path:'/repo/packages/shared/src/api.ts', text:'export function target(){}'},
    {path:'/repo/apps/web/use.ts', text:"import { target as run } from '@demo/shared/api'; export function caller(){run();}"},
    {path:'/repo/apps/web/other.ts', text:"import { target } from '@other/shared/api'; export function unrelated(){target();}"},
  ];
  for (const exports of [ {'./api': './src/api.ts'}, {'./*': {types:'./src/*.ts',import:'./src/*.ts'} } ]) {
    const idx=createSyntacticIndex(ts,files,{packages:[{dir:'/repo/packages/shared',data:{name:'@demo/shared',exports}}]});
    assert.deepEqual(idx.callersOf({file:files[0].path,name:'target'}).map(c=>c.label),['caller']);
  }
  const hidden=createSyntacticIndex(ts,files,{packages:[{dir:'/repo/packages/shared',data:{name:'@demo/shared',exports:{'./different':'./src/api.ts'}}}]});
  assert.deepEqual(hidden.callersOf({file:files[0].path,name:'target'}),[]);
});

test('static class calls follow class bindings, not instances or shadowed names', () => {
  const idx=build({
    'store.ts':'export class Store { static save() {} load() {} }',
    'other.ts':'export class Store { static save() {} }',
    'use.ts':`import { Store as DB } from './store'; import { Store } from './other';
      export function caller(){ DB.save(); }
      export function unrelated(){ Store.save(); }
      export function shadowed(DB: {save():void}){ DB.save(); }
      export function instance(){const db=new DB(); db.save();}
      export function invalid(){DB.load();}`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'save'}).map(c=>c.label),['caller']);
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'load'}),[]);
});

test('static namespace and inherited calls keep static and instance this separate', () => {
  const idx=build({
    'store.ts':`export class Store { static save() {} static own(){this.save();} wrong(){this.save();} }
      export class Child extends Store { static parent(){super.save();} }`,
    'use.ts':`import * as api from './store'; import {Child} from './store';
      export function namespace(){api.Store.save();}
      export function inherited(){Child.save();}
      export function shadowed(api:any){api.Store.save();}`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'save'}).map(c=>c.label).sort(),
    ['Store.own','Child.parent','namespace','inherited'].sort());
});

test('remote workspace metadata is loaded from the pinned head', async () => {
  const metadata=[];
  const files=[{path:'packages/lib/src/api.ts',status:'modified',patch:'@@ -1 +1 @@\n-old\n+new'},
    {path:'apps/web/use.ts',status:'modified',patch:'@@ -1 +1 @@\n-old\n+new'}];
  const r=await analyzeRemote({ts,repoRoot:'/remote',slug:'demo/repo',pr:{number:1,headSha:'head',baseSha:'base',mergeBaseSha:'base'},gh:{
    listPullRequestFiles:async()=>({files}),
    fileAtRef:async(_,file,ref)=>{
      if(file.endsWith('package.json')) { metadata.push([file,ref]); return file==='packages/lib/package.json'?JSON.stringify({name:'@demo/lib',exports:{'./api':'./src/api.ts'}}):null; }
      if(file==='packages/lib/src/api.ts') return ref==='head'?'export function target(x?:string){}':'export function target(){}';
      if(file==='apps/web/use.ts') return "import {target} from '@demo/lib/api'; export function caller(){target();}";
      return null;
    },
  }});
  assert(metadata.some(([file])=>file==='packages/lib/package.json'));
  assert(metadata.every(([,ref])=>ref==='head'));
  assert.deepEqual(r.allChanged.find(c=>c.label==='target').callers.map(c=>c.label),['caller']);
});

test('workspace conditional exports use the module format TypeScript gives the importer', () => {
  // Real TypeScript on disk is the oracle: a `.ts` importer is CommonJS unless its nearest
  // package.json says `"type": "module"`, and a CommonJS import takes the `require` condition.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-exports-mode-'));
  const K = ts.ModuleKind, R = ts.ModuleResolutionKind;
  const lib = path.join(dir, 'node_modules', '@demo', 'lib');
  const libData = { name: '@demo/lib', exports: { import: './esm.ts', require: './cjs.ts' } };
  const app = path.join(dir, 'app');
  const seen = new Set();
  try {
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify(libData));
    for (const f of ['esm.ts', 'cjs.ts']) fs.writeFileSync(path.join(lib, f), 'export function target(){}');
    for (const [label, options] of [
      ['nodenext', { module: K.NodeNext, moduleResolution: R.NodeNext }],
      ['node16', { module: K.Node16, moduleResolution: R.Node16 }],
      ['bundler', { module: K.ESNext, moduleResolution: R.Bundler }],
    ]) for (const type of ['module', 'commonjs', null]) for (const ext of ['.ts', '.mts', '.cts']) {
      fs.rmSync(app, { recursive: true, force: true });
      fs.mkdirSync(app);
      const appData = type ? { type } : null;
      if (appData) fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(appData));
      const importer = path.join(app, 'use' + ext);
      const text = "import { target } from '@demo/lib'; export function caller(){ target(); }";
      fs.writeFileSync(importer, text);
      const opts = { ...options, noLib: true, types: [], noEmit: true };
      const sf = ts.createProgram([importer], opts).getSourceFile(importer);
      const mode = ts.getModeForUsageLocation(sf, sf.statements[0].moduleSpecifier, opts);
      const real = ts.resolveModuleName('@demo/lib', importer, opts, ts.sys, undefined, undefined, mode).resolvedModule;
      const where = `${label} ${type} ${ext}`;
      assert(real, `oracle resolved nothing for ${where}`);
      const expected = path.basename(real.resolvedFileName);
      seen.add(expected);
      const files = ['esm.ts', 'cjs.ts'].map((f) => ({ path: path.join(lib, f), text: 'export function target(){}' }))
        .concat({ path: importer, text });
      const packages = [{ dir: lib, data: libData }].concat(appData ? [{ dir: app, data: appData }] : []);
      const idx = createSyntacticIndex(ts, files, { packages, moduleOptions: new Map([[importer, opts]]) });
      const hits = files.slice(0, 2).filter((f) => idx.callersOf({ file: f.path, name: 'target' }).length).map((f) => path.basename(f.path));
      assert.deepEqual(hits, [expected], where);
    }
    // The matrix must exercise both conditions, or it cannot tell them apart.
    assert.deepEqual([...seen].sort(), ['cjs.ts', 'esm.ts']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an explicit require takes the require condition in any importer', () => {
  const files=[
    {path:'/repo/lib/esm.ts',text:'export function target(){}'},
    {path:'/repo/lib/cjs.ts',text:'export function target(){}'},
    {path:'/repo/app/use.ts',text:"import {target} from '@demo/lib'; const {target: other}=require('@demo/lib'); export function esm(){target();} export function cjs(){other();}"},
  ];
  const idx=createSyntacticIndex(ts,files,{packages:[{dir:'/repo/lib',data:{name:'@demo/lib',exports:{import:'./esm.ts',require:'./cjs.ts'}}},{dir:'/repo/app',data:{type:'module'}}]});
  assert.deepEqual(idx.callersOf({file:files[0].path,name:'target'}).map(c=>c.label),['esm']);
  assert.deepEqual(idx.callersOf({file:files[1].path,name:'target'}).map(c=>c.label),['cjs']);
});

test('every local that shadows an import hides it from static and bare calls', () => {
  const idx=build({
    'store.ts':'export class Store { static save() {} } export function target() {}',
    'use.ts':`import { Store, target } from './store';
      export function ok(){ Store.save(); target(); }
      export function param({ Store, target }: any){ Store.save(); target(); }
      export function nested([, { Store, target }]: any){ Store.save(); target(); }
      export function loop(xs: any[]){ for (const { Store, target } of xs) { Store.save(); target(); } }
      export function caught(){ try {} catch ({ Store, target }) { Store.save(); target(); } }
      export function clause(x: number){ switch (x) { case 1: const Store = make(), target = make(); break; default: Store.save(); target(); } }
      export function hoisted(x: boolean){ if (x) { var Store = make(), target = make(); } Store.save(); target(); }
      export function local(){ class Store { static save() {} } function target() {} Store.save(); target(); }
      export const named = function Store(){ Store.save(); };`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'save'}).map(c=>c.label),['ok']);
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',name:'target'}).map(c=>c.label),['ok']);
});

test('typed locals in switch clauses and hoisted vars keep their receiver type', () => {
  const idx=build({
    'svc.ts':'export class Svc { run() {} }',
    'use.ts':`import { Svc } from './svc';
      export function inCase(x: number){ switch (x) { case 1: const s: Svc = get(); s.run(); } }
      export function inDefault(x: number){ switch (x) { default: const s = new Svc(); s.run(); } }
      export function otherClause(x: number){ switch (x) { case 1: const s: Svc = get(); break; case 2: s.run(); } }
      export function hoistedVar(x: boolean){ if (x) { var s: Svc = get(); } s.run(); }`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/svc.ts',className:'Svc',name:'run'}).map(c=>c.label).sort(),
    ['hoistedVar','inCase','inDefault','otherClause']);
});

test('a finding with no callers found is not shown as updated', () => {
  const provider = createTreeProvider(require('./vscode-stub'), { getState: () => ({ rowDetail: 'hover' }), resolver: {} });
  const finding = (callerState) => ({ type: 'finding', label: 'target', file: '/review/t.ts', pos: 1,
    finding: { label: 'target', relPath: 't.ts', startLine: 1, component: '(root)', kinds: [{ id: 'optional-param', short: '+optional param' }],
      callerState, staleCallers: 0, stale: [], throwsAdded: [], score: 1 } });
  const none = provider.getTreeItem(finding('none'));
  assert.equal(none.description, '∅');
  assert.match(none.tooltip.value, /no callers found/);
  assert.doesNotMatch(none.tooltip.value, /all call sites updated/);
  assert.match(provider.getTreeItem(finding('resolved')).tooltip.value, /all call sites updated/);
  assert.match(provider.getTreeItem(finding(undefined)).tooltip.value, /callers unknown/);
});

test('an expansion whose caller query failed or did not finish says so', async () => {
  const expand = (resolver) => createTreeProvider(require('./vscode-stub'), { getState: () => ({ rel: (f) => path.relative(root, f) }), resolver })
    .getChildren({ type: 'finding', file: '/review/t.ts', pos: 1 });
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

test('hiding untracked callers applies to the status query too', async () => {
  const { withoutUntrackedCallers } = require('../src/engine/analyze');
  const callers = [{ file: '/r/scratch.ts', pos: 1 }, { file: '/r/kept.ts', pos: 1 }];
  const resolver = withoutUntrackedCallers({
    incoming: async () => callers,
    incomingWithStatus: async () => ({ callers, complete: false, reason: 'partial' }),
    callerState: async () => ({ state: 'resolved', callers }),
  }, (c) => c.file === '/r/scratch.ts', () => {});
  assert.deepEqual(await resolver.incomingWithStatus('/r/t.ts', 1), { callers: [callers[1]], complete: false, reason: 'partial' });
  assert.equal('incomingWithStatus' in withoutUntrackedCallers({ incoming: async () => [], callerState: async () => ({}) }, () => false, () => {}), false);
});

test('dropping every untracked caller concludes "none" only from a finished search', async () => {
  const { withoutUntrackedCallers } = require('../src/engine/analyze');
  const untracked = [{ file: '/r/scratch.ts', pos: 1 }, { file: '/r/notes.ts', pos: 4 }];
  const stateAfterDropping = async (coverage) => withoutUntrackedCallers({
    incoming: async () => untracked,
    callerState: async () => ({ state: 'resolved', callers: untracked, ...coverage }),
  }, () => true, () => {}).callerState('/r/t.ts', 1);
  const finished = await stateAfterDropping({ complete: true });
  assert.deepEqual([finished.state, finished.callers, finished.complete], ['none', [], true]);
  const unfinished = await stateAfterDropping({ complete: false, reason: 'query-failed' });
  assert.deepEqual([unfinished.state, unfinished.callers, unfinished.complete, unfinished.reason], ['unknown', [], false, 'query-failed']);
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

test('deleted rows and unrecorded callers in one file have their own review identities', async () => {
  const file = path.join(root, 'a.ts');
  const base = 'export class A { run() { return 1; } }\nexport class B { run() { return 2; } }\nexport function gone() {}\n';
  let head = 'export const f = function first() { target(); };\nexport const g = function second() { target(); };\nexport function target() {}\n';
  const identity = (baseText = base) => createReviewIdentity(ts, root, { headText: () => head, baseText: () => baseText, fileRevision: () => null });
  // The rows come from the provider, as the editor builds them.
  const deletedRows = async (baseText) => {
    const S = require('../src/engine/symbols').makeSymbols(ts);
    const deleted = S.collect(ts.createSourceFile(file, baseText, ts.ScriptTarget.ES2021, true))
      .filter((s) => s.label !== 'A' && s.label !== 'B').map((s) => ({ ...s, file, relPath: 'a.ts' }));
    const provider = createTreeProvider(require('./vscode-stub'), { getState: () => ({ result: { deleted }, rel: (f) => path.relative(root, f) }), resolver: {} });
    return provider.getChildren({ type: 'section', key: 'deleted' });
  };
  const rows = await deletedRows(base);
  assert.ok(rows.length >= 3, `expected the two run() methods and gone(), got ${rows.map((r) => r.label)}`);
  const ids = rows.map(identity());
  assert.equal(new Set(ids).size, ids.length, 'every deleted row needs its own identity');
  // Editing one deleted method's base changes its identity and no other row's.
  const edited = base.replace('return 2', 'return 3');
  const after = (await deletedRows(edited)).map(identity(edited));
  assert.deepEqual(rows.filter((r, i) => after[i] !== ids[i]).map((r) => r.label), ['B.run']);

  // The call hierarchy anchors a named function expression at its own name, which the
  // symbol collector does not record (it records `f` and `g`).
  const caller = (name) => ({ type: 'caller', file, label: name, pos: head.indexOf(`${name}()`) });
  const before = [identity()(caller('first')), identity()(caller('second'))];
  assert.notEqual(before[0], before[1]);
  head = head.replace('second() { target(); }', 'second() { target(); target(); }');
  assert.equal(identity()(caller('first')), before[0], 'an edit to a sibling must not unreview this caller');
  assert.notEqual(identity()(caller('second')), before[1]);
});

test('preview identities come from the PR, never from the local checkout', async () => {
  const { previewRevisions } = require('../src/review-identity');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'it-preview-id-'));
  try {
    const base = 'export function kept() { return 1; }\nexport function gone() {}\n';
    const head = 'export function kept() { return 2; }\n';
    const patchOf = (b, h) => `@@ -1,${b.trimEnd().split('\n').length} +1,${h.trimEnd().split('\n').length} @@\n`
      + b.trimEnd().split('\n').map((l) => `-${l}`).join('\n') + '\n' + h.trimEnd().split('\n').map((l) => `+${l}`).join('\n');
    const preview = async (lockPatch) => {
      const gh = {
        listPullRequestFiles: async () => ({ files: [
          { path: 'a.ts', status: 'modified', patch: patchOf(base, head), sha: 'aaa' },
          { path: 'package-lock.json', status: 'modified', patch: lockPatch, sha: 'bbb' },
          { path: 'logo.png', status: 'modified', patch: null, sha: null },
        ] }),
        fileAtRef: async (_, p, ref) => (p === 'a.ts' ? (ref === 'head' ? head : base) : null),
      };
      return analyzeRemote({ ts, gh, slug: {}, pr: { number: 7, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: repo });
    };
    const rowsOf = (result) => {
      const provider = createTreeProvider(require('./vscode-stub'), {
        getState: () => ({ result, rel: (f) => path.relative(repo, f), absPath: (p) => path.join(repo, p) }), resolver: {},
      });
      return Promise.all(['deleted', 'files'].map((key) => provider.getChildren({ type: 'section', key }))).then((r) => r.flat());
    };
    const idsOf = async (result) => {
      const identity = createReviewIdentity(ts, repo, previewRevisions(result));
      return Object.fromEntries((await rowsOf(result)).filter((r) => r.type === 'deleted' || r.type === 'file')
        .map((r) => [`${r.type}:${r.relPath || r.label}:${r.label}`, identity(r)]));
    };
    const result = await preview('@@ -1 +1 @@\n-1\n+2');
    // Local files at the same paths, in any state, must not matter.
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function gone() { local(); }\n');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"local":1}');
    const first = await idsOf(result);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'something else entirely\n');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"local":2}');
    assert.deepEqual(await idsOf(result), first);
    assert.ok(Object.keys(first).some((k) => k.startsWith('deleted:') && first[k]), `a deleted row was expected: ${Object.keys(first)}`);
    const lockKey = Object.keys(first).find((k) => k.includes('package-lock.json'));
    assert.ok(first[lockKey], 'a listed file with a blob id keeps a persisted identity');
    assert.equal(first[Object.keys(first).find((k) => k.includes('logo.png'))], null, 'nothing identifies this file, so it is not persisted');
    // The PR changing that file again does change its identity.
    const second = await idsOf(await preview('@@ -1 +1 @@\n-1\n+3'));
    assert.notEqual(second[lockKey], first[lockKey]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    clearVirtualText();
  }
});

test('local review identities reuse the base texts the analysis loaded', async () => {
  const { analyze } = require('../src/engine/analyze');
  const { makeGit } = require('../src/engine/git');
  const { localRevisions } = require('../src/review-identity');
  const { execFileSync } = require('child_process');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-base-texts-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    write('tsconfig.json', JSON.stringify({ include: ['src'] }));
    write('.gitignore', 'node_modules\n');
    write('src/a.ts', 'export function target(n: number) { return n; }\nexport function old() {}\n');
    write('src/b.ts', 'import { target } from "./a";\nexport function caller() { return target(1); }\n');
    write('src/a.test.ts', 'import { target } from "./a";\ntarget(1);\n');
    write('notes.txt', 'one\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(repo, 'node_modules', 'typescript'));
    write('src/a.ts', 'export function target(n: number, m = 0) { return n + m; }\n');
    write('src/b.ts', 'import { target } from "./a";\nexport function caller() { return target(2); }\n');
    write('src/a.test.ts', 'import { target } from "./a";\ntarget(2);\n');
    write('notes.txt', 'two\n');
    const result = await analyze(repo, { mode: 'working' });
    assert.equal(result.baseTexts.get('src/a.ts'), 'export function target(n: number) { return n; }\nexport function old() {}\n');
    assert.equal(result.baseTexts.get('src/a.test.ts'), 'import { target } from "./a";\ntarget(1);\n', 'changed tests are loaded too');

    const real = makeGit(repo);
    const calls = { show: 0, blobIds: 0 };
    const counted = { ...real, show: (...a) => { calls.show++; return real.show(...a); }, blobIds: (...a) => { calls.blobIds++; return real.blobIds(...a); } };
    const identity = createReviewIdentity(ts, repo, localRevisions(repo, result, counted));
    const rows = [
      ...result.allChanged.map((c) => ({ type: 'finding', file: c.file, pos: c.namePos, label: c.label })),
      ...result.allChanged.flatMap((c) => (c.callers || []).map((k) => ({ type: 'caller', file: k.file, pos: k.pos, label: k.label }))),
      ...result.deleted.map((d) => ({ type: 'deleted', file: d.file, relPath: d.relPath, label: d.label, key: d.key })),
      ...result.otherFiles.map((f) => ({ type: 'file', relPath: f.path })),
    ];
    assert.ok(rows.some((r) => r.type === 'deleted') && rows.some((r) => r.type === 'file') && rows.some((r) => r.type === 'caller'));
    const ids = rows.map(identity);
    assert.ok(ids.every((id) => typeof id === 'string'), JSON.stringify(rows.filter((r, i) => !ids[i])));
    assert.equal(calls.show, 0, 'no `git show` per file');
    assert.ok(calls.blobIds <= 1, 'whole-file rows share one batch');
    // The base blob still decides a file row's identity.
    const fileRow = rows.find((r) => r.type === 'file');
    git('add', 'notes.txt'); git('commit', '-qm', 'notes moved on');
    const later = createReviewIdentity(ts, repo, localRevisions(repo, { ...result, base: { ...result.base, sha: git('rev-parse', 'HEAD') } }, real));
    assert.notEqual(later(fileRow), identity(fileRow));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---- impactTree.concurrency: an unusable value must not stop analysis ------------------
const CONCURRENCY_CASES = [
  [0, 'invalid'], [-1, 'invalid'], [NaN, 'invalid'], [0.5, 'invalid'], ['abc', 'invalid'], [Infinity, 'invalid'],
  [null, 'omitted'], [undefined, 'omitted'], [1, 'ok'], [2.7, 'ok'], [32, 'ok'], [33, 'clamped'], [1000, 'clamped'],
];
const concurrencyWarnings = (r) => r.warnings.filter((w) => w.includes('impactTree.concurrency'));
const assertConcurrencyWarnings = (r, kind, value) => {
  const used = { invalid: 8, omitted: 8, clamped: 32 }[kind] ?? Math.floor(value);
  assert.equal(r.concurrency, used, `${String(value)} reports the worker count it used`);
  const found = concurrencyWarnings(r);
  if (kind === 'invalid' || kind === 'clamped') {
    assert.equal(found.length, 1, `${String(value)}: ${JSON.stringify(r.warnings)}`);
    assert.ok(found[0].includes(String(value)), `names the bad value: ${found[0]}`);
  } else assert.deepEqual(found, [], String(value));
};

test('remote analysis resolves every symbol whatever impactTree.concurrency holds', async () => {
  const pr = { number: 2, headSha: 'head', mergeBaseSha: 'base' };
  const texts = {
    'lib/target.ts@base': 'export function target() { return 0; }\n',
    'lib/target.ts@head': 'export function target(required: string) { return 1; }\n',
    'lib/use.ts@head': "import { target } from './target'; export function caller() { target(); }\n",
    'lib/use.ts@base': "import { target } from './target'; export function caller() { target(); }\n",
  };
  const gh = {
    listPullRequestFiles: async () => ({ total: 2, files: ['lib/target.ts', 'lib/use.ts'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' })) }),
    fileAtRef: async (_, p, ref) => texts[`${p}@${ref}`] ?? null,
  };
  for (const [value, kind] of CONCURRENCY_CASES) {
    clearVirtualText();
    const r = await analyzeRemote({ ts, gh, slug: {}, pr, repoRoot: root, concurrency: value });
    assert.deepEqual(r.allChanged.find((c) => c.label === 'target').callers.map((c) => c.label), ['caller'], String(value));
    assertConcurrencyWarnings(r, kind, value);
  }
  clearVirtualText();
});

test('local analysis resolves every symbol whatever impactTree.concurrency holds', async () => {
  const { analyze } = require('../src/engine/analyze');
  const { execFileSync } = require('child_process');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-concurrency-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    write('tsconfig.json', JSON.stringify({ include: ['src'] }));
    write('.gitignore', 'node_modules\n');
    write('src/a.ts', 'export function target(n: number) { return n; }\n');
    write('src/b.ts', 'import { target } from "./a";\nexport function caller() { return target(1); }\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(repo, 'node_modules', 'typescript'));
    write('src/a.ts', 'export function target(n: number, m = 0) { return n + m; }\n');
    for (const [value, kind] of CONCURRENCY_CASES) {
      const r = await analyze(repo, { mode: 'working', skipForest: true, deferTestReach: true, concurrency: value });
      const target = r.allChanged.find((c) => c.label === 'target');
      assert.equal(target.callerState, 'resolved', String(value));
      assert.deepEqual(target.callers.map((c) => c.label), ['caller'], String(value));
      assertConcurrencyWarnings(r, kind, value);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mapLimit rejects a limit that is not a positive safe integer', async () => {
  const { mapLimit } = require('../src/engine/concurrency');
  for (const limit of [0, -1, NaN, 0.5, 1.5, Infinity, '2', null, undefined]) {
    await assert.rejects(mapLimit([1], limit, async (x) => x), RangeError, String(limit));
  }
  assert.deepEqual(await mapLimit([1, 2, 3], 2, async (x) => x * 2), [2, 4, 6]);
  assert.deepEqual(await mapLimit([], 1, async (x) => x), []);
});

test('package.json bounds impactTree.concurrency to 1..32', () => {
  const setting = require('../package.json').contributes.configuration.properties['impactTree.concurrency'];
  assert.equal(setting.minimum, 1); assert.equal(setting.maximum, 32);
});

// ---- TypeScript resolver: a query that threw is not an answer --------------------------
test('a failed TypeScript query is unknown, never cached, and never "no callers"', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-ts-fail-')));
  try {
    const files = {
      'tsconfig.json': '{"include":["*.ts"]}',
      'a.ts': 'export function target() {}\nexport function lonely() {}\nexport function viaValue() {}\n',
      'b.ts': "import { target, viaValue } from './a'; export function caller() { target(); }\nexport function pass() { [1].map(viaValue); }\n",
    };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const file = path.join(dir, 'a.ts');
    const at = (name) => files['a.ts'].indexOf(`function ${name}`) + 'function '.length;

    // The real compiler, with failures injected by wrapping the services it creates.
    const failing = new Set();
    const flaky = { ...ts, createLanguageService: (...a) => {
      const ls = ts.createLanguageService(...a);
      for (const method of ['provideCallHierarchyIncomingCalls', 'findReferences']) {
        const real = ls[method].bind(ls);
        ls[method] = (...args) => { if (failing.has(method)) throw new Error(`${method} failed`); return real(...args); };
      }
      return ls;
    } };
    const resolver = require('../src/engine/resolver-ts').createTsResolver(flaky, dir, { filterInherited: false });

    failing.add('provideCallHierarchyIncomingCalls');
    for (const name of ['target', 'lonely']) {
      const r = await resolver.callerState(file, at(name));
      assert.equal(r.state, 'unknown', name); assert.equal(r.reason, 'query-failed', name); assert.deepEqual(r.callers, []);
    }
    assert.deepEqual(await resolver.incoming(file, at('target')), [], 'incoming still returns a plain array');
    failing.clear();
    // the failures above were not cached: the same questions now get real answers
    assert.deepEqual((await resolver.callerState(file, at('target'))).callers.map((c) => c.label), ['caller']);
    assert.equal((await resolver.callerState(file, at('lonely'))).state, 'none', 'a genuine empty answer is still none');

    // an empty hierarchy plus a failed findReferences is not "none" either, and also retries
    const fresh = require('../src/engine/resolver-ts').createTsResolver(flaky, dir, { filterInherited: false });
    failing.add('findReferences');
    const refsDown = await fresh.callerState(file, at('lonely'));
    assert.equal(refsDown.state, 'unknown'); assert.equal(refsDown.reason, 'query-failed');
    failing.clear();
    assert.equal((await fresh.callerState(file, at('lonely'))).state, 'none');
    assert.equal((await fresh.callerState(file, at('viaValue'))).state, 'unknown', 'passed as a value: referenced, not called');
    resolver.dispose(); fresh.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    assert.equal(session.phase, 'ready', 'the user can still proceed');
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

// A class's identity is its declaration (file + name); a same-named class elsewhere is a different class.
const saveCallers = (idx, file, className) => idx.callersOf({ file: path.join(root, file), className, name: 'save' }).map((c) => c.label);
const holder = (importLine, type, owner = 'Svc') => `${importLine} export class ${owner} { constructor(private repo: ${type}) {} run() { this.repo.save(); } }`;

test('a same-named unrelated class does not hide a real caller through inheritance', () => {
  const idx = build({
    'a/base.ts': 'export class Base { save() {} }',
    'a/user-repo.ts': "import { Base } from './base'; export class UserRepo extends Base {}",
    'z/user-repo.ts': 'export class UserRepo { save() {} }',
    'c/svc.ts': holder("import { UserRepo } from '../a/user-repo';", 'UserRepo'),
  });
  assert.deepEqual(saveCallers(idx, 'a/base.ts', 'Base'), ['Svc.run']);
});

test('a same-named class elsewhere does not invent a caller of an unrelated class', () => {
  const idx = build({
    'a/repo.ts': 'export class Repo { save() {} }',
    'b/base.ts': 'export class Base { save() {} }',
    'b/repo.ts': "import { Base } from './base'; export class Repo extends Base {}",
    'c/u.ts': holder("import { Base } from '../b/base';", 'Base'),
  });
  assert.deepEqual(saveCallers(idx, 'a/repo.ts', 'Repo'), []);
  assert.deepEqual(saveCallers(idx, 'b/base.ts', 'Base'), ['Svc.run']);
});

test('two same-named hierarchies each reach only their own callers', () => {
  const idx = build({
    'a/base.ts': 'export class Base { save() {} }',
    'a/repo.ts': "import { Base } from './base'; export class Repo extends Base {}",
    'b/base.ts': 'export class Base { save() {} }',
    'b/repo.ts': "import { Base } from './base'; export class Repo extends Base {}",
    'c/ua.ts': holder("import { Repo } from '../a/repo';", 'Repo', 'UserA'),
    'c/ub.ts': holder("import { Repo } from '../b/repo';", 'Repo', 'UserB'),
  });
  assert.deepEqual(saveCallers(idx, 'a/base.ts', 'Base'), ['UserA.run']);
  assert.deepEqual(saveCallers(idx, 'b/base.ts', 'Base'), ['UserB.run']);
});

test('a caller typed as the port still finds the adapter, not a same-named adapter elsewhere', () => {
  const idx = build({
    'a/port.ts': 'export interface Port { save(): void; }',
    'a/adapter.ts': "import { Port } from './port'; export class Adapter implements Port { save() {} }",
    'b/adapter.ts': 'export class Adapter { save() {} }',
    'c/svc.ts': holder("import { Port } from '../a/port';", 'Port'),
  });
  assert.deepEqual(saveCallers(idx, 'a/adapter.ts', 'Adapter'), ['Svc.run']);
  assert.deepEqual(saveCallers(idx, 'b/adapter.ts', 'Adapter'), []);
});

const externalImpl = { 'a/impl.ts': "import { Port } from 'external-lib'; export class Impl implements Port { save() {} }", 'c/svc.ts': holder("import { Port } from 'external-lib';", 'Port') };

test('a heritage parent outside the source set still links by its name', () => {
  assert.deepEqual(saveCallers(build(externalImpl), 'a/impl.ts', 'Impl'), ['Svc.run']);
});

test('an unresolved name never meets a same-named class that is in the source set', () => {
  const idx = build({
    ...externalImpl,
    'b/port.ts': 'export interface Port { save(): void; }',
    'c/other.ts': holder("import { Port } from '../b/port';", 'Port', 'Other'),
  });
  assert.deepEqual(saveCallers(idx, 'a/impl.ts', 'Impl'), ['Svc.run']);
});

test('this and super calls reach only the base class the subclass actually extends', () => {
  const idx = build({
    'a/base.ts': 'export class Base { save() {} }',
    'b/base.ts': 'export class Base { save() {} }',
    'c/child.ts': "import { Base } from '../a/base'; export class Child extends Base { run() { this.save(); } again() { super.save(); } }",
  });
  assert.deepEqual(saveCallers(idx, 'a/base.ts', 'Base').sort(), ['Child.again', 'Child.run']);
  assert.deepEqual(saveCallers(idx, 'b/base.ts', 'Base'), []);
});

test('a CQRS handler is not confused with a same-named class elsewhere', () => {
  const idx = build({
    'a/cmd.ts': 'export class DoThing {}',
    'a/handler.ts': "import { CommandHandler } from '@nestjs/cqrs'; import { DoThing } from './cmd'; @CommandHandler(DoThing) export class Handler { execute() {} }",
    'b/handler.ts': 'export class Handler { execute() {} }',
    'c/api.ts': "import { DoThing } from '../a/cmd'; export class Api { post() { this.bus.execute(new DoThing()); } }",
  });
  const executeCallers = (file) => idx.callersOf({ file: path.join(root, file), className: 'Handler', name: 'execute' }).map((c) => c.label);
  assert.deepEqual(executeCallers('a/handler.ts'), ['Api.post']);
  assert.deepEqual(executeCallers('b/handler.ts'), []);
});
