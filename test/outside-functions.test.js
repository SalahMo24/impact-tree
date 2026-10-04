'use strict';
// Changed lines that sit in no callable (imports, constants, types) get their own
// reviewable row. Engine results for local runs and PR previews, the tree row, and its
// content-based review identity.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vscode = require('./vscode-stub');
const { analyze } = require('../src/engine/analyze');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const { createLocalHarness } = require('./local-repo');
const { createTreeProvider } = require('../src/tree-provider');
const { createReviewState } = require('../src/review-state');
const { createReviewIdentity, localRevisions, previewRevisions } = require('../src/review-identity');
const models = require('../src/tree-row-models');
const { ts } = require('./bug-regressions-helpers');

const h = createLocalHarness();
const FILE = 'src/a.ts';
const FIRST = 'a changed function, a new import and a changed constant';
const SCENARIOS = {
  [FIRST]: {
    base: "import { a } from './a';\nexport const LIMIT = 1;\nexport function f(x: number) {\n  return x;\n}\n",
    head: "import { a } from './a';\nimport { b } from './b';\nexport const LIMIT = 2;\nexport function f(x: number) {\n  return x + 1;\n}\n",
    outside: [2, 3],
  },
  'a change entirely inside a function': {
    base: "import { a } from './a';\nexport function f(x: number) {\n  return x;\n}\n",
    head: "import { a } from './a';\nexport function f(x: number) {\n  return x + 1;\n}\n",
    outside: null,
  },
  'a removed import beside a changed function': {
    base: "import { a } from './a';\nimport { b } from './b';\nexport function f(x: number) {\n  return x;\n}\n",
    head: "import { a } from './a';\nexport function f(x: number) {\n  return x + 1;\n}\n",
    outside: [1.5],
  },
  'a removed import and a modified signature in one replacement': {
    base: "import { a } from './a';\nexport function f(x: number) {\n  return x;\n}\n",
    head: "export function f(x: string) {\n  return x;\n}\n",
    outside: [0.5],
  },
  'a removed constant and a modified signature in one replacement': {
    base: "export const LIMIT = 1;\nexport function f(x: number) {\n  return x;\n}\n",
    head: "export function f(x: string) {\n  return x;\n}\n",
    outside: [0.5],
  },
  'an edited import and signature already name the outside replacement lines': {
    base: "import { a } from './a';\nexport function f(x: number) {\n  return x;\n}\n",
    head: "import { b } from './b';\nexport function f(x: string) {\n  return x;\n}\n",
    outside: [1],
  },
  'a line deleted from inside a function': {
    base: "import { a } from './a';\nexport function f(x: number) {\n  const y = 1;\n  return x;\n}\n",
    head: "import { a } from './a';\nexport function f(x: number) {\n  return x;\n}\n",
    outside: null,
  },
  'a deleted function with its doc comment': {
    base: "import { a } from './a';\nexport function f(x: number) {\n  return x;\n}\n\n/** Goes away. */\nexport function g() {\n  return 1;\n}\n",
    head: "import { a } from './a';\nexport function f(x: number) {\n  return x + 1;\n}\n",
    outside: null,
  },
  'a deleted function and the import after it in one hunk': {
    base: "export function f(x: number) {\n  return x;\n}\nexport function g() {\n  return 1;\n}\nimport { b } from './b';\n",
    head: "export function f(x: number) {\n  return x + 1;\n}\n",
    outside: [3.5],
  },
};
// a marker is one number: the gap before that line; otherwise an inclusive [first, last]
const rangesOf = (spec) => (spec.length === 1 ? [[spec[0], spec[0]]] : [spec]);
const outsideOf = (result) => (result.outside || []).filter((o) => o.relPath === FILE);
const assertOutside = (result, s, name) => {
  const got = outsideOf(result);
  if (!s.outside) return assert.deepEqual(got, [], name);
  assert.equal(got.length, 1, name);
  assert.deepEqual(got[0].ranges, rangesOf(s.outside), name);
  return got[0];
};

