// @ts-check
'use strict';
// The agent's notes beside the code (docs/UX_PLAN.md L6, gates G15 and G16): a third comment
// controller, `impactTree.agent`, next to the pull request one (`review-comments.js`) and the
// feedback one (`feedback-comments.js`), which it does not touch. One read-only thread per
// change the agent described, on the change's first line in the head side of the review diff:
// what the agent wrote, the callers it affects (a name the engine knows opens the call), the
// engine's verdict sentence, and who wrote it. What a note says is decided in
// `agent-threads-model.js`. Nothing here sends anything anywhere: "Reply in next round" opens
// a feedback draft, and "Post to the PR" opens a GitHub draft holding the note's text, both
// for the reviewer to edit and send or drop.
//
// No commenting ranges are offered and no thread can be replied to, so this controller never
// competes with the others when the reviewer starts a comment.
//
// Lifetime: a thread never outlives the result it came from. When the agent's result is not
// shown (none stored, Undo, the engine's cards asked for, a result for another state of the
// branch) or is another result than the one drawn, every thread is disposed. Drawing is
// synchronous and reads the state once, so nothing older is drawn. A thread whose note did not
// change keeps its VS Code object (and the way the reviewer left it open or closed); it is
// opened or closed only when the review's attention set changes whether it is expanded.
//
// Documents: those of the visible editors that are the head side of a reviewed file
// (`whereIs`). A local review cannot tell a diff's right side from a plain editor of the same
// file, so both show the notes.

const { needsAttention, changeIdOf } = require('../views/changes/review-tree-model');
const { classifyRowVerdict } = require('../views/changes/tree-row-models');
const { WORD } = require('../agent/agent-notes');
const { noteMarkdown, notePlainText, OPEN_CALLER_COMMAND } = require('./agent-threads-model');

const CONTROLLER_ID = 'impactTree.agent';
const CONTROLLER_LABEL = "Impact Tree: your agent's notes";
const COMMANDS = Object.freeze({
  markReviewed: 'impactTree.agent.markReviewed',
  markNotReviewed: 'impactTree.agent.markNotReviewed',
  replyNextRound: 'impactTree.agent.replyNextRound',
  postToPr: 'impactTree.agent.postToPr',
});
/** The author every note shows; the glyph stands for the sparkle (an author's icon takes only an address). */
const AUTHOR = Object.freeze({ name: '✦ Your agent' });

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null;

/**
 * @typedef {import('../views/changes/tree-row-models').TreeRow} TreeRow
 * @typedef {import('../agent/agent-review').AgentReview} AgentReview
 * @typedef {{ dispose(): any }} Disposable
 *
 * @typedef {object} ThreadSpec What a note's thread shows.
 * @property {string} id The change id (`relPath#namePos`).
 * @property {string} relPath
 * @property {number} line 0-based first line of the change.
 * @property {string} label The kind of the change, as a word.
 * @property {string} body The comment's markdown.
 * @property {string} contextValue Words the menus' `when` clauses match: `notReviewed` or
 *   `reviewed`, `canReply`, `canPost`.
 * @property {boolean} expanded The change needs attention.
 *
 * @typedef {object} AgentThreadsDeps
 * @property {{ changeRowsOf: (relPath: string) => TreeRow[], onDidChangeAgent: (listener: () => void) => Disposable }} provider
 *   The shown review's rows, and when the agent's answer changed.
 * @property {() => AgentReview} getAgentReview What the agent said, as the tree reads it.
 * @property {(uri: any) => { path: string, side: 'LEFT'|'RIGHT' }|null} whereIs Where a
 *   document is in the review: the file and the side, or null for a document that is not a
 *   side of a reviewed file.
 * @property {(row: TreeRow) => boolean} isReviewed Whether a change row is marked reviewed.
 * @property {(row: TreeRow, on: boolean) => void} setReviewed Marks a change row reviewed or not.
 * @property {() => boolean} canStartFeedback Whether a feedback draft can be started now
 *   (a local review or a checked-out pull request is shown).
 * @property {(row: TreeRow) => Promise<any>} startFeedbackDraft Opens the change's diff and a
 *   feedback box on its line; resolves to the thread or null.
 * @property {() => boolean} canPostToPr Whether a pull request under review can take a comment now.
 * @property {(row: TreeRow, text: string) => Promise<any>} startReviewDraft Opens the
 *   change's diff and a GitHub draft holding `text` on its line; resolves to the thread or null.
 * @property {Array<(listener: () => void) => Disposable>} [events] Fired when the analysis,
 *   the ticks, the pull request's state or the agent's result may have changed.
 * @property {(message: string) => void} [log]
 */

