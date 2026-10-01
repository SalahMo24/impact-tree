'use strict';
const fs = require('fs');
const path = require('path');
const { makeGit, resolveBaseAsync } = require('./git');
const {
  changedFiles, untrackedFiles, allHunks, wholeFileRange, isTestPath, isSourcePath,
  projectRootOf, clearProjectCache, projectLabel,
} = require('./diff');
const { makeSymbols } = require('./symbols');
const { score } = require('./signature');
const { changedSymbolsIn, changedSymbolKeys } = require('./changed-symbols');
const { createTsResolver } = require('./resolver-ts');
const { seedRoots, nestedIds, blastRadius, buildTree } = require('./forest');
const { offsetToPosition, clearVirtualText } = require('./textpos');

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Prefer the project's own TypeScript so analysis matches what the editor sees; fall
// back to the repo root, then to whatever this extension was installed with.
// Prefer the repo's OWN TypeScript so we parse with the version the project compiles
// with, and fall back to the copy shipped with the extension. A monorepo commonly has
// no install at its root -- every package has its own -- so the repo root alone is not
// a sufficient place to look.
function loadTypeScript(repo, projectDir) {
  // TypeScript 7 is the native rewrite: its package exports only `unstable/*` plus a
  // version stub, with no createSourceFile and no createLanguageService. Loading it
  // and discovering that three call frames later produces a baffling error, so any
  // candidate that does not expose the compiler API is rejected and we keep looking.
  const usable = (m) => !!m && typeof m.createSourceFile === 'function'
    && typeof m.createLanguageService === 'function';
  const rejected = [];
  const tryAt = (base) => {
    if (!base) return null;
    let m = null;
    try { m = require(require.resolve('typescript', { paths: [base] })); } catch { return null; }
    if (usable(m)) return m;
    if (m && m.version) rejected.push(`${m.version} at ${base}`);
    return null;
  };
  for (const base of [projectDir, repo]) {
    const hit = tryAt(base);
    if (hit) return hit;
  }
  // Two levels of subdirectory: `packages/foo`, `components/bar`, `apps/web`.
  if (repo) {
    const kids = (d) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
          .map((e) => path.join(d, e.name));
      } catch { return []; }
    };
    for (const a of kids(repo)) {
      if (fs.existsSync(path.join(a, 'node_modules'))) { const hit = tryAt(a); if (hit) return hit; }
      for (const b of kids(a)) {
        if (!fs.existsSync(path.join(b, 'node_modules'))) continue;
        const hit = tryAt(b);
        if (hit) return hit;
      }
    }
  }
  const own = tryAt(__dirname);
  if (own) return own;
  try { return require('typescript'); } catch { /* not bundled */ }
  throw new Error('typescript not resolvable — install it in the project or the repo, '
    + 'or reinstall the extension (it ships its own copy)'
    + (rejected.length ? `. Rejected: ${rejected.join(', ')} (no classic compiler API)` : ''));
}

// One `git diff` for every file, split only so a huge PR stays under the OS argument
// limit. A rename's two paths always travel in the same chunk: git can only pair them
// when both are in the pathspec.
function rangesFor(git, baseSha, headRev, files, { maxChars = 60000 } = {}) {
  const groups = files.map((f) => (f.oldPath && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]));
  const out = {};
  let chunk = [], size = 0;
  const flush = () => {
    if (!chunk.length) return;
    Object.assign(out, allHunks(git, baseSha, headRev, chunk));
    chunk = []; size = 0;
  };
  for (const g of groups) {
    const len = g.reduce((n, p) => n + p.length + 1, 0);
    if (chunk.length && size + len > maxChars) flush();
    chunk.push(...g); size += len;
  }
  flush();
  return out;
}

const MODES = {
  working:    { desc: 'uncommitted changes only (agent review)', headRev: null,   requireClean: false },
  checkpoint: { desc: 'since a recorded checkpoint',            headRev: null,   requireClean: false },
  branch:     { desc: 'whole branch vs base (includes uncommitted)', headRev: null, requireClean: false },
  pr:         { desc: 'committed branch state vs base (PR semantics)', headRev: 'HEAD', requireClean: true },
};

