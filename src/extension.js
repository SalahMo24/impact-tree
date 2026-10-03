'use strict';
const vscode = require('vscode');
const { MODES } = require('./engine/analyze');
const { createTreeProvider } = require('./tree-provider');
const { createDecorationProvider } = require('./decorations');
const { createReviewState } = require('./review-state');
const { createGitHub, parseRemote } = require('./github');
const { createSourcesProvider } = require('./sources-provider');
const { createPrDocuments } = require('./pr-documents');
const { createSession } = require('./session');
const { createPrActions } = require('./pr-actions');
const { createOpenReview } = require('./open-review');
const { registerContentProviders } = require('./content-providers');
const { registerCommands } = require('./commands');

// Bumped whenever extension-side behaviour changes, so the exthost log proves which
// build is actually loaded instead of us inferring it from timestamps.
const BUILD = '0.1.0+correctness-and-perf';

let session = null;
let prDocuments = null;
let out = null;
const log = (m) => { if (out) out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };

function activate(context) {
  const review = createReviewState(context.workspaceState);
  // The disposable holds its own reference: deactivate() drops the module's before the
  // editor disposes the subscriptions.
  const documents = createPrDocuments();
  prDocuments = documents;
  context.subscriptions.push({ dispose: () => documents.clear() });
  out = vscode.window.createOutputChannel('Impact Tree');
  context.subscriptions.push(out);
  log(`activated  build=${BUILD}  resolver=vscode-callhierarchy  openTextDocument=never`);

  // Local, so the closures below keep this activation's session after deactivate().
  const owned = createSession(vscode, { log, review, checkpoint: context.workspaceState.get('impactTree.checkpoint') });
  session = owned;

  const decorate = createDecorationProvider(vscode);
  session.decorate = decorate;
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorate));
  const provider = createTreeProvider(vscode, {
    decorate,
    review,
    isBusy: owned.isBusy,
    getPhase: owned.getPhase,
    getState: () => owned.state,
    getAnalysisId: owned.getAnalysisId,
    isCurrentAnalysis: owned.isCurrentAnalysis,
    resolver: owned.treeResolver,
  });
  session.provider = provider;
  const view = vscode.window.createTreeView('impactTree.changes',
    { treeDataProvider: provider, showCollapseAll: true, manageCheckboxStateManually: true });
  context.subscriptions.push(view);
  context.subscriptions.push(view.onDidChangeCheckboxState((e) => {
    for (const [node, state] of e.items) {
      const id = review.id(node);
      if (!id) continue;
      const on = state === vscode.TreeItemCheckboxState.Checked;
      // A file or "changed inside" group ticks its changes and, as ticking each of
      // them would, the callers already known under them.
      const kids = review.childIds(node).concat((node.members || []).flatMap((m) => review.childIds(m)));
      review.setWithChildren(id, kids, on);
    }
    provider.refresh();
  }));

  // ---- source picker: local modes and open pull requests -------------------
  const gh = createGitHub(vscode, { log });
  let prs = [];
  let prsTruncated = false;
  let prError = null;
  let loadingPrs = false;

  const repoSlug = () => {
    try {
      const { makeGit } = require('./engine/git');
      const url = makeGit(session.repoRoot()).tryRaw(['remote', 'get-url', 'origin']);
      return parseRemote(url);
    } catch { return null; }
  };

  const sources = createSourcesProvider(vscode, {
    modes: MODES,
    getMode: () => vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'),
    getRepoSlug: repoSlug,
    github: gh,
    getPrs: () => prs,
    getPrsTruncated: () => prsTruncated,
    getPrError: () => prError,
    isLoadingPrs: () => loadingPrs,
  });
  context.subscriptions.push(vscode.window.createTreeView('impactTree.sources',
    { treeDataProvider: sources }));

  const loadPrs = async () => {
    const slug = repoSlug();
    if (!slug || !gh.isSignedIn()) { sources.refresh(); return; }
    loadingPrs = true; prError = null; sources.refresh();
    try {
      ({ pullRequests: prs, truncated: prsTruncated } = await gh.listOpenPullRequests(slug));
      log(`github: ${prs.length} open PR(s) in ${slug.owner}/${slug.repo}${prsTruncated ? ' (list truncated)' : ''}`);
    } catch (e) {
      prs = []; prsTruncated = false; prError = e.message;
      log(`github: ${e.message}`);
    } finally {
      loadingPrs = false; sources.refresh();
    }
  };

  const { previewPullRequest, checkoutAndAnalyse } = createPrActions(vscode, session, {
    log, gh, repoSlug, sources, prDocuments,
  });
  session.previewPullRequest = previewPullRequest;
  session.checkoutAndAnalyse = checkoutAndAnalyse;

  const openReview = createOpenReview(vscode, session);

  // Restore an existing session silently so a returning user sees their PRs without
  // being prompted; never pop a sign-in modal on startup.
  gh.signIn().then((sess) => { if (sess) loadPrs(); else sources.refresh(); });

  context.subscriptions.push(
    ...registerCommands(vscode, {
      BUILD, session, openReview, sources, gh, loadPrs, context, log, out,
    }),
    ...registerContentProviders(vscode, { prDocuments, repoRoot: () => session.repoRoot(), gh, repoSlug }),
  );

  if (vscode.workspace.getConfiguration('impactTree').get('prewarm', true)) {
    const timer = setTimeout(() => {
      log('preparing in the background so the first refresh is fast');
      owned.prewarmInBackground().catch((e) => log(`prewarm failed: ${e.message}`));
    }, 2000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
  if (vscode.workspace.getConfiguration('impactTree').get('analyseOnStartup', false)) session.refresh();
}

function deactivate() {
  if (session) session.dispose();
  session = null;
  if (prDocuments) prDocuments.clear();
  prDocuments = null;
}

module.exports = { activate, deactivate };
