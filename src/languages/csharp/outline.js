// @ts-check
'use strict';
// C#'s types and C-D4 members read from the text alone (Part C, C3), shaped as a language
// server's document symbols (as `javaOutline`), so the provider (./provider.js) keys them as a
// server's answer would be keyed. The member set, ranges and keys are the Roslyn syntax
// oracle's (test/csharp-syntax-oracle/README.md); `test/lsp-harness/csharp-verify.js
// --syntactic` compares the two over whole repositories. Pure text in, plain data out.
//
// What is read, in order:
// 1. Preprocessor (owner decision after the C0–C2 review): as Roslyn with no symbols defined.
//    `#if X` / `#elif X` evaluate with every symbol false except those the file `#define`s, so
//    an `#if X` branch is inactive and its `#else` is read; inactive lines are blanked (offsets
//    kept) and never lexed, as Roslyn reads them as trivia. A conditional that does not nest
//    (`#endif` without `#if`, an `#if` never closed) or an expression this cannot read makes
//    the file unreadable.
// 2. The active text is lexed (./lexer.js), every `()`, `[]` and `{}` matched; unbalanced
//    brackets (an `#if`/`#else` pair that opens a brace twice, say) make the file unreadable:
//    "not analysed", never a wrong outline.
// 3. Declarations: namespaces (block and file-scoped) are walked, not listed; types (class,
//    struct, interface, record, enum; nested ones as children) are `Class`/`Struct`/
//    `Interface`/`Enum` symbols named with their key segment (`Result<1>`); a C# 14
//    `extension(T x) { … }` block adds no symbol, its members are the static class's.
//    Members (C-D4): methods (body-less ones too), constructors, a primary constructor (its
//    parameter list), static constructors, operators, conversions, properties and indexers
//    with an accessor body or `=>` (body-less ones only in an interface or when `abstract`),
//    and the file's top-level statements as one `Module` symbol. Each member's `name` is its
//    key segment (./keys.js), `range` Roslyn's `Span` (attributes in, comments and XML doc
//    comments out; a primary constructor its parameter list; top-level statements from the
//    first statement to the end of the last, as the oracle, not from offset 0), and
//    `selectionRange` the name token (`operator` for operators and conversions, `this` for an
//    indexer, the type's name for a primary constructor, the first statement's start for
//    top-level statements). Fields, events, finalizers, delegates, enum members and
//    auto-properties are not members. What is inside a member (local functions, lambdas) is
//    its body (P-D5).
//
// A declaration that looks like a member (a parameter list after a name, an accessor list or
// `=>`) but that the header parser (./signature.js) cannot read makes the file unreadable.
//
// Limits (documented): Unicode escapes in identifiers are not decoded (./lexer.js).

/** @typedef {import('../types').ServerSymbol} ServerSymbol */
/** @typedef {import('./lexer').Token} Token */
/** @typedef {import('./signature').CsharpDeclaration} CsharpDeclaration */
/** @typedef {import('./keys').ExtensionBlock} ExtensionBlock */
/**
 * A symbol of the outline. Members carry what the provider needs beyond the server shape:
 * `member` (the oracle's kind: `method`, `constructor`, `primary-constructor`,
 * `static-constructor`, `property`, `indexer`, `operator`, `conversion`, `top-level`), `decl`
 * (the parsed header; null for a primary constructor and top-level statements), `params`
 * and `sig` (a primary constructor's), `inInterface` and `typeName` (the enclosing type's
 * name, without arity).
 * @typedef {ServerSymbol & { csharp?: CsharpMemberInfo }} CsharpSymbol
 * @typedef {{ member: string, decl: CsharpDeclaration|null, inInterface: boolean, typeName: string|null,
 *   params?: import('./signature').CsharpParam[], sig?: import('./signature').CsharpSig }} CsharpMemberInfo
 */

const { lex } = require('./lexer');
const { parseCsharpDeclaration, parseCsharpParameterList, csharpExtensionKeyParams } = require('./signature');
const { typeKeySegment, memberKeyName, primaryConstructorKeyName } = require('./keys');

