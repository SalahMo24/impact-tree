'use strict';
const path = require('path');
const vscode = require('vscode');
const { analyze, MODES, loadTypeScript } = require('./engine/analyze');
const { createVscodeResolver } = require('./resolver-vscode');
const { createTreeProvider } = require('./tree-provider');
const { createDecorationProvider } = require('./decorations');
const { createReviewState } = require('./review-state');
const { createGitHub, parseRemote } = require('./github');
const { changedSymbolKeys } = require('./engine/changed-symbols');
const { createSourcesProvider } = require('./sources-provider');

// Bumped whenever extension-side behaviour changes, so the exthost log proves which
// build is actually loaded instead of us inferring it from timestamps.
const BUILD = '0.1.0+correctness-and-perf';
const { prQuery, createPrDocuments } = require('./pr-documents');
const prDocuments = createPrDocuments();

let state = null;
let resolver = null;
let out = null;
let busy = false;
// activate() owns the instance; analyze() runs at module scope and needs the same one.
let review = null;
// Tier A answers caller queries from its own index; the tree's lazy expansion must
// use it instead of the language-server resolver, which knows nothing about the PR.
let resolverOverride = null;
// 'starting' -> 'preparing' -> 'ready' -> 'analysing'. Users should never have to know
// that an index is warming; the view says what it is doing and refresh waits for it.
let phase = 'starting';
let readyPromise = null;
const log = (m) => { if (out) out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };

// Highlights every call site to the changed symbol in whatever editor we just opened,
// so "where does this file touch the change" is visible rather than inferred.
let callSiteDecoration = null;
function decorationType(vs) {
  if (!callSiteDecoration) {
    callSiteDecoration = vs.window.createTextEditorDecorationType({
      backgroundColor: new vs.ThemeColor('editor.findMatchHighlightBackground'),
      border: '1px solid',
      borderColor: new vs.ThemeColor('editor.findMatchBorder'),
      borderRadius: '2px',
      overviewRulerColor: new vs.ThemeColor('editorOverviewRuler.findMatchForeground'),
      overviewRulerLane: vs.OverviewRulerLane.Center,
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
    if (hit) ed.setDecorations(decorationType(vscode), ranges);
  }
}

const isTierA = () => !!(state && state.result && state.result.tierA);

function baseUriFor(relPath) {
  // In a Tier A preview the base revision is not in the local object database, so it
  // has to come from the API-fetched text rather than `git show`.
  if (isTierA()) return vscode.Uri.from({ scheme: 'impacttree-pr', path: relPath, query: prQuery(state.result, 'base') });
  return vscode.Uri.from({ scheme: 'impacttree-base', path: state.result.basePaths?.[relPath] || relPath, query: state.result.base.sha });
}

// The right-hand side of a diff. Locally that is the file on disk; in a Tier A
// preview the worktree is on some unrelated branch, so showing it would be actively
// misleading -- serve the PR's own text instead.
function headUriFor(relPath, absPath) {
  if (isTierA()) return vscode.Uri.from({ scheme: 'impacttree-pr', path: relPath, query: prQuery(state.result, 'head') });
  return vscode.Uri.file(absPath || path.join(repoRoot(), relPath));
}

// Warming needs a real symbol position in a file the server will have to load anyway.
async function warmTarget(repo) {
  const { makeGit, resolveBase } = require('./engine/git');
  const { changedFiles, isSourcePath } = require('./engine/diff');
  const { loadTypeScript } = require('./engine/analyze');
  const fs = require('fs');
  const git = makeGit(repo);
  const cfg = vscode.workspace.getConfiguration('impactTree');
  let baseSha;
  try {
    const b = resolveBase(git, cfg.get('baseBranch', 'main'), { fetch: false, allowLocal: true });
    baseSha = git.mergeBase(b.sha, 'HEAD') || b.sha;
  } catch { return null; }
  const { projectRootOf } = require('./engine/diff');
  const files = changedFiles(git, baseSha, 'HEAD', null)
    .filter((f) => isSourcePath(f.path) && f.status !== 'deleted' && projectRootOf(repo, f.path) !== null);
  for (const f of files) {
    const abs = path.join(repo, f.path);
    const root = projectRootOf(repo, f.path);
    try {
      const ts = loadTypeScript(repo, path.join(repo, root));
      const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2021, true);
      let pos = null;
      const visit = (n) => {
        if (pos != null) return;
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) pos = n.name.getStart(sf);
        else ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
      if (pos != null) return { file: abs, pos };
    } catch { /* try the next file */ }
  }
  return null;
}

function repoRoot() {
  const f = vscode.workspace.workspaceFolders;
  if (!f || !f.length) throw new Error('Impact Tree: no workspace folder open');
  return f[0].uri.fsPath;
}

// Resolves every prerequisite once: workspace, typescript, resolver, warm language
// server. Concurrent callers share the same promise instead of racing.
function ensureReady(progress) {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const say = (m) => { if (progress) progress.report({ message: m }); log(`  · ${m}`); };
    phase = 'preparing';
    const repo = repoRoot();

    if (!resolver) {
      say('loading typescript');
      let ts = null;
      try { ts = loadTypeScript(repo, repo); }
      catch (e) { log(`typescript not resolvable — CQRS edges disabled: ${e.message}`); }
      resolver = createVscodeResolver({ ts, repoRoot: repo, trace: (m) => log(`  · ${m}`),
        filterInherited: vscode.workspace.getConfiguration('impactTree').get('filterInheritedOverReports', true) });
      log(`resolver created  cqrs=${ts ? 'on' : 'off'}`);
    }

    if (!resolver.isWarm()) {
      say('indexing the workspace (first run only)');
      const t = await warmTarget(repo);
      if (t) {
        const ok = await resolver.warmUp(t.file, t.pos);
        if (!ok) log('language server never warmed; results may be incomplete');
      } else {
        log('no changed TypeScript file to warm with — skipping warm-up');
      }
    }
    phase = 'ready';
    return true;
  })().catch((e) => {
    phase = 'ready';          // let the user try anyway rather than dead-ending
    log(`prepare failed: ${e.message}`);
    return false;
  });
  return readyPromise;
}

