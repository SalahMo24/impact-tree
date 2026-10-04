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

// The kinds of src/engine/signature.js, so a new kind there is covered by this table.
const { KIND } = require('../src/engine/signature');
const BODY = { id: 'body' };
const RISKY_KINDS = Object.values(KIND).filter((k) => k.id !== 'body');
const callersOf = (n, callState = 'unchanged') => Array.from({ length: n }, (_, i) => ({ label: `c${i}`, callState }));
const verdictOf = (extra) => models.classifyChangeVerdict({
  staleCallers: 0, callerState: 'resolved', kinds: [BODY], callers: callersOf(2), ...extra,
});

test('every risky kind and every caller outcome gets the level the review rules give it', () => {
  const table = [
    // [name, change, level, token, text]
    ['risky, one stale of three', { staleCallers: 1, callers: callersOf(3) }, 0, '⛔', '1 of 3 callers not updated'],
    ['risky, all stale', { staleCallers: 2, callers: callersOf(2) }, 0, '⛔', '2 of 2 callers not updated'],
    ['risky, stale and the search incomplete', { staleCallers: 1, callersComplete: false, callers: callersOf(1) }, 0, '⛔', '1 of 1 caller not updated — more may be missing'],
    ['risky, stale, one edited nearby', { staleCallers: 2, staleChangedElsewhere: 1, callers: callersOf(3) }, 0, '⛔', '2 of 3 callers not updated (1 edited nearby)'],
    ['risky, stale, edited nearby and incomplete', { staleCallers: 2, staleChangedElsewhere: 2, callersComplete: false, callers: callersOf(2) }, 0, '⛔', '2 of 2 callers not updated (2 edited nearby) — more may be missing'],
    ['risky, stale, none edited nearby', { staleCallers: 1, staleChangedElsewhere: 0, callers: callersOf(1) }, 0, '⛔', '1 of 1 caller not updated'],
    ['risky, search incomplete', { callersComplete: false, callers: callersOf(1, 'updated-at-call') }, 1, '?', 'callers unknown'],
    ['risky, callers unknown', { callerState: 'unknown', callers: [] }, 1, '?', 'callers unknown'],
    ['risky, a state the result does not define', { callerState: undefined, callers: [] }, 1, '?', 'callers unknown'],
    ['risky, DI-built', { callerState: 'di', callers: [] }, 1, '?', 'DI-constructed'],
    ['risky, all callers updated', { callers: callersOf(2, 'updated-at-call') }, 2, '✓', 'all callers updated'],
    ['risky, no callers', { callerState: 'none', callers: [] }, 2, '✓', 'no callers'],
    ['risky, old result without callersComplete', { callers: callersOf(1, 'updated-at-call'), callersComplete: undefined }, 2, '✓', 'all callers updated'],
  ];
  for (const kind of RISKY_KINDS) {
    for (const [name, extra, level, token, text] of table) {
      const v = verdictOf({ kinds: [BODY, kind], ...extra });
      assert.deepEqual([v.level, v.token, v.text], [level, token, text], `${kind.id}: ${name}`);
      assert.ok(v.sentence.includes(kind.label), `${kind.id}: ${name}: the sentence names the kind`);
    }
  }
});

test('a body-only change is never needs-attention, however many callers were left alone', () => {
  const table = [
    ['callers, none touched', { staleCallers: 2, callers: callersOf(2) }, 3, '●', 'reaches 2 callers'],
    ['one caller', { staleCallers: 1, callers: callersOf(1) }, 3, '●', 'reaches 1 caller'],
    ['callers, search incomplete', { callersComplete: false, callers: callersOf(1) }, 3, '●', 'reaches 1 caller'],
    ['callers unknown', { callerState: 'unknown', callers: [] }, 3, '?', 'callers unknown'],
    ['incomplete and nothing found', { callerState: 'none', callersComplete: false, callers: [] }, 3, '?', 'callers unknown'],
    ['a state the result does not define', { callerState: 'anything', callers: [] }, 3, '?', 'callers unknown'],
    ['DI-built', { callerState: 'di', callers: [] }, 3, '?', 'DI-constructed'],
    ['no callers', { callerState: 'none', callers: [] }, 4, '∅', 'no callers'],
  ];
  for (const [name, extra, level, token, text] of table) {
    const v = verdictOf(extra);
    assert.deepEqual([v.level, v.token, v.text], [level, token, text], name);
  }
});

test('the sentence keeps the facts the row cannot: stale count, missing callers, why unknown', () => {
  const kinds = [BODY, KIND.NEW_THROW];
  assert.match(verdictOf({ kinds, staleCallers: 1, callers: callersOf(3) }).sentence, /1 of 3 callers? was not changed on the call line/);
  assert.match(verdictOf({ kinds, staleCallers: 2, callers: callersOf(3) }).sentence, /2 of 3 callers were not changed/);
  assert.match(verdictOf({ kinds, staleCallers: 1, callersComplete: false, callers: callersOf(1) }).sentence, /More callers may be missing/);
  assert.doesNotMatch(verdictOf({ kinds, staleCallers: 1, callers: callersOf(1) }).sentence, /may be missing/);
  assert.match(verdictOf({ callersComplete: false, callers: callersOf(2) }).sentence, /More callers may be missing/);
  assert.doesNotMatch(verdictOf({ callers: callersOf(2) }).sentence, /may be missing/);
  const unknown = (extra) => verdictOf({ kinds, callerState: 'unknown', callers: [], callersComplete: false, ...extra }).sentence;
  assert.match(unknown({ callersIncompleteReason: 'referenced-as-value' }), /passed around as a value/);
  assert.match(unknown({ callersIncompleteReason: 'query-failed' }), /the search reported "query-failed"/);
  assert.match(unknown({ callersIncompleteReason: undefined }), /did not say why/);
  assert.match(verdictOf({ kinds, callersComplete: false, callersIncompleteReason: 'referenced-as-value', callers: callersOf(1, 'updated-at-call') }).sentence,
    /callers found so far are updated, but more may be missing: it is passed around as a value/);
  assert.match(verdictOf({ kinds, callerState: 'di', callers: [] }).sentence, /DI container/);
});

