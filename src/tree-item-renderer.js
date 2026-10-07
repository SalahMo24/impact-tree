// @ts-check
'use strict';
// Turns one row model into a VS Code TreeItem. The renderer is handed the `vscode`
// module and the view settings, and reads nothing else: no session state, no review
// store, no decorations. The provider supplies review progress through `view`.
//
// Layout rule: a row's description is short and in a fixed order, so a column of rows
// scans. A file row says what needs attention, then its progress, then its last folder
// segment; a change row says where it is declared (only when that tells it apart from
// its siblings), then its verdict, then "no test". A sidebar truncates from the right, so
// the least important part comes last and the full path is in the tooltip. The review
// threads of a pull request add `💬 N` (unresolved) and `✎ N` (your pending comments):
// after the attention glyph on a file row, after the verdict on a change row.
const path = require('path');
const {
  CALL_STATE, classifyChangeVerdict, classifyDeletedVerdict, classifyWorstRowVerdict,
} = require('./tree-row-models');
const { needsAttention } = require('./review-tree-model');
const { describeThreadCounts } = require('./review-threads');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/**
 * What a row's rendering depends on besides the row.
 * - `rowDetail`: 'hover' keeps a change row to its name and one verdict glyph, with the
 *   verdict's words and the change kinds in the tooltip; 'inline' shows them on the row.
 * - `iconMode`: 'file' for the file-type glyph, 'symbol' for a symbol-kind icon on change rows;
 *   file rows always show the file-type glyph.
 * - `checkedOf(row)`: whether the row's review checkbox is ticked, or null for no checkbox.
 * - `threadCountsOf(row)`: the row's review thread counts, or null when none are known
 *   (no pull request review, or its threads are not loaded): then nothing is shown.
 * - `viewedOf(relPath, allTicked)`: where a file stands with GitHub's "viewed" mark, see
 *   `ViewedNote`; absent for a view that has no GitHub review.
 * @typedef {{
 *   rowDetail: string, iconMode: string, checkedOf: (row: TreeRow) => boolean|null,
 *   threadCountsOf?: (row: TreeRow) => import('./review-threads').ThreadCounts|null,
 *   viewedOf?: (relPath: string, allTicked: boolean) => ViewedNote|null,
 * }} TreeView
 */

/**
 * The thread counts a row's description shows (`💬 N`, `✎ N`), none when unknown.
 * @param {TreeRow} row
 * @param {TreeView} view
 * @returns {string[]}
 */
const threadParts = (row, view) => describeThreadCounts(view.threadCountsOf ? view.threadCountsOf(row) : null);

/**
 * What a file row says about GitHub's "viewed" mark; nothing when in sync.
 * - `changed`: GitHub dropped its mark because the file changed after it, and some rows are unticked.
 * - `syncing`: a write is queued or in flight.
 * - `failed`: the last write failed; the row offers Retry.
 * @typedef {'changed'|'syncing'|'failed'} ViewedNote
 */

const VIEWED_TEXT = Object.freeze({ changed: '👁 changed', syncing: '👁 …', failed: 'viewed not synced' });
const VIEWED_TOOLTIP = Object.freeze({
  changed: 'GitHub no longer shows this file as viewed because it changed after you viewed it. Tick the remaining rows to mark it viewed again.',
  syncing: 'Updating the viewed mark on GitHub.',
  failed: 'The viewed mark could not be written to GitHub. Your ticks are kept; use Retry to send it again.',
});

/**
 * The viewed note of a file row, its description part and tooltip line.
 * @param {TreeView} view
 * @param {string} relPath
 * @param {boolean} allTicked
 * @returns {{ note: ViewedNote, text: string, tooltip: string }|null}
 */
function viewedNote(view, relPath, allTicked) {
  const note = view.viewedOf ? view.viewedOf(relPath, allTicked) : null;
  return note ? { note, text: VIEWED_TEXT[note], tooltip: VIEWED_TOOLTIP[note] } : null;
}

/**
 * @param {string} label
 * @param {any} sym The changed symbol, or null for a caller.
 * @returns {string} A codicon id.
 */
