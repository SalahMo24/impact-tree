// @ts-check
'use strict';
// What GitHub knows about the review of one pull request: its threads, the viewer's
// pending review, per-file viewed state and a short timeline. Reading only; writes belong
// to the review-loop store. The query text and the normalisation are pure; the one
// function that does I/O, `loadPullRequestReview`, takes the GitHub client as a dependency.

const { GitHubResponseError } = require('./github-request');
const { throwIfCancelled } = require('./engine/cancellation');

const ENDPOINT = '/graphql';

/**
 * Page budgets for one load. Owner: `loadPullRequestReview`, which takes overrides
 * through its `budgets` option; the extension passes none. Chosen by the product owner;
 * revisit if real pull requests hit them. Every budget is an integer from 1 to
 * `MAX_BUDGET`; anything else is a `RangeError`. Page 1 is always fetched, so 0 would
 * mean "load nothing and report success".
 *
 * - `maxThreadPages`: pages of 100 review threads, default 5 (500 threads), counting the
 *   first query's page. Enforced before each follow-up request. Exhaustion: the threads
 *   so far are returned and `incomplete` says that more exist (GitHub's own
 *   `hasNextPage`, so exactly at the cap is not reported as truncation).
 * - `maxFilePages`: pages of 100 changed files, default 30 (3,000 files, which is
 *   GitHub's own ceiling for a pull request's file list). Same enforcement and
 *   exhaustion; the files past the budget have no viewed state in the result.
 *
 * Comments inside a thread are not paged: only the first `COMMENTS_PER_THREAD` are
 * read. A thread with more says so on the thread and on the result. The timeline is a
 * deliberate window of the newest `TIMELINE_WINDOW` items, not a truncated read.
 */
const DEFAULT_BUDGETS = Object.freeze({ maxThreadPages: 5, maxFilePages: 30 });
const MAX_BUDGET = 100;

/** Nodes per page, and comments read per thread. GitHub's maximum for `first` is 100. */
const PAGE_SIZE = 100;
const COMMENTS_PER_THREAD = 100;
/** Newest timeline items (reviews and issue comments) kept. */
const TIMELINE_WINDOW = 50;

const AUTHOR_FIELDS = 'login avatarUrl';

const THREAD_FIELDS = `
  id isResolved isOutdated path line originalLine startLine originalStartLine
  diffSide subjectType viewerCanResolve viewerCanUnresolve viewerCanReply
  comments(first: ${COMMENTS_PER_THREAD}) {
    totalCount
    pageInfo { hasNextPage }
    nodes {
      id databaseId author { ${AUTHOR_FIELDS} } body createdAt state viewerDidAuthor url
    }
  }`;

const THREADS_CONNECTION = `reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
    nodes {${THREAD_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  }`;

const FILES_CONNECTION = `files(first: ${PAGE_SIZE}, after: $cursor) {
    nodes { path viewerViewedState }
    pageInfo { hasNextPage endCursor }
  }`;

/** Page 1 of everything. `$cursor` is declared once and unset, so it is null. */
const REVIEW_QUERY = `query ImpactTreePullRequestReview($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title body url state
      author { ${AUTHOR_FIELDS} }
      viewerDidAuthor headRefOid baseRefOid headRefName baseRefName
      ${THREADS_CONNECTION}
      reviews(states: PENDING, first: 1) {
        nodes { id databaseId comments { totalCount } }
      }
      ${FILES_CONNECTION}
      timelineItems(last: ${TIMELINE_WINDOW}, itemTypes: [PULL_REQUEST_REVIEW, ISSUE_COMMENT]) {
        nodes {
          __typename
          ... on PullRequestReview { id author { ${AUTHOR_FIELDS} } createdAt body state }
          ... on IssueComment { id author { ${AUTHOR_FIELDS} } createdAt body }
        }
      }
    }
  }
}`;

/** Follow-up page of threads. */
const THREADS_PAGE_QUERY = `query ImpactTreeReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${THREADS_CONNECTION}
    }
  }
}`;