// Budget: the longest text read, in UTF-16 units. Valid range >= 1; default 2 Mi, the
// preview's per-file fetch limit (src/github/github-request.js `maxFileBytes`), above any real
// source file. Owner: this module; enforced by `csharpOutline`, which answers null past it.
const MAX_TEXT_CHARS = 2 * 1024 * 1024;

// LSP SymbolKind numbers.
const KIND = Object.freeze({
  MODULE: 2, CLASS: 5, METHOD: 6, PROPERTY: 7, CONSTRUCTOR: 9, ENUM: 10, INTERFACE: 11,
  STRUCT: 23, OPERATOR: 25,
});
const MEMBER_KIND = Object.freeze({
  method: KIND.METHOD, constructor: KIND.CONSTRUCTOR, 'primary-constructor': KIND.CONSTRUCTOR,
  'static-constructor': KIND.CONSTRUCTOR, property: KIND.PROPERTY, indexer: KIND.PROPERTY,
  operator: KIND.OPERATOR, conversion: KIND.OPERATOR, 'top-level': KIND.MODULE,
});
const TYPE_MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'sealed', 'abstract', 'partial',
  'readonly', 'ref', 'unsafe', 'new', 'file',
]);
const MEMBER_MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'readonly', 'virtual', 'override',
  'abstract', 'sealed', 'extern', 'unsafe', 'new', 'async', 'partial', 'volatile', 'const',
  'required', 'file', 'fixed', 'ref',
]);
const TYPE_WORDS = new Set(['class', 'struct', 'interface', 'enum', 'record', 'delegate']);
const OPEN = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const CLOSE = new Set([')', ']', '}']);
// Punctuation that, written right before `=`, makes an operator (`<=`, `+=`, …), not an
// assignment.
const COMPOUND = new Set(['<', '>', '!', '=', '+', '-', '*', '/', '%', '&', '|', '^', '?']);

/** Thrown inside the reader for text it cannot read; `csharpOutline` answers null. */
class Unreadable extends Error {}

/** @param {boolean} ok @param {string} what @returns {asserts ok} */
function need(ok, what) {
  if (!ok) throw new Unreadable(what);
}

/** An identifier's value: the verbatim `@` dropped. @param {string} s */
const valueOf = (s) => (s.startsWith('@') ? s.slice(1) : s);

/**
 * The document symbols of a C# file (see the file comment). Null for text this cannot read
 * (an unterminated literal or comment, unbalanced brackets, unbalanced or unreadable `#if`
 * directives, a member it cannot parse) or longer than `MAX_TEXT_CHARS`: never a partial
 * outline. Pure. Bound: one pass over the directives, one lexing pass, one pass over the
 * tokens (each member's header is parsed once).
 * @param {string} text
 * @param {{ fileName?: string }} [options] `fileName`: the file's basename, the key of its
 *   top-level statements (`Program.cs`); `Program.cs` when not given.
 * @returns {CsharpSymbol[]|null}
 */
function csharpOutline(text, options = {}) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) return null;
  try {
    const active = activeText(text);
    /** @type {Token[]} */
    const toks = [];
    if (lex(active, 0, (t) => { if (t.kind !== 'directive') toks.push(t); }) < 0) return null;
    const match = matchBrackets(toks);
    if (!match) return null;
    return new Reader(active, toks, match, options.fileName || 'Program.cs').compilationUnit();
  } catch (e) {
    if (e instanceof Unreadable) return null;
    throw e;
  }
}

// ---- preprocessor ------------------------------------------------------------------------

/**
 * The text with every inactive `#if` branch's lines blanked (white space kept, so offsets and
 * lines are the text's); directive lines are kept. Throws Unreadable on a conditional that
 * does not nest or an expression it cannot read, and on an unterminated literal or comment in
 * active text.
 * @param {string} text @returns {string}
 */
