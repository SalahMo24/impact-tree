// @ts-check
'use strict';
// Python signatures (docs/MULTI_LANGUAGE_PLAN.md, P3): a `def` declaration's header parsed
// into the `sig` object the shared `diffSignature` compares, plus the exceptions the body
// raises (P-D6) and the change kinds of a header (`pythonKindsOf`). Pure text in, plain data
// out; nothing here touches the editor or the file system.
//
// Pyright's `detail` is empty (P0), so the header comes from the declaration's text: the
// range Pyright gives starts at the first decorator and ends at the end of the body.
//
// Reading text is a documented, explicit result: text this cannot read yields `null`
// (never a throw, never a guessed signature), and the caller then compares the normalised
// header text instead (`pythonKindsOf`) rather than reporting the symbol as unchanged.
//
// Known limits (also listed where they apply):
// - Strings are scanned as Python 3.11 and earlier does: an f-string that reuses its own
//   quote inside a replacement field (3.12) ends early and can make a header unreadable.
// - A PEP 695 type-parameter list (`def f[T](x)`) is skipped, not compared.
// - Python 2 tuple parameters are unreadable (null).
// - A default value's text is never compared, only whether one exists.

/**
 * @typedef {{ name: string, type: string|null, optional: boolean, rest: boolean }} PyParam
 * @typedef {{ async: boolean, params: PyParam[], returns: string|null }} PySig
 * @typedef {'function'|'property'|'staticmethod'|'classmethod'} PyBinding
 * @typedef {{ sig: PySig, headerEnd: number, decorators: string[], binding: PyBinding }} PyDeclaration
 */

// Budget: decorators plus header, measured as the offset just past the header's `:`, may be
// at most this many UTF-16 units. Unit: characters of declText. Valid range: >= 1; default
// 64 Ki, far above any hand-written header (the longest in httpx is under 1 Ki) and small
// enough that scanning one costs microseconds. Owner: this module. Enforced in
// `readDeclaration` by cutting the text before any scan; a longer header is unreadable (null).
const { scanString } = require('./lexer');

const MAX_HEADER_CHARS = 65536;
// Why 8: Python itself counts a tab as advancing to the next multiple of 8 columns, which is
// how mixed tab/space bodies still nest consistently.
const TAB_WIDTH = 8;

const MARKER_POSITIONAL_ONLY = 'positional-only';
const MARKER_KEYWORD_ONLY = 'keyword-only';
const MARKER_VAR_POSITIONAL = '*';
const MARKER_VAR_KEYWORD = '**';

const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER = /[0-9][0-9A-Za-z_.]*/y;
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
// Operators of two characters that contain `=` or `*`, so a default's `=` and the `*` of
// `**` are never confused with a bare `=` or `*`. `->` is the return arrow.
const TWO_CHAR_PUNCT = new Set(['->', '**', '==', '!=', '<=', '>=']);
const PROPERTY_NAMES = new Set(['property', 'functools.cached_property', 'cached_property']);
const ATTRIBUTE_ACCESSOR = /^[\p{L}_][\p{L}\p{N}_.]*\.(setter|getter|deleter)$/u;
const MARKER_PREFIX = /^(positional-only|keyword-only|\*\*|\*)(?: |$)/;

/** @typedef {{ kind: 'ident' | 'punct' | 'lit', text: string, start: number, end: number }} Token */

/**
 * End offset of the string literal opening at `i` (just past its closing quote), or -1 when
 * it is unterminated (./lexer.js `scanString`: one reading of Python strings for every
 * Python scanner).
 * @param {string} text @param {number} i index of the opening quote @returns {number}
 */
function stringEnd(text, i) {
  const s = scanString(text, i);
  return s.terminated ? s.end : -1;
}

/**
 * Tokenise from `start` to the end of a logical unit: a newline at bracket depth 0
 * (`mode` 'newline', a decorator) or a `:` at depth 0 (`mode` 'colon', the header). Comments
 * and whitespace are dropped; strings are single tokens. Null on an unterminated string or
 * bracket, unbalanced closers, or (colon mode) no `:` before the end or a newline at depth 0.
 * @param {string} text @param {number} start @param {'newline'|'colon'} mode
 * @returns {{ tokens: Token[], end: number } | null} `end` is the terminator's index
 */
