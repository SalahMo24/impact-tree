// @ts-check
'use strict';
const crypto = require('crypto');
const { reviewDataOf } = require('./pr-review-store');
const { buildPullRequestHtml, pageModelOf, pendingStatusOf, submittedMessage } = require('./pr-overview-html');

// The Pull Request tab (review loop L7): one editor tab per window showing the pull
// request under review, its timeline, the viewer's pending comments, and the form that
// submits or cancels the review. Also the status bar item for a pending review, the
// `impactTree.hasPullRequestReview` context key, and the command that jumps to a thread.
// The HTML is built by pr-overview-html; this module owns the webview panel, its
// messages, the kept summary drafts and the status bar item. Every write goes through the
// review store.

/** @typedef {import('./pr-overview-html').ReviewEvent} ReviewEvent */
/** @typedef {import('./tree-row-models').TreeRow} TreeRow */

const VIEW_TYPE = 'impactTree.pullRequest';
const CONTEXT_KEY = 'impactTree.hasPullRequestReview';
const REVIEW_EVENTS = Object.freeze(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
/**
 * The longest summary accepted from the page, in UTF-16 code units: four times GitHub's
 * own 65,536-character limit, so a real draft is never refused here (GitHub refuses it with
 * its own message) while a runaway message is not kept in memory.
 */
const MAX_BODY = 262144;
/**
 * Summary drafts kept, one per pull request number, least recently written dropped
 * first. Owner: this module; cleared on dispose. 20 covers switching between the pull
 * requests of a working day; a dropped draft only loses unsent text of an old one.
 */
const MAX_DRAFTS = 20;

/**
 * @typedef {{ type: 'submit', event: ReviewEvent, body: string, approveAnyway: boolean }
 *   | { type: 'discard' } | { type: 'retry' } | { type: 'ready' }
 *   | { type: 'revealThread', threadId: string } | { type: 'revealRow', rowId: string }
 *   | { type: 'draft', body: string }} PageMessage
 */

/** @param {unknown} v @returns {v is string} */
const isBody = (v) => typeof v === 'string' && v.length <= MAX_BODY;
/** @param {unknown} v @returns {v is string} */
const isId = (v) => typeof v === 'string' && v !== '' && v.length <= 1024;

/**
 * A message from the currently rendered page, or null for anything else: a message from an
 * older page (its nonce no longer current), from a closed panel, or of an unknown shape.
 * @param {unknown} message
 * @param {string|null} token The rendered page's nonce; null when there is none.
 * @returns {PageMessage|null}
 */
function parseMessage(message, token) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  if (token === null || m.token !== token) return null;
  switch (m.type) {
    case 'submit':
      if (!REVIEW_EVENTS.includes(/** @type {string} */ (m.event)) || !isBody(m.body) || typeof m.approveAnyway !== 'boolean') return null;
      return { type: 'submit', event: /** @type {ReviewEvent} */ (m.event), body: m.body, approveAnyway: m.approveAnyway };
    case 'discard': return { type: 'discard' };
    case 'retry': return { type: 'retry' };
    case 'ready': return { type: 'ready' };
    case 'revealThread': return isId(m.threadId) ? { type: 'revealThread', threadId: m.threadId } : null;
    case 'revealRow': return isId(m.rowId) ? { type: 'revealRow', rowId: m.rowId } : null;
    case 'draft': return isBody(m.body) ? { type: 'draft', body: m.body } : null;
    default: return null;
  }
}

/**
 * @typedef {object} OpenPanel One open tab. Replaced, never reused, when the tab closes.
 * @property {any} panel The `WebviewPanel`.
 * @property {number} number The pull request it shows; the tab closes when this stops being the one under review.
 * @property {string|null} token The rendered page's nonce; null once the tab is closed.
 * @property {string|null} renderedKey The page model last rendered, without the draft.
 * @property {string|null} error The last submit or discard failure, shown in the page.
 * @property {null|'submit'|'discard'} busy
 * @property {Array<{ dispose(): any }>} subscriptions
 */

