// @ts-check
'use strict';
// What a caller resolver adds for a Python target to the callers Pyright reports
// (docs/MULTI_LANGUAGE_PLAN.md, P-D4 and P4; `EditorCallerExtras` in ../types.js). Applied
// by the editor's resolver (src/resolver-vscode.js) and, the same way, by the test harness
// (test/lsp-harness/harness-languages.js). Pyright's blind spots, measured in P0
// (test/lsp-harness/P0-REPORT.md §3–§5), and what is done about each:
//
// - Duplicated sites. A method's caller comes back with every `fromRange` twice (22 for 11
//   sites). `filter` keeps each site once; it never drops a caller.
// - Property uses. For a `@property` the callers are attribute reads and writes, with no
//   `(`: those are its uses, kept as they are, and none of the checks below asks for a `(`.
// - Value uses. Pyright's call hierarchy never lists a function passed as a value (a
//   callback, a dict entry, `functools.partial(f)`, `map(f, …)`, `@f` applied); its
//   `references` does. `moreCallers` asks for the target's references: one that is not the
//   definition, not an import, not at a listed call site and not followed by `(` is a value
//   use, and the answer is incomplete with `referenced-as-value` (as Go's and TypeScript's),
//   so even an answer with no caller is never "no callers". A reference followed by `(`
//   that no listed caller has is a call, not a value use (a test caller left out of a
//   no-tests query is one); the duck-typing check below counts unlisted method calls.
// - Implicit calls. A dunder method (any `__name__` but `__init__`: `__hash__`, `__eq__`,
//   `__iter__`, `__len__`, `__enter__`/`__exit__`, `__getattr__`, `__call__`, operators,
//   descriptors, pickling, …) is called by Python itself (`hash(x)`, `a == b`, `for`,
//   `with`, `x()`), which no call hierarchy lists: its answer is always incomplete,
//   PROTOCOL_REASON, whatever explicit calls were found.
// - Constructors. Pyright answers `null` at `__init__` and lists `Cls(...)` constructions
//   only as the class's incoming calls (P7, measured on httpx: `Client.__init__` null, the
//   `Proxy` class 5 callers). `callerTargets` therefore gives the class's name for a class's
//   `__init__` (A5): the shared step asks there too and merges the constructions with the
//   explicit `__init__` calls (`super().__init__()`, when Pyright lists them), and a `null`
//   at the `__init__` itself then means no call by that name. A class defined inside a
//   function gets no target (a new class each call, mostly returned or passed as a value):
//   its `__init__` stays incomplete, CONSTRUCTOR_REASON. The constructor's answer is then
//   read by the rules here, with these in place of duck typing (which does not apply:
//   nothing calls `.__init__(` on an untyped object by that name):
//   - value uses of the `__init__` (as above), and of the class, from the class name's
//     references: one that is not the definition, an import, a listed site, a call
//     (`Cls(`), an annotation (`x: Cls`, `-> Cls`, `Optional[Cls]`, a string annotation),
//     an `isinstance`/`issubclass` class argument or an `except` clause is a value use
//     (`transport_cls=Client`, `{"a": Client}`): VALUE_USE_REASON. Annotations, `isinstance`
//     and `except` neither construct nor hand the class to code that may: not value uses.
//   - a base-class reference (`class Sub(Cls):`): a subclass's constructions run this
//     `__init__` unless it overrides it, and are listed at the subclass: SUBCLASS_REASON.
//   - `cls(...)`, `type(self)(...)` or `self.__class__(...)` in the class's body, not at a
//     listed site: a construction Pyright may not list: FACTORY_REASON.
// - Decorator registration. A function with a decorator that is not one of
//   TRANSPARENT_DECORATORS (binding and wrapping decorators that leave the function called
//   by name) may be called by whatever the decorator registered it with (`@app.route`,
//   `@pytest.fixture`, `@click.command()`, a plugin registry): with no caller found its
//   answer is incomplete, REGISTRATION_REASON, never "no callers".
// - Duck typing (P-D4 as narrowed after P0). Pyright lists `obj.method()` only when it can
//   infer `obj`'s type; calls on untyped objects are missing without a sign. For a method
//   (not a property), the repository's Python files (the provider's `handles`, so `venv/`
//   and the like are left out) are searched for `.<name>(` in code (a string or comment
//   does not count; an f-string counts as code, since its fields are); every hit that is
//   not a listed call site is asked `definition`. A hit that resolves to another function
//   is ignored. A hit that resolves to nothing (no answer, an empty one, a failed query)
//   is counted: "N calls by this name that the language server could not resolve". A hit
//   that resolves to the target is a call the server knows of but did not list; it is
//   counted too, with its own words, not added as a caller: which function it is in is
//   not known here, and a test caller left out of a no-tests query looks the same (that
//   query's completeness is not shown). Module functions are not searched: a call by name
//   is resolved through its import (P0: `httpx.get` re-exports resolve); Pyright's project
//   is what limits them (next).
//   Budgets (CODING_STYLE §2; owner: this module; enforced in `duckTypingReason` before
//   each unit of work is admitted): DUCK_MAX_FILES files read, DUCK_MAX_FILE_BYTES per
//   file, DUCK_MAX_TOTAL_BYTES in all, DUCK_MAX_DEFINITIONS code hits examined (one
//   `definition` query each), DUCK_DEADLINE_MS for the whole search. Exhaustion: the answer is
//   incomplete and says how many were not checked ("more than N calls by this name; M not
//   checked", "M of N files with calls by this name not checked"), never
//   silently complete. A search that fails (git grep) makes the answer incomplete with
//   that reason.
// - Files outside Pyright's project (A7). A `pyrightconfig.json` or `[tool.pyright]` with
//   `include`/`exclude` (./pyright-project.js) limits what Pyright analyses, and its call
//   hierarchy never lists a caller in a file outside (pydantic: most of `tests/`). For a
//   module function (and a nested one), and for a class's `__init__` by its class's name
//   (constructions `Cls(...)` there are not among the class's references either), the
//   repository's Python files outside the project (the provider's `handles`) are searched
//   for the name as a call (`name(`, `mod.name(`; not `def name(`/`class name(`) or in an
//   import, in code, not at a listed site (in a file that defines the name at module
//   level and does not import it, only `mod.name(` counts: its bare calls are its own
//   function's, as in pydantic's `v1/` copy): each is counted, not resolved (which function a
//   call by that name is cannot be asked of a server that does not analyse the file), and
//   the answer is incomplete, "N call(s) by this name in files outside the language
//   server's project (<config>)". Methods are not searched again: the duck-typing search
//   reads every file, outside the project too, and `definition` answers there (A6: 9 calls
//   of `Color.as_rgb_tuple` in `tests/test_color.py`). A property's attribute uses outside
//   the project are not searched (not detectable). No config, or one with neither key:
//   nothing is outside (Pyright's default excludes hold folders the provider does not
//   handle); no search. A config that cannot be read or parsed: the project is unknown,
//   and every Python file is searched the same way, the reason naming the config's error,
//   so a broken config never makes an answer complete. The config is read once per extras
//   instance (two bounded file reads at most), and each name's file list is searched once
//   per instance (a target is asked more than once per analysis); both are dropped at
//   `clear()`.
//   Budgets (CODING_STYLE §2; owner: this module; enforced in `outsideProjectReason` before
//   each file is read): OUTSIDE_MAX_FILES files read, OUTSIDE_MAX_FILE_BYTES per file,
//   OUTSIDE_MAX_TOTAL_BYTES in all, OUTSIDE_DEADLINE_MS for the whole search (git grep
//   included). Exhaustion: incomplete, "M of K files outside the language server's
//   project with this name not checked" (with any count found), never silently complete.
//   A failed search (git grep) is incomplete with that reason. Not found: an import alias
//   in a parenthesised multi-line import whose line holds more than the name.
// - `null` vs `[]`. Pyright answers `null` when there are no incoming calls (P0); the
//   harness keeps it ("no incoming-call result", incomplete) and VS Code's
//   `vscode.provideIncomingCalls` may turn it into `[]`. On `[]` `moreCallers` runs, and
//   the rules above decide; on `null` both resolvers stop at "no answer" first.
// Not detectable: `getattr(obj, "name")()`, `operator.methodcaller`, calls built from
// strings; a call through a base class's method that dispatches to an override.

