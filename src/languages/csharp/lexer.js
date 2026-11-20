// @ts-check
'use strict';
// The C# lexer shared by the header parser (./signature.js, C2), the text outline (C3) and the
// entry rules (C4). Pure text in, tokens out; nothing here touches the editor or the file
// system.
//
// Read as single literal tokens: regular strings (`\` escapes), verbatim strings (`@"…"`, `""`
// escape), interpolated strings (`$"…"`, `$@"…"`, `@$"…"`) whose holes may nest strings,
// comments and further interpolations, raw strings (`"""…"""`, any run of three or more
// quotes) and raw interpolated strings (`$$"""…{{x}}…"""`: n `$` = n braces open a hole), the
// `u8` suffix, chars, numbers. Comments are skipped. A preprocessor line (first non-blank
// character `#`) is one `directive` token, so a consumer that cares about `#if` sees it and
// others skip it.
//
// Limits (documented, not handled): Unicode escapes (`A`) in identifiers are not decoded;
// inactive `#if` branches are lexed like active code (Roslyn, given no symbols, treats them
// as trivia).

/**
 * @typedef {{ kind: 'ident' | 'punct' | 'lit' | 'directive', text: string, start: number, end: number,
 *   holes?: Array<[number, number]> }} Token
 * `holes`: for an interpolated string, the [start, end) offsets of each hole's code.
 */

const IDENT = /@?[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER = /[0-9][0-9A-Za-z_]*(?:\.[0-9][0-9A-Za-z_]*)?/y;
const SPACE = /\s+/y;
// Two-character punctuation read as one token. `>>` is never one (generic `List<List<int>>`).
const PUNCT2 = new Set(['=>', '::', '==', '!=', '&&', '||', '??', '++', '--', '->', '?.']);

/**
 * Whether the `#` at `i` is the first non-blank character of its line.
 * @param {string} text @param {number} i
 */
function atLineStart(text, i) {
  for (let k = i - 1; k >= 0; k--) {
    const c = text[k];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '﻿') return false;
  }
  return true;
}

/**
 * Where a string or char literal starting at `i` ends, with its interpolation holes; null
 * when no literal starts at `i`, -1 as `end` when it is unterminated.
 * @param {string} text @param {number} i
 * @returns {{ end: number, holes: Array<[number, number]> } | null}
 */
function literalAt(text, i) {
  const c = text[i];
  if (c === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    return { end: j < text.length && text[j] === "'" ? j + 1 : -1, holes: [] };
  }
  // Prefixes: `$`* and at most one `@`, in either order.
  let j = i;
  let dollars = 0;
  let verbatim = false;
  while (text[j] === '$' || (text[j] === '@' && !verbatim)) {
    if (text[j] === '$') dollars++; else verbatim = true;
    j++;
  }
  if (text[j] !== '"') return null;
  /** @type {Array<[number, number]>} */
  const holes = [];
  let quotes = 0;
  while (text[j + quotes] === '"') quotes++;
  if (quotes >= 3 && !verbatim) {
    // Raw string: ends at the same run of quotes.
    const close = '"'.repeat(quotes);
    let k = j + quotes;
    while (k < text.length) {
      if (text.startsWith(close, k)) return { end: suffix(text, k + quotes), holes };
      if (dollars > 0 && text[k] === '{') {
        let run = 0;
        while (text[k + run] === '{') run++;
        if (run >= dollars) {
          const from = k + run;
          const to = holeEnd(text, from, dollars);
          if (!to) return { end: -1, holes };
          holes.push([from, to[0]]);
          k = to[1] + dollars;
          continue;
        }
        k += run;
        continue;
      }
      k++;
    }
    return { end: -1, holes };
  }
  if (quotes === 2 && !text.startsWith('"""', j)) return { end: suffix(text, j + 2), holes }; // ""
  let k = j + 1;
  while (k < text.length) {
    const ch = text[k];
    if (!verbatim && ch === '\\') { k += 2; continue; }
    if (ch === '"') {
      if (verbatim && text[k + 1] === '"') { k += 2; continue; }
      return { end: suffix(text, k + 1), holes };
    }
    if (!verbatim && ch === '\n') return { end: -1, holes };
    if (dollars > 0 && ch === '{') {
      if (text[k + 1] === '{') { k += 2; continue; }
      const to = holeEnd(text, k + 1, 1);
      if (!to) return { end: -1, holes };
      holes.push([k + 1, to[0]]);
      k = to[1] + 1;
      continue;
    }
    if (dollars > 0 && ch === '}' && text[k + 1] === '}') { k += 2; continue; }
    k++;
  }
  return { end: -1, holes };
}

