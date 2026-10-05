'use strict';
// The lens and the callers peek: what each is made of, decided by pure functions, and then
// what the extension does with them through the real activate() and the vscode stub.
// The pure part runs on built rows; the harness part is further down.
const test = require('node:test');
const assert = require('node:assert/strict');
const { lensPlan, lensTitles, callerLocations, noCallersMessage } = require('../src/review-lens');
const { treeItemId } = require('../src/review-tree-model');

const BODY = { id: 'body' };
const RISKY = { id: 'signature', label: 'signature' };
const callers = (n) => Array.from({ length: n }, (_, i) => ({ label: `c${i}`, callState: 'unchanged' }));
// A change row as the tree builds it: what the lens reads is the finding and the row's id.
const changeRow = (label, startLine, extra = {}) => {
  const finding = { relPath: 'a.ts', label, startLine, endLine: startLine + 2, namePos: startLine * 10, kinds: [BODY],
    staleCallers: 0, callerState: 'resolved', callers: callers(2), ...extra };
  return { type: 'finding', label, finding, file: '/r/a.ts', pos: finding.namePos };
};
const never = () => false;

// One row per verdict level 0..4, in the order of the levels.
const LEVELS = [
  changeRow('lv0', 10, { kinds: [RISKY], staleCallers: 1, callers: callers(3) }),
  changeRow('lv1', 20, { kinds: [RISKY], callerState: 'unknown', callers: [] }),
  changeRow('lv2', 30, { kinds: [RISKY], callerState: 'none', callers: [] }),
  changeRow('lv3', 40),
  changeRow('lv4', 50, { callerState: 'none', callers: [] }),
];

test('only changes at level 0 and 1 get a lens, on the first line of the change', () => {
  const plan = lensPlan(LEVELS, never);
  assert.deepEqual(plan.map((l) => [l.line, l.id]), [[9, treeItemId(LEVELS[0])], [19, treeItemId(LEVELS[1])]],
    'the 0-based line of startLine, for levels 0 and 1 only');
});

test('a deleted row, an outside row and a file row get no lens, whatever their level', () => {
  const rows = [
    { type: 'deleted', label: 'gone', relPath: 'a.ts', key: 'k' },
    { type: 'outside', label: 'Outside functions', relPath: 'a.ts', ranges: [[1, 2]] },
    { type: 'file', label: 'notes.md', relPath: 'notes.md' },
    LEVELS[0],
  ];
  assert.deepEqual(lensPlan(rows, never).map((l) => l.id), [treeItemId(LEVELS[0])]);
});

test('a lens says the verdict, offers the callers only when there are some, and tells the tick', () => {
  const [lv0, lv1] = lensPlan(LEVELS, never);
  assert.deepEqual(lensTitles(lv0), { verdict: '⛔ 1 of 3 callers not updated', callers: 'Show callers', tick: 'Mark reviewed' });
  assert.deepEqual(lensTitles(lv1), { verdict: '? callers unknown', callers: null, tick: 'Mark reviewed' }, 'no callers, no peek');
  assert.equal(lv0.hasCallers, true);
  assert.equal(lv1.hasCallers, false);
});

test('a ticked change keeps its lens and reads Reviewed; the others are not affected', () => {
  const ticked = new Set([LEVELS[0]]);
  const [lv0, lv1] = lensPlan(LEVELS, (row) => ticked.has(row));
  assert.equal(lensTitles(lv0).tick, '✓ Reviewed');
  assert.equal(lv0.reviewed, true);
  assert.equal(lensTitles(lv1).tick, 'Mark reviewed');
  assert.equal(lv1.reviewed, false);
});

test('the lens follows the change\'s own facts, on any line and any caller count', () => {
  const rows = [changeRow('x', 1, { kinds: [RISKY], staleCallers: 2, callers: callers(2) }),
    changeRow('y', 200, { kinds: [RISKY], callerState: 'di', callers: [] }),
    changeRow('z', 7, { kinds: [RISKY], staleCallers: 1, callers: callers(1), callersComplete: false })];
  assert.deepEqual(lensPlan(rows, never).map((l) => [l.line, lensTitles(l).verdict]), [
    [0, '⛔ 2 of 2 callers not updated'], [199, '? DI-constructed'], [6, '⛔ 1 of 1 caller not updated — more may be missing']]);
  assert.deepEqual(lensPlan([], never), []);
});

