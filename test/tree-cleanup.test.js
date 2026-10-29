'use strict';
// The tree clean-up (P1): icons, decorations, descriptions, the summary and the gap after
// an open file group, through the provider and the vscode stub. Each test names one item.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/views/changes/tree-provider');
const { renderTreeItem } = require('../src/views/changes/tree-item-renderer');
const { createReviewState } = require('../src/session/review-state');
const { createDecorationProvider } = require('../src/diff-editor/decorations');
const model = require('../src/views/changes/review-tree-model');

const BODY = { id: 'body', label: 'body' };
const SIG = { id: 'sig', label: 'signature', short: 'sig' };
const NO_SITES = { updated: [], untouched: [], unknown: [] };

const callerOf = (relPath, label, pos) => {
  const sites = [{ start: pos + 1, end: pos + 4 }];
  return { file: `/r/${relPath}`, pos, label, test: false, callSites: sites, sites: 1, callSiteUpdates: { ...NO_SITES, untouched: sites } };
};
const change = (relPath, label, startLine, extra = {}) => ({
  file: `/r/${relPath}`, relPath, label, namePos: startLine * 10, startLine, endLine: startLine + 3, component: '(root)',
  kinds: [BODY], throwsAdded: [], stale: [], staleCallers: 0, callerState: 'none', callers: [], score: 1,
  testState: 'covered', tests: ['spec'], ...extra,
});
// a signature change whose one caller was not updated: level 0, needs attention
const stale = (relPath, label, startLine, extra = {}) => {
  const c = callerOf('src/user.ts', 'user', startLine * 7);
  return change(relPath, label, startLine, { kinds: [SIG], callerState: 'resolved', callers: [c], staleCallers: 1, stale: [{ label: c.label }], ...extra });
};
const resultOf = (extra = {}) => ({
  allChanged: [], findings: [], deleted: [], outside: [], otherFiles: [], warnings: [], unanalysable: [], untested: [], testUnknown: [],
  testReachComputed: true, reachDepth: 2, mode: 'branch', requestedMode: 'branch', base: { ref: 'origin/main', sha: '0123456789' },
  changedFileCount: 1, fileStatus: {}, ...extra,
});

