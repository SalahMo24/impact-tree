'use strict';
// The file-first row model, built directly from small results: no provider, no vscode
// stub (except in the identity test, which checks that the provider shows the ticks the
// old tree stored). Inputs are deep-frozen, so a function that modified one would throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/review-tree-model');
const { NO_SITE_EVIDENCE } = require('../src/tree-row-models');

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};
const uriOf = (file, pos) => (file ? `uri:${file}${pos == null ? '' : `#${pos}`}` : null);
const absPath = (rel) => `/r/${rel}`;
const rel = (f) => f.replace('/r/', '');

const BODY = { id: 'body', label: 'body' };
const SIG = { id: 'param', label: 'parameter', short: 'param' };
let at = 0;
const change = (relPath, label, extra = {}) => {
  const line = extra.startLine ?? ++at * 10;
  return {
    file: `/r/${relPath}`, relPath, label, namePos: line * 100, startLine: line, endLine: line + 5, staleCallers: 0,
    callerState: 'none', callers: [], kinds: [BODY], score: 1, testState: 'uncovered', tests: [], ...extra,
  };
};
const site = (start) => ({ start, end: start + 3 });
const callerOf = (relPath, label, pos, extra = {}) => ({
  file: `/r/${relPath}`, pos, label, test: false, callSites: [site(pos + 1)], sites: 1,
  callSiteUpdates: { updated: [], untouched: [site(pos + 1)], unknown: [] }, callState: 'unchanged', ...extra,
});
const resultOf = (extra = {}) => {
  const allChanged = extra.allChanged || [];
  const paths = {};
  for (const c of allChanged) paths[c.relPath] = 'modified';
  for (const o of extra.outside || []) paths[o.relPath] = 'modified';
  for (const d of extra.deleted || []) paths[d.relPath] = 'modified';
  for (const f of extra.otherFiles || []) paths[f.path] = f.status;
  return {
    allChanged, findings: [], deleted: [], outside: [], otherFiles: [], untested: [], testReachComputed: true, reachDepth: 2,
    fileStatus: paths, ...extra,
  };
};
const build = (result, opts = {}) => model.buildFileRows(deepFreeze(result), { uriOf, absPath, ...opts });
const pathsOf = (rows) => rows.map((r) => r.relPath);
const labelsOf = (file) => file.rows.map((r) => r.label);
const outside = (relPath, ranges) => ({ file: `/r/${relPath}`, relPath, ranges });
const deleted = (relPath, label, startLine) => ({ label, key: label.replace('.', '>'), relPath, file: `/r/${relPath}`, namePos: startLine, startLine });

test('a file with only outside lines is a call-graph file with one quiet row', () => {
  const { rows } = build(resultOf({ outside: [outside('src/consts.js', [[1, 3], [9, 9]])] }));
  assert.equal(rows.length, 1);
  const [file] = rows;
  assert.equal(file.type, 'reviewFile');
  assert.equal(file.relPath, 'src/consts.js');
  assert.equal(file.status, 'modified');
  assert.equal(file.file, '/r/src/consts.js');
  assert.equal(file.level, 4);
  assert.equal(file.attention, 0);
  assert.deepEqual(file.rows.map((r) => r.type), ['outside']);
});

test('a file without a call graph is a file row of level 5 and its own counting row', () => {
  const result = resultOf({
    allChanged: [change('src/a.js', 'a')],
    otherFiles: [{ path: 'docs/guide.md', status: 'added', noCallable: true }],
    fileStatus: { 'src/a.js': 'modified', 'docs/guide.md': 'added', 'migrations/001.sql': 'modified' },
  });
  const { rows, decorations } = build(result);
  const leaves = rows.filter((r) => r.type === 'file');
  assert.deepEqual(pathsOf(leaves), ['docs/guide.md', 'migrations/001.sql'], 'a path with no rows is a file row even when it is not in otherFiles');
  for (const leaf of leaves) assert.equal(leaf.level, 5);
  assert.equal(leaves[0].status, 'added');
  assert.equal(leaves[1].status, 'modified', 'its status comes from the result\'s fileStatus');
  assert.equal(leaves[0].label, 'guide.md');
  assert.ok(decorations.some((d) => d.uri === 'uri:/r/docs/guide.md'), 'the file row carries its decoration');
  assert.deepEqual(model.collectCountingRows(rows).filter((r) => r.type === 'file'), leaves);
});

test('without a path mapping a file row has no resource and no decoration', () => {
  const { rows, decorations } = build(resultOf({ otherFiles: [{ path: 'x.md', status: 'added' }] }), { absPath: null });
  assert.equal(rows[0].decorationUri, null);
  assert.deepEqual(decorations, []);
});

test('a nested method shows its own name and its container, and keeps the full label', () => {
  const nested = change('src/s.js', 'Store.cache.get', { isRoot: false });
  const plain = change('src/s.js', 'helper');
  const { rows } = build(resultOf({ allChanged: [nested, plain] }));
  const byLabel = Object.fromEntries(rows[0].rows.map((r) => [r.label, r]));
  assert.equal(byLabel['Store.cache.get'].name, 'get');
  assert.equal(byLabel['Store.cache.get'].container, 'Store.cache');
  assert.equal(byLabel.helper.name, 'helper');
  assert.equal(byLabel.helper.container, null);
});

test('every changed symbol gets a row in its file, roots and non-roots alike, without nesting', () => {
  const root = change('src/s.js', 'Outer', { startLine: 10, endLine: 50 });
  const inner = change('src/s.js', 'Outer.inner', { isRoot: false, startLine: 20, endLine: 25 });
  const { rows } = build(resultOf({ allChanged: [root, inner] }));
  assert.equal(rows.length, 1);
  assert.deepEqual(labelsOf(rows[0]).sort(), ['Outer', 'Outer.inner']);
  for (const row of rows[0].rows) {
    assert.equal(row.inside, undefined);
    assert.equal(row.type, 'finding');
  }
});

test('a change row has the fields the review identity reads and no review parent', () => {
  const c = change('src/s.js', 'Store.save', { kinds: [SIG] });
  const { rows } = build(resultOf({ allChanged: [c] }));
  const row = rows[0].rows[0];
  assert.equal(row.type, 'finding');
  assert.equal(row.label, 'Store.save');
  assert.equal(row.file, c.file);
  assert.equal(row.pos, c.namePos);
  assert.equal(row.reviewParent, undefined);
  assert.equal(row.finding, c);
});

test('a deleted symbol is a level 1 row of its file and needs attention', () => {
  const quiet = change('src/p.js', 'keep', { startLine: 5 });
  const { rows } = build(resultOf({
    allChanged: [quiet], deleted: [deleted('src/p.js', 'parse.flush', 30), deleted('src/gone.js', 'whole', 1)],
  }));
  const p = rows.find((r) => r.relPath === 'src/p.js');
  assert.deepEqual(p.rows.map((r) => r.type), ['deleted', 'finding']);
  assert.equal(p.rows[0].name, 'flush');
  assert.equal(p.rows[0].container, 'parse');
  assert.equal(p.level, 1);
  assert.equal(p.attention, 1);
  const gone = rows.find((r) => r.relPath === 'src/gone.js');
  assert.equal(gone.type, 'reviewFile', 'a file holding only a deleted symbol has a call graph');
});

// ---- order in a file --------------------------------------------------------------------
const risky = (extra) => ({ kinds: [SIG], callerState: 'resolved', ...extra });

test('rows sort by level, then outside rows after the others of their level, then line', () => {
  const stale = change('src/m.js', 'stale', risky({ startLine: 90, staleCallers: 1, callers: [callerOf('src/u.js', 'u', 1)] }));
  const unknown = change('src/m.js', 'unknown', risky({ startLine: 70, callerState: 'unknown' }));
  const bodyLate = change('src/m.js', 'bodyLate', { startLine: 60, callerState: 'resolved', callers: [callerOf('src/u.js', 'u', 2)] });
  const bodyEarly = change('src/m.js', 'bodyEarly', { startLine: 20, callerState: 'resolved', callers: [callerOf('src/u.js', 'u', 3)] });
  const quietLate = change('src/m.js', 'quietLate', { startLine: 80 });
  const { rows } = build(resultOf({
    allChanged: [bodyLate, stale, quietLate, bodyEarly, unknown],
    deleted: [deleted('src/m.js', 'gone', 40)],
    outside: [outside('src/m.js', [[1, 2]])],
  }));
  // level 0; level 1 by line (deleted at 40, unknown at 70); level 3 by line; level 4 with outside last
  assert.deepEqual(labelsOf(rows[0]), ['stale', 'gone', 'unknown', 'bodyEarly', 'bodyLate', 'quietLate', 'Outside functions']);
});

test('rows of equal level, kind and line keep their input order', () => {
  const a = change('src/m.js', 'a', { startLine: 10 });
  const b = change('src/m.js', 'b', { startLine: 10 });
  assert.deepEqual(labelsOf(build(resultOf({ allChanged: [a, b] })).rows[0]), ['a', 'b']);
  assert.deepEqual(labelsOf(build(resultOf({ allChanged: [b, a] })).rows[0]), ['b', 'a']);
});

test('an outside row comes after rows of its level even on an earlier line', () => {
  const late = change('src/m.js', 'late', { startLine: 50 });
  const { rows } = build(resultOf({ allChanged: [late], outside: [outside('src/m.js', [[2, 4]])] }));
  assert.deepEqual(labelsOf(rows[0]), ['late', 'Outside functions']);
});

// ---- order of files ---------------------------------------------------------------------
const fileOrder = (result) => pathsOf(build(result).rows);
const stale1 = (relPath, label) => change(relPath, label, risky({ staleCallers: 1, callers: [callerOf('src/u.js', 'u', 7)] }));
const unknown1 = (relPath, label) => change(relPath, label, risky({ callerState: 'unknown' }));
const quiet = (relPath, label) => change(relPath, label);
const reaches = (relPath, label) => change(relPath, label, { callerState: 'resolved', callers: [callerOf('src/u.js', 'u', 9)] });

test('files sort by their worst level first', () => {
  assert.deepEqual(fileOrder(resultOf({ allChanged: [quiet('c.js', 'q'), reaches('b.js', 'r'), unknown1('d.js', 'u'), stale1('e.js', 's')] })),
    ['e.js', 'd.js', 'b.js', 'c.js']);
});

test('files of one level sort by attention, more first', () => {
  const result = resultOf({ allChanged: [stale1('a.js', 's1'), stale1('b.js', 's2'), unknown1('b.js', 'u2'), stale1('b.js', 's3'), quiet('c.js', 'q')] });
  assert.deepEqual(fileOrder(result), ['b.js', 'a.js', 'c.js']);
});

test('files of equal level and attention sort by row count, more first', () => {
  const result = resultOf({ allChanged: [stale1('a.js', 's1'), stale1('b.js', 's2'), quiet('b.js', 'q1'), quiet('b.js', 'q2')] });
  assert.deepEqual(fileOrder(result), ['b.js', 'a.js']);
});

test('files equal in everything else sort by path, and file rows sort by path last', () => {
  const result = resultOf({
    allChanged: [quiet('z.js', 'q'), quiet('m.js', 'q'), quiet('a.js', 'q')],
    otherFiles: [{ path: 'y.md', status: 'added' }, { path: 'b.md', status: 'added' }],
  });
  assert.deepEqual(fileOrder(result), ['a.js', 'm.js', 'z.js', 'b.md', 'y.md']);
});

test('a file with an outside row has the level of its worst row and counts the outside row', () => {
  const result = resultOf({ allChanged: [unknown1('a.js', 'u')], outside: [outside('a.js', [[1, 1]]), outside('b.js', [[1, 1]])] });
  const { rows } = build(result);
  assert.deepEqual(rows.map((r) => [r.relPath, r.level, r.rows.length]), [['a.js', 1, 2], ['b.js', 4, 1]]);
});

// ---- the whole model --------------------------------------------------------------------
test('building does not modify the result and returns decorations for the rows it makes', () => {
  const c = change('src/s.js', 'Store.save');
  const result = resultOf({
    allChanged: [c], deleted: [deleted('src/s.js', 'old', 1)], outside: [outside('src/s.js', [[1, 1]])],
    otherFiles: [{ path: 'x.md', status: 'added' }],
  });
  const { rows, decorations } = build(result);
  const uris = new Set(decorations.map((d) => d.uri));
  for (const u of [`uri:${c.file}#${c.namePos}`, 'uri:/r/src/s.js', 'uri:/r/x.md']) assert.ok(uris.has(u), u);
  assert.equal(rows.find((r) => r.type === 'reviewFile').decorationUri, 'uri:/r/src/s.js');
  assert.equal(decorations.find((d) => d.uri === 'uri:/r/src/s.js').status, 'modified');
});

test('a result with nothing changed has no files', () => {
  assert.deepEqual(build(resultOf()), { rows: [], decorations: [] });
});

// ---- counting rows ----------------------------------------------------------------------
test('counting rows are the changes, deleted and outside rows of call-graph files and every file row', () => {
  const result = resultOf({
    allChanged: [change('a.js', 'a'), change('a.js', 'a.b', { isRoot: false }), change('b.js', 'b')],
    deleted: [deleted('a.js', 'gone', 1)], outside: [outside('b.js', [[1, 1]])],
    otherFiles: [{ path: 'c.md', status: 'added' }],
  });
  const { rows } = build(result);
  const counting = model.collectCountingRows(rows);
  assert.deepEqual(counting.map((r) => `${r.type}:${r.label}`).sort(),
    ['deleted:gone', 'file:c.md', 'finding:a', 'finding:a.b', 'finding:b', 'outside:Outside functions']);
});

test('callers and tests rows never count', () => {
  const c = change('a.js', 'a', { callerState: 'resolved', callers: [callerOf('b.js', 'u', 1), callerOf('c.js', 'v', 2)] });
  const result = resultOf({ allChanged: [c] });
  const files = build(result).rows;
  const impact = model.buildImpactRows(files[0].rows[0], { result, uriOf, rel });
  assert.ok(impact.rows.length >= 3, 'two callers and a tests row');
  assert.equal(model.collectCountingRows(files).length, 1);
});

// ---- impact rows ------------------------------------------------------------------------
const impactOf = (c, extra = {}, others = []) => {
  const result = deepFreeze(resultOf({ allChanged: [c, ...others], ...extra }));
  const row = build(result).rows.find((r) => r.relPath === c.relPath).rows.find((r) => r.finding === c);
  return model.buildImpactRows(row, { result, uriOf, rel });
};
const testsRows = (rows) => rows.filter((r) => r.type === 'message' && r.label !== 'More callers may be missing' && r.label !== 'Callers could not be loaded');

test('impact rows list the callers the result carries, one row per file, with their call state', () => {
  const callers = [
    callerOf('src/u.js', 'one', 10),
    callerOf('src/u.js', 'two', 20, { callSiteUpdates: { updated: [site(21)], untouched: [], unknown: [] }, callState: 'updated-at-call' }),
    callerOf('src/w.js', 'three', 30),
  ];
  const { rows, decorations } = impactOf(change('src/a.js', 'a', { callerState: 'resolved', callers }));
  const group = rows.find((r) => r.type === 'callerFile');
  assert.equal(group.relPath, 'src/u.js');
  assert.deepEqual(group.callers.map((c) => [c.label, c.callState]), [['one', 'unchanged'], ['two', 'updated-at-call']]);
  const single = rows.find((r) => r.type === 'caller');
  assert.equal(single.label, 'three');
  assert.equal(single.relPath, 'src/w.js');
  assert.ok(decorations.length >= 3);
});

test('a caller that was edited elsewhere is marked as changed, from the result\'s own changes', () => {
  const caller = callerOf('src/u.js', 'u', 500, { callState: 'changed-elsewhere' });
  const edited = change('src/u.js', 'u', { namePos: 500, startLine: 1 });
  const a = change('src/a.js', 'a', { callerState: 'resolved', callers: [caller] });
  const callerRow = impactOf(a, {}, [edited]).rows.find((r) => r.type === 'caller');
  assert.equal(callerRow.changed, true);
  assert.equal(callerRow.callState, 'changed-elsewhere');
});

test('a caller without call-site evidence is built with none', () => {
  const bare = { file: '/r/src/u.js', pos: 5, label: 'bare', test: false, callSites: [site(6)], sites: 1 };
  const { rows } = impactOf(change('src/a.js', 'a', { callerState: 'resolved', callers: [bare] }));
  assert.deepEqual(rows.find((r) => r.type === 'caller').callSiteUpdates, NO_SITE_EVIDENCE);
});

test('a complete caller list has no incomplete row, an incomplete one closes with it', () => {
  const callers = [callerOf('src/u.js', 'u', 1)];
  const complete = impactOf(change('src/a.js', 'a', { callerState: 'resolved', callers, callersComplete: true })).rows;
  assert.equal(complete.filter((r) => r.label === 'More callers may be missing').length, 0);
  const cut = impactOf(change('src/a.js', 'a', { callerState: 'resolved', callers, callersComplete: false, callersIncompleteReason: 'budget' })).rows;
  const missing = cut.find((r) => r.label === 'More callers may be missing');
  assert.equal(missing.tooltip, 'budget');
  assert.equal(cut.indexOf(missing), 1, 'it closes the caller list, before the tests row');
  const none = impactOf(change('src/a.js', 'a', { callerState: 'unknown', callers: [], callersComplete: false })).rows;
  assert.equal(none[0].label, 'Callers could not be loaded');
  assert.equal(none[0].tooltip, 'the caller search did not finish');
});

test('a covered change says which test reaches it', () => {
  const { rows } = impactOf(change('src/a.js', 'a', { testState: 'covered', tests: ['a.test.js', 'b.test.js'] }));
  assert.deepEqual(testsRows(rows).map((r) => r.label), ['Tested by a.test.js, b.test.js']);
});

test('an uncovered change says how far the search went', () => {
  const { rows } = impactOf(change('src/a.js', 'a', { testState: 'uncovered' }), { reachDepth: 3 });
  assert.deepEqual(testsRows(rows).map((r) => r.label), ['No test within 3 caller level(s)']);
  const unbounded = impactOf(change('src/a.js', 'a', { testState: 'uncovered' }), { reachDepth: 0 });
  assert.deepEqual(testsRows(unbounded.rows).map((r) => r.label), ['No test within the searched caller levels']);
});

test('an unknown test reach is not reported as untested, and says why', () => {
  const withReason = impactOf(change('src/a.js', 'a', { testState: 'unknown', testReachIncompleteReason: 'budget ran out' })).rows;
  const [row] = testsRows(withReason);
  assert.equal(row.label, 'Test reach unknown');
  assert.equal(row.desc, 'budget ran out');
  const noReason = impactOf(change('src/a.js', 'a', { testState: 'unknown' })).rows;
  assert.equal(testsRows(noReason)[0].desc, 'the test search did not finish');
  const odd = impactOf(change('src/a.js', 'a', { testState: 'something-new' })).rows;
  assert.equal(testsRows(odd)[0].label, 'Test reach unknown', 'a state the result does not define is not an answer');
});

test('when test reach was not computed the row offers to compute it', () => {
  const { rows } = impactOf(change('src/a.js', 'a', { testState: 'not-computed' }), { testReachComputed: false });
  const tests = testsRows(rows);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].command, 'impactTree.computeTestReach');
});

