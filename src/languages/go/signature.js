// @ts-check
'use strict';
// Go signatures (docs/MULTI_LANGUAGE_PLAN.md, G3): a Go function or method declaration's
// header parsed into the `sig` object the shared `diffSignature` compares. Pure text in,
// plain data out; nothing here touches the editor or the file system.
//
// Parsing a header is a documented, explicit result: text this cannot read yields `null`
// (never a throw, never a guessed signature), and the caller reports the symbol as having
// no comparable signature rather than as unchanged.

/**
 * @typedef {{ name: string, type: string, optional: false, rest: boolean }} GoParam
 * @typedef {{ async: false, params: GoParam[], returns: string | null }} GoSig
 */

const RECEIVER = '(receiver)';
// Words that start a type, so an entry beginning with one is a type, never `name Type`.
const TYPE_KEYWORDS = new Set(['func', 'map', 'chan', 'struct', 'interface']);
const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER = /[0-9][0-9A-Za-z_.]*/y;
const SPACE = /\s+/y;
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

/** @typedef {{ kind: 'ident' | 'punct' | 'lit', text: string, start: number, end: number }} Token */

/**
 * Tokenise the header of a declaration: everything before the body's `{`. Comments are
 * skipped. The body brace is the first `{` at nesting depth 0 that does not open a
 * `struct`/`interface` type. Returns null on text it cannot scan (an unterminated comment
 * or literal, unbalanced brackets).
 * @param {string} text
 * @returns {{ tokens: Token[], headerEnd: number } | null}
 */
function tokenizeHeader(text) {
  /** @type {Token[]} */
  const tokens = [];
  let depth = 0;
  let i = 0;
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
      if (close < 0) return null;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return null;
      tokens.push({ kind: 'lit', text: text.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close < 0) return null;
      tokens.push({ kind: 'lit', text: text.slice(i, close + 1), start: i, end: close + 1 });
      i = close + 1;
      continue;
    }
    IDENT.lastIndex = i;
    if (IDENT.test(text)) {
      tokens.push({ kind: 'ident', text: text.slice(i, IDENT.lastIndex), start: i, end: IDENT.lastIndex });
      i = IDENT.lastIndex;
      continue;
    }
    NUMBER.lastIndex = i;
    if (NUMBER.test(text)) {
      tokens.push({ kind: 'lit', text: text.slice(i, NUMBER.lastIndex), start: i, end: NUMBER.lastIndex });
      i = NUMBER.lastIndex;
      continue;
    }
    if (c === '{' && depth === 0) {
      const prev = tokens[tokens.length - 1];
      const opensType = prev && prev.kind === 'ident' && (prev.text === 'struct' || prev.text === 'interface');
      if (!opensType) return { tokens, headerEnd: i };
    }
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) { depth--; if (depth < 0) return null; }
    const text3 = text.startsWith('...', i) ? '...' : text.startsWith('<-', i) ? '<-' : c;
    tokens.push({ kind: 'punct', text: text3, start: i, end: i + text3.length });
    i += text3.length;
  }
  return depth === 0 ? { tokens, headerEnd: text.length } : null;
}

/**
 * Index of the token closing the bracket opened at `open`, or -1.
 * @param {Token[]} tokens @param {number} open @returns {number}
 */
function matchClose(tokens, open) {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (OPEN.has(t.text)) depth++;
    else if (CLOSE.has(t.text) && --depth === 0) return k;
  }
  return -1;
}

/**
 * A type's text: tokens joined with a single space where the source had any gap, minus the
 * spaces just inside `(` `)` `[` `]` and before commas, and minus a trailing comma. Struct
 * tags and other literals are kept verbatim.
 * @param {string} src @param {Token[]} toks @returns {string}
 */
function renderType(src, toks) {
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (t.text === ',' && next && (next.text === ')' || next.text === ']')) continue;
    if (prev) {
      const tight = prev.text === '(' || prev.text === '[' || t.text === ')' || t.text === ']' || t.text === ',';
      if (prev.text === ',' || (t.start > prev.end && !tight)) out += ' ';
    }
    out += src.slice(t.start, t.end);
  }
  return out;
}

/**
 * Whether a parameter-list entry has the `name Type` form (versus a bare type or a bare
 * name awaiting the next entry's type).
 * @param {Token[]} e @returns {boolean}
 */
function isNamedEntry(e) {
  if (e.length < 2 || e[0].kind !== 'ident' || TYPE_KEYWORDS.has(e[0].text)) return false;
  if (e[1].text === '.') return false; // pkg.Type
  if (e[1].text === '[') {
    // `x []T` / `x [3]T` are named; `List[int]` (nothing after the brackets) is a type.
    const close = matchClose(e, 1);
    return close >= 0 && close < e.length - 1;
  }
  return true;
}

/**
 * Split the tokens between a list's brackets at top-level commas. A trailing comma is
 * allowed; any other empty entry is a parse failure (null).
 * @param {Token[]} toks @returns {Token[][] | null}
 */
function splitEntries(toks) {
  /** @type {Token[][]} */
  const entries = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.kind === 'punct') {
      if (OPEN.has(t.text)) depth++;
      else if (CLOSE.has(t.text)) depth--;
      else if (t.text === ',' && depth === 0) { entries.push([]); continue; }
    }
    entries[entries.length - 1].push(t);
  }
  if (entries[entries.length - 1].length === 0) entries.pop();
  return entries.some((e) => e.length === 0) ? null : entries;
}

