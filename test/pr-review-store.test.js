'use strict';
// The review-loop store: loading, superseding, refresh, mutations, their serialisation and
// validation, failure states and disposal. The fake GitHub client answers nothing until a
// test settles a call, so every race is arranged explicitly; no timers, no sleeps.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPullRequestReviewStore, changedPaths, reviewDataOf, reviewTargetOf, ReviewStoreError,
} = require('../src/pr-review-store');
const { GitHubGraphQLError, GitHubRateLimitError, GitHubResponseError } = require('../src/github-request');

const HEAD = 'a'.repeat(40);
const TARGET = Object.freeze({ owner: 'o', name: 'r', number: 7, headOid: HEAD });
const OTHER = Object.freeze({ owner: 'o', name: 'r', number: 8, headOid: 'b'.repeat(40) });

// ---- GitHub-shaped fixtures (the store loads through the real L2 normaliser) ----------

const comment = (id, over = {}) => ({
  id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', state: 'SUBMITTED', viewerDidAuthor: false, url: `https://x/${id}`, ...over,
});
const thread = (id, over = {}, comments = [comment(id)]) => ({
  id: `T_${id}`, isResolved: false, isOutdated: false, path: 'src/a.js', line: 10, originalLine: 10,
  startLine: null, originalStartLine: null, diffSide: 'RIGHT', subjectType: 'LINE',
  viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
  comments: { totalCount: comments.length, pageInfo: { hasNextPage: false }, nodes: comments }, ...over,
});
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/**
 * One load's answer.
 * @param {{ number?: number, threads?: object[], pending?: object|null, files?: object[], viewerDidAuthor?: boolean }} [o]
 */
function answer({ number = 7, threads = [thread(1)], pending = null, files = [{ path: 'src/a.js', viewerViewedState: 'UNVIEWED' }], viewerDidAuthor = false } = {}) {
  return { repository: { pullRequest: {
    id: `PR_${number}`, number, title: 't', body: 'b', url: 'https://x', state: 'OPEN', author: null,
    viewerDidAuthor, headRefOid: HEAD, baseRefOid: 'c'.repeat(40), headRefName: 'f', baseRefName: 'main',
    reviewThreads: page(threads),
    reviews: { nodes: pending ? [pending] : [] },
    files: page(files),
    timelineItems: { nodes: [] },
  } } };
}
const PENDING = { id: 'R_1', databaseId: 1, comments: { totalCount: 1 } };

// ---- a GitHub client whose calls stay open until the test settles them --------------

function fakeGitHub() {
  const calls = [];
  const waiting = [];
  return {
    calls,
    graphql(query, variables, options = {}) {
      let settle;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      const call = {
        name: /^(?:query|mutation) (\w+)/.exec(query)[1], variables, signal: options.signal,
        resolve: (value) => settle.resolve(value), reject: (error) => settle.reject(error),
      };
      calls.push(call);
      const next = waiting.shift();
      if (next) next(call);
      return promise;
    },
    /** The call number `i` (0-based), once it has been made. */
    call(i) {
      if (calls[i]) return Promise.resolve(calls[i]);
      return new Promise((resolve) => { waiting.push(() => resolve(calls[i])); });
    },
  };
}

// Lets the promise reactions already queued run. Not a timer: no wall-clock dependency.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ target = TARGET, analysisId = 1 } = {}) {
  const gh = fakeGitHub();
  let current = { target, analysisId };
  const logs = [];
  const store = createPullRequestReviewStore({
    gh, getTarget: () => current.target, getAnalysisId: () => current.analysisId, log: (m) => logs.push(m),
  });
  const changes = [];
  store.onDidChange((c) => changes.push(c));
  return {
    gh, store, changes, logs,
    /** A new analysis, optionally of a different target. */
    move(next = {}) { current = { ...current, ...next, analysisId: current.analysisId + 1 }; store.sync(); },
    /** A new analysis the store has not been told about yet. */
    bumpGenerationQuietly() { current = { ...current, analysisId: current.analysisId + 1 }; },
  };
}

/** A store showing the review loaded from `fixture`. */
async function ready(fixture = answer(), options) {
  const env = setup(options);
  env.store.sync();
  (await env.gh.call(0)).resolve(fixture);
  await settle();
  assert.equal(env.store.getState().kind, 'ready');
  env.changes.length = 0;
  return env;
}

