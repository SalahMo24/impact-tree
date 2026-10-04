// @ts-check
'use strict';
const path = require('path');
const { changedSymbolKeys } = require('./engine/changed-symbols');
const models = require('./tree-row-models');
const { groupCallerRowsByFile } = require('./tree-grouping');

// The file-first review tree as data: one row per changed file, each holding the changes,
// deleted symbols and "outside functions" lines of that file, worst first. Pure: nothing
// here reads session state, registers a decoration or touches the editor, and no input
// is modified. Rows come from the builders of tree-row-models, so a change, deleted,
// outside or plain file row has exactly the fields the review identity reads, and a tick
// stored under the old tree is the same tick here. A function whose rows need a
// decoration returns it as data, as those builders do.
//
// A file with a call graph is a `reviewFile` row. It has no review identity of its own:
// its checkbox is derived from its rows. A file without one is a `file` row, which is its
// own counting row.

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/** @typedef {import('./tree-row-models').DecorationRequest} DecorationRequest */
/** @typedef {import('./tree-row-models').ResourceUriOf} ResourceUriOf */

// Below every verdict level (0 to 4): a file with nothing to rank by sorts after all others.
const NO_GRAPH_LEVEL = 5;

/**
 * A label split at its last dot, so a nested method shows its own name and where it lives.
 * @param {string} label
 * @returns {{ name: string, container: string|null }}
 */
function splitLabel(label) {
  const dot = label.lastIndexOf('.');
  if (dot <= 0 || dot === label.length - 1) return { name: label, container: null };
  return { name: label.slice(dot + 1), container: label.slice(0, dot) };
}

/**
 * A row ready to be ordered inside its file: a copy with its display name, and the keys
 * the order reads.
 * @param {TreeRow} row A change, deleted or outside row.
 * @param {string} relPath The file the row belongs to.
 * @param {number} line `startLine` for a change or deleted symbol, the first range for outside lines.
 * @returns {{ row: TreeRow, relPath: string, level: number, isOutside: boolean, line: number }}
 */
const toEntry = (row, relPath, line) => ({
  row: row.type === 'outside' ? row : { ...row, ...splitLabel(row.label) },
  relPath, level: models.classifyRowVerdict(row).level, isOutside: row.type === 'outside', line,
});

/**
 * Orders the rows of one file: verdict level, then outside rows after the others of their
 * level, then line. Rows equal in all three keep their incoming order.
 * @param {{ level: number, isOutside: boolean, line: number }} a
 * @param {{ level: number, isOutside: boolean, line: number }} b
 * @returns {number} `Array.prototype.sort` result.
 */
const compareEntries = (a, b) => a.level - b.level || Number(a.isOutside) - Number(b.isOutside) || a.line - b.line;

/**
 * The file row of a path that has rows.
 * @param {any} result
 * @param {string} relPath
 * @param {Array<{ row: TreeRow, level: number }>} entries Sorted.
 * @param {ResourceUriOf} uriOf
 * @returns {{ file: TreeRow, decoration: DecorationRequest }}
 */
function buildReviewFileRow(result, relPath, entries, uriOf) {
  const rows = entries.map((e) => e.row);
  const file = rows[0].file;
  const uri = uriOf(file, null);
  const status = models.getFileStatus(result, relPath);
  return {
    file: {
      type: 'reviewFile', label: path.basename(relPath), relPath, file, status,
      level: Math.min(...entries.map((e) => e.level)), attention: entries.filter((e) => e.level <= 1).length,
      rows, decorationUri: uri,
    },
    decoration: { uri, status, tooltip: relPath },
  };
}

/**
 * The paths the result reports as changed: those git lists and the files without a call
 * graph, without repeats.
 * @param {any} result
 * @returns {string[]}
 */
const collectChangedPaths = (result) => [...new Set([
  ...Object.keys(result.fileStatus || {}), ...(result.otherFiles || []).map((/** @type {any} */ f) => f.path),
])];

/**
 * Files first by worst level, then by how many rows need attention, then by how many rows
 * there are, each more first, then by path.
 * @param {TreeRow} a
 * @param {TreeRow} b
 * @returns {number}
 */
const compareFiles = (a, b) => a.level - b.level || (b.attention || 0) - (a.attention || 0)
  || (b.rows || []).length - (a.rows || []).length || a.relPath.localeCompare(b.relPath);

/**
 * The entries of every change, deleted and outside row of a result, built through the
 * existing row builders.
 * @param {any} result
 * @param {ResourceUriOf} uriOf
 * @returns {{ entries: ReturnType<typeof toEntry>[], decorations: DecorationRequest[] }}
 */
