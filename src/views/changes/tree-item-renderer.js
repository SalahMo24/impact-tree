// @ts-check
'use strict';
const { unsupportedLanguageOf } = require('../../languages/index');
// Turns one row model into a VS Code TreeItem. The renderer is handed the `vscode`
// module and the view settings, and reads nothing else: no session state, no review
// store, no decorations. The provider supplies review progress through `view`.
//
// Layout rule: a row's description is short and in a fixed order, so a column of rows
// scans. A file row says what needs attention, then its progress, then its last folder
// segment; a change row says where it is declared (only when that tells it apart from
// its siblings), then its state in words, then "no test". The state is also the icon's
// colour: red or amber, none when fine (see LEVEL_TONES). A sidebar truncates from the right, so
// the least important part comes last and the full path is in the tooltip, drawn as a
// folder tree (path-tree.js). The review
// threads of a pull request add `💬 N` (unresolved) and `✎ N` (your pending comments):
// after the attention count on a file row, after the state on a change row.
const path = require('path');
const {
  CALL_STATE, LEVEL_TONES, NOT_ANALYSED_DESC, notAnalysedText, attentionCountText, CHANGED_ELSEWHERE_TONE, toneOf, classifyChangeVerdict, classifyDeletedVerdict,
} = require('./tree-row-models');
const { needsAttention, collectCountingRows, NO_AGENT_ATTENTION } = require('./review-tree-model');
const { describeCard, describeOthers } = require('./card-order');
const { describeThreadCounts } = require('./review-threads');
const { pathTreeMarkdown } = require('./path-tree');
const { rowLine, tooltipLines } = require('../../agent/agent-notes');

/** Agent text in a markdown tooltip: every markdown character escaped, so it stays text. @param {string} s */
const mdText = (s) => String(s).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/**
 * What a row's rendering depends on besides the row.
 * - `rowDetail`: 'hover' keeps a change row to its name and its state in words, with the
 *   change kinds in the tooltip; 'inline' shows the kinds on the row too.
 * - `iconMode`: 'file' for the file-type glyph, 'symbol' for a symbol-kind icon on change rows;
 *   file rows always show the file-type glyph.
 * - `checkedOf(row)`: whether the row's review checkbox is ticked, or null for no checkbox.
 * - `threadCountsOf(row)`: the row's review thread counts, or null when none are known
 *   (no pull request review, or its threads are not loaded): then nothing is shown.
 * - `viewedOf(relPath, allTicked)`: where a file stands with GitHub's "viewed" mark, see
 *   `ViewedNote`; absent for a view that has no GitHub review.
 * - `layout`: 'tree' when file rows sit under folder rows, so a file row does not repeat
 *   its folder; 'flat' (the default) names the folder on the row.
 * - `order`: 'cards' in the By card order, where a change row is not under its file and so
 *   ends its description with the file's name; 'files' (the default) is the Files order.
 * - `agentOf(row)`: what the user's agent said a change row's change does, or null; shown
 *   after the engine's text and in the tooltip, with the agent's own icon for the kind.
 *   `agentHowOf(row)`: how the agent says a direct caller is affected, or null. Both absent
 *   while agents are off.
 * - `agentAttention`: the change ids the agent named in `attention`, which need attention
 *   beside the engine's own flags (one set for every count, gate G15).
 * - `cardTooltipOf(row)`: the hover lines of a card row (its facts), or an empty list.
 * @typedef {{
 *   rowDetail: string, iconMode: string, checkedOf: (row: TreeRow) => boolean|null,
 *   threadCountsOf?: (row: TreeRow) => import('./review-threads').ThreadCounts|null,
 *   viewedOf?: (relPath: string, allTicked: boolean) => ViewedNote|null,
 *   layout?: 'flat'|'tree', order?: 'files'|'cards', agentAttention?: import('./review-tree-model').AgentAttention,
 *   cardTooltipOf?: (row: TreeRow) => string[],
 *   agentOf?: (row: TreeRow) => import('../../agent/agent-notes').AgentChange|null,
 *   agentHowOf?: (row: TreeRow) => string|null,
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
 * What a file row says about GitHub's Viewed on GitHub mark; nothing when in sync.
 * - `changed`: GitHub dropped its mark because the file changed after it, and some rows are not reviewed.
 * - `syncing`: a write is queued or in flight.
 * - `failed`: the last write failed; the row offers Retry.
 * @typedef {'changed'|'syncing'|'failed'} ViewedNote
 */

