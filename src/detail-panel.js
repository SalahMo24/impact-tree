// @ts-check
'use strict';
const path = require('path');
const crypto = require('crypto');
const { treeItemId } = require('./review-tree-model');
const { prKey, parsePrAddress } = require('./pr-documents');
const { buildDetailHtml, listCallerRows, describeOrigin, reviewPresentation } = require('./detail-panel-html');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */

// The Details view under the change tree: one row explained in sentences. It shows the
// row selected in the tree, or the row under the cursor in a review diff, and reveals that
// row in the tree. The HTML is built by detail-panel-html; this module owns the webview,
// the events it follows and the messages its buttons send.

/**
 * The repo-relative path of a document when it is the head side of a file the shown result
 * reviews, else null. A PR preview's head side is an `impacttree-pr` address of the shown
 * revision; its base side and any `file:` document are not. A local review's head side is
 * the file on disk under the repository.
 * @param {{ scheme: string, path: string, query: string, fsPath: string }} uri
 * @param {{ result: any, rel: (file: string) => string }} state The session state.
 * @returns {string|null} The path is not checked against the result's files.
 */
function headRelPath(uri, { result, rel }) {
  if (result.tierA) {
    if (uri.scheme !== 'impacttree-pr') return null;
    const address = parsePrAddress(uri);
    return address.side === 'head' && !address.absent && address.revision === prKey(result) ? address.path : null;
  }
  // A local review cannot tell a diff's right side from a plain editor of the same file:
  // both are the file on disk. Both are taken as the head side, which they are.
  if (uri.scheme !== 'file') return null;
  const relPath = rel(uri.fsPath);
  return relPath && relPath !== '..' && !relPath.startsWith('../') && !path.isAbsolute(relPath) ? relPath : null;
}

/**
 * A message from the currently rendered page. Its nonce also serves as an action token:
 * an older page cannot act on a new selection or revision, even at the same tree id.
 * @param {unknown} message
 * @param {string|null} token The current page's nonce; null when the view is disposed.
 * @returns {{ type: 'tick', id: string, on: boolean }|{ type: 'next' }|{ type: 'ready' }|{ type: 'showCallers', id: string }|{ type: 'openCaller', index: number }|null}
 */
function parseMessage(message, token) {
  if (!message || typeof message !== 'object') return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  if (token === null || m.token !== token) return null;
  if (m.type === 'tick' && typeof m.id === 'string' && typeof m.on === 'boolean') return { type: 'tick', id: m.id, on: m.on };
  if (m.type === 'next') return { type: 'next' };
  if (m.type === 'ready') return { type: 'ready' };
  if (m.type === 'showCallers' && typeof m.id === 'string') return { type: 'showCallers', id: m.id };
  if (m.type === 'openCaller' && Number.isSafeInteger(m.index) && Number(m.index) >= 0) return { type: 'openCaller', index: Number(m.index) };
  return null;
}

/**
 * Registers the Details view and makes it follow the tree and the cursor.
 *
 * What is shown is a tree id and an origin, not a row: the row is looked up again on each
 * paint, so a tick, a filter or a new analysis shows the current row, or the hint when the
 * shown review no longer has it.
 *
 * A cursor moving inside the row shown changes only the header's line, so the header is
 * updated by a message to the page instead of a new document, which would reload it and
 * flicker. Progress patches text and attributes; a new row or analysis paints the whole
 * document. A tree filter changes neither the shown row nor its contents.
 *
 * Feedback loop: revealing the cursor's row selects it in the tree, and VS Code reports
 * that as a selection change. The id revealed is remembered, and a selection of exactly
 * that row keeps the cursor origin. Any other selection forgets it.
 * @param {any} vscode
 * @param {{
 *   provider: ReturnType<typeof import('./tree-provider').createTreeProvider>,
 *   view: { visible: boolean, selection: readonly TreeRow[], reveal: (row: TreeRow, options: object) => PromiseLike<void>,
 *     onDidChangeSelection: (listener: (e: { selection: readonly TreeRow[] }) => void) => { dispose(): any },
 *     onDidChangeVisibility: (listener: (e: { visible: boolean }) => void) => { dispose(): any } },
 *   getState: () => { result: any, rel: (file: string) => string }|null,
 *   lineOf: (file: string, offset: number) => number|null,
 *   log: (message: string) => void,
 * }} deps `view` is the change view; `getState` the session state; `lineOf` the 1-based
 *   line of an offset in a file, or null when unreadable.
 * @returns {{ disposables: Array<{ dispose(): any }> }}
 */
