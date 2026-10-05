'use strict';
// The caller grouping of the change tree, called directly: no provider, no vscode stub.
// Inputs are deep-frozen, so a function that modified one would throw (the modules are
// strict mode) instead of passing by accident.
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupCallerRowsByFile } = require('../src/tree-grouping');

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};
const uriOf = (file, pos) => `uri:${file}${pos == null ? '' : `#${pos}`}`;

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
