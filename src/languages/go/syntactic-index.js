// @ts-check
'use strict';
// Go callers without a language server (docs/MULTI_LANGUAGE_PLAN.md, S4): an index of a set
// of Go files, read from their text alone, implementing S1's `SyntacticIndex` contract
// (src/languages/types.js) for `createSyntacticResolver` (src/engine/resolver-syntactic.js).
//
// Packages. A package is a directory (`package x_test` files in it are a package of their
// own). An import path names an indexed directory through a module (`modules`: each
// `go.mod`'s directory and module path; the CLI reads them) or, without modules (the preview,
// which has no go.mod), under the module path inferred from the imports (`inferredModulePath`):
// `github.com/o/r/pkg/a` names the indexed directory `pkg/a` when `github.com/o/r` is the most
// common prefix of imports that end with an indexed directory. Imports of anything else (other modules, the standard
// library) are not indexed: calls into them are not calls to an indexed function.
// Import bindings: the alias when written, else the imported package's own `package` name
// (from its indexed files), else the path's last element (`v2`-style suffixes skipped).
// `import . "p"`: p's functions are named bare; `import _ "p"` binds nothing.
//
// Declarations: the top-level functions and methods of S3's outline (`goOutline`, keyed as
// `collectGoSymbols` keys them, so a caller row expands in the tree), the top-level types
// (struct fields with their types, embedded fields, interface method names) and package-level
// variables with a written type.
//
// A use resolves to declarations by S-D2 (a):
//   1. `F(` where F is a function of the same package (or of a dot-imported one), not
//      shadowed by a local or parameter of the enclosing function;
//   2. `p.F(` where p is an import binding of an indexed package (not shadowed);
//   3. `x.M(` where x's type is known: the receiver of the enclosing method, a typed
//      parameter, `var x T`, `x := T{…}` / `&T{…}`, `x := F(…)` / `x := p.NewT(…)` through
//      F's (first, or the matching) result type, a package-level variable of a written type,
//      then through struct fields for `s.f.M(` and embedded fields for promoted methods and
//      fields. A pointer and a value receiver are the same type's methods.
// A name declared twice in one function with different types is not typed (scopes inside a
// function are not told apart). `x.M(` whose receiver's type is not known is an unresolved
// call to M (`unresolvedCallsTo`); one through a variable typed as an indexed interface is
// a call through an interface (counted per name). A use of a resolved function without `(`
// (`RunE: runF`, `f := pkg.F`, a method value `x.M`) is a value use.
//
// No answer is complete (CODING_STYLE §1): every `callersOfWithStatus` carries the index's
// scope note (`scopeNote`), plus the target's own reasons: value uses, an interface declaring
// a method of the same name (S-D3 (a): any implementation may be reached through it), other
// build-tag variants of the same function in the package, and (`partialPackages`, the
// preview) the package's files that are not in the index.
//
// Pure: reads only the `{ path, text }` pairs it is given. Budgets (CODING_STYLE §2):
// - files: bounded by its input; the caller chooses them (the preview: the PR's files under
//   `impactTree.tierA.maxFiles`; the CLI: `pickRepositoryFiles`, ../repository-files.js).
// - bytes per file: `MAX_FILE_BYTES` (1 MiB, as Python's). Owner: this module. Enforcement:
//   a longer text is not read. Exhaustion: the file is not indexed, counted in `skipped`,
//   and every answer's scope note says how many files were not indexed.
// - embedded fields: `MAX_EMBED_DEPTH` levels when a method or field is looked up through
//   them; past it the lookup finds nothing (the call counts as unresolved).
// - receiver chains: as long as written (`a.b.c.M(`), one field lookup per element.

const path = require('path');
const { goOutline, skipNonCode } = require('./outline');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EMBED_DEPTH = 8;

const KEYWORDS = new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
  'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch',
  'type', 'var']);
const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

/**
 * @typedef {{ t: 'id'|'op'|'str'|'num'|'nl', v: string, pos: number }} Token
 * @typedef {{ alias: string|null, name: string|null, file: FileRec }} TypeRef A type as
 *   written (`*p.T[X]` is `{ alias: 'p', name: 'T' }`), read in `file`'s imports; `name`
 *   null for a type this does not follow (slices, maps, functions, channels, literals).
 * @typedef {{ name: string, label: string, recvType: string|null, recvName: string|null,
 *   namePos: number, start: number, end: number, file: FileRec, results: TypeRef[],
 *   locals: Map<string, TypeRef|null> }} DefRec `locals`: the function's receiver,
 *   parameters, results and locals, each with its type, or null when not typed (or typed
 *   twice differently).
 * @typedef {{ name: string, kind: 'struct'|'interface'|'other', fields: Map<string, TypeRef>,
 *   embedded: TypeRef[], ifaceMethods: Set<string>, methods: Map<string, DefRec[]>, pkg: PkgRec }} TypeRec
 * @typedef {{ key: string, dir: string, name: string, files: FileRec[], funcs: Map<string, DefRec[]>,
 *   types: Map<string, TypeRec>, vars: Map<string, TypeRef> }} PkgRec
 * @typedef {{ name: string, pos: number, recv: string[]|'?'|null, called: boolean, owner: DefRec|null }} Use
 *   `recv`: the selector chain before `.name` (`a.b` in `a.b.name`), `'?'` when it is not a
 *   chain of names (`f().name`), null for a bare name.
 * @typedef {{ file: string, rel: string, dir: string, pkgName: string, pkg: PkgRec|null,
 *   imports: Array<{ alias: string|null, path: string }>, bindings: Map<string, PkgRec|null>|null,
 *   dots: PkgRec[], defs: DefRec[], byPos: Map<number, DefRec>, uses: Use[],
 *   rawTypes: Array<{ name: string, kind: TypeRec['kind'], fields: Map<string, TypeRef>, embedded: TypeRef[], ifaceMethods: Set<string> }>,
 *   rawVars: Map<string, TypeRef> }} FileRec
 */

