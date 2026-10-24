// @ts-check
'use strict';
// TypeScript and JavaScript as a language provider (src/languages/types.js). The one
// provider that needs no language server: it parses with the compiler it loads
// (./load.js) and, outside the editor, finds callers with its own language service
// (src/engine/resolver-ts.js). Everything TypeScript-specific the pipeline used to do
// itself lives here: grouping files by tsconfig project, loading the compiler, the
// symbol walk, the cross-file module-caller index, the choice of resolver, and the
// warnings that name tsconfig.json.
//
// Engine modules are required where they are used, not at the top: the registry
// (../index.js) loads this file, and src/engine/diff.js loads the registry.

const path = require('path');
const fs = require('fs');
const { typescriptRules } = require('./rules');

/** @typedef {import('../types').PrepareContext} PrepareContext */
/** @typedef {import('../types').AnalysisUnit} AnalysisUnit */
/** @typedef {import('../../engine/analyze').ChangedPath} ChangedPath */

/**
 * Changed files grouped by the project the TypeScript server would put them in.
 * @param {string} repo Absolute filesystem path of the repository root.
 * @param {ChangedPath[]} files Source files, tests already left out.
 * @returns {Map<string, { root: string, config: string|null, files: ChangedPath[] }>} Keyed by
 *   `'(root)'`, the repository-relative project directory, or `INFERRED_PROJECT` for files
 *   no tsconfig.json or jsconfig.json claims. `root` is `''` for the repository root and
 *   that directory otherwise; `config` is the config file name, `null` for the inferred
 *   project.
 */
function filesByProject(repo, files) {
  const { projectRootOf, projectConfigIn, projectLabel, INFERRED_PROJECT } = require('../../engine/diff');
  const byComponent = new Map();
  for (const file of files) {
    const root = projectRootOf(repo, file.path);
    const label = root === null ? INFERRED_PROJECT : projectLabel(root);
    let entry = byComponent.get(label);
    if (!entry) {
      entry = root === null
        ? { root: '', config: null, files: [] }
        : { root, config: projectConfigIn(path.join(repo, root)), files: [] };
      byComponent.set(label, entry);
    }
    entry.files.push(file);
  }
  return byComponent;
}

/**
 * Absolute paths of the worktree's source files that no config claims: the members of
 * the inferred project. `null` when git could not list the files.
 * @param {string} repo
 * @param {object} git
 * @returns {string[]|null}
 */
function inferredProjectFiles(repo, git) {
  const { worktreeFiles, projectRootOf } = require('../../engine/diff');
  const listed = worktreeFiles(git);
  if (listed == null) return null;
  // TypeScript/JavaScript files only: other languages' files are no project's members.
  return listed.filter((/** @type {string} */ rel) => typescriptRules.handles(rel) && projectRootOf(repo, rel) === null
    && fs.existsSync(path.join(repo, rel))).map((/** @type {string} */ rel) => path.join(repo, rel));
}

/**
 * Loads the compiler for one project. A project can have node_modules without
 * typescript in it; aborting the whole run for it blanks the view, so its files are
 * counted as not analysed with the reason, and the other projects go on.
 * @returns {any|null} The TypeScript module, or null when none could be loaded.
 */
function tryLoadTypeScript(/** @type {string} */ repo, /** @type {string} */ dir, /** @type {PrepareContext} */ ctx,
  /** @type {string} */ component, /** @type {number} */ count) {
  // Through the module's exports, so a test can stand in for the loader.
  try { return require('./load').loadTypeScript(repo, dir); }
  catch (e) {
    ctx.unanalysable.set(component, (ctx.unanalysable.get(component) || 0) + count);
    ctx.warnings.push(`${count} changed file(s) in '${component}' NOT analysed — ${/** @type {Error} */ (e).message}`);
    return null;
  }
}

/**
 * The resolver's `callerState`, noting each file outside every tsconfig the TypeScript
 * resolver reports (`not-in-program`) as its answer arrives, so the warnings come in the
 * order the answers did.
 * @param {any} resolver
 * @param {string} repo Absolute repository root.
 * @param {(relPath: string) => void} onOutside
 */
