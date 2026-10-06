'use strict';
// The Details view through the real activate(): what it shows for a tree selection and
// for a cursor in a review diff, what it reveals, and what its messages do. The HTML
// itself is tested in detail-panel-html.test.js; here only its text is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { localResult, finding, previewResult, pull, withEnv } = require('./extension-env');
const { prQuery } = require('../src/pr-documents');
const { treeItemId } = require('../src/review-tree-model');

const SITE = { start: 22, end: 25 };
const caller = (file) => ({ file, pos: 7, label: 'user', test: false, callSites: [SITE], sites: 1,
  callSiteUpdates: { updated: [], untouched: [SITE], unknown: [] } });
const NOT_FOLLOWED = 'Select a change in the tree, or put the cursor in a changed function.';

// a.ts: `bad` (lines 10–12, a signature change with a caller not updated) and `reach`
// (lines 50–52, body only); b.ts: `quiet` and the caller; notes.md has no call graph.
function useResult(env, { tierA = false } = {}) {
  const a = path.join(env.dir, 'a.ts'), b = path.join(env.dir, 'b.ts');
  // the caller's call site, offset 22, is on line 3 of b.ts
  fs.writeFileSync(b, 'const one = 1;\nfoo;\nuser(bad());\n');
  const bad = { ...finding('bad', a, 10), relPath: 'a.ts', startLine: 10, endLine: 12, staleCallers: 1, callers: [caller(b)] };
  const reach = { ...finding('reach', a, 50), relPath: 'a.ts', startLine: 50, endLine: 52, kinds: [{ id: 'body', label: 'body' }], callers: [caller(b)] };
  const quiet = { ...finding('quiet', b, 5), relPath: 'b.ts', startLine: 5, endLine: 6, kinds: [{ id: 'body', label: 'body' }] };
  // a real result lists new throws on every change, and the tree's tooltip reads them
  const allChanged = [bad, reach, quiet].map((c) => ({ ...c, throwsAdded: [] }));
  const parts = { allChanged, findings: [allChanged[0]], otherFiles: [{ path: 'notes.md', status: 'added' }],
    fileStatus: { 'a.ts': 'modified', 'b.ts': 'modified', 'notes.md': 'added' } };
  if (tierA) env.hooks.remoteResult = (pr) => ({ ...previewResult(pr), ...parts });
  else env.hooks.localResult = (o) => ({ ...localResult(o), ...parts });
}
// What the panel says, tags stripped.
const textOf = (details) => details.displayHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// The tree id the panel's tick button names, as its script would send it.
const tickId = (details) => /data-act="tick" data-id="([^"]*)"/.exec(details.webview.html)[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// Capture the page that drew an action, rather than attaching the current token on delivery.
const pageAction = (details, message) => message && typeof message === 'object'
  ? { ...message, token: /<script nonce="([^"]+)"/.exec(details.webview.html)[1] } : message;
const sendAction = (details, message) => details.send(pageAction(details, message));
const fileUri = (env, rel) => env.vscode.Uri.file(path.join(env.dir, rel));
const rowsOf = async (env) => {
  const files = await env.tree().getChildren();
  return { files, a: await env.tree().getChildren(files[0]) };
};

test('the view is a webview under the change view, with scripts on and no local resources', () => withEnv(async (env) => {
  const { contributes } = require('../package.json');
  const views = contributes.views.impactTree;
  assert.deepEqual(views.map((v) => v.id), ['impactTree.sources', 'impactTree.changes', 'impactTree.details']);
  assert.deepEqual(views[2], { type: 'webview', id: 'impactTree.details', name: 'Details', contextualTitle: 'Impact Tree' });
  const details = env.openDetails();
  assert.deepEqual(details.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.equal(textOf(details), NOT_FOLLOWED, 'nothing selected yet');
  assert.match(details.webview.html, /style-src vscode-webview:\/\/test 'nonce-/, 'the webview\'s own CSP source');
}));

test('a cursor inside a change in a review diff shows that change and reveals it', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  assert.match(textOf(details), /^at cursor, line 11 bad a\.ts:10–12 Needs attention\. /);
  assert.match(textOf(details), /Callers \(1\) Show callers ○ user b\.ts:3 /, 'the call site line, read from the file');
  assert.equal(env.seen.revealed.length, 1);
  assert.equal(env.seen.revealed[0].row, a[0]);
  assert.deepEqual(env.seen.revealed[0].options, { select: true, focus: false });

  env.moveCursor(fileUri(env, 'a.ts'), 51);
  assert.match(textOf(details), /^at cursor, line 51 reach /);
  assert.equal(env.seen.revealed.at(-1).row, a[1]);
}));

