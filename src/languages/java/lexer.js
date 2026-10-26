// @ts-check
'use strict';
// The Java lexer shared by the header parser (./signature.js, J3) and the text outline
// (./outline.js, J7). Pure text in, tokens out; nothing here touches the editor or the file
// system.
//
// Limits (documented, not handled): Unicode escapes are not decoded, so a brace or quote
// written as one is read as the escape's letters.

/** @typedef {{ kind: 'ident' | 'punct' | 'lit' | 'anno', text: string, start: number, end: number }} Token */

const IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER = /[0-9][0-9A-Za-z_.]*/y;
const SPACE = /\s+/y;

/**
 * Lex Java text from `from`, calling `visit` with each token until it returns `false`.
 * Comments are skipped; string, char and text-block literals are single `lit` tokens; `...`
 * and `->` are single tokens, every other punctuation character is its own (so `>>` is two
 * `>`). Returns the offset where lexing stopped, or -1 on an unterminated comment or literal.
 * @param {string} text @param {number} from @param {(t: Token) => boolean | void} visit
 * @returns {number}
 */
function lex(text, from, visit) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    SPACE.lastIndex = i;
    if (SPACE.test(text)) { i = SPACE.lastIndex; continue; }
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
    if (c === '"' && text.startsWith('"""', i)) {
      let j = i + 3;
      while (j < text.length && !text.startsWith('"""', j)) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return -1;
      tok = { kind: 'lit', text: text.slice(i, j + 3), start: i, end: j + 3 };
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length || text[j] !== c) return -1;
      tok = { kind: 'lit', text: text.slice(i, j + 1), start: i, end: j + 1 };
    } else {
      IDENT.lastIndex = i;
      NUMBER.lastIndex = i;
      if (IDENT.test(text)) {
        let end = IDENT.lastIndex;
        if (text.slice(i, end) === 'non' && text.startsWith('-sealed', end)) end += 7;
        tok = { kind: 'ident', text: text.slice(i, end), start: i, end };
      } else if (NUMBER.test(text)) {
        tok = { kind: 'lit', text: text.slice(i, NUMBER.lastIndex), start: i, end: NUMBER.lastIndex };
      } else {
        const p = text.startsWith('...', i) ? '...' : text.startsWith('->', i) ? '->' : text.startsWith('::', i) ? '::' : c;
        tok = { kind: 'punct', text: p, start: i, end: i + p.length };
      }
    }
    if (visit(tok) === false) return tok.start;
    i = tok.end;
  }
  return i;
}

module.exports = { lex };
