'use strict';
// Inheritance filter, CQRS, git, signatures, untracked callers, and concurrency.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createTreeProvider } = require('../src/tree-provider');
const { createInheritanceFilter } = require('../src/engine/inheritance');
const { ts, root, CONCURRENCY_CASES, assertConcurrencyWarnings } = require('./bug-regressions-helpers');

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
  const rows = await provider.getChildren({ type:'caller', file:a.file, pos:10 });
  assert.deepEqual(rows.map((r) => r.label),['kept']);
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