test('a cursor moving inside the row shown only updates the header; the page is not reloaded', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  const loads = details.loads;
  env.moveCursor(fileUri(env, 'a.ts'), 12);
  assert.equal(details.loads, loads, 'the html is not set again');
  assert.deepEqual(details.posted, [{ type: 'origin', token: pageAction(details, {}).token, text: 'at cursor, line 12' }]);
  assert.equal(env.seen.revealed.length, 1, 'the same row is not revealed again');
  env.moveCursor(fileUri(env, 'a.ts'), 12);
  assert.equal(details.posted.length, 1, 'the same line posts nothing');

  // a page hidden and shown again is rebuilt from the html, so it is painted afresh
  details.setVisible(false);
  details.setVisible(true);
  assert.match(textOf(details), /^at cursor, line 12 bad /);

  env.select([a[0]]);
  assert.equal(details.posted.length, 1, 'the cursor reveal\'s own selection changes nothing');
  env.select([a[1]]);
  const reloaded = details.loads;
  env.moveCursor(fileUri(env, 'a.ts'), 50);
  assert.deepEqual(details.posted.at(-1), { type: 'origin', token: pageAction(details, {}).token, text: 'at cursor, line 50' }, 'from the tree to the cursor on the same row');
  assert.equal(details.loads, reloaded);
  env.tick(a[1], true);
  assert.equal(details.loads, reloaded, 'a tick patches the review fields without reloading');
  assert.match(textOf(details), /^at cursor, line 50 reach .*Untick/);
}));

test('a cursor between functions shows the file', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { files } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 30);
  assert.match(textOf(details), /^at cursor, line 30 a\.ts a\.ts · modified 2 changes, 1 needs attention, 2 left to review\./);
  assert.equal(env.seen.revealed.at(-1).row.relPath, 'a.ts');
  assert.equal(env.seen.revealed.at(-1).row.type, 'reviewFile');
  assert.equal(files[0].relPath, 'a.ts');
  env.moveCursor(fileUri(env, 'notes.md'), 3);
  assert.match(textOf(details), /^at cursor, line 3 notes\.md notes\.md · added No call graph for this file/);
}));

test('a cursor in any other editor, on the base side or in a file the review does not include changes nothing', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { Uri } = env.vscode;
  for (const uri of [
    Uri.from({ scheme: 'impacttree-base', path: 'a.ts', query: 'HEAD' }),
    Uri.from({ scheme: 'output', path: 'extension-output-impact-tree' }),
    fileUri(env, 'README.md'),
    Uri.file(path.join(path.dirname(env.dir), 'elsewhere', 'a.ts')),
    // a preview's address names a result that is not shown
    Uri.from({ scheme: 'impacttree-pr', path: 'a.ts', query: 'side=head&revision=7%3Ah%3Am' }),
  ]) {
    env.moveCursor(uri, 11);
    assert.equal(textOf(details), NOT_FOLLOWED, uri.toString());
  }
  assert.deepEqual(env.seen.revealed, []);

  env.moveCursor(fileUri(env, 'a.ts'), 11, { active: false });
  assert.equal(textOf(details), NOT_FOLLOWED, 'an editor that is not the active one');
  env.moveCursor(fileUri(env, 'a.ts'), 11, { kind: env.vscode.TextEditorSelectionChangeKind.Command });
  assert.equal(textOf(details), NOT_FOLLOWED, 'a selection set by a command, such as opening a diff from the tree');
  env.moveCursor(fileUri(env, 'a.ts'), 11, { kind: undefined });
  assert.match(textOf(details), /^at cursor, line 11 bad /, 'an event that does not say how the cursor moved still counts');
}));

test('in a preview only the pull request\'s head side is followed', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const details = env.openDetails();
  const result = previewResult(pull(7));   // the same revision key as the preview shown
  const { Uri } = env.vscode;
  const side = (s) => Uri.from({ scheme: 'impacttree-pr', path: 'a.ts', query: prQuery(result, s, { path: 'a.ts', status: 'modified' }) });
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  env.moveCursor(side('base'), 11);
  assert.equal(textOf(details), NOT_FOLLOWED, 'neither the worktree file nor the base side');
  env.moveCursor(side('head'), 11);
  assert.match(textOf(details), /^at cursor, line 11 bad /);
  assert.match(textOf(details), /Preview: only callers in the pull request's own files are shown\./);
}));

