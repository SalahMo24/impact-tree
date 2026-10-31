'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const vscode = require('vscode');
const { MODES } = require('./engine/analyze');
const { createTreeProvider } = require('./views/changes/tree-provider');
const { latestCardsResult } = require('./agent/agent-cards');
const { agentReviewOf, NO_AGENT_REVIEW, clockText } = require('./agent/agent-review');
const { createReviewTab } = require('./views/review-tab/review-tab-panel');
const { createReviewSidebar, emptyReviewRow } = require('./views/sidebar/review-sidebar');
const { viewStateOf } = require('./views/changes/view-state');
const { createReviewNavigation } = require('./diff-editor/review-navigation');
const { createDetailPanel, headRelPath } = require('./views/details/detail-panel');
const { createCallerComment } = require('./diff-editor/caller-comment');
const { createAgentThreads } = require('./diff-editor/agent-threads');
const { createReviewLens } = require('./diff-editor/review-lens');
const { readLineOfOffset, offsetToPosition } = require('./engine/textpos');
const { createDecorationProvider } = require('./diff-editor/decorations');
const { createReviewState } = require('./session/review-state');
const { createGitHub } = require('./github/github');
const { parseRemoteList, chooseGitHubRemote, describeRemoteProblem, baseRemoteOf } = require('./github/github-remote');
const { createSourcesProvider } = require('./views/sidebar/sources-provider');
const { createPrDocuments } = require('./diff-editor/pr-documents');
const { createSession } = require('./session/session');
const { createAgentBridge } = require('./agent/agent-bridge');
const { createAgentConnect } = require('./agent/agent-connect-commands');
const { createAgentCardsState } = require('./agent/agent-cards-state');
const { createAnalyseWithAgent } = require('./agent/agent-analyse');
const { chooseAgent, chooseReviewAgent } = require('./feedback/feedback-send');
const { createSnapshotStoreGetter } = require('./storage/snapshot-storage');
const { createPrActions } = require('./session/pr-actions');
const { createPullRequestReviewStore, reviewTargetOf } = require('./github/pr-review-store');
const { createViewedSync } = require('./diff-editor/viewed-sync');
const { createOpenReview } = require('./diff-editor/open-review');
const { threadsViewOf, NO_THREADS } = require('./views/changes/review-threads');
const { createReviewComments } = require('./diff-editor/review-comments');
const { createPullRequestPanel } = require('./views/pr-tab/pr-overview-panel');
const { registerContentProviders } = require('./diff-editor/content-providers');
const { registerCommands } = require('./session/commands');
const { contextKeysOf } = require('./views/changes/view-state');
const { createFeedbackDrafts } = require('./feedback/feedback-drafts');
const { createFeedbackComments } = require('./feedback/feedback-comments');
const { createFeedbackStatus, SHOW_DRAFTS_COMMAND } = require('./feedback/feedback-tree');
const { createFeedbackRoundView } = require('./feedback/feedback-round-view');
const { createSendFeedback } = require('./feedback/feedback-send');
const { createAutoCleanup, createCleanupCommand } = require('./storage/storage-cleanup-run');
const { realClock } = require('./engine/clock');
const { createTelemetry } = require('./telemetry/telemetry');

// The packaged version, so the exthost log proves which build is actually loaded instead
// of us inferring it from timestamps.
const BUILD = require('../package.json').version;

let session = null;
let prDocuments = null;
let out = null;
// The channel is a log channel: the editor adds the timestamp and level, and "Developer: Set
// Log Level…" filters it. A channel without `info` (an older editor) gets the time prefixed.
const log = (m) => {
  if (!out) return;
  if (typeof out.info === 'function') out.info(m);
  // wall-clock: display — the time of day prefixed to each log line
  else out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
};

/**
 * @param {*} context The editor's ExtensionContext.
 * @param {{ clock?: import('./engine/clock').Clock }} [testSeams] Never passed by the editor,
 *   which calls `activate(context)`. `clock` (src/engine/clock.js; default the real clock)
 *   times every deadline, wait and background timer this activation starts, so a test
 *   (test/extension-env.js) can move time forward instead of waiting for it.
 */