function createDetailPanel(vscode, { provider, view, getState, lineOf, log }) {
  /** @type {any} */
  let webviewView = null;
  /** @type {Array<{ dispose(): any }>} */
  let viewSubscriptions = [];
  /** @type {{ id: string|null, origin: string }} */
  let shown = { id: null, origin: 'tree' };
  /** @type {string|null} */
  let revealedFromCursor = null;
  // Owned by this panel; replaced on every full render, preserved for header-only updates,
  // and cleared on disposal. It identifies the exact page whose actions are still valid.
  /** @type {string|null} */
  let renderToken = null;
  // Panel-owned display model, replaced on render/patch and cleared on disposal.
  // It covers progress only; the session remains authoritative for analysis content.
  /** @type {import('./detail-panel-html').ReviewPresentation|null} */
  let lastReview = null;
  /** @type {number|null|undefined} */
  let renderedVersion;

  /** @param {object} message */
  const post = (message) => {
    if (!webviewView) return;
    Promise.resolve(webviewView.webview.postMessage(message))
      .then(undefined, (/** @type {any} */ err) => log(`details: could not update the page: ${err && err.message}`));
  };

  /** @param {boolean} [force] */
  function patchReview(force = false) {
    if (!webviewView || renderedVersion !== provider.reviewVersion()) return;
    const next = reviewPresentation(currentRow(), provider.isReviewed);
    if (!next) return;
    if (!force && lastReview && next.id === lastReview.id && next.reviewed === lastReview.reviewed
        && next.buttonText === lastReview.buttonText && next.summaryText === lastReview.summaryText) return;
    lastReview = next;
    post({ type: 'review', token: renderToken, model: next });
  }

  /** @param {import('./tree-provider').ReviewProgress} event */
  function onProgress(event) {
    if (event.analysisId !== renderedVersion || !shown.id || !event.changedIds.includes(shown.id)) return;
    patchReview();
  }

  const currentRow = () => (shown.id ? provider.rowById(shown.id) : null);
  // The row a selected row stands for: itself when it has a tree id, else the change it sits under.
  /** @param {TreeRow|undefined} row @returns {TreeRow|null} */
  const ownerOf = (row) => {
    while (row && treeItemId(row) === undefined) row = provider.getParent(row);
    return row || null;
  };

  function render() {
    if (!webviewView) return;
    const row = currentRow();
    const state = getState();
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = buildDetailHtml(row, {
      result: state && state.result, isReviewed: provider.isReviewed,
      impactRows: row && row.type === 'finding' ? provider.impactRowsOf(row) : [],
      nonce, cspSource: webviewView.webview.cspSource, origin: shown.origin, lineOf,
    });
    renderToken = nonce;
    renderedVersion = provider.reviewVersion();
    lastReview = reviewPresentation(row, provider.isReviewed);
    webviewView.webview.html = html;
  }
  /** @param {string|null} id @param {string} origin */
  const show = (id, origin) => {
    if (id === shown.id && renderedVersion === provider.reviewVersion()) {
      if (origin !== shown.origin) moveOrigin(origin);
      return;
    }
    shown = { id, origin };
    render();
  };
  // The same row from another place: only the header's text changes.
  /** @param {string} origin */
  const moveOrigin = (origin) => {
    shown = { id: shown.id, origin };
    post({ type: 'origin', token: renderToken, text: describeOrigin(origin) });
  };

  /** @param {{ selection: readonly TreeRow[] }} e */
  function onSelection(e) {
    const picked = e.selection[0];
    // A cleared selection says nothing about what to explain.
    if (!picked) return;
    if (revealedFromCursor !== null && treeItemId(picked) === revealedFromCursor) return;
    revealedFromCursor = null;
    const owner = ownerOf(picked);
    show(owner ? /** @type {string} */ (treeItemId(owner)) : null, 'tree');
  }

  // A selection set by a command is not the reviewer moving the cursor: it is a diff opened
  // from the tree or the panel, or a jump. Following it would take the panel and the tree's
  // selection away from the row just clicked.
  /** @param {{ textEditor: any, selections: readonly any[], kind?: number }} e */
  function onCursor(e) {
    // Each view follows only while it is on screen: reveal opens a hidden view, even with
    // focus:false, and must not replace the reviewer's sidebar. A tree that missed the
    // cursor catches up when it is shown again.
    const treeVisible = view.visible;
    if (!treeVisible && !webviewView?.visible) return;
    if (e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
    if (e.textEditor !== vscode.window.activeTextEditor || !e.selections.length) return;
    const state = getState();
    if (!state || !state.result) return;
    const relPath = headRelPath(e.textEditor.document.uri, state);
    if (!relPath) return;
    const line = e.selections[0].active.line + 1;
    const row = provider.rowAtLine(relPath, line);
    const id = row && treeItemId(row);
    if (!row || !id) return;
    const origin = `cursor:${line}`;
    if (id === shown.id) {
      if (origin !== shown.origin) moveOrigin(origin);
      return;
    }
    show(id, origin);
    if (treeVisible) revealShown(row, id);
  }

  // Selects the row the panel shows without the selection replacing the panel's header.
  // A row the filter hides cannot be revealed; the panel still shows it.
  /** @param {TreeRow} row @param {string} id */
  function revealShown(row, id) {
    revealedFromCursor = id;
    Promise.resolve(view.reveal(row, { select: true, focus: false }))
      .then(undefined, (/** @type {any} */ err) => log(`details: could not reveal ${id}: ${err && err.message}`));
  }

  // A tree shown again may still select the row it had before the cursor moved on, and
  // clicking an already selected row changes nothing. It is visible now, so revealing the
  // panel's row cannot open or switch a view.
  function onTreeVisible() {
    if (!view.visible || !shown.id) return;
    const owner = ownerOf(view.selection[0]);
    if (owner && treeItemId(owner) === shown.id) return;
    const row = currentRow();
    if (row) revealShown(row, shown.id);
  }

  // A lens asks for a change to be explained: the panel shows it and the tree selects it, as
  // if the reviewer had picked it there. The selection that reveal causes is the one already shown.
  /** @param {unknown} id */
  async function showChange(id) {
    const row = typeof id === 'string' ? provider.rowById(id) : null;
    if (!row || typeof id !== 'string') return;
    show(id, 'tree');
    revealedFromCursor = id;
    // A row the filter hides cannot be revealed; the panel still shows it.
    await Promise.resolve(view.reveal(row, { select: true, focus: false }))
      .then(undefined, (/** @type {any} */ err) => log(`details: could not reveal ${id}: ${err && err.message}`));
  }

  /** @param {unknown} message */
  async function onMessage(message) {
    const m = parseMessage(message, renderToken);
    if (!m || renderedVersion !== provider.reviewVersion()) return;
    if (m.type === 'ready') {
      patchReview(true);
      if (shown.id) post({ type: 'origin', token: renderToken, text: describeOrigin(shown.origin) });
      return;
    }
    if (m.type === 'next') { await vscode.commands.executeCommand('impactTree.nextUnreviewed'); return; }
    const row = currentRow();
    if (!row) return;
    // A click that left the page before the panel moved on to another row ticks nothing.
    if (m.type === 'tick') {
      if (m.id !== shown.id) return;
      provider.setChecked(row, m.on);
      return;
    }
    if (m.type === 'showCallers') {
      if (m.id === shown.id) await vscode.commands.executeCommand('impactTree.showCallers', m.id);
      return;
    }
    if (row.type !== 'finding') return;
    const caller = listCallerRows(provider.impactRowsOf(row))[m.index];
    if (caller) await vscode.commands.executeCommand('impactTree.openCaller', caller);
  }

  const disposeView = () => {
    for (const s of viewSubscriptions) s.dispose();
    viewSubscriptions = []; webviewView = null; renderToken = null; lastReview = null; renderedVersion = undefined;
  };
  const webviewProvider = {
    /** @param {any} resolved */
    resolveWebviewView(resolved) {
      disposeView();
      webviewView = resolved;
      resolved.webview.options = { enableScripts: true, localResourceRoots: [] };
      viewSubscriptions = [
        resolved.webview.onDidReceiveMessage((/** @type {unknown} */ m) => onMessage(m)
          .catch((/** @type {any} */ err) => log(`details: ${err && err.message}`))),
        resolved.onDidDispose(() => { if (webviewView === resolved) disposeView(); }),
        // A page shown again is rebuilt from the last document, which may hold an older header.
        resolved.onDidChangeVisibility(() => { if (resolved.visible) render(); }),
      ];
      render();
    },
  };

  return {
    disposables: [
      vscode.window.registerWebviewViewProvider('impactTree.details', webviewProvider),
      vscode.commands.registerCommand('impactTree.showChange', showChange),
      view.onDidChangeSelection(onSelection),
      view.onDidChangeVisibility(onTreeVisible),
      provider.onDidChangePresentation((/** @type {{ reason: string }} */ event) => { if (event.reason !== 'filter') render(); }),
      provider.onDidChangeReview(onProgress),
      vscode.window.onDidChangeTextEditorSelection(onCursor),
      { dispose: disposeView },
    ],
  };
}

module.exports = { createDetailPanel, headRelPath };