test('a tree selection shows that row; a caller or tests row shows its change', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { files, a } = await rowsOf(env);
  env.select([a[1]]);
  assert.match(textOf(details), /^selected in tree reach a\.ts:50–52 Reaches callers\. /);
  const [under, tests] = await env.tree().getChildren(a[0]);
  assert.equal(under.type, 'caller');
  env.select([under]);
  assert.match(textOf(details), /^selected in tree bad a\.ts:10–12 Needs attention\. /);
  env.select([a[1]]);
  env.select([tests]);
  assert.match(textOf(details), /^selected in tree bad /);
  env.select([files[2]]);
  assert.match(textOf(details), /^selected in tree notes\.md /);
  env.select([]);
  assert.match(textOf(details), /^selected in tree notes\.md /, 'a cleared selection keeps what is shown');
  assert.deepEqual(env.seen.revealed, [], 'a tree selection reveals nothing');
}));

test('the selection a cursor reveal causes keeps the cursor header; another selection takes over', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  // VS Code selects the revealed row, and says so
  env.select([env.seen.revealed[0].row]);
  assert.match(textOf(details), /^at cursor, line 11 bad /);
  env.select([a[1]]);
  assert.match(textOf(details), /^selected in tree reach /);
  env.select([a[0]]);
  assert.match(textOf(details), /^selected in tree bad /, 'once another row was picked, the old reveal is not remembered');
}));

test('the tick message ticks the row shown and repaints; next runs the command; a caller link opens the caller', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { files, a } = await rowsOf(env);
  env.select([a[0]]);
  await sendAction(details, { type: 'tick', id: tickId(details), on: true });
  assert.equal(env.isTicked(a[0]), true);
  assert.match(textOf(details), /Untick Next unreviewed$/);
  assert.equal(env.seen.statusBar.text.split(' ')[1], '3', 'the status bar repainted too');
  await sendAction(details, { type: 'tick', id: tickId(details), on: false });
  assert.equal(env.isTicked(a[0]), false);

  env.select([files[0]]);
  await sendAction(details, { type: 'tick', id: tickId(details), on: true });
  assert.ok(a.every((r) => env.isTicked(r)), 'a file\'s button ticks its rows');
  assert.match(textOf(details), /0 left to review\. Untick file /);

  await sendAction(details, { type: 'next' });
  assert.deepEqual(env.seen.executed.filter(([name]) => name === 'impactTree.nextUnreviewed').length, 1);

  env.select([a[0]]);
  await sendAction(details, { type: 'openCaller', index: 0 });
  const opened = env.seen.executed.filter(([name]) => name === 'impactTree.openCaller');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][1].label, 'user');
  assert.equal(opened[0][1].file, path.join(env.dir, 'b.ts'));
}));

test('a tick drawn for another row than the one shown now is dropped', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const drawnFor = tickId(details);
  env.moveCursor(fileUri(env, 'a.ts'), 51);   // the panel moves on to `reach` before the click arrives
  await sendAction(details, { type: 'tick', id: drawnFor, on: true });
  assert.equal(env.isTicked(a[0]), false);
  assert.equal(env.isTicked(a[1]), false);
  await sendAction(details, { type: 'tick', id: tickId(details), on: true });
  assert.equal(env.isTicked(a[1]), true);
}));

test('a malformed or unknown message is ignored', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const before = env.seen.executed.length;
  const id = tickId(details);
  for (const message of [null, undefined, 'tick', 7, [], {}, { type: 'tick' }, { type: 'tick', on: true }, { type: 'tick', id: 5, on: true },
    { type: 'tick', id, on: 'true' }, { type: 'tick', id, on: 1 }, { type: 'tick', id: `${id} `, on: true },
    { type: 'openCaller' }, { type: 'openCaller', index: 1 }, { type: 'openCaller', index: -1 }, { type: 'openCaller', index: 0.5 },
    { type: 'openCaller', index: '0' }, { type: 'run', command: 'workbench.action.quit' }]) {
    await sendAction(details, message);
  }
  assert.equal(env.isTicked(a[0]), false);
  assert.equal(env.seen.executed.length, before, 'no command ran');

  env.select([(await env.tree().getChildren())[2]]);
  await sendAction(details, { type: 'openCaller', index: 0 });
  assert.equal(env.seen.executed.length, before, 'a file has no callers to open');
}));

