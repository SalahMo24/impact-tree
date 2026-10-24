// @ts-check
'use strict';
// Whether a place gopls lists as an incoming call is a call (docs/MULTI_LANGUAGE_PLAN.md,
// G4). gopls' call hierarchy lists every reference to a function from inside another
// function, with `fromRanges` at the identifier: `Args: noArgsConstraint`, `f` passed as an
// argument and a method value `x.M` are listed as callers just like `f(x)` (G0, item 4).
// Only the text after the identifier tells them apart. Pure: reads only the text given.

// How far past a site's end the classifier looks, in UTF-16 code units, for the `(` (past
// white space, comments and a generic instantiation). A site whose `(` or `[...]`'s end is
// not found within it is unknown, never a value use.
const MAX_LOOKAHEAD = 4096;

/** @param {string} ch @returns {boolean} A character that can end a Go identifier. */
const isIdentifierChar = (ch) => /[\p{L}\p{Nd}_]/u.test(ch);

/**
 * Skips white space and comments from `i`. Go inserts a semicolon at a newline that follows
 * an identifier or a `]` (the spec's "Semicolons"), so a newline, a `//` comment (which
 * runs to one) or a `/* *\/` comment holding one ends the expression: `f` then a newline is
 * never the callee of a `(` on the next line.
 * @param {string} text @param {number} i @param {number} limit Exclusive.
 * @returns {{ at: number, newline: boolean }|null} The next token's offset, or `limit`
 *   when only space and comments precede it; null for a comment that does not close
 *   before `limit`.
 */
function skipSpace(text, i, limit) {
  let newline = false;
  while (i < limit) {
    const ch = text[i];
    if (ch === '\n') { newline = true; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '/' && text[i + 1] === '/') return { at: i, newline: true };
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close + 2 > limit) return null;
      if (text.slice(i + 2, close).includes('\n')) newline = true;
      i = close + 2;
      continue;
    }
    return { at: i, newline };
  }
  return { at: limit, newline };
}

/**
 * The offset just past a balanced `[...]` starting at `i` (`text[i]` is `[`), or null when
 * it does not close within `limit`. Brackets inside it nest (`f[map[string]int]`).
 * @param {string} text @param {number} i @param {number} limit Exclusive.
 * @returns {number|null}
 */
function skipBrackets(text, i, limit) {
  let depth = 0;
  for (; i < limit; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i + 1;
  }
  return null;
}

/**
 * Whether the reference at `site` is called: from the end of its range, past white space
 * and comments and an optional generic instantiation `[...]`, the next character is `(`.
 * `f(x)`, `f (x)`, `f /* c *\/ (x)`, `f[int](x)`, `x.M()` are calls; `Args: f`, `g(f)`,
 * `h := f`, `x.M`, `f[int]` alone, and `f` at a line's end are value uses.
 * @param {string|null} text The caller file's text the site's offsets refer to; null when
 *   it could not be read.
 * @param {{ start: number|null, end: number|null }} site UTF-16 offsets, end exclusive, of
 *   the referencing identifier.
 * @returns {boolean|null} True: a call. False: a value use. Null: unknown (no text, a range
 *   outside it or not ending in an identifier, or the lookahead ran out), which is neither.
 */
function isGoCallSite(text, site) {
  if (typeof text !== 'string') return null;
  const { start, end } = site;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const s = /** @type {number} */ (start);
  const e = /** @type {number} */ (end);
  if (!(0 <= s && s < e && e <= text.length)) return null;
  // The range must end at an identifier, as gopls' does; a server that gave the whole call
  // expression would otherwise read as a value use.
  if (!isIdentifierChar(text[e - 1])) return null;
  const limit = Math.min(text.length, e + MAX_LOOKAHEAD);
  let next = skipSpace(text, e, limit);
  if (next && !next.newline && next.at < limit && text[next.at] === '[') {
    const closed = skipBrackets(text, next.at, limit);
    next = closed == null ? null : skipSpace(text, closed, limit);
  }
  if (!next) return null;
  if (next.newline) return false;
  // Nothing but space up to the end of the text: nothing calls it. Up to the lookahead's
  // end only: what follows is not known.
  if (next.at === limit) return limit === text.length ? false : null;
  return text[next.at] === '(';
}

module.exports = { isGoCallSite, MAX_LOOKAHEAD };