// ---- callers to locations ----------------------------------------------------------

// A position is the offset's line, so a call site is easy to read in the result.
const positionOf = (file, offset) => (file.endsWith('.missing') ? null : { line: Math.floor(offset / 100), character: offset % 100 });
const uriOf = (caller) => `uri:${caller.file}`;
const caller = (file, label, sites, extra = {}) => ({ type: 'caller', label, file, pos: 1, callSites: sites, test: false, ...extra });
const site = (start, end) => ({ start, end });

test('every call site of every caller is one location, at its own range', () => {
  const rows = [caller('/r/b.ts', 'one', [site(105, 110), site(310, 315)]), caller('/r/c.ts', 'two', [site(420, 425)])];
  assert.deepEqual(callerLocations(rows, { uriOf, positionOf }), [
    { uri: 'uri:/r/b.ts', start: { line: 1, character: 5 }, end: { line: 1, character: 10 } },
    { uri: 'uri:/r/b.ts', start: { line: 3, character: 10 }, end: { line: 3, character: 15 } },
    { uri: 'uri:/r/c.ts', start: { line: 4, character: 20 }, end: { line: 4, character: 25 } },
  ]);
});

test('a file group stands for the callers it holds, and a test caller is a caller', () => {
  const group = { type: 'callerFile', label: 'b.test.ts', file: '/r/b.test.ts', callers: [
    caller('/r/b.test.ts', 't1', [site(100, 103)], { test: true }), caller('/r/b.test.ts', 't2', [site(250, 253)], { test: true })] };
  const rows = [caller('/r/a.ts', 'solo', [site(0, 4)]), group, { type: 'message', label: 'Tested by 2' }];
  assert.deepEqual(callerLocations(rows, { uriOf, positionOf }).map((l) => [l.uri, l.start.line]),
    [['uri:/r/a.ts', 0], ['uri:/r/b.test.ts', 1], ['uri:/r/b.test.ts', 2]], 'message rows are not callers');
});

test('a caller without a call site is opened at its own position, and a site that cannot be read is left out', () => {
  const rows = [caller('/r/b.ts', 'bare', [], { pos: 350 }), caller('/r/x.missing', 'lost', [site(1, 2)]), caller('/r/c.ts', 'ok', [site(500, 505)])];
  assert.deepEqual(callerLocations(rows, { uriOf, positionOf }), [
    { uri: 'uri:/r/b.ts', start: { line: 3, character: 50 }, end: { line: 3, character: 50 } },
    { uri: 'uri:/r/c.ts', start: { line: 5, character: 0 }, end: { line: 5, character: 5 } },
  ]);
  assert.deepEqual(callerLocations([], { uriOf, positionOf }), []);
});

test('the message for a change without callers says whether the search finished', () => {
  assert.equal(noCallersMessage({ label: 'foo', callersComplete: true }), 'Impact Tree: No callers found for foo');
  assert.equal(noCallersMessage({ label: 'foo' }), 'Impact Tree: No callers found for foo', 'a result without the field reads as complete');
  assert.equal(noCallersMessage({ label: 'foo', callersComplete: false }), 'Impact Tree: No callers found for foo — the search did not finish');
});

// ---- through the real activate() ---------------------------------------------------

const path = require('path');
const fs = require('fs');
const { localResult, finding, previewResult, pull, withEnv } = require('./extension-env');
const { prQuery } = require('../src/pr-documents');
const { createOpenReview } = require('../src/open-review');

const SITE = { start: 22, end: 25 };
const OTHER_SITE = { start: 30, end: 32 };
const SITE_CALLER = (file, sites = [SITE]) => ({ file, pos: 7, label: 'user', test: false, callSites: sites, sites: sites.length,
  callSiteUpdates: { updated: [], untouched: sites, unknown: [] } });