function buildEntries(result, uriOf) {
  const changed = result.allChanged || [];
  const gone = result.deleted || [];
  const lines = result.outside || [];
  const changes = models.buildChangeRows(changed, { result, uriOf });
  const deletions = models.buildDeletedRows(gone, { result, uriOf });
  const outsides = models.buildOutsideRows(lines, { result, uriOf });
  // each builder returns one row per input, in order
  return {
    entries: [
      ...changes.rows.map((row, i) => toEntry(row, changed[i].relPath, changed[i].startLine)),
      ...deletions.rows.map((row, i) => toEntry(row, gone[i].relPath, gone[i].startLine ?? 0)),
      ...outsides.rows.map((row, i) => toEntry(row, lines[i].relPath, lines[i].ranges[0]?.[0] ?? 0)),
    ],
    decorations: [...changes.decorations, ...deletions.decorations, ...outsides.decorations],
  };
}

/**
 * The review tree's top level: one row per changed path, worst first. A path with rows
 * becomes a `reviewFile` row holding them; a path without, or listed in `otherFiles`
 * with none, becomes a `file` row of level 5.
 * @param {any} result An `analyze()` or `analyzeRemote()` result; not modified.
 * @param {{ uriOf: ResourceUriOf, absPath?: ((relPath: string) => string)|null }} opts
 *   `absPath` makes a path absolute; without it a `file` row has no resource and no decoration.
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }}
 */
function buildFileRows(result, { uriOf, absPath = null }) {
  const built = buildEntries(result, uriOf);
  /** @type {Map<string, typeof built.entries>} */
  const byPath = new Map();
  for (const e of built.entries) byPath.set(e.relPath, [...(byPath.get(e.relPath) || []), e]);
  /** @type {DecorationRequest[]} */
  const decorations = [...built.decorations];
  /** @type {TreeRow[]} */
  const files = [];
  for (const [relPath, entries] of byPath) {
    const made = buildReviewFileRow(result, relPath, entries.slice().sort(compareEntries), uriOf);
    files.push(made.file);
    decorations.push(made.decoration);
  }
  const others = new Map((result.otherFiles || []).map((/** @type {any} */ f) => [f.path, f.status]));
  const leaves = collectChangedPaths(result).filter((p) => !byPath.has(p))
    .map((p) => ({ path: p, status: String(others.get(p) ?? models.getFileStatus(result, p)) }));
  const leafRows = models.buildFileLeafRows(leaves, { absPath, uriOf });
  files.push(...leafRows.rows.map((r) => ({ ...r, level: NO_GRAPH_LEVEL })));
  decorations.push(...leafRows.decorations);
  return { rows: files.sort(compareFiles), decorations };
}

/**
 * The rows under a change row: its direct callers, the row closing an unfinished caller
 * search, and one tests row. The callers are the ones the result holds, which already
 * carry their call state, so these rows agree with the verdict's "N of M callers".
 * @param {TreeRow} changeRow A row from `buildFileRows`.
 * @param {{ result: any, uriOf: ResourceUriOf, rel?: ((file: string) => string)|null }} opts
 *   `rel` maps a caller's file to its repo-relative path; without it the file is its own path.
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }}
 */
function buildImpactRows(changeRow, { result, uriOf, rel = null }) {
  const change = changeRow.finding;
  const classified = (change.callers || []).map((/** @type {any} */ c) => ({
    caller: c, callSiteUpdates: c.callSiteUpdates ?? models.NO_SITE_EVIDENCE,
  }));
  const ancestry = models.collectAncestry(changeRow);
  const built = models.buildCallerRows(classified, {
    ancestry, reviewParent: null, changedKeys: changedSymbolKeys(result.allChanged || []), rel, result, uriOf,
  });
  const rows = groupCallerRowsByFile(built.rows, { reviewParent: null, ancestry, uriOf });
  if (change.callersComplete === false) {
    rows.push(models.buildIncompleteCallersRow(change.callersIncompleteReason || 'the caller search did not finish', rows.length > 0));
  }
  rows.push(buildTestsRow(change, result));
  return { rows, decorations: built.decorations };
}

/**
 * The one row saying what is known about tests reaching a change. A state the result
 * does not define is not an answer, so it reads as unknown.
 * @param {any} change
 * @param {any} result
 * @returns {TreeRow}
 */
function buildTestsRow(change, result) {
  if (!result.testReachComputed) return models.buildComputeTestReachRow();
  const state = change.testState;
  if (state === 'covered') {
    const tests = change.tests || [];
    return { type: 'message', icon: 'beaker', testState: state, label: tests.length ? `Tested by ${tests.join(', ')}` : 'Tested' };
  }
  if (state === 'uncovered') {
    const note = models.buildReachScopeNote(result);
    return { type: 'message', icon: 'beaker', testState: state, label: note[0].toUpperCase() + note.slice(1) };
  }
  return { type: 'message', icon: 'question', testState: 'unknown', label: 'Test reach unknown',
    desc: change.testReachIncompleteReason || 'the test search did not finish' };
}

