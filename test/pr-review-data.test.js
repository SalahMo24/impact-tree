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
const { isAnalysisCancelled, AnalysisCancelledError } = require('../src/engine/cancellation');

const TARGET = { owner: 'o', name: 'r', number: 7 };

const comment = (id, over = {}) => ({
  id: `C_${id}`, databaseId: 1000 + id, author: { login: 'bob', avatarUrl: 'https://a/bob' },
  body: `body ${id}`, createdAt: '2026-01-02T03:04:05Z', state: 'SUBMITTED', viewerDidAuthor: false, viewerCanUpdate: false,
  url: `https://github.com/o/r/pull/7#discussion_r${id}`, diffHunk: '@@ -9,2 +9,2 @@\n context\n+const x = 1;',
  commit: { oid: 'e'.repeat(40) }, ...over,
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

/** A good answer to the overview query: clean, one passing check, no reviewers or labels. */
const overviewAnswer = (over = {}, { pr = {}, repo = {} } = {}) => ({
  repository: {
    mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerPermission: 'WRITE',
    pullRequest: {
      headRefOid: 'h'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
      isMergeQueueEnabled: false, isInMergeQueue: false,
      labels: { totalCount: 0, nodes: [] }, reviewRequests: { totalCount: 0, nodes: [] }, latestReviews: { totalCount: 0, nodes: [] },
      ...pr,
    },
    object: { statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 1, ...page([checkRun('lint')]) } } },
    ...repo,
    ...over,
  },
});
const checkRun = (name, over = {}) => ({
  __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `https://github.com/o/r/runs/${name}`,
  isRequired: false, checkSuite: { app: { name: 'GitHub Actions' }, workflowRun: { workflow: { name: 'CI' } } }, ...over,
});
const statusContext = (context, over = {}) => ({
  __typename: 'StatusContext', context, state: 'SUCCESS', targetUrl: 'https://ci.example/1', description: 'ok', isRequired: false, ...over,
});
const contexts = (nodes, next = null, totalCount = nodes.length) => ({ totalCount, ...page(nodes, next) });
const rollup = (c) => ({ object: { statusCheckRollup: { state: 'SUCCESS', contexts: c } } });
const checksPage = (c) => ({ repository: rollup(c) });

/**
 * A client answering one fixture per call, in order; records query, variables, options.
 * The overview query and its check pages are answered from `overview` (default: one
 * good answer) and recorded in `overviewCalls`, so `calls` is the review's own requests.
 */
