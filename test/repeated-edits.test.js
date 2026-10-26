// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shapeSweepLabel, analyzeEdits, informative, tokenize, tokenDiff, editKeys, editsByFunction, repeatedPatterns } = require('../src/engine/repeated-edits');

test('tokenize ignores whitespace and keeps literals whole', () => {
  assert.deepEqual(tokenize('f(a, "x y")  + 1.5'), ['f', '(', 'a', ',', '"x y"', ')', '+', '1.5']);
});

test('tokenDiff returns the tokens that changed between the matching ones', () => {
  assert.deepEqual(tokenDiff(tokenize('x := interface{}(1)'), tokenize('x := any(1)')),
    [{ removed: ['interface', '{', '}'], added: ['any'] }]);
  assert.deepEqual(tokenDiff(['a'], ['a']), []);
  assert.equal(tokenDiff(new Array(600).fill('a'), new Array(600).fill('b')), null);
});

test('editKeys names each edit; an edit over 6 tokens a side has no key', () => {
  assert.deepEqual(editKeys('a(x)', 'a(x, ctx)').keys, [' → , ctx']);
  assert.deepEqual(editKeys('one two three four five six seven eight', 'z').keys, [null]);
});

test('editsByFunction gives each function the edits inside its line range', () => {
  const fns = [{ file: 'a.go', startLine: 1, endLine: 5 }, { file: 'a.go', startLine: 10, endLine: 20 }, { file: 'b.go', startLine: 1, endLine: 9 }];
  const hunks = [
    { file: 'a.go', newStart: 3, newCount: 1, removed: ['x := 1'], added: ['x := 2'] },
    { file: 'a.go', newStart: 30, newCount: 1, removed: ['q'], added: ['r'] },
  ];
  const e = editsByFunction(fns, hunks);
  assert.deepEqual(e[0].map((r) => r.keys), [['1 → 2']]);
  assert.equal(e[1], null);
  assert.equal(e[2], null);
});

test('a pattern is repeated at 5 functions over 2 or more call-graph groups', () => {
  const edits = [['p a'], ['p a'], ['p a'], ['p a'], ['p a'], ['q b'], ['q b'], ['q b'], ['q b'], ['q b']];
  assert.deepEqual([...repeatedPatterns(edits, [0, 0, 0, 0, 0, 1, 2, 3, 4, 5]).keys()], ['q b']);
  assert.deepEqual([...repeatedPatterns(edits, [0, 1, 0, 1, 0, 1, 1, 1, 1, 1]).keys()], ['p a']);
});

test('a pattern with fewer than 2 non-punctuation tokens is not informative', () => {
  assert.equal(informative(' → )'), false);
  assert.equal(informative(' → . String ( )'), false);
  assert.equal(informative('interface { } → any'), true);
});

test('a shape key catches the same change that differs in a name', () => {
  const recs = [];
  const fns = [];
  for (let i = 0; i < 6; i++) {
    fns.push({ file: `m${i}.ts`, startLine: 1, endLine: 3 });
    recs.push({ file: `m${i}.ts`, newStart: 2, newCount: 1, removed: ['return async (c, next) => {'], added: [`return async function name${i}(c, next) {`] });
  }
  const per = editsByFunction(fns, recs);
  const { repeated, effective } = analyzeEdits(per, fns.map((_, i) => i));
  const shape = [...repeated.keys()].filter((k) => k.startsWith('≈ '));
  assert.equal(shape.length, 1);
  assert.match(shape[0], /function \$/);
  assert.ok(effective.every((e) => e && e.length === 1 && e[0] === shape[0]));
});

test('a shape needs a keyword or literal besides identifiers and punctuation', () => {
  assert.equal(editKeys('a(b)', 'a(c)').shape, null);
  assert.notEqual(editKeys('a(b)', 'a(b, 1)').shape, null);
});

test('a shape sweep gets a readable label; other keys get none', () => {
  assert.equal(shapeSweepLabel('≈ ⟪0 → 12⟫', 26), 'Similar edit in 26 functions (12 tokens added each)');
  assert.equal(shapeSweepLabel('≈ ⟪7 → 0⟫', 9), 'Similar edit in 9 functions (7 tokens removed each)');
  assert.equal(shapeSweepLabel('≈ ⟪7 → 1⟫', 9), 'Similar edit in 9 functions (7 tokens replaced by 1 each)');
  assert.equal(shapeSweepLabel('≈  → function $ | = > → ', 12), 'Similar edit in 12 functions (each: added `function $`; removed `= >`)');
  assert.equal(shapeSweepLabel('≈  → $ ( | ⟪7 → 1⟫ | } → )', 8),
    'Similar edit in 8 functions (each: added `$ (`; 7 tokens replaced by 1; `}` replaced by `)`)');
  assert.equal(shapeSweepLabel('interface { } → any', 284), null);
});
