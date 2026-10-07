// @ts-check
'use strict';
// The pull request's review threads in the review diff, and starting, replying to,
// resolving and deleting them there, through VS Code's comments API. What is drawn and
// where commenting is offered is decided in `review-comments-model.js`; this adapter owns
// the comment controller, the threads it draws, and the commands its menus run.
//
// Only a review of a GitHub pull request shows any of it: a preview's `impacttree-pr:`
// documents, or a checkout's files on disk and their `impacttree-base:` base side while
// the worktree's HEAD is the pull request's head. Local and agent reviews get no
// commenting ranges (the provider is not even set) and no threads.
//
// Drawing follows the review store. A change event names the files whose threads changed,
// and only the open documents of those files are redrawn; a thread that is still there
// keeps its VS Code object (and with it an open reply box), and is only updated when what
// it shows changed. A new context (another pull request, a new result, a checkout moving)
// redraws every open document.

const { reviewDataOf } = require('./pr-review-store');
const { commentingContextOf, documentSide, commentableLines, acceptsComment, threadSpecsFor } = require('./review-comments-model');

const CONTROLLER_ID = 'impactTree.review';
/** Set while the viewer has a pending review, so a new comment offers "Add review comment". */
const PENDING_CONTEXT_KEY = 'impactTree.reviewPending';
const COMMANDS = Object.freeze({
  startReview: 'impactTree.review.startReview',
  commentNow: 'impactTree.review.commentNow',
  addToReview: 'impactTree.review.addReviewComment',
  reply: 'impactTree.review.reply',
  replyToReview: 'impactTree.review.replyToReview',
  resolve: 'impactTree.review.resolve',
  unresolve: 'impactTree.review.unresolve',
  deletePending: 'impactTree.review.deletePendingComment',
});

/**
 * A comment or reply that was not sent. The command rejects with it after the reason has
 * been shown: VS Code clears a comment box only once its command has completed, so the
 * rejection is what keeps the reviewer's text in the box (Q9).
 */
class CommentNotSentError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CommentNotSentError';
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null;

/**
 * @typedef {import('./review-comments-model').CommentingContext} CommentingContext
 * @typedef {import('./review-comments-model').ThreadSpec} ThreadSpec
 * @typedef {import('./review-comments-model').CommentSpec} CommentSpec
 * @typedef {Pick<import('./pr-review-store').PullRequestReviewStore,
 *   'getState'|'onDidChange'|'addComment'|'reply'|'setResolved'|'deletePendingComment'>} ReviewStore
 * @typedef {{ dispose(): any }} Disposable
 *
 * @typedef {object} ReviewCommentsDeps
 * @property {ReviewStore} store
 * @property {() => { source: unknown, result: Record<string, any>|null }} getSession The
 *   session's current source and shown result (null while a run is under way).
 * @property {() => string} repoRoot Absolute path of the repository; may throw without one.
 * @property {() => Promise<string|null>} readHead The worktree's HEAD commit, or null when
 *   it cannot be read. Never rejects. Read only for a checkout.
 * @property {Array<(listener: () => void) => Disposable>} contextEvents Fired when the
 *   session's analysis, source or shown result may have changed.
 * @property {(message: string) => void} [log]
 */

/**
 * Creates the comment controller and registers its commands.
 *
 * Ownership: the returned object owns the controller, every thread it drew, its
 * subscriptions and commands; `dispose()` ends them all, and a draw still waiting on the
 * HEAD read publishes nothing afterwards.
 * @param {any} vscode
 * @param {ReviewCommentsDeps} deps
 * @returns {{ dispose(): void, whenIdle(): Promise<void> }} `whenIdle` settles once no
 *   draw is pending.
 */
