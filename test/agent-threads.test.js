'use strict';
// The agent's notes beside the code (L6, gates G15 and G16): one read-only thread per change
// the agent described, on the head side of the review diff; what each says; when it is
// expanded; when it goes; and what its title actions do. The module runs against the stubbed
// comments API with a fake provider; the last tests run the whole extension.
const test = require('node:test');
const assert = require('node:assert/strict');
const baseStub = require('./vscode-stub');
const { createCommentsApi, withEnv } = require('./extension-env');
const { createAgentThreads, CONTROLLER_ID, CONTROLLER_LABEL, COMMANDS } = require('../src/diff-editor/agent-threads');
const { noteMarkdown, notePlainText, escapeNote } = require('../src/diff-editor/agent-threads-model');
const { agentNotes } = require('../src/agent/agent-notes');
const { lensPlan, lensTitles } = require('../src/diff-editor/review-lens');
const { changeIdOf, NO_AGENT_ATTENTION } = require('../src/views/changes/review-tree-model');

const { Uri } = baseStub;
const BODY = { id: 'body', label: 'body' };
const SIG = { id: 'signature', label: 'signature' };
const SITE = { start: 22, end: 25 };

// a.ts: `bad` (lines 10-12, a signature change, one caller not updated: level 0, so the engine
// needs a look at it), `reach` (50-52, body only: level 3), `quiet` (70-72, level 3, no note).
// b.ts: `other` (5-6) has a note too, in another file.
const callerOf = (label, file, pos) => ({ label, file, pos, test: false, callSites: [SITE], sites: 1,
  callSiteUpdates: { updated: [], untouched: [SITE], unknown: [] } });
const changeRow = (relPath, label, startLine, extra = {}) => {
  const finding = { relPath, label, startLine, endLine: startLine + 2, namePos: startLine * 10, kinds: [BODY], staleCallers: 0,
    callerState: 'resolved', callers: [callerOf('user', '/r/b.ts', 7)], ...extra };
  return { type: 'finding', label, finding, file: `/r/${relPath}`, pos: finding.namePos };
};
const BAD = changeRow('a.ts', 'bad', 10, { kinds: [SIG], staleCallers: 1 });
const REACH = changeRow('a.ts', 'reach', 50);
const QUIET = changeRow('a.ts', 'quiet', 70);
const OTHER = changeRow('b.ts', 'other', 5);
const ROWS = { 'a.ts': [BAD, REACH, QUIET], 'b.ts': [OTHER] };

const PAYLOAD = { cards: [], changes: [
  { id: 'a.ts#100', kind: 'changed', what: 'rejects tokens whose header is not {alg, typ:"JWT"}', before: 'any header', after: 'JwtHeaderInvalid',
    when: 'typ is missing', affects: [{ name: 'user (middleware)', how: 'now answers 401 for a bad header' }, { name: 'cron job', how: 'logs a warning' }] },
  { id: 'a.ts#500', kind: 'same', what: 'reads the file in one call' },
  { id: 'b.ts#50', kind: 'new', what: 'takes a stream' },
  { id: 'gone.ts#1', kind: 'changed', what: 'a change this review does not have' },
] };

/** What `agentReviewOf` returns for a stored result that fits the cards. */
const reviewOf = (over = {}) => ({ notes: agentNotes(PAYLOAD), attention: new Set(), cards: [], summary: null, hasResult: true, showEngine: false,
  stale: false, resultKey: 'k1', storedAtText: '10:07', waiting: null, ...over });

const emitter = () => {
  const listeners = new Set();
  return { event: (l) => { listeners.add(l); return { dispose() { listeners.delete(l); } }; }, fire: () => [...listeners].forEach((l) => l()), count: () => listeners.size };
};