test('the panel follows a new analysis, and shows the hint while there is no review', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const gate = env.holds.analyze.next();
  const running = env.refresh();
  await gate.reached;
  assert.equal(textOf(details), NOT_FOLLOWED, 'while analysing');
  gate.release();
  await running;
  assert.match(textOf(details), /^selected in tree bad /, 'the same row of the new result');
}));

test('the Show callers message runs the command for the row shown; one drawn for another row, or malformed, does nothing', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const peekId = () => /data-act="peek" data-id="([^"]*)"/.exec(details.webview.html)[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const ran = () => env.seen.executed.filter(([name]) => name === 'impactTree.showCallers');
  const id = peekId();
  assert.equal(id, tickId(details), 'the id of the row shown');
  await sendAction(details, { type: 'showCallers', id });
  assert.deepEqual(ran(), [['impactTree.showCallers', id]]);

  for (const message of [{ type: 'showCallers' }, { type: 'showCallers', id: 5 }, { type: 'showCallers', id: null }, { type: 'showCallers', id: `${id} ` },
    { type: 'showCallers', id: `finding:a.ts:reach:${a[1].pos}` }, { type: 'showCallers', index: 0 }]) await sendAction(details, message);
  assert.equal(ran().length, 1, 'only the row shown');

  env.select([(await env.tree().getChildren())[2]]);   // a file without a call graph
  await sendAction(details, { type: 'showCallers', id });
  assert.equal(ran().length, 1, 'the panel moved on to another row');
  assert.doesNotMatch(details.webview.html, /data-act="peek"/, 'a file row has no callers link');
}));

test('showChange shows the change in the panel and reveals it in the tree; a bad id does nothing', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  await env.run('impactTree.showChange', treeItemId(a[1]));
  assert.match(textOf(details), /^selected in tree reach a\.ts:50–52 /);
  assert.deepEqual(env.seen.revealed.map((r) => [r.row, r.options]), [[a[1], { select: true, focus: false }]]);
  // the selection that reveal causes is the row already shown
  const loads = details.loads;
  env.select([a[1]]);
  assert.equal(details.loads, loads, 'not painted twice');

  for (const id of [undefined, null, 5, '', 'finding:a.ts:nothing:1']) await env.run('impactTree.showChange', id);
  assert.equal(env.seen.revealed.length, 1);
  assert.match(textOf(details), /^selected in tree reach /);
}));

test('cursor following opens no view, and neither view follows while it is hidden', () => withEnv(async env => {
  useResult(env);
  await env.refresh();
  env.setTreeVisible(false);
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  assert.equal(env.seen.revealed.length, 0, 'Details was never opened and the change view is hidden');

  const details = env.openDetails();
  details.setVisible(false);
  const loads = details.loads;
  env.moveCursor(fileUri(env, 'a.ts'), 51);
  assert.equal(details.loads, loads, 'a collapsed Details view does not follow the cursor');
  assert.equal(env.seen.revealed.length, 0, 'the hidden change view is not revealed');
}));

test('a visible change view follows the cursor while Details is collapsed', () => withEnv(async env => {
  useResult(env);
  await env.refresh();
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  assert.equal(env.seen.revealed.length, 1, 'Details was never opened');
  assert.equal(treeItemId(env.seen.revealed[0].row), treeItemId((await rowsOf(env)).a[0]));
  assert.equal(env.seen.revealed[0].options.focus, false);
}));

test('a visible Details view follows the cursor while the change view is hidden, and the tree catches up', () => withEnv(async env => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  env.setTreeVisible(false);
  env.moveCursor(fileUri(env, 'a.ts'), 51);
  assert.match(textOf(details), /^at cursor, line 51 reach /, 'Details follows without the tree');
  assert.equal(env.seen.revealed.length, 0, 'the hidden change view is not revealed');

  env.setTreeVisible(true);
  assert.equal(env.seen.revealed.length, 1, 'the tree selects the row Details shows once it is visible');
  assert.equal(treeItemId(env.seen.revealed[0].row), treeItemId(a[1]));
  env.select([a[1]]);
  assert.match(textOf(details), /^at cursor, line 51 reach /, 'the reveal keeps the cursor header');

  env.setTreeVisible(false);
  env.setTreeVisible(true);
  assert.equal(env.seen.revealed.length, 1, 'a tree that already selects the shown row is left alone');
}));

