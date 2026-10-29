'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withEnv, finding, localResult } = require('./extension-env');
const { treeItemId } = require('../src/views/changes/review-tree-model');
const { createPage } = require('./webview-page');

async function prepare(env) {
  const a = path.join(env.dir, 'a.ts'), b = path.join(env.dir, 'b.ts');
  fs.writeFileSync(a, 'export function first() { return 1; }\nexport function second() { return 2; }\n');
  fs.writeFileSync(b, 'export function user() { first(); }\n');
  fs.writeFileSync(path.join(env.dir, 'notes.md'), 'review notes');
  const caller = { file: b, pos: 16, label: 'user', test: false, sites: 1, callSites: [{ start: 25, end: 30 }],
    callSiteUpdates: { updated: [], untouched: [{ start: 25, end: 30 }], unknown: [] } };
  const changes = [
    { ...finding('first', a, 16), startLine: 1, endLine: 1, callers: [caller], stale: [caller], staleCallers: 1, throwsAdded: [] },
    { ...finding('second', a, 53), startLine: 2, endLine: 2, kinds: [{ id: 'body' }], throwsAdded: [] },
    { ...finding('user', b, 16), startLine: 1, endLine: 1, kinds: [{ id: 'body' }], throwsAdded: [] },
  ];
  env.hooks.localResult = o => ({ ...localResult(o, { findings: changes }),
    fileStatus: { 'a.ts': 'modified', 'b.ts': 'modified', 'notes.md': 'added' }, otherFiles: [{ path: 'notes.md', status: 'added' }] });
  await env.refresh();
  const tree = env.tree();
  const files = await tree.getChildren();
  const aFile = files.find(f => f.relPath === 'a.ts'), bFile = files.find(f => f.relPath === 'b.ts');
  const [first, second] = await tree.getChildren(aFile);
  const [user] = await tree.getChildren(bFile);
  return { tree, first, second, user, aFile, bFile, notes: files.find(f => f.relPath === 'notes.md') };
}
// The strip's text as the page shows it.
const stripOf = (details) => {
  const text = (name) => new RegExp(`data-progress-${name}[^>]*>([^<]*)<`).exec(details.displayHtml)[1];
  return { count: text('count'), attention: text('attention') };
};

// The tree and the lens batch their change events with `setTimeout(…, 0)` (the next turn of
// the event loop, not a wait), so a test lets that turn pass before it counts the events.
// A timer set after the batching timer, with the same delay, runs after it.
const settleBatches = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test('all marking routes patch Details, refresh one file, and leave unchanged decorations alone', () => withEnv(async env => {
  const { tree, first, aFile, user } = await prepare(env);
  const details = env.openDetails();
  env.select([first]);
  // Drain the initial registrations before measuring a mark: read the rows the loop below
  // reads again (that is what first registers their caller decorations), then let the batch
  // timers those reads set run.
  await tree.getChildren(await tree.getChildren(aFile).then(rows => rows[0]));
  env.decorations().flush();
  await settleBatches();
  const treeEvents = [], progress = [], decorations = [];
  let fullPresentations = 0, lenses = 0;
  tree.onDidChangeTreeData(row => treeEvents.push(row));
  tree.onDidChangeReview(event => progress.push(event));
  tree.onDidChangePresentation(() => fullPresentations++);
  env.decorations().onDidChangeFileDecorations(uris => decorations.push(uris));
  env.lensProvider().provider.onDidChangeCodeLenses(() => lenses++);
  const loads = details.loads, beforeCommands = env.seen.executed.length;
  for (const [on, mark] of [
    [true, () => env.tick(first, true)],
    [false, () => env.tick(first, false)],
    [true, () => env.run('impactTree.setReviewed', treeItemId(first), true, tree.reviewVersion())],
  ]) {
    await mark();
    // Recreate expanded subtree reads performed by the editor after a file refresh.
    const current = await tree.getChildren(aFile);
    await tree.getChildren(current[0]);
    await settleBatches();
    assert.equal(env.isTicked(first), on);
    assert.equal(stripOf(details).count, on ? '1 of 4 reviewed' : '0 of 4 reviewed');
  }
  assert.deepEqual(treeEvents, [aFile, aFile, aFile]);
  assert.equal(progress.length, 3);
  assert.ok(progress.every(e => e.changedIds.includes(treeItemId(first)) && e.changedIds.includes(treeItemId(aFile))));
  assert.equal(details.loads, loads);
  assert.equal(fullPresentations, 0);
  assert.equal(lenses, 3);
  assert.deepEqual(decorations, []);
  const posted = details.posted.length;
  env.tick(user, true);
  await settleBatches();
  assert.deepEqual(details.posted.slice(posted).map(m => m.type), ['progress'], 'an unrelated tick patches only the strip');
  assert.equal(details.loads, loads);
  assert.equal(env.seen.executed.slice(beforeCommands).filter(([name]) => name === 'vscode.diff' || name === 'vscode.open').length, 0);
}));