/**
 * Parse a parenthesised parameter or result list (or a bracketed type-parameter list) into
 * `{ name, type }` pairs, names expanded from groups; `name` is '' for unnamed entries.
 * @param {string} src @param {Token[]} toks tokens between the brackets
 * @param {boolean} typeParams `[K, V any]` list: every entry of 2+ tokens is `name constraint`
 * @returns {{ name: string, type: string }[] | null}
 */
function parseList(src, toks, typeParams) {
  const entries = splitEntries(toks);
  if (!entries) return null;
  const named = typeParams || entries.some(isNamedEntry);
  /** @type {{ name: string, type: string }[]} */
  const out = [];
  if (!named) {
    for (const e of entries) out.push({ name: '', type: renderType(src, e) });
    return out;
  }
  /** @type {string[]} */
  let pending = [];
  for (const e of entries) {
    if (e.length === 1 && e[0].kind === 'ident' && !TYPE_KEYWORDS.has(e[0].text)) { pending.push(e[0].text); continue; }
    if (e[0].kind !== 'ident' || (!typeParams && !isNamedEntry(e))) return null;
    const type = renderType(src, e.slice(1));
    for (const name of [...pending, e[0].text]) out.push({ name, type });
    pending = [];
  }
  return pending.length === 0 ? out : null;
}

/**
 * Parse one function or method declaration.
 *
 * @param {string} declText source text of the declaration, from `func` (comments and
 *   whitespace before it are tolerated) to the closing `}` of the body, or to the end of
 *   the header when it has no body
 * @returns {{ sig: GoSig, headerEnd: number } | null} `headerEnd` is the UTF-16 offset
 *   in `declText` of the body's `{` (declText.length without a body). Null when the text
 *   is not a declaration this can read.
 */
function parseGoDeclaration(declText) {
  if (typeof declText !== 'string') return null;
  const scanned = tokenizeHeader(declText);
  if (!scanned) return null;
  const { tokens, headerEnd } = scanned;
  let k = 0;
  if (!tokens[k] || tokens[k].text !== 'func') return null;
  k++;
  /** @type {GoParam[]} */
  const params = [];

  // Receiver.
  if (tokens[k] && tokens[k].text === '(') {
    const close = matchClose(tokens, k);
    if (close < 0) return null;
    const recv = parseList(declText, tokens.slice(k + 1, close), false);
    if (!recv || recv.length !== 1) return null;
    params.push({ name: RECEIVER, type: recv[0].type, optional: false, rest: false });
    k = close + 1;
  }

  // Name, then optional type parameters.
  if (!tokens[k] || tokens[k].kind !== 'ident') return null;
  k++;
  if (tokens[k] && tokens[k].text === '[') {
    const close = matchClose(tokens, k);
    if (close < 0) return null;
    const tps = parseList(declText, tokens.slice(k + 1, close), true);
    if (!tps || tps.length === 0) return null;
    tps.forEach((tp, n) => params.push({
      name: `[${tp.name === '_' ? `_#${n + 1}` : tp.name}]`, type: tp.type, optional: false, rest: false,
    }));
    k = close + 1;
  }

  // Parameters.
  if (!tokens[k] || tokens[k].text !== '(') return null;
  const pclose = matchClose(tokens, k);
  if (pclose < 0) return null;
  const ps = parseList(declText, tokens.slice(k + 1, pclose), false);
  if (!ps) return null;
  ps.forEach((p, n) => {
    const pos = n + 1;
    const name = p.name === '' ? `#${pos}` : p.name === '_' ? `_#${pos}` : p.name;
    params.push({ name, type: p.type, optional: false, rest: p.type.startsWith('...') });
  });
  k = pclose + 1;

  // Results: nothing, one bare type, or a parenthesised list whose names are dropped.
  /** @type {string | null} */
  let returns = null;
  const rest = tokens.slice(k);
  if (rest.length > 0) {
    if (rest[0].text === '(') {
      const rclose = matchClose(rest, 0);
      if (rclose !== rest.length - 1) return null;
      const rs = parseList(declText, rest.slice(1, rclose), false);
      if (!rs) return null;
      if (rs.length === 1) returns = rs[0].type;
      else if (rs.length > 1) returns = `(${rs.map((r) => r.type).join(', ')})`;
    } else {
      returns = renderType(declText, rest);
    }
  }
  return { sig: { async: false, params, returns }, headerEnd };
}

/**
 * A readable, stable one-line rendering of a parsed signature:
 * `(receiver *T) [T any] (a int, b ...Opt) (int, error)`. Positional names (`#1`) are
 * omitted, as a reader would not have written them.
 * @param {GoSig} sig @returns {string}
 */
function renderGoSig(sig) {
  const recv = sig.params.filter((p) => p.name === RECEIVER);
  const tps = sig.params.filter((p) => p.name.startsWith('['));
  const ps = sig.params.filter((p) => p.name !== RECEIVER && !p.name.startsWith('['));
  const parts = [];
  if (recv.length > 0) parts.push(`(receiver ${recv[0].type})`);
  if (tps.length > 0) parts.push(`[${tps.map((p) => `${p.name.slice(1, -1).replace(/#\d+$/, '')} ${p.type}`).join(', ')}]`);
  parts.push(`(${ps.map((p) => (/^#\d+$/.test(p.name) ? p.type : `${p.name.replace(/#\d+$/, '')} ${p.type}`)).join(', ')})`);
  if (sig.returns) parts.push(sig.returns);
  return parts.join(' ');
}

module.exports = { parseGoDeclaration, renderGoSig };