// An editor with some documents showing: a head document is `file:/r/<path>`, a base one
// `impacttree-base:<path>`.
function setup({ review = reviewOf(), docs = ['file:a.ts', 'file:b.ts'], feedback = true, post = true } = {}) {
  const comments = createCommentsApi();
  const commands = new Map();
  const agent = emitter(), editors = emitter();
  const state = { review, feedback, post, reviewed: new Set(), warnings: [], feedbackStarted: [], reviewStarted: [] };
  const uriOf = (spec) => { const [scheme, rel] = spec.split(':'); return scheme === 'file' ? Uri.file(`/r/${rel}`) : Uri.from({ scheme, path: rel, query: 'HEAD' }); };
  const vscode = { ...baseStub,
    Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
    comments: comments.api,
    window: { visibleTextEditors: [], onDidChangeVisibleTextEditors: editors.event, showWarningMessage: async (m) => { state.warnings.push(m); } },
    workspace: { onDidOpenTextDocument: () => ({ dispose() {} }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() { commands.delete(name); } }; } },
  };
  const show = (specs) => { vscode.window.visibleTextEditors = specs.map((s) => ({ document: { uri: uriOf(s) } })); editors.fire(); };
  vscode.window.visibleTextEditors = docs.map((s) => ({ document: { uri: uriOf(s) } }));
  const threads = createAgentThreads(vscode, {
    provider: { changeRowsOf: (relPath) => ROWS[relPath] || [], onDidChangeAgent: agent.event },
    getAgentReview: () => state.review,
    whereIs: (uri) => (uri.scheme === 'file' ? { path: uri.fsPath.replace('/r/', ''), side: 'RIGHT' }
      : uri.scheme === 'impacttree-base' ? { path: uri.fsPath, side: 'LEFT' } : null),
    isReviewed: (row) => state.reviewed.has(row),
    setReviewed: (row, on) => { if (on) state.reviewed.add(row); else state.reviewed.delete(row); },
    canStartFeedback: () => state.feedback,
    startFeedbackDraft: async (row) => { state.feedbackStarted.push(row); return { disposed: false }; },
    canPostToPr: () => state.post,
    startReviewDraft: async (row, text) => { state.reviewStarted.push([row, text]); return { disposed: false }; },
    events: [],
  });
  const controller = comments.controllers.find((c) => c.id === CONTROLLER_ID);
  return { vscode, comments, controller, threads, commands, state, agent, show,
    on: (spec) => comments.threadsOn(controller, uriOf(spec)),
    live: () => controller.threads.filter((t) => !t.disposed),
    // A result, an undo or a new analysis: the agent's answer changed.
    set(review) { state.review = review; agent.fire(); },
    run: (name, thread) => commands.get(name)(thread) };
}

const bodyOf = (thread) => thread.comments[0].body.value;
const Expanded = baseStub.CommentThreadCollapsibleState.Expanded, Collapsed = baseStub.CommentThreadCollapsibleState.Collapsed;

// ---- the controller ---------------------------------------------------------------------

test('the controller is "Impact Tree: your agent\'s notes", offers no commenting range and no reply', () => {
  const env = setup();
  assert.equal(CONTROLLER_ID, 'impactTree.agent');
  assert.equal(env.controller.id, 'impactTree.agent');
  assert.equal(env.controller.label, 'Impact Tree: your agent\'s notes');
  assert.equal(CONTROLLER_LABEL, env.controller.label);
  assert.equal(env.controller.commentingRangeProvider, undefined, 'it never competes with the other controllers for a new comment');
  assert.ok(env.live().length > 0);
  assert.ok(env.live().every((t) => t.canReply === false));
  env.set(reviewOf({ resultKey: 'k2' }));
  assert.equal(env.controller.commentingRangeProvider, undefined, 'not after a redraw either');
});

// ---- placement and text ------------------------------------------------------------------

test('one thread per change the agent described, at its start line on the head document, and none elsewhere', () => {
  const env = setup({ docs: ['file:a.ts', 'file:b.ts', 'impacttree-base:a.ts', 'impacttree-base:b.ts', 'file:README.md'] });
  assert.deepEqual(env.on('file:a.ts').map((t) => [t.range.start.line, t.range.end.line, t.label]), [[9, 9, 'Changed'], [49, 49, 'Same behaviour, new way']],
    '`quiet` has no note, and a note for a change the review does not have is not drawn');
  assert.deepEqual(env.on('file:b.ts').map((t) => [t.range.start.line, t.label]), [[4, 'New']], 'another file has its own');
  assert.deepEqual(env.on('impacttree-base:a.ts'), [], 'none on the base side');
  assert.deepEqual(env.on('impacttree-base:b.ts'), []);
  assert.deepEqual(env.on('file:README.md'), [], 'none on a file the review does not have');
  assert.equal(env.live().length, 3);
  const [t] = env.on('file:a.ts');
  assert.deepEqual([t.comments.length, t.comments[0].author.name, t.comments[0].mode, t.canReply], [1, '✦ Your agent', baseStub.CommentMode.Preview, false]);
});

