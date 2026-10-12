'use strict';
// A file row's path drawn as a folder tree: one line per folder up to three, then the
// middle folders merged onto one line, shortened with `…` when that line is too long.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathTreeLines, pathTreeMarkdown } = require('../src/path-tree');

test('a file at the repo root is just its name', () => {
  assert.deepEqual(pathTreeLines('package.json'), { lines: ['package.json'], truncated: false });
});

test('up to three folders get a line each', () => {
  assert.deepEqual(pathTreeLines('src/engine/analyze.js').lines, [
    'src/',
    '└─ engine/',
    '   └─ analyze.js',
  ]);
  assert.deepEqual(pathTreeLines('src/engine/resolvers/resolver-ts.js'), {
    lines: ['src/', '└─ engine/', '   └─ resolvers/', '      └─ resolver-ts.js'],
    truncated: false,
  });
});

test('deeper paths keep the top and parent folders and merge the rest onto one line', () => {
  assert.deepEqual(pathTreeLines('src/engine/resolvers/ts/cache/program-cache.js'), {
    lines: ['src/', '└─ engine/resolvers/ts/', '   └─ cache/', '      └─ program-cache.js'],
    truncated: false,
  });
});

test('a merged line that is too long keeps whole segments from both ends around …', () => {
  const { lines, truncated } = pathTreeLines('packages/web/src/features/billing/components/forms/inputs/card/CardNumber.tsx');
  assert.deepEqual(lines, ['packages/', '└─ web/src/…/forms/inputs/', '   └─ card/', '      └─ CardNumber.tsx']);
  assert.equal(truncated, true);
  assert.ok(lines[1].length - '└─ '.length <= 32);
});

test('the first and last merged segments stay even when they alone are too long', () => {
  const long = 'a'.repeat(20);
  const { lines } = pathTreeLines(`top/${long}/mid/${long}/parent/f.js`);
  assert.equal(lines[1], `└─ ${long}/…/${long}/`);
});

test('backslash separators read like slashes', () => {
  assert.deepEqual(pathTreeLines('src\\engine\\analyze.js').lines, ['src/', '└─ engine/', '   └─ analyze.js']);
});

test('the Markdown is a code block, with the full path below only when the tree shortened it', () => {
  assert.deepEqual(pathTreeMarkdown('src/a.ts'), ['```', 'src/', '└─ a.ts', '```']);
  const deep = 'packages/web/src/features/billing/components/forms/inputs/card/CardNumber.tsx';
  assert.deepEqual(pathTreeMarkdown(deep).slice(-2), ['', `\`${deep}\``]);
});

test('backticks in a name cannot close the code block', () => {
  const md = pathTreeMarkdown('docs/```odd.md');
  assert.equal(md[0], '````');
  assert.equal(md[md.length - 1], '````');
});