function createReviewComments(vscode, { store, getSession, repoRoot, readHead, contextEvents, log = () => {} }) {
  let disposed = false;
  const controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Impact Tree review');
  controller.options = { placeHolder: 'Leave a comment (Markdown)', prompt: 'Reply' };

  // Drawn threads by document (its URI string), then by thread id. `resolved` is what the
  // thread was last drawn as, so only a change of it collapses or expands the thread.
  /** @type {Map<string, Map<string, { thread: any, signature: string, resolved: boolean }>>} */
  const drawn = new Map();
  // The review thread a drawn VS Code thread shows, and the comment a drawn comment is.
  /** @type {WeakMap<object, string>} */
  const threadIds = new WeakMap();
  /** @type {WeakMap<object, string>} */
  const commentIds = new WeakMap();

  // What an earlier result of a checkout said about its base side, for the re-analysis.
  /** @type {{ headOid: string, baseSha: string, headPathOf: Record<string, string> }|null} */
  let retainedBase = null;

  /** @param {Promise<unknown>|unknown} shown @param {string} what */
  const own = (shown, what) => {
    Promise.resolve(shown).then(undefined, (e) => log(`review comments: ${what} failed: ${e && e.message}`));
  };
  /** @param {string} message */
  const showError = (message) => own(vscode.window.showErrorMessage(message), 'showing an error');

  // ---- context --------------------------------------------------------------------------

  /** @param {string|null} head @returns {CommentingContext|null} */
  function contextWith(head) {
    const state = store.getState();
    const target = state.kind === 'none' ? null : state.target;
    if (!target) return null;
    const { source, result } = getSession();
    let root = '';
    if (isObject(source) && source.kind === 'checkout') {
      try { root = repoRoot(); } catch { return null; }
    }
    const ctx = commentingContextOf({ target, source, result, head, repoRoot: root, retainedBase });
    if (ctx && ctx.kind === 'checkout' && ctx.baseSha) retainedBase = { headOid: ctx.headOid, baseSha: ctx.baseSha, headPathOf: ctx.headPathOf };
    return ctx;
  }

  /**
   * The context now. The HEAD read is the only wait; everything else is read after it, so
   * the answer is never older than the read.
   * @returns {Promise<CommentingContext|null>}
   */
  async function contextNow() {
    const { source } = getSession();
    const head = isObject(source) && source.kind === 'checkout' ? await readHead() : null;
    return disposed ? null : contextWith(head);
  }

  const rangeProvider = {
    /**
     * @param {{ uri: any, lineCount: number, isDirty?: boolean }} document
     * @param {{ isCancellationRequested?: boolean }} [token]
     */
    async provideCommentingRanges(document, token) {
      const ctx = await contextNow();
      if (!ctx || disposed || (token && token.isCancellationRequested)) return [];
      // Without loaded data it is unknown whether a review is pending, so which button a
      // new comment needs: wait for it.
      if (!reviewDataOf(store.getState())) return [];
      const at = documentSide(document.uri, ctx);
      // Unsaved edits move the lines away from the commit GitHub has.
      if (!at || (document.uri.scheme === 'file' && document.isDirty)) return [];
      return commentableLines(ctx, at, document.lineCount).map(([lo, hi]) => new vscode.Range(lo - 1, 0, hi - 1, 0));
    },
  };

  // ---- drawing ----------------------------------------------------------------------------

  /** @param {CommentSpec} c */
  function toComment(c) {
    const body = new vscode.MarkdownString(c.body);
    // Text from GitHub: no command links, no HTML, no icons.
    body.isTrusted = false;
    body.supportHtml = false;
    body.supportThemeIcons = false;
    const when = new Date(c.createdAt);
    const comment = {
      body, mode: vscode.CommentMode.Preview, contextValue: c.contextValue,
      author: { name: c.author, ...(c.avatarUrl ? { iconPath: vscode.Uri.parse(c.avatarUrl) } : {}) },
      ...(c.pending ? { label: 'Pending' } : {}),
      ...(Number.isNaN(when.getTime()) ? {} : { timestamp: when }),
    };
    commentIds.set(comment, c.id);
    return comment;
  }

  /** @param {any} thread @param {ThreadSpec} spec */
  function describe(thread, spec) {
    thread.comments = spec.comments.map(toComment);
    thread.label = spec.label;
    thread.contextValue = spec.contextValue;
    thread.canReply = spec.canReply;
    if (vscode.CommentThreadState) thread.state = spec.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
  }

  /** @param {string} key */
  function disposeDocument(key) {
    const threads = drawn.get(key);
    if (!threads) return;
    for (const { thread } of threads.values()) thread.dispose();
    drawn.delete(key);
  }

  /**
   * Makes a document's threads those of `specs`: removes the rest, creates the new ones,
   * and updates in place the ones whose id persists and whose content changed.
   * @param {any} uri
   * @param {ThreadSpec[]} specs
   */
  function reconcile(uri, specs) {
    const key = uri.toString();
    const threads = drawn.get(key) || new Map();
    const wanted = new Set(specs.map((s) => s.id));
    for (const [id, d] of threads) {
      if (!wanted.has(id)) { d.thread.dispose(); threads.delete(id); }
    }
    for (const spec of specs) {
      const signature = JSON.stringify(spec);
      const existing = threads.get(spec.id);
      if (existing && existing.signature === signature) continue;
      const range = new vscode.Range(spec.startLine - 1, 0, spec.line - 1, 0);
      const collapsed = spec.resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
      if (!existing) {
        const thread = controller.createCommentThread(uri, range, []);
        threadIds.set(thread, spec.id);
        describe(thread, spec);
        thread.collapsibleState = collapsed;
        threads.set(spec.id, { thread, signature, resolved: spec.resolved });
        continue;
      }
      const { thread } = existing;
      if (thread.range.start.line !== spec.startLine - 1 || thread.range.end.line !== spec.line - 1) thread.range = range;
      describe(thread, spec);
      // Collapse a thread when it becomes resolved, expand it when it is reopened; leave
      // it as the reviewer set it otherwise.
      if (existing.resolved !== spec.resolved) thread.collapsibleState = collapsed;
      existing.signature = signature;
      existing.resolved = spec.resolved;
    }
    if (threads.size) drawn.set(key, threads); else drawn.delete(key);
  }

  // What the last draw was made for: the context's identity, whether data was loaded, and
  // the result whose lines the ranges came from.
  /** @type {string|null} */
  let shownKey = null;
  /** @type {unknown} */
  let shownResult = null;

  /**
   * @param {{ all: boolean, paths: Set<string>, uris: Set<string> }} work
   * @param {CommentingContext|null} ctx
   */
  function draw(work, ctx) {
    const data = ctx ? reviewDataOf(store.getState()) : null;
    const key = ctx === null ? 'none'
      : JSON.stringify([ctx.kind, ctx.number, ctx.headOid, ctx.kind === 'pr' ? ctx.revision : ctx.baseSha, data !== null]);
    const result = ctx ? getSession().result : null;
    const changed = key !== shownKey || result !== shownResult;
    if (changed) {
      shownKey = key;
      shownResult = result;
      // Setting the provider again is what makes VS Code ask for the ranges again.
      controller.commentingRangeProvider = ctx ? rangeProvider : undefined;
    }
    const all = work.all || changed;
    /** @type {any[]} */
    const open = vscode.workspace.textDocuments || [];
    const openKeys = new Set(open.map((d) => d.uri.toString()));
    for (const document of open) {
      const at = ctx ? documentSide(document.uri, ctx) : null;
      if (!all && !work.uris.has(document.uri.toString()) && !(at && work.paths.has(at.path))) continue;
      reconcile(document.uri, at && data ? threadSpecsFor(data, at.path, at.side) : []);
    }
    for (const key2 of [...drawn.keys()]) if (!openKeys.has(key2)) disposeDocument(key2);
  }

  // Draw requests accumulate here while a draw waits for the HEAD read; one loop at a time
  // takes them, so a later request is never overtaken by an earlier one.
  let wanted = { all: false, paths: new Set(), uris: new Set() };
  let wantedAny = false;
  /** @type {Promise<void>|null} */
  let drawing = null;

  /** @param {{ all?: boolean, paths?: string[], uris?: string[] }} request */
  function want({ all = false, paths = [], uris = [] }) {
    if (disposed) return;
    wanted.all = wanted.all || all;
    for (const p of paths) wanted.paths.add(p);
    for (const u of uris) wanted.uris.add(u);
    wantedAny = true;
    kick();
  }

  function kick() {
    if (drawing || disposed || !wantedAny) return;
    // Owned: failures are logged, and the loop ends on dispose before drawing anything.
    drawing = drawLoop()
      .catch((e) => log(`review comments: drawing threads failed: ${e && e.message}`))
      .finally(() => { drawing = null; kick(); });
  }

  async function drawLoop() {
    while (wantedAny && !disposed) {
      const work = wanted;
      wanted = { all: false, paths: new Set(), uris: new Set() };
      wantedAny = false;
      const ctx = await contextNow();
      if (disposed) return;
      draw(work, ctx);
    }
  }

  // ---- store state ------------------------------------------------------------------------

  /** @type {boolean|null} */
  let pendingShown = null;
  function showPendingKey() {
    const data = reviewDataOf(store.getState());
    const pending = !!(data && data.pendingReview);
    if (pending === pendingShown) return;
    pendingShown = pending;
    own(vscode.commands.executeCommand('setContext', PENDING_CONTEXT_KEY, pending), 'setting the pending-review context');
  }

  // One warning per failed load, not per document. A failed load is never shown as "no
  // threads": the threads of the last load stay drawn, and the warning says which.
  /** @type {Error|null} */
  let warnedFor = null;
  function warnOnFailure() {
    const state = store.getState();
    if (state.kind !== 'failed') return;
    if (warnedFor === state.error) return;
    warnedFor = state.error;
    const which = state.target ? `pull request #${state.target.number}` : 'the pull request';
    const shown = state.previous ? 'The threads shown are from the last load.' : 'No threads are shown, which does not mean there are none.';
    own(vscode.window.showWarningMessage(`Impact Tree: the review threads of ${which} could not be loaded — ${state.error.message}. ${shown} Refresh to try again.`),
      'showing a warning');
  }

  // ---- commands ---------------------------------------------------------------------------

  /** @param {unknown} arg @returns {{ thread: any, text: string }|null} A comment box's thread and text. */
  const replyOf = (arg) => (isObject(arg) && isObject(arg.thread) && typeof arg.text === 'string' ? { thread: arg.thread, text: arg.text } : null);
  /** @param {unknown} arg @returns {any} The thread a title action or a comment box belongs to. */
  const threadOf = (arg) => (isObject(arg) && isObject(arg.thread) ? arg.thread : arg);

  /**
   * Shows why a comment was not sent and rejects, which keeps its text in the box.
   * @param {string} what What failed, as "could not <what>".
   * @param {string} why
   * @returns {never}
   */
  function notSent(what, why) {
    const message = `Impact Tree: could not ${what} — ${why}. Your text is still in the comment box.`;
    showError(message);
    throw new CommentNotSentError(message);
  }

  /** @param {string} text */
  const isBlank = (text) => {
    if (text.trim() !== '') return false;
    own(vscode.window.showWarningMessage('Impact Tree: write the comment first.'), 'showing a warning');
    return true;
  };

  /**
   * A new thread from the comment box of a range the reviewer picked.
   * @param {'startReview'|'commentNow'|'addToReview'} mode
   * @param {unknown} arg VS Code's `CommentReply`: the new (empty) thread and the text.
   */
  async function addComment(mode, arg) {
    const reply = replyOf(arg);
    if (!reply || isBlank(reply.text)) return;
    const { thread, text } = reply;
    const what = { startReview: 'start a review with this comment', commentNow: 'post this comment', addToReview: 'add this comment to your review' }[mode];
    if (!thread.range) notSent(what, 'it is not on a line');
    const startLine = thread.range.start.line + 1, line = thread.range.end.line + 1;
    const where = startLine === line ? `line ${line}` : `lines ${startLine}–${line}`;
    const ctx = await contextNow();
    const at = ctx && documentSide(thread.uri, ctx);
    if (!ctx || !at) notSent(what, 'this document is not a side of the pull request under review');
    if (!acceptsComment(ctx, at, startLine, line)) {
      notSent(what, `${where} of ${at.path}${at.side === 'LEFT' ? ' (base)' : ''} are not all in one hunk of the pull request's diff, where GitHub takes comments`);
    }
    const result = await store.addComment({ path: at.path, side: at.side, line, ...(startLine < line ? { startLine } : {}), body: text, mode });
    if (!result.ok) notSent(`${what} on ${at.path} ${where}`, result.error.message);
    // The store has reloaded, so the thread is drawn from GitHub's data; the draft goes.
    thread.dispose();
  }

  /** @param {unknown} arg VS Code's `CommentReply` for a drawn thread. */
  async function reply(arg) {
    const r = replyOf(arg);
    if (!r || isBlank(r.text)) return;
    const data = reviewDataOf(store.getState());
    const what = data && data.pendingReview ? 'add this reply to your review' : 'post this reply';
    const threadId = threadIds.get(r.thread);
    if (!threadId) notSent(what, 'the thread is no longer shown; refresh and try again');
    const result = await store.reply({ threadId, body: r.text });
    if (!result.ok) notSent(what, result.error.message);
  }

  /** @param {boolean} resolved @param {unknown} arg */
  async function setResolved(resolved, arg) {
    const thread = threadOf(arg);
    const threadId = isObject(thread) ? threadIds.get(thread) : undefined;
    if (!threadId) return;
    const result = await store.setResolved({ threadId, resolved });
    if (!result.ok) showError(`Impact Tree: could not ${resolved ? 'resolve' : 'unresolve'} the thread — ${result.error.message}`);
  }

  /** @param {unknown} arg The comment, from its title action. */
  async function deletePending(arg) {
    const commentId = isObject(arg) ? commentIds.get(arg) : undefined;
    if (!commentId) return;
    const result = await store.deletePendingComment({ commentId });
    if (!result.ok) showError(`Impact Tree: could not delete the pending comment — ${result.error.message}`);
  }

  /** @type {Disposable[]} */
  const subscriptions = [
    store.onDidChange(({ paths }) => {
      showPendingKey();
      warnOnFailure();
      want(paths === null ? { all: true } : { paths });
    }),
    ...contextEvents.map((event) => event(() => want({}))),
    vscode.workspace.onDidOpenTextDocument((/** @type {any} */ document) => want({ uris: [document.uri.toString()] })),
    vscode.workspace.onDidCloseTextDocument((/** @type {any} */ document) => disposeDocument(document.uri.toString())),
    vscode.commands.registerCommand(COMMANDS.startReview, (/** @type {unknown} */ arg) => addComment('startReview', arg)),
    vscode.commands.registerCommand(COMMANDS.commentNow, (/** @type {unknown} */ arg) => addComment('commentNow', arg)),
    vscode.commands.registerCommand(COMMANDS.addToReview, (/** @type {unknown} */ arg) => addComment('addToReview', arg)),
    vscode.commands.registerCommand(COMMANDS.reply, reply),
    vscode.commands.registerCommand(COMMANDS.replyToReview, reply),
    vscode.commands.registerCommand(COMMANDS.resolve, (/** @type {unknown} */ arg) => setResolved(true, arg)),
    vscode.commands.registerCommand(COMMANDS.unresolve, (/** @type {unknown} */ arg) => setResolved(false, arg)),
    vscode.commands.registerCommand(COMMANDS.deletePending, deletePending),
  ];

  showPendingKey();
  want({ all: true });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of subscriptions) s.dispose();
      for (const key of [...drawn.keys()]) disposeDocument(key);
      controller.dispose();
    },
    async whenIdle() {
      while (drawing) await drawing;
    },
  };
}

module.exports = { createReviewComments, CommentNotSentError, CONTROLLER_ID, PENDING_CONTEXT_KEY, COMMANDS };
