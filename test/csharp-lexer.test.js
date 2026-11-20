// @ts-check
'use strict';
// The C# lexer (Part C, C2): literals of every kind as single tokens, comments skipped,
// preprocessor lines as directives, `blank` keeping offsets, attribute lists told apart from
// collection expressions and list patterns.
const test = require('node:test');
const assert = require('node:assert/strict');
const { lex, tokenize, blank, opensAttribute } = require('../src/languages/csharp/lexer');

/** @param {string} text */
const texts = (text) => {
  const toks = tokenize(text);
  assert.ok(toks, `expected to lex: ${text}`);
  return toks.map((t) => t.text);
};
/** @param {string} text @returns {string[]} the literal tokens */
const lits = (text) => /** @type {any[]} */ (tokenize(text)).filter((t) => t.kind === 'lit').map((t) => t.text);

test('regular, verbatim and u8 strings and chars are single literals; their quotes and braces do not leak', () => {
  assert.deepEqual(lits('a("x\\"{", @"c:\\dir""}", \'}\', \'\\\'\', "a"u8, "");'), ['"x\\"{"', '@"c:\\dir""}"', "'}'", "'\\''", '"a"u8', '""']);
  assert.deepEqual(texts('x = @"line1\nline2 {"; y'), ['x', '=', '@"line1\nline2 {"', ';', 'y']);
});

test('interpolated strings: nested holes, strings inside holes, format specifiers, escaped braces', () => {
  const src = 'var s = $"a {x + F("q}", $"{y:N2}")} {{lit}} {z,5:x}"; next';
  const toks = /** @type {any[]} */ (tokenize(src));
  assert.deepEqual(toks.map((t) => t.text), ['var', 's', '=', '$"a {x + F("q}", $"{y:N2}")} {{lit}} {z,5:x}"', ';', 'next']);
  const lit = toks[3];
  assert.deepEqual(lit.holes.map((/** @type {[number, number]} */ [a, b]) => src.slice(a, b)), ['x + F("q}", $"{y:N2}")', 'z,5']);
  assert.deepEqual(lits('$@"{a}\n""x""" + @$"{b}"'), ['$@"{a}\n""x"""', '@$"{b}"']);
  assert.deepEqual(lits('$"{(a ? b : c)}" + $"{global::X.Y}"'), ['$"{(a ? b : c)}"', '$"{global::X.Y}"']);
});

test('raw strings: any run of three or more quotes, and $$ raw holes', () => {
  assert.deepEqual(lits('a = """\n  say "hi" and ""two""\n  """; b = """"x""" y"""";'), ['"""\n  say "hi" and ""two""\n  """', '""""x""" y""""']);
  const src = 'j = $$"""{ "k": {{v}} }"""; k';
  const toks = /** @type {any[]} */ (tokenize(src));
  assert.equal(toks[2].text, '$$"""{ "k": {{v}} }"""');
  assert.deepEqual(toks[2].holes.map((/** @type {[number, number]} */ [a, b]) => src.slice(a, b)), ['v']);
  assert.deepEqual(texts(src).slice(-2), [';', 'k']);
});

test('comments are skipped; preprocessor lines are directive tokens; # elsewhere is punctuation', () => {
  const toks = /** @type {any[]} */ (tokenize('a // x "\n/* } */ b\n  #if DEBUG\nc\n#endregion // r\n'));
  assert.deepEqual(toks.map((t) => `${t.kind}:${t.text}`), ['ident:a', 'ident:b', 'directive:#if DEBUG', 'ident:c', 'directive:#endregion // r']);
  assert.equal(lex('a /* open', 0, () => {}), -1);
  assert.equal(lex('a "open\n"', 0, () => {}), -1);
});

test('punctuation: => :: ?. ?? are single tokens, >> is two (nested generics)', () => {
  assert.deepEqual(texts('List<List<int>> x => a?.b ?? global::c;'), ['List', '<', 'List', '<', 'int', '>', '>', 'x', '=>', 'a', '?.', 'b', '??', 'global', '::', 'c', ';']);
  assert.deepEqual(texts('@class 1.5e-3f 0x1F 1_000UL'), ['@class', '1.5e-3f', '0x1F', '1_000UL']);
});