const inputOf = (call) => call.variables.input;

// ---- loading ------------------------------------------------------------------------

test('loads the review when a PR review becomes current, and names everything in the first event', async () => {
  const { gh, store, changes } = setup();
  store.sync();
  assert.deepEqual(store.getState(), { kind: 'loading', target: TARGET, previous: null });
  const load = await gh.call(0);
  assert.equal(load.name, 'ImpactTreePullRequestReview');
  assert.deepEqual(load.variables, { owner: 'o', name: 'r', number: 7, cursor: null });
  load.resolve(answer());
  await settle();
  const state = store.getState();
  assert.equal(state.kind, 'ready');
  assert.deepEqual(state.target, TARGET);
  assert.equal(state.model.threads[0].id, 'T_1');
  assert.deepEqual(changes, [{ paths: [] }, { paths: null }]);
});

test('a local review holds nothing and does no I/O, for loads and mutations alike', async () => {
  const { gh, store, changes } = setup({ target: null });
  store.sync();
  await store.refresh();
  const result = await store.setViewed({ path: 'src/a.js', viewed: true });
  assert.deepEqual(store.getState(), { kind: 'none' });
  assert.equal(gh.calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not-ready');
  assert.deepEqual(changes, []);
});

test('leaving the PR review for a local one drops the data and names everything', async () => {
  const { store, changes, move } = await ready();
  move({ target: null });
  assert.deepEqual(store.getState(), { kind: 'none' });
  assert.deepEqual(changes, [{ paths: null }]);
});

test('a load superseded by a target change is aborted and its late answer discarded', async () => {
  const { gh, store, changes, move } = setup();
  store.sync();
  const stale = await gh.call(0);
  move({ target: OTHER });
  assert.equal(stale.signal.aborted, true);
  assert.deepEqual(store.getState(), { kind: 'loading', target: OTHER, previous: null });
  const fresh = await gh.call(1);
  assert.equal(fresh.variables.number, 8);
  changes.length = 0;

  stale.resolve(answer({ number: 7 }));           // a client that ignored its signal
  await settle();
  assert.equal(store.getState().kind, 'loading');
  assert.deepEqual(changes, []);

  fresh.resolve(answer({ number: 8 }));
  await settle();
  assert.equal(store.getState().kind, 'ready');
  assert.equal(reviewDataOf(store.getState()).pr.number, 8);
});

test('a new analysis of the same PR reloads while still showing the previous data', async () => {
  const { gh, store, changes, move } = await ready();
  const shown = reviewDataOf(store.getState());
  move();
  const state = store.getState();
  assert.equal(state.kind, 'loading');
  assert.equal(state.previous, shown);
  assert.deepEqual(changes, [{ paths: [] }]);           // nothing to repaint yet
  assert.equal((await gh.call(1)).name, 'ImpactTreePullRequestReview');
});

test('a load answered after the analysis moved on publishes nothing, and the next sync reloads', async () => {
  const { gh, store, changes, bumpGenerationQuietly } = setup();
  store.sync();
  const load = await gh.call(0);
  changes.length = 0;
  bumpGenerationQuietly();
  load.resolve(answer());
  await settle();
  assert.equal(store.getState().kind, 'loading');
  assert.deepEqual(changes, []);
  store.sync();
  (await gh.call(1)).resolve(answer());
  await settle();
  assert.equal(store.getState().kind, 'ready');
});

test('refresh reloads, names only the files whose threads changed, and settles when done', async () => {
  const { gh, store, changes } = await ready();
  const refreshed = store.refresh();
  assert.equal(store.getState().kind, 'loading');
  (await gh.call(1)).resolve(answer({ threads: [thread(1), thread(2, { path: 'src/b.js' })] }));
  await refreshed;
  assert.equal(store.getState().kind, 'ready');
  assert.deepEqual(changes, [{ paths: [] }, { paths: ['src/b.js'] }]);
});

test('refresh during a load aborts it and only the newer answer is shown', async () => {
  const { gh, store } = setup();
  store.sync();
  const first = await gh.call(0);
  const refreshed = store.refresh();
  assert.equal(first.signal.aborted, true);
  first.resolve(answer({ threads: [] }));
  (await gh.call(1)).resolve(answer());
  await refreshed;
  assert.equal(reviewDataOf(store.getState()).threads.length, 1);
});

test('a failed load is a failed state with the typed error, keeping the previous data', async () => {
  const { gh, store, changes } = await ready();
  const shown = reviewDataOf(store.getState());
  const refreshed = store.refresh();
  (await gh.call(1)).reject(new GitHubRateLimitError('/graphql', 403, null));
  await refreshed;
  const state = store.getState();
  assert.equal(state.kind, 'failed');
  assert.ok(state.error instanceof GitHubRateLimitError);
  assert.equal(state.previous, shown);
  assert.deepEqual(changes, [{ paths: [] }, { paths: [] }]);
});

test('a first load that fails is failed with no data, never an empty review', async () => {
  const { gh, store } = setup();
  store.sync();
  (await gh.call(0)).resolve({ repository: { pullRequest: { id: 'PR_7' } } });   // malformed
  await settle();
  const state = store.getState();
  assert.equal(state.kind, 'failed');
  assert.ok(state.error instanceof GitHubResponseError);
  assert.equal(state.previous, null);
});

test('a malformed target is a failed state, with no I/O', async () => {
  const { gh, store } = setup({ target: { owner: 'o', name: 'r', number: 7, headOid: undefined } });
  store.sync();
  const state = store.getState();
  assert.equal(state.kind, 'failed');
  assert.ok(state.error instanceof RangeError);
  assert.equal(gh.calls.length, 0);
});

// ---- mutations: success -------------------------------------------------------------

test('adding to the pending review sends the thread, reloads, and names its file', async () => {
  const { gh, store, changes } = await ready(answer({ pending: PENDING }));
  const done = store.addComment({ path: 'src/a.js', side: 'RIGHT', line: 12, body: 'hm', mode: 'addToReview' });
  const write = await gh.call(1);
  assert.equal(write.name, 'ImpactTreeAddThread');
  assert.deepEqual(inputOf(write), { path: 'src/a.js', body: 'hm', side: 'RIGHT', line: 12, subjectType: 'LINE', pullRequestReviewId: 'R_1' });
  write.resolve({ addPullRequestReviewThread: { thread: { id: 'T_9' } } });
  const reload = await gh.call(2);
  assert.equal(reload.name, 'ImpactTreePullRequestReview');
  reload.resolve(answer({ pending: PENDING, threads: [thread(1), thread(9, { line: 12 }, [comment(9, { state: 'PENDING', viewerDidAuthor: true })])] }));
  assert.deepEqual(await done, { ok: true });
  assert.equal(reviewDataOf(store.getState()).threads.length, 2);
  assert.deepEqual(changes, [{ paths: [] }, { paths: ['src/a.js'] }]);
});

test('starting a review creates a pending review on the reviewed commit, then adds the thread to it', async () => {
  const { gh, store } = await ready();
  const done = store.addComment({ path: 'src/a.js', side: 'LEFT', line: 3, startLine: 1, body: 'x', mode: 'startReview' });
  const create = await gh.call(1);
  assert.equal(create.name, 'ImpactTreeAddReview');
  assert.deepEqual(inputOf(create), { pullRequestId: 'PR_7', commitOID: HEAD });
  create.resolve({ addPullRequestReview: { pullRequestReview: { id: 'R_new', state: 'PENDING' } } });
  const add = await gh.call(2);
  assert.deepEqual(inputOf(add), { path: 'src/a.js', body: 'x', side: 'LEFT', line: 3, subjectType: 'LINE', startLine: 1, startSide: 'LEFT', pullRequestReviewId: 'R_new' });
  add.resolve({ addPullRequestReviewThread: { thread: { id: 'T_9' } } });
  (await gh.call(3)).resolve(answer({ pending: PENDING }));
  assert.deepEqual(await done, { ok: true });
});

test('commenting now creates, fills and submits a review; a file-level comment has no line', async () => {
  const { gh, store } = await ready();
  const done = store.addFileComment({ path: 'src/a.js', body: 'file note', mode: 'commentNow' });
  (await gh.call(1)).resolve({ addPullRequestReview: { pullRequestReview: { id: 'R_new', state: 'PENDING' } } });
  const add = await gh.call(2);
  assert.deepEqual(inputOf(add), { path: 'src/a.js', body: 'file note', subjectType: 'FILE', pullRequestReviewId: 'R_new' });
  add.resolve({ addPullRequestReviewThread: { thread: { id: 'T_9' } } });
  const submit = await gh.call(3);
  assert.equal(submit.name, 'ImpactTreeSubmitReview');
  assert.deepEqual(inputOf(submit), { pullRequestReviewId: 'R_new', event: 'COMMENT' });
  submit.resolve({ submitPullRequestReview: { pullRequestReview: { id: 'R_new', state: 'COMMENTED' } } });
  (await gh.call(4)).resolve(answer());
  assert.deepEqual(await done, { ok: true });
});

test('a reply joins the pending review when there is one, and is posted alone otherwise', async () => {
  for (const [pending, expected] of [[PENDING, { pullRequestReviewThreadId: 'T_1', body: 'ok', pullRequestReviewId: 'R_1' }],
    [null, { pullRequestReviewThreadId: 'T_1', body: 'ok' }]]) {
    const { gh, store } = await ready(answer({ pending }));
    const done = store.reply({ threadId: 'T_1', body: 'ok' });
    const write = await gh.call(1);
    assert.equal(write.name, 'ImpactTreeReply');
    assert.deepEqual(inputOf(write), expected);
    write.resolve({ addPullRequestReviewThreadReply: { comment: { id: 'C_9' } } });
    (await gh.call(2)).resolve(answer({ pending }));
    assert.deepEqual(await done, { ok: true });
  }
});

test('resolve, delete a pending comment, discard, mark viewed: each sends its mutation and reloads', async () => {
  const mine = comment(5, { state: 'PENDING', viewerDidAuthor: true });
  const fixture = answer({ pending: PENDING, threads: [thread(1), thread(5, {}, [mine])] });
  const cases = [
    [(s) => s.setResolved({ threadId: 'T_1', resolved: true }), 'ImpactTreeResolve', { threadId: 'T_1' },
      { resolveReviewThread: { thread: { id: 'T_1', isResolved: true } } }],
    [(s) => s.deletePendingComment({ commentId: 'C_5' }), 'ImpactTreeDeleteComment', { id: 'C_5' },
      { deletePullRequestReviewComment: { clientMutationId: null } }],
    [(s) => s.discardPendingReview(), 'ImpactTreeDeleteReview', { pullRequestReviewId: 'R_1' },
      { deletePullRequestReview: { pullRequestReview: { id: 'R_1' } } }],
    [(s) => s.setViewed({ path: 'src/a.js', viewed: true }), 'ImpactTreeMarkViewed', { pullRequestId: 'PR_7', path: 'src/a.js' },
      { markFileAsViewed: { pullRequest: { id: 'PR_7' } } }],
  ];
  for (const [act, name, input, reply] of cases) {
    const { gh, store } = await ready(fixture);
    const done = act(store);
    const write = await gh.call(1);
    assert.equal(write.name, name);
    assert.deepEqual(inputOf(write), input);
    write.resolve(reply);
    (await gh.call(2)).resolve(fixture);
    assert.deepEqual(await done, { ok: true }, name);
  }
});

test('a mutation with nothing to change sends nothing and reloads nothing', async () => {
  const { gh, store } = await ready();
  assert.deepEqual(await store.setViewed({ path: 'src/a.js', viewed: false }), { ok: true });
  assert.deepEqual(await store.setResolved({ threadId: 'T_1', resolved: false }), { ok: true });
  assert.equal(gh.calls.length, 1);
});

// ---- mutations: failure -------------------------------------------------------------

test('a failed mutation returns the typed error and leaves the state as it was', async () => {
  const { gh, store, changes } = await ready();
  const before = store.getState();
  const done = store.setResolved({ threadId: 'T_1', resolved: true });
  const error = new GitHubGraphQLError('/graphql', [{ message: 'nope', path: null, type: 'FORBIDDEN' }]);
  (await gh.call(1)).reject(error);
  const result = await done;
  assert.deepEqual(result, { ok: false, error });
  await settle();
  assert.equal(store.getState(), before);
  assert.equal(gh.calls.length, 2);                    // no reload
  assert.deepEqual(changes, []);
});

test('a failed start-review deletes the review it created, and keeps the state', async () => {
  const { gh, store } = await ready();
  const before = store.getState();
  const done = store.addComment({ path: 'src/a.js', side: 'RIGHT', line: 99, body: 'x', mode: 'startReview' });
  (await gh.call(1)).resolve({ addPullRequestReview: { pullRequestReview: { id: 'R_new', state: 'PENDING' } } });
  const error = new GitHubGraphQLError('/graphql', [{ message: 'line must be part of the diff', path: null, type: null }]);
  (await gh.call(2)).reject(error);
  const undo = await gh.call(3);
  assert.equal(undo.name, 'ImpactTreeDeleteReview');
  assert.deepEqual(inputOf(undo), { pullRequestReviewId: 'R_new' });
  undo.resolve({ deletePullRequestReview: { pullRequestReview: { id: 'R_new' } } });
  assert.deepEqual(await done, { ok: false, error });
  await settle();
  assert.equal(store.getState(), before);
  assert.equal(gh.calls.length, 4);
});

test('an answer without the new review id fails the mutation and reloads, since GitHub may have changed', async () => {
  const { gh, store } = await ready();
  const done = store.addComment({ path: 'src/a.js', side: 'RIGHT', line: 1, body: 'x', mode: 'startReview' });
  (await gh.call(1)).resolve({ addPullRequestReview: { pullRequestReview: null } });
  const next = await gh.call(2);
  assert.equal(next.name, 'ImpactTreePullRequestReview');
  next.resolve(answer());
  const result = await done;
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof GitHubResponseError);
});

