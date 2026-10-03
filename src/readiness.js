'use strict';
const path = require('path');

/**
 * Language-server warmup shared across local analysis runs and prewarm. Concurrent
 * callers share one promise; a failed prepare resolves false and is forgotten, so the
 * next call prepares again. The displayed phase belongs to the session's lifecycle,
 * which decides whether this work may show it.
 *
 * @param {*} vscode
 * @param {object} session
 * @param {{ log: (m: string) => void }} opts
 */
function createReadiness(vscode, session, { log }) {
  const { loadTypeScript } = require('./engine/analyze');
  const { createVscodeResolver } = require('./resolver-vscode');

  // Warming needs a real symbol position in a file the server will have to load anyway.
  async function warmTarget(repo) {
    const { makeGit, resolveBase } = require('./engine/git');
    const { changedFiles, isSourcePath, projectRootOf } = require('./engine/diff');
    const fs = require('fs');
    const git = makeGit(repo);
    const cfg = vscode.workspace.getConfiguration('impactTree');
    let baseSha;
    try {
      const b = resolveBase(git, cfg.get('baseBranch', 'main'), { fetch: false, allowLocal: true });
      baseSha = git.mergeBase(b.sha, 'HEAD') || b.sha;
    } catch { return null; }
    // A file no config claims still warms the server: it opens an inferred project.
    const files = changedFiles(git, baseSha, 'HEAD', null)
      .filter((f) => isSourcePath(f.path) && f.status !== 'deleted');
    for (const f of files) {
      const abs = path.join(repo, f.path);
      const root = projectRootOf(repo, f.path) ?? '';
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

  // Resolves every prerequisite once: workspace, typescript, resolver, warm language
  // server. Concurrent callers share the same promise instead of racing.
  function ensureReady(progress) {
    if (session.readyPromise) return session.readyPromise;
    const prepare = (async () => {
      const say = (m) => { if (progress) progress.report({ message: m }); log(`  · ${m}`); };
      const repo = session.repoRoot();

      if (!session.resolver) {
        say('loading typescript');
        let ts = null;
        try { ts = loadTypeScript(repo, repo); }
        catch (e) { log(`typescript not resolvable — CQRS edges disabled: ${e.message}`); }
        session.resolver = createVscodeResolver({ ts, repoRoot: repo, trace: (m) => log(`  · ${m}`),
          filterInherited: vscode.workspace.getConfiguration('impactTree').get('filterInheritedOverReports', true) });
        log(`resolver created  cqrs=${ts ? 'on' : 'off'}`);
      }

      if (!session.resolver.isWarm()) {
        say('indexing the workspace (first run only)');
        const t = await warmTarget(repo);
        if (t) {
          const ok = await session.resolver.warmUp(t.file, t.pos);
          if (!ok) log('language server never warmed; results may be incomplete');
        } else {
          log('no changed TypeScript file to warm with — skipping warm-up');
        }
      }
      return true;
    })().catch((e) => {
      // Forget the failure so the next call prepares again; a success stays cached.
      if (session.readyPromise === prepare) session.readyPromise = null;
      log(`prepare failed: ${e.message}`);
      return false;
    });
    session.readyPromise = prepare;
    return prepare;
  }

  return { ensureReady, warmTarget };
}

module.exports = { createReadiness };
