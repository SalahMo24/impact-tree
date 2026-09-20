'use strict';
const path = require('path');
const vscode = require('vscode');
const { analyze, MODES, loadTypeScript } = require('./engine/analyze');
const { createVscodeResolver } = require('./resolver-vscode');
const { createTreeProvider } = require('./tree-provider');
const { createDecorationProvider } = require('./decorations');

// Bumped whenever extension-side behaviour changes, so the exthost log proves which
// build is actually loaded instead of us inferring it from timestamps.
const BUILD = '0.1.0+no-opentextdocument';

let state = null;
let resolver = null;
let out = null;
let busy = false;
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

async function highlight(file, sites) {
  const ranges = rangesFor(file, sites);
  if (!ranges.length) return;
  // the freshly opened editor (for a diff this is the modified side)
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document.uri.fsPath === file) ed.setDecorations(decorationType(vscode), ranges);
  }
}

function baseUriFor(relPath) {
  return vscode.Uri.parse(`impacttree-base:${relPath}?${state.result.base.sha}`);
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
    if (!fs.existsSync(path.join(repo, root, 'node_modules'))) continue;
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
      resolver = createVscodeResolver({ ts, trace: (m) => log(`  · ${m}`) });
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

async function run(mode, progress) {
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
        mode, base: cfg.get('baseBranch', 'main'), fetch: cfg.get('fetchBase', true),
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
    const changedKeys = new Set(result.components.flatMap((c) => c.changed.map((x) => `${x.file}#${x.namePos}`)));
    const changedPaths = new Set(result.changedPaths || []);
    const { offsetToPosition } = require('./engine/textpos');
    const callSiteUpdated = (file, sites) => {
      const ranges = (result.changedRanges || {})[path.relative(repo, file)];
      if (!ranges || !ranges.length || !sites || !sites.length) return false;
      return sites.some((cs) => {
        const a = offsetToPosition(file, cs.start), b = offsetToPosition(file, cs.end);
        return a && b && ranges.some(([lo, hi]) => a.line + 1 <= hi && b.line + 1 >= lo);
      });
    };
    state = { ...state, result, changedKeys, changedPaths, callSiteUpdated,
      rel: (f) => path.relative(repo, f), absPath: (p2) => path.join(repo, p2),
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
  out = vscode.window.createOutputChannel('Impact Tree');
  context.subscriptions.push(out);
  log(`activated  build=${BUILD}  resolver=vscode-callhierarchy  openTextDocument=never`);
  const decorate = createDecorationProvider(vscode);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorate));
  const provider = createTreeProvider(vscode, {
    decorate,
    isBusy: () => busy,
    getPhase: () => phase,
    getState: () => state,
    get resolver() { return resolver; },
    resolver: { incoming: (...a) => (resolver ? resolver.incoming(...a) : Promise.resolve([])) },
  });
  const view = vscode.window.createTreeView('impactTree.changes', { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(view);

  let inFlight = null;
  const refresh = async (mode) => {
    if (inFlight) return inFlight;          // clicking twice must not start two runs
    busy = true; decorate.clear(); provider.refresh();
    inFlight = (async () => {
      try {
        await vscode.window.withProgress(
          { location: { viewId: 'impactTree.changes' }, title: 'Impact Tree' },
          async (progress) => {
            await ensureReady(progress);
            provider.refresh();
            await run(mode || vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'), progress);
          });
      } finally {
        busy = false; inFlight = null; provider.refresh();
      }
    })();
    return inFlight;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('impactTree.refresh', () => refresh()),
    vscode.commands.registerCommand('impactTree.selectMode', async () => {
      const pick = await vscode.window.showQuickPick(
        Object.entries(MODES).map(([id, m]) => ({ label: id, description: m.desc })),
        { title: 'Impact Tree: diff mode' });
      if (!pick) return;
      await vscode.workspace.getConfiguration('impactTree').update('mode', pick.label, true);
      await refresh(pick.label);
    }),
    vscode.commands.registerCommand('impactTree.showLegend', async () => {
      const { LEGEND } = require('./tree-provider');
      await vscode.window.showQuickPick(
        LEGEND.map(([icon, label, desc]) => ({ label: `$(${icon})  ${label}`, detail: desc || undefined })),
        { title: `Impact Tree legend — build ${BUILD}`, placeHolder: 'marker reference (Esc to close)' });
    }),
    vscode.commands.registerCommand('impactTree.showLog', () => { if (out) out.show(true); }),
    vscode.commands.registerCommand('impactTree.computeTestReach', async () => {
      state = { ...state, wantTestReach: true };
      await refresh();
    }),
    vscode.commands.registerCommand('impactTree.setCheckpoint', async () => {
      const { makeGit } = require('./engine/git');
      const sha = makeGit(repoRoot()).revParse('HEAD');
      state = { ...state, checkpoint: sha };
      vscode.window.showInformationMessage(`Impact Tree: checkpoint set at ${String(sha).slice(0, 10)}`);
    }),
    // A changed symbol opens as a diff at its hunk; an unchanged affected caller opens
    // at the call site, because there is nothing to diff there.
    vscode.commands.registerCommand('impactTree.openChange', async (node) => {
      const f = node.finding;
      const right = vscode.Uri.file(f.file);
      const sel = new vscode.Range(f.startLine - 1, 0, f.startLine - 1, 0);
      await vscode.commands.executeCommand('vscode.diff', baseUriFor(f.relPath), right,
        `${path.basename(f.relPath)} (${String(state.result.base.sha).slice(0, 7)} ↔ working)`, { selection: sel });
    }),
    // deleted symbols and non-code files: diff against base where possible
    vscode.commands.registerCommand('impactTree.openFile', async (node) => {
      const rel = node.relPath;
      const abs = vscode.Uri.file(require('path').join(repoRoot(), rel));
      const inDiff = state && state.changedPaths && state.changedPaths.has(rel);
      const exists = require('fs').existsSync(abs.fsPath);
      try {
        if (!exists) {
          // deleted file: show the base revision alone
          await vscode.window.showTextDocument(baseUriFor(rel), { preview: true });
        } else if (inDiff || node.status) {
          await vscode.commands.executeCommand('vscode.diff', baseUriFor(rel), abs,
            `${require('path').basename(rel)} (${String(state.result.base.sha).slice(0, 7)} ↔ working)`);
        } else {
          await vscode.window.showTextDocument(abs);
        }
      } catch (e) {
        vscode.window.showWarningMessage(`Impact Tree: cannot open ${rel} — ${e.message}`);
      }
    }),
    vscode.commands.registerCommand('impactTree.openCaller', async (node) => {
      const { offsetToPosition } = require('./engine/textpos');
      // land on the first call site, not the caller's own declaration -- the call is
      // the thing the reviewer came to look at
      const anchor = (node.callSites && node.callSites[0] && node.callSites[0].start) != null
        ? node.callSites[0].start : node.pos;
      const p = offsetToPosition(node.file, anchor) || { line: 0, character: 0 };
      const sel = new vscode.Range(p.line, p.character, p.line, p.character);
      const uri = vscode.Uri.file(node.file);
      const rel = state && state.rel ? state.rel(node.file) : null;
      // Diff whenever the FILE differs from base, not just when this symbol changed --
      // that is what surfaces "other changes in the file". Diffing a file identical to
      // base would just show two panes of the same content, so that case opens plain.
      const always = vscode.workspace.getConfiguration('impactTree').get('alwaysDiffCallers', false);
      const fileChanged = !!(rel && state.changedPaths && state.changedPaths.has(rel));
      if (rel && state && state.result && (always || fileChanged)) {
        await vscode.commands.executeCommand('vscode.diff', baseUriFor(rel), uri,
          `${require('path').basename(rel)} (${String(state.result.base.sha).slice(0, 7)} ↔ working)`,
          { selection: sel });
      } else {
        try { await vscode.window.showTextDocument(uri, { selection: sel }); }
        catch { await vscode.commands.executeCommand('vscode.open', uri, { selection: sel }); }
      }
      await highlight(node.file, node.callSites);
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

function deactivate() { resolver = null; state = null; }
module.exports = { activate, deactivate };
