// @ts-check
'use strict';
// How the change tree groups rows: changes by where they are declared, callers by file,
// and plain files into a compacted folder hierarchy. Pure: every function returns new
// rows and leaves the ones it was given as they were; a group that wants a decoration
// returns it as data for the provider to publish.
const path = require('path');
const { collectRowAndNested, classifyWorstRowVerdict, getFileStatus, buildOutsideRows } = require('./tree-row-models');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/** @typedef {import('./tree-row-models').DecorationRequest} DecorationRequest */
/** @typedef {import('./tree-row-models').ResourceUriOf} ResourceUriOf */

/**
 * Change rows ordered worst first, otherwise in their incoming (score) order. A row
 * ranks by the worst change it holds, nested ones included.
 * @param {TreeRow[]} rows
 * @returns {TreeRow[]} A new array.
 */
const sortByWorstStatus = (rows) => rows
  .map((r) => /** @type {[TreeRow, number]} */ ([r, classifyWorstRowVerdict(r.members || collectRowAndNested(r)).level]))
  .sort((a, b) => a[1] - b[1]).map(([r]) => r);

/**
 * For each change row, the nearest other change row in the same file whose declaration
 * encloses its own. Rows without a declaration range have no parent.
 * @param {TreeRow[]} rows
 * @returns {Map<TreeRow, TreeRow>}
 */
function findEnclosingChanges(rows) {
  /** @type {Map<string, TreeRow[]>} */
  const byFile = new Map();
  for (const n of rows) {
    if (!byFile.has(n.file)) byFile.set(n.file, []);
    /** @type {TreeRow[]} */ (byFile.get(n.file)).push(n);
  }
  /** @type {Map<TreeRow, TreeRow>} */
  const parentOf = new Map();
  for (const n of rows) {
    const c = n.finding;
    /** @type {TreeRow|null} */
    let parent = null;
    if (c.start != null && c.end != null) {
      for (const o of /** @type {TreeRow[]} */ (byFile.get(n.file))) {
        const p = o.finding;
        if (o === n || p.start == null || p.start > c.start || p.end < c.end || (p.start === c.start && p.end === c.end)) continue;
        if (!parent || p.end - p.start < parent.finding.end - parent.finding.start) parent = o;
      }
    }
    if (parent) parentOf.set(n, parent);
  }
  return parentOf;
}

/**
 * Nests each change row under the change that encloses it. Returns copies: a nested row
 * names its container and drops the container's prefix from its label, and a container
 * holds its nested rows, worst first, in `inside`.
 * @param {TreeRow[]} rows
 * @returns {TreeRow[]} The copies of the rows no other row encloses, in input order.
 */
function nestEnclosedChanges(rows) {
  const parentOf = findEnclosingChanges(rows);
  /** @type {Map<TreeRow, TreeRow>} */
  const copyOf = new Map(rows.map((n) => {
    const parent = parentOf.get(n);
    if (!parent) return [n, { ...n }];
    const prefix = `${parent.finding.label}.`;
    return [n, { ...n, container: parent.finding.label, label: n.label.startsWith(prefix) ? n.label.slice(prefix.length) : n.label }];
  }));
  const copy = (/** @type {TreeRow} */ n) => /** @type {TreeRow} */ (copyOf.get(n));
  /** @type {Map<TreeRow, TreeRow[]>} */
  const insideOf = new Map();
  /** @type {TreeRow[]} */
  const top = [];
  for (const n of rows) {
    const parent = parentOf.get(n);
    if (!parent) { top.push(copy(n)); continue; }
    if (!insideOf.has(parent)) insideOf.set(parent, []);
    /** @type {TreeRow[]} */ (insideOf.get(parent)).push(copy(n));
  }
  for (const [parent, inside] of insideOf) copy(parent).inside = sortByWorstStatus(inside);
  return top;
}

/**
 * Groups body-only change rows by where they live. Call edges have already nested
 * everything they can, so the remaining structure is location: a change declared inside
 * another nests under it, and in the tree layout a file holding several becomes one row.
 * Nothing is dropped: every change stays reachable, and the worst state in a group leads
 * its row, so a ⛔ cannot hide inside a collapsed group. The changed lines outside any
 * function (`result.outside`) join their file's changes, last: they are a change of the
 * file like the others, and cannot nest under one.
 * @param {TreeRow[]} rows Change rows from `buildChangeRows`; not modified.
 * @param {{ layout: string, result: any, uriOf: ResourceUriOf }} opts
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }} Decorations for the file rows
 *   and the outside-functions rows.
 */
function groupChangesByLocation(rows, { layout, result, uriOf }) {
  const outside = buildOutsideRows(result.outside || [], { result, uriOf });
  const top = [...nestEnclosedChanges(rows), ...outside.rows];
  /** @type {DecorationRequest[]} */
  const decorations = [...outside.decorations];
  if (layout === 'flat') return { rows: sortByWorstStatus(top), decorations };
  /** @type {Map<string, TreeRow[]>} */
  const rowsByFile = new Map();
  for (const n of top) {
    if (!rowsByFile.has(n.file)) rowsByFile.set(n.file, []);
    /** @type {TreeRow[]} */ (rowsByFile.get(n.file)).push(n);
  }
  /** @type {TreeRow[]} */
  const out = [];
  for (const [file, fileRows] of rowsByFile) {
    // a one-child group is pure overhead, the rule caller files and folders follow
    if (fileRows.length === 1) { out.push(fileRows[0]); continue; }
    const relPath = (fileRows[0].finding || fileRows[0]).relPath;
    const uri = uriOf(file, null);
    decorations.push({ uri, status: getFileStatus(result, relPath), tooltip: relPath });
    // the group names the file, so its outside row need not
    const members = fileRows.map((n) => (n.type === 'outside' ? { ...n, inGroup: true } : n));
    out.push({
      type: 'changeFile', label: path.basename(relPath), relPath, file,
      rows: sortByWorstStatus(members), members: members.flatMap(collectRowAndNested), decorationUri: uri,
    });
  }
  return { rows: sortByWorstStatus(out), decorations };
}