test('blank keeps offsets and newlines, blanks comments, directives and literal contents, keeps hole code', () => {
  const src = 'var s = $"a {F("q")} b {y:N2}"; // hi\n#if DEBUG\nchar c = \'}\'; var r = @"x\n""y";\n/* a\n b */ z';
  const out = blank(src);
  assert.equal(out.length, src.length);
  assert.deepEqual([...out].map((c, i) => (c === '\n') === (src[i] === '\n')).every(Boolean), true);
  assert.equal(out, 'var s = $"   F(" ")     y    ";      \n         \nchar c = \' \'; var r = @" \n   ";\n    \n      z');
  // An unterminated literal blanks the rest.
  assert.equal(blank('a "open\nb'), 'a      \n ');
});

test('attribute lists versus collection expressions, list patterns and element access', () => {
  /** @param {string} src @param {boolean} [inParams] whether the first `[` opens an attribute */
  const first = (src, inParams) => {
    const toks = /** @type {any[]} */ (tokenize(src));
    return opensAttribute(toks, toks.findIndex((t) => t.text === '['), inParams);
  };
  assert.equal(first('[HttpGet] public void M() {}'), true);
  assert.equal(first('} [Obsolete] void M() {}'), true);
  assert.equal(first('int x; [A][B] void M() {}'), true);
  assert.equal(first('int[] xs = [1, 2];'), false);
  assert.equal(first('return [a, b];'), false);
  assert.equal(first('if (x is [1, ..]) {}'), false);
  assert.equal(first('F([a, b]);'), false);
  assert.equal(first('a[0][1] = 2;'), false);
  assert.equal(first('void M([FromBody] int x)', true), true);
  // A second list after an attribute list is one too; after an element access it is not.
  const toks = /** @type {any[]} */ (tokenize('[A][B] void M() {} x = a[0][1];'));
  const opens = toks.map((t, k) => (t.text === '[' ? opensAttribute(toks, k) : null)).filter((x) => x !== null);
  assert.deepEqual(opens, [true, true, false, false]);
});

test('a `[` after `{` is an attribute only when the brace opens a block, type body or accessors', () => {
  /** @param {string} src @param {string} marker the first `[` at or after this text */
  const after = (src, marker) => {
    const toks = /** @type {any[]} */ (tokenize(src));
    const at = src.indexOf(marker);
    return opensAttribute(toks, toks.findIndex((t) => t.text === '[' && t.start >= at));
  };
  // Expressions: indexer and object initializers, list patterns, collection expressions.
  assert.equal(after('var d = new Dictionary<string, int> { ["a"] = 1, ["b"] = 2 };', '{'), false);
  assert.equal(after('var d = new D { [1] = 2 };', '{'), false);
  assert.equal(after('var d = new D() { [1] = 2 };', '{'), false);
  assert.equal(after('D d = new() { [1] = 2 };', '{'), false);
  assert.equal(after('var a = new int[] { [0] = 1 };', '{'), false);
  assert.equal(after('var a = new N.D<int>? { [0] = 1 };', '{'), false);
  assert.equal(after('var r = x switch { [1, ..] => 1, [] => 2 };', '{'), false);
  assert.equal(after('List<int[]> x = new() { [1, 2], [3] };', '{'), false);
  assert.equal(after('var y = x with { [0] = 1 };', '{'), false);
  assert.equal(after('if (o is { } && o is { P: [1] }) {}', '{'), false);
  assert.equal(after('M(a, new() { [1] = 2 });', '{'), false);
  // Nested initializer braces follow the outer one.
  assert.equal(after('var d = new D { { [1] } };', '{ ['), false);
  // Real attribute positions: start of a member or local function, after another list,
  // at the start of a file and an assembly attribute.
  assert.equal(after('class C { [Obsolete] void M() {} }', '{'), true);
  assert.equal(after('class C<T> : B { [A] int P => 1; }', '{'), true);
  assert.equal(after('namespace N.M { [A] class C {} }', '{'), true);
  assert.equal(after('void M() { [A] void Local() {} }', '{'), true);
  assert.equal(after('public new void M() { [A] void Local() {} }', '{'), true);
  assert.equal(after('void M<T>() where T : class, new() { [A] void L() {} }', '{'), true);
  assert.equal(after('int P { [A] get; set; }', '{'), true);
  assert.equal(after('class C { [A][B] void M() {} }', '[B]'), true);
  assert.equal(after('[assembly: InternalsVisibleTo("X")]', '['), true);
  assert.equal(after('using X; [assembly: A] namespace N;', '['), true);
  // A parameter's attribute.
  const toks = /** @type {any[]} */ (tokenize('void M(int a, [FromBody] B b) {}'));
  assert.equal(opensAttribute(toks, toks.findIndex((t) => t.text === '['), true), true);
});
