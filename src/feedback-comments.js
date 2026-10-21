// @ts-check
'use strict';
// Feedback drafts in the editor (docs/UX_PLAN.md F1): a second comment controller,
// `impactTree.feedback`, next to the pull request one (`review-comments.js`), which it
// does not touch. Where feedback is offered and how drafts are drawn is decided in
// `feedback-comments-model.js`; the drafts themselves are kept by `feedback-drafts.js`.
// Nothing here sends anything anywhere.
//
// Commenting ranges: the whole document, for a document on disk that is one of the files
// of the result shown (a local review or a checked-out pull request; bounded by that
// result's file list) and has no unsaved edits. Base sides, previewed pull request
// documents and files outside the result get none. In a checked-out pull request the
// review controller offers the same lines for GitHub comments; VS Code then asks which
// one a new comment is for, by the controllers' labels. The provider
// is set again whenever the result changes, which makes VS Code ask again.
//
// Drawing: every draft is a thread on its line of its file, in each open document on disk,
// labelled "Feedback · draft", with Edit and Delete. Drafts are drawn while the files on
// disk are reviewed (or nothing has been reviewed yet); a previewed pull request's
// documents show only its own threads. A change of the drafts or of the result redraws the open documents; a thread
// whose draft did not change keeps its VS Code object.
//
// Starting from the tree or Details: VS Code's API cannot fill a comment box, so these open
// the file's review diff and add an empty box on the line, as `review-comments.js` does. A
// box remembers what it is for (a whole file, or a caller) until it is submitted. Opening
// the diff is the only wait; a box is added only if the same analysis and result are still
// shown afterwards, so a click on an old result adds nothing.
//
// Edit: the drawn comment is put in VS Code's edit mode (Save / Cancel under it). From the
// tree, the draft's line is opened first; if its thread is not drawn there (another kind of
// review is shown, or the file could not be opened), an input box holding the text is used
// instead.

const path = require('path');
const {
  feedbackContextOf, drawsDrafts, relPathOf, symbolAt, draftThreadSpecs, draftLabel,
} = require('./feedback-comments-model');
const { rowCommentPlace } = require('./review-comments-model');
const { MAX_QUOTE_LINES } = require('./feedback-drafts');

const CONTROLLER_ID = 'impactTree.feedback';
const CONTROLLER_LABEL = 'Impact Tree: feedback for your agent';
const COMMANDS = Object.freeze({
  add: 'impactTree.feedback.add',
  cancel: 'impactTree.feedback.cancel',
  edit: 'impactTree.feedback.edit',
  saveEdit: 'impactTree.feedback.saveEdit',
  cancelEdit: 'impactTree.feedback.cancelEdit',
  remove: 'impactTree.feedback.delete',
  open: 'impactTree.feedback.open',
});

/**
 * Feedback that was not kept. The command rejects with it after the reason has been
 * shown: VS Code clears a comment box only once its command has completed, so the
 * rejection keeps the reviewer's text in the box (as `CommentNotSentError` does).
 */
class FeedbackNotAddedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FeedbackNotAddedError';
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null;

/**
 * @typedef {import('./feedback-comments-model').FeedbackContext} FeedbackContext
 * @typedef {import('./feedback-drafts').FeedbackItem} FeedbackItem
 * @typedef {{ dispose(): any }} Disposable
 * @typedef {Pick<ReturnType<typeof import('./feedback-drafts').createFeedbackDrafts>,
 *   'list'|'get'|'add'|'update'|'remove'|'onDidChange'>} DraftStore
 * @typedef {import('./review-comments-model').CallerContext} CallerContext
 *
 * @typedef {object} BoxPurpose What a box started from the tree or Details is for.
 * @property {string} relPath The file it is on.
 * @property {boolean} fileLevel The draft is about the whole file: its line is null.
 * @property {{ label: string, file: string, line: number }|null} caller The caller it is about.
 *
 * @typedef {object} FeedbackCommentsDeps
 * @property {DraftStore} drafts
 * @property {() => { source: unknown, result: unknown }} getSession The session's source
 *   and shown result (null while a run is under way).
 * @property {() => number} getAnalysisId
 * @property {(id: number) => boolean} isCurrentAnalysis
 * @property {() => string} repoRoot Absolute path of the repository; may throw without one.
 * @property {Array<(listener: () => void) => Disposable>} contextEvents Fired when the
 *   session's analysis, source or shown result may have changed.
 * @property {(relPath: string, line: number|null) => Promise<void>} openDiff Opens a changed
 *   file's review diff at a 1-based head line, or at its start for null.
 * @property {(message: string) => void} [log]
 */

