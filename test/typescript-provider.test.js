'use strict';
// TypeScript behind its language provider (T3, docs/MULTI_LANGUAGE_PLAN.md): the registry
// hands out the provider, its `prepare` yields the units the pipeline's own per-project
// loop produced before the move, a language whose `prepare` fails is reported as not
// analysed without blanking the others, and a review with no TypeScript file never loads
// the compiler.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { LANGUAGES, languageFor, useLanguagesForTest } = require('../src/languages');
const { typescriptProvider } = require('../src/languages/typescript/provider');
const { typescriptRules } = require('../src/languages/typescript/rules');
const { analyze, rangesFor } = require('../src/engine/analyze');
const { makeGit } = require('../src/engine/git');
const { changedFiles, isSourcePath, isTestPath } = require('../src/engine/diff');
const { AnalysisCancelledError, isAnalysisCancelled } = require('../src/engine/cancellation');
const typescriptLoader = require('../src/languages/typescript/load');

/** A throwaway repository: `base` committed on main, then `head` committed on a branch. */
function repoWith(base, head) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-ts-provider-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  };
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  write(base); git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feature');
  write(head); git('add', '-A'); git('commit', '-qm', 'head');
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const run = (dir) => analyze(dir, { mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true });

/** Counts the compiler loads the analysis asks for, until `restore()`. */
function countTypeScriptLoads() {
  const real = typescriptLoader.loadTypeScript;
  const counter = { loads: 0, restore: () => { typescriptLoader.loadTypeScript = real; } };
  typescriptLoader.loadTypeScript = (...args) => { counter.loads++; return real(...args); };
  return counter;
}

/** A second language for the registry seam: `.fake` files, whose `prepare` is given. */
const fakeLanguage = (prepare) => Object.freeze({
  id: 'fake', displayName: 'Fake', handles: (rel) => rel.endsWith('.fake'), isTest: () => false,
  isGenerated: () => false, needsServer: true, prepare,
});

test('the registry hands out the TypeScript provider, with the same file rules', () => {
  // Go is registered after TypeScript (G2); TypeScript is still asked first.
  assert.equal(LANGUAGES[0], typescriptProvider);
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['typescript', 'go', 'python', 'java']);
  assert.equal(languageFor('src/a.ts'), typescriptProvider);
  assert.equal(languageFor('src/a.jsx'), typescriptProvider);
  assert.equal(typescriptProvider.needsServer, false);
  assert.equal(typeof typescriptProvider.prepare, 'function');
  assert.equal(typeof typescriptProvider.editorCallers, 'function');
  assert.ok(!('trivia' in typescriptProvider), 'comment-only lines are the provider\'s business, not the interface\'s');
  for (const key of ['id', 'displayName', 'handles', 'isTest', 'isGenerated']) {
    assert.equal(typescriptProvider[key], typescriptRules[key], key);
  }
});

// Captured from the per-project loop analyze.js ran before the provider existed (8f3f5fd),
// on the synthetic fixture's `pr` diff: [relPath, label, key, namePos, startLine, endLine,
// component, projectRoot, kinds, baseSig, headSig, added].
const OLD_UNITS = [
  { component: 'packages/api', changed: [
    ['packages/api/src/orders/checkout.ts', 'createOrder', 'createOrder', 141, 7, 10, 'packages/api', 'packages/api', 'body', '(items: LineItem[]) => Order', '(items: LineItem[]) => Order', false],
    ['packages/api/src/pricing/quote.ts', 'quoteFor', 'quoteFor', 774, 20, 24, 'packages/api', 'packages/api', 'optional-param', '(items: LineItem[], currency: string) => Quote', '(items: LineItem[], currency: string, options?: QuoteOptions) => Quote', false],
    ['packages/api/src/pricing/rounding.ts', 'roundMoney', 'roundMoney', 99, 2, 10, 'packages/api', 'packages/api', 'body', null, "(n: number, mode?: 'half-up' | 'bankers') => number", true],
  ], deleted: [
    ['packages/api/src/pricing/quote.ts', 'legacyRounding', 'legacyRounding', 643, 16, 18, 'packages/api', 'packages/api', '', null, null, null],
  ], outside: [
    ['packages/api/src/pricing/quote.ts', [[4, 5], [10, 11]]],
    ['packages/api/src/pricing/rounding.ts', [[1, 1]]],
  ] },
  { component: 'packages/web', changed: [
    ['packages/web/src/components/PriceTag.tsx', 'PriceTag', 'PriceTag', 331, 12, 22, 'packages/web', 'packages/web', 'body', '({ amount, currency, listPrice, compact }: PriceTagProps) => ⟨inferred⟩', '({ amount, currency, listPrice, compact }: PriceTagProps) => ⟨inferred⟩', false],
    ['packages/web/src/format.ts', 'formatPrice', 'formatPrice', 16, 1, 3, 'packages/web', 'packages/web', 'body', '(amount: number, currency: string) => string', '(amount: number, currency: string) => string', false],
  ], deleted: [], outside: [] },
];