/** Follow-up page of changed files. */
const FILES_PAGE_QUERY = `query ImpactTreeReviewFiles($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${FILES_CONNECTION}
    }
  }
}`;

/**
 * @typedef {{ login: string, avatarUrl: string|null }} ReviewAuthor
 *
 * @typedef {object} ReviewComment
 * @property {string} id GraphQL node id.
 * @property {number|null} databaseId REST id, when GitHub gives one.
 * @property {ReviewAuthor|null} author Null for a deleted user.
 * @property {string} body
 * @property {string} createdAt ISO 8601.
 * @property {boolean} pending Part of the viewer's unsubmitted review.
 * @property {boolean} mine The viewer wrote it.
 * @property {string} url
 *
 * @typedef {object} ReviewThread
 * @property {string} id GraphQL node id.
 * @property {string} path Repository-relative, forward slashes.
 * @property {'LEFT'|'RIGHT'} side LEFT is the base file, RIGHT the head file.
 * @property {number|null} line 1-based line on `side` in the current diff; null for a
 *   file-level or outdated thread, which has no line there.
 * @property {number|null} originalLine 1-based line when the thread was written.
 * @property {number|null} startLine 1-based first line of a multi-line thread, under the
 *   same rule as `line`.
 * @property {boolean} isResolved
 * @property {boolean} isOutdated
 * @property {boolean} fileLevel The thread is on the whole file (subjectType FILE).
 * @property {boolean} canResolve
 * @property {boolean} canUnresolve
 * @property {boolean} canReply
 * @property {ReviewComment[]} comments Oldest first, at most `COMMENTS_PER_THREAD`.
 * @property {string[]} [incomplete] Present only when comments were left unread.
 *
 * @typedef {'VIEWED'|'UNVIEWED'|'DISMISSED'} ViewedState
 *
 * @typedef {object} TimelineItem
 * @property {'review'|'comment'} kind A submitted or pending review, or an issue comment.
 * @property {string} id
 * @property {ReviewAuthor|null} author
 * @property {string} createdAt
 * @property {string} body
 * @property {string|null} reviewState Review state for `kind: 'review'`, else null.
 *
 * @typedef {object} PullRequestSummary
 * @property {string} id
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {string} url
 * @property {'OPEN'|'CLOSED'|'MERGED'} state
 * @property {ReviewAuthor|null} author
 * @property {boolean} viewerDidAuthor
 * @property {string} headRefOid Pinned head commit.
 * @property {string} baseRefOid Pinned base commit.
 * @property {string} headRefName Mutable branch name.
 * @property {string} baseRefName Mutable branch name.
 *
 * @typedef {object} ReviewModel
 * @property {PullRequestSummary} pr
 * @property {ReviewThread[]} threads
 * @property {{ id: string, databaseId: number|null, commentCount: number }|null} pendingReview
 *   The viewer's own pending review; GitHub never returns anyone else's.
 * @property {Map<string, ViewedState>} viewed Repository-relative path to state; paths
 *   past the file budget are absent.
 * @property {TimelineItem[]} timeline Newest 50 reviews and issue comments, oldest first.
 * @property {string[]} incomplete Why the model is not the whole story; empty when it is.
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {v is string} */
const isString = (v) => typeof v === 'string';
/** @param {unknown} v @returns {v is boolean} */
const isBoolean = (v) => typeof v === 'boolean';

/**
 * @param {string} problem
 * @returns {never}
 */
function bad(problem) { throw new GitHubResponseError(ENDPOINT, problem); }

/**
 * @param {unknown} value
 * @param {string[]} allowed
 * @param {string} what Names the field and its owner in the error.
 */
function oneOf(value, allowed, what) {
  if (!isString(value) || !allowed.includes(value)) bad(`${what} is ${JSON.stringify(value)}, expected one of ${allowed.join(', ')}`);
  return value;
}

/** @param {unknown} value @param {string} what */
function str(value, what) {
  if (!isString(value)) bad(`${what} is not a string`);
  return value;
}

