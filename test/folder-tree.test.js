'use strict';
// The tree layout's folding, on file rows alone: which folders appear, how single-child
// chains compact, and that the order inside a folder is the flat list's order. Inputs are
// deep-frozen, so folding that modified a file row would throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const { foldFileRows, markFirstPathOpen, compareRanked } = require('../src/views/changes/folder-tree');

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};
// A call-graph file with `rows` changes, `attention` of them needing it, at verdict `level`.
const reviewFile = (relPath, level, { attention = 0, rows = 1 } = {}) => ({
  type: 'reviewFile', label: relPath.split('/').pop(), relPath, level, attention, rows: Array.from({ length: rows }, (_, i) => ({ type: 'finding', label: `c${i}` })),
});
// A file without a call graph: level 5, no attention.
const leaf = (relPath) => ({ type: 'file', label: relPath.split('/').pop(), relPath, level: 5 });
const fold = (files, opts) => foldFileRows(deepFreeze(files), opts);
const shape = (rows) => rows.map((r) => (r.type === 'folder' ? [r.label, shape(r.children)] : r.relPath));

test('files at the root stay rows; files in folders go under a folder row with the same objects', () => {
  const a = reviewFile('src/a.js', 0, { attention: 1 });
  const notes = leaf('notes.md');
  const { rows, folders } = fold([a, notes]);
  assert.deepEqual(shape(rows), [['src', ['src/a.js']], 'notes.md']);
  assert.equal(rows[0].children[0], a, 'the file row is the one given, not a copy');
  assert.equal(rows[1], notes);
  assert.equal(folders.length, 1);
  assert.equal(folders[0], rows[0]);
});

test('a folder with one child folder and no file of its own is drawn as one compacted row', () => {
  const { rows } = fold([reviewFile('src/engine/resolvers/ts/a.js', 2), reviewFile('src/engine/resolvers/ts/b.js', 3)]);
  assert.deepEqual(shape(rows), [['src/engine/resolvers/ts', ['src/engine/resolvers/ts/a.js', 'src/engine/resolvers/ts/b.js']]]);
  assert.equal(rows[0].relPath, 'src/engine/resolvers/ts', 'the folder keeps its full path');
});

test('compaction stops at a folder with a file of its own or two child folders', () => {
  const { rows } = fold([reviewFile('src/engine/a.js', 2), reviewFile('src/cli.js', 3), reviewFile('src/engine/deep/b.js', 4)]);
  assert.deepEqual(shape(rows), [['src', [['engine', ['src/engine/a.js', ['deep', ['src/engine/deep/b.js']]]], 'src/cli.js']]]);
});

test('a folder takes the worst level, the summed attention and the file count of everything under it', () => {
  const { rows } = fold([reviewFile('src/engine/a.js', 2, { attention: 0 }), reviewFile('src/engine/b.js', 0, { attention: 2 }), reviewFile('src/c.js', 1, { attention: 1 }), leaf('src/d.md')]);
  const src = rows[0];
  assert.equal(src.type, 'folder');
  assert.equal(src.level, 0);
  assert.equal(src.attention, 3);
  assert.equal(src.fileCount, 4);
  assert.deepEqual(src.files.map((f) => f.relPath).sort(), ['src/c.js', 'src/d.md', 'src/engine/a.js', 'src/engine/b.js']);
  const engine = src.children.find((r) => r.type === 'folder');
  assert.deepEqual([engine.level, engine.attention, engine.fileCount], [0, 2, 2]);
});

test('folders and files are ordered together, worst first, at the root and inside a folder', () => {
  // docs/ is calm, lib/ has an amber file, src/ a red one; inside src/, the red file comes
  // before the amber sub-folder, and the file without a call graph last.
  const { rows } = fold([
    leaf('docs/guide.md'), reviewFile('lib/x.js', 1, { attention: 1 }), reviewFile('src/sub/y.js', 1, { attention: 1 }),
    reviewFile('src/a.js', 0, { attention: 1 }), leaf('src/z.md'), reviewFile('src/b.js', 3),
  ]);
  assert.deepEqual(shape(rows), [
    ['src', ['src/a.js', ['sub', ['src/sub/y.js']], 'src/b.js', 'src/z.md']],
    ['lib', ['lib/x.js']],
    ['docs', ['docs/guide.md']],
  ]);
});

test('between equal levels, more attention, then more files or rows, then the path decide', () => {
  const busy = reviewFile('x/busy.js', 2, { rows: 3 });
  const quiet = reviewFile('x/quiet.js', 2, { rows: 1 });
  const { rows } = fold([quiet, busy, reviewFile('c/one.js', 2, { attention: 1 }), reviewFile('a/one.js', 2), reviewFile('a/two.js', 2)]);
  assert.deepEqual(rows.map((r) => r.label), ['c', 'a', 'x'], 'attention, then the folder with more files');
  assert.deepEqual(rows[2].children.map((r) => r.label), ['busy.js', 'quiet.js'], 'a file with more rows ranks first at the same level');
  assert.equal(compareRanked(quiet, busy) > 0, true);
});

test('a folder row carries no resource, so no git badge or colour reaches it', () => {
  const { folders } = fold([reviewFile('src/engine/a.js', 2), reviewFile('src/b.js', 2)]);
  assert.equal(folders.length, 2);
  for (const f of folders) assert.equal('decorationUri' in f, false, f.relPath);
});

test('backslash paths fold like slash paths', () => {
  const { rows } = fold([reviewFile('src\\engine\\a.js', 2)]);
  assert.deepEqual(shape(rows), [['src/engine', ['src\\engine\\a.js']]]);
});

test('no files fold to no rows', () => {
  assert.deepEqual(fold([]), { rows: [], folders: [] });
});

test('markFirstPathOpen opens the first folder chain down to its first file, and nothing else', () => {
  const a = reviewFile('src/engine/a.js', 0, { attention: 1 });
  const b = reviewFile('src/engine/b.js', 2);
  const c = reviewFile('lib/c.js', 3);
  const d = leaf('lib/d.md');
  const { rows } = foldFileRows([a, b, c, d]);
  for (const row of [...rows, ...rows.flatMap((r) => r.children)]) row.expanded = true;
  markFirstPathOpen(rows);
  assert.equal(rows[0].label, 'src/engine');
  assert.equal(rows[0].expanded, true);
  assert.equal(a.expanded, true);
  assert.equal(b.expanded, false);
  assert.equal(rows[1].expanded, false);
  assert.equal(c.expanded, false);
  assert.equal(d.expanded, false, 'a file without a call graph never opens');
});

test('markFirstPathOpen on the flat list opens the first call-graph file only', () => {
  const files = [leaf('z.md'), reviewFile('a.js', 2)];
  markFirstPathOpen(files);
  assert.deepEqual(files.map((f) => f.expanded), [false, false], 'a file without a call graph first: nothing opens');
  const open = [reviewFile('a.js', 2), reviewFile('b.js', 3)];
  markFirstPathOpen(open);
  assert.deepEqual(open.map((f) => f.expanded), [true, false]);
});