// a.ts: `bad` (lines 10-12, a signature change, one caller not updated: level 0), `reach`
// (50-52, body only: level 3), `lost` (60-62, a signature change whose callers are unknown:
// level 1, no callers); b.ts: `quiet`, and the caller. b.ts is
//   const one = 1;\nfoo;\nuser(bad());\n
// so offsets 22-25 are line 3 (1-based), columns 2-5, and 30-32 columns 10-12.
function useResult(env, { tierA = false, badCallers = null, lost = {} } = {}) {
  const a = path.join(env.dir, 'a.ts'), b = path.join(env.dir, 'b.ts');
  fs.writeFileSync(b, 'const one = 1;\nfoo;\nuser(bad());\n');
  const bad = { ...finding('bad', a, 10), relPath: 'a.ts', startLine: 10, endLine: 12, staleCallers: 1, callers: badCallers || [SITE_CALLER(b)] };
  const reach = { ...finding('reach', a, 50), relPath: 'a.ts', startLine: 50, endLine: 52, kinds: [{ id: 'body', label: 'body' }], callers: [SITE_CALLER(b)] };
  const lostChange = { ...finding('lost', a, 60), relPath: 'a.ts', startLine: 60, endLine: 62, callerState: 'unknown', callers: [], ...lost };
  const quiet = { ...finding('quiet', b, 5), relPath: 'b.ts', startLine: 5, endLine: 6, kinds: [{ id: 'body', label: 'body' }] };
  const allChanged = [bad, reach, lostChange, quiet].map((c) => ({ ...c, throwsAdded: [] }));
  const parts = { allChanged, findings: [allChanged[0]], otherFiles: [{ path: 'notes.md', status: 'added' }],
    fileStatus: { 'a.ts': 'modified', 'b.ts': 'modified', 'notes.md': 'added' }, changedPaths: ['a.ts', 'b.ts'] };
  if (tierA) env.hooks.remoteResult = (pr) => ({ ...previewResult(pr), ...parts });
  else env.hooks.localResult = (o) => ({ ...localResult(o), ...parts });
}
const fileUri = (env, rel) => env.vscode.Uri.file(path.join(env.dir, rel));
const peeks = (env) => env.seen.executed.filter(([name]) => name === 'editor.action.peekLocations');
const rowsOf = async (env) => (await env.tree().getChildren((await env.tree().getChildren())[0]));
const at = (line, character) => ({ line, character });

test('a reviewed head-side document gets three lenses on the first line of each change needing attention', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  assert.deepEqual(env.lensProvider().selector, [{ scheme: 'file' }, { scheme: 'impacttree-pr' }]);
  const lenses = env.lensesFor(fileUri(env, 'a.ts'));
  assert.deepEqual(lenses.map((l) => [l.range.start, l.command.title, l.command.command, l.command.arguments]), [
    [at(9, 0), '⛔ 1 of 1 caller not updated', 'impactTree.showChange', ['finding:a.ts:bad:10']],
    [at(9, 0), 'Show callers', 'impactTree.showCallers', ['finding:a.ts:bad:10']],
    [at(9, 0), 'Mark reviewed', 'impactTree.setReviewed', ['finding:a.ts:bad:10', true, env.tree().reviewVersion()]],
    [at(59, 0), '? callers unknown', 'impactTree.showChange', ['finding:a.ts:lost:60']],
    [at(59, 0), 'Mark reviewed', 'impactTree.setReviewed', ['finding:a.ts:lost:60', true, env.tree().reviewVersion()]],
  ], '`reach` is level 3 and has none; `lost` has no callers, so no peek');
  assert.deepEqual(env.lensesFor(fileUri(env, 'b.ts')), [], 'b.ts is reviewed, but nothing in it needs attention');
}));

