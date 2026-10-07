// @ts-check
'use strict';
// The lines a pull request's diff shows, per side: the lines inside its hunks, context
// lines included. These are the only lines GitHub accepts a review comment on (a LEFT
// comment on a base line, a RIGHT comment on a head line), so the review diff offers
// commenting exactly there.
//
// Two sources. GitHub's own patch (a PR preview) carries its hunks with three lines of
// context, and its `@@` headers are the answer as they stand. The local diff of a checkout
// is taken with `--unified=0` (a context line is not a changed line), so its changes are
// widened here by the same three context lines GitHub uses. The union of each change
// widened by three lines is exactly the set of lines git's default hunks hold: git joins
// two changes into one hunk when at most six unchanged lines separate them, which is when
// their widened spans touch, and otherwise shows three lines on each side of each.

/** Context lines on each side of a change in GitHub's pull request diff. */
const GITHUB_CONTEXT_LINES = 3;

/**
 * @typedef {Array<[number, number]>} LineSpans 1-based, inclusive, sorted, disjoint and
 *   not adjacent.
 * @typedef {{ left: LineSpans, right: LineSpans }} DiffLines `left` holds base lines,
 *   `right` head lines. The upper end of a widened local change is not clipped to the
 *   file's length (the diff does not say it); a consumer clips to the document.
 * @typedef {{ oldStart: number, oldCount: number, newStart: number, newCount: number }} DiffChange
 *   One `--unified=0` hunk header. A count of 0 means the side has no lines there; the
 *   start is then the line after which the other side's lines go (0: before line 1).
 */

/**
 * Sorts and joins overlapping or adjacent spans.
 * @param {LineSpans} spans
 * @returns {LineSpans}
 */
function mergeSpans(spans) {
  const sorted = spans.filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0]);
  /** @type {LineSpans} */
  const merged = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

/**
 * The lines a GitHub patch's hunks show, from their hunk headers (`-a,b +c,d`).
 * @param {string|null|undefined} patch A file's `patch` from the pull request files API.
 *   Absent for a binary file or one too large for GitHub to diff.
 * @returns {DiffLines} Empty spans when there is no patch.
 */
function diffLinesFromPatch(patch) {
  /** @type {LineSpans} */
  const left = [];
  /** @type {LineSpans} */
  const right = [];
  for (const line of String(patch || '').split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const oldStart = Number(m[1]), oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]), newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount > 0) left.push([oldStart, oldStart + oldCount - 1]);
    if (newCount > 0) right.push([newStart, newStart + newCount - 1]);
  }
  return { left: mergeSpans(left), right: mergeSpans(right) };
}

/**
 * The span one side of a `--unified=0` change shows once widened by `context` lines.
 * @param {number} start
 * @param {number} count
 * @param {number} context
 * @returns {[number, number]}
 */
function widened(start, count, context) {
  // With no lines on this side, the change sits between line `start` and `start + 1`
  // (`-0,0` is an insertion before line 1).
  const first = count > 0 ? start : start + 1;
  const last = count > 0 ? start + count - 1 : start;
  return [Math.max(1, first - context), last + context];
}

/**
 * The lines GitHub's diff shows, from the changes of a `--unified=0` diff of the same
 * two commits.
 * @param {DiffChange[]} changes One file's hunk headers.
 * @param {string} status The file's change status. An added file has no base side and a
 *   deleted one no head side: the header alone cannot tell an added file from lines
 *   inserted at the top of an existing one.
 * @param {number} [context] Lines of context on each side; GitHub's by default.
 * @returns {DiffLines}
 */
function diffLinesFromChanges(changes, status, context = GITHUB_CONTEXT_LINES) {
  /** @type {LineSpans} */
  const left = [];
  /** @type {LineSpans} */
  const right = [];
  for (const c of changes) {
    if (status !== 'added') left.push(widened(c.oldStart, c.oldCount, context));
    if (status !== 'deleted') right.push(widened(c.newStart, c.newCount, context));
  }
  return { left: mergeSpans(left), right: mergeSpans(right) };
}

/**
 * Parses a `--unified=0` hunk header.
 * @param {string} line
 * @returns {DiffChange|null}
 */
function changeOfHeader(line) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

module.exports = { GITHUB_CONTEXT_LINES, diffLinesFromPatch, diffLinesFromChanges, changeOfHeader, mergeSpans };
