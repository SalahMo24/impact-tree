'use strict';
const path = require('path');
const { prQuery } = require('./pr-documents');

/**
 * Opening a finding, file, or caller as a document or diff. `review-open.js` decides
 * what to open; this adapter talks to the editor.
 *
 * @param {*} vscode
 * @param {object} session
 */
function createOpenReview(vscode, session) {
  let callSiteDecoration = null;
  function decorationType() {
    if (!callSiteDecoration) {
      callSiteDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        border: '1px solid',
        borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
        borderRadius: '2px',
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Center,
      });
    }
    return callSiteDecoration;
  }

  function rangesFor(file, sites) {
    const { offsetToPosition } = require('./engine/textpos');
    const out = [];
    for (const s2 of sites || []) {
      const a = offsetToPosition(file, s2.start);
      const b = offsetToPosition(file, s2.end);
      if (a && b) out.push(new vscode.Range(a.line, a.character, b.line, b.character));
    }
    return out;
  }

  function sameDoc(a, b) {
    if (!a || !b) return false;
    return a.scheme === b.scheme
      && String(a.path || '').replace(/^\/+/, '') === String(b.path || '').replace(/^\/+/, '')
      && (a.query || '') === (b.query || '');
  }

  async function highlight(file, sites, opened) {
    const ranges = rangesFor(file, sites);
    if (!ranges.length) return;
    // the freshly opened editor (for a diff this is the modified side)
    for (const ed of vscode.window.visibleTextEditors) {
      const u = ed.document.uri;
      const hit = opened ? sameDoc(u, opened) : u.fsPath === file;
      if (hit) ed.setDecorations(decorationType(), ranges);
    }
  }

  function baseUriFor(relPath) {
    // In a Tier A preview the base revision is not in the local object database, so it
    // has to come from the API-fetched text rather than `git show`.
    if (session.isTierA()) return vscode.Uri.from({ scheme: 'impacttree-pr', path: relPath, query: prQuery(session.state.result, 'base') });
    return vscode.Uri.from({ scheme: 'impacttree-base', path: session.state.result.basePaths?.[relPath] || relPath, query: session.state.result.base.sha });
  }

  // The right-hand side of a diff. Locally that is the file on disk; in a Tier A
  // preview the worktree is on some unrelated branch, so showing it would be actively
  // misleading -- serve the PR's own text instead.
  function headUriFor(relPath, absPath) {
    if (session.isTierA()) return vscode.Uri.from({ scheme: 'impacttree-pr', path: relPath, query: prQuery(session.state.result, 'head') });
    return vscode.Uri.file(absPath || path.join(session.repoRoot(), relPath));
  }

  // A changed symbol opens as a diff at its hunk; an unchanged affected caller opens
  // at the call site, because there is nothing to diff there.
  async function openChange(node) {
    const f = node.finding;
    const right = headUriFor(f.relPath, f.file);
    const sel = new vscode.Range(f.startLine - 1, 0, f.startLine - 1, 0);
    const rhs = session.isTierA() ? `PR #${session.state.result.prNumber}` : 'working';
    await vscode.commands.executeCommand('vscode.diff', baseUriFor(f.relPath), right,
      `${path.basename(f.relPath)} (${String(session.state.result.base.sha).slice(0, 7)} ↔ ${rhs})`, { selection: sel });
  }

  // deleted symbols and non-code files: diff against base where possible
  async function openFile(node) {
    const rel = node.relPath;
    const abs = headUriFor(rel);
    const inDiff = session.state && session.state.changedPaths && session.state.changedPaths.has(rel);
    const exists = session.isTierA() || require('fs').existsSync(abs.fsPath);
    try {
      if (!exists) {
        // deleted file: show the base revision alone
        await vscode.window.showTextDocument(baseUriFor(rel), { preview: true });
      } else if (inDiff || node.status) {
        await vscode.commands.executeCommand('vscode.diff', baseUriFor(rel), abs,
          `${require('path').basename(rel)} (${String(session.state.result.base.sha).slice(0, 7)} ↔ ${session.isTierA() ? `PR #${session.state.result.prNumber}` : 'working'})`);
      } else {
        await vscode.window.showTextDocument(abs);
      }
    } catch (e) {
      vscode.window.showWarningMessage(`Impact Tree: cannot open ${rel} — ${e.message}`);
    }
  }

  async function openCaller(node) {
    const { offsetToPosition } = require('./engine/textpos');
    const { callerOpen } = require('./review-open');
    // land on the first call site, not the caller's own declaration -- the call is
    // the thing the reviewer came to look at
    const anchor = (node.callSites && node.callSites[0] && node.callSites[0].start) != null
      ? node.callSites[0].start : node.pos;
    const p = offsetToPosition(node.file, anchor) || { line: 0, character: 0 };
    const sel = new vscode.Range(p.line, p.character, p.line, p.character);
    const rel = session.state && session.state.rel ? session.state.rel(node.file) : null;
    // Diff whenever the FILE differs from base, not just when this symbol changed --
    // that is what surfaces "other changes in the file". Diffing a file identical to
    // base would just show two panes of the same content, so that case opens plain.
    const always = vscode.workspace.getConfiguration('impactTree').get('alwaysDiffCallers', false);
    const fileChanged = !!(rel && session.state.changedPaths && session.state.changedPaths.has(rel));
    const plan = callerOpen({
      tierA: session.isTierA(), rel, baseRel: session.state?.result?.basePaths?.[rel], absPath: node.file, fileChanged, always,
      baseSha: session.state && session.state.result && session.state.result.base && session.state.result.base.sha,
      prNumber: session.state && session.state.result && session.state.result.prNumber,
      headSha: session.state?.result?.headSha,
    });
    const toUri = (spec) => {
      if (spec.scheme === 'file') return vscode.Uri.file(spec.path);
      if (spec.scheme === 'impacttree-pr') return vscode.Uri.from({ scheme: 'impacttree-pr', path: spec.path, query: spec.query });
      return vscode.Uri.from({ scheme: 'impacttree-base', path: spec.path, query: spec.query });
    };
    let opened;
    if (plan.kind === 'diff') {
      opened = toUri(plan.right);
      await vscode.commands.executeCommand('vscode.diff', toUri(plan.left), opened,
        `${require('path').basename(rel)} (${String(session.state.result.base.sha).slice(0, 7)} ↔ ${plan.rhsName})`,
        { selection: sel });
    } else {
      opened = toUri(plan.uri);
      try { await vscode.window.showTextDocument(opened, { selection: sel }); }
      catch { await vscode.commands.executeCommand('vscode.open', opened, { selection: sel }); }
    }
    await highlight(node.file, node.callSites, opened);
  }

  return { openChange, openFile, openCaller };
}

module.exports = { createOpenReview };