test('there is no lens on the base side, in a file the review does not include, or outside the repository', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const { Uri } = env.vscode;
  for (const uri of [
    Uri.from({ scheme: 'impacttree-base', path: 'a.ts', query: 'HEAD' }),
    fileUri(env, 'README.md'),
    fileUri(env, 'missing/a.ts'),
    Uri.file(path.join(path.dirname(env.dir), 'elsewhere', 'a.ts')),
    Uri.from({ scheme: 'output', path: 'extension-output-impact-tree' }),
    // a preview's address names a result that is not shown
    Uri.from({ scheme: 'impacttree-pr', path: 'a.ts', query: 'side=head&revision=7%3Ah%3Am' }),
  ]) assert.deepEqual(env.lensesFor(uri), [], uri.toString());
}));

test('there is no lens before the first analysis, or while one runs', () => withEnv(async (env) => {
  useResult(env);
  assert.deepEqual(env.lensesFor(fileUri(env, 'a.ts')), [], 'nothing analysed');
  await env.refresh();
  const gate = env.holds.analyze.next();
  const running = env.refresh();
  await gate.reached;
  assert.deepEqual(env.lensesFor(fileUri(env, 'a.ts')), [], 'while analysing');
  gate.release();
  await running;
  assert.equal(env.lensesFor(fileUri(env, 'a.ts')).length, 5);
}));

test('in a preview only the head side of the pull request has lenses', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const result = previewResult(pull(7));   // the same revision key as the preview shown
  const side = (s) => env.vscode.Uri.from({ scheme: 'impacttree-pr', path: 'a.ts', query: prQuery(result, s, { path: 'a.ts', status: 'modified' }) });
  assert.equal(env.lensesFor(side('head')).length, 5);
  assert.deepEqual(env.lensesFor(side('base')), []);
  assert.deepEqual(env.lensesFor(fileUri(env, 'a.ts')), [], 'the worktree file is not the pull request');
}));

test('the lenses are asked again when ticks, the filter or the result change', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  let fired = 0;
  env.lensProvider().provider.onDidChangeCodeLenses(() => { fired++; });
  const [bad] = await rowsOf(env);
  env.tick(bad, true);
  assert.equal(fired, 1, 'a tick');
  env.tree().toggleFilter('attention');
  assert.equal(fired, 2, 'a filter');
  await env.refresh();
  assert.ok(fired >= 3, 'a new result');
}));

test('the lens ticks its change on and off, and its title follows', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const [bad] = await rowsOf(env);
  const titles = () => env.lensesFor(fileUri(env, 'a.ts')).map((l) => l.command.title);
  const tick = () => env.lensesFor(fileUri(env, 'a.ts')).find((l) => l.command.command === 'impactTree.setReviewed').command;
  assert.equal(titles()[2], 'Mark reviewed');
  await env.run(tick().command, ...tick().arguments);
  assert.equal(env.isTicked(bad), true);
  assert.deepEqual(titles().slice(0, 3), ['⛔ 1 of 1 caller not updated', 'Show callers', '✓ Reviewed'], 'the lens stays');
  assert.deepEqual(tick().arguments, ['finding:a.ts:bad:10', false, env.tree().reviewVersion()], 'and now unticks');
  assert.equal(env.seen.statusBar.text.split(' ')[1], '4', 'the view repainted');
  await env.run(tick().command, ...tick().arguments);
  assert.equal(env.isTicked(bad), false);
  assert.equal(titles()[2], 'Mark reviewed');
}));

test('the tick command ignores what is not a change or not well formed', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const [bad] = await rowsOf(env);
  const version = env.tree().reviewVersion();
  for (const args of [[], ['finding:a.ts:bad:10'], ['finding:a.ts:bad:10', 'true', version], ['finding:a.ts:bad:10', 1, version], [5, true, version],
    ['file:a.ts', true, version], ['finding:a.ts:nothing:1', true, version], [null, null, version],
    ...[undefined, null, '1', true, NaN, Infinity, 1.5, version + 1].map(v => [treeItemId(bad), true, v])]) {
    await env.run('impactTree.setReviewed', ...args);
  }
  assert.equal(env.isTicked(bad), false);
  assert.equal(env.isTicked((await env.tree().getChildren())[0]), false, 'a file is not ticked this way');
}));