test('a changed note with its callers, characterised: the engine\'s caller is a link, the unknown one is not', () => {
  const env = setup();
  const [bad] = env.on('file:a.ts');
  const link = 'command:impactTree.openCaller?' + encodeURIComponent(JSON.stringify([{ type: 'caller', label: 'user', file: '/r/b.ts', pos: 7, callSites: [SITE] }]));
  assert.equal(bodyOf(bad), [
    '**Changed** — rejects tokens whose header is not {alg, typ:"JWT"}',
    '**Before:** any header',
    '**After:** JwtHeaderInvalid',
    '**When:** typ is missing',
    `**Affects:**\n- [user (middleware)](${link}) — now answers 401 for a bad header\n- cron job — logs a warning`,
    '_The signature, and 1 of 1 caller was not changed on the call line. Check that it still works._',
    '_Written by your agent; the facts come from the engine._',
  ].join('\n\n'));
  assert.ok(link.startsWith('command:impactTree.openCaller?%5B%7B'), 'the argument is one encoded array');
  assert.deepEqual(bad.comments[0].body.isTrusted, { enabledCommands: ['impactTree.openCaller'] }, 'only that command may run from the note');
  assert.equal(bad.comments[0].body.supportHtml, false);
  assert.equal(bad.label, 'Changed');
});

test('a same-behaviour note says only what the agent said, then the engine\'s sentence and who wrote it', () => {
  const env = setup();
  const [, reach] = env.on('file:a.ts');
  const [head, ...rest] = bodyOf(reach).split('\n\n');
  assert.equal(head, '**Same behaviour, new way** — reads the file in one call');
  assert.equal(rest.length, 2, 'no before, after, when or affects: nothing the agent did not say is added');
  assert.equal(rest[0], '_Only the body changed: the signature is the same, so callers still compile. 1 of 1 caller is unchanged, which is expected; check it still gets the behaviour it relies on._');
  assert.equal(rest[1], '_Written by your agent; the facts come from the engine._');
});

