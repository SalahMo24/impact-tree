// @ts-check
'use strict';
// Turns one row model into a VS Code TreeItem. The renderer is handed the `vscode`
// module and the view settings, and reads nothing else: no session state, no review
// store, no decorations. The provider supplies review progress through `view`.
//
// Layout rule: the *status marker leads* the description and the path is reduced to a
// basename. A sidebar truncates from the right, so anything trailing a long path is
// invisible exactly when the row matters most.
const path = require('path');
const {
  CALL_STATE, GROUP_TYPES, classifyChangeVerdict, classifyWorstRowVerdict, collectRowAndNested,
} = require('./tree-row-models');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/**
 * What a row's rendering depends on besides the row.
 * - `layout`: 'tree' or 'flat' (impactTree.fileListLayout).
 * - `rowDetail`: 'hover' keeps a row to icon, name, badge and one state glyph, with the
 *   words and kind tags in the tooltip; 'inline' is the denser row.
 * - `iconMode`: 'file' for the file-type glyph, 'symbol' for a symbol-kind icon.
 * - `checkedOf(row)`: whether the row's review checkbox is ticked, or null for no checkbox.
 * - `reviewNoteOf(row)`: review progress of a change row's callers, or null.
 * @typedef {{
 *   layout: string, rowDetail: string, iconMode: string,
 *   checkedOf: (row: TreeRow) => boolean|null, reviewNoteOf: (row: TreeRow) => string|null,
 * }} TreeView
 */

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
    inline: (/** @type {string} */ text) => (view.rowDetail === 'inline' ? text : undefined),
    // 'hover' keeps the single state glyph in the row so the column is still scannable.
    rowDesc: (/** @type {string} */ token, /** @type {string} */ full) => (view.rowDetail === 'inline' ? full : token),
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
 * A row that groups changes: a file holding several, or the changes inside one.
 * @param {any} vscode
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderChangeGroupItem(vscode, n, view) {
  const st = classifyWorstRowVerdict(n.members);
  const open = st.level <= 1
    ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
  const item = n.decorationUri ? new vscode.TreeItem(n.decorationUri, open) : new vscode.TreeItem(n.label, open);
  item.label = n.label;
  const count = n.members.length;
  item.description = `${st.token}  ${count} change${count === 1 ? '' : 's'}`;
  item.iconPath = n.type === 'changeFile' ? vscode.ThemeIcon.File : new vscode.ThemeIcon('list-tree');
  item.tooltip = new vscode.MarkdownString([
    n.type === 'changeFile' ? `**${n.relPath}**` : `**Changed inside ${n.container}**`, '',
    `${count} body-only change${count === 1 ? '' : 's'}${n.type === 'changeFile' ? ' in this file' : ''}, worst first:`, '',
    ...n.members.slice(0, 12).map((/** @type {TreeRow} */ m) => (m.finding
      ? `- ${classifyChangeVerdict(m.finding).token} ${m.finding.label}`
      : `- ${m.label}: ${m.desc}`)),
    ...(count > 12 ? [`- …and ${count - 12} more`] : []),
  ].join('\n'));
  item.contextValue = n.type;
  applyCheckbox(vscode, item, n, view);
  if (n.type === 'changeFile') item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
  return item;
}

/**
 * A changed file without a call graph.
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
  item.description = view.layout === 'flat'
    ? `${path.dirname(n.relPath)}`
    : renderHelpers(vscode, view).inline(`${n.status}  ·  ${path.dirname(n.relPath)}`);
  item.tooltip = new vscode.MarkdownString([`**${path.basename(n.relPath)}**`, '', `_${n.status}_`, '', `\`${n.relPath}\``].join('\n'));
  applyCheckbox(vscode, item, n, view);
  item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
  return item;
}

/**
 * Rows whose rendering needs no status: summary, messages, folders, sections, deleted
 * symbols and the legend. Returns null for any other row type.
 * @param {any} vscode
 * @param {any} item The row's item, already constructed.
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderPlainItem(vscode, item, n, view) {
  switch (n.type) {
    case 'summary':
      item.description = n.desc;
      item.iconPath = new vscode.ThemeIcon('git-compare');
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.tooltip = n.tooltip;
      return item;
    case 'message':
      item.description = n.desc;
      item.iconPath = new vscode.ThemeIcon(n.icon || 'info');
      item.tooltip = n.tooltip || n.label;
      if (n.command) item.command = { command: n.command, title: n.label };
      return item;
    case 'dir': {
      const di = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      di.iconPath = vscode.ThemeIcon.Folder;
      di.tooltip = n.dirPath || n.label;
      di.contextValue = 'directory';
      return di;
    }
    case 'section':
      item.label = `${n.label}  (${n.count})`;
      item.description = n.desc;
      item.iconPath = new vscode.ThemeIcon(n.icon);
      item.collapsibleState = (n.count === 0 && n.computed !== false)
        ? vscode.TreeItemCollapsibleState.None
        : (n.key === 'findings' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      return item;
    case 'deleted':
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.description = renderHelpers(vscode, view).inline(path.basename(n.relPath));
      item.iconPath = new vscode.ThemeIcon('trash');  // semantics beat decoration here
      item.tooltip = new vscode.MarkdownString([`✕ **${n.label}**`, '', '_deleted in this change_', '', `\`${n.relPath}\``].join('\n'));
      applyCheckbox(vscode, item, n, view);
      item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
      return item;
    case 'outside':
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      // Inside its file's group the file is the parent; alone it has to name it.
      item.description = n.inGroup ? n.desc : `${path.basename(n.relPath)}  ·  ${n.desc}`;
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      item.tooltip = new vscode.MarkdownString([
        `**Outside functions** — \`${n.relPath}\``, '', n.desc, '',
        '_Changed lines in no function: imports, constants, types, fields and the like._',
      ].join('\n'));
      item.contextValue = 'outside';
      applyCheckbox(vscode, item, n, view);
      item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
      return item;
    case 'legend':
      item.iconPath = new vscode.ThemeIcon('list-unordered');
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      return item;
    case 'legendItem':
      item.iconPath = new vscode.ThemeIcon(n.icon);
      item.description = n.desc;
      return item;
    default:
      return null;
  }
}

/**
 * The tooltip lines of a change row. The row is deliberately bare, so the tooltip must
 * carry the whole story.
 * @param {TreeRow} n
 * @param {import('./tree-row-models').Verdict} st
 * @param {string[]} kinds Short names of the non-body change kinds.
 * @param {string|null} reviewNote
 * @returns {string[]}
 */
