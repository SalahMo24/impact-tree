'use strict';
// Characterization of the whole change tree: every row the provider returns, for a set of
// representative states, rendered through the vscode stub and compared with the output
// recorded in tree-characterization.expected.json before the provider was split. Any
// difference is a visible change. The states are small hand-made results, so no target
// repository is needed.
//
// Recording (only when the expected output is meant to change, which a refactor never is):
//   node test/tree-characterization.test.js --record
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');
const { createReviewState } = require('../src/review-state');

const EXPECTED = path.join(__dirname, 'tree-characterization.expected.json');
const MAX_DEPTH = 8;

// ---- results ---------------------------------------------------------------------------
const BODY = { id: 'body', label: 'body' };
// Callers consistent with the state: `resolved` means at least one was found.
const callersFor = (n) => Array.from({ length: n }, (_, i) => ({ file: '/repo/src/use.ts', pos: 1000 + i, label: `user${i}`, callState: 'unchanged' }));
const change = (relPath, label, namePos, extra = {}) => ({
  file: `/repo/${relPath}`, relPath, label, namePos, start: namePos, end: namePos + 10, startLine: namePos,
  component: '(root)', kinds: [BODY], throwsAdded: [], callers: (extra.callerState ?? 'resolved') === 'resolved' ? callersFor(1) : [],
  stale: [], staleCallers: 0, callerState: 'resolved', score: 1, ...extra,
});

function localResult() {
  const save = change('src/store.ts', 'Store.save', 10, {
    className: 'Store', score: 9, staleCallers: 2, staleChangedElsewhere: 1, stale: [{ label: 'useB' }, { label: 'main' }],
    kinds: [{ id: 'param', label: 'parameter', short: 'param' }, BODY], baseSig: 'save(a)', headSig: 'save(a, b)',
    throwsAdded: ['Error'], callers: [{ file: '/repo/src/use.ts', pos: 80, label: 'useB', callState: 'unchanged' }, { file: '/repo/src/app.ts', pos: 7, label: 'main', callState: 'changed-elsewhere' }],
  });
  const load = change('src/store.ts', 'Store.load', 50, {
    className: 'Store', callersComplete: false, callersIncompleteReason: 'query-failed',
    callers: [{ file: '/repo/src/use.ts', pos: 120, label: 'loader', callState: 'updated-at-call' }],
    kinds: [{ id: 'optional-param', label: 'optional param' }],
  });
  const webHelper = change('src/web/util.ts', 'helper', 5, { component: 'web', callerState: 'none', kinds: [{ id: 'sig', label: 'signature' }] });
  const apiHelper = change('src/api/util.ts', 'helper', 5, { component: 'api', callerState: 'di', kinds: [{ id: 'sig', label: 'signature' }] });
  const nestedFinding = change('src/store.ts', 'Store.inner', 70, { isRoot: false, callerState: 'unknown', kinds: [{ id: 'sig', label: 'signature' }] });
  const big = change('src/big.ts', 'Big', 1, {
    isConstructor: true, staleCallers: 11, callers: callersFor(11), kinds: [{ id: 'sig', label: 'signature' }],
    stale: Array.from({ length: 11 }, (_, i) => ({ label: `caller${i}` })),
  });
  const findings = [save, load, webHelper, apiHelper, nestedFinding, big];

  const factory = change('src/open.ts', 'createOpen', 100, { start: 100, end: 1000 });
  const inner = change('src/open.ts', 'createOpen.uriFor', 200, { start: 200, end: 300 });
  const sibling = change('src/open.ts', 'createOpen.same', 400, { start: 400, end: 500, callerState: 'unknown' });
  const sameUri = change('src/open.ts', 'sameUri', 1100, { start: 1100, end: 1200 });
  const lone = change('src/ready.ts', 'READY', 3, { valueLike: true });
  const nestedOther = change('src/ready.ts', 'readyInner', 30, { isRoot: false });
  const reachUnknown = change('src/reach.ts', 'deepWalk', 8, { testReachIncompleteReason: 'the walk budget of 120 callers ran out' });
  const reachBare = change('src/reach.ts', 'bareWalk', 20);
  const other = [factory, inner, sibling, sameUri, lone, nestedOther, reachUnknown, reachBare];

  return {
    allChanged: [...findings, ...other], findings,
    deleted: [{ label: 'gone', key: 'k-gone', relPath: 'src/old.ts', file: '/repo/src/old.ts', namePos: 3 },
      { label: 'Old.run', key: 'k-run', relPath: 'src/old.ts', file: '/repo/src/old.ts', namePos: 30 }],
    warnings: ['1 changed file(s) were too large to analyse'],
    unanalysable: [{ count: 2, component: 'legacy' }],
    otherFiles: [
      { path: 'docs/guide/deep/b.md', status: 'added' }, { path: 'docs/a.md', status: 'modified' },
      { path: 'config/x/y.json', status: 'renamed' }, { path: 'README.md', status: 'modified' },
      { path: 'docs/guide/c.md', status: 'deleted' },
    ],
    untested: [lone, sameUri], testUnknown: [reachUnknown, reachBare], testReachComputed: true, reachDepth: 3,
    excludedCallerPaths: ['src/scratch.ts'],
    fileStatus: { 'src/store.ts': 'modified', 'src/use.ts': 'modified', 'src/old.ts': 'modified', 'src/open.ts': 'added' },
    mode: 'pr', requestedMode: 'branch', base: { ref: 'origin/main', sha: 'abcdef1234567890' }, changedFileCount: 7,
  };
}

