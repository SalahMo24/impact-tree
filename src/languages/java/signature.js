// @ts-check
'use strict';
// Java signatures (docs/MULTI_LANGUAGE_PLAN.md, J3): a method's or constructor's header
// parsed into the `sig` object the shared `diffSignature` compares, the `throw new` types of
// its own body (J-D5), the change kinds of a header (`javaKindsOf`, J-D4/J-D5) and a short
// display. Pure text in, plain data out; nothing here touches the editor or the file system.
//
// Parsing a header is a documented, explicit result: text this cannot read yields `null`
// (never a throw, never a guessed signature), and the caller reports the symbol as having
// no comparable signature rather than as unchanged.
//
// Limits (documented, not handled):
// - Unicode escapes (`{`) are not decoded: a brace or quote written as one is read as
//   the escape's letters, so a header that depends on one may be misread or yield null.
// - Type-use annotations inside a type (`java.util.@Nullable List`) are dropped from the
//   type text like declaration annotations; only their presence is lost.
// - A record's compact constructor (`public Point { … }`) has no parameter list in its
//   text: its sig has no params (`compact: true`). jdtls names it by the record's
//   components (`Point(int, int)`), so a component change moves its key (J-D3) and reads
//   as a removal and an addition, not as a parameter change here.
// - An interface method without an access modifier is public. The parser cannot see the
//   enclosing type, so `javaKindsOf` reads such a method as package-private unless the
//   symbol says `inInterface: true`.

/**
 * @typedef {{ name: string, type: string, optional: false, rest: boolean }} JavaParam
 * @typedef {{
 *   async: false, name: string, params: JavaParam[], returns: string | null,
 *   typeParameters: string, throws: string[], compact: boolean,
 * }} JavaSig
 * @typedef {{ kind: 'ident' | 'punct' | 'lit' | 'anno', text: string, start: number, end: number }} Token
 */

const MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native',
  'default', 'strictfp', 'transient', 'volatile', 'sealed', 'non-sealed',
]);
// Words that cannot start a type or be a method name (so a class, field or statement is
// not read as a method). `record` is a restricted identifier: no type is named so.
const NOT_A_TYPE = new Set([
  'class', 'interface', 'enum', 'record', 'new', 'return', 'throw', 'if', 'for', 'while',
  'do', 'switch', 'case', 'try', 'catch', 'finally', 'else', 'import', 'package', 'extends',
  'implements', 'throws', 'this', 'super', 'null', 'true', 'false', '=', 'assert', 'break',
  'continue', 'instanceof', 'goto', 'const',
]);
const PRIMITIVES = new Set(['void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);
const { lex } = require('./lexer');
const ACCESS_RANK = { private: 0, package: 1, protected: 2, public: 3 };

/**
 * The header's tokens, annotations folded into single `anno` tokens (name as written,
 * arguments skipped), and the offset of the body's `{` or the closing `;`. The header ends
 * at the first `{` or `;` outside brackets, except inside an annotation method's
 * `default` value (`String[] names() default {};`). Null on text it cannot scan.
 * @param {string} text @returns {{ tokens: Token[], headerEnd: number } | null}
 */
function scanHeader(text) {
  /** @type {Token[]} */
  const raw = [];
  let depth = 0;
  let headerEnd = -1;
  let inDefault = false;
  let bad = false;
  let sawParams = false;
  let annoParen = false;
  const stop = lex(text, 0, (t) => {
    if (t.kind === 'punct') {
      if (depth === 0 && !inDefault && (t.text === '{' || t.text === ';')) { headerEnd = t.start; return false; }
      if (depth === 0 && inDefault && t.text === ';') { headerEnd = t.start; return false; }
      if (t.text === '(' && depth === 0) annoParen = isAnnotationName(raw);
      if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
      else if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (--depth < 0) { bad = true; return false; }
        if (depth === 0 && t.text === ')' && !annoParen) sawParams = true;
      }
    }
    // `default` after the parameter list starts an annotation method's default value.
    if (t.kind === 'ident' && t.text === 'default' && depth === 0 && sawParams) inDefault = true;
    raw.push(t);
    return true;
  });
  if (stop < 0 || bad || headerEnd < 0) return null;
  /** @type {Token[]} */
  const tokens = [];
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    if (t.text !== '@' || !raw[k + 1] || raw[k + 1].kind !== 'ident' || raw[k + 1].text === 'interface') { tokens.push(t); continue; }
    let n = k + 1;
    let name = raw[n].text;
    while (raw[n + 1] && raw[n + 1].text === '.' && raw[n + 2] && raw[n + 2].kind === 'ident') { name += `.${raw[n + 2].text}`; n += 2; }
    let end = raw[n].end;
    if (raw[n + 1] && raw[n + 1].text === '(') {
      let d = 0;
      let m = n + 1;
      for (; m < raw.length; m++) {
        if (raw[m].text === '(') d++;
        else if (raw[m].text === ')' && --d === 0) break;
      }
      if (m >= raw.length) return null;
      n = m;
      end = raw[m].end;
    }
    tokens.push({ kind: 'anno', text: name, start: t.start, end });
    k = n;
  }
  return { tokens, headerEnd };
}

