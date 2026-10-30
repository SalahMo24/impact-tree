'use strict';
// The Details view through the real activate(): what it shows for a tree selection and
// for a cursor in a review diff, what it reveals, and what its one message does. The HTML
// itself is tested in detail-panel-html.test.js; here only its text is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { localResult, finding, previewResult, pull, withEnv } = require('./extension-env');
const { prQuery } = require('../src/diff-editor/pr-documents');
const { treeItemId } = require('../src/views/changes/review-tree-model');

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
// The progress strip above the row, tags stripped.
const stripTextOf = (details) => /<div class="progress">[\s\S]*?<\/progress><\/div>/.exec(details.displayHtml)?.[0]
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() ?? null;
// What the panel says about the row, tags stripped; the strip is tested on its own.
const textOf = (details) => details.displayHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<div class="progress">[\s\S]*?<\/progress><\/div>/g, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// Capture the page that drew an action, rather than attaching the current token on delivery.
const pageAction = (details, message) => message && typeof message === 'object'
  ? { ...message, token: /<script nonce="([^"]+)"/.exec(details.webview.html)[1] } : message;
const sendAction = (details, message) => details.send(pageAction(details, message));
const fileUri = (env, rel) => env.vscode.Uri.file(path.join(env.dir, rel));
const rowsOf = async (env) => {
  const files = await env.tree().getChildren();
  return { files, a: (await env.tree().getChildren(files[0])).filter((r) => r.type !== 'spacer') };
};

test('the view is a webview under the Review view, with scripts on and no local resources', () => withEnv(async (env) => {
  const { contributes } = require('../package.json');
  const views = contributes.views.impactTree;
  assert.deepEqual(views.map((v) => v.id), ['impactTree.sources', 'impactTree.details']);
  assert.deepEqual(views[1], { type: 'webview', id: 'impactTree.details', name: 'Details', contextualTitle: 'Impact Tree' });
  const details = env.openDetails();
  assert.deepEqual(details.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.equal(textOf(details), NOT_FOLLOWED, 'nothing selected yet');
  assert.match(details.webview.html, /style-src vscode-webview:\/\/test 'nonce-/, 'the webview\'s own CSP source');
}));


// `bad` (red) says why; `reach` (body only, a caller reached) is fine, so only its title shows.
const BAD = /^bad a\.ts:10–12 Callers not updated\. /;
const REACH = 'reach a.ts:50–52';

test('a cursor inside a change in a review diff shows that change and reveals it', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  assert.match(textOf(details), BAD);
  assert.equal(env.seen.revealed.length, 1);
  assert.equal(env.seen.revealed[0].row, a[0]);
  assert.deepEqual(env.seen.revealed[0].options, { select: true, focus: false });

  env.moveCursor(fileUri(env, 'a.ts'), 51);
  assert.equal(textOf(details), REACH);
  assert.equal(env.seen.revealed.at(-1).row, a[1]);
}));

test('a cursor moving inside the row shown changes nothing: no reload, nothing posted', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  const loads = details.loads, posted = details.posted.length;
  env.moveCursor(fileUri(env, 'a.ts'), 12);
  assert.equal(details.loads, loads, 'the html is not set again');
  assert.equal(details.posted.length, posted, 'nothing is posted');
  assert.equal(env.seen.revealed.length, 1, 'the same row is not revealed again');

  // a page hidden and shown again is rebuilt from the html
  details.setVisible(false);
  details.setVisible(true);
  assert.match(textOf(details), BAD);

  env.select([a[0]]);
  env.select([a[1]]);
  const reloaded = details.loads;
  env.moveCursor(fileUri(env, 'a.ts'), 50);
  assert.equal(details.loads, reloaded, 'from the tree to the cursor on the same row');
}));

