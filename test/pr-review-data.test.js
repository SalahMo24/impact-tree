'use strict';
// PR review data: normalisation, paging, budgets and helpers, on hand-written fixtures
// shaped like GitHub's GraphQL answers. The fake client records every call.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadPullRequestReview, threadsForRange, threadsForFile, openCount, pendingCount,
  DEFAULT_BUDGETS, COMMENTS_PER_THREAD,
} = require('../src/pr-review-data');
const { GitHubResponseError, GitHubGraphQLError, GitHubRateLimitError } = require('../src/github-request');
const { isAnalysisCancelled } = require('../src/engine/cancellation');

const TARGET = { owner: 'o', name: 'r', number: 7 };

const comment = (id, over = {}) => ({
  id: `C_${id}`, databaseId: 1000 + id, author: { login: 'bob', avatarUrl: 'https://a/bob' },
  body: `body ${id}`, createdAt: '2026-01-02T03:04:05Z', state: 'SUBMITTED', viewerDidAuthor: false,
  url: `https://github.com/o/r/pull/7#discussion_r${id}`, diffHunk: '@@ -9,2 +9,2 @@\n context\n+const x = 1;', ...over,
});

const thread = (id, over = {}) => ({
  id: `T_${id}`, isResolved: false, isOutdated: false, path: 'src/a.js', line: 10, originalLine: 10,
  startLine: null, originalStartLine: null, diffSide: 'RIGHT', subjectType: 'LINE',
  viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
  comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [comment(id)] }, ...over,
});

const page = (nodes, next = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });

const pullRequest = (over = {}) => ({
  id: 'PR_1', number: 7, title: 'Title', body: 'Body', url: 'https://github.com/o/r/pull/7', state: 'OPEN',
  author: { login: 'alice', avatarUrl: 'https://a/alice' }, viewerDidAuthor: true,
  headRefOid: 'h'.repeat(40), baseRefOid: 'b'.repeat(40), headRefName: 'feat', baseRefName: 'main',
  reviewThreads: page([thread(1)]),
  reviews: { nodes: [] },
  files: page([{ path: 'src/a.js', viewerViewedState: 'UNVIEWED' }]),
  timelineItems: { nodes: [] },
  ...over,
});

const envelope = (pr) => ({ repository: { pullRequest: pr } });
const threadsOnly = (p) => envelope({ reviewThreads: p });
const filesOnly = (p) => envelope({ files: p });

