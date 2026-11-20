// @ts-check
'use strict';
// C# signatures (Part C, C2): a member's header parsed into the `sig` object the shared
// `diffSignature` compares, the parts of its C-D6 key (`csharpKeyParams`), the `throw new`
// types of its body (`thrownOf`), the change kinds of a header (`csharpKindsOf`, C-D6) and a
// short display (`renderCsharpSig`). Pure text in, plain data out; nothing here touches the
// editor or the file system.
//
// Parsing is a documented, explicit result: text this cannot read yields `null` (never a
// throw, never a guessed signature), and the caller reports the symbol as having no comparable
// signature rather than as unchanged.
//
// Text as written: `params[].type`, `params[].default`, `returns` and `attributes` are the
// source text of the type, default value, return type and attribute list (trivia inside kept),
// as Roslyn's `ToString()` gives them; the `sig` holds the same with whitespace and comments
// normalised, so a reformatted header is not a change.
//
// Limits (documented, not handled):
// - The parser cannot see the enclosing type: a member without an access modifier is read as
//   `private` unless the symbol says `inInterface: true` (interface members are public).
// - Whether `T?` is a nullable value type or an annotated reference type needs the semantic
//   model; C-D6's closed list decides (see `csharpKindsOf`).
// - `__arglist` parameters and function-pointer types (`delegate*<…>`) are read loosely: the
//   latter's key text is its source text with whitespace collapsed.

/**
 * @typedef {{ name: string, type: string, optional: boolean, rest: boolean, default: string | null }} CsharpSigParam
 * @typedef {{
 *   async: boolean, name: string, params: CsharpSigParam[], returns: string | null,
 *   typeParameters: string, constraints: string,
 * }} CsharpSig
 * @typedef {{ name: string, type: string, keyType: string, modifiers: string[], default: string | null, attributes: string[] }} CsharpParam
 * @typedef {'method' | 'constructor' | 'static-constructor' | 'operator' | 'conversion' | 'property' | 'indexer'} MemberKind
 * @typedef {{
 *   kind: MemberKind, name: string, explicitInterface: string | null, sig: CsharpSig,
 *   params: CsharpParam[], returns: string | null, modifiers: string[], attributes: string[],
 *   typeParameters: string[], headerStart: number, headerEnd: number,
 *   body: 'block' | 'expression' | 'accessors' | 'none', header: string,
 * }} CsharpDeclaration
 * @typedef {import('./lexer').Token} Token
 */

const { lex } = require('./lexer');

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'readonly', 'virtual', 'override',
  'abstract', 'sealed', 'extern', 'unsafe', 'new', 'async', 'partial', 'volatile', 'const',
  'required', 'file', 'fixed',
]);
const PARAM_MODIFIERS = new Set(['this', 'ref', 'out', 'in', 'params', 'scoped', 'readonly']);
// Words that cannot start a type or be a member name.
const NOT_A_TYPE = new Set([
  'class', 'struct', 'interface', 'enum', 'record', 'delegate', 'event', 'namespace', 'using',
  'return', 'throw', 'if', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'try', 'catch',
  'finally', 'else', 'operator', 'implicit', 'explicit', 'this', 'base', 'null', 'true',
  'false', 'where', 'new', 'typeof', 'sizeof', 'default', 'checked', 'unchecked', 'is', 'as',
  'in', 'out', 'ref', 'params', 'goto', 'break', 'continue', 'lock', 'fixed', 'stackalloc',
]);
const AWAITABLE = new Set(['Task', 'ValueTask', 'IAsyncEnumerable']);

/**
 * The header's tokens from the start of `text` to the body: the first `{`, `=>` or `;` outside
 * brackets. Directives are dropped. Null on text it cannot lex or with no body start.
 * @param {string} text @returns {{ tokens: Token[], headerEnd: number } | null}
 */
function scanHeader(text) {
  /** @type {Token[]} */
  const tokens = [];
  let depth = 0;
  let headerEnd = -1;
  let bad = false;
  const stop = lex(text, 0, (t) => {
    if (t.kind === 'directive') return true;
    if (t.kind === 'punct') {
      if (depth === 0 && (t.text === '{' || t.text === ';' || t.text === '=>')) { headerEnd = t.start; return false; }
      if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
      else if (t.text === ')' || t.text === ']' || t.text === '}') { if (--depth < 0) { bad = true; return false; } }
    }
    tokens.push(t);
    return true;
  });
  if (stop < 0 || bad || headerEnd < 0) return null;
  return { tokens, headerEnd };
}