/** @param {unknown} value @param {string} what */
function bool(value, what) {
  if (!isBoolean(value)) bad(`${what} is not a boolean`);
  return value;
}

/** @param {unknown} value @param {string} what */
function object(value, what) {
  if (!isObject(value)) bad(`${what} is not an object`);
  return value;
}

/** A 1-based line number, or null. @param {unknown} value @param {string} what */
function lineOrNull(value, what) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) bad(`${what} is not a 1-based line number or null`);
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {string} what */
function count(value, what) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) bad(`${what} is not a non-negative integer`);
  return /** @type {number} */ (value);
}

/** @param {unknown} raw @param {string} what @returns {ReviewAuthor|null} */
function author(raw, what) {
  if (raw == null) return null; // a deleted account
  const a = object(raw, what);
  if (a.avatarUrl != null && !isString(a.avatarUrl)) bad(`${what}.avatarUrl is not a string`);
  return { login: str(a.login, `${what}.login`), avatarUrl: a.avatarUrl == null ? null : /** @type {string} */ (a.avatarUrl) };
}

/**
 * A `{ nodes, pageInfo }` connection.
 * @param {unknown} raw
 * @param {string} what
 * @returns {{ nodes: unknown[], hasNextPage: boolean, endCursor: string|null }}
 */