test('a delayed caller link cannot open a caller of the new panel selection', () => withEnv(async env => {
  useResult(env);
  const original = env.hooks.localResult;
  env.hooks.localResult = o => {
    const result = original(o);
    result.allChanged[1].callers = [{ ...caller(path.join(env.dir, 'b.ts')), label: 'reachUser' }];
    return result;
  };
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const click = pageAction(details, { type: 'openCaller', index: 0 });
  env.select([a[1]]);
  await details.send(click);
  const opened = () => env.seen.executed.filter(([command]) => command === 'impactTree.openCaller');
  assert.equal(opened().length, 0);
  await sendAction(details, { type: 'openCaller', index: 0 });
  assert.equal(opened().length, 1, 'the current page can still open its caller');
  assert.equal(opened()[0][1].label, 'reachUser');
}));

test('all actions from an older page are ignored after content changes at the same tree id', () => withEnv(async env => {
  const file = path.join(env.dir, 'a.ts');
  fs.writeFileSync(file, 'export function f() { return 1; }\n');
  env.hooks.localResult = o => ({ ...localResult(o), fileStatus: { 'a.ts': 'added' }, allChanged: [
    { ...finding('f', file, 16), startLine: 1, endLine: 1, throwsAdded: [], staleCallers: 1,
      callers: [caller(path.join(env.dir, 'b.ts'))] },
  ] });
  await env.refresh();
  const details = env.openDetails();
  const [oldRow] = await env.changeRows();
  env.select([oldRow]);
  const id = tickId(details);
  const messages = [{ type: 'tick', id, on: true }, { type: 'next' }, { type: 'showCallers', id }, { type: 'openCaller', index: 0 }];
  const queued = messages.map(message => pageAction(details, message));
  fs.writeFileSync(file, 'export function f() { return 2; }\n');
  await env.refresh();
  const [newRow] = await env.changeRows();
  assert.equal(treeItemId(newRow), id, 'the UI id stays stable despite new reviewed content');
  const before = env.seen.executed.length;
  for (const message of queued) await details.send(message);
  assert.equal(env.isTicked(newRow), false);
  assert.equal(env.seen.executed.length, before, 'no old next, peek or caller command runs');
  await sendAction(details, { type: 'tick', id, on: true });
  assert.equal(env.isTicked(newRow), true, 'the current page can review the new content');
}));

test('a stale file checkbox cannot mark a changed file reviewed after refresh', () => withEnv(async env => {
  useResult(env);
  const file = path.join(env.dir, 'notes.md');
  fs.writeFileSync(file, 'first draft');
  await env.refresh();
  const details = env.openDetails();
  const { files } = await rowsOf(env);
  env.select([files[2]]);
  const click = pageAction(details, { type: 'tick', id: tickId(details), on: true });
  fs.writeFileSync(file, 'second draft');
  await env.refresh();
  const newFile = (await rowsOf(env)).files[2];
  assert.equal(treeItemId(newFile), click.id);
  await details.send(click);
  assert.equal(env.isTicked(newFile), false);
  await sendAction(details, { type: 'tick', id: click.id, on: true });
  assert.equal(env.isTicked(newFile), true);
}));

test('header-only cursor updates keep the page actions valid', () => withEnv(async env => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  const click = pageAction(details, { type: 'tick', id: tickId(details), on: true });
  env.moveCursor(fileUri(env, 'a.ts'), 12);
  await details.send(click);
  const { a } = await rowsOf(env);
  assert.equal(env.isTicked(a[0]), true);
}));

test('well-formed panel actions require the current page token', () => withEnv(async env => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const id = tickId(details);
  const before = env.seen.executed.length;
  for (const message of [{ type: 'tick', id, on: true }, { type: 'next' }, { type: 'showCallers', id }, { type: 'openCaller', index: 0 }]) {
    for (const token of [undefined, null, 1, {}, '', 'obsolete']) await details.send({ ...message, token });
  }
  assert.equal(env.isTicked(a[0]), false);
  assert.equal(env.seen.executed.length, before);
}));