/**
 * Index just past the bracket group opened at `k` (`(`, `[` or `<`), or -1.
 * @param {Token[]} toks @param {number} k
 */
function skipGroup(toks, k) {
  const open = toks[k].text;
  const close = open === '(' ? ')' : open === '[' ? ']' : '>';
  let d = 0;
  for (let m = k; m < toks.length; m++) {
    const t = toks[m].text;
    if (t === open) d++;
    else if (t === close && --d === 0) return m + 1;
    else if (open === '<' && (t === ';' || t === '{' || t === '}')) return -1;
  }
  return -1;
}

/**
 * Normalised text of tokens: a space after `,`, between two words and around `=`/`=>`, none
 * elsewhere (`Dictionary<string, List<int[]>>?`, `(int a, string b)`).
 * @param {Token[]} toks @returns {string}
 */
function render(toks) {
  let out = '';
  /** @type {Token | null} */
  let prev = null;
  for (const t of toks) {
    if (prev) {
      const word = t.kind !== 'punct';
      const prevWord = prev.kind !== 'punct';
      if (prev.text === ',' || prev.text === ':' || t.text === ':' || prev.text === '=' || t.text === '=' || t.text === '=>' || prev.text === '=>') out += ' ';
      else if (word && (prevWord || prev.text === ')' || prev.text === ']' || prev.text === '>' || prev.text === '?')) out += ' ';
    }
    out += t.text;
    prev = t;
  }
  return out;
}

/** An identifier's value: the verbatim `@` dropped. @param {string} s */
const valueOf = (s) => (s.startsWith('@') ? s.slice(1) : s);

/**
 * Read a type at `k`. Returns the index just past it and its C-D6 key form (namespaces and
 * alias qualifiers dropped, generic arguments erased, `?`, arrays and pointers kept, tuple
 * element names dropped), or null when no type starts here.
 * @param {Token[]} toks @param {number} k @returns {{ end: number, key: string } | null}
 */
function readType(toks, k) {
  const t = toks[k];
  if (!t) return null;
  let key;
  if (t.text === 'ref' && t.kind === 'ident') {
    let m = k + 1;
    let ro = '';
    if (toks[m] && toks[m].text === 'readonly') { ro = 'readonly '; m++; }
    const inner = readType(toks, m);
    return inner && { end: inner.end, key: `ref ${ro}${inner.key}` };
  }
  if (t.text === '(') {
    // A tuple: `(T1 a, T2 b)`.
    const parts = [];
    let m = k + 1;
    for (;;) {
      const el = readType(toks, m);
      if (!el) return null;
      parts.push(el.key);
      m = el.end;
      if (toks[m] && toks[m].kind === 'ident' && toks[m + 1] && (toks[m + 1].text === ',' || toks[m + 1].text === ')')) m++;
      if (toks[m] && toks[m].text === ',') { m++; continue; }
      if (toks[m] && toks[m].text === ')') { m++; break; }
      return null;
    }
    if (parts.length < 2) return null;
    key = `(${parts.join(', ')})`;
    k = m;
  } else if (t.kind === 'ident' && t.text === 'delegate' && toks[k + 1] && toks[k + 1].text === '*') {
    // A function pointer: `delegate* unmanaged[Cdecl]<int, void>`.
    let m = k + 2;
    while (toks[m] && toks[m].kind === 'ident') m++;
    if (toks[m] && toks[m].text === '[') { m = skipGroup(toks, m); if (m < 0) return null; }
    if (!toks[m] || toks[m].text !== '<') return null;
    const end = skipGroup(toks, m);
    if (end < 0) return null;
    key = render(toks.slice(k, end));
    k = end;
  } else {
    if (t.kind !== 'ident' || NOT_A_TYPE.has(t.text) || (MODIFIERS.has(t.text) && t.text !== 'file')) return null;
    let seg = valueOf(t.text);
    k++;
    if (toks[k] && toks[k].text === '::') {
      if (!toks[k + 1] || toks[k + 1].kind !== 'ident') return null;
      seg = valueOf(toks[k + 1].text);
      k += 2;
    }
    for (;;) {
      if (toks[k] && toks[k].text === '<') {
        const end = typeArgsEnd(toks, k);
        if (end < 0) return null;
        k = end;
      }
      if (toks[k] && toks[k].text === '.' && toks[k + 1] && toks[k + 1].kind === 'ident' && !NOT_A_TYPE.has(toks[k + 1].text)) {
        seg = valueOf(toks[k + 1].text);
        k += 2;
        continue;
      }
      break;
    }
    key = seg;
  }
  // Suffixes: `?`, `[]`/`[,]`, `*`.
  for (;;) {
    const s = toks[k];
    if (!s) break;
    if (s.text === '?') { key += '?'; k++; continue; }
    if (s.text === '*') { key += '*'; k++; continue; }
    if (s.text === '[') {
      let m = k + 1;
      let commas = 0;
      while (toks[m] && toks[m].text === ',') { commas++; m++; }
      if (!toks[m] || toks[m].text !== ']') break;
      key += `[${','.repeat(commas)}]`;
      k = m + 1;
      continue;
    }
    break;
  }
  return { end: k, key };
}