function tokenizeSpan(text, start, mode) {
  /** @type {Token[]} */
  const tokens = [];
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n' || c === '\r') {
      if (depth === 0) return mode === 'newline' ? { tokens, end: i } : null;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
    if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
      i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end < 0) return null;
      tokens.push({ kind: 'lit', text: text.slice(i, end), start: i, end });
      i = end;
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
    if (c === ':' && depth === 0 && mode === 'colon') return { tokens, end: i };
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) { depth--; if (depth < 0) return null; }
    const two = text.slice(i, i + 2);
    const p = TWO_CHAR_PUNCT.has(two) ? two : c;
    tokens.push({ kind: 'punct', text: p, start: i, end: i + p.length });
    i += p.length;
  }
  return mode === 'newline' && depth === 0 ? { tokens, end: text.length } : null;
}

/**
 * Normalised text of tokens: runs of whitespace (and comments) become one space, and the
 * spaces next to brackets and commas are removed, with a trailing comma before a closing
 * bracket dropped, so pure reformatting reads the same. String literals are verbatim.
 * @param {string} src @param {Token[]} toks @returns {string}
 */
function renderTokens(src, toks) {
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (t.text === ',' && next && CLOSE.has(next.text)) continue;
    if (prev && t.start > prev.end) {
      const tight = OPEN.has(prev.text) || CLOSE.has(t.text) || t.text === ',' || prev.text === ',';
      if (!tight) out += ' ';
    }
    out += src.slice(t.start, t.end);
  }
  return out;
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
 * Split parameter tokens at commas at bracket depth 0. A comma inside a `lambda`'s own
 * parameter list (`f=lambda a, b: a`) does not split: the lambda is pending until its `:`.
 * A trailing comma is allowed; any other empty entry is a failure (null).
 * @param {Token[]} toks @returns {Token[][] | null}
 */
function splitEntries(toks) {
  /** @type {Token[][]} */
  const entries = [[]];
  let depth = 0;
  let lambdas = 0;
  for (const t of toks) {
    if (t.kind === 'ident' && t.text === 'lambda' && depth === 0) lambdas++;
    else if (t.kind === 'punct') {
      if (OPEN.has(t.text)) depth++;
      else if (CLOSE.has(t.text)) depth--;
      else if (t.text === ':' && depth === 0 && lambdas > 0) lambdas--;
      else if (t.text === ',' && depth === 0 && lambdas === 0) { entries.push([]); continue; }
    }
    entries[entries.length - 1].push(t);
  }
  if (entries[entries.length - 1].length === 0 && entries.length > 1) entries.pop();
  if (entries.length === 1 && entries[0].length === 0) return [];
  return entries.some((e) => e.length === 0) ? null : entries;
}

/**
 * @typedef {{ form: 'slash' } | { form: 'star' } | { form: 'param', name: string, marker: string|null,
 *   ann: string|null, optional: boolean, rest: boolean }} Entry
 */

/**
 * Read one parameter-list entry.
 * @param {string} src @param {Token[]} e @returns {Entry | null}
 */
function parseEntry(src, e) {
  const first = e[0];
  if (e.length === 1 && first.text === '/') return { form: 'slash' };
  if (e.length === 1 && first.text === '*') return { form: 'star' };
  const starred = first.text === '*' || first.text === '**';
  const nameAt = starred ? 1 : 0;
  const nameTok = e[nameAt];
  if (!nameTok || nameTok.kind !== 'ident') return null;
  const tail = e.slice(nameAt + 1);
  let ann = null;
  let optional = false;
  if (tail.length > 0 && tail[0].text === ':') {
    let depth = 0;
    let eq = -1;
    for (let k = 1; k < tail.length; k++) {
      const t = tail[k];
      if (t.kind !== 'punct') continue;
      if (OPEN.has(t.text)) depth++;
      else if (CLOSE.has(t.text)) depth--;
      else if (t.text === '=' && depth === 0) { eq = k; break; }
    }
    const annToks = tail.slice(1, eq < 0 ? tail.length : eq);
    if (annToks.length === 0) return null;
    ann = renderTokens(src, annToks);
    if (eq >= 0) {
      if (eq === tail.length - 1) return null;
      optional = true;
    }
  } else if (tail.length > 0) {
    if (tail[0].text !== '=' || tail.length === 1) return null;
    optional = true;
  }
  if (starred && optional) return null; // `*args=1` is not Python
  const marker = first.text === '*' ? MARKER_VAR_POSITIONAL : first.text === '**' ? MARKER_VAR_KEYWORD : null;
  return { form: 'param', name: nameTok.text, marker, ann, optional, rest: starred };
}