test('local analysis reports changed lines outside every callable', { skip: !h && 'typescript not resolvable' }, async () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    const dir = h.mkRepo({ 'tsconfig.json': h.TSCONFIG, [FILE]: s.base });
    const base = h.headOf(dir);
    h.write(dir, { [FILE]: s.head });
    h.commit(dir);
    const got = assertOutside(await analyze(dir, h.since(base)), s, name);
    if (s.outside) assert.equal(got.file, path.join(dir, FILE), name);
  }
});

test('a file whose only change is outside functions stays under "Files without a call graph" alone', { skip: !h && 'typescript not resolvable' }, async () => {
  const dir = h.mkRepo({ 'tsconfig.json': h.TSCONFIG, [FILE]: "import { a } from './a';\nexport function f() {}\n" });
  const base = h.headOf(dir);
  h.write(dir, { [FILE]: "import { a } from './a';\nimport { b } from './b';\nexport function f() {}\n" });
  h.commit(dir);
  const result = await analyze(dir, h.since(base));
  assert.deepEqual(result.otherFiles, [{ path: FILE, status: 'modified', noCallable: true }]);
  assert.deepEqual(outsideOf(result), []);
});

// The PR preview gets the same texts and the diff git itself computes for them.
test('a PR preview reports the same outside ranges as a local run', { skip: !h && 'typescript not resolvable' }, async () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    const dir = h.mkRepo({ 'tsconfig.json': h.TSCONFIG, [FILE]: s.base });
    const base = h.headOf(dir);
    h.write(dir, { [FILE]: s.head });
    const head = h.commit(dir);
    const diff = h.run(dir, ['diff', '--unified=3', base, head, '--', FILE]);
    const gh = {
      listPullRequestFiles: async () => ({ files: [{ path: FILE, status: 'modified', patch: diff.slice(diff.indexOf('@@')) }] }),
      fileAtRef: async (_, p, ref) => (ref === 'head' ? s.head : ref === 'base' ? s.base : null),
    };
    const result = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: '/review' });
    assertOutside(result, s, name);
    clearVirtualText();
  }
});

// ---- the tree ----------------------------------------------------------------------
const change = (relPath, label, namePos) => ({
  file: `/repo/${relPath}`, relPath, label, namePos, start: namePos, end: namePos + 10, startLine: 1, component: '(root)',
  kinds: [{ id: 'body', label: 'body' }], throwsAdded: [], callers: [], stale: [], staleCallers: 0, callerState: 'resolved', score: 1,
});
const one = change('src/a.ts', 'one', 10);
const two = change('src/a.ts', 'two', 50);
const solo = change('src/b.ts', 'solo', 10);
const resultOf = (outside) => ({
  allChanged: [one, two, solo], findings: [], deleted: [], warnings: [], unanalysable: [], otherFiles: [], untested: [],
  fileStatus: { 'src/a.ts': 'modified', 'src/b.ts': 'modified' },
  mode: 'working', base: { ref: 'HEAD', sha: '0' }, testReachComputed: true, outside,
});
const viewOf = (outside, review = null) => {
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result: resultOf(outside), rowDetail: 'hover', rel: (f) => f.replace('/repo/', '') }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review,
  });
  const section = async (key) => provider.getChildren((await provider.getChildren()).find((s) => s.key === key));
  return { provider, section };
};
const OUT_A = { file: '/repo/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 4], [22, 22]] };

test('"Outside functions" sits in its file\'s group under Other changes and opens at the first range', async () => {
  const { provider, section } = viewOf([OUT_A]);
  const [group, lone] = await section('other');
  assert.equal(group.type, 'changeFile');
  const rows = await provider.getChildren(group);
  assert.deepEqual(rows.map((r) => r.label), ['one', 'two', 'Outside functions']);
  const item = provider.getTreeItem(rows[2]);
  assert.equal(item.description, 'lines 1–4, 22');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None, 'no expansion, so no callers');
  assert.deepEqual(await provider.getChildren(rows[2]), []);
  assert.equal(item.command.command, 'impactTree.openFile');
  assert.deepEqual(item.command.arguments[0].ranges[0], [1, 4]);
  assert.match(provider.getTreeItem(group).description, /3 changes/, 'it counts as one of the file\'s changes');
  assert.equal(lone.label, 'solo');
});