const path = require('path');
const { readTextOfOffsets } = require('../../engine/textpos');
const { realClock } = require('../../engine/clock');
const { pythonRules } = require('./rules');
const { nonCodeRanges: lexerNonCodeRanges } = require('./lexer');
const { messageOf } = require('../text');
const { readPyrightProject } = require('./pyright-project');

/** @typedef {import('../../engine/caller-contract').CallerRow} CallerRow */
/** @typedef {import('../types').LanguageServices} LanguageServices */

// The largest file read, in bytes on disk (target, caller and searched files). Python
// source files are rarely above a few hundred KiB; a larger one is not read. For the target,
// the checks cannot run and the answer is incomplete (UNREAD_TARGET_REASON); for a caller,
// its reference is counted as a value use (it cannot be placed); for a searched file, its
// hits are not examined and the answer says so.
const MAX_FILE_BYTES = 1024 * 1024;
// Duck-typing search budgets (see the header). Defaults chosen on httpx (61 files, P0):
// the most-hit method, `Response.read`, had 48 text hits in 20 files; 50 `definition`
// queries took well under a second warm.
const DUCK_MAX_FILES = 200;          // files: those holding `.<name>(` read, in git's order
const DUCK_MAX_FILE_BYTES = MAX_FILE_BYTES; // bytes per file
const DUCK_MAX_TOTAL_BYTES = 16 * 1024 * 1024; // bytes over all searched files
const DUCK_MAX_DEFINITIONS = 50;     // code hits outside listed sites examined, one `definition` query each
const DUCK_DEADLINE_MS = 10000;      // whole search, git grep included
const GREP_TIMEOUT_MS = 5000;        // the git grep alone (within the deadline)
// Search of files outside Pyright's project (see the header). No `definition` query is
// asked, so the bound is on files and bytes; defaults as the duck search's (pydantic's
// tests: about 300 files, a name is in a handful).
const OUTSIDE_MAX_FILES = 200;          // files outside the project holding the name, read in git's order
const OUTSIDE_MAX_FILE_BYTES = MAX_FILE_BYTES; // bytes per file
const OUTSIDE_MAX_TOTAL_BYTES = 16 * 1024 * 1024; // bytes over all searched files
const OUTSIDE_DEADLINE_MS = 10000;      // whole search, git grep included

const PROTOCOL_REASON = 'called by Python itself (protocol method); its callers cannot be traced';
const REGISTRATION_REASON = 'registered by a decorator; its callers cannot be traced';
const VALUE_USE_REASON = 'referenced-as-value';
const CONSTRUCTOR_REASON = 'a constructor of a class defined in a function: its constructions (`Class(...)`) are not listed, so its callers cannot be traced';
const SUBCLASS_REASON = 'subclassed: a subclass that does not override `__init__` runs it, and its constructions are not listed here';
const FACTORY_REASON = 'constructed through `cls(...)` or `type(self)(...)` in the class, which the language server may not list';
// When the checks above cannot run, the server's list alone is not known to be complete.
const UNREAD_TARGET_REASON = 'its file could not be read, so value uses and untyped calls were not checked';
const NO_SERVICES_REASON = 'no language services or repository, so value uses and untyped calls were not checked';
// The shared default's reason for a `null` incoming-calls answer (../callers-from-hierarchy.js).
const NO_INCOMING_RESULT = 'no incoming-call result';

