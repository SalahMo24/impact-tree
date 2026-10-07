// @ts-check
'use strict';
// The review-loop store: the one owner of what GitHub says about the review of the pull
// request being reviewed (threads, the viewer's pending review, viewed state), and the
// one way to change it. It knows a target only while a PR preview or a PR checkout is the
// current analysis; for anything else it holds nothing and does no I/O.
//
// Lifecycle, in one lane: at most one GitHub operation (a load or a mutation) runs at a
// time. A wanted load runs before the next queued mutation, so every mutation starts from
// the data its predecessor produced, and no load ever observes a half-applied sequence
// such as "create a pending review, then add a thread to it". Loads are generation
// checked: one that was superseded (target change, refresh, dispose) is aborted through
// its AbortController and its answer is discarded even if it arrives later.

const assert = require('node:assert/strict');
const { loadPullRequestReview } = require('./pr-review-data');
const { GitHubResponseError } = require('./github-request');
const { throwIfCancelled } = require('./engine/cancellation');

const ENDPOINT = '/graphql';

// Mutation texts. Every one takes its whole input as `$input`, so optional fields are
// simply left out of the variables rather than sent as null.
const MUTATIONS = Object.freeze({
  /** Creates a pending review (no `event`), or a submitted one when `event` is given. */
  addReview: `mutation ImpactTreeAddReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { id state } }
}`,
  addThread: `mutation ImpactTreeAddThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id } }
}`,
  reply: `mutation ImpactTreeReply($input: AddPullRequestReviewThreadReplyInput!) {
  addPullRequestReviewThreadReply(input: $input) { comment { id } }
}`,
  resolve: `mutation ImpactTreeResolve($input: ResolveReviewThreadInput!) {
  resolveReviewThread(input: $input) { thread { id isResolved } }
}`,
  unresolve: `mutation ImpactTreeUnresolve($input: UnresolveReviewThreadInput!) {
  unresolveReviewThread(input: $input) { thread { id isResolved } }
}`,
  deleteComment: `mutation ImpactTreeDeleteComment($input: DeletePullRequestReviewCommentInput!) {
  deletePullRequestReviewComment(input: $input) { clientMutationId }
}`,
  submitReview: `mutation ImpactTreeSubmitReview($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) { pullRequestReview { id state } }
}`,
  deleteReview: `mutation ImpactTreeDeleteReview($input: DeletePullRequestReviewInput!) {
  deletePullRequestReview(input: $input) { pullRequestReview { id } }
}`,
  markViewed: `mutation ImpactTreeMarkViewed($input: MarkFileAsViewedInput!) {
  markFileAsViewed(input: $input) { pullRequest { id } }
}`,
  unmarkViewed: `mutation ImpactTreeUnmarkViewed($input: UnmarkFileAsViewedInput!) {
  unmarkFileAsViewed(input: $input) { pullRequest { id } }
}`,
});

