'use strict';
// The "Feedback to send" group, the status bar count, the context key, and Details' 💬
// buttons in a local review (F1). The group's rows and the status text are pure and tested
// directly; the rest through the real activate(), with drafts stored in workspace state.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { localResult, finding, previewResult, pull, withEnv } = require('./extension-env');
const { buildFeedbackGroup, feedbackStatusText, FIRST_LINE_MAX } = require('../src/feedback-tree');
const { STORAGE_KEY } = require('../src/feedback-drafts');
const { treeItemId } = require('../src/review-tree-model');

const item = (id, over = {}) => ({ id, file: 'src/a.ts', line: 12, symbol: 'run', caller: null, quote: 'run();', body: `body of ${id}`, createdAtMs: 1000, ...over });

// ---- pure ---------------------------------------------------------------------------------

test('no drafts, no group', () => {
  assert.equal(buildFeedbackGroup([]), null);
});

test('the group counts its drafts and lists them in the order they were made', () => {
  const group = buildFeedbackGroup([item('c', { createdAtMs: 3 }), item('a', { createdAtMs: 1 }), item('b2', { createdAtMs: 2 }), item('b1', { createdAtMs: 2 })]);
  assert.equal(group.label, 'Feedback to send');
  assert.equal(group.desc, '4 drafts');
  assert.deepEqual(group.children.map((r) => r.draftId), ['a', 'b1', 'b2', 'c'], 'by creation time, then id: stable');
  assert.equal(buildFeedbackGroup([item('a')]).desc, '1 draft');
});

test('a draft row names its place and shows the first line of its text', () => {
  const rows = buildFeedbackGroup([
    item('line', { createdAtMs: 1, body: '\n  First line  \nsecond' }),
    item('change', { createdAtMs: 2, line: null }),
    item('file', { createdAtMs: 3, line: null, symbol: null }),
    item('caller', { createdAtMs: 4, caller: { label: 'useIt', file: 'src/b.ts', line: 3 } }),
    item('long', { createdAtMs: 5, body: 'x'.repeat(200) }),
  ]).children;
  assert.deepEqual(rows.map((r) => [r.type, r.label]), [
    ['feedbackDraft', 'src/a.ts:12'],
    ['feedbackDraft', 'src/a.ts · run'],
    ['feedbackDraft', 'src/a.ts'],
    ['feedbackDraft', 'src/a.ts:12 · about caller useIt'],
    ['feedbackDraft', 'src/a.ts:12'],
  ]);
  assert.equal(rows[0].desc, 'First line');
  assert.equal(rows[4].desc.length, FIRST_LINE_MAX);
  assert.ok(rows[4].desc.endsWith('…'));
  assert.match(rows[3].tooltip, /About caller `useIt` at `src\/b\.ts:3`/);
  assert.match(rows[0].tooltip, /```\nrun\(\);\n```/, 'the quote is fenced');
  assert.match(rows[0].tooltip, /> second/, 'the text is quoted');
});

test('the status bar text: hidden with none, singular, plural', () => {
  assert.equal(feedbackStatusText(0), null);
  assert.equal(feedbackStatusText(1), '💬 1 feedback draft');
  assert.equal(feedbackStatusText(3), '💬 3 feedback drafts');
});

// ---- wired --------------------------------------------------------------------------------

const withDrafts = (items) => ({ memento: new Map([[STORAGE_KEY, { version: 1, items }]]) });
const feedbackBar = (env) => env.seen.statusBars.find((b) => b.command === 'impactTree.feedback.showDrafts');

test('the group is at the top of Changes when there are drafts, and absent when there are none', () => withEnv(async (env) => {
  await env.refresh();
  const roots = await env.tree().getChildren();
  assert.ok(roots.every((r) => r.type !== 'feedbackGroup'));
}));

