'use strict';
const path = require('path');
const { nodeId } = require('./review-state');
const { classifyCallerUpdateState } = require('./engine/call-sites');

// Tree nodes resolve their callers on expand. That laziness is the whole reason the
// extension is cheap where the CLI is not: the CLI pre-walked 152 positions (123s);
// a reviewer expands maybe a dozen.
//
// Layout rule: the *status marker leads* the description and the path is reduced to a
// basename. A sidebar truncates from the right, so anything trailing a long path is
// invisible exactly when the row matters most.

const LEGEND = [
  ['file', 'Icon = file type', 'from your file-icon theme, on code rows and file rows alike'],
  ['symbol-method', 'impactTree.iconMode = "symbol"', 'switch code rows to method/function icons instead'],
  ['tag', 'Badge M / A / D / R', 'git status against the review base, not HEAD — hover for the word'],
  ['error', '⛔  call sites this change did NOT update', 'review these first'],
  ['pass', '✓  all call sites updated', 'every caller found was changed on the call line'],
  ['circle-slash', '∅  no callers found', 'in the code searched — dynamic calls and unloaded projects are not seen'],
  ['warning', '△  caller changed, but NOT on the call line', 'looks handled and is not'],
  ['circle-outline', '○  caller not changed at all', 'affected but untouched'],
  ['question', '?  callers unknown', 'the search failed or could not tell — e.g. passed as a value or DI-constructed'],
  ['beaker', '🧪  test that reaches this code', ''],
  ['issue-reopened', '↑  cycle — already shown higher up', ''],
];

// Three states, because "the symbol changed" and "the call was updated" are different
// questions. A caller edited just above and below the call line is the dangerous case:
// it looks handled and is not.
const CALL_STATE = {
  'updated-at-call':   { token: '✓', severity: 'ok',    text: 'call updated' },
  'changed-elsewhere': { token: '△', severity: 'warn',  text: 'changed, but not at the call' },
  unchanged:           { token: '○', severity: 'muted', text: 'not changed' },
};

// What a caller row knows about its call sites when the view state cannot classify them.
const NO_SITE_EVIDENCE = { updated: [], untouched: [], unknown: [] };

// Rows that only group changes; their review state is derived from their members.
const GROUP_TYPES = new Set(['changeFile', 'insideGroup']);
const SEVERITY_RANK = { stale: 0, warn: 1, ok: 2, muted: 3 };

