'use strict';
// The window's first review (src/session/first-run.js): when it runs by itself, what it
// selects afterwards, and the one-time hint.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFirstRun, decideAutoReview, branchAheadOfBase, startupPolicy, HINT, HINTED_KEY } = require('../src/session/first-run');

test('the setting: new words and the old booleans', () => {
  assert.equal(startupPolicy(undefined), 'branch');
  assert.equal(startupPolicy('branch'), 'branch');
  assert.equal(startupPolicy('always'), 'always');
  assert.equal(startupPolicy(true), 'always');
  assert.equal(startupPolicy('never'), 'never');
  assert.equal(startupPolicy(false), 'never');
  assert.equal(startupPolicy('junk'), 'branch');
});

/** A git whose answers are scripted by command. */
const fakeGit = (answers) => ({
  calls: [],
  tryRaw(args) { this.calls.push(args.join(' ')); const a = answers[args[0]]; return a === undefined ? null : a; },
  revParse(ref) { return answers.revParse ? answers.revParse(ref) : null; },
});

test('branch ahead of base: counts commits, and reads failures as unknown', () => {
  const sha = 'a'.repeat(40);
  const ok = fakeGit({ 'rev-list': '3\n', revParse: () => sha });
  assert.deepEqual(branchAheadOfBase(ok, { base: '', remote: 'origin' }), { ahead: 3, reason: 'ahead' });
  const even = fakeGit({ 'rev-list': '0\n', revParse: () => sha });
  assert.deepEqual(branchAheadOfBase(even, { base: '', remote: 'origin' }), { ahead: 0, reason: 'not-ahead' });
  const noBase = fakeGit({ revParse: () => null });
  assert.equal(branchAheadOfBase(noBase, { base: '', remote: 'origin' }).reason, 'no-base');
  const noCount = fakeGit({ revParse: () => sha });
  assert.deepEqual(branchAheadOfBase(noCount, { base: '', remote: 'origin' }), { ahead: null, reason: 'no-base' });
});

test('the decision: never, no repo and a held review stop it; branch asks git, always does not', () => {
  let asked = 0;
  const ahead = (reason) => () => { asked++; return { ahead: reason === 'ahead' ? 1 : 0, reason }; };
  assert.deepEqual(decideAutoReview({ policy: 'never', repoStatus: 'ok', held: false, ahead: ahead('ahead') }), { run: false, reason: 'never' });
  assert.deepEqual(decideAutoReview({ policy: 'branch', repoStatus: 'noGit', held: false, ahead: ahead('ahead') }), { run: false, reason: 'no-repo' });
  assert.deepEqual(decideAutoReview({ policy: 'branch', repoStatus: 'ok', held: true, ahead: ahead('ahead') }), { run: false, reason: 'held' });
  assert.equal(asked, 0);
  assert.deepEqual(decideAutoReview({ policy: 'always', repoStatus: 'ok', held: false, ahead: ahead('not-ahead') }), { run: true, reason: 'always' });
  assert.equal(asked, 0);
  assert.deepEqual(decideAutoReview({ policy: 'branch', repoStatus: 'ok', held: false, ahead: ahead('ahead') }), { run: true, reason: 'ahead' });
  assert.deepEqual(decideAutoReview({ policy: 'branch', repoStatus: 'ok', held: false, ahead: ahead('not-ahead') }), { run: false, reason: 'not-ahead' });
});

function setup({ setting, ahead = '2\n', attention = 1, hinted = false, held = false, dropFirst = false, visible = false } = {}) {
  const seen = { refreshed: 0, revealed: [], messages: [], events: [], timers: [] };
  const listeners = new Set();
  const session = {
    state: held ? { result: {} } : null,
    refresh: async () => { seen.refreshed++; },
    repoStatus: () => 'ok', repoRoot: () => '/repo', baseRemote: () => ({ name: 'origin' }), isBusy: () => false,
  };
  const worst = { type: 'finding', label: 'lockRow' };
  const provider = { nextUnreviewed: () => (attention ? worst : null), reviewCounts: () => ({ attention }),
    onDidChangePresentation: (l) => { listeners.add(l); return { dispose: () => listeners.delete(l) }; } };
  // The first reveal is lost to a repaint (`dropFirst`); the next one sticks.
  let drops = dropFirst ? 1 : 0;
  const visibility = [];
  const view = { visible, selection: [], reveal: async (row, o) => { seen.revealed.push([row.label, o]); view.selection = drops-- > 0 ? [] : [{ label: row.label }]; },
    onDidChangeVisibility: (l) => { visibility.push(l); return { dispose() { visibility.splice(visibility.indexOf(l), 1); } }; } };
  const values = new Map(hinted ? [[HINTED_KEY, true]] : []);
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'analyseOnStartup' ? setting : d) }) },
    window: { showInformationMessage: async (m) => { seen.messages.push(m); } },
  };
  const clock = { setTimeout: (f, ms) => { seen.timers.push(ms); f(); return f; }, clearTimeout: () => {} };
  const makeGit = () => fakeGit({ 'rev-list': ahead, revParse: () => 'b'.repeat(40) });
  const firstRun = createFirstRun(vscode, { session, provider, view, treeRead: async () => { seen.treeReads = (seen.treeReads || 0) + 1; }, rowId: (r) => `id:${r.label}`, globalState: { get: (k) => values.get(k), update: async (k, v) => { values.set(k, v); } },
    makeGit, log: () => {}, clock, telemetry: { event: (n, p) => seen.events.push(`${n}:${p.reason}`) } });
  /** The tree repainted for `result` (reason `analysis`), or for something else. */
  const finish = (result, reason = 'analysis') => { session.state = { result }; for (const l of [...listeners]) l({ reason }); };
  /** The view came on screen (or left it). */
  const show = (on = true) => { view.visible = on; for (const l of [...visibility]) l({ visible: on }); };
  return { firstRun, seen, finish, values, listeners, show, visibility };
}
const settle = () => new Promise((r) => setImmediate(r));