// ---- serialisation ------------------------------------------------------------------

test('mutations run one at a time, each after the reload of the one before', async () => {
  const { gh, store } = await ready();
  const first = store.setResolved({ threadId: 'T_1', resolved: true });
  const second = store.setViewed({ path: 'src/a.js', viewed: true });
  const refreshed = store.refresh();                      // waits for the lane too
  const write = await gh.call(1);
  await settle();
  assert.equal(gh.calls.length, 2, 'nothing else starts while the first mutation is in flight');
  write.resolve({ resolveReviewThread: { thread: { id: 'T_1', isResolved: true } } });
  (await gh.call(2)).resolve(answer({ threads: [thread(1, { isResolved: true, viewerCanResolve: false, viewerCanUnresolve: true })] }));
  assert.deepEqual(await first, { ok: true });
  const mark = await gh.call(3);
  assert.equal(mark.name, 'ImpactTreeMarkViewed');
  mark.resolve({ markFileAsViewed: { pullRequest: { id: 'PR_7' } } });
  (await gh.call(4)).resolve(answer({ files: [{ path: 'src/a.js', viewerViewedState: 'VIEWED' }] }));
  assert.deepEqual(await second, { ok: true });
  await refreshed;
  assert.deepEqual(gh.calls.map((c) => c.name), [
    'ImpactTreePullRequestReview', 'ImpactTreeResolve', 'ImpactTreePullRequestReview',
    'ImpactTreeMarkViewed', 'ImpactTreePullRequestReview',
  ]);
});

