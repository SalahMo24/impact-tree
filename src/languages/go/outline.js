// @ts-check
'use strict';
// Go's functions and methods read from the text alone, for where there is no language
// server (the CLI, the no-checkout preview; docs/MULTI_LANGUAGE_PLAN.md, S3). `goOutline`
// answers what gopls' documentSymbol answers for a file's `func` declarations, in the same
// shape (G0, G2: test/go-symbols/recorded.json), so `collectGoSymbols` keys them as it keys
// gopls' (`(T).Name`, `init#2`) and G3's header parser reads them unchanged. Pure text in,
// plain data out; nothing here touches the editor or the file system.

/** @typedef {import('../types').ServerSymbol} ServerSymbol */

// LSP SymbolKind numbers gopls gives a method and a function (G0).
const SYMBOL_KIND_METHOD = 6;
const SYMBOL_KIND_FUNCTION = 12;
const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy;
// A receiver's name before its type: `s` in `s *Set[T]` (a bare type has no space after it).
const RECEIVER_NAME = /^\s*[\p{L}_][\p{L}\p{N}_]*\s+(?=\S)/u;
const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * Where the comment, string, raw string or rune that starts at `i` ends. A line comment
 * ends before its newline (the newline still ends a statement); a block comment, a raw
 * string and an interpreted string or rune (with `\` escapes, on one line) after their
 * closing delimiter.
 * @param {string} text
 * @param {number} i
 * @returns {number} The offset just past it; `i` when none starts at `i`; -1 when it is
 *   not terminated (the rest of the text is not code this can read).
 */
function skipNonCode(text, i) {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl < 0 ? text.length : nl;
  }
  if (c === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2);
    return close < 0 ? -1 : close + 2;
  }
  if (c === '`') {
    const close = text.indexOf('`', i + 1);
    return close < 0 ? -1 : close + 1;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== c) {
      if (text[j] === '\n') return -1;
      j += text[j] === '\\' ? 2 : 1;
    }
    return j < text.length ? j + 1 : -1;
  }
  return i;
}

/**
 * The offset just past the bracket that closes the one at `open` (`(`, `[` or `{`), any
 * bracket kind counted, comments and literals skipped. -1 when it is not closed.
 * Bound: one pass from `open`.
 * @param {string} text
 * @param {number} open
 * @returns {number}
 */
function closeOf(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const skipped = skipNonCode(text, i);
    if (skipped < 0) return -1;
    if (skipped > i) { i = skipped; continue; }
    const c = text[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c) && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

/** @param {string} text @param {number} i @returns {number} `i` past spaces and tabs. */
function skipBlanks(text, i) {
  while (text[i] === ' ' || text[i] === '\t' || text[i] === '\r') i++;
  return i;
}

/**
 * A receiver's type as gopls names the method after it (`types.ExprString`): no white
 * space, `, ` between type arguments. `s *Set[T]` gives `*Set[T]`.
 * @param {string} receiver The text between the receiver's parentheses.
 */
const receiverTypeText = (receiver) => receiver.replace(RECEIVER_NAME, '').replace(/\s+/g, '').replace(/,(?=\S)/g, ', ');

/**
 * Where a declaration's signature ends and its body (if any) is, from just past its
 * parameters' `)`: the results, then the body's `{` (the first `{` outside brackets that
 * does not open a `struct`/`interface` type) to its matching `}`. A newline or `;` before
 * any body ends a declaration without one (an assembly stub; Go inserts the semicolon), and
 * the signature then ends at its last token.
 * @param {string} text
 * @param {number} from
 * @returns {{ end: number }|null} `end` just past the `}`, or past the signature when there
 *   is no body; null when the text cannot be read (unterminated literal, unbalanced brackets).
 */
function declarationEnd(text, from) {
  let i = from;
  let lastTokenEnd = from;
  let prevWord = '';
  while (i < text.length) {
    const skipped = skipNonCode(text, i);
    if (skipped < 0) return null;
    if (skipped > i) {
      // A block comment with a newline in it ends the statement as the newline would.
      if (text[i + 1] === '*' && text.slice(i, skipped).includes('\n')) return { end: lastTokenEnd };
      if (text[i] !== '/') { lastTokenEnd = skipped; prevWord = ''; }
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '\n' || c === ';') return { end: lastTokenEnd };
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '{' && prevWord !== 'struct' && prevWord !== 'interface') {
      const close = closeOf(text, i);
      return close < 0 ? null : { end: close };
    }
    if (OPENERS.includes(c)) {
      const close = closeOf(text, i);
      if (close < 0) return null;
      i = lastTokenEnd = close;
      prevWord = '';
      continue;
    }
    IDENT.lastIndex = i;
    const word = IDENT.exec(text);
    if (word) {
      prevWord = word[0];
      i = lastTokenEnd = i + word[0].length;
      continue;
    }
    if (CLOSERS.includes(c)) return null;
    prevWord = '';
    i = lastTokenEnd = i + 1;
  }
  return { end: lastTokenEnd };
}