/**
 * Whether the tokens so far end with an annotation's name (`@A`, `@a.b.C`), so a `(` here
 * opens its arguments rather than a parameter list.
 * @param {Token[]} raw @returns {boolean}
 */
function isAnnotationName(raw) {
  let m = raw.length - 1;
  while (m >= 0 && raw[m].kind === 'ident') {
    if (raw[m - 1] && raw[m - 1].text === '@') return true;
    if (!raw[m - 1] || raw[m - 1].text !== '.') return false;
    m -= 2;
  }
  return false;
}

/**
 * Index just past a balanced `<…>` starting at `k` (tokens[k] is `<`), or -1.
 * @param {Token[]} toks @param {number} k @returns {number}
 */
function skipAngles(toks, k) {
  let d = 0;
  for (let m = k; m < toks.length; m++) {
    const t = toks[m].text;
    if (t === '<') d++;
    else if (t === '>' && --d === 0) return m + 1;
    else if (t === '(' || t === ')' || t === '{' || t === '}' || t === ';') return -1;
  }
  return -1;
}

/**
 * A type's text from its tokens: annotations dropped, a space between two words (`? extends
 * T`), after a comma and around `&`, none elsewhere (`Map<String, List<int[]>>`, `T...`).
 * @param {Token[]} toks @returns {string}
 */
function renderType(toks) {
  let out = '';
  /** @type {Token | null} */
  let prev = null;
  for (const t of toks) {
    if (t.kind === 'anno') continue;
    if (prev) {
      const word = t.kind === 'ident';
      if (prev.text === ',' || t.text === '&' || prev.text === '&') out += ' ';
      else if (word && (prev.kind === 'ident' || prev.text === '?')) out += ' ';
    }
    out += t.text;
    prev = t;
  }
  return out;
}

/**
 * Read a type at `k`: annotations, a primitive or a (qualified, parameterised) class type or
 * `?` wildcard, then `[]` dims (annotations allowed between). Returns the index just past it.
 * @param {Token[]} toks @param {number} k @returns {number} -1 when there is no type here
 */
function readType(toks, k) {
  while (toks[k] && toks[k].kind === 'anno') k++;
  if (!toks[k] || toks[k].kind !== 'ident' || NOT_A_TYPE.has(toks[k].text) || MODIFIERS.has(toks[k].text)) return -1;
  k++;
  for (;;) {
    if (toks[k] && toks[k].text === '<') { k = skipAngles(toks, k); if (k < 0) return -1; }
    if (toks[k] && toks[k].text === '.' && toks[k + 1]) {
      let m = k + 1;
      while (toks[m] && toks[m].kind === 'anno') m++;
      if (toks[m] && toks[m].kind === 'ident') { k = m + 1; continue; }
    }
    break;
  }
  return readDims(toks, k);
}

