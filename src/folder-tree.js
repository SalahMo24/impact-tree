// @ts-check
'use strict';
// The tree layout of the Changes view: the file rows folded into their folders, the way
// the GitHub Pull Requests extension's "View as Tree" draws a pull request's files, but
// with this extension's order kept at every level. Pure: the function returns new folder
// rows and leaves the file rows it was given as they were; the file rows are the same
// objects, so a tick, a repaint or a reveal addressed to a file finds it in both layouts.
//
// Order is the rule the flat list uses (`compareFiles` in review-tree-model), applied to
// folders and files alike inside a folder: worst level first, then more rows needing
// attention, then more files (or rows), then the path. A folder takes its level from its
// worst descendant and its attention count from all of them, so a folder never reads calmer
// than a file inside it, and the first row at any level is still the thing to look at. This
// is the answer to gate G1 of docs/FILE_FIRST_REVIEW_PLAN.md: nesting was removed because
// an alphabetical tree hid the ranking; a ranked tree does not.
//
// A folder with no file of its own and one child folder is drawn as one row named with
// both (`src/engine`), as the Explorer's compact folders are, so a deep path is not a
// ladder of single rows.
//
// Work is bounded by the input: one trie node per distinct folder of the given paths, so
// at most the sum of the paths' segment counts, and each node is visited a fixed number
// of times.

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */

/**
 * A folder of the trie while it is built. `name` is the segment (or the compacted
 * segments) it is drawn with; `dir` its repo-relative path without a trailing slash.
 * @typedef {{ name: string, dir: string, folders: Map<string, TrieNode>, files: TreeRow[] }} TrieNode
 */

/** @returns {TrieNode} */
const newNode = (name = '', dir = '') => ({ name, dir, folders: new Map(), files: [] });

/**
 * The folders of a repo-relative path: `src/engine/a.js` gives `['src', 'engine']`.
 * @param {string} relPath `/` or `\` separated.
 * @returns {string[]}
 */
const foldersOf = (relPath) => String(relPath).split(/[\\/]/).filter(Boolean).slice(0, -1);

/**
 * How many rows a row stands for in the order: a folder's files, a call-graph file's rows,
 * a file without one counts itself.
 * @param {TreeRow} row
 * @returns {number}
 */
const sizeOf = (row) => (row.type === 'folder' ? row.fileCount : row.type === 'reviewFile' ? row.rows.length : 1);

/**
 * The order inside a folder and at the root: as `compareFiles` orders the flat list, with a
 * folder ranked by what it holds.
 * @param {TreeRow} a
 * @param {TreeRow} b
 * @returns {number}
 */
const compareRanked = (a, b) => a.level - b.level || (b.attention || 0) - (a.attention || 0)
  || sizeOf(b) - sizeOf(a) || a.relPath.localeCompare(b.relPath);

/**
 * Compacts a node's single-child chains in place: a child folder with no file of its own
 * and exactly one folder under it is replaced by that folder, named with both segments.
 * Iterative over a worklist; the work is one visit per node.
 * @param {TrieNode} root
 */
function compactFolders(root) {
  const pending = [root];
  while (pending.length) {
    const node = /** @type {TrieNode} */ (pending.pop());
    for (const [key, child] of node.folders) {
      let folder = child;
      while (folder.files.length === 0 && folder.folders.size === 1) {
        const only = /** @type {TrieNode} */ (folder.folders.values().next().value);
        folder = { ...only, name: `${folder.name}/${only.name}` };
      }
      node.folders.set(key, folder);
      pending.push(folder);
    }
  }
}

/**
 * The folder row of a node, its children ordered, and every folder row made under it.
 * Recursive over the folder depth, which is bounded by the longest path given.
 * @param {TrieNode} node
 * @param {(dir: string) => any} folderUriOf
 * @param {TreeRow[]} made Every folder row built, appended to.
 * @returns {TreeRow}
 */
function toFolderRow(node, folderUriOf, made) {
  const folders = [...node.folders.values()].map((child) => toFolderRow(child, folderUriOf, made));
  const files = [...node.files, ...folders.flatMap((f) => f.files)];
  const row = {
    type: 'folder', label: node.name, relPath: node.dir,
    children: [...folders, ...node.files].sort(compareRanked),
    files,
    level: Math.min(...files.map((f) => f.level)),
    attention: files.reduce((n, f) => n + (f.attention || 0), 0),
    fileCount: files.length,
    decorationUri: folderUriOf(node.dir),
    expanded: false,
  };
  made.push(row);
  return row;
}

/**
 * The file rows folded into folders.
 * @param {TreeRow[]} files `reviewFile` and `file` rows, each with a `relPath` and a
 *   `level`; the rows are kept as they are and placed by their path.
 * @param {{ folderUriOf?: (dir: string) => any }} [opts] `folderUriOf` gives a folder row's
 *   resource (for the icon theme's folder icons); none by default.
 * @returns {{ rows: TreeRow[], folders: TreeRow[] }} `rows` are the root: folder rows and
 *   the files at the repository root, ordered; `folders` every folder row, root first in
 *   no particular order. A folder row has `children` (ordered folder and file rows),
 *   `files` (every file under it), `level`, `attention` and `fileCount`.
 */
function foldFileRows(files, { folderUriOf = () => null } = {}) {
  const root = newNode();
  for (const file of files) {
    let node = root;
    for (const name of foldersOf(file.relPath)) {
      let next = node.folders.get(name);
      if (!next) {
        next = newNode(name, node.dir ? `${node.dir}/${name}` : name);
        node.folders.set(name, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  compactFolders(root);
  /** @type {TreeRow[]} */
  const folders = [];
  const top = [...root.folders.values()].map((child) => toFolderRow(child, folderUriOf, folders));
  return { rows: [...top, ...root.files].sort(compareRanked), folders };
}

/**
 * Marks the rows that start open: the first row at each level down to the first file, so
 * the first thing on screen is the worst change, as in the flat list. Every other folder
 * and file starts closed.
 * @param {TreeRow[]} rows The root rows from `foldFileRows`, or the flat file rows.
 */
function markFirstPathOpen(rows) {
  const pending = [...rows];
  while (pending.length) {
    const row = /** @type {TreeRow} */ (pending.pop());
    row.expanded = false;
    if (row.type === 'folder') pending.push(...row.children);
  }
  let row = rows[0];
  while (row && row.type === 'folder') {
    row.expanded = true;
    row = row.children[0];
  }
  if (row && row.type === 'reviewFile') row.expanded = true;
}

module.exports = { foldFileRows, markFirstPathOpen, compareRanked };
