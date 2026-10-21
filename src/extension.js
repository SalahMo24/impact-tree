'use strict';
const path = require('path');
const fs = require('fs');
const vscode = require('vscode');
const { MODES } = require('./engine/analyze');
const { createTreeProvider } = require('./tree-provider');
const { createReviewNavigation } = require('./review-navigation');
const { createDetailPanel } = require('./detail-panel');
const { createReviewLens } = require('./review-lens');
const { readLineOfOffset, offsetToPosition } = require('./engine/textpos');
const { createDecorationProvider } = require('./decorations');
const { createReviewState } = require('./review-state');
const { createGitHub } = require('./github');
const { parseRemoteList, chooseGitHubRemote, describeRemoteProblem, baseRemoteOf } = require('./github-remote');
const { createSourcesProvider } = require('./sources-provider');
const { createPrDocuments } = require('./pr-documents');
const { createSession } = require('./session');
const { createSnapshotStoreGetter } = require('./snapshot-storage');
const { createPrActions } = require('./pr-actions');
const { createPullRequestReviewStore, reviewTargetOf } = require('./pr-review-store');
const { createViewedSync } = require('./viewed-sync');
const { createOpenReview } = require('./open-review');
const { threadsViewOf, NO_THREADS } = require('./review-threads');
const { createReviewComments } = require('./review-comments');
const { createPullRequestPanel } = require('./pr-overview-panel');
const { registerContentProviders } = require('./content-providers');
const { registerCommands } = require('./commands');
const { contextKeysOf } = require('./view-state');
const { createFeedbackDrafts } = require('./feedback-drafts');
const { createFeedbackComments } = require('./feedback-comments');
const { createFeedbackStatus, SHOW_DRAFTS_COMMAND } = require('./feedback-tree');
const { createFeedbackRoundView } = require('./feedback-round-view');
const { createSendFeedback } = require('./feedback-send');
const { createAutoCleanup, createCleanupCommand } = require('./storage-cleanup-run');

// Bumped whenever extension-side behaviour changes, so the exthost log proves which
// build is actually loaded instead of us inferring it from timestamps.
const BUILD = '0.1.0+targeted-review-updates';

let session = null;
let prDocuments = null;
let out = null;
const log = (m) => { if (out) out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };

function activate(context) {
  const review = createReviewState(context.workspaceState, { log });
  // The disposable holds its own reference: deactivate() drops the module's before the
  // editor disposes the subscriptions.
  const documents = createPrDocuments();
  prDocuments = documents;
  context.subscriptions.push({ dispose: () => documents.clear() });
  out = vscode.window.createOutputChannel('Impact Tree');
  context.subscriptions.push(out);
  log(`activated  build=${BUILD}  resolver=vscode-callhierarchy  openTextDocument=never`);

  // Local, so the closures below keep this activation's session after deactivate().
  // Snapshot checkpoints live in the extension's per-workspace storage, never in .git. Without a
  // storage folder there is no store and a checkpoint stays a plain HEAD commit.
  const getSnapshotStore = createSnapshotStoreGetter(context, () => owned.repoRoot(), log);
  const getObjectDirs = () => { const s = getSnapshotStore(); return s ? s.objectDirs() : []; };
  const getTempDir = () => { const s = getSnapshotStore(); return s ? s.tempDir() : undefined; };
  const owned = createSession(vscode, { log, review, checkpoint: context.workspaceState.get('impactTree.checkpoint'), getObjectDirs, getTempDir });
  session = owned;
  getSnapshotStore();   // creates the store and sweeps leftover temporary files in the background
  // The last sent round's read-back (F4); created below, once the tree exists.
  /** @type {ReturnType<typeof createFeedbackRoundView>|null} */
  let feedbackRound = null;
  // Feedback drafts on local reviews (F1), kept in workspace state; disposed with the window.
  const feedbackDrafts = createFeedbackDrafts(context.workspaceState, { log });
  context.subscriptions.push(feedbackDrafts);

  const decorate = createDecorationProvider(vscode);
  session.decorate = decorate;
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorate));
  // The review store is created below, once GitHub is; until then no review has threads.
  let reviewStore = null;
  // Created once the review store exists; a file row asks it what to say about GitHub's viewed mark.
  /** @type {ReturnType<typeof createViewedSync>|null} */
  let viewedSync = null;
  // Whether the window has a folder and a repository: asked at activation, when the folders
  // change and whenever a run begins (so `git init` then Refresh is noticed), not on every repaint.
  let repoStatus = owned.repoStatus();
  const provider = createTreeProvider(vscode, {
    getRepoStatus: () => repoStatus,
    getThreads: () => (reviewStore ? threadsViewOf(reviewStore.getState()) : NO_THREADS),
    decorate,
    viewedOf: (relPath, allTicked) => (viewedSync ? viewedSync.statusOf(relPath, allTicked) : null),
    review,
    isBusy: owned.isBusy,
    getPhase: owned.getPhase,
    getState: () => owned.state,
    getAnalysisId: owned.getAnalysisId,
    isCurrentAnalysis: owned.isCurrentAnalysis,
    resolver: owned.treeResolver,
    getFeedbackDrafts: () => feedbackDrafts.list(),
    getFeedbackRound: () => (feedbackRound ? feedbackRound.current() : null),
  });
  session.provider = provider;
  context.subscriptions.push(provider, decorate);
  const view = vscode.window.createTreeView('impactTree.changes',
    { treeDataProvider: provider, showCollapseAll: true, manageCheckboxStateManually: true });
  context.subscriptions.push(view);
  const navigation = createReviewNavigation(vscode, { provider, view });
  context.subscriptions.push(...navigation.disposables);
  // Details starts comments and opens threads through the review comments, and starts
  // feedback drafts through the feedback comments, both created below.
  let reviewComments = null;
  let feedbackComments = null;
  const details = createDetailPanel(vscode, { provider, view, getState: () => owned.state, lineOf: readLineOfOffset, log,
    reviewActions: () => reviewComments, feedbackActions: () => feedbackComments,
    checkoutAndAnalyse: (pr) => session.checkoutAndAnalyse(pr) });
  context.subscriptions.push(...details.disposables);
  // Counts follow presentation and progress events, independently of tree repaint scope.
  const showSummary = () => {
    const summary = provider.summarize();
    const { badge } = summary;
    // While a run waits for the first index, the view says so, with the elapsed seconds,
    // after the counts the reviewer is already using.
    const indexing = owned.getIndexingText();
    const message = indexing === null ? summary.message : summary.message ? `${summary.message} · ${indexing}` : indexing;
    if (view.message !== message) view.message = message;
    if (view.badge?.value !== badge?.value || view.badge?.tooltip !== badge?.tooltip) view.badge = badge;
    navigation.update();
  };
  context.subscriptions.push(provider.onDidChangePresentation(showSummary), provider.onDidChangeReview(showSummary),
    provider.onDidChangeThreads(showSummary));
  showSummary();
  context.subscriptions.push(owned.onDidChangeIndexing(showSummary));

  // The welcome screens (package.json `viewsWelcome`) are chosen by these context keys.
  // Sent only when a value changes: setContext is a round trip to the workbench.
  /** @type {Map<string, string>} */
  const contextSent = new Map();
  const publishContext = () => {
    const keys = { ...contextKeysOf({ repo: repoStatus, phase: owned.getPhase(), busy: owned.isBusy(), state: owned.state }),
      // F3 hangs the title bar's Send feedback on it.
      'impactTree.hasFeedbackDrafts': feedbackDrafts.list().length > 0 };
    for (const [key, value] of Object.entries(keys)) {
      if (contextSent.get(key) === value) continue;
      contextSent.set(key, value);
      Promise.resolve(vscode.commands.executeCommand('setContext', key, value))
        .then(undefined, (e) => log(`could not set context ${key}: ${e && e.message}`));
    }
  };
  const recheckRepo = () => {
    const next = owned.repoStatus();
    if (next === repoStatus) return;
    repoStatus = next;
    provider.refresh();
    sources.refresh();
  };
  context.subscriptions.push(provider.onDidChangePresentation(publishContext),
    owned.onDidChangeAnalysis(() => { recheckRepo(); publishContext(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { recheckRepo(); publishContext(); }));
  context.subscriptions.push(view.onDidChangeCheckboxState((e) => {
    const started = Date.now();
    // A file's checkbox ticks its changes; a change's ticks only itself, not its callers.
    provider.setCheckedBatch(e.items.map(([row, state]) => ({ row, on: state === vscode.TreeItemCheckboxState.Checked })));
    log(`checkbox: ${e.items.length} row(s), analysis=${owned.getAnalysisId()}, ${Date.now() - started}ms`);
  }));

  // ---- source picker: local modes and open pull requests -------------------
  const gh = createGitHub(vscode, { log });
  let prs = [];
  let prsTruncated = false;
  let prError = null;
  let loadingPrs = false;
  // Only decides which group a PR is listed under; a failure here never hides the PRs.
  let team = { teams: [], truncated: false, error: null };

  // Which remote is the GitHub repository (src/github-remote.js): read from git and the
  // impactTree.githubRemote setting on each call, so a new remote or setting shows at once.
  const githubRemote = () => {
    let remotes = [];
    try {
      const { makeGit } = require('./engine/git');
      remotes = parseRemoteList(makeGit(session.repoRoot()).tryRaw(['remote', '-v']) || '');
    } catch { /* no repository: no remotes */ }
    return chooseGitHubRemote(remotes, vscode.workspace.getConfiguration('impactTree').get('githubRemote', ''));
  };
  const repoSlug = () => {
    const choice = githubRemote();
    return choice.kind === 'ok' ? { owner: choice.owner, repo: choice.repo } : null;
  };
  const remoteProblem = () => {
    const choice = githubRemote();
    const text = describeRemoteProblem(choice);
    return text === null ? null : { none: choice.kind === 'none', text };
  };
  // The base branch is read from the same remote (see baseRemoteOf).
  session.baseRemote = () => baseRemoteOf(githubRemote());

  // What GitHub says about the review of the PR being reviewed (threads, pending review,
  // viewed state). It follows the analysis: every new run, checkout claim or refreshed PR
  // source re-syncs it, so Refresh (which starts a new run) reloads it too. Local and
  // agent reviews have no target, and it does no I/O for them. Disposed with the window.
  reviewStore = createPullRequestReviewStore({
    gh, log,
    getAnalysisId: owned.getAnalysisId,
    getTarget: () => (owned.checkoutInProgress() != null ? null : reviewTargetOf(owned.state && owned.state.source, repoSlug, () => (remoteProblem() || { text: null }).text)),
  });
  context.subscriptions.push(reviewStore, owned.onDidChangeAnalysis(() => reviewStore.sync()),
    // Counts in the tree: only the file rows of the paths named are repainted.
    reviewStore.onDidChange(({ paths }) => provider.threadsChanged(paths)));
  session.reviewStore = reviewStore;
  // Ticks and GitHub's viewed marks follow each other (L6). Registered after the store so
  // its own disposal comes first; it reads the store's state, so it holds no target itself.
  viewedSync = createViewedSync({ provider, store: reviewStore, isCurrentAnalysis: owned.isCurrentAnalysis, log });
  const viewed = viewedSync;
  context.subscriptions.push(viewed, vscode.commands.registerCommand('impactTree.retryViewedSync',
    (row) => { if (row && typeof row.relPath === 'string') viewed.retry(row.relPath); }));

  // The store's threads in the review diff, and commenting there. Follows the store, and
  // the analysis for where the pull request is shown; disposed with the window.
  reviewComments = createReviewComments(vscode, {
    store: reviewStore, log,
    // openReview is created below; these run only on a click, after activation.
    headUri: (relPath) => openReview.headUri(relPath),
    openDiff: (relPath, line) => openReview.openFile({ relPath, ranges: line === null ? [] : [[line, line]] }),
    getSession: () => ({ source: owned.state && owned.state.source, result: (owned.state && owned.state.result) || null }),
    repoRoot: () => owned.repoRoot(),
    readHead: () => {
      const { makeGit } = require('./engine/git');
      return makeGit(owned.repoRoot()).rawAsync(['rev-parse', '--verify', 'HEAD^{commit}'], { timeoutMs: 10000 })
        .then((out) => out.trim() || null, (e) => { log(`review comments: reading HEAD failed: ${e.message}`); return null; });
    },
    // A suggestion is compared with its file at the commit it was written on.
    readAtCommit: (oid, relPath) => {
      const { makeGit } = require('./engine/git');
      return Promise.resolve()
        .then(() => makeGit(owned.repoRoot()).rawAsync(['show', `${oid}:${relPath}`], { timeoutMs: 10000 }))
        .then((out) => out, (e) => { log(`review comments: reading ${relPath} at ${oid} failed: ${e.message}`); return null; });
    },
    contextEvents: [
      owned.onDidChangeAnalysis,
      (listener) => provider.onDidChangePresentation((e) => { if (e.reason !== 'filter') listener(); }),
    ],
  });
  context.subscriptions.push(reviewComments);

  // Feedback drafts in the review diff of a local review, next to (never instead of) the
  // pull request comments above. Follows the drafts and the analysis; disposed with the window.
  feedbackComments = createFeedbackComments(vscode, {
    drafts: feedbackDrafts, log,
    getSession: () => ({ source: owned.state && owned.state.source, result: (owned.state && owned.state.result) || null }),
    getAnalysisId: owned.getAnalysisId,
    isCurrentAnalysis: owned.isCurrentAnalysis,
    repoRoot: () => owned.repoRoot(),
    // openReview is created below; this runs only on a click, after activation.
    openDiff: (relPath, line) => openReview.openFile({ relPath, ranges: line === null ? [] : [[line, line]] }),
    contextEvents: [
      owned.onDidChangeAnalysis,
      (listener) => provider.onDidChangePresentation((e) => { if (e.reason !== 'filter') listener(); }),
    ],
  });
  context.subscriptions.push(feedbackComments);

  const sources = createSourcesProvider(vscode, {
    getRepoStatus: () => repoStatus,
    modes: MODES,
    getMode: () => vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'),
    getRepoSlug: repoSlug,
    github: gh,
    getPrs: () => prs,
    getPrsTruncated: () => prsTruncated,
    getPrError: () => prError,
    isLoadingPrs: () => loadingPrs,
    getTeams: () => team,
    getRemoteProblem: remoteProblem,
  });
  context.subscriptions.push(vscode.window.createTreeView('impactTree.sources',
    { treeDataProvider: sources }));

  // Each load takes a number; only the latest one may publish, so a list for the old
  // repository never lands after the setting changed.
  let loadSeq = 0;
  const loadPrs = async () => {
    const mine = ++loadSeq;
    const slug = repoSlug();
    if (!slug || !gh.isSignedIn()) { prs = []; prError = null; loadingPrs = false; sources.refresh(); return; }
    loadingPrs = true; prError = null; sources.refresh();
    const teamsLoaded = gh.listMyTeams().then(
      ({ teams, truncated }) => ({ teams, truncated, error: null }),
      (e) => ({ teams: [], truncated: false, error: e.message }));
    try {
      const loaded = await gh.listOpenPullRequests(slug);
      if (mine !== loadSeq) return;
      ({ pullRequests: prs, truncated: prsTruncated } = loaded);
      log(`github: ${prs.length} open PR(s) in ${slug.owner}/${slug.repo}${prsTruncated ? ' (list truncated)' : ''}`);
      const teams = await teamsLoaded;
      if (mine !== loadSeq) return;
      team = teams;
      log(team.error ? `github: teams unavailable: ${team.error}`
        : `github: ${team.teams.length} team(s)${team.truncated ? ' (list truncated)' : ''}`);
    } catch (e) {
      if (mine !== loadSeq) return;
      prs = []; prsTruncated = false; prError = e.message;
      log(`github: ${e.message}`);
    } finally {
      if (mine === loadSeq) { loadingPrs = false; sources.refresh(); }
    }
  };

  // A change of the GitHub remote setting moves the pull request list (and the review
  // being read) to the other repository. Disposed with the window.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('impactTree.githubRemote')) return;
    sources.refresh();
    reviewStore.sync();
    loadPrs().catch((err) => log(`github: reloading pull requests failed: ${err && err.message}`));
  }));

  publishContext();

  const { previewPullRequest, checkoutAndAnalyse } = createPrActions(vscode, session, {
    log, gh, repoSlug, githubRemote, sources, prDocuments,
  });
  session.previewPullRequest = previewPullRequest;
  session.checkoutAndAnalyse = checkoutAndAnalyse;

  const openReview = createOpenReview(vscode, session, { log });
  const lens = createReviewLens(vscode, { provider, getState: () => owned.state, callerUri: openReview.callerUri, positionOf: offsetToPosition, log });
  context.subscriptions.push(...lens.disposables);

  // The Pull Request tab, the pending-review status bar item and the jump to a thread.
  const pullRequestTab = createPullRequestPanel(vscode, {
    store: reviewStore, provider, revealRow: navigation.revealRow, revealThread: reviewComments.revealThread, log,
  });
  context.subscriptions.push(...pullRequestTab.disposables);

  // The drafts' count in the status bar, after the review's own items; a drafts change
  // repaints only the tree's "Feedback to send" group.
  const feedbackStatus = createFeedbackStatus(vscode);
  const showFeedback = () => {
    provider.feedbackChanged();
    feedbackStatus.update(feedbackDrafts.list().length);
    publishContext();
  };
  feedbackStatus.update(feedbackDrafts.list().length);
  context.subscriptions.push(feedbackStatus, feedbackDrafts.onDidChange(showFeedback),
    vscode.commands.registerCommand(SHOW_DRAFTS_COMMAND, async () => {
      const group = provider.feedbackGroup();
      if (!group) { vscode.window.showInformationMessage('Impact Tree: there are no feedback drafts.'); return; }
      await view.reveal(group, { select: false, focus: true, expand: true });
    }));

  // What happened to the last sent round (F4), refreshed after each analysis, when a round
  // file changes, and after a send. Disposed with the window.
  feedbackRound = createFeedbackRoundView({
    workspaceState: context.workspaceState, session: owned, getSnapshotStore, log,
    onChange: () => provider.feedbackChanged(),
  });
  const refreshRound = () => { if (feedbackRound) feedbackRound.refresh(); };
  const roundFiles = vscode.workspace.createFileSystemWatcher('**/.impact-tree/feedback/*.md');
  context.subscriptions.push(feedbackRound, roundFiles, owned.onDidChangeAnalysis(refreshRound),
    roundFiles.onDidChange(refreshRound), roundFiles.onDidCreate(refreshRound), roundFiles.onDidDelete(refreshRound));
  refreshRound();

  // Cleanup of stored data (F5): in the background a minute after startup and after each
  // send; never feedback files, never the current checkpoint.
  const cleanupDeps = { getSnapshotStore, workspaceState: context.workspaceState, session: owned, review, log };
  const autoCleanup = createAutoCleanup(cleanupDeps);
  const cleanupTimer = setTimeout(() => { autoCleanup(); }, 60000);
  context.subscriptions.push({ dispose: () => clearTimeout(cleanupTimer) });

  // Send feedback (F3): the round file, its snapshot as the checkpoint, the hand-off.
  const sendFeedback = createSendFeedback(vscode, {
    drafts: feedbackDrafts, getSnapshotStore, session: owned, workspaceState: context.workspaceState, log,
    afterSend: () => { refreshRound(); autoCleanup(); },
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('impactTree.sendFeedback', () => sendFeedback()),
    vscode.commands.registerCommand('impactTree.sendFeedbackTo', () => sendFeedback({ ask: true })),
    vscode.commands.registerCommand('impactTree.cleanUpStoredData', createCleanupCommand(vscode, cleanupDeps)),
    vscode.commands.registerCommand('impactTree.feedback.openRoundItem', (row) => openRoundItem(row)),
    vscode.commands.registerCommand('impactTree.feedback.openRoundFile', async () => {
      const current = feedbackRound && feedbackRound.current();
      if (!current) return;
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(owned.repoRoot(), current.relPath)));
    }),
    vscode.commands.registerCommand('impactTree.feedback.reply', (row) => replyToRoundItem(row)),
  );

  /** Opens a round item's file at its line. @param {any} row */
  async function openRoundItem(row) {
    if (!row || typeof row.file !== 'string') return;
    const uri = vscode.Uri.file(path.join(owned.repoRoot(), ...row.file.split('/')));
    try {
      const line = typeof row.line === 'number' ? row.line - 1 : 0;
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: true });
    } catch (e) {
      vscode.window.showWarningMessage(`Impact Tree: cannot open ${row.file} (${e.message}).`);
    }
  }

  /**
   * "Reply in next round": a new draft at the same place, written in an input box (the file
   * may have no change in the review shown, so no comment box can be offered there).
   * @param {any} row
   */
  async function replyToRoundItem(row) {
    if (!row || typeof row.file !== 'string') return;
    const body = await vscode.window.showInputBox({
      title: `Reply in next round · ${row.label}`, prompt: `Was: ${row.summary || '(no text)'} — ${row.desc}`,
      placeHolder: 'Feedback for the agent (Markdown)',
      validateInput: (v) => (v.trim() === '' ? 'Write the feedback, or press Escape.' : null),
    });
    if (typeof body !== 'string') return;
    const quote = row.line ? readLines(path.join(owned.repoRoot(), ...row.file.split('/')), row.line, 5) : '';
    const added = await feedbackDrafts.add({ file: row.file, line: row.line, symbol: row.symbol, caller: null, quote, body });
    if (!added.ok) vscode.window.showErrorMessage(`Impact Tree: the reply was not added (${added.error.message}).`);
  }

  // Restore an existing session silently so a returning user sees their PRs without
  // being prompted; never pop a sign-in modal on startup.
  gh.signIn().then(
    (sess) => { if (sess) loadPrs(); else sources.refresh(); },
    (e) => { log(`github: sign-in failed: ${e.message}`); sources.refresh(); });

  context.subscriptions.push(
    ...registerCommands(vscode, {
      BUILD, session, openReview, sources, gh, loadPrs, context, log, out, getSnapshotStore,
    }),
    ...registerContentProviders(vscode, { prDocuments, repoRoot: () => session.repoRoot(), gh, repoSlug, log, getObjectDirs }),
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

/**
 * Up to `count` lines of a file from one-based `line`, for a draft's quote; '' when unreadable.
 * Reads at most 2 MB.
 * @param {string} abs @param {number} line @param {number} count
 */
function readLines(abs, line, count) {
  try {
    if (fs.statSync(abs).size > 2 * 1024 * 1024) return '';
    return fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(line - 1, line - 1 + count).join('\n');
  } catch {
    return '';
  }
}

module.exports = { activate, deactivate };