test('a mutation queued for a PR that is no longer under review is refused unsent', async () => {
  const { gh, store, move } = await ready();
  const first = store.setResolved({ threadId: 'T_1', resolved: true });
  const queued = store.setViewed({ path: 'src/a.js', viewed: true });
  const write = await gh.call(1);
  move({ target: OTHER });
  write.resolve({ resolveReviewThread: { thread: { id: 'T_1', isResolved: true } } });
  assert.deepEqual(await first, { ok: true });
  const result = await queued;
  assert.equal(result.error.code, 'stale');
  const load = await gh.call(2);
  assert.equal(load.variables.number, 8);                  // the new PR's load, not the old one's reload
  assert.equal(gh.calls.length, 3);
});

// ---- validation ---------------------------------------------------------------------

test('malformed arguments are refused before anything is queued', async () => {
  const { gh, store } = await ready();
  const line = { path: 'src/a.js', side: 'RIGHT', line: 1, body: 'x', mode: 'startReview' };
  const bad = [
    store.addComment({ ...line, side: 'UP' }),
    store.addComment({ ...line, line: 0 }),
    store.addComment({ ...line, line: 1.5 }),
    store.addComment({ ...line, startLine: 2 }),
    store.addComment({ ...line, body: '   ' }),
    store.addComment({ ...line, mode: 'later' }),
    store.addComment({ ...line, path: '/abs/a.js' }),
    store.addFileComment({ path: '', body: 'x', mode: 'commentNow' }),
    store.addComment(null),
    store.reply({ threadId: '', body: 'x' }),
    store.setResolved({ threadId: 'T_1', resolved: 'yes' }),
    store.deletePendingComment({}),
    store.submitReview({ event: 'DISMISS' }),
    store.setViewed({ path: 'src\\a.js', viewed: true }),
  ];
  for (const result of await Promise.all(bad)) {
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof ReviewStoreError);
    assert.equal(result.error.code, 'invalid-input');
  }
  assert.equal(gh.calls.length, 1);
});

