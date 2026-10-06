'use strict';
// The Pull Request tab's adapter: opening and revealing the tab, the message boundary
// (token and shape), the approve check, submit and discard through the store, the kept
// summary draft, closing with the review, the status bar item, the context key, the jump
// to a thread and disposal. The store and the tree are fakes with explicit promises; the
// webview panel is the shared fake, which runs the page's real script.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPullRequestPanel, parseMessage, MAX_DRAFTS } = require('../src/pr-overview-panel');
const { fakeWebviewPanel, deferred } = require('./extension-env');
const vscodeStub = require('./vscode-stub');

const TARGET = Object.freeze({ owner: 'o', name: 'r', number: 7, headOid: 'a'.repeat(40) });
const comment = (id, over = {}) => ({ id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', pending: false, mine: false, url: `https://x/${id}`, ...over });
const thread = (id, over = {}, comments = [comment(id)]) => ({ id: `T_${id}`, path: 'src/a.js', side: 'RIGHT', line: 10, originalLine: 10,
  startLine: null, isResolved: false, isOutdated: false, fileLevel: false, canResolve: true, canUnresolve: false, canReply: true, comments, ...over });
function reviewModel({ number = 7, threads = [], pending = null, own = false, title = 'Make it better' } = {}) {
  return {
    pr: { id: `PR_${number}`, number, title, body: 'b', url: 'https://x', state: 'OPEN', author: { login: 'alice', avatarUrl: null },
      viewerDidAuthor: own, headRefOid: 'a'.repeat(40), baseRefOid: 'c'.repeat(40), headRefName: 'feature', baseRefName: 'main' },
    threads, pendingReview: pending, viewed: new Map(), timeline: [], incomplete: [],
  };
}
const ready = (model = reviewModel(), target = TARGET) => ({ kind: 'ready', target, model });
const PENDING = { id: 'R_1', databaseId: 1, commentCount: 2 };
const withPending = () => ready(reviewModel({ pending: PENDING, threads: [thread(1, {}, [comment(1, { pending: true, mine: true })])] }));

// Lets queued promise reactions run; no wall clock.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeStore(initial) {
  let state = initial;
  const listeners = new Set();
  const calls = { submit: [], discard: 0, refresh: 0 };
  // Each mutation answers with the next queued answer (a value or a promise), else ok.
  const answers = { submit: [], discard: [] };
  return {
    calls, answers,
    getState: () => state,
    onDidChange(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    set(next) { state = next; for (const l of [...listeners]) l({ paths: null }); },
    listeners: () => listeners.size,
    submitReview(input) { calls.submit.push(input); return Promise.resolve(answers.submit.shift() ?? { ok: true }); },
    discardPendingReview() { calls.discard++; return Promise.resolve(answers.discard.shift() ?? { ok: true }); },
    async refresh() { calls.refresh++; },
  };
}

function fakeProvider() {
  const listeners = [];
  const provider = {
    attention: [], counts: { total: 3, left: 0 },
    attentionLeft: () => provider.attention, reviewCounts: () => provider.counts,
    onDidChangeReview(l) { listeners.push(l); return { dispose() {} }; },
    onDidChangePresentation(l) { listeners.push(l); return { dispose() {} }; },
    fire() { for (const l of listeners) l({}); },
  };
  return provider;
}

function setup(initial = ready(), { modalAnswer = 'Cancel review' } = {}) {
  const seen = { infos: [], errors: [], warnings: [], modals: [], contexts: {}, executed: [], panels: [], bars: [], opened: [], revealedRows: [], log: [] };
  const commands = new Map();
  const vscode = {
    ...vscodeStub,
    ViewColumn: { Active: -1 },
    window: {
      createWebviewPanel: (...args) => { const p = fakeWebviewPanel(...args); seen.panels.push(p); return p; },
      createStatusBarItem: (alignment, priority) => {
        const item = { alignment, priority, text: '', visible: false, disposed: false,
          show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; this.visible = false; } };
        seen.bars.push(item);
        return item;
      },
      showInformationMessage: (m) => { seen.infos.push(m); },
      showErrorMessage: (m) => { seen.errors.push(m); },
      showWarningMessage: async (m, options, ...items) => {
        if (options && options.modal) { seen.modals.push({ m, options, items }); return modalAnswer; }
        seen.warnings.push(m);
        return undefined;
      },
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return { dispose: () => commands.delete(name) }; },
      executeCommand: async (name, ...args) => {
        if (name === 'setContext') { seen.contexts[args[0]] = args[1]; return undefined; }
        seen.executed.push([name, ...args]);
        return commands.has(name) ? commands.get(name)(...args) : undefined;
      },
    },
  };
  const store = fakeStore(initial);
  const provider = fakeProvider();
  const rows = { result: true };
  const created = createPullRequestPanel(vscode, {
    store, provider, log: (m) => seen.log.push(m),
    revealRow: async (id) => { seen.revealedRows.push(id); return rows.result; },
    openFile: async (node) => { seen.opened.push(node); },
  });
  const panel = () => seen.panels.at(-1);
  const page = () => panel().page;
  return {
    seen, store, provider, commands, rows, created, panel, page,
    run: (name, ...args) => commands.get(name)(...args),
    open: () => commands.get('impactTree.showPullRequest')(),
    // A message as the current page's script sends it, carrying its own token. Like the
    // page, it does not wait for the extension to finish handling it.
    send(message) { panel().send({ ...message, token: tokenOf(panel()) }); return settle(); },
    dispose() { for (const d of created.disposables) d.dispose(); },
  };
}
const tokenOf = (panel) => /<script nonce="([^"]+)"/.exec(panel.webview.html)[1];
const textOf = (panel) => panel.webview.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// ---- opening ------------------------------------------------------------------------