/** Past `[]` pairs (annotations allowed before each) at `k`. @param {Token[]} toks @param {number} k */
function readDims(toks, k) {
  for (;;) {
    let m = k;
    while (toks[m] && toks[m].kind === 'anno') m++;
    if (toks[m] && toks[m].text === '[' && toks[m + 1] && toks[m + 1].text === ']') { k = m + 2; continue; }
    return k;
  }
}

/**
 * Split tokens at commas outside `()`, `[]`, `{}` and `<>`. Null on an empty entry.
 * @param {Token[]} toks @returns {Token[][] | null}
 */
function splitTop(toks) {
  if (toks.length === 0) return [];
  /** @type {Token[][]} */
  const out = [[]];
  let d = 0;
  for (const t of toks) {
    if ('([{<'.includes(t.text) && t.kind === 'punct') d++;
    else if (')]}>'.includes(t.text) && t.kind === 'punct') d--;
    else if (t.text === ',' && d === 0) { out.push([]); continue; }
    out[out.length - 1].push(t);
  }
  return out.some((e) => e.length === 0) ? null : out;
}

/**
 * One formal parameter: annotations and `final` dropped, varargs written `T...` with
 * `rest: true`, C-style dims after the name (`String args[]`) moved onto the type. Null for
 * a receiver parameter (`Foo this`), which is not a parameter callers pass; undefined when
 * the entry cannot be read.
 * @param {Token[]} e @returns {JavaParam | null | undefined}
 */
function readParam(e) {
  let k = 0;
  while (e[k] && (e[k].kind === 'anno' || e[k].text === 'final')) k++;
  const typeStart = k;
  const typeEnd = readType(e, k);
  if (typeEnd < 0) return undefined;
  let rest = false;
  let m = typeEnd;
  while (e[m] && e[m].kind === 'anno') m++;
  if (e[m] && e[m].text === '...') { rest = true; m++; }
  const nameTok = e[m];
  if (!nameTok || nameTok.kind !== 'ident') return undefined;
  // Receiver parameter: `Foo this` or `Outer.this`.
  if (nameTok.text === 'this' || (e[m + 1] && e[m + 1].text === '.')) {
    const last = e[e.length - 1];
    return last && last.text === 'this' ? null : undefined;
  }
  const dimsEnd = readDims(e, m + 1);
  if (dimsEnd !== e.length) return undefined;
  const dims = e.slice(m + 1, dimsEnd).filter((t) => t.kind !== 'anno').map((t) => t.text).join('');
  const type = renderType(e.slice(typeStart, typeEnd)) + dims + (rest ? '...' : '');
  return { name: nameTok.text, type, optional: false, rest };
}

/**
 * Parse one method or constructor declaration.
 *
 * @param {string} declText the declaration's text as jdtls' range gives it: Javadoc,
 *   comments and annotations may come first; it ends at the body's closing `}` or the `;`
 * @returns {{ sig: JavaSig, headerEnd: number, modifiers: string[], annotations: string[],
 *   typeParameters: string } | null} `headerEnd` is the UTF-16 offset of the body's `{` or
 *   the `;`. `modifiers` in source order; `annotations` are the declaration's annotation
 *   names as written (`Override`, `Deprecated`, `java.lang.Deprecated`); only `@Deprecated`
 *   is meant to be shown, and none is part of `sig`. Null when the text is not a method or
 *   constructor declaration this can read.
 */