/**
 * Past a type argument list `<…>` at `k`: types separated by commas, or an unbound `<,>`.
 * @param {Token[]} toks @param {number} k @returns {number} -1 when it is not one
 */
function typeArgsEnd(toks, k) {
  let m = k + 1;
  if (toks[m] && (toks[m].text === '>' || toks[m].text === ',')) {
    while (toks[m] && toks[m].text === ',') m++;
    return toks[m] && toks[m].text === '>' ? m + 1 : -1;
  }
  for (;;) {
    while (toks[m] && toks[m].text === '[') { m = skipGroup(toks, m); if (m < 0) return -1; } // attributes on type args
    const a = readType(toks, m);
    if (!a) return -1;
    m = a.end;
    if (toks[m] && toks[m].text === ',') { m++; continue; }
    if (toks[m] && toks[m].text === '>') return m + 1;
    return -1;
  }
}

/** Source text from token `a` to token `b - 1`. @param {string} text @param {Token[]} toks @param {number} a @param {number} b */
const slice = (text, toks, a, b) => text.slice(toks[a].start, toks[b - 1].end);

/**
 * Read attribute lists at `k`: `[…]` groups. Returns the index past them and their source
 * texts.
 * @param {string} text @param {Token[]} toks @param {number} k
 * @returns {{ end: number, attributes: string[] } | null}
 */
function readAttributes(text, toks, k) {
  /** @type {string[]} */
  const attributes = [];
  while (toks[k] && toks[k].text === '[') {
    const end = skipGroup(toks, k);
    if (end < 0) return null;
    attributes.push(slice(text, toks, k, end));
    k = end;
  }
  return { end: k, attributes };
}

/**
 * The parameters between `open` (a `(` or `[`) and its closing bracket.
 * @param {string} text @param {Token[]} toks @param {number} open
 * @returns {{ end: number, params: CsharpParam[], sigParams: CsharpSigParam[] } | null}
 */
