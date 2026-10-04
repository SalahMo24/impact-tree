'use strict';
// The tree must not call a symbol untested when the test search failed or stopped early:
// only a symbol whose walk finished without a test reads "no test", and the others say the
// reach is unknown, with the reason, on the change row's tooltip and its tests row.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');

const BODY = [{ id: 'body', label: 'body' }];
let at = 0;
const change = (label, testState, reason = null, extra = {}) => ({
  file: '/repo/src/a.ts', relPath: 'src/a.ts', label, namePos: ++at * 10, start: at * 100, end: at * 100 + 50, startLine: at, endLine: at,
  component: '(root)', kinds: BODY, throwsAdded: [], callers: [], stale: [], staleCallers: 0, callerState: 'none', score: 1,
  testState, testReachIncompleteReason: reason, tests: testState === 'covered' ? ['t'] : [], ...extra,
});
// the lists the engine derives from testState, built the same way here
const resultOf = (changed, extra = {}) => ({
  allChanged: changed, findings: [], deleted: [], outside: [], warnings: [], unanalysable: [], otherFiles: [],
  untested: changed.filter((c) => c.testState === 'uncovered'),
  testUnknown: changed.filter((c) => c.testState === 'unknown'),
  mode: 'working', base: { ref: 'HEAD', sha: '0' }, testReachComputed: changed.some((c) => c.testState !== 'not-computed'),
  fileStatus: { 'src/a.ts': 'modified' }, ...extra,
});

// Each change row of the one file, by label, with its item and its tests row.
async function rowsOf(result, rowDetail = 'inline') {
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail, rel: (f) => f.replace('/repo/', '') }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review: null,
  });
  const file = (await provider.getChildren()).find((r) => r.type === 'reviewFile');
  const out = {};
  for (const row of await provider.getChildren(file)) {
    const tests = (await provider.getChildren(row)).at(-1);
    out[row.label] = { item: provider.getTreeItem(row), tests, testsItem: provider.getTreeItem(tests) };
  }
  return out;
}

test('only a finished walk reads "no test"; an unknown one says why, on the tooltip and the tests row', async () => {
  const rows = await rowsOf(resultOf([
    change('covered', 'covered'),
    change('provenUntested', 'uncovered'),
    change('failedSearch', 'unknown', 'a caller query failed: language server crashed'),
    change('cutByBudget', 'unknown', 'the walk budget of 120 callers ran out'),
  ]));
  assert.deepEqual(Object.entries(rows).filter(([, r]) => /no test/.test(r.item.description)).map(([l]) => l), ['provenUntested']);
  assert.equal(rows.covered.tests.label, 'Tested by t');
  assert.equal(rows.provenUntested.tests.label, 'No test within the searched caller levels');
  for (const label of ['failedSearch', 'cutByBudget']) {
    const reason = rows[label].item.tooltip.value.match(/_test reachability unknown: (.*)_/)?.[1];
    assert.ok(reason && reason.length > 0, `${label}: the tooltip gives the reason`);
    assert.equal(rows[label].tests.label, 'Test reach unknown');
    assert.equal(rows[label].testsItem.description, reason, `${label}: so does the tests row`);
    assert.doesNotMatch(rows[label].item.tooltip.value, /no test within/);
  }
});

test('hover mode keeps "no test" on the row and the unknown reason in the tooltip', async () => {
  const rows = await rowsOf(resultOf([change('failedSearch', 'unknown', 'a caller query failed: boom'), change('none', 'uncovered')]), 'hover');
  assert.equal(rows.none.item.description, '∅  ·  no test');
  assert.equal(rows.failedSearch.item.description, '∅');
  assert.match(rows.failedSearch.item.tooltip.value, /boom/);
});

test('an unknown symbol with no reason recorded still says the search did not finish', async () => {
  const rows = await rowsOf(resultOf([change('bare', 'unknown', null)]));
  assert.match(rows.bare.item.tooltip.value, /did not finish/);
  assert.match(rows.bare.testsItem.description, /did not finish/);
});

test('before the walk runs, every tests row offers to run it and no row reads "no test"', async () => {
  const rows = await rowsOf(resultOf([change('a', 'not-computed'), change('b', 'not-computed')]));
  for (const r of Object.values(rows)) {
    assert.equal(r.tests.label, 'Compute test reachability');
    assert.equal(r.testsItem.command.command, 'impactTree.computeTestReach');
    assert.doesNotMatch(r.item.description, /no test/);
  }
});

test('"no test" says how many caller levels the search covered', async () => {
  for (const depth of [1, 3, 6]) {
    const rows = await rowsOf(resultOf([change('none', 'uncovered')], { reachDepth: depth }));
    const scope = new RegExp(`no test within ${depth} caller level`, 'i');
    assert.match(rows.none.item.tooltip.value, scope);
    assert.match(rows.none.tests.label, scope);
  }
});
