// @ts-check
'use strict';
// Checks a language server's "nothing uses this" before it becomes "no callers".
//
// The editor's TypeScript server searches only the projects it has loaded. A component's
// tests often live in their own config (`tsconfig.test.json`, `include: ["tests/**"]`)
// next to a `tsconfig.json` that includes only `src/`. The server never loads that test
// project for a source file, so its call hierarchy and its references both miss calls
// from tests. The same goes for any project the server has not loaded yet. The symbol
// then reads as "no callers" although "Find References" from an open test shows it used.
//
// A text search for the name finds such files. It keeps only files that import the
// declaring module: a relative specifier must resolve to it; any other (a `baseUrl` or
// `paths` alias such as `src/data/x`) must come from the same package (nearest
// package.json) and end the declaring file's path. A class member's users must also name
// its class. A monorepo's copy of a file in another package is therefore not counted.
// A file that passes is evidence of a use, not a caller: the answer becomes unknown and
// names the files, so the reviewer checks them by hand.
//
// Bounds: one `git grep` per symbol, with a deadline; at most MAX_CANDIDATES files read,
// each at most MAX_FILE_BYTES. Past the file limit the rest is unchecked, and that is said.

const fs = require('fs');
const path = require('path');

const MAX_CANDIDATES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const GREP_TIMEOUT_MS = 5000;
const NAMED_FILES = 3;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const MODULE_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/g;

/**
 * @typedef {{ name: string, className: string|null }} SymbolName
 */

/**
 * The name declared at `pos` and the class it belongs to, or null when no function,
 * method, property or variable is named there. A constructor is not named: its users
 * are constructions, which a DI container hides anyway.
 * @param {any} ts TypeScript module, used only to parse.
 * @param {string} text Source text of the declaring file.
 * @param {string} fileName For the parser's script kind.
 * @param {number} pos Offset of the declaration's name.
 * @returns {SymbolName|null}
 */
function symbolNameAt(ts, text, fileName, pos) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  /** @type {SymbolName|null|undefined} undefined while not found */
  let found;
  /** @param {any} node @param {string|null} cls */
  const visit = (node, cls) => {
    if (found !== undefined || pos < node.getFullStart() || pos >= node.getEnd()) return;
    const owner = ts.isClassDeclaration(node) || ts.isClassExpression(node) ? (node.name ? node.name.text : null) : cls;
    const topLevel = ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node);
    const member = ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertySignature(node);
    if ((topLevel || member) && node.name && ts.isIdentifier(node.name) && node.name.getStart(sf) === pos) {
      // A member of an anonymous class cannot be narrowed by its class's name.
      found = member && owner === null ? null : { name: node.name.text, className: member ? owner : null };
      return;
    }
    ts.forEachChild(node, (/** @type {any} */ k) => visit(k, owner));
  };
  ts.forEachChild(sf, (/** @type {any} */ k) => visit(k, null));
  return found ?? null;
}

/**
 * The folder of the nearest package.json at or above `abs`, inside `repo`; `repo` when
 * there is none.
 * @param {string} abs
 * @param {string} repo
 * @param {(p: string) => boolean} exists
 * @returns {string}
 */
function packageRootOf(abs, repo, exists) {
  for (let dir = path.dirname(abs); dir.startsWith(repo) && dir !== repo; dir = path.dirname(dir)) {
    if (exists(path.join(dir, 'package.json'))) return dir;
  }
  return repo;
}

/**
 * Whether a module specifier in `importer` can name `declFile`. A relative one must
 * resolve to it. Another (a `baseUrl` or `paths` alias such as `src/data/x`) must come
 * from the same package and end the declaring file's path; a package name is not followed.
 * @param {string} spec
 * @param {string} importer Absolute path of the importing file.
 * @param {{ declFile: string, packageRoot: string, importerRoot: string }} o
 * @returns {boolean}
 */
function specifierNames(spec, importer, { declFile, packageRoot, importerRoot }) {
  const bare = spec.replace(SOURCE_FILE, '').replace(/\/index$/, '');
  const decl = declFile.replace(SOURCE_FILE, '');
  const targets = path.basename(decl) === 'index' ? [decl, path.dirname(decl)] : [decl];
  if (bare.startsWith('./') || bare.startsWith('../') || bare === '.' || bare === '..') {
    return targets.includes(path.resolve(path.dirname(importer), bare));
  }
  if (importerRoot !== packageRoot) return false;
  const tail = path.sep + bare.split('/').join(path.sep);
  return targets.some((t) => t.endsWith(tail));
}