test('a PR preview states that tests are not searched, and offers no command that would refuse', () => {
  for (const testState of ['not-computed', 'unknown', undefined]) {
    const { rows } = impactOf(change('src/a.js', 'a', { testState }), { tierA: true, testReachComputed: false });
    const tests = testsRows(rows);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].label, 'Tests are not searched in a PR preview');
    assert.equal(tests[0].command, undefined);
    assert.match(tests[0].tooltip, /Check out the PR/);
  }
});

test('there is exactly one tests row, after the callers', () => {
  const callers = [callerOf('src/u.js', 'u', 1)];
  for (const state of ['covered', 'uncovered', 'unknown']) {
    const { rows } = impactOf(change('src/a.js', 'a', { callerState: 'resolved', callers, testState: state, tests: state === 'covered' ? ['t'] : [] }));
    assert.equal(testsRows(rows).length, 1, state);
    assert.equal(rows.at(-1), testsRows(rows)[0], state);
  }
});

// ---- finding a row by line --------------------------------------------------------------
test('findRowAtLine finds the innermost change, then an outside range, then the file', () => {
  const outer = change('src/s.js', 'Outer', { startLine: 10, endLine: 60 });
  const inner = change('src/s.js', 'Outer.inner', { isRoot: false, startLine: 20, endLine: 30 });
  const deeper = change('src/s.js', 'Outer.inner.deep', { isRoot: false, startLine: 22, endLine: 24 });
  const { rows } = build(resultOf({ allChanged: [outer, inner, deeper], outside: [outside('src/s.js', [[1, 3], [80, 81]])] }));
  const labelAt = (line) => model.findRowAtLine(rows, 'src/s.js', line).label;
  assert.equal(labelAt(23), 'Outer.inner.deep');
  assert.equal(labelAt(26), 'Outer.inner');
  assert.equal(labelAt(50), 'Outer');
  assert.equal(labelAt(10), 'Outer', 'the first line is inside');
  assert.equal(labelAt(60), 'Outer', 'the last line is inside');
  assert.equal(labelAt(2), 'Outside functions');
  assert.equal(labelAt(81), 'Outside functions');
  assert.equal(model.findRowAtLine(rows, 'src/s.js', 70).type, 'reviewFile', 'between functions it is the file row');
  assert.equal(model.findRowAtLine(rows, 'src/s.js', 0).type, 'reviewFile');
});

