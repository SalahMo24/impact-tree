'use strict';
// The review commands through the real activate(): the filter toggles, "next unreviewed",
// the status bar item and the context keys the title icons and the keybinding read. The
// provider's own filtering is tested in review-tree-view.test.js; here the extension wires it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { localResult, finding, withEnv } = require('./extension-env');
const { nextKeyHint, statusBarText } = require('../src/review-navigation');

const SITE = { start: 22, end: 25 };
const caller = (file) => ({ file, pos: 7, label: 'user', test: false, callSites: [SITE], sites: 1,
  callSiteUpdates: { updated: [], untouched: [SITE], unknown: [] } });
const ALL = ['a.ts', '  bad', '  reach', 'b.ts', '  quiet', 'notes.md'];
const NEXT_KEY =process.platform === 'darwin' ? '⌥N' : 'Alt+N';

// a.ts: `bad` (a signature change with a caller not updated) and `reach` (body only, reached by a caller);
// b.ts: `quiet`; notes.md has no call graph. Display order: bad, reach, quiet, notes.md.
function useResult(env) {
  const a = path.join(env.dir, 'a.ts'), b = path.join(env.dir, 'b.ts');
  const bad = { ...finding('bad', a, 10), startLine: 10, endLine: 12, staleCallers: 1, callers: [caller(b)] };
  const reach = { ...finding('reach', a, 50), startLine: 50, endLine: 52, kinds: [{ id: 'body', label: 'body' }], callers: [caller(b)] };
  const quiet = { ...finding('quiet', b, 5), startLine: 5, endLine: 6, kinds: [{ id: 'body', label: 'body' }] };
  const findings = [bad, reach, quiet].map(c => ({ ...c, throwsAdded: [] }));
  env.hooks.localResult = (o) => ({ ...localResult(o, { findings }), otherFiles: [{ path: 'notes.md', status: 'added' }] });
}
// The labels of every file row and every row under it, as the view shows them.
async function shown(env) {
  const out = [];
  for (const top of await env.tree().getChildren()) {
    out.push(top.label, ...(top.type === 'reviewFile' ? (await env.tree().getChildren(top)).filter((r) => r.type !== 'spacer').map((r) => `  ${r.label}`) : []));
  }
  return out;
}
const rowsOf = async (env) => {
  const files = await env.tree().getChildren();
  return { files, rows: await env.tree().getChildren(files[0]), b: await env.tree().getChildren(files[1]) };
};

test('the hint names the key for the platform', () => {
  assert.equal(nextKeyHint('darwin'), '⌥N');
  assert.equal(nextKeyHint('linux'), 'Alt+N');
  assert.equal(nextKeyHint('win32'), 'Alt+N');
  assert.equal(statusBarText({ left: 3, attention: 1 }, 'darwin'), '$(checklist) 3 left · ⛔ 1 · ⌥N next');
});

test('the status bar is hidden with no review, and shows what is left, the attention count and the key', () => withEnv(async (env) => {
  useResult(env);
  const bar = env.seen.statusBar;
  assert.equal(bar.visible, false);
  assert.equal(bar.command, 'impactTree.nextUnreviewed', 'clicking it runs next unreviewed');
  assert.equal(env.seen.contexts['impactTree.hasReview'], false);
  assert.equal(env.seen.contexts['impactTree.filter'], 'all');
  await env.refresh();
  assert.equal(bar.visible, true);
  assert.equal(bar.text, `$(checklist) 4 left · ⛔ 1 · ${NEXT_KEY} next`);
  assert.equal(env.seen.contexts['impactTree.hasReview'], true);
  const { rows } = await rowsOf(env);
  env.tick(rows[0], true);
  assert.equal(bar.text, `$(checklist) 3 left · ⛔ 0 · ${NEXT_KEY} next`, 'it follows a tick');
}));

test('the status bar hides again when the review goes away', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  assert.equal(env.seen.statusBar.visible, true);
  const gate = env.holds.analyze.next();
  const running = env.refresh();
  await gate.reached;
  assert.equal(env.seen.statusBar.visible, false, 'while analysing, the view shows a placeholder, not a review');
  assert.equal(env.seen.contexts['impactTree.hasReview'], false);
  gate.release();
  await running;
  assert.equal(env.seen.statusBar.visible, true);
}));

