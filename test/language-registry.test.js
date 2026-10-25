'use strict';
// The language registry (src/languages): which language analyses a file, and the source
// and test rules `src/engine/diff.js` now takes from it. For every path but Go's, each
// answer must equal the rules diff.js had before the registry existed; Go (G1/G2) is
// registered after TypeScript and owns `.go` files.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LANGUAGES, languageFor, isSourcePath, isTestPath, unsupportedLanguageOf } = require('../src/languages');
const diff = require('../src/engine/diff');

// The rules as they were in src/engine/diff.js, kept here as the oracle.
const OLD_SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const OLD_DECLARATION_EXT = /\.d\.(ts|mts|cts)$/;
const oldIsSourcePath = (f) => OLD_SOURCE_EXT.test(f) && !OLD_DECLARATION_EXT.test(f);
const oldIsTestPath = (f) => /(^|\/)(tests?|__tests__|__mocks__)\//.test(String(f).replace(/\\/g, '/'))
  || /\.(spec|test|e2e-spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(f);

const PATHS = [
  'a/b.ts', 'a/b.tsx', 'a/b.js', 'a/b.jsx', 'a/b.mjs', 'a/b.cjs', 'a/b.mts', 'a/b.cts',
  'a/b.d.ts', 'a/b.d.mts', 'a/b.d.cts', 'a/b.test.d.ts', 'a/b.md', 'a/up.sql', 'a/b.go', 'a/b_test.go',
  'a/test_b.py', 'a/BTest.java', 'b.ts', '.ts', 'a/b.ts.orig', 'a/b.TS',
  'a/b.spec.tsx', 'a/b.test.ts', 'a/b.e2e-spec.ts', 'a/b.spec.md',
  'a/__tests__/c.tsx', 'a/__mocks__/d.ts', 'components/x/tests/e.ts', 'test/f.md', 'tests/g.go',
  'a/testing/h.ts', 'a/contest/i.ts', 'a\\tests\\j.ts', 'a\\b.spec.ts', 'café/ünïcode.ts',
];

// Go's paths: source since the Go provider was registered (G2), tests by Go's `_test.go`.
const GO_PATHS = { 'a/b.go': { source: true, test: false }, 'a/b_test.go': { source: true, test: true }, 'tests/g.go': { source: true, test: true },
  // Python's: source since the Python provider was registered (P2), tests by pytest's names.
  'a/test_b.py': { source: true, test: true } };

test('every source and test answer equals the rules diff.js had before the registry, except Go\'s and Python\'s', () => {
  for (const p of PATHS) {
    if (GO_PATHS[p]) {
      assert.equal(isSourcePath(p), GO_PATHS[p].source, `isSourcePath(${p})`);
      assert.equal(isTestPath(p), GO_PATHS[p].test, `isTestPath(${p})`);
      assert.equal(diff.isSourcePath(p), GO_PATHS[p].source, `diff.isSourcePath(${p})`);
      assert.equal(diff.isTestPath(p), GO_PATHS[p].test, `diff.isTestPath(${p})`);
      continue;
    }
    assert.equal(isSourcePath(p), oldIsSourcePath(p), `isSourcePath(${p})`);
    assert.equal(isTestPath(p), oldIsTestPath(p), `isTestPath(${p})`);
    assert.equal(diff.isSourcePath(p), oldIsSourcePath(p), `diff.isSourcePath(${p})`);
    assert.equal(diff.isTestPath(p), oldIsTestPath(p), `diff.isTestPath(${p})`);
  }
});

test('TypeScript is registered first and owns its source paths; Go and Python come after it', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['typescript', 'go', 'python']);
  assert.equal(languageFor('a/b.go').id, 'go');
  assert.equal(languageFor('a/b.py').id, 'python');
  assert.equal(languageFor('stubs/b.pyi').id, 'python');
  assert.equal(languageFor('a/b.py').needsServer, true, 'Python needs the editor\'s language server');
  assert.ok(Object.isFrozen(LANGUAGES), 'the registry cannot be changed by a consumer');
  assert.equal(languageFor('a/b.tsx').id, 'typescript');
  assert.equal(languageFor('a/b.tsx').displayName, 'TypeScript/JavaScript');
});

test('a file no language handles has no language, and is not source', () => {
  for (const p of ['a/B.java', 'README.md', 'a/b.d.ts', 'a/testdata/b.go', '.venv/lib/x.py', '']) {
    assert.equal(languageFor(p), null, p);
    assert.equal(isSourcePath(p), false, p);
  }
});

test('a test directory makes any file a test; a test name only counts for the language that handles the file', () => {
  assert.equal(isTestPath('tests/fixture.json'), true, 'by directory, whatever the language');
  assert.equal(isTestPath('a/b.spec.md'), false, 'a test-like name of a file no language handles');
  assert.equal(isTestPath('a/b_test.go'), true, 'a Go test, by Go\'s rules');
  assert.equal(isTestPath('a/b_test.py'), true, 'a Python test, by Python\'s rules');
  assert.equal(isTestPath('a/BTest.java'), false, 'a test-like name of a language with no provider');
});

test('TypeScript marks nothing as generated yet', () => {
  assert.equal(languageFor('a/b.ts').isGenerated('a/b.ts', '// @generated\n'), false);
});

test('diff.js still exports SOURCE_EXT for its existing users', () => {
  assert.ok(diff.SOURCE_EXT instanceof RegExp);
  assert.equal(diff.SOURCE_EXT.test('a/b.ts'), true);
});

test('a common language no provider analyses is named; a handled or unknown file is not', () => {
  for (const [p, name] of [['A.java', 'Java'], ['b.kt', 'Kotlin'],
    ['c.cs', 'C#'], ['d.rb', 'Ruby'], ['e.rs', 'Rust'], ['f.php', 'PHP'], ['g.swift', 'Swift'], ['h.c', 'C'], ['i.hpp', 'C++'], ['j.scala', 'Scala']]) {
    assert.equal(unsupportedLanguageOf(p), name, p);
  }
  // Python is analysed since P2: never "not analysed yet".
  for (const p of ['a.go', 'a.ts', 'a.d.ts', 'svc/app.py', 'stubs/x.pyi', 'README.md', 'Makefile', 'go.mod']) assert.equal(unsupportedLanguageOf(p), null, p);
});