test('findRowAtLine on an unknown path is null, and on a file without a call graph is the file row', () => {
  const { rows } = build(resultOf({ allChanged: [change('a.js', 'a')], otherFiles: [{ path: 'c.md', status: 'added' }] }));
  assert.equal(model.findRowAtLine(rows, 'nope.js', 1), null);
  assert.equal(model.findRowAtLine(rows, 'c.md', 3), rows.find((r) => r.relPath === 'c.md'));
});

test('findRowAtLine ignores deleted rows, which have no line in the new file', () => {
  const { rows } = build(resultOf({ allChanged: [change('a.js', 'a', { startLine: 50, endLine: 60 })], deleted: [deleted('a.js', 'gone', 5)] }));
  assert.equal(model.findRowAtLine(rows, 'a.js', 5).type, 'reviewFile');
});

// ---- filters and the walk to the next unreviewed row ------------------------------------
// a.js: bad (⛔), mid (●), low (∅) and an outside row; b.js: unk (?); c.js: q (∅); n.md has no call graph.
function walkRows() {
  const result = resultOf({
    allChanged: [stale1('a.js', 'bad'), reaches('a.js', 'mid'), quiet('a.js', 'low'), unknown1('b.js', 'unk'), quiet('c.js', 'q')],
    outside: [outside('a.js', [[1, 2]])], otherFiles: [{ path: 'n.md', status: 'added' }],
  });
  const { rows } = build(result);
  const row = (rel, label) => (rel === 'n.md' ? rows.find((f) => f.relPath === rel) : rows.find((f) => f.relPath === rel).rows.find((r) => r.label === label));
  const ticked = new Set();
  return { rows, row, ticked, isReviewed: (r) => ticked.has(r) };
}
const shownLabels = (entries) => entries.map((e) => [e.file.relPath, e.rows.map((r) => r.label)]);

