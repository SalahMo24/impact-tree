// @ts-check
'use strict';
// Java's types, methods and constructors read from the text alone, for where there is no
// language server (the CLI, the no-checkout preview; docs/MULTI_LANGUAGE_PLAN.md, J7).
// `javaOutline` answers what jdtls' documentSymbol answers (J0 §1;
// test/java-symbols/recorded.json), in the same shape, so `collectJavaSymbols` keys it as it
// keys jdtls' answer and J3's header parser reads its ranges unchanged. Pure text in, plain
// data out; nothing here touches the editor or the file system.
//
// The text is lexed once (./lexer.js: strings, text blocks, chars and comments are skipped
// as single tokens), every `()`, `[]` and `{}` is matched, then declarations are read from
// the tokens. `<` and `>` are read as brackets only where a type is (a type's or method's
// type parameters, a declared type, after `new`, explicit type arguments after `.`), so a
// comparison in an initializer or a body is never taken for one.
//
// Limits (documented, not handled):
// - Unicode escapes are not decoded (./lexer.js).
// - What jdtls names from resolved types is named as written: a parameter type keeps its
//   type arguments as written and only its outermost qualification is dropped
//   (`java.util.Map<K, V>` → `Map<K, V>`, as J0 measured), which `erasedType` then keys.
// - Initializer blocks (`static { … }`) are not listed, nor what is inside them; a local
//   class's range starts at its modifiers, not at its annotations. Neither is a candidate
//   (`collectJavaSymbols` does not walk method bodies).
// - A field declaration with several names (`int a, b;`) lists each name with the
//   declaration's range.

/** @typedef {import('../types').ServerSymbol} ServerSymbol */
/** @typedef {import('./lexer').Token} Token */

const { lex } = require('./lexer');

// Budget: the longest text read, in UTF-16 units. Valid range >= 1; default 2 Mi, the
// preview's per-file fetch limit (src/github/github-request.js `maxFileBytes`), above any real
// source file (gson's largest is ~70 Ki). Owner: this module; enforced by `javaOutline`,
// which answers null past it (an unread file, never a partial outline).
const MAX_TEXT_CHARS = 2 * 1024 * 1024;

// LSP SymbolKind numbers jdtls gives (J0).
const KIND = Object.freeze({
  PACKAGE: 4, CLASS: 5, METHOD: 6, FIELD: 8, CONSTRUCTOR: 9, ENUM: 10, INTERFACE: 11,
  CONSTANT: 14, ENUM_MEMBER: 22,
});
const MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native',
  'default', 'strictfp', 'transient', 'volatile', 'sealed', 'non-sealed',
]);
const TYPE_WORDS = new Set(['class', 'interface', 'enum']);
const OPEN = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const CLOSE = new Set([')', ']', '}']);

/** Thrown inside the reader for text it cannot read; `javaOutline` answers null. */
class Unreadable extends Error {}

/**
 * @param {boolean} ok
 * @param {string} what
 * @returns {asserts ok}
 */
function need(ok, what) {
  if (!ok) throw new Unreadable(what);
}

/**
 * Tokens rendered as a type is shown: a space after a comma, around `&` and between two
 * words (`? extends T`), none elsewhere (`Map<String, List<int[]>>`). Annotations dropped.
 * @param {Token[]} toks
 * @returns {string}
 */
function render(toks) {
  let out = '';
  /** @type {Token|null} */
  let prev = null;
  for (const t of toks) {
    if (prev) {
      if (prev.text === ',' || t.text === '&' || prev.text === '&') out += ' ';
      else if (t.kind === 'ident' && (prev.kind === 'ident' || prev.text === '?')) out += ' ';
    }
    out += t.text;
    prev = t;
  }
  return out;
}

