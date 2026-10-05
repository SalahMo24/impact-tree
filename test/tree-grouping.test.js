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
const sibling = change('src/open-review.js', 'createOpenReview.sameDoc', 300, 400, { callerState: 'unknown', kinds: [{ id: 'sig', label: 'signature' }] });
const helper = change('src/open-review.js', 'sameUri', 1100, 1200);
const stale = change('src/session.js', 'createSession', 0, 500, { staleCallers: 1, stale: [{ label: 'activate' }], kinds: [{ id: 'sig', label: 'signature' }] });
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
  assert.equal(provider.getTreeItem(openReview).description, '●  ·  ? inside', 'a collapsed container shows the worst state inside it');
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

// A caller-file group takes its worst member's state: △ (changed elsewhere) needs more
// attention than ○ (not changed), which needs more than ✓ (call updated).
test('a caller-file group shows the worst state of its callers', async () => {
  const target = change('src/target.js', 'target', 0, 100, { kinds: [{ id: 'sig', label: 'signature' }] });
  const callerOf = (pos, state) => ({
    file: '/repo/src/user.js', pos, label: `user${pos}`, test: false, sites: 1,
    callSites: [{ start: pos, end: pos + 1, updated: state === 'updated-at-call' }], state,
  });
  const groupState = async (...states) => {
    const callers = states.map((s, i) => callerOf(10 + i, s));
    const provider = createTreeProvider(vscode, {
      getState: () => ({
        result: { ...result, allChanged: [target], findings: [target] }, rowDetail: 'hover', rel: (f) => f.replace('/repo/', ''),
        changedKeys: new Set(callers.filter((c) => c.state === 'changed-elsewhere').map((c) => `${c.file}#${c.pos}`)),
        classifyCallSiteUpdates: (_, sites) => ({
          updated: sites.filter((s) => s.updated), untouched: sites.filter((s) => !s.updated), unknown: [],
        }),
      }),
      resolver: { incomingWithStatus: async () => ({ callers, complete: true }) },
    });
    const sections = await provider.getChildren();
    const [row] = await provider.getChildren(sections.find((s) => s.key === 'findings'));
    const kids = await provider.getChildren(row);
    assert.deepEqual(kids.map((k) => k.type), ['callerFile'], states.join(','));
    assert.deepEqual(kids[0].callers.map((k) => k.callState), states, 'members keep their own state');
    return kids[0].callState;
  };
  assert.equal(await groupState('unchanged', 'changed-elsewhere'), 'changed-elsewhere');
  assert.equal(await groupState('changed-elsewhere', 'unchanged', 'updated-at-call'), 'changed-elsewhere');
  assert.equal(await groupState('updated-at-call', 'changed-elsewhere'), 'changed-elsewhere');
  assert.equal(await groupState('updated-at-call', 'unchanged'), 'unchanged');
  assert.equal(await groupState('unchanged', 'updated-at-call', 'unchanged'), 'unchanged');
  assert.equal(await groupState('updated-at-call', 'updated-at-call'), 'updated-at-call');
});

// Folders compact like the explorer's: a chain of directories that each hold nothing
// but one directory is one row, at every depth, and every folder row knows its full path.
test('expanding a folder compacts whole single-child chains and records every folder path', async () => {
  const filesView = async (paths) => {
    const provider = createTreeProvider(vscode, {
      getState: () => ({
        result: { ...result, allChanged: [], findings: [], otherFiles: paths.map((p) => ({ path: p, status: 'modified' })) },
        rowDetail: 'hover', rel: (f) => f,
      }),
      resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) },
    });
    const sections = await provider.getChildren();
    return { provider, top: await provider.getChildren(sections.find((s) => s.key === 'files')) };
  };
  const shape = (rows) => rows.map((n) => (n.type === 'dir' ? `dir:${n.label}@${n.dirPath}` : n.label));

  const deep = await filesView(['src/x.ts', 'src/a/b/c/d/y.ts', 'src/a/b/c/d/z.ts']);
  assert.deepEqual(shape(deep.top), ['dir:src@src']);
  const src = await deep.provider.getChildren(deep.top[0]);
  assert.deepEqual(shape(src), ['dir:a/b/c/d@src/a/b/c/d', 'x.ts']);
  assert.equal(deep.provider.getTreeItem(src[0]).tooltip, 'src/a/b/c/d');
  assert.deepEqual(shape(await deep.provider.getChildren(src[0])), ['y.ts', 'z.ts']);

  // the top level compacts the same way, and is unchanged
  const chain = await filesView(['p/q/r/s/t.ts', 'p/q/r/s/u.ts']);
  assert.deepEqual(shape(chain.top), ['dir:p/q/r/s@p/q/r/s']);

  // a branch stops the compaction, and a directory that holds a file is never merged
  const branchy = await filesView(['m/n/o/one.ts', 'm/n/o/p/two.ts', 'm/n/o/q/r/three.ts', 'm/n/o/q/r/s/four.ts', 'm/n/file.ts']);
  assert.deepEqual(shape(branchy.top), ['dir:m/n@m/n']);
  const n = await branchy.provider.getChildren(branchy.top[0]);
  assert.deepEqual(shape(n), ['dir:o@m/n/o', 'file.ts']);
  const o = await branchy.provider.getChildren(n[0]);
  assert.deepEqual(shape(o), ['dir:p@m/n/o/p', 'dir:q/r@m/n/o/q/r', 'one.ts']);
  assert.deepEqual(shape(await branchy.provider.getChildren(o[1])), ['dir:s@m/n/o/q/r/s', 'three.ts']);
});