/**
 * Creates the comment controller and registers its commands.
 *
 * Ownership: the returned object owns the controller, every thread it drew, its
 * subscriptions and commands; `dispose()` ends them all.
 * @param {any} vscode
 * @param {AgentThreadsDeps} deps
 * @returns {{ dispose(): void, redraw(): void }} `redraw` draws again from the current state.
 */
function createAgentThreads(vscode, { provider, getAgentReview, whereIs, isReviewed, setReviewed, canStartFeedback, startFeedbackDraft,
  canPostToPr, startReviewDraft, events = [], log = () => {} }) {
  let disposed = false;
  const controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);

  /** @param {Promise<unknown>|unknown} shown @param {string} what */
  const own = (shown, what) => {
    Promise.resolve(shown).then(undefined, (e) => log(`agent notes: ${what} failed: ${e && e.message}`));
  };
  /** @param {string} message */
  const tell = (message) => own(vscode.window.showWarningMessage(`Impact Tree: ${message}`), 'showing a warning');

  // Drawn threads by document (its URI string), then by change id. `expanded` is what the
  // thread was last drawn as, so only a change of it opens or closes the thread.
  /** @type {Map<string, Map<string, { thread: any, signature: string, expanded: boolean }>>} */
  const drawn = new Map();
  // The change a drawn thread is the note of.
  /** @type {WeakMap<object, { id: string, relPath: string }>} */
  const noteOf = new WeakMap();
  // The result the drawn threads came from: its key, or null while none is drawn.
  /** @type {string|null} */
  let shownKey = null;

  // ---- what to draw ------------------------------------------------------------------------

  /** @param {AgentReview} review @returns {boolean} Whether the agent's notes are shown. */
  const showsNotes = (review) => review.notes !== null && review.hasResult && !review.showEngine && !review.stale && review.resultKey !== null;

  /** @param {TreeRow} row @param {AgentReview} review @returns {ThreadSpec|null} */
  function specOf(row, review) {
    const id = changeIdOf(row);
    const change = id && review.notes ? review.notes.change(id) : null;
    if (!id || !change || row.type !== 'finding') return null;
    const contextValue = [isReviewed(row) ? 'reviewed' : 'notReviewed', ...(canStartFeedback() ? ['canReply'] : []), ...(canPostToPr() ? ['canPost'] : [])].join(' ');
    return {
      id, relPath: row.finding.relPath, line: row.finding.startLine - 1, label: WORD[change.kind], contextValue,
      body: noteMarkdown(change, { verdict: classifyRowVerdict(row).sentence, callers: row.finding.callers || [] }),
      expanded: needsAttention(row, review.attention),
    };
  }

  /** @param {string} relPath @param {AgentReview} review @returns {ThreadSpec[]} */
  function specsFor(relPath, review) {
    /** @type {ThreadSpec[]} */
    const specs = [];
    for (const row of provider.changeRowsOf(relPath)) {
      const spec = specOf(row, review);
      if (spec) specs.push(spec);
    }
    return specs;
  }

  // ---- drawing -----------------------------------------------------------------------------

  /** @param {string} key */
  function disposeDocument(key) {
    const threads = drawn.get(key);
    if (!threads) return;
    for (const { thread } of threads.values()) thread.dispose();
    drawn.delete(key);
  }

  function disposeAll() {
    for (const key of [...drawn.keys()]) disposeDocument(key);
  }

  /** @param {boolean} expanded */
  const stateOf = (expanded) => (expanded ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed);

  /** @param {string} body */
  function markdown(body) {
    const md = new vscode.MarkdownString(body);
    // The agent's text is escaped; the only links are the callers', which open a call site.
    md.isTrusted = { enabledCommands: [OPEN_CALLER_COMMAND] };
    md.supportHtml = false;
    md.supportThemeIcons = false;
    return md;
  }

  /** @param {ThreadSpec} spec */
  const commentOf = (spec) => ({ body: markdown(spec.body), mode: vscode.CommentMode.Preview, author: AUTHOR });

  /**
   * Makes a document's threads those of `specs`: removes the rest, creates the new ones, and
   * updates in place the ones whose note changed.
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
      const { expanded, ...shown } = spec;
      const signature = JSON.stringify(shown);
      const existing = threads.get(spec.id);
      if (!existing) {
        const range = new vscode.Range(spec.line, 0, spec.line, 0);
        const thread = controller.createCommentThread(uri, range, [commentOf(spec)]);
        noteOf.set(thread, { id: spec.id, relPath: spec.relPath });
        thread.label = spec.label;
        thread.contextValue = spec.contextValue;
        thread.canReply = false;
        thread.collapsibleState = stateOf(expanded);
        threads.set(spec.id, { thread, signature, expanded });
        continue;
      }
      if (existing.signature !== signature) {
        const { thread } = existing;
        if (thread.range.start.line !== spec.line) thread.range = new vscode.Range(spec.line, 0, spec.line, 0);
        thread.comments = [commentOf(spec)];
        thread.label = spec.label;
        thread.contextValue = spec.contextValue;
        existing.signature = signature;
      }
      // Opened or closed only when the attention set says so; otherwise as the reviewer left it.
      if (existing.expanded !== expanded) {
        existing.thread.collapsibleState = stateOf(expanded);
        existing.expanded = expanded;
      }
    }
    if (threads.size) drawn.set(key, threads); else drawn.delete(key);
  }

  /** @returns {any[]} The documents of the visible editors, each once. */
  function visibleDocuments() {
    /** @type {Map<string, any>} */
    const byKey = new Map();
    for (const editor of vscode.window.visibleTextEditors || []) {
      if (editor && editor.document) byKey.set(editor.document.uri.toString(), editor.document);
    }
    return [...byKey.values()];
  }

  /** Draws the notes of the result shown on the visible editors; disposes what does not belong. */
  function draw() {
    if (disposed) return;
    const review = getAgentReview();
    const key = showsNotes(review) ? review.resultKey : null;
    // Another result, or none: nothing of the old one stays.
    if (key !== shownKey) { disposeAll(); shownKey = key; }
    if (key === null) return;
    const open = visibleDocuments();
    const openKeys = new Set(open.map((d) => d.uri.toString()));
    for (const document of open) {
      const at = whereIs(document.uri);
      reconcile(document.uri, at && at.side === 'RIGHT' ? specsFor(at.path, review) : []);
    }
    for (const documentKey of [...drawn.keys()]) if (!openKeys.has(documentKey)) disposeDocument(documentKey);
  }

  // ---- commands ----------------------------------------------------------------------------

  /**
   * The change row a drawn thread is the note of, or null when the thread is not one of
   * ours or the review no longer has the change.
   * @param {unknown} arg The thread, from its title action.
   * @returns {TreeRow|null}
   */
  function rowOf(arg) {
    const note = isObject(arg) ? noteOf.get(arg) : undefined;
    if (!note) return null;
    return provider.changeRowsOf(note.relPath).find((r) => r.type === 'finding' && changeIdOf(r) === note.id) || null;
  }

  /** @param {unknown} arg The thread, from its title action. */
  function toggleReviewed(arg) {
    const row = rowOf(arg);
    if (!row) { tell('that note is no longer part of the review shown.'); return; }
    setReviewed(row, !isReviewed(row));
    // The thread's menu follows the mark.
    draw();
  }

  /**
   * The change row and the agent's note on it, for the two actions that start a comment.
   * @param {unknown} arg The thread, from its title action.
   * @returns {{ row: TreeRow, text: string }|null} Null, after saying why, when the thread is not a note of the result shown.
   */
  function noteFor(arg) {
    const row = rowOf(arg);
    const review = getAgentReview();
    const id = row ? changeIdOf(row) : null;
    const change = id && showsNotes(review) && review.notes ? review.notes.change(id) : null;
    if (!row || !change) { tell('that note is no longer part of the review shown.'); return null; }
    return { row, text: notePlainText(change) };
  }

  /** @param {unknown} arg The thread, from its title action. */
  async function replyNextRound(arg) {
    const note = noteFor(arg);
    if (!note) return;
    if (!canStartFeedback()) { tell('feedback can be started only while a local review or a checked-out pull request is shown.'); return; }
    await startFeedbackDraft(note.row);
  }

  /** @param {unknown} arg The thread, from its title action. */
  async function postToPr(arg) {
    const note = noteFor(arg);
    if (!note) return;
    if (!canPostToPr()) { tell('comments can be posted only on a pull request under review.'); return; }
    await startReviewDraft(note.row, note.text);
  }

  // ---- lifetime ----------------------------------------------------------------------------

  /** @type {Disposable[]} */
  const subscriptions = [
    provider.onDidChangeAgent(draw),
    ...events.map((event) => event(draw)),
    vscode.window.onDidChangeVisibleTextEditors(draw),
    vscode.workspace.onDidOpenTextDocument(draw),
    vscode.commands.registerCommand(COMMANDS.markReviewed, toggleReviewed),
    vscode.commands.registerCommand(COMMANDS.markNotReviewed, toggleReviewed),
    vscode.commands.registerCommand(COMMANDS.replyNextRound, replyNextRound),
    vscode.commands.registerCommand(COMMANDS.postToPr, postToPr),
  ];

  draw();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of subscriptions) s.dispose();
      disposeAll();
      controller.dispose();
    },
    redraw: draw,
  };
}

module.exports = { createAgentThreads, CONTROLLER_ID, CONTROLLER_LABEL, COMMANDS };