function symbolIcon(label, sym) {
  if (sym && sym.isConstructor) return 'symbol-constructor';
  if (sym && sym.valueLike) return 'symbol-variable';
  if (sym && sym.className) return 'symbol-method';
  return String(label || '').includes('.') ? 'symbol-method' : 'symbol-function';
}

/**
 * Helpers bound to one render: the view's detail and icon modes.
 * @param {any} vscode
 * @param {TreeView} view
 */
function renderHelpers(vscode, view) {
  return {
    // 'hover' keeps the single state glyph in the row so the column is still scannable;
    // `words` is what a row that needs doing shows in its place.
    rowDesc: (/** @type {string} */ token, /** @type {string} */ full, /** @type {string} */ words = token) => (
      view.rowDetail === 'inline' ? full : words),
    // VS Code infers a folder glyph for any expandable row with a resourceUri;
    // ThemeIcon.File overrides that and resolves the row against the file-icon theme.
    rowIcon: (/** @type {string} */ label, /** @type {any} */ sym) => (view.iconMode === 'symbol'
      ? new vscode.ThemeIcon(symbolIcon(label, sym))
      : vscode.ThemeIcon.File),
  };
}

/**
 * Sets the review checkbox when the view gives the row one.
 * @param {any} vscode
 * @param {any} item
 * @param {TreeRow} row
 * @param {TreeView} view
 */
function applyCheckbox(vscode, item, row, view) {
  const checked = view.checkedOf(row);
  if (checked === null) return;
  item.checkboxState = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
}

/**
 * The description of a change or deleted row: where it is declared, its verdict as
 * `impactTree.rowDetail` asks, and what the test walk established. In either detail mode
 * a walk that found no test reads "no test", and one that did not finish "tests ?", so
 * a lack of evidence never looks like a covered change; the reason is in the tooltip.
 * @param {string|null|undefined} container
 * @param {string} verdict The glyph, or the glyph and words.
 * @param {TreeRow|null} change A change row, for its `scopeNote` and `reachReason`; null for a deleted row.
 * @param {string[]} [threads] The row's thread counts, shown right after the verdict.
 * @returns {string}
 */
const describeChangeRow = (container, verdict, change, threads = []) => [
  container ? `in ${container}` : null, verdict, ...threads,
  change && change.scopeNote ? 'no test' : null, change && change.reachReason ? 'tests ?' : null,
].filter(Boolean).join('  ·  ');

/**
 * The name of the symbol a change or deleted row is declared in, when it tells the row
 * apart: its file has changes in more than one container, or its name is shared.
 * @param {TreeRow} n
 * @returns {string|null}
 */
const containerToShow = (n) => (n.showContainer || n.ambiguous ? n.container ?? null : null);

/**
 * The last segment of a file's folder, or null at the repo root.
 * @param {string} relPath
 * @returns {string|null}
 */
function lastFolder(relPath) {
  const folder = path.basename(path.dirname(relPath));
  return folder === '.' || folder === '' ? null : folder;
}

/**
 * A changed file with a call graph. Its checkbox is ticked when all its rows are; its
 * description counts the rows that still need attention and how many are done.
 * @param {any} vscode
 * @param {TreeRow} n A `reviewFile` row.
 * @param {TreeView} view
 */
function renderReviewFileItem(vscode, n, view) {
  const open = n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
  const item = n.decorationUri ? new vscode.TreeItem(n.decorationUri, open) : new vscode.TreeItem(n.label, open);
  item.label = n.label;
  item.iconPath = vscode.ThemeIcon.File;
  /** @type {TreeRow[]} */
  const rows = n.rows;
  const left = rows.filter((r) => !view.checkedOf(r));
  const attention = left.filter(needsAttention);
  const viewed = viewedNote(view, n.relPath, left.length === 0);
  item.description = [
    attention.length ? `${classifyWorstRowVerdict(attention).token} ${attention.length}` : null,
    ...threadParts(n, view),
    `${rows.length - left.length}/${rows.length}`,
    viewed && viewed.text,
    lastFolder(n.relPath),
  ].filter(Boolean).join('  ·  ');
  item.tooltip = new vscode.MarkdownString([
    `**${n.relPath}**`, ...(n.status ? ['', `_${n.status}_`] : []), '',
    `${rows.length} change${rows.length === 1 ? '' : 's'}, ${attention.length} need${attention.length === 1 ? 's' : ''} attention, ${left.length} left to review`,
    ...(viewed ? ['', `_${viewed.tooltip}_`] : []),
  ].join('\n'));
  // The failed note makes Retry available through the context value (package.json `when`).
  item.contextValue = viewed && viewed.note === 'failed' ? 'reviewFileViewedFailed' : 'reviewFile';
  applyCheckbox(vscode, item, n, view);
  item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
  return item;
}