/** Past a `u8` / `U8` suffix. @param {string} text @param {number} k */
const suffix = (text, k) => (/[uU]8/.test(text.slice(k, k + 2)) && !/[\p{L}\p{N}_]/u.test(text[k + 2] || '') ? k + 2 : k);

/**
 * Where an interpolation hole whose code starts at `from` ends: `[codeEnd, close]`, `close`
 * the `}` that closes it (for a raw string with n `$`, the first of n closing braces) and
 * `codeEnd` the end of its code (the format specifier's `:` when there is one: it runs to the
 * `}` and is literal text). Nested strings, chars and comments are skipped. Null when
 * unterminated.
 * @param {string} text @param {number} from @param {number} braces
 * @returns {[number, number] | null}
 */
function holeEnd(text, from, braces) {
  let depth = 0;
  let k = from;
  while (k < text.length) {
    const c = text[k];
    if (c === '/' && text[k + 1] === '/') { const nl = text.indexOf('\n', k); k = nl < 0 ? text.length : nl + 1; continue; }
    if (c === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k + 2); if (e < 0) return null; k = e + 2; continue; }
    if (c === '"' || c === "'" || ((c === '$' || c === '@') && /["$@]/.test(text[k + 1] || ''))) {
      const lit = literalAt(text, k);
      if (lit) { if (lit.end < 0) return null; k = lit.end; continue; }
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') {
      if (depth === 0) return braces === 1 || text.startsWith('}'.repeat(braces), k) ? [k, k] : null;
      depth--;
    } else if (c === ':' && depth === 0 && text[k + 1] !== ':' && text[k - 1] !== ':') {
      const close = text.indexOf('}'.repeat(braces), k);
      return close < 0 ? null : [k, close];
    }
    k++;
  }
  return null;
}

/**
 * Lex C# text from `from`, calling `visit` with each token until it returns `false`.
 * Comments are skipped; every literal is one `lit` token; a preprocessor line is one
 * `directive` token. Punctuation is one character, except `=>`, `::`, `==`, `!=`, `&&`, `||`,
 * `??`, `++`, `--`, `->`, `?.` (`>>` is two `>`). Returns the offset where lexing stopped, or
 * -1 on an unterminated comment or literal.
 * @param {string} text @param {number} from @param {(t: Token) => boolean | void} visit
 * @returns {number}
 */
function lex(text, from, visit) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    SPACE.lastIndex = i;
    if (SPACE.test(text)) { i = SPACE.lastIndex; continue; }
    if (c === '﻿') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    /** @type {Token} */
    let tok;
    const lit = c === '"' || c === "'" || c === '$' || (c === '@' && /["$]/.test(text[i + 1] || '')) ? literalAt(text, i) : null;
    if (lit) {
      if (lit.end < 0) return -1;
      tok = { kind: 'lit', text: text.slice(i, lit.end), start: i, end: lit.end };
      if (lit.holes.length) tok.holes = lit.holes;
    } else if (c === '#' && atLineStart(text, i)) {
      let nl = text.indexOf('\n', i);
      if (nl < 0) nl = text.length;
      const end = text[nl - 1] === '\r' ? nl - 1 : nl;
      tok = { kind: 'directive', text: text.slice(i, end), start: i, end };
    } else {
      IDENT.lastIndex = i;
      NUMBER.lastIndex = i;
      if (IDENT.test(text)) {
        tok = { kind: 'ident', text: text.slice(i, IDENT.lastIndex), start: i, end: IDENT.lastIndex };
      } else if (NUMBER.test(text)) {
        let end = NUMBER.lastIndex;
        // An exponent's sign: `1e-3`, `2.5E+10f`.
        if (/[eE]$/.test(text.slice(i, end)) && /[+-]/.test(text[end] || '') && /[0-9]/.test(text[end + 1] || '')) {
          NUMBER.lastIndex = end + 1;
          end = NUMBER.test(text) ? NUMBER.lastIndex : end;
        }
        tok = { kind: 'lit', text: text.slice(i, end), start: i, end };
      } else {
        const two = text.slice(i, i + 2);
        const p = PUNCT2.has(two) ? two : c;
        tok = { kind: 'punct', text: p, start: i, end: i + p.length };
      }
    }
    if (visit(tok) === false) return tok.start;
    i = tok.end;
  }
  return i;
}

/**
 * All tokens of `text` (directives included), or null when it cannot be lexed.
 * @param {string} text @returns {Token[] | null}
 */
function tokenize(text) {
  /** @type {Token[]} */
  const out = [];
  return lex(text, 0, (t) => { out.push(t); }) < 0 ? null : out;
}

/**
 * The text with comments, preprocessor lines and the contents of string and char literals
 * replaced by spaces; whitespace (so newlines and offsets), the literals' quotes and prefixes
 * and the code of interpolation holes are kept. Text after an unterminated comment or literal
 * is blanked.
 * @param {string} text @returns {string}
 */
function blank(text) {
  const out = text.split('');
  const fill = (/** @type {number} */ a, /** @type {number} */ b) => { for (let k = a; k < b; k++) if (!/\s/.test(out[k])) out[k] = ' '; };
  /** Blank a literal's contents, except the code of its holes. @param {Token} t */
  const blankLiteral = (t) => {
    let open = 0;
    while (text[t.start + open] === '$' || text[t.start + open] === '@') open++;
    let quotes = 1;
    if (text[t.start + open] === '"' && !text.slice(t.start, t.start + open).includes('@')) {
      let q = 0;
      while (text[t.start + open + q] === '"') q++;
      if (q >= 3) quotes = q;
    }
    const close = t.end - quotes - (/[uU]8$/.test(t.text) && text[t.end - 3] === '"' ? 2 : 0);
    let at = t.start + open + quotes;
    for (const [hs, he] of t.holes || []) {
      fill(at, hs);
      blankRange(hs, he);
      at = he;
    }
    fill(at, Math.max(at, close));
  };
  /** Comments, directives and literals between `a` and `b`. @param {number} a @param {number} b */
  const blankRange = (a, b) => {
    let last = a;
    const stop = lex(b === text.length ? text : text.slice(0, b), a, (t) => {
      fill(last, t.start);
      if (t.kind === 'lit') blankLiteral(t);
      else if (t.kind === 'directive') fill(t.start, t.end);
      last = t.end;
    });
    fill(last, stop < 0 ? b : stop);
  };
  blankRange(0, text.length);
  return out.join('');
}


/** The index of the token before `k` that is not a directive (-1 at the start). @param {Token[]} tokens @param {number} k */
function prevCode(tokens, k) {
  let p = k - 1;
  while (p >= 0 && tokens[p].kind === 'directive') p--;
  return p;
}

/**
 * The index of the bracket opening the group that `tokens[k]` (`)`, `]` or `>`) closes, or -1.
 * @param {Token[]} tokens @param {number} k
 */
function groupStart(tokens, k) {
  const close = tokens[k].text;
  const open = close === ')' ? '(' : close === ']' ? '[' : '<';
  let d = 0;
  for (let m = k; m >= 0; m--) {
    if (tokens[m].text === close) d++;
    else if (tokens[m].text === open && --d === 0) return m;
  }
  return -1;
}

// Words after which a `{` is an expression's brace: `x switch {`, `x with {`, `x is {`, `case {`.
const EXPRESSION_BRACE_AFTER = new Set(['new', 'switch', 'with', 'return', 'is', 'and', 'or', 'not', 'case', 'when', 'yield']);
const EXPRESSION_BRACE_AFTER_PUNCT = new Set(['=', '(', ',', '[', '?', '??']);

/**
 * Whether the `{` at `tokens[b]` opens an expression's braces (an object, collection or
 * array initializer, an anonymous type, a switch expression, `with`, a property pattern)
 * rather than a block, a type body or an accessor list. Read from the tokens before it:
 * `new D {`, `new D(…) {`, `new() {`, `new List<int> {`, `new int[] {`, `new {`, `= {`,
 * `x switch {`, `x with {`, `is {`; a `{` right after such a `{` or a `,` follows its outer brace.
 * @param {Token[]} tokens @param {number} b @returns {boolean}
 */
function isExpressionBrace(tokens, b) {
  let q = prevCode(tokens, b);
  if (q < 0) return false;
  const t = tokens[q];
  if (t.kind === 'ident') {
    if (EXPRESSION_BRACE_AFTER.has(t.text)) return true;
  } else if (t.kind === 'punct') {
    if (t.text === '{') return isExpressionBrace(tokens, q);
    if (EXPRESSION_BRACE_AFTER_PUNCT.has(t.text)) return true;
    if (t.text !== ')' && t.text !== ']' && t.text !== '>') return false;
  } else return false;
  // A creation's type: `new` [dotted name [type arguments]] [array ranks] [(arguments)] `{`.
  if (tokens[q].text === ')') { q = groupStart(tokens, q); if (q < 0) return false; q = prevCode(tokens, q); }
  while (q >= 0 && tokens[q].text === ']') { q = groupStart(tokens, q); if (q < 0) return false; q = prevCode(tokens, q); }
  if (q >= 0 && tokens[q].text === '?') q = prevCode(tokens, q);
  for (;;) {
    if (q < 0) return false;
    if (tokens[q].text === '>') { q = groupStart(tokens, q); if (q < 0) return false; q = prevCode(tokens, q); }
    if (q < 0) return false;
    if (tokens[q].kind !== 'ident') return false;
    if (tokens[q].text === 'new') return !inConstraint(tokens, q);
    const before = prevCode(tokens, q);
    if (before >= 0 && (tokens[before].text === '.' || tokens[before].text === '::')) { q = prevCode(tokens, before); continue; }
    return before >= 0 && tokens[before].text === 'new';
  }
}

/**
 * Whether the `new` at `tokens[k]` is a `new()` constraint (`where T : class, new() {`): the
 * tokens before it, through a constraint's names and punctuation, reach `where`.
 * @param {Token[]} tokens @param {number} k
 */
function inConstraint(tokens, k) {
  for (let m = prevCode(tokens, k); m >= 0; m = prevCode(tokens, m)) {
    const t = tokens[m];
    if (t.kind === 'ident') { if (t.text === 'where') return true; continue; }
    if (t.kind !== 'punct' || ![',', ':', '.', '<', '>', '?', '::'].includes(t.text)) return false;
  }
  return false;
}

/**
 * Whether the `[` at `tokens[k]` opens an attribute list rather than a collection expression,
 * a list pattern, an indexer initializer or an element access. True after nothing, `;`, `}`,
 * another attribute list's `]`, or a `{` that opens a block, type body or accessor list (not an
 * expression's brace: see `isExpressionBrace`, so `new D { [1] = 2 }`, `x switch { [1] => … }`
 * and `new() { [1, 2] }` are false); after `(` or `,` only when `inParameters` (a declaration's
 * parameter list or type parameter list `<`). Never after `=`, `return`, `=>`, `is`, `case`,
 * `in`, an identifier or `)`.
 * @param {Token[]} tokens @param {number} k @param {boolean} [inParameters]
 * @returns {boolean}
 */
function opensAttribute(tokens, k, inParameters = false) {
  if (!tokens[k] || tokens[k].text !== '[') return false;
  const p = prevCode(tokens, k);
  if (p < 0) return true;
  const prev = tokens[p];
  if (prev.kind !== 'punct') return false;
  if (prev.text === '{') return !isExpressionBrace(tokens, p);
  if (prev.text === ';' || prev.text === '}') return true;
  if (prev.text === '(' || prev.text === ',' || prev.text === '<') return inParameters;
  if (prev.text === ']') {
    let d = 0;
    let m = p;
    for (; m >= 0; m--) {
      if (tokens[m].text === ']') d++;
      else if (tokens[m].text === '[' && --d === 0) break;
    }
    return m >= 0 && opensAttribute(tokens, m, inParameters);
  }
  return false;
}

module.exports = { lex, tokenize, blank, opensAttribute, literalAt };