/**
 * The rows a reviewer ticks: the change, deleted and outside rows of every `reviewFile`,
 * and every `file` row. Caller and tests rows never count.
 * @param {TreeRow[]} files The rows from `buildFileRows`.
 * @returns {TreeRow[]}
 */
const collectCountingRows = (files) => files.flatMap((f) => (f.type === 'reviewFile' ? f.rows : [f]));

// The row types that are counting rows: one checkbox each, ticked on their own.
const COUNTING_TYPES = new Set(['finding', 'deleted', 'outside', 'file']);

/**
 * The counting rows a checkbox on `row` stands for. A `reviewFile`'s checkbox is derived
 * from its rows, so it stands for all of them; a counting row stands for itself; any other
 * row (a caller, a message, a tests row) has no checkbox and stands for nothing.
 * @param {TreeRow} row
 * @returns {TreeRow[]}
 */
const collectTickTargets = (row) => (row.type === 'reviewFile' ? row.rows : COUNTING_TYPES.has(row.type) ? [row] : []);

/**
 * Whether a counting row needs attention: a verdict at level 0 or 1. A file without a call
 * graph has no verdict and never does.
 * @param {TreeRow} row A counting row.
 * @returns {boolean}
 */
const needsAttention = (row) => row.type !== 'file' && models.classifyRowVerdict(row).level <= 1;

/**
 * How far a review has got.
 * @param {TreeRow[]} files The rows from `buildFileRows`.
 * @param {(row: TreeRow) => boolean} isReviewed Whether a counting row is ticked.
 * @returns {{ total: number, left: number, attention: number }} `attention` counts the
 *   unreviewed rows that need attention.
 */
function countReview(files, isReviewed) {
  const rows = collectCountingRows(files);
  const left = rows.filter((r) => !isReviewed(r));
  return { total: rows.length, left: left.length, attention: left.filter(needsAttention).length };
}

/**
 * The view's message and badge for a shown result: what is reviewed against what, how many
 * unreviewed rows need attention, and how many are left. A PR (a preview or a checkout) is
 * named by its number; a local review by its mode, and the mode it was asked for when the
 * analysis fell back to another.
 * @param {any} result
 * @param {{ kind: string, pr?: { number: number } }|null|undefined} source The session's source.
 * @param {{ total: number, left: number, attention: number }} counts From `countReview`.
 * @returns {{ message: string, badge: { value: number, tooltip: string }|undefined }} No
 *   badge once nothing is left.
 */
function buildReviewSummary(result, source, { total, left, attention }) {
  const pr = source && (source.kind === 'pr' || source.kind === 'checkout') && source.pr ? source.pr.number : null;
  const asked = result.requestedMode && result.requestedMode !== result.mode ? ` (requested ${result.requestedMode})` : '';
  const what = pr == null ? `${result.mode}${asked}` : `PR #${pr}`;
  return {
    message: `${what} against ${result.base.ref} · ${attention} need attention · ${left} of ${total} left`,
    badge: left > 0 ? { value: left, tooltip: `${left} of ${total} left to review` } : undefined,
  };
}

/**
 * The row for a line of a file's head side: the innermost change containing it, else the
 * file's outside row when one of its ranges contains it, else the file row.
 * @param {TreeRow[]} files The rows from `buildFileRows`.
 * @param {string} relPath Repo-relative path.
 * @param {number} line 1-based head-side line.
 * @returns {TreeRow|null} Null when no changed file has that path.
 */
function findRowAtLine(files, relPath, line) {
  const file = files.find((f) => f.relPath === relPath);
  if (!file) return null;
  if (file.type !== 'reviewFile') return file;
  /** @type {TreeRow[]} */
  const rows = file.rows;
  const around = rows.filter((r) => r.finding && line >= r.finding.startLine && line <= r.finding.endLine);
  const innermost = around.reduce((/** @type {TreeRow|null} */ best, r) => (!best || span(r) < span(best) ? r : best), null);
  if (innermost) return innermost;
  const outside = rows.find((r) => r.type === 'outside' && r.ranges.some((/** @type {number[]} */ [lo, hi]) => line >= lo && line <= hi));
  return outside || file;
}

/** @param {TreeRow} row A change row. @returns {number} Its length in lines, less one. */
const span = (row) => row.finding.endLine - row.finding.startLine;

module.exports = {
  buildFileRows, buildImpactRows, collectCountingRows, collectTickTargets, needsAttention, countReview, buildReviewSummary,
  findRowAtLine,
};
