'use strict';
// "Comment on this call" on a caller row: which comment kind it starts, what it names,
// and what it refuses. Runs against fakes of the tree, the session and both comment kinds;
// what a started comment looks like is tested in review-comments.test.js and
// feedback-comments.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCallerComment, COMMAND } = require('../src/caller-comment');

const change = { type: 'finding', label: 'bad', relPath: 'a.ts' };
const group = { type: 'callerFile', label: 'b.ts' };
const direct = { type: 'caller', label: 'user', file: '/r/b.ts', relPath: 'b.ts', pos: 7, test: false,
  callSites: [{ start: 22, end: 25 }], callState: 'unchanged' };
const grouped = { ...direct, label: 'other' };
const deep = { ...direct, label: 'deep' };
const PARENTS = new Map([[direct, change], [group, change], [grouped, group], [deep, direct]]);

function setup({ threads = { status: 'none' }, feedbackAvailable = true, review = true, line = 3, state = { result: {} } } = {}) {
  const seen = { warnings: [], review: [], feedback: [], lineAsked: [] };
  /** @type {Function|null} */
  let handler = null;
  const vscode = {
    commands: { registerCommand: (id, fn) => { assert.equal(id, COMMAND); handler = fn; return { dispose() {} }; } },
    window: { showWarningMessage: (m) => { seen.warnings.push(m); } },
  };
  createCallerComment(vscode, {
    provider: { getParent: (row) => PARENTS.get(row) ?? null, threadsView: () => threads },
    getState: () => (state ? { ...state, rel: (f) => f.replace('/r/', '') } : null),
    lineOf: (file, offset) => { seen.lineAsked.push([file, offset]); return line; },
    reviewComments: () => (review ? { commentOnCaller: async (row, c) => { seen.review.push([row, c]); } } : null),
    feedbackComments: () => ({ available: () => feedbackAvailable, commentOnCaller: async (row, c) => { seen.feedback.push([row, c]); } }),
  });
  return { seen, run: (arg) => /** @type {Function} */ (handler)(arg) };
}

const CONTEXT = { label: 'user', test: false, relPath: 'b.ts', siteLine: 3, callState: 'unchanged' };

test('the command and its menu: on caller rows of the change view, hidden from the palette', () => {
  const { contributes } = require('../package.json');
  const command = contributes.commands.find((c) => c.command === COMMAND);
  assert.equal(command.title, 'Comment on this call');
  assert.deepEqual(contributes.menus['view/item/context'].filter((m) => m.command === COMMAND),
    [{ command: COMMAND, when: 'view == impactTree.sources && viewItem =~ /^(caller|changedCaller)$/', group: 'navigation@2' }]);
  assert.equal(contributes.menus.commandPalette.find((m) => m.command === COMMAND).when, 'false');
});

test('a local review starts a feedback draft about the call, on the change it calls', async () => {
  const { seen, run } = setup();
  await run(direct);
  assert.deepEqual(seen.feedback, [[change, CONTEXT]]);
  assert.deepEqual(seen.review, []);
  assert.deepEqual(seen.lineAsked, [['/r/b.ts', 22]], 'the line of the first call site');
});

test('a pull request under review starts a GitHub review comment, even when feedback is also possible', async () => {
  const { seen, run } = setup({ threads: { status: 'ready' } });
  await run(direct);
  assert.deepEqual(seen.review, [[change, CONTEXT]]);
  assert.deepEqual(seen.feedback, []);
});

test('a caller inside a file group is a direct caller of the change', async () => {
  const { seen, run } = setup();
  await run(grouped);
  assert.deepEqual(seen.feedback, [[change, { ...CONTEXT, label: 'other' }]]);
});

test('a caller of a caller is refused with a reason, since its call is not to the change', async () => {
  const { seen, run } = setup();
  await run(deep);
  assert.deepEqual(seen.feedback, []);
  assert.match(seen.warnings[0], /deep calls another caller, not a change/);
});

test('a review still loading, or that failed to load, says so and starts nothing', async () => {
  for (const [threads, said] of [[{ status: 'loading' }, /still loading/], [{ status: 'failed', message: 'HTTP 502' }, /could not be loaded: HTTP 502/]]) {
    const { seen, run } = setup({ threads });
    await run(direct);
    assert.deepEqual([seen.review, seen.feedback], [[], []]);
    assert.match(seen.warnings[0], said);
  }
});

test('with neither comment kind available it says where comments can be started', async () => {
  const { seen, run } = setup({ feedbackAvailable: false });
  await run(direct);
  assert.deepEqual(seen.feedback, []);
  assert.match(seen.warnings[0], /pull request under review or a review of local changes/);
});

test('a call whose line cannot be read is refused with a reason', async () => {
  const { seen, run } = setup({ line: null });
  await run(direct);
  assert.deepEqual(seen.feedback, []);
  assert.match(seen.warnings[0], /line of user's call could not be read/);
});

test('anything but a caller row, or no review shown, does nothing', async () => {
  for (const arg of [undefined, null, 'user', change, group, { ...direct, file: 7 }]) {
    const { seen, run } = setup();
    await run(arg);
    assert.deepEqual([seen.review, seen.feedback, seen.warnings], [[], [], []], String(arg && arg.type));
  }
  const { seen, run } = setup({ state: null });
  await run(direct);
  assert.deepEqual([seen.review, seen.feedback, seen.warnings], [[], [], []]);
});