function previewResult() {
  const run = change('src/service.ts', 'Service.run', 12, {
    className: 'Service', staleCallers: 1, stale: [{ label: 'Caller.go' }], kinds: [{ id: 'param', short: 'param' }],
  });
  const body = change('src/service.ts', 'Service.idle', 90);
  const body2 = change('src/service.ts', 'Service.stop', 120, { callerState: 'unknown' });
  return {
    tierA: true, prNumber: 7, headSha: 'headsha', base: { ref: 'main', sha: 'basesha' },
    allChanged: [run, body, body2], findings: [run], deleted: [{ label: 'legacy', key: 'k', relPath: 'src/gone.ts', file: '/repo/src/gone.ts', namePos: 1 }],
    warnings: [], unanalysable: [], untested: [], testReachComputed: false,
    otherFiles: [{ path: 'docs/new.md', status: 'added' }, { path: 'docs/sub/moved.md', status: 'renamed' }],
    fileStatus: { 'src/service.ts': 'modified', 'src/caller.ts': 'added', 'src/gone.ts': 'deleted', 'docs/new.md': 'added' },
    mode: 'pr-preview', changedFileCount: 3,
  };
}

// ---- callers ---------------------------------------------------------------------------
const site = (start, updated, extra = {}) => ({ start, end: start + 4, updated, ...extra });
const caller = (relPath, pos, label, callSites, extra = {}) => ({
  file: `/repo/${relPath}`, pos, label, test: false, callSites, sites: callSites.length, ...extra,
});
const LOCAL_CALLERS = {
  '/repo/src/store.ts#10': { complete: true, callers: [
    caller('src/use.ts', 40, 'useA', [site(41, true)]),
    caller('src/use.ts', 80, 'useB', [site(81, true), site(90, false)]),
    caller('test/store.test.ts', 5, 'saves', [site(6, false)], { test: true }),
    caller('src/store.ts', 10, 'Store.save', [site(15, false)]),
    caller('src/scratch.ts', 2, 'scratch', [site(3, false)]),
    caller('src/lib.ts', 7, 'libCall', [site(8, false, { unknown: true })]),
  ] },
  '/repo/src/store.ts#50': { complete: false, reason: 'command-bus callers unavailable',
    callers: [caller('src/use.ts', 120, 'loader', [site(121, true)])] },
  '/repo/src/web/util.ts#5': { throws: 'tsserver crashed' },
  '/repo/src/api/util.ts#5': { complete: false, callers: [] },
  '/repo/src/use.ts#40': { complete: true, callers: [caller('src/app.ts', 7, 'main', [site(9, false)])] },
  '/repo/src/app.ts#7': { complete: true, callers: [caller('src/use.ts', 40, 'useA', [site(44, false)])] },
  '/repo/src/open.ts#100': { complete: true, callers: [caller('src/boot.ts', 1, 'boot', [site(2, true)])] },
};
const PREVIEW_CALLERS = {
  '/repo/src/service.ts#12': [
    caller('src/caller.ts', 40, 'Caller.go', [site(41, false)]),
    caller('src/caller.ts', 60, 'Caller.stop', [site(61, true)]),
  ],
};