test('the agent\'s text stays text: no link, image, code, HTML or command link comes from it', () => {
  const hostile = { id: 'a.ts#100', kind: 'changed', what: '[x](command:impactTree.undoAgentResult) <b>hi</b> `code` ![i](http://e/x.png)\nnext line',
    affects: [{ name: '[evil](command:foo)', how: '*bold* _it_' }] };
  const body = noteMarkdown(hostile, { verdict: 'v.', callers: [] });
  assert.ok(!/(^|[^\\])\[/.test(body.replace(/\*\*Affects:\*\*[\s\S]*$/, '')), 'every [ of the agent\'s is escaped');
  assert.ok(!body.includes('<b>') && !body.includes('\n\nnext') && !body.includes('![i]'));
  assert.equal(escapeNote('a_b *c* <d> [e] `f` & g|h'), 'a\\_b \\*c\\* \\<d\\> \\[e\\] \\`f\\` \\& g\\|h');
  const link = noteMarkdown({ ...hostile, affects: [{ name: 'user (a)', how: 'h' }] }, { verdict: 'v', callers: [{ label: 'user', file: '/r/b.ts', pos: 1 }] });
  assert.match(link, /\[user \(a\)\]\(command:impactTree\.openCaller\?[^()\s]*\)/, 'a bracket in a caller name does not end the link; parentheses in its argument are encoded');
});

test('the plain text for the pull request is the note without the two closing lines', () => {
  assert.equal(notePlainText(PAYLOAD.changes[0]), [
    'Changed — rejects tokens whose header is not {alg, typ:"JWT"}',
    'Before: any header',
    'After: JwtHeaderInvalid',
    'When: typ is missing',
    'Affects:\n- user (middleware) — now answers 401 for a bad header\n- cron job — logs a warning',
  ].join('\n\n'));
  assert.equal(notePlainText(PAYLOAD.changes[2]), 'New — takes a stream');
});

// ---- expansion ---------------------------------------------------------------------------

test('a thread is expanded when its change needs attention and collapsed otherwise; a mark does not change it', () => {
  const env = setup();
  const [bad, reach] = env.on('file:a.ts');
  assert.deepEqual([bad.collapsibleState, reach.collapsibleState], [Expanded, Collapsed], 'the engine flags `bad` (level 0); `reach` is at level 3');
  env.set(reviewOf({ attention: new Set(['a.ts#500']) }));
  assert.deepEqual([bad.collapsibleState, reach.collapsibleState], [Expanded, Expanded], 'the agent named `reach` in attention (G15)');
  env.state.reviewed.add(BAD); env.state.reviewed.add(REACH);
  env.threads.redraw();
  assert.deepEqual([bad.collapsibleState, reach.collapsibleState], [Expanded, Expanded], 'looked at, still as it was');
  env.set(reviewOf());
  assert.deepEqual([bad.collapsibleState, reach.collapsibleState], [Expanded, Collapsed], 'the attention set changed: recomputed');
  // A thread the reviewer closed stays closed across a redraw that changes nothing about it.
  bad.collapsibleState = Collapsed;
  env.threads.redraw();
  assert.equal(bad.collapsibleState, Collapsed);
});

// ---- lifetime ----------------------------------------------------------------------------

test('a redraw keeps the thread objects of notes that did not change', () => {
  const env = setup();
  const before = env.on('file:a.ts');
  env.set(reviewOf());   // the same result, a new object
  assert.deepEqual(env.on('file:a.ts'), before, 'the same objects');
  assert.equal(env.controller.threads.length, 3, 'nothing was created or disposed');
  env.show(['file:a.ts', 'file:b.ts']);
  assert.equal(env.on('file:a.ts')[0], before[0]);
  env.show(['file:b.ts']);
  assert.ok(before.every((t) => t.disposed), 'a document that is no longer visible has no threads');
});

test('Undo, the engine\'s cards and a result that does not fit the branch dispose every thread', () => {
  for (const [what, none] of [['Undo: no result', reviewOf({ notes: null, hasResult: false, resultKey: null })],
    ['the engine\'s cards asked for', reviewOf({ notes: null, showEngine: true })],
    ['a result for another state of the branch', reviewOf({ stale: true })]]) {
    const env = setup({ docs: ['file:a.ts', 'file:b.ts'] });
    const drawn = env.live();
    assert.equal(drawn.length, 3, what);
    env.set(none);
    assert.ok(drawn.every((t) => t.disposed), what);
    assert.equal(env.live().length, 0, what);
    env.threads.redraw();
    assert.equal(env.live().length, 0, `${what}: a redraw draws nothing either`);
    env.set(reviewOf());
    assert.equal(env.live().length, 3, `${what}: and a result that fits draws again`);
  }
});

test('a new result replaces every thread, even one whose note is the same', () => {
  const env = setup();
  const before = env.live();
  env.set(reviewOf({ resultKey: 'k2' }));
  assert.ok(before.every((t) => t.disposed), 'nothing outlives the result it came from');
  assert.equal(env.live().length, 3);
  assert.equal(env.live().filter((t) => before.includes(t)).length, 0);
});

test('no editor shows the review before the agent has a result: nothing is drawn, and disposal ends it all', () => {
  const env = setup({ review: reviewOf({ notes: null, hasResult: false, resultKey: null }) });
  assert.equal(env.live().length, 0);
  env.set(reviewOf());
  assert.equal(env.live().length, 3);
  const threads = env.live();
  env.threads.dispose();
  assert.equal(env.controller.disposed, true);
  assert.ok(threads.every((t) => t.disposed));
  assert.equal(env.commands.size, 0, 'the commands are gone');
  assert.equal(env.agent.count(), 0, 'and the subscription');
});

// ---- the title actions -------------------------------------------------------------------

const menus = require('../package.json').contributes.menus['comments/commentThread/title'].filter((m) => /impactTree\.agent\b/.test(m.when));
const shows = (command, thread) => {
  const entry = menus.find((m) => m.command === command);
  const re = new RegExp(/commentThread =~ \/(.*)\/$/.exec(entry.when)[1].replace(/\\\\/g, '\\'));
  return re.test(thread.contextValue);
};

test('Mark reviewed marks the change\'s row and the menu then says Mark not reviewed; the next one undoes it', async () => {
  const env = setup();
  const [bad] = env.on('file:a.ts');
  assert.deepEqual([shows(COMMANDS.markReviewed, bad), shows(COMMANDS.markNotReviewed, bad)], [true, false]);
  await env.run(COMMANDS.markReviewed, bad);
  assert.equal(env.state.reviewed.has(BAD), true);
  assert.deepEqual([shows(COMMANDS.markReviewed, bad), shows(COMMANDS.markNotReviewed, bad)], [false, true]);
  assert.equal(env.on('file:a.ts')[0], bad, 'the same thread');
  await env.run(COMMANDS.markNotReviewed, bad);
  assert.equal(env.state.reviewed.has(BAD), false);
  assert.deepEqual([shows(COMMANDS.markReviewed, bad), shows(COMMANDS.markNotReviewed, bad)], [true, false]);
  // The mark made elsewhere (the tree, a lens) is what the thread reads next time.
  env.state.reviewed.add(BAD);
  env.threads.redraw();
  assert.equal(shows(COMMANDS.markNotReviewed, bad), true);
});

test('Reply in next round starts a feedback draft at the change; it is offered only when one can be started', async () => {
  const env = setup();
  const [bad] = env.on('file:a.ts');
  assert.equal(shows(COMMANDS.replyNextRound, bad), true);
  await env.run(COMMANDS.replyNextRound, bad);
  assert.deepEqual(env.state.feedbackStarted, [BAD]);
  assert.deepEqual(env.state.reviewStarted, [], 'and nothing for the pull request');
  env.state.feedback = false;
  env.threads.redraw();
  assert.equal(shows(COMMANDS.replyNextRound, bad), false, 'hidden when no local review or checked-out pull request is shown');
  await env.run(COMMANDS.replyNextRound, bad);
  assert.equal(env.state.feedbackStarted.length, 1, 'and refused if run anyway');
  assert.match(env.state.warnings.at(-1), /feedback can be started only while a local review or a checked-out pull request/);
});

test('Post to the PR opens the GitHub draft with the note\'s text for editing and sends nothing; it is offered only with a pull request under review', async () => {
  const env = setup({ post: false });
  const [bad] = env.on('file:a.ts');
  assert.equal(shows(COMMANDS.postToPr, bad), false, 'a local review has no Post');
  await env.run(COMMANDS.postToPr, bad);
  assert.deepEqual(env.state.reviewStarted, [], 'refused if run anyway');
  assert.match(env.state.warnings.at(-1), /only on a pull request under review/);
  env.state.post = true;
  env.threads.redraw();
  assert.equal(shows(COMMANDS.postToPr, bad), true);
  await env.run(COMMANDS.postToPr, bad);
  assert.deepEqual(env.state.reviewStarted, [[BAD, notePlainText(PAYLOAD.changes[0])]]);
  assert.ok(!env.state.reviewStarted[0][1].includes('Written by your agent'), 'not the two lines about this view');
});

test('an action on a thread that is not a note of the result shown does nothing', async () => {
  const env = setup();
  const [bad] = env.on('file:a.ts');
  env.set(reviewOf({ notes: null, hasResult: false, resultKey: null }));
  for (const name of Object.values(COMMANDS)) await env.run(name, bad);
  for (const name of Object.values(COMMANDS)) await env.run(name, { not: 'a thread' });
  assert.deepEqual([env.state.reviewed.size, env.state.feedbackStarted.length, env.state.reviewStarted.length], [0, 0, 0]);
});

// ---- the lens and the whole extension ------------------------------------------------------

test('the CodeLens has no agent line: a change the agent described keeps the engine\'s lens and a fine one gets none', () => {
  const rows = [BAD, REACH, QUIET];
  const plan = lensPlan(rows, () => false);
  assert.deepEqual(plan.map((e) => lensTitles(e)), [{ verdict: '1 of 1 caller not updated', callers: 'Show callers', tick: 'Mark reviewed' }]);
  assert.ok(agentNotes(PAYLOAD).change(changeIdOf(REACH)), '`reach` has a note, so a thread');
  assert.equal(plan.length, 1, 'and so no lens of its own');
  assert.equal(NO_AGENT_ATTENTION.size, 0);
});

test('the extension creates the controller and registers the four actions; with no agent result it draws nothing', () => withEnv(async (env) => {
  const controller = env.commentController('impactTree.agent');
  assert.equal(controller.label, 'Impact Tree: your agent\'s notes');
  assert.equal(controller.commentingRangeProvider, undefined);
  assert.equal(controller.threads.length, 0);
  await env.refresh();
  assert.equal(controller.threads.filter((t) => !t.disposed).length, 0, 'an analysis without an agent result');
  for (const name of Object.values(COMMANDS)) await env.run(name, { not: 'a thread' });
  assert.ok(env.commentController('impactTree.review') && env.commentController('impactTree.feedback'), 'beside the other two');
}));