test('a tick patches the progress strip without reloading the page', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[1]]);
  const loads = details.loads;
  const before = details.posted.length;
  env.tick(a[1], true);
  assert.equal(details.posted.length, before, '`reach` does not need attention: the strip does not move');
  env.tick(a[0], true);
  assert.equal(details.loads, loads, 'not reloaded');
  assert.equal(details.posted.at(-1).type, 'progress');
  assert.equal(details.posted.at(-1).model.countText, '1 of 1 looked at');
  assert.equal(stripTextOf(details), '1 of 1 looked at nothing needs attention 1 of 1 looked at');
  const posted = details.posted.length;
  env.tick(a[0], true);
  assert.equal(details.posted.length, posted, 'the same counts post nothing');
}));

test('a cursor between functions shows the file', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { files } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 30);
  assert.equal(textOf(details), 'a.ts a.ts · modified');
  assert.equal(env.seen.revealed.at(-1).row.relPath, 'a.ts');
  assert.equal(env.seen.revealed.at(-1).row.type, 'reviewFile');
  assert.equal(files[0].relPath, 'a.ts');
  env.moveCursor(fileUri(env, 'notes.md'), 3);
  assert.equal(textOf(details), 'notes.md notes.md · added');
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
  assert.match(textOf(details), BAD, 'an event that does not say how the cursor moved still counts');
}));

test('the strip shows the counts of a pull request preview, with nothing selected', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const details = env.openDetails();
  assert.equal(textOf(details), NOT_FOLLOWED);
  assert.equal(stripTextOf(details), '0 of 1 looked at 1 needs attention 0 of 1 looked at', 'no source line and no percentage');
}));

test('the strip of a local review shows the same counts', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  assert.equal(stripTextOf(env.openDetails()), '0 of 1 looked at 1 needs attention 0 of 1 looked at');
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
  assert.match(textOf(details), BAD);
  assert.match(textOf(details), /Preview: callers outside this PR and tests are not searched\. Check out and analyse$/);
}));

test('selecting a file\'s spacer changes nothing in Details', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { files, a } = await rowsOf(env);
  const spacer = (await env.tree().getChildren(files[0])).at(-1);
  assert.equal(spacer.type, 'spacer');
  env.select([a[1]]);
  const shown = details.displayHtml;
  env.select([spacer]);
  assert.equal(details.displayHtml, shown, 'the previous row stays shown');
  assert.equal(textOf(details), REACH);
  assert.deepEqual(env.seen.revealed, []);
}));

test('a tree selection shows that row; a caller or tests row shows its change', () => withEnv(async (env) => {
  useResult(env);
  // a tests row exists once the tests were searched
  const base = env.hooks.localResult;
  env.hooks.localResult = (o) => ({ ...base(o), testReachComputed: true });
  await env.refresh();
  const details = env.openDetails();
  const { files, a } = await rowsOf(env);
  env.select([a[1]]);
  assert.equal(textOf(details), REACH, 'a fine change shows no verdict');
  const [under, tests] = await env.tree().getChildren(a[0]);
  assert.equal(under.type, 'caller');
  env.select([under]);
  assert.match(textOf(details), BAD);
  env.select([a[1]]);
  env.select([tests]);
  assert.match(textOf(details), BAD);
  env.select([files[2]]);
  assert.equal(textOf(details), 'notes.md notes.md · added');
  env.select([]);
  assert.equal(textOf(details), 'notes.md notes.md · added', 'a cleared selection keeps what is shown');
  assert.deepEqual(env.seen.revealed, [], 'a tree selection reveals nothing');
}));

test('the selection a cursor reveal causes does not repaint; another selection takes over', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  const loads = details.loads;
  // VS Code selects the revealed row, and says so
  env.select([env.seen.revealed[0].row]);
  assert.equal(details.loads, loads);
  assert.match(textOf(details), BAD);
  env.select([a[1]]);
  assert.equal(textOf(details), REACH);
  env.select([a[0]]);
  assert.match(textOf(details), BAD, 'once another row was picked, the old reveal is not remembered');
}));