test('GitHub\'s review rules are enforced before sending', async () => {
  const mine = answer({ viewerDidAuthor: true, pending: PENDING });
  const cases = [
    [answer(), (s) => s.submitReview({ event: 'REQUEST_CHANGES', body: ' ' }), /needs a summary/],
    [answer(), (s) => s.submitReview({ event: 'COMMENT' }), /summary or a pending comment/],
    [answer({ pending: { ...PENDING, comments: { totalCount: 0 } } }), (s) => s.submitReview({ event: 'COMMENT', body: '' }), /summary or a pending comment/],
    [mine, (s) => s.submitReview({ event: 'APPROVE' }), /cannot approve your own/],
    [mine, (s) => s.submitReview({ event: 'REQUEST_CHANGES', body: 'fix' }), /cannot request changes on your own/],
    [answer(), (s) => s.addComment({ path: 'a', side: 'RIGHT', line: 1, body: 'x', mode: 'addToReview' }), /no pending review/],
    [answer({ pending: PENDING }), (s) => s.addComment({ path: 'a', side: 'RIGHT', line: 1, body: 'x', mode: 'startReview' }), /already pending/],
    [answer({ pending: PENDING }), (s) => s.addFileComment({ path: 'a', body: 'x', mode: 'commentNow' }), /already pending/],
    [answer(), (s) => s.deletePendingComment({ commentId: 'C_1' }), /own pending comments/],
    [answer(), (s) => s.discardPendingReview(), /no pending review/],
    [answer({ threads: [thread(1, { viewerCanReply: false })] }), (s) => s.reply({ threadId: 'T_1', body: 'x' }), /cannot reply/],
    [answer({ threads: [thread(1, { viewerCanResolve: false })] }), (s) => s.setResolved({ threadId: 'T_1', resolved: true }), /cannot resolve/],
  ];
  for (const [fixture, act, message] of cases) {
    const { gh, store } = await ready(fixture);
    const result = await act(store);
    assert.equal(result.ok, false, String(message));
    assert.equal(result.error.code, 'rule', String(message));
    assert.match(result.error.message, message);
    assert.equal(gh.calls.length, 1, `${message}: nothing sent`);
  }
});

