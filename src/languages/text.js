// @ts-check
'use strict';
// Small text helpers every language provider uses: line starts and the line of an offset,
// repository-relative paths with `/`, and an error's message. Pure; no file system.

/**
 * Offset of each line's first character. Lines end at `\n` (a `\r` before it stays on its
 * line), so offsets are UTF-16 code units into `text`.
 * @param {string} text
 * @returns {number[]} Ascending; the first is 0.
 */
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/**
 * The one-based line holding `offset`, by binary search over `lineStartsOf`'s answer.
 * @param {number[]} starts From `lineStartsOf`.
 * @param {number} offset
 * @returns {number} One-based.
 */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** @param {string} relPath @returns {string} The path with `/` separators. */
const slashed = (relPath) => String(relPath).replace(/\\/g, '/');

/** @param {unknown} e @returns {string} Its message, or the value as text. */
const messageOf = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));

module.exports = { lineStartsOf, lineOf, slashed, messageOf };
