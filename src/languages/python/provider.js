// @ts-check
'use strict';
// Python as a language provider (src/languages/types.js; docs/MULTI_LANGUAGE_PLAN.md, P2).
// Python needs a language server, as Go does: its symbols come from the editor's (Pyright,
// through Pylance or Cursor's Python extension) via the shared `prepareFromServerSymbols`
// (../server-symbols.js). What is Python's own here: which server symbols are changed-symbol
// candidates and how they are keyed (`collectPythonSymbols`), the definitions Pyright leaves
// out (a property getter that has a setter, `@overload` stubs: P0) recovered from the text,
// and which project a file belongs to (`pythonProjectOf`, ./rules.js).
//
// Callers (P4): the shared call-hierarchy default plus Python's extras (./editor-extras.js:
// duplicated sites, value uses, protocol methods, decorator registration, duck typing).
// The server's warm-up (P5): `warmUpTarget` below, asked by src/readiness.js.
//
// Engine modules and the header parser are required where they are used: the registry
// (../index.js) loads this file, and src/engine/diff.js loads the registry.

const path = require('path');
const { pythonRules, pythonProjectOf } = require('./rules');

/** @typedef {import('../types').ServerSymbol} ServerSymbol */
/** @typedef {import('../types').CollectedSymbol} CollectedSymbol */
/** @typedef {'function'|'property'|'staticmethod'|'classmethod'} PythonBinding */

/**
 * A Python function or method as a changed-symbol candidate: a `CollectedSymbol` with the
 * normalised header text (from `def`/`async def` to the header's `:`), its decorators and
 * how it is bound, which the header comparison (`pythonKindsOf`, ./signature.js) reads.
 * @typedef {CollectedSymbol & { header: string, binding: PythonBinding, className: string|null,
 *   nested: false, valueLike: false, decorators: string[], classNamePos: null,
 *   recovered: boolean }} PythonSymbol
 */

/**
 * The Python header parser (./signature.js, P3).
 * - `parsePythonDeclaration(declText, { isMethod })`: `declText` is from the first decorator
 *   to the end of the body; the answer's `headerEnd` is the offset in it of the header's `:`.
 *   Null for text it cannot read.
 * - `raisesOf(declText, headerEnd)`: the exceptions the body raises.
 * - `pythonKindsOf(base, head)`: the signature kinds of a change.
 * - `renderPythonSig(sig)`: a `sig` as shown.
 * @typedef {{
 *   parsePythonDeclaration: (declText: string, options: { isMethod: boolean }) => { sig: NonNullable<CollectedSymbol['sig']>, headerEnd: number, decorators: string[], binding: PythonBinding }|null,
 *   raisesOf: (declText: string, headerEnd: number) => Set<string>,
 *   pythonKindsOf: (base: any, head: any) => object[],
 *   renderPythonSig: (sig: NonNullable<CollectedSymbol['sig']>) => string }} PythonSignatureParser
 */

/** @returns {PythonSignatureParser} */
const defaultParser = () => /** @type {PythonSignatureParser} */ (/** @type {unknown} */ (require('./signature')));

// LSP SymbolKind numbers Pyright gives (P0): a class `Class`; a module-level function
// `Function`; a method (also class/static methods and properties) `Method`. A nested def is
// a `Function` child of its function; parameters and locals are `Variable`/`Constant`
// children, and are never candidates.
const SYMBOL_KIND_CLASS = 5;
const SYMBOL_KIND_METHOD = 6;
const SYMBOL_KIND_FUNCTION = 12;
const isCallableKind = (/** @type {number} */ kind) => kind === SYMBOL_KIND_FUNCTION || kind === SYMBOL_KIND_METHOD;

// A `def` or `async def` line, its indentation and its name. Matched per line (`m`), from a
// scope's start (`g` with `lastIndex`).
const DEF_LINE = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([^\W\d]\w*)/gmu;

/** @param {string} text @returns {number[]} Offset of each line's first character. */
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** @param {number[]} starts @param {number} offset @returns {number} One-based line of `offset`. */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** @param {string} header @returns {string} The header with runs of white space as one space. */
const normalizedHeader = (header) => header.replace(/\s+/g, ' ').trim();