function notingOutsideProgram(resolver, repo, onOutside) {
  return {
    ...resolver,
    callerState: async (/** @type {string} */ file, /** @type {number} */ pos, /** @type {any} */ opts) => {
      const cs = await resolver.callerState(file, pos, opts);
      if (cs.reason === 'not-in-program') onOutside(path.relative(repo, file).split(path.sep).join('/'));
      return cs;
    },
  };
}

/**
 * The changed, deleted and outside parts of one TypeScript/JavaScript file, parsed with
 * `ts`: `changedSymbolsIn` (src/engine/changed-symbols.js) with this language's symbol
 * walk. Shared by `prepare` and the no-checkout preview (src/engine/analyze-remote.js).
 * Pure: it reads no file.
 * @param {any} ts The TypeScript module.
 * @returns {(file: Parameters<typeof import('../../engine/changed-symbols').changedSymbolsIn>[2]) => { changed: any[], deleted: any[], outside: any[] }}
 */
function changedSymbolsWith(ts) {
  const { makeSymbols } = require('../../engine/symbols');
  const { changedSymbolsIn } = require('../../engine/changed-symbols');
  const S = makeSymbols(ts);
  return (file) => changedSymbolsIn(ts, S, file);
}

/**
 * Finds the changed symbols of every changed TypeScript/JavaScript file and builds one
 * caller resolver per tsconfig project (one unit each).
 *
 * Hooks read from `ctx.hooks`:
 * - `makeResolver({ ts, componentDir, component, repoRoot })`: the environment's resolver
 *   for a project (the editor's language server). Omitted: a TypeScript language service
 *   per project. Returning null skips the project with a warning.
 * - `makeModuleCallers({ ts, repo, git })`: the cross-file module-caller index (the
 *   editor's worker pool). Omitted: the synchronous index.
 *
 * Owns the language services its resolvers share (`servicePool`): `extras.dispose`
 * releases them, and a rejection releases them before it propagates.
 * @param {PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
async function prepare(ctx) {
  const { repo, git, files, baseTexts, changedRanges, deletions, warnings, report, signal, hooks } = ctx;
  const { clearProjectCache } = require('../../engine/diff');
  const { throwIfCancelled } = require('../../engine/cancellation');
  // Untyped engine modules: their JSDoc defaults (`null`) would be read as their types.
  const { createTsResolver } = /** @type {any} */ (require('../../engine/resolver-ts'));
  const { createModuleCallers, withModuleCallers } = /** @type {any} */ (require('../../engine/module-callers'));
  // Per-run: the extension host lives for hours, and a tsconfig added since the last run
  // must be seen.
  clearProjectCache();
  const byComponent = filesByProject(repo, files);
  // Cache: language services and document registries shared by the projects of this
  // run. Owner: this `prepare` call, then the run through `extras.dispose`. Key:
  // TypeScript version and config path for a service, the TypeScript module for a
  // registry; the config is read once, and a file's version is its mtime, so an edit
  // during the run is seen by the service. Invalidation: none; the next run builds a new
  // pool. Disposal: `extras.dispose`, which the pipeline calls once the caller stage is
  // over (on failure and cancellation too), or the `catch` below when this rejects.
  const servicePool = { services: new Map(), registries: new Map() };
  const disposePool = () => { for (const svc of servicePool.services.values()) svc.dispose(); };
  /** @type {any} */
  let workspaceGraph;
  // Shared by every project: the index it builds on first use covers the whole worktree.
  /** @type {any} */
  let moduleCallers = null;
  // `component\0relPath` of each changed file no tsconfig in its project includes.
  const outsideProgram = new Set();
  /** @type {AnalysisUnit[]} */
  const units = [];
  let compIndex = 0;
  try {
    for (const [comp, entry] of byComponent) {
      throwIfCancelled(signal);
      const compFiles = entry.files;
      report({ phase: 'component', component: comp, done: compIndex++, total: byComponent.size });
      const dir = path.join(repo, entry.root);
      const ts = tryLoadTypeScript(repo, dir, ctx, comp, compFiles.length);
      if (!ts) continue;

      const symbolsOf = changedSymbolsWith(ts);
      if (!moduleCallers) moduleCallers = hooks.makeModuleCallers
        ? hooks.makeModuleCallers({ ts, repo, git }) : createModuleCallers(ts, repo, git);
      if (entry.config === null) {
        warnings.push(`${compFiles.length} changed file(s) have no tsconfig.json or jsconfig.json — analysed as one inferred JavaScript project, as the editor does; callers in other files come from static import and require() statements`);
      }
      let projectResolver;
      if (hooks.makeResolver) {
        projectResolver = hooks.makeResolver({ ts, componentDir: dir, component: comp, repoRoot: repo });
      } else if (entry.config === null) {
        const members = inferredProjectFiles(repo, git);
        projectResolver = members && createTsResolver(ts, dir, { repoRoot: repo, servicePool, inferredFiles: members });
      } else {
        if (!workspaceGraph) workspaceGraph = require('../../engine/workspace-projects').workspaceProjects(ts, repo);
        projectResolver = createTsResolver(ts, dir, { tsconfig: entry.config, repoRoot: repo, workspaceGraph, servicePool });
      }
      if (!projectResolver) { warnings.push(`'${comp}': no TypeScript project could be loaded — skipped`); continue; }
      const resolver = notingOutsideProgram(withModuleCallers(projectResolver, moduleCallers), repo,
        (relPath) => { outsideProgram.add(`${comp}\u0000${relPath}`); });
      /** @type {object[]} */
      const changed = [];
      /** @type {object[]} */
      const deleted = [];
      /** @type {AnalysisUnit['outside']} */
      const outside = [];
      for (const f of compFiles) {
        const abs = path.join(repo, f.path);
        let headText = null;
        if (f.status !== 'deleted') {
          try { headText = fs.readFileSync(abs, 'utf8'); } catch { headText = null; }
        }
        // One file the parser or symbol walk chokes on must not blank the whole view.
        try {
          const r = symbolsOf({
            absPath: abs, relPath: f.path, oldPath: f.oldPath, status: f.status,
            headText,
            baseText: f.status === 'added' ? null : baseTexts.get(f.oldPath || f.path) ?? null,
            hunkRanges: changedRanges[f.path] || [],
            hunkDeletions: deletions[f.path] || [],
            component: comp,
            projectRoot: entry.root,
          });
          changed.push(...r.changed);
          deleted.push(...r.deleted);
          if (r.outside.length) outside.push({ file: abs, relPath: f.path, ranges: r.outside });
        } catch (e) {
          warnings.push(`${f.path}: could not be analysed — ${e && /** @type {Error} */ (e).message}`);
        }
      }
      for (const c of changed) moduleCallers.hint(c);
      units.push({ component: comp, projectRoot: entry.root, changed, deleted, outside, resolver });
    }
  } catch (e) {
    disposePool();
    throw e;
  }
  return {
    units,
    extras: {
      notes: () => {
        const out = [];
        for (const k of outsideProgram) {
          const [comp, rel] = k.split('\u0000');
          out.push(`${rel} is not included by the tsconfig.json or jsconfig.json in '${comp}' — its callers are unknown`);
        }
        if (moduleCallers) out.push(...moduleCallers.notes());
        return out;
      },
      dispose: disposePool,
      // The editor expands rows lazily through its own resolver; it must add the same
      // module callers.
      resultProperties: { moduleCallers },
    },
  };
}

/**
 * The editor resolver's TypeScript extras; see ./editor-extras.js.
 * @type {NonNullable<import('../types').LanguageProvider['editorCallers']>}
 */
const editorCallers = (options) => require('./editor-extras').createTypescriptEditorExtras(options);

/** @type {import('../types').LanguageProvider} */
const typescriptProvider = Object.freeze({
  ...typescriptRules,
  needsServer: false,
  prepare,
  editorCallers,
});

module.exports = { typescriptProvider, changedSymbolsWith };
