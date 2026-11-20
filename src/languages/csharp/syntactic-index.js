// @ts-check
'use strict';
// C# callers without a language server (Part C, C8a): an index of a set of C# files, read from
// their text alone, implementing S1's `SyntacticIndex` contract (src/languages/types.js) for
// `createSyntacticResolver` (src/engine/resolver-syntactic.js). Shaped as Java's J8 index
// (../java/syntactic-index.js).
//
// Declarations: C3's outline (`csharpOutline`) keyed by `collectCsharpSymbols` exactly as the
// changed rows are (C-D6 keys), so a caller row expands in the tree; top-level statements are
// the outline's module symbol (its key the file's basename, its position the first
// statement's). Types with their base lists as written, type parameters, `partial` parts
// merged (one type per namespace, name and arity), `file` types visible in their file only;
// fields, properties (auto or not) and primary-constructor parameters with their types.
//
// Names. A file's namespaces are its `namespace` declarations (block and file-scoped). A simple
// type name resolves, in order: the enclosing types, their nested types and their bases'
// nested types; the `file` types of the file; the enclosing namespaces, innermost first; `using`
// aliases (the file's, then `global using` ones); `using` namespaces (the file's, `global
// using`, and the SDK's implicit usings when a project enables them). Two indexed types found
// through `using` namespaces for one name is an ambiguity: not typed. A name that resolves to
// none of the indexed types is an outside type (the BCL, a package): its calls are not calls to
// an indexed declaration. `using static T` binds T's methods to bare calls.
//
// A call resolves only where the receiver's type is written:
//   - `M(` bare: the innermost enclosing type whose hierarchy has a method `M`, then `using
//     static` types; a local function or a delegate-typed local, parameter or field is not a
//     call of a member;
//   - `x.M(` / `x?.M(` / `x!.M(`: x a local (`T x`, `var x = new T(…)`, `var x = (T)e`,
//     `var x = e as T`, `is T x`, `out T x`, `catch (T x)`, `foreach (T x in`), a parameter, a
//     field, property or primary-constructor parameter (of the enclosing types and their bases),
//     `this`, `a.b` through member types, `a.GetB().M(` through the declared return type, a
//     cast `((T)e).M(`, `(e as T).M(`, `new T(…).M(`;
//   - `T.M(` static; `base.M(` from the bases up; `new T(…)`, `new T { … }`, target-typed
//     `new(…)` (where the type is written on the left: `T x = new(`, a field or property
//     initializer, `return new(` in a method of a declared return type), `: base(…)`,
//     `: this(…)` and a primary constructor's base call `: B(…)` reach constructors.
//   Methods are looked up through the base lists within the index (a class's own methods
//   before its bases'; nearest declaration of a parameter list wins). Overloads are matched by
//   argument count within each method's range (optional parameters, `params`); several that
//   match are each listed and the answer says so.
// A call whose receiver's type is not known (an untyped lambda parameter, `var x = F()`,
// `dynamic`, a type parameter, a member of an outside base, a call named as an indexed extension
// method on a receiver that has no such method) is an unresolved call to its name
// (`unresolvedCallsTo`). An indexed method's name used anywhere without `(` (and not as the left
// side of a member access) is a method group (a value use). A type name a member inherited from
// an outside base may hide is not a receiver, and a type written as a receiver reaches static
// methods only. A name used under an inactive `#if` branch or in a file that was not indexed
// counts as an unresolved call to that name.
//
// Completeness (the CLI's whole-repository index can answer complete; the preview never does):
// a method answers incomplete when it is virtual, abstract or an override, a member of an
// interface, implements a member of an interface or a base in the index (by name and parameter
// count for interfaces, also those of indexed derived types; C8b lists those callers), belongs
// to a type with a base the index does not declare and is public and not static (C-D5: "may be
// called through `IBar`, which is not in the indexed files"; also a derived type's outside
// base), is an extension method, is used as a method group, is generated or partial, sits in a
// project with Razor/XAML files, or a C# file could not be read; properties, indexers and
// operators are "not computed" (C8b).
//
// Pure: reads only the `{ path, text }` pairs it is given. Budgets (CODING_STYLE §2):
// - files: bounded by its input (the CLI: `pickRepositoryFiles`, 3000 files / 64 MiB).
// - bytes per file: `MAX_FILE_BYTES` (1 MiB). A longer or unreadable text is not indexed,
//   counted in `skipped`, and the scope note says so.
// - receiver chains: `MAX_CHAIN_DEPTH` (32); type hierarchy walks: `MAX_HIERARCHY` (64).
// Caches (owner: the index, lifetime: the index's, which never changes; no invalidation):
// per-file tokens and bracket matches, per-use resolutions, per-definition locals, per-type
// hierarchies, unresolved counts by name.

const path = require('path');
const { lex, opensAttribute } = require('./lexer');
const { csharpOutline, activeText } = require('./outline');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CHAIN_DEPTH = 32;
const MAX_HIERARCHY = 64;

// The SDK's implicit usings (`<ImplicitUsings>enable</ImplicitUsings>`): Microsoft.NET.Sdk's,
// plus Microsoft.NET.Sdk.Web's.
const IMPLICIT_USINGS = ['System', 'System.Collections.Generic', 'System.IO', 'System.Linq', 'System.Net.Http', 'System.Threading', 'System.Threading.Tasks'];
const WEB_IMPLICIT_USINGS = [...IMPLICIT_USINGS, 'System.Net.Http.Json', 'Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Hosting', 'Microsoft.AspNetCore.Http',
  'Microsoft.AspNetCore.Routing', 'Microsoft.Extensions.Configuration', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging'];

const GENERATED_ATTRIBUTES = new Set(['GeneratedRegex', 'LoggerMessage', 'RelayCommand', 'ObservableProperty', 'JsonSerializable', 'LibraryImport', 'GeneratedCode']);
const KEYWORDS = new Set([
  'abstract', 'as', 'base', 'break', 'case', 'catch', 'checked', 'class', 'const', 'continue', 'default', 'delegate', 'do', 'else', 'enum',
  'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'interface', 'internal', 'is',
  'lock', 'namespace', 'new', 'null', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return',
  'sealed', 'sizeof', 'stackalloc', 'static', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'unchecked', 'unsafe', 'using',
  'virtual', 'volatile', 'while', 'await', 'nameof', 'yield', 'when', 'where', 'and', 'or', 'not', 'with', 'var', 'async', 'get', 'set', 'init',
  'global', 'record', 'value', 'select', 'from', 'let', 'orderby', 'group', 'join', 'into', 'on', 'equals', 'by', 'ascending', 'descending',
]);
const PREDEFINED = new Set(['bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short', 'ushort',
  'object', 'string', 'void', 'nint', 'nuint', 'dynamic']);
const NOT_TYPE_START = new Set([...KEYWORDS].filter((k) => k !== 'var' && k !== 'global'));
const MEMBER_MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'readonly', 'virtual', 'override', 'abstract', 'sealed',
  'extern', 'unsafe', 'new', 'async', 'partial', 'volatile', 'const', 'required', 'file', 'fixed', 'ref']);
const STATEMENT_START = new Set(['{', ';', '}', '(', ',', ']']);

/**
 * @typedef {import('./lexer').Token} Token
 * @typedef {{ rel: string, file: string, text: string, toks: Token[], match: Int32Array, spaces: Array<{ name: string, start: number, end: number }>,
 *   usings: string[], aliases: Map<string, string>, statics: string[], fileTypes: Map<string, TypeRec>,
 *   parts: Array<{ start: number, end: number, type: TypeRec }>, defs: DefRec[], byPos: Map<number, DefRec>,
 *   baseCalls: Map<number, { type: TypeRec, open: number }>, ui: boolean, uses: Use[]|null }} FileRec
 * @typedef {{ key: string, simple: string, arity: number, ns: string, path: string[], kind: string, parts: FileRec[], namePos: number,
 *   bases: Array<{ text: string, file: FileRec, at: number }>, typeParams: Set<string>, methods: Map<string, DefRec[]>, ctors: DefRec[],
 *   fields: Map<string, { text: string, file: FileRec, at: number }|null>, outer: TypeRec|null, nested: Map<string, TypeRec>, sealed: boolean,
 *   isStatic: boolean, generated: boolean, hier: { types: TypeRec[], open: boolean, outside: string[] }|null }} TypeRec
 * @typedef {{ name: string, key: string, label: string, namePos: number, start: number, end: number, type: TypeRec|null, file: FileRec,
 *   min: number, max: number, member: string, mods: Set<string>, attributes: string[], returns: string|null,
 *   params: Array<{ name: string, type: string }>, paramKey: string, typeParams: Set<string>, inInterface: boolean, extension: boolean,
 *   explicit: string|null, locals: { vars: Map<string, string|null>, fns: Set<string> }|null }} DefRec
 * @typedef {{ name: string, pos: number, end: number, at: number, kind: 'call'|'new'|'ref', argc: number, open: number, newKind?: string, targs?: number }} Use
 * @typedef {DefRec[]|'unresolved'|null} Hit
 * @typedef {{ t: TypeRec } | { pre: string } | { ext: string } | null} ArgKind
 * @typedef {{ t: 'type', type: TypeRec, static: boolean, shadowable?: boolean } | { t: 'ext', name?: string } | { t: 'unk' } | { t: 'ns', name: string }} Recv
 *   `ext`: an outside type; `name` its simple name (a predefined type's keyword) when written.
 *   `shadowable`: a type name that a member inherited from an outside base may hide.
 */

/** @param {Token[]} toks @returns {Int32Array} */
function matchBrackets(toks) {
  const m = new Int32Array(toks.length).fill(-1);
  /** @type {number[]} */
  const stack = [];
  const pair = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'punct') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') stack.push(i);
    else if (t.text in pair) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (toks[stack[s]].text === pair[/** @type {')'|']'|'}'} */ (t.text)]) { m[i] = stack[s]; m[stack[s]] = i; stack.length = s; break; }
      }
    }
  }
  return m;
}

const isP = (/** @type {Token|undefined} */ t, /** @type {string} */ s) => !!t && t.kind === 'punct' && t.text === s;
const isIdent = (/** @type {Token|undefined} */ t) => !!t && t.kind === 'ident' && !KEYWORDS.has(t.text) && !PREDEFINED.has(t.text);
const bare = (/** @type {string} */ s) => (s.startsWith('@') ? s.slice(1) : s);

/**
 * Type arguments from `toks[i]` (`<`): the index after the closing `>` and the argument count,
 * or null when they do not close over type-like tokens.
 * @param {Token[]} toks @param {number} i @returns {{ end: number, count: number }|null}
 */
function typeArgs(toks, i) {
  let depth = 0;
  let count = 1;
  for (let j = i; j < toks.length && j < i + 80; j++) {
    const a = toks[j];
    if (isP(a, '<')) depth++;
    else if (isP(a, '>')) { if (--depth === 0) return { end: j + 1, count }; }
    else if (isP(a, ',')) { if (depth === 1) count++; }
    else if (!(a.kind === 'ident' || isP(a, '.') || isP(a, '?') || isP(a, '[') || isP(a, ']') || isP(a, '(') || isP(a, ')') || isP(a, '::'))) return null;
  }
  return null;
}

/**
 * A type as written from `toks[i]`: `global::A.B.C<X, Y>?[]`. `base` is the dotted name with
 * each segment's arity (`A.C`1`), `text` the same with `[]` when an array.
 * @param {Token[]} toks @param {number} i
 * @returns {{ base: string, end: number, array: boolean, nullable: boolean, text: string }|null}
 */
