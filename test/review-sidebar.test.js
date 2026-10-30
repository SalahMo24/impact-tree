'use strict';
// The Review view as one tree (src/views/sidebar/review-sidebar.js): the review nested under the row it came
// from, the review's controls and notices on that row, no hover on pull request rows, and
// parents that let the review rows be revealed. While a review is shown the root is the
// review alone, with Review something else… above it to draw the groups again (L1).
const test = require('node:test');
const assert = require('node:assert/strict');
const stub = require('./vscode-stub');
const { createReviewSidebar, emptyReviewRow, isNotice } = require('../src/views/sidebar/review-sidebar');

const vscode = { ...stub, EventEmitter: class {
  constructor() { const ls = []; this.event = (l) => { ls.push(l); return { dispose() {} }; }; this.fire = (v) => ls.forEach((l) => l(v)); this.dispose = () => {}; }
} };

const pr = (number, title) => ({ type: 'pr', label: `#${number}  ${title}`, icon: 'git-pull-request', desc: 'someone', tooltip: '', command: 'impactTree.openPullRequest', args: [{ number, title }] });
/** A sources provider like sources-provider.js: Local changes with modes, PR groups; rows made anew on each read. */
function fakeSources({ prs = [pr(1, 'one'), pr(2, 'two')] } = {}) {
  const changed = new vscode.EventEmitter();
  return {
    onDidChangeTreeData: changed.event, fire: () => changed.fire(undefined),
    getTreeItem: (n) => ({ label: n.label, description: n.desc, tooltip: n.tooltip, contextValue: n.type === 'group' ? `source-${n.key}` : undefined,
      collapsibleState: n.type === 'group' ? (n.expanded ? 2 : 1) : 0, command: n.command ? { command: n.command } : undefined }),
    async getChildren(n) {
      if (!n) return [{ type: 'group', key: 'local', label: 'Local changes', expanded: true }, { type: 'group', key: 'prs', label: 'Pull requests', expanded: true }];
      if (n.key === 'local') return ['pr', 'working'].map((id) => ({ type: 'mode', label: id, args: [id], command: 'impactTree.analyseMode' }));
      if (n.key === 'prs') return [{ type: 'group', key: 'pr-mine', label: 'Yours', expanded: true, children: [] }, { type: 'group', key: 'pr-others', label: 'Everyone else', expanded: false, children: prs }];
      return n.children || [];
    },
  };
}
const FILE = { type: 'reviewFile', label: 'a.ts', relPath: 'a.ts' };
const CHANGE = { type: 'finding', label: 'save' };
/** A review tree like tree-provider.js: a notice, a progress row and one file holding one change. */
function fakeTree(roots = [{ type: 'message', label: 'fetched origin/main', icon: 'warning', notice: 'warning' },
  { type: 'message', label: 'Resolving callers…', icon: 'loading~spin' }, FILE]) {
  const changed = new vscode.EventEmitter();
  return {
    onDidChangeTreeData: changed.event, fire: (r) => changed.fire(r),
    getTreeItem: (r) => ({ label: r.label, id: r.label }),
    async getChildren(r) { if (!r) return roots; return r === FILE ? [CHANGE] : []; },
    getParent: (r) => (r === CHANGE ? FILE : undefined),
  };
}

/**
 * A sidebar with its groups drawn (Review something else… asked for), as the tests of the
 * nesting need; `scopedRoots` is what the first read gave: the review alone when one is shown.
 */
async function sidebarWith(host, { tree = fakeTree(), sources = fakeSources(), emptyRow } = {}) {
  const sidebar = createReviewSidebar(vscode, { tree, getHost: () => host, emptyRow });
  sidebar.setSources(sources);
  const scopedRoots = await sidebar.getChildren();
  sidebar.showPicker();
  const roots = await sidebar.getChildren();
  const prsGroup = roots[1];
  const groups = await sidebar.getChildren(prsGroup);
  return { sidebar, roots, scopedRoots, groups, tree, sources };
}