function buildChangeTooltipLines(n, st, kinds, reviewNote) {
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
    ...(reviewNote ? ['', `_${reviewNote}_`] : []),
    '', `_score ${f.score}_`,
  ];
}

/**
 * A changed symbol.
 * @param {any} vscode
 * @param {any} item The row's item, already constructed.
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderChangeItem(vscode, item, n, view) {
  const { rowDesc, rowIcon } = renderHelpers(vscode, view);
  const reviewNote = view.reviewNoteOf(n);
  const f = n.finding;
  const st = classifyChangeVerdict(f);
  const kinds = f.kinds.filter((/** @type {any} */ k) => k.id !== 'body').map((/** @type {any} */ k) => k.short || k.label);
  // marker first, then the short kind list — both survive truncation
  const qual = n.ambiguous ? `  ·  ${f.component}` : '';
  item.description = rowDesc(st.token,
    `${st.token}  ${st.text}${qual}${kinds.length ? '  ·  ' + kinds.join(', ') : ''}`);
  if (n.ambiguous) item.label = `${f.label}  ‹${f.component}›`;
  // The row starts collapsed, so a worse state among the changes inside it must show on
  // the row itself.
  const insideSt = n.inside && n.inside.length ? classifyWorstRowVerdict(n.inside.flatMap(collectRowAndNested)) : null;
  if (insideSt && insideSt.level < st.level && insideSt.level <= 1) {
    item.description = `${item.description}  ·  ${insideSt.token} inside`;
  }
  // In the unknown-test section the reason is the point of the row, so it leads in
  // either detail mode.
  if (n.reachReason) item.description = `?  tests unknown: ${n.reachReason}  ·  ${item.description}`;
  item.iconPath = rowIcon(f.label, f);
  item.tooltip = new vscode.MarkdownString(buildChangeTooltipLines(n, st, kinds, reviewNote).join('\n'));
  item.contextValue = 'finding';
  applyCheckbox(vscode, item, n, view);
  // Review progress goes inline only in 'inline' mode; hover mode keeps the row to a
  // single state glyph, so the count lives in the tooltip instead.
  if (reviewNote && view.rowDetail === 'inline') {
    item.description = `${item.description || ''}${item.description ? '  ·  ' : ''}${reviewNote}`;
  }
  item.command = { command: 'impactTree.openChange', title: 'Open change', arguments: [n] };
  return item;
}

/**
 * A file grouping several callers of one change.
 * @param {any} vscode
 * @param {any} item The row's item, already constructed.
 * @param {TreeRow} n
 * @param {TreeView} view
 */
function renderCallerFileItem(vscode, item, n, view) {
  const { rowDesc, rowIcon } = renderHelpers(vscode, view);
  const cs = CALL_STATE[n.callState] || CALL_STATE.unchanged;
  const tok = n.test ? '🧪' : cs.token;
  const fns = n.callers.length;
  item.description = rowDesc(tok,
    `${tok}  ${fns} caller${fns === 1 ? '' : 's'}  ·  ${n.sites} call site${n.sites === 1 ? '' : 's'}`);
  item.iconPath = rowIcon(n.label, null);
  item.tooltip = new vscode.MarkdownString([
    `**${n.relPath}**`, '',
    `${fns} function${fns === 1 ? '' : 's'} in this file call the change, across ${n.sites} call site${n.sites === 1 ? '' : 's'}:`,
    '', ...n.callers.slice(0, 12).map((/** @type {TreeRow} */ c) => `- ${(CALL_STATE[c.callState] || CALL_STATE.unchanged).token} ${c.label}`),
    ...(n.callers.length > 12 ? [`- …and ${n.callers.length - 12} more`] : []),
  ].join('\n'));
  item.contextValue = 'callerFile';
  applyCheckbox(vscode, item, n, view);
  item.command = { command: 'impactTree.openFile', title: 'Open file', arguments: [n] };
  return item;
}

/**
 * One caller of a change.
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
  applyCheckbox(vscode, item, n, view);
  item.command = { command: 'impactTree.openCaller', title: 'Open caller', arguments: [n] };
  return item;
}

/**
 * Renders one row as a TreeItem.
 * @param {any} vscode The vscode module (or a stand-in with the same constructors).
 * @param {TreeRow} n A row model.
 * @param {TreeView} view
 * @returns {any} A new vscode.TreeItem.
 */
function renderTreeItem(vscode, n, view) {
  if (GROUP_TYPES.has(n.type)) return renderChangeGroupItem(vscode, n, view);
  if (n.type === 'file') return renderFileItem(vscode, n, view);
  const collapsible = n.type === 'message' || n.type === 'legendItem' || n.cycle
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