function parseJavaDeclaration(declText) {
  if (typeof declText !== 'string') return null;
  const scanned = scanHeader(declText);
  if (!scanned) return null;
  const { tokens, headerEnd } = scanned;
  /** @type {string[]} */
  const modifiers = [];
  /** @type {string[]} */
  const annotations = [];
  let k = 0;
  /** @type {Token[]} */
  let typeParamToks = [];
  for (;;) {
    const t = tokens[k];
    if (!t) return null;
    if (t.kind === 'anno') { annotations.push(t.text); k++; continue; }
    if (t.kind === 'ident' && MODIFIERS.has(t.text)) { modifiers.push(t.text); k++; continue; }
    if (t.text === '<' && typeParamToks.length === 0) {
      const end = skipAngles(tokens, k);
      if (end < 0) return null;
      typeParamToks = tokens.slice(k, end);
      k = end;
      continue;
    }
    break;
  }
  const typeParameters = renderType(typeParamToks);
  /** @type {string | null} */
  let returns = null;
  let name;
  let compact = false;
  if (tokens[k] && tokens[k].kind === 'ident' && (!tokens[k + 1] || tokens[k + 1].text === '(')) {
    // A constructor (`Name(`) or a compact record constructor (`Name` then the body).
    if (NOT_A_TYPE.has(tokens[k].text) || PRIMITIVES.has(tokens[k].text)) return null;
    name = tokens[k].text;
    compact = !tokens[k + 1];
    if (compact && (declText[headerEnd] !== '{' || typeParamToks.length > 0)) return null;
    k++;
  } else {
    const typeEnd = readType(tokens, k);
    if (typeEnd < 0) return null;
    returns = renderType(tokens.slice(k, typeEnd));
    k = typeEnd;
    if (!tokens[k] || tokens[k].kind !== 'ident' || NOT_A_TYPE.has(tokens[k].text) || PRIMITIVES.has(tokens[k].text)) return null;
    name = tokens[k].text;
    k++;
    if (!tokens[k] || tokens[k].text !== '(') return null;
  }
  /** @type {JavaParam[]} */
  const params = [];
  if (!compact) {
    let d = 0;
    let close = -1;
    for (let m = k; m < tokens.length; m++) {
      if (tokens[m].text === '(') d++;
      else if (tokens[m].text === ')' && --d === 0) { close = m; break; }
    }
    if (close < 0) return null;
    const entries = splitTop(tokens.slice(k + 1, close));
    if (!entries) return null;
    for (const e of entries) {
      const p = readParam(e);
      if (p === undefined) return null;
      if (p) params.push(p);
    }
    k = close + 1;
    // Old-style array dims on the method: `int m()[]`.
    const dimsEnd = readDims(tokens, k);
    if (dimsEnd > k) {
      if (returns === null) return null;
      returns += tokens.slice(k, dimsEnd).filter((t) => t.kind !== 'anno').map((t) => t.text).join('');
      k = dimsEnd;
    }
  }
  /** @type {string[]} */
  const throws = [];
  if (tokens[k] && tokens[k].text === 'throws') {
    let end = tokens.length;
    const dflt = tokens.findIndex((t, n) => n > k && t.text === 'default');
    if (dflt > 0) end = dflt;
    const entries = splitTop(tokens.slice(k + 1, end));
    if (!entries || entries.length === 0) return null;
    for (const e of entries) {
      if (readType(e, 0) !== e.length) return null;
      throws.push(renderType(e));
    }
    k = end;
  }
  if (tokens[k] && tokens[k].text === 'default') {
    if (declText[headerEnd] !== ';') return null;
    k = tokens.length;
  }
  if (k !== tokens.length) return null;
  return {
    sig: { async: false, name, params, returns, typeParameters, throws, compact },
    headerEnd, modifiers, annotations, typeParameters,
  };
}

/**
 * The exception types of `throw new X(…)` statements in the method's own body: lambda
 * bodies, anonymous class bodies and local classes (records, enums, interfaces) inside it
 * are not its own code and are skipped (J-D5, as Python's P-D6). A switch rule's
 * `case … -> { … }` block is the method's own code. Types are as written (`IOException`,
 * `java.io.IOException`), type arguments dropped. `throw e;` and other non-`new` throws are
 * not read. A body that cannot be lexed yields what was read up to that point.
 * @param {string} declText @param {number} headerEnd as `parseJavaDeclaration` returned it
 * @returns {Set<string>}
 */