const localResolver = {
  async incomingWithStatus(file, pos) {
    const answer = LOCAL_CALLERS[`${file}#${pos}`];
    if (!answer) return { callers: [], complete: true };
    if (answer.throws) throw new Error(answer.throws);
    return { callers: answer.callers, complete: answer.complete, reason: answer.reason };
  },
};
// The older resolver contract: no completeness, so every expansion says callers may be missing.
const previewResolver = { incoming: async (file, pos) => PREVIEW_CALLERS[`${file}#${pos}`] || [] };

function viewState(result, extra = {}) {
  return {
    result, rel: (f) => f.replace('/repo/', ''), absPath: (p) => `/repo/${p}`,
    changedKeys: new Set(['/repo/src/use.ts#80', '/repo/src/caller.ts#40']),
    classifyCallSiteUpdates: (_, sites) => ({
      updated: (sites || []).filter((s) => s.updated), unknown: (sites || []).filter((s) => s.unknown),
      untouched: (sites || []).filter((s) => !s.updated && !s.unknown),
    }),
    ...extra,
  };
}

function reviewWith(ids) {
  const store = new Map();
  const review = createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
  for (const id of ids) review.set(id, true);
  return review;
}

// ---- recording -------------------------------------------------------------------------
function recordingDecorations() {
  const log = [];
  const byUri = new Map();
  let flushes = 0;
  return {
    decorate: {
      register(uri, d) { log.push([uri.toString(), d.status ?? null, d.tooltip ?? null]); byUri.set(uri.toString(), d); },
      flush() { flushes++; },
    },
    take() { return log.splice(0); },
    at(uri) { const d = uri && byUri.get(uri.toString()); return d ? { status: d.status ?? null, tooltip: d.tooltip ?? null } : null; },
    flushes: () => flushes,
  };
}

const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string';
const isChange = (v) => v && typeof v === 'object' && Array.isArray(v.kinds) && 'namePos' in v;

// A stable, readable form of a row model: nested rows and changes by label, URIs by string.
function summarize(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (value.__isUri) return `uri:${value.toString()}`;
  if (value instanceof Map) return { '<Map>': [...value.keys()] };
  if (value instanceof Set) return { '<Set>': [...value] };
  if (Array.isArray(value)) return value.map((v) => summarize(v, depth + 1));
  if (depth > 0 && isNode(value)) return `<${value.type}:${value.label}>`;
  if (depth > 0 && isChange(value)) return `<change:${value.label}>`;
  if (depth > 4) return '<deep>';
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = summarize(value[key], depth + 1);
  }
  return out;
}

