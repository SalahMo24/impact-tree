'use strict';
// The tree must not call a symbol untested when the test search failed or stopped early:
// "No test reaches" holds only symbols whose walk finished, and a separate section shows
// the others with the reason their walk is unknown.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');

const BODY = [{ id: 'body', label: 'body' }];
let at = 0;
const change = (label, testState, reason = null, extra = {}) => ({
  file: '/repo/src/a.ts', relPath: 'src/a.ts', label, namePos: at++, start: at * 100, end: at * 100 + 50, startLine: at,
  component: '(root)', kinds: BODY, throwsAdded: [], callers: [], stale: [], staleCallers: 0, callerState: 'none', score: 1,
  testState, testReachIncompleteReason: reason, tests: testState === 'covered' ? ['t'] : [], ...extra,
});
// the lists the engine derives from testState, built the same way here
const resultOf = (changed, extra = {}) => ({
  allChanged: changed, findings: [], deleted: [], warnings: [], unanalysable: [], otherFiles: [],
  untested: changed.filter((c) => c.testState === 'uncovered'),
  testUnknown: changed.filter((c) => c.testState === 'unknown'),
  mode: 'working', base: { ref: 'HEAD', sha: '0' }, testReachComputed: changed.some((c) => c.testState !== 'not-computed'),
  ...extra,
});

async function sections(result) {
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'inline', rel: (f) => f.replace('/repo/', '') }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review: null,
  });
  const top = await provider.getChildren();
  const rows = async (key) => {
    const section = top.find((n) => n.key === key);
    return section ? { section, nodes: await provider.getChildren(section) } : null;
  };
  return { provider, top, rows };
}

test('the untested section lists only uncovered symbols; unknown ones have their own section with the reason', async () => {
  const covered = change('covered', 'covered');
  const none = change('provenUntested', 'uncovered');
  const failed = change('failedSearch', 'unknown', 'a caller query failed: language server crashed');
  const deep = change('cutByDepth', 'unknown', 'the depth limit of 2 stopped the walk');
  const { provider, rows } = await sections(resultOf([covered, none, failed, deep]));

  const untested = await rows('untested');
  assert.deepEqual(untested.nodes.map((n) => n.label), ['provenUntested']);
  assert.equal(untested.section.count, 1);

  const unknown = await rows('testUnknown');
  assert.equal(unknown.section.count, 2);
  assert.deepEqual(unknown.nodes.map((n) => n.label).sort(), ['cutByDepth', 'failedSearch']);
  for (const node of unknown.nodes) {
    const item = provider.getTreeItem(node);
    const reason = node.finding.testReachIncompleteReason;
    assert.ok(item.description.includes(reason), `description shows the reason: ${item.description}`);
    assert.ok(item.tooltip.value.includes(reason), 'tooltip shows the reason');
  }
  // the covered symbol is in neither
  for (const section of [untested, unknown]) assert.ok(!section.nodes.some((n) => n.label === 'covered'));
});

test('hover mode still shows the reason on an unknown row', async () => {
  const failed = change('failedSearch', 'unknown', 'a caller query failed: boom');
  const result = resultOf([failed]);
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/repo/', '') }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review: null,
  });
  const top = await provider.getChildren();
  const [row] = await provider.getChildren(top.find((n) => n.key === 'testUnknown'));
  assert.match(provider.getTreeItem(row).description, /boom/);
});

test('rows in the other sections do not carry a test-reach reason', async () => {
  const failed = change('failedSearch', 'unknown', 'a caller query failed: boom');
  const other = change('plain', 'uncovered');
  const { provider, rows } = await sections(resultOf([failed, other]));
  const { nodes } = await rows('other');
  assert.equal(nodes.length > 0, true);
  for (const node of nodes.flatMap((n) => (n.type === 'finding' ? [n] : []))) {
    assert.ok(!/tests unknown/.test(provider.getTreeItem(node).description), node.label);
  }
});

test('there is no unknown section when every walk finished, or when none ran', async () => {
  const finished = await sections(resultOf([change('a', 'uncovered'), change('b', 'covered')]));
  assert.equal(await finished.rows('testUnknown'), null);
  const deferred = await sections(resultOf([change('a', 'not-computed')]));
  assert.equal(await deferred.rows('testUnknown'), null);
  const untested = await deferred.rows('untested');
  assert.equal(untested.section.count, 0);
  assert.equal(untested.section.computed, false);
});

test('an unknown symbol with no reason recorded still says the search did not finish', async () => {
  const bare = change('bare', 'unknown', null);
  const { provider, rows } = await sections(resultOf([bare]));
  const { nodes } = await rows('testUnknown');
  assert.match(provider.getTreeItem(nodes[0]).description, /did not finish/);
});

test('a PR preview shows neither test section', async () => {
  const { top } = await sections(resultOf([change('a', 'unknown', 'x')], { tierA: true, testReachComputed: false }));
  assert.ok(!top.some((n) => n.key === 'untested' || n.key === 'testUnknown'));
});