function activeText(text) {
  if (!text.includes('#')) return text;
  /** @type {Set<string>} */
  const defined = new Set();
  /** @type {Array<{ active: boolean, taken: boolean, parent: boolean }>} */
  const stack = [];
  const isActive = () => stack.length === 0 || stack[stack.length - 1].active;
  /** @param {string} line The directive's text from `#`. */
  const apply = (line) => {
    const m = /^#\s*([a-z]+)\b\s*(.*)$/.exec(line.trim());
    if (!m) return;
    const [, word, rest] = m;
    const arg = rest.replace(/\/\/.*$/, '').trim();
    if (word === 'if') {
      const parent = isActive();
      const value = condition(arg, defined);
      stack.push({ active: parent && value, taken: value, parent });
    } else if (word === 'elif') {
      need(stack.length > 0, '#elif without #if');
      const top = stack[stack.length - 1];
      const value = condition(arg, defined);
      top.active = top.parent && !top.taken && value;
      top.taken = top.taken || value;
    } else if (word === 'else') {
      need(stack.length > 0, '#else without #if');
      const top = stack[stack.length - 1];
      top.active = top.parent && !top.taken;
      top.taken = true;
    } else if (word === 'endif') {
      need(stack.length > 0, '#endif without #if');
      stack.pop();
    } else if (isActive() && (word === 'define' || word === 'undef')) {
      if (word === 'define') defined.add(arg); else defined.delete(arg);
    }
  };
  /** @param {number} i @returns {number} The start of the line after the one holding `i`. */
  const nextLine = (i) => { const nl = text.indexOf('\n', i); return nl < 0 ? text.length : nl + 1; };
  /** @type {Array<[number, number]>} */
  const inactive = [];
  let pos = 0;
  while (pos < text.length) {
    let stop = -1;
    const r = lex(text, pos, (t) => {
      if (t.kind !== 'directive') return true;
      apply(t.text);
      if (isActive()) return true;
      stop = nextLine(t.end);
      return false;
    });
    need(r >= 0, 'an unterminated literal or comment');
    if (stop < 0) break;
    // Inactive lines: skipped up to the directive that makes text active again.
    let i = stop;
    let resume = text.length;
    let to = text.length;
    while (i < text.length) {
      const next = nextLine(i);
      const line = text.slice(i, next);
      if (/^[ \t\f\v\uFEFF]*#/.test(line)) {
        apply(line.slice(line.indexOf('#')));
        if (isActive()) { to = i; resume = next; break; }
      }
      i = next;
    }
    inactive.push([stop, to]);
    pos = resume;
  }
  need(stack.length === 0, '#if without #endif');
  if (!inactive.length) return text;
  let out = '';
  let from = 0;
  for (const [a, b] of inactive) {
    out += text.slice(from, a) + text.slice(a, b).replace(/[^\s]/g, ' ');
    from = b;
  }
  return out + text.slice(from);
}

/**
 * A `#if`/`#elif` expression's value with only `defined` symbols true: `!`, `&&`, `||`,
 * `==`, `!=`, parentheses, `true`, `false`. Throws Unreadable on anything else.
 * @param {string} expr @param {Set<string>} defined @returns {boolean}
 */
function condition(expr, defined) {
  const toks = expr.match(/[\p{L}_][\p{L}\p{N}_]*|&&|\|\||==|!=|[!()]|\S/gu) || [];
  let k = 0;
  /** @returns {boolean} */
  const primary = () => {
    const t = toks[k++];
    need(t !== undefined, 'an incomplete #if expression');
    if (t === '!') return !primary();
    if (t === '(') { const v = or(); need(toks[k++] === ')', 'an unbalanced #if expression'); return v; }
    need(/^[\p{L}_]/u.test(t), `an unreadable #if expression: ${expr}`);
    if (t === 'true') return true;
    if (t === 'false') return false;
    return defined.has(t);
  };
  const equality = () => {
    let v = primary();
    while (toks[k] === '==' || toks[k] === '!=') { const op = toks[k++]; const w = primary(); v = op === '==' ? v === w : v !== w; }
    return v;
  };
  const and = () => { let v = equality(); while (toks[k] === '&&') { k++; const w = equality(); v = v && w; } return v; };
  const or = () => { let v = and(); while (toks[k] === '||') { k++; const w = and(); v = v || w; } return v; };
  const value = or();
  need(k === toks.length, `an unreadable #if expression: ${expr}`);
  return value;
}