test('submitting: a comment with pending comments needs no summary; approving with none pending creates and submits at once', async () => {
  {
    const { gh, store } = await ready(answer({ pending: PENDING }));
    const done = store.submitReview({ event: 'COMMENT' });
    const write = await gh.call(1);
    assert.deepEqual(inputOf(write), { pullRequestReviewId: 'R_1', event: 'COMMENT' });
    write.resolve({ submitPullRequestReview: { pullRequestReview: { id: 'R_1', state: 'COMMENTED' } } });
    (await gh.call(2)).resolve(answer());
    assert.deepEqual(await done, { ok: true });
  }
  {
    const { gh, store } = await ready();
    const done = store.submitReview({ event: 'APPROVE', body: 'lgtm' });
    const write = await gh.call(1);
    assert.equal(write.name, 'ImpactTreeAddReview');
    assert.deepEqual(inputOf(write), { pullRequestId: 'PR_7', commitOID: HEAD, event: 'APPROVE', body: 'lgtm' });
    write.resolve({ addPullRequestReview: { pullRequestReview: { id: 'R_2', state: 'APPROVED' } } });
    (await gh.call(2)).resolve(answer());
    assert.deepEqual(await done, { ok: true });
  }
});

test('an unknown thread is reported as stale data, not sent', async () => {
  const { gh, store } = await ready();
  const result = await store.reply({ threadId: 'T_404', body: 'x' });
  assert.equal(result.error.code, 'stale');
  assert.equal(gh.calls.length, 1);
});