/**
 * Creates the feedback comment controller and registers its commands.
 *
 * Ownership: the returned object owns the controller, every thread it drew or added, its
 * subscriptions and commands; `dispose()` ends them all, and a box still waiting for its
 * diff to open is not added afterwards.
 * @param {any} vscode
 * @param {FeedbackCommentsDeps} deps
 */
function createFeedbackComments(vscode, { drafts, getSession, getAnalysisId, isCurrentAnalysis, repoRoot, contextEvents, openDiff, log = () => {} }) {
  let disposed = false;
  const controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
  controller.options = { placeHolder: 'Feedback for the agent (Markdown)', prompt: 'Add feedback' };

  /** @param {Promise<unknown>|unknown} shown @param {string} what */
  const own = (shown, what) => {
    Promise.resolve(shown).then(undefined, (e) => log(`feedback: ${what} failed: ${e && e.message}`));
  };
  /** @param {string} message */
  const tell = (message) => own(vscode.window.showWarningMessage(`Impact Tree: ${message}`), 'showing a warning');

  const rootOrNull = () => { try { return repoRoot(); } catch { return null; } };
  /** @returns {FeedbackContext|null} */
  const contextNow = () => {
    const { source, result } = getSession();
    return feedbackContextOf({ source, result, repoRoot: rootOrNull(), analysisId: getAnalysisId() });
  };
  /** @param {FeedbackContext} ctx */
  const stillShown = (ctx) => !disposed && isCurrentAnalysis(ctx.analysisId) && getSession().result === ctx.result;

  const rangeProvider = {
    /** @param {{ uri: any, lineCount: number, isDirty?: boolean }} document */
    provideCommentingRanges(document) {
      const ctx = disposed ? null : contextNow();
      if (!ctx) return [];
      const rel = relPathOf(document.uri, ctx.repoRoot);
      // Unsaved edits move lines away from the file the agent will read.
      if (!rel || !ctx.files.has(rel) || document.isDirty) return [];
      return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    },
  };

  // ---- drawing ------------------------------------------------------------------------------

  /**
   * Drawn drafts by document (URI string), then by draft id. `signature` is what the thread
   * was drawn from, so an unchanged draft is not touched (an open edit stays open).
   * @type {Map<string, Map<string, { thread: any, comment: any, signature: string }>>}
   */
  const drawn = new Map();
  /** The draft a drawn thread or comment shows. @type {WeakMap<object, string>} */
  const draftIds = new WeakMap();
  /** Boxes started from the tree or Details. @type {WeakMap<object, BoxPurpose>} */
  const purposes = new WeakMap();

  /** @param {string} body */
  function markdown(body) {
    const md = new vscode.MarkdownString(body);
    // The reviewer's own text, shown, never run: no command links, HTML or icons.
    md.isTrusted = false;
    md.supportHtml = false;
    md.supportThemeIcons = false;
    return md;
  }

  /** @param {import('./feedback-comments-model').DraftThreadSpec} spec */
  function makeComment(spec) {
    const comment = { body: markdown(spec.body), mode: vscode.CommentMode.Preview, author: { name: 'Feedback draft' },
      contextValue: 'feedbackDraft', label: 'not sent' };
    draftIds.set(comment, spec.id);
    return comment;
  }

  /** @param {string} key */
  function disposeDocument(key) {
    const threads = drawn.get(key);
    if (!threads) return;
    for (const { thread } of threads.values()) thread.dispose();
    drawn.delete(key);
  }

  /**
   * Makes a document's drawn drafts those of `specs`.
   * @param {any} uri
   * @param {import('./feedback-comments-model').DraftThreadSpec[]} specs
   */
  function reconcile(uri, specs) {
    const key = uri.toString();
    const threads = drawn.get(key) || new Map();
    const wanted = new Set(specs.map((s) => s.id));
    for (const [id, d] of threads) if (!wanted.has(id)) { d.thread.dispose(); threads.delete(id); }
    for (const spec of specs) {
      const signature = JSON.stringify(spec);
      const existing = threads.get(spec.id);
      if (existing && existing.signature === signature) continue;
      const range = new vscode.Range(spec.line - 1, 0, spec.line - 1, 0);
      const comment = makeComment(spec);
      if (existing) {
        existing.thread.range = range;
        existing.thread.label = spec.label;
        existing.thread.comments = [comment];
        existing.comment = comment;
        existing.signature = signature;
        continue;
      }
      const thread = controller.createCommentThread(uri, range, [comment]);
      draftIds.set(thread, spec.id);
      thread.label = spec.label;
      thread.contextValue = 'feedbackDraft';
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      threads.set(spec.id, { thread, comment, signature });
    }
    if (threads.size) drawn.set(key, threads); else drawn.delete(key);
  }

  // What the ranges were last offered for: the analysis and its result.
  /** @type {{ analysisId: number, result: unknown }|null} */
  let offeredFor = null;

  /**
   * Draws the drafts on the open documents (`only`: just that one), and offers ranges for
   * the result shown. Synchronous: it reads the state once, so nothing older is drawn.
   * @param {string} [only] A document's URI string.
   */
  function draw(only) {
    if (disposed) return;
    const ctx = contextNow();
    const offer = ctx ? { analysisId: ctx.analysisId, result: ctx.result } : null;
    const sameOffer = offer === null ? offeredFor === null
      : offeredFor !== null && offer.analysisId === offeredFor.analysisId && offer.result === offeredFor.result;
    if (!sameOffer) {
      offeredFor = offer;
      // Setting the provider again is what makes VS Code ask for the ranges again.
      controller.commentingRangeProvider = offer ? rangeProvider : undefined;
    }
    const root = rootOrNull();
    const shows = root !== null && drawsDrafts(getSession().source);
    /** @type {Map<string, FeedbackItem[]>} */
    const byFile = new Map();
    if (shows) for (const item of drafts.list()) byFile.set(item.file, [...(byFile.get(item.file) || []), item]);
    /** @type {any[]} */
    const open = vscode.workspace.textDocuments || [];
    const openKeys = new Set(open.map((d) => d.uri.toString()));
    for (const document of open) {
      const key = document.uri.toString();
      if (only && key !== only) continue;
      const rel = shows ? relPathOf(document.uri, /** @type {string} */ (root)) : null;
      const items = rel ? byFile.get(rel) : undefined;
      reconcile(document.uri, items && rel ? draftThreadSpecs(items, rel, document.lineCount) : []);
    }
    if (!only) for (const key of [...drawn.keys()]) if (!openKeys.has(key)) disposeDocument(key);
  }

  // ---- adding feedback from a box -----------------------------------------------------------

  /**
   * Shows why the feedback was not kept and rejects, which keeps the text in the box.
   * @param {string} why
   * @returns {never}
   */
  function notAdded(why) {
    const message = `Impact Tree: could not add this feedback — ${why}. Your text is still in the box.`;
    own(vscode.window.showErrorMessage(message), 'showing an error');
    throw new FeedbackNotAddedError(message);
  }

  /**
   * The code a box's lines hold, at most MAX_QUOTE_LINES lines read.
   * @param {any} document
   * @param {number} first 0-based.
   * @param {number} last 0-based, inclusive.
   */
  function quoteOf(document, first, last) {
    const end = Math.min(last, first + MAX_QUOTE_LINES - 1, document.lineCount - 1);
    const lines = [];
    for (let i = first; i <= end; i++) lines.push(document.lineAt(i).text);
    // One more line than kept tells the store to mark the quote as cut.
    if (last > end && end === first + MAX_QUOTE_LINES - 1) lines.push('…');
    return lines.join('\n');
  }

  /** @param {unknown} arg VS Code's `CommentReply`: the box's thread and its text. */
  async function add(arg) {
    if (!isObject(arg) || !isObject(arg.thread) || typeof arg.text !== 'string') return;
    const { thread, text } = arg;
    if (text.trim() === '') { tell('write the feedback first.'); return; }
    const ctx = contextNow();
    if (!ctx) notAdded('feedback can be added only while a local review or a checked-out pull request is shown, not while analysing');
    const rel = relPathOf(thread.uri, ctx.repoRoot);
    const purpose = purposes.get(thread);
    if (!rel || !ctx.files.has(rel)) notAdded('this document is not a file on disk of the review shown');
    const document = (vscode.workspace.textDocuments || []).find((/** @type {any} */ d) => d.uri.toString() === thread.uri.toString());
    if (!document) notAdded(`${rel} is not open`);
    if (document.isDirty) notAdded(`${rel} has unsaved changes; save it first, so the line is the one the agent will read`);
    if (!thread.range) notAdded('it is not on a line');
    const fileLevel = !!(purpose && purpose.fileLevel);
    const first = thread.range.start.line, last = thread.range.end.line;
    const line = fileLevel ? null : first + 1;
    const result = await drafts.add({
      file: rel, line, symbol: line === null ? null : symbolAt(ctx.result, rel, line),
      caller: purpose ? purpose.caller : null,
      quote: fileLevel ? '' : quoteOf(document, first, last), body: text,
    });
    if (!result.ok) notAdded(result.error.message);
    if (result.warning) own(vscode.window.showWarningMessage(`Impact Tree: ${result.warning}.`), 'showing a warning');
    // The draft is drawn from the store now; the box goes.
    thread.dispose();
  }

  /** @param {unknown} arg The box's thread, or a `CommentReply`. */
  function cancel(arg) {
    const thread = isObject(arg) && isObject(arg.thread) ? arg.thread : arg;
    if (!isObject(thread) || draftIds.has(thread)) return;
    thread.dispose();
  }

  // ---- edit and delete ----------------------------------------------------------------------

  /**
   * The draft id an action names: a drawn comment or thread, a tree row, or an id.
   * @param {unknown} arg
   * @returns {string|null}
   */
  function idOf(arg) {
    if (typeof arg === 'string') return arg;
    if (!isObject(arg)) return null;
    if (typeof arg.draftId === 'string') return arg.draftId;
    return draftIds.get(arg) || (isObject(arg.thread) ? draftIds.get(arg.thread) || null : null);
  }

  /** @param {string} id @returns {{ thread: any, comment: any, signature: string }|null} */
  function drawnOf(id) {
    for (const threads of drawn.values()) {
      const d = threads.get(id);
      if (d) return d;
    }
    return null;
  }

  /** @param {{ thread: any, comment: any }} d @param {number} mode */
  function setMode(d, mode) {
    d.comment.mode = mode;
    d.thread.comments = [d.comment];
    d.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /**
   * Opens a draft's file at its line: the review diff for a file of the local result shown,
   * else the file itself.
   * @param {FeedbackItem} item
   * @returns {Promise<boolean>} False, after saying why, when it could not be opened.
   */
  async function openItem(item) {
    const ctx = contextNow();
    try {
      if (ctx && ctx.files.has(item.file)) {
        await openDiff(item.file, item.line);
      } else {
        const root = repoRoot();
        const line = Math.max(0, (item.line || 1) - 1);
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, ...item.file.split('/'))),
          { preview: true, selection: new vscode.Range(line, 0, line, 0) });
      }
      return true;
    } catch (e) {
      log(`feedback: could not open ${item.file}: ${/** @type {Error} */ (e).message}`);
      tell(`cannot open ${item.file}: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  /** @param {unknown} arg A tree row, from its click. */
  async function open(arg) {
    const id = idOf(arg);
    const item = id ? drafts.get(id) : null;
    if (!item) { tell('that feedback draft is no longer there.'); return; }
    await openItem(item);
  }

  /** @param {unknown} arg A drawn comment or thread, or a tree row. */
  async function edit(arg) {
    const id = idOf(arg);
    const item = id ? drafts.get(id) : null;
    if (!id || !item) { tell('that feedback draft is no longer there.'); return; }
    // From the tree, the draft's line is shown first, so the edit happens where it is seen.
    if (isObject(arg) && arg.type === 'feedbackDraft') {
      if (!await openItem(item)) return;
      draw();
    }
    const d = drawnOf(id);
    if (d) { setMode(d, vscode.CommentMode.Editing); return; }
    // Not drawn anywhere VS Code can edit it: edit the text in an input box instead.
    const body = await vscode.window.showInputBox({
      title: `Edit feedback · ${item.file}${item.line !== null ? `:${item.line}` : ''}`, value: item.body, prompt: 'Feedback for the agent (Markdown)',
      validateInput: (/** @type {string} */ v) => (v.trim() === '' ? 'Write the feedback, or use Delete to remove the draft.' : null),
    });
    if (typeof body !== 'string') return;
    await save(id, body);
  }

  /**
   * @param {string} id
   * @param {string} body
   * @returns {Promise<boolean>} Whether the draft now has this body.
   */
  async function save(id, body) {
    const result = await drafts.update(id, body);
    if (!result.ok) {
      own(vscode.window.showErrorMessage(`Impact Tree: could not save this feedback — ${result.error.message}.`), 'showing an error');
      return false;
    }
    if (result.warning) own(vscode.window.showWarningMessage(`Impact Tree: ${result.warning}.`), 'showing a warning');
    return true;
  }

  /** @param {unknown} arg The comment being edited; VS Code has put the edited text in its body. */
  async function saveEdit(arg) {
    const id = idOf(arg);
    if (!id || !isObject(arg)) return;
    const body = typeof arg.body === 'string' ? arg.body : isObject(arg.body) && typeof arg.body.value === 'string' ? arg.body.value : null;
    if (body === null) return;
    if (!await save(id, body)) return;
    // An unchanged body draws nothing new: leave edit mode here.
    const d = drawnOf(id);
    if (d && d.comment.mode === vscode.CommentMode.Editing) setMode(d, vscode.CommentMode.Preview);
  }

  /** @param {unknown} arg The comment being edited. */
  function cancelEdit(arg) {
    const id = idOf(arg);
    const d = id ? drawnOf(id) : null;
    const item = id ? drafts.get(id) : null;
    if (!d || !item) return;
    d.comment.body = markdown(item.body);
    setMode(d, vscode.CommentMode.Preview);
  }

  /** @param {unknown} arg A drawn comment or thread, or a tree row. */
  async function remove(arg) {
    const id = idOf(arg);
    if (!id) return;
    const result = await drafts.remove(id);
    if (!result.ok) { tell(`could not delete the feedback draft: ${result.error.message}.`); return; }
    if (result.warning) own(vscode.window.showWarningMessage(`Impact Tree: ${result.warning}.`), 'showing a warning');
  }

  // ---- starting a box from the tree or Details ----------------------------------------------

  /**
   * The local result a box can be started on, or null after saying why not.
   * @returns {FeedbackContext|null}
   */
  function startContext() {
    const ctx = contextNow();
    if (!ctx) tell('feedback can be started only while a local review or a checked-out pull request is shown.');
    return ctx;
  }

  /**
   * Opens the file's review diff at `line` and adds an empty box there.
   * @param {FeedbackContext} ctx
   * @param {number} line 1-based.
   * @param {BoxPurpose} purpose
   * @returns {Promise<any>} The box's thread, or null.
   */
  async function openBox(ctx, line, purpose) {
    try {
      await openDiff(purpose.relPath, purpose.fileLevel ? null : line);
    } catch (e) {
      log(`feedback: could not open ${purpose.relPath}: ${/** @type {Error} */ (e).message}`);
      tell(`cannot open ${purpose.relPath}: ${/** @type {Error} */ (e).message}`);
      return null;
    }
    // Another analysis or result replaced this one while the diff opened: add nothing.
    if (!stillShown(ctx)) return null;
    const uri = vscode.Uri.file(path.join(ctx.repoRoot, ...purpose.relPath.split('/')));
    const thread = controller.createCommentThread(uri, new vscode.Range(line - 1, 0, line - 1, 0), []);
    purposes.set(thread, purpose);
    thread.canReply = true;
    thread.label = purpose.fileLevel || purpose.caller
      ? draftLabel({ line: purpose.fileLevel ? null : line, symbol: null, caller: purpose.caller }).replace(/^Feedback · draft/, 'New feedback')
      : undefined;
    thread.contextValue = 'feedbackNew';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return thread;
  }

  /**
   * Starts a box for a row: on line 1 of a file row (feedback on the whole file), or on the
   * first line of a change or of an outside row's lines.
   * @param {any} row
   * @param {{ label: string, file: string, line: number }|null} [caller] The caller it is about.
   * @returns {Promise<any>} The box's thread, or null.
   */
  async function commentOnRow(row, caller = null) {
    if (!isObject(row)) return null;
    const fileLevel = row.type === 'reviewFile' || row.type === 'file';
    const place = fileLevel ? null : rowCommentPlace(/** @type {any} */ (row));
    const relPath = fileLevel ? row.relPath : place && place.relPath;
    if (typeof relPath !== 'string') return null;
    const ctx = startContext();
    if (!ctx) return null;
    if (!ctx.files.has(relPath)) { tell(`${relPath} is not a file on disk of the review shown.`); return null; }
    return openBox(ctx, fileLevel || !place ? 1 : place.preferred, { relPath, fileLevel, caller });
  }

  /**
   * Starts a box about a caller of a change: on the call's line when its file is one of the
   * result's, else on the change, naming the caller.
   * @param {any} row The change row the caller is under.
   * @param {CallerContext} caller
   * @returns {Promise<any>} The box's thread, or null.
   */
  async function commentOnCaller(row, caller) {
    const about = { label: caller.label, file: caller.relPath, line: caller.siteLine };
    const ctx = startContext();
    if (!ctx) return null;
    if (ctx.files.has(caller.relPath)) return openBox(ctx, caller.siteLine, { relPath: caller.relPath, fileLevel: false, caller: about });
    return commentOnRow(row, about);
  }

  /** @type {Disposable[]} */
  const subscriptions = [
    drafts.onDidChange(() => draw()),
    ...contextEvents.map((event) => event(() => draw())),
    vscode.workspace.onDidOpenTextDocument((/** @type {any} */ document) => draw(document.uri.toString())),
    vscode.workspace.onDidCloseTextDocument((/** @type {any} */ document) => disposeDocument(document.uri.toString())),
    vscode.commands.registerCommand(COMMANDS.add, add),
    vscode.commands.registerCommand(COMMANDS.cancel, cancel),
    vscode.commands.registerCommand(COMMANDS.edit, edit),
    vscode.commands.registerCommand(COMMANDS.saveEdit, saveEdit),
    vscode.commands.registerCommand(COMMANDS.cancelEdit, cancelEdit),
    vscode.commands.registerCommand(COMMANDS.remove, remove),
    vscode.commands.registerCommand(COMMANDS.open, open),
  ];

  draw();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of subscriptions) s.dispose();
      for (const key of [...drawn.keys()]) disposeDocument(key);
      controller.dispose();
    },
    /** Whether feedback can be started now: a local review or a checked-out pull request is shown. */
    available: () => !disposed && contextNow() !== null,
    commentOnRow: (/** @type {any} */ row) => commentOnRow(row),
    commentOnCaller,
  };
}

module.exports = { createFeedbackComments, FeedbackNotAddedError, CONTROLLER_ID, CONTROLLER_LABEL, COMMANDS };