// Worst state wins, so a group never looks calmer than its contents.
/** @type {Record<string, number>} */
const CALL_STATE_RANK = { 'changed-elsewhere': 3, unchanged: 2, 'updated-at-call': 1 };

/**
 * One row per file, not per calling function. A file with three methods that each call
 * the change read as the same file repeated three times; the callers are still distinct
 * impacts, so they become children rather than disappearing. A file with a single
 * caller stays flat: a one-child group is pure noise, the rule folders already follow.
 * @param {TreeRow[]} callerRows From `buildCallerRows`, in display order; not modified.
 * @param {{ reviewParent: string|null, ancestry: string[], uriOf: ResourceUriOf }} opts
 * @returns {TreeRow[]}
 */
function groupCallerRowsByFile(callerRows, { reviewParent, ancestry, uriOf }) {
  /** @type {Map<string, TreeRow[]>} */
  const byFile = new Map();
  for (const c of callerRows) {
    const key = c.relPath || c.file;
    if (!byFile.has(key)) byFile.set(key, []);
    /** @type {TreeRow[]} */ (byFile.get(key)).push(c);
  }
  /** @type {TreeRow[]} */
  const grouped = [];
  for (const [rel, rows] of byFile) {
    if (rows.length === 1) { grouped.push(rows[0]); continue; }
    const rank = (/** @type {TreeRow} */ x) => CALL_STATE_RANK[x.callState] || 0;
    const worst = rows.slice().sort((a, b) => rank(b) - rank(a))[0];
    grouped.push({
      type: 'callerFile', reviewParent,
      label: path.basename(rel),
      relPath: rel,
      file: rows[0].file,
      callers: rows,
      test: rows.every((x) => x.test),
      changed: rows.some((x) => x.changed),
      callState: worst.callState,
      sites: rows.reduce((n, x) => n + (x.sites || 0), 0),
      decorationUri: uriOf(rows[0].file, null),
      path: [...ancestry],
    });
  }
  return grouped;
}

/** @typedef {{ dirs: Map<string, DirNode>, files: TreeRow[] }} DirNode */

/**
 * Rows for one directory's children: folders first, then files, each sorted by label.
 * A folder holding exactly one folder and no files merges into it, as the explorer's
 * compact folders do.
 * @param {DirNode} node
 * @param {string} prefix Repo-relative path of `node`; '' at the top.
 * @param {string[]} segs Names already merged into the next folder row.
 * @returns {TreeRow[]}
 */
function emitDirectoryRows(node, prefix, segs) {
  /** @type {TreeRow[]} */
  const out = [];
  for (const [name, child] of node.dirs) {
    const nextSegs = [...segs, name];
    const nextPrefix = prefix ? `${prefix}/${name}` : name;
    if (child.dirs.size === 1 && child.files.length === 0) {
      out.push(...emitDirectoryRows({ dirs: child.dirs, files: [] }, nextPrefix, nextSegs));
      continue;
    }
    out.push({ type: 'dir', label: nextSegs.join('/'), dirPath: nextPrefix, node: child });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out.concat([...node.files].sort((a, b) => a.label.localeCompare(b.label)));
}

/**
 * Nests file rows under folder rows. The GitHub PR extension groups with a real folder
 * hierarchy rather than spacing; blank rows were a poor substitute (selectable,
 * keyboard-navigable and visually noisy). Single-child chains collapse so
 * `src/data/application-state` is one row.
 * @param {TreeRow[]} leaves File rows with a forward-slash `relPath`; not modified.
 * @returns {TreeRow[]} The top level; each folder row carries its subtree in `node`.
 */
function buildFileTreeRows(leaves) {
  /** @type {DirNode} */
  const root = { dirs: new Map(), files: [] };
  for (const leaf of leaves) {
    const parts = leaf.relPath.split('/');
    const fileName = parts.pop();
    let cur = root;
    for (const part of parts) {
      if (!cur.dirs.has(part)) cur.dirs.set(part, { dirs: new Map(), files: [] });
      cur = /** @type {DirNode} */ (cur.dirs.get(part));
    }
    cur.files.push({ ...leaf, label: fileName });
  }
  return emitDirectoryRows(root, '', []);
}

/**
 * The children of an expanded folder row, compacted exactly as the top level is.
 * @param {TreeRow} dirRow A row from `buildFileTreeRows` or from this function.
 * @returns {TreeRow[]}
 */
const buildDirectoryChildRows = (dirRow) => emitDirectoryRows(dirRow.node, dirRow.dirPath, []);

module.exports = {
  sortByWorstStatus, groupChangesByLocation, groupCallerRowsByFile, buildFileTreeRows, buildDirectoryChildRows,
};