test('opens one tab per pull request with a locked-down webview, and reveals it when asked again', async () => {
  const env = setup();
  env.open();
  assert.equal(env.seen.panels.length, 1);
  const panel = env.panel();
  assert.equal(panel.viewType, 'impactTree.pullRequest');
  assert.equal(panel.title, 'Pull Request #7');
  assert.deepEqual(panel.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.equal(panel.options.retainContextWhenHidden, false);
  assert.match(textOf(panel), /Make it better #7/);
  env.run('impactTree.submitReview');
  assert.equal(env.seen.panels.length, 1, 'the tree title command opens the same tab');
  assert.equal(panel.reveals, 1);
  env.dispose();
});

test('without a pull request review there is no tab, only a message', () => {
  const env = setup({ kind: 'none' });
  env.open();
  assert.equal(env.seen.panels.length, 0);
  assert.match(env.seen.infos[0], /no pull request is under review/);
  env.dispose();
});

test('while the review loads the tab says so, then shows the data when it arrives', () => {
  const env = setup({ kind: 'loading', target: TARGET, previous: null });
  env.open();
  assert.match(textOf(env.panel()), /Loading pull request #7/);
  env.store.set(ready());
  assert.match(textOf(env.panel()), /Make it better #7/);
  env.dispose();
});

// ---- the message boundary -----------------------------------------------------------

test('parseMessage accepts only the documented shapes with the current token', () => {
  const t = 'tok';
  const ok = [
    [{ type: 'submit', event: 'APPROVE', body: '', approveAnyway: false }, { type: 'submit', event: 'APPROVE', body: '', approveAnyway: false }],
    [{ type: 'discard' }, { type: 'discard' }], [{ type: 'retry' }, { type: 'retry' }], [{ type: 'ready' }, { type: 'ready' }],
    [{ type: 'revealThread', threadId: 'T_1' }, { type: 'revealThread', threadId: 'T_1' }],
    [{ type: 'revealRow', rowId: 'finding:a:b:1' }, { type: 'revealRow', rowId: 'finding:a:b:1' }],
    [{ type: 'draft', body: 'x' }, { type: 'draft', body: 'x' }],
  ];
  for (const [message, parsed] of ok) assert.deepEqual(parseMessage({ ...message, token: t, extra: 1 }, t), parsed);
  const bad = [
    null, 'submit', [], { type: 'discard' }, { type: 'discard', token: 'other' },
    { type: 'submit', event: 'MERGE', body: '', approveAnyway: false, token: t },
    { type: 'submit', event: 'COMMENT', body: 3, approveAnyway: false, token: t },
    { type: 'submit', event: 'COMMENT', body: 'x', token: t },
    { type: 'submit', event: 'COMMENT', body: 'x', approveAnyway: 'yes', token: t },
    { type: 'submit', event: 'COMMENT', body: 'x'.repeat(262145), approveAnyway: false, token: t },
    { type: 'revealThread', threadId: '', token: t }, { type: 'revealThread', threadId: 5, token: t },
    { type: 'revealRow', token: t }, { type: 'draft', token: t }, { type: 'merge', token: t },
  ];
  for (const message of bad) assert.equal(parseMessage(message, t), null, JSON.stringify(message)?.slice(0, 80));
  assert.equal(parseMessage({ type: 'ready', token: null }, null), null, 'no page, no messages');
});

test('messages with no token, a wrong one, or an older page\'s token do nothing', async () => {
  const env = setup(ready(reviewModel({ threads: [thread(1)] })));
  env.open();
  const oldToken = tokenOf(env.panel());
  env.store.set(ready(reviewModel({ title: 'Renamed' })));
  assert.notEqual(tokenOf(env.panel()), oldToken, 'a new render has a new token');
  for (const token of [undefined, 'forged', oldToken]) {
    await env.panel().send({ type: 'submit', event: 'COMMENT', body: 'x', approveAnyway: false, token });
    await env.panel().send({ type: 'revealThread', threadId: 'T_1', token });
    await env.panel().send({ type: 'retry', token });
    await env.panel().send({ type: 'discard', token });
  }
  await settle();
  assert.deepEqual(env.store.calls, { submit: [], discard: 0, refresh: 0 });
  assert.deepEqual(env.seen.executed, []);
  assert.equal(env.seen.modals.length, 0);
  env.dispose();
});

// ---- submit -------------------------------------------------------------------------

test('each button calls submitReview with its event and the summary', async () => {
  for (const event of ['COMMENT', 'REQUEST_CHANGES', 'APPROVE']) {
    const env = setup();
    env.open();
    await env.send({ type: 'submit', event, body: 'summary', approveAnyway: false });
    assert.deepEqual(env.store.calls.submit, [{ event, body: 'summary' }], event);
    env.dispose();
  }
});

test('the page\'s own buttons reach the store through the real script', async () => {
  const env = setup();
  env.open();
  env.page().type('summary', 'Please rename');
  env.page().click('requestChanges');
  await settle();
  assert.deepEqual(env.store.calls.submit, [{ event: 'REQUEST_CHANGES', body: 'Please rename' }]);
  env.dispose();
});

test('the approve check refuses Approve without "Approve anyway" and does not call the store', async () => {
  const env = setup(ready(reviewModel({ threads: [thread(1)] })));
  env.provider.attention = [{ type: 'finding', label: 'bad', pos: 3, finding: { relPath: 'a.ts' } }];
  env.provider.counts = { total: 3, left: 1 };
  env.open();
  await env.send({ type: 'submit', event: 'APPROVE', body: 'ok', approveAnyway: false });
  assert.deepEqual(env.store.calls.submit, []);
  assert.match(textOf(env.panel()), /Not approved: tick “Approve anyway” first/);
  assert.equal(env.page().el('summary').value, 'ok', 'the summary is kept');
  await env.send({ type: 'submit', event: 'APPROVE', body: 'ok', approveAnyway: true });
  assert.deepEqual(env.store.calls.submit, [{ event: 'APPROVE', body: 'ok' }]);
  env.dispose();
});

test('the check follows the tree: once the rows are reviewed and no thread is open, Approve needs no box', async () => {
  const env = setup();
  env.provider.attention = [{ type: 'finding', label: 'bad', pos: 3, finding: { relPath: 'a.ts' } }];
  env.provider.counts = { total: 3, left: 1 };
  env.open();
  assert.ok(env.page().el('approve').hasAttribute('disabled'));
  const loads = env.panel().loads;
  env.provider.fire();
  assert.equal(env.panel().loads, loads, 'a tick that changes nothing shown does not repaint');
  env.provider.attention = [];
  env.provider.counts = { total: 3, left: 0 };
  env.provider.fire();
  assert.equal(env.page().el('check'), null);
  assert.ok(!env.page().el('approve').hasAttribute('disabled'));
  await env.send({ type: 'submit', event: 'APPROVE', body: '', approveAnyway: false });
  assert.deepEqual(env.store.calls.submit, [{ event: 'APPROVE', body: '' }]);
  env.dispose();
});

test('success: the info message names what was done, and the kept summary is cleared', async () => {
  const env = setup(withPending());
  env.open();
  env.page().type('summary', 'Great work');
  env.page().runTimers();
  await settle();
  await env.send({ type: 'submit', event: 'APPROVE', body: 'Great work', approveAnyway: false });
  assert.deepEqual(env.seen.infos, ['Review submitted: you approved on PR #7']);
  assert.equal(env.page().el('summary').value, '');
  env.panel().dispose();
  env.open();
  assert.equal(env.page().el('summary').value, '', 'a reopened tab starts empty');
  env.dispose();
});

test('failure: the summary stays, the error is shown in the tab and as a message, and the store\'s refusal too', async () => {
  const env = setup(withPending());
  env.open();
  env.store.answers.submit.push({ ok: false, error: new Error('GitHub said no') });
  await env.send({ type: 'submit', event: 'COMMENT', body: 'my words', approveAnyway: false });
  assert.match(textOf(env.panel()), /The review was not submitted: GitHub said no/);
  assert.equal(env.page().el('summary').value, 'my words');
  assert.deepEqual(env.seen.errors, ['Impact Tree: The review was not submitted: GitHub said no']);
  assert.deepEqual(env.seen.infos, []);
  assert.match(textOf(env.panel()), /Your pending review has 2 comments/, 'pending comments are still listed');
  env.panel().dispose();
  env.open();
  assert.equal(env.page().el('summary').value, 'my words', 'reopening keeps the text');
  // The store refuses too (a rule): its reason is shown the same way.
  const refusal = Object.assign(new Error('requesting changes needs a summary'), { code: 'rule' });
  env.store.answers.submit.push({ ok: false, error: refusal });
  await env.send({ type: 'submit', event: 'REQUEST_CHANGES', body: '', approveAnyway: false });
  assert.match(textOf(env.panel()), /The review was not submitted: requesting changes needs a summary/);
  env.dispose();
});

test('while a submit runs the buttons are disabled, and a second submit is ignored', async () => {
  const env = setup(withPending());
  env.open();
  const answer = deferred();
  env.store.answers.submit.push(answer.promise);
  await env.send({ type: 'submit', event: 'COMMENT', body: 'x', approveAnyway: false });
  for (const name of ['approve', 'requestChanges', 'comment', 'cancel']) assert.ok(env.page().el(name).hasAttribute('disabled'), name);
  assert.match(textOf(env.panel()), /Submitting your review…/);
  await env.send({ type: 'submit', event: 'COMMENT', body: 'x', approveAnyway: false });
  await env.send({ type: 'discard' });
  assert.equal(env.store.calls.submit.length, 1);
  assert.equal(env.seen.modals.length, 0);
  answer.resolve({ ok: true });
  await settle();
  assert.ok(!env.page().el('comment').hasAttribute('disabled'));
  env.dispose();
});

test('a submit that finishes after its tab closed publishes nothing to a page', async () => {
  const env = setup(withPending());
  env.open();
  const answer = deferred();
  env.store.answers.submit.push(answer.promise);
  await env.send({ type: 'submit', event: 'COMMENT', body: 'x', approveAnyway: false });
  const first = env.panel();
  env.store.set(ready(reviewModel({ number: 8 }), { ...TARGET, number: 8 }));
  assert.ok(first.disposed, 'another pull request closes the tab');
  answer.resolve({ ok: true });
  await settle();
  assert.deepEqual(env.seen.log.filter((m) => /disposed/.test(m)), [], 'nothing was written to the closed webview');
  assert.deepEqual(env.seen.infos, ['Review submitted: you commented on PR #7'], 'the review was submitted, so the user is told');
  env.dispose();
});

// ---- the kept draft -----------------------------------------------------------------

test('the summary survives a re-render, a reload of the page and a reopen', async () => {
  const env = setup();
  env.open();
  env.page().type('summary', 'half a thought');
  env.page().runTimers();
  await settle();
  env.store.set(ready(reviewModel({ title: 'New title' })));
  assert.equal(env.page().el('summary').value, 'half a thought', 'restored in the new document');
  // VS Code reloads a hidden tab from its last document; the page asks for the draft.
  env.page().type('summary', 'half a thought, finished');
  env.page().runTimers();
  await settle();
  env.panel().webview.html = env.panel().webview.html;
  await settle();
  assert.equal(env.page().el('summary').value, 'half a thought, finished');
  env.panel().dispose();
  env.open();
  assert.equal(env.page().el('summary').value, 'half a thought, finished');
  env.dispose();
});

test('drafts are kept per pull request, and only the most recent ones', async () => {
  const env = setup();
  env.open();
  await env.send({ type: 'draft', body: 'for seven' });
  for (let n = 100; n < 100 + MAX_DRAFTS; n++) {
    env.store.set(ready(reviewModel({ number: n }), { ...TARGET, number: n }));
    env.open();
    await env.send({ type: 'draft', body: `for ${n}` });
  }
  env.store.set(ready(reviewModel({ number: 100 }), { ...TARGET, number: 100 }));
  env.open();
  assert.equal(env.page().el('summary').value, 'for 100');
  env.store.set(ready());
  env.open();
  assert.equal(env.page().el('summary').value, '', 'the oldest draft was dropped past the limit');
  env.dispose();
});

// ---- discard ------------------------------------------------------------------------

test('Cancel review asks first; declining sends nothing, confirming discards through the store', async () => {
  const declined = setup(withPending(), { modalAnswer: null });   // the dialog closed
  declined.open();
  await declined.send({ type: 'discard' });
  assert.equal(declined.seen.modals.length, 1);
  assert.match(declined.seen.modals[0].m, /Cancel your pending review on PR #7\?/);
  assert.match(declined.seen.modals[0].options.detail, /2 comments will be deleted/);
  assert.equal(declined.store.calls.discard, 0);
  declined.dispose();

  const env = setup(withPending());
  env.open();
  await env.send({ type: 'discard' });
  assert.equal(env.store.calls.discard, 1);
  assert.match(env.seen.infos[0], /pending review on PR #7 was cancelled/);
  env.store.answers.discard.push({ ok: false, error: new Error('network down') });
  await env.send({ type: 'discard' });
  assert.match(textOf(env.panel()), /The pending review was not cancelled: network down/);
  assert.equal(env.seen.errors.length, 1);
  env.dispose();
});

// ---- closing with the review --------------------------------------------------------

test('the tab closes when the pull request review ends or moves to another pull request, not on a new head', () => {
  const env = setup();
  env.open();
  env.store.set({ kind: 'loading', target: { ...TARGET, headOid: 'b'.repeat(40) }, previous: reviewModel() });
  assert.ok(!env.panel().disposed, 'same pull request, new head: still open');
  env.store.set({ kind: 'none' });
  assert.ok(env.panel().disposed);
  assert.equal(env.panel().listeners(), 0, 'its message subscription is gone');
  env.store.set(ready());
  env.open();
  env.store.set(ready(reviewModel({ number: 8 }), { ...TARGET, number: 8 }));
  assert.ok(env.panel().disposed);
  assert.equal(env.seen.panels.length, 2);
  env.dispose();
});

// ---- links --------------------------------------------------------------------------

test('a pending comment jumps to its thread: the command opens the file at the thread\'s line', async () => {
  const threads = [
    thread(1, {}, [comment(1, { pending: true, mine: true })]),
    thread(2, { path: 'b.js', side: 'LEFT', line: 4 }, [comment(2, { pending: true, mine: true })]),
    thread(3, { path: 'c.js', fileLevel: true, line: null }, [comment(3, { pending: true, mine: true })]),
  ];
  const env = setup(ready(reviewModel({ threads, pending: { id: 'R', databaseId: null, commentCount: 3 } })));
  env.open();
  for (const link of env.page().all('[data-act="revealThread"]')) env.page().click(link);
  await settle();
  assert.deepEqual(env.seen.executed.map((e) => e[1]), ['T_1', 'T_2', 'T_3']);
  assert.deepEqual(env.seen.opened, [
    { relPath: 'src/a.js', ranges: [[10, 10]] }, { relPath: 'b.js', ranges: [] }, { relPath: 'c.js', ranges: [] },
  ]);
  assert.equal(await env.run('impactTree.revealReviewThread', 'T_gone'), false);
  assert.equal(await env.run('impactTree.revealReviewThread', 42), false);
  assert.equal(env.seen.opened.length, 3);
  env.dispose();
});

test('an attention row in the check goes to the row in the tree; Retry refreshes the store', async () => {
  const env = setup({ kind: 'failed', target: TARGET, error: new Error('boom'), previous: reviewModel() });
  env.provider.attention = [{ type: 'finding', label: 'bad', pos: 3, finding: { relPath: 'a.ts' } }];
  env.provider.counts = { total: 3, left: 1 };
  env.open();
  env.page().click(env.page().all('[data-act="revealRow"]')[0]);
  await settle();
  assert.deepEqual(env.seen.revealedRows, ['finding:a.ts:bad:3']);
  env.rows.result = false;
  env.page().click(env.page().all('[data-act="revealRow"]')[0]);
  await settle();
  assert.match(env.seen.infos.at(-1), /not in the tree any more/);
  env.page().click(env.page().all('[data-act="retry"]')[0]);
  await settle();
  assert.equal(env.store.calls.refresh, 1);
  env.dispose();
});

// ---- status bar and context key -----------------------------------------------------

test('the status bar shows a pending review with comments and opens the tab; the context key follows the review', () => {
  const env = setup({ kind: 'none' });
  const bar = env.seen.bars[0];
  assert.equal(bar.visible, false);
  assert.equal(bar.command, 'impactTree.showPullRequest');
  assert.equal(env.seen.contexts['impactTree.hasPullRequestReview'], false);
  env.store.set({ kind: 'loading', target: TARGET, previous: null });
  assert.equal(env.seen.contexts['impactTree.hasPullRequestReview'], true);
  assert.equal(bar.visible, false);
  env.store.set(withPending());
  assert.equal(bar.visible, true);
  assert.equal(bar.text, '✎ 2 pending · Submit review…');
  env.store.set(ready());
  assert.equal(bar.visible, false, 'no pending review');
  env.store.set(ready(reviewModel({ pending: { id: 'R', databaseId: null, commentCount: 0 } })));
  assert.equal(bar.visible, false, 'a pending review with no comments');
  env.store.set({ kind: 'none' });
  assert.equal(bar.visible, false);
  assert.equal(env.seen.contexts['impactTree.hasPullRequestReview'], false);
  env.dispose();
});

// ---- disposal -----------------------------------------------------------------------

test('dispose closes the tab, removes the bar, the commands and the store subscription', async () => {
  const env = setup(withPending());
  env.open();
  const panel = env.panel();
  env.dispose();
  assert.ok(panel.disposed);
  assert.equal(panel.listeners(), 0);
  assert.ok(env.seen.bars[0].disposed);
  assert.equal(env.store.listeners(), 0);
  assert.equal(env.commands.size, 0);
  env.store.set(ready());
  env.provider.fire();
  assert.equal(env.seen.panels.length, 1);
});

// ---- through the real activate() ----------------------------------------------------

const { withEnv, pull } = require('./extension-env');
const HEAD = 'a'.repeat(40);
const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
// GitHub's answer for PR #7: one resolved thread and, while `pending` is set, a pending
// review holding one of the viewer's comments in it.
function githubAnswer({ pending }) {
  const posted = { id: 'C_1', databaseId: 1, author: { login: 'bob', avatarUrl: null }, body: 'why?', createdAt: '2026-01-02T03:04:05Z',
    state: 'SUBMITTED', viewerDidAuthor: false, url: 'https://x/1', diffHunk: '@@ -3 +3 @@\n+const a = 1;' };
  const mine = { ...posted, id: 'C_2', databaseId: 2, body: 'rename', state: 'PENDING', viewerDidAuthor: true };
  return { repository: { pullRequest: {
    id: 'PR_7', number: 7, title: 'Seven', body: 'b', url: 'https://x', state: 'OPEN', author: null, viewerDidAuthor: false,
    headRefOid: HEAD, baseRefOid: 'c'.repeat(40), headRefName: 'f', baseRefName: 'main',
    reviewThreads: connection([{ id: 'T_1', isResolved: true, isOutdated: false, path: 'a.ts', line: 3, originalLine: 3, startLine: null,
      originalStartLine: null, diffSide: 'RIGHT', subjectType: 'LINE', viewerCanResolve: true, viewerCanUnresolve: true, viewerCanReply: true,
      comments: { totalCount: pending ? 2 : 1, pageInfo: { hasNextPage: false }, nodes: pending ? [posted, mine] : [posted] } }]),
    reviews: { nodes: pending ? [{ id: 'R_1', databaseId: 1, comments: { totalCount: 1 } }] : [] },
    files: connection([]), timelineItems: { nodes: [] },
  } } };
}
// A GitHub that answers loads from `github.pending` and records mutations; a submit ends
// the pending review.
function fakeGraphql() {
  const github = { pending: true, mutations: [] };
  github.graphql = async (query, variables) => {
    const name = /^(?:query|mutation) (\w+)/.exec(query)[1];
    if (query.startsWith('query')) return githubAnswer(github);
    github.mutations.push({ name, input: variables.input });
    if (name !== 'ImpactTreeSubmitReview') throw new Error(`unexpected mutation ${name}`);
    github.pending = false;
    return { submitPullRequestReview: { pullRequestReview: { id: 'R_1', state: 'COMMENTED' } } };
  };
  return github;
}
const flushAll = async () => { for (let i = 0; i < 10; i++) await settle(); };

test('wired: a local review has no PR tab, and the pending-review bar stays hidden', () => withEnv(async (env) => {
  await env.refresh();
  await flushAll();
  assert.equal(env.seen.contexts['impactTree.hasPullRequestReview'], false);
  assert.equal(env.seen.statusBars.length, 2, 'review progress and pending review');
  assert.equal(env.seen.statusBars[1].visible, false);
  await env.run('impactTree.showPullRequest');
  assert.equal(env.seen.panels.length, 0);
  assert.match(env.seen.infos.at(-1), /no pull request is under review/);
}));

test('wired: a PR preview with a pending review shows the bar; the tab submits through the store to GitHub', async () => {
  const github = fakeGraphql();
  await withEnv(async (env) => {
    await env.preview({ ...pull(7), headSha: HEAD });
    await flushAll();
    assert.equal(env.seen.contexts['impactTree.hasPullRequestReview'], true);
    const bar = env.seen.statusBars[1];
    assert.equal(bar.visible, true);
    assert.equal(bar.text, '✎ 1 pending · Submit review…');
    await env.run(bar.command);
    const panel = env.seen.panels[0];
    assert.equal(panel.title, 'Pull Request #7');
    assert.match(textOf(panel), /Your pending review has 1 comment: a\.ts:3 rename/);
    panel.page.click('comment');
    await flushAll();
    assert.deepEqual(github.mutations, [{ name: 'ImpactTreeSubmitReview', input: { pullRequestReviewId: 'R_1', event: 'COMMENT' } }]);
    assert.deepEqual(env.seen.infos, ['Review submitted: you commented on PR #7']);
    assert.equal(bar.visible, false, 'the reload shows no pending review');
    assert.match(textOf(panel), /Comment needs a summary or a pending comment/);
    // Leaving the PR review for a local one closes the tab and clears the key.
    await env.analyseLocally('pr');
    await flushAll();
    assert.ok(panel.disposed);
    assert.equal(env.seen.contexts['impactTree.hasPullRequestReview'], false);
  }, { graphql: github.graphql });
});

test('package.json declares the commands, the tree-title entry and their when clauses', () => {
  const pkg = require('../package.json');
  const ids = pkg.contributes.commands.map((c) => c.command);
  for (const id of ['impactTree.showPullRequest', 'impactTree.submitReview', 'impactTree.revealReviewThread']) assert.ok(ids.includes(id), id);
  const title = pkg.contributes.menus['view/title'].find((m) => m.command === 'impactTree.submitReview');
  assert.equal(title.when, 'view == impactTree.changes && impactTree.hasPullRequestReview');
  assert.ok(pkg.contributes.commands.find((c) => c.command === 'impactTree.submitReview').icon);
  assert.equal(pkg.contributes.menus.commandPalette.find((m) => m.command === 'impactTree.revealReviewThread').when, 'false');
});
