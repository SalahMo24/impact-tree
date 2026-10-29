// @ts-check
'use strict';
// The TypeScript steps of a review identity (src/session/review-identity.js): parsing a side of a
// file, its symbols, its text without them, and the declarations a caller is anchored at.
// Hashing and caching are the identity's; nothing here keeps state.
const { createHash } = require('crypto');
const { makeSymbols } = require('../../engine/symbols');

/** @param {string|null|undefined} s Text; null or undefined is an absent side. */
const hash = (s) => createHash('sha256').update(s == null ? '<absent>' : s).digest('hex');

/**
 * @param {any} ts The TypeScript compiler module (`any`: dynamically loaded, see ./load.js).
 * @returns {{
 *   parse: (file: string, text: string) => any,
 *   collect: (sf: any) => any[],
 *   blankSpans: (sf: any, symbols: any[]) => string|null,
 *   declarationHashes: (sf: any) => Map<number, string>,
 * }}
 */
function typescriptReviewSymbols(ts) {
  const S = makeSymbols(ts);
  return {
    parse: (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true),
    collect: (sf) => S.collect(sf),
    blankSpans: (sf, symbols) => blankSpans(ts, sf, symbols),
    declarationHashes: (sf) => declarationHashes(ts, sf),
  };
}

/**
 * @param {any} ts The TypeScript compiler module.
 * @param {any} sf A parsed source file, or null.
 * @param {{ startLine: number, endLine: number }[]} symbols One-based, inclusive lines.
 * @returns {string|null}
 */
// Text without its callables, null staying null. Whole lines are cut, from the line a
// callable starts on to the line it ends on, so a function added or removed leaves no
// `export const ;` behind. Blank separator lines are ignored, but lines inside literal
// text (including template chunks and JSX text) keep their meaningful whitespace.
function blankSpans(ts, sf, symbols) {
  if (!sf) return null;
  const literalKinds = new Set([
    ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  const literalLines = new Set();
  const stack = [sf];
  while (stack.length) {
    const node = stack.pop();
    if (literalKinds.has(node.kind)) {
      const first = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const last = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      for (let line = first; line <= last; line++) literalLines.add(line + 1);
    }
    ts.forEachChild(node, (/** @type {any} */ child) => { stack.push(child); });
  }
  const spans = symbols.slice().sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  let at = 0;
  return sf.text.split('\n').filter((/** @type {string} */ line, /** @type {number} */ index) => {
    const number = index + 1;
    while (at < spans.length && spans[at].endLine < number) at++;
    if (at < spans.length && spans[at].startLine <= number) return false;
    return line.trim() !== '' || literalLines.has(number);
  }).join('\n');
}

/**
 * @param {any} ts The TypeScript compiler module.
 * @param {any} sf A parsed source file.
 * @returns {Map<number, string>}
 */
// Callers are anchored at their declaration's name: name start -> hash of that
// declaration's text, for every named node in the file. One parse per file, which is
// then dropped; an explicit stack, so a deep file cannot overflow the call stack.
function declarationHashes(ts, sf) {
  const out = new Map();
  const stack = [sf];
  while (stack.length) {
    const node = stack.pop();
    if (node.name && ts.isIdentifier(node.name)) {
      const at = node.name.getStart(sf);
      if (!out.has(at)) out.set(at, hash(node.getText(sf)));
    }
    ts.forEachChild(node, (/** @type {any} */ k) => { stack.push(k); });
  }
  return out;
}

module.exports = { typescriptReviewSymbols };
