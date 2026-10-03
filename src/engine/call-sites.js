// @ts-check
'use strict';
// The rule for "was this caller updated for the change": pure, over supplied evidence.
// Each pipeline reads the file positions itself and passes them in as `lineOfOffset`,
// so local analysis, PR preview and the lazy tree decide the same way.

/**
 * Sort a caller's call sites by whether the diff edited the lines they sit on. A site
 * is updated when its line span overlaps a changed range; ranges are 1-based and
 * inclusive on the new side, and a deletion gap is the fractional marker `[N + 0.5,
 * N + 0.5]`, which overlaps only a site spanning lines N and N + 1. Overlap is syntactic
 * evidence that the call was edited, not that the new call is right.
 * @param {object} args
 * @param {Array<{start: number, end: number}>} [args.callSites] The caller's sites, as offsets into its file.
 * @param {Array<[number, number]>} [args.changedLineRanges] Changed ranges of the caller's file; none when it did not change.
 * @param {(offset: number) => number|null} args.lineOfOffset 1-based line of an offset in the caller's file, or null when unknown.
 * @returns {{updated: object[], untouched: object[], unknown: object[]}} The input site objects.
 *   `unknown` holds sites whose start or end line is null. Missing or empty `callSites`
 *   give three empty arrays, which is no evidence that the caller was updated.
 */
function classifyCallSiteUpdates({ callSites, changedLineRanges, lineOfOffset }) {
  const ranges = changedLineRanges || [];
  /** @type {{updated: object[], untouched: object[], unknown: object[]}} */
  const result = { updated: [], untouched: [], unknown: [] };
  for (const site of callSites || []) {
    const first = lineOfOffset(site.start), last = lineOfOffset(site.end);
    if (first == null || last == null) result.unknown.push(site);
    else if (ranges.some(([lo, hi]) => first <= hi && last >= lo)) result.updated.push(site);
    else result.untouched.push(site);
  }
  return result;
}

/**
 * Label a caller for one change. `'updated-at-call'` needs at least one updated site and
 * no untouched or unknown one: a caller that edited one call and left another is still
 * out of date. Otherwise it is `'changed-elsewhere'` when the caller symbol was edited
 * (just not at every call) and `'unchanged'` when it was not.
 * @param {object} args
 * @param {{updated: object[], untouched: object[], unknown: object[]}} args.callSiteUpdates Result of `classifyCallSiteUpdates`.
 * @param {boolean} args.callerChanged Whether the caller symbol itself changed.
 * @returns {'updated-at-call'|'changed-elsewhere'|'unchanged'}
 */
function classifyCallerUpdateState({ callSiteUpdates, callerChanged }) {
  const { updated, untouched, unknown } = callSiteUpdates;
  if (updated.length && !untouched.length && !unknown.length) return 'updated-at-call';
  return callerChanged ? 'changed-elsewhere' : 'unchanged';
}

module.exports = { classifyCallSiteUpdates, classifyCallerUpdateState };