function readParams(text, toks, open) {
  const close = toks[open].text === '(' ? ')' : ']';
  /** @type {CsharpParam[]} */
  const params = [];
  /** @type {CsharpSigParam[]} */
  const sigParams = [];
  let k = open + 1;
  if (toks[k] && toks[k].text === close) return { end: k + 1, params, sigParams };
  for (;;) {
    const attrs = readAttributes(text, toks, k);
    if (!attrs) return null;
    k = attrs.end;
    /** @type {string[]} */
    const modifiers = [];
    while (toks[k] && toks[k].kind === 'ident' && PARAM_MODIFIERS.has(toks[k].text)) {
      // `scoped` is a modifier only before a type (`scoped ref Span<int> x`, `scoped Span<int> x`).
      if (toks[k].text === 'scoped' && (!toks[k + 1] || toks[k + 1].text === ',' || toks[k + 1].text === close || toks[k + 1].text === '=')) break;
      modifiers.push(toks[k].text);
      k++;
    }
    /** @type {string} */
    let name;
    let type = '';
    let keyType;
    let typeNorm = '';
    if (toks[k] && toks[k].text === '__arglist') {
      name = '__arglist';
      keyType = '__arglist';
      k++;
    } else {
      const ty = readType(toks, k);
      if (!ty) return null;
      type = slice(text, toks, k, ty.end);
      typeNorm = render(toks.slice(k, ty.end));
      keyType = ty.key;
      k = ty.end;
      if (!toks[k] || toks[k].kind !== 'ident') return null;
      name = valueOf(toks[k].text);
      k++;
    }
    /** @type {string | null} */
    let dflt = null;
    /** @type {string | null} */
    let dfltNorm = null;
    if (toks[k] && toks[k].text === '=') {
      const from = k + 1;
      let d = 0;
      let m = from;
      for (; m < toks.length; m++) {
        const x = toks[m].text;
        if (x === '(' || x === '[' || x === '{') d++;
        else if (x === ')' || x === ']' || x === '}') { if (d === 0) break; d--; } else if (x === ',' && d === 0) break;
      }
      if (m === from) return null;
      dflt = slice(text, toks, from, m);
      dfltNorm = render(toks.slice(from, m));
      k = m;
    }
    // `this` first however written (`ref this Span<int> s` → `this ref Span`), as the oracle keys it.
    const kept = modifiers.filter((x) => x !== 'scoped').sort((a, b) => (a === 'this' ? -1 : b === 'this' ? 1 : 0));
    params.push({ name, type, keyType: [...kept, keyType].join(' '), modifiers, default: dflt, attributes: attrs.attributes });
    sigParams.push({
      name,
      type: [...kept, typeNorm].filter(Boolean).join(' '),
      optional: dflt !== null,
      rest: modifiers.includes('params'),
      default: dfltNorm,
    });
    if (toks[k] && toks[k].text === ',') { k++; continue; }
    if (toks[k] && toks[k].text === close) return { end: k + 1, params, sigParams };
    return null;
  }
}

/** Whether a return type is awaitable (C-D6): `Task`, `Task<T>`, `ValueTask`, `ValueTask<T>`, `IAsyncEnumerable<T>`. @param {string | null} returnsKey */
const isAwaitable = (returnsKey) => returnsKey !== null && AWAITABLE.has(returnsKey.replace(/\?$/, ''));

/**
 * Parse one member declaration: a method, constructor, static constructor, operator,
 * conversion, property or indexer.
 *
 * @param {string} declText the member's text as Roslyn's `Span` gives it (attributes in);
 *   comments and an XML doc comment may come first; it ends with the body (or `;`)
 * @returns {CsharpDeclaration | null} `headerStart` is the offset of the first modifier (or
 *   of the type or name when there is none), `headerEnd` that of the body's `{`, `=>` or `;`.
 *   `header` is the text between them with comments dropped and whitespace collapsed. Null
 *   when the text is not a member this can read (a field, an event, a finalizer, a type).
 */
