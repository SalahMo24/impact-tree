'use strict';
// Go's call-or-value classifier (src/languages/go/call-sites.js, G4): is the identifier
// gopls lists as an incoming call followed by `(`?

const test = require('node:test');
const assert = require('node:assert/strict');
const { isGoCallSite, MAX_LOOKAHEAD } = require('../src/languages/go/call-sites');

/**
 * The site of the first `name` in `text` that is a whole identifier, or of the n-th one.
 * @param {string} text @param {string} name @param {number} [nth] zero-based
 */
function siteOf(text, name, nth = 0) {
  const re = new RegExp(`(?<![\\p{L}\\p{Nd}_])${name.replace('.', '\\.')}(?![\\p{L}\\p{Nd}_])`, 'gu');
  let m;
  for (let i = 0; (m = re.exec(text)); i++) if (i === nth) return { start: m.index, end: m.index + name.length };
  throw new Error(`no ${name} #${nth} in ${text}`);
}
const classify = (/** @type {string} */ text, /** @type {string} */ name, nth = 0) => isGoCallSite(text, siteOf(text, name, nth));

test('a plain call is a call', () => {
  assert.equal(classify('func a() { run(x) }', 'run'), true);
  assert.equal(classify('func a() { defer run() }', 'run'), true);
  assert.equal(classify('func a() { go run() }', 'run'), true);
  assert.equal(classify('func a() { return pkg.Run(1, 2) }', 'Run'), true);
});

test('space and comments before `(` on the same line still make a call', () => {
  assert.equal(classify('func a() { run (x) }', 'run'), true);
  assert.equal(classify('func a() { run\t(x) }', 'run'), true);
  assert.equal(classify('func a() { run /* why */ (x) }', 'run'), true);
  assert.equal(classify('func a() { run/**/(x) }', 'run'), true);
});

test('a newline ends the expression (Go inserts a semicolon), so a `(` after it is not a call', () => {
  assert.equal(classify('func a() {\n\th := run\n\t(x)\n}', 'run'), false);
  assert.equal(classify('func a() { h := run // later\n(x) }', 'run'), false);
  assert.equal(classify('func a() { h := run /* a\nb */ (x) }', 'run'), false);
});

test('a generic instantiation before `(` is a call; on its own it is a value', () => {
  assert.equal(classify('func a() { Map[int](xs) }', 'Map'), true);
  assert.equal(classify('func a() { Map[T, U](xs) }', 'Map'), true);
  assert.equal(classify('func a() { Map[map[string]int, []byte] (xs) }', 'Map'), true);
  assert.equal(classify('func a() { f := Map[int]; f(xs) }', 'Map'), false);
  assert.equal(classify('func a() { use(Map[T, U]) }', 'Map'), false);
});

test('value uses are not calls', () => {
  // in a struct literal (cobra's `Args: noArgsConstraint`)
  assert.equal(classify('cmd := &cobra.Command{\n\tArgs: noArgsConstraint,\n}', 'noArgsConstraint'), false);
  assert.equal(classify('cmd := &cobra.Command{Args: noArgsConstraint}', 'noArgsConstraint'), false);
  // as an argument
  assert.equal(classify('func a() { register(run, other) }', 'run'), false);
  assert.equal(classify('func a() { register(run) }', 'run'), false);
  // in an assignment
  assert.equal(classify('func a() { opts.RunF = run; }', 'run'), false);
  assert.equal(classify('func a() { h := run\n}', 'run'), false);
  // in a return
  assert.equal(classify('func a() func() { return run }', 'run'), false);
});

test('a method value is a value; the same selector called is a call', () => {
  assert.equal(classify('func a() { h := x.Close; h() }', 'Close'), false);
  assert.equal(classify('func a() { defer x.Close() }', 'Close'), true);
  assert.equal(classify('func a() { register(x.Close) }', 'Close'), false);
});

test('one caller can hold both: each site is classified on its own', () => {
  const text = 'func a() { run(1); register(run) }';
  assert.equal(classify(text, 'run', 0), true);
  assert.equal(classify(text, 'run', 1), false);
});

test('a range at the end of the text is a value use; at the lookahead limit it is unknown', () => {
  const text = 'var h = run';
  assert.equal(isGoCallSite(text, { start: text.length - 3, end: text.length }), false);
  assert.equal(isGoCallSite(`${text}  // trailing`, { start: text.length - 3, end: text.length }), false);
  const far = `${text}${' '.repeat(MAX_LOOKAHEAD + 1)}(x)`;
  assert.equal(isGoCallSite(far, { start: text.length - 3, end: text.length }), null);
  const brackets = `use(run[${'int, '.repeat(MAX_LOOKAHEAD)}])`;
  assert.equal(isGoCallSite(brackets, siteOf(brackets, 'run')), null, 'an instantiation that does not close within the lookahead');
  const comment = 'h := run /* never closed';
  assert.equal(isGoCallSite(comment, siteOf(comment, 'run')), null, 'an unterminated comment');
});

test('unreadable text or an unusable range is unknown, neither a call nor a value', () => {
  assert.equal(isGoCallSite(null, { start: 0, end: 3 }), null);
  const text = 'func a() { run() }';
  assert.equal(isGoCallSite(text, { start: 11, end: 999 }), null, 'past the end');
  assert.equal(isGoCallSite(text, { start: 14, end: 11 }), null, 'reversed');
  assert.equal(isGoCallSite(text, { start: null, end: 14 }), null, 'unconverted start');
  assert.equal(isGoCallSite(text, { start: 11, end: null }), null, 'unconverted end');
  assert.equal(isGoCallSite(text, { start: 11.5, end: 14 }), null, 'not an offset');
  // A range that does not end at an identifier (the whole call expression) is not read as a value use.
  assert.equal(isGoCallSite(text, { start: 11, end: 16 }), null);
});

test('identifiers with non-ASCII letters end where Go says they do', () => {
  const text = 'func a() { größe(x); h := größe }';
  assert.equal(classify(text, 'größe', 0), true);
  assert.equal(classify(text, 'größe', 1), false);
});