/** A client answering one fixture per call, in order; records query, variables, options. */
function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    async graphql(query, variables, options) {
      calls.push({ query, variables, options });
      const next = answers[calls.length - 1];
      if (next === undefined) throw new Error('unexpected extra call');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('normalises every field of the pull request, thread, comment, review, file and timeline', async () => {
  const gh = fakeClient([envelope(pullRequest({
    reviewThreads: page([thread(1, {
      line: 12, originalLine: 11, startLine: 10, originalStartLine: 9, isResolved: true,
      viewerCanResolve: false, viewerCanUnresolve: true, viewerCanReply: false,
      comments: {
        totalCount: 2, pageInfo: { hasNextPage: false },
        nodes: [comment(1, { state: 'PENDING', viewerDidAuthor: true }), comment(2, { author: null, databaseId: null })],
      },
    })]),
    reviews: { nodes: [{ id: 'R_1', databaseId: 55, comments: { totalCount: 3 } }] },
    files: page([
      { path: 'src/a.js', viewerViewedState: 'VIEWED' },
      { path: 'src/b.js', viewerViewedState: 'DISMISSED' },
    ]),
    timelineItems: {
      nodes: [
        { __typename: 'PullRequestReview', id: 'RV', author: { login: 'carol', avatarUrl: null }, createdAt: 't1', body: 'lgtm', state: 'APPROVED' },
        { __typename: 'IssueComment', id: 'IC', author: null, createdAt: 't2', body: 'hi' },
      ],
    },
  }))]);
  const model = await loadPullRequestReview(gh, TARGET);

  assert.deepEqual(model.pr, {
    id: 'PR_1', number: 7, title: 'Title', body: 'Body', url: 'https://github.com/o/r/pull/7', state: 'OPEN',
    author: { login: 'alice', avatarUrl: 'https://a/alice' }, viewerDidAuthor: true,
    headRefOid: 'h'.repeat(40), baseRefOid: 'b'.repeat(40), headRefName: 'feat', baseRefName: 'main',
  });
  assert.equal(model.threads.length, 1);
  const [t] = model.threads;
  assert.deepEqual({ ...t, comments: undefined }, {
    id: 'T_1', path: 'src/a.js', side: 'RIGHT', line: 12, originalLine: 11, startLine: 10,
    isResolved: true, isOutdated: false, fileLevel: false,
    canResolve: false, canUnresolve: true, canReply: false, originalCode: 'const x = 1;', comments: undefined,
  });
  assert.deepEqual(t.comments[0], {
    id: 'C_1', databaseId: 1001, author: { login: 'bob', avatarUrl: 'https://a/bob' }, body: 'body 1',
    createdAt: '2026-01-02T03:04:05Z', pending: true, mine: true, url: 'https://github.com/o/r/pull/7#discussion_r1',
  });
  assert.equal(t.comments[1].author, null);
  assert.equal(t.comments[1].databaseId, null);
  assert.equal(t.comments[1].pending, false);
  assert.equal(t.comments[1].mine, false);
  assert.equal('incomplete' in t, false);
  assert.deepEqual(model.pendingReview, { id: 'R_1', databaseId: 55, commentCount: 3 });
  assert.deepEqual([...model.viewed], [['src/a.js', 'VIEWED'], ['src/b.js', 'DISMISSED']]);
  assert.deepEqual(model.timeline, [
    { kind: 'review', id: 'RV', author: { login: 'carol', avatarUrl: null }, createdAt: 't1', body: 'lgtm', reviewState: 'APPROVED' },
    { kind: 'comment', id: 'IC', author: null, createdAt: 't2', body: 'hi', reviewState: null },
  ]);
  assert.deepEqual(model.incomplete, []);

  assert.equal(gh.calls.length, 1);
  assert.deepEqual(gh.calls[0].variables, { owner: 'o', name: 'r', number: 7, cursor: null });
});

test('no pending review is null', async () => {
  const model = await loadPullRequestReview(fakeClient([envelope(pullRequest())]), TARGET);
  assert.equal(model.pendingReview, null);
});

test('file-level and outdated threads have no line; a file-level thread says so', async () => {
  const gh = fakeClient([envelope(pullRequest({
    reviewThreads: page([
      thread(1, { subjectType: 'FILE', line: null, originalLine: null }),
      thread(2, { isOutdated: true, line: 30, originalLine: 25, startLine: 28 }),
    ]),
  }))]);
  const { threads } = await loadPullRequestReview(gh, TARGET);
  assert.equal(threads[0].fileLevel, true);
  assert.equal(threads[0].line, null);
  assert.equal(threads[1].isOutdated, true);
  assert.equal(threads[1].line, null);
  assert.equal(threads[1].startLine, null);
  assert.equal(threads[1].originalLine, 25);
});

test('a thread keeps the line it was written on: the last line of its first comment\'s diffHunk', async () => {
  const hunk = (text) => ({ comments: { totalCount: 2, pageInfo: { hasNextPage: false },
    nodes: [comment(1, { diffHunk: text }), comment(2, { diffHunk: '@@ -1 +1 @@\n+not the first comment' })] } });
  const gh = fakeClient([envelope(pullRequest({
    reviewThreads: page([
      thread(1, { isOutdated: true, line: null, originalLine: 41, ...hunk('@@ -40,3 +40,4 @@ class A\n   a();\n-  b();\n+  return c(x);\n') }),
      thread(2, { diffSide: 'LEFT', ...hunk('@@ -8,2 +8,1 @@\r\n keep\r\n-  removed();') }),
      thread(3, { ...hunk('@@ -3,1 +3,1 @@\n   unchanged context') }),
      thread(4, { subjectType: 'FILE', line: null, ...hunk('') }),
      thread(5, { ...hunk('@@ -1,0 +1,0 @@') }),
    ]),
  }))]);
  const { threads } = await loadPullRequestReview(gh, TARGET);
  assert.deepEqual(threads.map((t) => t.originalCode), ['  return c(x);', '  removed();', '  unchanged context', null, null]);
});

test('threads and files are paged separately by cursor', async () => {
  const gh = fakeClient([
    envelope(pullRequest({
      reviewThreads: page([thread(1)], 'TC1'),
      files: page([{ path: 'a', viewerViewedState: 'VIEWED' }], 'FC1'),
    })),
    threadsOnly(page([thread(2)], 'TC2')),
    threadsOnly(page([thread(3)])),
    filesOnly(page([{ path: 'b', viewerViewedState: 'UNVIEWED' }])),
  ]);
  const model = await loadPullRequestReview(gh, TARGET, { signal: new AbortController().signal });
  assert.deepEqual(model.threads.map((t) => t.id), ['T_1', 'T_2', 'T_3']);
  assert.deepEqual([...model.viewed.keys()], ['a', 'b']);
  assert.deepEqual(model.incomplete, []);
  assert.deepEqual(gh.calls.slice(1).map((c) => c.variables.cursor), ['TC1', 'TC2', 'FC1']);
  assert.ok(gh.calls.every((c) => c.variables.number === 7 && c.variables.owner === 'o' && c.variables.name === 'r'));
  assert.ok(gh.calls.every((c) => c.options.signal), 'the signal reaches every request');
  assert.ok(gh.calls[1].query.includes('reviewThreads') && !gh.calls[1].query.includes('timelineItems'));
  assert.ok(gh.calls[3].query.includes('files(') && !gh.calls[3].query.includes('reviewThreads'));
});

test('exhausting the thread budget returns the data so far and says so', async () => {
  const gh = fakeClient([
    envelope(pullRequest({ reviewThreads: page([thread(1)], 'TC1') })),
    threadsOnly(page([thread(2)], 'TC2')),
  ]);
  const model = await loadPullRequestReview(gh, TARGET, { budgets: { maxThreadPages: 2 } });
  assert.deepEqual(model.threads.map((t) => t.id), ['T_1', 'T_2']);
  assert.equal(gh.calls.length, 2, 'no request beyond the budget');
  assert.equal(model.incomplete.length, 1);
  assert.match(model.incomplete[0], /review threads/);
});

test('exactly at the thread budget with nothing more is complete', async () => {
  const gh = fakeClient([
    envelope(pullRequest({ reviewThreads: page([thread(1)], 'TC1') })),
    threadsOnly(page([thread(2)])),
  ]);
  const model = await loadPullRequestReview(gh, TARGET, { budgets: { maxThreadPages: 2 } });
  assert.deepEqual(model.incomplete, []);
});

test('exhausting the file budget keeps the viewed states read and says so', async () => {
  const gh = fakeClient([
    envelope(pullRequest({ files: page([{ path: 'a', viewerViewedState: 'VIEWED' }], 'FC1') })),
  ]);
  const model = await loadPullRequestReview(gh, TARGET, { budgets: { maxFilePages: 1 } });
  assert.deepEqual([...model.viewed], [['a', 'VIEWED']]);
  assert.equal(gh.calls.length, 1);
  assert.equal(model.incomplete.length, 1);
  assert.match(model.incomplete[0], /changed files/);
});

test('both budgets exhausted give both reasons', async () => {
  const gh = fakeClient([envelope(pullRequest({
    reviewThreads: page([thread(1)], 'TC'), files: page([], 'FC'),
  }))]);
  const model = await loadPullRequestReview(gh, TARGET, { budgets: { maxThreadPages: 1, maxFilePages: 1 } });
  assert.equal(model.incomplete.length, 2);
});

test('a thread with more comments than were read is incomplete, on the thread and the result', async () => {
  const nodes = Array.from({ length: COMMENTS_PER_THREAD }, (_, i) => comment(i + 1));
  const gh = fakeClient([envelope(pullRequest({
    reviewThreads: page([thread(1, { comments: { totalCount: 130, pageInfo: { hasNextPage: true }, nodes } })]),
  }))]);
  const model = await loadPullRequestReview(gh, TARGET);
  assert.equal(model.threads[0].comments.length, COMMENTS_PER_THREAD);
  assert.equal(model.threads[0].incomplete.length, 1);
  assert.match(model.threads[0].incomplete[0], /100 of 130/);
  assert.equal(model.incomplete.length, 1);
  assert.match(model.incomplete[0], /T_1/);
});

test('a thread with exactly 100 comments is complete', async () => {
  const nodes = Array.from({ length: COMMENTS_PER_THREAD }, (_, i) => comment(i + 1));
  const gh = fakeClient([envelope(pullRequest({
    reviewThreads: page([thread(1, { comments: { totalCount: 100, pageInfo: { hasNextPage: false }, nodes } })]),
  }))]);
  const model = await loadPullRequestReview(gh, TARGET);
  assert.deepEqual(model.incomplete, []);
});

test('malformed nodes are a GitHubResponseError', async () => {
  const cases = {
    'thread without id': (pr) => { delete pr.reviewThreads.nodes[0].id; },
    'unknown diffSide': (pr) => { pr.reviewThreads.nodes[0].diffSide = 'MIDDLE'; },
    'unknown subjectType': (pr) => { pr.reviewThreads.nodes[0].subjectType = 'REPO'; },
    'line zero': (pr) => { pr.reviewThreads.nodes[0].line = 0; },
    'fractional line': (pr) => { pr.reviewThreads.nodes[0].line = 1.5; },
    'string boolean': (pr) => { pr.reviewThreads.nodes[0].isResolved = 'false'; },
    'unknown comment state': (pr) => { pr.reviewThreads.nodes[0].comments.nodes[0].state = 'DRAFT'; },
    'comment without body': (pr) => { delete pr.reviewThreads.nodes[0].comments.nodes[0].body; },
    'comment without diffHunk': (pr) => { delete pr.reviewThreads.nodes[0].comments.nodes[0].diffHunk; },
    'diffHunk not a string': (pr) => { pr.reviewThreads.nodes[0].comments.nodes[0].diffHunk = null; },
    'author without login': (pr) => { pr.reviewThreads.nodes[0].comments.nodes[0].author = {}; },
    'threads not a list': (pr) => { pr.reviewThreads.nodes = {}; },
    'more pages without cursor': (pr) => { pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: null }; },
    'unknown viewed state': (pr) => { pr.files.nodes[0].viewerViewedState = 'SEEN'; },
    'file without path': (pr) => { delete pr.files.nodes[0].path; },
    'unknown PR state': (pr) => { pr.state = 'DRAFT'; },
    'two pending reviews': (pr) => { pr.reviews.nodes = [{ id: 'a', databaseId: 1, comments: { totalCount: 0 } }, { id: 'b', databaseId: 2, comments: { totalCount: 0 } }]; },
    'pending review without count': (pr) => { pr.reviews.nodes = [{ id: 'a', databaseId: 1, comments: {} }]; },
    'unknown timeline type': (pr) => { pr.timelineItems.nodes = [{ __typename: 'Other' }]; },
    'review state unknown': (pr) => { pr.timelineItems.nodes = [{ __typename: 'PullRequestReview', id: 'x', author: null, createdAt: 't', body: '', state: 'MAYBE' }]; },
    'files missing': (pr) => { pr.files = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const pr = pullRequest();
    mutate(pr);
    await assert.rejects(loadPullRequestReview(fakeClient([envelope(pr)]), TARGET), GitHubResponseError, name);
  }
  await assert.rejects(loadPullRequestReview(fakeClient([{ repository: null }]), TARGET), GitHubResponseError);
  await assert.rejects(loadPullRequestReview(fakeClient([{ repository: { pullRequest: null } }]), TARGET), GitHubResponseError);
});

test('a malformed node on a follow-up page is a GitHubResponseError', async () => {
  const gh = fakeClient([
    envelope(pullRequest({ reviewThreads: page([thread(1)], 'TC') })),
    threadsOnly(page([{ id: 'T_2' }])),
  ]);
  await assert.rejects(loadPullRequestReview(gh, TARGET), GitHubResponseError);
});

test('client errors propagate, from the first query and from a follow-up', async () => {
  const graphqlError = new GitHubGraphQLError('/graphql', [{ message: 'boom', path: null, type: null }]);
  await assert.rejects(loadPullRequestReview(fakeClient([graphqlError]), TARGET), GitHubGraphQLError);
  const limited = new GitHubRateLimitError('/graphql', 200, null);
  const gh = fakeClient([envelope(pullRequest({ files: page([], 'FC') })), limited]);
  await assert.rejects(loadPullRequestReview(gh, TARGET), (e) => e === limited);
});

test('a signal aborted between pages stops the load as a cancellation', async () => {
  const controller = new AbortController();
  const gh = fakeClient([envelope(pullRequest({ reviewThreads: page([thread(1)], 'TC') }))]);
  const inner = gh.graphql;
  gh.graphql = async (...args) => { const r = await inner(...args); controller.abort(); return r; };
  await assert.rejects(loadPullRequestReview(gh, TARGET, { signal: controller.signal }), isAnalysisCancelled);
  assert.equal(gh.calls.length, 1);
});

test('invalid budgets and targets are rejected, not repaired', async () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '3', 101]) {
    await assert.rejects(loadPullRequestReview(fakeClient([]), TARGET, { budgets: { maxThreadPages: bad } }), RangeError, String(bad));
    await assert.rejects(loadPullRequestReview(fakeClient([]), TARGET, { budgets: { maxFilePages: bad } }), RangeError, String(bad));
  }
  await assert.rejects(loadPullRequestReview(fakeClient([]), { ...TARGET, number: 0 }), RangeError);
  await assert.rejects(loadPullRequestReview(fakeClient([]), { ...TARGET, owner: '' }), RangeError);
  assert.ok(Object.isFrozen(DEFAULT_BUDGETS));
});

