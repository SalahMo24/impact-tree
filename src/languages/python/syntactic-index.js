// @ts-check
'use strict';
// Python callers without a language server (docs/MULTI_LANGUAGE_PLAN.md, Part A8): an index
// of a set of Python files, read from their text alone, with the three methods TypeScript's
// syntax-only index gives `createSyntacticResolver` (src/engine/resolver-syntactic.js):
// `symbolAt`, `callersOfWithStatus` and `unresolvedCallsTo`.
//
// Per file: its module name (from the repository-relative path: `a/b.py` is `a.b`,
// `a/__init__.py` is `a`, and under a `src/` segment also the name after it), its classes
// and functions (the outline's: module functions, methods, nested classes; a def inside a
// function is its parent's body, P-D5), its imports (`import a.b`, `import a.b as c`,
// `from .m import x as y`, `from m import (…)` across lines, `from m import *`) and every
// name in code (strings and comments are not code; neither are f-string fields, a limit).
// A use resolves to a definition by the six rules of A8-D2 (a):
//   1. `name(` where `name` is a def of the same module, or imported from an indexed module;
//   2. `mod.name(` where `mod` is an imported, indexed module (or a package attribute);
//   3. `self.m(` / `cls.m(` in a class: that class's `m`, else a base class's in the index;
//   4. `super().m(`: the first base class in the index that defines `m`;
//   5. `Cls(` (named as in 1–2): the class's `__init__` (its own, else a base's);
//   6. `x.m(` where `x` is a parameter annotated `Cls`, `"Cls"`, `Optional[Cls]` or
//      `Cls | None`, or a local assigned `x = Cls(…)` in the same function: `Cls.m`.
// Anything else named `.m(` is an unresolved call to `m` (`unresolvedCallsTo`). A use of a
// resolved function without `(` (a callback, `@decorator`, a dict entry) is a value use; a
// use of a property without `(` on a resolved receiver is a use of its getter (A8-D3 (a);
// followed by `=`, of its setter).
//
// No answer is complete (CODING_STYLE §1): every `callersOfWithStatus` carries the index's
// scope note (`scopeNote`), plus the target's own reasons: value uses, a dunder Python calls
// itself, a registration decorator, an override that base-typed calls may reach, a class
// constructed through `cls(…)`.
//
// Pure: reads only the `{ path, text }` pairs it is given. Budgets (CODING_STYLE §2):
// - files: bounded by its input; the caller chooses them (the preview: the PR's files under
//   `impactTree.tierA.maxFiles`; the CLI: `pickRepositoryFiles`, ../repository-files.js).
// - bytes per file: `MAX_FILE_BYTES` (1 MiB, the editor's per-file read limit). Owner: this
//   module. Enforcement: a longer text is not read. Exhaustion: the file is not indexed,
//   counted in `skipped`, and every answer's reason says how many files were not indexed.
// - re-export chains: `MAX_REEXPORT_DEPTH` hops through `from m import x` (and `*`) when a
//   module's name is looked up; past it the name is unresolved (the call then counts as
//   unresolved when it has a receiver).
// - base classes: `MAX_BASE_DEPTH` levels when a method is looked up through bases.

const path = require('path');
const { scanString } = require('./lexer');
const { isRegistrationDecorator, PROTOCOL_REASON, REGISTRATION_REASON, FACTORY_REASON } = require('./editor-extras');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REEXPORT_DEPTH = 8;
const MAX_BASE_DEPTH = 16;
// The CLI's file set and its bound (A8-D1 (b)), shared with Go: ../repository-files.js.
const { pickRepositoryFiles, REPO_MAX_FILES, REPO_MAX_BYTES } = require('../repository-files');

const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const PROPERTY_DECORATOR = /^(?:\w+\.)*(?:property|cached_property)\b|^\w+\.(?:getter|setter|deleter)\b/;
const SETTER_DECORATOR = /^\w+\.(?:setter|deleter)\b/;
const isDunder = (/** @type {string} */ name) => /^__\w+__$/.test(name);

/**
 * @typedef {{ t: 'id'|'op'|'str', v: string, pos: number }} Token
 * @typedef {{ indent: number, tokens: Token[] }} Line
 */

/**
 * The logical lines of a Python text: tokens of code (names, strings with their contents,
 * one-character operators), joined across brackets and backslash continuations, each with
 * the column of its first token. Comments are dropped. A string prefix (`r`, `b`, `f`, …)
 * is part of its string. Bound: one pass over `text`.
 * @param {string} text
 * @returns {Line[]}
 */