function readType(toks, i) {
  let j = i;
  if (toks[j] && toks[j].text === 'global' && isP(toks[j + 1], '::')) j += 2;
  const t = toks[j];
  if (!t || t.kind !== 'ident' || (NOT_TYPE_START.has(t.text) && !PREDEFINED.has(t.text))) return null;
  /** @type {string[]} */
  const segs = [];
  for (;;) {
    const name = bare(toks[j].text);
    j++;
    let arity = 0;
    if (isP(toks[j], '<')) {
      const ta = typeArgs(toks, j);
      if (!ta) return null;
      arity = ta.count;
      j = ta.end;
    }
    segs.push(arity ? `${name}\`${arity}` : name);
    if ((isP(toks[j], '.') || isP(toks[j], '::')) && toks[j + 1] && toks[j + 1].kind === 'ident' && !NOT_TYPE_START.has(toks[j + 1].text)) { j++; continue; }
    break;
  }
  let nullable = false;
  let array = false;
  for (;;) {
    if (isP(toks[j], '?') && !(toks[j + 1] && (toks[j + 1].kind === 'lit' || isP(toks[j + 1], '(')))) { nullable = true; j++; continue; }
    if (isP(toks[j], '[')) {
      let k = j + 1;
      while (isP(toks[k], ',')) k++;
      if (isP(toks[k], ']')) { array = true; j = k + 1; continue; }
    }
    break;
  }
  const base = segs.join('.');
  return { base, end: j, array, nullable, text: base + (array ? '[]' : '') };
}

/**
 * Whether `toks[from..to)` is only a chain of names, member accesses and calls (`a.B(x).C()`,
 * `T.M()`, `new T().M()`): no operator at its own level.
 * @param {Token[]} toks @param {Int32Array} match @param {number} from @param {number} to
 */
function chainOnly(toks, match, from, to) {
  for (let k = from; k < to; k++) {
    const x = toks[k];
    if (isP(x, '(') && match[k] > k) { k = match[k]; continue; }
    if (isP(x, '<')) { const ta = typeArgs(toks, k); if (ta && ta.end <= to) { k = ta.end - 1; continue; } return false; }
    if (x.kind === 'ident' ? KEYWORDS.has(x.text) && x.text !== 'this' && x.text !== 'base' && x.text !== 'new' : !(isP(x, '.') || isP(x, '?.') || isP(x, '!'))) return false;
  }
  return true;
}

/** Whether `t`, after an expression, ends a local's initializer: `;`, or `,`/`)` of a list. @param {Token|undefined} t */
const endsInitializer = (t) => isP(t, ';') || isP(t, ',') || isP(t, ')');

/** `Foo<1>` → `Foo`1`. @param {string} name */
const segOf = (name) => name.replace(/<(\d+)>$/, '`$1');

/**
 * The index of a set of C# files.
 * @param {Array<{ path: string, text: string }>} sources Repository-relative paths.
 * @param {{ root?: string, scope?: string, notIndexed?: number, partial?: boolean, implicitUsings?: string[],
 *   uiDirs?: string[] }} [options]
 *   `root`: the repository's directory (answers name absolute files); `scope`: what was indexed,
 *   for the scope note; `notIndexed`: files left out by the caller's bound; `partial`: the
 *   preview (the files outside the pull request are not read, so no answer is complete);
 *   `implicitUsings`: namespaces every file imports (the SDK's implicit usings);
 *   `uiDirs`: project directories with `.razor`/`.cshtml`/`.xaml` files.
 */