test('deleted symbols and outside-functions rows have fixed verdicts', () => {
  assert.deepEqual(models.classifyDeletedVerdict(), { level: 1, token: '−', text: 'deleted', sentence: models.classifyDeletedVerdict().sentence });
  assert.match(models.classifyDeletedVerdict().sentence, /removed/);
  assert.match(models.classifyDeletedVerdict().sentence, /not searched/);
  assert.doesNotMatch(models.classifyDeletedVerdict().sentence, /nothing (in the analysed code )?(still )?calls|no(thing| one) (still )?call/i, 'it does not claim nothing calls it');
  const outside = models.classifyOutsideVerdict([[1, 4], [22, 22]]);
  assert.deepEqual([outside.level, outside.token, outside.text], [4, '≡', 'lines 1–4, 22']);
  assert.match(outside.sentence, /not inside any function/);
  assert.equal(models.classifyOutsideVerdict([[9.5, 9.5]]).text, 'deleted before line 10');
});

test('the worst verdict of several rows is the lowest level, the first on a tie', () => {
  const rowOf = (label, extra) => ({ type: 'finding', label, finding: change('a.ts', label, extra) });
  const rows = [rowOf('a', {}), rowOf('b', { callerState: 'unknown', kinds: [RISKY_KINDS[0]] }), rowOf('c', { callerState: 'none', callers: [] }), rowOf('d', { callerState: 'unknown', kinds: [RISKY_KINDS[1]] })];
  assert.deepEqual(models.classifyWorstRowVerdict(rows), models.classifyChangeVerdict(rows[1].finding));
  assert.equal(models.classifyWorstRowVerdict([{ type: 'outside', ranges: [[1, 1]] }, rows[2]]).level, 4);
  assert.equal(models.classifyWorstRowVerdict([{ type: 'outside', ranges: [[1, 1]] }, { type: 'deleted' }]).level, 1);
});

test('a row takes the verdict of what it holds, and a row without a symbol is not a change', () => {
  assert.equal(models.classifyRowVerdict({ type: 'finding', finding: change('a.ts', 'f', { callerState: 'unknown', kinds: [RISKY_KINDS[0]] }) }).level, 1);
  assert.equal(models.classifyRowVerdict({ type: 'outside', ranges: [[3, 3]] }).level, 4);
  assert.equal(models.classifyRowVerdict({ type: 'deleted' }).level, 1);
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

test('notice rows: the preview notice first, then one row per warning and per unanalysed component', () => {
  const local = models.buildNoticeRows(deepFreeze(resultOf({ warnings: ['w1', 'w2'], unanalysable: [{ count: 2, component: 'legacy' }] })));
  assert.deepEqual(local.map((r) => [r.type, r.icon, r.label]), [
    ['message', 'warning', 'w1'], ['message', 'warning', 'w2'], ['message', 'circle-slash', "2 file(s) in 'legacy' not analysed"],
  ]);
  const preview = models.buildNoticeRows(deepFreeze(resultOf({ tierA: true, changedFileCount: 4, warnings: ['w'] })));
  assert.deepEqual(preview.map((r) => r.label), ['Preview — PR files only (4 file(s))', 'w']);
  assert.match(preview[0].desc, /callers outside this PR are NOT shown/);
  assert.deepEqual(models.buildNoticeRows(resultOf()), []);
});

test('top-level change refs name only root changes', () => {
  const refs = models.collectTopLevelChangeRefs(resultOf({ allChanged: [change('a.ts', 'a'), change('a.ts', 'b', { isRoot: false })] }));
  assert.deepEqual(refs.map((r) => r.type), ['finding']);
  assert.equal(refs[0].file, '/r/a.ts');
});

test('change rows mark shared labels, carry reach notes, and ask for one decoration each', () => {
  const web = change('web/u.ts', 'helper', { testState: 'uncovered' });
  const api = change('api/u.ts', 'helper', { testState: 'covered' });
  const solo = change('s.ts', 'solo', { testState: 'unknown', testReachIncompleteReason: 'budget' });
  const bare = change('b.ts', 'bare', { testState: 'unknown' });
  const deferred = change('d.ts', 'deferred', { testState: 'not-computed' });
  const result = deepFreeze(resultOf({ allChanged: [web, api, solo, bare, deferred], fileStatus: { 'web/u.ts': 'modified' }, reachDepth: 3 }));
  const { rows, decorations } = models.buildChangeRows([solo, web, api, bare, deferred], { result, uriOf });
  assert.deepEqual(rows.map((r) => [r.label, r.ambiguous, r.reachReason, r.scopeNote]), [
    ['solo', false, 'budget', null],
    ['helper', true, null, 'no test within 3 caller level(s)'],
    ['helper', true, null, null],
    ['bare', false, 'the test search did not finish', null],
    ['deferred', false, null, null],
  ], 'only a finished walk gets the scope note; an unknown one always gets a reason');
  assert.equal(rows[1].finding, web);
  assert.equal(rows[1].decorationUri, `uri:/r/web/u.ts#${web.namePos}`);
  assert.deepEqual(decorations.slice(0, 2).map((d) => [d.status, d.tooltip]), [[undefined, `s.ts:${solo.startLine}`], ['modified', `web/u.ts:${web.startLine}`]]);
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