function logicalLines(text) {
  /** @type {Line[]} */
  const lines = [];
  /** @type {Token[]} */
  let cur = [];
  let indent = 0;
  let lineStart = 0;
  let depth = 0;
  const n = text.length;
  let i = 0;
  const flush = () => { if (cur.length) lines.push({ indent, tokens: cur }); cur = []; };
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      i++;
      if (depth === 0) { flush(); lineStart = i; }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) { i += text[i + 1] === '\n' ? 2 : 3; continue; }
    if (!cur.length) indent = i - lineStart;
    if (c === '"' || c === "'") {
      const s = scanString(text, i);
      const end = Math.max(i + 1, s.end);
      cur.push({ t: 'str', v: text.slice(i, end), pos: i });
      i = end;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_]/u.test(text[j])) j++;
      const word = text.slice(i, j);
      if ((text[j] === '"' || text[j] === "'") && /^[rRbBuUfF]{1,2}$/.test(word)) {
        const s = scanString(text, j);
        const end = Math.max(j + 1, s.end);
        cur.push({ t: 'str', v: text.slice(j, end), pos: i });
        i = end;
        continue;
      }
      cur.push({ t: 'id', v: word, pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      cur.push({ t: 'op', v: '0', pos: i });
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    // `==`, `!=`, `<=`, `>=`, `:=` and `->` are not assignments, annotations or attribute dots.
    if ((c === '=' || c === '!' || c === '<' || c === '>' || c === ':' || c === '-') && text[i + 1] === '=') { cur.push({ t: 'op', v: `${c}=`, pos: i }); i += 2; continue; }
    if (c === '-' && text[i + 1] === '>') { cur.push({ t: 'op', v: '->', pos: i }); i += 2; continue; }
    cur.push({ t: 'op', v: c, pos: i });
    i++;
  }
  flush();
  return lines;
}

/**
 * The module names of a repository-relative path: `a/b.py` → `a.b`, `a/__init__.py` → `a`;
 * under a `src/` segment, also the name after its last one (`src/pkg/m.py` → `pkg.m`).
 * @param {string} relPath
 * @returns {string[]} Empty for a path that is not a module.
 */
function moduleNamesOf(relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return [];
  const last = parts[parts.length - 1].replace(/\.pyi?$/, '');
  if (last === '__init__') parts.pop(); else parts[parts.length - 1] = last;
  if (!parts.length || !parts.every((p) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(p))) return [];
  const names = [parts.join('.')];
  const src = parts.lastIndexOf('src');
  if (src >= 0 && src < parts.length - 1) names.push(parts.slice(src + 1).join('.'));
  return names;
}

/** @param {Token[]} toks @param {number} at Index of an open bracket. @returns {number} Index of its close, or toks.length. */
function closeOf(toks, at) {
  let d = 0;
  for (let k = at; k < toks.length; k++) {
    const v = toks[k].v;
    if (toks[k].t !== 'op') continue;
    if (v === '(' || v === '[' || v === '{') d++;
    else if (v === ')' || v === ']' || v === '}') { d--; if (d === 0) return k; }
  }
  return toks.length;
}

/**
 * A dotted name from an annotation's tokens: `Cls`, `m.Cls`, `"Cls"`, `Optional[Cls]`,
 * `typing.Optional[Cls]`, `Cls | None`, `None | Cls`; null for anything else.
 * @param {Token[]} toks
 * @returns {string|null}
 */
