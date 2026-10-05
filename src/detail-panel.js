// @ts-check
'use strict';
const path = require('path');
const crypto = require('crypto');
const { treeItemId } = require('./review-tree-model');
const { prKey, parsePrAddress } = require('./pr-documents');
const { buildDetailHtml, listCallerRows } = require('./detail-panel-html');

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
 * A message from the webview, checked: anything else it could send is dropped.
 * @param {unknown} message
 * @returns {{ type: 'tick', on: boolean }|{ type: 'next' }|{ type: 'openCaller', index: number }|null}
 */
function parseMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  if (m.type === 'tick' && typeof m.on === 'boolean') return { type: 'tick', on: m.on };
  if (m.type === 'next') return { type: 'next' };
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
 * Feedback loop: revealing the cursor's row selects it in the tree, and VS Code reports
 * that as a selection change. The id revealed is remembered, and a selection of exactly
 * that row keeps the cursor origin. Any other selection forgets it.
 * @param {any} vscode
 * @param {{
 *   provider: ReturnType<typeof import('./tree-provider').createTreeProvider>,
 *   view: { selection: readonly TreeRow[], reveal: (row: TreeRow, options: object) => PromiseLike<void>,
 *     onDidChangeSelection: (listener: (e: { selection: readonly TreeRow[] }) => void) => { dispose(): any } },
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
    webviewView.webview.html = buildDetailHtml(row, {
      result: state && state.result, isReviewed: provider.isReviewed,
      impactRows: row && row.type === 'finding' ? provider.impactRowsOf(row) : [],
      nonce: crypto.randomBytes(16).toString('base64'), cspSource: webviewView.webview.cspSource, origin: shown.origin, lineOf,
    });
  }
  /** @param {string|null} id @param {string} origin */
  const show = (id, origin) => { shown = { id, origin }; render(); };

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
    if (id === shown.id && origin === shown.origin) return;
    const moved = id !== shown.id;
    show(id, origin);
    if (!moved) return;
    revealedFromCursor = id;
    // A row the filter hides cannot be revealed; the panel still shows it.
    Promise.resolve(view.reveal(row, { select: true, focus: false }))
      .then(undefined, (/** @type {any} */ err) => log(`details: could not reveal ${id}: ${err && err.message}`));
  }

  /** @param {unknown} message */
  async function onMessage(message) {
    const m = parseMessage(message);
    if (!m) return;
    if (m.type === 'next') { await vscode.commands.executeCommand('impactTree.nextUnreviewed'); return; }
    const row = currentRow();
    if (!row) return;
    if (m.type === 'tick') { provider.setChecked(row, m.on); provider.refresh(); return; }
    if (row.type !== 'finding') return;
    const caller = listCallerRows(provider.impactRowsOf(row))[m.index];
    if (caller) await vscode.commands.executeCommand('impactTree.openCaller', caller);
  }

  const disposeView = () => { for (const s of viewSubscriptions) s.dispose(); viewSubscriptions = []; webviewView = null; };
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
      ];
      render();
    },
  };

  return {
    disposables: [
      vscode.window.registerWebviewViewProvider('impactTree.details', webviewProvider),
      view.onDidChangeSelection(onSelection),
      provider.onDidChangeTreeData(render),
      vscode.window.onDidChangeTextEditorSelection(onCursor),
      { dispose: disposeView },
    ],
  };
}

module.exports = { createDetailPanel, headRelPath };