/**
 * Registers the Pull Request tab, its commands, the pending-review status bar item and
 * the context key.
 *
 * Commands:
 * - `impactTree.showPullRequest` and `impactTree.submitReview` open the tab, or reveal it.
 * - `impactTree.revealReviewThread(threadId: string)` opens the file of a thread of the
 *   loaded review in the review diff (`revealThread`, the comment controller's, which
 *   Details uses too). Resolves to false when the thread is not in the loaded review.
 *
 * Ownership: the module owns the tab (at most one), its subscriptions, the drafts and
 * the status bar item; the returned disposables end all of them. The tab owns its message
 * subscription and its nonce; closing it (by the user, by the end of the pull request
 * review, or on dispose) drops both. A submit or discard that finishes after its tab was
 * closed or replaced publishes nothing to the page.
 * @param {any} vscode
 * @param {{
 *   store: Pick<import('./pr-review-store').PullRequestReviewStore, 'getState'|'onDidChange'|'submitReview'|'discardPendingReview'|'refresh'>,
 *   provider: { attentionLeft: () => TreeRow[]|null, reviewCounts: () => { total: number, left: number }|null,
 *     onDidChangeReview: (listener: (e: any) => void) => { dispose(): any },
 *     onDidChangePresentation: (listener: (e: any) => void) => { dispose(): any } },
 *   revealRow: (id: string) => Promise<boolean>,
 *   revealThread: (threadId: unknown) => Promise<boolean>,
 *   log: (message: string) => void,
 * }} deps `provider` is the change tree's; `revealRow` goes to a tree row by id;
 *   `revealThread` opens a thread of the loaded review in the review diff, saying why when it cannot.
 * @returns {{ disposables: Array<{ dispose(): any }>, open: () => void }}
 */