test('mutating before any data has loaded is refused as not ready', async () => {
  const { gh, store } = setup();
  store.sync();
  const done = store.setViewed({ path: 'src/a.js', viewed: true });
  (await gh.call(0)).reject(new GitHubRateLimitError('/graphql', 429, null));
  const result = await done;
  assert.equal(result.error.code, 'not-ready');
  assert.equal(gh.calls.length, 1);
});

// ---- disposal -----------------------------------------------------------------------

test('dispose aborts the load, and nothing fires or loads afterwards', async () => {
  const { gh, store, changes } = setup();
  store.sync();
  const load = await gh.call(0);
  changes.length = 0;
  store.dispose();
  assert.equal(load.signal.aborted, true);
  load.resolve(answer());
  await settle();
  await store.refresh();
  store.sync();
  assert.deepEqual(changes, []);
  assert.deepEqual(store.getState(), { kind: 'none' });
  assert.equal(gh.calls.length, 1);
});

test('dispose aborts the mutation in flight and fails the queued ones; no reload follows', async () => {
  const { gh, store, changes } = await ready();
  const running = store.setResolved({ threadId: 'T_1', resolved: true });
  const queued = store.setViewed({ path: 'src/a.js', viewed: true });
  const write = await gh.call(1);
  store.dispose();
  assert.equal(write.signal.aborted, true);
  assert.equal((await queued).error.code, 'disposed');
  write.resolve({ resolveReviewThread: { thread: { id: 'T_1', isResolved: true } } });
  await running;
  await settle();
  assert.equal(gh.calls.length, 2);
  assert.deepEqual(changes, []);
  assert.equal((await store.setViewed({ path: 'src/a.js', viewed: true })).error.code, 'disposed');
});

// ---- pure helpers -------------------------------------------------------------------

test('changedPaths names files whose threads or viewed state differ, and nothing else', async () => {
  const load = async (fixture) => {
    const { store } = await ready(fixture);
    return reviewDataOf(store.getState());
  };
  const files = [{ path: 'src/a.js', viewerViewedState: 'UNVIEWED' }, { path: 'src/c.js', viewerViewedState: 'UNVIEWED' }];
  const base = await load(answer({ threads: [thread(1), thread(2, { path: 'src/b.js' })], files }));
  const same = await load(answer({ threads: [thread(1), thread(2, { path: 'src/b.js' })], files }));
  const changed = await load(answer({
    threads: [thread(1, { isResolved: true })],
    files: [files[0], { path: 'src/c.js', viewerViewedState: 'VIEWED' }],
  }));
  assert.deepEqual(changedPaths(base, same), []);
  assert.deepEqual(changedPaths(base, changed), ['src/a.js', 'src/b.js', 'src/c.js']);
});

test('reviewTargetOf: PR previews and checkouts have a target, local reviews none', () => {
  const slug = () => ({ owner: 'o', repo: 'r' });
  const pr = { number: 7, headSha: HEAD };
  assert.equal(reviewTargetOf({ kind: 'local' }, () => { throw new Error('git must not run'); }), null);
  assert.equal(reviewTargetOf(undefined, slug), null);
  assert.deepEqual(reviewTargetOf({ kind: 'pr', pr }, slug), TARGET);
  assert.deepEqual(reviewTargetOf({ kind: 'checkout', pr, sha: 'd'.repeat(40) }, slug), { ...TARGET, headOid: 'd'.repeat(40) });
  assert.throws(() => reviewTargetOf({ kind: 'pr', pr }, () => null), /not a GitHub repository/);
});