// ---- declarations ------------------------------------------------------------------------

/**
 * For each `(`, `[`, `{` its closer's index and for each closer its opener's; null when they
 * do not balance.
 * @param {Token[]} toks @returns {Int32Array|null}
 */
function matchBrackets(toks) {
  const match = new Int32Array(toks.length).fill(-1);
  /** @type {number[]} */
  const stack = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind !== 'punct') continue;
    if (OPEN.has(t.text)) stack.push(k);
    else if (CLOSE.has(t.text)) {
      const o = stack.pop();
      if (o === undefined || OPEN.get(toks[o].text) !== t.text) return null;
      match[o] = k;
      match[k] = o;
    }
  }
  return stack.length ? null : match;
}

/**
 * Where a declaration is read: the type path (key segments), the symbols list members go to,
 * whether it is an interface's body, the extension block around it, the enclosing type's name.
 * @typedef {{ path: string[], into: CsharpSymbol[], level: 'unit'|'namespace'|'type',
 *   inInterface: boolean, ext: ExtensionBlock|null, typeName: string|null, isStaticClass: boolean }} Scope
 */

class Reader {
  /** @param {string} text @param {Token[]} toks @param {Int32Array} match @param {string} fileName */
  constructor(text, toks, match, fileName) {
    this.text = text;
    this.toks = toks;
    this.match = match;
    this.fileName = fileName;
    /** @type {{ start: number, end: number }|null} */
    this.topLevel = null;
  }

  /** @returns {CsharpSymbol[]} */
  compilationUnit() {
    /** @type {CsharpSymbol[]} */
    const out = [];
    this.declarations(0, this.toks.length, { path: [], into: out, level: 'unit', inInterface: false, ext: null, typeName: null, isStaticClass: false });
    if (this.topLevel) {
      const { start, end } = this.topLevel;
      out.unshift({
        name: this.fileName, detail: 'top-level', kind: KIND.MODULE,
        range: { start, end }, selectionRange: { start, end: start }, children: [],
        csharp: { member: 'top-level', decl: null, inInterface: false, typeName: null },
      });
    }
    return out;
  }

  /** @param {number} k @param {string} text */
  is(k, text) {
    const t = this.toks[k];
    return t !== undefined && t.text === text && t.kind !== 'lit';
  }

  /** @param {number} k @returns {number} Past the token at `k`, jumping a bracket group. */
  skip(k) {
    return this.match[k] >= 0 && OPEN.has(this.toks[k].text) ? this.match[k] + 1 : k + 1;
  }

  /** @param {number} k @param {number} to @returns {number} Past the next `;` at this depth. */
  pastSemicolon(k, to) {
    while (k < to && !this.is(k, ';')) k = this.skip(k);
    return k + 1;
  }

  /**
   * A type declaration at `k` (attributes, then type modifiers, then the keyword): the
   * keyword's index, or -1.
   * @param {number} k @param {boolean} inType Whether an `extension(…)` block may be here.
   */
  typeKeywordAt(k, inType) {
    const toks = this.toks;
    while (this.is(k, '[')) k = this.match[k] + 1;
    while (toks[k] && toks[k].kind === 'ident' && TYPE_MODIFIERS.has(toks[k].text)) k++;
    const t = toks[k];
    if (!t || t.kind !== 'ident') return -1;
    if (t.text === 'record') {
      const n = toks[k + 1];
      return n && n.kind === 'ident' ? k : -1;
    }
    if (TYPE_WORDS.has(t.text)) return k;
    if (inType && t.text === 'extension' && (this.is(k + 1, '(') || this.is(k + 1, '<'))) return k;
    return -1;
  }