/**
 * The declaration whose `func` keyword is at `at`, as gopls lists it, or null when the text
 * there is not a function or method declaration this can read.
 * @param {string} text
 * @param {number} at
 * @returns {{ symbol: ServerSymbol, end: number }|null}
 */
function declarationAt(text, at) {
  let i = skipBlanks(text, at + 4);
  let receiver = null;
  if (text[i] === '(') {
    const close = closeOf(text, i);
    if (close < 0) return null;
    receiver = text.slice(i + 1, close - 1);
    i = skipBlanks(text, close);
  }
  IDENT.lastIndex = i;
  const name = IDENT.exec(text);
  if (!name) return null;
  const namePos = i;
  i = skipBlanks(text, i + name[0].length);
  if (text[i] === '[') {
    const close = closeOf(text, i);
    if (close < 0) return null;
    i = skipBlanks(text, close);
  }
  if (text[i] !== '(') return null;
  const paramsEnd = closeOf(text, i);
  if (paramsEnd < 0) return null;
  const decl = declarationEnd(text, paramsEnd);
  if (!decl) return null;
  return {
    end: decl.end,
    symbol: {
      name: receiver === null ? name[0] : `(${receiverTypeText(receiver)}).${name[0]}`,
      // gopls' detail is the signature (`func(user string) error`); nothing reads it from
      // here (`collectGoSymbols` reads the text), so this is the header after the name.
      detail: `func${text.slice(i, paramsEnd).replace(/\s+/g, ' ')}`,
      kind: receiver === null ? SYMBOL_KIND_FUNCTION : SYMBOL_KIND_METHOD,
      range: { start: at, end: decl.end },
      selectionRange: { start: namePos, end: namePos + name[0].length },
      children: [],
    },
  };
}

/**
 * The functions and methods of a Go file's text as gopls' documentSymbol gives them (G0):
 * every top-level `func` declaration, in source order, flat (a method is not a child of its
 * type), named `Name` or `(T).Name` / `(*T).Name` / `(*Set[T]).Name` by its receiver's
 * type as written, `range` from `func` to the body's closing `}` (the doc comment is
 * outside it; a declaration without a body ends at its signature), `selectionRange` the
 * name, `Function` or `Method` kind, no children. Function literals are part of their
 * parent's body and never listed, nor are types, constants and variables (gopls lists
 * them; `collectGoSymbols` drops them).
 *
 * A declaration is `func` at the start of a statement outside every bracket: comments,
 * strings, raw strings and runes are skipped, so braces and `func` in them count for
 * nothing. Text is read as gofmt leaves it (headers may span lines inside their brackets).
 * Limits: text that is not valid Go may hide declarations after it (an unterminated literal
 * ends the outline; a declaration this cannot read is skipped); a receiver with a comment
 * inside its parentheses is named with the comment.
 *
 * Pure. Bound: one pass over `text`; each declaration's brackets are scanned once more.
 * @param {string} text
 * @returns {ServerSymbol[]}
 */
function goOutline(text) {
  /** @type {ServerSymbol[]} */
  const out = [];
  let depth = 0;
  let statementStart = true;
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonCode(text, i);
    if (skipped < 0) break;
    if (skipped > i) {
      if (text[i] !== '/') statementStart = false;
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '\n' || c === ';') {
      if (depth === 0) statementStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    IDENT.lastIndex = i;
    const word = IDENT.exec(text);
    if (word) {
      if (depth === 0 && statementStart && word[0] === 'func') {
        const decl = declarationAt(text, i);
        if (decl) {
          out.push(decl.symbol);
          i = decl.end;
          statementStart = false;
          continue;
        }
      }
      statementStart = false;
      i += word[0].length;
      continue;
    }
    statementStart = false;
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth = Math.max(0, depth - 1);
    i++;
  }
  return out;
}

module.exports = { goOutline, skipNonCode };