test('no filter keeps every file with every counting row, in display order', () => {
  const { rows, isReviewed } = walkRows();
  assert.deepEqual(shownLabels(model.filterFileRows(rows, 'all', isReviewed)), [
    ['a.js', ['bad', 'mid', 'low', 'Outside functions']], ['b.js', ['unk']], ['c.js', ['q']], ['n.md', ['n.md']],
  ]);
});

test('"attention" keeps the unticked rows at level 1 or worse, and the files that have one', () => {
  const { rows, row, ticked, isReviewed } = walkRows();
  assert.deepEqual(shownLabels(model.filterFileRows(rows, 'attention', isReviewed)), [['a.js', ['bad']], ['b.js', ['unk']]]);
  ticked.add(row('a.js', 'bad'));
  assert.deepEqual(shownLabels(model.filterFileRows(rows, 'attention', isReviewed)), [['b.js', ['unk']]], 'a ticked row is gone, and its file with it');
  ticked.add(row('b.js', 'unk'));
  assert.deepEqual(model.filterFileRows(rows, 'attention', isReviewed), []);
});

test('"unreviewed" keeps the unticked counting rows, and a file row without a call graph while it is unticked', () => {
  const { rows, row, ticked, isReviewed } = walkRows();
  ticked.add(row('a.js', 'mid')); ticked.add(row('a.js', 'Outside functions')); ticked.add(row('c.js', 'q'));
  assert.deepEqual(shownLabels(model.filterFileRows(rows, 'unreviewed', isReviewed)), [['a.js', ['bad', 'low']], ['b.js', ['unk']], ['n.md', ['n.md']]]);
  ticked.add(row('n.md')); ticked.add(row('a.js', 'bad')); ticked.add(row('a.js', 'low'));
  assert.deepEqual(shownLabels(model.filterFileRows(rows, 'unreviewed', isReviewed)), [['b.js', ['unk']]]);
});