test('a pure deletion reads as the line it was removed before', async () => {
  const { provider, section } = viewOf([{ ...OUT_A, ranges: [[6.5, 6.5]] }]);
  const rows = await provider.getChildren((await section('other'))[0]);
  assert.equal(provider.getTreeItem(rows.at(-1)).description, 'deleted before line 7');
  assert.equal(models.describeOutsideRanges([[1, 1], [6.5, 6.5], [9, 12]]), 'lines 1, 9–12, deleted before line 7');
});

test('without a group the row names its file; the section counts it', async () => {
  const { provider, section } = viewOf([{ file: '/repo/src/c.ts', relPath: 'src/c.ts', ranges: [[3, 3]] }]);
  const row = (await section('other')).find((r) => r.type === 'outside');
  assert.equal(provider.getTreeItem(row).description, 'c.ts  ·  line 3');
  const sections = await provider.getChildren();
  assert.equal(sections.find((s) => s.key === 'other').count, 4, '3 symbols + 1 outside row');
});

test('ticking the file group ticks its "Outside functions" row, and unticking the row unticks the group', async () => {
  const store = new Map();
  const review = createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
  const { provider, section } = viewOf([OUT_A], review);
  const [group] = await section('other');
  const outsideRow = (await provider.getChildren(group)).find((r) => r.type === 'outside');
  const kids = review.childIds(group);
  assert.equal(kids.length, 3);
  review.setWithChildren(review.id(group), kids, true);
  assert.equal(provider.getTreeItem(outsideRow).checkboxState, vscode.TreeItemCheckboxState.Checked);
  review.set(review.id(outsideRow), false);
  assert.equal(provider.getTreeItem(group).checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  const summary = (await provider.getChildren())[0];
  assert.match(summary.label, /left to review/);
});

// ---- identity ----------------------------------------------------------------------
const ID_BASE = "import { a } from './a';\nexport const LIMIT = 1;\nexport function f(x: number) {\n  return x;\n}\nexport function g() {\n  return 1;\n}\n";
const idOf = (head, base) => {
  const identity = createReviewIdentity(ts, '/review', { headText: () => head, baseText: () => base, fileRevision: () => null });
  return identity({ type: 'outside', file: '/review/a.ts', relPath: 'a.ts', ranges: [[1, 1]] });
};

test('the outside row\'s identity changes with the text outside functions, and only then', () => {
  const head = ID_BASE.replace('LIMIT = 1', 'LIMIT = 2');
  const id = idOf(head, ID_BASE);
  assert.ok(id);
  const edited = head.replace('return x;', 'return x * 2;\n  // more\n  // lines').replace('return 1;', 'return 3;');
  assert.equal(idOf(edited, ID_BASE), id, 'edits inside function bodies keep the id');
  assert.equal(idOf(`${head}export function h() {}\n`, ID_BASE), id, 'a new function beside it keeps the id');
  assert.notEqual(idOf(head.replace("'./a'", "'./b'"), ID_BASE), id, 'an edited import changes it');
  assert.notEqual(idOf(head.replace('LIMIT = 2', 'LIMIT = 3'), ID_BASE), id, 'an edited constant changes it');
  assert.notEqual(idOf(head, ID_BASE.replace('LIMIT = 1', 'LIMIT = 0')), id, 'a different base changes it');
});

test('outside hashes preserve blank lines in literal values on both sides', () => {
  const literals = [
    '`first\nsecond`',
    '`first\n${value}\nsecond`',
    '`first${value}\nsecond`',
    '`first${value}\nsecond${value}third`',
    '`first\n  \t\nsecond`',
    "'first\\\nsecond'",
  ];
  const insertBlankLine = (text) => (text.includes('\\\n')
    ? text.replace('\\\n', '\\\n\\\n') : text.replace('\n', '\n\n'));
  for (const literal of literals) {
    const base = `export const MESSAGE = ${literal};\nexport function f() {}\n`;
    const head = base.replace('first', 'edited');
    const id = idOf(head, base);
    assert.notEqual(idOf(insertBlankLine(head), base), id,
      `head-side literal whitespace matters: ${literal}`);
    assert.notEqual(idOf(head, insertBlankLine(base)), id,
      `base-side literal whitespace matters: ${literal}`);
    assert.equal(idOf(`${head}\nexport function g() {}\n\n`, base), id, 'callable separator lines stay irrelevant');
  }
});

test('a blank line inserted in a template value clears its reviewed outside row', { skip: !h && 'typescript not resolvable' }, async () => {
  const baseText = 'export const MESSAGE = `hello\nworld`;\nexport function f() { return 0; }\n';
  const head = baseText.replace('hello', 'hi').replace('return 0', 'return 1');
  const dir = h.mkRepo({ 'tsconfig.json': h.TSCONFIG, [FILE]: baseText });
  const base = h.headOf(dir);
  const review = createReviewState(null);
  const { makeGit } = require('../src/engine/git');
  const rowFor = async (text) => {
    h.write(dir, { [FILE]: text });
    const result = await analyze(dir, h.since(base, { headRev: null }));
    assert.equal(outsideOf(result).length, 1);
    review.configure('pr-1', createReviewIdentity(h.ts, dir, localRevisions(dir, result, makeGit(dir))));
    return { type: 'outside', ...outsideOf(result)[0] };
  };
  const first = await rowFor(head);
  review.set(review.id(first), true);
  assert.equal(review.isReviewed(review.id(await rowFor(head.replace('return 1', 'return 2')))), true,
    'a function body edit keeps the tick');
  assert.equal(review.isReviewed(review.id(await rowFor(head.replace('hi\nworld', 'hi\n\nworld')))), false,
    'the template value changed, so it must be reviewed again');
});

test('a tick on the row survives a function edit and is lost by an import edit, in a PR preview', async () => {
  const root = '/review';
  const base = "import { a } from './a';\nexport function f(x: number) {\n  return x;\n}\n";
  const head = "import { a } from './a';\nimport { b } from './b';\nexport function f(x: number) {\n  return x + 1;\n}\n";
  const patch = "@@ -1,4 +1,5 @@\n import { a } from './a';\n+import { b } from './b';\n export function f(x: number) {\n-  return x;\n+  return x + 1;\n }";
  const preview = async (headText) => {
    const gh = {
      listPullRequestFiles: async () => ({ files: [{ path: FILE, status: 'modified', patch }] }),
      fileAtRef: async (_, p, ref) => (ref === 'head' ? headText : ref === 'base' ? base : null),
    };
    const result = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: root });
    return { row: { type: 'outside', ...result.outside[0] }, identity: createReviewIdentity(ts, root, previewRevisions(result)) };
  };
  const first = await preview(head);
  const review = createReviewState(null);
  review.configure('pr-1', first.identity);
  review.set(review.id(first.row), true);
  const reload = async (headText) => {
    const next = await preview(headText);
    review.configure('pr-1', next.identity);
    return review.isReviewed(review.id(next.row));
  };
  assert.equal(await reload(head.replace('x + 1', 'x + 2')), true, 'a function body edit keeps the tick');
  assert.equal(await reload(head.replace("'./b'", "'./c'")), false, 'an import edit un-ticks it');
  clearVirtualText();
});

test('a local identity is content-based too', { skip: !h && 'typescript not resolvable' }, async () => {
  const dir = h.mkRepo({ 'tsconfig.json': h.TSCONFIG, [FILE]: SCENARIOS[FIRST].base });
  const base = h.headOf(dir);
  const { makeGit } = require('../src/engine/git');
  const idFor = async (text) => {
    h.write(dir, { [FILE]: text });
    const result = await analyze(dir, h.since(base, { headRev: null }));
    const identity = createReviewIdentity(h.ts, dir, localRevisions(dir, result, makeGit(dir)));
    return identity({ type: 'outside', ...outsideOf(result)[0] });
  };
  const id = await idFor(SCENARIOS[FIRST].head);
  assert.equal(await idFor(SCENARIOS[FIRST].head.replace('x + 1', 'x + 2')), id);
  assert.notEqual(await idFor(SCENARIOS[FIRST].head.replace("'./b'", "'./c'")), id);
});

test.after(() => { if (h) fs.rmSync(h.TMP, { recursive: true, force: true }); });