/**
 * The binding a method's decorators give it. Matched on the decorator's whole expression
 * (a call such as `@property()` is not one). `abc.abstract*` decorators are not bindings.
 * @param {string[]} decorators @returns {PyBinding}
 */
function bindingOf(decorators) {
  for (const d of decorators) {
    if (d === 'staticmethod') return 'staticmethod';
    if (d === 'classmethod') return 'classmethod';
    if (PROPERTY_NAMES.has(d) || ATTRIBUTE_ACCESSOR.test(d)) return 'property';
  }
  return 'function';
}

/**
 * Read decorators and the header tokens of a declaration.
 * @param {string} declText
 * @returns {{ src: string, decorators: string[], header: Token[], colon: number } | null}
 */
function readDeclaration(declText) {
  if (typeof declText !== 'string') return null;
  const src = declText.length > MAX_HEADER_CHARS ? declText.slice(0, MAX_HEADER_CHARS) : declText;
  /** @type {string[]} */
  const decorators = [];
  let i = 0;
  for (;;) {
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\f' || c === '\n' || c === '\r') i++;
      else if (c === '#') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; }
      else break;
    }
    if (src[i] !== '@') break;
    const dec = tokenizeSpan(src, i + 1, 'newline');
    if (!dec || dec.tokens.length === 0) return null;
    decorators.push(renderTokens(src, dec.tokens));
    i = dec.end;
  }
  const head = tokenizeSpan(src, i, 'colon');
  if (!head) return null;
  return { src, decorators, header: head.tokens, colon: head.end };
}

/**
 * Parse one function or method declaration's decorators and header.
 *
 * @param {string} declText source text from the first decorator (or `def` / `async def`)
 *   to the end of the body, as Pyright's range gives it. Only the part up to the header's
 *   `:` is read; at most MAX_HEADER_CHARS of it.
 * @param {{ isMethod: boolean }} options a method (defined directly in a class body) loses
 *   its first parameter, unless it is a `@staticmethod`
 * @returns {PyDeclaration | null} `headerEnd` is the offset just past the header's `:`.
 *   Null when the text is not a declaration this can read.
 */
function parsePythonDeclaration(declText, { isMethod }) {
  const read = readDeclaration(declText);
  if (!read) return null;
  const { src, decorators, header, colon } = read;
  let k = 0;
  const isAsync = header[k] && header[k].text === 'async';
  if (isAsync) k++;
  if (!header[k] || header[k].text !== 'def') return null;
  k++;
  if (!header[k] || header[k].kind !== 'ident') return null;
  k++;
  if (header[k] && header[k].text === '[') { // PEP 695 type parameters: skipped
    const tclose = matchClose(header, k);
    if (tclose < 0) return null;
    k = tclose + 1;
  }
  if (!header[k] || header[k].text !== '(') return null;
  const pclose = matchClose(header, k);
  if (pclose < 0) return null;
  const entries = splitEntries(header.slice(k + 1, pclose));
  if (!entries) return null;

  const after = header.slice(pclose + 1);
  /** @type {string|null} */
  let returns = null;
  if (after.length > 0) {
    if (after[0].text !== '->' || after.length === 1) return null;
    returns = renderTokens(src, after.slice(1));
  }

  const binding = bindingOf(decorators);
  /** @type {{ name: string, marker: string|null, ann: string|null, optional: boolean, rest: boolean }[]} */
  const ps = [];
  let keywordOnly = false;
  let sawSlash = false;
  for (let n = 0; n < entries.length; n++) {
    const entry = parseEntry(src, entries[n]);
    if (!entry) return null;
    if (entry.form === 'slash') {
      if (sawSlash || keywordOnly || ps.length === 0) return null;
      sawSlash = true;
      for (const p of ps) p.marker = MARKER_POSITIONAL_ONLY;
    } else if (entry.form === 'star') {
      if (keywordOnly || n === entries.length - 1) return null; // a second `*`, or `*` with nothing after
      keywordOnly = true;
    } else {
      if (entry.marker === MARKER_VAR_KEYWORD && n !== entries.length - 1) return null;
      if (entry.marker === MARKER_VAR_POSITIONAL) {
        if (keywordOnly) return null;
        keywordOnly = true;
        ps.push({ ...entry });
      } else {
        ps.push({ ...entry, marker: entry.marker || (keywordOnly ? MARKER_KEYWORD_ONLY : null) });
      }
    }
  }
  if (isMethod && binding !== 'staticmethod' && ps.length > 0 && !ps[0].rest) ps.shift();

  const params = ps.map((p) => ({
    name: p.name,
    type: [p.marker, p.ann].filter(Boolean).join(' ') || null,
    optional: p.optional,
    rest: p.rest,
  }));
  return { sig: { async: !!isAsync, params, returns }, headerEnd: colon + 1, decorators, binding };
}

