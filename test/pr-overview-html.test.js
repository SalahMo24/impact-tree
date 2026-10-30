'use strict';
// The Pull Request tab's document and its page script: what each store state shows, the
// escaping of everything GitHub sends, the submit rules as the page applies them while the
// reviewer types, and the messages the page sends. The adapter is tested in
// pr-overview-panel.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPullRequestHtml, pageModelOf, mergeStateOf, buttonRules, mergeRules, pendingStatusOf, submittedMessage, firstLineOf, formatWhen, refsBaseOf, OWN_PR_REASON,
} = require('../src/views/pr-tab/pr-overview-html');
const { createFormPage } = require('./webview-page');

const NONCE = 'bm9uY2UxMjM0NTY3OA==';
const TARGET = Object.freeze({ owner: 'o', name: 'r', number: 7, headOid: 'a'.repeat(40) });

const comment = (id, over = {}) => ({ id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', pending: false, mine: false, canEdit: false, url: `https://x/${id}`, commitOid: null, originalCommitOid: null, originalLine: null, originalStartLine: null, ...over });
const thread = (id, over = {}, comments = [comment(id)]) => ({ id: `T_${id}`, path: 'src/a.js', side: 'RIGHT', line: 10, originalLine: 10,
  startLine: null, isResolved: false, isOutdated: false, fileLevel: false, canResolve: true, canUnresolve: false, canReply: true, comments, ...over });

const CLEAN_OVERVIEW = Object.freeze({
  kind: 'ready',
  merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, isDraft: false, isMergeQueueEnabled: false,
    isInMergeQueue: false, methods: { merge: true, squash: true, rebase: true }, viewerPermission: 'WRITE', headMoved: false },
  labels: { items: [], more: 0 }, assignees: { items: [], more: 0 }, milestone: null, reviewers: { items: [], more: 0 }, checks: { kind: 'none' },
});

/** A normalised review model, as the store holds it. */
function reviewModel({ threads = [], pending = null, own = false, timeline = [], body = 'Fixes things.', incomplete = [], overview = CLEAN_OVERVIEW } = {}) {
  return {
    pr: { id: 'PR_7', number: 7, title: 'Make it better', body, url: 'https://x/7', state: 'OPEN', author: { login: 'alice', avatarUrl: null },
      viewerDidAuthor: own, headRefOid: 'a'.repeat(40), baseRefOid: 'c'.repeat(40), headRefName: 'feature', baseRefName: 'main' },
    threads, pendingReview: pending, viewed: new Map(), timeline, overview, incomplete,
  };
}
const ready = (model = reviewModel()) => ({ kind: 'ready', target: TARGET, model });
const PENDING_TWO = { id: 'R_1', databaseId: 1, commentCount: 2 };
// Two pending comments of the viewer's, one on a line and one on a file.
const pendingThreads = () => [
  thread(1, {}, [comment(1, { pending: true, mine: true, body: '\n  Rename this\nsecond line' })]),
  thread(2, { path: 'README.md', fileLevel: true, line: null, originalLine: null }, [comment(2, { pending: true, mine: true, body: 'Docs?' })]),
];

// A change row needing attention, as the tree hands it out.
const attentionRow = (label, relPath, pos) => ({ type: 'finding', label, pos, finding: { relPath } });
const NOTHING_LEFT = { attentionLeft: [], counts: { total: 4, left: 0, attention: 0, attentionTotal: 2 } };
const panel = (over = {}) => ({ ...NOTHING_LEFT, draft: '', error: null, busy: null, ...over });

const html = (state, over) => buildPullRequestHtml(pageModelOf(state, panel(over)), { nonce: NONCE, cspSource: 'vscode-webview://test' });
// The visible text, tags stripped.
const textOf = (doc) => doc.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// A start tag carrying `data-el="name"`.
const tagOf = (doc, name) => new RegExp(`<\\w+[^>]*data-el="${name}"[^>]*>`).exec(doc)?.[0] ?? null;
const isDisabled = (doc, name) => / disabled(?=[\s>])/.test(tagOf(doc, name));
const isHidden = (doc, name) => / hidden(?=[\s>])/.test(tagOf(doc, name));

test('everything GitHub sends is escaped text or sanitized markdown', () => {
  const evil = '<img src=x onerror="alert(1)"> & \'quotes\'\nline two';
  const model = reviewModel({
    body: evil,
    pending: PENDING_TWO,
    threads: [thread(1, { path: 'src/<b>.js' }, [comment(1, { pending: true, mine: true, body: evil })])],
    timeline: [{ kind: 'comment', id: 'I_1', author: { login: '<i>eve</i>', avatarUrl: null }, createdAt: '2026-01-02T03:04:05Z', body: evil, reviewState: null }],
  });
  model.pr.title = '<script>alert(1)</script>';
  model.pr.headRefName = 'x"><svg>';
  const doc = html(ready(model), { draft: '</textarea><script>bad()</script>' });
  assert.equal((doc.match(/<script/g) || []).length, 1, 'the only script element is the page\'s own');
  assert.ok(!doc.includes('<img'), 'no element from a body');
  assert.ok(!doc.includes('<svg'), 'no element from a branch name');
  assert.ok(!doc.includes('<i>eve'), 'no element from a login');
  assert.ok(!doc.includes('<b>.js'), 'no element from a path');
  assert.ok(doc.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(doc.includes('&lt;/textarea&gt;&lt;script&gt;bad()&lt;/script&gt;</textarea>'), 'the draft cannot close its textarea');
  assert.match(doc, /<div class="md" data-el="description"><p><span>\[image: image\]<\/span> &amp; 'quotes'<br>\nline two<\/p>\n<\/div>/,
    'the description is sanitized markdown: an image with no safe source is its placeholder, its handler is gone, and a single newline is a line break as GitHub draws it');
  assert.match(doc, /\.text \{ white-space: pre-wrap;/);
});

test('no inline style or event-handler attributes in any state; the CSP names the nonce', () => {
  const states = [
    { kind: 'loading', target: TARGET, previous: null },
    { kind: 'failed', target: TARGET, error: new Error('boom'), previous: null },
    ready(), ready(reviewModel({ own: true })), ready(reviewModel({ pending: PENDING_TWO, threads: pendingThreads() })),
    { kind: 'failed', target: TARGET, error: new Error('boom'), previous: reviewModel() },
  ];
  for (const state of states) {
    const doc = html(state, { attentionLeft: [attentionRow('bad', 'a.ts', 1)], counts: { total: 3, left: 2, attention: 1, attentionTotal: 1 } });
    assert.ok(!/\sstyle=/.test(doc), `${state.kind}: no style= attribute`);
    assert.ok(!/\son\w+=/.test(doc), `${state.kind}: no on…= attribute`);
    assert.match(doc, new RegExp(`script-src 'nonce-${NONCE}'`));
    assert.match(doc, new RegExp(`<script nonce="${NONCE}">`));
    assert.match(doc, /default-src 'none'; img-src https:\/\/github\.com https:\/\/\*\.githubusercontent\.com; style-src /);
  }
  assert.throws(() => buildPullRequestHtml(pageModelOf(ready(), panel()), { nonce: 'x"><script>', cspSource: 's' }), /base64/);
});

test('no pull request under review has no page', () => {
  assert.equal(pageModelOf({ kind: 'none' }, panel()), null);
});

test('loading without data says so; a failed load shows the error and Retry, and no form', () => {
  const loading = html({ kind: 'loading', target: TARGET, previous: null });
  assert.match(textOf(loading), /Loading pull request #7 from GitHub/);
  assert.equal(tagOf(loading, 'form'), null);
  const failed = html({ kind: 'failed', target: TARGET, error: new Error('rate limited until 12:00'), previous: null });
  assert.match(textOf(failed), /Could not load the review from GitHub: rate limited until 12:00/);
  assert.match(failed, /<button class="secondary" data-act="retry">Retry<\/button>/);
  assert.equal(tagOf(failed, 'form'), null);
});

test('a refresh shows the previous data with a note; a failed refresh keeps the data and offers Retry', () => {
  const refreshing = html({ kind: 'loading', target: TARGET, previous: reviewModel() });
  assert.match(textOf(refreshing), /Refreshing from GitHub/);
  assert.match(textOf(refreshing), /Make it better #7/);
  const failed = html({ kind: 'failed', target: TARGET, error: new Error('timeout'), previous: reviewModel() });
  assert.match(textOf(failed), /Could not load the review from GitHub: timeout/);
  assert.match(textOf(failed), /Make it better #7/);
  assert.notEqual(tagOf(failed, 'form'), null, 'the review can still be submitted from the data shown');
});

test('header: title, number, state, author and branches; an incomplete load says what is missing', () => {
  const text = textOf(html(ready(reviewModel({ incomplete: ['review threads: only the first 500 were loaded'] }))));
  assert.match(text, /Make it better #7 Open alice wants to merge into main from feature Refresh Open on GitHub alice opened this pull request Fixes things\./);
  assert.match(text, /Not everything was loaded: review threads: only the first 500 were loaded/);
  assert.match(textOf(html(ready(reviewModel({ body: '  ' })))), /No description provided\./);
});

test('timeline: oldest first, each with who, what and when', () => {
  const timeline = [
    { kind: 'review', id: 'R_a', author: { login: 'omar', avatarUrl: null }, createdAt: '2026-01-01T10:00:00Z', body: '', reviewState: 'CHANGES_REQUESTED' },
    { kind: 'comment', id: 'I_b', author: null, createdAt: '2026-01-02T11:30:59Z', body: 'ping', reviewState: null },
    { kind: 'review', id: 'R_c', author: { login: 'maria', avatarUrl: null }, createdAt: '2026-01-03T09:05:00Z', body: 'LGTM', reviewState: 'APPROVED' },
  ];
  const text = textOf(html(ready(reviewModel({ timeline }))));
  assert.match(text, /Timeline omar requested changes 2026-01-01 10:00 ghost commented 2026-01-02 11:30 ping maria approved 2026-01-03 09:05 LGTM/);
  assert.equal(formatWhen('yesterday'), 'yesterday');
});

test('no pending review: Comment, no Cancel review; Request Changes and Comment wait for a summary', () => {
  const doc = html(ready());
  assert.match(doc, /data-el="comment"[^>]*>Comment<\/button>/);
  assert.equal(tagOf(doc, 'cancel'), null);
  assert.ok(isDisabled(doc, 'requestChanges'));
  assert.ok(isDisabled(doc, 'comment'));
  assert.ok(!isDisabled(doc, 'approve'), 'nothing stands against approving');
  assert.match(textOf(doc), /Request Changes needs a summary\. Comment needs a summary or a pending comment\./);
  assert.ok(isHidden(doc, 'reason-approve'));
  const typed = html(ready(), { draft: 'Looks fine' });
  assert.ok(!isDisabled(typed, 'requestChanges'));
  assert.ok(!isDisabled(typed, 'comment'));
  assert.ok(isHidden(typed, 'reason-requestChanges') && isHidden(typed, 'reason-comment'));
});

test('a pending review: Submit Review, Cancel review, and its comments listed, each jumping to its thread', () => {
  const doc = html(ready(reviewModel({ pending: PENDING_TWO, threads: [...pendingThreads(), thread(3)] })));
  assert.match(doc, /data-el="comment"[^>]*>Submit Review<\/button>/);
  assert.ok(!isDisabled(doc, 'comment'), 'pending comments are enough for a comment review');
  assert.ok(isDisabled(doc, 'requestChanges'), 'request changes still needs a summary');
  assert.match(doc, /<button class="secondary cancel" data-act="discard" data-el="cancel">Cancel review<\/button>/);
  const text = textOf(doc);
  assert.match(text, /Your pending review has 2 comments: src\/a\.js:10 Rename this README\.md · file comment Docs\?/);
  assert.ok(!text.includes('body 3'), 'a posted comment is not pending');
  assert.deepEqual([...doc.matchAll(/data-act="revealThread" data-thread="([^"]*)"/g)].map((m) => m[1]), ['T_1', 'T_2']);
  // A pending review with no comments yet: still cancellable, but Comment needs a summary.
  const empty = html(ready(reviewModel({ pending: { id: 'R_1', databaseId: 1, commentCount: 0 } })));
  assert.match(empty, /data-el="comment"[^>]*>Comment<\/button>/);
  assert.ok(isDisabled(empty, 'comment'));
  assert.notEqual(tagOf(empty, 'cancel'), null);
});

test('own pull request: Approve and Request Changes disabled with the reason, and no approve check', () => {
  const doc = html(ready(reviewModel({ own: true, threads: [thread(1)] })),
    { draft: 'summary', attentionLeft: [attentionRow('bad', 'a.ts', 1)], counts: { total: 2, left: 2, attention: 1, attentionTotal: 1 } });
  assert.ok(isDisabled(doc, 'approve'));
  assert.ok(isDisabled(doc, 'requestChanges'), 'even with a summary');
  assert.ok(!isDisabled(doc, 'comment'));
  assert.match(textOf(doc), new RegExp(OWN_PR_REASON.replace(/\./g, '\\.')));
  assert.equal(tagOf(doc, 'check'), null);
});

test('the approve check lists unreviewed attention rows in order and unresolved threads, and says how many were looked at; Approve waits for the box', () => {
  const threads = [
    thread(1),                                                                         // unresolved, posted
    thread(2, { isResolved: true }),                                                   // resolved
    thread(3, {}, [comment(3, { pending: true, mine: true })]),                        // only a pending comment: not open yet
    thread(4, {}, [comment(4), comment(5, { pending: true, mine: true })]),            // posted, with a pending reply
  ];
  const rows = [attentionRow('bad', 'src/a.ts', 10), { type: 'outside', label: 'Outside functions', relPath: 'src/b.ts', ranges: [[1, 2]] }];
  const doc = html(ready(reviewModel({ threads, pending: PENDING_TWO })), { attentionLeft: rows, counts: { total: 9, left: 5, attention: 2, attentionTotal: 3 } });
  const text = textOf(doc);
  assert.match(text, /Before you approve: 2 need attention and are not reviewed: bad src\/a\.ts , Outside functions src\/b\.ts 2 threads are unresolved 1 of 3 looked at Approve anyway/);
  assert.deepEqual([...doc.matchAll(/data-act="revealRow" data-row="([^"]*)"/g)].map((m) => m[1]),
    ['finding:src/a.ts:bad:10', 'outside:src/b.ts:Outside functions:']);
  assert.ok(isDisabled(doc, 'approve'));
  assert.match(text, /Check “Approve anyway” to approve/);
  assert.match(tagOf(doc, 'anyway'), /type="checkbox"/);
  assert.ok(!/ checked/.test(tagOf(doc, 'anyway')), 'never ticked on a new page');
});

test('the approve check: only threads, only rows, or the tree not showing the review', () => {
  // NOTHING_LEFT: two rows needed attention and both were looked at, so only the thread stands against approving
  const onlyThread = textOf(html(ready(reviewModel({ threads: [thread(1)] }))));
  assert.match(onlyThread, /Before you approve: 1 thread is unresolved 2 of 2 looked at/);
  const calm = textOf(html(ready(reviewModel({ threads: [thread(1)] })), { attentionLeft: [], counts: { total: 107, left: 107, attention: 0, attentionTotal: 0 } }));
  assert.match(calm, /Before you approve: 1 thread is unresolved Approve anyway/, 'nothing needed attention: no count of looked-at rows, and no count of rows left');
  const onlyRow = textOf(html(ready(), { attentionLeft: [attentionRow('bad', 'a.ts', 1)], counts: { total: 4, left: 1, attention: 1, attentionTotal: 1 } }));
  assert.match(onlyRow, /1 needs attention and is not reviewed: bad a\.ts 0 of 1 looked at/);
  assert.doesNotMatch(onlyRow, /rows are not reviewed|left/);
  // While the tree shows no review (it is analysing), what is left is unknown, not "nothing".
  const unknown = html(ready(), { attentionLeft: null, counts: null });
  assert.match(textOf(unknown), /The tree is not showing this review, so which changes are left is not known\./);
  assert.ok(!/looked at/.test(textOf(unknown)));
  assert.ok(isDisabled(unknown, 'approve'));
});

test('while a submit runs, every button is disabled and the page says so; an error is shown in the page', () => {
  const doc = html(ready(reviewModel({ pending: PENDING_TWO, threads: pendingThreads() })), { draft: 'x', busy: 'submit' });
  for (const name of ['approve', 'requestChanges', 'comment', 'cancel']) assert.ok(isDisabled(doc, name), name);
  assert.match(textOf(doc), /Submitting your review…/);
  const failed = html(ready(), { error: 'The review was not submitted: <boom>' });
  assert.ok(!isHidden(failed, 'error'));
  assert.match(failed, /role="alert">The review was not submitted: &lt;boom&gt;<\/div>/);
  assert.ok(isHidden(html(ready()), 'error'));
});

test('buttonRules: each rule on its own', () => {
  const base = { own: false, pendingComments: 0, checkNeeded: false, busy: false, hasSummary: false, approveAnyway: false };
  const r = (over) => buttonRules({ ...base, ...over });
  assert.deepEqual(r({}).requestChanges, { disabled: true, reason: 'Request Changes needs a summary.' });
  assert.deepEqual(r({ hasSummary: true }).requestChanges, { disabled: false, reason: null });
  assert.deepEqual(r({}).comment, { disabled: true, reason: 'Comment needs a summary or a pending comment.' });
  assert.equal(r({ pendingComments: 1 }).comment.disabled, false);
  assert.equal(r({ hasSummary: true }).comment.disabled, false);
  assert.equal(r({}).approve.disabled, false);
  assert.equal(r({ checkNeeded: true }).approve.disabled, true);
  assert.equal(r({ checkNeeded: true, approveAnyway: true }).approve.disabled, false);
  assert.deepEqual(r({ own: true, hasSummary: true }).approve, { disabled: true, reason: null });
  assert.deepEqual(r({ own: true, hasSummary: true }).requestChanges, { disabled: true, reason: null });
  assert.equal(r({ own: true, hasSummary: true }).comment.disabled, false);
  const busy = r({ busy: true, hasSummary: true, pendingComments: 3 });
  assert.ok(busy.approve.disabled && busy.requestChanges.disabled && busy.comment.disabled);
});

test('status bar text only while a pending review has comments; submit message words', () => {
  assert.equal(pendingStatusOf({ kind: 'none' }), null);
  assert.equal(pendingStatusOf({ kind: 'loading', target: TARGET, previous: null }), null);
  assert.equal(pendingStatusOf(ready()), null);
  assert.equal(pendingStatusOf(ready(reviewModel({ pending: { id: 'R', databaseId: null, commentCount: 0 } }))), null);
  assert.deepEqual(pendingStatusOf(ready(reviewModel({ pending: PENDING_TWO }))), { text: '✎ 2 pending · Submit review…', number: 7 });
  assert.equal(submittedMessage('APPROVE', 7), 'Review submitted: you approved on PR #7');
  assert.equal(submittedMessage('COMMENT', 7), 'Review submitted: you commented on PR #7');
  assert.equal(submittedMessage('REQUEST_CHANGES', 7), 'Review submitted: you requested changes on PR #7');
  assert.equal(firstLineOf(`\n\n  ${'x'.repeat(200)}\nmore`).length, 120);
});

// ---- the page script, run against a small DOM ----------------------------------------

const page = (state, over) => createFormPage(html(state, over));
const lastSent = (p) => p.sent.at(-1);

test('page: says ready once, with its token', () => {
  const p = page(ready());
  assert.deepEqual(p.sent, [{ type: 'ready', body: '', token: NONCE }]);
});

test('page: typing a summary enables Request Changes and Comment and hides their reasons; clearing it undoes that', () => {
  const p = page(ready());
  assert.ok(p.el('requestChanges').hasAttribute('disabled'));
  p.type('summary', '   ');
  assert.ok(p.el('requestChanges').hasAttribute('disabled'), 'blank is not a summary');
  p.type('summary', 'Please fix');
  assert.ok(!p.el('requestChanges').hasAttribute('disabled'));
  assert.ok(!p.el('comment').hasAttribute('disabled'));
  assert.ok(p.el('reason-requestChanges').hasAttribute('hidden'));
  assert.ok(p.el('reason-comment').hasAttribute('hidden'));
  p.type('summary', '');
  assert.ok(p.el('requestChanges').hasAttribute('disabled'));
  assert.ok(!p.el('reason-requestChanges').hasAttribute('hidden'));
  assert.equal(p.el('reason-requestChanges').textContent, 'Request Changes needs a summary.');
});

test('page: a disabled button sends nothing; an enabled one sends its event, the summary and the box', () => {
  const p = page(ready(reviewModel({ threads: [thread(1)] })));
  p.click('requestChanges');
  p.click('approve');
  assert.equal(p.sent.length, 1, 'only ready');
  p.type('summary', 'Needs work');
  p.click('requestChanges');
  assert.deepEqual(lastSent(p), { type: 'submit', event: 'REQUEST_CHANGES', body: 'Needs work', approveAnyway: false, token: NONCE });
  p.setChecked('anyway', true);
  assert.ok(!p.el('approve').hasAttribute('disabled'));
  p.click('approve');
  assert.deepEqual(lastSent(p), { type: 'submit', event: 'APPROVE', body: 'Needs work', approveAnyway: true, token: NONCE });
  p.setChecked('anyway', false);
  assert.ok(p.el('approve').hasAttribute('disabled'));
});

test('page: own pull request keeps Approve and Request Changes disabled whatever is typed', () => {
  const p = page(ready(reviewModel({ own: true })));
  p.type('summary', 'mine');
  assert.ok(p.el('approve').hasAttribute('disabled'));
  assert.ok(p.el('requestChanges').hasAttribute('disabled'));
  p.click('comment');
  assert.equal(lastSent(p).event, 'COMMENT');
});

test('page: each input saves the draft immediately and submit sends the current text', () => {
  const p = page(ready());
  p.type('summary', 'a');
  p.type('summary', 'ab');
  assert.equal(p.pendingTimers(), 0);
  assert.equal(p.sent.length, 3);
  p.runTimers();
  assert.deepEqual(lastSent(p), { type: 'draft', body: 'ab', token: NONCE });
  p.type('summary', 'abc');
  p.click('comment');
  assert.equal(p.pendingTimers(), 0);
  assert.equal(lastSent(p).type, 'submit');
});

test('page: a draft from the extension fills the summary; one with another token is ignored', () => {
  const p = page(ready());
  p.receive({ type: 'draft', token: 'other', body: 'nope' });
  assert.equal(p.el('summary').value, '');
  p.receive({ type: 'draft', token: NONCE, body: 'kept text' });
  assert.equal(p.el('summary').value, 'kept text');
  assert.ok(!p.el('requestChanges').hasAttribute('disabled'), 'the rules follow the restored text');
});

test('page: links and buttons send reveal, retry and discard messages', () => {
  const p = page(ready(reviewModel({ pending: PENDING_TWO, threads: pendingThreads() })), { attentionLeft: [attentionRow('bad', 'a.ts', 3)], counts: { total: 2, left: 1, attention: 1, attentionTotal: 1 } });
  p.click(p.all('[data-act="revealThread"]')[1]);
  assert.deepEqual(lastSent(p), { type: 'revealThread', threadId: 'T_2', token: NONCE });
  p.click(p.all('[data-act="revealRow"]')[0]);
  assert.deepEqual(lastSent(p), { type: 'revealRow', rowId: 'finding:a.ts:bad:3', token: NONCE });
  p.click('cancel');
  assert.deepEqual(lastSent(p), { type: 'discard', token: NONCE });
  const failed = createFormPage(html({ kind: 'failed', target: TARGET, error: new Error('x'), previous: null }));
  failed.click(failed.all('[data-act="retry"]')[0]);
  assert.deepEqual(lastSent(failed), { type: 'retry', token: NONCE });
});


test('webview state recovers typing whose IPC message was overtaken by a repaint', () => {
  const state = { value: null };
  const model = pageModelOf(ready(), { attentionLeft: [], counts: { total: 1, left: 0, attention: 0, attentionTotal: 0 }, draft: '', error: null, busy: null });
  const doc = buildPullRequestHtml(model, { nonce: NONCE, cspSource: 'vscode-webview://test', draftKey: 'draft-one' });
  const first = createFormPage(doc, undefined, state);
  first.type('summary', 'latest text');
  const next = createFormPage(doc, undefined, state);
  assert.equal(next.el('summary').value, 'latest text');
  assert.equal(lastSent(next).body, 'latest text', 'ready recovers the extension copy');
  next.type('summary', 'new typing');
  next.receive({ type: 'draft', token: NONCE, body: 'old handshake' });
  assert.equal(next.el('summary').value, 'new typing');
  const cleared = createFormPage(buildPullRequestHtml(model, { nonce: NONCE, cspSource: 'vscode-webview://test', draftKey: 'after-submit' }), undefined, state);
  assert.equal(cleared.el('summary').value, '', 'successful submit uses a new draft identity');
});

// ---- merge state, checks, reviewers and labels ---------------------------------------

const PR = { state: 'OPEN', baseRefName: 'main' };
const mergeInfo = (over = {}) => ({ ...CLEAN_OVERVIEW.merge, ...over });
const overviewWith = (over = {}, merge = {}) => ({ ...CLEAN_OVERVIEW, ...over, merge: mergeInfo(merge) });
const check = (name, state, over = {}) => ({ name, context: 'CI', state, required: false, detail: null, url: `https://github.com/o/r/runs/${name}`, ...over });
const readyChecks = (items, incomplete = null, total = items.length) => ({ kind: 'ready', items, total, incomplete });
const pageOf = (overview, over = {}) => html(ready(reviewModel({ overview })), over);

test('mergeStateOf: merged and closed are done; a failed overview is unknown with a retry', () => {
  assert.deepEqual(mergeStateOf({ ...PR, state: 'MERGED' }, overviewWith()), { tone: 'done', headline: 'Merged.', reasons: [], retry: false });
  assert.deepEqual(mergeStateOf({ ...PR, state: 'CLOSED' }, overviewWith()), { tone: 'done', headline: 'Closed without merging.', reasons: [], retry: false });
  const failed = mergeStateOf(PR, { kind: 'failed', error: new Error('GitHub answered 502') });
  assert.deepEqual(failed, { tone: 'unknown', headline: 'Merge state could not be loaded: GitHub answered 502', reasons: [], retry: true });
});

test('a merged or closed pull request says so even when the overview failed to load', () => {
  const failed = { kind: 'failed', error: new Error('GitHub answered 502') };
  assert.equal(mergeStateOf({ ...PR, state: 'MERGED' }, failed).headline, 'Merged.');
  const doc = html(ready({ ...reviewModel({ overview: failed }), pr: { ...reviewModel().pr, state: 'MERGED' } }));
  assert.match(textOf(doc), /Merged\./);
  assert.doesNotMatch(textOf(doc), /Merge state could not be loaded/);
  assert.match(textOf(doc), /Checks could not be loaded/);
});

test('mergeStateOf: draft, conflicts, unknown, behind, clean and unstable', () => {
  const of = (merge, checks) => mergeStateOf(PR, overviewWith(checks ? { checks } : {}, merge));
  assert.deepEqual(of({ isDraft: true, mergeStateStatus: 'DRAFT' }),
    { tone: 'blocked', headline: 'This pull request is a draft.', reasons: ['Mark it ready for review on GitHub.'], retry: false });
  assert.equal(of({ mergeStateStatus: 'DRAFT' }).tone, 'blocked', 'a DRAFT status without isDraft is still a draft');
  for (const merge of [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, { mergeStateStatus: 'DIRTY' }, { mergeable: 'CONFLICTING' }]) {
    assert.deepEqual(of(merge), { tone: 'conflict', headline: 'This branch has conflicts with main.',
      reasons: ['Resolve them in the checkout and push, or on GitHub.'], retry: false });
  }
  for (const merge of [{ mergeable: 'UNKNOWN' }, { mergeStateStatus: 'UNKNOWN' }]) {
    assert.deepEqual(of(merge), { tone: 'unknown', headline: 'GitHub is still working out whether this can merge.', reasons: [], retry: true });
  }
  assert.deepEqual(of({ mergeStateStatus: 'BEHIND' }),
    { tone: 'blocked', headline: 'This branch is behind main and must be updated first.', reasons: [], retry: false });
  assert.deepEqual(of({ mergeStateStatus: 'UNSTABLE' }),
    { tone: 'clean', headline: 'No conflicts with main. Some checks that are not required are failing.', reasons: [], retry: false });
  for (const status of ['CLEAN', 'HAS_HOOKS']) {
    assert.deepEqual(of({ mergeStateStatus: status }), { tone: 'clean', headline: 'No conflicts with main. Ready to merge.', reasons: [], retry: false });
  }
});

test('mergeStateOf: blocked lists failed then pending required checks, then the review decision', () => {
  const blocked = (merge, checks) => mergeStateOf(PR, overviewWith({ checks }, { mergeStateStatus: 'BLOCKED', ...merge }));
  const items = [check('pending-req', 'pending', { required: true }), check('failed-req', 'failed', { required: true }),
    check('failed-optional', 'failed'), check('passed-req', 'passed', { required: true })];
  assert.deepEqual(blocked({ reviewDecision: 'CHANGES_REQUESTED' }, readyChecks(items)), { tone: 'blocked', headline: 'Merging is blocked:', retry: false,
    reasons: ['Required check failed-req failed', 'Required check pending-req has not finished', 'Changes were requested'] });
  assert.deepEqual(blocked({ reviewDecision: 'REVIEW_REQUIRED' }, readyChecks([])).reasons, ['An approving review is required']);
  // Checks that could not be read, or only partly, are said so when nothing read explains the block.
  assert.deepEqual(blocked({}, { kind: 'failed', error: new Error('x') }).reasons, ['The required checks could not all be read']);
  assert.deepEqual(blocked({}, readyChecks([check('a', 'passed')], 'only the first 1 of 9 checks were loaded', 9)).reasons,
    ['The required checks could not all be read']);
  // When the loaded checks or the review decision explain it, the unread checks add nothing.
  assert.deepEqual(blocked({ reviewDecision: 'REVIEW_REQUIRED' }, { kind: 'failed', error: new Error('x') }).reasons,
    ['An approving review is required']);
  assert.deepEqual(blocked({}, readyChecks([check('r', 'failed', { required: true })], 'only the first 1 of 9 checks were loaded', 9)).reasons,
    ['Required check r failed']);
  // No reason at all is not "clean": GitHub does not say.
  assert.deepEqual(blocked({}, { kind: 'none' }).reasons, ['Branch protection blocks the merge; GitHub does not say why here.']);
  assert.deepEqual(blocked({ reviewDecision: 'APPROVED' }, { kind: 'none' }).reasons, ['Branch protection blocks the merge; GitHub does not say why here.']);
});

test('mergeStateOf: a merge queue and a head that moved add notes without changing the tone', () => {
  const state = mergeStateOf(PR, overviewWith({}, { isMergeQueueEnabled: true, headMoved: true }));
  assert.equal(state.tone, 'clean');
  assert.deepEqual(state.reasons, ['This branch uses a merge queue: merge on GitHub.', 'GitHub has a newer head than the one reviewed; refresh the analysis.']);
});

test('the Merge box: tone class, headline, reasons, and Refresh when GitHub has not answered', () => {
  const clean = pageOf(overviewWith());
  assert.match(tagOf(clean, 'merge'), /class="merge clean"/);
  assert.match(textOf(clean), /Merge ✓ No conflicts with main\. Ready to merge\./);
  const blocked = pageOf(overviewWith({ checks: readyChecks([check('build', 'failed', { required: true })]) }, { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }));
  assert.match(tagOf(blocked, 'merge'), /class="merge blocked"/);
  assert.match(blocked, /<li>Required check build failed<\/li><li>An approving review is required<\/li>/);
  const unknown = pageOf(overviewWith({}, { mergeable: 'UNKNOWN' }));
  assert.match(tagOf(unknown, 'merge'), /class="merge unknown"/);
  assert.match(unknown, /<a href="#" data-act="retry">Refresh<\/a> in a moment\./);
  const failed = pageOf({ kind: 'failed', error: new Error('GitHub answered 502') });
  assert.match(textOf(failed), /Merge state could not be loaded: GitHub answered 502 Retry/);
  assert.match(failed, /data-act="retry">Retry<\/button>/);
  assert.ok(!/Ready to merge/.test(failed));
  assert.ok(html(ready(reviewModel({ overview: overviewWith() }))).indexOf('data-el="merge"') < html(ready()).indexOf('Finish your review'), 'the merge box is above the review form');
});

test('Checks: none, failed, and the summary lines', () => {
  assert.match(textOf(pageOf(overviewWith({ checks: { kind: 'none' } }))), /Checks No checks reported for this commit\./);
  assert.match(textOf(pageOf(overviewWith({ checks: readyChecks([]) }))), /No checks reported for this commit\./);
  const failed = pageOf(overviewWith({ checks: { kind: 'failed', error: new Error('GitHub answered 502') } }));
  assert.match(textOf(failed), /Checks could not be loaded: GitHub answered 502 ?\. They are not shown, which does not mean there are none\. Retry/);
  assert.match(failed, /data-el="checks-failed"[^>]*>[\s\S]*data-act="retry"/);
  const all = textOf(pageOf(overviewWith({ checks: readyChecks([check('a', 'passed'), check('b', 'passed'), check('c', 'skipped')]) })));
  assert.match(all, /All 2 checks passed, 1 skipped/);
  const mixed = textOf(pageOf(overviewWith({ checks: readyChecks([check('a', 'failed'), check('b', 'pending'), check('c', 'passed')]) })));
  assert.match(mixed, /1 failing, 1 pending, 1 passed/);
});

test('Checks: failing and pending are always listed; passed and skipped are folded away', () => {
  const items = [check('lint', 'passed'), check('build (node 20)', 'failed', { required: true }), check('e2e', 'pending'),
    check('docs', 'skipped'), check('ci/legacy', 'passed', { context: null, detail: 'Build ok', url: null })];
  const doc = pageOf(overviewWith({ checks: readyChecks(items) }));
  const [open, folded] = doc.split('<details data-el="checks-passed">');
  assert.match(open, /build \(node 20\) <span class="ctx">· CI<\/span> <span class="req">Required<\/span><\/span><span class="bad">Failed<\/span>/);
  assert.match(open, /e2e[\s\S]*Pending/);
  assert.ok(!/lint|docs/.test(open.split('data-el="checks"')[1]), 'passed and skipped are not in the open list');
  assert.match(folded, /<summary>2 passed, 1 skipped<\/summary>/);
  assert.match(folded, /lint[\s\S]*docs/);
  assert.match(folded, /ci\/legacy <span class="ctx">Build ok<\/span>/);
  assert.equal(open.match(/data-act="openLink"/g).length, 2, 'failed and pending have Details');
  assert.match(open, /data-act="openLink" data-url="https:\/\/github.com\/o\/r\/runs\/build \(node 20\)">Details/);
  assert.equal(folded.match(/data-act="openLink"/g).length, 2, 'a check with no link has no Details');
});

test('Checks: an incomplete list never says "all passed", and says how many were loaded', () => {
  const doc = pageOf(overviewWith({ checks: readyChecks([check('a', 'passed'), check('b', 'passed')], 'only the first 2 of 9 checks were loaded', 9) }));
  const text = textOf(doc);
  assert.ok(!/All \d+ checks passed/.test(text));
  assert.match(text, /None of the 2 loaded checks is failing or pending/);
  assert.match(text, /Only the first 2 of 9 checks were loaded\./);
  assert.notEqual(tagOf(doc, 'checks-incomplete'), null);
});

test('Reviewers: state words, none, more, and failed', () => {
  const reviewers = { items: [
    { name: 'omar', kind: 'user', state: 'CHANGES_REQUESTED' }, { name: 'mylo/mobile', kind: 'team', state: 'AWAITING' },
    { name: 'amy', kind: 'user', state: 'APPROVED' }, { name: 'sara', kind: 'user', state: 'COMMENTED' }, { name: 'dan', kind: 'user', state: 'DISMISSED' },
  ], more: 2 };
  const text = textOf(pageOf(overviewWith({ reviewers })));
  assert.match(text, /Reviewers omar ✗ mylo\/mobile ● amy ✓ sara 💬 dan ○ 2 more reviewers were not loaded\./);
  const doc = pageOf(overviewWith({ reviewers }));
  assert.match(doc, /<div class="p" title="Changes requested"><span class="av ph"><\/span><span class="n">omar<\/span><span class="s bad">✗<\/span><\/div>/, 'the state in words is the row\'s title');
  assert.match(textOf(pageOf(overviewWith())), /Reviewers No reviewers\./);
  assert.match(textOf(pageOf(overviewWith({ reviewers: { items: [], more: 1 } }))), /1 more reviewer was not loaded/);
  const failed = textOf(pageOf({ kind: 'failed', error: new Error('boom') }));
  assert.match(failed, /Reviewers, assignees, labels and milestone could not be loaded: boom Retry/);
  assert.equal((failed.match(/Reviewers, assignees, labels and milestone could not be loaded/g) || []).length, 1, 'said once for the side column, not once per section');
  assert.ok(!/No reviewers|No labels|No one assigned|No milestone/.test(failed), 'a failed part is never shown as empty');
});

test('Labels: chips with a class per valid colour, a generated rule only for 6 hex digits', () => {
  const labels = { items: [
    { name: 'bug', color: 'd73a4a' }, { name: 'plain', color: null }, { name: 'sneaky', color: 'fff;}</style><script>x()</script>' },
    { name: 'upper', color: 'D73A4A' }, { name: 'ok', color: '0e8a16' },
  ], more: 3 };
  const doc = pageOf(overviewWith({ labels }));
  assert.match(doc, /<span class="lbl lbl-0">bug<\/span><span class="lbl">plain<\/span><span class="lbl">sneaky<\/span><span class="lbl">upper<\/span><span class="lbl lbl-4">ok<\/span>/);
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(doc)[1];
  assert.match(style, /\.lbl-0 \{ background: #d73a4a; border-color: #d73a4a; color: #fff; \}/);
  assert.match(style, /\.lbl-4 \{ background: #0e8a16; border-color: #0e8a16; color: #fff; \}/);
  const light = /<style[^>]*>([\s\S]*?)<\/style>/.exec(pageOf(overviewWith({ labels: { items: [{ name: 'docs', color: 'fbca04' }], more: 0 } })))[1];
  assert.match(light, /\.lbl-0 \{ background: #fbca04; border-color: #fbca04; color: #000; \}/, 'dark text on a light label');
  assert.equal((style.match(/\.lbl-\d+ \{/g) || []).length, 2, 'rules only for the valid colours');
  assert.ok(!style.includes('sneaky') && !style.includes('<script') && !style.includes('#fff;}'), 'the sneaky colour never reaches the stylesheet');
  assert.equal((doc.match(/<script/g) || []).length, 1);
  assert.ok(!/\sstyle=/.test(doc));
  assert.match(textOf(doc), /3 more labels were not loaded/);
  assert.match(textOf(pageOf(overviewWith())), /Labels No labels\./);
});

test('names from GitHub in the overview are escaped; the side column follows the main one', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const doc = pageOf(overviewWith({
    checks: readyChecks([check(evil, 'failed', { context: evil, detail: evil, url: 'https://x/"><b>' })]),
    reviewers: { items: [{ name: evil, kind: 'user', state: 'APPROVED' }], more: 0 },
    labels: { items: [{ name: evil, color: null }], more: 0 },
  }, { mergeStateStatus: 'BLOCKED' }));
  assert.ok(!doc.includes('<img'), 'no element from a name');
  assert.ok(!doc.includes('"><b>'), 'no attribute breakout from a link');
  assert.ok((doc.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 5);
  assert.ok(doc.indexOf('class="side"') > doc.indexOf('Finish your review'));
  assert.match(doc, /@media \(max-width: 560px\) \{ \.cols \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
});

test('the overview parts have no inline style or handler in any state', () => {
  const overviews = [overviewWith(), { kind: 'failed', error: new Error('x') },
    overviewWith({ checks: readyChecks([check('a', 'failed'), check('b', 'passed')]), labels: { items: [{ name: 'x', color: 'abcdef' }], more: 0 },
      reviewers: { items: [{ name: 'a', kind: 'user', state: 'APPROVED' }], more: 0 } })];
  for (const overview of overviews) {
    const doc = pageOf(overview);
    assert.ok(!/\sstyle=/.test(doc));
    assert.ok(!/\son\w+=/.test(doc));
  }
});

// ---- merging --------------------------------------------------------------------------

const modelFor = (overview, over = {}, prOver = {}) => {
  const model = reviewModel({ overview });
  model.pr = { ...model.pr, ...prOver };
  return pageModelOf(ready(model), panel(over));
};
const rulesFor = (overview, over, prOver) => mergeRules(modelFor(overview, over, prOver));
const pickerOptions = (doc) => [...doc.matchAll(/<option value="(\w+)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

test('mergeRules: clean offers the allowed methods in GitHub\'s order, the first by default', () => {
  const all = rulesFor(overviewWith());
  assert.deepEqual(all, { show: true, methods: ['MERGE', 'SQUASH', 'REBASE'], notes: [], disabled: false, reason: null });
  const some = rulesFor(overviewWith({}, { methods: { merge: false, squash: true, rebase: false } }));
  assert.deepEqual(some.methods, ['SQUASH']);
  assert.deepEqual(some.notes, ['Merge commits are not allowed in this repository.', 'Rebase is not allowed in this repository.']);
  assert.equal(some.disabled, false);
  assert.equal(rulesFor(overviewWith({}, { mergeStateStatus: 'UNSTABLE' })).disabled, false, 'failing checks that are not required do not block');
});

test('mergeRules: only a clean answer enables Merge, and every other state says why', () => {
  const why = (merge, over, prOver) => { const r = rulesFor(overviewWith({}, merge), over, prOver); return [r.disabled, r.reason]; };
  assert.deepEqual(why({ mergeStateStatus: 'BLOCKED' }), [true, 'Blocked: see the reasons above.']);
  assert.deepEqual(why({ mergeStateStatus: 'BEHIND' }), [true, 'Blocked: see the reasons above.']);
  assert.deepEqual(why({ isDraft: true, mergeStateStatus: 'DRAFT' }), [true, 'Blocked: see the reasons above.']);
  assert.deepEqual(why({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), [true, 'Resolve the conflicts first.']);
  assert.deepEqual(why({ mergeable: 'UNKNOWN' }), [true, 'Waiting for GitHub’s answer.']);
  assert.deepEqual(why({ mergeStateStatus: 'UNKNOWN' }), [true, 'Waiting for GitHub’s answer.']);
  assert.deepEqual(why({ isMergeQueueEnabled: true }), [true, 'This branch uses a merge queue: merge on GitHub.']);
  assert.deepEqual(why({ headMoved: true }), [true, 'GitHub has a newer head than the one reviewed; refresh the analysis.']);
  for (const viewerPermission of ['TRIAGE', 'READ', null]) assert.deepEqual(why({ viewerPermission }), [true, 'You need write access to merge.']);
  for (const viewerPermission of ['ADMIN', 'MAINTAIN', 'WRITE']) assert.equal(why({ viewerPermission })[0], false);
  assert.deepEqual(why({ methods: { merge: false, squash: false, rebase: false } }), [true, 'This repository allows no merge method.']);
  const failed = rulesFor({ kind: 'failed', error: new Error('502') });
  assert.deepEqual([failed.show, failed.disabled, failed.reason, failed.methods], [true, true, 'The merge state could not be loaded.', []]);
});

test('mergeRules: busy disables without a reason; merged and closed show no button', () => {
  const busy = rulesFor(overviewWith(), { busy: 'merge' });
  assert.deepEqual([busy.show, busy.disabled, busy.reason], [true, true, null]);
  assert.equal(rulesFor(overviewWith(), { busy: 'submit' }).disabled, true);
  for (const state of ['MERGED', 'CLOSED']) {
    const r = rulesFor(overviewWith(), {}, { state });
    assert.equal(r.show, false, state);
  }
});

test('the Merge box: picker with only the allowed methods, Merge…, the notes, and no inline handler', () => {
  const doc = pageOf(overviewWith({}, { methods: { merge: true, squash: true, rebase: false } }));
  assert.deepEqual(pickerOptions(doc), [['MERGE', 'Create a merge commit'], ['SQUASH', 'Squash and merge']]);
  assert.ok(!isDisabled(doc, 'merge-button'));
  assert.match(doc, /data-act="merge" data-el="merge-button">Merge…<\/button>/);
  assert.match(textOf(doc), /Rebase is not allowed in this repository\./);
  assert.equal(tagOf(doc, 'merge-reason'), null, 'no reason while enabled');
  assert.ok(doc.indexOf('data-el="merge-button"') < doc.indexOf('Finish your review'));
  assert.ok(!/\sstyle=|\son\w+=/.test(doc));
});

test('the Merge box: blocked, conflicts, unknown and a failed overview disable Merge… with the reason', () => {
  const cases = [
    [overviewWith({}, { mergeStateStatus: 'BLOCKED' }), /Blocked: see the reasons above\./, true],
    [overviewWith({}, { mergeStateStatus: 'DIRTY' }), /Resolve the conflicts first\./, true],
    [overviewWith({}, { mergeable: 'UNKNOWN' }), /Waiting for GitHub’s answer\./, true],
    [{ kind: 'failed', error: new Error('502') }, /The merge state could not be loaded\./, false],
  ];
  for (const [overview, reason, hasPicker] of cases) {
    const doc = pageOf(overview);
    assert.ok(isDisabled(doc, 'merge-button'), String(reason));
    assert.match(textOf(doc), reason);
    assert.equal(pickerOptions(doc).length > 0, hasPicker);
  }
});

test('the Merge box: running disables the picker and the button and says so; the result is kept', () => {
  const doc = pageOf(overviewWith(), { busy: 'merge' });
  assert.ok(isDisabled(doc, 'merge-button') && isDisabled(doc, 'merge-method'));
  assert.match(textOf(doc), /Merging…/);
  const merged = html(ready(reviewModel({ overview: overviewWith() })), { mergeResult: { ok: true, text: 'Merged into main as 4f2a9c1.' } });
  assert.match(tagOf(merged, 'merge-result'), /class="ok text"/);
  assert.match(textOf(merged), /Merged into main as 4f2a9c1\./);
  const refused = html(ready(reviewModel({ overview: overviewWith() })), { mergeResult: { ok: false, text: 'GitHub refused the merge: <b>Head branch was modified</b>' } });
  assert.match(tagOf(refused, 'merge-result'), /class="err text" data-el="merge-result" role="alert"/);
  assert.ok(!refused.includes('<b>Head'), 'GitHub\'s words are escaped');
});

test('a merged or closed pull request says so and has no Merge button', () => {
  for (const [state, words] of [['MERGED', /Merged\./], ['CLOSED', /Closed without merging\./]]) {
    const model = reviewModel();
    model.pr.state = state;
    const doc = html(ready(model));
    assert.match(textOf(doc), words);
    assert.equal(tagOf(doc, 'merge-button'), null);
    assert.equal(tagOf(doc, 'merge-method'), null);
  }
});

test('page: Merge… posts the chosen method; a disabled button posts nothing', () => {
  const p = page(ready(), {});
  p.el('merge-method').value = 'SQUASH';
  p.click('merge-button');
  assert.deepEqual(lastSent(p), { type: 'merge', method: 'SQUASH', token: NONCE });
  const blocked = page(ready(reviewModel({ overview: overviewWith({}, { mergeStateStatus: 'BLOCKED' }) })));
  const before = blocked.sent.length;
  blocked.click('merge-button');
  assert.equal(blocked.sent.length, before);
});

test('the description and timeline bodies are markdown: headings, code, task lists, and #123 links into the repository', () => {
  const model = reviewModel({
    body: '## Problem\n\nSee #17063 and `branchPullRequest`.\n\n- [x] done\n- [ ] todo',
    timeline: [{ kind: 'comment', id: 'I_1', author: { login: 'eve', avatarUrl: null }, createdAt: '2026-01-02T03:04:05Z', body: 'Fixes #24098, **really**', reviewState: null }],
  });
  model.pr.url = 'https://github.com/o/r/pull/7';
  model.pr.createdAt = '2026-01-01T09:30:00Z';
  const doc = html(ready(model));
  assert.match(doc, /<div class="card desc"><div class="head"><span class="who">alice<\/span> opened this pull request <span class="when">2026-01-01 09:30<\/span><\/div><div class="md" data-el="description"><h2>Problem<\/h2>/);
  assert.ok(doc.includes('<a href="https://github.com/o/r/issues/17063" class="ref">#17063</a>'));
  assert.ok(doc.includes('<code>branchPullRequest</code>'));
  assert.ok(doc.includes('<li class="task"><input type="checkbox" disabled checked> done</li>'));
  assert.ok(doc.includes('<li class="task"><input type="checkbox" disabled> todo</li>'));
  assert.match(doc, /<div class="card ev"><div class="head"><span class="who">eve<\/span> commented <span class="when">2026-01-02 03:04<\/span><\/div><div class="md"><p>Fixes <a href="https:\/\/github.com\/o\/r\/issues\/24098" class="ref">#24098<\/a>, <strong>really<\/strong><\/p>\n<\/div><\/div>/);
  assert.ok(doc.indexOf('data-el="description"') > doc.indexOf('class="cols"'), 'the description sits in the main column, beside the side column');
  // No creation time known: the card says who, nothing about when.
  const plain = html(ready(reviewModel()));
  assert.match(plain, /<div class="head"><span class="who">alice<\/span> opened this pull request<\/div>/);
});

test('links in a body: http(s) and mailto are anchors to their real target, anything else is text, an image is a link to it', () => {
  const body = '[ok](https://x.y/z) [mail](mailto:a@b.c) [js](javascript:alert(1)) [file](file:///etc/passwd) ![pic](https://img/a.png) ![d](data:image/png;base64,AAAA)';
  const doc = html(ready(reviewModel({ body })));
  assert.ok(doc.includes('<a href="https://x.y/z">ok</a>'));
  assert.ok(doc.includes('<a href="mailto:a@b.c">mail</a>'));
  assert.ok(doc.includes('[js](javascript:alert(1))') && !doc.includes('href="javascript'), 'a javascript: link is the written text');
  assert.ok(doc.includes('[file](file:///etc/passwd)') && !doc.includes('href="file:'));
  assert.ok(doc.includes('<a href="https://img/a.png" class="img">[image: pic]</a>'), 'an image is a link that says what it was');
  assert.ok(!doc.includes('<img') && !/href="data:/.test(doc), 'no image element, no data: target');
  assert.ok(!/data-act="openLink"[^>]*https:\/\/x\.y/.test(doc), 'a body link is not sent through the page\'s openLink message, which is for a check\'s link only');
});

test('a body adds no inline style or handler, whatever it holds: raw HTML, an aligned table, a form', () => {
  const body = '<div style="x" onclick="y()">hi</div>\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n\n<form><input onfocus=z></form>';
  const doc = html(ready(reviewModel({ body })));
  assert.ok(!/<[^>]*\sstyle=/.test(doc), 'no style= attribute in any tag');
  assert.ok(!/<[^>]*\son\w+=/.test(doc), 'no on…= attribute in any tag');
  assert.ok(doc.includes('<th class="ac">a</th>') && doc.includes('<td class="ar">2</td>'), 'alignment is a class');
  assert.ok(!doc.includes('<form') && !doc.includes('<input') && doc.includes('<div>hi</div>'), 'GitHub\'s HTML is sanitized: the div stays bare, the form and its input are gone');
});

test('refsBaseOf: the repository under a pull request URL, on any host; nothing for another shape', () => {
  assert.equal(refsBaseOf('https://github.com/o/r/pull/7'), 'https://github.com/o/r');
  assert.equal(refsBaseOf('https://ghe.example.com/team/repo/pull/123/'), 'https://ghe.example.com/team/repo');
  for (const url of ['https://x/7', 'https://github.com/o/r/issues/7', 'http://github.com/o/r/pull/7', 'https://github.com/o/r/pull/7/files', '']) {
    assert.equal(refsBaseOf(url), null, url);
  }
});

test('page: the header\'s Refresh asks GitHub again, and is disabled while a refresh runs', () => {
  const p = page(ready());
  p.click('refresh');
  assert.deepEqual(lastSent(p), { type: 'retry', token: NONCE });
  const refreshing = html({ kind: 'loading', target: TARGET, previous: reviewModel() });
  assert.ok(isDisabled(refreshing, 'refresh'));
  assert.match(tagOf(refreshing, 'refresh') + 'Refreshing…', /Refreshing…/);
});

test('avatars: shown for the author, a commenter, a reviewer and an assignee when GitHub hosts them, asked at 40px; never from another host', () => {
  const gh = 'https://avatars.githubusercontent.com/u/1?v=4';
  const model = reviewModel({
    timeline: [{ kind: 'comment', id: 'I_1', author: { login: 'eve', avatarUrl: gh }, createdAt: '2026-01-02T03:04:05Z', body: 'hi', reviewState: null }],
    overview: overviewWith({
      reviewers: { items: [{ name: 'amy', kind: 'user', state: 'APPROVED', avatarUrl: gh }, { name: 'o/t', kind: 'team', state: 'AWAITING', avatarUrl: null }], more: 0 },
      assignees: { items: [{ login: 'bob', avatarUrl: 'https://evil.example/a.png' }, { login: 'cat', avatarUrl: gh }], more: 1 },
    }),
  });
  model.pr.author = { login: 'alice', avatarUrl: gh };
  const doc = html(ready(model));
  const img = '<img class="av" src="https://avatars.githubusercontent.com/u/1?v=4&amp;s=40" alt="">';
  assert.ok(doc.includes(`${img}<span class="who">alice</span> wants to merge`), 'header');
  assert.ok(doc.includes(`<div class="head">${img}<span class="who">alice</span> opened this pull request`), 'description');
  assert.ok(doc.includes(`<div class="head">${img}<span class="who">eve</span> commented`), 'timeline');
  assert.ok(doc.includes(`<div class="p" title="Approved">${img}<span class="n">amy</span>`), 'reviewer');
  assert.ok(doc.includes('<div class="p" title="Awaiting review"><span class="av ph"></span><span class="n">o/t</span>'), 'a team has no avatar, only the placeholder');
  assert.ok(doc.includes('<div class="p"><span class="av ph"></span><span class="n">bob</span></div>') && doc.includes(`<div class="p">${img}<span class="n">cat</span></div>`), 'assignees; not from another host');
  assert.equal((doc.match(/<img /g) || []).length, 5);
  for (const src of doc.match(/<img class="av" src="([^"]+)"/g)) assert.match(src, /src="https:\/\/avatars\.githubusercontent\.com\//);
  assert.match(textOf(doc), /Assignees bob cat 1 more assignee was not loaded\./);
  // The header's own CSP lets exactly these hosts load images.
  assert.match(doc, /img-src https:\/\/github\.com https:\/\/\*\.githubusercontent\.com;/);
});

test('milestone: the title, or none; Open on GitHub links the pull request\'s https URL only', () => {
  assert.match(textOf(pageOf(overviewWith({ milestone: 'v1.0' }))), /Milestone v1\.0/);
  assert.match(textOf(pageOf(overviewWith())), /Milestone No milestone\./);
  const doc = html(ready(reviewModel()));
  assert.ok(doc.includes('<a href="https://x/7" data-el="open-on-github">Open on GitHub</a>'));
  const model = reviewModel();
  model.pr.url = 'javascript:alert(1)';
  assert.equal(tagOf(html(ready(model)), 'open-on-github'), null, 'no link for a URL that is not https');
});

test('timeline: a review without a body is one coloured line; one with a body is a card with the same colour', () => {
  const model = reviewModel({ timeline: [
    { kind: 'review', id: 'R_a', author: { login: 'omar', avatarUrl: null }, createdAt: '2026-01-01T10:00:00Z', body: '', reviewState: 'CHANGES_REQUESTED' },
    { kind: 'review', id: 'R_b', author: { login: 'amy', avatarUrl: null }, createdAt: '2026-01-02T10:00:00Z', body: 'Nice', reviewState: 'APPROVED' },
    { kind: 'review', id: 'R_c', author: { login: 'sara', avatarUrl: null }, createdAt: '2026-01-03T10:00:00Z', body: '', reviewState: 'COMMENTED' },
  ] });
  const doc = html(ready(model));
  assert.ok(doc.includes('<div class="ev line changes"><span class="who">omar</span> requested changes <span class="when">2026-01-01 10:00</span></div>'));
  assert.ok(doc.includes('<div class="card ev approved"><div class="head"><span class="who">amy</span> approved <span class="when">2026-01-02 10:00</span></div><div class="md"><p>Nice</p>\n</div></div>'));
  assert.ok(doc.includes('<div class="ev line"><span class="who">sara</span> reviewed <span class="when">2026-01-03 10:00</span></div>'));
});
