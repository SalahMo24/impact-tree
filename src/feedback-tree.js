// @ts-check
'use strict';
// The "Feedback to send" group at the top of the Changes view and the status bar's count of
// feedback drafts (docs/UX_PLAN.md F1). `buildFeedbackGroup` and `feedbackStatusText` are
// pure; `renderFeedbackItem` turns a row into a TreeItem with the `vscode` module it is
// handed, as tree-item-renderer does for the other rows.

/** @typedef {import('./feedback-drafts').FeedbackItem} FeedbackItem */
/**
 * @typedef {{ type: 'feedbackDraft', label: string, desc: string, tooltip: string, draftId: string,
 *   file: string, line: number|null }} FeedbackDraftRow One draft: `file:line`, or
 *   `file · symbol` / `file` for a draft about a whole change or file; the body's first line
 *   is its description.
 * @typedef {{ label: string, desc: string, count: number, children: FeedbackDraftRow[] }} FeedbackGroup
 */

const GROUP_LABEL = 'Feedback to send';
/** The description's first line is cut to this many characters, ending in "…". */
const FIRST_LINE_MAX = 80;

/** @param {number} n */
const draftsText = (n) => `${n} draft${n === 1 ? '' : 's'}`;

/** @param {string} body @returns {string} The first non-blank line, cut to FIRST_LINE_MAX. */
function firstLineOf(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') || '';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

/**
 * Where a draft is, as its row names it.
 * @param {FeedbackItem} item
 * @returns {string}
 */
function placeOf(item) {
  const where = item.line !== null ? `${item.file}:${item.line}` : item.symbol ? `${item.file} · ${item.symbol}` : item.file;
  return item.caller ? `${where} · about caller ${item.caller.label}` : where;
}

/**
 * The tooltip of a draft: where it is, what it is about, the code quoted and the text.
 * Markdown; the quote and body are fenced or quoted so they are shown, not interpreted.
 * @param {FeedbackItem} item
 * @returns {string}
 */
function tooltipOf(item) {
  const lines = [`**Feedback draft** — not sent yet`, '', `\`${item.file}\`${item.line !== null ? ` line ${item.line}` : ' (whole file or change)'}`];
  if (item.symbol) lines.push(`In \`${item.symbol}\``);
  if (item.caller) lines.push(`About caller \`${item.caller.label}\` at \`${item.caller.file}:${item.caller.line}\``);
  if (item.quote) {
    const fence = item.quote.includes('```') ? '~~~~' : '```';
    lines.push('', fence, item.quote, fence);
  }
  lines.push('', ...item.body.split(/\r?\n/).map((l) => `> ${l}`));
  return lines.join('\n');
}

/**
 * The group for the drafts, or null when there are none (the group is then hidden).
 * Children are in the order the drafts were made (`createdAtMs`, then id), so a new draft
 * goes last and the others keep their place.
 * @param {readonly FeedbackItem[]} items
 * @returns {FeedbackGroup|null}
 */
function buildFeedbackGroup(items) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    label: GROUP_LABEL, desc: draftsText(items.length), count: items.length,
    children: sorted.map((item) => ({
      type: 'feedbackDraft', label: placeOf(item), desc: firstLineOf(item.body), tooltip: tooltipOf(item),
      draftId: item.id, file: item.file, line: item.line,
    })),
  };
}

/**
 * The status bar text for a count of drafts: null for none (the item is hidden).
 * @param {number} count
 * @returns {string|null}
 */
const feedbackStatusText = (count) => (count > 0 ? `💬 ${count} feedback draft${count === 1 ? '' : 's'}` : null);

/**
 * A TreeItem for the group row or a draft row.
 * @param {any} vscode
 * @param {{ type: string, label: string, desc?: string, tooltip?: string, draftId?: string }} row
 * @returns {any}
 */