test('a malformed, unknown or removed message is ignored', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  env.select([a[0]]);
  const before = env.seen.executed.length;
  const id = treeItemId(a[0]);
  const loads = details.loads;
  for (const message of [null, undefined, 'tick', 7, [], {}, { type: 'tick', id, on: true }, { type: 'next' }, { type: 'showCallers', id },
    { type: 'computeTestReach' }, { type: 'openCaller', index: 0 }, { type: 'revealThread', id: 'T1' }, { type: 'comment', id },
    { type: 'feedback', id }, { type: 'commentCaller', index: 0 }, { type: 'run', command: 'workbench.action.quit' }]) {
    await sendAction(details, message);
  }
  assert.equal(env.isTicked(a[0]), false);
  assert.equal(env.seen.executed.length, before, 'no command ran');
  assert.equal(details.loads, loads, 'nothing repainted');
  assert.equal(env.seen.modals, 0, 'nothing asked');
}));

test('the ready message re-posts the progress strip', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const posted = details.posted.length;
  await sendAction(details, { type: 'ready' });
  assert.equal(details.posted.length, posted + 1);
  assert.equal(details.posted.at(-1).type, 'progress');
  assert.equal(details.posted.at(-1).token, pageAction(details, {}).token);
  await details.send({ type: 'ready', token: 'obsolete' });
  assert.equal(details.posted.length, posted + 1, 'an older page gets nothing');
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
  assert.match(textOf(details), BAD, 'the same row of the new result');
}));

test('showChange shows the change in the panel and reveals it in the tree; a bad id does nothing', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const { a } = await rowsOf(env);
  await env.run('impactTree.showChange', treeItemId(a[1]));
  assert.equal(textOf(details), REACH);
  assert.deepEqual(env.seen.revealed.map((r) => [r.row, r.options]), [[a[1], { select: true, focus: false }]]);
  // the selection that reveal causes is the row already shown
  const loads = details.loads;
  env.select([a[1]]);
  assert.equal(details.loads, loads, 'not painted twice');

  for (const id of [undefined, null, 5, '', 'finding:a.ts:nothing:1']) await env.run('impactTree.showChange', id);
  assert.equal(env.seen.revealed.length, 1);
  assert.equal(textOf(details), REACH);
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
  assert.equal(textOf(details), REACH, 'Details follows without the tree');
  assert.equal(env.seen.revealed.length, 0, 'the hidden change view is not revealed');

  env.setTreeVisible(true);
  assert.equal(env.seen.revealed.length, 1, 'the tree selects the row Details shows once it is visible');
  assert.equal(treeItemId(env.seen.revealed[0].row), treeItemId(a[1]));
  const loads = details.loads;
  env.select([a[1]]);
  assert.equal(details.loads, loads, 'the reveal\'s own selection does not repaint');

  env.setTreeVisible(false);
  env.setTreeVisible(true);
  assert.equal(env.seen.revealed.length, 1, 'a tree that already selects the shown row is left alone');
}));

// P3: a Preview cannot see callers outside the PR or tests, so every change's page says so
// and offers the way out. The button asks for nothing but the PR the session shows.
test('every change in a preview says what a preview cannot see, with Check out and analyse', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const details = env.openDetails();
  const changes = await env.changeRows();
  assert.equal(changes.length, 3);
  for (const row of changes) {
    env.select([row]);
    assert.match(textOf(details), /Preview: callers outside this PR and tests are not searched\. Check out and analyse/, row.label);
    assert.match(details.webview.html, /data-act="checkout">Check out and analyse<\/button>/);
  }
}));

test('a local review never shows the preview limits', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const changes = await env.changeRows();
  assert.equal(changes.length, 3);
  for (const row of changes) {
    env.select([row]);
    assert.doesNotMatch(details.webview.html, /Preview: callers outside|data-act="checkout"/, row.label);
  }
}));

test('the Check out and analyse message checks out the shown pull request; a stale, malformed or foreign one does not', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const details = env.openDetails();
  const [change] = await env.changeRows();
  env.select([change]);
  const token = /<script nonce="([^"]+)"/.exec(details.webview.html)[1];
  for (const bad of [{ type: 'checkoutAndAnalyse' }, { type: 'checkoutAndAnalyse', token: 'obsolete' }, { type: 'checkoutAndAnalyse', token: null },
    { type: 'checkoutAnalyse', token }, { type: 'checkout', token }]) await details.send(bad);
  assert.equal(env.seen.modals, 0, 'nothing asked to check out');
  await details.send({ type: 'checkoutAndAnalyse', token, pr: pull(99) });
  assert.equal(env.seen.modals, 1, 'the checkout was confirmed with the user');
  assert.deepEqual(env.git.fetches, [7], 'it is the pull request shown, whatever the message names');
  assert.deepEqual(env.seen.errors, []);
}));

