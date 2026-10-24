// @ts-check
'use strict';
// Finding the TypeScript compiler a repository's files are parsed and analysed with.
// Everything that needs the compiler loads it through here: the analysis only from the
// TypeScript provider's `prepare` (./provider.js), so a review with no TypeScript or
// JavaScript file never loads it.
const fs = require('fs');
const path = require('path');
const { typescriptRules } = require('./rules');

// Prefer the project's own TypeScript so analysis matches what the editor sees; fall
// back to the repo root, then to whatever this extension was installed with.
// Prefer the repo's OWN TypeScript so we parse with the version the project compiles
// with, and fall back to the copy shipped with the extension. A monorepo commonly has
// no install at its root -- every package has its own -- so the repo root alone is not
// a sufficient place to look.
/**
 * @param {string|null} repo Absolute repository root, if there is one.
 * @param {string|null} projectDir Absolute directory of the project the file is in.
 * @returns {any} The TypeScript compiler module (`any`: it is loaded dynamically from
 *   whichever install is found, and its API is not typed here).
 * @throws {Error} No usable compiler could be found.
 */
function loadTypeScript(repo, projectDir) {
  // TypeScript 7 is the native rewrite: its package exports only `unstable/*` plus a
  // version stub, with no createSourceFile and no createLanguageService. Loading it
  // and discovering that three call frames later produces a baffling error, so any
  // candidate that does not expose the compiler API is rejected and we keep looking.
  /** @param {any} m A loaded module (`any`: it may be any TypeScript version). */
  const usable = (m) => !!m && typeof m.createSourceFile === 'function'
    && typeof m.createLanguageService === 'function';
  /** @type {string[]} */
  const rejected = [];
  /** @param {string|null} base Directory to resolve `typescript` from. */
  const tryAt = (base) => {
    if (!base) return null;
    /** @type {any} */
    let m;
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
    /** @param {string} d Absolute directory. */
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

/**
 * The compiler, when a review has a TypeScript or JavaScript file: what an environment
 * loads up front for such a review (as it always did), and a review without one skips.
 * @param {string} repo Absolute repository root; the compiler is looked for from there.
 * @param {Iterable<string>} relPaths The review's changed paths, repository-relative.
 * @returns {object|null} Null when no path is TypeScript or JavaScript.
 * @throws {Error} No usable compiler, for a review that has such a file.
 */
function loadTypeScriptIfUsed(repo, relPaths) {
  for (const rel of relPaths) if (typescriptRules.handles(rel)) return loadTypeScript(repo, repo);
  return null;
}

module.exports = { loadTypeScript, loadTypeScriptIfUsed };