test('the group and its rows: first above everything, open, with Edit/Delete rows that open their line', () => withEnv(async (env) => {
  const before = await env.tree().getChildren();
  assert.equal(before[0].type, 'feedbackGroup', 'shown before any analysis too: a draft is never hidden');
  env.hooks.localResult = (o) => ({ ...localResult(o, { findings: [finding('f', path.join(env.dir, 'a.ts'), 3)] }), changedPaths: ['a.ts'] });
  await env.refresh();
  const roots = await env.tree().getChildren();
  assert.equal(roots[0].type, 'feedbackGroup');
  assert.ok(roots.slice(1).some((r) => r.type === 'reviewFile'), 'the review follows');
  const group = env.tree().getTreeItem(roots[0]);
  assert.deepEqual([group.label, group.description, group.id, group.collapsibleState], ['Feedback to send', '2 drafts', 'feedback:group', env.vscode.TreeItemCollapsibleState.Expanded]);
  const children = await env.tree().getChildren(roots[0]);
  assert.deepEqual(children.map((c) => c.label), ['src/a.ts:12', 'src/a.ts · run']);
  const row = env.tree().getTreeItem(children[0]);
  assert.equal(row.contextValue, 'feedbackDraft');
  assert.equal(row.id, 'feedback:one');
  assert.equal(row.description, 'body of one');
  assert.deepEqual([row.command.command, row.command.arguments[0]], ['impactTree.feedback.open', children[0]]);
  assert.equal(env.tree().getParent(children[0]), roots[0]);
  assert.equal(env.tree().getParent(roots[0]), undefined);
}, withDrafts([item('one', { createdAtMs: 1 }), item('two', { createdAtMs: 2, line: null })])));

test('a drafts change repaints only the group; the root only when the group appears or goes', () => withEnv(async (env) => {
  env.hooks.localResult = (o) => ({ ...localResult(o, { findings: [finding('f', path.join(env.dir, 'a.ts'), 3)] }), changedPaths: ['a.ts'] });
  await env.refresh();
  const [group] = await env.tree().getChildren();
  const fired = [];
  env.tree().onDidChangeTreeData((e) => fired.push(e));
  await env.run('impactTree.feedback.delete', { type: 'feedbackDraft', draftId: 'one' });
  assert.deepEqual(fired, [group], 'one of two deleted: the group repaints, nothing else');
  assert.equal(env.tree().getTreeItem(group).description, '1 draft');
  await env.run('impactTree.feedback.delete', { type: 'feedbackDraft', draftId: 'two' });
  assert.deepEqual(fired, [group, undefined], 'the last one: the root repaints and the group is gone');
  assert.ok((await env.tree().getChildren()).every((r) => r.type !== 'feedbackGroup'));
}, withDrafts([item('one', { createdAtMs: 1 }), item('two', { createdAtMs: 2 })])));

test('the status bar counts the drafts, hides with none, and shows the group; the context key follows', () => withEnv(async (env) => {
  const bar = feedbackBar(env);
  assert.equal(env.seen.statusBars.indexOf(bar), 2, 'after the review progress and pending review items');
  assert.equal(bar.visible, true);
  assert.equal(bar.text, '💬 2 feedback drafts');
  assert.equal(env.seen.contexts['impactTree.hasFeedbackDrafts'], true);
  await env.run('impactTree.feedback.showDrafts');
  const [group] = await env.tree().getChildren();
  assert.deepEqual(env.seen.revealed.at(-1), { row: group, options: { select: false, focus: true, expand: true } });
  await env.run('impactTree.feedback.delete', { type: 'feedbackDraft', draftId: 'one' });
  assert.equal(bar.text, '💬 1 feedback draft');
  await env.run('impactTree.feedback.delete', { type: 'feedbackDraft', draftId: 'two' });
  assert.equal(bar.visible, false);
  assert.equal(env.seen.contexts['impactTree.hasFeedbackDrafts'], false);
  await env.run('impactTree.feedback.showDrafts');
  assert.match(env.seen.infos.at(-1), /there are no feedback drafts/);
  assert.deepEqual(env.memento.get(STORAGE_KEY), { version: 1, items: [] }, 'deletes are written to workspace state');
}, withDrafts([item('one', { createdAtMs: 1 }), item('two', { createdAtMs: 2 })])));