test('one file gesture updates the progress strip, and repeated marks publish nothing', () => withEnv(async env => {
  const { tree, first, second, aFile, notes } = await prepare(env);
  const details = env.openDetails();
  env.select([aFile]);
  const loads = details.loads, events = [], progress = [];
  tree.onDidChangeTreeData(row => events.push(row));
  tree.onDidChangeReview(e => progress.push(e));
  let lenses = 0;
  env.lensProvider().provider.onDidChangeCodeLenses(() => lenses++);
  tree.setCheckedBatch([{ row: aFile, on: true }, { row: notes, on: true }]);
  assert.ok(env.isTicked(first) && env.isTicked(second));
  assert.equal(stripOf(details).count, '3 of 4 reviewed');
  assert.equal(details.loads, loads);
  assert.deepEqual(events, [aFile, notes]);
  assert.equal(progress.length, 1, 'one notification for the gesture');
  await settleBatches();
  assert.equal(lenses, 1);
  env.tick(first, true);
  await settleBatches();
  assert.equal(progress.length, 1, 'same state is a no-op');
  tree.setCheckedBatch([{ row: first, on: false }, { row: first, on: true }]);
  await settleBatches();
  assert.equal(progress.length, 1, 'the net result of a batch is a no-op');
  env.tick(notes, false);
  await settleBatches();
  assert.equal(lenses, 1, 'a plain file has no review lenses');
  tree.clearReviewed();
  assert.equal(env.seen.statusBar.text.split(' ')[1], '4');
  assert.equal(env.isTicked(first), false);
  assert.equal(stripOf(details).count, '0 of 4 reviewed');
  assert.equal(details.loads, loads);
}));

test('filtered progress refreshes the parent until root membership changes; Details stays mounted', () => withEnv(async env => {
  const { tree, first, second, aFile } = await prepare(env);
  const details = env.openDetails();
  env.select([first]);
  const loads = details.loads;
  const events = [];
  tree.toggleFilter('unreviewed');
  tree.onDidChangeTreeData(row => events.push(row));
  env.tick(first, true);
  assert.deepEqual(events, [aFile]);
  assert.deepEqual((await tree.getChildren(aFile)).map(r => r.label), ['second', ''], 'the visible row, then the spacer');
  env.tick(second, true);
  assert.deepEqual(events, [aFile, undefined]);
  assert.ok(!(await tree.getChildren()).some(r => r === aFile));
  env.tick(first, false);
  assert.equal(events.at(-1), undefined, 'the file is restored at the root');
  assert.ok((await tree.getChildren()).includes(aFile));
  tree.toggleFilter('attention');
  events.length = 0;
  env.tick(first, true);
  assert.deepEqual(events, [undefined]);
  assert.ok((await tree.getChildren()).some(r => r.label === 'Nothing needs attention'));
  assert.equal(details.loads, loads, 'neither a filter nor hidden progress reloads the selected row');
}));

test('row identities survive repaint, while old analysis checkboxes cannot change a new review', () => withEnv(async env => {
  const { tree, first, aFile } = await prepare(env);
  const firstChildren = await tree.getChildren(first);
  const ids = firstChildren.map(r => tree.getTreeItem(r).id);
  assert.deepEqual((await tree.getChildren(first)).map(r => tree.getTreeItem(r).id), ids);
  assert.ok((await tree.getChildren()).includes(aFile), 'the first file is canonical');
  assert.equal(tree.getParent(first), aFile);
  await env.refresh();
  const events = [];
  tree.onDidChangeReview(e => events.push(e));
  env.tick(first, true);
  assert.deepEqual(events, []);
  const [newFirst] = await tree.getChildren((await tree.getChildren()).find(f => f.relPath === 'a.ts'));
  assert.equal(env.isTicked(newFirst), false);
  env.tick(newFirst, true);
  assert.equal(env.isTicked(newFirst), true);
}));

test('rapid marks batch lens invalidation and disposal cancels queued lens and decoration work', () => withEnv(async env => {
  const { tree, first, second, aFile } = await prepare(env);
  env.decorations().flush();
  let lenses = 0, decorations = 0;
  env.lensProvider().provider.onDidChangeCodeLenses(() => lenses++);
  env.decorations().onDidChangeFileDecorations(() => decorations++);
  env.tick(first, true);
  env.tick(second, true);
  await settleBatches();
  assert.equal(lenses, 1);
  env.tick(first, false);
  env.decorations().register(env.vscode.Uri.file('/new.ts'), { status: 'added' });
  await tree.getChildren(aFile);
  await tree.getChildren();
  env.dispose();
  await settleBatches();
  assert.equal(lenses, 1);
  assert.equal(decorations, 0);
  // withEnv disposes once more; disposal must remain harmless.
}));