function parseCsharpDeclaration(declText) {
  if (typeof declText !== 'string') return null;
  const scanned = scanHeader(declText);
  if (!scanned) return null;
  const { tokens: toks, headerEnd } = scanned;
  const attrs = readAttributes(declText, toks, 0);
  if (!attrs) return null;
  let k = attrs.end;
  if (!toks[k]) return null;
  const first = k;
  /** @type {string[]} */
  const modifiers = [];
  while (toks[k] && toks[k].kind === 'ident' && MODIFIERS.has(toks[k].text)
    && toks[k + 1] && toks[k + 1].text !== '.' && toks[k + 1].text !== '::') {
    modifiers.push(toks[k].text);
    k++;
  }
  if (!toks[k] || toks[k].text === '~') return null;
  /** @type {MemberKind} */
  let kind;
  let name;
  /** @type {string | null} */
  let explicitInterface = null;
  /** @type {string | null} */
  let returns = null;
  /** @type {string | null} */
  let returnsKey = null;
  /** @type {string | null} */
  let returnsNorm = null;
  /** @type {string[]} */
  let typeParameters = [];
  let typeParamText = '';
  if (toks[k].kind === 'ident' && (toks[k].text === 'implicit' || toks[k].text === 'explicit')) {
    // Conversion: `implicit operator T(…)`.
    const word = toks[k].text;
    k++;
    let iface = '';
    if (toks[k] && toks[k].kind === 'ident' && toks[k].text !== 'operator') {
      const r = readInterfacePrefix(toks, k);
      if (!r) return null;
      iface = r.iface;
      k = r.end;
    }
    if (!toks[k] || toks[k].text !== 'operator') return null;
    k++;
    if (toks[k] && toks[k].text === 'checked') k++;
    const ty = readType(toks, k);
    if (!ty) return null;
    kind = 'conversion';
    returns = slice(declText, toks, k, ty.end);
    returnsNorm = render(toks.slice(k, ty.end));
    returnsKey = ty.key;
    name = `${word} operator ${ty.key}`;
    explicitInterface = iface || null;
    k = ty.end;
  } else if (toks[k].kind === 'ident' && toks[k + 1] && toks[k + 1].text === '(' && !NOT_A_TYPE.has(toks[k].text)) {
    kind = modifiers.includes('static') ? 'static-constructor' : 'constructor';
    name = valueOf(toks[k].text);
    k++;
  } else {
    const ty = readType(toks, k);
    if (!ty) return null;
    returns = slice(declText, toks, k, ty.end);
    returnsNorm = render(toks.slice(k, ty.end));
    returnsKey = ty.key;
    k = ty.end;
    // Explicit interface prefix: `IFoo.`, `IEnumerable<T>.`, `N.IFoo.`.
    const pre = readInterfacePrefix(toks, k);
    if (pre) { explicitInterface = pre.iface; k = pre.end; }
    const t = toks[k];
    if (!t) return null;
    if (t.text === 'operator') {
      k++;
      let op = '';
      if (toks[k] && toks[k].text === 'checked') { op = 'checked '; k++; }
      const from = k;
      while (toks[k] && toks[k].text !== '(') k++;
      if (k === from || !toks[k]) return null;
      op += toks.slice(from, k).map((x) => x.text).join('');
      kind = 'operator';
      name = `operator ${op}`;
    } else if (t.text === 'this') {
      kind = 'indexer';
      name = 'this';
      k++;
      if (!toks[k] || toks[k].text !== '[') return null;
    } else {
      if (t.kind !== 'ident' || NOT_A_TYPE.has(t.text)) return null;
      name = valueOf(t.text);
      k++;
      if (toks[k] && toks[k].text === '<') {
        const end = skipGroup(toks, k);
        if (end < 0) return null;
        typeParamText = render(toks.slice(k, end));
        typeParameters = [];
        for (let m = k + 1; m < end - 1; m++) {
          if (toks[m].kind === 'ident' && (toks[m + 1].text === ',' || toks[m + 1].text === '>') && toks[m].text !== 'in' && toks[m].text !== 'out') typeParameters.push(valueOf(toks[m].text));
        }
        k = end;
      }
      kind = toks[k] && toks[k].text === '(' ? 'method' : 'property';
    }
  }
  /** @type {CsharpParam[]} */
  let params = [];
  /** @type {CsharpSigParam[]} */
  let sigParams = [];
  if (kind !== 'property') {
    if (!toks[k] || (toks[k].text !== '(' && toks[k].text !== '[')) return null;
    const ps = readParams(declText, toks, k);
    if (!ps) return null;
    params = ps.params;
    sigParams = ps.sigParams;
    k = ps.end;
  }
  // A constructor's initializer: `: base(…)` / `: this(…)`.
  if ((kind === 'constructor') && toks[k] && toks[k].text === ':') {
    if (!toks[k + 1] || (toks[k + 1].text !== 'base' && toks[k + 1].text !== 'this') || !toks[k + 2] || toks[k + 2].text !== '(') return null;
    const end = skipGroup(toks, k + 2);
    if (end < 0) return null;
    k = end;
  }
  // Type parameter constraints: `where T : class, new()`.
  const constraintsFrom = k;
  if (kind === 'method') {
    while (toks[k] && toks[k].text === 'where') {
      k++;
      while (toks[k] && toks[k].text !== 'where') {
        if (toks[k].text === '(') { const end = skipGroup(toks, k); if (end < 0) return null; k = end; } else k++;
      }
    }
  }
  if (k !== toks.length) return null;
  // A property has an accessor list or `=>`; `int _x;` (a field without an initializer) ends
  // at `;` and is not a member (C-D4), so null as for any field.
  if (kind === 'property' && declText[headerEnd] === ';') return null;
  const constraints = render(toks.slice(constraintsFrom, k));
  let body = /** @type {CsharpDeclaration['body']} */ ('none');
  if (declText.startsWith('=>', headerEnd)) body = 'expression';
  else if (declText[headerEnd] === '{') body = kind === 'property' || kind === 'indexer' ? accessorsBody(declText, headerEnd) : 'block';
  return {
    kind, name, explicitInterface,
    sig: {
      async: isAwaitable(returnsKey), name, params: sigParams, returns: returnsNorm,
      typeParameters: typeParamText, constraints,
    },
    params, returns, modifiers, attributes: attrs.attributes, typeParameters,
    headerStart: toks[first].start, headerEnd, body,
    header: joinTokens(declText, toks.slice(first)),
  };
}