test('with a review open the root is Review something else… and the reviewed row; the groups come back on request and go on a new review', async () => {
  let current = { kind: 'pr', number: 2 };
  const tree = fakeTree();
  const sidebar = createReviewSidebar(vscode, { tree, getHost: () => current });
  sidebar.setSources(fakeSources());
  const fired = [];
  sidebar.onDidChangeTreeData((r) => fired.push(r));
  const [back, host] = await sidebar.getChildren();
  assert.equal(sidebar.isScoped(), true);
  assert.deepEqual([back.label, host.label], ['Review something else…', '#2  two']);
  assert.equal(host, await sidebar.hostRow());
  const backItem = sidebar.getTreeItem(back);
  assert.equal(backItem.command.command, 'impactTree.showPicker');
  assert.equal(backItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(await sidebar.getChildren(back), []);
  const hostItem = sidebar.getTreeItem(host);
  assert.equal(hostItem.contextValue, 'reviewHost');
  assert.equal(hostItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.deepEqual((await sidebar.getChildren(host)).map((r) => r.label), ['Resolving callers…', 'a.ts']);
  assert.equal(sidebar.getParent(host), undefined, 'the reviewed row is a root: a reveal stops there');
  assert.equal(sidebar.getParent(back), undefined);
  assert.equal(sidebar.getParent(FILE), host);
  // The groups again: the reviewed row is found under its group, with a parent.
  sidebar.showPicker();
  assert.deepEqual(fired, [undefined]);
  sidebar.showPicker();
  assert.deepEqual(fired, [undefined], 'asking twice fires once');
  const roots = await sidebar.getChildren();
  assert.equal(sidebar.isScoped(), false);
  assert.deepEqual(roots.map((r) => r.label), ['Local changes', 'Pull requests']);
  const groups = await sidebar.getChildren(roots[1]);
  const [, two] = await sidebar.getChildren(groups[1]);
  assert.equal(two, await sidebar.hostRow());
  assert.equal(sidebar.getParent(two), groups[1]);
  // A refresh of the same review keeps the groups; a review of another source hides them.
  sidebar.followTree();
  tree.fire(undefined);
  assert.deepEqual((await sidebar.getChildren()).map((r) => r.label), ['Local changes', 'Pull requests']);
  current = { kind: 'pr', number: 1 };
  tree.fire(undefined);
  assert.deepEqual((await sidebar.getChildren()).map((r) => r.label), ['Review something else…', '#1  one']);
  // No review: the groups, and nothing to ask for.
  current = null;
  tree.fire(undefined);
  assert.deepEqual((await sidebar.getChildren()).map((r) => r.label), ['Local changes', 'Pull requests']);
  assert.equal(sidebar.isScoped(), false);
  const before = fired.length;
  sidebar.showPicker();
  assert.equal(fired.length, before, 'nothing to show: no refresh');
});

test('the reviewed pull request holds the review: its group opens, its row is the header, its notices are its hover', async () => {
  const { sidebar, groups } = await sidebarWith({ kind: 'pr', number: 2 });
  const others = groups[1];
  assert.equal(others.expanded, true, 'the group holding the reviewed PR opens');
  const [one, two] = await sidebar.getChildren(others);
  const host = await sidebar.hostRow();
  assert.equal(host, two);
  const item = sidebar.getTreeItem(two);
  assert.equal(item.contextValue, 'reviewHost');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.equal(item.command.command, 'impactTree.openPullRequest', 'clicking it still offers preview, check out or open on GitHub');
  const rows = await sidebar.getChildren(two);
  assert.deepEqual(rows.map((r) => r.label), ['Resolving callers…', 'a.ts'], 'the notice left the tree');
  assert.equal(sidebar.getTreeItem(two).tooltip, 'fetched origin/main', 'it is in the reviewed row\'s hover');
  // Another pull request row: no hover, still previews on click.
  const other = sidebar.getTreeItem(one);
  assert.equal(other.tooltip, '');
  assert.equal(other.command.command, 'impactTree.openPullRequest');
  assert.notEqual(other.contextValue, 'reviewHost');
});

test('parents: a change row reveals through its file, the reviewed row, its group and Pull requests', async () => {
  const { sidebar, roots, groups } = await sidebarWith({ kind: 'pr', number: 1 });
  const [host] = await sidebar.getChildren(groups[1]);
  await sidebar.getChildren(host);
  assert.equal(sidebar.getParent(CHANGE), FILE);
  assert.equal(sidebar.getParent(FILE), host);
  assert.equal(sidebar.getParent(host), groups[1]);
  assert.equal(sidebar.getParent(groups[1]), roots[1]);
  assert.equal(sidebar.getParent(roots[1]), undefined);
  assert.deepEqual(await sidebar.getChildren(FILE), [CHANGE], 'the review rows are the review tree\'s own');
  assert.equal(sidebar.getTreeItem(CHANGE).id, 'save');
});

test('a reviewed pull request missing from the list gets its own row at the top; a local review sits under its mode', async () => {
  const missing = await sidebarWith({ kind: 'pr', number: 99, title: 'not open' });
  assert.deepEqual(missing.scopedRoots.map((r) => r.label), ['Review something else…', '#99  not open'], 'the review alone, as for a listed one');
  assert.equal(missing.roots[0].label, '#99  not open');
  assert.equal(await missing.sidebar.hostRow(), missing.roots[0]);
  assert.equal(missing.sidebar.getTreeItem(missing.roots[0]).contextValue, 'reviewHost');
  const local = await sidebarWith({ kind: 'local', mode: 'working' });
  const modes = await local.sidebar.getChildren(local.roots[0]);
  assert.equal(await local.sidebar.hostRow(), modes[1]);
  assert.equal(local.sidebar.getParent(FILE), modes[1]);
  assert.equal(local.roots.length, 2, 'no extra row');
});

test('nothing reviewed: no host, the rows are the sources\'; an empty review shows the empty row', async () => {
  const none = await sidebarWith(null);
  assert.equal(await none.sidebar.hostRow(), null);
  assert.deepEqual(none.scopedRoots.map((r) => r.label), ['Local changes', 'Pull requests'], 'nothing to scope to');
  assert.deepEqual(none.roots.map((r) => r.label), ['Local changes', 'Pull requests']);
  const empty = await sidebarWith({ kind: 'pr', number: 1 }, { tree: fakeTree([]), emptyRow: () => ({ type: 'message', label: 'Nothing changed' }) });
  const [host] = await empty.sidebar.getChildren(empty.groups[1]);
  assert.deepEqual((await empty.sidebar.getChildren(host)).map((r) => r.label), ['Nothing changed']);
});

test('refreshes: a review row repaints alone; a whole refresh of either side reads the rows again', async () => {
  const { sidebar, tree, sources } = await sidebarWith({ kind: 'pr', number: 1 });
  const fired = [];
  sidebar.onDidChangeTreeData((r) => fired.push(r));
  sidebar.followTree();
  tree.fire(FILE);
  tree.fire(undefined);
  sources.fire();
  assert.deepEqual(fired, [FILE, undefined, undefined]);
});

test('notices and the empty rows', () => {
  assert.equal(isNotice({ type: 'message', notice: 'warning', label: 'x' }), true);
  assert.equal(isNotice({ type: 'message', notice: 'unanalysable', label: 'x' }), true);
  assert.equal(isNotice({ type: 'message', notice: 'preview', label: 'x' }), true);
  assert.equal(isNotice({ type: 'message', label: 'Resolving callers…' }), false);
  const nothing = emptyReviewRow('nothingChanged', { result: { requestedMode: 'pr', base: { ref: 'origin/main' } } });
  assert.match(nothing.label, /^Nothing changed in .+ mode against origin\/main$/);
  assert.equal(nothing.command, 'impactTree.selectMode');
  assert.match(emptyReviewRow('noTypeScript', {}).tooltip, /npm install/);
  assert.equal(emptyReviewRow('shown', {}), null);
});

test('a preview says so on the reviewed row, and its limits are in the row\'s hover, not among the files', async () => {
  const limits = { type: 'message', icon: 'eye', notice: 'preview', label: 'Preview — PR files only (3 file(s))', desc: 'Preview: callers outside this PR and tests are not searched.' };
  const tree = fakeTree([limits, { type: 'message', label: 'Resolving callers…', icon: 'loading~spin' }, FILE]);
  tree.isPreview = () => true;
  const { sidebar, groups } = await sidebarWith({ kind: 'pr', number: 2 }, { tree });
  const [, two] = await sidebar.getChildren(groups[1]);
  const rows = await sidebar.getChildren(two);
  assert.deepEqual(rows.map((r) => r.label), ['Resolving callers…', 'a.ts'], 'the progress row stays, the limits left the tree');
  const item = sidebar.getTreeItem(two);
  assert.equal(item.description, 'someone  ·  preview');
  assert.match(item.tooltip, /^Preview — PR files only \(3 file\(s\)\) — Preview: callers outside this PR/);
  // A review that is not a preview, or a tree that cannot say, adds nothing.
  tree.isPreview = () => false;
  assert.equal(sidebar.getTreeItem(two).description, 'someone');
  delete tree.isPreview;
  assert.equal(sidebar.getTreeItem(two).description, 'someone');
});