test('filtering hands back the file rows themselves and does not modify them', () => {
  const { rows, isReviewed } = walkRows();
  const before = rows.map((f) => (f.rows ? f.rows.length : null));
  const [first] = model.filterFileRows(rows, 'attention', isReviewed);
  assert.equal(first.file, rows[0]);
  assert.deepEqual(rows.map((f) => (f.rows ? f.rows.length : null)), before, 'the file still holds all its rows');
});

test('toggling a filter turns it on, turns the other off, and a second toggle returns to all', () => {
  assert.equal(model.toggleFilter('all', 'attention'), 'attention');
  assert.equal(model.toggleFilter('attention', 'unreviewed'), 'unreviewed');
  assert.equal(model.toggleFilter('unreviewed', 'unreviewed'), 'all');
  assert.equal(model.toggleFilter('attention', 'attention'), 'all');
});

test('the summary names a filter that narrows the tree and says nothing for all', () => {
  const result = { mode: 'branch', base: { ref: 'main' } };
  const counts = { total: 5, left: 3, attention: 1 };
  assert.equal(model.buildReviewSummary(result, null, counts).message, 'branch mode against main · 1 need attention · 3 of 5 left');
  assert.equal(model.buildReviewSummary(result, null, counts, 'all').message, 'branch mode against main · 1 need attention · 3 of 5 left');
  assert.match(model.buildReviewSummary(result, null, counts, 'attention').message, / · filter: needs attention$/);
  assert.match(model.buildReviewSummary(result, null, counts, 'unreviewed').message, / · filter: unreviewed$/);
});