function fakeClient(answers, overview = [overviewAnswer()]) {
  const calls = [];
  const overviewCalls = [];
  return {
    calls,
    overviewCalls,
    async graphql(query, variables, options) {
      if (/^query ImpactTree(PullRequestOverview|OverviewChecks)\b/.test(query)) {
        overviewCalls.push({ query, variables, options });
        const next = overview[overviewCalls.length - 1];
        if (next === undefined) throw new Error('unexpected extra overview call');
        if (next instanceof Error) throw next;
        return next;
      }
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
        nodes: [comment(1, { state: 'PENDING', viewerDidAuthor: true, viewerCanUpdate: true }), comment(2, { author: null, databaseId: null })],
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
    createdAt: '2026-01-02T03:04:05Z', pending: true, mine: true, canEdit: true, url: 'https://github.com/o/r/pull/7#discussion_r1',
    commitOid: 'e'.repeat(40),
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

test('a comment can be edited only when it is the viewer\'s and GitHub allows the update', async () => {
  const flags = [[true, true], [true, false], [false, true], [false, false]];
  const nodes = flags.map(([did, can], i) => comment(i, { viewerDidAuthor: did, viewerCanUpdate: can }));
  const model = await loadPullRequestReview(fakeClient([envelope(pullRequest({
    reviewThreads: page([thread(1, { comments: { totalCount: 4, pageInfo: { hasNextPage: false }, nodes } })]),
  }))]), TARGET);
  assert.deepEqual(model.threads[0].comments.map((c) => c.canEdit), [true, false, false, false]);
});

test('a comment\'s commit is its oid (40 or 64 hex digits), or null when GitHub gives none', async () => {
  const nodes = [comment(1), comment(2, { commit: { oid: 'f'.repeat(64) } }), comment(3, { commit: null })];
  const model = await loadPullRequestReview(fakeClient([envelope(pullRequest({
    reviewThreads: page([thread(1, { comments: { totalCount: 3, pageInfo: { hasNextPage: false }, nodes } })]),
  }))]), TARGET);
  assert.deepEqual(model.threads[0].comments.map((c) => c.commitOid), ['e'.repeat(40), 'f'.repeat(64), null]);
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
    'comment without viewerCanUpdate': (pr) => { delete pr.reviewThreads.nodes[0].comments.nodes[0].viewerCanUpdate; },
    'comment without diffHunk': (pr) => { delete pr.reviewThreads.nodes[0].comments.nodes[0].diffHunk; },
    'diffHunk not a string': (pr) => { pr.reviewThreads.nodes[0].comments.nodes[0].diffHunk = null; },
    'comment without commit': (pr) => { delete pr.reviewThreads.nodes[0].comments.nodes[0].commit; },
    'commit oid not hex': (pr) => { pr.reviewThreads.nodes[0].comments.nodes[0].commit = { oid: 'main' }; },
    'commit oid short': (pr) => { pr.reviewThreads.nodes[0].comments.nodes[0].commit = { oid: 'abc1234' }; },
    'commit not an object': (pr) => { pr.reviewThreads.nodes[0].comments.nodes[0].commit = 'e'.repeat(40); },
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

// Overview: checks, reviewers, labels and merge state. ------------------------------

const REVIEW = [envelope(pullRequest())];
const overviewOf = async (answers, options) => (await loadPullRequestReview(fakeClient(REVIEW, answers), TARGET, options)).overview;

test('the overview asks for the reviewed commit and loads after the review', async () => {
  const gh = fakeClient(REVIEW);
  const model = await loadPullRequestReview(gh, TARGET);
  assert.equal(model.overview.kind, 'ready');
  assert.equal(gh.overviewCalls.length, 1);
  const v = gh.overviewCalls[0].variables;
  assert.deepEqual({ ...v }, { owner: 'o', name: 'r', number: 7, headOid: 'h'.repeat(40), cursor: null });
  assert.deepEqual(model.overview.merge, {
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, isDraft: false, isMergeQueueEnabled: false,
    isInMergeQueue: false, methods: { merge: true, squash: true, rebase: false }, viewerPermission: 'WRITE', headMoved: false,
  });
});

test('check states: every run status and conclusion, and every commit status', async () => {
  const runs = [
    ['SUCCESS', 'passed'], ['NEUTRAL', 'skipped'], ['SKIPPED', 'skipped'], ['FAILURE', 'failed'], ['TIMED_OUT', 'failed'],
    ['CANCELLED', 'failed'], ['ACTION_REQUIRED', 'failed'], ['STARTUP_FAILURE', 'failed'], ['STALE', 'failed'],
  ].map(([conclusion, state]) => [checkRun(`run-${conclusion}`, { conclusion }), state]);
  const pending = ['IN_PROGRESS', 'PENDING', 'QUEUED', 'REQUESTED', 'WAITING'].map((status) => [checkRun(`s-${status}`, { status, conclusion: null }), 'pending']);
  const noConclusion = [[checkRun('no-conclusion', { conclusion: null }), 'pending']];
  const statuses = [['SUCCESS', 'passed'], ['PENDING', 'pending'], ['EXPECTED', 'pending'], ['FAILURE', 'failed'], ['ERROR', 'failed']]
    .map(([state, want]) => [statusContext(`st-${state}`, { state }), want]);
  const all = [...runs, ...pending, ...noConclusion, ...statuses];
  const overview = await overviewOf([overviewAnswer({ ...rollup(contexts(all.map(([n]) => n))) })]);
  assert.equal(overview.checks.kind, 'ready');
  assert.deepEqual(overview.checks.items.map((c) => c.state), all.map(([, want]) => want));
  assert.equal(overview.checks.total, all.length);
  assert.equal(overview.checks.incomplete, null);
});

test('a check carries name, workflow or app context, required, description and an https-only link', async () => {
  const nodes = [
    checkRun('a', { isRequired: true }),
    checkRun('b', { checkSuite: { app: { name: 'Vercel' }, workflowRun: null } }),
    checkRun('c', { checkSuite: null, detailsUrl: 'http://insecure.example/x' }),
    checkRun('d', { detailsUrl: 'javascript:alert(1)' }),
    checkRun('e', { detailsUrl: null }),
    statusContext('ci/legacy', { description: 'Build ok', targetUrl: 'https://ci.example/9' }),
    statusContext('ci/odd', { targetUrl: 'not a url', description: null }),
  ];
  const { items } = (await overviewOf([overviewAnswer(rollup(contexts(nodes)))])).checks;
  assert.deepEqual(items[0], { name: 'a', context: 'CI', state: 'passed', required: true, detail: null, url: 'https://github.com/o/r/runs/a' });
  assert.equal(items[1].context, 'Vercel');
  assert.equal(items[2].context, null);
  assert.deepEqual(items.slice(2, 5).map((c) => c.url), [null, null, null]);
  assert.deepEqual(items[5], { name: 'ci/legacy', context: null, state: 'passed', required: false, detail: 'Build ok', url: 'https://ci.example/9' });
  assert.deepEqual([items[6].url, items[6].detail], [null, null]);
});

test('labels: names, a colour only when it is 6 hex digits (lower-cased), and the count not loaded', async () => {
  const labels = { totalCount: 105, nodes: [
    { name: 'bug', color: 'D73A4A' }, { name: 'short', color: 'fff' }, { name: 'evil', color: 'red;}</style>' }, { name: 'none', color: null },
  ] };
  const overview = await overviewOf([overviewAnswer({}, { pr: { labels } })]);
  assert.deepEqual(overview.labels, { items: [
    { name: 'bug', color: 'd73a4a' }, { name: 'short', color: null }, { name: 'evil', color: null }, { name: 'none', color: null },
  ], more: 101 });
  const exact = await overviewOf([overviewAnswer({}, { pr: { labels: { totalCount: 1, nodes: [{ name: 'x', color: '000000' }] } } })]);
  assert.equal(exact.labels.more, 0, 'exactly at the count is not truncation');
});

test('reviewers: requested are awaiting, others come from the latest review; PENDING and the author are skipped; ordered', async () => {
  const requests = { totalCount: 4, nodes: [
    { requestedReviewer: { __typename: 'User', login: 'zed' } },
    { requestedReviewer: { __typename: 'Team', name: 'mobile', combinedSlug: 'mylo/mobile' } },
    { requestedReviewer: { __typename: 'Bot', login: 'copilot' } },
    { requestedReviewer: { __typename: 'Mannequin', login: 'imported' } },
  ] };
  const reviews = { totalCount: 8, nodes: [
    { author: { login: 'omar' }, state: 'CHANGES_REQUESTED' },
    { author: { login: 'zed' }, state: 'APPROVED' }, // re-requested: awaiting wins
    { author: { login: 'amy' }, state: 'APPROVED' },
    { author: { login: 'sara' }, state: 'COMMENTED' },
    { author: { login: 'dan' }, state: 'DISMISSED' },
    { author: { login: 'me' }, state: 'PENDING' },
    { author: { login: 'alice' }, state: 'COMMENTED' }, // the pull request's author
    { author: null, state: 'COMMENTED' },
  ] };
  const overview = await overviewOf([overviewAnswer({}, { pr: { reviewRequests: requests, latestReviews: reviews } })]);
  assert.deepEqual(overview.reviewers.items.map((r) => `${r.kind}:${r.name}:${r.state}`), [
    'user:omar:CHANGES_REQUESTED',
    'user:copilot:AWAITING', 'user:imported:AWAITING', 'team:mylo/mobile:AWAITING', 'user:zed:AWAITING',
    'user:amy:APPROVED',
    'user:ghost:COMMENTED', 'user:sara:COMMENTED',
    'user:dan:DISMISSED',
  ]);
  assert.equal(overview.reviewers.more, 0);
  const more = await overviewOf([overviewAnswer({}, { pr: { reviewRequests: { totalCount: 102, nodes: [] }, latestReviews: { totalCount: 101, nodes: [] } } })]);
  assert.equal(more.reviewers.more, 203);
});

test('checks paging: follow-up pages by cursor, for the reviewed commit', async () => {
  const gh = fakeClient(REVIEW, [
    overviewAnswer(rollup(contexts([checkRun('a')], 'K1', 3))),
    checksPage(contexts([checkRun('b')], 'K2', 3)),
    checksPage(contexts([checkRun('c')], null, 3)),
  ]);
  const model = await loadPullRequestReview(gh, TARGET);
  assert.deepEqual(model.overview.checks.items.map((c) => c.name), ['a', 'b', 'c']);
  assert.equal(model.overview.checks.incomplete, null);
  assert.deepEqual(gh.overviewCalls.slice(1).map((c) => c.variables.cursor), ['K1', 'K2']);
  assert.ok(gh.overviewCalls.slice(1).every((c) => c.variables.headOid === 'h'.repeat(40)));
  assert.ok(!gh.overviewCalls[1].query.includes('labels'), 'a follow-up page asks only for checks');
  assert.deepEqual(model.incomplete, [], 'a complete overview adds nothing to the model\'s own incomplete list');
});

test('checks budget: one page under, at, and over the limit', async () => {
  const run = (n, lastNext) => {
    const total = lastNext ? 9 : 3;
    const answers = [overviewAnswer(rollup(contexts([checkRun('p1')], 'K1', total)))];
    if (n >= 2) answers.push(checksPage(contexts([checkRun('p2')], n >= 3 || lastNext ? 'K2' : null, total)));
    if (n >= 3) answers.push(checksPage(contexts([checkRun('p3')], lastNext ? 'K3' : null, total)));
    return answers;
  };
  // limit - 1 pages: all read, nothing more to say.
  let gh = fakeClient(REVIEW, run(2, false));
  let m = await loadPullRequestReview(gh, TARGET, { budgets: { maxCheckPages: 3 } });
  assert.equal(m.overview.checks.incomplete, null);
  // exactly the limit, GitHub has no more: complete.
  gh = fakeClient(REVIEW, run(3, false));
  m = await loadPullRequestReview(gh, TARGET, { budgets: { maxCheckPages: 3 } });
  assert.equal(m.overview.checks.incomplete, null);
  assert.equal(gh.overviewCalls.length, 3);
  // limit reached with more pages: the checks so far and a note, and no request past the budget.
  gh = fakeClient(REVIEW, run(3, true));
  m = await loadPullRequestReview(gh, TARGET, { budgets: { maxCheckPages: 3 } });
  assert.equal(m.overview.checks.kind, 'ready');
  assert.equal(m.overview.checks.items.length, 3);
  assert.equal(m.overview.checks.incomplete, 'only the first 3 of 9 checks were loaded');
  assert.equal(gh.overviewCalls.length, 3);
  // The default budget is 3 pages.
  assert.equal(DEFAULT_BUDGETS.maxCheckPages, 3);
  await assert.rejects(loadPullRequestReview(fakeClient([]), TARGET, { budgets: { maxCheckPages: 0 } }), RangeError);
});

test('no rollup is "none"; an unknown commit is a failed checks section, not "none"', async () => {
  const none = await overviewOf([overviewAnswer({ object: { statusCheckRollup: null } })]);
  assert.deepEqual(none.checks, { kind: 'none' });
  const unknown = await overviewOf([overviewAnswer({ object: null })]);
  assert.equal(unknown.kind, 'ready');
  assert.equal(unknown.checks.kind, 'failed');
  assert.match(unknown.checks.error.message, /GitHub does not know commit hhhhhhh/);
  assert.equal(unknown.merge.mergeStateStatus, 'CLEAN', 'the rest of the overview is intact');
});

test('a failing follow-up page fails only the checks', async () => {
  const boom = new GitHubRateLimitError('/graphql', 200, null);
  const overview = await overviewOf([overviewAnswer(rollup(contexts([checkRun('a')], 'K1', 2))), boom]);
  assert.equal(overview.kind, 'ready');
  assert.deepEqual(overview.checks, { kind: 'failed', error: boom });
  assert.equal(overview.merge.mergeable, 'MERGEABLE');
  const malformed = await overviewOf([overviewAnswer(rollup(contexts([checkRun('a')], 'K1', 2))), checksPage(contexts([{ __typename: 'Other' }]))]);
  assert.equal(malformed.checks.kind, 'failed');
  assert.ok(malformed.checks.error instanceof GitHubResponseError);
});

test('the overview query failing is only the overview failing; the review data is intact', async () => {
  const boom = new GitHubGraphQLError('/graphql', [{ message: 'boom', path: null, type: null }]);
  const model = await loadPullRequestReview(fakeClient(REVIEW, [boom]), TARGET);
  assert.deepEqual(model.overview, { kind: 'failed', error: boom });
  assert.equal(model.pr.number, 7);
  assert.deepEqual(model.threads.map((t) => t.id), ['T_1']);
  assert.deepEqual(model.incomplete, []);
});

test('a malformed or unknown enum value fails the overview with a GitHubResponseError', async () => {
  const cases = [
    overviewAnswer({}, { pr: { mergeable: 'MAYBE' } }),
    overviewAnswer({}, { pr: { mergeStateStatus: 'SHINY' } }),
    overviewAnswer({}, { pr: { reviewDecision: 'LGTM' } }),
    overviewAnswer({ viewerPermission: 'GOD' }),
    overviewAnswer({}, { pr: { isDraft: 'no' } }),
    overviewAnswer({}, { pr: { latestReviews: { totalCount: 1, nodes: [{ author: { login: 'x' }, state: 'WEIRD' }] } } }),
    overviewAnswer({}, { pr: { reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: 'Alien' } }] } } }),
    overviewAnswer(rollup(contexts([checkRun('a', { conclusion: 'MEH' })]))),
    overviewAnswer(rollup(contexts([checkRun('a', { status: 'ODD' })]))),
    overviewAnswer(rollup(contexts([statusContext('s', { state: 'ODD' })]))),
    overviewAnswer(rollup(contexts([checkRun('a', { isRequired: 'yes' })]))),
    overviewAnswer({ object: {} }),
    { repository: { pullRequest: null } },
  ];
  for (const answer of cases) {
    const model = await loadPullRequestReview(fakeClient(REVIEW, [answer]), TARGET);
    assert.equal(model.overview.kind, 'failed', JSON.stringify(answer).slice(0, 120));
    assert.ok(model.overview.error instanceof GitHubResponseError);
    assert.equal(model.pr.number, 7);
  }
});

test('cancellation during the overview still rejects, and so does an aborted signal at its start', async () => {
  const controller = new AbortController();
  const gh = fakeClient(REVIEW, [overviewAnswer()]);
  const inner = gh.graphql;
  gh.graphql = async (query, ...rest) => {
    if (/ImpactTreePullRequestOverview/.test(query)) { controller.abort(); throw new AnalysisCancelledError(); }
    return inner(query, ...rest);
  };
  await assert.rejects(loadPullRequestReview(gh, TARGET, { signal: controller.signal }), isAnalysisCancelled);
  // Aborted between the review and the overview query.
  const c2 = new AbortController();
  const gh2 = fakeClient(REVIEW);
  const inner2 = gh2.graphql;
  gh2.graphql = async (...args) => { const r = await inner2(...args); c2.abort(); return r; };
  await assert.rejects(loadPullRequestReview(gh2, TARGET, { signal: c2.signal }), isAnalysisCancelled);
  assert.equal(gh2.overviewCalls.length, 0);
  // An abort while a check page is read.
  const c3 = new AbortController();
  const gh3 = fakeClient(REVIEW, [overviewAnswer(rollup(contexts([checkRun('a')], 'K1', 2))), new AnalysisCancelledError()]);
  await assert.rejects(loadPullRequestReview(gh3, TARGET, { signal: c3.signal }), isAnalysisCancelled);
  // A DOM-style AbortError is a cancellation too.
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(loadPullRequestReview(fakeClient(REVIEW, [abort]), TARGET), (e) => e === abort);
});

test('an internal invariant failure in the overview is not turned into a failed section', async () => {
  const invariant = new assert.AssertionError({ message: 'broken' });
  await assert.rejects(loadPullRequestReview(fakeClient(REVIEW, [invariant]), TARGET), (e) => e === invariant);
});

test('the pull request head moved since the review is flagged', async () => {
  const overview = await overviewOf([overviewAnswer({}, { pr: { headRefOid: 'n'.repeat(40) } })]);
  assert.equal(overview.merge.headMoved, true);
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
