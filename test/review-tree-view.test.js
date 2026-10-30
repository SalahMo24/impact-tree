'use strict';
// The file-first tree through the provider and the vscode stub: what a checkbox ticks,
// which rows have one, which row starts open, and the view's message and badge.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/views/changes/tree-provider');
const { createReviewState } = require('../src/session/review-state');
const { buildReviewSummary } = require('../src/views/changes/review-tree-model');
const { rootFiles } = require('./root-files');

const { Checked, Unchecked } = vscode.TreeItemCheckboxState;
const { Expanded, Collapsed, None } = vscode.TreeItemCollapsibleState;
const BODY = { id: 'body', label: 'body' };
const SIG = { id: 'sig', label: 'signature', short: 'sig' };
const NO_SITES = { updated: [], untouched: [], unknown: [] };

let at = 0;
const callerOf = (relPath, label, updated) => {
  const pos = ++at * 7;
  const sites = [{ start: pos + 1, end: pos + 4 }];
  return { file: `/r/${relPath}`, pos, label, test: false, callSites: sites, sites: 1,
    callSiteUpdates: updated ? { ...NO_SITES, updated: sites } : { ...NO_SITES, untouched: sites } };
};
const change = (relPath, label, startLine, extra = {}) => ({
  file: `/r/${relPath}`, relPath, label, namePos: startLine * 10, startLine, endLine: startLine + 3, component: '(root)',
  kinds: [BODY], throwsAdded: [], stale: [], staleCallers: 0, callerState: 'none', callers: [], score: 1,
  testState: 'covered', tests: ['spec'], ...extra,
});
const stale = (relPath, label, startLine) => {
  const c = callerOf('src/user.ts', 'user', false);
  return change(relPath, label, startLine, { kinds: [SIG], callerState: 'resolved', callers: [c], staleCallers: 1, stale: [{ label: c.label }] });
};
const resultOf = (extra = {}) => ({
  allChanged: [], findings: [], deleted: [], outside: [], otherFiles: [], warnings: [], unanalysable: [], untested: [], testUnknown: [],
  testReachComputed: true, reachDepth: 2, mode: 'branch', requestedMode: 'branch', base: { ref: 'origin/main', sha: '0123456789' },
  changedFileCount: 1, ...extra,
});