test('an old CodeLens tick cannot review changed content, during or after a replacement analysis', () => withEnv(async env => {
  const file = path.join(env.dir, 'a.ts');
  fs.writeFileSync(file, 'export function f() { return 1; }\n');
  env.hooks.localResult = o => ({ ...localResult(o), fileStatus: { 'a.ts': 'added' }, allChanged: [
    { ...finding('f', file, 16), startLine: 1, endLine: 1, throwsAdded: [], callerState: 'unknown', callersComplete: false },
  ] });
  await env.refresh();
  const [oldRow] = await env.changeRows();
  const tick = () => env.lensesFor(fileUri(env, 'a.ts')).find(l => l.command.command === 'impactTree.setReviewed').command;
  const oldCommand = tick();
  const oldVersion = env.tree().reviewVersion();
  fs.writeFileSync(file, 'export function f() { return 2; }\n');
  const gate = env.holds.analyze.next();
  const refreshing = env.refresh();
  await gate.reached;
  assert.equal(env.tree().reviewVersion(), null, 'a placeholder has no actionable review');
  await env.run(oldCommand.command, ...oldCommand.arguments);
  assert.equal(env.isTicked(oldRow), false);
  gate.release();
  await refreshing;
  const [newRow] = await env.changeRows();
  assert.equal(treeItemId(newRow), treeItemId(oldRow));
  assert.notEqual(env.tree().reviewVersion(), oldVersion);
  await env.run(oldCommand.command, ...oldCommand.arguments);
  assert.equal(env.isTicked(newRow), false, 'a stable tree id must not rebind an old tick to new content');
  const newCommand = tick();
  await env.run(newCommand.command, ...newCommand.arguments);
  assert.equal(env.isTicked(newRow), true, 'a fresh lens can review the new content');
  const untick = tick();
  env.tree().toggleFilter('attention');
  await env.run(untick.command, ...untick.arguments);
  assert.equal(env.isTicked(newRow), false, 'ticks and filters do not invalidate the analysis');
}));

test('an old preview CodeLens tick cannot mark a row of another PR reviewed', () => withEnv(async env => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const headUri = pr => env.vscode.Uri.from({ scheme: 'impacttree-pr', path: 'a.ts',
    query: prQuery(previewResult(pull(pr)), 'head', { path: 'a.ts', status: 'modified' }) });
  const oldCommand = env.lensesFor(headUri(7)).find(l => l.command.command === 'impactTree.setReviewed').command;
  await env.preview(pull(8));
  const [current] = await env.changeRows();
  assert.equal(treeItemId(current), oldCommand.arguments[0], 'two PRs can show the same UI row id');
  await env.run(oldCommand.command, ...oldCommand.arguments);
  assert.equal(env.isTicked(current), false);
  const fresh = env.lensesFor(headUri(8)).find(l => l.command.command === 'impactTree.setReviewed').command;
  await env.run(fresh.command, ...fresh.arguments);
  assert.equal(env.isTicked(current), true);
}));

test('showCallers at the cursor peeks one location per call site of the change\'s callers', () => withEnv(async (env) => {
  const b = path.join(env.dir, 'b.ts');
  useResult(env, { badCallers: [SITE_CALLER(b, [SITE, OTHER_SITE])] });
  await env.refresh();
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  await env.run('impactTree.showCallers');
  assert.equal(peeks(env).length, 1);
  const [, anchor, position, locations, mode] = peeks(env)[0];
  assert.equal(anchor.toString(), fileUri(env, 'a.ts').toString(), 'the editor that shows the change');
  assert.deepEqual([position.line, position.character], [9, 0], 'at the start of the change');
  assert.deepEqual(locations.map((l) => [l.uri.toString(), l.range.start, l.range.end]), [
    [fileUri(env, 'b.ts').toString(), at(2, 2), at(2, 5)],
    [fileUri(env, 'b.ts').toString(), at(2, 10), at(2, 12)],
  ]);
  assert.equal(mode, 'peek');
  assert.ok(env.seen.executed.every(([name]) => name !== 'impactTree.openChange'), 'the change was already open');
}));