/**
 * A changed file without a call graph: its own counting row.
 * @param {any} vscode
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderFileItem(vscode, n, view) {
  const uri = n.decorationUri || (n.absPath ? vscode.Uri.file(n.absPath) : null);
  const item = uri
    ? new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None)
    : new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
  // A file:// row takes its icon from the resource URI. A Tier A row is not a file://
  // URI (so git cannot badge it); ThemeIcon.File still resolves the extension against
  // the icon theme.
  if (uri && uri.scheme && uri.scheme !== 'file') {
    item.label = n.label || path.basename(n.relPath);
    item.iconPath = vscode.ThemeIcon.File;
  }
  const viewed = viewedNote(view, n.relPath, view.checkedOf(n) === true);
  item.description = [...threadParts(n, view), 'no call graph', viewed && viewed.text, lastFolder(n.relPath)].filter(Boolean).join('  ·  ');
  item.tooltip = new vscode.MarkdownString([
    `**${path.basename(n.relPath)}**`, '', `_${n.status}_`, '', `\`${n.relPath}\``, '',
    '_No call graph (tests, config, docs): read the diff and tick the file._',
    ...(viewed ? ['', `_${viewed.tooltip}_`] : []),
  ].join('\n'));
  if (viewed && viewed.note === 'failed') item.contextValue = 'fileViewedFailed';
  applyCheckbox(vscode, item, n, view);
  item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
  return item;
}

/**
 * Rows whose rendering needs no verdict of a changed symbol: messages, deleted symbols and
 * the changed lines outside functions. Returns null for any other row type.
 * @param {any} vscode
 * @param {any} item The row's item, already constructed.
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderPlainItem(vscode, item, n, view) {
  switch (n.type) {
    case 'message':
      item.description = n.desc;
      item.iconPath = new vscode.ThemeIcon(n.icon || 'info');
      item.tooltip = n.tooltip || n.label;
      if (n.command) item.command = { command: n.command, title: n.label };
      return item;
    case 'deleted': {
      const st = classifyDeletedVerdict();
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      // VS Code cannot strike a tree label through, so the icon says it is gone.
      item.label = n.name;
      const words = `${st.token}  ${st.text}`;
      item.description = describeChangeRow(containerToShow(n), renderHelpers(vscode, view).rowDesc(st.token, words, needsAttention(n) ? words : st.token), null);
      item.iconPath = new vscode.ThemeIcon('trash');  // semantics beat decoration here
      item.tooltip = new vscode.MarkdownString([`✕ **${n.label}**`, '', st.sentence, '', `\`${n.relPath}\``].join('\n'));
      item.contextValue = 'deleted';
      applyCheckbox(vscode, item, n, view);
      item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
      return item;
    }
    case 'outside':
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      // The file row it sits under names the file.
      item.description = [n.desc, ...threadParts(n, view)].filter(Boolean).join('  ·  ');
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      item.tooltip = new vscode.MarkdownString([
        `**Outside functions** — \`${n.relPath}\``, '', n.desc, '',
        '_Changed lines in no function: imports, constants, types, fields and the like._',
      ].join('\n'));
      item.contextValue = 'outside';
      applyCheckbox(vscode, item, n, view);
      item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
      return item;
    default:
      return null;
  }
}

/**
 * The tooltip lines of a change row. In hover mode the row is bare, so the tooltip must
 * carry the whole story.
 * @param {TreeRow} n
 * @param {import('./tree-row-models').Verdict} st
 * @param {string[]} kinds Short names of the non-body change kinds.
 * @returns {string[]}
 */