function renderFeedbackItem(vscode, row) {
  if (row.type === 'feedbackGroup') {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.Expanded);
    item.description = row.desc;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.tooltip = `${row.desc} of feedback for the agent, not sent yet. Click one to open its line.`;
    item.contextValue = 'feedbackGroup';
    return item;
  }
  const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
  item.description = row.desc;
  item.iconPath = new vscode.ThemeIcon('comment-draft');
  const tip = new vscode.MarkdownString(row.tooltip || '');
  // The body is the reviewer's own text, but it is still shown, never run.
  tip.isTrusted = false;
  tip.supportHtml = false;
  item.tooltip = tip;
  item.contextValue = 'feedbackDraft';
  item.command = { command: 'impactTree.feedback.open', title: 'Open feedback draft', arguments: [row] };
  return item;
}

/**
 * The "Feedback round N" group: what happened to each item of the round whose snapshot is
 * the checkpoint (docs/UX_PLAN.md F4). Built from `roundRows`; null when there is no round.
 * @param {import('./feedback-round-view').RoundView|null} view
 * @returns {{ label: string, desc: string, relPath: string, children: Array<{ type: 'feedbackRoundItem', label: string,
 *   desc: string, tooltip: string, attention: boolean, itemId: string, file: string, line: number|null,
 *   symbol: string|null, summary: string }> }|null}
 */
function buildRoundGroup(view) {
  if (!view) return null;
  return {
    label: view.label, desc: view.description, relPath: view.relPath,
    children: view.items.map((i) => ({
      type: 'feedbackRoundItem', label: i.label, desc: i.description, tooltip: i.tooltip, attention: i.attention,
      itemId: i.id, file: i.item.file, line: i.item.line, symbol: i.item.symbol, summary: i.item.summary,
    })),
  };
}

/**
 * A TreeItem for the round group or one of its items. An item that needs attention has the
 * amber warning icon; one that does not has a plain check. Both say why in words.
 * @param {any} vscode
 * @param {{ type: string, label: string, desc?: string, tooltip?: string, attention?: boolean }} row
 * @returns {any}
 */
function renderRoundItem(vscode, row) {
  if (row.type === 'feedbackRound') {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.Expanded);
    item.description = row.desc;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.tooltip = 'What the agent wrote under each item, and whether the code near it changed since the feedback was sent.';
    item.contextValue = 'feedbackRound';
    return item;
  }
  const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
  item.description = row.desc;
  item.iconPath = row.attention
    ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
    : new vscode.ThemeIcon('check');
  item.tooltip = row.tooltip;
  item.contextValue = 'feedbackRoundItem';
  item.command = { command: 'impactTree.feedback.openRoundItem', title: 'Open', arguments: [row] };
  return item;
}

/** The command the status bar item runs: shows the "Feedback to send" group. */
const SHOW_DRAFTS_COMMAND = 'impactTree.feedback.showDrafts';

/**
 * The status bar item counting the drafts, next to the review's own (priority 50). Hidden
 * with none; clicking it shows the "Feedback to send" group.
 * Ownership: the caller disposes the returned item's `dispose`, which disposes the item.
 * @param {any} vscode
 * @returns {{ update: (count: number) => void, dispose: () => void }} Call `update` with the
 *   number of drafts whenever it may have changed.
 */
function createFeedbackStatus(vscode) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  bar.name = 'Impact Tree feedback drafts';
  bar.command = SHOW_DRAFTS_COMMAND;
  bar.tooltip = 'Feedback for the agent, not sent yet. Click to show the drafts.';
  return {
    update(count) {
      const text = feedbackStatusText(count);
      if (text === null) { bar.hide(); return; }
      if (bar.text !== text) bar.text = text;
      bar.show();
    },
    dispose: () => bar.dispose(),
  };
}

module.exports = {
  buildFeedbackGroup, buildRoundGroup, renderRoundItem, feedbackStatusText, renderFeedbackItem, createFeedbackStatus, GROUP_LABEL, FIRST_LINE_MAX, SHOW_DRAFTS_COMMAND,
};