function annotationClass(toks) {
  if (!toks.length) return null;
  if (toks.length === 1 && toks[0].t === 'str') {
    const inner = toks[0].v.replace(/^[a-zA-Z]*(['"])/, '').replace(/['"]$/, '').trim();
    return /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(inner) ? inner : null;
  }
  const bar = toks.findIndex((x) => x.v === '|');
  if (bar > 0) {
    const left = toks.slice(0, bar);
    const right = toks.slice(bar + 1);
    if (right.length === 1 && right[0].v === 'None') return annotationClass(left);
    if (left.length === 1 && left[0].v === 'None') return annotationClass(right);
    return null;
  }
  const chain = [];
  let k = 0;
  while (k < toks.length && toks[k].t === 'id') {
    chain.push(toks[k].v);
    if (toks[k + 1] && toks[k + 1].v === '.') k += 2; else { k++; break; }
  }
  if (!chain.length) return null;
  if (k === toks.length) return chain.join('.');
  if (/(^|\.)Optional$/.test(chain.join('.')) && toks[k].v === '[' && closeOf(toks, k) === toks.length - 1) return annotationClass(toks.slice(k + 1, toks.length - 1));
  return null;
}

/**
 * @typedef {{ name: string, qualified: string, namePos: number, file: string, isMethod: boolean,
 *   cls: ClassRec|null, decorators: string[], property: 'getter'|'setter'|null }} DefRec
 * @typedef {{ name: string, qualified: string, namePos: number, file: string, bases: string[],
 *   methods: Map<string, DefRec[]>, classes: Map<string, ClassRec>, parent: ClassRec|null,
 *   factory: boolean, fileRec: FileRec }} ClassRec
 * @typedef {{ kind: 'module', module: string } | { kind: 'member', module: string, name: string }} ImportBinding
 * @typedef {{ name: string, pos: number, recv: string|null, called: boolean, assigned: boolean,
 *   decorator: boolean, owner: { label: string, pos: number }, cls: ClassRec|null,
 *   fn: FnScope|null }} Use
 * @typedef {{ locals: Map<string, string|null>, parent: FnScope|null }} FnScope
 * @typedef {{ owner: { label: string, pos: number }, cls: ClassRec|null, fn: FnScope|null, inFunction: boolean }} Ctx
 * @typedef {{ file: string, rel: string, modules: string[], isPackage: boolean,
 *   defs: Map<string, DefRec[]>, classes: Map<string, ClassRec>, imports: Map<string, ImportBinding>,
 *   stars: string[], uses: Use[], byPos: Map<number, DefRec> }} FileRec
 */

/**
 * The index; see the file comment.
 * @param {Array<{ path: string, text: string }>} sources Repository-relative paths and texts.
 * @param {{ root?: string, scope?: string, notIndexed?: number }} [options] `root`: joined to
 *   each path to give the files' keys (the engine's absolute paths); `scope`: what was indexed,
 *   in words, for the scope note; `notIndexed`: files the caller left out, said in it.
 * @returns {import('../types').SyntacticIndex & { skipped: number, scopeNote: () => string, byFile: Map<string, FileRec> }}
 *   The shared contract, with what this index has besides: the files over the size limit it
 *   skipped, its scope note, and the parsed files.
 */
function createPythonSyntacticIndex(sources, { root = '', scope = 'the indexed files', notIndexed = 0 } = {}) {
  /** @type {Map<string, FileRec>} */
  const byFile = new Map();
  /** @type {Map<string, FileRec>} */
  const byModule = new Map();
  let skipped = 0;
  const fileKey = (/** @type {string} */ rel) => (root ? path.join(root, rel) : rel);

  // Pass 1: the names every def and class has, so pass 2 records only uses that may reach one.
  const known = new Set(['__init__']);
  const DEF_NAME = /^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+([\p{L}_][\p{L}\p{N}_]*)/gmu;
  const AS_NAME = /\bas[ \t]+([\p{L}_][\p{L}\p{N}_]*)/gu;
  const kept = [];
  for (const s of sources) {
    if (typeof s.text !== 'string' || s.text.length > MAX_FILE_BYTES) { skipped++; continue; }
    kept.push(s);
    for (const m of s.text.matchAll(DEF_NAME)) known.add(m[1]);
    // An import's alias (`import a as b`, `from m import f as g`) names a def too.
    for (const m of s.text.matchAll(AS_NAME)) known.add(m[1]);
  }

  for (const s of kept) {
    const rec = parseFile(s.path, s.text);
    byFile.set(rec.file, rec);
    for (const m of rec.modules) if (!byModule.has(m)) byModule.set(m, rec);
  }

  /**
   * @param {string} rel @param {string} text
   * @returns {FileRec}
   */
  function parseFile(rel, text) {
    const file = fileKey(rel);
    const slashedRel = rel.split(path.sep).join('/');
    /** @type {FileRec} */
    const rec = {
      file, rel: slashedRel, modules: moduleNamesOf(slashedRel), isPackage: /(^|\/)__init__\.pyi?$/.test(slashedRel),
      defs: new Map(), classes: new Map(), imports: new Map(), stars: [], uses: [], byPos: new Map(),
    };
    const moduleOwner = { label: path.basename(slashedRel), pos: 0 };
    /** @type {Array<{ indent: number, kind: 'class'|'def', cls: ClassRec|null, def: DefRec|null, fn: FnScope|null, owner: { label: string, pos: number } }>} */
    const stack = [];
    /** @type {string[]} */
    let pendingDecorators = [];

    /** @returns {Ctx} */
    const ctx = () => {
      const top = stack[stack.length - 1];
      let cls = null;
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind === 'class') { cls = stack[k].cls; break; }
      return { owner: top ? top.owner : moduleOwner, cls, fn: top ? top.fn : null, inFunction: stack.some((x) => x.kind === 'def') };
    };

    for (const line of logicalLines(text)) {
      while (stack.length && line.indent <= stack[stack.length - 1].indent) stack.pop();
      const toks = line.tokens;
      const first = toks[0];
      const here = ctx();
      if (first.v === '@' && first.t === 'op') {
        pendingDecorators.push(text.slice(toks[1] ? toks[1].pos : first.pos, toks[toks.length - 1].pos + toks[toks.length - 1].v.length).trim());
        scanUses(toks.slice(1), here, { decorator: true });
        continue;
      }
      const isAsync = first.v === 'async' && toks[1] && toks[1].v === 'def';
      const head = isAsync ? toks[1] : first;
      const nameTok = isAsync ? toks[2] : toks[1];
      if ((head.v === 'def' || head.v === 'class') && head.t === 'id' && nameTok && nameTok.t === 'id') {
        const decorators = pendingDecorators;
        pendingDecorators = [];
        const start = toks.indexOf(nameTok) + 1;
        // The header's `:` at depth 0; the rest of the line is a one-line body.
        let colon = start;
        for (let d = 0; colon < toks.length; colon++) {
          const v = toks[colon].v;
          if (v === '(' || v === '[' || v === '{') d++;
          else if (v === ')' || v === ']' || v === '}') d--;
          else if (v === ':' && d === 0) break;
        }
        const header = toks.slice(start, colon);
        const body = toks.slice(colon + 1);
        const parentIsClass = stack.length && stack[stack.length - 1].kind === 'class';
        const listed = !here.inFunction; // P-D5: a def or class in a function is its body
        const prefix = parentIsClass ? `${/** @type {ClassRec} */ (stack[stack.length - 1].cls).qualified}.` : '';
        if (head.v === 'class') {
          /** @type {string[]} */
          const bases = [];
          if (header[0] && header[0].v === '(') {
            const close = closeOf(header, 0);
            let partStart = 1;
            for (let k = 1, d = 0; k <= close; k++) {
              const v = header[k] ? header[k].v : ')';
              if (v === '(' || v === '[' || v === '{') d++;
              else if ((v === ')' || v === ']' || v === '}') && d > 0) d--;
              else if ((v === ',' && d === 0) || k === close) {
                const part = header.slice(partStart, k);
                if (part.length && !(part[1] && part[1].v === '=')) {
                  const bracket = part.findIndex((x) => x.v === '[');
                  const name = annotationClass(bracket >= 0 ? part.slice(0, bracket) : part);
                  if (name) bases.push(name);
                }
                partStart = k + 1;
              }
            }
            scanUses(header, here, { header: true });
          }
          /** @type {ClassRec} */
          const cls = {
            name: nameTok.v, qualified: prefix + nameTok.v, namePos: nameTok.pos, file, bases,
            methods: new Map(), classes: new Map(), parent: parentIsClass ? stack[stack.length - 1].cls : null, factory: false, fileRec: rec,
          };
          if (listed) {
            if (cls.parent) cls.parent.classes.set(cls.name, cls);
            else if (!stack.length || stack.every((x) => x.kind !== 'class')) rec.classes.set(cls.name, cls);
          }
          stack.push({ indent: line.indent, kind: 'class', cls, def: null, fn: here.fn, owner: here.owner });
          if (body.length) scanUses(body, ctx(), {});
          continue;
        }
        /** @type {DefRec} */
        const def = {
          name: nameTok.v, qualified: prefix + nameTok.v, namePos: nameTok.pos, file, isMethod: Boolean(parentIsClass),
          cls: parentIsClass ? stack[stack.length - 1].cls : null, decorators,
          property: decorators.some((d) => SETTER_DECORATOR.test(d)) ? 'setter' : decorators.some((d) => PROPERTY_DECORATOR.test(d)) ? 'getter' : null,
        };
        /** @type {FnScope} */
        const fn = { locals: new Map(), parent: here.fn };
        if (here.fn) here.fn.locals.set(def.name, null); // a nested def shadows the name
        // Parameters, with the class an annotation names (rule 6).
        if (header[0] && header[0].v === '(') {
          const close = closeOf(header, 0);
          let k = 1;
          while (k < close) {
            let end = k;
            for (let d = 0; end < close; end++) {
              const v = header[end].v;
              if (v === '(' || v === '[' || v === '{') d++;
              else if (v === ')' || v === ']' || v === '}') d--;
              else if (v === ',' && d === 0) break;
            }
            const part = header.slice(k, end).filter((x) => x.v !== '*');
            if (part[0] && part[0].t === 'id') {
              const eq = part.findIndex((x) => x.v === '=');
              const ann = part[1] && part[1].v === ':' ? part.slice(2, eq < 0 ? part.length : eq) : [];
              fn.locals.set(part[0].v, annotationClass(ann));
              if (eq >= 0) scanUses(part.slice(eq + 1), here, {});
              if (ann.length) scanUses(ann.filter((x) => x.t !== 'str'), here, { header: true });
            }
            k = end + 1;
          }
        }
        const owner = listed ? { label: def.qualified, pos: def.namePos } : here.owner;
        if (listed) {
          rec.byPos.set(def.namePos, def);
          const into = def.cls ? def.cls.methods : rec.defs;
          if (!into.has(def.name)) into.set(def.name, []);
          /** @type {DefRec[]} */ (into.get(def.name)).push(def);
        }
        stack.push({ indent: line.indent, kind: 'def', cls: null, def, fn, owner });
        if (body.length) scanUses(body, ctx(), {});
        continue;
      }
      pendingDecorators = [];
      if (first.v === 'import' && first.t === 'id') { readImport(toks, here); continue; }
      if (first.v === 'from' && first.t === 'id' && toks.some((x) => x.v === 'import' && x.t === 'id')) { readFromImport(toks, here); continue; }
      // `x = Cls(…)` and `x: Cls = …` in a function (rule 6); any other assignment of a name
      // in a function makes it a local, shadowing a module name.
      if (here.fn && first.t === 'id' && toks[1]) {
        if (toks[1].v === '=') {
          const rhs = toks.slice(2);
          const callAt = rhs.findIndex((x) => x.v === '(');
          const chain = callAt > 0 && rhs.slice(0, callAt).every((x, k) => (k % 2 === 0 ? x.t === 'id' : x.v === '.')) && callAt % 2 === 1
            && closeOf(rhs, callAt) === rhs.length - 1 ? rhs.slice(0, callAt).map((x) => x.v).join('') : null;
          here.fn.locals.set(first.v, chain);
        } else if (toks[1].v === ':') {
          const eq = toks.findIndex((x) => x.v === '=');
          here.fn.locals.set(first.v, annotationClass(toks.slice(2, eq < 0 ? toks.length : eq)));
        } else if (toks[1].v === ',' || (first.v === 'for' && toks[1].t === 'id')) {
          for (const x of toks.slice(first.v === 'for' ? 1 : 0)) { if (x.v === '=' || x.v === 'in') break; if (x.t === 'id') here.fn.locals.set(x.v, null); }
        } else if (first.v === 'with' || first.v === 'except') {
          const as = toks.findIndex((x) => x.v === 'as');
          if (as >= 0 && toks[as + 1] && toks[as + 1].t === 'id') here.fn.locals.set(toks[as + 1].v, null);
        }
      }
      if (here.fn && (first.v === 'global' || first.v === 'nonlocal')) continue;
      scanUses(toks, here, {});
    }
    return rec;

    /**
     * @param {Token[]} toks
     * @param {Ctx} at
     */
    function readImport(toks, at) {
      // import a.b.c [as d], e
      let k = 1;
      while (k < toks.length) {
        const parts = [];
        while (k < toks.length && toks[k].t === 'id' && toks[k].v !== 'as') { parts.push(toks[k].v); if (toks[k + 1] && toks[k + 1].v === '.') k += 2; else { k++; break; } }
        if (!parts.length) { k++; continue; }
        let alias = null;
        if (toks[k] && toks[k].v === 'as' && toks[k + 1]) { alias = toks[k + 1].v; k += 2; }
        bind(at, alias || parts[0], { kind: 'module', module: alias ? parts.join('.') : parts[0] });
        if (toks[k] && toks[k].v === ',') k++;
      }
    }

    /**
     * @param {Token[]} toks
     * @param {Ctx} at
     */
    function readFromImport(toks, at) {
      let k = 1;
      let dots = 0;
      while (toks[k] && toks[k].v === '.') { dots++; k++; }
      const parts = [];
      while (toks[k] && toks[k].t === 'id' && toks[k].v !== 'import') { parts.push(toks[k].v); k += toks[k + 1] && toks[k + 1].v === '.' ? 2 : 1; }
      let base = parts.join('.');
      if (dots) {
        // A relative import: from the file's package, one level up per further dot.
        const own = rec.modules[0] ? rec.modules[0].split('.') : [];
        const pkg = rec.isPackage ? own : own.slice(0, -1);
        const up = pkg.slice(0, Math.max(0, pkg.length - (dots - 1)));
        base = [...up, ...parts].join('.');
        // Under `src/`, the short name too (moduleNamesOf's second name).
        if (rec.modules[1]) {
          const short = rec.modules[1].split('.');
          const spkg = rec.isPackage ? short : short.slice(0, -1);
          const sup = spkg.slice(0, Math.max(0, spkg.length - (dots - 1)));
          const alt = [...sup, ...parts].join('.');
          if (!byModuleName(base) && alt) base = alt;
        }
      }
      k++; // `import`
      if (toks[k] && toks[k].v === '*') { if (!at.fn) rec.stars.push(base); return; }
      for (; k < toks.length; k++) {
        const x = toks[k];
        if (x.t !== 'id') continue;
        let alias = null;
        if (toks[k + 1] && toks[k + 1].v === 'as' && toks[k + 2]) { alias = toks[k + 2].v; }
        bind(at, alias || x.v, { kind: 'member', module: base, name: x.v });
        if (alias) k += 2;
      }
    }

    /** @param {Ctx} at @param {string} name @param {ImportBinding} b */
    function bind(at, name, b) {
      // An import in a function binds a local; it is still resolved like a module import.
      if (at.fn) at.fn.locals.set(name, `\0import:${JSON.stringify(b)}`);
      else rec.imports.set(name, b);
    }

    /**
     * Records the uses in `toks` of names some def or class has.
     * @param {Token[]} toks
     * @param {Ctx} at
     * @param {{ decorator?: boolean, header?: boolean }} how `header`: only calls count (an
     *   annotation or a base class is not a value use).
     */
    function scanUses(toks, at, how) {
      for (let k = 0; k < toks.length; k++) {
        const x = toks[k];
        if (x.t !== 'id' || KEYWORDS.has(x.v)) continue;
        const prev = toks[k - 1];
        const next = toks[k + 1];
        if (next && next.v === '.') continue; // the head or middle of a chain: read at its end
        const called = Boolean(next && next.v === '(');
        // `cls(…)` in a class: constructed through the class object.
        if (!(prev && prev.v === '.') && x.v === 'cls' && called && at.cls) { at.cls.factory = true; continue; }
        if (!known.has(x.v)) {
          continue;
        }
        // A keyword argument's name (`f(x=1)`).
        if (next && next.v === '=' && prev && (prev.v === '(' || prev.v === ',')) continue;
        if (how.header && !called) continue;
        /** @type {string|null} */
        let recv = null;
        if (prev && prev.v === '.') {
          // Walk back over `a.b.`: a name chain, `super().`, or anything else (unresolved).
          let j = k - 1;
          const parts = [];
          while (toks[j] && toks[j].v === '.' && toks[j - 1] && toks[j - 1].t === 'id') { parts.unshift(toks[j - 1].v); j -= 2; }
          if (parts.length && !(toks[j] && toks[j].v === '.')) recv = parts.join('.');
          else if (!parts.length && toks[k - 2] && toks[k - 2].v === ')' && toks[k - 3] && toks[k - 3].v === '(' && toks[k - 4] && toks[k - 4].v === 'super' && !(toks[k - 5] && toks[k - 5].v === '.')) recv = 'super()';
          else recv = '?';
        }
        const assigned = Boolean(next && next.v === '=');
        rec.uses.push({ name: x.v, pos: x.pos, recv, called, assigned, decorator: Boolean(how.decorator), owner: at.owner, cls: at.cls, fn: at.fn });
      }
    }
  }

  /** @param {string} name @returns {FileRec|undefined} */
  function byModuleName(name) { return byModule.get(name); }

  /**
   * What a name of a module is: a def, a class, a submodule, or what it imports (followed).
   * @param {FileRec|undefined} rec @param {string} moduleName @param {string} name @param {number} depth
   * @returns {Entity|null}
   */
  function memberOf(rec, moduleName, name, depth = 0) {
    if (depth > MAX_REEXPORT_DEPTH) return null;
    if (rec) {
      if (rec.defs.has(name)) return { kind: 'func', defs: /** @type {DefRec[]} */ (rec.defs.get(name)) };
      if (rec.classes.has(name)) return { kind: 'class', cls: /** @type {ClassRec} */ (rec.classes.get(name)) };
      const imp = rec.imports.get(name);
      // `from . import sub` in a package's `__init__` binds its own submodule (A8.2, pydantic's
      // `from . import dataclasses`): followed, it would name itself until the depth bound; the
      // submodule is found below.
      const self = imp && imp.kind === 'member' && imp.name === name && byModule.get(imp.module) === rec;
      if (imp && !self) return importEntity(imp, depth + 1);
    }
    const sub = byModule.get(`${moduleName}.${name}`);
    if (sub) return { kind: 'module', rec: sub, name: `${moduleName}.${name}` };
    if (rec) for (const star of rec.stars) { const hit = memberOf(byModule.get(star), star, name, depth + 1); if (hit) return hit; }
    return null;
  }

  /**
   * @typedef {{ kind: 'func', defs: DefRec[] } | { kind: 'class', cls: ClassRec } | { kind: 'module', rec: FileRec|undefined, name: string }
   *   | { kind: 'instance', cls: ClassRec }} Entity
   */

  /** @param {ImportBinding} b @param {number} depth @returns {Entity|null} */
  function importEntity(b, depth) {
    if (b.kind === 'module') return { kind: 'module', rec: byModule.get(b.module), name: b.module };
    return memberOf(byModule.get(b.module), b.module, b.name, depth);
  }

  /**
   * What a bare name means at a use: a function's local (a parameter or a local typed by rule
   * 6, or a local import), the module's own name, an import, or a star import's.
   * @param {FileRec} rec @param {Use} use @param {string} name
   * @returns {Entity|null|'local'}
   */
  function nameEntity(rec, use, name) {
    for (let fn = use.fn; fn; fn = fn.parent) {
      if (!fn.locals.has(name)) continue;
      const v = fn.locals.get(name);
      if (v && v.startsWith('\0import:')) return importEntity(JSON.parse(v.slice(8)), 0);
      if (v && fn === use.fn) {
        // Rule 6: a parameter annotated with a class, or a local assigned its construction.
        const t = chainEntity(rec, { ...use, fn: fn.parent }, v);
        if (t && t !== 'local' && t.kind === 'class') return { kind: 'instance', cls: t.cls };
      }
      return 'local';
    }
    return memberOf(rec, rec.modules[0] || '', name);
  }

  /** @param {FileRec} rec @param {Use} use @param {string} chain @returns {Entity|null|'local'} */
  function chainEntity(rec, use, chain) {
    const parts = chain.split('.');
    if ((parts[0] === 'self' || parts[0] === 'cls') && use.cls) {
      if (parts.length === 1) return { kind: 'instance', cls: use.cls };
      return null;
    }
    let e = nameEntity(rec, use, parts[0]);
    for (const p of parts.slice(1)) {
      if (!e || e === 'local') return e;
      if (e.kind === 'module') e = memberOf(e.rec, e.name, p);
      else if (e.kind === 'class' && e.cls.classes.has(p)) e = { kind: 'class', cls: /** @type {ClassRec} */ (e.cls.classes.get(p)) };
      else return null;
    }
    return e;
  }

  /** @param {ClassRec} cls @returns {ClassRec[]} The class's indexed bases, in order. */
  function basesOf(cls) {
    /** @type {ClassRec[]} */
    const out = [];
    for (const b of cls.bases) {
      const scopeCls = cls.parent;
      let e;
      if (scopeCls && !b.includes('.') && scopeCls.classes.has(b)) e = { kind: 'class', cls: scopeCls.classes.get(b) };
      else e = chainEntity(cls.fileRec, /** @type {Use} */ ({ name: b, pos: cls.namePos, recv: null, called: false, assigned: false, decorator: false, owner: { label: '', pos: 0 }, cls: null, fn: null }), b);
      if (e && e !== 'local' && e.kind === 'class' && e.cls !== cls) out.push(/** @type {ClassRec} */ (e.cls));
    }
    return out;
  }

  /**
   * The defs named `name` a lookup on `cls` finds: its own, else the first base's (depth
   * first, as rules 3 and 6 read it), within `MAX_BASE_DEPTH` levels.
   * @param {ClassRec} cls @param {string} name @param {number} [depth] @param {Set<ClassRec>} [seen]
   * @returns {DefRec[]}
   */
  function lookup(cls, name, depth = 0, seen = new Set()) {
    if (depth > MAX_BASE_DEPTH || seen.has(cls)) return [];
    seen.add(cls);
    if (cls.methods.has(name)) return /** @type {DefRec[]} */ (cls.methods.get(name));
    for (const b of basesOf(cls)) { const hit = lookup(b, name, depth + 1, seen); if (hit.length) return hit; }
    return [];
  }

  /**
   * What one use reaches: the defs, how (a call, a value use, a property access), or that
   * its receiver could not be resolved.
   * @param {FileRec} rec @param {Use} use
   * @returns {{ defs: DefRec[], how: 'call'|'value'|'property' } | 'unresolved' | null}
   */
  function resolveUse(rec, use) {
    /** @type {DefRec[]} */
    let defs = [];
    if (use.recv === null) {
      const e = nameEntity(rec, use, use.name);
      if (!e || e === 'local') return null;
      if (e.kind === 'func') defs = e.defs;
      else if (e.kind === 'class') {
        if (!use.called) return null; // a class named without `(`: not a use of a function
        defs = lookup(e.cls, '__init__');
      } else return null;
    } else if (use.recv === '?') {
      return use.called ? 'unresolved' : null;
    } else if (use.recv === 'super()') {
      if (!use.cls) return use.called ? 'unresolved' : null;
      for (const b of basesOf(use.cls)) { defs = lookup(b, use.name); if (defs.length) break; }
      if (!defs.length) return use.called ? 'unresolved' : null;
    } else {
      const e = chainEntity(rec, use, use.recv);
      if (!e || e === 'local') return use.called ? 'unresolved' : null;
      if (e.kind === 'module') {
        const m = memberOf(e.rec, e.name, use.name);
        if (!m) return use.called && e.rec ? 'unresolved' : null;
        if (m.kind === 'func') defs = m.defs;
        else if (m.kind === 'class') { if (!use.called) return null; defs = lookup(m.cls, '__init__'); }
        else return null;
      } else if (e.kind === 'instance') {
        defs = lookup(e.cls, use.name);
        if (!defs.length) return use.called ? 'unresolved' : null;
        const props = defs.filter((d) => d.property);
        if (props.length && !use.called) {
          const want = use.assigned ? 'setter' : 'getter';
          const pick = props.filter((d) => d.property === want);
          return { defs: pick.length ? pick : props, how: 'property' };
        }
      } else {
        // `Cls.m(` and `func.attr(` are outside rules 1–6: unresolved.
        return use.called ? 'unresolved' : null;
      }
    }
    if (!defs.length) return null;
    return { defs, how: use.called ? 'call' : 'value' };
  }

  // Per-file resolution, on first use. Cache: owner this index; key the use; the files never
  // change, so it is never invalidated; it goes with the index.
  /** @type {Map<Use, ReturnType<typeof resolveUse>>} */
  const resolved = new Map();
  const resolveCached = (/** @type {FileRec} */ rec, /** @type {Use} */ use) => {
    if (!resolved.has(use)) resolved.set(use, resolveUse(rec, use));
    return /** @type {ReturnType<typeof resolveUse>} */ (resolved.get(use));
  };

  /** @param {string} file @param {number} pos @param {string|null} className @param {string} name @returns {DefRec|null} */
  function targetDef(file, pos, className, name) {
    const rec = byFile.get(file);
    if (!rec) return null;
    const at = pos != null ? rec.byPos.get(pos) : undefined;
    if (at) return at;
    for (const d of rec.byPos.values()) if (d.name === name && (d.cls ? d.cls.name : null) === (className || null)) return d;
    return null;
  }

  const scopeNote = () => `Python callers from syntax only: ${scope}${skipped + notIndexed ? `, ${skipped + notIndexed} Python file(s) not indexed${skipped ? ` (${skipped} over ${MAX_FILE_BYTES / 1024 / 1024} MiB)` : ''}` : ''}; untyped receivers and dynamic calls are not resolved`;

  /**
   * The callers of a target (TypeScript's shape): rows `{ file, label, pos, callSites }`, and
   * `incompleteReason`, never null here (see the file comment).
   * @param {{ file: string, className?: string|null, name: string, pos?: number }} target
   */
  function callersOfWithStatus(target) {
    const def = targetDef(target.file, /** @type {number} */ (target.pos), target.className || null, target.name);
    /** @type {string[]} */
    const reasons = [scopeNote()];
    /** @type {Map<string, { file: string, label: string, pos: number, callSites: Array<{ start: number, end: number }> }>} */
    const out = new Map();
    if (!def) return { callers: [], incompleteReason: `${reasons[0]}; the function was not found in the indexed files` };
    let valueUses = 0;
    const construction = def.isMethod && def.name === '__init__';
    for (const rec of byFile.values()) {
      for (const use of rec.uses) {
        // A bare name may be an import's alias (`from m import f as g`), and a construction
        // names the class (rule 5), not `__init__`: those are matched by what they resolve to.
        if (use.name !== def.name && use.recv !== null && !(construction && use.called)) continue;
        const hit = resolveCached(rec, use);
        if (!hit || hit === 'unresolved' || !hit.defs.includes(def)) continue;
        if (hit.how === 'value' || (use.decorator && !use.called)) { valueUses++; continue; }
        const id = `${rec.file}#${use.owner.pos}`;
        if (!out.has(id)) out.set(id, { file: rec.file, label: use.owner.label, pos: use.owner.pos, callSites: [] });
        /** @type {any} */ (out.get(id)).callSites.push({ start: use.pos, end: use.pos + use.name.length });
      }
    }
    if (valueUses) reasons.push(`referenced as a value ${valueUses} time(s) (a callback, a decorator or a registration), so its calls cannot be followed`);
    if (isDunder(def.name) && def.name !== '__init__') reasons.push(PROTOCOL_REASON);
    if (def.decorators.some(isRegistrationDecorator)) reasons.push(REGISTRATION_REASON);
    if (def.cls) {
      if (def.name === '__init__' && def.cls.factory) reasons.push(FACTORY_REASON);
      const overridden = basesOf(def.cls).some((b) => lookup(b, def.name).length);
      if (overridden) reasons.push(`it overrides a base class's \`${def.name}\`, and calls typed as the base may reach it`);
    }
    return { callers: [...out.values()], incompleteReason: reasons.join('; ') };
  }

  // Cache: count of unresolved `.m(` calls by name, built on first use; owner and lifetime as
  // `resolved`'s.
  /** @type {Map<string, number>|null} */
  let unresolvedByName = null;
  /** @param {{ name: string }} target @returns {number} */
  function unresolvedCallsTo(target) {
    if (!unresolvedByName) {
      unresolvedByName = new Map();
      for (const rec of byFile.values()) {
        for (const use of rec.uses) if (use.called && use.recv !== null && resolveCached(rec, use) === 'unresolved') unresolvedByName.set(use.name, (unresolvedByName.get(use.name) || 0) + 1);
      }
    }
    return unresolvedByName.get(target.name) || 0;
  }

  /** @param {string} file @param {number} pos @returns {{ className: string|null, name: string }|null} */
  function symbolAt(file, pos) {
    const d = byFile.get(file)?.byPos.get(pos);
    return d ? { className: d.cls ? d.cls.name : null, name: d.name } : null;
  }

  return { symbolAt, callersOfWithStatus, unresolvedCallsTo, size: byFile.size, skipped, scopeNote, byFile };
}

module.exports = {
  createPythonSyntacticIndex, pickRepositoryFiles, moduleNamesOf, logicalLines,
  MAX_FILE_BYTES, REPO_MAX_FILES, REPO_MAX_BYTES, MAX_REEXPORT_DEPTH, MAX_BASE_DEPTH,
};