// Decorators that leave the function called by its name: how it is bound
// (property family, staticmethod, classmethod), typing markers, and wrappers whose result
// is still called directly. Matched on the decorator's last dotted name, before any `(`.
// Any other decorator may register the function somewhere its calls cannot be followed.
const TRANSPARENT_DECORATORS = new Set([
  'property', 'cached_property', 'setter', 'getter', 'deleter', 'staticmethod', 'classmethod',
  'overload', 'override', 'final', 'abstractmethod', 'abstractproperty', 'abstractclassmethod',
  'abstractstaticmethod', 'no_type_check', 'deprecated', 'wraps', 'cache', 'lru_cache',
  'contextmanager', 'asynccontextmanager', 'singledispatch', 'singledispatchmethod',
]);

/** @param {unknown} e */

/** @param {string} name A dunder name Python calls itself (all but `__init__`). */
const isProtocolName = (name) => /^__\w+__$/.test(name) && name !== '__init__';
/** A class's `__init__` (a module function named so is not a constructor). @param {{ name: string, isMethod: boolean }} decl */
const isConstructorDecl = (decl) => decl.isMethod && decl.name === '__init__';

/**
 * Offsets of `text` that are not code: comments and string literals other than f-strings
 * (an f-string's fields are code, so it counts as code). Pure; ./lexer.js reads the strings.
 * @param {string} text
 * @returns {Array<[number, number]>} Sorted, disjoint [start, end) ranges.
 */
const nonCodeRanges = (text) => lexerNonCodeRanges(text, { fStringsAsCode: true });

/**
 * @param {Array<[number, number]>} ranges From `nonCodeRanges`. @param {number} at
 * @returns {boolean} Whether `at` is in code.
 */
function inCode(ranges, at) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][1] <= at) lo = mid + 1;
    else if (ranges[mid][0] > at) hi = mid - 1;
    else return false;
  }
  return true;
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Offsets of the name in each `.<name>(` call text that is in code. Pure.
 * @param {string} text @param {string} name
 * @returns {number[]}
 */
function attributeCallHits(text, name) {
  const re = new RegExp(`\\.[ \\t]*(${escapeRe(name)})[ \\t]*\\(`, 'g');
  /** @type {number[]} */
  const hits = [];
  let ranges = null;
  for (const m of text.matchAll(re)) {
    const at = /** @type {number} */ (m.index) + m[0].indexOf(name, 1);
    ranges = ranges || nonCodeRanges(text);
    if (inCode(ranges, at)) hits.push(at);
  }
  return hits;
}

/**
 * Offsets of `name` in `text` used as a call (`name(`, `mod.name(`; not `def name(` or
 * `class name(`) or named in an import statement, in code. Pure.
 * @param {string} text @param {string} name
 * @returns {number[]}
 */
function nameUseHits(text, name) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'gu');
  /** @type {number[]} */
  const hits = [];
  let ranges = null;
  for (const m of text.matchAll(re)) {
    const at = /** @type {number} */ (m.index);
    const end = at + name.length;
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    const called = isCalledAt(text, at, end) === true && !/(?:^|[^\w.])(?:def|class)[ \t]+$/.test(text.slice(lineStart, at));
    if (!called && !isImportAt(text, at)) continue;
    ranges = ranges || nonCodeRanges(text);
    if (inCode(ranges, at)) hits.push(at);
  }
  return hits;
}

/**
 * The function declared with its name at `pos`: its name, whether it is a method (its
 * `def` is inside a `class` body) and its decorators' texts. Null when `pos` is not at a
 * `def`'s name. Pure.
 * @param {string} text @param {number} pos
 * @returns {{ name: string, isMethod: boolean, decorators: string[] }|null}
 */