  /**
   * The declarations from `k` to `to` (a compilation unit's, a namespace's or a type's body).
   * @param {number} k @param {number} to @param {Scope} scope
   */
  declarations(k, to, scope) {
    const toks = this.toks;
    while (k < to) {
      const t = toks[k];
      if (this.is(k, ';')) { k++; continue; }
      if (scope.level !== 'type') {
        if (t.text === 'extern' && toks[k + 1] && toks[k + 1].text === 'alias') { k = this.pastSemicolon(k, to); continue; }
        if (this.isUsingDirective(k)) { k = this.pastSemicolon(k, to); continue; }
        if (this.is(k, '[') && toks[k + 1] && /^(assembly|module)$/.test(toks[k + 1].text) && this.is(k + 2, ':')) { k = this.match[k] + 1; continue; }
        if (t.text === 'namespace' && t.kind === 'ident') {
          let j = k + 1;
          while (j < to && !this.is(j, '{') && !this.is(j, ';')) j++;
          need(j < to, 'a namespace without a body');
          if (this.is(j, '{')) {
            this.declarations(j + 1, this.match[j], { ...scope, level: 'namespace' });
            k = this.match[j] + 1;
          } else {
            k = j + 1;
            scope = { ...scope, level: 'namespace' };
          }
          continue;
        }
      }
      const kw = this.typeKeywordAt(k, scope.level === 'type' && scope.isStaticClass);
      if (kw >= 0) { k = this.typeDeclaration(k, kw, to, scope); continue; }
      if (scope.level === 'unit') { k = this.globalStatements(k, to); continue; }
      if (scope.level === 'namespace') { k = this.memberEnd(k, to) + 1; continue; } // not valid C#: skipped
      const end = this.memberEnd(k, to);
      this.member(k, end, scope);
      k = end + 1;
    }
  }

  /**
   * Whether `using` at `k` is a directive (`using N.M;`, `using static N.T;`, `using A = T;`,
   * `global using …`), not a statement (`using var x = …;`, `using (…)`).
   * @param {number} k
   */
  isUsingDirective(k) {
    const toks = this.toks;
    if (toks[k] && toks[k].text === 'global' && toks[k + 1] && toks[k + 1].text === 'using') k++;
    if (!toks[k] || toks[k].text !== 'using' || toks[k].kind !== 'ident') return false;
    k++;
    if (toks[k] && (toks[k].text === 'static' || toks[k].text === 'unsafe')) k++;
    if (!toks[k] || toks[k].kind !== 'ident') return false;
    if (this.is(k + 1, '=')) return true;
    // A dotted name, type arguments allowed, then `;`.
    let depth = 0;
    for (k++; toks[k]; k++) {
      const x = toks[k].text;
      if (x === '<') depth++;
      else if (x === '>') depth--;
      else if (x === ';') return depth === 0;
      else if (depth === 0 && x !== '.' && x !== '::' && toks[k].kind !== 'ident') return false;
    }
    return false;
  }

  /**
   * Top-level statements from `k` up to the next type or namespace declaration at a
   * statement boundary; their range joins the file's top-level range.
   * @param {number} k @param {number} to @returns {number} Where the next declaration starts.
   */
  globalStatements(k, to) {
    const start = k;
    let last = k;
    let j = k;
    while (j < to) {
      if (j > start && (this.is(j - 1, ';') || this.is(j - 1, '}'))) {
        if (this.typeKeywordAt(j, false) >= 0 || (this.toks[j].text === 'namespace' && this.toks[j].kind === 'ident')) break;
      }
      j = this.skip(j);
      last = j - 1;
    }
    const range = { start: this.toks[start].start, end: this.toks[last].end };
    this.topLevel = this.topLevel
      ? { start: Math.min(this.topLevel.start, range.start), end: Math.max(this.topLevel.end, range.end) }
      : range;
    return j;
  }

  /**
   * The index of a member declaration's last token (its `;` or its body's `}`), from its
   * first token at `k`.
   * @param {number} k @param {number} to
   */
  memberEnd(k, to) {
    let assigned = false;
    let arrow = false;
    while (k < to) {
      const t = this.toks[k];
      if (t.kind === 'punct') {
        if (t.text === ';') return k;
        if (t.text === '{') {
          const close = this.match[k];
          if (!assigned && !arrow && !this.is(close + 1, '=')) return close;
          k = close + 1;
          if (this.is(k, '=')) { assigned = true; k++; }
          continue;
        }
        if (t.text === '=>') arrow = true;
        else if (t.text === '=') {
          const prev = this.toks[k - 1];
          if (!(prev && prev.end === t.start && COMPOUND.has(prev.text))) assigned = true;
        }
      }
      k = this.skip(k);
    }
    return to - 1;
  }