function thrownOf(declText, headerEnd) {
  /** @type {Set<string>} */
  const out = new Set();
  if (typeof declText !== 'string' || declText[headerEnd] !== '{') return out;
  /** @type {Token[]} */
  const toks = [];
  lex(declText, headerEnd, (t) => { toks.push(t); });
  /** @type {number[]} index of each open `(` */
  const parens = [];
  /** @type {boolean[]} whether each open `{` starts code that is not the method's own */
  const braces = [];
  let skipped = 0;
  /** Index of the token just before `k` at which the current statement or expression starts. @param {number} k */
  const boundary = (k) => {
    let m = k - 1;
    while (m >= 0 && !['{', '}', ';', '(', '='].includes(toks[m].text)) m--;
    return m;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === 'punct' && t.text === '(') parens.push(k);
    else if (t.kind === 'punct' && t.text === ')') parens.pop();
    else if (t.kind === 'punct' && t.text === '{') {
      let foreign = false;
      if (k > 0) {
        const prev = toks[k - 1];
        if (prev.text === '->') {
          // A lambda body, unless the arrow ends a switch rule's label.
          const from = boundary(k - 1);
          const label = toks.slice(from + 1, k - 1).some((x) => x.text === 'case' || x.text === 'default');
          foreign = !label;
        } else if (prev.text === ')') {
          // `new T(…) {`: an anonymous class body.
          let d = 0;
          let m = k - 1;
          for (; m >= 0; m--) {
            if (toks[m].text === ')') d++;
            else if (toks[m].text === '(' && --d === 0) break;
          }
          const open = m;
          m--;
          while (m >= 0 && (toks[m].kind === 'ident' || ['.', '<', '>', ',', '?', '[', ']', '@'].includes(toks[m].text)) && toks[m].text !== 'new') m--;
          foreign = m >= 0 && toks[m].text === 'new';
          // A local record: `record Name(…) {`.
          if (!foreign) {
            const from = boundary(Math.max(open, 0));
            const stmt = toks.slice(from + 1, open);
            foreign = stmt.some((x, n) => x.text === 'record' && stmt[n + 1] && stmt[n + 1].kind === 'ident' && (n === 0 || stmt[n - 1].text !== '.'));
          }
        } else {
          // A local class, interface or enum: `class Name … {`.
          const from = boundary(k);
          const stmt = toks.slice(from + 1, k);
          foreign = stmt.some((x, n) => (x.text === 'class' || x.text === 'interface' || x.text === 'enum') && (n === 0 || stmt[n - 1].text !== '.'));
        }
      }
      braces.push(foreign);
      if (foreign) skipped++;
    } else if (t.kind === 'punct' && t.text === '}') {
      if (braces.pop()) skipped--;
    } else if (skipped === 0 && t.kind === 'ident' && t.text === 'throw' && toks[k + 1] && toks[k + 1].text === 'new') {
      let m = k + 2;
      while (toks[m] && toks[m].kind === 'anno') m++;
      let name = '';
      while (toks[m] && toks[m].kind === 'ident') {
        name += toks[m].text;
        if (toks[m + 1] && toks[m + 1].text === '.' && toks[m + 2] && toks[m + 2].kind === 'ident') { name += '.'; m += 2; } else break;
      }
      // Only when the thrown expression is the `new` itself: in `throw new X(e).withCause(c);`
      // the type thrown is the method's result, which text cannot tell.
      m++;
      if (toks[m] && toks[m].text === '<') m = skipAngles(toks, m);
      if (name && m > 0 && toks[m] && toks[m].text === '(') {
        let d = 0;
        for (; m < toks.length; m++) {
          if (toks[m].text === '(') d++;
          else if (toks[m].text === ')' && --d === 0) break;
        }
        const after = toks[m + 1];
        if (after && (after.text === ';' || after.text === '{')) out.add(name);
      }
    }
  }
  return out;
}