/**
 * Whether `text` imports, requires or re-exports the declaring module (see specifierNames).
 * @param {string} text
 * @param {string} importer
 * @param {{ declFile: string, packageRoot: string, importerRoot: string }} o
 * @returns {boolean}
 */
function importsModule(text, importer, o) {
  for (const m of text.matchAll(MODULE_SPECIFIER)) if (specifierNames(m[1], importer, o)) return true;
  return false;
}

/** @param {string} word */
const wordRe = (word) => new RegExp(`(^|[^A-Za-z0-9_$])${word.replace(/[$]/g, '\\$')}($|[^A-Za-z0-9_$])`);

/**
 * Files other than the declaring one that may use the symbol, from a text search.
 * @param {{
 *   ts: any,
 *   repo: string,
 *   declFile: string,
 *   pos: number,
 *   grep: (word: string, timeoutMs: number) => Promise<string[]>,
 *   readFile?: (abs: string) => string|null,
 *   exists?: (abs: string) => boolean,
 * }} o `grep` lists the repository-relative paths of tracked and untracked files that
 *   contain the word; it rejects when the search failed.
 * @returns {Promise<{ files: string[], unchecked: number }|null>} null when no name could
 *   be read at `pos`. `unchecked`: candidates past the limit, not read.
 */
async function findUnseenUsers({ ts, repo, declFile, pos, grep, readFile = readBounded, exists = fs.existsSync }) {
  const declText = readFile(declFile);
  if (declText === null) return null;
  const symbol = symbolNameAt(ts, declText, declFile, pos);
  if (!symbol) return null;
  const declRel = path.relative(repo, declFile).split(path.sep).join('/');
  const listed = (await grep(symbol.name, GREP_TIMEOUT_MS))
    .filter((rel) => rel !== declRel && SOURCE_FILE.test(rel) && !DECLARATION_FILE.test(rel));
  const packageRoot = packageRootOf(declFile, repo, exists);
  const files = [];
  for (const rel of listed.slice(0, MAX_CANDIDATES)) {
    const abs = path.join(repo, rel);
    const text = readFile(abs);
    if (text === null || !wordRe(symbol.name).test(text)) continue;
    // A member is also narrowed by its class's name: the module may declare others.
    if (symbol.className && !wordRe(symbol.className).test(text)) continue;
    if (importsModule(text, abs, { declFile, packageRoot, importerRoot: packageRootOf(abs, repo, exists) })) files.push(rel);
  }
  return { files, unchecked: Math.max(0, listed.length - MAX_CANDIDATES) };
}

/**
 * The reason an unknown answer gives, naming a few of the files; null when there is none.
 * @param {{ files: string[], unchecked: number }} found
 * @returns {string|null}
 */
function unseenUsersReason({ files, unchecked }) {
  if (files.length) {
    const shown = files.slice(0, NAMED_FILES).join(', ');
    const more = files.length > NAMED_FILES ? ` and ${files.length - NAMED_FILES} more` : '';
    return `used in ${files.length === 1 ? 'a file' : `${files.length} files`} the editor's search did not reach (${shown}${more})`;
  }
  if (unchecked) return `used in files the editor's search may not reach (${unchecked} files name it and were not checked)`;
  return null;
}

/** @param {string} abs @returns {string|null} */
function readBounded(abs) {
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A `grep` for findUnseenUsers over a repository's tracked and untracked (not ignored)
 * files. No match is an empty list; any other failure rejects.
 * @param {{ rawAsync: (args: string[], o?: { timeoutMs?: number }) => Promise<string> }} git
 * @returns {(word: string, timeoutMs: number) => Promise<string[]>}
 */
function gitGrep(git) {
  return async (word, timeoutMs) => {
    try {
      const out = await git.rawAsync(['grep', '-l', '-I', '-w', '-F', '--untracked', '-e', word, '--', '.'], { timeoutMs });
      return out.split('\n').filter(Boolean);
    } catch (e) {
      // git grep exits 1 when nothing matched.
      if (e && /** @type {any} */ (e).code === 1 && !/** @type {any} */ (e).killed) return [];
      throw e;
    }
  };
}

module.exports = { findUnseenUsers, unseenUsersReason, symbolNameAt, specifierNames, packageRootOf, gitGrep, MAX_CANDIDATES };
