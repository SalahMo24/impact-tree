'use strict';
// Review ticks and identities for local runs and PR previews.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { createReviewState } = require('../src/review-state');
const { createReviewIdentity } = require('../src/review-identity');
const { createTreeProvider } = require('../src/tree-provider');
const { createPrDocuments, prQuery } = require('../src/pr-documents');
const { registerVirtualText, clearVirtualText } = require('../src/engine/textpos');
const { ts, root } = require('./bug-regressions-helpers');

test('preview documents hold only the current revision, and paths with punctuation still resolve', () => {
  const docs = createPrDocuments();
  const a = { prNumber: 1, headSha: 'one', base: { sha: 'base' }, texts: new Map([['a?#.ts', { head: 'first', base: null }]]) };
  const b = { ...a, prNumber: 2, texts: new Map([['a?#.ts', { head: 'second' }]]) };
  const c = { ...a, headSha: 'pushed', texts: new Map([['a?#.ts', { head: 'updated' }]]) };
  const read = (r, side) => docs.read({ path: '/a?#.ts', query: prQuery(r, side) });
  for (const r of [a, b, c]) {
    docs.add(r);
    assert.equal(read(r, 'head'), r.texts.get('a?#.ts').head);
    for (const other of [a, b, c].filter((o) => o !== r)) assert.equal(read(other, 'head'), null, 'another revision is not held');
  }
  assert.equal(read(c, 'base'), null, 'a side with no text is a miss for the provider to settle, not an empty file');
  assert.equal(docs.read({ path: '/a?#.ts', query: prQuery(c, 'base', { path: 'a?#.ts', status: 'added' }) }), '');
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
