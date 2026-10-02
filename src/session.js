'use strict';
const path = require('path');
const { changedSymbolKeys } = require('./engine/changed-symbols');
const { createReadiness } = require('./readiness');
const { withModuleCallers } = require('./engine/module-callers');

/**
 * Mutable review session for one editor window: which analysis is current, whether a
 * run or checkout is in flight, and the view-facing result. `vscode` is passed in so
 * a cached copy of this module cannot capture a previous stub.
 *
 * @param {*} vscode
 * @param {{ log: (m: string) => void, review: object }} opts
 */
function createSession(vscode, { log, review }) {
  // Required here rather than at module load: tests intercept analyze/git per activate.
  const { analyze, loadTypeScript } = require('./engine/analyze');

  const session = {
    state: null,
    phase: 'starting',
    busy: false,
    inFlight: null,
    checkingOut: null,
    resolver: null,
    // session.resolver plus the cross-file callers the last local analysis added.
    localResolver: null,
    resolverOverride: null,
    readyPromise: null,
    review,
    decorate: null,
    provider: null,
    previewPullRequest: null,
    checkoutAndAnalyse: null,
  };

  function repoRoot() {
    const f = vscode.workspace.workspaceFolders;
    if (!f || !f.length) throw new Error('Impact Tree: no workspace folder open');
    return f[0].uri.fsPath;
  }

  const isTierA = () => !!(session.state && session.state.result && session.state.result.tierA);

  function callSiteUpdatedFor(result, repo) {
    const { offsetToPosition } = require('./engine/textpos');
    return (file, sites) => {
      const ranges = (result.changedRanges || {})[path.relative(repo, file).split(path.sep).join('/')];
      if (!ranges || !ranges.length || !sites || !sites.length) return false;
      return sites.some((cs) => {
        const a = offsetToPosition(file, cs.start), b = offsetToPosition(file, cs.end);
        return a && b && ranges.some(([lo, hi]) => a.line + 1 <= hi && b.line + 1 >= lo);
      });
    };
  }

  function viewStateFromResult(result, repo, extra = {}) {
    const cfg = vscode.workspace.getConfiguration('impactTree');
    session.state = {
      ...session.state, result,
      changedKeys: changedSymbolKeys(result.allChanged),
      changedPaths: new Set(result.changedPaths || []),
      callSiteUpdated: callSiteUpdatedFor(result, repo),
      rel: (f) => path.relative(repo, f).split(path.sep).join('/'),
      absPath: (p2) => path.join(repo, p2),
      iconMode: cfg.get('iconMode', 'file'),
      rowDetail: cfg.get('rowDetail', 'hover'),
      fileListLayout: cfg.get('fileListLayout', 'tree'),
      error: null,
      ...extra,
    };
  }

  const refuseDuringCheckout = () => {
    if (session.checkingOut == null) return false;
    vscode.window.showWarningMessage(`Impact Tree: PR #${session.checkingOut} is being checked out — try again when it finishes`);
    return true;
  };

  async function run(mode, progress, opts = {}) {
    const repo = repoRoot();
    const cfg = vscode.workspace.getConfiguration('impactTree');
    session.resolver.clear();
    session.localResolver = null;
    try {
      session.phase = 'analysing';
      const tStart = Date.now();
      const report = (m) => { if (progress) progress.report({ message: m }); };
      const result = await analyze(repo, {
          onProgress: (p2) => {
            if (p2.phase === 'component') report(`analysing ${p2.component}…`);
            else if (p2.total) report(`${p2.component}: resolving callers ${p2.done}/${p2.total}`);
          },
          mode, base: opts.base || cfg.get('baseBranch', 'main'), fetch: cfg.get('fetchBase', true),
          checkpoint: session.state && session.state.checkpoint,
          depth: cfg.get('reachDepth', 2),
          skipForest: true,                      // the tree resolves callers on expand
          deferTestReach: !(session.state && session.state.wantTestReach), // only one section needs it
          concurrency: cfg.get('concurrency', 8),
          onDirty: 'fallback',                   // never blank the view because a file is edited
          makeResolver: () => session.resolver,
        });
      session.localResolver = withModuleCallers(session.resolver, result.moduleCallers);
      session.busy = false;
      log(`run mode=${result.mode}${result.requestedMode !== result.mode ? ` (requested ${result.requestedMode})` : ''} base=${result.base.ref}@${String(result.base.sha).slice(0, 10)} files=${result.changedFileCount} findings=${result.findings.length}`);
      result.warnings.forEach((w) => log(`  warn: ${w}`));
      const st = session.resolver.stats();
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
        const { createReviewIdentity, localRevisions } = require('./review-identity');
        const identity = createReviewIdentity(loadTypeScript(repo, repo), repo, localRevisions(repo, result, git));
        review.configure(`v2:${repo}:${git.currentBranch()}:${result.mode}:${opts.base || cfg.get('baseBranch', 'main')}`, identity);
      }
      viewStateFromResult(result, repo);
      const stale = result.findings.reduce((n, f) => n + f.staleCallers, 0);
      vscode.window.setStatusBarMessage(
        `Impact Tree: ${result.findings.length} finding(s), ${stale} un-updated caller(s), base ${result.base.ref}`, 8000);
    } catch (e) {
      session.state = { ...session.state, result: null, error: e.message };
      log(`ERROR ${e.stack || e.message}`);
      vscode.window.showErrorMessage(`Impact Tree: ${e.message}`);
    } finally {
      session.phase = 'ready';
    }
  }

  const refresh = async (mode, opts = {}) => {
    if (refuseDuringCheckout()) return;
    if (session.inFlight) return session.inFlight;          // clicking twice must not start two runs
    session.resolverOverride = null;                // leaving a PR preview
    session.state = { ...session.state, source: { kind: 'local' } };
    session.busy = true; session.decorate.clear(); session.provider.refresh();
    session.inFlight = (async () => {
      try {
        await vscode.window.withProgress(
          { location: { viewId: 'impactTree.changes' }, title: 'Impact Tree' },
          async (progress) => {
            await session.ensureReady(progress);
            session.provider.refresh();
            await run(mode || vscode.workspace.getConfiguration('impactTree').get('mode', 'pr'), progress, opts);
          });
      } finally {
        session.busy = false; session.inFlight = null; session.provider.refresh();
      }
    })();
    return session.inFlight;
  };

  function reset() {
    session.resolver = null;
    session.localResolver = null;
    session.state = null;
    session.readyPromise = null;
    session.resolverOverride = null;
    session.busy = false;
    session.phase = 'starting';
  }

  // Lets an expanded row say its caller query failed rather than show no callers.
  const current = () => session.resolverOverride || session.localResolver || session.resolver;
  const treeResolver = {
    incoming: (...a) => {
      const r = current();
      return r ? r.incoming(...a) : Promise.resolve([]);
    },
    incomingWithStatus: async (...a) => {
      const r = current();
      if (!r) return { callers: [], complete: false, reason: 'no analysis has run in this window' };
      if (r.incomingWithStatus) return r.incomingWithStatus(...a);
      // A resolver that cannot say whether its search finished is not evidence that it did.
      return { callers: await r.incoming(...a), complete: false, reason: 'this resolver does not report whether its caller search finished' };
    },
  };

  Object.assign(session, {
    repoRoot, isTierA, viewStateFromResult, refuseDuringCheckout, run, refresh, reset, treeResolver,
  });
  const { ensureReady } = createReadiness(vscode, session, { log });
  session.ensureReady = ensureReady;
  return session;
}

module.exports = { createSession };