/** @param {string} c */
const isBlank = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\f';

/**
 * Where a `def` that starts at `defStart` (its `def` or `async` keyword) has its header's `:`
 * and where its body ends, read from the text, for definitions the server does not list and
 * as the header's end when the parser cannot read one.
 *
 * The header ends at the first `:` outside brackets and strings. The body ends before the
 * first line, after the header, that starts code at an indentation of at most `indent`
 * characters (tabs count as one): blank lines and comment-only lines never end it (a
 * comment at the def's own indentation between two methods is skipped, not taken as the
 * end), and neither do lines inside brackets, inside a string (a docstring's unindented
 * line), or after a backslash continuation. The end is just past the last code character
 * (strings included, trailing comments and blank lines not), as the server's range ends at
 * the last statement. Limits: a one-line body (`def f(): ...`) ends with its line as any
 * other; text that is not valid Python gives some end within `limit`, never past it.
 *
 * Bound: one pass over `text` from `defStart`, stopping at the body's end or at `limit`.
 * @param {string} text
 * @param {number} defStart
 * @param {number} indent Width of the def line's indentation.
 * @param {number} limit Offset the scan never passes (the enclosing scope's end).
 * @returns {{ headerEnd: number, end: number }|null} Offsets into `text`; null when no
 *   header `:` is found before `limit`.
 */
