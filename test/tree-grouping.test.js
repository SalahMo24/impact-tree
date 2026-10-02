'use strict';
// "Other changes" layout: a change declared inside another nests under it, several
// changes in one file share a file row, and the worst state leads every group.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');
const { createReviewState } = require('../src/review-state');

const BODY = [{ id: 'body', label: 'body' }];
let at = 0;
const change = (relPath, label, start, end, extra = {}) => ({
  file: `/repo/${relPath}`, relPath, label, namePos: at++, start, end, startLine: 1, component: '(root)',
  kinds: BODY, throwsAdded: [], callers: [], stale: [], staleCallers: 0, callerState: 'resolved', score: 1, ...extra,
});
const factory = change('src/open-review.js', 'createOpenReview', 0, 1000);
const inner = change('src/open-review.js', 'createOpenReview.baseUriFor', 100, 200);
const innerMost = change('src/open-review.js', 'createOpenReview.baseUriFor.toUri', 120, 150);
const sibling = change('src/open-review.js', 'createOpenReview.sameDoc', 300, 400, { callerState: 'unknown' });
const helper = change('src/open-review.js', 'sameUri', 1100, 1200);
const stale = change('src/session.js', 'createSession', 0, 500, { staleCallers: 1, stale: [{ label: 'activate' }] });
const sessionHelper = change('src/session.js', 'reset', 600, 700);
const lone = change('src/readiness.js', 'createReadiness', 0, 100);
const finding = change('src/open-review.js', 'createOpenReview.rangesFor', 500, 600, { kinds: [{ id: 'sig', label: 'signature' }] });
const result = {
  allChanged: [factory, inner, innerMost, sibling, helper, stale, sessionHelper, lone, finding],
  findings: [finding], deleted: [], warnings: [], unanalysable: [], otherFiles: [], untested: [],
  mode: 'working', base: { ref: 'HEAD', sha: '0' }, testReachComputed: true,
};

function viewOf(state = {}, review = null) {
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/repo/', ''), ...state }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review,
  });
  const other = async () => {
    const sections = await provider.getChildren();
    return provider.getChildren(sections.find((s) => s.key === 'other'));
  };
  return { provider, other };
}
const reachable = async (provider, nodes) => {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'finding') out.push(n.finding);
    if (n.type === 'finding' || n.type === 'changeFile' || n.type === 'insideGroup') {
      out.push(...await reachable(provider, (await provider.getChildren(n)).filter((k) => k.type !== 'caller')));
    }
  }
  return out;
};

test('every body-only change stays reachable exactly once', async () => {
  const { provider, other } = viewOf();
  const seen = await reachable(provider, await other());
  assert.deepEqual(seen.map((c) => c.label).sort(), [factory, inner, innerMost, sibling, helper, stale, sessionHelper, lone].map((c) => c.label).sort());
});

test('a file with several changes is one row, worst state first; a lone change stays flat', async () => {
  const { provider, other } = viewOf();
  const top = await other();
  assert.deepEqual(top.map((n) => n.type === 'changeFile' ? `file:${n.label}` : n.label), ['file:session.js', 'file:open-review.js', 'createReadiness']);
  const sessionRow = provider.getTreeItem(top[0]);
  assert.equal(sessionRow.description, '⛔  2 changes');
  assert.equal(sessionRow.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'a group holding ⛔ starts open');
  const reviewRow = provider.getTreeItem(top[1]);
  assert.equal(reviewRow.description, '?  5 changes', 'counts, and takes its state from, the changes nested inside its rows');
  assert.deepEqual((await provider.getChildren(top[0])).map((n) => n.label), ['createSession', 'reset']);
});

test('a change declared inside another nests under it, apart from its callers, without the prefix', async () => {
  const { provider, other } = viewOf();
  const [openReview] = await provider.getChildren((await other())[1]);
  assert.deepEqual((await provider.getChildren((await other())[1])).map((n) => n.label), ['createOpenReview', 'sameUri'],
    'inner functions are not rows of the file');
  const [inside] = await provider.getChildren(openReview);
  assert.equal(inside.type, 'insideGroup');
  assert.deepEqual((await provider.getChildren(inside)).map((n) => n.label), ['sameDoc', 'baseUriFor'], 'worst first');
  assert.equal(provider.getTreeItem(openReview).description, '✓  ·  ? inside', 'a collapsed container shows the worst state inside it');
  const [, base] = await provider.getChildren(inside);
  const [baseInside] = await provider.getChildren(base);
  assert.deepEqual((await provider.getChildren(baseInside)).map((n) => n.label), ['toUri'], 'nearest container wins');
  assert.equal(provider.getTreeItem(baseInside).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'an all-✓ group starts closed');
  assert.equal(provider.getTreeItem(inside).collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'a group holding ? starts open');
  assert.ok(!(await provider.getChildren(inside)).some((n) => n.label.includes('rangesFor')), 'a finding is not pulled out of Findings');
});

test('a file whose changes all sit inside one function is that function\'s row, not a file row', async () => {
  const saved = result.allChanged;
  result.allChanged = saved.filter((c) => c !== helper);
  try {
    const { other } = viewOf();
    assert.deepEqual((await other()).map((n) => n.label), ['session.js', 'createOpenReview', 'createReadiness']);
  } finally { result.allChanged = saved; }
});

test('flat layout keeps containment but drops the file rows', async () => {
  const { other } = viewOf({ fileListLayout: 'flat' });
  assert.deepEqual((await other()).map((n) => n.label), ['createSession', 'createOpenReview', 'sameUri', 'reset', 'createReadiness']);
});

test('a group is ticked exactly when every change in it is', async () => {
  const store = new Map();
  const review = createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
  const { provider, other } = viewOf({}, review);
  const [sessionFile] = await other();
  const kids = review.childIds(sessionFile);
  assert.equal(kids.length, 2);
  assert.equal(provider.getTreeItem(sessionFile).checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  review.setWithChildren(review.id(sessionFile), kids, true);
  assert.equal(provider.getTreeItem(sessionFile).checkboxState, vscode.TreeItemCheckboxState.Checked);
  review.set(kids[0], false);
  assert.equal(provider.getTreeItem(sessionFile).checkboxState, vscode.TreeItemCheckboxState.Unchecked, 'unticking a member unticks the group');
});
