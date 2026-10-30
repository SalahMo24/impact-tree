// @ts-check
'use strict';

// The Review view as one tree: where to review from (Local changes and its modes, the open
// pull requests) with the review itself nested under the row it came from, as the GitHub
// Pull Requests extension nests a pull request's files under it. The rows come from the two
// providers that build them (sources-provider.js, tree-provider.js); this module only joins
// them, so the change rows, their ids, ticks and parents are the review tree's own.
//
// The host is the row the shown review came from: the pull request being previewed or
// checked out, or the active mode under Local changes. It opens, carries the review's
// notices (warnings, files not analysed, a preview's limits) in its hover, and holds the review's controls
// (package.json, `viewItem == reviewHost`). The review's summary stays the view's message. A
// pull request missing from the list (not loaded, or not open) is shown as its own row
// above the groups. Other pull request rows have no hover.
//
// While a review is shown, the view's root is the review alone (docs/UX_PLAN.md L1, gate
// G13): one row, "Review something else…", and the host row, expanded; the Local changes
// and Pull requests groups are not drawn above it, so a change row sits two levels deep
// instead of eight. That row (or the host's menu entry) brings the groups back, with the
// host open inside them; the next review of a different source hides them again, while a
// refresh of the same review (callers retried, a new result) leaves the view as it is.

const { MODE_LABELS } = require('../changes/tree-row-models');

/** @typedef {import('../changes/tree-row-models').TreeRow} TreeRow */
/** @typedef {{ kind: 'pr', number: number, title?: string } | { kind: 'local', mode: string }} Host */

/** The row above the review that draws the groups again (its command is registered by extension.js). */
const BACK_ROW = Object.freeze({ type: 'picker', label: 'Review something else…', icon: 'arrow-left',
  desc: 'pull requests and local changes', command: 'impactTree.showPicker' });

/** Whether a root row of the review tree is a notice that belongs in the host's hover. @param {TreeRow} row */
const isNotice = (row) => row.type === 'message' && (row.notice === 'warning' || row.notice === 'unanalysable' || row.notice === 'preview');

/**
 * @param {any} vscode
 * @param {{
 *   tree: any, getHost: () => Host|null, emptyRow?: () => TreeRow|null,
 * }} deps `tree`: the review's provider (tree-provider.js). `getHost`: where the shown
 *   review came from, or null when nothing is reviewed. `emptyRow`: what the host
 *   shows when the review has no rows (nothing changed, TypeScript not loaded), or null.
 */