// Helpers: built from normalised threads, as the model holds them. -------------------

/** @param {string|number} id @param {object} [over] */
const norm = (id, over = {}) => ({
  id: `T_${id}`, path: 'src/a.js', side: 'RIGHT', line: 10, originalLine: 10, startLine: null,
  isResolved: false, isOutdated: false, fileLevel: false, comments: [{ pending: false }], ...over,
});
const model = (threads) => ({ threads });

test('threadsForRange: inclusive 1-based bounds on the RIGHT side only', () => {
  const m = model([
    norm(1, { line: 9 }), norm(2, { line: 10 }), norm(3, { line: 15 }), norm(4, { line: 20 }), norm(5, { line: 21 }),
    norm(6, { line: 12, side: 'LEFT' }),
    norm(7, { line: null, isOutdated: true }),
    norm(8, { line: null, fileLevel: true }),
    norm(9, { line: 12, path: 'src/other.js' }),
  ]);
  assert.deepEqual(threadsForRange(m, 'src/a.js', 10, 20).map((x) => x.id), ['T_2', 'T_3', 'T_4']);
  assert.deepEqual(threadsForRange(m, 'src/a.js', 10, 10).map((x) => x.id), ['T_2']);
  assert.deepEqual(threadsForRange(m, 'src/a.js', 21, 20), []);
  assert.deepEqual(threadsForRange(m, 'nope.js', 1, 100), []);
});