test('no drafts: the status bar item is hidden and the context key is false', () => withEnv(async (env) => {
  assert.equal(feedbackBar(env).visible, false);
  assert.equal(env.seen.contexts['impactTree.hasFeedbackDrafts'], false);
}));

test('an unreadable stored value starts with no drafts and says so once in the log', () => withEnv(async (env) => {
  assert.equal(feedbackBar(env).visible, false);
  assert.equal(env.seen.log.filter((l) => /feedback drafts: the stored value is not version 1/.test(l)).length, 1);
}, { memento: new Map([[STORAGE_KEY, { version: 9, items: [] }]]) }));

// ---- Details ------------------------------------------------------------------------------

const SITE = { start: 22, end: 25 };
const caller = (file) => ({ file, pos: 7, label: 'user', test: false, callSites: [SITE], sites: 1,
  callSiteUpdates: { updated: [], untouched: [SITE], unknown: [] } });
// a.ts: `bad` (lines 10–12) called by `user` on line 3 of b.ts; both files are in the result.
function useResult(env, { tierA = false } = {}) {
  const a = path.join(env.dir, 'a.ts'), b = path.join(env.dir, 'b.ts');
  fs.writeFileSync(a, Array.from({ length: 20 }, (_, k) => `// a ${k + 1}`).join('\n'));
  fs.writeFileSync(b, 'const one = 1;\nfoo;\nuser(bad());\n');
  const bad = { ...finding('bad', a, 10), relPath: 'a.ts', startLine: 10, endLine: 12, staleCallers: 1, callers: [caller(b)], throwsAdded: [] };
  const parts = { allChanged: [bad], findings: [bad], changedPaths: ['a.ts', 'b.ts'], fileStatus: { 'a.ts': 'modified', 'b.ts': 'modified' } };
  if (tierA) env.hooks.remoteResult = (pr) => ({ ...previewResult(pr), ...parts });
  else env.hooks.localResult = (o) => ({ ...localResult(o), ...parts });
}
const pageAction = (details, message) => ({ ...message, token: /<script nonce="([^"]+)"/.exec(details.webview.html)[1] });
const textOf = (details) => details.displayHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const feedbackBoxes = (env) => env.commentController('impactTree.feedback').threads.filter((t) => !t.disposed && t.comments.length === 0);

// Feedback is started from the diff's comment box; Details offers none.
test('Details of a local review offers no feedback, and the old 💬 messages start none', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const details = env.openDetails();
  const [file] = (await env.tree().getChildren()).filter((r) => r.type === 'reviewFile');
  const [bad] = (await env.tree().getChildren(file)).filter((r) => r.type === 'finding');
  for (const row of [bad, file]) {
    env.select([row]);
    assert.doesNotMatch(textOf(details), /Feedback/, row.type);
    assert.doesNotMatch(details.displayHtml, /data-act="(feedback|comment|caller-comment)"/, row.type);
    for (const message of [{ type: 'comment', id: treeItemId(row) }, { type: 'feedback', id: treeItemId(row) }, { type: 'commentCaller', index: 0 }]) {
      await details.send(pageAction(details, message));
    }
  }
  assert.equal(feedbackBoxes(env).length, 0);
  assert.equal(env.seen.executed.filter(([name]) => name === 'vscode.diff').length, 0, 'no diff opened');
}));

test('Details of a Preview offers no feedback, and its 💬 messages start none', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const details = env.openDetails();
  const files = (await env.tree().getChildren()).filter((r) => r.type === 'reviewFile');
  const [bad] = (await env.tree().getChildren(files[0])).filter((r) => r.type === 'finding');
  env.select([bad]);
  assert.doesNotMatch(textOf(details), /Feedback on this/);
  await details.send(pageAction(details, { type: 'comment', id: treeItemId(bad) }));
  await details.send(pageAction(details, { type: 'commentCaller', index: 0 }));
  assert.equal(feedbackBoxes(env).length, 0);
}));
