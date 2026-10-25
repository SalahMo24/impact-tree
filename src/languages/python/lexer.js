// @ts-check
'use strict';
// Python string literals and comments, read one way for every Python scanner: the header
// parser and its raise scan (./signature.js), the definition recovery (./provider.js) and
// the caller checks (./editor-extras.js). Pure text in, offsets out.
//
// A string: an optional prefix (`r`, `b`, `u`, `f`, or two of them, not part of a longer
// name), then `'`, `"`, `'''` or `"""`. A backslash always skips the next character, raw
// strings included (in `r"\""` the escaped quote does not end the string, as in Python).
// In an f-string, a quote inside a `{…}` field opens a nested string (Python 3.12 allows
// the same quote), and `{{` is a literal brace. A single-quoted string ends at its line's
// end when not closed (unterminated); a triple-quoted one runs to the scan's limit.

const PREFIX = /[rRbBuUfF]/;
const WORD = /[\p{L}\p{N}_]/u;

/**
 * The prefix letters before the quote at `quoteAt`, lowercased: `''` when none, or when the
 * letters belong to a longer name (`xf"…"` is a name followed by a string).
 * @param {string} text @param {number} quoteAt
 * @returns {string}
 */
function prefixBefore(text, quoteAt) {
  let i = quoteAt;
  while (i > 0 && quoteAt - i < 2 && PREFIX.test(text[i - 1])) i--;
  if (i > 0 && WORD.test(text[i - 1])) return '';
  return text.slice(i, quoteAt).toLowerCase();
}

/**
 * Where the string literal whose opening quote is at `quoteAt` ends.
 * Bound: one pass from `quoteAt`, never past `limit`; a field's nested string is skipped in
 * the same pass.
 * @param {string} text
 * @param {number} quoteAt Index of the opening quote (after any prefix).
 * @param {number} [limit] Offset the scan never passes; `text.length` by default.
 * @returns {{ end: number, terminated: boolean, fString: boolean }} `end`: just past the
 *   closing quote; for an unterminated single-quoted string the index of the line end (or
 *   `limit`), for an unterminated triple-quoted one `limit`.
 */
function scanString(text, quoteAt, limit = text.length) {
  const q = text[quoteAt];
  const triple = text.startsWith(q.repeat(3), quoteAt);
  const close = triple ? q.repeat(3) : q;
  const fString = prefixBefore(text, quoteAt).includes('f');
  let depth = 0;
  let j = quoteAt + close.length;
  while (j < limit) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (fString && c === '{') {
      if (depth === 0 && text[j + 1] === '{') { j += 2; continue; }
      depth++; j++; continue;
    }
    if (fString && depth > 0) {
      if (c === '}') { depth--; j++; continue; }
      if (c === '"' || c === "'") { j = scanString(text, j, limit).end; continue; }
    }
    if (!triple && (c === '\n' || c === '\r')) return { end: j, terminated: false, fString };
    if (depth === 0 && text.startsWith(close, j)) return { end: j + close.length, terminated: true, fString };
    j++;
  }
  return { end: Math.min(j, limit), terminated: false, fString };
}

/**
 * The parts of `text` that are not code: `#` comments and string literals.
 * @param {string} text
 * @param {{ fStringsAsCode?: boolean }} [options] `fStringsAsCode`: leave f-strings out of
 *   the ranges, since their fields are code (the caller checks count a call in one).
 * @returns {Array<[number, number]>} Sorted, disjoint `[start, end)` ranges; a string's range
 *   starts at its first quote.
 */
function nonCodeRanges(text, { fStringsAsCode = false } = {}) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? n : nl;
      out.push([i, end]);
      i = end;
    } else if (c === '"' || c === "'") {
      const s = scanString(text, i);
      if (!(fStringsAsCode && s.fString)) out.push([i, s.end]);
      i = Math.max(s.end, i + 1);
    } else i++;
  }
  return out;
}

module.exports = { scanString, nonCodeRanges, prefixBefore };
