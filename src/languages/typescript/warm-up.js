// @ts-check
'use strict';
// Where the editor's TypeScript server is warmed (src/readiness.js): a real function or
// method name in a changed file, so the server loads the project that file is in.
const fs = require('fs');
const path = require('path');
const { typescriptRules } = require('./rules');

/**
 * The first named function or method declaration in a TypeScript/JavaScript file.
 * @param {string} repo Absolute repository root.
 * @param {string} relPath Repository-relative path of a changed file.
 * @returns {{ file: string, pos: number }|null} `file` absolute, `pos` the UTF-16 offset
 *   of the name. Null when the file is not TypeScript/JavaScript or declares none.
 * @throws {Error} The file cannot be read, or no compiler can be loaded for it.
 */
function warmUpTarget(repo, relPath) {
  if (!typescriptRules.handles(relPath)) return null;
  const { projectRootOf } = require('../../engine/diff');
  const { loadTypeScript } = require('./load');
  const abs = path.join(repo, relPath);
  const root = projectRootOf(repo, relPath) ?? '';
  const ts = loadTypeScript(repo, path.join(repo, root));
  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2021, true);
  /** @type {number|null} */
  let pos = null;
  /** @param {any} n A syntax node (`any`: the compiler's node types are not loaded here). */
  const visit = (n) => {
    if (pos != null) return;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) pos = n.name.getStart(sf);
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return pos != null ? { file: abs, pos } : null;
}

module.exports = { warmUpTarget };