test('the next unreviewed row starts at the top, then follows display order', () => {
  const { rows, row, ticked, isReviewed } = walkRows();
  const next = (after, filter = 'all') => model.findNextUnreviewed(rows, { after, isReviewed, filter });
  assert.equal(next(null), row('a.js', 'bad'));
  assert.equal(next(row('a.js', 'bad')), row('a.js', 'mid'));
  assert.equal(next(row('a.js', 'Outside functions')), row('b.js', 'unk'), 'across a file boundary');
  assert.equal(next(row('c.js', 'q')), row('n.md'), 'a file without a call graph is a row to visit');
  ticked.add(row('a.js', 'mid'));
  assert.equal(next(row('a.js', 'bad')), row('a.js', 'low'), 'ticked rows are skipped');
});

test('the walk wraps around once, and ends at the starting row when it is the only one left', () => {
  const { rows, row, ticked, isReviewed } = walkRows();
  const next = (after, filter = 'all') => model.findNextUnreviewed(rows, { after, isReviewed, filter });
  assert.equal(next(row('n.md')), row('a.js', 'bad'), 'after the last row it goes back to the first');
  ticked.add(row('a.js', 'bad'));
  assert.equal(next(row('n.md')), row('a.js', 'mid'));
  for (const f of rows) for (const r of f.rows || [f]) if (r !== row('c.js', 'q')) ticked.add(r);
  assert.equal(next(row('c.js', 'q')), row('c.js', 'q'), 'the only one left, even though it is the starting row');
  assert.equal(next(row('n.md')), row('c.js', 'q'));
});

