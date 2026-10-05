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
const textOf = (details) => details.webview.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
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
  assert.match(textOf(details), /Callers \(1\) ○ user b\.ts:3 /, 'the call site line, read from the file');
  assert.equal(env.seen.revealed.length, 1);
  assert.equal(env.seen.revealed[0].row, a[0]);
  assert.deepEqual(env.seen.revealed[0].options, { select: true, focus: false });

  env.moveCursor(fileUri(env, 'a.ts'), 12);
  assert.match(textOf(details), /^at cursor, line 12 bad /, 'the header follows the line');
  assert.equal(env.seen.revealed.length, 1, 'the same row is not revealed again');
  env.moveCursor(fileUri(env, 'a.ts'), 51);
  assert.match(textOf(details), /^at cursor, line 51 reach /);
  assert.equal(env.seen.revealed.at(-1).row, a[1]);
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
  await details.send({ type: 'tick', on: true });
  assert.equal(env.isTicked(a[0]), true);
  assert.match(textOf(details), /Untick Next unreviewed$/);
  assert.equal(env.seen.statusBar.text.split(' ')[1], '3', 'the status bar repainted too');
  await details.send({ type: 'tick', on: false });
  assert.equal(env.isTicked(a[0]), false);

  env.select([files[0]]);
  await details.send({ type: 'tick', on: true });
  assert.ok(a.every((r) => env.isTicked(r)), 'a file\'s button ticks its rows');
  assert.match(textOf(details), /0 left to review\. Untick file /);

  await details.send({ type: 'next' });
  assert.deepEqual(env.seen.executed.filter(([name]) => name === 'impactTree.nextUnreviewed').length, 1);

  env.select([a[0]]);
  await details.send({ type: 'openCaller', index: 0 });
  const opened = env.seen.executed.filter(([name]) => name === 'impactTree.openCaller');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][1].label, 'user');
  assert.equal(opened[0][1].file, path.join(env.dir, 'b.ts'));
}));

test('a malformed or unknown message is ignored', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const before = env.seen.executed.length;
  for (const message of [null, undefined, 'tick', 7, [], {}, { type: 'tick' }, { type: 'tick', on: 'true' }, { type: 'tick', on: 1 },
    { type: 'openCaller' }, { type: 'openCaller', index: 1 }, { type: 'openCaller', index: -1 }, { type: 'openCaller', index: 0.5 },
    { type: 'openCaller', index: '0' }, { type: 'run', command: 'workbench.action.quit' }]) {
    await details.send(message);
  }
  assert.equal(env.isTicked(a[0]), false);
  assert.equal(env.seen.executed.length, before, 'no command ran');

  env.select([(await env.tree().getChildren())[2]]);
  await details.send({ type: 'openCaller', index: 0 });
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
