'use strict';

// Unlike analyze.js's tryLoadTypeScript, a preview cannot skip TypeScript and
// continue. Load from the repo root or abort the run.
function loadTypeScriptForPreview(repo) {
  const { loadTypeScript } = require('./engine/analyze');
  try {
    return loadTypeScript(repo, repo);
  } catch (e) {
    throw new Error(`Tier A needs TypeScript: ${e.message}`);
  }
}

/**
 * PR preview (no checkout) and checkout-then-analyse. Shares the session's in-flight
 * and checkout locks with local refresh.
 *
 * @param {*} vscode
 * @param {object} session
 * @param {{ log: (m: string) => void, gh: object, repoSlug: () => object|null, sources: object, prDocuments: object }} opts
 */
function createPrActions(vscode, session, { log, gh, repoSlug, sources, prDocuments }) {

  const { analyzeRemote } = require('./engine/analyze-remote');

  // Tier A: analyse the PR from the API alone. Never touches the worktree, so it is
  // safe to run on any branch, mid-edit, with no confirmation.
  const previewPullRequest = async (pr) => {
    if (session.refuseDuringCheckout()) return;
    if (session.inFlight) { vscode.window.showWarningMessage('Impact Tree: an analysis is already running'); return; }
    // Recorded before the run so that Refresh retries this PR even when the run fails.
    session.state = { ...session.state, source: { kind: 'pr', pr } };
    session.busy = true; session.decorate.clear(); session.provider.refresh();
    session.inFlight = (async () => {
      try {
        await vscode.window.withProgress(
          { location: { viewId: 'impactTree.changes' }, title: `Impact Tree: PR #${pr.number}` },
          async (progress) => {
            session.phase = 'analysing';
            const t0 = Date.now();
            const repo = session.repoRoot();
            const cfg = vscode.workspace.getConfiguration('impactTree');
            const ts = loadTypeScriptForPreview(repo);

            const { clearVirtualText } = require('./engine/textpos');
            clearVirtualText();

            const result = await analyzeRemote({
              ts, gh, slug: repoSlug(), pr, repoRoot: repo,
              maxFiles: cfg.get('tierA.maxFiles', 300),
              concurrency: cfg.get('concurrency', 8),
              onProgress: (p2) => progress.report({
                message: p2.total ? `${p2.message} ${p2.done}/${p2.total}` : p2.message,
              }),
              trace: (m) => log(`  tierA · ${m}`),
            });

            pr = result.pr || pr;
            session.state = { ...session.state, source: { kind: 'pr', pr } };
            prDocuments.add(result);

            // Text for the diff views, keyed the way the content provider looks it up.
            const prText = new Map();
            for (const [rel, t] of result.texts) prText.set(rel, t);

            log(`tier A: PR #${pr.number} ${result.changedFileCount} file(s), `
              + `${result.allChanged.length} changed symbol(s), ${result.findings.length} finding(s) `
              + `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            result.warnings.forEach((w) => log(`  warn: ${w}`));
            const st = result.resolver ? result.resolver.stats() : {};
            if (st.indexedFiles != null) {
              log(`  indexed ${st.indexedFiles} PR file(s); ${st.unknownTarget || 0} symbol(s) not in the index`);
            }

            session.resolverOverride = result.resolver;
            session.viewStateFromResult(result, repo, { prText });
            session.review.configure(`v2:${repo}:pr:${pr.number}`,
              require('./review-identity').createReviewIdentity(ts, repo, require('./review-identity').previewRevisions(result)));
            vscode.window.setStatusBarMessage(
              `Impact Tree: PR #${pr.number} preview — ${result.findings.length} finding(s), PR files only`, 8000);
          });
      } catch (e) {
        session.state = { ...session.state, result: null, error: `PR #${pr.number}: ${e.message}` };
        log(`ERROR tier A ${e.stack || e.message}`);
        vscode.window.showErrorMessage(`Impact Tree: ${e.message}`);
      } finally {
        session.phase = 'ready'; session.busy = false; session.inFlight = null; session.provider.refresh();
      }
    })();
    return session.inFlight;
  };

  // Checking out rewrites the worktree, so this states the exact effect and the branch
  // it is leaving before doing anything. `pull/N/head` works for forks too, which a
  // plain `fetch origin <headRef>` would not.
  const checkoutAndAnalyse = async (pr) => {
    const busyWith = () => (session.checkingOut != null ? `PR #${session.checkingOut} is being checked out`
      : session.inFlight ? 'an analysis is running' : null);
    const refuse = () => {
      const why = busyWith();
      if (why) vscode.window.showWarningMessage(`Impact Tree: ${why} — try checking out PR #${pr.number} when it finishes`);
      return !!why;
    };
    if (refuse()) return;
    const { makeGit } = require('./engine/git');
    const git = makeGit(session.repoRoot());
    const dirty = git.isDirty();
    if (dirty.length) {
      vscode.window.showErrorMessage(
        `Impact Tree: ${dirty.length} uncommitted change(s) — commit or stash before checking out PR #${pr.number}.`);
      return;
    }
    const was = git.currentBranch();
    const yes = await vscode.window.showWarningMessage(
      `Check out PR #${pr.number} (${pr.headRef})?`,
      { modal: true, detail: `This leaves '${was}' and moves the worktree to a detached HEAD.` },
      'Check out');
    if (yes !== 'Check out') return;
    if (refuse()) return;                   // something started while the dialog was open
    session.checkingOut = pr.number;
    let sha;
    try {
      await vscode.window.withProgress(
        { location: { viewId: 'impactTree.sources' }, title: `Fetching PR #${pr.number}` },
        async () => {
          await git.rawAsync(['fetch', 'origin', `pull/${pr.number}/head`, '--quiet'],
            { timeoutMs: 60000, env: require('./engine/git').FETCH_ENV });
          // Pin the fetched commit at once: FETCH_HEAD is rewritten by any later fetch.
          sha = (await git.rawAsync(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
          await git.rawAsync(['checkout', '--detach', sha, '--quiet']);
        });
    } catch (e) {
      vscode.window.showErrorMessage(`Impact Tree: checkout failed — ${e.message}`);
      return;
    } finally {
      session.checkingOut = null;
    }
    log(`checked out PR #${pr.number} (${pr.headRef}) at ${sha.slice(0, 10)} from '${was}'`);
    vscode.window.showInformationMessage(
      `Impact Tree: on PR #${pr.number}. Return with: git checkout ${was}`);
    sources.refresh();
    await session.refresh('pr', { base: pr.baseRef });
  };

  return { previewPullRequest, checkoutAndAnalyse };
}

module.exports = { createPrActions };
