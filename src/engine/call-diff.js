// @ts-check
'use strict';
// The calls a changed function gained and lost: the names it calls on the head side that it
// did not call on the base side, and the other way round. Read from the text, by name, for
// every language the engine knows: a name followed by `(` is a call. The base side is the
// head body with the diff undone (its added lines out, its removed lines in), so only the
// file diff and the head text are needed. Pure.
//
// By name means: two calls to the same name are one; a call moved to another line is
// neither gained nor lost; a call that only changed its arguments is unchanged. Left out:
// the function's own name (its declaration looks like a call; recursion is rare), calls on
// an expression's result (`f().g(`), and the language's own helpers (`.map`, `String`,
// `JSON.parse`, `len`), which say how the code is written rather than what it depends on.

/** Words followed by `(` that are not calls. */
const NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'def', 'func', 'elif', 'with',
  'assert', 'in', 'of', 'not', 'and', 'or', 'lambda', 'yield', 'await', 'else', 'do', 'case', 'throw',
  'sizeof', 'instanceof', 'void', 'delete', 'except', 'select', 'go', 'defer', 'super', 'this', 'synchronized',
]);
/**
 * Methods of the language's own strings, arrays, regular expressions and promises: a call to
 * one says how the code is written, not what it depends on, so it is left out.
 */
const BUILTIN_METHODS = new Set([
  'map', 'filter', 'reduce', 'forEach', 'some', 'every', 'find', 'findIndex', 'flatMap', 'flat', 'includes', 'indexOf',
  'lastIndexOf', 'slice', 'splice', 'concat', 'join', 'split', 'push', 'pop', 'shift', 'unshift', 'sort', 'reverse',
  'keys', 'values', 'entries', 'trim', 'trimStart', 'trimEnd', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase',
  'padStart', 'padEnd', 'replace', 'replaceAll', 'match', 'matchAll', 'test', 'exec', 'toString', 'toFixed', 'charAt',
  'charCodeAt', 'codePointAt', 'at', 'fill', 'then', 'catch', 'finally', 'bind', 'call', 'apply', 'append', 'extend',
  'strip', 'lower', 'upper', 'format', 'items', 'pipe',
]);
/** The language's own functions and namespaces, left out for the same reason. */
const BUILTINS = new Set([
  'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Array', 'Object', 'JSON', 'Math', 'Reflect', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict',
  'set', 'tuple', 'isinstance', 'range', 'enumerate', 'zip', 'sorted', 'append', 'make', 'cap', 'copy', 'panic',
]);
/** A word before a name that makes it a declaration, not a call. */
const DECLARES = /(?:\bfunction\s*\*?|\bdef|\bfunc(?:\s*\([^)]*\))?|\bclass|\binterface|\btype)\s*$/;
/** A dotted name, with optional type arguments, before `(`. */
const CALL = /([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[\w$.,\s<>[\]|&?]*>)?\s*\(/g;
/** Most names listed per side; the rest are counted. */
const MAX_CALLS = 12;

/**
 * One line without its strings and comments, so names inside them are not read as calls.
 * @param {string} line @param {boolean} hashComments `#` starts a comment (Python).
 */
function codeOf(line, hashComments) {
  let s = line.replace(/\/\*.*?\*\//g, ' ').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  const slash = s.indexOf('//');
  if (slash >= 0) s = s.slice(0, slash);
  if (hashComments) { const hash = s.indexOf('#'); if (hash >= 0) s = s.slice(0, hash); }
  return s;
}

/**
 * The names called on one line, in order.
 * @param {string} line @param {{ self?: string, hashComments?: boolean }} [opts]
 * @returns {string[]}
 */
function callsOn(line, { self, hashComments = false } = {}) {
  const code = codeOf(line, hashComments);
  /** @type {string[]} */
  const out = [];
  for (const m of code.matchAll(CALL)) {
    const name = m[1].replace(/\s+/g, '').replace(/\?\./g, '.');
    const dot = name.lastIndexOf('.');
    const last = name.slice(dot + 1);
    const first = name.split('.')[0];
    if (NOT_CALLS.has(name) || last === self || BUILTINS.has(first)) continue;
    // `rows.map(` is the language's; `Effect.map(` (a capitalised namespace or class) is not.
    const receiver = dot >= 0 ? name.slice(name.lastIndexOf('.', dot - 1) + 1, dot) : '';
    if (dot >= 0 && BUILTIN_METHODS.has(last) && !/^[A-Z]/.test(receiver)) continue;
    const before = code.slice(0, m.index);
    // A call on an expression's result (`f().g(`) has no receiver to name: left out.
    if (DECLARES.test(before) || /\.\s*$/.test(before)) continue;
    out.push(name);
  }
  return out;
}

/**
 * The calls one changed function gained and lost.
 * @param {object} args
 * @param {string} args.headText The file at the head.
 * @param {string} args.hunks The file's diff hunks (unified, `@@ -a,b +c,d @@` headers) that touch the function.
 * @param {number} args.startLine First line of the function at the head, 1-based.
 * @param {number} args.endLine Last line of the function at the head, inclusive.
 * @param {string} [args.self] The function's own name, left out.
 * @param {boolean} [args.hashComments] `#` starts a comment (Python).
 * @returns {{ added: string[], removed: string[], addedMore: number, removedMore: number }|null}
 *   Null when there is no hunk in the function (nothing to compare).
 */
function callDiff({ headText, hunks, startLine, endLine, self, hashComments = false }) {
  /** @type {Set<number>} */
  const addedLines = new Set();
  /** @type {string[]} */
  const removed = [];
  let seen = false;
  let head = 0;
  for (const l of String(hunks || '').split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (m) { head = Number(m[1]); continue; }
    if (!head || /^(\\ No newline|diff --git|index |--- |\+\+\+ )/.test(l)) continue;
    const inside = head >= startLine && head <= endLine;
    if (l[0] === '-') { if (inside) { removed.push(l.slice(1)); seen = true; } continue; }
    if (l[0] === '+' && inside) { addedLines.add(head); seen = true; }
    head++;
  }
  if (!seen) return null;
  const lines = headText.split('\n').slice(startLine - 1, endLine);
  const opts = { self, hashComments };
  const headCalls = lines.flatMap((l) => callsOn(l, opts));
  const baseCalls = [...lines.filter((_, i) => !addedLines.has(startLine + i)), ...removed].flatMap((l) => callsOn(l, opts));
  const inHead = new Set(headCalls), inBase = new Set(baseCalls);
  const added = [...new Set(headCalls.filter((n) => !inBase.has(n)))];
  const gone = [...new Set(baseCalls.filter((n) => !inHead.has(n)))];
  return {
    added: added.slice(0, MAX_CALLS), addedMore: Math.max(0, added.length - MAX_CALLS),
    removed: gone.slice(0, MAX_CALLS), removedMore: Math.max(0, gone.length - MAX_CALLS),
  };
}

module.exports = { callDiff, callsOn, MAX_CALLS };