function renderItem(item, node, decorations) {
  const tooltip = item.tooltip && typeof item.tooltip === 'object' ? { markdown: item.tooltip.value } : item.tooltip;
  return summarize({
    label: item.label, description: item.description, tooltip,
    icon: item.iconPath ? item.iconPath.id : undefined,
    collapsible: item.collapsibleState, checkbox: item.checkboxState, contextValue: item.contextValue,
    resourceUri: item.resourceUri,
    decoration: decorations.at(item.resourceUri),
    command: item.command && {
      command: item.command.command, title: item.command.title,
      arguments: item.command.arguments && item.command.arguments.map((a) => (a === node ? '<this row>' : summarize(a, 1))),
    },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Expands every row depth-first, as a reviewer opening the whole tree would.
async function renderTree({ state, resolver, review = null, getPhase, isBusy }) {
  const decorations = recordingDecorations();
  const provider = createTreeProvider(vscode, {
    getState: () => state, resolver, review, decorate: decorations.decorate,
    ...(getPhase ? { getPhase } : {}), ...(isBusy ? { isBusy } : {}),
  });
  const rows = [];
  const visit = async (node, where, depth) => {
    const children = await provider.getChildren(node);
    const registered = decorations.take();
    if (registered.length) rows.push({ expanded: where, registered });
    for (const [i, child] of children.entries()) {
      const at = `${where}/${i}:${child.label}`;
      const model = summarize(child);
      rows.push({ at, model, item: renderItem(provider.getTreeItem(child), child, decorations) });
      if (depth < MAX_DEPTH) await visit(child, at, depth + 1);
    }
  };
  await visit(undefined, '', 0);
  await tick();
  rows.push({ flushes: decorations.flushes() });
  return rows;
}

const STATES = {
  'local, tree layout, hover detail, file icons, with review progress': () => renderTree({
    state: viewState(localResult(), { fileListLayout: 'tree', rowDetail: 'hover', iconMode: 'file' }),
    resolver: localResolver,
    review: reviewWith(['/repo/src/store.ts#10', '/repo/src/use.ts#40', 'file:docs/a.md', '/repo/src/open.ts#200', '/repo/src/open.ts#400']),
  }),
  'local, flat layout, inline detail, symbol icons, no review': () => renderTree({
    state: viewState(localResult(), { fileListLayout: 'flat', rowDetail: 'inline', iconMode: 'symbol' }),
    resolver: localResolver,
  }),
  'local, inline detail with review progress': () => renderTree({
    state: viewState(localResult(), { rowDetail: 'inline' }),
    resolver: localResolver,
    review: reviewWith(['/repo/src/use.ts#40', '/repo/src/use.ts#80', '/repo/src/use.ts#120']),
  }),
  'local, test reach not computed': () => {
    const result = { ...localResult(), testReachComputed: false };
    return renderTree({ state: viewState(result, {}), resolver: localResolver });
  },
  'PR preview, tree layout, hover detail': () => renderTree({
    state: viewState(previewResult(), { fileListLayout: 'tree', rowDetail: 'hover' }),
    resolver: previewResolver,
    review: reviewWith(['file:docs/new.md']),
  }),
  'PR preview, flat layout, inline detail, symbol icons': () => renderTree({
    state: viewState(previewResult(), { fileListLayout: 'flat', rowDetail: 'inline', iconMode: 'symbol' }),
    resolver: previewResolver,
  }),
  'phase starting': () => renderTree({ state: null, resolver: localResolver, getPhase: () => 'starting' }),
  'phase preparing': () => renderTree({ state: null, resolver: localResolver, getPhase: () => 'preparing' }),
  'phase analysing': () => renderTree({ state: null, resolver: localResolver, getPhase: () => 'analysing' }),
  'busy while ready': () => renderTree({ state: null, resolver: localResolver, isBusy: () => true }),
  'no result yet': () => renderTree({ state: {}, resolver: localResolver }),
  'analysis error': () => renderTree({ state: { error: 'git failed: not a repository' }, resolver: localResolver }),
};

async function renderAll() {
  const out = {};
  for (const [name, render] of Object.entries(STATES)) out[name] = await render();
  return out;
}

if (process.argv.includes('--record')) {
  renderAll().then((out) => {
    fs.writeFileSync(EXPECTED, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`recorded ${EXPECTED}`);
  });
} else {
  const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
  for (const [name, render] of Object.entries(STATES)) {
    test(`the tree renders as recorded: ${name}`, async () => {
      assert.deepEqual(await render(), expected[name]);
    });
  }
  test('every recorded state is still rendered', () => {
    assert.deepEqual(Object.keys(STATES), Object.keys(expected));
  });
}