function buildChangeTooltipLines(n, st, kinds) {
  const f = n.finding;
  return [
    `${st.token} **${f.label}**`,
    '',
    st.sentence,
    ...(n.reachReason ? ['', `_test reachability unknown: ${n.reachReason}_`] : []),
    ...(n.scopeNote ? ['', `_${n.scopeNote}_`] : []),
    ...(f.callersComplete === false && f.callersIncompleteReason ? ['', `_caller search incomplete: ${f.callersIncompleteReason}_`] : []),
    ...(kinds.length ? ['', `**${kinds.join(', ')}**`] : []),
    '',
    `\`${f.relPath}:${f.startLine}\`  ·  component \`${f.component}\``,
    ...(f.baseSig && f.baseSig !== f.headSig
      ? ['', '---', '', `base: \`${f.baseSig}\``, '', `head: \`${f.headSig}\``] : []),
    ...(f.throwsAdded.length ? ['', '---', '', ...f.throwsAdded.map((/** @type {string} */ t) => `+ throw \`${t}\``)] : []),
    ...(f.stale && f.stale.length
      ? ['', '---', '', `**${f.staleCallers} call site(s) not updated:**`,
        ...f.stale.slice(0, 10).map((/** @type {{ label: string }} */ x) => `- ${x.label}`),
        ...(f.stale.length > 10 ? [`- …and ${f.stale.length - 10} more`] : []),
        ...(f.staleChangedElsewhere
          ? ['', `${f.staleChangedElsewhere} of them were edited — just not on the call line`] : [])]
      : []),
    '', `_score ${f.score}_`,
  ];
}

/**
 * A changed symbol, named by its own name; the symbol it is declared in is in the
 * description.
 * @param {any} vscode
 * @param {any} item The row's item, already constructed.
 * @param {TreeRow} n A change row from `buildFileRows`.
 * @param {TreeView} view
 */
function renderChangeItem(vscode, item, n, view) {
  const { rowDesc, rowIcon } = renderHelpers(vscode, view);
  const f = n.finding;
  const st = classifyChangeVerdict(f);
  const kinds = f.kinds.filter((/** @type {any} */ k) => k.id !== 'body').map((/** @type {any} */ k) => k.short || k.label);
  const qual = n.ambiguous ? `  ·  ${f.component}` : '';
  item.label = n.ambiguous ? `${n.name}  ‹${f.component}›` : n.name;
  item.description = describeChangeRow(containerToShow(n),
    rowDesc(st.token, `${st.token}  ${st.text}${qual}${kinds.length ? '  ·  ' + kinds.join(', ') : ''}`,
      needsAttention(n) ? `${st.token}  ${st.text}` : st.token),
    n, threadParts(n, view));
  item.iconPath = rowIcon(f.label, f);
  item.tooltip = new vscode.MarkdownString(buildChangeTooltipLines(n, st, kinds).join('\n'));
  item.contextValue = 'finding';
  applyCheckbox(vscode, item, n, view);
  item.command = { command: 'impactTree.openChange', title: 'Open change', arguments: [n] };
  return item;
}

/**
 * A file grouping several callers of one change. Callers are the impact of a change, not
 * something to review, so the row has no checkbox.
 * @param {any} vscode
 * @param {any} item The row's item, already constructed.
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderCallerFileItem(vscode, item, n, view) {
  const { rowDesc } = renderHelpers(vscode, view);
  const cs = CALL_STATE[n.callState] || CALL_STATE.unchanged;
  const tok = n.test ? '🧪' : cs.token;
  const fns = n.callers.length;
  item.description = rowDesc(tok,
    `${tok}  ${fns} caller${fns === 1 ? '' : 's'}  ·  ${n.sites} call site${n.sites === 1 ? '' : 's'}`);
  item.iconPath = vscode.ThemeIcon.File;  // a file, whatever iconMode says
  item.tooltip = new vscode.MarkdownString([
    `**${n.relPath}**`, '',
    `${fns} function${fns === 1 ? '' : 's'} in this file call the change, across ${n.sites} call site${n.sites === 1 ? '' : 's'}:`,
    '', ...n.callers.slice(0, 12).map((/** @type {TreeRow} */ c) => `- ${(CALL_STATE[c.callState] || CALL_STATE.unchanged).token} ${c.label}`),
    ...(n.callers.length > 12 ? [`- …and ${n.callers.length - 12} more`] : []),
  ].join('\n'));
  item.contextValue = 'callerFile';
  item.command = { command: 'impactTree.openFile', title: 'Open file', arguments: [n] };
  return item;
}