function createTreeProvider(vscode, { getState, resolver, isBusy = () => false, decorate = null, getPhase = () => 'ready', review = null }) {
  // A finding's direct callers are already resolved, so checking it can clear them too
  // and report real progress. Deeper levels are lazy and are not counted.
  const idOf = (n) => review?.id ? review.id(n) : nodeId(n);
  const childIdsOf = (n) => review?.childIds ? review.childIds(n) : [];
  const applyCheckbox = (item, n) => {
    if (!review) return;
    const id = idOf(n);
    if (!id) return;
    // A grouping row is reviewed exactly when everything in it is, so unticking one
    // change inside it unticks the group too.
    const members = GROUP_TYPES.has(n.type) ? childIdsOf(n) : null;
    const on = members ? members.length > 0 && review.remaining(members) === 0 : review.isReviewed(id);
    item.checkboxState = on
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  };
  // file:///path#offset — unique per symbol so decorations do not collide, while the
  // icon theme still matches on the extension.
  // Tier A must NOT use a file:// URI. The editor's git decoration provider keys on
  // those and paints the worktree status (U for untracked, M for a local edit) on
  // top of the PR status. A non-file scheme is invisible to git, so the only badge
  // is the one we register from the pull request.
  const uriFor = (file, pos) => {
    if (!file) return null;
    const st = getState();
    let u;
    if (st && st.result && st.result.tierA && st.rel) {
      const rel = String(st.rel(file) || file).replace(/\\/g, '/').replace(/^\/+/, '');
      u = vscode.Uri.from({ scheme: 'impacttree-pr', path: `/${rel}`, query: require('./pr-documents').prQuery(st.result, 'head') });
    } else {
      u = vscode.Uri.file(file);
    }
    return pos == null ? u : u.with({ fragment: String(pos) });
  };
  // The GitHub PR extension groups with a real folder hierarchy rather than spacing
  // (githubPullRequests.fileListLayout: "tree" | "flat", default "tree"). Blank rows
  // were a poor substitute: selectable, keyboard-navigable and visually noisy.
  const layout = () => {
    const st = getState();
    return (st && st.fileListLayout) || 'tree';
  };
  // Rows for one directory's children. `prefix` is the repo-relative path of `node`.
  const emitDirs = (node, prefix, segs) => {
    const out = [];
    for (const [name, child] of node.dirs) {
      const nextSegs = [...segs, name];
      const nextPrefix = prefix ? `${prefix}/${name}` : name;
      // compact: a directory with exactly one subdirectory and no files merges down
      if (child.dirs.size === 1 && child.files.length === 0) {
        out.push(...emitDirs({ dirs: child.dirs, files: [] }, nextPrefix, nextSegs));
        continue;
      }
      out.push({ type: 'dir', label: nextSegs.join('/'), dirPath: nextPrefix, node: child });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out.concat(node.files.sort((a, b) => a.label.localeCompare(b.label)));
  };
  // Collapse single-child chains so `src/data/application-state` is one row, as the
  // explorer's compact folders do.
  const buildFileTree = (leaves) => {
    const root = { dirs: new Map(), files: [] };
    for (const leaf of leaves) {
      const parts = leaf.relPath.split('/');
      const fileName = parts.pop();
      let cur = root;
      for (const part of parts) {
        if (!cur.dirs.has(part)) cur.dirs.set(part, { dirs: new Map(), files: [] });
        cur = cur.dirs.get(part);
      }
      cur.files.push({ ...leaf, label: fileName });
    }
    return emitDirs(root, '', []);
  };
  // Expanding a folder compacts its subfolders exactly as the top level does.
  const childrenOfDir = (node, prefix) => emitDirs(node, prefix, []);
  const statusOfPath = (st, relPath) => {
    const table = st && st.result && st.result.fileStatus;
    if (!table || relPath == null) return undefined;
    if (table[relPath]) return table[relPath];
    const slash = String(relPath).replace(/\\/g, '/');
    return table[slash];
  };
  const mark = (uri, status, _severity, tooltip) => {
    if (decorate && uri) decorate.register(uri, { status, tooltip });
    return uri;
  };
  const symbolIcon = (label, sym) => {
    if (sym && sym.isConstructor) return 'symbol-constructor';
    if (sym && sym.valueLike) return 'symbol-variable';
    if (sym && sym.className) return 'symbol-method';
    return String(label || '').includes('.') ? 'symbol-method' : 'symbol-function';
  };
  // VS Code infers FileKind.FOLDER for any expandable row, which is why resourceUri
  // alone yields a folder glyph. ThemeIcon.File overrides that inference and resolves
  // the row against the active file-icon theme using resourceUri's extension.
  const iconMode = () => {
    const st = getState();
    return (st && st.iconMode) || 'file';
  };
  // 'hover'  -> row is icon + name + badge; everything else lives in the tooltip
  // 'inline' -> the previous dense row
  const detailMode = () => {
    const st = getState();
    return (st && st.rowDetail) || 'hover';
  };
  const inline = (text) => (detailMode() === 'inline' ? text : undefined);
  // 'hover' keeps the single state glyph in the row so the column is still scannable;
  // only the words and kind tags move into the tooltip.
  const rowDesc = (token, full) => (detailMode() === 'inline' ? full : token);
  const rowIcon = (label, sym) => (iconMode() === 'symbol'
    ? new vscode.ThemeIcon(symbolIcon(label, sym))
    : vscode.ThemeIcon.File);
  const _emitter = new vscode.EventEmitter();
  const N = (p) => p;

  // token + severity, not an icon: the icon slot belongs to the file glyph now, and
  // severity is carried by the decoration colour
  function statusOf(f) {
    // Results from before `callersComplete` existed have no such field and read as complete.
    const mayBeMissing = f.callersComplete === false;
    if (f.staleCallers > 0) {
      const e = f.staleChangedElsewhere || 0;
      return { token: '⛔', severity: 'stale',
        marker: `${f.staleCallers} call site(s) not updated${e ? ` (${e} edited nearby)` : ''}${mayBeMissing ? ' — more callers may be missing' : ''}` };
    }
    switch (f.callerState) {
      case 'resolved': return mayBeMissing
        ? { token: '?', severity: 'warn', marker: 'callers found so far are updated, but more may be missing' }
        : { token: '✓', severity: 'ok', marker: 'all call sites updated' };
      // A completed search that found nothing is not evidence that callers were updated.
      case 'none': return { token: '∅', severity: 'muted', marker: 'no callers found' };
      case 'di': return { token: '?', severity: 'muted', marker: 'DI-constructed' };
      default: return { token: '?', severity: 'warn', marker: 'callers unknown' };
    }
  }

  const membersOf = (n) => [n, ...(n.inside || []).flatMap(membersOf)];
  const rankOf = (n) => SEVERITY_RANK[statusOf(n.finding).severity] ?? 3;
  const worstStatus = (nodes) => statusOf(nodes.reduce((w, x) => (rankOf(x) < rankOf(w) ? x : w)).finding);
  // Worst first, otherwise the incoming (score) order. Array sort is stable.
  const byWorst = (rows) => rows
    .map((r) => [r, Math.min(...(r.members || membersOf(r)).map(rankOf))])
    .sort((a, b) => a[1] - b[1]).map(([r]) => r);

  // Body-only changes that call no other change are what is left once call edges have
  // nested everything they can, so the remaining structure is where they live: a change
  // declared inside another change nests under it, and a file holding several becomes
  // one row. Nothing is dropped: every change stays reachable, and the worst state in a
  // group leads its row, so a ⛔ cannot hide inside a collapsed group.
  function groupByLocation(nodes) {
    const byFile = new Map();
    for (const n of nodes) {
      if (!byFile.has(n.file)) byFile.set(n.file, []);
      byFile.get(n.file).push(n);
    }
    const top = [];
    for (const n of nodes) {
      const c = n.finding;
      let parent = null;
      if (c.start != null && c.end != null) {
        for (const o of byFile.get(n.file)) {
          const p = o.finding;
          if (o === n || p.start == null || p.start > c.start || p.end < c.end || (p.start === c.start && p.end === c.end)) continue;
          if (!parent || p.end - p.start < parent.finding.end - parent.finding.start) parent = o;
        }
      }
      if (!parent) { top.push(n); continue; }
      (parent.inside ||= []).push(n);
      n.container = parent.finding.label;
      if (n.label.startsWith(`${parent.finding.label}.`)) n.label = n.label.slice(parent.finding.label.length + 1);
    }
    for (const n of nodes) if (n.inside) n.inside = byWorst(n.inside);
    if (layout() === 'flat') return byWorst(top);
    const st = getState();
    const rowsByFile = new Map();
    for (const n of top) {
      if (!rowsByFile.has(n.file)) rowsByFile.set(n.file, []);
      rowsByFile.get(n.file).push(n);
    }
    const out = [];
    for (const [file, rows] of rowsByFile) {
      // a one-child group is pure overhead, the rule caller files and folders follow
      if (rows.length === 1) { out.push(rows[0]); continue; }
      const relPath = rows[0].finding.relPath;
      const uri = uriFor(file, null);
      mark(uri, statusOfPath(st, relPath), 'muted', relPath);
      out.push(N({
        type: 'changeFile', label: path.basename(relPath), relPath, file,
        rows: byWorst(rows), members: rows.flatMap(membersOf), decorationUri: uri,
      }));
    }
    return byWorst(out);
  }

  function groupItem(n) {
    const st = worstStatus(n.members);
    const open = st.severity === 'stale' || st.severity === 'warn'
      ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = n.decorationUri ? new vscode.TreeItem(n.decorationUri, open) : new vscode.TreeItem(n.label, open);
    item.label = n.label;
    const count = n.members.length;
    item.description = `${st.token}  ${count} change${count === 1 ? '' : 's'}`;
    item.iconPath = n.type === 'changeFile' ? vscode.ThemeIcon.File : new vscode.ThemeIcon('list-tree');
    item.tooltip = new vscode.MarkdownString([
      n.type === 'changeFile' ? `**${n.relPath}**` : `**Changed inside ${n.container}**`, '',
      `${count} body-only change${count === 1 ? '' : 's'}${n.type === 'changeFile' ? ' in this file' : ''}, worst first:`, '',
      ...n.members.slice(0, 12).map((m) => `- ${statusOf(m.finding).token} ${m.finding.label}`),
      ...(count > 12 ? [`- …and ${count - 12} more`] : []),
    ].join('\n'));
    item.contextValue = n.type;
    applyCheckbox(item, n);
    if (n.type === 'changeFile') item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
    return item;
  }

  function toItem(n) {
    if (GROUP_TYPES.has(n.type)) return groupItem(n);
    if (n.type === 'file') {
      const uri = n.decorationUri || (n.absPath ? vscode.Uri.file(n.absPath) : null);
      const item = uri
        ? new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None)
        : new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
      // A file:// row takes its icon from the resource URI. A Tier A row is not a
      // file:// URI (so git cannot badge it); ThemeIcon.File still resolves the
      // extension against the icon theme.
      if (uri && uri.scheme && uri.scheme !== 'file') {
        item.label = n.label || path.basename(n.relPath);
        item.iconPath = vscode.ThemeIcon.File;
      }
      item.description = layout() === 'flat'
        ? `${path.dirname(n.relPath)}`
        : inline(`${n.status}  ·  ${path.dirname(n.relPath)}`);
      item.tooltip = new vscode.MarkdownString([`**${path.basename(n.relPath)}**`, '', `_${n.status}_`, '', `\`${n.relPath}\``].join('\n'));
      applyCheckbox(item, n);
    item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
      return item;
    }
    const collapsible = n.type === 'message' || n.type === 'legendItem' || n.cycle
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;
    // Construct from the Uri so the file-icon theme applies, then override the label:
    // assigning resourceUri afterwards onto a string-labelled item does not pick up
    // the theme. The fragment makes each symbol row a distinct decoration target.
    const uri = n.decorationUri;
    const item = uri ? new vscode.TreeItem(uri, collapsible) : new vscode.TreeItem(n.label, collapsible);
    if (uri) item.label = n.label;

    if (n.type === 'summary') {
      item.description = n.desc;
      item.iconPath = new vscode.ThemeIcon('git-compare');
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.tooltip = n.tooltip;
      return item;
    }
    if (n.type === 'message') {
      item.description = n.desc;
      item.iconPath = new vscode.ThemeIcon(n.icon || 'info');
      item.tooltip = n.tooltip || n.label;
      if (n.command) item.command = { command: n.command, title: n.label };
      return item;
    }
    if (n.type === 'dir') {
      const di = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      di.iconPath = vscode.ThemeIcon.Folder;
      di.tooltip = n.dirPath || n.label;
      di.contextValue = 'directory';
      return di;
    }
    if (n.type === 'section') {
      item.label = `${n.label}  (${n.count})`;
      item.description = n.desc;
      item.iconPath = new vscode.ThemeIcon(n.icon);
      item.collapsibleState = (n.count === 0 && n.computed !== false)
        ? vscode.TreeItemCollapsibleState.None
        : (n.key === 'findings' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      return item;
    }
    if (n.type === 'deleted') {
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.description = inline(path.basename(n.relPath));
      item.iconPath = new vscode.ThemeIcon('trash');  // semantics beat decoration here
      item.tooltip = new vscode.MarkdownString([`✕ **${n.label}**`, '', '_deleted in this change_', '', `\`${n.relPath}\``].join('\n'));
      applyCheckbox(item, n);
    item.command = { command: 'impactTree.openFile', title: 'Open diff', arguments: [n] };
      return item;
    }
    if (n.type === 'legend') {
      item.iconPath = new vscode.ThemeIcon('list-unordered');
      item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      return item;
    }
    if (n.type === 'legendItem') {
      item.iconPath = new vscode.ThemeIcon(n.icon);
      item.description = n.desc;
      return item;
    }
    if (n.type === 'finding') {
      const kids = childIdsOf(n);
      const left = review ? review.remaining(kids) : 0;
      n._reviewNote = review && kids.length ? (left ? `${left}/${kids.length} callers left to review` : 'all callers reviewed') : null;
      const f = n.finding;
      const st = statusOf(f);
      const kinds = f.kinds.filter((k) => k.id !== 'body').map((k) => k.short || k.label);
      // marker first, then the short kind list — both survive truncation
      const qual = n.ambiguous ? `  ·  ${f.component}` : '';
      item.description = rowDesc(st.token,
        `${st.token}  ${st.marker}${qual}${kinds.length ? '  ·  ' + kinds.join(', ') : ''}`);
      if (n.ambiguous) item.label = `${f.label}  ‹${f.component}›`;
      // The row starts collapsed, so a worse state among the changes inside it must
      // show on the row itself.
      const insideSt = n.inside && n.inside.length ? worstStatus(n.inside.flatMap(membersOf)) : null;
      if (insideSt && SEVERITY_RANK[insideSt.severity] < SEVERITY_RANK[st.severity] && SEVERITY_RANK[insideSt.severity] <= 1) {
        item.description = `${item.description}  ·  ${insideSt.token} inside`;
      }
      item.iconPath = rowIcon(f.label, f);
      // the row is deliberately bare, so the tooltip must carry the whole story
      item.tooltip = new vscode.MarkdownString([
        `${st.token} **${f.label}**`,
        '',
        `${st.marker}`,
        ...(f.callersComplete === false && f.callersIncompleteReason ? ['', `_caller search incomplete: ${f.callersIncompleteReason}_`] : []),
        ...(kinds.length ? ['', `**${kinds.join(', ')}**`] : []),
        '',
        `\`${f.relPath}:${f.startLine}\`  ·  component \`${f.component}\``,
        ...(f.baseSig && f.baseSig !== f.headSig
          ? ['', '---', '', `base: \`${f.baseSig}\``, '', `head: \`${f.headSig}\``] : []),
        ...(f.throwsAdded.length ? ['', '---', '', ...f.throwsAdded.map((t) => `+ throw \`${t}\``)] : []),
        ...(f.stale && f.stale.length
          ? ['', '---', '', `**${f.staleCallers} call site(s) not updated:**`,
            ...f.stale.slice(0, 10).map((x) => `- ${x.label}`),
            ...(f.stale.length > 10 ? [`- …and ${f.stale.length - 10} more`] : []),
            ...(f.staleChangedElsewhere
              ? ['', `${f.staleChangedElsewhere} of them were edited — just not on the call line`] : [])]
          : []),
        ...(n._reviewNote ? ['', `_${n._reviewNote}_`] : []),
        '', `_score ${f.score}_`,
      ].join('\n'));
      item.contextValue = 'finding';
      applyCheckbox(item, n);
      // Review progress goes inline only in 'inline' mode; hover mode keeps the row to a
      // single state glyph, so the count lives in the tooltip instead.
      if (n._reviewNote && detailMode() === 'inline') {
        item.description = `${item.description || ''}${item.description ? '  ·  ' : ''}${n._reviewNote}`;
      }
      item.command = { command: 'impactTree.openChange', title: 'Open change', arguments: [n] };
      return item;
    }
    if (n.type === 'callerFile') {
      const cs2 = CALL_STATE[n.callState] || CALL_STATE.unchanged;
      const tok2 = n.test ? '🧪' : cs2.token;
      const fns = n.callers.length;
      item.description = rowDesc(tok2,
        `${tok2}  ${fns} caller${fns === 1 ? '' : 's'}  ·  ${n.sites} call site${n.sites === 1 ? '' : 's'}`);
      item.iconPath = rowIcon(n.label, null);
      item.tooltip = new vscode.MarkdownString([
        `**${n.relPath}**`, '',
        `${fns} function${fns === 1 ? '' : 's'} in this file call the change, across ${n.sites} call site${n.sites === 1 ? '' : 's'}:`,
        '', ...n.callers.slice(0, 12).map((c) => `- ${(CALL_STATE[c.callState] || CALL_STATE.unchanged).token} ${c.label}`),
        ...(n.callers.length > 12 ? [`- …and ${n.callers.length - 12} more`] : []),
      ].join('\n'));
      item.contextValue = 'callerFile';
      applyCheckbox(item, n);
      item.command = { command: 'impactTree.openFile', title: 'Open file', arguments: [n] };
      return item;
    }
    // caller
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
    applyCheckbox(item, n);
    item.command = { command: 'impactTree.openCaller', title: 'Open caller', arguments: [n] };
    return item;
  }

  return {
    onDidChangeTreeData: _emitter.event,
    refresh() { _emitter.fire(); },
    getTreeItem: toItem,
    async getChildren(node) {
      const state = getState();
      if (!node) {
        const ph = getPhase();
        // Never leave the view looking idle while prerequisites are still resolving --
        // a user should not have to know that an index is warming.
        if (ph === 'starting' || ph === 'preparing') {
          return [N({ type: 'message', label: 'Preparing…', icon: 'loading~spin',
            desc: 'indexing the workspace — this happens once per window' })];
        }
        if (ph === 'analysing' || isBusy()) {
          return [N({ type: 'message', label: 'Analysing…', icon: 'loading~spin',
            desc: 'resolving callers through the language server' })];
        }
        if (!state || (!state.result && !state.error)) {
          return [N({ type: 'message', label: 'Ready — click to analyse', icon: 'play',
            desc: 'Impact Tree: Refresh', command: 'impactTree.refresh' })];
        }
        if (state.error) return [N({ type: 'message', label: state.error, icon: 'error' })];
        const r = state.result;
        const out = [];
        const stale = r.findings.reduce((n2, f) => n2 + f.staleCallers, 0);
        const rootsOf = (list) => list.filter((c) => c.isRoot !== false);
        const findingRoots = rootsOf(r.findings);
        const other = rootsOf((r.allChanged || []).filter((c) => !r.findings.includes(c)));
        const nestedFindings = r.findings.length - findingRoots.length;
        const nestedOther = (r.allChanged || []).filter((c) => !r.findings.includes(c)).length - other.length;
        const topIds = rootsOf(r.allChanged || []).map((c) => idOf({ type: 'finding', file: c.file, pos: c.namePos }));
        const left = review ? review.remaining(topIds) : null;
        out.push(N({
          type: 'summary',
          label: `${(r.allChanged || []).length} changed symbol${(r.allChanged || []).length === 1 ? '' : 's'}`
            + (left === null ? '' : left === 0 ? '  ·  all reviewed' : `  ·  ${left} left to review`),
          desc: `${r.findings.length} finding(s)  ·  ${stale} call site(s) not updated  ·  ${r.mode}  ·  ${r.base.ref}`,
          tooltip: `mode '${r.mode}'${r.requestedMode && r.requestedMode !== r.mode ? ` (requested '${r.requestedMode}')` : ''}\nbase ${r.base.ref} @ ${String(r.base.sha).slice(0, 10)}\n${r.changedFileCount} analysed file(s), ${(r.otherFiles || []).length} not analysed`,
        }));
        // Tier A cannot see a caller in a file the PR does not touch. Presenting a
        // truncated tree as if it were complete is the one failure mode that would
        // make this feature worse than useless, so it is stated on the face of it.
        if (r.tierA) {
          out.push(N({
            type: 'message', icon: 'eye',
            label: `Preview — PR files only (${r.changedFileCount} file(s))`,
            desc: 'callers outside this PR are NOT shown  ·  check out for full impact',
            tooltip: 'Built from the pull request\'s own files via the GitHub API.\n'
              + 'Your worktree was not touched.\n\n'
              + 'Any caller living in a file this PR does not change is invisible here.\n'
              + 'Use "Check out and analyse" on the PR for the complete tree.',
          }));
        }
        for (const w of r.warnings) out.push(N({ type: 'message', label: w, icon: 'warning' }));
        for (const u of r.unanalysable) {
          out.push(N({ type: 'message', icon: 'circle-slash',
            label: `${u.count} file(s) in '${u.component}' not analysed`, desc: 'see analysis warning' }));
        }
        // Sections, so a body-only change is visible without competing with findings
        out.push(N({ type: 'section', key: 'findings', label: 'Findings', count: findingRoots.length,
          icon: 'warning',
          desc: `signature, throw or deletion risk${nestedFindings ? `  ·  ${nestedFindings} nested under its callee` : ''}` }));
        out.push(N({ type: 'section', key: 'other', label: 'Other changes', count: other.length,
          icon: 'edit',
          desc: `body-only edits${nestedOther ? `  ·  ${nestedOther} nested under their callee` : ''}` }));
        out.push(N({ type: 'section', key: 'deleted', label: 'Deleted', count: r.deleted.length, icon: 'trash', desc: '' }));
        if (!r.tierA) {
          out.push(N({ type: 'section', key: 'untested', label: 'No test reaches',
            count: r.testReachComputed ? r.untested.length : 0, icon: 'beaker',
            computed: r.testReachComputed,
            desc: r.testReachComputed ? '' : 'not computed — expand to run' }));
        }
        out.push(N({ type: 'section', key: 'files', label: 'Files without a call graph', count: (r.otherFiles || []).length,
          icon: 'files', desc: 'migrations, config, docs' }));
        out.push(N({ type: 'legend', label: 'Legend' }));
        return out;
      }
      if (node.type === 'section') {
        const r = state.result;
        if (decorate) setTimeout(() => decorate.flush(), 0);
        const seen = new Map();
        for (const c of r.allChanged || []) seen.set(c.label, (seen.get(c.label) || 0) + 1);
        const mk = (c) => {
          const sev = c.staleCallers > 0 ? 'stale'
            : (c.callerState === 'unknown') ? 'warn'
              : (c.kinds || []).some((k) => k.id !== 'body') ? 'ok' : 'muted';
          const uri = uriFor(c.file, c.namePos);
          mark(uri, statusOfPath(state, c.relPath), sev, `${c.relPath}:${c.startLine}`);
          return N({
            type: 'finding', label: c.label, finding: c, file: c.file, pos: c.namePos, score: c.score,
            ambiguous: (seen.get(c.label) || 0) > 1, decorationUri: uri,
          });
        };
        // A changed symbol that calls another changed symbol appears ONLY under it --
        // otherwise every such symbol shows twice, once nested and once at top level.
        const isRoot = (c) => c.isRoot !== false;
        if (node.key === 'findings') return r.findings.filter(isRoot).map(mk);
        if (node.key === 'other') return groupByLocation((r.allChanged || []).filter((c) => !r.findings.includes(c)).filter(isRoot).map(mk));
        if (node.key === 'untested') {
          if (!r.testReachComputed) {
            return [N({ type: 'message', label: 'Compute test reachability', icon: 'play',
              desc: 'extra caller queries — run on demand', command: 'impactTree.computeTestReach' })];
          }
          return r.untested.map(mk);
        }
        if (node.key === 'deleted') {
          return r.deleted.map((d) => {
            const uri = uriFor(d.file, d.namePos);
            mark(uri, statusOfPath(state, d.relPath) || 'deleted', 'stale', `${d.label} deleted`);
            return N({ type: 'deleted', label: d.label, key: d.key, relPath: d.relPath, file: d.file, decorationUri: uri });
          });
        }
        if (node.key === 'files') {
          const leaves = (r.otherFiles || []).map((f) => {
            const abs = state.absPath ? state.absPath(f.path) : null;
            const uri = abs ? uriFor(abs, null) : null;
            mark(uri, f.status, 'muted', f.path);
            return N({
              type: 'file', label: path.basename(f.path), relPath: f.path, status: f.status,
              absPath: abs, decorationUri: uri,
            });
          }).sort((a, b) => a.relPath.localeCompare(b.relPath));
          return layout() === 'flat' ? leaves : buildFileTree(leaves);
        }
        return [];
      }
      if (node.type === 'legend') {
        return LEGEND.map(([icon, label, desc]) => N({ type: 'legendItem', icon, label, desc }));
      }
      if (node.type === 'dir') return childrenOfDir(node.node, node.dirPath);
      if (node.type === 'callerFile') return node.callers;
      if (GROUP_TYPES.has(node.type)) return node.rows;
      if (node.type === 'message' || node.type === 'summary' || node.type === 'legendItem'
        || node.type === 'deleted' || node.type === 'file' || node.cycle) return [];
      const state2 = getState();
      const seenPath = new Set(node.path || []);
      seenPath.add(`${node.file}#${node.pos}`);
      // A query that failed or did not finish must not look like a symbol nobody calls.
      let callers = [];
      let incomplete = null;
      try {
        if (resolver.incomingWithStatus) {
          const answer = await resolver.incomingWithStatus(node.file, node.pos, true);
          callers = answer.callers;
          if (!answer.complete) incomplete = answer.reason || 'the caller query did not complete';
        } else {
          callers = await resolver.incoming(node.file, node.pos, true);
          incomplete = 'this resolver does not report whether its caller search finished';
        }
      } catch (e) {
        incomplete = (e && e.message) || 'the caller query failed';
      }
      const excluded = new Set(state2?.result?.excludedCallerPaths || []);
      if (excluded.size && state2?.rel) callers = callers.filter((c) => !excluded.has(state2.rel(c.file)));
      const changedKeys = (state2 && state2.changedKeys) || new Set();
      if (decorate) setTimeout(() => decorate.flush(), 0);
      const built = callers.map((c) => {
        const symChanged = changedKeys.has(`${c.file}#${c.pos}`);
        const callSiteUpdates = state2 && state2.classifyCallSiteUpdates
          ? state2.classifyCallSiteUpdates(c.file, c.callSites) : NO_SITE_EVIDENCE;
        const callState = classifyCallerUpdateState({ callSiteUpdates, callerChanged: symChanged });
        const rel = state2 ? state2.rel(c.file) : c.file;
        const uri = uriFor(c.file, c.pos);
        mark(uri, statusOfPath(state2, rel), c.test ? 'muted' : (CALL_STATE[callState] || {}).severity, rel);
        return N({
          type: 'caller', reviewParent: idOf(node), label: c.label, file: c.file, pos: c.pos, test: c.test,
          callSites: c.callSites || [], sites: c.sites,
          relPath: rel, changed: symChanged, callState, callSiteUpdates, decorationUri: uri,
          cycle: seenPath.has(`${c.file}#${c.pos}`),
          path: [...seenPath],
        });
      });
      built.sort((a, b) => (a.relPath || '').localeCompare(b.relPath || '')
        || a.label.localeCompare(b.label));

      // One row per FILE, not per calling function. A file with three methods that
      // each call the change read as the same file repeated three times; the callers
      // are still distinct impacts, so they become children rather than disappearing.
      // A file with a single caller stays flat -- a one-child group is pure noise,
      // the same rule the directory hierarchy already uses.
      const byFile = new Map();
      for (const c of built) {
        const key = c.relPath || c.file;
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(c);
      }
      const grouped = [];
      for (const [rel, rows] of byFile) {
        if (rows.length === 1) { grouped.push(rows[0]); continue; }
        // worst state wins, so a group never looks calmer than its contents
        const rank = (x) => ({ 'changed-elsewhere': 3, unchanged: 2, 'updated-at-call': 1 })[x.callState] || 0;
        const worst = rows.slice().sort((a, b) => rank(b) - rank(a))[0];
        grouped.push(N({
          type: 'callerFile', reviewParent: idOf(node),
          label: path.basename(rel),
          relPath: rel,
          file: rows[0].file,
          callers: rows,
          test: rows.every((x) => x.test),
          changed: rows.some((x) => x.changed),
          callState: worst.callState,
          sites: rows.reduce((n2, x) => n2 + (x.sites || 0), 0),
          decorationUri: uriFor(rows[0].file, null),
          path: [...seenPath],
        }));
      }
      if (incomplete) {
        grouped.push(N({
          type: 'message', icon: 'warning',
          label: grouped.length ? 'More callers may be missing' : 'Callers could not be loaded',
          desc: 'refresh to retry', tooltip: incomplete,
        }));
      }
      // Changes declared inside this one are not its callers, so they sit in their own
      // row rather than among the rows that call it.
      if (node.inside && node.inside.length) {
        grouped.unshift(N({
          type: 'insideGroup', label: 'Changed inside', container: node.finding.label,
          file: node.file, relPath: node.finding.relPath, rows: node.inside, members: node.inside.flatMap(membersOf),
        }));
      }
      return grouped;
    },
  };
}
module.exports = { createTreeProvider, LEGEND };
