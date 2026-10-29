'use strict';

/**
 * Thin command registrations. Workflows live on the session and open-review adapter.
 *
 * @param {*} vscode
 * @param {object} deps
 * @returns {object[]} disposables
 */
function registerCommands(vscode, {
  BUILD, session, openReview, sources, gh, loadPrs, context, log, out, getSnapshotStore = () => null,
}) {
  const { MODES } = require('../engine/analyze');
  return [
    // Refresh repeats what is being viewed, including a PR preview whose last run failed.
    vscode.commands.registerCommand('impactTree.refresh', () => (session.state.source?.kind === 'pr'
      ? session.previewPullRequest(session.state.source.pr) : session.refresh())),

    vscode.commands.registerCommand('impactTree.selectMode', async () => {
      const pick = await vscode.window.showQuickPick(
        Object.entries(MODES).map(([id, m]) => ({ id, label: m.label, description: m.desc })),
        { title: 'Impact Tree: Choose what to review' });
      if (!pick) return;
      await vscode.workspace.getConfiguration('impactTree').update('mode', pick.id, vscode.ConfigurationTarget.Workspace);
      await session.refresh(pick.id);
    }),

    vscode.commands.registerCommand('impactTree.showLegend', async () => {
      const { LEGEND } = require('../views/changes/tree-provider');
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
      // The Pull Request tab opens with the review it shows, before the analysis ends. It
      // reads the same data the review loads anyway, so a preview costs no extra request.
      const openTab = vscode.workspace.getConfiguration('impactTree').get('openPullRequestTab', true) === true;
      const stopWaiting = openTab && session.openPullRequestTabWhenLoaded ? session.openPullRequestTabWhenLoaded(pr.number) : () => {};
      try {
        if (pick.id === 'preview') await session.previewPullRequest(pr);
        else await session.checkoutAndAnalyse(pr);
      } finally {
        stopWaiting();
      }
    }),

    vscode.commands.registerCommand('impactTree.clearReviewed', async () => {
      const yes = await vscode.window.showWarningMessage(
        `Clear progress for this review? (${session.review.size()} item(s) marked)`, { modal: true }, 'Clear');
      if (yes !== 'Clear') return;
      session.provider.clearReviewed();
    }),

    vscode.commands.registerCommand('impactTree.computeTestReach', async () => {
      if (session.isTierA()) {
        vscode.window.showInformationMessage('Test reachability requires local analysis. The PR preview is unchanged.');
        return;
      }
      await session.refreshWithTestReach();
    }),

    vscode.commands.registerCommand('impactTree.setCheckpoint', async () => {
      const { makeGit } = require('../engine/git');
      const sha = makeGit(session.repoRoot()).revParse('HEAD');
      // A repository with no commit has nothing to record; storing null would read as "no
      // checkpoint" while the message claimed one was set.
      if (!sha) { vscode.window.showWarningMessage('Impact Tree: there is no commit to record as a checkpoint yet'); return; }
      // A snapshot records the working tree, uncommitted work included, in the extension's
      // own storage. Without a store (no storage folder) the checkpoint is the HEAD commit.
      let checkpointSha = sha;
      const store = getSnapshotStore();
      if (store) {
        try {
          const record = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Recording checkpoint…' },
            () => store.take());
          checkpointSha = record.sha;
        } catch (e) {
          log(`checkpoint: snapshot failed: ${e.message}`);
          vscode.window.showErrorMessage(`Impact Tree: could not record the checkpoint (${e.message})`);
          return;
        }
      }
      session.setCheckpoint(checkpointSha);
      await context.workspaceState.update('impactTree.checkpoint', checkpointSha);
      vscode.window.showInformationMessage(`Impact Tree: checkpoint set at ${String(checkpointSha).slice(0, 10)}`);
      // The view may be showing "No checkpoint yet": now there is one, so run the mode it
      // was waiting for. Only for a local review; a PR on screen is not replaced.
      const source = session.state && session.state.source;
      if (vscode.workspace.getConfiguration('impactTree').get('mode', 'pr') === 'checkpoint' && (!source || source.kind === 'local')) {
        await session.refresh();
      }
    }),
    
    vscode.commands.registerCommand('impactTree.openChange', (node) => openReview.openChange(node)),
    vscode.commands.registerCommand('impactTree.openFile', (node) => openReview.openFile(node)),
    vscode.commands.registerCommand('impactTree.openCaller', (node) => openReview.openCaller(node)),
  ];
}

module.exports = { registerCommands };