// src/a.ts holds a ⛔ change, a body-only change with a caller, a deleted symbol and an
// outside row; src/b.ts one quiet change; notes.md has no call graph.
function sampleResult() {
  const bad = stale('src/a.ts', 'bad', 10);
  const body = change('src/a.ts', 'Holder.body', 20, { callerState: 'resolved', callers: [callerOf('src/user.ts', 'reader', false)] });
  const quiet = change('src/b.ts', 'quiet', 5);
  return resultOf({
    allChanged: [bad, body, quiet], findings: [bad],
    deleted: [{ label: 'gone', key: 'gone', relPath: 'src/a.ts', file: '/r/src/a.ts', namePos: 400, startLine: 40 }],
    outside: [{ file: '/r/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 2]] }],
    otherFiles: [{ path: 'notes.md', status: 'added' }],
    fileStatus: { 'src/a.ts': 'modified', 'src/b.ts': 'modified', 'notes.md': 'added' },
  });
}

function memoryReview() {
  const store = new Map();
  return createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
}

function viewOf(result, { review = memoryReview(), state = {}, deps = {}, resolver = { incomingWithStatus: async () => ({ callers: [], complete: true }) } } = {}) {
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}`, ...state }),
    resolver, review, ...deps,
  });
  const item = (row) => provider.getTreeItem(row);
  const files = async () => (await rootFiles(provider)).filter((r) => r.type === 'reviewFile' || r.type === 'file');
  const fileAt = async (relPath) => (await files()).find((f) => f.relPath === relPath);
  return { provider, review, item, files, fileAt };
}

test('ticking a call-graph file ticks exactly its counting rows, and nothing else', async () => {
  const { provider, review, item, fileAt } = viewOf(sampleResult());
  const a = await fileAt('src/a.ts');
  assert.equal(item(a).checkboxState, Unchecked);
  provider.setChecked(a, true);
  const rows = (await provider.getChildren(a)).filter((r) => r.type !== 'spacer');
  assert.deepEqual(rows.map((r) => [r.type, r.label]),
    [['finding', 'bad'], ['deleted', 'gone'], ['finding', 'Holder.body'], ['outside', 'Outside functions']]);
  assert.ok(rows.every((r) => item(r).checkboxState === Checked), 'every row of the file');
  assert.equal(review.size(), rows.length, 'and only them: no caller, no other file');
  assert.equal(item(a).checkboxState, Checked);
  assert.equal(item(await fileAt('src/b.ts')).checkboxState, Unchecked);
  assert.equal(item(await fileAt('notes.md')).checkboxState, Unchecked);
  provider.setChecked(a, false);
  assert.equal(review.size(), 0, 'unticking the file unticks every row');
});

test('unticking one change unticks the file; ticking it back ticks the file', async () => {
  const { provider, item, fileAt } = viewOf(sampleResult());
  const a = await fileAt('src/a.ts');
  provider.setChecked(a, true);
  const [, , body] = await provider.getChildren(a);
  provider.setChecked(body, false);
  assert.equal(item(body).checkboxState, Unchecked);
  assert.equal(item(a).checkboxState, Unchecked);
  provider.setChecked(body, true);
  assert.equal(item(a).checkboxState, Checked);
});

test('ticking a change does not tick its callers, and a file without a call graph ticks itself', async () => {
  const { provider, review, item, fileAt } = viewOf(sampleResult());
  const [bad] = await provider.getChildren(await fileAt('src/a.ts'));
  provider.setChecked(bad, true);
  assert.equal(review.size(), 1);
  const notes = await fileAt('notes.md');
  provider.setChecked(notes, true);
  assert.equal(item(notes).checkboxState, Checked);
  assert.equal(review.size(), 2);
});

test('caller, caller-file, message and tests rows have no checkbox', async () => {
  const sameFile = [callerOf('src/user.ts', 'one', false), callerOf('src/user.ts', 'two', true)];
  const holder = change('src/a.ts', 'holder', 10, { callerState: 'resolved', callers: sameFile, callersComplete: false, callersIncompleteReason: 'query-failed' });
  const lone = change('src/a.ts', 'lone', 30, { callerState: 'resolved', callers: [callerOf('src/other.ts', 'other', true)] });
  const { provider, item } = viewOf(resultOf({ allChanged: [holder, lone], fileStatus: { 'src/a.ts': 'modified' } }),
    { resolver: { incomingWithStatus: async () => ({ callers: [callerOf('src/deep.ts', 'deep', false)], complete: true }) } });
  const [file] = await rootFiles(provider);
  const [holderRow, loneRow] = await provider.getChildren(file);
  const under = [...await provider.getChildren(holderRow), ...await provider.getChildren(loneRow)];
  assert.deepEqual(under.map((r) => r.type), ['callerFile', 'message', 'message', 'caller', 'message']);
  const callerFile = under[0];
  const lazy = await provider.getChildren(under[3]);
  const rows = [...under, ...callerFile.callers, ...lazy];
  assert.ok(rows.some((r) => r.type === 'caller') && lazy.length > 0);
  for (const r of rows) assert.equal(item(r).checkboxState, undefined, `${r.type} ${r.label}`);
});

test('a tick stored by the old tree on a top-level change shows ticked in the new one', async () => {
  // The fixture and the stored id are those of review-tree-model.test.js's identity test;
  // the id is the one the section tree gave this change before it was removed.
  const { createReviewIdentity } = require('../src/session/review-identity');
  const { ts, root } = require('./bug-regressions-helpers');
  const base = "import { a } from './a';\nexport function target() { return 0; }\nexport function gone() { return 1; }\n";
  const head = "import { b } from './a';\nexport function target() { return 1; }\n";
  const OLD_TICK = 'finding:root>a.ts#target:390e0a3aa46d475e227507bf3cc83d07fb66081f5f6c9ce0044cdc608f1ea576:6e63f5de721da97c9082bf5ce3e20037a76f506c09eb0cd923f62ec6d5e08fb8';
  const store = new Map([['impactTree.reviewed.identity', [OLD_TICK]]]);
  const review = createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
  review.configure('identity', createReviewIdentity(ts, root, {
    headText: (p) => (p === 'a.ts' ? head : null), baseText: (p) => (p === 'a.ts' ? base : null), fileRevision: (p) => `rev:${p}`,
  }));
  const file = `${root}/a.ts`;
  const target = { file, relPath: 'a.ts', label: 'target', namePos: head.indexOf('target'), startLine: 2, endLine: 2, kinds: [BODY],
    staleCallers: 0, callerState: 'none', callers: [], score: 1, testState: 'uncovered', tests: [], throwsAdded: [], component: '(root)' };
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result: resultOf({ allChanged: [target], fileStatus: { 'a.ts': 'modified' } }), rel: (f) => f.replace(`${root}/`, '') }),
    resolver: {}, review,
  });
  const [fileRow] = await rootFiles(provider);
  const [row] = await provider.getChildren(fileRow);
  assert.equal(row.label, 'target');
  assert.equal(provider.getTreeItem(row).checkboxState, Checked);
  assert.equal(provider.getTreeItem(fileRow).checkboxState, Checked, 'its only row is ticked, so the file is');
});

test('only the first file starts expanded; every other expandable row starts collapsed', async () => {
  const { provider, item, files } = viewOf(sampleResult());
  const [first, second, third] = await files();
  assert.deepEqual([first.relPath, second.relPath, third.relPath], ['src/a.ts', 'src/b.ts', 'notes.md']);
  assert.equal(item(first).collapsibleState, Expanded);
  assert.equal(item(second).collapsibleState, Collapsed);
  assert.equal(item(third).collapsibleState, None, 'no call graph, nothing to expand');
  const rows = await provider.getChildren(first);
  assert.deepEqual(rows.map((r) => item(r).collapsibleState), [Collapsed, None, Collapsed, None, None], 'the last child is the spacer');
  const [caller] = await provider.getChildren(rows[2]);
  assert.equal(caller.type, 'caller');
  assert.equal(item(caller).collapsibleState, Collapsed, 'a caller expands to its own callers');
});

test('the file row shows the unreviewed attention count as words, done/total, then its last folder', async () => {
  const { provider, item, fileAt } = viewOf(sampleResult());
  const a = await fileAt('src/a.ts');
  assert.equal(item(a).label, 'a.ts');
  assert.equal(item(a).description, '2 need attention  ·  0/4  ·  src');
  assert.match(item(a).tooltip.value, /```\nsrc\/\n└─ a\.ts\n```/, 'the path is drawn as a folder tree');
  assert.match(item(a).tooltip.value, /4 changes, 2 need attention, 0 marked reviewed/);
  const [bad, gone] = await provider.getChildren(a);
  provider.setChecked(bad, true);
  assert.equal(item(a).description, '1 needs attention  ·  1/4  ·  src', 'singular once one is left');
  provider.setChecked(gone, true);
  assert.equal(item(a).description, '2/4  ·  src', 'no attention left, no count');
});

test('the summary counts unreviewed attention rows and how many were looked at, and follows the ticks', async () => {
  const { provider, fileAt } = viewOf(sampleResult(), { state: { source: { kind: 'local' } } });
  assert.deepEqual(provider.summarize(), {
    message: 'Branch + uncommitted · 2 need attention · 0 of 2 looked at',
    badge: { value: 2, tooltip: '2 of 2 need attention still to look at' },
  });
  provider.setChecked(await fileAt('src/a.ts'), true);
  assert.deepEqual(provider.summarize(), { message: 'Branch + uncommitted · 0 need attention · 2 of 2 looked at', badge: undefined },
    'ticking the file looks at both rows that need attention; no badge once none is left');
  provider.setChecked(await fileAt('src/b.ts'), true);
  provider.setChecked(await fileAt('notes.md'), true);
  assert.deepEqual(provider.summarize(), { message: 'Branch + uncommitted · 0 need attention · 2 of 2 looked at', badge: undefined },
    'ticking the quiet rows changes nothing: only the rows that need attention are counted');
});

test('there is no summary without a result, or while a placeholder is shown', () => {
  const empty = { message: undefined, badge: undefined };
  const of = (state, deps = {}) => createTreeProvider(vscode, { getState: () => state, resolver: {}, ...deps }).summarize();
  assert.deepEqual(of(null), empty);
  assert.deepEqual(of({}), empty);
  assert.deepEqual(of({ error: 'boom' }), empty);
  assert.deepEqual(of({ result: sampleResult(), rel: (f) => f }, { isBusy: () => true }), empty, 'an older result while analysing');
  assert.deepEqual(of({ result: sampleResult(), rel: (f) => f }, { getPhase: () => 'preparing' }), empty);
});

test('the summary names the PR for a preview or a checkout, and the mode for a local review', () => {
  const counts = { attention: 3, attentionTotal: 5, left: 70, total: 71 };
  const result = resultOf({ base: { ref: 'main', sha: 'x' } });
  assert.equal(buildReviewSummary(result, { kind: 'pr', pr: { number: 15 } }, counts).message, 'PR #15 · 3 need attention · 2 of 5 looked at');
  assert.equal(buildReviewSummary(result, { kind: 'checkout', pr: { number: 9 }, sha: 'abc' }, counts).message, 'PR #9 · 3 need attention · 2 of 5 looked at');
  assert.equal(buildReviewSummary(result, { kind: 'local' }, counts).message, 'Branch + uncommitted · 3 need attention · 2 of 5 looked at');
  assert.equal(buildReviewSummary(result, null, counts).message, 'Branch + uncommitted · 3 need attention · 2 of 5 looked at');
  const fellBack = resultOf({ mode: 'branch', requestedMode: 'pr', base: { ref: 'origin/main', sha: 'x' } });
  assert.equal(buildReviewSummary(fellBack, { kind: 'local' }, { attention: 1, attentionTotal: 1, left: 1, total: 1 }).message,
    'Branch + uncommitted (requested Branch vs base) · 1 needs attention · 0 of 1 looked at', 'a fallback mode says what was asked for');
  assert.deepEqual(buildReviewSummary(result, null, counts).badge, { value: 3, tooltip: '3 of 5 need attention still to look at' });
  assert.equal(buildReviewSummary(result, null, { attention: 0, attentionTotal: 5, left: 60, total: 71 }).badge, undefined,
    'every row that needs attention was looked at: no badge, though rows are left');
  assert.equal(buildReviewSummary(result, null, { attention: 0, attentionTotal: 5, left: 60, total: 71 }).message,
    'Branch + uncommitted · 0 need attention · 5 of 5 looked at');
});

test('a review with nothing that needs attention says so, counts its changes and has no badge', () => {
  const result = resultOf({ base: { ref: 'main', sha: 'x' } });
  const calm = (total, left) => buildReviewSummary(result, { kind: 'pr', pr: { number: 27095 } }, { attention: 0, attentionTotal: 0, left, total });
  assert.deepEqual(calm(107, 107), { message: 'PR #27095 · 107 changes · nothing needs attention', badge: undefined });
  assert.equal(calm(1, 0).message, 'PR #27095 · 1 change · nothing needs attention', 'singular, and the same once everything is ticked');
  assert.equal(buildReviewSummary(result, null, { attention: 0, attentionTotal: 0, left: 2, total: 2 }, 'unreviewed', ' · 1 unresolved thread').message,
    'Branch + uncommitted · 2 changes · nothing needs attention · 1 unresolved thread · filter: unreviewed', 'the threads and the filter keep their place');
});

// ---- filters, ids, parents and the walk -------------------------------------------------
// What the filtered tree shows: each file with the labels of its visible rows.
async function shown(provider) {
  const out = [];
  for (const top of await provider.getChildren()) {
    const rows = top.type === 'reviewFile' ? (await provider.getChildren(top)).filter((r) => r.type !== 'spacer') : [];
    out.push([top.relPath ?? top.label, rows.map((r) => r.label)]);
  }
  return out;
}

test('the filter starts on all, and "needs attention" hides every row that does not', async () => {
  const { provider, fileAt } = viewOf(sampleResult());
  assert.equal(provider.getFilter(), 'all');
  assert.deepEqual(await shown(provider), [['src/a.ts', ['bad', 'gone', 'Holder.body', 'Outside functions']], ['src/b.ts', ['quiet']], ['notes.md', []]]);
  provider.toggleFilter('attention');
  assert.equal(provider.getFilter(), 'attention');
  assert.deepEqual(await shown(provider), [['src/a.ts', ['bad', 'gone']]], 'b.ts and notes.md have no row that needs attention');
  provider.setChecked((await provider.getChildren(await fileAt('src/a.ts')))[0], true);
  assert.deepEqual(await shown(provider), [['src/a.ts', ['gone']]], 'a ticked row leaves the filter');
});

test('"unreviewed" hides ticked rows and files whose rows are all ticked, and keeps an unticked file row', async () => {
  const { provider, fileAt } = viewOf(sampleResult());
  provider.toggleFilter('unreviewed');
  assert.deepEqual(await shown(provider), [['src/a.ts', ['bad', 'gone', 'Holder.body', 'Outside functions']], ['src/b.ts', ['quiet']], ['notes.md', []]]);
  const [bad] = await provider.getChildren(await fileAt('src/a.ts'));
  provider.setChecked(bad, true);
  provider.setChecked(await fileAt('src/b.ts'), true);
  assert.deepEqual(await shown(provider), [['src/a.ts', ['gone', 'Holder.body', 'Outside functions']], ['notes.md', []]]);
  provider.setChecked(await fileAt('notes.md'), true);
  assert.deepEqual((await shown(provider)).map(([f]) => f), ['src/a.ts']);
});

test('a filter hides rows, not a file\'s progress: its checkbox and counts still stand for all its rows', async () => {
  const { provider, item, fileAt } = viewOf(sampleResult());
  provider.toggleFilter('attention');
  const a = await fileAt('src/a.ts');
  assert.equal(item(a).description, '2 need attention  ·  0/4  ·  src');
  provider.setChecked(a, true);
  assert.equal(item(a).checkboxState, Checked);
  provider.toggleFilter('attention');
  const rows = (await provider.getChildren(a)).filter((r) => r.type !== 'spacer');
  assert.ok(rows.every((r) => item(r).checkboxState === Checked), 'ticking the file in a filter ticked every row, not only the visible ones');
});

test('turning one filter on turns the other off, and the active one again returns to all', () => {
  const { provider } = viewOf(sampleResult());
  provider.toggleFilter('attention');
  provider.toggleFilter('unreviewed');
  assert.equal(provider.getFilter(), 'unreviewed');
  provider.toggleFilter('attention');
  assert.equal(provider.getFilter(), 'attention');
  provider.toggleFilter('attention');
  assert.equal(provider.getFilter(), 'all');
});

test('the summary message names the active filter', () => {
  const { provider } = viewOf(sampleResult(), { state: { source: { kind: 'local' } } });
  assert.equal(provider.summarize().message, 'Branch + uncommitted · 2 need attention · 0 of 2 looked at');
  provider.toggleFilter('attention');
  assert.equal(provider.summarize().message, 'Branch + uncommitted · 2 need attention · 0 of 2 looked at · filter: needs attention');
  provider.toggleFilter('unreviewed');
  assert.equal(provider.summarize().message, 'Branch + uncommitted · 2 need attention · 0 of 2 looked at · filter: unreviewed');
});

test('when a filter leaves nothing the root is one message row, after any notices', async () => {
  const { provider, fileAt } = viewOf({ ...sampleResult(), warnings: ['careful'] });
  provider.toggleFilter('attention');
  for (const row of await provider.getChildren(await fileAt('src/a.ts'))) provider.setChecked(row, true);
  assert.deepEqual((await provider.getChildren()).map((r) => [r.type, r.label]), [['message', 'careful'], ['message', 'Nothing needs attention']]);
  provider.toggleFilter('unreviewed');
  assert.deepEqual((await provider.getChildren()).map((r) => r.label), ['careful', 'a.ts', 'b.ts', 'notes.md'], 'only the attention rows were ticked');
  for (const f of ['src/a.ts', 'src/b.ts', 'notes.md']) provider.setChecked(await fileAt(f), true);
  assert.deepEqual((await provider.getChildren()).map((r) => r.label), ['careful', 'Everything is reviewed']);
  provider.toggleFilter('unreviewed');
  assert.equal((await provider.getChildren()).length, 4, 'all: the warning and three files');
});

test('an empty result with no filter stays empty', async () => {
  const { provider } = viewOf(resultOf());
  assert.deepEqual(await provider.getChildren(), []);
});

test('getParent: a file has none, a counting row has its file, a caller has the row it was built under', async () => {
  const sameFile = [callerOf('src/user.ts', 'one', false), callerOf('src/user.ts', 'two', true)];
  const holder = change('src/a.ts', 'holder', 10, { callerState: 'resolved', callers: sameFile });
  const { provider } = viewOf(resultOf({ allChanged: [holder], outside: [{ file: '/r/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 2]] }],
    fileStatus: { 'src/a.ts': 'modified' } }),
  { resolver: { incomingWithStatus: async () => ({ callers: [callerOf('src/deep.ts', 'deep', false)], complete: true }) } });
  const [file] = await rootFiles(provider);
  assert.equal(provider.getParent(file).type, 'browse', 'nothing here needs attention: the file sits in the calm state\'s container');
  assert.equal(provider.getParent(provider.getParent(file)), undefined);
  const [change1, outsideRow] = await provider.getChildren(file);
  assert.equal(provider.getParent(change1).relPath, 'src/a.ts');
  assert.equal(provider.getParent(outsideRow).relPath, 'src/a.ts');
  const [callerFile, tests] = await provider.getChildren(change1);
  assert.equal(callerFile.type, 'callerFile');
  assert.equal(provider.getParent(callerFile), change1);
  assert.equal(provider.getParent(tests), change1);
  const [caller] = await provider.getChildren(callerFile);
  assert.equal(provider.getParent(caller), callerFile, 'a caller grouped under its file');
  const [deeper] = await provider.getChildren(caller);
  assert.equal(provider.getParent(deeper), caller);
});

test('a counting row has its file as parent before anything under it was expanded', async () => {
  const { provider, fileAt } = viewOf(sampleResult());
  const b = await fileAt('src/b.ts');
  const files = await provider.getChildren();
  assert.equal(provider.getParent(b.rows[0]), files.find((f) => f.relPath === 'src/b.ts'), 'known from the root build');
  assert.equal(provider.getParent(await fileAt('notes.md')), undefined);
});

test('tree item ids are unique over every level, including parent-scoped caller and tests rows', async () => {
  const twinA = change('src/a.ts', 'twin', 10, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', false), callerOf('src/v.ts', 'u', false)] });
  const twinB = change('src/a.ts', 'twin', 40, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', false)] });
  const sample = sampleResult();
  const result = { ...sample, allChanged: [...sample.allChanged, twinA, twinB] };
  const { provider, item } = viewOf(result);
  const ids = [];
  const walk = async (row) => {
    const id = item(row).id;
    assert.equal(typeof id, 'string', `${row.type} ${row.label}`);
    ids.push(id);
    for (const child of await provider.getChildren(row)) await walk(child);
  };
  for (const top of await provider.getChildren()) await walk(top);
  assert.ok(ids.length >= 9, `${ids.length} ids`);
  assert.equal(new Set(ids).size, ids.length);
});

test('the built rows are shared by the root, getParent, the walk and the summary, and rebuilt when the analysis changes', async () => {
  let analysisId = 1;
  let current = sampleResult();
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result: current, rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }), resolver: {},
    review: memoryReview(), getAnalysisId: () => analysisId,
  });
  // Even the initially expanded file is the canonical parent object.
  const second = async () => (await provider.getChildren())[0];
  const before = await second();
  provider.summarize();
  provider.nextUnreviewed(null);
  assert.equal(await second(), before, 'the same row objects, not a rebuild');
  const [child] = await provider.getChildren(before);
  assert.equal(provider.getParent(child), before);
  current = sampleResult();
  const rebuilt = await second();
  assert.notEqual(rebuilt, before, 'a new result object');
  analysisId = 2;
  assert.notEqual(await second(), rebuilt, 'a new analysis id, even for the same result');
  assert.equal(provider.getParent(child), undefined, 'a row of the old analysis has no parent now');
});

test('the next unreviewed row follows the filter and the ticks, and is null when none is left', async () => {
  const { provider, fileAt } = viewOf(sampleResult());
  const a = await fileAt('src/a.ts');
  const [bad, gone, body, outsideRow] = await provider.getChildren(a);
  assert.equal(provider.nextUnreviewed(null), bad);
  assert.equal(provider.nextUnreviewed(bad), gone);
  provider.toggleFilter('attention');
  assert.equal(provider.nextUnreviewed(bad), gone);
  assert.equal(provider.nextUnreviewed(gone), bad, 'body and the others are hidden, so it wraps');
  provider.toggleFilter('attention');
  provider.setChecked(a, true);
  assert.equal(provider.nextUnreviewed(outsideRow).label, 'quiet', 'a.ts is ticked, so the walk goes on to b.ts');
  assert.equal(provider.nextUnreviewed(body).label, 'quiet');
  for (const f of ['src/b.ts', 'notes.md']) provider.setChecked(await fileAt(f), true);
  assert.equal(provider.nextUnreviewed(null), null);
});

test('the previous unreviewed row follows the filter and the ticks, and is null when none is left', async () => {
  const { provider, fileAt } = viewOf(sampleResult());
  const a = await fileAt('src/a.ts');
  const [bad, gone, body, outsideRow] = await provider.getChildren(a);
  assert.equal(provider.previousUnreviewed(gone), bad);
  const notes = await fileAt('notes.md');
  assert.equal(provider.previousUnreviewed(bad), notes, 'wraps to the last row of the review');
  provider.toggleFilter('attention');
  assert.equal(provider.previousUnreviewed(body), gone);
  assert.equal(provider.previousUnreviewed(gone), bad);
  assert.equal(provider.previousUnreviewed(bad), gone, 'wraps over the hidden rows');
  provider.toggleFilter('attention');
  provider.setChecked(a, true);
  assert.equal(provider.previousUnreviewed(outsideRow), notes, 'a.ts is ticked: nothing above, so it wraps');
  for (const f of ['src/b.ts', 'notes.md']) provider.setChecked(await fileAt(f), true);
  assert.equal(provider.previousUnreviewed(null), null);
});

test('the counts of a shown review, and none while a placeholder is shown', async () => {
  const { provider } = viewOf(sampleResult());
  assert.deepEqual(provider.reviewCounts(), { total: 6, left: 6, attention: 2, attentionTotal: 2 });
  const none = createTreeProvider(vscode, { getState: () => null, resolver: {} });
  assert.equal(none.reviewCounts(), null);
  assert.equal(none.nextUnreviewed(null), null);
  assert.equal(none.previousUnreviewed(null), null);
});

// ---- the tree layout: file rows folded into folders, over the same rows -----------------

// src/a.ts and src/b.ts as in sampleResult, plus a change in src/engine/c.ts; notes.md at the root.
function treeResult() {
  const base = sampleResult();
  const engine = change('src/engine/c.ts', 'deep', 3);
  return { ...base, allChanged: [...base.allChanged, engine], fileStatus: { ...base.fileStatus, 'src/engine/c.ts': 'modified' } };
}
const treeView = (result, opts = {}) => viewOf(result, { ...opts, deps: { getLayout: () => 'tree', ...(opts.deps || {}) } });

test('in the tree layout the root holds folders and root files, ranked, with the canonical file rows inside', async () => {
  const { provider, item } = treeView(treeResult());
  const roots = await provider.getChildren();
  assert.deepEqual(roots.map((r) => [r.type, r.label]), [['folder', 'src'], ['file', 'notes.md']]);
  const [src] = roots;
  assert.equal(item(src).collapsibleState, Expanded, 'the worst folder starts open');
  assert.equal(item(src).iconPath, vscode.ThemeIcon.Folder);
  assert.equal(item(src).id, 'folder:src');
  assert.equal(item(src).resourceUri.fsPath, '/r/src', 'the folder resource, for the icon theme');
  const children = await provider.getChildren(src);
  assert.deepEqual(children.map((r) => [r.type, r.label]), [['reviewFile', 'a.ts'], ['reviewFile', 'b.ts'], ['folder', 'engine']],
    'a.ts (needs attention) first; b.ts and engine/ hold one quiet row each, so the path decides');
  assert.equal(item(children[0]).collapsibleState, Expanded, 'and its worst file');
  assert.equal(item(children[1]).collapsibleState, Collapsed);
  assert.equal(provider.fileRows().includes(children[0]), true, 'the file row is the canonical one');
  assert.equal(provider.getParent(children[0]), src);
  assert.equal(provider.getParent(children[2]), src);
  assert.equal(provider.getParent(src), undefined);
  const [c] = await provider.getChildren(children[2]);
  assert.equal(provider.getParent(c), children[2]);
  assert.equal(item(children[2]).description, '', 'a calm folder says nothing');
  assert.equal(item(children[0]).description, '2 need attention  ·  0/4', 'a file under a folder does not repeat the folder');
});

test('a folder\'s checkbox ticks every counting row under it, and reads ticked only when all are', async () => {
  const { provider, review, item } = treeView(treeResult());
  const [src] = await provider.getChildren();
  assert.equal(item(src).checkboxState, Unchecked);
  assert.equal(item(src).description, '2 need attention', 'the stale change and the deleted symbol');
  assert.match(item(src).tooltip.value, /3 files, 6 changes, 2 need attention, 0 marked reviewed/);
  provider.setChecked(src, true);
  assert.equal(review.size(), 6, 'the four rows of a.ts, b.ts\'s one and engine/c.ts\'s one');
  assert.equal(item(src).checkboxState, Checked);
  assert.equal(item(src).description, '');
  const [a] = await provider.getChildren(src);
  const [bad] = await provider.getChildren(a);
  provider.setChecked(bad, false);
  assert.equal(item(src).checkboxState, Unchecked, 'one unticked row unticks the folder');
  assert.equal(item(a).checkboxState, Unchecked);
  assert.equal(item(src).description, '1 needs attention');
});

test('a tick repaints the root folder of the file, not the root, while the filter keeps the same files', async () => {
  // The shared stub's emitter delivers nothing; this one does, so the repaint scope shows.
  const delivering = { ...vscode, EventEmitter: class {
    constructor() { const listeners = []; this.event = (l) => { listeners.push(l); return { dispose() {} }; }; this.fire = (v) => { for (const l of listeners) l(v); }; this.dispose = () => { listeners.length = 0; }; }
  } };
  const result = treeResult();
  const provider = createTreeProvider(delivering, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review: memoryReview(), getLayout: () => 'tree',
  });
  const fired = [];
  provider.onDidChangeTreeData((row) => fired.push(row === undefined ? 'root' : `${row.type}:${row.label}`));
  const [src] = await provider.getChildren();
  const [a, , engine] = await provider.getChildren(src);
  const [c] = await provider.getChildren(engine);
  provider.setChecked(c, true);
  assert.deepEqual(fired, ['folder:src'], 'the folder\'s own counts changed too');
  fired.length = 0;
  provider.setChecked(a, true);
  assert.deepEqual(fired, ['folder:src']);
});

test('the flat layout after a tree read has no folder parents left, and the layout can change between reads', async () => {
  let layout = 'tree';
  const { provider } = viewOf(treeResult(), { deps: { getLayout: () => layout } });
  const [src] = await provider.getChildren();
  const [a] = await provider.getChildren(src);
  assert.equal(provider.getParent(a), src);
  assert.equal(provider.getLayout(), 'tree');
  layout = 'flat';
  const flat = await provider.getChildren();
  assert.deepEqual(flat.map((r) => r.label), ['a.ts', 'b.ts', 'c.ts', 'notes.md']);
  assert.equal(flat[0], a, 'the same file row');
  assert.equal(provider.getParent(a), undefined, 'a reveal in the flat list does not climb into an old folder');
  assert.equal(provider.getLayout(), 'flat');
  const [badFlat] = await provider.getChildren(a);
  assert.equal(provider.getParent(badFlat), a, 'a change row still sits under its file');
});

test('the filter folds only the files it keeps, and an empty filter shows its message, not empty folders', async () => {
  const { provider } = treeView(treeResult());
  provider.toggleFilter('attention');
  const roots = await provider.getChildren();
  assert.deepEqual(roots.map((r) => [r.type, r.label]), [['folder', 'src']]);
  assert.deepEqual((await provider.getChildren(roots[0])).map((r) => r.label), ['a.ts'], 'b.ts and engine/ have nothing needing attention');
  const [a] = await provider.getChildren(roots[0]);
  provider.setChecked(a, true);
  const after = await provider.getChildren();
  assert.deepEqual(after.map((r) => r.type), ['message'], 'nothing needs attention: no empty folder, the filter\'s message');
});

test('next unreviewed walks the flat order whatever the layout, and a row is revealed through its file and folder', async () => {
  const { provider } = treeView(treeResult());
  const [src] = await provider.getChildren();
  const [a, , engine] = await provider.getChildren(src);
  await provider.getChildren(a);
  const first = provider.nextUnreviewed(null);
  assert.equal(first.label, 'bad');
  assert.equal(provider.getParent(first), a, 'change -> file');
  assert.equal(provider.getParent(a), src, 'file -> folder');
  const [c] = await provider.getChildren(engine);
  await provider.getChildren(c);
  const last = provider.previousUnreviewed(null);
  assert.equal(last.label, 'notes.md', 'the flat order ends with the root file, whatever the folders');
  const counts = provider.reviewCounts();
  assert.deepEqual([counts.total, counts.left], [7, 7], 'counts read the flat rows: six rows and notes.md');
});

// ---- the calm state (gate G14): nothing needs attention ------------------------------------
// src/a.ts holds a quiet change with a caller and a quiet change; src/engine/c.ts one quiet
// change; notes.md has no call graph: 4 counting rows, none of which needs attention.
function calmResult(extra = {}) {
  const holder = change('src/a.ts', 'Holder.body', 20, { callerState: 'resolved', callers: [callerOf('src/user.ts', 'reader', true)] });
  const lone = change('src/a.ts', 'lone', 40);
  const engine = change('src/engine/c.ts', 'deep', 3);
  return resultOf({
    allChanged: [holder, lone, engine], otherFiles: [{ path: 'notes.md', status: 'added' }],
    fileStatus: { 'src/a.ts': 'modified', 'src/engine/c.ts': 'modified', 'notes.md': 'added' }, ...extra,
  });
}
const calmView = (extra = {}, opts = {}) => viewOf(calmResult(extra), opts);

test('a review with nothing to flag opens on a calm row and one collapsed container holding the files', async () => {
  const { provider, item } = calmView();
  const roots = await provider.getChildren();
  assert.deepEqual(roots.map((r) => [r.type, r.label]), [['message', 'Nothing to flag'], ['browse', 'Browse all 4 changes']]);
  const calm = item(roots[0]);
  assert.equal(calm.description, 'every caller updated, or a body-only change');
  assert.equal(calm.iconPath.id, 'pass');
  const browse = item(roots[1]);
  assert.equal(browse.collapsibleState, Collapsed);
  assert.equal(browse.iconPath.id, 'list-flat');
  assert.equal(browse.checkboxState, undefined, 'the container has no checkbox: the files keep theirs');
  assert.equal(browse.id, 'browse:all');
  assert.equal(browse.contextValue, 'browse');
  const files = await provider.getChildren(roots[1]);
  assert.deepEqual(files.map((r) => r.relPath), ['src/a.ts', 'src/engine/c.ts', 'notes.md']);
  assert.deepEqual(files, provider.fileRows(), 'the canonical file rows, not copies');
  assert.equal(provider.summarize().message, 'Branch + uncommitted · 4 changes · nothing needs attention');
  assert.equal(provider.summarize().badge, undefined);
});

test('the container says "1 change" for one', async () => {
  const { provider } = viewOf(resultOf({ allChanged: [change('src/a.ts', 'only', 5)], fileStatus: { 'src/a.ts': 'modified' } }));
  assert.deepEqual((await provider.getChildren()).map((r) => r.label), ['Nothing to flag', 'Browse all 1 change']);
});

test('the calm row hedges for a preview, and for an analysis that left something out', async () => {
  const labels = async (extra) => (await calmView(extra).provider.getChildren()).filter((r) => r.type === 'message').map((r) => [r.label, r.desc]);
  const preview = await labels({ tierA: true, changedFileCount: 3 });
  assert.deepEqual(preview.at(-1), ['Nothing to flag in what was searched', 'check out and analyse for the full picture']);
  const searched = ['Nothing to flag in what was searched', 'some callers or files could not be searched'];
  assert.deepEqual((await labels({ warnings: ['gopls did not answer'] })).at(-1), searched);
  const incomplete = change('src/a.ts', 'Holder.body', 20, { callerState: 'unknown', callersComplete: false, callersIncompleteReason: 'query-failed' });
  assert.deepEqual((await labels({ allChanged: [incomplete] })).at(-1), searched, 'a change whose caller search did not finish');
  assert.ok(!(await labels({ tierA: true })).some(([label]) => label === 'Nothing to flag'), 'never bare without the evidence');
});

test('anything that needs attention keeps the plain list: no calm row, no container', async () => {
  const { provider } = viewOf(sampleResult());
  assert.deepEqual((await provider.getChildren()).map((r) => r.type), ['reviewFile', 'reviewFile', 'file']);
  const extra = { allChanged: [...calmResult().allChanged, stale('src/b.ts', 'bad', 5)],
    fileStatus: { 'src/a.ts': 'modified', 'src/engine/c.ts': 'modified', 'src/b.ts': 'modified', 'notes.md': 'added' } };
  const withBad = calmView(extra);
  assert.ok((await withBad.provider.getChildren()).every((r) => r.type !== 'browse' && r.label !== 'Nothing to flag'));
});

test('getParent: a file sits under the container, a counting row under its file, and the container has none', async () => {
  const { provider } = calmView();
  const [, browse] = await provider.getChildren();
  const [a, c, notes] = await provider.getChildren(browse);
  for (const file of [a, c, notes]) assert.equal(provider.getParent(file), browse, file.relPath);
  assert.equal(provider.getParent(browse), undefined, 'the sidebar puts it under the review\'s host');
  const [holder] = await provider.getChildren(a);
  assert.equal(provider.getParent(holder), a);
  // a reveal climbs the whole chain: change, file, container, host
  const chain = [];
  for (let row = holder; row; row = provider.getParent(row)) chain.push(row.type);
  assert.deepEqual(chain, ['finding', 'reviewFile', 'browse']);
});

test('the sidebar finds the container\'s parent through its host when the review tree has none', async () => {
  const { createReviewSidebar } = require('../src/views/sidebar/review-sidebar');
  const { provider } = calmView();
  const sidebar = createReviewSidebar(vscode, { tree: provider, getHost: () => ({ kind: 'local', mode: 'branch' }) });
  sidebar.setSources({ onDidChangeTreeData: () => ({ dispose() {} }), getTreeItem: (n) => new vscode.TreeItem(n.label),
    getChildren: async (n) => (n ? [] : [{ type: 'mode', label: 'Branch', args: ['branch'] }]) });
  const host = await sidebar.hostRow();
  const rows = await sidebar.getChildren(host);
  const browse = rows.find((r) => r.type === 'browse');
  assert.ok(browse, 'the container is among the review rows');
  assert.equal(sidebar.getParent(browse), host);
  const [a] = await sidebar.getChildren(browse);
  assert.equal(sidebar.getParent(a), browse);
});

test('ticks, counts, the walk and line lookup see the files through the container', async () => {
  const { provider, review, item } = calmView();
  const [, browse] = await provider.getChildren();
  const [a, c] = await provider.getChildren(browse);
  assert.deepEqual(provider.reviewCounts(), { total: 4, left: 4, attention: 0, attentionTotal: 0 });
  provider.setChecked(a, true);
  assert.equal(item(a).checkboxState, Checked);
  assert.equal(review.size(), 2);
  assert.deepEqual(provider.reviewCounts(), { total: 4, left: 2, attention: 0, attentionTotal: 0 }, 'quiet rows are not counted against the reviewer, so only `left` moves');
  assert.equal(provider.summarize().message, 'Branch + uncommitted · 4 changes · nothing needs attention', 'and the message does not move');
  assert.equal(provider.nextUnreviewed(null).label, 'deep');
  assert.equal(provider.previousUnreviewed(null).label, 'notes.md');
  assert.equal(provider.nextUnreviewed(a).label, 'deep');
  assert.equal(provider.rowAtLine('src/engine/c.ts', 4).label, 'deep');
  assert.equal(provider.rowById('file:src/engine/c.ts'), c);
  assert.deepEqual(provider.changeRowsOf('src/a.ts').map((r) => r.label), ['Holder.body', 'lone']);
  provider.clearReviewed();
  assert.equal(provider.reviewCounts().left, 4);
  assert.equal(item(a).checkboxState, Unchecked);
});

test('a tick repaints its file, not the root: the calm state does not move', async () => {
  const delivering = { ...vscode, EventEmitter: class {
    constructor() { const listeners = []; this.event = (l) => { listeners.push(l); return { dispose() {} }; }; this.fire = (v) => { for (const l of listeners) l(v); }; this.dispose = () => { listeners.length = 0; }; }
  } };
  const result = calmResult();
  const provider = createTreeProvider(delivering, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }),
    resolver: {}, review: memoryReview(),
  });
  const fired = [];
  provider.onDidChangeTreeData((row) => fired.push(row === undefined ? 'root' : `${row.type}:${row.label}`));
  const [, browse] = await provider.getChildren();
  const [a] = await provider.getChildren(browse);
  provider.setChecked(a, true);
  assert.deepEqual(fired, ['reviewFile:a.ts']);
});

test('the filters: needs attention shows its empty row, unreviewed lists the files without the container', async () => {
  const { provider } = calmView();
  provider.toggleFilter('attention');
  assert.deepEqual((await provider.getChildren()).map((r) => [r.type, r.label]), [['message', 'Nothing needs attention']]);
  provider.toggleFilter('unreviewed');
  assert.deepEqual((await provider.getChildren()).map((r) => r.type), ['reviewFile', 'reviewFile', 'file'], 'no calm row and no container off the filter all');
  provider.toggleFilter('unreviewed');
  assert.deepEqual((await provider.getChildren()).map((r) => r.type), ['message', 'browse']);
});

test('the tree layout: the folders sit under the container, a file under its folder, a root file under the container', async () => {
  const { provider, item } = treeView(calmResult());
  const roots = await provider.getChildren();
  assert.deepEqual(roots.map((r) => r.type), ['message', 'browse']);
  const top = await provider.getChildren(roots[1]);
  assert.deepEqual(top.map((r) => [r.type, r.label]), [['folder', 'src'], ['file', 'notes.md']]);
  assert.equal(provider.getParent(top[0]), roots[1]);
  assert.equal(provider.getParent(top[1]), roots[1]);
  const [a, engine] = await provider.getChildren(top[0]);
  assert.equal(provider.getParent(a), top[0], 'inside a folder the folder is the parent');
  assert.equal(provider.getParent(engine), top[0]);
  assert.equal(item(top[0]).checkboxState, Unchecked);
  provider.setChecked(top[0], true);
  assert.equal(item(top[0]).checkboxState, Checked, 'a folder under the container still ticks every row under it');
  assert.equal(provider.reviewCounts().left, 1, 'only notes.md is left');
});

test('a read without the calm state forgets the container: no stale parent', async () => {
  const shown = { value: calmResult() };
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result: shown.value, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }),
    resolver: {}, review: memoryReview(),
  });
  const [, browse] = await provider.getChildren();
  const [a] = await provider.getChildren(browse);
  assert.equal(provider.getParent(a), browse);
  shown.value = resultOf({ allChanged: [stale('src/a.ts', 'bad', 5)], fileStatus: { 'src/a.ts': 'modified' } });
  const [file] = await provider.getChildren();
  assert.equal(file.type, 'reviewFile');
  assert.equal(provider.getParent(file), undefined);
});
