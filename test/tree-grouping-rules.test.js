'use strict';
// The grouping rules of the change tree, called directly: no provider, no vscode stub.
// Inputs are deep-frozen, so a function that modified one would throw (the modules are
// strict mode) instead of passing by accident.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sortByWorstStatus, groupChangesByLocation, groupCallerRowsByFile, buildFileTreeRows, buildDirectoryChildRows,
} = require('../src/tree-grouping');

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};
const uriOf = (file, pos) => `uri:${file}${pos == null ? '' : `#${pos}`}`;

let at = 0;
// A change row as buildChangeRows makes it.
const row = (relPath, label, start, end, extra = {}) => {
  const finding = { file: `/r/${relPath}`, relPath, label, namePos: at++, start, end, staleCallers: 0, callerState: 'resolved', ...extra };
  return { type: 'finding', label, finding, file: finding.file, pos: finding.namePos, decorationUri: uriOf(finding.file, finding.namePos) };
};
const shape = (rows) => rows.map((n) => (n.type === 'changeFile'
  ? `file:${n.label}[${n.rows.map((r) => r.label).join(',')}]`
  : `${n.label}${n.inside ? `{${shape(n.inside).join(',')}}` : ''}`));

test('a change declared inside another nests under the nearest one, without its prefix, at any depth', () => {
  const outer = row('a.ts', 'Outer', 0, 1000);
  const mid = row('a.ts', 'Outer.mid', 100, 500);
  const deep = row('a.ts', 'Outer.mid.deep', 150, 200);
  const unprefixed = row('a.ts', 'callback', 300, 320);
  const input = deepFreeze([deep, outer, unprefixed, mid]);
  const { rows } = groupChangesByLocation(input, { layout: 'flat', result: {}, uriOf });
  assert.deepEqual(shape(rows), ['Outer{mid{deep,callback}}']);
  const midCopy = rows[0].inside[0];
  assert.equal(midCopy.container, 'Outer');
  assert.equal(midCopy.inside[0].container, 'Outer.mid', 'the container is named by its full label');
  assert.equal(midCopy.inside[1].label, 'callback', 'a label without the prefix is kept');
  assert.equal(input[0].label, 'Outer.mid.deep', 'the input rows keep their labels');
  assert.equal(input[1].inside, undefined);
});

test('equal ranges, missing ranges and other files never nest', () => {
  const a = row('a.ts', 'a', 0, 100);
  const twin = row('a.ts', 'twin', 0, 100);
  const noRange = row('a.ts', 'noRange', null, null);
  const elsewhere = row('b.ts', 'elsewhere', 10, 20);
  const { rows } = groupChangesByLocation(deepFreeze([a, twin, noRange, elsewhere]), { layout: 'flat', result: {}, uriOf });
  assert.deepEqual(shape(rows), ['a', 'twin', 'noRange', 'elsewhere']);
});

test('rows go worst first, otherwise in input order, ranked by what they hold', () => {
  const ok = row('a.ts', 'ok', 0, 10);
  const muted = row('b.ts', 'muted', 0, 10, { callerState: 'none' });
  const holder = row('c.ts', 'holder', 0, 100);
  const staleInside = row('c.ts', 'holder.stale', 10, 20, { staleCallers: 1 });
  const unknown = row('d.ts', 'unknown', 0, 10, { callerState: 'unknown' });
  const { rows } = groupChangesByLocation(deepFreeze([muted, ok, unknown, holder, staleInside]), { layout: 'flat', result: {}, uriOf });
  assert.deepEqual(shape(rows), ['holder{stale}', 'unknown', 'ok', 'muted']);
});

test('the tree layout makes a file row for a file with several top-level changes, and asks for its decoration', () => {
  const one = row('src/x.ts', 'one', 0, 10);
  const two = row('src/x.ts', 'two', 20, 30, { callerState: 'unknown' });
  const wrapper = row('src/y.ts', 'wrap', 0, 100);
  const inner = row('src/y.ts', 'wrap.inner', 10, 20);
  const lone = row('src/z.ts', 'lone', 0, 10);
  const result = { fileStatus: { 'src/x.ts': 'modified', 'src/y.ts': 'added' } };
  const { rows, decorations } = groupChangesByLocation(deepFreeze([one, two, wrapper, inner, lone]), { layout: 'tree', result, uriOf });
  assert.deepEqual(shape(rows), ['file:x.ts[two,one]', 'wrap{inner}', 'lone'], 'a file whose changes sit in one function is that function');
  const file = rows[0];
  assert.equal(file.relPath, 'src/x.ts');
  assert.equal(file.decorationUri, 'uri:/r/src/x.ts');
  assert.deepEqual(file.members.map((m) => m.label), ['one', 'two']);
  assert.deepEqual(decorations, [{ uri: 'uri:/r/src/x.ts', status: 'modified', tooltip: 'src/x.ts' }]);
  assert.deepEqual(groupChangesByLocation([one, two], { layout: 'flat', result, uriOf }).decorations, [], 'flat has no file rows to decorate');
});

test('a file row counts the changes nested in its rows as members', () => {
  const a = row('m.ts', 'A', 0, 100);
  const aInner = row('m.ts', 'A.x', 10, 20);
  const b = row('m.ts', 'B', 200, 300);
  const { rows } = groupChangesByLocation(deepFreeze([a, aInner, b]), { layout: 'tree', result: {}, uriOf });
  assert.deepEqual(rows[0].members.map((m) => m.label), ['A', 'x', 'B']);
});