function scanDef(text, defStart, indent, limit) {
  let depth = 0;
  let headerEnd = -1;
  let lastCode = defStart;
  let atLineStart = false;
  let i = defStart;
  while (i < limit) {
    if (atLineStart) {
      atLineStart = false;
      let j = i;
      while (j < limit && isBlank(text[j])) j++;
      if (j >= limit) break;
      const first = text[j];
      if (first !== '\n' && first !== '#' && j - i <= indent) break;
      i = j;
      continue;
    }
    const c = text[i];
    if (c === '#') {
      while (i < limit && text[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      if (depth === 0 && headerEnd >= 0) atLineStart = true;
      i++;
      continue;
    }
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      i += text[i + 1] === '\n' ? 2 : 3;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      let j = i + close.length;
      while (j < limit) {
        if (text[j] === '\\') { j += 2; continue; }
        if (!triple && text[j] === '\n') break;
        if (text.startsWith(close, j)) { j += close.length; break; }
        j++;
      }
      i = Math.min(j, limit);
      lastCode = i;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0 && headerEnd < 0) headerEnd = i;
    if (!isBlank(c)) lastCode = i + 1;
    i++;
  }
  return headerEnd < 0 ? null : { headerEnd, end: lastCode };
}

/**
 * The decorator lines just above a def line: lines at exactly the def's indentation that
 * start with `@`, read upwards until another line. Limit: a decorator whose arguments span
 * several lines is cut at its first line (its other lines stop the walk), and a comment or
 * blank line between decorators stops it too; the definition then starts later than the
 * server would start it.
 * @param {string} text
 * @param {number[]} starts
 * @param {number} defLine One-based line of the def.
 * @param {string} indent The def line's indentation.
 * @param {number} floor Offset above which the walk does not go (the scope's start).
 * @returns {number} Offset of the first decorator's `@`, or of the def keyword.
 */
function decoratedStart(text, starts, defLine, indent, floor) {
  let line = defLine;
  while (line > 1) {
    const prev = starts[line - 2];
    if (prev < floor) break;
    const lineText = text.slice(prev, starts[line - 1]);
    if (!lineText.startsWith(`${indent}@`)) break;
    line--;
  }
  return starts[line - 1] + indent.length;
}

/**
 * Decorators and binding read from the text, for a declaration the parser could not read:
 * each `@` line above the `def` (its first line, trimmed).
 * @param {string} decoratorText Text from the first decorator to the `def` keyword.
 * @returns {{ decorators: string[], binding: PythonBinding }}
 */
function decoratorsOf(decoratorText) {
  const decorators = decoratorText.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@'));
  /** @type {PythonBinding} */
  let binding = 'function';
  for (const d of decorators) {
    if (/^@(\w+\.)*(property|cached_property)\b/.test(d) || /^@\w+\.(setter|getter|deleter)\b/.test(d)) binding = 'property';
    else if (/^@staticmethod\b/.test(d)) binding = 'staticmethod';
    else if (/^@classmethod\b/.test(d)) binding = 'classmethod';
  }
  return { decorators, binding };
}

/**
 * One candidate before keying: where it is and what it is named.
 * @typedef {{ qualified: string, simpleName: string, className: string|null, start: number,
 *   end: number, namePos: number, recovered: boolean }} Found
 */

/**
 * The changed-symbol candidates of one side of a Python file: its module-level functions
 * and the methods of its classes (also of classes nested in classes), as Pyright lists
 * them, plus the definitions it leaves out.
 * - Candidates: `Function`/`Method` symbols at module level and as children of a `Class`
 *   (recursively, so `Outer.Inner.method`). A def inside a function is part of its parent's
 *   body (P-D5) and never its own candidate; nor is a class inside a function.
 * - Recovered (P0): Pyright lists a `@property` getter and its setter, and `@overload` stubs
 *   and their implementation, as one symbol (the last definition), so the earlier
 *   definitions are inside no symbol's range and a change there would read as outside every
 *   function. In each class body, and at module level, every `def`/`async def` line at that
 *   body's indentation that no listed symbol covers becomes a candidate, from its first
 *   decorator to its body's end (`scanDef`). A class body's indentation is read from its
 *   listed methods (a class with none listed is not scanned: Pyright merges definitions,
 *   so a class with methods always has one listed). Bound: one pass per scope over its
 *   lines, plus one `scanDef` per recovered def. Limit: a docstring line at exactly the
 *   body's indentation that starts with `def name` would be taken for a definition.
 * - `label` is the qualified name (`func`, `Class.method`); `key` the same, with repeats in
 *   one file keyed `#2`, `#3` in source order (a getter `Class.timeout`, its setter
 *   `Class.timeout#2`), so base and head match by position among the repeats.
 * - `namePos` is the name (`selectionRange.start`, or the name in the recovered def line);
 *   `start`/`end` the declaration from its first decorator to its body's end (`range`; P0:
 *   decorators are inside it, comments above them outside).
 * - `sig`, `decorators`, `binding` and `throws` are the injected parser's; when it cannot
 *   read the declaration, `sig` is null and decorators and binding are read from the `@`
 *   lines. `header` is the normalised text from `def` to the header's `:` either way.
 * - `exported`: a name that is not private by Python's convention: no segment of the
 *   qualified name starts with `_`, except dunder names (`__init__`, `__eq__`), which are
 *   the class's public protocol. `isConstructor`: `__init__`.
 * Pure: reads only `symbols` and `text`. Throws on a symbol whose range is outside the text
 * (a bug or a server answer for another text), rather than reading a wrong declaration.
 * @param {ServerSymbol[]} symbols The server's answer for `text`, offsets into it.
 * @param {string} text
 * @param {PythonSignatureParser} [parser] The header parser; ./signature.js by default (tests
 *   may pass a stub).
 * @returns {PythonSymbol[]}
 */
function collectPythonSymbols(symbols, text, parser = defaultParser()) {
  const starts = lineStartsOf(text);
  /** @type {Found[]} */
  const found = [];

  /** @param {ServerSymbol} s */
  const checkRange = (s) => {
    for (const r of [s.range, s.selectionRange]) {
      const { start, end } = r;
      if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= text.length)) {
        throw new RangeError(`Python symbol ${s.name}: range ${start}..${end} is outside its text (length ${text.length})`);
      }
    }
  };
  /** @param {number} offset @returns {string} The indentation of the line holding `offset`. */
  const indentAt = (offset) => {
    const lineStart = starts[lineOf(starts, offset) - 1];
    return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
  };

  /**
   * Candidates in one scope (the module, or a class body) and the classes in it.
   * @param {ServerSymbol[]} members The scope's listed symbols.
   * @param {string} prefix `''` or `Outer.Inner.`.
   * @param {string|null} className The innermost class, for methods.
   * @param {{ start: number, end: number, indent: string|null }} scope The region scanned for
   *   unlisted defs, and its body indentation (null: do not scan).
   */
  function walk(members, prefix, className, scope) {
    /** @type {Array<{ start: number, end: number }>} */
    const covered = [];
    for (const s of members) {
      if (isCallableKind(s.kind)) {
        checkRange(s);
        covered.push(s.range);
        found.push({
          qualified: prefix + s.name, simpleName: s.name, className,
          start: s.range.start, end: s.range.end, namePos: s.selectionRange.start, recovered: false,
        });
      } else if (s.kind === SYMBOL_KIND_CLASS) {
        checkRange(s);
        covered.push(s.range);
        const firstMethod = (s.children || []).find((c) => isCallableKind(c.kind) || c.kind === SYMBOL_KIND_CLASS);
        if (firstMethod) checkRange(firstMethod);
        walk(s.children || [], `${prefix}${s.name}.`, s.name, {
          start: s.range.start, end: s.range.end,
          indent: firstMethod ? indentAt(firstMethod.selectionRange.start) : null,
        });
      }
    }
    if (scope.indent === null) return;
    const indent = scope.indent;
    DEF_LINE.lastIndex = scope.start;
    for (let m = DEF_LINE.exec(text); m && m.index < scope.end; m = DEF_LINE.exec(text)) {
      if (m[1] !== indent) continue;
      const defStart = m.index + indent.length;
      if (covered.some((r) => r.start <= defStart && defStart < r.end)) continue;
      const scanned = scanDef(text, defStart, indent.length, scope.end);
      if (!scanned) continue;
      const start = Math.max(scope.start, decoratedStart(text, starts, lineOf(starts, m.index), indent, scope.start));
      found.push({
        qualified: prefix + m[2], simpleName: m[2], className,
        start, end: scanned.end, namePos: m.index + m[0].length - m[2].length, recovered: true,
      });
    }
  }
  walk(symbols, '', null, { start: 0, end: text.length, indent: '' });

  found.sort((a, b) => a.start - b.start || a.namePos - b.namePos);
  /** @type {Map<string, number>} */
  const seen = new Map();
  return found.map((f) => {
    const n = (seen.get(f.qualified) || 0) + 1;
    seen.set(f.qualified, n);
    const declText = text.slice(f.start, f.end);
    const isMethod = f.className !== null;
    const parsed = parser.parsePythonDeclaration(declText, { isMethod });
    // The `def` keyword is on the name's line, after the decorators.
    const defStart = starts[lineOf(starts, f.namePos) - 1] + indentAt(f.namePos).length;
    const scanned = scanDef(text, defStart, indentAt(f.namePos).length, f.end);
    const headerEnd = parsed ? parsed.headerEnd : (scanned ? scanned.headerEnd - f.start : declText.length);
    const defInDecl = Math.max(0, Math.min(defStart - f.start, headerEnd));
    const fromText = decoratorsOf(declText.slice(0, defInDecl));
    const startLine = lineOf(starts, f.start);
    const endLine = lineOf(starts, f.end);
    const segments = f.qualified.split('.');
    return {
      label: f.qualified,
      key: n === 1 ? f.qualified : `${f.qualified}#${n}`,
      simpleName: f.simpleName,
      className: f.className,
      nested: false,
      isConstructor: isMethod && f.simpleName === '__init__',
      classNamePos: null,
      valueLike: false,
      namePos: f.namePos,
      startLine, endLine, span: endLine - startLine,
      start: f.start, end: f.end,
      decorators: parsed ? parsed.decorators : fromText.decorators,
      binding: parsed ? parsed.binding : fromText.binding,
      exported: segments.every((s) => !s.startsWith('_') || /^__\w+__$/.test(s)),
      sig: parsed ? parsed.sig : null,
      header: normalizedHeader(declText.slice(defInDecl, headerEnd)),
      throws: parser.raisesOf(declText, headerEnd),
      recovered: f.recovered,
    };
  });
}