async function analyze(repo, opts = {}) {
  const mode = opts.mode || 'pr';
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`unknown mode '${mode}' (expected ${Object.keys(MODES).join('|')})`);
  const depth = opts.depth ?? 2;
  const git = makeGit(repo);
  const warnings = [];
  // Per-run caches. The extension host lives for hours: a tsconfig added since the last
  // run must be seen, and text a Tier A preview registered for a PR must not stand in
  // for the file on disk (it moved every call-site line of a local run).
  clearProjectCache();
  clearVirtualText();

  // `rev-parse <40 hex>` echoes any well-formed sha back, existing or not, so a stale
  // checkpoint surfaced as a raw `git diff` failure. Ask for a commit specifically.
  const commitOf = (ref) => git.revParse(`${ref}^{commit}`);
  let base;
  if (mode === 'working') base = { ref: 'HEAD', sha: git.revParse('HEAD'), notes: [] };
  else if (mode === 'checkpoint') {
    if (!opts.checkpoint) throw new Error('checkpoint mode requires opts.checkpoint');
    const sha = commitOf(opts.checkpoint);
    if (!sha) {
      const err = new Error(`checkpoint ${String(opts.checkpoint).slice(0, 12)} is not a commit in this repository — record a new checkpoint`);
      err.code = 'NO_CHECKPOINT';
      throw err;
    }
    base = { ref: opts.checkpoint, sha, notes: [] };
  } else {
    const resolved = await resolveBaseAsync(git, opts.base || 'main', {
      fetch: !!opts.fetch, allowLocal: !!opts.allowLocalBase, timeoutMs: opts.fetchTimeoutMs,
    });
    warnings.push(...resolved.notes);
    const mb = git.mergeBase(resolved.sha, 'HEAD');
    if (!mb) {
      // Falling back to the base TIP diffed every commit the base gained since the
      // branch point, in reverse -- other people's work shown as this branch deleting it.
      const shallow = git.isShallow();
      const err = new Error(shallow
        ? `no common ancestor of ${resolved.ref} and HEAD in this clone — it is shallow, so the branch point was never fetched. Run 'git fetch --unshallow' (or fetch with more depth) and refresh.`
        : `${resolved.ref} and HEAD share no history — a branch diff against it is meaningless. Choose another base branch.`);
      err.code = 'NO_MERGE_BASE';
      throw err;
    }
    base = { ...resolved, sha: mb };
  }

  const dirty = git.isDirty(null);
  let effectiveMode = mode;
  let effectiveCfg = cfg;
  if (cfg.requireClean && dirty.length) {
    // Erroring to a blank view the moment someone edits a file is hostile. Fall back
    // to 'branch' (which includes uncommitted work) and say loudly that we did.
    if (opts.onDirty === 'fallback') {
      effectiveMode = 'branch';
      effectiveCfg = MODES.branch;
      warnings.push(`${dirty.length} uncommitted change(s) — showing 'branch' (includes your edits) instead of 'pr'. Commit or stash for a true PR diff.`);
    } else {
      const err = new Error(`working tree is dirty — a PR diff would be contaminated by ${dirty.length} uncommitted change(s). Commit, stash, or use mode 'branch'.`);
      err.dirty = dirty;
      throw err;
    }
  }

  const headRev = opts.headRev !== undefined ? opts.headRev : effectiveCfg.headRev;
  const everything = changedFiles(git, base.sha, headRev, null);
  // A new file nobody has `git add`ed yet is invisible to `git diff`. When the head is
  // the working tree it is part of the change; when the head is a commit it is not,
  // and neither are the callers the language service finds inside it.
  const untracked = new Set(untrackedFiles(git));
  if (headRev === null) {
    const listed = new Set(everything.map((f) => f.path));
    for (const p of untracked) if (!listed.has(p)) everything.push({ status: 'added', oldPath: null, path: p, untracked: true });
  }
  const files = everything.filter((f) => isSourcePath(f.path) && !isTestPath(f.path)
    && projectRootOf(repo, f.path) !== null);

  const byComponent = new Map();
  const unanalysable = new Map();
  for (const f of files) {
    const root = projectRootOf(repo, f.path);
    if (root === null) continue;
    const label = projectLabel(root);
    if (!byComponent.has(label)) byComponent.set(label, { root, files: [] });
    byComponent.get(label).files.push(f);
  }

  // relPath -> [[startLine, endLine], ...] of the new-side changed ranges
  const changedRanges = {};
  const tracked = files.filter((f) => !f.untracked);
  const ranges = tracked.length ? rangesFor(git, base.sha, headRev, tracked) : {};
  for (const f of files) {
    changedRanges[f.path] = f.untracked ? wholeFileRange(path.join(repo, f.path)) : (ranges[f.path] || []);
  }
  // every base-side blob in one process, not a `git show` per file
  const baseTexts = git.showMany(base.sha, files.filter((f) => f.status !== 'added').map((f) => f.oldPath || f.path));

  // A call site counts as updated only if a hunk actually covers it. A caller edited
  // elsewhere in its body has NOT been updated for this change, even though its symbol
  // shows as changed -- that is the false "already handled" signal we are removing.
  const lineOf = (file, offset) => {
    const p2 = offsetToPosition(file, offset);
    return p2 ? p2.line + 1 : null;
  };
  const relOf = (abs) => path.relative(repo, abs).split(path.sep).join('/');
  const callSiteUpdated = (callerFile, callSites) => {
    const rel2 = relOf(callerFile);
    const ranges = changedRanges[rel2];
    if (!ranges || !ranges.length || !callSites || !callSites.length) return false;
    return callSites.some((cs) => {
      const a = lineOf(callerFile, cs.start), b = lineOf(callerFile, cs.end);
      if (a == null || b == null) return false;
      return ranges.some(([lo, hi]) => a <= hi && b >= lo);
    });
  };

  const components = [];
  let droppedUntracked = 0;
  const outsideProgram = new Set();
  let compIndex = 0;
  for (const [comp, entry] of byComponent) {
    const compFiles = entry.files;
    (opts.onProgress || (() => {}))({ phase: 'component', component: comp, done: compIndex++, total: byComponent.size });
    const dir = path.join(repo, entry.root);
    // A project can have node_modules without typescript in it. Aborting the whole run
    // for one such project blanks the view; report it and analyse the rest.
    let ts;
    try { ts = loadTypeScript(repo, dir); }
    catch (e) {
      unanalysable.set(comp, (unanalysable.get(comp) || 0) + compFiles.length);
      warnings.push(`${compFiles.length} changed file(s) in '${comp}' NOT analysed — ${e.message}`);
      continue;
    }
    const S = makeSymbols(ts);
    const resolver = opts.makeResolver ? opts.makeResolver({ ts, componentDir: dir, component: comp, repoRoot: repo }) : createTsResolver(ts, dir, { repoRoot: repo });
    if (!resolver) { warnings.push(`'${comp}' has no tsconfig.json — skipped`); continue; }
    const changed = [], deleted = [];
    for (const f of compFiles) {
      const abs = path.join(repo, f.path);
      let headText = null;
      if (f.status !== 'deleted') {
        try { headText = fs.readFileSync(abs, 'utf8'); } catch { headText = null; }
      }
      // One file the parser or symbol walk chokes on must not blank the whole view.
      try {
        const r = changedSymbolsIn(ts, S, {
          absPath: abs, relPath: f.path, oldPath: f.oldPath, status: f.status,
          headText,
          baseText: f.status === 'added' ? null : baseTexts.get(f.oldPath || f.path) ?? null,
          hunkRanges: changedRanges[f.path] || [],
          component: comp, projectRoot: entry.root,
        });
        changed.push(...r.changed);
        deleted.push(...r.deleted);
      } catch (e) {
        warnings.push(`${f.path}: could not be analysed — ${e && e.message}`);
      }
    }

    const changedKeys = changedSymbolKeys(changed);
    const concurrency = opts.concurrency ?? 8;
    const deferReach = opts.deferTestReach === true;
    const report = opts.onProgress || (() => {});
    let done = 0;
    report({ phase: 'resolve', component: comp, done: 0, total: changed.length });
    await mapLimit(changed, concurrency, async (c) => {
      let cs;
      try {
        cs = await resolver.callerState(c.file, c.namePos, { isConstructor: c.isConstructor });
      } catch (e) {
        cs = { state: 'unknown', callers: [] };
        warnings.push(`caller resolution failed for ${c.label} (${c.relPath}): ${e && e.message}`);
      }
      if (headRev !== null && untracked.size && cs.callers.length) {
        const kept = cs.callers.filter((x) => !untracked.has(relOf(x.file)));
        if (kept.length !== cs.callers.length) {
          droppedUntracked += cs.callers.length - kept.length;
          cs = { ...cs, callers: kept, state: kept.length || cs.state !== 'resolved' ? cs.state : 'none' };
        }
      }
      if (cs.reason === 'not-in-program') outsideProgram.add(`${comp}\u0000${c.relPath}`);
      c.callerState = cs.state;
      c.callers = cs.callers;
      for (const x of cs.callers) {
        const atCall = callSiteUpdated(x.file, x.callSites);
        const symChanged = changedKeys.has(`${x.file}#${x.pos}`);
        x.callState = atCall ? 'updated-at-call' : symChanged ? 'changed-elsewhere' : 'unchanged';
      }
      // stale = the call was not updated, whatever else happened in that caller
      c.stale = cs.callers.filter((x) => !x.test && x.callState !== 'updated-at-call');
      c.staleCallers = c.stale.length;
      c.staleChangedElsewhere = c.stale.filter((x) => x.callState === 'changed-elsewhere').length;
      c.score = score(c);
      // Test reachability: does ANY test sit in the upward closure. Deferred by default
      // -- it only feeds one section, and computing it for every symbol multiplies the
      // query count for information the reviewer may never open.
      let tests = [];
      if (!deferReach) {
        const seen = new Set(); const stack = [[c.file, c.namePos, 0]];
        const budget = opts.reachBudget ?? 120;
        outer: while (stack.length) {
          const [f, p, d] = stack.pop();
          if (d >= depth || seen.size > budget) continue;
          let ups = [];
          try { ups = await resolver.incoming(f, p, d <= 1); } catch { ups = []; }
          for (const k of ups) {
            const id = `${k.file}#${k.pos}`;
            if (seen.has(id)) continue;
            seen.add(id);
            if (k.test) { tests.push(k.label); break outer; }
            stack.push([k.file, k.pos, d + 1]);
          }
        }
      }
      c.tests = tests;
      c.testState = !deferReach
        ? (tests.length ? 'covered' : (c.callerState === 'unknown' || c.callerState === 'di') ? 'unknown' : 'uncovered')
        : 'not-computed';
      report({ phase: 'resolve', component: comp, done: ++done, total: changed.length, label: c.label });
    });

    // Blast radius is only computed for roots we will actually show: at depth 4 with
    // 90-node closures it was the single largest cost in the run (234s -> see README).
    const ranked = seedRoots(changed).sort((a, b) => b.score - a.score);
    const roots = [];
    if (opts.skipForest) {
      components.push({ component: comp, changed, deleted, roots: ranked, forest: [], stats: resolver.stats ? resolver.stats() : {} });
      if (resolver.dispose) resolver.dispose();
      continue;
    }
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      if (i >= (opts.rankedRoots ?? 6)) { roots.push({ ...r, blast: null, blastCapped: false }); continue; }
      const b = await blastRadius(resolver, r.file, r.namePos, opts.blastDepth ?? 1);
      roots.push({ ...r, blast: b.count, blastCapped: b.capped });
    }
    roots.sort((a, b) => b.score - a.score || (b.blast || 0) - (a.blast || 0));
    const forest = [];
    for (const r of roots.slice(0, opts.rankedRoots ?? 6)) {
      forest.push(await buildTree(resolver, r, {
        depth: opts.treeDepth ?? 2, maxChildren: opts.maxChildren ?? 8,
        isChanged: (id) => changedKeys.has(id),
      }));
    }

    components.push({ component: comp, changed, deleted, roots, forest, stats: resolver.stats ? resolver.stats() : {} });
    if (resolver.dispose) resolver.dispose();
  }

  for (const k of outsideProgram) {
    const [comp, rel] = k.split('\u0000');
    warnings.push(`${rel} is not included by any tsconfig in '${comp}' — its callers are unknown`);
  }
  if (droppedUntracked) warnings.push(`${droppedUntracked} caller(s) in untracked files ignored — they are not part of the committed change`);
  const all = components.flatMap((c) => c.changed);
  const nested = nestedIds(all);
  for (const c of all) c.isRoot = !nested.has(`${c.file}#${c.namePos}`);
  // Same rule as the Tier A path: a source file we analysed but which produced no
  // changed callable still changed, and must stay visible somewhere in the view.
  const withSymbols = new Set([
    ...all.map((c) => c.relPath),
    ...components.flatMap((c) => c.deleted).map((d) => d.relPath),
  ]);
  const analysedPaths = new Set(files.map((f) => f.path).filter((p2) => withSymbols.has(p2)));
  const otherFiles = everything
    .filter((f) => !analysedPaths.has(f.path))
    .map((f) => ({ path: f.path, status: f.status, noCallable: withSymbols.has(f.path) ? undefined : true }));
  return {
    allChanged: all.slice().sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)),
    nestedCount: nested.size,
    otherFiles,
    mode: effectiveMode, requestedMode: mode, modeDesc: effectiveCfg.desc, dirtyCount: dirty.length, base, warnings,
    changedFileCount: files.length,
    changedPaths: files.map((f) => f.path),
    fileStatus: Object.fromEntries(everything.map((f) => [f.path, f.status])),
    basePaths: Object.fromEntries(everything.filter(f => f.oldPath).map(f => [f.path, f.oldPath])),
    changedRanges,
    excludedCallerPaths: headRev !== null ? [...untracked] : [],
    unanalysable: [...unanalysable].map(([component, count]) => ({ component, count })),
    components,
    findings: all.filter((c) => c.kinds.some((k) => k.id !== 'body')).sort((a, b) => b.score - a.score),
    deleted: components.flatMap((c) => c.deleted),
    untested: all.filter((c) => c.testState === 'uncovered'),
    testReachComputed: all.length === 0 || all.some((c) => c.testState !== 'not-computed'),
    unknownCallers: all.filter((c) => c.callerState === 'unknown'),
  };
}
module.exports = { analyze, MODES, loadTypeScript, rangesFor };