test('nothing left is null, for every filter, starting anywhere', () => {
  const { rows, row, ticked, isReviewed } = walkRows();
  for (const f of rows) for (const r of f.rows || [f]) ticked.add(r);
  for (const filter of ['all', 'attention', 'unreviewed']) {
    assert.equal(model.findNextUnreviewed(rows, { after: null, isReviewed, filter }), null, filter);
    assert.equal(model.findNextUnreviewed(rows, { after: row('b.js', 'unk'), isReviewed, filter }), null, filter);
  }
  assert.equal(model.findNextUnreviewed([], { after: null, isReviewed, filter: 'all' }), null);
});

test('a file row stands just before its own rows, and a file without a call graph after itself', () => {
  const { rows, row, isReviewed } = walkRows();
  const next = (after) => model.findNextUnreviewed(rows, { after, isReviewed, filter: 'all' });
  assert.equal(next(rows[0]), row('a.js', 'bad'), 'selecting a file goes to its first row');
  assert.equal(next(rows[1]), row('b.js', 'unk'));
  assert.equal(next(row('n.md')), row('a.js', 'bad'));
});

test('with a filter the walk visits only the rows it shows, and starts from a hidden row\'s place', () => {
  const { rows, row, ticked, isReviewed } = walkRows();
  const next = (after, filter) => model.findNextUnreviewed(rows, { after, isReviewed, filter });
  assert.equal(next(row('a.js', 'bad'), 'attention'), row('b.js', 'unk'), 'mid and low are hidden');
  assert.equal(next(row('b.js', 'unk'), 'attention'), row('a.js', 'bad'), 'and it wraps to the first shown');
  assert.equal(next(row('a.js', 'mid'), 'attention'), row('b.js', 'unk'), 'a hidden selection starts from its own place');
  assert.equal(next(row('c.js', 'q'), 'attention'), row('a.js', 'bad'), 'its whole file is hidden: nothing after it, so it wraps');
  ticked.add(row('a.js', 'low'));
  assert.equal(next(row('a.js', 'mid'), 'unreviewed'), row('a.js', 'Outside functions'));
  ticked.add(row('b.js', 'unk'));
  assert.equal(next(row('b.js', 'unk'), 'unreviewed'), row('c.js', 'q'), 'a ticked selection is hidden by the filter but still marks the place');
});

test('a row that is not among the file rows, such as a caller, starts the walk at the top', () => {
  const { rows, row, isReviewed } = walkRows();
  const result = resultOf({ allChanged: [reaches('a.js', 'mid')] });
  const [under] = model.buildImpactRows(build(result).rows[0].rows[0], { result, uriOf }).rows;
  assert.equal(under.type, 'caller');
  assert.equal(model.findNextUnreviewed(rows, { after: under, isReviewed, filter: 'all' }), row('a.js', 'bad'));
});

