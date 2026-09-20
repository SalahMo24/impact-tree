'use strict';
const path = require('path');

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
  ['pass', '✓  all call sites updated', 'or the symbol has no callers'],
  ['warning', '△  caller changed, but NOT on the call line', 'looks handled and is not'],
  ['circle-outline', '○  caller not changed at all', 'affected but untouched'],
  ['question', '?  callers unknown', 'value-passed or DI-constructed, never called directly'],
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

function createTreeProvider(vscode, { getState, resolver, isBusy = () => false, decorate = null, getPhase = () => 'ready' }) {
  // file:///path#offset — unique per symbol so decorations do not collide, while the
  // icon theme still matches on the extension
  const uriFor = (file, pos) => {
    if (!file) return null;
    const u = vscode.Uri.file(file);
    return pos == null ? u : u.with({ fragment: String(pos) });
  };
  // The GitHub PR extension groups with a real folder hierarchy rather than spacing
  // (githubPullRequests.fileListLayout: "tree" | "flat", default "tree"). Blank rows
  // were a poor substitute: selectable, keyboard-navigable and visually noisy.
  const layout = () => {
    const st = getState();
    return (st && st.fileListLayout) || 'tree';
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
    const emit = (node, prefix, segs) => {
      const out = [];
      for (const [name, child] of node.dirs) {
        const nextSegs = [...segs, name];
        const nextPrefix = prefix ? `${prefix}/${name}` : name;
        // compact: a directory with exactly one subdirectory and no files merges down
        if (child.dirs.size === 1 && child.files.length === 0) {
          out.push(...emit({ dirs: child.dirs, files: [] }, nextPrefix, nextSegs));
          continue;
        }
        out.push({ type: 'dir', label: nextSegs.join('/'), dirPath: nextPrefix, node: child });
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out.concat(node.files.sort((a, b) => a.label.localeCompare(b.label)));
    };
    return emit(root, '', []);
  };
  const childrenOfDir = (node) => {
    const out = [];
    for (const [name, child] of node.dirs) {
      if (child.dirs.size === 1 && child.files.length === 0) {
        const only = [...child.dirs.keys()][0];
        out.push({ type: 'dir', label: `${name}/${only}`, node: child.dirs.get(only) });
        continue;
      }
      out.push({ type: 'dir', label: name, node: child });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out.concat(node.files.sort((a, b) => a.label.localeCompare(b.label)));
  };
  const statusOfPath = (st, relPath) => (st && st.result && st.result.fileStatus ? st.result.fileStatus[relPath] : undefined);
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
    if (f.staleCallers > 0) {
      const e = f.staleChangedElsewhere || 0;
      return { token: '⛔', severity: 'stale',
        marker: `${f.staleCallers} call site(s) not updated${e ? ` (${e} edited nearby)` : ''}` };
    }
    if (f.callerState === 'unknown') return { token: '?', severity: 'warn', marker: 'callers unknown' };
    if (f.callerState === 'di') return { token: '?', severity: 'muted', marker: 'DI-constructed' };
    return { token: '✓', severity: 'ok', marker: 'all call sites updated' };
  }

  function toItem(n) {
    if (n.type === 'file') {
      const item = n.absPath
        ? new vscode.TreeItem(vscode.Uri.file(n.absPath), vscode.TreeItemCollapsibleState.None)
        : new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
      item.description = layout() === 'flat'
        ? `${path.dirname(n.relPath)}`
        : inline(`${n.status}  ·  ${path.dirname(n.relPath)}`);
      item.tooltip = new vscode.MarkdownString([`**${path.basename(n.relPath)}**`, '', `_${n.status}_`, '', `\`${n.relPath}\``].join('\n'));
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
      const f = n.finding;
      const st = statusOf(f);
      const kinds = f.kinds.filter((k) => k.id !== 'body').map((k) => k.short || k.label);
      // marker first, then the short kind list — both survive truncation
      const qual = n.ambiguous ? `  ·  ${f.component}` : '';
      item.description = rowDesc(st.token,
        `${st.token}  ${st.marker}${qual}${kinds.length ? '  ·  ' + kinds.join(', ') : ''}`);
      if (n.ambiguous) item.label = `${f.label}  ‹${f.component}›`;
      item.iconPath = rowIcon(f.label, f);
      // the row is deliberately bare, so the tooltip must carry the whole story
      item.tooltip = new vscode.MarkdownString([
        `${st.token} **${f.label}**`,
        '',
        `${st.marker}`,
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
        '', `_score ${f.score}_`,
      ].join('\n'));
      item.contextValue = 'finding';
      item.command = { command: 'impactTree.openChange', title: 'Open change', arguments: [n] };
      return item;
    }
    // caller
    const cs = CALL_STATE[n.callState] || CALL_STATE.unchanged;
    const base = path.basename(n.relPath || n.file);
    const tok = n.cycle ? '↑' : n.test ? '🧪' : cs.token;
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
      ...(n.callState === 'changed-elsewhere'
        ? ['', '---', '', 'This caller **was** edited in this change, but not on the line that calls the changed symbol — it may still need updating.']
        : []),
    ].join('\n'));
    item.contextValue = n.changed ? 'changedCaller' : 'caller';
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
        out.push(N({
          type: 'summary',
          label: `${(r.allChanged || []).length} changed symbol${(r.allChanged || []).length === 1 ? '' : 's'}`,
          desc: `${r.findings.length} finding(s)  ·  ${stale} call site(s) not updated  ·  ${r.mode}  ·  ${r.base.ref}`,
          tooltip: `mode '${r.mode}'${r.requestedMode && r.requestedMode !== r.mode ? ` (requested '${r.requestedMode}')` : ''}\nbase ${r.base.ref} @ ${String(r.base.sha).slice(0, 10)}\n${r.changedFileCount} analysed file(s), ${(r.otherFiles || []).length} not analysed`,
        }));
        for (const w of r.warnings) out.push(N({ type: 'message', label: w, icon: 'warning' }));
        for (const u of r.unanalysable) {
          out.push(N({ type: 'message', icon: 'circle-slash',
            label: `${u.count} file(s) in '${u.component}' not analysed`, desc: 'no node_modules installed' }));
        }
        // Sections, so a body-only change is visible without competing with findings
        out.push(N({ type: 'section', key: 'findings', label: 'Findings', count: findingRoots.length,
          icon: 'warning',
          desc: `signature, throw or deletion risk${nestedFindings ? `  ·  ${nestedFindings} nested under its callee` : ''}` }));
        out.push(N({ type: 'section', key: 'other', label: 'Other changes', count: other.length,
          icon: 'edit',
          desc: `body-only edits${nestedOther ? `  ·  ${nestedOther} nested under their callee` : ''}` }));
        out.push(N({ type: 'section', key: 'deleted', label: 'Deleted', count: r.deleted.length, icon: 'trash', desc: '' }));
        out.push(N({ type: 'section', key: 'untested', label: 'No test reaches',
          count: r.testReachComputed ? r.untested.length : 0, icon: 'beaker',
          computed: r.testReachComputed,
          desc: r.testReachComputed ? '' : 'not computed — expand to run' }));
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
        if (node.key === 'other') return (r.allChanged || []).filter((c) => !r.findings.includes(c)).filter(isRoot).map(mk);
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
            return N({ type: 'deleted', label: d.label, relPath: d.relPath, file: d.file, decorationUri: uri });
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
      if (node.type === 'dir') return childrenOfDir(node.node);
      if (node.type === 'message' || node.type === 'summary' || node.type === 'legendItem'
        || node.type === 'deleted' || node.type === 'file' || node.cycle) return [];
      const state2 = getState();
      const seenPath = new Set(node.path || []);
      seenPath.add(`${node.file}#${node.pos}`);
      let callers = [];
      try { callers = await resolver.incoming(node.file, node.pos, true); } catch { callers = []; }
      const changedKeys = (state2 && state2.changedKeys) || new Set();
      if (decorate) setTimeout(() => decorate.flush(), 0);
      const built = callers.map((c) => {
        const symChanged = changedKeys.has(`${c.file}#${c.pos}`);
        const atCall = state2 && state2.callSiteUpdated ? state2.callSiteUpdated(c.file, c.callSites) : false;
        const callState = atCall ? 'updated-at-call' : symChanged ? 'changed-elsewhere' : 'unchanged';
        const rel = state2 ? state2.rel(c.file) : c.file;
        const uri = uriFor(c.file, c.pos);
        mark(uri, statusOfPath(state2, rel), c.test ? 'muted' : (CALL_STATE[callState] || {}).severity, rel);
        return N({
          type: 'caller', label: c.label, file: c.file, pos: c.pos, test: c.test,
          callSites: c.callSites || [], sites: c.sites,
          relPath: rel, changed: symChanged, callState, decorationUri: uri,
          cycle: seenPath.has(`${c.file}#${c.pos}`),
          path: [...seenPath],
        });
      });
      return built.sort((a, b) => (a.relPath || '').localeCompare(b.relPath || '')
        || a.label.localeCompare(b.label));
    },
  };
}
module.exports = { createTreeProvider, LEGEND };