function activate(context, { clock = realClock } = {}) {
  const now = () => clock.now();
  const review = createReviewState(context.workspaceState, { log, now });
  // Java's record of the build files at the last import seen (src/languages/java/server-status.js).
  require('./languages/java/server-status').setEditorJavaBuildFileStore(context.workspaceState);
  // The disposable holds its own reference: deactivate() drops the module's before the
  // editor disposes the subscriptions.
  const documents = createPrDocuments();
  prDocuments = documents;
  context.subscriptions.push({ dispose: () => documents.clear() });
  out = vscode.window.createOutputChannel('Impact Tree', { log: true });
  context.subscriptions.push(out);
  log(`activated  build=${BUILD}  resolver=vscode-callhierarchy  openTextDocument=never`);
  // Anonymous usage events and error reports; the editor's telemetry setting turns them off.
  const telemetry = createTelemetry(vscode, { context, log, clock });
  context.subscriptions.push(telemetry);
  telemetry.event('activated');

  // Local, so the closures below keep this activation's session after deactivate().
  // Snapshot checkpoints live in the extension's per-workspace storage, never in .git. Without a
  // storage folder there is no store and a checkpoint stays a plain HEAD commit.
  const getSnapshotStore = createSnapshotStoreGetter(context, () => owned.repoRoot(), log, { now });
  const getObjectDirs = () => { const s = getSnapshotStore(); return s ? s.objectDirs() : []; };
  const getTempDir = () => { const s = getSnapshotStore(); return s ? s.tempDir() : undefined; };
  // Temporary base-side copies the language services ask a server about (gate L1): the
  // per-workspace storage, or a folder in the OS temp folder for a window without one.
  // Each request removes its own copy; the services sweep stale leftovers when created.
  const getScratchDir = () => (context.storageUri
    ? path.join(context.storageUri.fsPath, 'impact-tree-base-documents')
    : path.join(os.tmpdir(), 'impact-tree-base-documents'));
  const owned = createSession(vscode, { log, review, checkpoint: context.workspaceState.get('impactTree.checkpoint'), getObjectDirs, getTempDir, getScratchDir, clock, telemetry });
  session = owned;
  getSnapshotStore();   // creates the store and sweeps leftover temporary files in the background
  // The last sent round's read-back (F4); created below, once the tree exists.
  /** @type {ReturnType<typeof createFeedbackRoundView>|null} */
  let feedbackRound = null;
  // Feedback drafts on local reviews (F1), kept in workspace state; disposed with the window.
  const feedbackDrafts = createFeedbackDrafts(context.workspaceState, { log, now });
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
  // What the user's agent said about the changes, shown on the Changes rows and lenses (set below, with the bridge).
  /** @type {() => import('./agent/agent-notes').AgentNotes|null} */
  let agentNotesNow = () => null;
  // The rest of what the agent said: the attention set, its cards, the hand-off's state (set below).
  /** @type {() => import('./agent/agent-review').AgentReview} */
  let agentReviewNow = () => NO_AGENT_REVIEW;
  const provider = createTreeProvider(vscode, {
    getAgentNotes: () => agentNotesNow(),
    getAgentReview: () => agentReviewNow(),
    // The engine's cards of the shown review: none until they are built.
    getCards: () => (owned.state && owned.state.cards) || null,
    // Read on each root read; anything but `cards` is the Files order (the default).
    getOrder: () => (vscode.workspace.getConfiguration('impactTree').get('reviewOrder', 'files') === 'cards' ? 'cards' : 'files'),
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
    // Read on each root read; a value that is not `tree` is the flat list (the default).
    getLayout: () => (vscode.workspace.getConfiguration('impactTree').get('fileListLayout', 'flat') === 'tree' ? 'tree' : 'flat'),
  });
  session.provider = provider;
  context.subscriptions.push(provider, decorate);
  // The Review view: where to review from, with the review nested under the row it came
  // from (review-sidebar.js). The PR list joins it when it is built, below.
  const sidebar = createReviewSidebar(vscode, {
    tree: provider,
    getHost: () => {
      const src = owned.state && owned.state.source;
      if (!src) return null;
      if ((src.kind === 'pr' || src.kind === 'checkout') && src.pr && Number.isSafeInteger(src.pr.number)) return { kind: 'pr', number: src.pr.number, title: src.pr.title };
      return src.kind === 'local' ? { kind: 'local', mode: vscode.workspace.getConfiguration('impactTree').get('mode', 'pr') } : null;
    },
    emptyRow: () => emptyReviewRow(viewStateOf({ repo: repoStatus, phase: owned.getPhase(), busy: owned.isBusy(), state: owned.state }), owned.state),
  });
  const view = vscode.window.createTreeView('impactTree.sources',
    { treeDataProvider: sidebar, showCollapseAll: true, manageCheckboxStateManually: true });
  context.subscriptions.push(view, sidebar, sidebar.followTree(),
    // Review something else…: the groups above the review again (review-sidebar.js).
    vscode.commands.registerCommand('impactTree.showPicker', () => sidebar.showPicker()));
  // A new review opens its row, even inside a group the reviewer had closed; a refresh of the
  // same review (callers retried, a new result) leaves the view where the reviewer is.
  let revealedFor = '';
  const revealHost = async () => {
    const src = owned.state && owned.state.source;
    const key = src ? JSON.stringify([src.kind, src.pr && src.pr.number]) : '';
    if (key === revealedFor) return;
    revealedFor = key;
    const host = await sidebar.hostRow();
    if (host) await Promise.resolve(view.reveal(host, { select: false, focus: false, expand: true })).then(undefined, (e) => log(`review: could not show the reviewed row: ${e && e.message}`));
  };
  context.subscriptions.push(owned.onDidChangeAnalysis(() => { void revealHost(); }));
  // The agent's part of the review (set below, with the bridge): null until then.
  /** @type {() => { waiting: { askedAt: number }|null, showEngine: boolean, results: Array<{ kind: string, key: string, payload: unknown, storedAt: number }> }|null} */
  let agentSource = () => null;
  /** @type {(changeId: string) => any} */
  let agentChangeOf = () => null;
  const navigation = createReviewNavigation(vscode, { provider, view });
  context.subscriptions.push(...navigation.disposables);
  // "Comment on this call" starts comments through the review comments, and feedback drafts
  // through the feedback comments, both created below.
  let reviewComments = null;
  let feedbackComments = null;
  const details = createDetailPanel(vscode, { provider, view, getState: () => owned.state, log,
    checkoutAndAnalyse: (pr) => session.checkoutAndAnalyse(pr), agentChange: (id) => agentChangeOf(id) });
  context.subscriptions.push(...details.disposables);
  // Counts follow presentation and progress events, independently of tree repaint scope.
  const showSummary = () => {
    const summary = provider.summarize();
    const { badge } = summary;
    // While a run waits for the first index, the view says so, with the elapsed seconds,
    // after the counts the reviewer is already using.
    const indexing = owned.getIndexingText();
    const message = indexing === null ? summary.message : summary.message ? `${summary.message} · ${indexing}` : indexing;
    // At the top of the Review view, always in sight (on the reviewed row it would sit after a
    // long pull request title and be cut off).
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
      'impactTree.hasFeedbackDrafts': feedbackDrafts.list().length > 0,
      // L3 hangs the review row's "Find the tests that cover this review" on it: false until
      // the walk ran, and with no result.
      'impactTree.testReachComputed': Boolean(owned.state && owned.state.result && owned.state.result.testReachComputed),
      // L4 hangs the review row's agent entries on these: a stored result for the shown head, and
      // whether the engine's cards are shown although there is one.
      'impactTree.hasAgentResult': agentReviewNow().hasResult,
      'impactTree.agentShowsEngine': agentReviewNow().showEngine };
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
    // wall-clock: log-only — how long a checkbox change took, for the log
    const started = Date.now();
    // A file's checkbox ticks its changes; a change's ticks only itself, not its callers.
    provider.setCheckedBatch(e.items.map(([row, state]) => ({ row, on: state === vscode.TreeItemCheckboxState.Checked })));
    // wall-clock: log-only — the duration logged
    log(`checkbox: ${e.items.length} row(s), analysis=${owned.getAnalysisId()}, ${Date.now() - started}ms`);
  }));

  // ---- source picker: local modes and open pull requests -------------------
  const gh = createGitHub(vscode, { log, clock });
  let prs = [];
  let prsTruncated = false;
  let prError = null;
  let loadingPrs = false;
  // Only decides which group a PR is listed under; a failure here never hides the PRs.
  let team = { teams: [], truncated: false, error: null };

  // Which remote is the GitHub repository (src/github/github-remote.js): read from git and the
  // impactTree.githubRemote setting on each call, so a new remote or setting shows at once.
  let remoteCache = { stamp: null, remotes: [] };
  const githubRemote = () => {
    let remotes = [];
    try {
      const { makeGit, repoStamp } = require('./engine/git');
      const root = session.repoRoot();
      const stamp = `${root}|${repoStamp(root)}`;
      if (remoteCache.stamp !== stamp) remoteCache = { stamp, remotes: parseRemoteList(makeGit(root).tryRaw(['remote', '-v']) || '') };
      remotes = remoteCache.remotes;
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
    // A suggestion is compared with its file at the head and at the commit it was written on.
    readAtCommit: (oid, relPath) => {
      const { makeGit } = require('./engine/git');
      return Promise.resolve()
        .then(() => makeGit(owned.repoRoot()).rawAsync(['show', `${oid}:${relPath}`], { timeoutMs: 10000 }))
        .then((out) => out, (e) => { log(`review comments: reading ${relPath} at ${oid} failed: ${e.message}`); return null; });
    },
    contextEvents: [
      owned.onDidChangeAnalysis,
      (listener) => provider.onDidChangePresentation((e) => { if (e.reason === 'analysis') listener(); }),
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
      (listener) => provider.onDidChangePresentation((e) => { if (e.reason === 'analysis') listener(); }),
    ],
  });
  context.subscriptions.push(feedbackComments);
  context.subscriptions.push(createCallerComment(vscode, {
    provider, getState: () => owned.state, lineOf: readLineOfOffset,
    reviewComments: () => reviewComments, feedbackComments: () => feedbackComments,
  }));

  // The agent's notes beside the code: a read-only thread per change it described, in the
  // head side of the review diff (L6). It follows the agent's result, the analysis, the
  // checks and the pull request's state; disposed with the window. Its actions start a
  // feedback draft or a GitHub draft, which the reviewer edits and sends; it sends nothing.
  context.subscriptions.push(createAgentThreads(vscode, {
    provider, log,
    getAgentReview: () => agentReviewNow(),
    // The head side of a file the shown review covers, for a local review and a preview alike.
    whereIs: (uri) => {
      const state = owned.state;
      const relPath = state && state.result ? headRelPath(uri, state) : null;
      return relPath ? { path: relPath, side: 'RIGHT' } : null;
    },
    isReviewed: provider.isReviewed,
    setReviewed: (row, on) => provider.setChecked(row, on),
    canStartFeedback: () => feedbackComments.available(),
    startFeedbackDraft: (row) => feedbackComments.commentOnRow(row),
    canPostToPr: () => provider.threadsView().status === 'ready',
    startReviewDraft: (row, text) => reviewComments.commentOnRowWith(row, text),
    events: [
      owned.onDidChangeAnalysis, owned.onDidChangeCards, reviewStore.onDidChange, provider.onDidChangeReview,
      (listener) => provider.onDidChangePresentation((e) => { if (e.reason === 'analysis') listener(); }),
    ],
  }));

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
  context.subscriptions.push(sidebar.setSources(sources));

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

  // The layout toggle writes the setting; the view follows it here, so a change made in
  // the settings editor or another window repaints the same way.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('impactTree.fileListLayout')) provider.refresh('layout');
    // The order the review is drawn in.
    if (e.affectsConfiguration('impactTree.reviewOrder')) provider.refresh('order');
  }));
  context.subscriptions.push(owned.onDidChangeCards(() => provider.refresh('order')));
  // A change of the GitHub remote setting moves the pull request list (and the review
  // being read) to the other repository. Disposed with the window.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('impactTree.githubRemote')) return;
    sources.refresh();
    reviewStore.sync();
    loadPrs().catch((err) => log(`github: reloading pull requests failed: ${err && err.message}`));
  }));

  // The bridge to the user's own agent: a local socket in a private temporary folder, guarded
  // by a token, started with the window and stopped with it. Nothing leaves the machine.
  const agentBridge = createAgentBridge(vscode, { session: owned, workspaceState: context.workspaceState, log, telemetry });
  const agentConnect = createAgentConnect(vscode, { context, log });
  context.subscriptions.push(agentBridge, agentConnect, vscode.commands.registerCommand('impactTree.connectAgent', () => agentConnect.connect()),
    vscode.commands.registerCommand('impactTree.disconnectAgent', () => agentConnect.disconnect()),
    vscode.commands.registerCommand('impactTree.chooseAgent', () => chooseReviewAgent(vscode)));
  agentBridge.start().catch((e) => log(`agent bridge: ${e && e.message}`));
  // The launcher and the Copilot provider are offered for as long as the window is open.
  agentConnect.prepareLauncher();
  agentConnect.syncProvider(true);

  // "Analyse with my agent" and the agent's cards in the review. The waiting state and the
  // shown head live in memory only; results live in the bridge's workspace state.
  const agentCards = createAgentCardsState();
  agentSource = () => ({ waiting: agentCards.waiting, showEngine: agentCards.showEngine, results: agentCards.head ? agentBridge.resultsFor(agentCards.head) : [] });
  // What the agent said about the changes: the latest result for the shown head, unless the
  // engine's cards are shown. Built once per stored result.
  // One value per stored result, shown state and engine cards, so what the tree compares to
  // find its rows stays the same object until one of them changes; the hand-off's state is
  // added on each read.
  /** @type {{ key: string|null, showEngine: boolean, cards: any, review: import('./agent/agent-review').AgentReview }|null} */
  let reviewFor = null;
  agentReviewNow = () => {
    const src = agentSource();
    if (!src) return NO_AGENT_REVIEW;
    const cards = (owned.state && owned.state.cards) || null;
    const latest = latestCardsResult(src.results);
    const key = latest ? latest.key : null;
    if (!reviewFor || reviewFor.key !== key || reviewFor.showEngine !== src.showEngine || reviewFor.cards !== cards) {
      reviewFor = { key, showEngine: src.showEngine, cards, review: agentReviewOf({ ...src, waiting: null }, cards) };
    }
    return src.waiting ? { ...reviewFor.review, waiting: { askedAtText: clockText(src.waiting.askedAt) } } : reviewFor.review;
  };
  agentNotesNow = () => agentReviewNow().notes;
  agentChangeOf = (id) => { const notes = agentNotesNow(); return notes ? notes.change(id) : null; };
  // The review tab (U1): the board and the card-by-card review, in an editor tab.
  const reviewTab = createReviewTab(vscode, {
    getState: () => owned.state, repoRoot: () => { try { return session.repoRoot(); } catch { return null; } }, log,
    agentPayload: () => { const src = agentSource(); if (!src || src.showEngine) return null; const latest = latestCardsResult(src.results); return latest ? latest.payload : null; },
  });
  context.subscriptions.push(...reviewTab.disposables, vscode.commands.registerCommand('impactTree.openReview', () => reviewTab.open()),
    owned.onDidChangeAnalysis(() => reviewTab.refresh()), owned.onDidChangeCards(() => reviewTab.refresh()));
  // Everything that shows the agent's result: Details, the review rows and lenses, the review tab, the menus.
  const agentRedraw = () => { details.refresh(); provider.agentChanged(); reviewTab.refresh(); publishContext(); };
  // The head of the review shown is read from the repository, so it arrives after the analysis does.
  let headRead = 0;
  const agentShowsAnything = () => { const src = agentSource(); return Boolean(src && (src.waiting || src.results.length)); };
  const syncAgentHead = async () => {
    const mine = ++headRead;
    let head = null;
    try { const ctx = await agentBridge.context(); head = ctx ? ctx.head : null; } catch (e) { log(`agent: could not read the head: ${e && e.message}`); }
    if (mine !== headRead) return;
    // Redraw only when the agent shows something for the old head or the new one: the bridge
    // reads the head after every analysis, and a review the agent never saw looks the same.
    const before = agentShowsAnything();
    if (agentCards.headChanged(head) && (before || agentShowsAnything())) agentRedraw();
  };
  const analyseWithAgent = createAnalyseWithAgent(vscode, {
    session: owned, bridge: agentBridge, state: agentCards, chooseAgent, ensureConnected: (id) => agentConnect.ensureConnected(id), log, telemetry, redraw: agentRedraw,
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('impactTree.analyseWithAgent', () => analyseWithAgent.run()),
    vscode.commands.registerCommand('impactTree.cancelAgentWaiting', () => analyseWithAgent.cancelWaiting()),
    vscode.commands.registerCommand('impactTree.toggleAgentCards', () => analyseWithAgent.toggle()),
    vscode.commands.registerCommand('impactTree.showAgentCards', () => analyseWithAgent.toggle()),
    // From the reviewed row's menu there is no key: undo the latest result of the shown head.
    vscode.commands.registerCommand('impactTree.undoAgentResult', (key) => analyseWithAgent.undo(typeof key === 'string' ? key : agentReviewNow().resultKey)),
    agentBridge.onDidStoreResult((e) => { agentCards.stored(e); agentRedraw(); }),
    agentBridge.onDidRemoveResult(() => agentRedraw()),
    owned.onDidChangeAnalysis(() => { void syncAgentHead(); }), owned.onDidChangeCards(() => { void syncAgentHead(); }));
  void syncAgentHead();

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
  session.openPullRequestTabWhenLoaded = pullRequestTab.openWhenLoaded;

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
  const cleanupDeps = { getSnapshotStore, workspaceState: context.workspaceState, session: owned, review, log, now };
  const autoCleanup = createAutoCleanup(cleanupDeps);
  const cleanupTimer = clock.setTimeout(() => { autoCleanup(); }, 60000);
  // Background housekeeping must not hold a process open on its own: the editor's
  // extension host stays up anyway, and a test that ends before the minute is over (or
  // cannot clear the timer because it mocks timers) exits at once.
  clock.unref?.(cleanupTimer);
  context.subscriptions.push({ dispose: () => clock.clearTimeout(cleanupTimer) });

  // Send feedback (F3): the round file, its snapshot as the checkpoint, the hand-off.
  const sendFeedback = createSendFeedback(vscode, {
    drafts: feedbackDrafts, getSnapshotStore, session: owned, workspaceState: context.workspaceState, log,
    afterSend: () => { refreshRound(); autoCleanup(); }, now, telemetry,
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
    const timer = clock.setTimeout(() => {
      log('preparing in the background so the first refresh is fast');
      owned.prewarmInBackground().catch((e) => log(`prewarm failed: ${e.message}`));
    }, 2000);
    context.subscriptions.push({ dispose: () => clock.clearTimeout(timer) });
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