/**
 * An explicit interface prefix at `k` (`IFoo.`, `N.IFoo.`, `IEnumerable<T>.`, `global::N.I.`):
 * the interface's last segment with its arity (`IEnumerable<1>`), as the oracle keys it. Null
 * when the tokens at `k` are a plain member name.
 * @param {Token[]} toks @param {number} k @returns {{ end: number, iface: string } | null}
 */
function readInterfacePrefix(toks, k) {
  let m = k;
  let iface = '';
  let found = false;
  for (;;) {
    if (!toks[m] || toks[m].kind !== 'ident' || NOT_A_TYPE.has(toks[m].text)) break;
    let seg = valueOf(toks[m].text);
    let n = m + 1;
    if (toks[n] && toks[n].text === '::') {
      if (!toks[n + 1] || toks[n + 1].kind !== 'ident') break;
      seg = valueOf(toks[n + 1].text);
      n += 2;
    }
    if (toks[n] && toks[n].text === '<') {
      const end = typeArgsEnd(toks, n);
      if (end < 0) break;
      let count = 1;
      let d = 0;
      for (let x = n + 1; x < end - 1; x++) {
        const tx = toks[x].text;
        if (tx === '<' || tx === '(' || tx === '[') d++;
        else if (tx === '>' || tx === ')' || tx === ']') d--;
        else if (tx === ',' && d === 0) count++;
      }
      seg += `<${count}>`;
      n = end;
    }
    if (!toks[n] || toks[n].text !== '.') break;
    iface = seg;
    found = true;
    m = n + 1;
  }
  return found ? { end: m, iface } : null;
}

/** `accessors` when an accessor at `open` has a body, else `none`. @param {string} text @param {number} open */
function accessorsBody(text, open) {
  let depth = 0;
  let bodied = false;
  lex(text, open, (t) => {
    if (t.kind !== 'punct') return true;
    if (t.text === '{') { depth++; if (depth === 2) bodied = true; } else if (t.text === '}') { if (--depth === 0) return false; } else if (t.text === '=>' && depth === 1) bodied = true;
    return true;
  });
  return bodied ? 'accessors' : 'none';
}

/**
 * Parse a primary constructor's parameter list (`(int x, string y = "")`, as the oracle's span
 * of a `primary-constructor` gives it).
 * @param {string} text @returns {{ params: CsharpParam[], sig: CsharpSig } | null}
 */
function parseCsharpParameterList(text) {
  /** @type {Token[]} */
  const toks = [];
  if (lex(text, 0, (t) => { if (t.kind !== 'directive') toks.push(t); }) < 0) return null;
  if (!toks[0] || toks[0].text !== '(') return null;
  const ps = readParams(text, toks, 0);
  if (!ps || ps.end !== toks.length) return null;
  return { params: ps.params, sig: { async: false, name: '', params: ps.sigParams, returns: null, typeParameters: '', constraints: '' } };
}

/**
 * C-D6's parameter-type list of a key: each parameter's `keyType` joined with `, `
 * (`ref int, List?, (int, string)`), as the oracle writes between the key's brackets.
 * @param {Array<{ keyType: string }>} params @returns {string}
 */
const csharpKeyParams = (params) => params.map((p) => p.keyType).join(', ');

/**
 * C# 14 extension blocks (owner decision after the C0–C2 review): an instance member of
 * `extension(Foo f) { … }` is keyed as the classic extension method, the receiver first as a
 * `this` parameter, so `extension(Foo f) { int M(int x) }` and `static int M(this Foo f, int x)`
 * share the key `Ext.M(this Foo, int)`. This returns that bracket text from the block's
 * parameter list as written (`(Foo f)`, `(ref Foo f)`, `(List<T> l)`, unnamed `(Foo)`) and the
 * member's parameters (as `parseCsharpDeclaration` gives them). Null when the receiver cannot
 * be read. The rest of the key, as the syntax oracle builds it:
 * - methods: `Type.Name<arity>(…)`, arity = the block's type parameters + the method's own
 *   (`extension<T>(List<T> l) { void M<U>() }` → `Ext.M<2>(this List)`);
 * - properties: `Type.Name(this Foo)` (this helper with no parameters);
 * - static members and operators of a block have no receiver: key them as usual.
 * @param {string} receiverList @param {Array<{ keyType: string }>} params @returns {string | null}
 */