function connection(raw, what) {
  const c = object(raw, what);
  if (!Array.isArray(c.nodes)) bad(`${what}.nodes is not a list`);
  const info = object(c.pageInfo, `${what}.pageInfo`);
  const hasNextPage = bool(info.hasNextPage, `${what}.pageInfo.hasNextPage`);
  if (info.endCursor != null && !isString(info.endCursor)) bad(`${what}.pageInfo.endCursor is not a string`);
  // Paging on without a cursor would refetch page 1 forever.
  if (hasNextPage && !isString(info.endCursor)) bad(`${what} has more pages but no endCursor`);
  return { nodes: c.nodes, hasNextPage, endCursor: info.endCursor == null ? null : /** @type {string} */ (info.endCursor) };
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {ReviewComment}
 */
function normaliseComment(raw, what) {
  const c = object(raw, what);
  if (c.databaseId != null && !Number.isSafeInteger(c.databaseId)) bad(`${what}.databaseId is not an integer`);
  return {
    id: str(c.id, `${what}.id`),
    databaseId: c.databaseId == null ? null : /** @type {number} */ (c.databaseId),
    author: author(c.author, `${what}.author`),
    body: str(c.body, `${what}.body`),
    createdAt: str(c.createdAt, `${what}.createdAt`),
    pending: oneOf(c.state, ['PENDING', 'SUBMITTED'], `${what}.state`) === 'PENDING',
    mine: bool(c.viewerDidAuthor, `${what}.viewerDidAuthor`),
    url: str(c.url, `${what}.url`),
  };
}

/**
 * @param {unknown} raw One `reviewThreads` node.
 * @returns {ReviewThread}
 */
function normaliseThread(raw) {
  const t = object(raw, 'a review thread');
  const id = str(t.id, 'a review thread `id`');
  const what = `review thread ${id}`;
  const side = /** @type {'LEFT'|'RIGHT'} */ (oneOf(t.diffSide, ['LEFT', 'RIGHT'], `${what}.diffSide`));
  const fileLevel = oneOf(t.subjectType, ['LINE', 'FILE'], `${what}.subjectType`) === 'FILE';
  const isOutdated = bool(t.isOutdated, `${what}.isOutdated`);
  const line = lineOrNull(t.line, `${what}.line`);
  const startLine = lineOrNull(t.startLine, `${what}.startLine`);
  lineOrNull(t.originalStartLine, `${what}.originalStartLine`);
  // An outdated or file-level thread has no place in the current diff, whatever else the
  // answer carries; the contract is null there so no consumer draws it on a wrong line.
  const placed = !isOutdated && !fileLevel;

  const comments = object(t.comments, `${what}.comments`);
  const total = count(comments.totalCount, `${what}.comments.totalCount`);
  const hasMore = bool(object(comments.pageInfo, `${what}.comments.pageInfo`).hasNextPage, `${what}.comments.pageInfo.hasNextPage`);
  if (!Array.isArray(comments.nodes)) bad(`${what}.comments.nodes is not a list`);
  const nodes = comments.nodes.map((n, i) => normaliseComment(n, `${what} comment ${i}`));

  /** @type {ReviewThread} */
  const thread = {
    id,
    path: str(t.path, `${what}.path`),
    side,
    line: placed ? line : null,
    originalLine: lineOrNull(t.originalLine, `${what}.originalLine`),
    startLine: placed ? startLine : null,
    isResolved: bool(t.isResolved, `${what}.isResolved`),
    isOutdated,
    fileLevel,
    canResolve: bool(t.viewerCanResolve, `${what}.viewerCanResolve`),
    canUnresolve: bool(t.viewerCanUnresolve, `${what}.viewerCanUnresolve`),
    canReply: bool(t.viewerCanReply, `${what}.viewerCanReply`),
    comments: nodes,
  };
  if (hasMore || total > nodes.length) {
    thread.incomplete = [`only the first ${nodes.length} of ${total} comments were read`];
  }
  return thread;
}

/** @param {unknown} raw @returns {PullRequestSummary} */
function normalisePullRequestSummary(raw) {
  const p = object(raw, 'the pull request');
  const what = 'the pull request';
  return {
    id: str(p.id, `${what}.id`),
    number: count(p.number, `${what}.number`),
    title: str(p.title, `${what}.title`),
    body: str(p.body, `${what}.body`),
    url: str(p.url, `${what}.url`),
    state: /** @type {'OPEN'|'CLOSED'|'MERGED'} */ (oneOf(p.state, ['OPEN', 'CLOSED', 'MERGED'], `${what}.state`)),
    author: author(p.author, `${what}.author`),
    viewerDidAuthor: bool(p.viewerDidAuthor, `${what}.viewerDidAuthor`),
    headRefOid: str(p.headRefOid, `${what}.headRefOid`),
    baseRefOid: str(p.baseRefOid, `${what}.baseRefOid`),
    headRefName: str(p.headRefName, `${what}.headRefName`),
    baseRefName: str(p.baseRefName, `${what}.baseRefName`),
  };
}

/** @param {unknown} raw @returns {ReviewModel['pendingReview']} */
function normalisePendingReview(raw) {
  const { nodes } = object(raw, 'the pending review list');
  if (!Array.isArray(nodes)) bad('the pending review list `nodes` is not a list');
  if (nodes.length === 0) return null;
  // `first: 1` and GitHub only returns the viewer's own: a second one breaks that premise.
  if (nodes.length > 1) bad('more than one pending review returned');
  const r = object(nodes[0], 'the pending review');
  if (r.databaseId != null && !Number.isSafeInteger(r.databaseId)) bad('the pending review `databaseId` is not an integer');
  return {
    id: str(r.id, 'the pending review `id`'),
    databaseId: r.databaseId == null ? null : /** @type {number} */ (r.databaseId),
    commentCount: count(object(r.comments, 'the pending review `comments`').totalCount, 'the pending review `comments.totalCount`'),
  };
}

/** @param {unknown} raw @returns {TimelineItem[]} */
function normaliseTimeline(raw) {
  const c = object(raw, 'the timeline');
  if (!Array.isArray(c.nodes)) bad('the timeline `nodes` is not a list');
  return c.nodes.map((n, i) => {
    const what = `timeline item ${i}`;
    const item = object(n, what);
    const type = oneOf(item.__typename, ['PullRequestReview', 'IssueComment'], `${what}.__typename`);
    const isReview = type === 'PullRequestReview';
    return {
      kind: isReview ? 'review' : 'comment',
      id: str(item.id, `${what}.id`),
      author: author(item.author, `${what}.author`),
      createdAt: str(item.createdAt, `${what}.createdAt`),
      body: str(item.body, `${what}.body`),
      reviewState: isReview
        ? oneOf(item.state, ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'], `${what}.state`)
        : null,
    };
  });
}

/**
 * @param {unknown} raw One `files` node.
 * @returns {{ path: string, state: ViewedState }}
 */
function normaliseFile(raw) {
  const f = object(raw, 'a changed file');
  const path = str(f.path, 'a changed file `path`');
  return {
    path,
    state: /** @type {ViewedState} */ (oneOf(f.viewerViewedState, ['VIEWED', 'UNVIEWED', 'DISMISSED'], `changed file ${path} \`viewerViewedState\``)),
  };
}

/**
 * Normalises the parts of an answer that are paged: validates each node and returns
 * the model's pieces. Pure.
 * @param {unknown} rawPullRequest A `pullRequest` object from the first query.
 * @returns {{
 *   pr: PullRequestSummary, threads: { nodes: ReviewThread[], hasNextPage: boolean, endCursor: string|null },
 *   files: { nodes: { path: string, state: ViewedState }[], hasNextPage: boolean, endCursor: string|null },
 *   pendingReview: ReviewModel['pendingReview'], timeline: TimelineItem[],
 * }}
 */
function normaliseFirstPage(rawPullRequest) {
  const p = object(rawPullRequest, 'the pull request');
  const threads = connection(p.reviewThreads, 'reviewThreads');
  const files = connection(p.files, 'files');
  return {
    pr: normalisePullRequestSummary(p),
    threads: { ...threads, nodes: threads.nodes.map(normaliseThread) },
    files: { ...files, nodes: files.nodes.map(normaliseFile) },
    pendingReview: normalisePendingReview(p.reviews),
    timeline: normaliseTimeline(p.timelineItems),
  };
}

/**
 * @param {Record<string, unknown>} data The `data` object of an answer.
 * @param {number} number
 * @returns {Record<string, unknown>} The `pullRequest` object.
 */
function pullRequestOf(data, number) {
  const repo = data.repository;
  if (!isObject(repo)) bad('no `repository` in the answer');
  if (!isObject(repo.pullRequest)) bad(`no pull request #${number} in the answer`);
  return repo.pullRequest;
}

/**
 * @param {Partial<typeof DEFAULT_BUDGETS>|undefined} overrides
 * @returns {{ maxThreadPages: number, maxFilePages: number }}
 */
function resolveBudgets(overrides) {
  const budgets = { ...DEFAULT_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BUDGET) {
      throw new RangeError(`${name} must be an integer from 1 to ${MAX_BUDGET}`);
    }
  }
  return budgets;
}

/**
 * Loads and normalises the review state of one pull request: page 1 of everything in a
 * single query, then threads and files separately by cursor until done or the budget is
 * spent. Does I/O only through `gh.graphql`, and lets its errors (typed GitHub errors,
 * cancellation) propagate: a failed read is never an empty model.
 * @param {{ graphql: (query: string, variables?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>> }} gh
 * @param {{ owner: string, name: string, number: number }} target Repository owner and name,
 *   and the pull request number.
 * @param {{ signal?: AbortSignal, budgets?: Partial<typeof DEFAULT_BUDGETS> }} [options]
 * @returns {Promise<ReviewModel>}
 * @throws {RangeError} A budget or the target is out of range.
 * @throws {GitHubResponseError} A node is not the shape this module relies on.
 * @throws {Error} Whatever `gh.graphql` throws, including cancellation.
 */
async function loadPullRequestReview(gh, { owner, name, number }, { signal, budgets } = {}) {
  if (!isString(owner) || owner === '' || !isString(name) || name === '') throw new RangeError('owner and name must be non-empty strings');
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError('number must be a positive integer');
  const { maxThreadPages, maxFilePages } = resolveBudgets(budgets);
  const base = { owner, name, number };

  throwIfCancelled(signal);
  const first = normaliseFirstPage(pullRequestOf(await gh.graphql(REVIEW_QUERY, { ...base, cursor: null }, { signal }), number));
  const { pr, pendingReview, timeline } = first;
  const threads = first.threads.nodes;
  const viewed = new Map(first.files.nodes.map((f) => [f.path, f.state]));
  /** @type {string[]} */
  const incomplete = [];

  let threadPages = 1;
  let { hasNextPage: moreThreads, endCursor: threadCursor } = first.threads;
  while (moreThreads && threadPages < maxThreadPages) {
    throwIfCancelled(signal);
    const answer = pullRequestOf(await gh.graphql(THREADS_PAGE_QUERY, { ...base, cursor: threadCursor }, { signal }), number);
    const page = connection(answer.reviewThreads, 'reviewThreads');
    threads.push(...page.nodes.map(normaliseThread));
    threadPages += 1;
    moreThreads = page.hasNextPage;
    threadCursor = page.endCursor;
  }
  if (moreThreads) incomplete.push(`review threads: only the first ${threads.length} were loaded (budget ${maxThreadPages} pages of ${PAGE_SIZE})`);

  let filePages = 1;
  let { hasNextPage: moreFiles, endCursor: fileCursor } = first.files;
  while (moreFiles && filePages < maxFilePages) {
    throwIfCancelled(signal);
    const answer = pullRequestOf(await gh.graphql(FILES_PAGE_QUERY, { ...base, cursor: fileCursor }, { signal }), number);
    const page = connection(answer.files, 'files');
    for (const f of page.nodes.map(normaliseFile)) viewed.set(f.path, f.state);
    filePages += 1;
    moreFiles = page.hasNextPage;
    fileCursor = page.endCursor;
  }
  if (moreFiles) incomplete.push(`changed files: viewed state for only the first ${viewed.size} was loaded (budget ${maxFilePages} pages of ${PAGE_SIZE})`);

  for (const t of threads) {
    for (const reason of t.incomplete || []) incomplete.push(`thread ${t.id} on ${t.path}: ${reason}`);
  }
  return { pr, threads, pendingReview, viewed, timeline, incomplete };
}

/**
 * Threads drawn on lines of the head file: RIGHT side, not outdated, not file-level,
 * with `line` inside the 1-based inclusive range.
 * @param {Pick<ReviewModel, 'threads'>} model
 * @param {string} relPath Repository-relative path.
 * @param {number} lo 1-based, inclusive.
 * @param {number} hi 1-based, inclusive.
 * @returns {ReviewThread[]}
 */
function threadsForRange(model, relPath, lo, hi) {
  return model.threads.filter((t) => t.path === relPath && t.side === 'RIGHT' && !t.isOutdated
    && !t.fileLevel && t.line !== null && t.line >= lo && t.line <= hi);
}

/**
 * Every thread on a path: either side, outdated and file-level included.
 * @param {Pick<ReviewModel, 'threads'>} model
 * @param {string} relPath Repository-relative path.
 * @returns {ReviewThread[]}
 */
function threadsForFile(model, relPath) {
  return model.threads.filter((t) => t.path === relPath);
}

/**
 * Unresolved threads that someone has posted in: a thread holding only the viewer's
 * pending comments is not open for anyone else yet.
 * @param {ReviewThread[]} threads
 * @returns {number}
 */
function openCount(threads) {
  return threads.filter((t) => !t.isResolved && t.comments.some((c) => !c.pending)).length;
}

/**
 * Pending (unsubmitted) comments across the threads, counted per comment.
 * @param {ReviewThread[]} threads
 * @returns {number}
 */
function pendingCount(threads) {
  let total = 0;
  for (const t of threads) for (const c of t.comments) if (c.pending) total += 1;
  return total;
}

module.exports = {
  DEFAULT_BUDGETS, MAX_BUDGET, PAGE_SIZE, COMMENTS_PER_THREAD, TIMELINE_WINDOW,
  REVIEW_QUERY, THREADS_PAGE_QUERY, FILES_PAGE_QUERY,
  loadPullRequestReview, normaliseFirstPage, normaliseThread,
  threadsForRange, threadsForFile, openCount, pendingCount,
};