test('tree item ids exist for file and counting rows only, and are unique in the tree', () => {
  const result = resultOf({
    allChanged: [stale1('a.js', 'bad'), reaches('a.js', 'mid'), change('d.js', 'twin', { startLine: 10 }), change('d.js', 'twin', { startLine: 40 }),
      change('e.js', 'twin', { startLine: 10 })],
    deleted: [deleted('a.js', 'gone', 5), deleted('e.js', 'gone', 5)],
    outside: [outside('a.js', [[1, 2]]), outside('e.js', [[1, 1]])], otherFiles: [{ path: 'n.md', status: 'added' }],
  });
  const { rows } = build(result);
  const ids = [];
  for (const f of rows) {
    ids.push(model.treeItemId(f));
    for (const r of f.rows || []) {
      ids.push(model.treeItemId(r));
      if (r.type !== 'finding') continue;
      for (const under of model.buildImpactRows(r, { result, uriOf }).rows) assert.equal(model.treeItemId(under), undefined, `${under.type} row has no id`);
    }
  }
  assert.equal(ids.length, 13);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), ids.join('\n'));
  assert.equal(new Set(ids).size, ids.length, 'unique');
  assert.equal(model.treeItemId({ type: 'caller', label: 'x', file: '/r/x', pos: 1 }), undefined);
  assert.equal(model.treeItemId({ type: 'message', label: 'x' }), undefined);
});

// ---- review identity --------------------------------------------------------------------
test('review ids of the new rows equal the ids the old tree gives the same symbols', async () => {
  const vscode = require('./vscode-stub');
  const store = new Map();
  const { createReviewState } = require('../src/review-state');
  const { createReviewIdentity } = require('../src/review-identity');
  const { createTreeProvider } = require('../src/tree-provider');
  const { ts, root } = require('./bug-regressions-helpers');
  const base = "import { a } from './a';\nexport function target() { return 0; }\nexport function gone() { return 1; }\n";
  const head = "import { b } from './a';\nexport function target() { return 1; }\n";
  const review = createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
  review.configure('identity', createReviewIdentity(ts, root, {
    headText: (p) => (p === 'a.ts' ? head : null), baseText: (p) => (p === 'a.ts' ? base : null), fileRevision: (p) => `rev:${p}`,
  }));
  const file = `${root}/a.ts`;
  const target = { file, relPath: 'a.ts', label: 'target', namePos: head.indexOf('target'), startLine: 2, endLine: 2, kinds: [BODY],
    staleCallers: 0, callerState: 'none', callers: [], score: 1, testState: 'uncovered', tests: [], throwsAdded: [], component: '(root)' };
  const result = {
    allChanged: [target], findings: [], deleted: [{ label: 'gone', key: 'gone', relPath: 'a.ts', file, namePos: base.indexOf('gone'), startLine: 3 }],
    outside: [{ file, relPath: 'a.ts', ranges: [[1, 1]] }], otherFiles: [{ path: 'docs/n.md', status: 'added' }], untested: [target], testUnknown: [],
    warnings: [], unanalysable: [], testReachComputed: true, mode: 'branch', base: { ref: 'main', sha: 'abcdef0123' }, changedFileCount: 2,
    fileStatus: { 'a.ts': 'modified', 'docs/n.md': 'added' },
  };
  // The ids the section tree gave these rows (its flat layout), recorded before it was
  // removed: a tick stored then must be the same tick now.
  const OLD_IDS = {
    finding: 'finding:root>a.ts#target:390e0a3aa46d475e227507bf3cc83d07fb66081f5f6c9ce0044cdc608f1ea576:6e63f5de721da97c9082bf5ce3e20037a76f506c09eb0cd923f62ec6d5e08fb8',
    outside: 'outside:root>a.ts#outside:7a38a50dc9bc3596f9806e0f16115d72241cba59081e953247ebe3d81cbdcdb5:2fed4012c3db96cb47728da2271057af44c0537729dee4a26f8f3c07c1a2c173',
    deleted: 'deleted:root>deleted:a.ts#gone:31fd2c28036288b007e8beaa73cc3d4be8c1dd6c51d396090d2c0775f8bd5abc',
    file: 'file:root>file:docs/n.md:rev:docs/n.md',
  };
  const { rows } = model.buildFileRows(result, { uriOf, absPath: (p) => `${root}/${p}` });
  const fresh = Object.fromEntries(model.collectCountingRows(rows).map((r) => [r.type, r]));
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(OLD_IDS).sort());
  for (const type of Object.keys(OLD_IDS)) assert.equal(review.id(fresh[type]), OLD_IDS[type], type);
  // and the provider shows the stored ticks on the rows it builds
  for (const id of Object.values(OLD_IDS)) review.set(id, true);
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rel: (f) => f.replace(`${root}/`, ''), absPath: (p) => `${root}/${p}` }), resolver: {}, review,
  });
  const shown = [];
  for (const top of await provider.getChildren()) shown.push(top, ...(top.type === 'reviewFile' ? await provider.getChildren(top) : []));
  assert.deepEqual(shown.map((r) => [r.type, provider.getTreeItem(r).checkboxState]),
    [['reviewFile', 1], ['deleted', 1], ['finding', 1], ['outside', 1], ['file', 1]]);
});
