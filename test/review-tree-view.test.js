'use strict';
// The file-first tree through the provider and the vscode stub: what a checkbox ticks,
// which rows have one, which row starts open, and the view's message and badge.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');
const { createReviewState } = require('../src/review-state');
const { buildReviewSummary } = require('../src/review-tree-model');

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
  const files = async () => (await provider.getChildren()).filter((r) => r.type === 'reviewFile' || r.type === 'file');
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
  const [file] = await provider.getChildren();
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
  const { createReviewIdentity } = require('../src/review-identity');
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
  const [fileRow] = await provider.getChildren();
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

test('the file row shows the unreviewed attention count with the worst token, done/total, then its last folder', async () => {
  const { provider, item, fileAt } = viewOf(sampleResult());
  const a = await fileAt('src/a.ts');
  assert.equal(item(a).label, 'a.ts');
  assert.equal(item(a).description, '⛔ 2  ·  0/4  ·  src');
  assert.match(item(a).tooltip.value, /src\/a\.ts/);
  assert.match(item(a).tooltip.value, /4 changes, 2 need attention, 4 left to review/);
  const [bad, gone] = await provider.getChildren(a);
  provider.setChecked(bad, true);
  assert.equal(item(a).description, '− 1  ·  1/4  ·  src', 'the token is the worst unreviewed one');
  provider.setChecked(gone, true);
  assert.equal(item(a).description, '2/4  ·  src', 'no attention left, no count');
});

test('the summary counts unreviewed attention rows and what is left, and follows the ticks', async () => {
  const { provider, fileAt } = viewOf(sampleResult(), { state: { source: { kind: 'local' } } });
  assert.deepEqual(provider.summarize(), {
    message: 'branch mode · ⛔ 2 · 6 of 6 left',
    badge: { value: 6, tooltip: '6 of 6 left to review' },
  });
  provider.setChecked(await fileAt('src/a.ts'), true);
  assert.equal(provider.summarize().message, 'branch mode · ⛔ 0 · 2 of 6 left');
  provider.setChecked(await fileAt('src/b.ts'), true);
  provider.setChecked(await fileAt('notes.md'), true);
  assert.deepEqual(provider.summarize(), { message: 'branch mode · ⛔ 0 · 0 of 6 left', badge: undefined });
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
  const counts = { attention: 3, left: 70, total: 71 };
  const result = resultOf({ base: { ref: 'main', sha: 'x' } });
  assert.equal(buildReviewSummary(result, { kind: 'pr', pr: { number: 15 } }, counts).message, 'PR #15 · ⛔ 3 · 70 of 71 left');
  assert.equal(buildReviewSummary(result, { kind: 'checkout', pr: { number: 9 }, sha: 'abc' }, counts).message, 'PR #9 · ⛔ 3 · 70 of 71 left');
  assert.equal(buildReviewSummary(result, { kind: 'local' }, counts).message, 'branch mode · ⛔ 3 · 70 of 71 left');
  assert.equal(buildReviewSummary(result, null, counts).message, 'branch mode · ⛔ 3 · 70 of 71 left');
  const fellBack = resultOf({ mode: 'branch', requestedMode: 'pr', base: { ref: 'origin/main', sha: 'x' } });
  assert.equal(buildReviewSummary(fellBack, { kind: 'local' }, { attention: 1, left: 1, total: 1 }).message,
    'branch mode (requested pr) · ⛔ 1 · 1 of 1 left', 'a fallback mode says what was asked for');
  assert.deepEqual(buildReviewSummary(result, null, { attention: 0, left: 1, total: 2 }).badge, { value: 1, tooltip: '1 of 2 left to review' });
  assert.equal(buildReviewSummary(result, null, { attention: 0, left: 0, total: 2 }).badge, undefined, 'nothing left, no badge');
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
  assert.equal(item(a).description, '⛔ 2  ·  0/4  ·  src');
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
  assert.equal(provider.summarize().message, 'branch mode · ⛔ 2 · 6 of 6 left');
  provider.toggleFilter('attention');
  assert.equal(provider.summarize().message, 'branch mode · ⛔ 2 · 6 of 6 left · filter: needs attention');
  provider.toggleFilter('unreviewed');
  assert.equal(provider.summarize().message, 'branch mode · ⛔ 2 · 6 of 6 left · filter: unreviewed');
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
  const [file] = await provider.getChildren();
  assert.equal(provider.getParent(file), undefined);
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

test('the counts of a shown review, and none while a placeholder is shown', async () => {
  const { provider } = viewOf(sampleResult());
  assert.deepEqual(provider.reviewCounts(), { total: 6, left: 6, attention: 2 });
  const none = createTreeProvider(vscode, { getState: () => null, resolver: {} });
  assert.equal(none.reviewCounts(), null);
  assert.equal(none.nextUnreviewed(null), null);
});