  /**
   * A type declaration from `k` (its first attribute or modifier), keyword at `kw`.
   * @param {number} k @param {number} kw @param {number} to @param {Scope} scope
   * @returns {number} Past the declaration.
   */
  typeDeclaration(k, kw, to, scope) {
    const toks = this.toks;
    const word = toks[kw].text;
    if (word === 'delegate') return this.pastSemicolon(kw, to);
    let j = kw + 1;
    if (word === 'record' && (toks[j].text === 'struct' || toks[j].text === 'class')) j++;
    /** @type {Token|null} */
    let nameTok = null;
    if (word !== 'extension') {
      need(toks[j] && toks[j].kind === 'ident', `a ${word} without a name`);
      nameTok = toks[j];
      j++;
    }
    let arity = 0;
    if (this.is(j, '<')) {
      let depth = 0;
      arity = 1;
      for (; j < to; j = this.skip(j)) {
        const x = toks[j].text;
        if (x === '<') depth++;
        else if (x === '>') { if (--depth === 0) { j++; break; } } else if (x === ',' && depth === 1) arity++;
      }
    }
    /** @type {number} */
    let paramsAt = -1;
    if (this.is(j, '(')) { paramsAt = j; j = this.match[j] + 1; }
    while (j < to && !this.is(j, '{') && !this.is(j, ';')) j = this.skip(j);
    need(j < to, `a ${word} without a body`);
    const bodyOpen = this.is(j, '{') ? j : -1;
    const end = bodyOpen >= 0 ? this.match[bodyOpen] : j;
    const modifiers = toks.slice(k, kw).filter((t) => t.kind === 'ident').map((t) => t.text);

    if (word === 'extension') {
      need(paramsAt >= 0, 'an extension block without a receiver');
      const receiverText = this.text.slice(toks[paramsAt].start, toks[this.match[paramsAt]].end);
      const params = csharpExtensionKeyParams(receiverText, []);
      const ext = { receiver: params || '', arity };
      if (bodyOpen >= 0) this.declarations(bodyOpen + 1, end, { ...scope, ext, inInterface: false });
      return end + 1;
    }
    const name = valueOf(/** @type {Token} */ (nameTok).text);
    const segment = typeKeySegment(name, arity);
    const kind = word === 'interface' ? KIND.INTERFACE : word === 'enum' ? KIND.ENUM
      : word === 'struct' || (word === 'record' && toks[kw + 1].text === 'struct') ? KIND.STRUCT : KIND.CLASS;
    /** @type {CsharpSymbol} */
    const symbol = {
      name: segment, detail: word, kind,
      range: { start: toks[k].start, end: toks[end].end },
      selectionRange: { start: /** @type {Token} */ (nameTok).start, end: /** @type {Token} */ (nameTok).end },
      children: [],
    };
    scope.into.push(symbol);
    const path = [...scope.path, segment];
    if (paramsAt >= 0 && word !== 'enum' && word !== 'interface') {
      const open = toks[paramsAt];
      const close = toks[this.match[paramsAt]];
      const parsed = parseCsharpParameterList(this.text.slice(open.start, close.end));
      need(parsed !== null, `an unreadable primary constructor of ${name}`);
      /** @type {CsharpSymbol[]} */ (symbol.children).push({
        name: primaryConstructorKeyName(parsed.params), detail: 'primary-constructor', kind: KIND.CONSTRUCTOR,
        range: { start: open.start, end: close.end },
        selectionRange: { start: /** @type {Token} */ (nameTok).start, end: /** @type {Token} */ (nameTok).end },
        children: [],
        csharp: { member: 'primary-constructor', decl: null, inInterface: false, typeName: name, params: parsed.params, sig: parsed.sig },
      });
    }
    if (bodyOpen >= 0 && word !== 'enum') {
      this.declarations(bodyOpen + 1, end, {
        path, into: symbol.children, level: 'type', inInterface: word === 'interface', ext: null, typeName: name,
        isStaticClass: word === 'class' && modifiers.includes('static'),
      });
    }
    return end + 1;
  }