function declarationAt(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const head = /^([ \t]*)(?:async[ \t]+)?def[ \t]+$/.exec(text.slice(lineStart, pos));
  const nameMatch = /^[^\W\d]\w*/u.exec(text.slice(pos, pos + 256));
  if (!head || !nameMatch) return null;
  const indent = head[1].length;
  const lines = text.slice(0, lineStart).split('\n');
  lines.pop(); // the empty tail after the last newline
  /** @type {string[]} */
  const decorators = [];
  let isMethod = false;
  let k = lines.length - 1;
  // Decorators directly above (comments and blank lines between them allowed). A
  // decorator's arguments may span lines (`@app.route(\n    "/x",\n)`): lines indented
  // deeper than the `def`, or closing a bracket, are skipped while looking for its `@`,
  // up to MAX_DECORATOR_LINES lines.
  for (; k >= 0; k--) {
    const line = lines[k];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const d = /^([ \t]*)@\s*(.*)$/.exec(line);
    if (d && d[1].length === indent) { decorators.unshift(d[2].trim()); continue; }
    let j = k;
    const continues = (/** @type {string} */ l) => /^\s*[)\]}]/.test(l) || l.length - l.trimStart().length > indent || /^\s*$/.test(l);
    while (j >= 0 && k - j < MAX_DECORATOR_LINES && continues(lines[j])) j--;
    const open = j >= 0 && j < k ? /^([ \t]*)@\s*(.*)$/.exec(lines[j]) : null;
    if (open && open[1].length === indent) { decorators.unshift(open[2].trim()); k = j; continue; }
    break;
  }
  // The enclosing block: the nearest line above with less indentation.
  if (indent > 0) {
    for (; k >= 0; k--) {
      const line = lines[k];
      if (/^\s*(#.*)?$/.test(line)) continue;
      const ind = line.length - line.trimStart().length;
      if (ind < indent) { isMethod = /^[ \t]*class\b/.test(line); break; }
    }
  }
  return { name: nameMatch[0], isMethod, decorators };
}

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length;
/** @param {string} line A blank or comment-only line. */
const isTrivia = (line) => /^\s*(#.*)?$/.test(line);

/**
 * The class whose body holds the `def` whose name is at `pos`, when that class is not
 * inside a function: the offset of the class's name and its body's [start, end) offsets.
 * Found by indentation from the text, as `declarationAt` finds the enclosing block (a
 * nested class's own name for a nested class; decorators above the class do not matter).
 * Null when the `def` is not directly in a class body, or the class is defined in a
 * function (at any depth). Pure.
 * @param {string} text @param {number} pos
 * @returns {{ namePos: number, bodyStart: number, bodyEnd: number }|null}
 */
function enclosingClassAt(text, pos) {
  const defStart = text.lastIndexOf('\n', pos - 1) + 1;
  if (!/^[ \t]*(?:async[ \t]+)?def[ \t]+$/.test(text.slice(defStart, pos))) return null;
  let indent = indentOf(text.slice(defStart, pos));
  /** @type {{ namePos: number, bodyStart: number, bodyEnd: number }|null} */
  let found = null;
  let end = defStart; // start of the line below the one being read
  while (end > 0 && indent > 0) {
    const start = text.lastIndexOf('\n', end - 2) + 1;
    const line = text.slice(start, end - 1);
    end = start;
    if (isTrivia(line) || indentOf(line) >= indent) continue;
    indent = indentOf(line);
    if (!found) {
      const m = /^([ \t]*class[ \t]+)([^\W\d]\w*)/u.exec(line);
      if (!m) return null; // the `def` is not in a class body
      const classIndent = indent;
      const bodyStart = text.indexOf('\n', start) + 1 || text.length;
      let bodyEnd = text.length;
      for (let at = bodyStart; at < text.length;) {
        const nl = text.indexOf('\n', at);
        const next = nl < 0 ? text.length : nl + 1;
        const l = text.slice(at, nl < 0 ? text.length : nl);
        if (!isTrivia(l) && indentOf(l) <= classIndent) { bodyEnd = at; break; }
        at = next;
      }
      found = { namePos: start + m[1].length, bodyStart, bodyEnd };
    } else if (/^[ \t]*(?:async[ \t]+)?def\b/.test(line)) {
      return null; // a class defined in a function
    }
  }
  return found;
}

/**
 * How a reference to a class at [start, end) uses it, for its `__init__`'s verdict:
 * `'call'` (`Cls(`), `'base'` (in a `class X(…)` base list), `'inert'` (an annotation,
 * a string annotation, an `isinstance`/`issubclass` class argument, an `except` clause:
 * nothing is constructed or handed on), or `'value'` (anything else, such as
 * `transport_cls=Client`). Pure; a heuristic on the text before and after the name, which
 * reads `'value'` whenever it is unsure. `ranges` is `nonCodeRanges(text)`.
 * @param {string} text @param {number} start @param {number} end @param {Array<[number, number]>} ranges
 * @returns {'call'|'base'|'inert'|'value'}
 */
function classUseAt(text, start, end, ranges) {
  if (!inCode(ranges, start)) return 'inert'; // a string annotation ("Client")
  if (isCalledAt(text, start, end) === true) return 'call';
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(lineStart, start);
  if (/^[ \t]*class[ \t]+\w+[ \t]*\([^)]*$/.test(before)) return 'base';
  if (/^[ \t]*except\b[^:]*$/.test(before)) return 'inert';
  if (/\b(?:isinstance|issubclass)[ \t]*\([^()]*,[ \t(]*(?:[\w.]+[ \t]*,[ \t]*)*[\w.]*$/.test(before)) return 'inert';
  // An annotation: walk back over a type expression (`Optional[`, `A | `, `typing.`) to
  // the `:` or `->` it follows.
  const m = /[\w.\s[,|]*$/.exec(before);
  const lead = before.slice(0, before.length - (m ? m[0].length : 0));
  if (/->$/.test(lead)) return 'inert';
  if (/^[ \t]*[\w.]+[ \t]*:$/.test(lead)) return 'inert'; // `x: Cls` / `self.x: Cls = …`
  if (/[(,][ \t]*\*{0,2}\w+[ \t]*:$/.test(lead) && inDefHeader(text, start)) return 'inert';
  return 'value';
}

/**
 * Whether `at` is inside a `def`'s parameter list (its `(` opened and not closed before
 * `at`), looking back at most 4096 characters. Pure; brackets in strings are not skipped.
 * @param {string} text @param {number} at
 */
function inDefHeader(text, at) {
  const from = Math.max(0, at - 4096);
  const before = text.slice(from, at);
  const heads = [...before.matchAll(/(?:^|\n)[ \t]*(?:async[ \t]+)?def[ \t]+\w+[ \t]*\(/g)];
  const last = heads[heads.length - 1];
  if (!last) return false;
  let depth = 1;
  for (const ch of before.slice(/** @type {number} */ (last.index) + last[0].length)) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0) return false;
  }
  return true;
}

/**
 * How many `cls(`, `type(self)(` or `self.__class__(` calls in code in the class's body are
 * not at a listed site (`listed`: `file#start`). Pure.
 * @param {string} text @param {{ bodyStart: number, bodyEnd: number }} cls
 * @param {Set<string>} listed @param {string} file
 */
function factoryCallsIn(text, cls, listed, file) {
  const body = text.slice(cls.bodyStart, cls.bodyEnd);
  const re = /\bcls[ \t]*\(|\btype[ \t]*\([ \t]*self[ \t]*\)[ \t]*\(|\bself[ \t]*\.[ \t]*__class__[ \t]*\(/g;
  let ranges = null;
  let count = 0;
  for (const m of body.matchAll(re)) {
    const at = cls.bodyStart + /** @type {number} */ (m.index);
    ranges = ranges || nonCodeRanges(text);
    if (!inCode(ranges, at) || listed.has(`${file}#${at}`)) continue;
    count++;
  }
  return count;
}

/**
 * Whether the attribute call whose name is at `at` is on a string literal (`"x".join(`,
 * `b"".split(`): the character before the `.`, past spaces, closes a string. Pure; `ranges`
 * is `nonCodeRanges(text)`, computed once per file, so each hit costs no rescan.
 * @param {string} text @param {number} at @param {Array<[number, number]>} ranges
 */
function hasStringReceiver(text, at, ranges) {
  const dot = text.lastIndexOf('.', at - 1);
  let i = dot - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  if (i < 0 || (text[i] !== '"' && text[i] !== '\'')) return false;
  // The quote closes a string when it is not code. (Not a comment: the call text after it
  // is code, and a comment runs to the line's end.)
  return !inCode(ranges, i);
}

// How many lines a multi-line decorator's arguments may take (see `declarationAt`).
const MAX_DECORATOR_LINES = 50;

/** @param {string} decorator Text after `@`. @returns {boolean} One that may register it. */
function isRegistrationDecorator(decorator) {
  const callee = decorator.split('(')[0].trim();
  const last = callee.split('.').pop() || '';
  return !TRANSPARENT_DECORATORS.has(last);
}

/** @param {CallerRow[]} callers @returns {CallerRow[]} Each caller with each site once. */
function dedupeSites(callers) {
  return callers.map((caller) => {
    const sites = caller.callSites;
    if (!sites || sites.length < 2) return caller;
    const seen = new Set();
    const unique = sites.filter((s) => {
      const id = `${s.start}:${s.end}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return unique.length === sites.length ? caller : { ...caller, callSites: unique, sites: unique.length };
  });
}

/**
 * Whether the reference at [start, end) is followed by `(` (past spaces, tabs and a
 * backslash line continuation). Null when unknown. Pure.
 * @param {string|null} text @param {number|null} start @param {number|null} end
 * @returns {boolean|null}
 */
function isCalledAt(text, start, end) {
  if (typeof text !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  const e = /** @type {number} */ (end);
  if (!(0 <= /** @type {number} */ (start) && /** @type {number} */ (start) < e && e <= text.length)) return null;
  const m = /^(?:[ \t]|\\\r?\n)*/.exec(text.slice(e, e + 256));
  return text[e + (m ? m[0].length : 0)] === '(';
}

/**
 * Whether the reference at `start` is in an import statement (`import x`, `from m import
 * x`, or a parenthesised `from m import (…)` list). Pure.
 * @param {string} text @param {number} start
 */
function isImportAt(text, start) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (/^[ \t]*(?:from[ \t]+[\w.]+[ \t]+)?import\b/.test(text.slice(lineStart, start))) return true;
  const before = text.slice(Math.max(0, start - 4096), start);
  return /(?:^|\n)[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]*\([^)]*$/.test(before);
}

/**
 * Python's caller extras. Holds no state between queries but Pyright's project, read once
 * and dropped at `clear()`.
 * @param {{ trace?: (message: string) => void, readText?: (file: string) => string|null,
 *   services?: LanguageServices|null, repoRoot?: string|null,
 *   grep?: ((pattern: string, timeoutMs: number) => Promise<string[]>)|null,
 *   clock?: { now: () => number }, readConfig?: ((abs: string) => string|null)|null }} [options]
 *   `readText` (tests): a file's text, by default through src/engine/textpos.js (the text
 *   the offsets were converted from), up to MAX_FILE_BYTES. `services` and `repoRoot`:
 *   where references and definitions are asked and which files are searched; without
 *   either, no check runs (the server's answer stands). `grep`: lists the repository-relative
 *   paths of tracked and untracked Python files matching an extended regular expression,
 *   rejecting when the search failed; by default `git grep` in `repoRoot`. `readConfig`
 *   (tests): a config file's text, null when absent, throwing on a failure; by default a
 *   bounded read (./pyright-project.js).
 * @returns {import('../types').EditorCallerExtras}
 */
function createPythonEditorExtras({ trace = () => {}, readText = (file) => readTextOfOffsets(file, { maxBytes: MAX_FILE_BYTES }), services = null, repoRoot = null, grep = null, clock = realClock, readConfig = null } = {}) {
  const search = grep || (repoRoot ? gitGrepPython(/** @type {string} */ (repoRoot)) : null);
  /** @type {ReturnType<typeof readPyrightProject>|undefined} Pyright's project, read on first use (undefined: not yet). */
  let project;
  const projectOf = () => {
    if (project === undefined) project = repoRoot ? (readConfig ? readPyrightProject(repoRoot, readConfig) : readPyrightProject(repoRoot)) : null;
    return project;
  };
  /** @type {Map<string, Promise<string[]>>} Per name, the files the search found (each name searched once per instance, as the project). */
  const outsideFiles = new Map();

  /**
   * The verdict on files outside Pyright's project (see the header), within its budgets.
   * @param {string} name @param {Set<string>} listed
   * @returns {Promise<string|null>}
   */
  async function outsideProjectReason(name, listed) {
    const proj = projectOf();
    if (!search || !repoRoot || !proj || ('explicit' in proj && !proj.explicit)) return null;
    const unknown = 'error' in proj ? proj : null;
    const inProject = 'inProject' in proj ? proj.inProject : () => false;
    const started = clock.now();
    const late = () => clock.now() - started >= OUTSIDE_DEADLINE_MS;
    const n = escapeRe(name);
    let rels;
    try {
      // The files naming it as a word (a simple pattern: git's search is about twice as
      // fast as with the call/import alternatives, measured on pydantic); the text decides.
      let files = outsideFiles.get(name);
      if (!files) {
        files = search(`(^|[^[:alnum:]_])${n}([^[:alnum:]_]|$)`, GREP_TIMEOUT_MS);
        outsideFiles.set(name, files);
      }
      rels = (await files).filter((rel) => pythonRules.handles(rel) && !inProject(rel));
    } catch (e) {
      return `calls by this name in files outside the language server's project could not be searched: ${messageOf(e)}`;
    }
    let found = 0;
    let filesRead = 0;
    let bytes = 0;
    let filesUnchecked = 0;
    /** @type {string[]} */
    const examples = [];
    for (const rel of rels) {
      if (filesRead >= OUTSIDE_MAX_FILES || late()) { filesUnchecked++; continue; }
      const abs = path.join(/** @type {string} */ (repoRoot), rel);
      const text = readText(abs);
      if (typeof text !== 'string' || text.length > OUTSIDE_MAX_FILE_BYTES || bytes + text.length > OUTSIDE_MAX_TOTAL_BYTES) { filesUnchecked++; continue; }
      filesRead++;
      bytes += text.length;
      const hits = nameUseHits(text, name);
      // A file with its own module-level `def name`/`class name` and no import of the name
      // calls its own by the bare name (pydantic's `v1/` copy of its modules): only its
      // attribute calls (`mod.name(`) may be the target's.
      const own = new RegExp(`^(?:async[ \\t]+)?(?:def|class)[ \\t]+${n}(?![\\p{L}\\p{N}_])`, 'mu').test(text)
        && !hits.some((at) => isImportAt(text, at));
      for (const at of hits) {
        if (listed.has(`${abs}#${at}`)) continue;
        if (own && !/\.[ \t]*$/.test(text.slice(Math.max(0, at - 64), at))) continue;
        found++;
        if (examples.length < 3) examples.push(`${rel}:${text.slice(0, at).split('\n').length}`);
      }
    }
    const where = unknown
      ? `the language server did not list; its project could not be read (${unknown.configFile}: ${unknown.error})`
      : `in files outside the language server's project (${proj.configFile})`;
    trace(`python: outside-project search for ${name}: ${rels.length} file(s), ${filesRead} read, ${found} use(s)${examples.length ? ` (e.g. ${examples.join(', ')})` : ''}, ${filesUnchecked} file(s) not checked`);
    /** @type {string[]} */
    const parts = [];
    if (found) parts.push(`${found} call${found === 1 ? '' : 's'} by this name ${where}`);
    if (filesUnchecked) parts.push(`${filesUnchecked} of ${rels.length} files ${unknown ? 'with this name' : 'outside the language server\'s project with this name'} not checked`);
    return parts.length ? parts.join('; ') : null;
  }

  /**
   * The value-use verdict from the target's references.
   * @param {LanguageServices} svc @param {string} file @param {number} pos @param {Set<string>} listed
   * @returns {Promise<string|null>}
   */
  async function valueUseReason(svc, file, pos, listed) {
    let refs;
    try {
      refs = await svc.references({ file, side: 'head' }, pos);
    } catch (e) {
      return `its references could not be listed: ${messageOf(e)}`;
    }
    if (!Array.isArray(refs)) return 'its references could not be listed (no answer)';
    let values = 0;
    for (const r of refs) {
      if (r.file === file && r.start != null && r.end != null && r.start <= pos && pos < r.end) continue; // the definition
      if (r.start != null && listed.has(`${r.file}#${r.start}`)) continue;
      const text = readText(r.file);
      // A reference that cannot be placed counts, as in `referenceVerdict`.
      if (typeof text === 'string' && r.start != null && isImportAt(text, r.start)) continue;
      if (isCalledAt(text, r.start, r.end) === true) continue;
      values++;
    }
    if (values) trace(`python: ${values} value use(s) of ${path.basename(file)}@${pos} among ${refs.length} reference(s)`);
    return values ? VALUE_USE_REASON : null;
  }

  /**
   * The constructor verdict beyond the `__init__`'s own value uses (see the header): the
   * class's references, then factory calls in its body.
   * @param {LanguageServices} svc @param {string} file @param {string} text The target file's text.
   * @param {{ namePos: number, bodyStart: number, bodyEnd: number }} cls From `enclosingClassAt`.
   * @param {Set<string>} listed `file#start` of every listed call site.
   * @returns {Promise<string|null>}
   */
  async function constructionReason(svc, file, text, cls, listed) {
    let refs;
    try {
      refs = await svc.references({ file, side: 'head' }, cls.namePos);
    } catch (e) {
      return `its class's references could not be listed: ${messageOf(e)}`;
    }
    if (!Array.isArray(refs)) return 'its class\'s references could not be listed (no answer)';
    let values = 0;
    let bases = 0;
    /** @type {Map<string, Array<[number, number]>>} */
    const rangesOf = new Map();
    for (const r of refs) {
      if (r.file === file && r.start != null && r.end != null && r.start <= cls.namePos && cls.namePos < r.end) continue; // the definition
      if (r.start != null && listed.has(`${r.file}#${r.start}`)) continue;
      const t = r.file === file ? text : readText(r.file);
      // A reference that cannot be placed counts, as in `referenceVerdict`.
      if (typeof t !== 'string' || r.start == null || r.end == null || !(0 <= r.start && r.start < r.end && r.end <= t.length)) { values++; continue; }
      if (isImportAt(t, r.start)) continue;
      let ranges = rangesOf.get(r.file);
      if (!ranges) { ranges = nonCodeRanges(t); rangesOf.set(r.file, ranges); }
      const use = classUseAt(t, r.start, r.end, ranges);
      if (use === 'value') values++;
      else if (use === 'base') bases++;
    }
    const factory = factoryCallsIn(text, cls, listed, file);
    trace(`python: constructor of ${path.basename(file)}@${cls.namePos}: ${refs.length} class reference(s), ${values} value use(s), ${bases} subclass(es), ${factory} factory call(s) unlisted`);
    if (values) return VALUE_USE_REASON;
    if (bases) return SUBCLASS_REASON;
    if (factory) return FACTORY_REASON;
    return null;
  }

  /**
   * The duck-typing verdict (see the header), within the budgets.
   * @param {LanguageServices} svc @param {string} file @param {number} pos @param {string} name @param {Set<string>} listed
   * @returns {Promise<string|null>}
   */
  async function duckTypingReason(svc, file, pos, name, listed) {
    if (!search || !repoRoot) return null;
    const started = clock.now();
    const late = () => clock.now() - started >= DUCK_DEADLINE_MS;
    let rels;
    try {
      rels = (await search(`\\.[[:space:]]*${escapeRe(name)}[[:space:]]*\\(`, GREP_TIMEOUT_MS)).filter((rel) => pythonRules.handles(rel));
    } catch (e) {
      return `calls by this name could not be searched: ${messageOf(e)}`;
    }
    let unresolved = 0;
    /** @type {string[]} */
    const examples = []; // a few unresolved hits, for the trace
    let missed = 0;
    let examined = 0;
    let bytes = 0;
    let filesRead = 0;
    let unchecked = 0; // hits found but not examined
    let filesUnchecked = 0; // files not read
    for (const rel of rels) {
      if (filesRead >= DUCK_MAX_FILES || late()) { filesUnchecked++; continue; }
      const abs = path.join(/** @type {string} */ (repoRoot), rel);
      const text = readText(abs);
      if (typeof text !== 'string' || text.length > DUCK_MAX_FILE_BYTES || bytes + text.length > DUCK_MAX_TOTAL_BYTES) { filesUnchecked++; continue; }
      filesRead++;
      bytes += text.length;
      const hits = attributeCallHits(text, name);
      const ranges = hits.length ? nonCodeRanges(text) : [];
      for (const at of hits) {
        if (listed.has(`${abs}#${at}`)) continue;
        // `", ".join(…)`: a method of a string literal, never the target.
        if (hasStringReceiver(text, at, ranges)) continue;
        if (examined >= DUCK_MAX_DEFINITIONS || late()) { unchecked++; continue; }
        examined++;
        /** @type {import('../types').ServerLocation[]|null} */
        let locations;
        // A failed query is no answer: the hit counts as unresolved.
        try { locations = await svc.definitions({ file: abs, side: 'head' }, at); } catch { locations = null; }
        if (!Array.isArray(locations) || !locations.length) {
          unresolved++;
          if (examples.length < 3) examples.push(`${rel}:${text.slice(0, at).split('\n').length}`);
          continue;
        }
        const toTarget = locations.some((l) => l.file === file && (l.start === pos || (l.start != null && l.end != null && l.start <= pos && pos < l.end)));
        if (toTarget) missed++;
      }
    }
    trace(`python: duck-typing search for .${name}( : ${rels.length} file(s), ${filesRead} read, ${examined} hit(s) examined, ${unresolved} unresolved${examples.length ? ` (e.g. ${examples.join(', ')})` : ''}, ${missed} resolved to it but unlisted, ${unchecked} hit(s) and ${filesUnchecked} file(s) not checked`);
    /** @type {string[]} */
    const parts = [];
    if (unresolved) parts.push(`${unresolved} call${unresolved === 1 ? '' : 's'} by this name that the language server could not resolve`);
    if (missed) parts.push(`${missed} call${missed === 1 ? '' : 's'} the language server resolves to it but did not list`);
    if (unchecked) parts.push(`more than ${examined} calls by this name; ${unchecked} not checked`);
    if (filesUnchecked) parts.push(`${filesUnchecked} of ${rels.length} files with calls by this name not checked`);
    return parts.length ? parts.join('; ') : null;
  }

  return {
    // Python never suppresses a query (`isSuppressed` is always false).
    suppressedReason: 'caller query not asked',
    // Nothing is dropped: `filter` only removes duplicated sites.
    droppedStat: 'valueUsesDropped',
    query(file, pos) {
      /** @type {CallerRow[]} */
      let seen = [];
      return {
        isSuppressed: () => false,
        filter(callers) {
          const kept = dedupeSites(callers);
          seen = kept;
          return { kept, dropped: 0 };
        },
        // Asked after `filter` (which is skipped when there is no caller). Adds no caller,
        // only says whether the answer is complete; the first rule that applies decides.
        async moreCallers() {
          const none = { callers: [], incompleteReason: null };
          const text = readText(file);
          if (typeof text !== 'string') return { callers: [], incompleteReason: UNREAD_TARGET_REASON };
          // Not at a `def` (a module-level caller of a deeper level): nothing to check.
          const decl = declarationAt(text, pos);
          if (!decl) return none;
          if (isProtocolName(decl.name)) return { callers: [], incompleteReason: PROTOCOL_REASON };
          const cls = isConstructorDecl(decl) ? enclosingClassAt(text, pos) : null;
          if (isConstructorDecl(decl) && !cls) return { callers: [], incompleteReason: CONSTRUCTOR_REASON };
          if (!services || !repoRoot) return { callers: [], incompleteReason: NO_SERVICES_REASON };
          const isProperty = decl.decorators.some((d) => /^(?:[\w.]*\.)?(?:property|cached_property)\b|^\w+\.(?:setter|getter|deleter)\b/.test(d));
          /** @type {Set<string>} */
          const listed = new Set();
          for (const c of seen) for (const s of c.callSites || []) if (s.start != null) listed.add(`${c.file}#${s.start}`);
          // A property's uses are attribute accesses, not value uses.
          if (!isProperty) {
            const value = await valueUseReason(services, file, pos, listed);
            if (value) return { callers: [], incompleteReason: value };
          }
          if (cls) {
            const construction = await constructionReason(services, file, text, cls, listed);
            if (construction) return { callers: [], incompleteReason: construction };
            const className = /^[^\W\d]\w*/u.exec(text.slice(cls.namePos, cls.namePos + 256));
            return { callers: [], incompleteReason: className ? await outsideProjectReason(className[0], listed) : null };
          }
          if (!seen.length && decl.decorators.some(isRegistrationDecorator)) return { callers: [], incompleteReason: REGISTRATION_REASON };
          if (isProperty) return none;
          if (!decl.isMethod) return { callers: [], incompleteReason: await outsideProjectReason(decl.name, listed) };
          return { callers: [], incompleteReason: await duckTypingReason(services, file, pos, decl.name, listed) };
        },
      };
    },
    // Pyright answers `null` for a function with no incoming call (P0), which the shared
    // default reads as "no incoming-call result" (incomplete) without asking `moreCallers`.
    // For a protocol method or a registered function that is the expected answer: say why.
    explainIncomplete(reason, file, pos) {
      if (reason !== NO_INCOMING_RESULT) return null;
      const text = readText(file);
      const decl = typeof text === 'string' ? declarationAt(text, pos) : null;
      if (!decl) return null;
      if (isProtocolName(decl.name)) return PROTOCOL_REASON;
      // With its class as a caller target, an `__init__`'s `null` is no call by that name
      // (the shared step reads it so); a class in a function has no target.
      if (isConstructorDecl(decl)) return enclosingClassAt(/** @type {string} */ (text), pos) ? null : CONSTRUCTOR_REASON;
      if (decl.decorators.some(isRegistrationDecorator)) return REGISTRATION_REASON;
      return null;
    },
    // A class's `__init__`: its class's name, where Pyright lists the constructions.
    callerTargets(file, pos) {
      const text = readText(file);
      if (typeof text !== 'string') return [];
      const decl = declarationAt(text, pos);
      if (!decl || !isConstructorDecl(decl)) return [];
      const cls = enclosingClassAt(text, pos);
      return cls ? [{ file, pos: cls.namePos }] : [];
    },
    // Pyright's call hierarchy answers for the whole workspace; there are no users it is
    // known not to see beyond those `moreCallers` checks.
    unseenUsers: async () => null,
    // Pyright's project is read, and each name searched, again after this.
    clear() { project = undefined; outsideFiles.clear(); },
  };
}

/**
 * A search over a repository's tracked and untracked (not ignored) Python files for an
 * extended regular expression. No match is an empty list; any other failure rejects.
 * @param {string} repoRoot
 * @returns {(pattern: string, timeoutMs: number) => Promise<string[]>}
 */
function gitGrepPython(repoRoot) {
  const { makeGit } = require('../../engine/git');
  const git = makeGit(repoRoot);
  return async (pattern, timeoutMs) => {
    try {
      const out = await git.rawAsync(['grep', '-l', '-I', '-E', '--untracked', '-e', pattern, '--', '*.py', '*.pyi'], { timeoutMs });
      return out.split('\n').filter(Boolean);
    } catch (e) {
      if (e && /** @type {any} */ (e).code === 1 && !/** @type {any} */ (e).killed) return [];
      throw e;
    }
  };
}

module.exports = {
  createPythonEditorExtras, nonCodeRanges, inCode, attributeCallHits, declarationAt, isRegistrationDecorator,
  dedupeSites, isCalledAt, nameUseHits, hasStringReceiver, isImportAt, isProtocolName, TRANSPARENT_DECORATORS,
  PROTOCOL_REASON, REGISTRATION_REASON, VALUE_USE_REASON, UNREAD_TARGET_REASON, NO_SERVICES_REASON, CONSTRUCTOR_REASON,
  SUBCLASS_REASON, FACTORY_REASON, enclosingClassAt, classUseAt, factoryCallsIn,
  DUCK_MAX_FILES, DUCK_MAX_FILE_BYTES, DUCK_MAX_TOTAL_BYTES, DUCK_MAX_DEFINITIONS, DUCK_DEADLINE_MS, MAX_FILE_BYTES,
  OUTSIDE_MAX_FILES, OUTSIDE_MAX_FILE_BYTES, OUTSIDE_MAX_TOTAL_BYTES, OUTSIDE_DEADLINE_MS,
};