test('threadsForRange skips outdated and file-level threads even if a line is present', () => {
  const m = model([norm(1, { line: 12, isOutdated: true }), norm(2, { line: 12, fileLevel: true })]);
  assert.deepEqual(threadsForRange(m, 'src/a.js', 1, 100), []);
});

test('threadsForFile returns every thread on the path: both sides, outdated, file-level', () => {
  const m = model([
    norm(1, { line: 5 }), norm(2, { line: 5, side: 'LEFT' }), norm(3, { line: null, isOutdated: true }),
    norm(4, { line: null, fileLevel: true }), norm(5, { path: 'src/other.js' }),
  ]);
  assert.deepEqual(threadsForFile(m, 'src/a.js').map((x) => x.id), ['T_1', 'T_2', 'T_3', 'T_4']);
  assert.deepEqual(threadsForFile(m, 'missing.js'), []);
});

test('openCount counts unresolved threads with a posted comment; pendingCount counts pending comments', () => {
  const posted = { pending: false };
  const pending = { pending: true };
  const threads = [
    norm(1, { comments: [posted] }),
    norm(2, { comments: [posted, pending, pending] }),
    norm(3, { comments: [pending] }),
    norm(4, { comments: [pending, pending] }),
    norm(5, { isResolved: true, comments: [posted] }),
    norm(6, { comments: [] }),
  ];
  assert.equal(openCount(threads), 2, 'pending-only, resolved and empty threads are not open');
  assert.equal(pendingCount(threads), 5);
  assert.equal(openCount([]), 0);
  assert.equal(pendingCount([]), 0);
});

test('helpers work on a model produced by the loader', async () => {
  const gh = fakeClient([envelope(pullRequest({
    reviewThreads: page([
      thread(1, { line: 10 }),
      thread(2, { line: 11, comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [comment(2, { state: 'PENDING' })] } }),
    ]),
  }))]);
  const m = await loadPullRequestReview(gh, TARGET);
  assert.equal(threadsForRange(m, 'src/a.js', 10, 11).length, 2);
  assert.equal(openCount(m.threads), 1);
  assert.equal(pendingCount(m.threads), 1);
});