test('sortByWorstStatus returns a new array and leaves the input order alone', () => {
  const rows = deepFreeze([row('a.ts', 'fine', 0, 1), row('a.ts', 'bad', 2, 3, { staleCallers: 2 }), row('a.ts', 'fine2', 4, 5)]);
  const sorted = sortByWorstStatus(rows);
  assert.deepEqual(sorted.map((r) => r.label), ['bad', 'fine', 'fine2']);
  assert.deepEqual(rows.map((r) => r.label), ['fine', 'bad', 'fine2']);
  assert.deepEqual(sortByWorstStatus([]), []);
});

// ---- callers --------------------------------------------------------------------------
const callerRow = (relPath, label, callState, extra = {}) => ({
  type: 'caller', label, relPath, file: `/r/${relPath}`, pos: label.length, callState, sites: 1, test: false, changed: false, ...extra,
});

test('callers in one file become one row with the worst state; a lone caller stays flat', () => {
  const input = deepFreeze([
    callerRow('a.ts', 'a1', 'updated-at-call'), callerRow('a.ts', 'a2', 'unchanged', { sites: 3 }),
    callerRow('a.ts', 'a3', 'updated-at-call', { changed: true }), callerRow('b.ts', 'b1', 'changed-elsewhere'),
  ]);
  const ancestry = deepFreeze(['/r/t.ts#1']);
  const grouped = groupCallerRowsByFile(input, { reviewParent: 'parent', ancestry, uriOf });
  assert.deepEqual(grouped.map((g) => `${g.type}:${g.label}`), ['callerFile:a.ts', 'caller:b1']);
  const [file] = grouped;
  assert.equal(file.callState, 'unchanged');
  assert.equal(file.sites, 5);
  assert.equal(file.changed, true);
  assert.equal(file.test, false);
  assert.equal(file.reviewParent, 'parent');
  assert.equal(file.decorationUri, 'uri:/r/a.ts');
  assert.deepEqual(file.path, ['/r/t.ts#1']);
  assert.notEqual(file.path, ancestry, 'each group owns its path');
  assert.equal(file.callers[0], input[0], 'members are the caller rows themselves');
});

test('a caller-file row is a test only when every caller in it is, and groups by path when there is one', () => {
  const tests = [callerRow('t.ts', 't1', 'unchanged', { test: true }), callerRow('t.ts', 't2', 'unchanged', { test: true })];
  assert.equal(groupCallerRowsByFile(tests, { reviewParent: null, ancestry: [], uriOf })[0].test, true);
  const mixed = [callerRow('t.ts', 't1', 'unchanged', { test: true }), callerRow('t.ts', 'x', 'unchanged')];
  assert.equal(groupCallerRowsByFile(mixed, { reviewParent: null, ancestry: [], uriOf })[0].test, false);
  // without a relative path the absolute file is the key
  const noRel = [callerRow('n.ts', 'p', 'unchanged', { relPath: undefined }), callerRow('n.ts', 'q', 'unchanged', { relPath: undefined })];
  const [g] = groupCallerRowsByFile(noRel, { reviewParent: null, ancestry: [], uriOf });
  assert.equal(g.relPath, '/r/n.ts');
  assert.equal(g.label, 'n.ts');
});

// ---- folders --------------------------------------------------------------------------
const leaf = (relPath) => ({ type: 'file', label: relPath.split('/').pop(), relPath, status: 'modified' });
const dirShape = (rows) => rows.map((n) => (n.type === 'dir' ? `dir:${n.label}@${n.dirPath}` : n.label));

test('folders compact single-child chains at every depth and list folders before files', () => {
  const leaves = deepFreeze(['z.md', 'src/x.ts', 'src/a/b/c/y.ts', 'src/a/b/c/w.ts', 'lib/one/two/three.ts'].map(leaf));
  const top = buildFileTreeRows(leaves);
  assert.deepEqual(dirShape(top), ['dir:lib/one/two@lib/one/two', 'dir:src@src', 'z.md']);
  const src = buildDirectoryChildRows(top[1]);
  assert.deepEqual(dirShape(src), ['dir:a/b/c@src/a/b/c', 'x.ts']);
  assert.deepEqual(dirShape(buildDirectoryChildRows(src[0])), ['w.ts', 'y.ts'], 'files sorted by name');
  assert.deepEqual(dirShape(buildDirectoryChildRows(top[0])), ['three.ts']);
  assert.notEqual(src[1], leaves[1], 'file rows are copies');
  assert.equal(src[1].relPath, 'src/x.ts');
});

test('a branch or a file stops the compaction, and expanding twice gives the same rows', () => {
  const leaves = deepFreeze(['m/n/o/one.ts', 'm/n/o/p/two.ts', 'm/n/o/q/r/three.ts', 'm/n/file.ts'].map(leaf));
  const [mn] = buildFileTreeRows(leaves);
  assert.equal(mn.label, 'm/n');
  const n = buildDirectoryChildRows(mn);
  assert.deepEqual(dirShape(n), ['dir:o@m/n/o', 'file.ts']);
  const o = buildDirectoryChildRows(n[0]);
  assert.deepEqual(dirShape(o), ['dir:p@m/n/o/p', 'dir:q/r@m/n/o/q/r', 'one.ts']);
  assert.deepEqual(dirShape(buildDirectoryChildRows(n[0])), dirShape(o));
  assert.deepEqual(buildFileTreeRows([]), []);
});