test('prepare on the synthetic fixture yields the units the old per-project loop gave', async () => {
  const repo = require('./fixture-repo').fixtureRepo();
  const git = makeGit(repo);
  const base = git.mergeBase(git.revParse('main'), 'HEAD');
  const files = changedFiles(git, base, 'HEAD', null).filter((f) => isSourcePath(f.path) && !isTestPath(f.path));
  const deletions = {};
  const changedRanges = rangesFor(git, base, 'HEAD', files, { deletionsOut: deletions });
  const baseTexts = git.showMany(base, files.filter((f) => f.status !== 'added').map((f) => f.oldPath || f.path));
  const warnings = [], progress = [];
  const { units, extras } = await typescriptProvider.prepare({
    repo, git, files, baseTexts, changedRanges, deletions, warnings, unanalysable: new Map(),
    report: (event) => progress.push(event), signal: undefined, hooks: {},
  });
  try {
    const sym = (s) => [s.relPath, s.label, s.key, s.namePos, s.startLine, s.endLine, s.component, s.projectRoot,
      (s.kinds || []).map((k) => k.id).join('+'), s.baseSig ?? null, s.headSig ?? null, s.added ?? null];
    assert.deepEqual(units.map((u) => ({
      component: u.component, changed: u.changed.map(sym), deleted: u.deleted.map(sym),
      outside: u.outside.map((o) => [o.relPath, o.ranges]),
    })), OLD_UNITS);
    assert.deepEqual(units.map((u) => u.projectRoot), ['packages/api', 'packages/web']);
    for (const u of units) for (const o of u.outside) assert.equal(o.file, path.join(repo, o.relPath));
    assert.deepEqual(warnings, [], 'both projects have a tsconfig.json');
    assert.deepEqual(progress.map((p) => [p.phase, p.component, p.done, p.total]),
      [['component', 'packages/api', 0, 2], ['component', 'packages/web', 1, 2]]);
    // Each unit's resolver answers for its symbols; the stale caller is found.
    const quoteFor = units[0].changed.find((c) => c.label === 'quoteFor');
    const answer = await units[0].resolver.callerState(quoteFor.file, quoteFor.namePos, { isConstructor: false });
    assert.equal(answer.state, 'resolved');
    assert.ok(answer.callers.some((c) => c.label === 'buildInvoice'), answer.callers.map((c) => c.label).join(', '));
    assert.ok('moduleCallers' in extras.resultProperties);
    assert.ok(Array.isArray(extras.notes()));
  } finally {
    extras.dispose();
  }
});

test('a language whose prepare throws is reported as not analysed; the other languages are still analysed', async () => {
  const repo = repoWith(
    { 'src/a.ts': 'export function target(a: number) { return a; }\n', 'src/b.fake': 'one\n' },
    { 'src/a.ts': 'export function target(a: number, b: string) { return a; }\n', 'src/b.fake': 'two\n' },
  );
  const restore = useLanguagesForTest([typescriptProvider, fakeLanguage(async (ctx) => {
    ctx.warnings.push('a warning from the half-done preparation');
    ctx.unanalysable.set('somewhere', 1);
    throw new Error('the fake language server is not installed');
  })]);
  try {
    const result = await run(repo.dir);
    assert.ok(result.warnings.includes('1 changed Fake file(s) NOT analysed — the fake language server is not installed'), result.warnings.join('\n'));
    assert.ok(!result.warnings.includes('a warning from the half-done preparation'), 'a failed preparation adds nothing but its failure');
    assert.deepEqual(result.unanalysable, [{ component: 'Fake', count: 1 }]);
    assert.deepEqual(result.otherFiles.map((f) => [f.path, f.noCallable]), [['src/b.fake', true]], 'the file stays visible');
    assert.ok(result.changedPaths.includes('src/b.fake'));
    assert.deepEqual(result.otherFiles.map((f) => f.notAnalysed),
      [{ language: 'Fake', reason: 'the fake language server is not installed' }], 'the reason is on the file itself');
    assert.equal(result.otherFiles.some((f) => f.path === 'src/a.ts'), false);
    assert.deepEqual(result.allChanged.map((c) => [c.relPath, c.label, c.kinds.map((k) => k.id).join('+')]),
      [['src/a.ts', 'target', 'required-param']], 'the TypeScript file is analysed');
    assert.equal(result.allChanged[0].callerState, 'none', 'and its callers searched');
  } finally {
    restore();
    repo.remove();
  }
});