test('the filter commands narrow the tree, name the filter and set the context key; one turns the other off', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  assert.deepEqual(await shown(env), ALL);
  assert.equal(env.view().message, 'pr mode · ⛔ 1 · 4 of 4 left');

  env.run('impactTree.filterAttention');
  assert.equal(env.seen.contexts['impactTree.filter'], 'attention');
  assert.deepEqual(await shown(env), ['a.ts', '  bad'], 'only the rows that need attention, and only their files');
  assert.equal(env.view().message, 'pr mode · ⛔ 1 · 4 of 4 left · filter: needs attention');

  env.run('impactTree.filterUnreviewed');
  assert.equal(env.seen.contexts['impactTree.filter'], 'unreviewed', 'one turns the other off');
  assert.deepEqual(await shown(env), ALL);
  assert.match(env.view().message, / · filter: unreviewed$/);
  const { rows } = await rowsOf(env);
  env.tick(rows[0], true);
  assert.deepEqual(await shown(env), ['a.ts', '  reach', 'b.ts', '  quiet', 'notes.md'], 'a ticked row leaves the unreviewed filter on the repaint');

  env.run('impactTree.filterUnreviewedOn');
  assert.equal(env.seen.contexts['impactTree.filter'], 'all', 'the title icon of the active filter turns it off');
  assert.deepEqual(await shown(env), ALL);
  assert.doesNotMatch(env.view().message, /filter/);
  env.run('impactTree.filterAttentionOn');
  assert.equal(env.seen.contexts['impactTree.filter'], 'attention', 'the same toggle from the other state');
}));

test('a filter that leaves nothing shows one row saying why', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  env.run('impactTree.filterAttention');
  const { rows } = await rowsOf(env);
  env.tick(rows[0], true);
  assert.deepEqual((await env.tree().getChildren()).map((r) => r.label), ['Nothing needs attention']);
}));

test('next unreviewed reveals and selects the first row, then the one after the selection', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const { files, rows, b } = await rowsOf(env);
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed.length, 1);
  assert.equal(env.seen.revealed[0].row, rows[0], 'with no selection it starts at the top');
  assert.deepEqual(env.seen.revealed[0].options, { select: true, focus: true, expand: true });
  env.view().selection = [rows[0]];
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed[1].row, rows[1]);
  env.view().selection = [rows[1]];
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed[2].row, b[0], 'across to the next file');
  env.view().selection = [b[0]];
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed[3].row, files[2], 'a file without a call graph is the row to review');
}));

test('next unreviewed from a file\'s spacer goes on after that file, never onto a spacer', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const { files, rows, b } = await rowsOf(env);
  const spacer = rows.at(-1);
  assert.equal(spacer.type, 'spacer');
  env.view().selection = [spacer];
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed[0].row, b[0], 'the first row of the next file, not the top of this one');
  env.view().selection = [b.at(-1)];
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed[1].row, files[2]);
}));

test('a selected caller or tests row counts as the change it sits under', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const { rows } = await rowsOf(env);
  const [under, tests] = await env.tree().getChildren(rows[0]);
  assert.equal(under.type, 'caller');
  env.view().selection = [under];
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed.at(-1).row, rows[1], 'after `bad`, not from the top');
  env.view().selection = [tests];
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed.at(-1).row, rows[1]);
}));

test('next unreviewed from an editor focuses the tree so Space reviews the selected row', () => withEnv(async env => {
  useResult(env);
  await env.refresh();
  const { rows } = await rowsOf(env);
  env.moveCursor(env.vscode.Uri.file(path.join(env.dir, 'a.ts')), 11);
  assert.equal(env.seen.focus, 'editor');
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.focus, 'tree');
  assert.equal(env.seen.focusedRow, rows[0]);
  env.pressSpace();
  assert.equal(env.isTicked(rows[0]), true);
  assert.equal(env.isTicked(rows[1]), false, 'the following row stays unreviewed');
  assert.equal(env.seen.editorSpaces, 0, 'Space is not delivered to the editor');
  assert.equal(env.seen.statusBar.text.split(' ')[1], '3', 'the review count follows the keyboard tick');
}));

test('next unreviewed follows the active filter and wraps', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const { rows } = await rowsOf(env);
  env.run('impactTree.filterAttention');
  env.view().selection = [rows[1]];   // `reach` is hidden by the filter
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.revealed.at(-1).row, rows[0], 'nothing shown after it, so it wraps to `bad`');
}));

test('with nothing left it reports it and reveals nothing', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const { files, rows, b } = await rowsOf(env);
  for (const row of [...rows, ...b, files[2]]) env.tick(row, true);
  await env.run('impactTree.nextUnreviewed');
  assert.deepEqual(env.seen.infos, ['Impact Tree: all reviewed']);
  assert.deepEqual(env.seen.revealed, []);
  assert.equal(env.seen.statusBar.text, `$(checklist) 0 left · ⛔ 0 · ${NEXT_KEY} next`);
  env.tick(rows[0], false);
  env.run('impactTree.filterAttention');
  env.tick(rows[0], true);
  await env.run('impactTree.nextUnreviewed');
  assert.equal(env.seen.infos.at(-1), 'Impact Tree: nothing left needs attention', 'under a filter, "all reviewed" would not be true');
}));

