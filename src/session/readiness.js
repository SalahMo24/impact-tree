'use strict';
const { realClock } = require('../engine/clock');

/**
 * Language-server warmup shared across local analysis runs and prewarm. Concurrent
 * callers share one promise; a failed prepare resolves false and is forgotten, so the
 * next call prepares again. The displayed phase belongs to the session's lifecycle,
 * which decides whether this work may show it.
 *
 * @param {*} vscode
 * @param {object} session
 * @param {{ log: (m: string) => void, getScratchDir?: () => string|null, clock?: import('../engine/clock').Clock }} opts
 *   `getScratchDir`: the absolute folder the resolver's services write temporary
 *   base-side copies in (src/session/services-vscode.js); null or omitted: none, and base-side
 *   symbols are not served. `clock` is the resolver's (see src/session/resolver-vscode.js).
 */
function createReadiness(vscode, session, { log, getScratchDir = () => null, clock = realClock }) {
  const { loadTypeScript } = require('../languages/typescript/load');
  const { createVscodeResolver } = require('./resolver-vscode');

  // The server the current warm-up waits for, as its language names it (`serverLabel`), or
  // null for TypeScript's wording. Owner: this module; set by `warmTarget` before it asks
  // a language for a target, and cleared with `indexing` in the same `finally`.
  /** @type {string|null} */
  let waitingFor = null;

  // Warming needs a real symbol position in a file the server will have to load anyway.
  // Each language in registry order (TypeScript first) that has changed files and a
  // `warmUpTarget` is asked in turn until one gives a target; a language whose answer
  // fails is logged and passed over. Never rejects.
  async function warmTarget(repo, services) {
    const { makeGit, resolveBase } = require('../engine/git');
    const { changedFiles, isSourcePath } = require('../engine/diff');
    const git = makeGit(repo);
    const cfg = vscode.workspace.getConfiguration('impactTree');
    // No base remote (an ambiguous choice or a bad setting): nothing to warm; the
    // analysis itself reports the problem.
    const baseRemote = session.baseRemote();
    if (baseRemote.name === null) return null;
    let baseSha;
    try {
      const b = resolveBase(git, cfg.get('baseBranch', ''), { fetch: false, allowLocal: true, remote: baseRemote.name });
      baseSha = git.mergeBase(b.sha, 'HEAD') || b.sha;
    } catch { return null; }
    // A file no config claims still warms the server: it opens an inferred project.
    const files = changedFiles(git, baseSha, 'HEAD', null)
      .filter((f) => isSourcePath(f.path) && f.status !== 'deleted');
    const { registeredLanguages, languageFor } = require('../languages/index');
    for (const language of registeredLanguages()) {
      if (!language.warmUpTarget) continue;
      const own = files.filter((f) => languageFor(f.path) === language).map((f) => f.path);
      if (!own.length) continue;
      // Set before the first wait, so the progress shown from now on names this server.
      waitingFor = language.serverLabel || null;
      try {
        const target = await language.warmUpTarget({ repo, files: own, services: services || null, log });
        if (target) return target;
      } catch (e) {
        log(`warm-up: no ${language.displayName} target — ${e && e.message ? e.message : e}`);
      }
    }
    waitingFor = null;
    return null;
  }

  function ensureResolver() {
    if (session.resolver) return session.resolver;
    const repo = session.repoRoot();
    let ts = null;
    try { ts = loadTypeScript(repo, repo); }
    catch (e) { log(`typescript not resolvable — CQRS edges disabled: ${e.message}`); }
    session.resolver = createVscodeResolver({ ts, repoRoot: repo, scratchDir: getScratchDir(), clock, trace: m => log(`  · ${m}`),
      filterInherited: vscode.workspace.getConfiguration('impactTree').get('filterInheritedOverReports', true) });
    log(`resolver created  cqrs=${ts ? 'on' : 'off'}`);
    return session.resolver;
  }

  // Resolves every prerequisite once: workspace, typescript, resolver, warm language
  // server. Concurrent callers share the same promise instead of racing. The session
  // owns `session.resolver` and `session.readyPromise` (see src/session/session.js); this module
  // creates the resolver once, from the repository root and the settings at that time.
  // Whether the first index is being built right now. Owner: this module; set around the
  // language server's warm-up only, and cleared in the same `finally`, so a failed or
  // never-finishing warm-up cannot leave it set. Readers (the session) use it to decide
  // whether a user-started run shows the indexing progress. It is a flag, not progress:
  // the language server reports none, so no percentage is, or may be, derived from it.
  let indexing = false;

  function ensureReady(progress) {
    if (session.readyPromise) return session.readyPromise;
    const prepare = (async () => {
      const say = (m) => { if (progress) progress.report({ message: m }); log(`  · ${m}`); };
      const repo = session.repoRoot();

      const resolver = ensureResolver();

      if (!resolver.isWarm()) {
        say('indexing the workspace (first run only)');
        indexing = true;
        try {
          const t = await warmTarget(repo, resolver.services);
          if (t) {
            const ok = await resolver.warmUp(t.file, t.pos);
            if (!ok) log('language server still loading after the warm-up; caller searches wait for it one at a time, and any that time out are retried once it answers');
          } else {
            log('no changed file to warm the language server with — skipping warm-up');
          }
        } finally {
          indexing = false;
          waitingFor = null;
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

  return { ensureReady, ensureResolver, warmTarget, isIndexing: () => indexing, indexingServer: () => (indexing ? waitingFor : null) };
}

module.exports = { createReadiness };