test('a cancellation inside a language\'s prepare cancels the run; it is not a failed language', async () => {
  const repo = repoWith({ 'src/b.fake': 'one\n' }, { 'src/b.fake': 'two\n' });
  const restore = useLanguagesForTest([typescriptProvider, fakeLanguage(async () => { throw new AnalysisCancelledError(); })]);
  try {
    await assert.rejects(run(repo.dir), (e) => isAnalysisCancelled(e));
  } finally {
    restore();
    repo.remove();
  }
});

test('the units of every language are analysed together', async () => {
  const repo = repoWith(
    { 'src/a.ts': 'export function target(a: number) { return a; }\n', 'src/b.fake': 'one\n' },
    { 'src/a.ts': 'export function target(a: number, b: string) { return a; }\n', 'src/b.fake': 'two\n' },
  );
  let disposed = 0;
  const restore = useLanguagesForTest([typescriptProvider, fakeLanguage(async (ctx) => {
    const file = path.join(ctx.repo, 'src/b.fake');
    const symbol = { label: 'fakeFn', key: 'fakeFn', simpleName: 'fakeFn', namePos: 0, startLine: 1, endLine: 1, start: 0, end: 3,
      isConstructor: false, exported: true, sig: { async: false, params: [], returns: null }, throws: new Set(),
      file, relPath: 'src/b.fake', oldPath: 'src/b.fake', component: 'fake', projectRoot: '', fileStatus: 'modified',
      added: false, baseSig: '()', headSig: '()', kinds: [{ id: 'body', weight: 1, label: 'body', short: 'body' }], throwsAdded: [] };
    ctx.warnings.push('fake: one file prepared');
    return {
      units: [{ component: 'fake', changed: [symbol], deleted: [], outside: [], resolver: {
        callerState: async () => ({ state: 'none', callers: [], complete: true }), incoming: async () => [],
      } }],
      extras: { notes: () => ['fake: callers done'], dispose: () => { disposed++; } },
    };
  })]);
  try {
    const result = await run(repo.dir);
    assert.deepEqual(result.components.map((c) => c.component), ['(inferred)', 'fake']);
    assert.deepEqual(result.allChanged.map((c) => c.label).sort(), ['fakeFn', 'target']);
    assert.ok(result.warnings.indexOf('fake: one file prepared') < result.warnings.indexOf('fake: callers done'));
    assert.equal(disposed, 1, 'what the units share is released once');
    assert.deepEqual(result.unanalysable, []);
  } finally {
    restore();
    repo.remove();
  }
});

test('a review with no TypeScript file never loads TypeScript', async () => {
  const docs = repoWith({ 'README.md': 'one\n', 'config.yml': 'a: 1\n' }, { 'README.md': 'two\n', 'config.yml': 'a: 2\n' });
  const other = repoWith({ 'src/b.fake': 'one\n' }, { 'src/b.fake': 'two\n' });
  const typescript = repoWith({ 'a.ts': 'export function f() {}\n' }, { 'a.ts': 'export function f(a = 1) {}\n' });
  const counter = countTypeScriptLoads();
  try {
    const result = await run(docs.dir);
    assert.deepEqual(result.otherFiles.map((f) => f.path), ['README.md', 'config.yml']);
    assert.deepEqual(result.components, []);
    assert.equal(counter.loads, 0, 'only documents changed');
    assert.equal(typescriptLoader.loadTypeScriptIfUsed(docs.dir, Object.keys(result.fileStatus)), null, 'nor for their review identity');

    const restore = useLanguagesForTest([typescriptProvider, fakeLanguage(async () => ({ units: [] }))]);
    try { await run(other.dir); } finally { restore(); }
    assert.equal(counter.loads, 0, 'only another language\'s files changed');

    await run(typescript.dir);
    assert.ok(counter.loads > 0, 'a TypeScript file does load it, through the same loader');
  } finally {
    counter.restore();
    docs.remove(); other.remove(); typescript.remove();
  }
});
