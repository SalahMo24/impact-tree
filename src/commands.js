'use strict';

/**
 * Thin command registrations. Workflows live on the session and open-review adapter.
 *
 * @param {*} vscode
 * @param {object} deps
 * @returns {object[]} disposables
 */
function registerCommands(vscode, {
  BUILD, session, openReview, sources, gh, loadPrs, context, log, out,
}) {
  const { MODES } = require('./engine/analyze');
  return [
    // Refresh repeats what is being viewed, including a PR preview whose last run failed.
    vscode.commands.registerCommand('impactTree.refresh', () => (session.state.source?.kind === 'pr'
      ? session.previewPullRequest(session.state.source.pr) : session.refresh())),

    vscode.commands.registerCommand('impactTree.selectMode', async () => {
      const pick = await vscode.window.showQuickPick(
        Object.entries(MODES).map(([id, m]) => ({ label: id, description: m.desc })),
        { title: 'Impact Tree: diff mode' });
      if (!pick) return;
      await vscode.workspace.getConfiguration('impactTree').update('mode', pick.label, vscode.ConfigurationTarget.Workspace);
      await session.refresh(pick.label);
    }),

    vscode.commands.registerCommand('impactTree.showLegend', async () => {
      const { LEGEND } = require('./tree-provider');
      await vscode.window.showQuickPick(
        LEGEND.map(([icon, label, desc]) => ({ label: `$(${icon})  ${label}`, detail: desc || undefined })),
        { title: `Impact Tree legend — build ${BUILD}`, placeHolder: 'marker reference (Esc to close)' });
    }),

    vscode.commands.registerCommand('impactTree.showLog', () => { if (out) out.show(true); }),

    vscode.commands.registerCommand('impactTree.analyseMode', async (mode) => {
      await vscode.workspace.getConfiguration('impactTree').update('mode', mode, vscode.ConfigurationTarget.Workspace);
      sources.refresh();
      await session.refresh(mode);
    }),

    vscode.commands.registerCommand('impactTree.githubSignIn', async () => {
      const sess = await gh.signIn({ interactive: true });
      if (!sess) { vscode.window.showWarningMessage('Impact Tree: GitHub sign-in was cancelled'); return; }
      log(`github: signed in as ${gh.account()}`);
      await loadPrs();
    }),

    vscode.commands.registerCommand('impactTree.refreshPullRequests', () => loadPrs()),

    vscode.commands.registerCommand('impactTree.openPullRequest', async (pr) => {
      const pick = await vscode.window.showQuickPick([
        { label: '$(eye) Preview impact (no checkout)',
          detail: 'builds the tree from the PR\'s own files via the GitHub API — your worktree is untouched',
          id: 'preview' },
        { label: '$(git-pull-request) Check out and analyse',
          detail: `checks out PR #${pr.number} (${pr.headRef}) into a detached HEAD, then builds the impact tree against ${pr.baseRef}`,
          id: 'analyse' },
        { label: '$(link-external) Open on GitHub', detail: pr.url, id: 'open' },
      ], { title: `#${pr.number}  ${pr.title}` });
      if (!pick) return;
      if (pick.id === 'open') { await vscode.env.openExternal(vscode.Uri.parse(pr.url)); return; }
      if (pick.id === 'preview') { await session.previewPullRequest(pr); return; }
      await session.checkoutAndAnalyse(pr);
    }),

    vscode.commands.registerCommand('impactTree.clearReviewed', async () => {
      const yes = await vscode.window.showWarningMessage(
        `Clear progress for this review? (${session.review.size()} item(s) marked)`, { modal: true }, 'Clear');
      if (yes !== 'Clear') return;
      session.review.clear();
      session.provider.refresh();
    }),

    vscode.commands.registerCommand('impactTree.computeTestReach', async () => {
      if (session.isTierA()) {
        vscode.window.showInformationMessage('Test reachability requires local analysis. The PR preview is unchanged.');
        return;
      }
      session.state = { ...session.state, wantTestReach: true };
      await session.refresh();
    }),

    vscode.commands.registerCommand('impactTree.setCheckpoint', async () => {
      const { makeGit } = require('./engine/git');
      const sha = makeGit(session.repoRoot()).revParse('HEAD');
      session.state = { ...session.state, checkpoint: sha };
      await context.workspaceState.update('impactTree.checkpoint', sha);
      vscode.window.showInformationMessage(`Impact Tree: checkpoint set at ${String(sha).slice(0, 10)}`);
    }),
    
    vscode.commands.registerCommand('impactTree.openChange', (node) => openReview.openChange(node)),
    vscode.commands.registerCommand('impactTree.openFile', (node) => openReview.openFile(node)),
    vscode.commands.registerCommand('impactTree.openCaller', (node) => openReview.openCaller(node)),
  ];
}

module.exports = { registerCommands };