async function run(mode, progress, opts = {}) {
  const repo = repoRoot();
  const cfg = vscode.workspace.getConfiguration('impactTree');
  resolver.clear();
  try {
    phase = 'analysing';
    const tStart = Date.now();
    const report = (m) => { if (progress) progress.report({ message: m }); };
    const result = await analyze(repo, {
        onProgress: (p2) => {
          if (p2.phase === 'component') report(`analysing ${p2.component}…`);
          else if (p2.total) report(`${p2.component}: resolving callers ${p2.done}/${p2.total}`);
        },
        mode, base: opts.base || cfg.get('baseBranch', 'main'), fetch: cfg.get('fetchBase', true),
        checkpoint: state && state.checkpoint,
        depth: cfg.get('reachDepth', 2),
        skipForest: true,                      // the tree resolves callers on expand
        deferTestReach: !(state && state.wantTestReach), // only one section needs it
        concurrency: cfg.get('concurrency', 8),
        onDirty: 'fallback',                   // never blank the view because a file is edited
        makeResolver: () => resolver,
      });
    busy = false;
    log(`run mode=${result.mode}${result.requestedMode !== result.mode ? ` (requested ${result.requestedMode})` : ''} base=${result.base.ref}@${String(result.base.sha).slice(0, 10)} files=${result.changedFileCount} findings=${result.findings.length}`);
    result.warnings.forEach((w) => log(`  warn: ${w}`));
    const st = resolver.stats();
    const wall = (Date.now() - tStart) / 1000;
    if (st.warmUpMs) log(`  server warm-up ${(st.warmUpMs / 1000).toFixed(1)}s (paid once per window)`);
    log(`  WALL ${wall.toFixed(1)}s   (query time sums to ${(st.incomingMs / 1000).toFixed(1)}s across ${cfg.get('concurrency', 8)} workers — overlapping, not additive)`);
    log(`  queries: ${st.incomingCalls}  min ${st.minMs}ms / median ${st.medianMs}ms / max ${st.maxMs}ms`);
    log(`  ${st.cacheHits} cache hits · ${st.warmupRetries} warmup retries · ${st.skipped} unresolved · ${st.resolvedEmpty} resolved-but-empty`);
    log(`  cqrs: +${st.cqrsEdges} edges / ${st.cqrsSuppressed} handlers de-noised`);
    if (st.inheritedDropped) log(`  precision: -${st.inheritedDropped} inherited-member over-report(s) (sibling subclasses the call hierarchy wrongly attributes to an override)`);
    if (st.slowest) log(`  slowest query ${st.slowest.ms}ms -> ${path.relative(repo, st.slowest.file)}@${st.slowest.pos}`);
    if (st.resolvedEmpty) {
      log(`  NOTE: ${st.resolvedEmpty} symbol(s) returned no callers:`);
      for (const e of st.emptyAt || []) {
        const { offsetToPosition } = require('./engine/textpos');
        const p3 = offsetToPosition(e.file, e.pos);
        log(`    - ${path.relative(repo, e.file)}:${p3 ? p3.line + 1 : '?'}`);
      }
      log('    If one is in a component whose TS project the editor has not loaded, that is under-reporting, not an answer.');
    }
    if (review) {
      const { makeGit } = require('./engine/git');
      const git = makeGit(repo);
      const identity = require('./review-identity').createReviewIdentity(loadTypeScript(repo, repo), repo, result,
        (rel) => git.show(result.base.sha, rel));
      review.configure(`v2:${repo}:${git.currentBranch()}:${result.mode}:${opts.base || cfg.get('baseBranch', 'main')}`, identity);
    }
    const changedKeys = changedSymbolKeys(result.allChanged);
    const changedPaths = new Set(result.changedPaths || []);
    const { offsetToPosition } = require('./engine/textpos');
    const callSiteUpdated = (file, sites) => {
      const ranges = (result.changedRanges || {})[path.relative(repo, file).split(path.sep).join('/')];
      if (!ranges || !ranges.length || !sites || !sites.length) return false;
      return sites.some((cs) => {
        const a = offsetToPosition(file, cs.start), b = offsetToPosition(file, cs.end);
        return a && b && ranges.some(([lo, hi]) => a.line + 1 <= hi && b.line + 1 >= lo);
      });
    };
    state = { ...state, result, changedKeys, changedPaths, callSiteUpdated,
      rel: (f) => path.relative(repo, f).split(path.sep).join('/'), absPath: (p2) => path.join(repo, p2),
      iconMode: cfg.get('iconMode', 'file'), rowDetail: cfg.get('rowDetail', 'hover'),
      fileListLayout: cfg.get('fileListLayout', 'tree'), error: null };
    const stale = result.findings.reduce((n, f) => n + f.staleCallers, 0);
    vscode.window.setStatusBarMessage(
      `Impact Tree: ${result.findings.length} finding(s), ${stale} un-updated caller(s), base ${result.base.ref}`, 8000);
  } catch (e) {
    state = { ...state, result: null, error: e.message };
    log(`ERROR ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Impact Tree: ${e.message}`);
  } finally {
    phase = 'ready';
  }
}