const COMMENT_MODES = Object.freeze(['startReview', 'commentNow', 'addToReview']);
const REVIEW_EVENTS = Object.freeze(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
const SIDES = Object.freeze(['LEFT', 'RIGHT']);
// A SHA-1 or SHA-256 commit id, as GitHub's GitObjectID.
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * @typedef {import('./pr-review-data').ReviewModel} ReviewModel
 * @typedef {import('./pr-review-data').ReviewThread} ReviewThread
 *
 * @typedef {object} ReviewTarget The pull request under review, pinned to the commit the
 *   analysis reviewed (a PR preview's head, or the commit a checkout checked out).
 * @property {string} owner
 * @property {string} name Repository name.
 * @property {number} number
 * @property {string} headOid Pending reviews are created against this commit.
 *
 * @typedef {{ kind: 'none' }
 *   | { kind: 'loading', target: ReviewTarget, previous: ReviewModel|null }
 *   | { kind: 'ready', target: ReviewTarget, model: ReviewModel }
 *   | { kind: 'failed', target: ReviewTarget|null, error: Error, previous: ReviewModel|null }} ReviewStoreState
 *   `none`: not reviewing a pull request. `loading`: a load is wanted or running;
 *   `previous` is what was shown before for the same target. `ready`: the last load
 *   succeeded. `failed`: the last load failed; `previous` is kept for display but is not
 *   current. A null `target` in `failed` means the target itself was invalid. States are
 *   frozen; the models inside are shared with every reader and must not be mutated.
 *
 * @typedef {{ paths: string[]|null }} ReviewStoreChange `paths` names the
 *   repository-relative files whose threads or viewed state changed; empty when only the
 *   state or pull-request-wide data (pending review, timeline, summary) changed; null when
 *   the shown data was replaced wholesale (first data, target change, dropped).
 *
 * @typedef {{ ok: true } | { ok: false, error: Error }} MutationResult
 *
 * @typedef {object} StoreDeps
 * @property {{ graphql: (query: string, variables?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<Record<string, unknown>> }} gh
 * @property {() => unknown} getTarget The PR review that is current (a raw `ReviewTarget`, validated here), or null
 *   for local and agent reviews. Read on `sync()`.
 * @property {() => number} getAnalysisId The analysis generation; a load whose generation
 *   is no longer current publishes nothing.
 * @property {(message: string) => void} [log]
 * @property {Partial<import('./pr-review-data').DEFAULT_BUDGETS>} [budgets] Passed to the load.
 */

/**
 * A mutation refused before anything was sent, or not run at all.
 * - `invalid-input`: an argument is not of the documented shape.
 * - `rule`: GitHub would refuse it (e.g. approving one's own pull request) or the review
 *   is not in a state that allows it (e.g. adding to a pending review that does not exist).
 * - `not-ready`: no review data is loaded to act on.
 * - `stale`: the reviewed pull request changed between the request and its turn.
 * - `disposed`: the store was disposed first.
 */
class ReviewStoreError extends Error {
  /** @param {'invalid-input'|'rule'|'not-ready'|'stale'|'disposed'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ReviewStoreError';
    this.code = code;
  }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {v is string} */
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
/** @param {unknown} v */
const isLine = (v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 1;

/** @param {Error} error @returns {MutationResult} */
const failed = (error) => ({ ok: false, error });
/** @param {string} message */
const invalid = (message) => failed(new ReviewStoreError('invalid-input', message));
/** @param {string} message @returns {never} */
const refuse = (message) => { throw new ReviewStoreError('rule', message); };

/**
 * The data a state shows: the model when ready, the previous model while loading or
 * after a failure, nothing otherwise.
 * @param {ReviewStoreState} state
 * @returns {ReviewModel|null}
 */
function reviewDataOf(state) {
  if (state.kind === 'ready') return state.model;
  if (state.kind === 'loading' || state.kind === 'failed') return state.previous;
  return null;
}

/**
 * @param {unknown} raw
 * @returns {ReviewTarget}
 * @throws {RangeError} A field is missing or malformed.
 */
function validateTarget(raw) {
  if (!isObject(raw)) throw new RangeError('a review target must be an object');
  const { owner, name, number, headOid } = raw;
  if (!isNonEmptyString(owner) || !isNonEmptyString(name)) throw new RangeError('a review target needs a non-empty owner and name');
  if (!Number.isSafeInteger(number) || /** @type {number} */ (number) < 1) throw new RangeError('a review target needs a positive pull request number');
  if (typeof headOid !== 'string' || !OID.test(headOid)) throw new RangeError(`review target #${number} has no head commit id`);
  return Object.freeze({ owner, name, number: /** @type {number} */ (number), headOid });
}

/**
 * The review target of a session source: a PR preview reviews the PR's head as listed,
 * a checkout the commit it checked out. Anything else (local, agent) has none. The slug
 * is read only for a PR source, since reading it runs git.
 * @param {unknown} source The session's `state.source`.
 * @param {() => { owner: string, repo: string }|null} repoSlug origin's owner and name.
 * @returns {unknown} A raw target for `validateTarget` (which the store applies), or null.
 * @throws {Error} A PR review in a repository whose origin is not on GitHub.
 */
function reviewTargetOf(source, repoSlug) {
  if (!isObject(source) || (source.kind !== 'pr' && source.kind !== 'checkout')) return null;
  const pr = isObject(source.pr) ? source.pr : {};
  const slug = repoSlug();
  if (!slug) throw new Error('the repository\'s origin is not a GitHub repository, so its review threads cannot be loaded');
  return { owner: slug.owner, name: slug.repo, number: pr.number, headOid: source.kind === 'checkout' ? source.sha : pr.headSha };
}

/** @param {ReviewTarget|null} t */
const keyOf = (t) => (t ? `${t.owner}/${t.name}#${t.number}@${t.headOid}` : null);

/**
 * Repository-relative paths whose threads or viewed state differ between two models,
 * sorted. Pure; work is linear in the size of both models.
 * @param {ReviewModel} before
 * @param {ReviewModel} after
 * @returns {string[]}
 */
function changedPaths(before, after) {
  /** @param {ReviewModel} model */
  const signatures = (model) => {
    /** @type {Map<string, ReviewThread[]>} */
    const byPath = new Map();
    for (const t of model.threads) {
      const list = byPath.get(t.path);
      if (list) list.push(t); else byPath.set(t.path, [t]);
    }
    /** @type {Map<string, string>} */
    const out = new Map();
    for (const path of new Set([...byPath.keys(), ...model.viewed.keys()])) {
      out.set(path, JSON.stringify([model.viewed.get(path) || null, byPath.get(path) || []]));
    }
    return out;
  };
  const a = signatures(before);
  const b = signatures(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
}

/**
 * The payload object a mutation answered with, checked to be present.
 * @param {Record<string, unknown>} data
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
function payloadOf(data, field) {
  const payload = data[field];
  if (!isObject(payload)) throw new GitHubResponseError(ENDPOINT, `\`${field}\` is missing from the answer`);
  return payload;
}

/**
 * The `id` of `payload[field]`, checked to be a non-empty string.
 * @param {Record<string, unknown>} payload
 * @param {string} field
 * @param {string} mutation Names the mutation in the error.
 * @returns {string}
 */
function idIn(payload, field, mutation) {
  const node = payload[field];
  if (!isObject(node) || !isNonEmptyString(node.id)) throw new GitHubResponseError(ENDPOINT, `${mutation} answered without \`${field}.id\``);
  return node.id;
}

/**
 * What a mutation works with: the data loaded when its turn came, the target it was
 * requested for, and the only way it reaches GitHub.
 * @typedef {object} MutationContext
 * @property {ReviewModel} model
 * @property {ReviewTarget} target
 * @property {AbortSignal} signal Aborted when the store is disposed.
 * @property {(query: string, input: Record<string, unknown>, field: string) => Promise<Record<string, unknown>>} write
 *   Sends one mutation and returns its payload object. Marks the context `applied`.
 * @property {boolean} applied Whether GitHub may now differ from `model`, so the store
 *   must reload. Cleared when a failed sequence was undone.
 * @property {(message: string) => void} log
 */

/**
 * @param {ReviewModel} model
 * @param {string} threadId
 * @returns {ReviewThread}
 */
function findThread(model, threadId) {
  const thread = model.threads.find((t) => t.id === threadId);
  if (!thread) throw new ReviewStoreError('stale', `thread ${threadId} is not in the loaded review; refresh and try again`);
  return thread;
}

/**
 * Adds a thread and checks GitHub answered with it.
 * @param {MutationContext} ctx
 * @param {Record<string, unknown>} input
 */
async function addThread(ctx, input) {
  idIn(await ctx.write(MUTATIONS.addThread, input, 'addPullRequestReviewThread'), 'thread', 'addPullRequestReviewThread');
}

/**
 * Creates a pending review on the reviewed commit, runs `steps` against it, and deletes
 * it again if they fail, so a failed "start review" or "comment now" leaves no empty
 * pending review behind. If the undo fails too, it is logged and the store reloads
 * (`applied` stays set), so the stray review is shown rather than hidden.
 * @param {MutationContext} ctx
 * @param {(reviewId: string) => Promise<void>} steps
 */
async function withNewPendingReview(ctx, steps) {
  const created = await ctx.write(MUTATIONS.addReview,
    { pullRequestId: ctx.model.pr.id, commitOID: ctx.target.headOid }, 'addPullRequestReview');
  const reviewId = idIn(created, 'pullRequestReview', 'addPullRequestReview');
  try {
    throwIfCancelled(ctx.signal);
    await steps(reviewId);
  } catch (error) {
    try {
      await ctx.write(MUTATIONS.deleteReview, { pullRequestReviewId: reviewId }, 'deletePullRequestReview');
      ctx.applied = false;
    } catch (undoError) {
      ctx.log(`review store: could not delete pending review ${reviewId} after a failed comment: ${/** @type {Error} */ (undoError).message}`);
    }
    throw error;
  }
}

/**
 * @typedef {{ path: string, body: string, mode: 'startReview'|'commentNow'|'addToReview' }
 *   & ({ fileLevel: true } | { fileLevel: false, side: 'LEFT'|'RIGHT', line: number, startLine?: number })} CommentRequest
 */

/**
 * The `AddPullRequestReviewThreadInput` fields that place a comment.
 * @param {CommentRequest} request
 * @returns {Record<string, unknown>}
 */
function placement(request) {
  if (request.fileLevel) return { path: request.path, body: request.body, subjectType: 'FILE' };
  const { path, body, side, line, startLine } = request;
  const range = startLine !== undefined && startLine !== line ? { startLine, startSide: side } : {};
  return { path, body, side, line, subjectType: 'LINE', ...range };
}

/** @param {MutationContext} ctx @param {CommentRequest} request */
async function performAddComment(ctx, request) {
  const pending = ctx.model.pendingReview;
  const thread = placement(request);
  if (request.mode === 'addToReview') {
    if (!pending) refuse('there is no pending review to add to — start a review first');
    await addThread(ctx, { ...thread, pullRequestReviewId: pending.id });
    return;
  }
  // GitHub allows one pending review per reviewer; with one open, comments go into it.
  if (pending) refuse('a review is already pending — add the comment to it instead');
  await withNewPendingReview(ctx, async (reviewId) => {
    await addThread(ctx, { ...thread, pullRequestReviewId: reviewId });
    if (request.mode !== 'commentNow') return;
    throwIfCancelled(ctx.signal);
    idIn(await ctx.write(MUTATIONS.submitReview, { pullRequestReviewId: reviewId, event: 'COMMENT' }, 'submitPullRequestReview'),
      'pullRequestReview', 'submitPullRequestReview');
  });
}

/**
 * A reply joins the viewer's pending review when there is one (GitHub then shows it only
 * on submit), and is posted at once otherwise.
 * @param {MutationContext} ctx
 * @param {{ threadId: string, body: string }} request
 */
async function performReply(ctx, { threadId, body }) {
  const thread = findThread(ctx.model, threadId);
  if (!thread.canReply) refuse('you cannot reply to this thread');
  const pending = ctx.model.pendingReview;
  const input = { pullRequestReviewThreadId: threadId, body, ...(pending ? { pullRequestReviewId: pending.id } : {}) };
  idIn(await ctx.write(MUTATIONS.reply, input, 'addPullRequestReviewThreadReply'), 'comment', 'addPullRequestReviewThreadReply');
}

/** @param {MutationContext} ctx @param {{ threadId: string, resolved: boolean }} request */
async function performSetResolved(ctx, { threadId, resolved }) {
  const thread = findThread(ctx.model, threadId);
  if (thread.isResolved === resolved) return;
  if (resolved ? !thread.canResolve : !thread.canUnresolve) refuse(`you cannot ${resolved ? 'resolve' : 'unresolve'} this thread`);
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  const payload = await ctx.write(resolved ? MUTATIONS.resolve : MUTATIONS.unresolve, { threadId }, field);
  const answered = payload.thread;
  if (!isObject(answered) || answered.isResolved !== resolved) {
    throw new GitHubResponseError(ENDPOINT, `${field} answered without the thread ${resolved ? 'resolved' : 'unresolved'}`);
  }
}

/** @param {MutationContext} ctx @param {{ commentId: string }} request */
async function performDeletePendingComment(ctx, { commentId }) {
  const comment = ctx.model.threads.flatMap((t) => t.comments).find((c) => c.id === commentId);
  if (!comment) throw new ReviewStoreError('stale', `comment ${commentId} is not in the loaded review; refresh and try again`);
  if (!comment.pending || !comment.mine) refuse('only your own pending comments can be deleted here');
  await ctx.write(MUTATIONS.deleteComment, { id: commentId }, 'deletePullRequestReviewComment');
}

/**
 * GitHub's rules, checked before sending so the reason is clear: approving or requesting
 * changes on one's own pull request is refused; requesting changes needs a summary; a
 * comment review needs a summary or a pending comment.
 * @param {MutationContext} ctx
 * @param {{ event: 'COMMENT'|'APPROVE'|'REQUEST_CHANGES', body: string }} request
 */
async function performSubmitReview(ctx, { event, body }) {
  const { pr, pendingReview } = ctx.model;
  const hasBody = body.trim() !== '';
  if (event !== 'COMMENT' && pr.viewerDidAuthor) {
    refuse(`you cannot ${event === 'APPROVE' ? 'approve' : 'request changes on'} your own pull request`);
  }
  if (event === 'REQUEST_CHANGES' && !hasBody) refuse('requesting changes needs a summary');
  if (event === 'COMMENT' && !hasBody && !(pendingReview && pendingReview.commentCount > 0)) {
    refuse('a comment review needs a summary or a pending comment');
  }
  const summary = hasBody ? { body } : {};
  if (pendingReview) {
    const payload = await ctx.write(MUTATIONS.submitReview, { pullRequestReviewId: pendingReview.id, event, ...summary }, 'submitPullRequestReview');
    idIn(payload, 'pullRequestReview', 'submitPullRequestReview');
    return;
  }
  // No pending review: create and submit in one call.
  const payload = await ctx.write(MUTATIONS.addReview,
    { pullRequestId: pr.id, commitOID: ctx.target.headOid, event, ...summary }, 'addPullRequestReview');
  idIn(payload, 'pullRequestReview', 'addPullRequestReview');
}

/** @param {MutationContext} ctx */
async function performDiscardPendingReview(ctx) {
  const pending = ctx.model.pendingReview;
  if (!pending) refuse('there is no pending review to discard');
  idIn(await ctx.write(MUTATIONS.deleteReview, { pullRequestReviewId: pending.id }, 'deletePullRequestReview'),
    'pullRequestReview', 'deletePullRequestReview');
}

/** @param {MutationContext} ctx @param {{ path: string, viewed: boolean }} request */
async function performSetViewed(ctx, { path, viewed }) {
  const now = ctx.model.viewed.get(path);
  if (viewed ? now === 'VIEWED' : now === 'UNVIEWED') return;
  const field = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  idIn(await ctx.write(viewed ? MUTATIONS.markViewed : MUTATIONS.unmarkViewed, { pullRequestId: ctx.model.pr.id, path }, field),
    'pullRequest', field);
}

/**
 * Checks a repository-relative path: non-empty, forward slashes, not absolute.
 * @param {unknown} path
 * @returns {string|null} The problem, or null.
 */
function pathProblem(path) {
  if (!isNonEmptyString(path)) return '`path` must be a non-empty string';
  if (path.startsWith('/') || path.includes('\\')) return '`path` must be repository-relative with forward slashes';
  return null;
}

/** @param {unknown} body @returns {string|null} */
const bodyProblem = (body) => (typeof body === 'string' && body.trim() !== '' ? null : '`body` must be non-empty text');

/**
 * @param {unknown} raw
 * @param {boolean} fileLevel
 * @returns {{ request: CommentRequest } | { problem: string }}
 */
function checkCommentRequest(raw, fileLevel) {
  if (!isObject(raw)) return { problem: 'expected an object' };
  const { path, body, mode, side, line, startLine } = raw;
  const problem = pathProblem(path) || bodyProblem(body)
    || (COMMENT_MODES.includes(/** @type {string} */ (mode)) ? null : `\`mode\` must be one of ${COMMENT_MODES.join(', ')}`);
  if (problem) return { problem };
  const common = { path: /** @type {string} */ (path), body: /** @type {string} */ (body),
    mode: /** @type {CommentRequest['mode']} */ (mode) };
  if (fileLevel) return { request: { ...common, fileLevel: true } };
  if (!SIDES.includes(/** @type {string} */ (side))) return { problem: '`side` must be LEFT or RIGHT' };
  if (!isLine(line)) return { problem: '`line` must be a 1-based line number' };
  if (startLine !== undefined && !(isLine(startLine) && /** @type {number} */ (startLine) <= /** @type {number} */ (line))) {
    return { problem: '`startLine` must be a 1-based line number no later than `line`' };
  }
  return { request: { ...common, fileLevel: false, side: /** @type {'LEFT'|'RIGHT'} */ (side), line: /** @type {number} */ (line),
    ...(startLine === undefined ? {} : { startLine: /** @type {number} */ (startLine) }) } };
}

/** @param {unknown} raw */
function checkReply(raw) {
  if (!isObject(raw)) return { problem: 'expected an object' };
  if (!isNonEmptyString(raw.threadId)) return { problem: '`threadId` must be a non-empty string' };
  const problem = bodyProblem(raw.body);
  return problem ? { problem } : { request: { threadId: raw.threadId, body: /** @type {string} */ (raw.body) } };
}

/** @param {unknown} raw */
function checkSetResolved(raw) {
  if (!isObject(raw)) return { problem: 'expected an object' };
  if (!isNonEmptyString(raw.threadId)) return { problem: '`threadId` must be a non-empty string' };
  if (typeof raw.resolved !== 'boolean') return { problem: '`resolved` must be a boolean' };
  return { request: { threadId: raw.threadId, resolved: raw.resolved } };
}

/** @param {unknown} raw */
function checkDeletePendingComment(raw) {
  if (!isObject(raw) || !isNonEmptyString(raw.commentId)) return { problem: '`commentId` must be a non-empty string' };
  return { request: { commentId: raw.commentId } };
}

/** @param {unknown} raw */
function checkSubmitReview(raw) {
  if (!isObject(raw)) return { problem: 'expected an object' };
  if (!REVIEW_EVENTS.includes(/** @type {string} */ (raw.event))) return { problem: `\`event\` must be one of ${REVIEW_EVENTS.join(', ')}` };
  if (raw.body !== undefined && typeof raw.body !== 'string') return { problem: '`body` must be text' };
  const event = /** @type {'COMMENT'|'APPROVE'|'REQUEST_CHANGES'} */ (raw.event);
  return { request: { event, body: raw.body === undefined ? '' : raw.body } };
}

/** @param {unknown} raw */
function checkSetViewed(raw) {
  if (!isObject(raw)) return { problem: 'expected an object' };
  const problem = pathProblem(raw.path);
  if (problem) return { problem };
  if (typeof raw.viewed !== 'boolean') return { problem: '`viewed` must be a boolean' };
  return { request: { path: /** @type {string} */ (raw.path), viewed: raw.viewed } };
}

/**
 * Creates the store. Call `sync()` whenever the analysis or its source may have changed;
 * the store reads `getTarget()` and `getAnalysisId()` then, and loads, reloads or drops.
 *
 * Ownership: the store owns its listeners, the running load's AbortController, the
 * running mutation's AbortController and the mutation queue; `dispose()` ends all four.
 * @param {StoreDeps} deps
 */
function createPullRequestReviewStore({ gh, getTarget, getAnalysisId, log: logLine = () => {}, budgets }) {
  let disposed = false;
  const log = (/** @type {string} */ m) => { if (!disposed) logLine(m); };
  /** @type {ReviewStoreState} */
  let state = Object.freeze({ kind: 'none' });
  /** @type {ReviewTarget|null} */
  let target = null;
  /** @type {number|null} */
  let analysisId = null;
  // The lane: at most one operation in flight. A load's `seq` is what lets it publish.
  /** @type {null | { kind: 'load', seq: number, controller: AbortController } | { kind: 'mutation', controller: AbortController }} */
  let busy = null;
  let loadSeq = 0;
  let loadWanted = false;
  /** @type {Array<{ key: string, perform: (ctx: MutationContext) => Promise<void>, resolve: (r: MutationResult) => void, reject: (e: unknown) => void }>} */
  const queue = [];
  /** @type {Set<(change: ReviewStoreChange) => void>} */
  const listeners = new Set();
  // Callers waiting for the load lane to go quiet (refresh(), a mutation's reload).
  /** @type {Array<() => void>} */
  let loadWaiters = [];

  /** @param {ReviewStoreState} next */
  function setState(next) {
    if (disposed) return;
    const before = reviewDataOf(state);
    state = Object.freeze(next);
    const after = reviewDataOf(state);
    const paths = before === after ? [] : before && after ? changedPaths(before, after) : null;
    for (const listener of [...listeners]) {
      try { listener({ paths }); } catch (e) { log(`review store: a listener failed: ${/** @type {Error} */ (e).message}`); }
    }
  }

  /** Shows `loading` for the current target, keeping what was shown; no event if already loading. */
  function markLoading() {
    if (!target || state.kind === 'loading') return;
    setState({ kind: 'loading', target, previous: reviewDataOf(state) });
  }

  /** Aborts the running load; its answer, if it still arrives, is discarded. */
  function cancelLoad() {
    if (busy && busy.kind === 'load') {
      busy.controller.abort();
      busy = null;
    }
  }

  function settleLoadWaiters() {
    if (!disposed && (loadWanted || (busy && busy.kind === 'load'))) return;
    const waiters = loadWaiters;
    loadWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** @returns {Promise<void>} Settles when no load is wanted or running. */
  function whenLoadsSettle() {
    /** @type {Promise<void>} */
    const settled = new Promise((resolve) => { loadWaiters.push(() => resolve()); });
    settleLoadWaiters();
    return settled;
  }

  /** Starts the next operation if the lane is free: a wanted load first, then a mutation. */
  function pump() {
    while (!disposed && !busy) {
      if (loadWanted && target) { startLoad(); break; }
      const job = queue.shift();
      if (!job) break;
      const refused = refusal(job);
      if (refused) { job.resolve(refused); continue; }
      // Owned: the job's caller holds the promise; runMutation sets `busy` before it awaits.
      runMutation(job).then(job.resolve, job.reject);
    }
    settleLoadWaiters();
  }

  /** Fails at once, unsent, every queued mutation requested for another target. */
  function refuseQueuedForOldTarget() {
    const key = keyOf(target);
    const stale = queue.filter((job) => job.key !== key);
    if (!stale.length) return;
    queue.splice(0, queue.length, ...queue.filter((job) => job.key === key));
    for (const job of stale) job.resolve(/** @type {MutationResult} */ (refusal(job)));
  }

  /**
   * Why a job cannot run now, or null when it can.
   * @param {typeof queue[number]} job
   * @returns {MutationResult|null}
   */
  function refusal(job) {
    if (job.key !== keyOf(target)) return failed(new ReviewStoreError('stale', 'the pull request under review changed before this could be sent'));
    if (!reviewDataOf(state)) return failed(new ReviewStoreError('not-ready', 'the review data is not loaded'));
    return null;
  }

  function startLoad() {
    assert.ok(target && !busy, 'a load starts only on a free lane with a target');
    loadWanted = false;
    const seq = ++loadSeq;
    const controller = new AbortController();
    const forAnalysis = analysisId;
    busy = { kind: 'load', seq, controller };
    // Owned: both outcomes are handled, and only the load still named by `seq` publishes.
    loadPullRequestReview(gh, target, { signal: controller.signal, budgets }).then(
      (model) => finishLoad(seq, forAnalysis, { model }),
      (error) => finishLoad(seq, forAnalysis, { error: error instanceof Error ? error : new Error(String(error)) }),
    ).catch((e) => log(`review store: publishing a load failed: ${e && e.message}`));
  }

  /**
   * @param {number} seq
   * @param {number|null} forAnalysis
   * @param {{ model: ReviewModel } | { error: Error }} outcome
   */
  function finishLoad(seq, forAnalysis, outcome) {
    if (disposed || !busy || busy.kind !== 'load' || busy.seq !== seq) return;   // superseded
    busy = null;
    // The analysis moved on without a sync() yet: publish nothing; the sync will reload.
    if (getAnalysisId() !== forAnalysis || !target) { pump(); return; }
    if ('error' in outcome) {
      log(`review store: loading PR #${target.number} failed: ${outcome.error.message}`);
      setState({ kind: 'failed', target, error: outcome.error, previous: reviewDataOf(state) });
    } else {
      setState({ kind: 'ready', target, model: outcome.model });
    }
    pump();
  }

  /**
   * Runs one queued mutation on the lane. Resolves once any reload it caused has
   * settled, so the caller then sees the new data. Rejects only for an internal invariant
   * failure, never for a GitHub failure.
   * @param {typeof queue[number]} job
   * @returns {Promise<MutationResult>}
   */
  async function runMutation(job) {
    const model = reviewDataOf(state);
    assert.ok(model && target && !busy, 'a mutation runs only on a free lane with loaded data (see refusal)');
    const controller = new AbortController();
    busy = { kind: 'mutation', controller };
    /** @type {MutationContext} */
    const ctx = {
      model, target, signal: controller.signal, applied: false, log,
      write: async (query, input, field) => {
        throwIfCancelled(controller.signal);
        const payload = payloadOf(await gh.graphql(query, { input }, { signal: controller.signal }), field);
        ctx.applied = true;
        return payload;
      },
    };
    /** @type {MutationResult} */
    let result;
    try {
      await job.perform(ctx);
      result = { ok: true };
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      const cause = error instanceof Error ? error : new Error(String(error));
      log(`review store: ${cause.message}`);
      result = failed(cause);
    } finally {
      busy = null;
    }
    // GitHub changed (or may have): reload before the next mutation runs on this data.
    const reload = ctx.applied && !disposed && job.key === keyOf(target);
    if (reload) { loadWanted = true; markLoading(); }
    const settled = reload ? whenLoadsSettle() : null;
    pump();
    if (settled) await settled;
    return result;
  }

  /**
   * Queues a mutation for the current target.
   * @param {(ctx: MutationContext) => Promise<void>} perform
   * @returns {Promise<MutationResult>}
   */
  function enqueue(perform) {
    if (disposed) return Promise.resolve(failed(new ReviewStoreError('disposed', 'the review store is closed')));
    const key = keyOf(target);
    if (!key) return Promise.resolve(failed(new ReviewStoreError('not-ready', 'no pull request is under review')));
    return new Promise((resolve, reject) => {
      queue.push({ key, perform, resolve, reject });
      pump();
    });
  }

  /**
   * Reads the current target and generation. A different target drops the shown data
   * and loads; the same target under a new analysis reloads, showing the old data
   * meanwhile; no target drops everything and does no I/O.
   * @returns {void}
   */
  function sync() {
    if (disposed) return;
    const nextAnalysis = getAnalysisId();
    /** @type {ReviewTarget|null} */
    let next;
    try {
      const raw = getTarget();
      next = raw === null ? null : validateTarget(raw);
    } catch (error) {
      // Our own wiring produced a malformed target: shown as a failure, never as "no threads".
      cancelLoad();
      loadWanted = false;
      target = null;
      analysisId = nextAnalysis;
      refuseQueuedForOldTarget();
      log(`review store: ${/** @type {Error} */ (error).message}`);
      setState({ kind: 'failed', target: null, error: /** @type {Error} */ (error), previous: null });
      pump();
      return;
    }
    const sameTarget = keyOf(next) === keyOf(target);
    // Nothing to do unless the target or generation moved (or a bad target was replaced).
    if (sameTarget && nextAnalysis === analysisId && (next !== null || state.kind === 'none')) return;
    analysisId = nextAnalysis;
    target = next;
    cancelLoad();
    loadWanted = next !== null;
    if (!sameTarget) refuseQueuedForOldTarget();
    if (!next) { if (state.kind !== 'none') setState({ kind: 'none' }); }
    else if (sameTarget) markLoading();
    else setState({ kind: 'loading', target: next, previous: null });
    pump();
  }

  /**
   * Reloads the current target, aborting a load in flight; a load wanted while a
   * mutation runs starts when it ends. Does nothing without a target.
   * @returns {Promise<void>} Settles when no load is wanted or running any more.
   */
  function refresh() {
    if (disposed || !target) return Promise.resolve();
    cancelLoad();
    loadWanted = true;
    markLoading();
    const settled = whenLoadsSettle();
    pump();
    return settled;
  }

  /**
   * Aborts the load and the mutation in flight, fails the queued mutations with
   * `disposed`, and removes every listener. Nothing fires afterwards.
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (busy) busy.controller.abort();
    busy = null;
    loadWanted = false;
    for (const job of queue.splice(0)) job.resolve(failed(new ReviewStoreError('disposed', 'the review store is closed')));
    listeners.clear();
    settleLoadWaiters();
    state = Object.freeze({ kind: 'none' });
    target = null;
  }

  /**
   * @param {(change: ReviewStoreChange) => void} listener
   * @returns {{ dispose: () => void }}
   */
  function onDidChange(listener) {
    if (disposed) return { dispose: () => {} };
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  }

  /**
   * A public mutation: validates the argument at once, then queues the work.
   * @template T
   * @param {(raw: unknown) => { request: T } | { problem: string }} check
   * @param {(ctx: MutationContext, request: T) => Promise<void>} perform
   * @returns {(raw: unknown) => Promise<MutationResult>}
   */
  const mutation = (check, perform) => (raw) => {
    const checked = check(raw);
    if ('problem' in checked) return Promise.resolve(invalid(checked.problem));
    return enqueue((ctx) => perform(ctx, checked.request));
  };

  return {
    /** @returns {ReviewStoreState} */
    getState: () => state,
    onDidChange, sync, refresh, dispose,
    /** Line comment: `{ path, side, line, startLine?, body, mode }`. */
    addComment: mutation((raw) => checkCommentRequest(raw, false), performAddComment),
    /** File-level comment: `{ path, body, mode }`. */
    addFileComment: mutation((raw) => checkCommentRequest(raw, true), performAddComment),
    /** `{ threadId, body }`. */
    reply: mutation(checkReply, performReply),
    /** `{ threadId, resolved }`. */
    setResolved: mutation(checkSetResolved, performSetResolved),
    /** `{ commentId }`. */
    deletePendingComment: mutation(checkDeletePendingComment, performDeletePendingComment),
    /** `{ event, body? }`. */
    submitReview: mutation(checkSubmitReview, performSubmitReview),
    /** @returns {Promise<MutationResult>} */
    discardPendingReview: () => enqueue(performDiscardPendingReview),
    /** `{ path, viewed }`. */
    setViewed: mutation(checkSetViewed, performSetViewed),
  };
}

/** @typedef {ReturnType<typeof createPullRequestReviewStore>} PullRequestReviewStore */

module.exports = {
  MUTATIONS, ReviewStoreError, createPullRequestReviewStore, reviewDataOf, reviewTargetOf, validateTarget, changedPaths,
};
