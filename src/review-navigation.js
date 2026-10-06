// @ts-check
'use strict';
const { treeItemId } = require('./review-tree-model');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */

// Walking a review without the mouse: the two filter toggles, "next unreviewed", and the
// status bar item that shows how much is left. The state lives in the provider (the filter,
// the ticks); this module only connects it to commands, context keys and the status bar.

/**
 * The key that runs "next unreviewed", as the status bar names it.
 * @param {string} platform A `process.platform` value.
 * @returns {string}
 */
const nextKeyHint = (platform) => (platform === 'darwin' ? '⌥N' : 'Alt+N');

/**
 * The status bar text of a shown review: what is left, what needs attention, how to go on.
 * @param {{ left: number, attention: number }} counts
 * @param {string} platform
 * @returns {string}
 */
const statusBarText = ({ left, attention }, platform) => `$(checklist) ${left} left · ⛔ ${attention} · ${nextKeyHint(platform)} next`;

/**
 * What "nothing is left" means under a filter, since "all reviewed" would be untrue when
 * the filter hides rows that are not.
 * @param {import('./review-tree-model').ReviewFilter} filter
 * @returns {string}
 */
const nothingLeftText = (filter) => (filter === 'attention' ? 'Impact Tree: nothing left needs attention' : 'Impact Tree: all reviewed');

/**
 * Registers the review commands and the status bar item.
 * @param {any} vscode
 * @param {{
 *   provider: ReturnType<typeof import('./tree-provider').createTreeProvider>,
 *   view: { selection: readonly TreeRow[], reveal: (row: TreeRow, options: object) => PromiseLike<void> },
 *   platform?: string,
 * }} deps `view` is the change view the provider feeds.
 * @returns {{ disposables: Array<{ dispose(): any }>, update: () => void }} `update` shows the
 *   provider's current state in the status bar and the context keys; call it whenever the
 *   view repaints.
 */
function createReviewNavigation(vscode, { provider, view, platform = process.platform }) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.name = 'Impact Tree review progress';
  bar.command = 'impactTree.nextUnreviewed';
  bar.tooltip = 'Go to the next unreviewed change (rebind it in Keyboard Shortcuts)';

  // A context key is sent only when its value changes.
  /** @type {Map<string, unknown>} */
  const sent = new Map();
  /** @param {string} key @param {unknown} value */
  const setContext = (key, value) => {
    if (sent.has(key) && sent.get(key) === value) return;
    sent.set(key, value);
    vscode.commands.executeCommand('setContext', key, value);
  };

  // The row the walk starts after: the selection when it is a counting row or a file row,
  // else the change a caller or tests row sits under, or the last row of a spacer's file.
  /** @returns {TreeRow|null} */
  const startOfWalk = () => {
    /** @type {TreeRow|undefined} */
    let row = view.selection[0];
    // A file's spacer stands for the end of the file it closes: the walk goes on after it.
    if (row && row.type === 'spacer') row = provider.changeRowsOf(row.relPath).at(-1) || provider.getParent(row);
    while (row && treeItemId(row) === undefined) row = provider.getParent(row);
    return row || null;
  };
  const nextUnreviewed = async () => {
    if (!provider.reviewCounts()) return;
    const row = provider.nextUnreviewed(startOfWalk());
    if (!row) { vscode.window.showInformationMessage(nothingLeftText(provider.getFilter())); return; }
    await view.reveal(row, { select: true, focus: true, expand: true });
  };

  /** @param {'attention'|'unreviewed'} name */
  const toggle = (name) => () => provider.toggleFilter(name);
  const on = (/** @type {string} */ id, /** @type {() => any} */ fn) => vscode.commands.registerCommand(id, fn);
  return {
    disposables: [
      bar,
      // Each filter is two commands, one per state of its title icon: a command contribution
      // cannot show on/off by itself, so package.json shows the one that matches the filter.
      on('impactTree.filterAttention', toggle('attention')), on('impactTree.filterAttentionOn', toggle('attention')),
      on('impactTree.filterUnreviewed', toggle('unreviewed')), on('impactTree.filterUnreviewedOn', toggle('unreviewed')),
      on('impactTree.nextUnreviewed', nextUnreviewed),
    ],
    update() {
      const counts = provider.reviewCounts();
      setContext('impactTree.filter', provider.getFilter());
      setContext('impactTree.hasReview', counts !== null);
      if (counts) {
        const text = statusBarText(counts, platform);
        if (bar.text !== text) bar.text = text;
        bar.show();
      } else bar.hide();
    },
  };
}

module.exports = { createReviewNavigation, nextKeyHint, statusBarText };