test('showCallers works on a body-only change, and on any line of the change', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  for (const line of [50, 52]) {
    env.moveCursor(fileUri(env, 'a.ts'), line);
    await env.run('impactTree.showCallers');
  }
  assert.equal(peeks(env).length, 2);
  assert.deepEqual(peeks(env).map(([, , position]) => position.line), [49, 49]);
}));

test('showCallers does nothing outside a change, in another editor, or with no editor', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const quiet = async (why) => {
    await env.run('impactTree.showCallers');
    assert.deepEqual(env.seen.executed.filter(([name]) => name !== 'setContext'), [], why);
    assert.deepEqual(env.seen.infos.concat(env.seen.warnings), [], why);
  };
  await quiet('no editor');
  env.moveCursor(fileUri(env, 'a.ts'), 30);
  await quiet('between functions');
  env.moveCursor(fileUri(env, 'notes.md'), 3);
  await quiet('a file without a call graph');
  env.moveCursor(fileUri(env, 'README.md'), 11);
  await quiet('a file the review does not include');
  env.moveCursor(env.vscode.Uri.from({ scheme: 'impacttree-base', path: 'a.ts', query: 'HEAD' }), 11);
  await quiet('the base side');
  await env.run('impactTree.showCallers', 'file:a.ts');
  await env.run('impactTree.showCallers', 'finding:a.ts:nothing:1');
  await quiet('an id that is not a change');
}));

test('a change without callers says so, and says when the search did not finish', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  env.moveCursor(fileUri(env, 'a.ts'), 61);
  await env.run('impactTree.showCallers');
  assert.deepEqual(env.seen.infos, ['Impact Tree: No callers found for lost']);
  useResult(env, { lost: { callersComplete: false } });
  await env.refresh();
  await env.run('impactTree.showCallers');
  assert.equal(env.seen.infos.at(-1), 'Impact Tree: No callers found for lost — the search did not finish');
  assert.deepEqual(peeks(env), [], 'no empty peek');
}));

test('call sites that cannot be read are told, not shown as no callers', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  fs.rmSync(path.join(env.dir, 'b.ts'));
  require('../src/engine/textpos')._clear();
  env.moveCursor(fileUri(env, 'a.ts'), 11);
  await env.run('impactTree.showCallers');
  assert.deepEqual(env.seen.infos, []);
  assert.deepEqual(env.seen.warnings, ['Impact Tree: the call sites of bad could not be read']);
  assert.deepEqual(peeks(env), []);
}));

test('showCallers with an id opens the change first when no editor shows it, and peeks in the editor that opens', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const [bad] = await rowsOf(env);
  env.hooks.onCommand = (name) => {
    if (name === 'impactTree.openChange') env.vscode.window.activeTextEditor = { document: { uri: fileUri(env, 'a.ts') }, selection: { active: { line: 9, character: 0 } } };
  };
  env.moveCursor(fileUri(env, 'b.ts'), 1);   // an editor that is not the change's
  await env.run('impactTree.showCallers', 'finding:a.ts:bad:10');
  const names = env.seen.executed.map(([name]) => name);
  assert.deepEqual(names, ['impactTree.openChange', 'editor.action.peekLocations']);
  assert.equal(env.seen.executed[0][1], bad, 'the change row is what openChange takes');
  assert.equal(peeks(env)[0][1].toString(), fileUri(env, 'a.ts').toString());
  assert.deepEqual(peeks(env)[0][3].map((l) => l.range.start), [at(2, 2)]);
}));

test('with an id and the change already shown, the cursor may be anywhere in the file', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  env.moveCursor(fileUri(env, 'a.ts'), 30);
  await env.run('impactTree.showCallers', 'finding:a.ts:bad:10');
  assert.deepEqual(env.seen.executed.map(([name]) => name), ['editor.action.peekLocations']);
  assert.deepEqual([peeks(env)[0][2].line, peeks(env)[0][2].character], [9, 0], 'at the change, not at the cursor');
}));

