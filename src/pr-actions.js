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
 * PR preview (no checkout) and checkout-then-analyse. Both go through the session's
 * lifecycle: a preview is an analysis run like a local refresh, and a checkout claims
 * the worktree from it.
 *
 * @param {*} vscode
 * @param {object} session
 * @param {{ log: (m: string) => void, gh: object, repoSlug: () => object|null, sources: object, prDocuments: object }} opts
 */
function createPrActions(vscode, session, { log, gh, repoSlug, sources, prDocuments }) {

  const { analyzeRemote } = require('./engine/analyze-remote');

  // Tier A: analyse the PR from the API alone. Never touches the worktree, so it is
  // safe to run on any branch, mid-edit, with no confirmation. Replaces any running
  // analysis, as every analysis request does.
  const previewPullRequest = async (pr) => {
    // The source is recorded at begin so that Refresh retries this PR even when the run fails.
    const run = session.beginAnalysisRun({ source: { kind: 'pr', pr }, stage: 'analysing' });
    if (!run) return;
    try {
      await vscode.window.withProgress(
        { location: { viewId: 'impactTree.changes' }, title: `Impact Tree: PR #${pr.number}` },
        async (progress) => {
          const t0 = Date.now();
          const repo = session.repoRoot();
          const cfg = vscode.workspace.getConfiguration('impactTree');
          const ts = loadTypeScriptForPreview(repo);

          const { clearVirtualText } = require('./engine/textpos');
          clearVirtualText();

          const publish = (result) => {
            const currentPr = result.pr || pr;
            if (!session.completeAnalysisRun(run, {
              result, repo, expansionResolver: result.resolver,
              source: { kind: 'pr', pr: currentPr }, viewExtras: { prText: new Map(result.texts) },
            })) return false;
            prDocuments.add(result);
            session.review.configure(`v2:${repo}:pr:${currentPr.number}`,
              require('./review-identity').createReviewIdentity(ts, repo, require('./review-identity').previewRevisions(result)));
            session.provider.refresh();
            return true;
          };

          const result = await analyzeRemote({
            ts, gh, slug: repoSlug(), pr, repoRoot: repo,
            maxFiles: cfg.get('tierA.maxFiles', 300),
            concurrency: cfg.get('concurrency', 8),
            onPrepared: (pending) => {
              if (publish(pending)) log(`tier A: changed files ready in ${Date.now() - t0}ms; caller analysis continues`);
            },
            onProgress: (p2) => { if (!run.signal.aborted) progress.report({
              message: p2.total ? `${p2.message} ${p2.done}/${p2.total}` : p2.message,
            }); },
            trace: (m) => { if (!run.signal.aborted) log(`  tierA · ${m}`); },
            signal: run.signal,
          });

          pr = result.pr || pr;
          // Text for the diff views, keyed the way the content provider looks it up.
          if (!publish(result)) return;

          log(`tier A: PR #${pr.number} ${result.changedFileCount} file(s), `
            + `${result.allChanged.length} changed symbol(s), ${result.findings.length} finding(s) `
            + `in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          result.warnings.forEach((w) => log(`  warn: ${w}`));
          const st = result.resolver ? result.resolver.stats() : {};
          if (st.indexedFiles != null) {
            log(`  indexed ${st.indexedFiles} PR file(s); ${st.unknownTarget || 0} symbol(s) not in the index`);
          }

          vscode.window.setStatusBarMessage(
            `Impact Tree: PR #${pr.number} preview — ${result.findings.length} finding(s), PR files only`, 8000);
        });
    } catch (e) {
      session.failAnalysisRun(run, e, { viewError: `PR #${pr.number}: ${e.message}`, logLabel: 'ERROR tier A' });
    } finally {
      session.releaseAnalysisRunResources(run);
    }
  };

  // Checking out rewrites the worktree, so this states the exact effect and the branch
  // it is leaving before doing anything. `pull/N/head` works for forks too, which a
  // plain `fetch origin <headRef>` would not. A running analysis does not block it: the
  // checkout cancels it once confirmed, and git waits until it has settled.
  const checkoutAndAnalyse = async (pr) => {
    const refuse = () => {
      const busy = session.checkoutInProgress();
      if (busy != null) {
        vscode.window.showWarningMessage(`Impact Tree: PR #${busy} is being checked out — try checking out PR #${pr.number} when it finishes`);
      }
      return busy != null;
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
    if (refuse()) return;                   // another checkout started while the dialog was open
    let checkout = null;
    let sha;
    try {
      checkout = await session.beginCheckout(pr.number);
      if (!checkout) return;                // the window closed while the analysis settled
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
      if (session.getPhase() !== 'disposed') vscode.window.showErrorMessage(`Impact Tree: checkout failed — ${e.message}`);
      return;
    } finally {
      session.endCheckout(checkout);
    }
    if (session.getPhase() === 'disposed') return;
    log(`checked out PR #${pr.number} (${pr.headRef}) at ${sha.slice(0, 10)} from '${was}'`);
    vscode.window.showInformationMessage(
      `Impact Tree: on PR #${pr.number}. Return with: git checkout ${was}`);
    sources.refresh();
    await session.analyseCheckedOutPr(pr, sha);
  };

  return { previewPullRequest, checkoutAndAnalyse };
}

module.exports = { createPrActions };