  /**
   * One member declaration, tokens `k` to `end`: a symbol when it is a C-D4 member.
   * @param {number} k @param {number} end @param {Scope} scope
   */
  member(k, end, scope) {
    const toks = this.toks;
    const start = toks[k].start;
    const declText = this.text.slice(start, toks[end].end);
    const decl = parseCsharpDeclaration(declText);
    if (!decl) {
      need(!this.looksLikeMember(k, end), `an unreadable member: ${declText.slice(0, 80)}`);
      return;
    }
    if ((decl.kind === 'property' || decl.kind === 'indexer') && decl.body === 'none'
      && !scope.inInterface && !decl.modifiers.includes('abstract')) return;
    const nameTok = this.nameToken(k, end, start + decl.headerStart, start + decl.headerEnd, decl);
    need(nameTok !== null, `no name found for ${decl.name}`);
    scope.into.push({
      name: memberKeyName(decl, scope.ext), detail: decl.kind,
      kind: MEMBER_KIND[decl.kind],
      range: { start, end: toks[end].end },
      selectionRange: { start: nameTok.start, end: nameTok.end },
      children: [],
      csharp: { member: decl.kind, decl, inInterface: scope.inInterface, typeName: scope.typeName },
    });
  }

  /**
   * Whether a declaration the header parser could not read is a member (so the file is
   * unreadable) rather than a field, an event or a finalizer: a `(` right after a name, or an
   * accessor list or `=>` before any `=`.
   * @param {number} k @param {number} end
   */
  looksLikeMember(k, end) {
    const toks = this.toks;
    while (this.is(k, '[')) k = this.match[k] + 1;
    for (let j = k; j <= end; j = this.skip(j)) {
      const t = toks[j];
      if (t.kind === 'ident' && (t.text === 'event' || t.text === 'delegate')) return false;
      if (t.kind !== 'punct') continue;
      if (t.text === '~' || t.text === ';') return false;
      if (t.text === '=') {
        const prev = toks[j - 1];
        if (!(prev && prev.end === t.start && COMPOUND.has(prev.text))) return false;
      }
      if (t.text === '{' || t.text === '=>') return true;
      if (t.text === '(') {
        const prev = toks[j - 1];
        if (j > k && prev && (prev.text === '>' || (prev.kind === 'ident' && !MEMBER_MODIFIERS.has(prev.text)))) return true;
      }
    }
    return false;
  }

  /**
   * The token the member is named by, among its header tokens (`from`..`to` offsets).
   * @param {number} k @param {number} end @param {number} from @param {number} to
   * @param {CsharpDeclaration} decl
   * @returns {Token|null}
   */
  nameToken(k, end, from, to, decl) {
    const toks = this.toks;
    /** @type {Token|null} */
    let found = null;
    let depth = 0;
    for (let j = k; j <= end && toks[j].start < to; j++) {
      const t = toks[j];
      if (t.start < from) continue;
      if (t.kind === 'punct' && (t.text === '(' || t.text === '[')) {
        if (depth === 0 && decl.kind === 'indexer' && t.text === '[' && toks[j - 1].text === 'this') return toks[j - 1];
        depth++;
        continue;
      }
      if (t.kind === 'punct' && (t.text === ')' || t.text === ']')) { depth--; continue; }
      if (depth !== 0) continue;
      switch (decl.kind) {
        case 'operator': case 'conversion':
          if (t.text === 'operator') return t;
          break;
        case 'property':
          if (t.kind === 'ident' && valueOf(t.text) === decl.name) found = t;
          break;
        case 'indexer':
          break;
        default: {
          const next = toks[j + 1];
          if (t.kind === 'ident' && valueOf(t.text) === decl.name && next && (next.text === '(' || next.text === '<')) found = t;
        }
      }
    }
    return found;
  }
}

module.exports = { csharpOutline, MAX_TEXT_CHARS, KIND };