function createCsharpSyntacticIndex(sources, { root = '', scope = 'the indexed files', notIndexed = 0, partial = false, implicitUsings = [], uiDirs = [] } = {}) {
  const { collectCsharpSymbols } = require('./provider');
  /** @type {Map<string, FileRec>} */
  const byFile = new Map();
  /** @type {Map<string, TypeRec>} */
  const typesByKey = new Map();
  /** @type {Set<string>} Every declared namespace and its prefixes. */
  const namespaces = new Set();
  /** @type {Map<string, Array<{ rec: FileRec, use: Use }>>} */
  const usesByName = new Map();
  /** @type {Set<string>} Names of indexed extension methods. */
  const extNames = new Set();
  /** @type {Set<string>} Names of indexed methods: the names a method-group use is recorded for. */
  const methodNames = new Set();
  const globalUsings = new Set(implicitUsings);
  /** @type {Map<string, string>} */
  const globalAliases = new Map();
  /** @type {string[]} */
  const globalStatics = [];
  let skipped = 0;
  // Names written where the index does not read calls (B1, B2): code under an inactive `#if`
  // branch (blanked as Roslyn does with no symbols defined, yet compiled in other
  // configurations: `DEBUG`, a target framework) and files that were not indexed (over
  // `MAX_FILE_BYTES`, or the outline cannot read them). Each identifier there counts as an
  // unresolved use of its name: a lower bound on nothing, so an answer for that name is never
  // complete. `unreadSkipped`: skipped files without text, whose names are not known.
  /** @type {Map<string, number>} */
  const hiddenInIf = new Map();
  /** @type {Map<string, number>} */
  const hiddenInSkipped = new Map();
  let unreadSkipped = 0;

  for (const src of sources) {
    if (typeof src.text !== 'string') { skipped++; unreadSkipped++; continue; }
    const rec = src.text.length > MAX_FILE_BYTES ? null : parseFile(src.path, src.text);
    if (!rec) { skipped++; countNames(src.text, hiddenInSkipped); continue; }
    byFile.set(rec.file, rec);
  }
  for (const rec of byFile.values()) {
    rec.uses = recordUses(rec);
    for (const use of rec.uses) {
      const k = use.kind === 'new' ? `new ${use.name}` : use.name;
      let list = usesByName.get(k);
      if (!list) { list = []; usesByName.set(k, list); }
      list.push({ rec, use });
    }
  }

  /** @param {string} text @param {Map<string, number>} into Counts each non-keyword identifier of `text` by name. */
  function countNames(text, into) {
    for (const m of text.matchAll(/@?([\p{L}_][\p{L}\p{N}_]*)/gu)) {
      const name = m[1];
      if (KEYWORDS.has(name) || PREDEFINED.has(name)) continue;
      into.set(name, (into.get(name) || 0) + 1);
    }
  }

  /** @param {string} text @param {string} active `activeText(text)` @returns {string} The inactive `#if` code of `text` only (the rest blanked). */
  function inactivePart(text, active) {
    let out = '';
    for (let i = 0; i < text.length; i++) out += active[i] === text[i] && !/\s/.test(text[i]) ? ' ' : text[i];
    return out;
  }

  /** @param {string} rel @param {string} text @returns {FileRec|null} */
  function parseFile(rel, text) {
    const base = path.posix.basename(rel);
    const outline = csharpOutline(text, { fileName: base });
    if (!outline) return null;
    const active = activeText(text);
    if (active !== text) countNames(inactivePart(text, active), hiddenInIf);
    /** @type {Token[]} */
    const toks = [];
    // The code of interpolation holes (`$"…{F(x)}…"`) is lexed after its literal, so calls
    // there are read; a hole's own literals may have holes in turn.
    /** @type {(t: Token) => void} */
    const take = (t) => {
      if (t.kind === 'directive') return;
      toks.push(t);
      for (const [a, b] of t.holes || []) {
        // A separator before each hole, so two holes never read as one declaration (`{a}{F(x)}`).
        toks.push({ kind: 'punct', text: '$hole', start: a, end: a });
        lex(active.slice(0, b), a, (x) => { take(x); });
      }
    };
    if (lex(active, 0, (t) => { take(t); }) < 0) return null;
    /** @type {FileRec} */
    const rec = {
      rel, file: root ? path.join(root, rel) : rel, text: active, toks, match: matchBrackets(toks), spaces: [], usings: [], aliases: new Map(),
      statics: [], fileTypes: new Map(), parts: [], defs: [], byPos: new Map(), baseCalls: new Map(),
      ui: uiDirs.some((d) => d === '' || rel.startsWith(`${d}/`)), uses: null,
    };
    readNamespacesAndUsings(rec, outline);
    /** @type {(syms: any[], outer: TypeRec|null, pathSoFar: string[]) => void} */
    const walk = (syms, outer, pathSoFar) => {
      for (const s of syms) {
        if (![5, 10, 11, 23].includes(s.kind)) continue;
        const seg = segOf(s.name);
        const p = [...pathSoFar, seg];
        const t = typeRec(rec, s, seg, p, outer);
        rec.parts.push({ start: s.range.start, end: s.range.end, type: t });
        walk(s.children || [], t, p);
      }
    };
    walk(outline, null, []);
    for (const sym of collectCsharpSymbols(/** @type {any} */ (outline), text)) {
      const part = innermostPart(rec, sym.namePos);
      const owner = sym.csharpKind === 'top-level' ? null : part ? part.type : null;
      const sig = /** @type {any} */ (sym.sig);
      const sp = sig && Array.isArray(sig.params) ? sig.params : [];
      const params = sp.map((/** @type {any} */ pr) => ({ name: bare(String(pr.name)), type: String(pr.type) }));
      const rest = sp.some((/** @type {any} */ pr) => pr.rest);
      const required = sp.filter((/** @type {any} */ pr) => !pr.optional && !pr.rest).length;
      const decl = /** @type {any} */ (sym).explicitInterface;
      const isCtor = sym.isConstructor;
      /** @type {DefRec} */
      const d = {
        name: isCtor ? (owner ? owner.simple : sym.simpleName) : bare(sym.simpleName),
        key: sym.key, label: sym.label, namePos: sym.namePos, start: sym.start, end: sym.end, type: owner, file: rec,
        min: required, max: rest ? Infinity : params.length, member: /** @type {any} */ (sym).csharpKind,
        mods: new Set(/** @type {any} */ (sym).modifiers || []), attributes: sym.decorators || [], returns: sig ? sig.returns : null,
        params, paramKey: sym.key.includes('(') ? sym.key.slice(sym.key.indexOf('(')).replace(/#\d+$/, '') : '',
        typeParams: new Set(sig && sig.typeParameters ? String(sig.typeParameters).replace(/[<>]/g, '').split(',').map((x) => x.replace(/\b(in|out)\b/g, '').trim()).filter(Boolean) : []),
        inInterface: /** @type {any} */ (sym).inInterface, extension: /\(this /.test(sym.key), explicit: decl || null, locals: null,
      };
      if (/** @type {any} */ (sym).csharpKind === 'static-constructor') continue;
      rec.defs.push(d);
      rec.byPos.set(d.namePos, d);
      if (d.member === 'method') methodNames.add(d.name);
      if (!owner) continue;
      if (/** @type {any} */ (sym).csharpKind === 'primary-constructor') {
        owner.ctors.push(d);
        for (const pr of params) setField(owner, pr.name, pr.type, rec, d.namePos);
      } else if (isCtor) owner.ctors.push(d);
      else if (d.member === 'method' && !d.explicit) {
        let list = owner.methods.get(d.name);
        if (!list) { list = []; owner.methods.set(d.name, list); }
        list.push(d);
        if (d.extension) extNames.add(d.name);
      }
      if (d.attributes.some((a) => GENERATED_ATTRIBUTES.has(a.replace(/Attribute$/, '')))) owner.generated = true;
    }
    return rec;
  }

  /**
   * Namespaces (block: `namespace A.B { … }`; file-scoped: `namespace A.B;` to the file's end)
   * and `using` directives outside every type and statement.
   * @param {FileRec} rec @param {any[]} outline
   */
  function readNamespacesAndUsings(rec, outline) {
    const { toks, match } = rec;
    const ranges = outline.map((s) => s.range);
    const inside = (/** @type {number} */ pos) => ranges.some((r) => r.start <= pos && pos < r.end);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind !== 'ident' || inside(t.start)) continue;
      if (t.text === 'namespace') {
        let j = i + 1;
        /** @type {string[]} */
        const parts = [];
        while (toks[j] && toks[j].kind === 'ident') { parts.push(bare(toks[j].text)); j++; if (isP(toks[j], '.')) j++; else break; }
        if (!parts.length) continue;
        const end = isP(toks[j], '{') && match[j] > j ? toks[match[j]].end : rec.text.length;
        const outerNs = nsAt(rec, t.start);
        const name = outerNs ? `${outerNs}.${parts.join('.')}` : parts.join('.');
        rec.spaces.push({ name, start: t.start, end });
        for (let k = 1; k <= name.split('.').length; k++) namespaces.add(name.split('.').slice(0, k).join('.'));
        continue;
      }
      if (t.text !== 'using') continue;
      const isGlobal = toks[i - 1] && toks[i - 1].text === 'global' && !isP(toks[i - 2], '::');
      let j = i + 1;
      const isStatic = toks[j] && toks[j].text === 'static';
      if (isStatic) j++;
      if (isP(toks[j], '(')) continue;
      let alias = null;
      if (toks[j] && toks[j].kind === 'ident' && isP(toks[j + 1], '=')) { alias = bare(toks[j].text); j += 2; }
      const ty = readType(toks, j);
      if (!ty || !isP(toks[ty.end], ';')) continue;
      const name = ty.base.replace(/^global\./, '');
      if (alias) (isGlobal ? globalAliases : rec.aliases).set(alias, name);
      else if (isStatic) (isGlobal ? globalStatics : rec.statics).push(name);
      else if (isGlobal) globalUsings.add(name); else rec.usings.push(name);
      i = ty.end;
    }
  }

  /** @param {FileRec} rec @param {number} pos @returns {string} The namespace at `pos`. */
  function nsAt(rec, pos) {
    /** @type {{ name: string, start: number }|null} */
    let best = null;
    for (const s of rec.spaces) if (s.start <= pos && pos < s.end && (!best || s.start >= best.start)) best = s;
    return best ? best.name : '';
  }

  /** @param {TypeRec} t @param {string} name @param {string} text @param {FileRec} file @param {number} at */
  function setField(t, name, text, file, at) {
    const prev = t.fields.get(name);
    t.fields.set(name, prev === undefined || (prev && prev.text === text) ? { text, file, at } : null);
  }

  /**
   * One declaration part of a type, merged into the type of its namespace, path and arity.
   * @param {FileRec} rec @param {any} s @param {string} seg @param {string[]} p @param {TypeRec|null} outer @returns {TypeRec}
   */
  function typeRec(rec, s, seg, p, outer) {
    const { text, toks, match } = rec;
    const head = text.slice(s.range.start, s.selectionRange.start).replace(/\[[^\]]*\]/g, ' ');
    const word = (/\b(class|struct|interface|enum|record)\b(?:\s+(?:class|struct))?\s*$/.exec(head) || [])[1] || 'class';
    const ns = nsAt(rec, s.selectionRange.start);
    const isFile = /\bfile\b/.test(head);
    const key = `${ns ? `${ns}.` : ''}${p.join('.')}`;
    /** @type {TypeRec|undefined} */
    let t = isFile ? undefined : typesByKey.get(key);
    if (!t) {
      const [simple, ar] = seg.split('`');
      t = {
        key, simple, arity: Number(ar || 0), ns, path: p, kind: word, parts: [], namePos: s.selectionRange.start, bases: [],
        typeParams: new Set(), methods: new Map(), ctors: [], fields: new Map(), outer, nested: new Map(), sealed: false,
        isStatic: false, generated: false, hier: null,
      };
      if (isFile) rec.fileTypes.set(seg, t); else typesByKey.set(key, t);
      if (outer) outer.nested.set(seg, t);
    }
    t.parts.push(rec);
    if (/\b(sealed|static)\b/.test(head) || word === 'struct' || /\brecord\s+struct\b/.test(head)) t.sealed = true;
    if (/\bstatic\b/.test(head)) t.isStatic = true;
    // The header after the name: type parameters, a primary constructor, the base list.
    let i = toks.findIndex((x) => x.start >= s.selectionRange.end);
    if (i < 0) return t;
    if (isP(toks[i], '<')) {
      const close = typeArgs(toks, i);
      for (let k = i + 1; close && k < close.end - 1; k++) if (toks[k].kind === 'ident' && !['in', 'out'].includes(toks[k].text)) t.typeParams.add(toks[k].text);
      if (close) i = close.end;
    }
    if (isP(toks[i], '(') && match[i] > i) i = match[i] + 1;
    if (isP(toks[i], ':')) {
      i++;
      for (;;) {
        const from = i;
        const ty = readType(toks, i);
        if (!ty) break;
        t.bases.push({ text: ty.base, file: rec, at: toks[i].start });
        i = ty.end;
        if (isP(toks[i], '(') && match[i] > i) { rec.baseCalls.set(lastNameTok(toks, from, ty.end).start, { type: t, open: i }); i = match[i] + 1; }
        if (!isP(toks[i], ',')) break;
        i++;
      }
    }
    if (word !== 'enum') readFields(rec, t, s);
    else readEnumMembers(rec, t, s);
    return t;
  }

  /**
   * Fields, events and properties of one part of a type: `T name;`, `T name = …`, `T Name { … }`,
   * `T Name => …`, at the body's level (bodies, nested types and initializers skipped).
   * @param {FileRec} rec @param {TypeRec} t @param {any} s
   */
  function readFields(rec, t, s) {
    const { toks, match } = rec;
    const open = toks.findIndex((x) => x.start >= s.selectionRange.end && isP(x, '{'));
    if (open < 0 || match[open] < 0 || toks[open].start >= s.range.end) return;
    const close = match[open];
    let i = open + 1;
    const nestedStarts = new Set((s.children || []).filter((/** @type {any} */ c) => [5, 10, 11, 23].includes(c.kind)).map((/** @type {any} */ c) => c.range.end));
    while (i < close) {
      // Attributes and modifiers.
      while (isP(toks[i], '[') && match[i] > i) i = match[i] + 1;
      while (toks[i] && toks[i].kind === 'ident' && (MEMBER_MODIFIERS.has(toks[i].text) || toks[i].text === 'event')) i++;
      const ty = readType(toks, i);
      if (ty && toks[ty.end] && toks[ty.end].kind === 'ident' && !KEYWORDS.has(toks[ty.end].text)) {
        const after = toks[ty.end + 1];
        if (after && ['; ', ';', '=', '{', '=>', ','].includes(after.text)) {
          setField(t, bare(toks[ty.end].text), ty.text, rec, toks[ty.end].start);
          // `T a, b;`
          for (let k = ty.end + 1; isP(toks[k], ',') && toks[k + 1] && toks[k + 1].kind === 'ident'; k += 2) setField(t, bare(toks[k + 1].text), ty.text, rec, toks[k + 1].start);
        }
      }
      // To the end of this member: a `;` at this level or a closing body brace.
      for (; i < close; i++) {
        const x = toks[i];
        if (isP(x, ';')) { i++; break; }
        if ((isP(x, '(') || isP(x, '[')) && match[i] > i) { i = match[i]; continue; }
        if (isP(x, '{') && match[i] > i) {
          i = match[i];
          const nx = toks[i + 1];
          if (nestedStarts.has(toks[i].end) || !(nx && (isP(nx, '=') || isP(nx, ';')))) { i++; break; }
        }
      }
    }
  }

  /**
   * An enum's members, as fields of the enum's own type.
   * @param {FileRec} rec @param {TypeRec} t @param {any} s
   */
  function readEnumMembers(rec, t, s) {
    const { toks, match } = rec;
    const open = toks.findIndex((x) => x.start >= s.selectionRange.end && isP(x, '{'));
    if (open < 0 || match[open] < 0) return;
    let expect = true;
    for (let i = open + 1; i < match[open]; i++) {
      const x = toks[i];
      if ((isP(x, '[') || isP(x, '(')) && match[i] > i) { i = match[i]; continue; }
      if (isP(x, ',')) { expect = true; continue; }
      if (expect && x.kind === 'ident') { setField(t, bare(x.text), t.simple, rec, x.start); expect = false; }
    }
  }

  /** @param {FileRec} rec @param {number} pos */
  function innermostPart(rec, pos) {
    /** @type {{ start: number, end: number, type: TypeRec }|null} */
    let best = null;
    for (const p of rec.parts) if (p.start <= pos && pos < p.end && (!best || p.start >= best.start)) best = p;
    return best;
  }
  /** @param {FileRec} rec @param {number} pos @returns {TypeRec|null} */
  const innermostType = (rec, pos) => { const p = innermostPart(rec, pos); return p ? p.type : null; };

  /** @param {FileRec} rec @param {number} pos @returns {DefRec|null} */
  function innermostDef(rec, pos) {
    /** @type {DefRec|null} */
    let best = null;
    for (const d of rec.defs) if (d.start <= pos && pos < d.end && (!best || d.start >= best.start)) best = d;
    return best;
  }

  /**
   * What each positional argument of a call is when that is plain from its tokens: `string`,
   * `char`, `number`, `bool` (a single literal), `new` (a `new T(…)` or `new T { … }`); null
   * otherwise. Null for a call with named arguments.
   * @param {FileRec} rec @param {Use} use @returns {ArgKind[]|null}
   */
  function argKinds(rec, use) {
    const { toks, match } = rec;
    if (use.open < 0 || match[use.open] < 0) return null;
    const close = match[use.open];
    /** @type {ArgKind[]} */
    const out = [];
    let first = use.open + 1;
    for (let j = use.open + 1; j <= close; j++) {
      const x = toks[j];
      if (j < close && (isP(x, '(') || isP(x, '[') || isP(x, '{')) && match[j] > j) { j = match[j]; continue; }
      if (j < close && !isP(x, ',')) continue;
      if (j === first) break;
      const from = first;
      first = j + 1;
      if (isP(toks[from + 1], ':') && toks[from].kind === 'ident') return null;
      if (toks[from].text === 'out' || toks[from].text === 'ref' || toks[from].text === 'in') { out.push(null); continue; }
      const a = toks[from];
      const single = j === from + 1;
      if (a.kind === 'lit' && single) out.push(/^[$@]*"/.test(a.text) ? { pre: 'string' } : /^'/.test(a.text) ? { pre: 'char' } : /^[0-9]/.test(a.text) ? { pre: 'number' } : null);
      else if ((a.text === 'true' || a.text === 'false') && single) out.push({ pre: 'bool' });
      else if (a.text === 'new' && !isP(toks[from + 1], '(') && !isP(toks[from + 1], '[')) {
        const ty = readType(toks, from + 1);
        const groupEnd = ty && (isP(toks[ty.end], '(') || isP(toks[ty.end], '{')) && match[ty.end] > ty.end ? match[ty.end] + 1 : -1;
        if (!ty || ty.array || groupEnd !== j) { out.push(null); continue; }
        const r = resolveTypeName(ty.base, rec, a.start, innermostType(rec, a.start), innermostDef(rec, a.start)?.typeParams);
        out.push(r && typeof r !== 'string' ? { t: r } : PREDEFINED.has(ty.base) ? { pre: ty.base } : r ? null : { ext: ty.base.replace(/`\d+/g, '').replace(/^.*\./, '') });
      } else if ((a.kind === 'ident' || isP(a, '(')) && j - 1 > from - 1 && chainOnly(toks, match, from, j)) {
        // A name, a member access or a call: its type when the index knows it.
        if (single && a.kind === 'ident') {
          const def = innermostDef(rec, a.start);
          const ty = def ? localsOf(def).vars.get(bare(a.text)) : undefined;
          if (typeof ty === 'string' && PREDEFINED.has(ty.replace(/\?$/, ''))) { out.push({ pre: ty.replace(/\?$/, '') }); continue; }
        }
        const r = recvAt(rec, j - 1, 1);
        out.push(r.t === 'type' && !r.static ? { t: r.type } : r.t === 'ext' && r.name ? (PREDEFINED.has(r.name) ? { pre: r.name } : { ext: r.name }) : null);
      } else out.push(null);
    }
    if (use.targs) /** @type {any} */ (out).targs = use.targs;
    return out;
  }

  /**
   * Whether an argument (`argKinds`) may convert to parameter `n` of `d`: false only when
   * plainly not — an indexed type whose bases (in the index) do not include the parameter's
   * indexed type, or that goes to a predefined type other than `object`; a literal or a
   * predefined-typed value to an indexed type or an unrelated predefined type.
   * @param {ArgKind} k @param {DefRec} d @param {number} n
   */
  function argFits(k, d, n) {
    if (!k) return true;
    const p = d.params[Math.min(n, d.params.length - 1)];
    if (!p) return true;
    if (d.max === Infinity && n >= d.params.length - 1) return true;
    const pt = p.type.replace(/^((this|ref|out|in|params|scoped)\s+)+/, '').replace(/\?$/, '');
    if (pt === 'object' || pt === 'dynamic' || /\[\]$/.test(pt)) return true;
    const predefined = PREDEFINED.has(pt);
    /** @type {TypeRec|null|'tp'|'amb'} */
    const pr = predefined ? null : resolveTypeName((readTypeText(pt) || pt), d.file, d.namePos, d.type, d.typeParams);
    if (pr === 'tp' || pr === 'amb') return true;
    if ('t' in k) {
      if (predefined) return false;
      const h = hierarchy(k.t);
      if (pr) return h.types.includes(pr);
      // An outside parameter type: only through an outside base of the argument's type.
      return h.outside.length > 0 || h.open;
    }
    if ('ext' in k) {
      if (pr) return false;
      if (predefined) return false;
      return true;
    }
    if (pr) return false;
    if (!predefined) return true;
    return predefinedConverts(k.pre, pt);
  }

  /**
   * C#'s implicit conversions between predefined types (identity, numeric widening; a numeric
   * literal to any numeric type). @param {string} from @param {string} to
   */
  function predefinedConverts(from, to) {
    if (from === to) return true;
    const RANK = { sbyte: 1, byte: 1, short: 2, ushort: 2, char: 2, int: 3, uint: 3, nint: 3, nuint: 3, long: 4, ulong: 4, float: 5, double: 6, decimal: 5 };
    const a = /** @type {Record<string, number>} */ (RANK)[from];
    const b = /** @type {Record<string, number>} */ (RANK)[to];
    if (from === 'number') return b !== undefined;
    if (a === undefined || b === undefined) return false;
    if (to === 'decimal') return a <= 4;
    if (from === 'decimal' || from === 'float' && to === 'decimal') return false;
    return b > a || (from === 'char' && (to === 'ushort' || to === 'int'));
  }

  /** @param {string} text A parameter type as the header parser gives it. @returns {string|null} `readType`'s `base` for it. */
  function readTypeText(text) {
    /** @type {Token[]} */
    const tt = [];
    lex(text, 0, (x) => { tt.push(x); });
    const ty = readType(tt, 0);
    return ty && ty.end === tt.length ? ty.text : null;
  }

  /** @param {FileRec} rec @param {number} open @returns {number} */
  function argCount(rec, open) {
    const { toks, match } = rec;
    const close = match[open];
    if (close < 0) return -1;
    if (close === open + 1) return 0;
    let n = 1;
    for (let j = open + 1; j < close; j++) {
      const x = toks[j];
      if (x.kind === 'punct' && (x.text === '(' || x.text === '[' || x.text === '{') && match[j] > j) { j = match[j]; continue; }
      if (isP(x, '<') && toks[j - 1] && toks[j - 1].kind === 'ident') {
        const ta = typeArgs(toks, j);
        if (ta && (isP(toks[ta.end], '(') || isP(toks[ta.end], '.') || isP(toks[ta.end], '>') || isP(toks[ta.end], ')') || isP(toks[ta.end], ',') || (toks[ta.end] && toks[ta.end].kind === 'ident'))) { j = ta.end - 1; continue; }
      }
      if (isP(x, ',')) n++;
    }
    return n;
  }

  /**
   * Whether the identifier at `toks[i]` (before `(` at `open`) declares a local function: a
   * type is written before it, or `>`/`?`/`]` of a type with a body after the parameters.
   * @param {Token[]} toks @param {Int32Array} match @param {number} i @param {number} open
   */
  function isDeclarationAt(toks, match, i, open) {
    const prev = toks[i - 1];
    if (!prev) return false;
    if (prev.kind === 'ident') return (!KEYWORDS.has(prev.text) || prev.text === 'var') && !isP(toks[i - 2], '.') ? !['new', 'return', 'await', 'throw', 'in', 'is', 'as', 'case', 'else', 'yield', 'out', 'ref', 'using', 'await', 'when', 'and', 'or', 'not', 'nameof', 'typeof', 'sizeof', 'default', 'checked', 'unchecked', 'lock', 'from', 'select', 'where'].includes(prev.text) : PREDEFINED.has(prev.text);
    if (isP(prev, '>') || isP(prev, ']') || isP(prev, '?')) {
      const close = match[open];
      const after = close >= 0 ? toks[close + 1] : undefined;
      return !!after && (isP(after, '{') || isP(after, '=>') || (after.kind === 'ident' && after.text === 'where'));
    }
    return false;
  }

  /**
   * Every call, constructor call and method-group use of a file, by token. Attribute lists,
   * `nameof(…)`, `typeof(…)` and declarations are skipped.
   * @param {FileRec} rec @returns {Use[]}
   */
  function recordUses(rec) {
    const { toks, match } = rec;
    /** @type {Use[]} */
    const uses = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind === 'punct') {
        if (t.text === '[' && match[i] > i && opensAttribute(toks, i)) i = match[i];
        continue;
      }
      if (t.kind !== 'ident') continue;
      if ((t.text === 'nameof' || t.text === 'typeof' || t.text === 'sizeof') && isP(toks[i + 1], '(') && match[i + 1] > i) { i = match[i + 1]; continue; }
      if (t.text === 'new') {
        if (isP(toks[i + 1], '(')) {
          uses.push({ name: '<new()>', pos: t.start, end: t.end, at: i, kind: 'new', argc: argCount(rec, i + 1), open: i + 1, newKind: 'target' });
          continue;
        }
        const ty = readType(toks, i + 1);
        if (!ty || ty.array) continue;
        const nameTok = lastNameTok(toks, i + 1, ty.end);
        if (isP(toks[ty.end], '(')) {
          if (match[ty.end] < 0) continue;
          uses.push({ name: nameTok.text.replace(/^@/, ''), pos: nameTok.start, end: nameTok.end, at: i, kind: 'new', argc: argCount(rec, ty.end), open: ty.end });
        } else if (isP(toks[ty.end], '{')) {
          uses.push({ name: nameTok.text.replace(/^@/, ''), pos: nameTok.start, end: nameTok.end, at: i, kind: 'new', argc: 0, open: -1 });
        }
        i = ty.end - 1;
        continue;
      }
      const baseCall = rec.baseCalls.get(t.start);
      if (baseCall) {
        uses.push({ name: '<base>', pos: t.start, end: t.end, at: i, kind: 'new', argc: argCount(rec, baseCall.open), open: baseCall.open, newKind: 'primary-base' });
        continue;
      }
      // `: base(…)` / `: this(…)` constructor initializers.
      if ((t.text === 'base' || t.text === 'this') && isP(toks[i - 1], ':') && isP(toks[i + 1], '(')) {
        uses.push({ name: t.text === 'this' ? '<this>' : '<base>', pos: t.start, end: t.end, at: i, kind: 'new', argc: argCount(rec, i + 1), open: i + 1 });
        continue;
      }
      if (KEYWORDS.has(t.text) || PREDEFINED.has(t.text) || rec.byPos.has(t.start)) continue;
      let open = i + 1;
      let targs = 0;
      if (isP(toks[open], '<')) { const ta = typeArgs(toks, open); if (ta && isP(toks[ta.end], '(')) { open = ta.end; targs = ta.count; } }
      if (isP(toks[open], '(')) {
        if (isDeclarationAt(toks, match, i, open)) continue;
        uses.push({ name: bare(t.text), pos: t.start, end: t.end, at: i, kind: 'call', argc: argCount(rec, open), open, ...(targs ? { targs } : {}) });
        continue;
      }
      // A possible method group: any other use of an indexed method's name that is not called
      // and not the left side of a member access (`M.x`, `M::x`) — `return M;`, `h: M`,
      // `c ? M : null`, `{ M }`, `[M]`, `x += M`. What the name denotes is decided when it is
      // resolved (a local, a field or a property of that name is not the method).
      const name = bare(t.text);
      if (!methodNames.has(name)) continue;
      const nx = toks[open];
      if (nx && (isP(nx, '.') || isP(nx, '?.') || isP(nx, '::') || (isP(nx, '?') && isP(toks[open + 1], '[')))) continue;
      uses.push({ name, pos: t.start, end: t.end, at: i, kind: 'ref', argc: -1, open: -1 });
    }
    return uses;
  }

  /** @param {Token[]} toks @param {number} from @param {number} end @returns {Token} The last name segment of a type read from `from` to `end`. */
  function lastNameTok(toks, from, end) {
    let last = toks[from];
    for (let k = from; k < end; k++) {
      if (isP(toks[k], '<')) { const ta = typeArgs(toks, k); if (ta) { k = ta.end - 1; continue; } }
      if (toks[k].kind === 'ident' && toks[k].text !== 'global') last = toks[k];
    }
    return last;
  }

  // ---- types and members -----------------------------------------------------------------

  /**
   * The type a name written in `rec` denotes: an indexed type, null for an outside one, `'tp'`
   * for a type parameter, `'amb'` for two indexed types imported under one name.
   * @param {string} text `readType`'s `base` (segments with arity) @param {FileRec} rec @param {number} pos
   * @param {TypeRec|null} enc @param {Set<string>} [tps] @returns {TypeRec|null|'tp'|'amb'}
   */
  function resolveTypeName(text, rec, pos, enc, tps) {
    const name = text.replace(/\[\]$/, '').replace(/^global\./, '');
    if (!name || PREDEFINED.has(name)) return null;
    const parts = name.split('.');
    const first = parts[0];
    if (parts.length === 1) {
      if (tps && tps.has(first)) return 'tp';
      for (let o = enc; o; o = o.outer) if (o.typeParams.has(first)) return 'tp';
    }
    const head = resolveSimple(first, rec, pos, enc);
    if (head === 'amb') return 'amb';
    if (head) {
      /** @type {TypeRec|null} */
      let x = head;
      for (const seg of parts.slice(1)) x = x && (x.nested.get(seg) || null);
      if (x) return x;
    }
    if (parts.length > 1) {
      const alias = rec.aliases.get(first) || globalAliases.get(first);
      const full = alias ? [alias, ...parts.slice(1)].join('.') : name;
      if (typesByKey.has(full)) return /** @type {TypeRec} */ (typesByKey.get(full));
      for (let ns = nsAt(rec, pos); ns; ns = ns.includes('.') ? ns.slice(0, ns.lastIndexOf('.')) : '') {
        const t = typesByKey.get(`${ns}.${name}`);
        if (t) return t;
      }
    }
    return null;
  }

  /** @param {string} name @param {FileRec} rec @param {number} pos @param {TypeRec|null} enc @returns {TypeRec|null|'amb'} */
  function resolveSimple(name, rec, pos, enc) {
    for (let o = enc; o; o = o.outer) {
      if (`${o.simple}${o.arity ? `\`${o.arity}` : ''}` === name) return o;
      const n = o.nested.get(name);
      if (n) return n;
      for (const s of hierarchy(o).types.slice(1)) { const m = s.nested.get(name); if (m) return m; }
    }
    const ft = rec.fileTypes.get(name);
    if (ft) return ft;
    for (let ns = nsAt(rec, pos); ; ns = ns.slice(0, Math.max(0, ns.lastIndexOf('.')))) {
      const t = typesByKey.get(ns ? `${ns}.${name}` : name);
      if (t) return t;
      if (!ns) break;
    }
    const alias = rec.aliases.get(name) || globalAliases.get(name);
    if (alias) return typesByKey.get(alias) || null;
    /** @type {Set<TypeRec>} */
    const found = new Set();
    for (const u of rec.usings) { const t = typesByKey.get(`${u}.${name}`); if (t) found.add(t); }
    for (const u of globalUsings) { const t = typesByKey.get(`${u}.${name}`); if (t) found.add(t); }
    if (found.size > 1) return 'amb';
    return found.size ? [...found][0] : null;
  }

  /** An outside base named `I` + capital is taken for an interface. @param {string} text */
  const looksLikeInterface = (text) => /^I[A-Z]/.test(text.slice(text.lastIndexOf('.') + 1));

  /**
   * The type and its bases within the index, nearest first. `open`: a base class is written
   * but not indexed (an outside interface does not open a class's member lookup); `outside`:
   * every base not indexed, as written. Bound: `MAX_HIERARCHY` types.
   * @param {TypeRec} t @returns {{ types: TypeRec[], open: boolean, outside: string[] }}
   */
  function hierarchy(t) {
    if (t.hier) return t.hier;
    t.hier = { types: [t], open: false, outside: [] };
    /** @type {TypeRec[]} */
    const types = [];
    let open = false;
    /** @type {string[]} */
    const outside = [];
    const queue = [t];
    const seen = new Set();
    while (queue.length) {
      const x = /** @type {TypeRec} */ (queue.shift());
      if (seen.has(x)) continue;
      if (types.length >= MAX_HIERARCHY) { open = true; break; }
      seen.add(x);
      types.push(x);
      for (const b of x.bases) {
        const r = resolveTypeName(b.text, b.file, b.at, x.outer, x.typeParams);
        if (r && r !== 'tp' && r !== 'amb') queue.push(r);
        else if (b.text !== 'object' && b.text !== 'Object') {
          outside.push(b.text.replace(/`\d+/g, ''));
          if (r === 'amb' || !looksLikeInterface(b.text) || t.kind === 'interface') open = true;
        }
      }
    }
    t.hier = { types, open, outside };
    return t.hier;
  }

  /** @param {DefRec} d @param {number} argc */
  const arityMatches = (d, argc) => argc < 0 || (argc >= d.min && argc <= d.max);

  /**
   * The methods named `name` a call with `argc` arguments may reach on `t`: the nearest type of
   * its hierarchy with an applicable method of the name (a class's own before its bases',
   * interfaces only for an interface receiver). `byName`: some method of that name exists.
   * `kinds`: what each argument is when written as a literal or `new T(` (`argKinds`); an
   * overload a literal cannot convert to is dropped when another one fits.
   * @param {TypeRec} t @param {string} name @param {number} argc @param {boolean} [skipSelf] @param {ArgKind[]|null} [kinds]
   */
  function lookup(t, name, argc, skipSelf = false, kinds = null) {
    const h = hierarchy(t);
    /** @type {Map<string, DefRec>} */
    const found = new Map();
    let byName = false;
    const targs = kinds ? /** @type {any} */ (kinds).targs || 0 : 0;
    // Arity matched, but every such overload plainly does not take the arguments: the call
    // goes elsewhere (an outside base, an extension, a conversion this does not read).
    let misfit = false;
    for (const x of skipSelf ? h.types.slice(1) : h.types) {
      if (x.kind === 'interface' && t.kind !== 'interface') continue;
      for (const d of x.methods.get(name) || []) {
        byName = true;
        // The nearest declaration of a parameter list wins; two of one type that differ only
        // in generic arguments (`Find(IList<A>)`, `Find(IList<B>)`, keys `#2`) are both kept.
        if (!arityMatches(d, argc) || [...found.values()].some((f) => f.paramKey === d.paramKey && f.type !== d.type)) continue;
        if (targs && d.typeParams.size !== targs) continue;
        if (kinds && !kinds.every((k, n) => argFits(k, d, n))) { misfit = true; continue; }
        found.set(d.key, d);
      }
      // Overload resolution stops at the most derived type with an applicable method.
      if (found.size && argc >= 0) break;
    }
    let defs = [...found.values()];
    if (defs.length > 1 && kinds) defs = mostSpecific(defs, kinds);
    // Several by arity and argument types: those the call fits without defaults or `params`
    // expansion first (C#'s tie-break when the parameter types do not decide).
    if (defs.length > 1 && argc >= 0) {
      const exact = defs.filter((d) => d.min === argc && d.max === argc);
      if (exact.length) defs = exact;
    }
    // A base chain that leaves the index: C# tries the most derived type's applicable methods
    // first, so an indexed method wins only when it surely takes the arguments; otherwise an
    // outside base's overload (`ControllerBase.Ok(object)`) may be the one called.
    if (defs.length && h.open && argc >= 0 && !defs.some((d) => surelyApplicable(d, kinds, argc))) return { defs: [], byName, open: true };
    return { defs, byName, open: h.open || t.generated || (misfit && !defs.length) };
  }

  /**
   * Whether `d` surely takes a call's arguments: no arguments, or each argument's type is
   * known and converts to its parameter's (an indexed base, the same or a widening predefined
   * type, the same outside type name, `object`, a bare type parameter).
   * @param {DefRec} d @param {ArgKind[]|null} kinds @param {number} argc
   */
  function surelyApplicable(d, kinds, argc) {
    if (argc === 0) return true;
    if (!kinds || kinds.length !== argc) return false;
    return kinds.every((k, n) => {
      if (!k) return false;
      const p = d.params[Math.min(n, d.params.length - 1)];
      if (!p) return false;
      const pt = p.type.replace(/^((this|ref|out|in|params|scoped)\s+)+/, '').replace(/\?$/, '');
      if (pt === 'object' || d.typeParams.has(pt)) return true;
      if ('pre' in k) return predefinedConverts(k.pre, pt);
      if ('ext' in k) return pt.replace(/<.*$/s, '').replace(/^.*\./, '') === k.ext;
      const pr = PREDEFINED.has(pt) ? null : resolveTypeName(readTypeText(pt) || pt, d.file, d.namePos, d.type, d.typeParams);
      return !!pr && typeof pr !== 'string' && hierarchy(k.t).types.includes(pr);
    });
  }

  /**
   * C#'s better function member, where the arguments' indexed types decide: the candidates
   * whose parameter types are nearest in each argument's hierarchy (all, when no one is
   * nearest on every argument).
   * @param {DefRec[]} defs @param {ArgKind[]} kinds @returns {DefRec[]}
   */
  function mostSpecific(defs, kinds) {
    /** @type {number[][]} */
    const ranks = defs.map((d) => kinds.map((k, n) => {
      if (!k) return 0;
      const p = d.params[Math.min(n, d.params.length - 1)];
      if (!p) return 0;
      const pt = p.type.replace(/^((this|ref|out|in|params|scoped)\s+)+/, '').replace(/\?$/, '');
      if ('t' in k) {
        const pr = PREDEFINED.has(pt) ? null : resolveTypeName(readTypeText(pt) || pt, d.file, d.namePos, d.type, d.typeParams);
        const at = pr && typeof pr !== 'string' ? hierarchy(k.t).types.indexOf(pr) : -1;
        return at < 0 ? 1000 : at;
      }
      if ('pre' in k) return pt === k.pre ? 0 : pt === 'object' ? 1000 : 10;
      if ('ext' in k) return pt.replace(/<.*$/s, '').replace(/^.*\./, '') === k.ext ? 0 : 1000;
      return 0;
    }));
    const best = defs.filter((_, a) => ranks.every((r) => r.every((v, n) => ranks[a][n] <= v)));
    return best.length ? best : defs;
  }

  /** @param {DefRec} d @returns {{ vars: Map<string, string|null>, fns: Set<string> }} */
  function localsOf(d) {
    if (d.locals) return d.locals;
    /** @type {Map<string, string|null>} */
    const vars = new Map();
    /** @type {Set<string>} */
    const fns = new Set();
    const set = (/** @type {string} */ n, /** @type {string|null} */ ty) => { const k = bare(n); vars.set(k, vars.has(k) && vars.get(k) !== ty ? null : ty); };
    for (const p of d.params) set(p.name, p.type.replace(/^(this|ref|out|in|params|scoped)\s+/g, ''));
    const { toks, match } = d.file;
    let i = 0;
    while (i < toks.length && toks[i].start < d.namePos) i++;
    for (; i < toks.length && toks[i].start < d.end; i++) {
      const t = toks[i];
      if (t.kind !== 'ident') {
        if (isP(t, '=>')) {
          const prev = toks[i - 1];
          if (isIdent(prev) && prev.start !== d.namePos && !isP(toks[i - 2], '.') && !(toks[i - 2] && toks[i - 2].kind === 'ident')) set(prev.text, null);
          else if (isP(prev, ')') && match[i - 1] >= 0) {
            for (let j = match[i - 1] + 1; j < i - 1; j++) {
              if (isIdent(toks[j]) && (isP(toks[j + 1], ',') || j + 1 === i - 1) && (isP(toks[j - 1], ',') || isP(toks[j - 1], '('))) set(toks[j].text, null);
            }
          }
        }
        continue;
      }
      if (t.text === 'is' || t.text === 'as') {
        if (t.text === 'is') { const ty = readType(toks, i + 1); if (ty && isIdent(toks[ty.end]) && !isP(toks[ty.end + 1], '.') && !isP(toks[ty.end + 1], '(')) set(toks[ty.end].text, ty.text); }
        continue;
      }
      if (isIdent(t) && isP(toks[i + 1], '(') && isDeclarationAt(toks, match, i, i + 1) && t.start !== d.namePos) {
        fns.add(bare(t.text));
        continue;
      }
      const prev = toks[i - 1];
      if (!prev || !(STATEMENT_START.has(prev.text) || ['out', 'using', 'const', 'ref', 'readonly', 'await', 'scoped'].includes(prev.text))) continue;
      if (NOT_TYPE_START.has(t.text) && t.text !== 'var') continue;
      if (t.text === 'var' && isP(toks[i + 1], '(')) {
        // `var (a, b) = …`: untyped.
        for (let j = i + 2; j < match[i + 1]; j++) if (isIdent(toks[j])) set(toks[j].text, null);
        continue;
      }
      const ty = readType(toks, i);
      if (!ty) continue;
      const nameTok = toks[ty.end];
      const after = toks[ty.end + 1];
      if (!nameTok || nameTok.kind !== 'ident' || KEYWORDS.has(nameTok.text) || !after || !['=', ';', ',', ')', 'in'].includes(after.text)) continue;
      if (ty.base === 'var') {
        const r = toks[ty.end + 2];
        let typed = null;
        // `var x = new T(…);` / `new T { … };` / `new T(…) { … };`: only when the `new` expression
        // is the whole initializer (`new T().Build()` is typed below, as a chain).
        if (after.text === '=' && r && r.text === 'new') {
          const nt = readType(toks, ty.end + 3);
          let e = nt && !nt.array && (isP(toks[nt.end], '(') || isP(toks[nt.end], '{')) && match[nt.end] > nt.end ? match[nt.end] + 1 : -1;
          if (e > 0 && isP(toks[e], '{') && isP(toks[nt ? nt.end : 0], '(') && match[e] > e) e = match[e] + 1;
          if (nt && e > 0 && endsInitializer(toks[e])) typed = nt.text;
        } else if (after.text === '=' && isP(r, '(')) {
          // `var x = (T)e;`: a cast when a name, a literal, `(`, `!` or `~` follows the `)`
          // (C#'s rule), and the operand is one token or a chain of names and calls to the `;`;
          // `var y = (x).M();` is a parenthesized expression.
          const ct = readType(toks, ty.end + 3);
          const close = match[ty.end + 2];
          const nx = toks[close + 1];
          const castable = nx && (nx.kind === 'ident' && nx.text !== 'as' && nx.text !== 'is' || nx.kind === 'lit' || isP(nx, '(') || isP(nx, '!') || isP(nx, '~'));
          let k = close + 1;
          for (; toks[k] && !isP(toks[k], ';') && k < close + 64; k++) if ((isP(toks[k], '(') || isP(toks[k], '[') || isP(toks[k], '{')) && match[k] > k) k = match[k];
          if (ct && isP(toks[ct.end], ')') && ct.end === close && castable && isP(toks[k], ';') && (k === close + 2 || chainOnly(toks, match, close + 1, k))) typed = ct.text;
        }
        if (after.text === '=' && typed === null) {
          // `var x = e as T;`
          let k = ty.end + 2;
          for (; toks[k] && !isP(toks[k], ';') && k < ty.end + 64; k++) if ((isP(toks[k], '(') || isP(toks[k], '{') || isP(toks[k], '[')) && match[k] > k) k = match[k];
          if (isP(toks[k], ';')) {
            for (let a = ty.end + 2; a < k; a++) {
              if (toks[a].text === 'as') { const at = readType(toks, a + 1); if (at && at.end === k) typed = at.text; }
            }
            // `var x = a.B().C();`: typed later from the expression (a chain of names and calls).
            if (typed === null && k > ty.end + 2 && isP(toks[k - 1], ')') && chainOnly(toks, match, ty.end + 2, k)) typed = `@${k - 1}`;
            // `var x = await a.F(…)[.ConfigureAwait(…)];`: the awaited result of F.
            else if (typed === null && toks[ty.end + 2] && toks[ty.end + 2].text === 'await' && k > ty.end + 3 && isP(toks[k - 1], ')') && chainOnly(toks, match, ty.end + 3, k)) typed = `@await${k - 1}`;
          }
        }
        set(nameTok.text, typed);
      } else set(nameTok.text, ty.text);
      i = ty.end;
    }
    d.locals = { vars, fns };
    return d.locals;
  }

  /** @param {TypeRec} t @param {string} name @returns {{ text: string, file: FileRec, at: number }|null|undefined} undefined: none; null: several types. */
  function fieldOf(t, name) {
    for (const x of hierarchy(t).types) if (x.fields.has(name)) return x.fields.get(name);
    return undefined;
  }

  /** @param {string} text @param {FileRec} file @param {number} at @param {TypeRec|null} enc @param {Set<string>} [tps] @returns {Recv} */
  function recvOfText(text, file, at, enc, tps) {
    if (/[<?:]/.test(text)) text = readTypeText(text.replace(/^((this|ref|out|in|params|scoped)\s+)+/, '')) || text;
    text = text.replace(/\?$/, '');
    if (/\[\]$/.test(text)) return { t: 'ext' };
    if (text === 'dynamic') return { t: 'unk' };
    if (PREDEFINED.has(text)) return { t: 'ext', name: text };
    const r = resolveTypeName(text, file, at, enc, tps);
    if (r === 'tp' || r === 'amb') return { t: 'unk' };
    return r ? { t: 'type', type: r, static: false } : { t: 'ext', name: text.replace(/`\d+/g, '').replace(/^.*\./, '') };
  }

  /** @param {FileRec} rec @param {number} end @param {number} depth @returns {Recv} The type of the receiver ending at token `end`. */
  function recvAt(rec, end, depth) {
    if (depth > MAX_CHAIN_DEPTH) return { t: 'unk' };
    let t = rec.toks[end];
    if (isP(t, '!')) { end--; t = rec.toks[end]; }
    if (!t) return { t: 'unk' };
    if (t.kind === 'lit') return /^[$@]*"/.test(t.text) ? { t: 'ext' } : { t: 'unk' };
    if (t.kind === 'ident') return recvOfName(rec, end, depth);
    if (isP(t, ')')) return recvOfParen(rec, end, depth);
    if (isP(t, '>')) {
      // `Foo<int>.M(`: a generic type's static call.
      let k = end;
      let depthA = 0;
      for (; k >= 0 && k > end - 80; k--) { if (isP(rec.toks[k], '>')) depthA++; else if (isP(rec.toks[k], '<') && --depthA === 0) break; }
      if (k > 0 && rec.toks[k - 1].kind === 'ident' && !isP(rec.toks[k - 2], '.')) {
        const ty = readType(rec.toks, k - 1);
        if (ty && ty.end === end + 1) {
          const enc = innermostType(rec, rec.toks[end].start);
          const r = resolveTypeName(ty.base, rec, rec.toks[end].start, enc);
          return r && r !== 'tp' && r !== 'amb' ? { t: 'type', type: r, static: true } : r ? { t: 'unk' } : { t: 'ext' };
        }
      }
    }
    return { t: 'unk' };
  }

  /** @param {FileRec} rec @param {number} end @param {number} depth @returns {Recv} */
  function recvOfName(rec, end, depth) {
    const { toks } = rec;
    const t = toks[end];
    const name = bare(t.text);
    const enc = innermostType(rec, t.start);
    const def = innermostDef(rec, t.start);
    const dotted = isP(toks[end - 1], '.') || isP(toks[end - 1], '?.');
    if (t.text === 'this' && !dotted) return enc ? { t: 'type', type: enc, static: false } : { t: 'unk' };
    if (t.text === 'base' && !dotted) return { t: 'unk' };
    if (PREDEFINED.has(t.text)) return { t: 'ext' };
    if (KEYWORDS.has(t.text) && t.text !== 'value') return { t: 'unk' };
    if (isP(toks[end - 1], '::')) return { t: 'ns', name };
    if (dotted) return memberOf(recvAt(rec, end - 2, depth + 1), name, rec, t.start);
    if (def) {
      const { vars } = localsOf(def);
      if (vars.has(name)) {
        const ty = vars.get(name);
        if (ty && ty.startsWith('@await')) return awaitedAt(rec, Number(ty.slice(6)), depth + 1);
        if (ty && ty.startsWith('@')) return recvAt(rec, Number(ty.slice(1)), depth + 1);
        return ty ? recvOfText(ty, rec, t.start, def.type || enc, def.typeParams) : { t: 'unk' };
      }
    }
    if (t.text === 'value') return { t: 'unk' };
    for (let o = enc; o; o = o.outer) {
      const f = fieldOf(o, name);
      if (f === null) return { t: 'unk' };
      if (f) { const owner = innermostType(f.file, f.at); return recvOfText(f.text, f.file, f.at, owner, undefined); }
    }
    const ty = resolveTypeName(name, rec, t.start, enc, def ? def.typeParams : undefined);
    if (ty === 'tp' || ty === 'amb') return { t: 'unk' };
    // A member inherited from an outside base hides a type of the same name found outside the
    // enclosing types (`User.IsInRole(…)` in a controller is `ControllerBase.User`): only a
    // static method of the type can be meant then (`onReceiver`), and no member of it.
    if (ty) return { t: 'type', type: ty, static: true, ...(memberTypeOf(enc, name) !== ty && enclosingOpen(enc) ? { shadowable: true } : {}) };
    if (enclosingOpen(enc)) return { t: 'unk' };
    if (namespaces.has(name) || rec.aliases.has(name) || globalAliases.has(name)) return { t: 'ns', name: rec.aliases.get(name) || globalAliases.get(name) || name };
    // A namespace named relative to an enclosing one (`Naming.TV.X` inside `Emby.Server`).
    for (let ns = nsAt(rec, t.start); ns; ns = ns.includes('.') ? ns.slice(0, ns.lastIndexOf('.')) : '') {
      if (namespaces.has(`${ns}.${name}`)) return { t: 'ns', name: `${ns}.${name}` };
    }
    // A lowercase name not declared anywhere visible: something this cannot see.
    if (/^[a-z_]/.test(name)) return { t: 'unk' };
    return { t: 'ext' };
  }

  /** @param {TypeRec|null} enc @returns {boolean} Whether an enclosing type has a base class outside the index. */
  function enclosingOpen(enc) {
    for (let o = enc; o; o = o.outer) if (hierarchy(o).open) return true;
    return false;
  }

  /** @param {TypeRec|null} enc @param {string} name @returns {TypeRec|null} The type `name` denotes as a member of an enclosing type (itself, nested, a base's nested). */
  function memberTypeOf(enc, name) {
    for (let o = enc; o; o = o.outer) {
      if (o.simple === name && !o.arity) return o;
      const n = o.nested.get(name);
      if (n) return n;
      for (const s of hierarchy(o).types.slice(1)) { const m = s.nested.get(name); if (m) return m; }
    }
    return null;
  }

  /**
   * The awaited result of the call ending at `toks[end]` (`)`): its declared return type's
   * `Task<T>`/`ValueTask<T>` argument; a trailing `.ConfigureAwait(…)` is skipped.
   * @param {FileRec} rec @param {number} end @param {number} depth @returns {Recv}
   */
  function awaitedAt(rec, end, depth) {
    const { toks, match } = rec;
    let open = match[end];
    if (open > 2 && toks[open - 1].text === 'ConfigureAwait' && isP(toks[open - 2], '.') && isP(toks[open - 3], ')')) { end = open - 3; open = match[end]; }
    if (open < 0) return { t: 'unk' };
    const use = (rec.uses || []).find((u) => u.open === open && u.kind === 'call');
    if (!use) return { t: 'unk' };
    const hit = resolveUse(rec, use, depth + 1);
    if (!Array.isArray(hit) || !hit.length || new Set(hit.map((d) => String(d.returns))).size !== 1) return { t: 'unk' };
    const d = hit[0];
    const m = /^(?:System\.Threading\.Tasks\.)?(?:Task|ValueTask)<(.+)>$/s.exec(String(d.returns).trim());
    if (!m || !d.type || d.typeParams.has(m[1].replace(/\?$/, ''))) return { t: 'unk' };
    return recvOfText(m[1].trim(), d.file, d.namePos, d.type, d.typeParams);
  }

  /** @param {Recv} base @param {string} name @param {FileRec} rec @param {number} pos @returns {Recv} `base.name`. */
  function memberOf(base, name, rec, pos) {
    if (base.t === 'type' && base.shadowable) return { t: 'unk' };
    if (base.t === 'type') {
      const f = fieldOf(base.type, name);
      if (f === null) return { t: 'unk' };
      if (f) return recvOfText(f.text, f.file, f.at, innermostType(f.file, f.at));
      const n = base.type.nested.get(name) || [...base.type.nested.entries()].find(([k]) => k.startsWith(`${name}\``))?.[1];
      if (n) return { t: 'type', type: n, static: true };
      return { t: 'unk' }; // a member this does not read (an auto-property of another form, an outside base's)
    }
    if (base.t === 'ns') {
      const full = `${base.name}.${name}`;
      const ty = typesByKey.get(full) || resolveTypeName(full, rec, pos, null);
      if (ty && typeof ty !== 'string') return { t: 'type', type: ty, static: true };
      return namespaces.has(full) ? { t: 'ns', name: full } : /^[A-Z]/.test(name) && !namespaces.has(base.name) ? { t: 'ext' } : namespaces.has(base.name) ? { t: 'ext' } : { t: 'unk' };
    }
    return base.t === 'ext' ? { t: 'unk' } : base; // a member of an outside type: its type is not known
  }

  /** @param {FileRec} rec @param {number} end @param {number} depth @returns {Recv} A receiver ending at `)`. */
  function recvOfParen(rec, end, depth) {
    const { toks, match } = rec;
    const open = match[end];
    if (open < 0) return { t: 'unk' };
    const pos = toks[end].start;
    const enc = innermostType(rec, pos);
    const def = innermostDef(rec, pos);
    const tps = def ? def.typeParams : undefined;
    const use = (rec.uses || []).find((u) => u.open === open);
    if (use && use.kind === 'new' && !use.newKind) {
      const ty = readType(toks, use.at + 1);
      if (!ty) return { t: 'unk' };
      const r = resolveTypeName(ty.base, rec, pos, enc, tps);
      return r && r !== 'tp' && r !== 'amb' ? { t: 'type', type: r, static: false } : r ? { t: 'unk' } : { t: 'ext' };
    }
    if (use && use.kind === 'call') {
      const hit = resolveUse(rec, use, depth + 1);
      if (hit === 'unresolved') return { t: 'unk' };
      if (!hit || !hit.length) return { t: 'unk' }; // an outside method: its return type is not known
      if (new Set(hit.map((d) => String(d.returns))).size !== 1) return { t: 'unk' };
      const d = hit[0];
      if (!d.returns || !d.type) return { t: 'unk' };
      if (d.typeParams.has(d.returns.replace(/\?$/, '')) && use.targs === 1) {
        const lt = isP(toks[use.at + 1], '<') ? use.at + 1 : -1;
        const ta = lt > 0 ? readType(toks, lt + 1) : null;
        return ta ? recvOfText(ta.text, rec, pos, enc, tps) : { t: 'unk' };
      }
      return recvOfText(d.returns.replace(/\?$/, ''), d.file, d.namePos, d.type, d.typeParams);
    }
    const before = toks[open - 1];
    if (before && (before.kind === 'ident' || isP(before, '>') || isP(before, ']'))) return { t: 'unk' };
    // `((T)e)` and `(e as T)`.
    if (isP(toks[open + 1], '(') && match[open + 1] > open + 1) {
      const inner = match[open + 1];
      const ty = readType(toks, open + 2);
      if (ty && ty.end === inner && inner + 1 < end) {
        if (ty.array) return { t: 'ext' };
        return recvOfText(ty.text, rec, pos, enc, tps);
      }
    }
    for (let k = open + 1; k < end; k++) {
      if ((isP(toks[k], '(') || isP(toks[k], '[') || isP(toks[k], '{')) && match[k] > k) { k = match[k]; continue; }
      if (toks[k].text === 'as') { const ty = readType(toks, k + 1); if (ty && ty.end === end) return recvOfText(ty.text, rec, pos, enc, tps); }
    }
    return end - 1 > open && open + 1 < end - 1 && !toks.slice(open + 1, end - 1).some((x) => x.kind === 'punct' && !['.', '?.', '(', ')', '!'].includes(x.text)) ? recvAt(rec, end - 1, depth + 1) : { t: 'unk' };
  }

  // Cache: each use's resolution (owner and lifetime: the index's).
  /** @type {Map<Use, Hit>} */
  const resolved = new Map();

  /** @param {FileRec} rec @param {Use} use @param {number} [depth] @returns {Hit} */
  function resolveUse(rec, use, depth = 0) {
    if (resolved.has(use)) return /** @type {Hit} */ (resolved.get(use));
    resolved.set(use, 'unresolved');
    const dot = isP(rec.toks[use.at - 1], '.') || isP(rec.toks[use.at - 1], '?.') ? use.at - 1 : -1;
    const hit = use.kind === 'new' ? resolveNew(rec, use)
      : dot >= 0 ? resolveQualified(rec, use, dot, depth)
        : resolveBare(rec, use);
    resolved.set(use, hit);
    return hit;
  }

  /**
   * The type a target-typed `new(` creates: `T x = new(`, a field or property initializer, a
   * `return new(` in a member with a declared return type. Null when not written there.
   * @param {FileRec} rec @param {Use} use @returns {string|null}
   */
  function targetTypeOf(rec, use) {
    const { toks } = rec;
    const prev = toks[use.at - 1];
    if (isP(prev, '=') && toks[use.at - 2] && toks[use.at - 2].kind === 'ident') {
      const nameTok = toks[use.at - 2];
      // Walk back over the declared type.
      for (let k = use.at - 3; k >= 0 && k > use.at - 40; k--) {
        const ty = readType(toks, k);
        if (ty && ty.end === use.at - 2 && ty.base !== 'var') {
          const b = toks[k - 1];
          if (!b || STATEMENT_START.has(b.text) || MEMBER_MODIFIERS.has(b.text) || b.text === 'using') return ty.text;
        }
        if (!(toks[k].kind === 'ident' || ['.', '<', '>', ',', '?', '[', ']'].includes(toks[k].text))) break;
      }
      void nameTok;
      return null;
    }
    if (prev && prev.text === 'return') {
      const def = innermostDef(rec, use.pos);
      if (def && def.returns && def.member === 'method' && !/^(Task|ValueTask)\b/.test(def.returns) && !def.mods.has('async')) return def.returns;
    }
    return null;
  }

  /** @param {FileRec} rec @param {Use} use @returns {Hit} Constructors reached by `new`, `this(`, `base(`, a primary base call. */
  function resolveNew(rec, use) {
    const enc = innermostType(rec, use.pos);
    const def = innermostDef(rec, use.pos);
    /** @type {TypeRec|null|'tp'|'amb'} */
    let t;
    if (use.name === '<this>') t = enc;
    else if (use.name === '<base>') {
      const owner = use.newKind === 'primary-base' ? /** @type {any} */ (rec.baseCalls.get(use.pos)).type : enc;
      if (!owner || !owner.bases.length) return null;
      const b = owner.bases.find((/** @type {any} */ x) => x.at <= use.pos) || owner.bases[0];
      t = use.newKind === 'primary-base' ? resolveTypeName(b.text, b.file, b.at, owner.outer, owner.typeParams) : resolveTypeName(owner.bases[0].text, owner.bases[0].file, owner.bases[0].at, owner.outer, owner.typeParams);
      if (t && typeof t !== 'string' && t.kind === 'interface') return null;
    } else if (use.newKind === 'target') {
      const text = targetTypeOf(rec, use);
      if (!text) return 'unresolved';
      t = resolveTypeName(text.replace(/\?$/, ''), rec, use.pos, enc, def ? def.typeParams : undefined);
    } else {
      const ty = readType(rec.toks, use.at + 1);
      t = ty ? resolveTypeName(ty.base, rec, use.pos, enc, def ? def.typeParams : undefined) : null;
    }
    if (t === 'amb') return 'unresolved';
    if (!t || t === 'tp') return null;
    const kinds = use.open >= 0 ? argKinds(rec, use) : null;
    let defs = t.ctors.filter((d) => arityMatches(d, use.argc));
    if (kinds && defs.length) {
      const fit = defs.filter((d) => kinds.every((k, n) => argFits(k, d, n)));
      if (!fit.length) return 'unresolved';
      defs = fit.length > 1 ? mostSpecific(fit, kinds) : fit;
    }
    return defs.length ? defs : null;
  }

  /** @param {Recv} recv @param {string} name @param {number} argc @param {ArgKind[]|null} [kinds] @returns {Hit} */
  function onReceiver(recv, name, argc, kinds = null) {
    if (recv.t === 'type') {
      const l = lookup(recv.type, name, argc, false, kinds);
      // A type written as the receiver calls static methods only: an instance method found
      // there means the name is something else (an inherited member, a property not read).
      if (l.defs.length) return recv.static && l.defs.some((d) => !d.mods.has('static')) ? 'unresolved' : l.defs;
      return l.open || extNames.has(name) ? 'unresolved' : null;
    }
    if (recv.t === 'ext') return extNames.has(name) ? 'unresolved' : null;
    return recv.t === 'unk' ? 'unresolved' : null;
  }

  /** @param {FileRec} rec @param {Use} use @returns {Hit} Bare `M(`. */
  function resolveBare(rec, use) {
    const enc = innermostType(rec, use.pos);
    const def = innermostDef(rec, use.pos);
    if (def) {
      const { vars, fns } = localsOf(def);
      if (fns.has(use.name) || vars.has(use.name)) return null;
    }
    let open = false;
    for (let o = enc; o; o = o.outer) {
      if (o.fields.has(use.name)) return null;
      const l = lookup(o, use.name, use.argc, false, argKinds(rec, use));
      if (l.byName) return l.defs.length ? l.defs : l.open ? 'unresolved' : null;
      open = open || l.open;
    }
    let outsideStatic = false;
    for (const owner of [...rec.statics, ...globalStatics]) {
      const t = resolveTypeName(owner, rec, use.pos, null);
      if (!t || typeof t === 'string') { outsideStatic = true; continue; }
      const l = lookup(t, use.name, use.argc, false, argKinds(rec, use));
      if (l.defs.length) return l.defs;
    }
    return open || outsideStatic ? 'unresolved' : null;
  }

  /** @param {FileRec} rec @param {Use} use @param {number} dot @param {number} depth @returns {Hit} `base.M(` and `x.M(`. */
  function resolveQualified(rec, use, dot, depth) {
    const { toks } = rec;
    const r = toks[dot - 1];
    if (r && r.kind === 'ident' && r.text === 'base' && !isP(toks[dot - 2], '.')) {
      const enc = innermostType(rec, use.pos);
      if (!enc) return 'unresolved';
      const l = lookup(enc, use.name, use.argc, true, argKinds(rec, use));
      return l.defs.length ? l.defs : l.open ? 'unresolved' : null;
    }
    return onReceiver(recvAt(rec, dot - 1, depth), use.name, use.argc, argKinds(rec, use));
  }

  // ---- the contract ----------------------------------------------------------------------

  const scopeNote = () => `C# callers from syntax only: ${scope}${skipped + notIndexed ? `, ${skipped + notIndexed} C# file(s) not indexed${skipped ? ` (${skipped} unreadable or over ${MAX_FILE_BYTES / 1024 / 1024} MiB)` : ''}` : ''}${partial ? '; the SDK\'s implicit usings are assumed (the web SDK\'s)' : ''}; calls through an interface or an override, extension methods, method groups, reflection and receivers whose type is not written are not resolved`;

  /** @param {string} file @param {number|undefined} pos @param {string|null} className @param {string} name @returns {DefRec|null} */
  function targetDef(file, pos, className, name) {
    const rec = byFile.get(file);
    if (!rec) return null;
    const at = pos != null ? rec.byPos.get(pos) : undefined;
    if (at) return at;
    return rec.defs.find((d) => d.name === name && (d.type ? d.type.simple : null) === (className || null)) || null;
  }

  /** @param {DefRec} def @returns {Array<{ rec: FileRec, use: Use }>} */
  const usesOf = (def) => (def.member === 'constructor' || def.member === 'primary-constructor'
    ? [...(usesByName.get(`new ${def.name}`) || []), ...(usesByName.get('new <this>') || []), ...(usesByName.get('new <base>') || []), ...(usesByName.get('new <new()>') || [])]
    : usesByName.get(def.name) || []);

  // Counts for the verification harness: methods hit by the undeclared-base rule (C-D5).
  const undeclaredBase = new Set();

  /**
   * Why `def`'s callers may be more than its direct calls: dispatch through an interface or a
   * base it implements or overrides, a base the index does not declare.
   * @param {DefRec} def @returns {string[]}
   */
  function dispatchReasons(def) {
    /** @type {string[]} */
    const out = [];
    const t = def.type;
    if (!t) return out;
    if (def.inInterface) { out.push(`a member of the interface \`${t.simple}\`: calls through it reach its implementations, and calls written on an implementation are not listed here`); return out; }
    if (def.explicit) { out.push(`an explicit implementation of \`${def.explicit}\`: it is called through that interface, which is not followed yet`); return out; }
    if (def.mods.has('static')) return out;
    const h = hierarchy(t);
    /** @type {string[]} */
    const via = [];
    for (const x of h.types.slice(1)) {
      if (x.kind === 'interface') continue;
      const same = (x.methods.get(def.name) || []).some((m) => m.paramKey === def.paramKey);
      if (same) via.push(x.simple);
    }
    /** @type {string[]} */
    const derivedVia = [];
    for (const m of interfaceMembersFor(def)) {
      if (m.through === t) { if (!via.includes(m.iface.simple)) via.push(m.iface.simple); }
      else if (!derivedVia.includes(`\`${m.iface.simple}\` (through \`${m.through.simple}\`)`)) derivedVia.push(`\`${m.iface.simple}\` (through \`${m.through.simple}\`)`);
    }
    if (via.length) out.push(`implements or overrides a member of ${via.map((v) => `\`${v}\``).join(', ')}: calls through ${via.length > 1 ? 'them' : 'it'} are not listed yet`);
    if (derivedVia.length) out.push(`may implement a member of ${derivedVia.join(', ')}, a type derived from \`${t.simple}\`: calls through it are not listed yet`);
    const pubInst = def.member === 'method' && def.mods.has('public') && !t.sealed;
    const derivedOutside = pubInst ? [...new Set(derivedOf(t).flatMap((x) => hierarchy(x).outside.filter((o) => !h.outside.includes(o)).map((o) => `\`${o}\` (of \`${x.simple}\`)`)))] : [];
    if (derivedOutside.length) out.push(`may implement a member of ${derivedOutside.slice(0, 3).join(', ')}${derivedOutside.length > 3 ? ', …' : ''}, not in the indexed files, through a type derived from \`${t.simple}\``);
    if (def.mods.has('override')) out.push('an override: calls written on its base type may run it and are not listed');
    else if ((def.mods.has('virtual') || def.mods.has('abstract')) && !t.sealed) out.push('virtual: a call listed here may run an override');
    const pub = def.mods.has('public') || def.mods.has('protected');
    if (pub && h.outside.length && !via.length) {
      undeclaredBase.add(def);
      out.push(`may be called through \`${h.outside[0]}\`, which is not in the indexed files`);
    }
    return out;
  }

  // Cache: indexed types derived from each type, transitively (owner, lifetime: the index's).
  /** @type {Map<TypeRec, TypeRec[]>|null} */
  let derivedIndex = null;

  /** @param {TypeRec} t @returns {TypeRec[]} The indexed types whose hierarchy holds `t` (not `t` itself). */
  function derivedOf(t) {
    if (!derivedIndex) {
      derivedIndex = new Map();
      const all = new Set(typesByKey.values());
      for (const rec of byFile.values()) for (const ft of rec.fileTypes.values()) all.add(ft);
      for (const x of all) {
        for (const b of hierarchy(x).types.slice(1)) {
          let list = derivedIndex.get(b);
          if (!list) { list = []; derivedIndex.set(b, list); }
          list.push(x);
        }
      }
    }
    return derivedIndex.get(t) || [];
  }

  /**
   * The indexed interface members a public instance method may implement (B4; C8b lists the
   * calls through them): a member of the same name and parameter count in an interface of the
   * method's type's hierarchy, or — for a class that is not sealed — of an indexed type derived
   * from it (a derived class may implement an interface with an inherited method). Parameter
   * types are not compared: generic parameters (`IHandler<T>.Handle(T)`), aliases and
   * spellings (`System.String`, `int?`) would need a binder, so the match errs towards more.
   * `through`: the type whose hierarchy holds the interface (the method's own type or a derived
   * one).
   * @param {DefRec} def @returns {Array<{ iface: TypeRec, member: DefRec, through: TypeRec }>}
   */
  function interfaceMembersFor(def) {
    const t = def.type;
    /** @type {Array<{ iface: TypeRec, member: DefRec, through: TypeRec }>} */
    const out = [];
    if (!t || def.inInterface || def.explicit || def.mods.has('static') || def.member !== 'method') return out;
    // An implicit implementation is public; a type's own interfaces are checked for any access
    // so a private method of the name is incomplete too (it cannot implement, but errs safe).
    const throughs = [t, ...(def.mods.has('public') && !t.sealed ? derivedOf(t) : [])];
    const seen = new Set();
    for (const x of throughs) {
      for (const i of hierarchy(x).types) {
        if (i.kind !== 'interface' || i === t) continue;
        for (const m of i.methods.get(def.name) || []) {
          if (m.params.length !== def.params.length || seen.has(m)) continue;
          seen.add(m);
          out.push({ iface: i, member: m, through: x });
        }
      }
    }
    return out;
  }

  /**
   * @param {{ file: string, className?: string|null, name: string, pos?: number }} target
   * @returns {{ callers: import('../types').SyntacticCaller[], incompleteReason: string|null }}
   */
  function callersOfWithStatus(target) {
    const def = targetDef(target.file, target.pos, target.className || null, target.name);
    /** @type {string[]} */
    const reasons = [];
    if (partial) reasons.push(scopeNote(), 'the files outside the pull request were not read');
    if (!def) return { callers: [], incompleteReason: [scopeNote(), 'the member was not found in the indexed files'].join('; ') };
    if (def.member === 'property' || def.member === 'indexer' || def.member === 'operator' || def.member === 'conversion' || def.member === 'top-level') {
      return { callers: [], incompleteReason: [...reasons, `not computed: callers of a C# ${def.member === 'top-level' ? 'file\'s top-level statements' : def.member} are not searched yet`].join('; ') };
    }
    /** @type {Map<string, import('../types').SyntacticCaller>} */
    const out = new Map();
    let valueUses = 0;
    let ambiguous = 0;
    for (const { rec, use } of usesOf(def)) {
      const hit = resolveUse(rec, use);
      if (!hit || typeof hit === 'string' || !hit.includes(def)) continue;
      if (use.kind === 'ref') { valueUses++; continue; }
      if (hit.length > 1) ambiguous++;
      const owner = innermostDef(rec, use.pos);
      const t = owner ? null : innermostType(rec, use.pos);
      const pos = owner ? owner.namePos : t ? t.namePos : 0;
      const id = `${rec.file}#${pos}`;
      let row = out.get(id);
      if (!row) {
        row = { file: rec.file, label: owner ? owner.label : t ? t.path.join('.').replace(/`(\d+)/g, '<$1>') : path.posix.basename(rec.rel), pos, callSites: [] };
        out.set(id, row);
      }
      row.callSites.push({ start: use.pos, end: use.end });
    }
    reasons.push(...dispatchReasons(def));
    if (def.extension) reasons.push('an extension method: calls written as `x.' + def.name + '(…)` are not resolved yet');
    if (def.mods.has('partial') || (def.type && def.type.generated) || def.attributes.some((a) => GENERATED_ATTRIBUTES.has(a.replace(/Attribute$/, '')))) reasons.push('generated or partial members are not read');
    const isCtor = def.member === 'constructor' || def.member === 'primary-constructor';
    if (isCtor && def.type) {
      if (def.min === 0 && !def.type.sealed && def.type.kind !== 'struct') reasons.push('a constructor without arguments: a derived constructor\'s implicit base call is not listed');
      if (def.member === 'primary-constructor' && def.type.kind === 'record') reasons.push('a record\'s primary constructor: deconstruction, `with` and patterns are not followed');
      if (/Attribute$/.test(def.type.simple)) reasons.push('attribute usages are not read');
      const target = (usesByName.get('new <new()>') || []).filter(({ rec, use }) => arityMatches(def, use.argc) && resolveUse(rec, use) === 'unresolved').length;
      if (target) reasons.push(`${target} target-typed \`new(…)\` call(s) whose type is not written`);
    }
    if (def.file.ui && !def.mods.has('private')) reasons.push('Razor/XAML calls are not read');
    const inIf = hiddenInIf.get(def.name) || 0;
    if (inIf) reasons.push(`${inIf} use(s) of the name \`${def.name}\` in code under an inactive \`#if\` branch (read with no symbols defined): calls there are not resolved`);
    const inSkipped = hiddenInSkipped.get(def.name) || 0;
    if (inSkipped) reasons.push(`${inSkipped} use(s) of the name \`${def.name}\` in C# file(s) that were not indexed (over ${MAX_FILE_BYTES / 1024 / 1024} MiB, or not readable as C#)`);
    if (!partial && unreadSkipped + notIndexed) reasons.push(`${unreadSkipped + notIndexed} C# file(s) could not be read: calls there are not seen`);
    if (valueUses) reasons.push(`used as a method group ${valueUses} time(s): calls through that delegate cannot be followed`);
    if (ambiguous) reasons.push(`${ambiguous} call(s) match several overloads with the same number of arguments: each such call is listed for every one of them`);
    return { callers: [...out.values()], incompleteReason: reasons.length ? reasons.join('; ') : null };
  }

  // Cache: count of unresolved calls by name, built on first use (owner, lifetime: the index's).
  /** @type {Map<string, number>} */
  const unresolvedByName = new Map();
  /** @param {{ name: string }} target @returns {number} */
  function unresolvedCallsTo(target) {
    if (unresolvedByName.has(target.name)) return /** @type {number} */ (unresolvedByName.get(target.name));
    // Uses in code that was not read (inactive `#if` branches, files not indexed) count too.
    let n = (hiddenInIf.get(target.name) || 0) + (hiddenInSkipped.get(target.name) || 0);
    for (const k of [target.name, `new ${target.name}`]) for (const { rec, use } of usesByName.get(k) || []) if (use.kind !== 'ref' && resolveUse(rec, use) === 'unresolved') n++;
    unresolvedByName.set(target.name, n);
    return n;
  }

  /** @param {string} file @param {number} pos @returns {{ className: string|null, name: string }|null} */
  function symbolAt(file, pos) {
    const d = byFile.get(file)?.byPos.get(pos);
    return d ? { className: d.type ? d.type.simple : null, name: d.name } : null;
  }

  /**
   * The declarations the use at `pos` in `file` reaches (for the verification harness).
   * @param {string} file @param {number} pos @returns {Hit|undefined}
   */
  function targetsAt(file, pos) {
    const rec = byFile.get(file);
    const use = rec && (rec.uses || []).find((u) => u.pos === pos);
    return rec && use ? resolveUse(rec, use) : undefined;
  }

  return { symbolAt, callersOfWithStatus, unresolvedCallsTo, size: byFile.size, skipped, scopeNote, byFile, undeclaredBase, targetsAt };
}

/**
 * The SDK implicit usings a project file enables: none unless `<ImplicitUsings>enable</…>`
 * (or `true`); the web SDK's list for `Microsoft.NET.Sdk.Web`.
 * @param {string} csproj @returns {string[]}
 */
function implicitUsingsOf(csproj) {
  if (!/<ImplicitUsings>\s*(enable|true)\s*<\/ImplicitUsings>/i.test(csproj)) return [];
  return /Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(csproj) ? WEB_IMPLICIT_USINGS : IMPLICIT_USINGS;
}

module.exports = { createCsharpSyntacticIndex, implicitUsingsOf, IMPLICIT_USINGS, WEB_IMPLICIT_USINGS, MAX_FILE_BYTES, MAX_CHAIN_DEPTH, MAX_HIERARCHY };