/**
 * One caller of a change, or of a caller further up. It has no checkbox.
 * @param {any} vscode
 * @param {any} item The row's item, already constructed.
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderCallerItem(vscode, item, n, view) {
  const { rowDesc, rowIcon } = renderHelpers(vscode, view);
  const cs = CALL_STATE[n.callState] || CALL_STATE.unchanged;
  const base = path.basename(n.relPath || n.file);
  const tok = n.cycle ? '↑' : n.test ? '🧪' : cs.token;
  // Some calls were edited and others not: the row cannot read as handled, and the count says why.
  const { updated, untouched, unknown } = n.callSiteUpdates;
  const notUpdated = untouched.length + unknown.length;
  const partlyUpdated = updated.length > 0 && notUpdated > 0;
  item.description = n.cycle ? rowDesc('↑', '↑  already shown above')
    : rowDesc(tok, `${tok}  ${cs.text}  ·  ${base}${n.sites > 1 ? `  ·  ${n.sites} call sites` : ''}`);
  item.iconPath = n.cycle ? new vscode.ThemeIcon('issue-reopened')
    : n.test ? new vscode.ThemeIcon('beaker')
      : rowIcon(n.label, null);
  item.tooltip = new vscode.MarkdownString([
    `${tok} **${n.label}**`,
    '',
    n.cycle ? '_already shown higher up in this tree_' : n.test ? '🧪 test' : `**${cs.text}**`,
    '',
    `\`${n.relPath || n.file}\``,
    ...(n.sites ? ['', `${n.sites} call site${n.sites === 1 ? '' : 's'} to the changed symbol`] : []),
    ...(partlyUpdated ? ['', `${updated.length} of ${updated.length + notUpdated} call sites updated`] : []),
    ...(n.callState === 'changed-elsewhere'
      ? ['', '---', '', 'This caller **was** edited in this change, but not on the line that calls the changed symbol — it may still need updating.']
      : []),
  ].join('\n'));
  item.contextValue = n.changed ? 'changedCaller' : 'caller';
  item.command = { command: 'impactTree.openCaller', title: 'Open caller', arguments: [n] };
  return item;
}

/**
 * The gap that closes an open file group: nothing to read, tick or open.
 * @param {any} vscode
 * @returns {any}
 */
function renderSpacerItem(vscode) {
  const item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
  item.contextValue = 'spacer';
  return item;
}

/**
 * Renders one row as a TreeItem. Every expandable row starts collapsed, except a file row
 * the provider marks `expanded`.
 * @param {any} vscode The vscode module (or a stand-in with the same constructors).
 * @param {TreeRow} n A row model.
 * @param {TreeView} view
 * @returns {any} A new vscode.TreeItem.
 */
function renderTreeItem(vscode, n, view) {
  if (n.type === 'reviewFile') return renderReviewFileItem(vscode, n, view);
  if (n.type === 'file') return renderFileItem(vscode, n, view);
  if (n.type === 'spacer') return renderSpacerItem(vscode);
  const collapsible = n.type === 'message' || n.cycle
    ? vscode.TreeItemCollapsibleState.None
    : vscode.TreeItemCollapsibleState.Collapsed;
  // Construct from the Uri so the file-icon theme applies, then override the label:
  // assigning resourceUri afterwards onto a string-labelled item does not pick up the
  // theme. The fragment makes each symbol row a distinct decoration target.
  const uri = n.decorationUri;
  const item = uri ? new vscode.TreeItem(uri, collapsible) : new vscode.TreeItem(n.label, collapsible);
  if (uri) item.label = n.label;
  const plain = renderPlainItem(vscode, item, n, view);
  if (plain) return plain;
  if (n.type === 'finding') return renderChangeItem(vscode, item, n, view);
  if (n.type === 'callerFile') return renderCallerFileItem(vscode, item, n, view);
  return renderCallerItem(vscode, item, n, view);
}

module.exports = { renderTreeItem };