function viewOf(result, { state = {}, review = null } = {}) {
  const decorated = [];
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}`, ...state }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review,
    decorate: { register: (uri, d) => decorated.push({ uri: uri.toString(), ...d }), flush() {} },
  });
  const files = async () => (await provider.getChildren()).filter((r) => r.type === 'reviewFile' || r.type === 'file');
  const fileAt = async (relPath) => (await files()).find((f) => f.relPath === relPath);
  return { provider, decorated, files, fileAt, item: (row) => provider.getTreeItem(row) };
}
const memoryReview = () => {
  const store = new Map();
  return createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
};
const withoutSpacer = (rows) => rows.filter((r) => r.type !== 'spacer');

// ---- 1. icons --------------------------------------------------------------------------
const renderWith = (iconMode, row) => renderTreeItem(vscode, row, { rowDetail: 'hover', iconMode, checkedOf: () => null });

test('change rows take a symbol-kind icon in symbol mode and the file glyph in file mode', () => {
  const row = (label, f) => ({ type: 'finding', label, name: label, finding: change('src/a.ts', label, 1, f), file: '/r/src/a.ts', pos: 1 });
  const icon = (mode, r) => renderWith(mode, r).iconPath.id;
  assert.equal(icon('symbol', row('run', {})), 'symbol-function');
  assert.equal(icon('symbol', row('Store.save', {})), 'symbol-method');
  assert.equal(icon('symbol', row('Store', { isConstructor: true })), 'symbol-constructor');
  assert.equal(icon('symbol', row('READY', { valueLike: true })), 'symbol-variable');
  assert.equal(icon('file', row('run', {})), vscode.ThemeIcon.File.id);
});

test('outside rows are a namespace and deleted rows a trash can, in either mode', () => {
  const outside = { type: 'outside', label: 'Outside functions', relPath: 'a.ts', ranges: [[1, 2]], desc: 'lines 1–2', status: 'modified' };
  const deleted = { type: 'deleted', label: 'gone', name: 'gone', relPath: 'a.ts', file: '/r/a.ts', key: 'gone' };
  for (const mode of ['symbol', 'file']) {
    assert.equal(renderWith(mode, outside).iconPath.id, 'symbol-namespace');
    assert.equal(renderWith(mode, deleted).iconPath.id, 'trash');
  }
});

test('file rows and caller-file rows keep the file icon in symbol mode', async () => {
  const bad = stale('src/a.ts', 'bad', 10, { callers: [callerOf('src/user.ts', 'one', 5), callerOf('src/user.ts', 'two', 9)], staleCallers: 2 });
  const { provider, files, fileAt } = viewOf(resultOf({
    allChanged: [bad], otherFiles: [{ path: 'notes.md', status: 'added' }], fileStatus: { 'src/a.ts': 'modified', 'notes.md': 'added' },
  }), { state: { iconMode: 'symbol' } });
  const a = await fileAt('src/a.ts');
  assert.equal(provider.getTreeItem(a).iconPath.id, vscode.ThemeIcon.File.id);
  const notes = (await files()).find((f) => f.type === 'file');
  assert.equal(provider.getTreeItem(notes).iconPath ?? vscode.ThemeIcon.File, vscode.ThemeIcon.File, 'a file without a call graph takes the theme icon');
  const [change1] = await provider.getChildren(a);
  assert.equal(provider.getTreeItem(change1).iconPath.id, 'symbol-function');
  const [callerFile] = await provider.getChildren(change1);
  assert.equal(callerFile.type, 'callerFile');
  assert.equal(provider.getTreeItem(callerFile).iconPath.id, vscode.ThemeIcon.File.id);
});

test('symbol icons are the default when the settings do not say', async () => {
  const { provider, fileAt } = viewOf(resultOf({ allChanged: [change('src/a.ts', 'run', 1)], fileStatus: { 'src/a.ts': 'modified' } }));
  const [row] = await provider.getChildren(await fileAt('src/a.ts'));
  assert.equal(provider.getTreeItem(row).iconPath.id, 'symbol-function');
});

test('the manifest defaults iconMode to symbol', () => {
  const setting = require('../package.json').contributes.configuration.properties['impactTree.iconMode'];
  assert.equal(setting.default, 'symbol');
  assert.deepEqual(setting.enum, ['file', 'symbol']);
});

// ---- 2. the status letter on every row, the colour on file rows only --------------------
test('the decoration provider can leave out the label colour and keep the badge and tooltip', () => {
  const decorate = createDecorationProvider(vscode);
  const tinted = vscode.Uri.file('/r/a.ts');
  const plain = vscode.Uri.file('/r/a.ts').with({ fragment: '10' });
  decorate.register(tinted, { status: 'modified', tooltip: 'a.ts' });
  decorate.register(plain, { status: 'modified', tooltip: 'a.ts:10', tint: false });
  const a = decorate.provideFileDecoration(tinted);
  const b = decorate.provideFileDecoration(plain);
  assert.equal(a.badge, 'M');
  assert.ok(a.color, 'a file row is coloured');
  assert.equal(b.badge, 'M');
  assert.equal(b.tooltip, 'Modified — a.ts:10');
  assert.equal(b.color, undefined, 'a change row keeps the letter only');
});

test('a change differing only in colour is a new decoration value, and an unchanged one publishes nothing', () => {
  const { EventEmitter } = require('node:events');
  const bus = new EventEmitter();
  const decorate = createDecorationProvider({ ...vscode, EventEmitter: class {
    constructor() { this.event = (listener) => { bus.on('fire', listener); return { dispose() {} }; }; }
    fire(uris) { bus.emit('fire', uris); }
    dispose() {}
  } });
  const fired = [];
  decorate.onDidChangeFileDecorations((uris) => fired.push(uris));
  const uri = vscode.Uri.file('/r/a.ts').with({ fragment: '1' });
  decorate.register(uri, { status: 'added', tooltip: 't', tint: false });
  decorate.flush();
  decorate.register(uri, { status: 'added', tooltip: 't', tint: false });
  decorate.flush();
  assert.equal(fired.length, 1);
  decorate.register(uri, { status: 'added', tooltip: 't' });
  decorate.flush();
  assert.equal(fired.length, 2, 'turning the colour on is a change');
});

test('the tree asks for the colour on file rows and not on change, outside, deleted and caller rows', async () => {
  const { provider, decorated, files, fileAt } = viewOf(resultOf({
    allChanged: [change('src/a.ts', 'run', 1)], deleted: [{ label: 'gone', key: 'gone', relPath: 'src/a.ts', file: '/r/src/a.ts', namePos: 400, startLine: 40 }],
    outside: [{ file: '/r/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 2]] }], otherFiles: [{ path: 'notes.md', status: 'added' }],
    fileStatus: { 'src/a.ts': 'modified', 'notes.md': 'added' },
  }));
  await provider.getChildren();
  const tintOf = (suffix) => decorated.filter((d) => d.uri.endsWith(suffix)).map((d) => d.tint ?? true);
  assert.deepEqual(tintOf('/r/src/a.ts'), [true], 'only the file row decorates the bare file URI, with the colour');
  assert.deepEqual(tintOf('/r/src/a.ts#outside'), [false], 'the outside row has its own URI, untinted');
  assert.deepEqual(tintOf('/r/src/a.ts#10'), [false], 'the change row');
  assert.deepEqual(tintOf('/r/src/a.ts#400'), [false], 'the deleted row');
  assert.deepEqual(tintOf('/r/notes.md'), [true], 'a file without a call graph');
  assert.equal((await files()).length, 2);
  await fileAt('src/a.ts');
});

test('a caller row keeps its badge but not the colour of its changed file', async () => {
  const { provider, decorated, fileAt } = viewOf(resultOf({
    allChanged: [stale('src/a.ts', 'bad', 10)], fileStatus: { 'src/a.ts': 'modified', 'src/user.ts': 'modified' },
  }));
  const [finding] = (await provider.getChildren(await fileAt('src/a.ts'))).filter((r) => r.type === 'finding');
  await provider.getChildren(finding);
  const caller = decorated.filter((d) => d.uri.endsWith('/r/src/user.ts#70'));
  assert.deepEqual(caller.map((d) => [d.status, d.tint]), [['modified', false]]);
});

// ---- 3. the folder, last and one segment ------------------------------------------------
test('a file row reads attention, progress, then the last folder segment; the path stays in the tooltip', async () => {
  const { fileAt, item } = viewOf(resultOf({
    allChanged: [stale('src/deep/a.ts', 'bad', 10), change('src/deep/a.ts', 'ok', 30), change('root.ts', 'top', 1)],
    fileStatus: { 'src/deep/a.ts': 'modified', 'root.ts': 'modified' },
  }));
  const a = await fileAt('src/deep/a.ts');
  assert.equal(item(a).description, '1 needs attention  ·  0/2  ·  deep');
  assert.match(item(a).tooltip.value, /src\/\n└─ deep\/\n   └─ a\.ts/, 'the path, drawn as a folder tree');
  assert.equal(item(await fileAt('root.ts')).description, '0/1', 'no folder at the repo root');
});

test('a file without a call graph reads "no call graph", then the last folder segment', async () => {
  const { fileAt, item } = viewOf(resultOf({
    otherFiles: [{ path: 'docs/sub/guide.md', status: 'added' }, { path: 'README.md', status: 'modified' }],
    fileStatus: { 'docs/sub/guide.md': 'added', 'README.md': 'modified' },
  }));
  const guide = item(await fileAt('docs/sub/guide.md'));
  assert.equal(guide.description, 'no call graph  ·  sub');
  assert.match(guide.tooltip.value, /docs\/\n└─ sub\/\n   └─ guide\.md/, 'the path, drawn as a folder tree');
  assert.equal(item(await fileAt('README.md')).description, 'no call graph');
});

// ---- 4. "in Container" only when it tells changes apart ---------------------------------
const descriptions = async (view, relPath) => {
  const rows = withoutSpacer(await view.provider.getChildren(await view.fileAt(relPath)));
  return Object.fromEntries(rows.map((r) => [view.item(r).label, view.item(r).description]));
};

test('a file whose changes sit in several containers names them; a single-container file does not', async () => {
  const mixed = viewOf(resultOf({
    allChanged: [change('src/github.js', 'Client.get', 10, { className: 'Client' }), change('src/github.js', 'Pool.size', 20, { className: 'Pool' }),
      change('src/github.js', 'request', 40)],
    fileStatus: { 'src/github.js': 'modified' },
  }));
  const named = await descriptions(mixed, 'src/github.js');
  assert.match(named.get, /^in Client/);
  assert.match(named.size, /^in Pool/);
  assert.doesNotMatch(named.request, /\bin\b/, 'the top level is a container of its own and needs no name');

  const single = viewOf(resultOf({
    allChanged: [change('src/store.js', 'Store.save', 10, { className: 'Store' }), change('src/store.js', 'Store.load', 20, { className: 'Store' })],
    fileStatus: { 'src/store.js': 'modified' },
  }));
  const bare = await descriptions(single, 'src/store.js');
  assert.deepEqual(Object.keys(bare), ['save', 'load']);
  for (const text of Object.values(bare)) assert.doesNotMatch(text, /\bin\b/);
});

test('a file with one nested container and a top-level function names the container', async () => {
  const view = viewOf(resultOf({
    allChanged: [change('src/a.js', 'Store.save', 10, { className: 'Store' }), change('src/a.js', 'helper', 20)],
    fileStatus: { 'src/a.js': 'modified' },
  }));
  const named = await descriptions(view, 'src/a.js');
  assert.match(named.save, /^in Store/);
  assert.doesNotMatch(named.helper, /\bin\b/);
});

test('an ambiguous name still names its container in a single-container file', async () => {
  const view = viewOf(resultOf({
    allChanged: [change('src/a.js', 'Store.save', 10, { className: 'Store' }), change('src/b.js', 'Store.save', 10, { className: 'Store', component: 'api' })],
    fileStatus: { 'src/a.js': 'modified', 'src/b.js': 'modified' },
  }));
  const [text] = Object.values(await descriptions(view, 'src/a.js'));
  assert.match(text, /^in Store/);
});

test('a deleted row follows the same container rule', async () => {
  const gone = (label, relPath) => ({ label, key: label, relPath, file: `/r/${relPath}`, namePos: 5, startLine: 5 });
  const mixed = viewOf(resultOf({
    allChanged: [change('src/a.js', 'Store.save', 10, { className: 'Store' }), change('src/a.js', 'helper', 20)],
    deleted: [gone('Store.old', 'src/a.js')], fileStatus: { 'src/a.js': 'modified' },
  }));
  assert.match((await descriptions(mixed, 'src/a.js')).old, /^in Store/);
  const single = viewOf(resultOf({
    allChanged: [change('src/b.js', 'Store.save', 10, { className: 'Store' })],
    deleted: [gone('Store.old', 'src/b.js')], fileStatus: { 'src/b.js': 'modified' },
  }));
  assert.doesNotMatch((await descriptions(single, 'src/b.js')).old, /\bin\b/);
});

// ---- 5. the state in words, in both detail modes ------------------------------------------
test('in either detail mode a row says its state in words; inline adds the change kinds', async () => {
  const result = resultOf({
    allChanged: [stale('src/a.ts', 'bad', 10), change('src/a.ts', 'quiet', 30)], fileStatus: { 'src/a.ts': 'modified' },
    deleted: [{ label: 'gone', key: 'gone', relPath: 'src/a.ts', file: '/r/src/a.ts', namePos: 400, startLine: 40 }],
  });
  const text = await descriptions(viewOf(result), 'src/a.ts');
  assert.match(text.bad, /^1 of 1 caller not updated/);
  assert.match(text.gone, /^deleted/);
  assert.equal(text.quiet, 'no callers');
  const inline = await descriptions(viewOf(result, { state: { rowDetail: 'inline' } }), 'src/a.ts');
  assert.match(inline.quiet, /^no callers/);
  assert.match(inline.bad, /^1 of 1 caller not updated/);
});

// ---- 6. the one-line summary -------------------------------------------------------------
test('the summary reads PR or mode, the attention count, what is left and the filter', () => {
  const counts = { total: 5, left: 3, attention: 2 };
  const result = resultOf({ base: { ref: 'origin/main', sha: 'abc' } });
  assert.equal(model.buildReviewSummary(result, { kind: 'pr', pr: { number: 15 } }, counts).message, 'PR #15 · 2 need attention · 3 of 5 left');
  assert.equal(model.buildReviewSummary(result, { kind: 'local' }, counts).message, 'Branch + uncommitted · 2 need attention · 3 of 5 left');
  assert.equal(model.buildReviewSummary(result, { kind: 'pr', pr: { number: 15 } }, counts, 'attention').message,
    'PR #15 · 2 need attention · 3 of 5 left · filter: needs attention');
  assert.equal(model.buildReviewSummary(result, null, counts, 'unreviewed').message, 'Branch + uncommitted · 2 need attention · 3 of 5 left · filter: unreviewed');
  assert.doesNotMatch(model.buildReviewSummary(result, null, counts).message, /origin\/main/, 'the base is not named');
});

// ---- 7. the gap after an open file group ---------------------------------------------------
const sampleResult = () => resultOf({
  allChanged: [stale('src/a.ts', 'bad', 10), change('src/a.ts', 'quiet', 30), change('src/b.ts', 'other', 5)],
  fileStatus: { 'src/a.ts': 'modified', 'src/b.ts': 'modified' },
});

test('an expanded file ends with one inert spacer row', async () => {
  const { provider, fileAt, item } = viewOf(sampleResult(), { review: memoryReview() });
  const a = await fileAt('src/a.ts');
  const children = await provider.getChildren(a);
  assert.deepEqual(children.map((r) => r.type), ['finding', 'finding', 'spacer']);
  const spacer = children.at(-1);
  const rendered = item(spacer);
  assert.equal(rendered.label, '');
  assert.equal(rendered.iconPath, undefined);
  assert.equal(rendered.checkboxState, undefined);
  assert.equal(rendered.command, undefined);
  assert.equal(rendered.tooltip, undefined);
  assert.equal(rendered.contextValue, 'spacer');
  assert.equal(rendered.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.equal(rendered.id, 'spacer:src/a.ts');
  assert.equal(provider.getParent(spacer), a);
  assert.deepEqual(await provider.getChildren(spacer), []);
  const bSpacer = (await provider.getChildren(await fileAt('src/b.ts'))).at(-1);
  assert.notEqual(item(bSpacer).id, rendered.id, 'each file has its own');
});

test('the spacer id is stable across reads and ticks, and a ticked file keeps its one spacer', async () => {
  const { provider, fileAt, item } = viewOf(sampleResult(), { review: memoryReview() });
  const a = await fileAt('src/a.ts');
  const before = item((await provider.getChildren(a)).at(-1)).id;
  provider.setChecked(a, true);
  const after = await provider.getChildren(a);
  assert.equal(after.filter((r) => r.type === 'spacer').length, 1);
  assert.equal(item(after.at(-1)).id, before);
});

test('a filter that hides all of a file gives it no spacer; a file with visible rows keeps one', async () => {
  const { provider, fileAt } = viewOf(sampleResult(), { review: memoryReview() });
  provider.toggleFilter('unreviewed');
  const a = await fileAt('src/a.ts');
  const b = await fileAt('src/b.ts');
  provider.setChecked((await provider.getChildren(b))[0], true);
  assert.deepEqual((await provider.getChildren(a)).map((r) => r.type), ['finding', 'finding', 'spacer']);
  assert.deepEqual(await provider.getChildren(b), [], 'every row of b is reviewed: no children, so no spacer');
  provider.toggleFilter('unreviewed');
  provider.toggleFilter('attention');
  assert.deepEqual((await provider.getChildren(a)).map((r) => r.type), ['finding', 'spacer'], 'only the row that needs attention, then the gap');
  assert.deepEqual(await provider.getChildren(b), [], 'b has nothing that needs attention');
});

test('the spacer is not a counting row, and counts, line lookup and next-unreviewed ignore it', async () => {
  const { provider, files, fileAt } = viewOf(sampleResult(), { review: memoryReview() });
  const rows = await files();
  const spacer = model.buildSpacerRow(rows[0]);
  assert.deepEqual(model.collectCountingRows(rows).filter((r) => r.type === 'spacer'), []);
  assert.deepEqual(model.collectTickTargets(spacer), [], 'it has no checkbox to stand for');
  assert.deepEqual(provider.reviewCounts(), { total: 3, left: 3, attention: 1 });
  assert.equal(provider.rowAtLine('src/a.ts', 31)?.type, 'finding');
  assert.equal(provider.rowAtLine('src/a.ts', 500)?.type, 'reviewFile', 'a line in no change is the file, never its spacer');
  assert.equal(provider.rowById('spacer:src/a.ts'), null);
  await fileAt('src/a.ts');
  // walk the whole review: no row it lands on is a spacer
  const seen = [];
  for (let next = provider.nextUnreviewed(null); next && seen.length < 10; next = provider.nextUnreviewed(next)) {
    seen.push(next.type);
    provider.setChecked(next, true);
  }
  assert.deepEqual(seen, ['finding', 'finding', 'finding']);
  assert.equal(provider.nextUnreviewed(null), null, 'nothing is left');
});

// ---- 7. fewer states (P2): three colours in the tree, the exact state in words ------------
const { stateNameOf, classifyChangeVerdict } = require('../src/views/changes/tree-row-models');
const STATE_GLYPHS = /[⛔✓●∅△○?−≡🧪↑]/u;
const ERROR = 'list.errorForeground';
const WARNING = 'list.warningForeground';
const renderRow = (iconMode, row, rowDetail = 'hover') => renderTreeItem(vscode, row, { rowDetail, iconMode, checkedOf: () => null });
const findingRow = (label, f) => ({ type: 'finding', label, name: label, finding: change('src/a.ts', label, 1, f), file: '/r/src/a.ts', pos: 1 });
const callerRow = (callState, extra = {}) => ({ type: 'caller', label: 'user', relPath: 'src/u.ts', file: '/r/src/u.ts', pos: 1, sites: 1,
  test: false, cycle: false, changed: false, callState, callSiteUpdates: NO_SITES, ...extra });
const updatedCaller = { ...callerOf('src/u.ts', 'u', 3), callState: 'updated-at-call' };

// one representative row per verdict level: [name, row, icon colour, description start, icon in file mode]
const LEVEL_ROWS = [
  ['level 0', findingRow('l0', { kinds: [SIG], callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 3)], staleCallers: 1 }), ERROR, '1 of 1 caller not updated', 'error'],
  ['level 1', findingRow('l1', { kinds: [SIG], callerState: 'unknown' }), WARNING, 'callers unknown', 'warning'],
  ['level 1, DI', findingRow('l1di', { kinds: [SIG], callerState: 'di' }), WARNING, 'DI-constructed', 'warning'],
  ['level 2', findingRow('l2', { kinds: [SIG], callerState: 'resolved', callers: [updatedCaller] }), undefined, 'all callers updated', null],
  ['level 3', findingRow('l3', { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 3)] }), undefined, 'reaches 1 caller', null],
  ['level 4', findingRow('l4', {}), undefined, 'no callers', null],
];

test('each verdict level colours the icon red, amber or not at all, and says its state in words', () => {
  for (const [name, row, color, words, fileIcon] of LEVEL_ROWS) {
    for (const rowDetail of ['hover', 'inline']) {
      const sym = renderRow('symbol', row, rowDetail);
      assert.equal(sym.iconPath.color && sym.iconPath.color.id, color, `${name}: symbol icon colour`);
      assert.match(sym.iconPath.id, /^symbol-/, `${name}: the symbol-kind icon is kept`);
      assert.ok(sym.description.startsWith(words), `${name} (${rowDetail}): ${sym.description}`);
      assert.doesNotMatch(sym.description, STATE_GLYPHS, `${name}: no glyph token in the description`);
      assert.doesNotMatch(sym.tooltip.value.split('\n')[0], STATE_GLYPHS, `${name}: none in the tooltip header`);
    }
    const file = renderRow('file', row);
    if (fileIcon) {
      assert.deepEqual([file.iconPath.id, file.iconPath.color.id], [fileIcon, color], `${name}: file mode swaps in a coloured icon`);
    } else assert.equal(file.iconPath, vscode.ThemeIcon.File, `${name}: a fine row keeps ThemeIcon.File`);
  }
});

test('a level-1 state is never uncoloured, in either icon mode', () => {
  for (const state of ['unknown', 'di']) {
    const row = findingRow('u', { kinds: [SIG], callerState: state });
    for (const mode of ['symbol', 'file']) assert.equal(renderRow(mode, row).iconPath.color.id, WARNING, `${state} in ${mode} mode`);
  }
  const incomplete = findingRow('p', { kinds: [SIG], callerState: 'resolved', callersComplete: false, callers: [updatedCaller] });
  assert.equal(renderRow('symbol', incomplete).iconPath.color.id, WARNING, 'updated callers with a search that did not finish');
  // A body-only change keeps level 3 for ordering, but an unknown must not read as fine.
  for (const state of ['unknown', 'di']) {
    const body = findingRow('b', { callerState: state });
    for (const mode of ['symbol', 'file']) assert.equal(renderRow(mode, body).iconPath.color.id, WARNING, `body-only, ${state} in ${mode} mode`);
    assert.equal(stateNameOf(body, classifyChangeVerdict(body.finding)), 'Callers unknown', `body-only, ${state}: Details heading`);
  }
});

test('a deleted row keeps the trash icon in amber; an outside row is uncoloured', () => {
  const deleted = { type: 'deleted', label: 'Store.old', name: 'old', key: 'k', relPath: 'src/a.ts', file: '/r/src/a.ts' };
  for (const mode of ['symbol', 'file']) {
    const item = renderRow(mode, deleted);
    assert.deepEqual([item.iconPath.id, item.iconPath.color.id, item.description], ['trash', WARNING, 'deleted'], mode);
    assert.doesNotMatch(item.tooltip.value.split('\n')[0], STATE_GLYPHS);
  }
  const outside = renderRow('symbol', { type: 'outside', label: 'Outside functions', relPath: 'src/a.ts', file: '/r/src/a.ts', ranges: [[1, 4]], desc: 'lines 1–4' });
  assert.equal(outside.iconPath.color, undefined);
  assert.equal(outside.description, 'lines 1–4');
});

test('caller rows say the call state in words; only a caller changed elsewhere is amber', () => {
  const cases = [['updated-at-call', 'call updated', undefined], ['unchanged', 'not changed', undefined], ['changed-elsewhere', 'changed, but not at the call', WARNING]];
  for (const [callState, words, color] of cases) {
    for (const mode of ['symbol', 'file']) {
      const item = renderRow(mode, callerRow(callState));
      assert.equal(item.description, `${words}  ·  u.ts`, `${callState} (${mode})`);
      assert.equal(item.iconPath.color && item.iconPath.color.id, color, `${callState} (${mode}) colour`);
      assert.doesNotMatch(item.tooltip.value.split('\n')[0], STATE_GLYPHS);
    }
    const group = renderRow('symbol', { type: 'callerFile', label: 'u.ts', relPath: 'src/u.ts', callState, sites: 1, callers: [callerRow(callState)] });
    assert.ok(group.description.startsWith(words), group.description);
    assert.equal(group.iconPath.color && group.iconPath.color.id, color, `${callState}: caller-file colour`);
    assert.doesNotMatch(group.description + group.tooltip.value, STATE_GLYPHS);
  }
  const testCaller = renderRow('symbol', callerRow('unchanged', { test: true }));
  assert.deepEqual([testCaller.iconPath.id, testCaller.description.split('  ·  ')[0]], ['beaker', 'test']);
  const cycle = renderRow('symbol', callerRow('changed-elsewhere', { cycle: true }));
  assert.deepEqual([cycle.iconPath.id, cycle.description, cycle.iconPath.color], ['issue-reopened', 'already shown above', undefined]);
});

test('the legend explains the colours without glyph tokens, and the state names are frozen and distinct', () => {
  const { LEGEND, STATE_NAMES } = require('../src/views/changes/tree-row-models');
  const names = [...STATE_NAMES.levels, STATE_NAMES.deleted, STATE_NAMES.outside];
  const legendText = LEGEND.map(([, label, desc]) => `${label} ${desc}`).join('\n');
  assert.match(legendText, /Red icon — Callers not updated/);
  assert.match(legendText, /Amber icon/);
  assert.match(legendText, /No colour — Fine/);
  assert.doesNotMatch(legendText, STATE_GLYPHS);
  assert.ok(Object.isFrozen(STATE_NAMES) && Object.isFrozen(STATE_NAMES.levels));
  assert.equal(new Set(names).size, names.length, 'no two states share a name');
});
