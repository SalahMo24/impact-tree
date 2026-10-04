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

function viewOf(result, { review = memoryReview(), state = {}, resolver = { incomingWithStatus: async () => ({ callers: [], complete: true }) } } = {}) {
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}`, ...state }),
    resolver, review,
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
  const rows = await provider.getChildren(a);
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
  assert.deepEqual(rows.map((r) => item(r).collapsibleState), [Collapsed, None, Collapsed, None]);
  const [caller] = await provider.getChildren(rows[2]);
  assert.equal(caller.type, 'caller');
  assert.equal(item(caller).collapsibleState, Collapsed, 'a caller expands to its own callers');
});

test('the file row shows its folder, the unreviewed attention count with the worst token, and done/total', async () => {
  const { provider, item, fileAt } = viewOf(sampleResult());
  const a = await fileAt('src/a.ts');
  assert.equal(item(a).label, 'a.ts');
  assert.equal(item(a).description, 'src  ·  ⛔ 2  ·  0/4');
  assert.match(item(a).tooltip.value, /src\/a\.ts/);
  assert.match(item(a).tooltip.value, /4 changes, 2 need attention, 4 left to review/);
  const [bad, gone] = await provider.getChildren(a);
  provider.setChecked(bad, true);
  assert.equal(item(a).description, 'src  ·  − 1  ·  1/4', 'the token is the worst unreviewed one');
  provider.setChecked(gone, true);
  assert.equal(item(a).description, 'src  ·  2/4', 'no attention left, no count');
});

test('the summary counts unreviewed attention rows and what is left, and follows the ticks', async () => {
  const { provider, fileAt } = viewOf(sampleResult(), { state: { source: { kind: 'local' } } });
  assert.deepEqual(provider.summarize(), {
    message: 'branch against origin/main · 2 need attention · 6 of 6 left',
    badge: { value: 6, tooltip: '6 of 6 left to review' },
  });
  provider.setChecked(await fileAt('src/a.ts'), true);
  assert.equal(provider.summarize().message, 'branch against origin/main · 0 need attention · 2 of 6 left');
  provider.setChecked(await fileAt('src/b.ts'), true);
  provider.setChecked(await fileAt('notes.md'), true);
  assert.deepEqual(provider.summarize(), { message: 'branch against origin/main · 0 need attention · 0 of 6 left', badge: undefined });
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
  assert.equal(buildReviewSummary(result, { kind: 'pr', pr: { number: 15 } }, counts).message, 'PR #15 against main · 3 need attention · 70 of 71 left');
  assert.equal(buildReviewSummary(result, { kind: 'checkout', pr: { number: 9 }, sha: 'abc' }, counts).message, 'PR #9 against main · 3 need attention · 70 of 71 left');
  assert.equal(buildReviewSummary(result, { kind: 'local' }, counts).message, 'branch against main · 3 need attention · 70 of 71 left');
  assert.equal(buildReviewSummary(result, null, counts).message, 'branch against main · 3 need attention · 70 of 71 left');
  const fellBack = resultOf({ mode: 'branch', requestedMode: 'pr', base: { ref: 'origin/main', sha: 'x' } });
  assert.equal(buildReviewSummary(fellBack, { kind: 'local' }, { attention: 1, left: 1, total: 1 }).message,
    'branch (requested pr) against origin/main · 1 need attention · 1 of 1 left', 'a fallback mode says what was asked for');
  assert.deepEqual(buildReviewSummary(result, null, { attention: 0, left: 1, total: 2 }).badge, { value: 1, tooltip: '1 of 2 left to review' });
  assert.equal(buildReviewSummary(result, null, { attention: 0, left: 0, total: 2 }).badge, undefined, 'nothing left, no badge');
});