/**
 * The header's normalised text (`def` or `async def` to the `:`, comments dropped, spacing
 * normalised, decorators excluded), for comparing two sides whose `sig` could not be read.
 * When even the header cannot be scanned, the declaration's first `def` line with whitespace
 * runs collapsed: a best effort that never includes the body's later lines.
 * @param {string} declText @returns {string}
 */
function pythonHeaderText(declText) {
  const read = readDeclaration(declText);
  if (read) return renderTokens(read.src, read.header);
  if (typeof declText !== 'string') return '';
  const line = declText.split('\n').find((l) => /\bdef\b/.test(l));
  return line ? line.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Text with comments and string literals blanked to spaces (newlines kept, so offsets and
 * line structure survive). An unterminated single-quoted string ends at its line's end.
 * @param {string} text @returns {string}
 */
function blankCommentsAndStrings(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '"' || c === "'") {
      // Unterminated: a triple string runs to the end, a single one to its line's end.
      const { end } = scanString(text, i);
      for (let j = i; j < end && j < text.length; j++) if (text[j] !== '\n' && text[j] !== '\r') out[j] = ' ';
      i = Math.max(end, i + 1);
    } else i++;
  }
  return out.join('');
}

const RAISE = /\braise\b/g;
const NESTED_BLOCK = /^(async\s+def|def|class)\b/;
const DOTTED_NAME = /[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/uy;

/**
 * The exception names a function's own body raises: the leading dotted name of the
 * expression of each `raise X`, `raise X(...)`, `raise X from e`, as written
 * (`httpx.HTTPError`, `ValueError`), whatever its case. Excluded: a bare `raise`; comments
 * and strings; and the bodies (and header lines) of nested `def`, `async def` and `class`
 * (P-D5: a nested function's raise is not the parent's contract).
 *
 * Limits: nesting is found by indentation (a tab counts as 8 columns, as Python does), at
 * statement starts only (not inside brackets or after a `\` continuation); `raise (X)` reads
 * `X`; an expression that does not begin with a name (`raise errors[0]` reads `errors`,
 * `raise 1` reads nothing) contributes its leading name only. The whole body is scanned, in
 * one linear pass: its size is bounded by the file read that produced it, and a cap here
 * would miss a later `raise` without saying so.
 *
 * @param {string} declText the declaration as given to `parsePythonDeclaration`
 * @param {number} headerEnd its `headerEnd`
 * @returns {Set<string>}
 */
function raisesOf(declText, headerEnd) {
  /** @type {Set<string>} */
  const names = new Set();
  if (typeof declText !== 'string' || !(headerEnd >= 0)) return names;
  const body = blankCommentsAndStrings(declText.slice(headerEnd));
  const lines = body.split('\n');
  let depth = 0;
  let continued = false;
  /** Indent of the nested block being skipped, or -1. */
  let skipIndent = -1;
  let offset = 0;
  /** @type {number[]} start offset in `body` of each line */
  const starts = lines.map((l) => { const s = offset; offset += l.length + 1; return s; });
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const isStatementStart = depth === 0 && !continued && line.trim() !== '';
    if (isStatementStart && n > 0) {
      let indent = 0;
      for (const ch of line) {
        if (ch === ' ') indent++;
        else if (ch === '\t') indent += TAB_WIDTH - (indent % TAB_WIDTH);
        else break;
      }
      if (skipIndent >= 0 && indent <= skipIndent) skipIndent = -1;
      if (skipIndent < 0 && NESTED_BLOCK.test(line.trim())) skipIndent = indent;
    }
    const skipped = n > 0 && skipIndent >= 0;
    if (!skipped) {
      RAISE.lastIndex = 0;
      for (let m = RAISE.exec(line); m; m = RAISE.exec(line)) {
        const found = raisedName(body, starts[n] + m.index + m[0].length);
        if (found) names.add(found);
      }
    }
    for (const ch of line) {
      if (OPEN.has(ch)) depth++;
      else if (CLOSE.has(ch) && depth > 0) depth--;
    }
    continued = depth === 0 && /\\\s*$/.test(line);
  }
  return names;
}