function createPullRequestPanel(vscode, { store, provider, revealRow, revealThread, log }) {
  let disposed = false;
  /** @type {OpenPanel|null} */
  let current = null;
  /** @type {Map<number, string>} */
  const drafts = new Map();

  /** @param {number} number @param {string} body */
  function keepDraft(number, body) {
    drafts.delete(number);
    if (body === '') return;
    drafts.set(number, body);
    if (drafts.size > MAX_DRAFTS) drafts.delete(/** @type {number} */ (drafts.keys().next().value));
  }

  /** @param {any} state @returns {number|null} */
  const numberOf = (state) => (state.kind !== 'none' && state.target ? state.target.number : null);

  /** @param {OpenPanel} open */
  const modelOf = (open) => pageModelOf(store.getState(), {
    attentionLeft: provider.attentionLeft(), counts: provider.reviewCounts(),
    draft: drafts.get(open.number) ?? '', error: open.error, busy: open.busy,
  });

  /**
   * Paints the tab when what it shows changed, or always when forced. The draft is left
   * out of the comparison: the page already holds what the reviewer typed.
   * @param {boolean} [force]
   */
  function render(force = false) {
    const open = current;
    if (!open || disposed) return;
    const model = modelOf(open);
    if (!model) return;
    const key = JSON.stringify({ ...model, draft: null });
    if (!force && key === open.renderedKey) return;
    const nonce = crypto.randomBytes(16).toString('base64');
    open.token = nonce;
    open.renderedKey = key;
    open.panel.webview.html = buildPullRequestHtml(model, { nonce, cspSource: open.panel.webview.cspSource });
  }

  /** @param {OpenPanel} open @param {object} message */
  const post = (open, message) => {
    Promise.resolve(open.panel.webview.postMessage({ ...message, token: open.token }))
      .then(undefined, (/** @type {any} */ err) => log(`pull request tab: could not update the page: ${err && err.message}`));
  };

  // A bar item shown only while the viewer's pending review holds comments.
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  bar.name = 'Impact Tree pending review';
  bar.command = 'impactTree.showPullRequest';
  /** @type {unknown} */
  let sentContext;
  function updateStatus() {
    const state = store.getState();
    const hasReview = state.kind !== 'none';
    if (sentContext !== hasReview) {
      sentContext = hasReview;
      Promise.resolve(vscode.commands.executeCommand('setContext', CONTEXT_KEY, hasReview))
        .then(undefined, (/** @type {any} */ err) => log(`pull request tab: could not set ${CONTEXT_KEY}: ${err && err.message}`));
    }
    const status = pendingStatusOf(state);
    if (!status) { bar.hide(); return; }
    if (bar.text !== status.text) bar.text = status.text;
    bar.tooltip = `Open Pull Request #${status.number} to submit or cancel your pending review`;
    bar.show();
  }

  function onStoreChange() {
    if (disposed) return;
    updateStatus();
    if (!current) return;
    // The tab belongs to one pull request review: when that ends, the tab goes with it.
    if (numberOf(store.getState()) !== current.number) { current.panel.dispose(); return; }
    render();
  }

  function open() {
    if (disposed) return;
    const state = store.getState();
    if (state.kind === 'none') {
      vscode.window.showInformationMessage('Impact Tree: no pull request is under review. Preview or check out one from the Review view first.');
      return;
    }
    const number = numberOf(state);
    if (number === null) {
      vscode.window.showErrorMessage(`Impact Tree: the pull request under review cannot be shown: ${state.kind === 'failed' ? state.error.message : 'it has no number'}`);
      return;
    }
    if (current && current.number === number) { current.panel.reveal(); return; }
    if (current) current.panel.dispose();
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `Pull Request #${number}`, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false });
    /** @type {OpenPanel} */
    const opened = { panel, number, token: null, renderedKey: null, error: null, busy: null, subscriptions: [] };
    current = opened;
    opened.subscriptions = [
      panel.webview.onDidReceiveMessage((/** @type {unknown} */ m) => onMessage(opened, m)
        .catch((/** @type {any} */ err) => log(`pull request tab: ${err && err.message}`))),
      panel.onDidDispose(() => closed(opened)),
    ];
    render(true);
  }

  /** @param {OpenPanel} closing */
  function closed(closing) {
    for (const s of closing.subscriptions) s.dispose();
    closing.subscriptions = [];
    closing.token = null;
    if (current === closing) current = null;
  }

  /**
   * @param {OpenPanel} owner
   * @param {Extract<PageMessage, { type: 'submit' }>} m
   */
  async function submit(owner, m) {
    if (owner.busy) return;
    const model = modelOf(owner);
    if (!model || model.kind !== 'ready') return;
    keepDraft(owner.number, m.body);
    // Ours, not GitHub's: the store would send it, so the check is made here.
    if (m.event === 'APPROVE' && model.check && !m.approveAnyway) {
      owner.error = 'Not approved: tick “Approve anyway” first. Changes needing attention or unresolved threads are still open.';
      render();
      return;
    }
    owner.busy = 'submit';
    owner.error = null;
    render();
    let result;
    try {
      result = await store.submitReview({ event: m.event, body: m.body });
    } finally {
      owner.busy = null;
    }
    if (result.ok) {
      vscode.window.showInformationMessage(submittedMessage(m.event, owner.number));
      // A draft typed while the review was sent is not the one that was submitted.
      if ((drafts.get(owner.number) ?? '') === m.body) drafts.delete(owner.number);
    } else {
      owner.error = `The review was not submitted: ${result.error.message}`;
      vscode.window.showErrorMessage(`Impact Tree: ${owner.error}`);
    }
    if (current === owner) render();
  }

  /** @param {OpenPanel} owner */
  async function discard(owner) {
    if (owner.busy) return;
    const data = reviewDataOf(store.getState());
    if (!data || !data.pendingReview) return;
    const n = data.pendingReview.commentCount;
    const answer = await vscode.window.showWarningMessage(`Cancel your pending review on PR #${owner.number}?`,
      { modal: true, detail: `Its ${n} comment${n === 1 ? '' : 's'} will be deleted from GitHub. This cannot be undone.` },
      'Cancel review');
    if (answer !== 'Cancel review' || current !== owner || owner.busy) return;
    owner.busy = 'discard';
    owner.error = null;
    render();
    let result;
    try {
      result = await store.discardPendingReview();
    } finally {
      owner.busy = null;
    }
    if (result.ok) vscode.window.showInformationMessage(`Impact Tree: your pending review on PR #${owner.number} was cancelled`);
    else {
      owner.error = `The pending review was not cancelled: ${result.error.message}`;
      vscode.window.showErrorMessage(`Impact Tree: ${owner.error}`);
    }
    if (current === owner) render();
  }

  /** @param {OpenPanel} owner @param {unknown} raw */
  async function onMessage(owner, raw) {
    if (current !== owner) return;
    const m = parseMessage(raw, owner.token);
    if (!m) return;
    switch (m.type) {
      case 'ready': post(owner, { type: 'draft', body: drafts.get(owner.number) ?? '' }); return;
      case 'draft': keepDraft(owner.number, m.body); return;
      case 'submit': await submit(owner, m); return;
      case 'discard': await discard(owner); return;
      case 'retry': await store.refresh(); return;
      case 'revealThread': await vscode.commands.executeCommand('impactTree.revealReviewThread', m.threadId); return;
      case 'revealRow':
        if (!await revealRow(m.rowId)) vscode.window.showInformationMessage('Impact Tree: that change is not in the tree any more.');
        return;
    }
  }

  const repaint = () => { if (!disposed) render(); };
  updateStatus();
  return {
    open,
    disposables: [
      bar,
      store.onDidChange(onStoreChange),
      // The approve check counts the tree's ticks, so a tick can change the page.
      provider.onDidChangeReview(repaint),
      provider.onDidChangePresentation(repaint),
      vscode.commands.registerCommand('impactTree.showPullRequest', open),
      vscode.commands.registerCommand('impactTree.submitReview', open),
      vscode.commands.registerCommand('impactTree.revealReviewThread', revealThread),
      {
        dispose() {
          if (current) current.panel.dispose();
          disposed = true;
          current = null;
          drafts.clear();
        },
      },
    ],
  };
}

module.exports = { createPullRequestPanel, parseMessage, VIEW_TYPE, CONTEXT_KEY, MAX_DRAFTS };