/**
 * @param {PythonSignatureParser} [parser]
 * @returns {(symbol: CollectedSymbol) => string} The parsed signature as the parser shows
 *   it, or the raw header text when it was not parsed.
 */
const renderPythonSymbolSig = (parser = defaultParser()) => (symbol) => (symbol.sig
  ? parser.renderPythonSig(symbol.sig)
  : /** @type {PythonSymbol} */ (symbol).header);

/**
 * Python's spec for the shared `prepare`.
 * @param {PythonSignatureParser} [parser] The header parser; ./signature.js by default.
 * @returns {import('../server-symbols').ServerSymbolSpec}
 */
function pythonSpec(parser) {
  const p = parser || defaultParser();
  return {
    rules: pythonRules,
    serverName: 'the Python language server',
    installHint: 'Install the Python extension (Pylance, or Cursor\'s Python) to analyse Python files',
    collect: (symbols, text) => collectPythonSymbols(symbols, text, p),
    renderSig: renderPythonSymbolSig(p),
    kindsOf: (base, head) => p.pythonKindsOf(base, head),
    // A blank line or a `#` comment line. A docstring is code here: changing one is a
    // change inside its function (P0: docstrings are inside the range).
    trivia: /^\s*(#.*)?$/,
    componentOf: pythonProjectOf,
    // A text with a def: an empty answer for it is no answer, never "no functions".
    declaresSymbols: (text) => /^[ \t]*(?:async[ \t]+)?def[ \t]/m.test(text),
  };
}

/**
 * Finds the changed Python functions and methods; see `prepareFromServerSymbols` for what it
 * reads from `ctx.hooks` (the environment's `services` and `makeResolver`, both required).
 * @param {import('../types').PrepareContext} ctx
 * @returns {Promise<import('../types').PreparedLanguage>}
 */
const prepare = (ctx) => require('../server-symbols').prepareFromServerSymbols(ctx, pythonSpec());

/** @type {import('../types').LanguageProvider} */
/**
 * The first function or method in `symbols`, in source order. Pyright lists a method as a
 * child of its class (P0), so classes are searched; a function's own children (nested defs,
 * parameters) are not.
 * @param {ServerSymbol[]} symbols
 * @returns {ServerSymbol|null}
 */
function firstCallable(symbols) {
  for (const symbol of symbols) {
    if (isCallableKind(symbol.kind)) return symbol;
    if (symbol.kind === SYMBOL_KIND_CLASS) {
      const inner = firstCallable(symbol.children || []);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Where the editor's Python server is warmed (src/readiness.js): the name of the first
 * function or method Pyright lists in the first changed Python file. Only that file is
 * asked: each answer from a server that is still loading can take seconds, and any file of
 * the project makes Pyright load it. Null when the editor has no Python support (logged;
 * the analysis itself reports it once), when the server gives no symbols, or when the file
 * declares no function. Rejects when the server's request fails; readiness logs that and
 * analyses unwarmed.
 * @type {NonNullable<import('../types').LanguageProvider['warmUpTarget']>}
 */
async function warmUpTarget({ repo, files, services, log }) {
  if (!services) return null;
  const availability = await services.available(pythonRules.id);
  if (!availability.ok) {
    log(`warm-up: Python skipped — ${availability.reason}`);
    return null;
  }
  const file = path.join(repo, files[0]);
  const symbols = await services.documentSymbols({ file, side: 'head' });
  const first = firstCallable(symbols || []);
  return first ? { file, pos: first.selectionRange.start } : null;
}

/** @type {import('../types').LanguageProvider} */
const pythonProvider = Object.freeze({
  ...pythonRules,
  needsServer: true,
  prepare,
  editorCallers: ({ services, repoRoot, trace, clock }) => require('./editor-extras').createPythonEditorExtras({
    services, repoRoot, trace, ...(clock ? { clock } : {}),
  }),
  warmUpTarget,
  serverLabel: 'the Python language server (Pyright)',
});

module.exports = { pythonProvider, pythonSpec, collectPythonSymbols, renderPythonSymbolSig, scanDef };