/**
 * The dotted name that starts the expression after a `raise` keyword ending at `at`, or
 * null for a bare `raise`.
 * @param {string} body blanked body text @param {number} at @returns {string|null}
 */
function raisedName(body, at) {
  let i = at;
  for (;;) {
    while (i < body.length && (body[i] === ' ' || body[i] === '\t' || body[i] === '\r')) i++;
    if (body[i] === '\\' && body[i + 1] === '\n') i += 2; // a `\` continuation: the expression is on the next line
    else break;
  }
  if (i >= body.length || body[i] === '\n' || body[i] === ';') return null;
  while (i < body.length && (body[i] === '(' || /\s/.test(body[i]))) i++;
  DOTTED_NAME.lastIndex = i;
  return DOTTED_NAME.test(body) ? body.slice(i, DOTTED_NAME.lastIndex) : null;
}

/**
 * The change kinds of a Python function or method between its base and head versions.
 * Symbols carry `sig` (null when the header could not be read), `header` (the normalised
 * header text, `pythonHeaderText`) and `binding`. A binding change (property to method,
 * plain to static) is a type change; with both `sig`s the shared `diffSignature` decides;
 * otherwise the normalised headers are compared. Decorators other than bindings are not a
 * signature change.
 * @param {{ sig: any, header: string, binding: string }|null|undefined} base
 * @param {{ sig: any, header: string, binding: string }} head
 * @returns {object[]}
 */
function pythonKindsOf(base, head) {
  const { diffSignature, KIND } = require('../../engine/signature');
  if (!base) return [];
  const kinds = base.sig && head.sig ? diffSignature(base, head) : base.header === head.header ? [] : [KIND.TYPE_CHANGED];
  if (base.binding !== head.binding && !kinds.includes(KIND.TYPE_CHANGED)) kinds.push(KIND.TYPE_CHANGED);
  return kinds;
}

/**
 * A readable, stable one-line rendering of a parsed signature:
 * `(a: int, b=…, *args, *, c: str, **kw) -> T`. A default shows as `=…` (`: T = …` when
 * annotated); `/` and a bare `*` are shown where the parameter kinds switch.
 * @param {PySig} sig @returns {string}
 */
function renderPythonSig(sig) {
  /** @type {string[]} */
  const parts = [];
  let seenVarPositional = false;
  let inKeywordOnly = false;
  let prevPositionalOnly = false;
  for (const p of sig.params) {
    const m = p.type ? MARKER_PREFIX.exec(p.type) : null;
    const marker = m ? m[1] : null;
    const ann = p.type ? p.type.slice(m ? m[0].length : 0) : '';
    if (prevPositionalOnly && marker !== MARKER_POSITIONAL_ONLY) parts.push('/');
    prevPositionalOnly = marker === MARKER_POSITIONAL_ONLY;
    if (marker === MARKER_KEYWORD_ONLY && !inKeywordOnly && !seenVarPositional) parts.push('*');
    if (marker === MARKER_KEYWORD_ONLY) inKeywordOnly = true;
    if (marker === MARKER_VAR_POSITIONAL) { seenVarPositional = true; inKeywordOnly = true; }
    const star = marker === MARKER_VAR_POSITIONAL ? '*' : marker === MARKER_VAR_KEYWORD ? '**' : '';
    const text = `${star}${p.name}${ann ? `: ${ann}` : ''}`;
    parts.push(p.optional ? (ann ? `${text} = …` : `${text}=…`) : text);
  }
  if (prevPositionalOnly) parts.push('/');
  return `(${parts.join(', ')})${sig.returns ? ` -> ${sig.returns}` : ''}`;
}

module.exports = {
  parsePythonDeclaration, pythonHeaderText, raisesOf, pythonKindsOf, renderPythonSig,
  MAX_HEADER_CHARS,
};