/** What the top-level changes of a file are, for the hover of the row that holds them. */
const TOP_LEVEL_TOOLTIP = 'Top-level changes: changed lines in no function (imports, constants, types, fields and the like). Read the diff and mark the file reviewed.';

const VIEWED_TEXT = Object.freeze({ changed: '👁 changed', syncing: '👁 …', failed: 'Viewed on GitHub not synced' });
const VIEWED_TOOLTIP = Object.freeze({
  changed: 'This file changed after you marked it Viewed on GitHub, so GitHub cleared that mark. Mark the remaining rows reviewed to set it again.',
  syncing: 'Updating Viewed on GitHub.',
  failed: 'Viewed on GitHub could not be updated. Your reviewed marks are kept; use Retry to send it again.',
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
 * The folder a file row names at its end: its last folder in the flat layout, nothing in
 * the tree layout, where the folder row above it says so.
 * @param {TreeRow} row
 * @param {TreeView} view
 * @returns {string|null}
 */
const folderNote = (row, view) => (view.layout === 'tree' ? null : lastFolder(row.relPath));

/**
 * The file a row names at its end in the By card order, where the row is not under its
 * file; nothing in the Files order, where the file row above it says so.
 * @param {TreeRow} row A change, deleted or top-level row.
 * @param {TreeView} view
 * @returns {string|null}
 */
const basenameNote = (row, view) => (view.order === 'cards' ? path.basename(row.relPath ?? row.finding?.relPath ?? '') || null : null);

/** The icon of each kind the agent gives a change; none for "same behaviour, a new way". */
/** @type {Readonly<Record<string, string>>} */
const AGENT_KIND_ICON = Object.freeze({ changed: 'edit', 'may-change': 'question', new: 'add' });

/** @param {TreeView} view @returns {import('./review-tree-model').AgentAttention} */
const attentionOf = (view) => view.agentAttention || NO_AGENT_ATTENTION;

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
 * Helpers bound to one render: the view's icon mode.
 * @param {any} vscode
 * @param {TreeView} view
 */
function renderHelpers(vscode, view) {
  return {
    // The icon carries the colour; the words carry the state. In 'symbol' mode the
    // symbol-kind icon is kept and tinted. ThemeIcon.File cannot be tinted, so in 'file'
    // mode a red or amber row swaps it for an `error` / `warning` icon of that colour, and
    // a fine row keeps ThemeIcon.File (which also stops VS Code inferring a folder glyph
    // for an expandable row with a resourceUri).
    rowIcon: (/** @type {string} */ label, /** @type {any} */ sym, /** @type {import('./tree-row-models').IconTone|null} */ tone = null) => {
      const color = tone ? new vscode.ThemeColor(tone.color) : undefined;
      if (view.iconMode === 'symbol') return new vscode.ThemeIcon(symbolIcon(label, sym), color);
      return tone ? new vscode.ThemeIcon(tone.fileIcon, color) : vscode.ThemeIcon.File;
    },
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
 * The description of a change or deleted row: where it is declared, its state in words
 * (with the change kinds when `impactTree.rowDetail` is inline), and what the test walk
 * established. In either detail mode a walk that found no test reads "no test", and one
 * that did not finish "tests ?", so a lack of evidence never looks like a covered change;
 * the reason is in the tooltip.
 * @param {string|null|undefined} container
 * @param {string} verdict The state in words, plus what the detail mode adds.
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
  const attention = left.filter((r) => needsAttention(r, attentionOf(view)));
  const viewed = viewedNote(view, n.relPath, left.length === 0);
  item.description = [
    attention.length ? attentionCountText(attention.length) : null,
    ...threadParts(n, view),
    `${rows.length - left.length}/${rows.length}`,
    viewed && viewed.text,
    folderNote(n, view),
  ].filter(Boolean).join('  ·  ');
  item.tooltip = new vscode.MarkdownString([
    ...pathTreeMarkdown(n.relPath), ...(n.status ? ['', `_${n.status}_`] : []), '',
    `${rows.length} change${rows.length === 1 ? '' : 's'}, ${attentionCountText(attention.length)}, ${rows.length - left.length} marked reviewed`,
    ...(viewed ? ['', `_${viewed.tooltip}_`] : []),
  ].join('\n'));
  // The failed note makes Retry available through the context value (package.json `when`).
  item.contextValue = viewed && viewed.note === 'failed' ? 'reviewFileViewedFailed' : 'reviewFile';
  applyCheckbox(vscode, item, n, view);
  item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
  return item;
}

/**
 * A folder of the tree layout: a place to find files, not a finding. It has no checkbox
 * (the files under it keep theirs) and no resource, so neither a git badge nor a colour
 * reaches it. Its description is the count of rows under it that still need attention,
 * nothing when none; how many are done and how many files it holds are in the tooltip.
 * @param {any} vscode
 * @param {TreeRow} n A `folder` row.
 * @param {TreeView} view
 */
function renderFolderItem(vscode, n, view) {
  const open = n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
  const item = new vscode.TreeItem(n.label, open);
  item.iconPath = vscode.ThemeIcon.Folder;
  const rows = collectCountingRows(n.files);
  const left = rows.filter((r) => !view.checkedOf(r));
  const attention = left.filter((r) => needsAttention(r, attentionOf(view)));
  const files = `${n.fileCount} file${n.fileCount === 1 ? '' : 's'}`;
  // Only the attention count on the row, so a chain of nested folders stays readable as
  // a path; progress and size are in the tooltip.
  item.description = attention.length ? attentionCountText(attention.length) : '';
  item.tooltip = new vscode.MarkdownString([
    `**${n.relPath}/**`, '',
    `${files}, ${rows.length} change${rows.length === 1 ? '' : 's'}, ${attentionCountText(attention.length)}, ${rows.length - left.length} marked reviewed`,
  ].join('\n'));
  item.contextValue = 'folder';
  return item;
}

/**
 * A changed file without a call graph, or whose only change is its top-level lines: its
 * own counting row.
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
  const notAnalysed = n.notAnalysed || null;
  if (notAnalysed) {
    // Amber, like every "check by hand": nothing was established about this file.
    const tone = /** @type {import('./tree-row-models').IconTone} */ (LEVEL_TONES[1]);
    item.iconPath = new vscode.ThemeIcon(tone.fileIcon, new vscode.ThemeColor(tone.color));
  }
  // A file of a language no provider analyses yet (Kotlin, C#…) names it, so it does not
  // read like a docs or config file. It stays quiet: that is expected, not a failure.
  const unsupported = notAnalysed ? null : unsupportedLanguageOf(n.relPath);
  // A file with nothing to analyse says nothing here: its git badge and its folder are enough.
  // One whose only change is its top-level lines (`ranges`) names them, as its own row would.
  const kind = notAnalysed ? NOT_ANALYSED_DESC : unsupported ? `${unsupported}  ·  not analysed yet` : n.ranges ? n.desc : null;
  item.description = [...threadParts(n, view), kind, viewed && viewed.text, folderNote(n, view)].filter(Boolean).join('  ·  ');
  item.tooltip = new vscode.MarkdownString([
    ...pathTreeMarkdown(n.relPath), '', `_${n.status}_`, '',
    notAnalysed ? `_${notAnalysedText(notAnalysed)}. Read the diff by hand and mark the file reviewed._`
      : unsupported ? `_${unsupported} files are not analysed yet: read the diff and mark the file reviewed._`
        : n.ranges ? `_${TOP_LEVEL_TOOLTIP}_`
          : '_A file without analysed code: read the diff and mark it reviewed._',
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
      if (n.contextValue) item.contextValue = n.contextValue;
      return item;
    case 'deleted': {
      const st = classifyDeletedVerdict();
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      // VS Code cannot strike a tree label through, so the icon says it is gone.
      item.label = n.name;
      item.description = [describeChangeRow(containerToShow(n), st.text, null), basenameNote(n, view)].filter(Boolean).join('  ·  ');
      // Semantics beat decoration here: it keeps `trash` whatever iconMode says, in the
      // level's amber (an unsearched deleted symbol is never "fine").
      item.iconPath = new vscode.ThemeIcon('trash', new vscode.ThemeColor(/** @type {import('./tree-row-models').IconTone} */ (LEVEL_TONES[st.level]).color));
      item.tooltip = new vscode.MarkdownString([`**${n.label}**`, '', st.sentence, '', `\`${n.relPath}\``].join('\n'));
      item.contextValue = 'deleted';
      applyCheckbox(vscode, item, n, view);
      item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
      return item;
    }
    case 'outside':
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      // The file row it sits under names the file.
      item.description = [n.desc, ...threadParts(n, view), basenameNote(n, view)].filter(Boolean).join('  ·  ');
      // No icon of its own: the row is the last under its file, and its words say what it is.
      item.tooltip = new vscode.MarkdownString([
        `**Top-level changes** — \`${n.relPath}\``, '', n.desc, '',
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
    `**${f.label}**`,
    '',
    st.sentence,
    ...(n.reachReason ? ['', `_test reachability unknown: ${n.reachReason}_`] : []),
    ...(n.scopeNote ? ['', `_${n.scopeNote}_`] : []),
    ...(n.notSearched ? ['', `_${n.notSearched}_`] : []),
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
  const { rowIcon } = renderHelpers(vscode, view);
  const f = n.finding;
  const st = classifyChangeVerdict(f);
  const kinds = f.kinds.filter((/** @type {any} */ k) => k.id !== 'body').map((/** @type {any} */ k) => k.short || k.label);
  const qual = n.ambiguous ? `  ·  ${f.component}` : '';
  item.label = n.ambiguous ? `${n.name}  ‹${f.component}›` : n.name;
  const agent = view.agentOf ? view.agentOf(n) : null;
  item.description = [describeChangeRow(containerToShow(n),
    view.rowDetail === 'inline' ? `${st.text}${qual}${kinds.length ? '  ·  ' + kinds.join(', ') : ''}` : st.text,
    n, threadParts(n, view)), agent && rowLine(agent), basenameNote(n, view)].filter(Boolean).join('  ·  ');
  // The agent's own kind icon, never the engine's: the colour is still the verdict's.
  const tone = toneOf(st);
  const kindIcon = agent ? AGENT_KIND_ICON[agent.kind] : undefined;
  item.iconPath = kindIcon ? new vscode.ThemeIcon(kindIcon, tone ? new vscode.ThemeColor(tone.color) : undefined) : rowIcon(f.label, f, tone);
  const lines = buildChangeTooltipLines(n, st, kinds);
  item.tooltip = new vscode.MarkdownString((agent ? [...lines.slice(0, 2), ...tooltipLines(agent, mdText), '', '---', '', ...lines.slice(2)] : lines).join('\n'));
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
 */
function renderCallerFileItem(vscode, item, n) {
  const cs = CALL_STATE[n.callState] || CALL_STATE.unchanged;
  const state = n.test ? 'test' : cs.text;
  const fns = n.callers.length;
  item.description = [state, `${fns} caller${fns === 1 ? '' : 's'}`, `${n.sites} call site${n.sites === 1 ? '' : 's'}`].join('  ·  ');
  // A file, whatever iconMode says; ThemeIcon.File cannot be tinted, so the one state that
  // looks handled and is not trades it for the amber warning icon.
  item.iconPath = !n.test && n.callState === 'changed-elsewhere' && CHANGED_ELSEWHERE_TONE
    ? new vscode.ThemeIcon(CHANGED_ELSEWHERE_TONE.fileIcon, new vscode.ThemeColor(CHANGED_ELSEWHERE_TONE.color))
    : vscode.ThemeIcon.File;
  item.tooltip = new vscode.MarkdownString([
    `**${n.relPath}**`, '',
    `${fns} function${fns === 1 ? '' : 's'} in this file call the change, across ${n.sites} call site${n.sites === 1 ? '' : 's'}:`,
    '', ...n.callers.slice(0, 12).map((/** @type {TreeRow} */ c) => `- ${c.label} — ${c.test ? 'test' : (CALL_STATE[c.callState] || CALL_STATE.unchanged).text}`),
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
  const { rowIcon } = renderHelpers(vscode, view);
  const cs = CALL_STATE[n.callState] || CALL_STATE.unchanged;
  const base = path.basename(n.relPath || n.file);
  const state = n.cycle ? 'already shown above' : n.test ? 'test' : cs.text;
  // Some calls were edited and others not: the row cannot read as handled, and the count says why.
  const { updated, untouched, unknown } = n.callSiteUpdates;
  const notUpdated = untouched.length + unknown.length;
  const partlyUpdated = updated.length > 0 && notUpdated > 0;
  const how = !n.cycle && view.agentHowOf ? view.agentHowOf(n) : null;
  item.description = n.cycle ? state : [`${state}  ·  ${base}${n.sites > 1 ? `  ·  ${n.sites} call sites` : ''}`, how].filter(Boolean).join('  ·  ');
  item.iconPath = n.cycle ? new vscode.ThemeIcon('issue-reopened')
    : n.test ? new vscode.ThemeIcon('beaker')
      : rowIcon(n.label, null, n.callState === 'changed-elsewhere' ? CHANGED_ELSEWHERE_TONE : null);
  item.tooltip = new vscode.MarkdownString([
    `**${n.label}**`,
    '',
    n.cycle ? '_already shown higher up in this tree_' : n.test ? 'test' : `**${cs.text}**`,
    '',
    `\`${n.relPath || n.file}\``,
    ...(n.sites ? ['', `${n.sites} call site${n.sites === 1 ? '' : 's'} to the changed symbol`] : []),
    ...(partlyUpdated ? ['', `${updated.length} of ${updated.length + notUpdated} call sites updated`] : []),
    ...(n.callState === 'changed-elsewhere'
      ? ['', '---', '', 'This caller **was** edited in this change, but not on the line that calls the changed symbol — it may still need updating.']
      : []),
    ...(how ? ['', '---', '', `**Your agent:** ${mdText(how)}`] : []),
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
 * The calm state's container: "Browse all N changes", collapsed, holding the file rows. It
 * has no checkbox and no commands; the files under it keep theirs.
 * @param {any} vscode
 * @param {TreeRow} n A `browse` row.
 */
function renderBrowseItem(vscode, n) {
  const item = new vscode.TreeItem(n.label, n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon(n.icon || 'list-flat');
  item.tooltip = 'Nothing here needs attention. Open it to read the changes anyway; each can still be marked reviewed.';
  item.contextValue = 'browse';
  return item;
}

/**
 * A card of the By card order: a group of related changes, not a finding. It has no checkbox
 * (the changes under it keep theirs). Its description says how many changes it holds and how
 * many of them still need attention.
 * @param {any} vscode
 * @param {TreeRow} n A `card` row.
 * @param {TreeView} view
 */
function renderCardItem(vscode, n, view) {
  const item = new vscode.TreeItem(n.label, n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon(n.card.agent ? 'sparkle' : 'layers');
  item.description = describeCard(n, { isReviewed: (r) => view.checkedOf(r) === true, attention: attentionOf(view) });
  const lines = view.cardTooltipOf ? view.cardTooltipOf(n) : [];
  item.tooltip = [n.label, ...(lines.length ? [''] : []), ...lines].join('\n');
  item.contextValue = 'card';
  return item;
}

/**
 * The container of the changes no card holds: files without a call graph, files that only
 * have top-level changes, and what a card left out. It has no checkbox.
 * @param {any} vscode
 * @param {TreeRow} n An `others` row.
 */
function renderOthersItem(vscode, n) {
  const item = new vscode.TreeItem(n.label, n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  item.iconPath = new vscode.ThemeIcon('files');
  item.description = describeOthers(n);
  item.tooltip = 'The changes that are in no card: files without a call graph, files whose only change is top-level lines, and changes the cards left out.';
  item.contextValue = 'others';
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
  if (n.type === 'folder') return renderFolderItem(vscode, n, view);
  if (n.type === 'reviewFile') return renderReviewFileItem(vscode, n, view);
  if (n.type === 'file') return renderFileItem(vscode, n, view);
  if (n.type === 'spacer') return renderSpacerItem(vscode);
  if (n.type === 'browse') return renderBrowseItem(vscode, n);
  if (n.type === 'card') return renderCardItem(vscode, n, view);
  if (n.type === 'others') return renderOthersItem(vscode, n);
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
  if (n.type === 'callerFile') return renderCallerFileItem(vscode, item, n);
  return renderCallerItem(vscode, item, n, view);
}

module.exports = { renderTreeItem };