function createReviewSidebar(vscode, { tree, getHost, emptyRow = () => null }) {
  const changed = new vscode.EventEmitter();
  /** @type {any} */
  let sources = null;
  /** Rows the sources provider made, by the row they sit under ('' for the root), kept until either side refreshes. */
  /** @type {Map<any, any[]>} */
  let cache = new Map();
  /** @type {WeakMap<any, any>} */
  let parentOf = new WeakMap();
  /** @type {WeakSet<any>} */
  let fromSources = new WeakSet();
  /** @type {any} */
  let host = null;
  /** The review tree's notices, read when the host's children are. @type {TreeRow[]} */
  let notices = [];
  /** Whether the groups are drawn above the review (after Review something else…); a new review clears it. */
  let pickerShown = false;
  /** What the last root read reviewed, so a new review hides the groups and a refresh of the same one does not. */
  let hostKey = '';

  const reset = () => { cache = new Map(); parentOf = new WeakMap(); fromSources = new WeakSet(); host = null; };

  /** Whether the root is the review alone: a host is shown and the groups were not asked for. */
  const scoped = () => host !== null && !pickerShown;
  /** @param {Host|null} h @returns {string} */
  const keyOf = (h) => (h ? (h.kind === 'pr' ? `pr:${h.number}` : `local:${h.mode}`) : '');

  /** Whether a sources row is the host. @param {any} n @param {Host|null} h */
  const isHost = (n, h) => !!h && ((h.kind === 'pr' && n.type === 'pr' && n.args && n.args[0] && n.args[0].number === h.number)
    || (h.kind === 'local' && n.type === 'mode' && n.args && n.args[0] === h.mode));

  /** The sources rows under `node` (null: the root), remembered, with the host found and its group opened. @param {any} node */
  async function sourceRows(node) {
    const key = node || '';
    if (cache.has(key)) return /** @type {any[]} */ (cache.get(key));
    const rows = sources ? await sources.getChildren(node || undefined) : [];
    for (const r of rows) { fromSources.add(r); if (node) parentOf.set(r, node); }
    cache.set(key, rows);
    return rows;
  }

  /** Finds the host among the sources rows (loading the groups that may hold it), or makes a row for it. */
  async function findHost() {
    const h = getHost();
    if (!h) return null;
    const roots = await sourceRows(null);
    /** @param {any[]} rows @returns {Promise<any>} */
    const search = async (rows) => {
      for (const r of rows) {
        if (isHost(r, h)) return r;
        if (r.type === 'group') {
          const found = await search(await sourceRows(r));
          if (found) { r.expanded = true; return found; }
        }
      }
      return null;
    };
    const found = await search(roots);
    if (found) return found;
    if (h.kind !== 'pr') return null;
    const row = { type: 'pr', synthetic: true, label: `#${h.number}  ${h.title || ''}`.trim(), icon: 'git-pull-request', args: [{ number: h.number }] };
    fromSources.add(row);
    roots.unshift(row);
    return row;
  }

  /** The review tree's rows for the host: its root rows without the notices, or the empty row. */
  async function reviewRows() {
    /** @type {TreeRow[]} */
    const rows = await tree.getChildren(undefined);
    notices = rows.filter(isNotice);
    const kept = rows.filter((r) => !isNotice(r));
    if (kept.length) return kept;
    const empty = emptyRow();
    return empty ? [empty] : [];
  }

  // Read afresh each time the root is read (a refresh of either side): the repository, the
  // pull request list and the reviewed row may all have changed.
  async function rootRows() {
    reset();
    const key = keyOf(getHost());
    if (key !== hostKey) { hostKey = key; pickerShown = false; }
    host = await findHost();
    const roots = await sourceRows(null);
    return scoped() ? [BACK_ROW, host] : roots;
  }

  /** @param {any} node */
  function getTreeItem(node) {
    if (node === BACK_ROW) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.description = node.desc;
      item.tooltip = 'Show the pull requests and the local modes again. The review stays open under its row.';
      item.command = { command: node.command, title: node.label };
      return item;
    }
    if (!fromSources.has(node)) return tree.getTreeItem(node);
    const item = sources.getTreeItem(node);
    if (node.type === 'pr') item.tooltip = '';     // no hover on pull request rows
    if (node !== host) return item;
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    item.contextValue = 'reviewHost';
    item.tooltip = notices.length ? notices.map((n) => `${n.label}${n.desc ? ` — ${n.desc}` : ''}`).join('\n') : '';
    // A preview says so on the host's row; its limits are in the hover above. Asked of the
    // tree, not read from the notices, which are only known once the host's children are.
    if (typeof tree.isPreview === 'function' && tree.isPreview()) item.description = [item.description, 'preview'].filter(Boolean).join('  ·  ');
    // Clicking it still offers the pull request's choices (preview, check out, open on
    // GitHub), so a preview can be followed by a checkout from the same row.
    return item;
  }

  return {
    /** The review's own provider, for code that reads the review rows directly. */
    reviewTree: tree,
    onDidChangeTreeData: changed.event,
    /** @param {any} provider The sources provider; its refreshes rebuild the source rows. @returns {{ dispose(): any }} */
    setSources(provider) {
      sources = provider;
      reset();
      changed.fire(undefined);
      return provider.onDidChangeTreeData(() => { reset(); changed.fire(undefined); });
    },
    /** Follows the review tree: a whole refresh may change the host; a row's refresh is that row's. @returns {{ dispose(): any }} */
    followTree() {
      return tree.onDidChangeTreeData((/** @type {any} */ row) => {
        if (row === undefined || row === null) { reset(); changed.fire(undefined); } else changed.fire(row);
      });
    },
    /** The host row, once the root is read (it is read now if it was not). @returns {Promise<any>} */
    async hostRow() { if (!cache.has('')) await rootRows(); return host; },
    /**
     * Draws the Local changes and Pull requests groups above the review again (Review
     * something else…), with the host open inside them. Nothing happens while they are
     * already drawn or no review is shown. The next review of another source hides them.
     */
    showPicker() {
      if (pickerShown || !cache.has('') || host === null) return;
      pickerShown = true;
      reset();
      changed.fire(undefined);
    },
    /** Whether the last root read drew the review alone (Review something else… and the host). */
    isScoped: () => scoped(),
    /** @param {any} [node] */
    async getChildren(node) {
      if (!node) return rootRows();
      if (node === BACK_ROW) return [];
      if (node === host) return reviewRows();
      if (fromSources.has(node)) return sourceRows(node);
      return tree.getChildren(node);
    },
    getTreeItem,
    /** @param {any} node */
    getParent(node) {
      if (node === BACK_ROW || (node === host && scoped())) return undefined;
      if (fromSources.has(node)) return parentOf.get(node);
      const up = tree.getParent(node);
      return up || host || undefined;
    },
    dispose() { changed.dispose(); },
  };
}

/**
 * What the reviewed row shows when the review has no rows of its own: the two states the
 * old Changes view said on its welcome screen.
 * @param {string} viewState From view-state.js. @param {any} state The session state.
 * @returns {TreeRow|null}
 */
function emptyReviewRow(viewState, state) {
  if (viewState === 'nothingChanged') {
    const r = state && state.result;
    const mode = r ? (MODE_LABELS[r.requestedMode || r.mode] || r.requestedMode || r.mode) : '';
    return { type: 'message', icon: 'info', label: `Nothing changed${mode ? ` in ${mode} mode` : ''}${r && r.base ? ` against ${r.base.ref}` : ''}`,
      desc: 'switch mode', command: 'impactTree.selectMode' };
  }
  if (viewState === 'noTypeScript') {
    return { type: 'message', icon: 'error', label: 'TypeScript could not be loaded: nothing was analysed',
      desc: 'install the dependencies, then refresh', command: 'impactTree.refresh',
      tooltip: 'Impact Tree could not load TypeScript for the changed files, so none of them was analysed. This is not a result of "no impact". Install the project\'s dependencies (for example npm install), then refresh.' };
  }
  return null;
}

module.exports = { createReviewSidebar, isNotice, emptyReviewRow };
