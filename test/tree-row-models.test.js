'use strict';
// The row models of the change tree, built directly from small results: no provider, no
// vscode stub. Inputs are deep-frozen, so a builder that modified one would throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/tree-row-models');

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};
const uriOf = (file, pos) => (file ? `uri:${file}${pos == null ? '' : `#${pos}`}` : null);

let at = 0;
const change = (relPath, label, extra = {}) => ({
  file: `/r/${relPath}`, relPath, label, namePos: ++at, startLine: at, staleCallers: 0, callerState: 'resolved',
  kinds: [{ id: 'body' }], score: 1, ...extra,
});
const resultOf = (extra = {}) => ({
  allChanged: [], findings: [], deleted: [], warnings: [], unanalysable: [], otherFiles: [], untested: [],
  mode: 'pr', base: { ref: 'origin/main', sha: '0123456789abcdef' }, changedFileCount: 1, testReachComputed: true, ...extra,
});

test('a change status leads with the worst fact about its callers', () => {
  const status = (extra) => models.classifyChangeStatus({ staleCallers: 0, callerState: 'resolved', ...extra });
  assert.deepEqual(status({ staleCallers: 2, staleChangedElsewhere: 1 }),
    { token: '⛔', severity: 'stale', marker: '2 call site(s) not updated (1 edited nearby)' });
  assert.match(status({ staleCallers: 1, callersComplete: false }).marker, /more callers may be missing$/);
  assert.deepEqual(status({}), { token: '✓', severity: 'ok', marker: 'all call sites updated' });
  assert.equal(status({ callersComplete: false }).severity, 'warn', 'an incomplete search is never ok');
  assert.equal(status({ callerState: 'none' }).token, '∅');
  assert.equal(status({ callerState: 'di' }).severity, 'muted');
  for (const callerState of ['unknown', undefined, 'anything']) assert.equal(status({ callerState }).marker, 'callers unknown');
});

test('the worst status of several rows comes from the worst row, the first on a tie', () => {
  const rowOf = (extra) => ({ type: 'finding', label: 'x', finding: { staleCallers: 0, callerState: 'resolved', ...extra } });
  assert.equal(models.classifyWorstChangeStatus([rowOf({}), rowOf({ callerState: 'unknown' }), rowOf({ callerState: 'none' })]).marker, 'callers unknown');
  assert.equal(models.classifyWorstChangeStatus([rowOf({ callerState: 'none' }), rowOf({ callerState: 'di' })]).marker, 'no callers found');
});

test('a file status is looked up as given, then with forward slashes', () => {
  const result = { fileStatus: { 'src/a.ts': 'added' } };
  assert.equal(models.getFileStatus(result, 'src/a.ts'), 'added');
  assert.equal(models.getFileStatus(result, 'src\\a.ts'), 'added');
  assert.equal(models.getFileStatus(result, 'src/b.ts'), undefined);
  assert.equal(models.getFileStatus({}, 'src/a.ts'), undefined);
  assert.equal(models.getFileStatus(result, null), undefined);
});

test('the placeholder row explains every state without a result, and there is none with one', () => {
  const label = (view) => models.buildPlaceholderRows({ phase: 'ready', busy: false, state: null, ...view })?.map((r) => r.label);
  assert.deepEqual(label({ phase: 'starting' }), ['Preparing…']);
  assert.deepEqual(label({ phase: 'preparing', state: { result: resultOf() } }), ['Preparing…']);
  assert.deepEqual(label({ phase: 'analysing' }), ['Analysing…']);
  assert.deepEqual(label({ busy: true, state: { result: resultOf() } }), ['Analysing…']);
  assert.deepEqual(label({ state: {} }), ['Ready — click to analyse']);
  assert.deepEqual(label({ state: { error: 'boom' } }), ['boom']);
  assert.equal(label({ state: { result: resultOf() } }), undefined);
});

test('root rows: summary with review progress, preview notice, warnings and the sections a result has', () => {
  const nested = change('a.ts', 'nested', { isRoot: false });
  const top = change('a.ts', 'top', { staleCallers: 3 });
  const body = change('b.ts', 'body');
  const local = deepFreeze(resultOf({
    allChanged: [top, nested, body], findings: [top, nested], untested: [body], testUnknown: [], reachDepth: 2,
    warnings: ['w'], unanalysable: [{ count: 2, component: 'legacy' }], requestedMode: 'branch',
  }));
  const rows = models.buildRootRows(local, { leftToReview: 2 });
  assert.deepEqual(rows.map((r) => r.key || r.type), ['summary', 'message', 'message', 'findings', 'other', 'deleted', 'untested', 'files', 'legend']);
  assert.equal(rows[0].label, '3 changed symbols  ·  2 left to review');
  assert.match(rows[0].desc, /^2 finding\(s\)  ·  3 call site\(s\) not updated/);
  assert.match(rows[0].tooltip, /\(requested 'branch'\)/);
  const findings = rows.find((r) => r.key === 'findings');
  assert.equal(findings.count, 1);
  assert.match(findings.desc, /1 nested under its callee/);
  assert.equal(rows.find((r) => r.key === 'untested').desc, 'no test within 2 caller level(s)');
  assert.equal(models.buildRootRows(local, { leftToReview: 0 })[0].label, '3 changed symbols  ·  all reviewed');
  assert.equal(models.buildRootRows(local, { leftToReview: null })[0].label, '3 changed symbols');

  const unknown = models.buildRootRows(resultOf({ testUnknown: [body] }), { leftToReview: null });
  assert.equal(unknown.find((r) => r.key === 'testUnknown').count, 1);
  const deferred = models.buildRootRows(resultOf({ testReachComputed: false, testUnknown: [body] }), { leftToReview: null });
  assert.equal(deferred.find((r) => r.key === 'testUnknown'), undefined, 'no unknown section before the walk ran');
  assert.equal(deferred.find((r) => r.key === 'untested').computed, false);

  const preview = models.buildRootRows(resultOf({ tierA: true, changedFileCount: 4 }), { leftToReview: null });
  assert.equal(preview[1].label, 'Preview — PR files only (4 file(s))');
  assert.ok(!preview.some((r) => r.key === 'untested' || r.key === 'testUnknown'));
});

test('top-level change refs name only root changes', () => {
  const refs = models.collectTopLevelChangeRefs(resultOf({ allChanged: [change('a.ts', 'a'), change('a.ts', 'b', { isRoot: false })] }));
  assert.deepEqual(refs.map((r) => r.type), ['finding']);
  assert.equal(refs[0].file, '/r/a.ts');
});

test('change rows mark shared labels, carry reach notes, and ask for one decoration each', () => {
  const web = change('web/u.ts', 'helper');
  const api = change('api/u.ts', 'helper');
  const solo = change('s.ts', 'solo', { testReachIncompleteReason: 'budget' });
  const result = deepFreeze(resultOf({ allChanged: [web, api, solo], fileStatus: { 'web/u.ts': 'modified' } }));
  const { rows, decorations } = models.buildChangeRows([solo, web], {
    result, uriOf, reachReasonOf: (c) => c.testReachIncompleteReason || null, scopeNote: 'note',
  });
  assert.deepEqual(rows.map((r) => [r.label, r.ambiguous, r.reachReason, r.scopeNote]), [['solo', false, 'budget', 'note'], ['helper', true, null, 'note']]);
  assert.equal(rows[1].finding, web);
  assert.equal(rows[1].decorationUri, `uri:/r/web/u.ts#${web.namePos}`);
  assert.deepEqual(decorations.map((d) => [d.status, d.tooltip]), [[undefined, `s.ts:${solo.startLine}`], ['modified', `web/u.ts:${web.startLine}`]]);
  const plain = models.buildChangeRows([web], { result, uriOf }).rows[0];
  assert.equal(plain.reachReason, null);
  assert.equal(plain.scopeNote, null);
});

test('deleted rows fall back to the deleted status', () => {
  const deleted = deepFreeze([{ label: 'gone', key: 'k', relPath: 'o.ts', file: '/r/o.ts', namePos: 3 }]);
  const { rows, decorations } = models.buildDeletedRows(deleted, { result: resultOf({ fileStatus: {} }), uriOf });
  assert.deepEqual(rows[0], { type: 'deleted', label: 'gone', key: 'k', relPath: 'o.ts', file: '/r/o.ts', decorationUri: 'uri:/r/o.ts#3' });
  assert.deepEqual(decorations, [{ uri: 'uri:/r/o.ts#3', status: 'deleted', tooltip: 'gone deleted' }]);
  assert.equal(models.buildDeletedRows(deleted, { result: resultOf({ fileStatus: { 'o.ts': 'modified' } }), uriOf }).decorations[0].status, 'modified');
});

test('file leaves are sorted by path and decorated only when the path can be made absolute', () => {
  const files = deepFreeze([{ path: 'z/b.md', status: 'added' }, { path: 'a.md', status: 'modified' }]);
  const absolute = models.buildFileLeafRows(files, { absPath: (p) => `/r/${p}`, uriOf });
  assert.deepEqual(absolute.rows.map((r) => [r.label, r.relPath, r.absPath]), [['a.md', 'a.md', '/r/a.md'], ['b.md', 'z/b.md', '/r/z/b.md']]);
  assert.deepEqual(absolute.decorations.map((d) => d.tooltip), ['z/b.md', 'a.md'], 'requested in input order');
  const relative = models.buildFileLeafRows(files, { absPath: null, uriOf });
  assert.deepEqual(relative.decorations, []);
  assert.equal(relative.rows[0].decorationUri, null);
  assert.deepEqual(files.map((f) => f.path), ['z/b.md', 'a.md']);
});

test('excluded callers are dropped only when there is a path mapping', () => {
  const callers = deepFreeze([{ file: '/r/keep.ts' }, { file: '/r/scratch.ts' }]);
  const rel = (f) => f.replace('/r/', '');
  assert.deepEqual(models.dropExcludedCallers(callers, ['scratch.ts'], rel).map((c) => c.file), ['/r/keep.ts']);
  assert.equal(models.dropExcludedCallers(callers, ['scratch.ts'], null), callers);
  assert.equal(models.dropExcludedCallers(callers, [], rel), callers);
  assert.equal(models.dropExcludedCallers(callers, undefined, rel), callers);
});

test('the ancestry of a row is its path plus itself, without duplicates', () => {
  assert.deepEqual(models.collectAncestry({ file: '/r/a.ts', pos: 1 }), ['/r/a.ts#1']);
  const path = deepFreeze(['/r/x.ts#5', '/r/a.ts#1']);
  assert.deepEqual(models.collectAncestry({ file: '/r/a.ts', pos: 1, path }), ['/r/x.ts#5', '/r/a.ts#1']);
  assert.deepEqual(models.collectAncestry({ file: '/r/b.ts', pos: 2, path }), ['/r/x.ts#5', '/r/a.ts#1', '/r/b.ts#2']);
});

test('caller rows: state from the evidence, cycles from the ancestry, sorted by path then label', () => {
  const evidence = (updated, untouched) => ({ updated: Array(updated).fill({}), untouched: Array(untouched).fill({}), unknown: [] });
  const classified = deepFreeze([
    { caller: { file: '/r/z.ts', pos: 1, label: 'zed', sites: 1, callSites: [{ start: 1, end: 2 }] }, callSiteUpdates: evidence(1, 0) },
    { caller: { file: '/r/a.ts', pos: 9, label: 'beta', sites: 2 }, callSiteUpdates: evidence(1, 1) },
    { caller: { file: '/r/a.ts', pos: 3, label: 'alpha', test: true }, callSiteUpdates: evidence(0, 1) },
  ]);
  const ancestry = deepFreeze(['/r/a.ts#3']);
  const { rows, decorations } = models.buildCallerRows(classified, {
    ancestry, reviewParent: 'p', changedKeys: new Set(['/r/a.ts#9']), rel: (f) => f.replace('/r/', ''),
    result: { fileStatus: { 'z.ts': 'added' } }, uriOf,
  });
  assert.deepEqual(rows.map((r) => [r.label, r.callState, r.cycle, r.changed]),
    [['alpha', 'unchanged', true, false], ['beta', 'changed-elsewhere', false, true], ['zed', 'updated-at-call', false, false]]);
  assert.deepEqual(rows[2].callSites, [{ start: 1, end: 2 }]);
  assert.deepEqual(rows[0].callSites, [], 'missing call sites read as none');
  assert.equal(rows[0].reviewParent, 'p');
  assert.deepEqual(rows[0].path, ['/r/a.ts#3']);
  assert.deepEqual(decorations.map((d) => [d.tooltip, d.status]), [['z.ts', 'added'], ['a.ts', undefined], ['a.ts', undefined]], 'requested in answer order');
  const noView = models.buildCallerRows(classified, { ancestry: [], reviewParent: null, changedKeys: new Set(), rel: null, result: null, uriOf });
  assert.equal(noView.rows[0].relPath, '/r/a.ts', 'without a path mapping the file is its own path');
});

test('an incomplete caller list says whether anything was found; changes inside get their own row', () => {
  assert.equal(models.buildIncompleteCallersRow('why', true).label, 'More callers may be missing');
  assert.deepEqual(models.buildIncompleteCallersRow('why', false),
    { type: 'message', icon: 'warning', label: 'Callers could not be loaded', desc: 'refresh to retry', tooltip: 'why' });
  const inner = { type: 'finding', label: 'x', inside: [{ type: 'finding', label: 'y' }] };
  const holder = deepFreeze({ type: 'finding', label: 'H', file: '/r/h.ts', finding: { label: 'H', relPath: 'h.ts' }, inside: [inner] });
  const group = models.buildInsideGroupRow(holder);
  assert.equal(group.type, 'insideGroup');
  assert.equal(group.container, 'H');
  assert.equal(group.rows, holder.inside);
  assert.deepEqual(group.members.map((m) => m.label), ['x', 'y']);
});

test('legend rows follow the legend, and the deferred-walk row runs the walk', () => {
  assert.deepEqual(models.buildLegendRows().map((r) => r.icon), models.LEGEND.map(([icon]) => icon));
  assert.equal(models.buildComputeTestReachRow().command, 'impactTree.computeTestReach');
});
