// @ts-check
'use strict';
// How the change tree groups callers: one row per file. Pure: the function returns new
// rows and leaves the ones it was given as they were.
const path = require('path');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/** @typedef {import('./tree-row-models').ResourceUriOf} ResourceUriOf */

// Worst state wins, so a group never looks calmer than its contents.
/** @type {Record<string, number>} */
const CALL_STATE_RANK = { 'changed-elsewhere': 3, unchanged: 2, 'updated-at-call': 1 };

/**
 * One row per file, not per calling function. A file with three methods that each call
 * the change read as the same file repeated three times; the callers are still distinct
 * impacts, so they become children rather than disappearing. A file with a single
 * caller stays flat: a one-child group is pure noise.
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

module.exports = { groupCallerRowsByFile };