test('next unreviewed with no review shown does nothing', () => withEnv(async (env) => {
  await env.run('impactTree.nextUnreviewed');
  assert.deepEqual(env.seen.infos, []);
  assert.deepEqual(env.seen.revealed, []);
}));

test('package.json contributes the commands, the keybinding and the palette gates', () => withEnv(async (env) => {
  const { contributes } = require('../package.json');
  const mine = ['filterAttention', 'filterAttentionOn', 'filterUnreviewed', 'filterUnreviewedOn', 'filterThreads', 'filterThreadsOn', 'nextUnreviewed']
    .map((c) => `impactTree.${c}`);
  for (const id of mine) {
    assert.ok(contributes.commands.some((c) => c.command === id && c.icon), `${id} is contributed with an icon`);
    assert.doesNotThrow(() => env.run(id), `${id} is registered`);
  }
  // the review lens adds its own, ⇧⌥C for the callers peek (test/review-lens.test.js)
  assert.deepEqual(contributes.keybindings.filter((k) => k.command !== 'impactTree.showCallers'),
    [{ command: 'impactTree.nextUnreviewed', key: 'alt+n', when: 'impactTree.hasReview' }]);
  assert.equal(contributes.commands.find((c) => c.command === 'impactTree.nextUnreviewed').title, 'Impact Tree: Go to next unreviewed change');
  assert.equal(env.seen.statusBar.tooltip, 'Go to the next unreviewed change (rebind it in Keyboard Shortcuts)');
  // the title bar keeps refresh, the three filters and next; the rest is in the overflow menu
  const changes = contributes.menus['view/title'].filter((m) => m.when.startsWith('view == impactTree.changes'));
  const groupOf = (id) => changes.filter((m) => m.command === id).map((m) => m.group);
  assert.deepEqual(changes.filter((m) => m.group.startsWith('navigation')).map((m) => m.command),
    ['impactTree.refresh', 'impactTree.filterAttention', 'impactTree.filterAttentionOn', 'impactTree.filterUnreviewed', 'impactTree.filterUnreviewedOn',
      'impactTree.filterThreads', 'impactTree.filterThreadsOn', 'impactTree.nextUnreviewed']);
  assert.deepEqual(['selectMode', 'setCheckpoint', 'showLegend', 'showLog', 'clearReviewed'].map((c) => groupOf(`impactTree.${c}`)[0]),
    ['1_mode@1', '1_mode@2', '2_help@1', '2_help@2', '3_progress@1']);
  const palette = Object.fromEntries(contributes.menus.commandPalette.map((m) => [m.command, m.when]));
  for (const id of ['impactTree.filterAttention', 'impactTree.filterUnreviewed', 'impactTree.nextUnreviewed']) assert.equal(palette[id], 'impactTree.hasReview', id);
  for (const id of ['impactTree.filterAttentionOn', 'impactTree.filterUnreviewedOn', 'impactTree.filterThreadsOn']) assert.equal(palette[id], 'false', id);
  // the threads filter is offered only once a pull request's threads are loaded
  assert.equal(palette['impactTree.filterThreads'], 'impactTree.hasReviewThreads');
  assert.match(title0(contributes, 'impactTree.filterThreads').when, /&& impactTree\.hasReviewThreads$/);
  assert.doesNotMatch(title0(contributes, 'impactTree.filterThreadsOn').when, /hasReviewThreads/, 'a filter that is on can always be turned off');
  // in the view title, exactly one command of each pair matches each value of the key
  const title = contributes.menus['view/title'].filter((m) => /impactTree\.filter/.test(m.command));
  const matches = (when, filter) => {
    const [, op, value] = /impactTree\.filter (==|!=) (\w+)/.exec(when);
    return op === '==' ? filter === value : filter !== value;
  };
  for (const filter of ['all', 'attention', 'unreviewed', 'threads']) {
    const names = title.filter((m) => matches(m.when, filter)).map((m) => m.command);
    assert.equal(names.length, 3, `${filter}: ${names}`);
    for (const pair of [/Attention/, /Unreviewed/, /Threads/]) assert.equal(names.filter((n) => pair.test(n)).length, 1, `${filter} ${pair}`);
  }
}));

/** The first view/title entry of a command. */
const title0 = (contributes, id) => contributes.menus['view/title'].find((m) => m.command === id);