function activate(context) {
  review = createReviewState(context.workspaceState);
  state = { checkpoint: context.workspaceState.get('impactTree.checkpoint') };
  context.subscriptions.push({ dispose: () => prDocuments.clear() });
  out = vscode.window.createOutputChannel('Impact Tree');
  context.subscriptions.push(out);
  log(`activated  build=${BUILD}  resolver=vscode-callhierarchy  openTextDocument=never`);
  const decorate = createDecorationProvider(vscode);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorate));
  const provider = createTreeProvider(vscode, {
    decorate,
    review,
    isBusy: () => busy,
    getPhase: () => phase,
    getState: () => state,
    resolver: {
      incoming: (...a) => {
        const r = resolverOverride || resolver;
        return r ? r.incoming(...a) : Promise.resolve([]);
      },
    },
  });
  const view = vscode.window.createTreeView('impactTree.changes',
    { treeDataProvider: provider, showCollapseAll: true, manageCheckboxStateManually: true });
  context.subscriptions.push(view);
  context.subscriptions.push(view.onDidChangeCheckboxState((e) => {
    for (const [node, state] of e.items) {
      const id = review.id(node);
      if (!id) continue;
      const on = state === vscode.TreeItemCheckboxState.Checked;
      const kids = review.childIds(node);
      review.setWithChildren(id, kids, on);
    }
    provider.refresh();
  }));

  let inFlight = null;
  const refresh = async (mode, opts = {}) => {
    if (inFlight) return inFlight;          // clicking twice must not start two runs
    resolverOverride = null;                // leaving a PR preview
    busy = true; decorate.clear(); provider.refresh();
    inFlight = (async () => {
      try {
        await vscode.window.withProgress(
          { location: { viewId: 'impactTree.changes' }, title: 'Impact Tree' },
          async (progress) => {
            await ensureReady(progress);
            provider.refresh();
            await run(mode || vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'), progress, opts);
          });
      } finally {
        busy = false; inFlight = null; provider.refresh();
      }
    })();
    return inFlight;
  };

  // ---- source picker: local modes and open pull requests -------------------
  const gh = createGitHub(vscode, { log });
  let prs = [];
  let prError = null;
  let loadingPrs = false;

  const repoSlug = () => {
    try {
      const { makeGit } = require('./engine/git');
      const url = makeGit(repoRoot()).tryRaw(['remote', 'get-url', 'origin']);
      return parseRemote(url);
    } catch { return null; }
  };

  const sources = createSourcesProvider(vscode, {
    modes: MODES,
    getMode: () => vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'),
    getRepoSlug: repoSlug,
    github: gh,
    getPrs: () => prs,
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
      prs = await gh.listOpenPullRequests(slug);
      log(`github: ${prs.length} open PR(s) in ${slug.owner}/${slug.repo}`);
    } catch (e) {
      prs = []; prError = e.message;
      log(`github: ${e.message}`);
    } finally {
      loadingPrs = false; sources.refresh();
    }
  };

  // Tier A: analyse the PR from the API alone. Never touches the worktree, so it is
  // safe to run on any branch, mid-edit, with no confirmation.
  const previewPullRequest = async (pr) => {
    if (inFlight) { vscode.window.showWarningMessage('Impact Tree: an analysis is already running'); return; }
    busy = true; decorate.clear(); provider.refresh();
    inFlight = (async () => {
      try {
        await vscode.window.withProgress(
          { location: { viewId: 'impactTree.changes' }, title: `Impact Tree: PR #${pr.number}` },
          async (progress) => {
            phase = 'analysing';
            const t0 = Date.now();
            const repo = repoRoot();
            const cfg = vscode.workspace.getConfiguration('impactTree');
            let ts = null;
            try { ts = loadTypeScript(repo, repo); }
            catch (e) { throw new Error(`Tier A needs TypeScript: ${e.message}`); }

            const { analyzeRemote } = require('./engine/analyze-remote');
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

            resolverOverride = result.resolver;
            state = {
              ...state, result, prText,
              changedKeys: changedSymbolKeys(result.allChanged),
              changedPaths: new Set(result.changedPaths),
              // Lazily expanded callers recompute this, and Tier A CAN answer it:
              // offsetToPosition resolves through the registered PR text. Stubbing it
              // to false would silently downgrade every updated call site to "stale".
              callSiteUpdated: (file, sites) => {
                const ranges = (result.changedRanges || {})[path.relative(repo, file).split(path.sep).join('/')];
                if (!ranges || !ranges.length || !sites || !sites.length) return false;
                const { offsetToPosition } = require('./engine/textpos');
                return sites.some((cs) => {
                  const a = offsetToPosition(file, cs.start), b = offsetToPosition(file, cs.end);
                  return a && b && ranges.some(([lo, hi]) => a.line + 1 <= hi && b.line + 1 >= lo);
                });
              },
              rel: (f) => path.relative(repo, f).split(path.sep).join('/'),
              absPath: (p2) => path.join(repo, p2),
              iconMode: cfg.get('iconMode', 'file'),
              rowDetail: cfg.get('rowDetail', 'hover'),
              fileListLayout: cfg.get('fileListLayout', 'tree'),
              error: null,
            };
            review.configure(`v2:${repo}:pr:${pr.number}`,
              require('./review-identity').createReviewIdentity(ts, repo, result, (rel) => result.texts.get(rel)?.base ?? null));
            vscode.window.setStatusBarMessage(
              `Impact Tree: PR #${pr.number} preview — ${result.findings.length} finding(s), PR files only`, 8000);
          });
      } catch (e) {
        state = { ...state, result: null, error: `PR #${pr.number}: ${e.message}` };
        log(`ERROR tier A ${e.stack || e.message}`);
        vscode.window.showErrorMessage(`Impact Tree: ${e.message}`);
      } finally {
        phase = 'ready'; busy = false; inFlight = null; provider.refresh();
      }
    })();
    return inFlight;
  };

  // Checking out rewrites the worktree, so this states the exact effect and the branch
  // it is leaving before doing anything. `pull/N/head` works for forks too, which a
  // plain `fetch origin <headRef>` would not.
  const checkoutAndAnalyse = async (pr) => {
    const { makeGit } = require('./engine/git');
    const git = makeGit(repoRoot());
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
    try {
      await vscode.window.withProgress(
        { location: { viewId: 'impactTree.sources' }, title: `Fetching PR #${pr.number}` },
        async () => {
          await git.rawAsync(['fetch', 'origin', `pull/${pr.number}/head`, '--quiet'],
            { timeoutMs: 60000, env: require('./engine/git').FETCH_ENV });
          await git.rawAsync(['checkout', '--detach', 'FETCH_HEAD', '--quiet']);
        });
    } catch (e) {
      vscode.window.showErrorMessage(`Impact Tree: checkout failed — ${e.message}`);
      return;
    }
    log(`checked out PR #${pr.number} (${pr.headRef}) from '${was}'`);
    vscode.window.showInformationMessage(
      `Impact Tree: on PR #${pr.number}. Return with: git checkout ${was}`);
    sources.refresh();
    await refresh('pr', { base: pr.baseRef });
  };

  // Restore an existing session silently so a returning user sees their PRs without
  // being prompted; never pop a sign-in modal on startup.
  gh.signIn().then((sess) => { if (sess) loadPrs(); else sources.refresh(); });

  context.subscriptions.push(
    vscode.commands.registerCommand('impactTree.refresh', () => isTierA()
      ? previewPullRequest(state.result.pr || { number: state.result.prNumber }) : refresh()),
    vscode.commands.registerCommand('impactTree.selectMode', async () => {
      const pick = await vscode.window.showQuickPick(
        Object.entries(MODES).map(([id, m]) => ({ label: id, description: m.desc })),
        { title: 'Impact Tree: diff mode' });
      if (!pick) return;
      await vscode.workspace.getConfiguration('impactTree').update('mode', pick.label, vscode.ConfigurationTarget.Workspace);
      await refresh(pick.label);
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
      await refresh(mode);
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
      if (pick.id === 'preview') { await previewPullRequest(pr); return; }
      await checkoutAndAnalyse(pr);
    }),
    vscode.commands.registerCommand('impactTree.clearReviewed', async () => {
      const yes = await vscode.window.showWarningMessage(
        `Clear progress for this review? (${review.size()} item(s) marked)`, { modal: true }, 'Clear');
      if (yes !== 'Clear') return;
      review.clear();
      provider.refresh();
    }),
    vscode.commands.registerCommand('impactTree.computeTestReach', async () => {
      if (isTierA()) {
        vscode.window.showInformationMessage('Test reachability requires local analysis. The PR preview is unchanged.');
        return;
      }
      state = { ...state, wantTestReach: true };
      await refresh();
    }),
    vscode.commands.registerCommand('impactTree.setCheckpoint', async () => {
      const { makeGit } = require('./engine/git');
      const sha = makeGit(repoRoot()).revParse('HEAD');
      state = { ...state, checkpoint: sha };
      await context.workspaceState.update('impactTree.checkpoint', sha);
      vscode.window.showInformationMessage(`Impact Tree: checkpoint set at ${String(sha).slice(0, 10)}`);
    }),
    // A changed symbol opens as a diff at its hunk; an unchanged affected caller opens
    // at the call site, because there is nothing to diff there.
    vscode.commands.registerCommand('impactTree.openChange', async (node) => {
      const f = node.finding;
      const right = headUriFor(f.relPath, f.file);
      const sel = new vscode.Range(f.startLine - 1, 0, f.startLine - 1, 0);
      const rhs = isTierA() ? `PR #${state.result.prNumber}` : 'working';
      await vscode.commands.executeCommand('vscode.diff', baseUriFor(f.relPath), right,
        `${path.basename(f.relPath)} (${String(state.result.base.sha).slice(0, 7)} ↔ ${rhs})`, { selection: sel });
    }),
    // deleted symbols and non-code files: diff against base where possible
    vscode.commands.registerCommand('impactTree.openFile', async (node) => {
      const rel = node.relPath;
      const abs = headUriFor(rel);
      const inDiff = state && state.changedPaths && state.changedPaths.has(rel);
      const exists = isTierA() || require('fs').existsSync(abs.fsPath);
      try {
        if (!exists) {
          // deleted file: show the base revision alone
          await vscode.window.showTextDocument(baseUriFor(rel), { preview: true });
        } else if (inDiff || node.status) {
          await vscode.commands.executeCommand('vscode.diff', baseUriFor(rel), abs,
            `${require('path').basename(rel)} (${String(state.result.base.sha).slice(0, 7)} ↔ ${isTierA() ? `PR #${state.result.prNumber}` : 'working'})`);
        } else {
          await vscode.window.showTextDocument(abs);
        }
      } catch (e) {
        vscode.window.showWarningMessage(`Impact Tree: cannot open ${rel} — ${e.message}`);
      }
    }),
    vscode.commands.registerCommand('impactTree.openCaller', async (node) => {
      const { offsetToPosition } = require('./engine/textpos');
      const { callerOpen } = require('./review-open');
      // land on the first call site, not the caller's own declaration -- the call is
      // the thing the reviewer came to look at
      const anchor = (node.callSites && node.callSites[0] && node.callSites[0].start) != null
        ? node.callSites[0].start : node.pos;
      const p = offsetToPosition(node.file, anchor) || { line: 0, character: 0 };
      const sel = new vscode.Range(p.line, p.character, p.line, p.character);
      const rel = state && state.rel ? state.rel(node.file) : null;
      // Diff whenever the FILE differs from base, not just when this symbol changed --
      // that is what surfaces "other changes in the file". Diffing a file identical to
      // base would just show two panes of the same content, so that case opens plain.
      const always = vscode.workspace.getConfiguration('impactTree').get('alwaysDiffCallers', false);
      const fileChanged = !!(rel && state.changedPaths && state.changedPaths.has(rel));
      const plan = callerOpen({
        tierA: isTierA(), rel, baseRel: state?.result?.basePaths?.[rel], absPath: node.file, fileChanged, always,
        baseSha: state && state.result && state.result.base && state.result.base.sha,
        prNumber: state && state.result && state.result.prNumber,
        headSha: state?.result?.headSha,
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
          `${require('path').basename(rel)} (${String(state.result.base.sha).slice(0, 7)} ↔ ${plan.rhsName})`,
          { selection: sel });
      } else {
        opened = toUri(plan.uri);
        try { await vscode.window.showTextDocument(opened, { selection: sel }); }
        catch { await vscode.commands.executeCommand('vscode.open', opened, { selection: sel }); }
      }
      await highlight(node.file, node.callSites, opened);
    }),
    // Tier A text: head and base come from what we fetched, never from the worktree.
    vscode.workspace.registerTextDocumentContentProvider('impacttree-pr', {
      provideTextDocumentContent: (uri) => prDocuments.read(uri),
    }),
    // base-revision contents for the left-hand side of the diff
    vscode.workspace.registerTextDocumentContentProvider('impacttree-base', {
      provideTextDocumentContent(uri) {
        const { makeGit } = require('./engine/git');
        return makeGit(repoRoot()).show(uri.query, uri.path) || '';
      },
    }),
  );

  if (vscode.workspace.getConfiguration('impactTree').get('prewarm', true)) {
    setTimeout(() => {
      log('preparing in the background so the first refresh is fast');
      ensureReady().then(() => { log('ready'); provider.refresh(); });
    }, 2000);
  }
  if (vscode.workspace.getConfiguration('impactTree').get('analyseOnStartup', false)) refresh();
}

function deactivate() {
  resolver = null; state = null; readyPromise = null; resolverOverride = null;
  busy = false; phase = 'starting'; prDocuments.clear();
}
module.exports = { activate, deactivate };