test('a branch ahead of its base is reviewed by itself; the worst row is selected and the hint shown once', async () => {
  const t = setup();
  t.firstRun.schedule();
  assert.equal(t.seen.refreshed, 0, 'nothing runs while the view is not on screen');
  t.show(false);
  assert.equal(t.seen.refreshed, 0);
  t.show(true);
  assert.equal(t.seen.refreshed, 1, 'the view came on screen');
  assert.equal(t.visibility.length, 0, 'watched once');
  t.show(true);
  assert.equal(t.seen.refreshed, 1);
  assert.deepEqual(t.seen.events, ['startup.review:ahead']);
  t.finish({ callersPending: true });            // the prepared result: wait for the callers
  t.finish({ callersPending: false }, 'filter');  // not a result
  await settle(); await settle();
  assert.deepEqual(t.seen.revealed, []);
  t.finish({ callersPending: false });
  await settle(); await settle();
  assert.equal(t.seen.treeReads, 1, 'waits for the view to read the result first');
  assert.deepEqual(t.seen.revealed, [['lockRow', { select: true, focus: false, expand: true }]]);
  assert.deepEqual(t.seen.messages, [`Impact Tree: ${HINT}`]);
  assert.equal(t.values.get(HINTED_KEY), true);
  assert.equal(t.listeners.size, 0, 'stops listening after the result');
  t.finish({ callersPending: false });
  assert.equal(t.seen.revealed.length, 1);
});

test('a selection lost to the repaint is made again', async () => {
  const t = setup({ dropFirst: true });
  t.firstRun.start();
  t.finish({});
  for (let i = 0; i < 4; i++) await settle();
  assert.deepEqual(t.seen.revealed.map(([l]) => l), ['lockRow', 'lockRow']);
  assert.deepEqual(t.seen.timers, [300]);
});

test('a view already on screen starts at once; disposing before it shows starts nothing', () => {
  const shown = setup({ visible: true });
  shown.firstRun.schedule();
  assert.equal(shown.seen.refreshed, 1);
  const gone = setup();
  gone.firstRun.schedule();
  gone.firstRun.dispose();
  gone.show(true);
  assert.equal(gone.seen.refreshed, 0);
});

test('the hint is not repeated, and not shown when nothing needs attention', async () => {
  const again = setup({ hinted: true });
  again.firstRun.start();
  again.finish({});
  await settle(); await settle();
  assert.equal(again.seen.revealed.length, 1);
  assert.deepEqual(again.seen.messages, []);
  const calm = setup({ attention: 0 });
  calm.firstRun.start();
  calm.finish({});
  await settle();
  assert.deepEqual(calm.seen.revealed, []);
  assert.deepEqual(calm.seen.messages, []);
  assert.equal(calm.values.get(HINTED_KEY), undefined, 'the one hint is saved for a review that has something red');
});

test('nothing runs on an even branch, with never, or over a held review', () => {
  const even = setup({ ahead: '0\n' });
  even.firstRun.start();
  assert.equal(even.seen.refreshed, 0);
  assert.deepEqual(even.seen.events, ['startup.review:not-ahead']);
  const never = setup({ setting: false });
  never.firstRun.start();
  assert.equal(never.seen.refreshed, 0);
  assert.deepEqual(never.seen.events, ['startup.review:never']);
  const held = setup({ held: true });
  held.firstRun.start();
  assert.equal(held.seen.refreshed, 0);
  assert.deepEqual(held.seen.events, ['startup.review:held']);
});