function csharpExtensionKeyParams(receiverList, params) {
  let parsed = parseCsharpParameterList(receiverList);
  // An unnamed receiver (`extension(Foo)`, for static members) reads with a placeholder name.
  if (!parsed) parsed = parseCsharpParameterList(String(receiverList).replace(/\)\s*$/, ' __receiver)'));
  if (!parsed || parsed.params.length !== 1) return null;
  return [`this ${parsed.params[0].keyType}`, ...params.map((p) => p.keyType)].join(', ');
}

/**
 * The exception types of `throw new X(…)` (statements and `throw` expressions) in the
 * member's body after `headerEnd`. Lambdas and local functions are the method's own code
 * (P-D5), so their throws count. Types as written (`ArgumentException`,
 * `System.IO.IOException`), type arguments dropped. `throw;`, `throw e;` and
 * `ArgumentNullException.ThrowIfNull(x)`-style guards are not read. A body that cannot be
 * lexed yields what was read up to that point.
 * @param {string} declText @param {number} headerEnd as `parseCsharpDeclaration` returned it
 * @returns {Set<string>}
 */
function thrownOf(declText, headerEnd) {
  /** @type {Set<string>} */
  const out = new Set();
  if (typeof declText !== 'string' || headerEnd < 0 || headerEnd >= declText.length) return out;
  /** @type {Token[]} */
  const toks = [];
  lex(declText, headerEnd, (t) => { if (t.kind !== 'directive') toks.push(t); });
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].kind !== 'ident' || toks[k].text !== 'throw' || !toks[k + 1] || toks[k + 1].text !== 'new') continue;
    let m = k + 2;
    let name = '';
    if (toks[m] && toks[m].kind === 'ident' && toks[m + 1] && toks[m + 1].text === '::') m += 2;
    while (toks[m] && toks[m].kind === 'ident') {
      name += valueOf(toks[m].text);
      m++;
      if (toks[m] && toks[m].text === '<') { const end = skipGroup(toks, m); if (end < 0) break; m = end; }
      if (toks[m] && toks[m].text === '.' && toks[m + 1] && toks[m + 1].kind === 'ident') { name += '.'; m++; } else break;
    }
    if (!name || !toks[m]) continue;
    if (toks[m].text === '(') {
      const end = skipGroup(toks, m);
      if (end < 0) continue;
      m = end;
    } else if (toks[m].text !== '{') continue;
    if (toks[m] && toks[m].text === '{') {
      // An object initializer.
      let d = 0;
      for (; m < toks.length; m++) {
        if (toks[m].text === '{') d++;
        else if (toks[m].text === '}' && --d === 0) { m++; break; }
      }
    }
    // Only when the thrown expression is the `new` itself, not `new X().With(…)`.
    const after = toks[m];
    if (after && (after.text === '.' || after.text === '?.' || after.text === '[')) continue;
    out.add(name);
  }
  return out;
}

/**
 * Tokens joined by one space wherever the source had whitespace or a comment between them
 * (as the oracle's `header`).
 * @param {string} text @param {Token[]} toks
 */
function joinTokens(text, toks) {
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    if (k > 0 && toks[k].start > toks[k - 1].end) out += ' ';
    out += toks[k].text;
  }
  return out;
}

/** Whitespace collapsed and comments removed. @param {string | undefined} h */
const normaliseHeader = (h) => String(h || '').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

// C-D6's access lattice as who may call: bits for derived types in the assembly, derived types
// outside it, other types in the assembly, everyone else. A change whose new set misses a bit
// of the old one breaks a caller.
const D_IN = 1;
const D_OUT = 2;
const ASM = 4;
const WORLD = 8;

/**
 * Who may call a member with these modifiers (C-D6 defaults: members `private`, interface
 * members and explicit implementations `public`).
 * @param {{ modifiers?: string[], inInterface?: boolean, explicitInterface?: string | null }} sym
 */
