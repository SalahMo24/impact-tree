'use strict';
// Python strings and comments read one way (src/languages/python/lexer.js) for the header
// parser, the definition recovery and the caller checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanString, nonCodeRanges, prefixBefore } = require('../src/languages/python/lexer');

const endOf = (text) => scanString(text, text.search(/["']/));

test('plain, triple and escaped strings end at their closing quote', () => {
  assert.deepEqual(endOf('x = "a" + b'), { end: 7, terminated: true, fString: false });
  assert.equal(endOf("'''a ' '' b''' tail").end, 14);
  assert.equal(endOf('"a\\"b" tail').end, 6);
});

test('a backslash escapes the quote in raw strings too, f-strings included', () => {
  assert.equal(endOf('r"\\"" tail').end, 5);
  assert.equal(endOf('rf"\\"" tail').end, 6, 'the caller checks used to end rf-strings at the escaped quote');
});

test('an f-string field may hold a string with the same quote (3.12); {{ is a brace', () => {
  const t = 'f"{d["k"]}" tail';
  assert.deepEqual(scanString(t, 1), { end: 11, terminated: true, fString: true });
  assert.equal(endOf('f"{{"} tail').end, 5, '`{{` opens no field');
});

test('unterminated: a single-quoted string ends at its line, a triple one at the limit', () => {
  assert.deepEqual(endOf('"abc\nnext'), { end: 4, terminated: false, fString: false });
  assert.deepEqual(endOf('"""abc\nnext'), { end: 11, terminated: false, fString: false });
  assert.deepEqual(scanString('"""abc\nnext', 0, 5), { end: 5, terminated: false, fString: false });
});

test('prefix letters belong to the string only when not part of a name', () => {
  assert.equal(prefixBefore('x = rb"a"', 6), 'rb');
  assert.equal(prefixBefore('elif"a"', 4), '', 'the f of elif is a name');
  assert.equal(scanString('elif"{"', 4).fString, false);
});

test('nonCodeRanges: comments and strings; f-strings optionally left as code', () => {
  const t = 'a = "s"  # c\nb = f"{x.get(1)}"\n';
  assert.deepEqual(nonCodeRanges(t), [[4, 7], [9, 12], [18, 30]]);
  assert.deepEqual(nonCodeRanges(t, { fStringsAsCode: true }), [[4, 7], [9, 12]]);
});