test('the tree\'s context menu passes the change row, and a change that opens in no editor is reported', () => withEnv(async (env) => {
  useResult(env);
  await env.refresh();
  const [bad] = await rowsOf(env);
  await env.run('impactTree.showCallers', bad);
  assert.equal(env.seen.executed[0][0], 'impactTree.openChange', 'no editor shows the change');
  assert.deepEqual(peeks(env), [], 'and none opened, so there is nothing to peek from');
  assert.match(env.seen.log.join('\n'), /callers: bad is not shown in an editor/);
}));

test('in a preview the locations are in the pull request\'s head documents', () => withEnv(async (env) => {
  useResult(env, { tierA: true });
  await env.preview(pull(7));
  const result = previewResult(pull(7));
  const head = env.vscode.Uri.from({ scheme: 'impacttree-pr', path: 'a.ts', query: prQuery(result, 'head', { path: 'a.ts', status: 'modified' }) });
  env.moveCursor(head, 11);
  await env.run('impactTree.showCallers');
  const [, anchor, , locations] = peeks(env)[0];
  assert.equal(anchor, head);
  assert.equal(locations.length, 1);
  assert.equal(locations[0].uri.scheme, 'impacttree-pr', 'b.ts is changed, so its caller opens as the pull request\'s own text');
  assert.equal(locations[0].uri.path, 'b.ts');
  assert.match(locations[0].uri.query, /side=head/);
}));

test('a caller opens in the right side of its diff: the file locally, the head text in a preview', () => {
  const { Uri } = require('./vscode-stub');
  const vscode = { Uri, Range: class {}, workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
  const sessionOf = (result, tierA) => ({ isTierA: () => tierA, repoRoot: () => '/r',
    state: { rel: (f) => f.replace('/r/', ''), changedPaths: new Set(['b.ts']), result } });
  const local = createOpenReview(vscode, sessionOf({ base: { sha: 'abc' } }, false));
  assert.equal(local.callerUri({ file: '/r/b.ts' }).toString(), 'file:///r/b.ts', 'changed, so a diff; its right side is the file');
  assert.equal(local.callerUri({ file: '/r/c.ts' }).toString(), 'file:///r/c.ts', 'unchanged: the plain editor');
  const result = { tierA: true, prNumber: 7, headSha: 'h7', base: { sha: 'm' }, fileStatus: { 'b.ts': 'modified' } };
  const preview = createOpenReview(vscode, sessionOf(result, true));
  const changed = preview.callerUri({ file: '/r/b.ts' });
  assert.equal(changed.scheme, 'impacttree-pr');
  assert.match(changed.query, /side=head/);
  assert.equal(preview.callerUri({ file: '/r/c.ts' }).toString(), 'file:///r/c.ts', 'a file the pull request does not touch has no text to show');
});

test('the contributions: a keybinding in a review editor, a context menu on changes, internal commands hidden', () => {
  const { contributes } = require('../package.json');
  assert.deepEqual(contributes.keybindings.filter((k) => k.command === 'impactTree.showCallers'),
    [{ command: 'impactTree.showCallers', key: 'shift+alt+c', when: 'editorTextFocus && impactTree.hasReview' }]);
  assert.deepEqual(contributes.menus['view/item/context'].map((m) => [m.command, m.when]),
    [['impactTree.showCallers', 'view == impactTree.changes && viewItem == finding']]);
  const declared = new Set(contributes.commands.map((c) => c.command));
  const palette = new Map(contributes.menus.commandPalette.map((m) => [m.command, m.when]));
  for (const id of ['impactTree.showCallers', 'impactTree.showChange', 'impactTree.setReviewed']) assert.ok(declared.has(id), id);
  assert.equal(palette.get('impactTree.showCallers'), 'impactTree.hasReview');
  assert.equal(palette.get('impactTree.showChange'), 'false');
  assert.equal(palette.get('impactTree.setReviewed'), 'false');
});