function accessBits(sym) {
  const m = sym.modifiers || [];
  if (m.includes('public')) return D_IN | D_OUT | ASM | WORLD;
  const prot = m.includes('protected');
  const int = m.includes('internal');
  const priv = m.includes('private');
  if (prot && int) return D_IN | D_OUT | ASM;
  if (priv && prot) return D_IN;
  if (prot) return D_IN | D_OUT;
  if (int) return D_IN | ASM;
  if (priv) return 0;
  return sym.inInterface || sym.explicitInterface ? D_IN | D_OUT | ASM | WORLD : 0;
}

/**
 * A type with C-D6's closed list of reference types un-annotated: `?` after `string`,
 * `object`, `dynamic` or an array's `]` dropped, so a nullable annotation there is no change.
 * @param {string | null} type
 */
const unannotated = (type) => (type === null ? null : type.replace(/\b(string|object|dynamic)\s*\?/g, '$1').replace(/\]\s*\?/g, ']'));

/**
 * The change kinds of a C# member between its base and head versions (C-D6). Symbols carry
 * `sig` (null when the header could not be read), `header` (the header's text), `modifiers`,
 * and optionally `inInterface` and `explicitInterface`.
 * - Both sigs: `diffSignature` (parameters by name; a parameter's type includes its
 *   `ref`/`out`/`in`/`params`/`this` modifier, so changing one is `type-changed`; a changed
 *   default is `default-changed`), types compared with a `?` dropped only on `string`, `object`,
 *   `dynamic` and arrays; plus `type-changed` for changed type parameters or constraints.
 *   `async-changed` follows the return type (awaitable or not), never the `async` keyword.
 * - Either sig null: the normalised header texts are compared and a difference is
 *   `type-changed`.
 * - `access-changed` when the new access is not a superset of the old (C-D6's lattice) or
 *   `static` is added or removed. `virtual` removed, `sealed` added and attribute changes have
 *   no kind (they show in the header diff).
 * `throw new` in the body is compared by the engine from each symbol's `throws` set
 * (`thrownOf`), not by this.
 * @param {{ sig: CsharpSig | null, header?: string, modifiers?: string[], inInterface?: boolean, explicitInterface?: string | null } | null | undefined} base
 * @param {{ sig: CsharpSig | null, header?: string, modifiers?: string[], inInterface?: boolean, explicitInterface?: string | null }} head
 * @returns {object[]}
 */
function csharpKindsOf(base, head) {
  const { diffSignature, KIND } = require('../../engine/signature');
  if (!base) return [];
  /** @type {object[]} */
  const kinds = [];
  const add = (/** @type {object} */ k) => { if (!kinds.includes(k)) kinds.push(k); };
  if (base.sig && head.sig) {
    const loose = (/** @type {CsharpSig} */ s) => ({
      sig: { ...s, returns: unannotated(s.returns), params: s.params.map((p) => ({ ...p, type: /** @type {string} */ (unannotated(p.type)) })) },
    });
    for (const k of diffSignature(loose(base.sig), loose(head.sig))) add(k);
    if (base.sig.typeParameters !== head.sig.typeParameters || base.sig.constraints !== head.sig.constraints) add(KIND.TYPE_CHANGED);
  } else if (normaliseHeader(base.header) !== normaliseHeader(head.header)) {
    add(KIND.TYPE_CHANGED);
  }
  if (base.modifiers && head.modifiers) {
    const lost = accessBits(base) & ~accessBits(head);
    const staticChanged = base.modifiers.includes('static') !== head.modifiers.includes('static');
    if (lost || staticChanged) add(KIND.ACCESS_CHANGED);
  }
  return kinds;
}

/**
 * A readable one-line rendering of a parsed signature:
 * `<T> (ref int a, string? b = null): Task<T> where T : class`. A constructor has no `: T`.
 * @param {CsharpSig} sig @returns {string}
 */
function renderCsharpSig(sig) {
  const parts = [];
  if (sig.typeParameters) parts.push(`${sig.typeParameters} `);
  parts.push(`(${sig.params.map((p) => `${p.type ? `${p.type} ` : ''}${p.name}${p.default !== null ? ` = ${p.default}` : ''}`).join(', ')})`);
  if (sig.returns !== null) parts.push(`: ${sig.returns}`);
  if (sig.constraints) parts.push(` ${sig.constraints}`);
  return parts.join('');
}

module.exports = {
  parseCsharpDeclaration, parseCsharpParameterList, csharpKeyParams, csharpExtensionKeyParams, thrownOf,
  csharpKindsOf, renderCsharpSig, normaliseHeader,
};