test('the Check out and analyse message does nothing without a shown row', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const details = env.openDetails();
  assert.equal(textOf(details), NOT_FOLLOWED);
  await sendAction(details, { type: 'checkoutAndAnalyse' });
  assert.equal(env.seen.modals, 0);
}));

test('the Check out and analyse message does nothing once the shown result is not a preview', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const details = env.openDetails();
  const [change] = await env.changeRows();
  env.select([change]);
  const token = /<script nonce="([^"]+)"/.exec(details.webview.html)[1];
  useResult(env);
  await env.refresh();
  await details.send({ type: 'checkoutAndAnalyse', token });
  assert.equal(env.seen.modals, 0, 'no checkout was started');
}));

test('selecting a folder of the tree layout changes nothing in Details', () => withEnv(async (env) => {
  // a.ts and b.ts moved under src/, so the tree layout has a folder to select
  const a = path.join(env.dir, 'src', 'a.ts'), b = path.join(env.dir, 'src', 'b.ts');
  const bad = { ...finding('bad', a, 10), relPath: 'src/a.ts', startLine: 10, endLine: 12, staleCallers: 1, callers: [caller(b)], throwsAdded: [] };
  const quiet = { ...finding('quiet', b, 5), relPath: 'src/b.ts', startLine: 5, endLine: 6, kinds: [{ id: 'body', label: 'body' }], throwsAdded: [] };
  env.hooks.localResult = (o) => ({ ...localResult(o), allChanged: [bad, quiet], findings: [bad], fileStatus: { 'src/a.ts': 'modified', 'src/b.ts': 'modified' } });
  await env.refresh();
  const details = env.openDetails();
  const [src] = await env.tree().getChildren();
  assert.equal(src.type, 'folder');
  const [fileA] = await env.tree().getChildren(src);
  const [badRow] = (await env.tree().getChildren(fileA)).filter((r) => r.type !== 'spacer');
  env.select([badRow]);
  const shown = details.displayHtml;
  assert.match(textOf(details), /^bad src\/a\.ts:10–12 Callers not updated\. /);
  env.select([src]);
  assert.equal(details.displayHtml, shown, 'the previous row stays shown');
  assert.deepEqual(env.seen.revealed, []);
}, { settings: { fileListLayout: 'tree' } }));

test('with nothing to flag the strip counts the changes, and selecting the "Browse all" row changes nothing in Details', () => withEnv(async (env) => {
  const a = path.join(env.dir, 'a.ts'), b = path.join(env.dir, 'b.ts');
  const body = [{ id: 'body', label: 'body' }];
  const one = { ...finding('one', a, 10), startLine: 10, endLine: 12, kinds: body, throwsAdded: [] };
  const two = { ...finding('two', b, 5), startLine: 5, endLine: 6, kinds: body, throwsAdded: [] };
  env.hooks.localResult = (o) => ({ ...localResult(o), allChanged: [one, two], findings: [], fileStatus: { 'a.ts': 'modified', 'b.ts': 'modified' } });
  await env.refresh();
  const details = env.openDetails();
  assert.equal(stripTextOf(details), '2 changes nothing needs attention 2 changes');
  const posted = details.posted.length;
  const [, browse] = await env.tree().getChildren();
  assert.equal(browse.type, 'browse');
  const [fileA] = await env.tree().getChildren(browse);
  const [oneRow] = (await env.tree().getChildren(fileA)).filter((r) => r.type !== 'spacer');
  env.select([oneRow]);
  const shown = details.displayHtml;
  env.select([browse]);
  assert.equal(details.displayHtml, shown, 'the previous row stays shown');
  env.tick(oneRow, true);
  assert.equal(details.posted.length, posted, 'a quiet row reviewed leaves the strip as it was');
}));