/**
 * The document symbols of a Java file, as jdtls' documentSymbol gives them (J0 §1):
 * - the package (`Package`, its statement), then each top-level type: `Class` (records too),
 *   `Interface` (annotation types too), `Enum`; named with their type parameters as written
 *   (`Generic<T extends Comparable<T>>`); nested types are children of their type;
 * - methods `name(T1, T2)` with parameter types as written (annotations, `final` and names
 *   dropped, the outermost qualification dropped, `T...` and `[]` kept) and a generic
 *   method's ` <T>` suffix, `detail` ` : Ret`; constructors kind `Constructor`, a record's
 *   compact one named by the record's components (`Point(int, int)`);
 * - fields (`Constant` when `static final` or in an interface) and record components
 *   (`Field`); enum constants (`EnumMember`), a constant's body an `Enum` child `{...}`;
 *   an anonymous class `new X() {...}` (`Class`, type arguments dropped) is a child of the
 *   field or method whose text holds it, a local class a child of its method;
 * - `range` from the leading Javadoc, comments and annotations to the closing `}` or `;`
 *   (a comment on the line where the previous declaration ends is that one's),
 *   `selectionRange` the bare name.
 * Null for text this cannot read (an unterminated literal or comment, unbalanced brackets,
 * a declaration it cannot parse) or longer than `MAX_TEXT_CHARS`: never a partial outline.
 * Pure. Bound: one lexing pass and one pass over the tokens (each declaration is read once;
 * bodies are scanned once for anonymous and local classes).
 * @param {string} text
 * @returns {ServerSymbol[]|null}
 */
function javaOutline(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) return null;
  /** @type {Token[]} */
  const toks = [];
  if (lex(text, 0, (t) => { toks.push(t); }) < 0) return null;
  const match = matchBrackets(toks);
  if (!match) return null;
  try {
    return new Reader(text, toks, match).compilationUnit();
  } catch (e) {
    if (e instanceof Unreadable) return null;
    throw e;
  }
}