/**
 * The tokens of a Go text: names, strings (with runes and raw strings), numbers, one-
 * character operators (`:=` and `...` as one), and newlines (`nl`, which end statements and
 * the entries of a `var (…)` block). Comments are dropped; a block comment with a newline in
 * it is a newline. Bound: one pass over `text`. An unterminated literal ends the tokens.
 * @param {string} text
 * @returns {Token[]}
 */
function goTokens(text) {
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const skipped = skipNonCode(text, i);
    if (skipped < 0) break;
    if (skipped > i) {
      if (text[i] === '/') { if (text[i + 1] === '*' && text.slice(i, skipped).includes('\n')) out.push({ t: 'nl', v: '\n', pos: i }); }
      else out.push({ t: 'str', v: text.slice(i, skipped), pos: i });
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '\n') { out.push({ t: 'nl', v: '\n', pos: i }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(text[j])) j++;
      out.push({ t: 'id', v: text.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      out.push({ t: 'num', v: text.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === ':' && text[i + 1] === '=') { out.push({ t: 'op', v: ':=', pos: i }); i += 2; continue; }
    if (c === '.' && text[i + 1] === '.' && text[i + 2] === '.') { out.push({ t: 'op', v: '...', pos: i }); i += 3; continue; }
    out.push({ t: 'op', v: c, pos: i });
    i++;
  }
  return out;
}

/** @param {Token[]} toks @param {number} open @returns {number} The index of the bracket closing `toks[open]`, or toks.length. */
function closeIndex(toks, open) {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const v = toks[k].t === 'op' ? toks[k].v : '';
    if (v === '(' || v === '[' || v === '{') depth++;
    else if ((v === ')' || v === ']' || v === '}') && --depth === 0) return k;
  }
  return toks.length;
}

/**
 * A type as written, from tokens `toks[k..]`: `T`, `*T`, `p.T`, `*p.T[A, B]`. Null name for
 * anything else (`[]T`, `map[…]`, `func(…)`, `chan`, `struct{…}`, `...T`).
 * @param {Token[]} toks @param {number} k @param {FileRec} file
 * @returns {{ ref: TypeRef, end: number }} `end`: the index after the type's name (and type
 *   arguments); `k` when there is no name.
 */
function typeAt(toks, k, file) {
  let i = k;
  while (toks[i] && toks[i].v === '*') i++;
  const a = toks[i];
  if (!a || a.t !== 'id' || KEYWORDS.has(a.v)) return { ref: { alias: null, name: null, file }, end: k };
  if (toks[i + 1] && toks[i + 1].v === '.' && toks[i + 2] && toks[i + 2].t === 'id') {
    let end = i + 3;
    if (toks[end] && toks[end].v === '[') end = closeIndex(toks, end) + 1;
    return { ref: { alias: a.v, name: toks[i + 2].v, file }, end };
  }
  let end = i + 1;
  if (toks[end] && toks[end].v === '[') end = closeIndex(toks, end) + 1;
  return { ref: { alias: null, name: a.v, file }, end };
}

/**
 * The entries of a parenthesised list `toks[open]` … its `)`: parameters (`a, b T`, `T`) as
 * `[name|null, type tokens start, end]`. Names without a type take the next written type, as
 * Go reads them.
 * @param {Token[]} toks @param {number} open
 * @returns {Array<{ name: string|null, typeStart: number, typeEnd: number }>}
 */
function paramEntries(toks, open) {
  const close = closeIndex(toks, open);
  /** @type {Array<[number, number]>} */
  const parts = [];
  let start = open + 1;
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const v = toks[k].v;
    if (toks[k].t === 'op' && (v === '(' || v === '[' || v === '{')) depth++;
    else if (toks[k].t === 'op' && (v === ')' || v === ']' || v === '}')) depth--;
    else if (v === ',' && depth === 0) { parts.push([start, k]); start = k + 1; }
  }
  if (start < close) parts.push([start, close]);
  const entries = parts.map(([s, e]) => {
    while (s < e && toks[s].t === 'nl') s++;
    const named = e - s >= 2 && toks[s].t === 'id' && !KEYWORDS.has(toks[s].v) && toks[s + 1].v !== '.' && toks[s + 1].t !== 'nl';
    return named ? { name: toks[s].v, typeStart: s + 1, typeEnd: e, bare: false } : { name: null, typeStart: s, typeEnd: e, bare: e - s === 1 && toks[s].t === 'id' };
  });
  // `a, b int`: a bare name before a named entry is a name of that entry's type.
  if (entries.some((x) => x.name !== null)) {
    for (let k = entries.length - 1, typeFrom = null; k >= 0; k--) {
      const x = entries[k];
      if (x.name !== null) typeFrom = x;
      else if (x.bare && typeFrom) entries[k] = { name: toks[x.typeStart].v, typeStart: typeFrom.typeStart, typeEnd: typeFrom.typeEnd, bare: false };
    }
  }
  return entries;
}

/**
 * The type of the expression starting at `toks[k]` when it is one S-D2 (a) reads: `T{`,
 * `&T{`, `p.T{`, `F(`, `p.F(` (a call: its result types, `which` is the left-hand position).
 * @param {Token[]} toks @param {number} k @param {FileRec} file
 * @returns {{ ref: TypeRef }|{ call: { alias: string|null, name: string }, which: number }|null}
 */
function rhsType(toks, k, file) {
  let i = k;
  if (toks[i] && toks[i].v === '&') i++;
  const { ref, end } = typeAt(toks, i, file);
  if (!ref.name) return null;
  const next = toks[end];
  if (next && next.v === '{') return { ref };
  if (next && next.v === '(' && toks[i].v !== '*' && toks[k].v !== '&') return { call: { alias: ref.alias, name: ref.name }, which: 0 };
  return null;
}

/** @param {Token[]} toks @param {number} pos @returns {number} The index of the first token at or after `pos` (binary search). */
function tokenAt(toks, pos) {
  let lo = 0;
  let hi = toks.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (toks[mid].pos < pos) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * The index; see the file comment.
 * @param {Array<{ path: string, text: string }>} sources Repository-relative paths and texts.
 * @param {{ root?: string, scope?: string, notIndexed?: number, modules?: Array<{ dir: string, path: string }>,
 *   partialPackages?: boolean }} [options] `root`: joined to each path to give the files'
 *   keys (the engine's absolute paths); `scope`: what was indexed, in words, for the scope
 *   note; `notIndexed`: files the caller left out, said in it; `modules`: each module's
 *   repository-relative directory (`''` for the root) and module path (absent: import paths
 *   are matched by suffix); `partialPackages`: the packages' other files may be missing (the
 *   preview), said in every answer.
 * @returns {import('../types').SyntacticIndex & { skipped: number, scopeNote: () => string, byFile: Map<string, FileRec> }}
 */
function createGoSyntacticIndex(sources, { root = '', scope = 'the indexed files', notIndexed = 0, modules, partialPackages = false } = {}) {
  /** @type {Map<string, FileRec>} */
  const byFile = new Map();
  /** @type {Map<string, PkgRec>} */
  const packages = new Map();
  let skipped = 0;
  const fileKey = (/** @type {string} */ rel) => (root ? path.join(root, rel) : rel);

  // Pass 1: every function and method name, so pass 2 records only uses that may reach one.
  /** @type {Set<string>} */
  const known = new Set();
  const kept = [];
  for (const s of sources) {
    if (typeof s.text !== 'string' || s.text.length > MAX_FILE_BYTES) { skipped++; continue; }
    kept.push(s);
    for (const m of s.text.matchAll(/^func[ \t]*(?:\([^)]*\)[ \t]*)?([\p{L}_][\p{L}\p{N}_]*)/gmu)) known.add(m[1]);
  }
  for (const s of kept) {
    const rec = parseFile(s.path, s.text);
    byFile.set(rec.file, rec);
  }
  // Packages, then their types, methods and variables.
  for (const rec of byFile.values()) {
    const key = `${rec.dir}${rec.pkgName.endsWith('_test') ? ':test' : ''}`;
    if (!packages.has(key)) packages.set(key, { key, dir: rec.dir, name: rec.pkgName, files: [], funcs: new Map(), types: new Map(), vars: new Map() });
    const pkg = /** @type {PkgRec} */ (packages.get(key));
    if (!rec.pkgName.endsWith('_test')) pkg.name = rec.pkgName;
    pkg.files.push(rec);
    rec.pkg = pkg;
    for (const t of rec.rawTypes) if (!pkg.types.has(t.name)) pkg.types.set(t.name, { ...t, methods: new Map(), pkg });
    for (const [name, ref] of rec.rawVars) if (!pkg.vars.has(name)) pkg.vars.set(name, ref);
  }
  for (const rec of byFile.values()) {
    const pkg = /** @type {PkgRec} */ (rec.pkg);
    for (const d of rec.defs) {
      if (d.recvType) {
        if (!pkg.types.has(d.recvType)) pkg.types.set(d.recvType, { name: d.recvType, kind: 'other', fields: new Map(), embedded: [], ifaceMethods: new Set(), methods: new Map(), pkg });
        const t = /** @type {TypeRec} */ (pkg.types.get(d.recvType));
        if (!t.methods.has(d.name)) t.methods.set(d.name, []);
        /** @type {DefRec[]} */ (t.methods.get(d.name)).push(d);
      } else {
        if (!pkg.funcs.has(d.name)) pkg.funcs.set(d.name, []);
        /** @type {DefRec[]} */ (pkg.funcs.get(d.name)).push(d);
      }
    }
  }
  /** @type {Map<string, string[]>} Interface method name → the interfaces declaring it (`p.I`). */
  const interfacesByMethod = new Map();
  for (const pkg of packages.values()) {
    for (const t of pkg.types.values()) {
      for (const m of t.ifaceMethods) {
        if (!interfacesByMethod.has(m)) interfacesByMethod.set(m, []);
        /** @type {string[]} */ (interfacesByMethod.get(m)).push(`${pkg.name}.${t.name}`);
      }
    }
  }
  /** @type {Set<string>} Every method name of an indexed type, for `unresolvedCallsTo`. */
  const methodNames = new Set();
  for (const pkg of packages.values()) for (const t of pkg.types.values()) for (const m of t.methods.keys()) methodNames.add(m);

  /** @param {string} rel @param {string} text @returns {FileRec} */
  function parseFile(rel, text) {
    const slashed = rel.split(path.sep).join('/');
    const toks = goTokens(text);
    const pkgAt = toks.findIndex((t) => t.t === 'id' && t.v === 'package');
    /** @type {FileRec} */
    const rec = {
      file: fileKey(rel), rel: slashed, dir: path.posix.dirname(slashed),
      pkgName: pkgAt >= 0 && toks[pkgAt + 1] ? toks[pkgAt + 1].v : '',
      pkg: null, imports: [], bindings: null, dots: [], defs: [], byPos: new Map(), uses: [], rawTypes: [], rawVars: new Map(),
    };
    const symbols = goOutline(text);
    let s = 0;
    // Top-level declarations outside the functions: imports, types, package-level variables.
    let depth = 0;
    for (let k = 0; k < toks.length; k++) {
      const tok = toks[k];
      while (s < symbols.length && symbols[s].range.end <= tok.pos) s++;
      if (s < symbols.length && symbols[s].range.start <= tok.pos) continue; // inside a function
      if (tok.t === 'op' && (tok.v === '(' || tok.v === '[' || tok.v === '{')) { depth++; continue; }
      if (tok.t === 'op' && (tok.v === ')' || tok.v === ']' || tok.v === '}')) { depth = Math.max(0, depth - 1); continue; }
      if (depth !== 0 || tok.t !== 'id') continue;
      if (tok.v === 'import') k = readImports(toks, k + 1, rec) - 1;
      else if (tok.v === 'type') k = readGroup(toks, k + 1, (a) => readTypeSpec(toks, a, rec)) - 1;
      else if (tok.v === 'var') k = readGroup(toks, k + 1, (a) => readVarSpec(toks, a, rec, rec.rawVars)) - 1;
    }
    for (const sym of symbols) rec.defs.push(readDef(text, toks, sym, rec));
    for (const d of rec.defs) rec.byPos.set(d.namePos, d);
    recordUses(toks, rec);
    return rec;
  }

  /**
   * Reads `import "p"`, `import a "p"` and `import ( … )` from `toks[k]`.
   * @param {Token[]} toks @param {number} k @param {FileRec} rec @returns {number} The index after them.
   */
  function readImports(toks, k, rec) {
    const one = (/** @type {number} */ a) => {
      let alias = null;
      if (toks[a] && (toks[a].t === 'id' || toks[a].v === '.')) { alias = toks[a].v; a++; }
      if (toks[a] && toks[a].t === 'str') rec.imports.push({ alias, path: toks[a].v.slice(1, -1) });
      return a + 1;
    };
    if (toks[k] && toks[k].v === '(') {
      const close = closeIndex(toks, k);
      for (let a = k + 1; a < close; a++) if (toks[a].t !== 'nl' && toks[a].v !== ';') a = one(a) - 1;
      return close + 1;
    }
    return one(k);
  }

  /**
   * One spec, or each spec of a `( … )` group, from `toks[k]`; `readSpec` reads one from its
   * first token and returns the index after it.
   * @param {Token[]} toks @param {number} k @param {(at: number) => number} readSpec @returns {number}
   */
  function readGroup(toks, k, readSpec) {
    if (toks[k] && toks[k].v === '(') {
      const close = closeIndex(toks, k);
      let a = k + 1;
      while (a < close) {
        if (toks[a].t === 'nl' || toks[a].v === ';') { a++; continue; }
        a = Math.max(a + 1, readSpec(a));
      }
      return close + 1;
    }
    return readSpec(k);
  }

  /** @param {Token[]} toks @param {number} k @returns {number} The index of the end of the statement at `k` (a newline or `;` outside brackets). */
  function statementEnd(toks, k) {
    let depth = 0;
    for (let a = k; a < toks.length; a++) {
      const v = toks[a].v;
      if (toks[a].t === 'op' && (v === '(' || v === '[' || v === '{')) depth++;
      else if (toks[a].t === 'op' && (v === ')' || v === ']' || v === '}')) { if (--depth < 0) return a; }
      else if (depth === 0 && (toks[a].t === 'nl' || v === ';')) return a;
    }
    return toks.length;
  }

  /**
   * `T struct { … }`, `I interface { … }`, `T U`, `T = U` at `toks[k]`.
   * @param {Token[]} toks @param {number} k @param {FileRec} rec @returns {number}
   */
  function readTypeSpec(toks, k, rec) {
    const end = statementEnd(toks, k);
    const nameTok = toks[k];
    if (!nameTok || nameTok.t !== 'id') return end;
    let a = k + 1;
    if (toks[a] && toks[a].v === '[' && !(toks[a + 1] && toks[a + 1].v === ']')) a = closeIndex(toks, a) + 1; // type parameters
    const kw = toks[a] && toks[a].v;
    /** @type {FileRec['rawTypes'][number]} */
    const t = { name: nameTok.v, kind: 'other', fields: new Map(), embedded: [], ifaceMethods: new Set() };
    if ((kw === 'struct' || kw === 'interface') && toks[a + 1] && toks[a + 1].v === '{') {
      t.kind = kw;
      const close = closeIndex(toks, a + 1);
      let b = a + 2;
      while (b < close) {
        if (toks[b].t === 'nl' || toks[b].v === ';') { b++; continue; }
        const lineEnd = Math.min(statementEnd(toks, b), close);
        if (kw === 'interface') {
          if (toks[b].t === 'id' && toks[b + 1] && toks[b + 1].v === '(') t.ifaceMethods.add(toks[b].v);
        } else {
          readField(toks, b, lineEnd, rec, t);
        }
        b = lineEnd + 1;
      }
    }
    rec.rawTypes.push(t);
    return end;
  }

  /**
   * One struct field line (`a, b T`, `*E`, `p.E`, a tag after it) between `b` and `end`.
   * @param {Token[]} toks @param {number} b @param {number} end @param {FileRec} rec @param {FileRec['rawTypes'][number]} t
   */
  function readField(toks, b, end, rec, t) {
    const names = [];
    let a = b;
    while (a < end && toks[a].t === 'id' && toks[a + 1] && toks[a + 1].v === ',') { names.push(toks[a].v); a += 2; }
    if (!toks[a]) return;
    const embedded = !names.length && (toks[a].v === '*' || (toks[a].t === 'id' && (a + 1 >= end || toks[a + 1].t === 'str' || toks[a + 1].v === '.')));
    if (embedded) {
      const { ref } = typeAt(toks, a, rec);
      if (ref.name) { t.embedded.push(ref); t.fields.set(ref.name, ref); }
      return;
    }
    if (!toks[a] || toks[a].t !== 'id') return;
    names.push(toks[a].v);
    const { ref } = typeAt(toks, a + 1, rec);
    for (const n of names) t.fields.set(n, ref);
  }

  /**
   * `x T`, `x, y T`, `x = rhs`, `x T = rhs` at `toks[k]`, into `into` (name → type).
   * @param {Token[]} toks @param {number} k @param {FileRec} rec @param {Map<string, TypeRef|null>} into
   * @returns {number}
   */
  function readVarSpec(toks, k, rec, into) {
    const end = statementEnd(toks, k);
    const names = [];
    let a = k;
    while (a < end && toks[a].t === 'id') {
      names.push(toks[a].v);
      if (toks[a + 1] && toks[a + 1].v === ',') a += 2; else { a++; break; }
    }
    if (!names.length) return end;
    /** @type {TypeRef|null} */
    let ref = null;
    if (toks[a] && toks[a].v !== '=') {
      const typed = typeAt(toks, a, rec);
      ref = typed.ref.name ? typed.ref : null;
    }
    const assigned = !!toks[a] && toks[a].v === '=';
    names.forEach((n, i) => setLocal(into, n, assigned ? refOfRhs(toks, a + 1, rec, i, names.length) : ref));
    return end;
  }

  /**
   * The type of the `which`-th left-hand name assigned from the expression at `toks[k]`.
   * A call's result is kept as a pending reference (`call:`), resolved once every file is read.
   * @param {Token[]} toks @param {number} k @param {FileRec} rec @param {number} which @param {number} count
   * @returns {TypeRef|null}
   */
  function refOfRhs(toks, k, rec, which, count) {
    const r = rhsType(toks, k, rec);
    if (!r) return null;
    if ('ref' in r) return count === 1 ? r.ref : null;
    return /** @type {any} */ ({ alias: r.call.alias, name: null, file: rec, call: r.call.name, which });
  }

  /** @param {Map<string, TypeRef|null>} into @param {string} name @param {TypeRef|null} ref */
  function setLocal(into, name, ref) {
    if (name === '_') return;
    if (!into.has(name)) { into.set(name, ref); return; }
    const prev = into.get(name);
    if (!sameRef(prev, ref)) into.set(name, null);
  }

  /** @param {TypeRef|null|undefined} a @param {TypeRef|null|undefined} b */
  function sameRef(a, b) {
    if (!a || !b) return false;
    return a.alias === b.alias && a.name === b.name && /** @type {any} */ (a).call === /** @type {any} */ (b).call
      && /** @type {any} */ (a).which === /** @type {any} */ (b).which;
  }

  /**
   * A function's record: its name, receiver, parameters, results and locals with their types.
   * @param {string} text @param {Token[]} toks @param {import('../types').ServerSymbol} sym @param {FileRec} rec
   * @returns {DefRec}
   */
  function readDef(text, toks, sym, rec) {
    const { start, end } = sym.range;
    const name = text.slice(sym.selectionRange.start, sym.selectionRange.end);
    const recvMatch = /^\(\*?\s*([^)[\s]+)/.exec(sym.name);
    /** @type {DefRec} */
    const def = {
      name, label: sym.name, recvType: sym.name.startsWith('(') && recvMatch ? recvMatch[1] : null, recvName: null,
      namePos: sym.selectionRange.start, start, end, file: rec, results: [], locals: new Map(),
    };
    let k = tokenAt(toks, start);
    if (k >= toks.length) return def;
    const last = tokenAt(toks, end);
    k++; // past `func`
    if (toks[k] && toks[k].v === '(') {
      const [recv] = paramEntries(toks, k);
      if (recv && recv.name) { def.recvName = recv.name; setLocal(def.locals, recv.name, typeAt(toks, recv.typeStart, rec).ref); }
      k = closeIndex(toks, k) + 1;
    }
    k++; // the name
    if (toks[k] && toks[k].v === '[') k = closeIndex(toks, k) + 1;
    if (!toks[k] || toks[k].v !== '(') return def;
    for (const p of paramEntries(toks, k)) if (p.name) setLocal(def.locals, p.name, typedOrNull(toks, p, rec));
    k = closeIndex(toks, k) + 1;
    // Results: one type, or a list (named or not).
    if (toks[k] && toks[k].v === '(') {
      for (const r of paramEntries(toks, k)) {
        def.results.push(typedOrNull(toks, r, rec) || { alias: null, name: null, file: rec });
        if (r.name) setLocal(def.locals, r.name, typedOrNull(toks, r, rec));
      }
    } else if (toks[k] && toks[k].v !== '{') {
      def.results.push(typeAt(toks, k, rec).ref);
    }
    readLocals(toks, k, last, rec, def.locals);
    return def;
  }

  /** @param {Token[]} toks @param {{ typeStart: number, typeEnd: number }} p @param {FileRec} rec @returns {TypeRef|null} */
  function typedOrNull(toks, p, rec) {
    const { ref, end } = typeAt(toks, p.typeStart, rec);
    return ref.name && end === p.typeEnd ? ref : null;
  }

  /**
   * The locals a function body declares (function literals' parameters included): `x := …`,
   * `x, y := …`, `var x T`, `for k, v := range` (untyped), each typed when S-D2 (a) reads it.
   * @param {Token[]} toks @param {number} from @param {number} to @param {FileRec} rec @param {Map<string, TypeRef|null>} into
   */
  function readLocals(toks, from, to, rec, into) {
    for (let k = from; k < to; k++) {
      const tok = toks[k];
      if (tok.v === ':=' && tok.t === 'op') {
        const names = [];
        let a = k - 1;
        while (a >= from && toks[a].t === 'id') {
          names.unshift(toks[a].v);
          if (toks[a - 1] && toks[a - 1].v === ',') a -= 2; else break;
        }
        const isRange = toks[k + 1] && toks[k + 1].v === 'range';
        names.forEach((n, i) => setLocal(into, n, isRange ? null : refOfRhs(toks, k + 1, rec, i, names.length)));
      } else if (tok.t === 'id' && tok.v === 'var') {
        k = readGroup(toks, k + 1, (a) => readVarSpec(toks, a, rec, into)) - 1;
      } else if (tok.t === 'id' && tok.v === 'func' && toks[k + 1] && toks[k + 1].v === '(') {
        for (const p of paramEntries(toks, k + 1)) if (p.name) setLocal(into, p.name, typedOrNull(toks, p, rec));
      }
    }
  }

  /**
   * Records every use of a known function or method name in the file: whether it is called,
   * its selector chain, and the enclosing top-level function. Names inside an `interface { … }`
   * and the declarations' own names are not uses; nor is a key in a composite literal.
   * @param {Token[]} toks @param {FileRec} rec
   */
  function recordUses(toks, rec) {
    let d = 0;
    let skipUntil = -1;
    for (let k = 0; k < toks.length; k++) {
      const tok = toks[k];
      if (k < skipUntil) continue;
      if (tok.t === 'id' && tok.v === 'interface' && toks[k + 1] && toks[k + 1].v === '{') { skipUntil = closeIndex(toks, k + 1); continue; }
      if (tok.t !== 'id' || !known.has(tok.v) || rec.byPos.has(tok.pos)) continue;
      while (d < rec.defs.length && rec.defs[d].end <= tok.pos) d++;
      const owner = d < rec.defs.length && rec.defs[d].start <= tok.pos ? rec.defs[d] : null;
      const prev = toks[k - 1];
      /** @type {string[]|'?'|null} */
      let recv = null;
      if (prev && prev.v === '.' && prev.t === 'op') {
        const chain = [];
        let a = k - 1;
        while (toks[a] && toks[a].v === '.' && toks[a].t === 'op') {
          const before = toks[a - 1];
          if (before && before.v === ')' && before.t === 'op' && !chain.length) {
            // `F(…).M(` / `p.F(…).M(`: typed by F's first result, as `x := F(…)` is.
            const call = callBefore(toks, a - 1);
            if (call) chain.push('()', call.alias || '', call.name);
            break;
          }
          if (!before || before.t !== 'id') { chain.length = 0; break; }
          chain.unshift(before.v);
          a -= 2;
        }
        recv = chain.length ? chain : '?';
      } else if (prev && prev.t === 'id' && (prev.v === 'func' || prev.v === 'package')) continue;
      let after = k + 1;
      if (toks[after] && toks[after].v === '[' && toks[after].t === 'op') after = closeIndex(toks, after) + 1;
      const next = toks[after];
      const called = !!next && next.v === '(' && next.t === 'op';
      if (!called && recv === null && next && next.v === ':' && next.t === 'op') continue; // a key or a label
      rec.uses.push({ name: tok.v, pos: tok.pos, recv, called, owner });
    }
  }

  /**
   * The function called by the parenthesised arguments that end at `toks[close]`: `F` or
   * `p.F` before the matching `(`, or null for anything else.
   * @param {Token[]} toks @param {number} close @returns {{ alias: string|null, name: string }|null}
   */
  function callBefore(toks, close) {
    let depth = 0;
    let k = close;
    for (; k >= 0; k--) {
      const v = toks[k].t === 'op' ? toks[k].v : '';
      if (v === ')' || v === ']' || v === '}') depth++;
      else if ((v === '(' || v === '[' || v === '{') && --depth === 0) break;
    }
    if (k <= 0 || toks[k].v !== '(') return null;
    const name = toks[k - 1];
    if (!name || name.t !== 'id' || KEYWORDS.has(name.v)) return null;
    const dot = toks[k - 2];
    if (dot && dot.v === '.' && dot.t === 'op') {
      const alias = toks[k - 3];
      if (!alias || alias.t !== 'id' || (toks[k - 4] && toks[k - 4].v === '.')) return null;
      return { alias: alias.v, name: name.v };
    }
    return { alias: null, name: name.v };
  }

  // Import bindings, per file, once every package is known.
  /** @param {string} importPath @returns {PkgRec|null} */
  function packageOfImport(importPath) {
    /** @type {string|null} */
    let dir = null;
    if (modules && modules.length) {
      for (const m of modules) {
        if (importPath === m.path) dir = m.dir || '.';
        else if (importPath.startsWith(`${m.path}/`)) dir = path.posix.join(m.dir || '.', importPath.slice(m.path.length + 1));
        if (dir) break;
      }
    } else {
      const prefix = inferredModulePath();
      dir = prefix !== null && importPath.startsWith(`${prefix}/`) ? importPath.slice(prefix.length + 1) : null;
    }
    return dir ? packages.get(dir) || null : null;
  }

  /** @param {string} importPath @returns {string|null} The longest indexed directory `importPath` ends with. */
  function suffixDir(importPath) {
    let best = '';
    for (const p of packages.values()) {
      if (p.key.endsWith(':test') || p.dir === '.') continue;
      if (importPath.endsWith(`/${p.dir}`) && p.dir.length > best.length) best = p.dir;
    }
    return best || null;
  }

  // Without modules (the preview has no go.mod), the module path is inferred once: of the
  // imports whose path ends with an indexed directory, the most common prefix before it (the
  // PR's own module). Only imports under it name indexed directories, so another module's
  // package with the same directory name (`github.com/cli/go-gh/v2/pkg/api` and `api/`) is not
  // taken for the indexed one. Cache: owner this index; never invalidated (the files never change).
  /** @type {string|null|undefined} */
  let modulePathGuess;
  function inferredModulePath() {
    if (modulePathGuess !== undefined) return modulePathGuess;
    /** @type {Map<string, number>} */
    const votes = new Map();
    for (const rec of byFile.values()) {
      for (const imp of rec.imports) {
        const dir = suffixDir(imp.path);
        if (dir) { const prefix = imp.path.slice(0, -(dir.length + 1)); votes.set(prefix, (votes.get(prefix) || 0) + 1); }
      }
    }
    modulePathGuess = [...votes].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
    return modulePathGuess;
  }

  /** @param {FileRec} rec @returns {Map<string, PkgRec|null>} */
  function bindingsOf(rec) {
    if (rec.bindings) return rec.bindings;
    /** @type {Map<string, PkgRec|null>} */
    const out = new Map();
    for (const imp of rec.imports) {
      const pkg = packageOfImport(imp.path);
      if (imp.alias === '_') continue;
      if (imp.alias === '.') { if (pkg) rec.dots.push(pkg); continue; }
      const elems = imp.path.split('/');
      let lastElem = elems[elems.length - 1];
      if (/^v\d+$/.test(lastElem) && elems.length > 1) lastElem = elems[elems.length - 2];
      out.set(imp.alias || (pkg ? pkg.name : lastElem.replace(/^go-/, '').replace(/[.-].*$/, '')), pkg);
    }
    rec.bindings = out;
    return out;
  }

  /**
   * The indexed type a reference names, or 'external' (a type of an unindexed package, or a
   * built-in), or null (not a type this follows, or a pending call this cannot resolve).
   * @param {TypeRef|null|undefined} ref @param {number} [depth]
   * @returns {TypeRec|'external'|null}
   */
  function typeOf(ref, depth = 0) {
    if (!ref || depth > MAX_EMBED_DEPTH) return null;
    const call = /** @type {any} */ (ref).call;
    if (call) {
      const defs = funcsNamed(ref.file, ref.alias, call);
      if (defs === 'external') return 'external';
      // Not a function: a conversion `T(x)` has type T.
      // Not an indexed function: a conversion `T(x)` to an indexed type has type T; anything
      // else (a function this index has not read) is not typed.
      if (!defs || !defs.length) {
        const conv = typeOf({ alias: ref.alias, name: call, file: ref.file }, depth + 1);
        return conv && conv !== 'external' ? conv : null;
      }
      const r = defs[0].results[/** @type {any} */ (ref).which];
      return r ? typeOf(r, depth + 1) : null;
    }
    if (!ref.name) return null;
    const own = /** @type {PkgRec} */ (ref.file.pkg);
    if (ref.alias === null) {
      const t = own.types.get(ref.name);
      if (t) return t;
      bindingsOf(ref.file);
      for (const p of ref.file.dots) { const dt = p.types.get(ref.name); if (dt) return dt; }
      return 'external';
    }
    const b = bindingsOf(ref.file);
    if (!b.has(ref.alias)) return null;
    const pkg = b.get(ref.alias);
    if (!pkg) return 'external';
    return pkg.types.get(ref.name) || null;
  }

  /**
   * The functions `F` (or `alias.F`) names from `file`, 'external' for an unindexed package's,
   * null when the name is not a function this knows.
   * @param {FileRec} file @param {string|null} alias @param {string} name
   * @returns {DefRec[]|'external'|null}
   */
  function funcsNamed(file, alias, name) {
    const own = /** @type {PkgRec} */ (file.pkg);
    if (alias === null) {
      const hit = own.funcs.get(name);
      if (hit) return hit;
      bindingsOf(file);
      for (const p of file.dots) { const f = p.funcs.get(name); if (f) return f; }
      return null;
    }
    const b = bindingsOf(file);
    if (!b.has(alias)) return null;
    const pkg = b.get(alias);
    return pkg ? pkg.funcs.get(name) || null : 'external';
  }

  /**
   * A field's or promoted field's type on `t`, through embedded fields.
   * @param {TypeRec} t @param {string} name @param {number} [depth] @returns {TypeRec|'external'|null}
   */
  function fieldType(t, name, depth = 0) {
    if (depth > MAX_EMBED_DEPTH) return null;
    if (t.fields.has(name)) return typeOf(t.fields.get(name));
    for (const e of t.embedded) {
      const et = typeOf(e);
      if (et && et !== 'external') { const hit = fieldType(et, name, depth + 1); if (hit) return hit; }
    }
    return null;
  }

  /**
   * The methods named `name` a value of `t` has (its own, else promoted through embedded
   * fields), or 'interface' when `t` is an interface declaring it, or 'external' when it may
   * be promoted from an unindexed type.
   * @param {TypeRec} t @param {string} name @param {number} [depth]
   * @returns {DefRec[]|'interface'|'external'|null}
   */
  function methodsOf(t, name, depth = 0) {
    if (depth > MAX_EMBED_DEPTH) return null;
    if (t.methods.has(name)) return /** @type {DefRec[]} */ (t.methods.get(name));
    if (t.kind === 'interface' && t.ifaceMethods.has(name)) return 'interface';
    let external = false;
    for (const e of t.embedded) {
      const et = typeOf(e);
      if (et === 'external') { external = true; continue; }
      if (!et) continue;
      const hit = methodsOf(et, name, depth + 1);
      if (hit && hit !== 'external') return hit;
      if (hit === 'external') external = true;
    }
    if (t.kind === 'interface' && t.embedded.length) return external ? 'interface' : null;
    return external ? 'external' : null;
  }

  /**
   * What one use reaches.
   * @param {FileRec} rec @param {Use} use
   * @returns {{ defs: DefRec[] } | 'unresolved' | 'interface' | null}
   */
  function resolveUse(rec, use) {
    const locals = use.owner ? use.owner.locals : null;
    if (use.recv === null) {
      if (locals && locals.has(use.name)) return null; // a local or parameter of that name
      const f = funcsNamed(rec, null, use.name);
      return f && f !== 'external' ? { defs: f } : null;
    }
    if (use.recv === '?') return 'unresolved';
    const [head, ...rest] = use.recv;
    /** @type {TypeRec|'external'|null} */
    let t;
    if (head === '()') {
      const [alias, name] = rest;
      if (!alias && locals && locals.has(name)) return 'unresolved'; // a function value's result
      if (alias && locals && locals.has(alias)) return 'unresolved'; // a method's result
      t = typeOf(/** @type {any} */ ({ alias: alias || null, name: null, file: rec, call: name, which: 0 }));
      rest.length = 0;
    } else if (locals && locals.has(head)) {
      t = typeOf(locals.get(head));
    } else if (!rest.length && bindingsOf(rec).has(head)) {
      const f = funcsNamed(rec, head, use.name);
      if (f === 'external') return null;
      // `p.T(` (a conversion) or `p.V(` (a function variable): not a declaration's call.
      return f ? { defs: f } : null;
    } else if (bindingsOf(rec).has(head) && rest.length) {
      const pkg = bindingsOf(rec).get(head);
      if (!pkg) return null;
      const v = pkg.vars.get(rest[0]);
      if (!v) return pkg.types.has(rest[0]) ? null : 'unresolved'; // `p.T.M(`: a method expression
      t = typeOf(v);
      rest.shift();
    } else {
      const own = /** @type {PkgRec} */ (rec.pkg);
      const v = own.vars.get(head);
      if (v) t = typeOf(v);
      else if (own.types.has(head)) return null; // `T.M(`: a method expression, not followed
      else return 'unresolved';
    }
    for (const field of rest) {
      if (!t) return 'unresolved';
      if (t === 'external') return null;
      t = fieldType(t, field);
    }
    if (!t) return 'unresolved';
    if (t === 'external') return null;
    const m = methodsOf(t, use.name);
    if (m === 'interface') return 'interface';
    if (m === 'external') return null;
    if (!m) return t.kind === 'interface' ? 'interface' : null; // a field of a function type, or a method this cannot see
    return { defs: m };
  }

  // Per-use resolution, on first need. Cache: owner this index; key the use; the files never
  // change, so it is never invalidated; it goes with the index.
  /** @type {Map<Use, ReturnType<typeof resolveUse>>} */
  const resolved = new Map();
  const resolveCached = (/** @type {FileRec} */ rec, /** @type {Use} */ use) => {
    if (!resolved.has(use)) resolved.set(use, resolveUse(rec, use));
    return /** @type {ReturnType<typeof resolveUse>} */ (resolved.get(use));
  };
  /** @type {Map<string, Array<{ rec: FileRec, use: Use }>>|null} Uses by name, built on first need; owner and lifetime as `resolved`'s. */
  let usesByName = null;
  const usesNamed = (/** @type {string} */ name) => {
    if (!usesByName) {
      usesByName = new Map();
      for (const rec of byFile.values()) for (const use of rec.uses) {
        if (!usesByName.has(use.name)) usesByName.set(use.name, []);
        /** @type {any[]} */ (usesByName.get(use.name)).push({ rec, use });
      }
    }
    return /** @type {Map<string, Array<{ rec: FileRec, use: Use }>>} */ (usesByName).get(name) || [];
  };

  /** @param {string} file @param {number|undefined} pos @param {string|null} className @param {string} name @returns {DefRec|null} */
  function targetDef(file, pos, className, name) {
    const rec = byFile.get(file);
    if (!rec) return null;
    const at = pos != null ? rec.byPos.get(pos) : undefined;
    if (at) return at;
    return rec.defs.find((d) => d.name === name && d.recvType === (className || null)) || null;
  }

  const scopeNote = () => `Go callers from syntax only: ${scope}${skipped + notIndexed ? `, ${skipped + notIndexed} Go file(s) not indexed${skipped ? ` (${skipped} over ${MAX_FILE_BYTES / 1024 / 1024} MiB)` : ''}` : ''}; calls through an interface or a function value, and receivers whose type is not written, are not resolved`;

  /**
   * The callers of a target: rows `{ file, label, pos, callSites }` (the enclosing top-level
   * function, as the outline names it; `label` the file's name and `pos` 0 for a use outside
   * every function), and `incompleteReason`, never null here (see the file comment).
   * @param {{ file: string, className?: string|null, name: string, pos?: number }} target
   */
  function callersOfWithStatus(target) {
    const def = targetDef(target.file, target.pos, target.className || null, target.name);
    const reasons = [scopeNote()];
    if (!def) return { callers: [], incompleteReason: `${reasons[0]}; the function was not found in the indexed files` };
    /** @type {Map<string, import('../types').SyntacticCaller>} */
    const out = new Map();
    let valueUses = 0;
    let interfaceCalls = 0;
    for (const { rec, use } of usesNamed(def.name)) {
      const hit = resolveCached(rec, use);
      if (hit === 'interface' && use.called) { interfaceCalls++; continue; }
      if (!hit || typeof hit === 'string' || !hit.defs.includes(def)) continue;
      if (!use.called) { valueUses++; continue; }
      const owner = use.owner;
      const id = `${rec.file}#${owner ? owner.namePos : 0}`;
      if (!out.has(id)) out.set(id, { file: rec.file, label: owner ? owner.label : path.posix.basename(rec.rel), pos: owner ? owner.namePos : 0, callSites: [] });
      /** @type {any} */ (out.get(id)).callSites.push({ start: use.pos, end: use.pos + use.name.length });
    }
    if (valueUses) reasons.push(`referenced as a value ${valueUses} time(s) (a callback or a field such as \`RunE: f\`), so its calls through that value cannot be followed`);
    if (def.recvType) {
      const ifaces = interfacesByMethod.get(def.name);
      if (ifaces && ifaces.length) {
        reasons.push(`an interface in the indexed files declares \`${def.name}\` (${[...new Set(ifaces)].slice(0, 3).join(', ')}${ifaces.length > 3 ? ', …' : ''}), and a call through it may reach any implementation${interfaceCalls ? ` (${interfaceCalls} such call(s) named ${def.name})` : ''}`);
      } else if (interfaceCalls) {
        reasons.push(`${interfaceCalls} call(s) named ${def.name} through an interface may reach it`);
      }
    }
    const pkg = /** @type {PkgRec} */ (def.file.pkg);
    const same = def.recvType ? (pkg.types.get(def.recvType)?.methods.get(def.name) || []) : (pkg.funcs.get(def.name) || []);
    const variants = same.filter((d) => d !== def && d.file !== def.file && def.name !== 'init');
    if (variants.length) reasons.push(`other build-tag variants of it in ${variants.map((d) => path.posix.basename(d.file.rel)).join(', ')}: a call is matched to each`);
    if (partialPackages) reasons.push(`the package's files outside the pull request were not read`);
    return { callers: [...out.values()], incompleteReason: reasons.join('; ') };
  }

  // Cache: count of unresolved `.M(` calls by name, built on first use; owner and lifetime as
  // `resolved`'s. Only names of an indexed type's methods count: a call whose receiver is not
  // typed may reach one of them.
  /** @type {Map<string, number>|null} */
  let unresolvedByName = null;
  /** @param {{ name: string }} target @returns {number} */
  function unresolvedCallsTo(target) {
    if (!unresolvedByName) {
      unresolvedByName = new Map();
      for (const rec of byFile.values()) {
        for (const use of rec.uses) {
          if (use.called && use.recv !== null && methodNames.has(use.name) && resolveCached(rec, use) === 'unresolved') {
            unresolvedByName.set(use.name, (unresolvedByName.get(use.name) || 0) + 1);
          }
        }
      }
    }
    return unresolvedByName.get(target.name) || 0;
  }

  /** @param {string} file @param {number} pos @returns {{ className: string|null, name: string }|null} */
  function symbolAt(file, pos) {
    const d = byFile.get(file)?.byPos.get(pos);
    return d ? { className: d.recvType, name: d.name } : null;
  }

  return { symbolAt, callersOfWithStatus, unresolvedCallsTo, size: byFile.size, skipped, scopeNote, byFile };
}

module.exports = { createGoSyntacticIndex, goTokens, MAX_FILE_BYTES, MAX_EMBED_DEPTH };