/** Whitespace collapsed and comments removed, for comparing headers the parser could not read. @param {string | undefined} h */
const normaliseHeader = (h) => String(h || '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The access a symbol's modifiers give it: `public`, `protected`, `private`, else `package`
 * (or `public` for an interface member, when the symbol says `inInterface`).
 * @param {{ modifiers?: string[], inInterface?: boolean }} sym @returns {keyof typeof ACCESS_RANK}
 */
function accessOf(sym) {
  const mods = sym.modifiers || [];
  for (const a of /** @type {const} */ (['public', 'protected', 'private'])) if (mods.includes(a)) return a;
  return sym.inInterface ? 'public' : 'package';
}

/**
 * The change kinds of a Java method or constructor between its base and head versions.
 * Symbols carry `sig` (null when the header could not be read), `header` (the header's
 * text) and `modifiers`; `inInterface` is optional.
 * - Both sigs: `diffSignature` (parameters by name, types as written, varargs `T...` versus
 *   `T[]` a type change), plus `type-changed` for changed type parameters and `new-throw`
 *   for a type added to `throws` (removing one breaks no caller that compiles).
 * - Either sig null: the normalised header texts are compared and a difference is
 *   `type-changed`, as `goKindsOf` does.
 * - `access-changed` (J-D4): visibility reduced (public → protected → package → private)
 *   or `static` added or removed. Widening breaks no caller, so it is no kind (TypeScript has
 *   no access kind at all; a widened method's callers still compile).
 * Not here: `final` added to a method that is overridden needs the overriding methods,
 * which only the callers' index has (J4). `throw new` in the body is compared by the
 * engine from each symbol's `throws` set (`thrownOf`), not by this.
 * @param {{ sig: JavaSig | null, header?: string, modifiers?: string[], inInterface?: boolean } | null | undefined} base
 * @param {{ sig: JavaSig | null, header?: string, modifiers?: string[], inInterface?: boolean }} head
 * @returns {object[]}
 */
function javaKindsOf(base, head) {
  const { diffSignature, KIND } = require('../../engine/signature');
  if (!base) return [];
  /** @type {object[]} */
  const kinds = [];
  const add = (/** @type {object} */ k) => { if (!kinds.includes(k)) kinds.push(k); };
  if (base.sig && head.sig) {
    for (const k of diffSignature(base, head)) add(k);
    if (base.sig.typeParameters !== head.sig.typeParameters) add(KIND.TYPE_CHANGED);
    const old = new Set(base.sig.throws);
    if (head.sig.throws.some((t) => !old.has(t))) add(KIND.NEW_THROW);
  } else if (normaliseHeader(base.header) !== normaliseHeader(head.header)) {
    add(KIND.TYPE_CHANGED);
  }
  if (base.modifiers && head.modifiers) {
    const reduced = ACCESS_RANK[accessOf(head)] < ACCESS_RANK[accessOf(base)];
    const staticChanged = base.modifiers.includes('static') !== head.modifiers.includes('static');
    if (reduced || staticChanged) add(KIND.ACCESS_CHANGED);
  }
  return kinds;
}

/**
 * A readable, stable one-line rendering of a parsed signature:
 * `<T> (Class<T> type, String... names): T throws IOException`. A constructor has no `: T`.
 * @param {JavaSig} sig @returns {string}
 */
function renderJavaSig(sig) {
  const parts = [];
  if (sig.typeParameters) parts.push(`${sig.typeParameters} `);
  parts.push(sig.compact ? '(record components)' : `(${sig.params.map((p) => `${p.type} ${p.name}`).join(', ')})`);
  if (sig.returns !== null) parts.push(`: ${sig.returns}`);
  if (sig.throws.length > 0) parts.push(` throws ${sig.throws.join(', ')}`);
  return parts.join('');
}

module.exports = { parseJavaDeclaration, thrownOf, javaKindsOf, renderJavaSig };