/**
 * For each `(`, `[`, `{` its closing token's index and for each closer its opener's; null
 * when they do not balance.
 * @param {Token[]} toks
 * @returns {Int32Array|null}
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

class Reader {
  /** @param {string} text @param {Token[]} toks @param {Int32Array} match */
  constructor(text, toks, match) {
    this.text = text;
    this.toks = toks;
    this.match = match;
  }

  /** @param {number} k @param {string} s */
  is(k, s) {
    const t = this.toks[k];
    return Boolean(t) && t.text === s && t.kind !== 'lit';
  }

  /** @param {number} k */
  isIdent(k) {
    const t = this.toks[k];
    return Boolean(t) && t.kind === 'ident';
  }

  /** @param {number} k @returns {number} Index past the bracket group opened at `k`. */
  past(k) {
    need(this.match[k] > k, 'bracket');
    return this.match[k] + 1;
  }

  /**
   * Index past a balanced `<…>` at `k` (only `<`/`>` counted; a `(`, `{`, `;` or `}`
   * inside means it was no type argument list).
   * @param {number} k
   */
  pastAngles(k) {
    let d = 0;
    for (let m = k; m < this.toks.length; m++) {
      const t = this.toks[m].text;
      if (this.toks[m].kind === 'lit') continue;
      if (t === '<') d++;
      else if (t === '>' && --d === 0) return m + 1;
      else if (t === '(' || t === '{' || t === ';' || t === '}') break;
    }
    throw new Unreadable('type arguments');
  }

  /**
   * Where a declaration's range starts: the first comment between the previous token and
   * `k` that does not start on the line the previous token ends (that one belongs to it).
   * @param {number} k The declaration's first token (its first annotation or modifier).
   */
  leadStart(k) {
    const from = k > 0 ? this.toks[k - 1].end : 0;
    const to = this.toks[k].start;
    let i = from;
    let sameLine = k > 0;
    while (i < to) {
      const c = this.text[i];
      if (c === '\n') { sameLine = false; i++; continue; }
      if (c === '/' && (this.text[i + 1] === '/' || this.text[i + 1] === '*')) {
        if (!sameLine) return i;
        const end = this.text[i + 1] === '/' ? this.text.indexOf('\n', i) : this.text.indexOf('*/', i + 2) + 2;
        i = end < 0 || end < i ? to : end;
        continue;
      }
      i++;
    }
    return to;
  }

  /** @returns {ServerSymbol[]} */
  compilationUnit() {
    /** @type {ServerSymbol[]} */
    const out = [];
    let k = 0;
    const n = this.toks.length;
    // Annotations of a `package-info.java` come before `package`.
    const a = this.skipAnnotations(0);
    if (this.is(a, 'package')) {
      let m = a + 1;
      while (m < n && !this.is(m, ';')) m++;
      need(m < n, 'package');
      const start = this.toks[a].start;
      const end = this.toks[m].end;
      out.push({
        name: this.toks.slice(a + 1, m).map((t) => t.text).join(''), detail: '', kind: KIND.PACKAGE,
        range: { start, end }, selectionRange: { start, end }, children: [],
      });
      k = m + 1;
    }
    while (k < n) {
      if (this.is(k, ';')) { k++; continue; }
      if (this.is(k, 'import')) {
        while (k < n && !this.is(k, ';')) k++;
        k++;
        continue;
      }
      k = this.member(k, out, { name: null, kind: null });
    }
    return out;
  }

  /** @param {number} k @returns {number} Index past the annotations at `k`. */
  skipAnnotations(k) {
    while (this.is(k, '@') && !this.is(k + 1, 'interface')) {
      k++;
      need(this.isIdent(k), 'annotation');
      k++;
      while (this.is(k, '.') && this.isIdent(k + 1)) k += 2;
      if (this.is(k, '(')) k = this.past(k);
    }
    return k;
  }

  /**
   * One member of a type body (or a top-level type), appended to `out`.
   * @param {number} k Its first token.
   * @param {ServerSymbol[]} out
   * @param {{ name: string|null, kind: 'class'|'interface'|'enum'|'record'|'annotation'|'anonymous'|null, components?: string[] }} owner
   * @returns {number} Index past it.
   */
  member(k, out, owner) {
    const first = k;
    const modifiers = new Set();
    for (;;) {
      k = this.skipAnnotations(k);
      if (this.isIdent(k) && MODIFIERS.has(this.toks[k].text) && !(this.toks[k].text === 'default' && this.is(k + 1, ':'))) {
        modifiers.add(this.toks[k].text);
        k++;
      } else break;
    }
    // An initializer block: not listed (see Limits).
    if (this.is(k, '{')) return this.past(k);
    if (this.isTypeStart(k)) return this.typeDeclaration(first, k, out);
    let typeParams = '';
    if (this.is(k, '<')) {
      const e = this.pastAngles(k);
      typeParams = this.typeParameterNames(k, e);
      k = e;
    }
    need(this.isIdent(k), 'member');
    const nameTok = this.toks[k];
    // A constructor, or a record's compact constructor.
    if (owner.name && nameTok.text === owner.name && (this.is(k + 1, '(') || (owner.kind === 'record' && this.is(k + 1, '{')))) {
      const compact = this.is(k + 1, '{');
      const params = compact ? (owner.components || []) : this.parameterTypes(k + 1);
      const end = this.methodEnd(compact ? k + 1 : this.past(k + 1));
      out.push(this.symbol(`${nameTok.text}(${params.join(', ')})${typeParams ? ` ${typeParams}` : ''}`, '', KIND.CONSTRUCTOR,
        first, end.last, k, this.bodyChildren(end.body)));
      return end.last + 1;
    }
    const typeStart = k;
    k = this.pastType(k);
    const returnType = render(this.toks.slice(typeStart, k).filter((t) => t.kind !== 'anno'));
    need(this.isIdent(k), 'member name');
    const name = k;
    if (this.is(k + 1, '(')) {
      const params = this.parameterTypes(k + 1);
      const end = this.methodEnd(this.past(k + 1));
      out.push(this.symbol(`${this.toks[name].text}(${params.join(', ')})${typeParams ? ` ${typeParams}` : ''}`, ` : ${returnType}`,
        KIND.METHOD, first, end.last, name, this.bodyChildren(end.body)));
      return end.last + 1;
    }
    // A field: one or more declarators up to `;`.
    const constant = (modifiers.has('static') && modifiers.has('final')) || owner.kind === 'interface' || owner.kind === 'annotation';
    /** @type {Array<{ name: number, init: [number, number]|null }>} */
    const declarators = [];
    for (;;) {
      need(this.isIdent(k), 'field name');
      const at = k;
      k++;
      while (this.is(k, '[')) k = this.past(k);
      /** @type {[number, number]|null} */
      let init = null;
      if (this.is(k, '=')) {
        const from = k + 1;
        k = this.initializerEnd(from);
        init = [from, k];
      }
      declarators.push({ name: at, init });
      if (this.is(k, ',')) { k++; continue; }
      need(this.is(k, ';'), 'field end');
      break;
    }
    for (const d of declarators) {
      out.push(this.symbol(this.toks[d.name].text, '', constant ? KIND.CONSTANT : KIND.FIELD, first, k, d.name,
        d.init ? this.bodyChildren(d.init) : []));
    }
    return k + 1;
  }

  /** @param {number} k Whether a type declaration's keyword is at `k`. */
  isTypeStart(k) {
    if (!this.isIdent(k) && !this.is(k, '@')) return false;
    const w = this.toks[k].text;
    if (w === '@') return this.is(k + 1, 'interface');
    if (TYPE_WORDS.has(w)) return true;
    // `record` is a restricted identifier: a record only when a name and `(` or `<` follow.
    return w === 'record' && this.isIdent(k + 1) && (this.is(k + 2, '(') || this.is(k + 2, '<'));
  }

  /**
   * A type declaration from its keyword at `k` (`first`: its first annotation or modifier).
   * @param {number} first @param {number} k @param {ServerSymbol[]} out
   * @returns {number} Index past its body.
   */
  typeDeclaration(first, k, out) {
    const word = this.is(k, '@') ? 'annotation' : /** @type {'class'|'interface'|'enum'|'record'} */ (this.toks[k].text);
    k += word === 'annotation' ? 2 : 1;
    need(this.isIdent(k), 'type name');
    const nameAt = k;
    k++;
    let name = this.toks[nameAt].text;
    if (this.is(k, '<')) {
      const e = this.pastAngles(k);
      name += render(this.toks.slice(k, e));
      k = e;
    }
    /** @type {ServerSymbol[]} */
    const children = [];
    /** @type {string[]} */
    const components = [];
    if (word === 'record') {
      need(this.is(k, '('), 'record components');
      const close = this.match[k];
      for (const p of this.splitTop(k + 1, close)) {
        const nameTok = p[p.length - 1];
        need(nameTok >= p[0] && this.isIdent(nameTok), 'record component');
        components.push(this.parameterType(p));
        children.push({
          name: this.toks[nameTok].text, detail: '', kind: KIND.FIELD,
          range: { start: this.toks[p[0]].start, end: this.toks[nameTok].end },
          selectionRange: { start: this.toks[nameTok].start, end: this.toks[nameTok].end }, children: [],
        });
      }
      k = close + 1;
    }
    // `extends`, `implements`, `permits` up to the body.
    while (k < this.toks.length && !this.is(k, '{')) {
      if (this.is(k, '(') || this.is(k, '[')) k = this.past(k);
      else { need(!this.is(k, ';') && !this.is(k, '}'), 'type header'); k++; }
    }
    need(this.is(k, '{'), 'type body');
    const close = this.match[k];
    const kind = word === 'enum' ? KIND.ENUM : word === 'interface' || word === 'annotation' ? KIND.INTERFACE : KIND.CLASS;
    /** @type {Parameters<Reader['member']>[2]} */
    const owner = { name: this.toks[nameAt].text, kind: word, components };
    let m = k + 1;
    if (word === 'enum') m = this.enumConstants(m, close, children);
    this.body(m, close, children, owner);
    out.push(this.symbol(name, '', kind, first, close, nameAt, children));
    return close + 1;
  }

  /**
   * Members from `k` to the body's closing brace at `close`.
   * @param {number} k @param {number} close @param {ServerSymbol[]} out
   * @param {Parameters<Reader['member']>[2]} owner
   */
  body(k, close, out, owner) {
    while (k < close) {
      if (this.is(k, ';')) { k++; continue; }
      k = this.member(k, out, owner);
      need(k <= close, 'member past its body');
    }
  }

  /**
   * An enum's constants from `k`; returns the index of the `;` that ends them (past it) or
   * of the body's `}`.
   * @param {number} k @param {number} close @param {ServerSymbol[]} out
   */
  enumConstants(k, close, out) {
    while (k < close) {
      if (this.is(k, ';')) return k + 1;
      if (this.is(k, ',')) { k++; continue; }
      const first = k;
      k = this.skipAnnotations(k);
      need(this.isIdent(k), 'enum constant');
      const nameAt = k;
      k++;
      /** @type {ServerSymbol[]} */
      const children = [];
      if (this.is(k, '(')) {
        const e = this.past(k);
        children.push(...this.bodyChildren([k + 1, e - 1]));
        k = e;
      }
      if (this.is(k, '{')) {
        const bodyClose = this.match[k];
        /** @type {ServerSymbol[]} */
        const members = [];
        this.body(k + 1, bodyClose, members, { name: null, kind: 'anonymous' });
        const nameTok = this.toks[nameAt];
        children.push({
          name: '{...}', detail: '', kind: KIND.ENUM,
          range: { start: nameTok.start, end: this.toks[bodyClose].end },
          selectionRange: { start: nameTok.start, end: nameTok.end }, children: members,
        });
        k = bodyClose + 1;
      }
      out.push(this.symbol(this.toks[nameAt].text, '', KIND.ENUM_MEMBER, first, k - 1, nameAt, children));
    }
    return k;
  }

  /**
   * Index past a declared type at `k`: annotations, a (qualified, parameterised) name or a
   * primitive, then `[]` dims or `...`.
   * @param {number} k
   */
  pastType(k) {
    k = this.skipAnnotations(k);
    need(this.isIdent(k), 'type');
    k++;
    for (;;) {
      if (this.is(k, '<')) k = this.pastAngles(k);
      if (this.is(k, '.') && (this.isIdent(k + 1) || this.is(k + 1, '@'))) { k = this.skipAnnotations(k + 1); need(this.isIdent(k), 'type'); k++; continue; }
      break;
    }
    for (;;) {
      k = this.skipAnnotations(k);
      if (this.is(k, '[') && this.is(k + 1, ']')) k += 2;
      else break;
    }
    if (this.is(k, '...')) k++;
    return k;
  }

  /**
   * A method's type parameters as its name's suffix shows them: `<K, V>`, bounds dropped.
   * @param {number} k Its `<`. @param {number} e Past its `>`.
   */
  typeParameterNames(k, e) {
    /** @type {string[]} */
    const names = [];
    for (const p of this.splitTop(k + 1, e - 1)) {
      const at = this.skipAnnotations(p[0]);
      need(this.isIdent(at), 'type parameter');
      names.push(this.toks[at].text);
    }
    return `<${names.join(', ')}>`;
  }

  /**
   * Token-index lists of the parts between `from` and `to` split at top-level commas
   * (commas inside `()`, `[]`, `{}` or `<>` are not separators).
   * @param {number} from @param {number} to Exclusive.
   * @returns {number[][]}
   */
  splitTop(from, to) {
    /** @type {number[][]} */
    const parts = [];
    let cur = [];
    let angles = 0;
    for (let k = from; k < to; k++) {
      if (this.match[k] > k) {
        for (let m = k; m <= this.match[k]; m++) cur.push(m);
        k = this.match[k];
        continue;
      }
      if (this.is(k, '<')) angles++;
      else if (this.is(k, '>') && angles > 0) angles--;
      else if (this.is(k, ',') && angles === 0) { parts.push(cur); cur = []; continue; }
      cur.push(k);
    }
    if (cur.length) parts.push(cur);
    for (const p of parts) need(p.length > 0, 'empty parameter');
    return parts;
  }

  /**
   * The parameter types of the list whose `(` is at `k`, as jdtls names them.
   * @param {number} k
   * @returns {string[]}
   */
  parameterTypes(k) {
    need(this.is(k, '('), 'parameter list');
    return this.splitTop(k + 1, this.match[k]).map((p) => this.parameterType(p));
  }

  /**
   * One parameter's type: annotations, `final` and its name dropped, `[]` after the name
   * moved onto the type, the outermost qualification dropped.
   * @param {number[]} part Token indices.
   * @returns {string}
   */
  parameterType(part) {
    const toks = part.map((m) => this.toks[m]);
    let i = 0;
    // Annotations (with their arguments) and `final` before the type.
    /** @type {Token[]} */
    const kept = [];
    while (i < toks.length) {
      if (toks[i].text === '@' && toks[i + 1] && toks[i + 1].kind === 'ident') {
        i += 2;
        while (toks[i] && toks[i].text === '.' && toks[i + 1] && toks[i + 1].kind === 'ident') i += 2;
        if (toks[i] && toks[i].text === '(') {
          const close = this.match[part[i]];
          while (i < toks.length && part[i] <= close) i++;
        }
        continue;
      }
      if (toks[i].kind === 'ident' && toks[i].text === 'final') { i++; continue; }
      kept.push(toks[i]);
      i++;
    }
    // The name is the last word; `[]` after it belong to the type.
    let n = kept.length - 1;
    /** @type {Token[]} */
    const dims = [];
    while (n > 0 && kept[n].text === ']' && kept[n - 1].text === '[') { dims.unshift(kept[n - 1], kept[n]); n -= 2; }
    need(n >= 1 && kept[n].kind === 'ident', 'parameter name');
    // A receiver parameter (`Outer this`) keeps `this` as its "name"; jdtls does not list it.
    const type = [...kept.slice(0, n), ...dims];
    let top = type.findIndex((t) => t.text === '<' || t.text === '[' || t.text === '...');
    if (top < 0) top = type.length;
    let lastDot = -1;
    for (let j = 0; j < top; j++) if (type[j].text === '.') lastDot = j;
    return render(type.slice(lastDot + 1));
  }

  /**
   * Where a method's declaration ends, from just past its parameter list: past `[]` dims,
   * `throws`, then its body `{…}`, `;`, or an annotation method's `default` value and `;`.
   * @param {number} k
   * @returns {{ last: number, body: [number, number]|null }} `last` the index of its `}`
   *   or `;`; `body` the token range inside its body.
   */
  methodEnd(k) {
    for (;;) {
      if (this.is(k, '{')) return { last: this.match[k], body: [k + 1, this.match[k]] };
      if (this.is(k, ';')) return { last: k, body: null };
      need(k < this.toks.length && !this.is(k, '}'), 'method end');
      k = this.match[k] > k ? this.match[k] + 1 : k + 1;
    }
  }

  /**
   * The end of a field's initializer from `k`: the index of the `,` or `;` that ends it.
   * Brackets are skipped whole; `<…>` only after `new X` or `.` (explicit type arguments),
   * where it can only be type arguments.
   * @param {number} k
   */
  initializerEnd(k) {
    while (k < this.toks.length) {
      if (this.is(k, ',') || this.is(k, ';')) return k;
      need(!this.is(k, '}'), 'initializer');
      if (this.match[k] > k) { k = this.match[k] + 1; continue; }
      if (this.is(k, 'new')) {
        k++;
        while (this.isIdent(k) || this.is(k, '.') || this.is(k, '@')) {
          if (this.is(k, '@')) k = this.skipAnnotations(k);
          else k++;
          if (this.is(k, '<')) k = this.pastAngles(k);
        }
        continue;
      }
      if (this.is(k, '.') && this.is(k + 1, '<')) { k = this.pastAngles(k + 1); continue; }
      k++;
    }
    throw new Unreadable('initializer end');
  }

  /**
   * The anonymous and local classes in a token range (a method's body, a field's
   * initializer, an enum constant's arguments), in source order; each one's own body is
   * read as a type body (its methods hold what is inside them).
   * @param {[number, number]|null} range From, to (exclusive).
   * @returns {ServerSymbol[]}
   */
  bodyChildren(range) {
    /** @type {ServerSymbol[]} */
    const out = [];
    if (!range) return out;
    let [k] = range;
    const to = range[1];
    while (k < to) {
      if (this.is(k, 'new') && !this.is(k - 1, '::')) {
        const at = k;
        let m = k + 1;
        let nameAt = -1;
        while (this.isIdent(m) || this.is(m, '.') || this.is(m, '@')) {
          if (this.is(m, '@')) { m = this.skipAnnotations(m); continue; }
          if (this.isIdent(m)) nameAt = m;
          m++;
          if (this.is(m, '<')) m = this.pastAngles(m);
        }
        if (nameAt >= 0 && this.is(m, '(')) {
          const argsClose = this.match[m];
          out.push(...this.bodyChildren([m + 1, argsClose]));
          if (this.is(argsClose + 1, '{')) {
            const close = this.match[argsClose + 1];
            /** @type {ServerSymbol[]} */
            const members = [];
            this.body(argsClose + 2, close, members, { name: null, kind: 'anonymous' });
            const nameTok = this.toks[nameAt];
            out.push({
              name: `new ${nameTok.text}() {...}`, detail: '', kind: KIND.CLASS,
              range: { start: this.toks[at].start, end: this.toks[close].end },
              selectionRange: { start: nameTok.start, end: nameTok.end }, children: members,
            });
            k = close + 1;
            continue;
          }
          k = argsClose + 1;
          continue;
        }
        k = m;
        continue;
      }
      if (this.isTypeStart(k) && !this.is(k - 1, '.') && (this.is(k, '@') || this.isIdent(k + 1))) {
        // A local class, interface, enum or record, from its modifiers.
        let first = k;
        while (first - 1 >= range[0] && this.isIdent(first - 1) && MODIFIERS.has(this.toks[first - 1].text)) first--;
        /** @type {ServerSymbol[]} */
        const local = [];
        k = this.typeDeclaration(first, k, local);
        for (const s of local) s.range.start = this.toks[first].start;
        out.push(...local);
        continue;
      }
      k++;
    }
    return out.sort((a, b) => a.range.start - b.range.start);
  }

  /**
   * @param {string} name @param {string} detail @param {number} kind
   * @param {number} first The declaration's first token (annotation or modifier).
   * @param {number} last Its last token (`}` or `;`).
   * @param {number} nameAt Its name token.
   * @param {ServerSymbol[]} children
   * @returns {ServerSymbol}
   */
  symbol(name, detail, kind, first, last, nameAt, children) {
    const nameTok = this.toks[nameAt];
    return {
      name, detail, kind,
      range: { start: this.leadStart(first), end: this.toks[last].end },
      selectionRange: { start: nameTok.start, end: nameTok.end },
      children,
    };
  }
}

module.exports = { javaOutline, MAX_TEXT_CHARS };