test('decoration changes are scoped, deduplicated, and flushed once across repeated row reads', () => withEnv(async env => {
  const { tree, first } = await prepare(env);
  const decorate = env.decorations();
  await settleBatches(); // Drain the initial tree decorations under the controlled clock.
  const events = [];
  decorate.onDidChangeFileDecorations(uris => events.push(uris));
  const uri = env.vscode.Uri.file(path.join(env.dir, 'extra.ts'));
  decorate.register(uri, { status: 'modified', tooltip: 'changed file' });
  decorate.register(uri, { status: 'modified', tooltip: 'changed file' });
  let flushes = 0;
  const originalFlush = decorate.flush;
  decorate.flush = () => { flushes++; originalFlush(); };
  await tree.getChildren();
  await tree.getChildren();
  await settleBatches();
  assert.equal(flushes, 1);
  assert.deepEqual(events, [[uri]], 'only the changed URI, once');
  decorate.register(uri, { status: 'modified', tooltip: 'changed file' });
  await tree.getChildren();
  await settleBatches();
  assert.equal(events.length, 1, 'unchanged values produce no decoration event');
  decorate.register(uri, { status: 'added', tooltip: 'temporary value' });
  decorate.register(uri, { status: 'modified', tooltip: 'changed file' });
  await tree.getChildren();
  await settleBatches();
  assert.equal(events.length, 1, 'restoring the published value within a batch is also a no-op');
  // Expanding a finding genuinely materializes caller decorations for the first time.
  await tree.getChildren(first);
  await tree.getChildren(first);
  await settleBatches();
  assert.equal(events.length, 2);
  assert.ok(Array.isArray(events[1]) && events[1].length > 0);
  assert.equal(new Set(events[1].map(u => u.toString())).size, events[1].length);
}));


test('any tick updates the progress strip by a patch, also a tick of a row other than the one shown', () => withEnv(async env => {
  const { first, second, user } = await prepare(env);
  const details = env.openDetails();
  env.select([first]);
  const loads = details.loads, page = details.webview.html;
  assert.deepEqual(stripOf(details), { count: '0 of 4 reviewed', attention: '1 needs attention' });
  env.tick(user, true);
  assert.equal(stripOf(details).count, '1 of 4 reviewed');
  assert.deepEqual(details.posted.map(m => m.type), ['progress']);

  env.tick(first, true);
  assert.deepEqual(stripOf(details), { count: '2 of 4 reviewed', attention: 'nothing needs attention' });
  assert.deepEqual(details.posted.map(m => m.type), ['progress', 'progress'], 'only strip patches: the page has no per-row fields');

  details.posted.length = 0;
  env.tick(second, false); // already unreviewed: nothing changes
  env.tick(first, true);
  assert.deepEqual(details.posted, [], 'a tick that changes nothing posts nothing');
  assert.equal(details.loads, loads, 'no full render');
  assert.equal(details.webview.html, page, 'the stored document is untouched');
}));

test('the strip is on the page with nothing selected and the meter follows ticks', () => withEnv(async env => {
  const { first, second } = await prepare(env);
  const details = env.openDetails();
  assert.match(details.displayHtml, /Select a change in the tree/);
  assert.equal(stripOf(details).count, '0 of 4 reviewed');
  env.tick(first, true);
  env.tick(second, true);
  assert.equal(stripOf(details).count, '2 of 4 reviewed');
  assert.match(details.webview.html, /<progress max="4" value="0" data-progress-meter>/, 'the stored document is the render, not the patches');
  const page = createPage(details.webview.html);
  await details.send(page.sent[0]);
  for (const message of details.posted) page.receive(message);
  assert.equal(page.nodes.get('[data-progress-meter]').getAttribute('value'), '2');
  assert.equal(page.nodes.get('[data-progress-meter]').getAttribute('max'), '4');
}));

test('the progress patch is token checked, and the ready handshake restores a missed strip update', () => withEnv(async env => {
  const { first, user } = await prepare(env);
  const details = env.openDetails();
  env.select([first]);
  const page = createPage(details.webview.html);
  const count = page.nodes.get('[data-progress-count]');
  env.tick(user, true); // never reaches `page`, as before its script started
  const before = details.posted.length;
  await details.send(page.sent[0]);
  const resent = details.posted.slice(before).find(m => m.type === 'progress');
  assert.ok(resent, 'ready re-sends the current strip');
  page.receive({ ...resent, token: 'obsolete', model: { ...resent.model, countText: 'wrong' } });
  assert.equal(count.textContent, '0 of 4 reviewed');
  page.receive({ ...resent, model: { ...resent.model, reviewed: 9 } });
  assert.equal(count.textContent, '0 of 4 reviewed', 'an impossible model is ignored');
  page.receive(resent);
  assert.equal(count.textContent, '1 of 4 reviewed');
  assert.equal(page.nodes.get('[data-progress-meter]').getAttribute('value'), '1');
}));

test('an analysis without counting rows has no strip', () => withEnv(async env => {
  env.hooks.localResult = o => ({ ...localResult(o, { findings: [] }) });
  await env.refresh();
  const details = env.openDetails();
  assert.doesNotMatch(details.webview.html.replace(/<script[\s\S]*?<\/script>/, ''), /<progress|data-progress/);
  assert.doesNotMatch(details.webview.html, /\sstyle="/);
}));
