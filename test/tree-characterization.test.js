'use strict';
// Characterization of the whole change tree: every row the provider returns, for a set of
// representative states, rendered through the vscode stub and compared with the output
// recorded in tree-characterization.expected.json, together with the view's message and
// badge. Any difference is a visible change. The states are small hand-made results, so
// no target repository is needed.
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
const { changedSymbolKeys } = require('../src/engine/changed-symbols');

const EXPECTED = path.join(__dirname, 'tree-characterization.expected.json');
const MAX_DEPTH = 8;

// ---- results ---------------------------------------------------------------------------
// The results are shaped as the engine shapes them: `resolved` means at least one caller
// was found, a stale caller is one of the callers, and each caller's call-site evidence
// agrees with whether it is stale.
const BODY = { id: 'body', label: 'body' };
const PARAM = { id: 'param', label: 'parameter', short: 'param' };
const SIG = { id: 'sig', label: 'signature', short: 'sig' };
const NO_SITES = { updated: [], untouched: [], unknown: [] };
const updatedAt = (start) => ({ ...NO_SITES, updated: [{ start, end: start + 4 }] });
const untouchedAt = (start) => ({ ...NO_SITES, untouched: [{ start, end: start + 4 }] });
const resultCaller = (relPath, pos, label, callSiteUpdates, extra = {}) => ({
  file: `/repo/${relPath}`, pos, label, test: false, sites: 1,
  callSites: [...callSiteUpdates.updated, ...callSiteUpdates.untouched, ...callSiteUpdates.unknown], callSiteUpdates, ...extra,
});
const change = (relPath, label, startLine, extra = {}) => ({
  file: `/repo/${relPath}`, relPath, label, namePos: startLine * 10, start: startLine * 10, end: startLine * 10 + 90,
  startLine, endLine: startLine + 8, component: '(root)', kinds: [BODY], throwsAdded: [], callers: [], stale: [],
  staleCallers: 0, callerState: 'none', score: 1, testState: 'uncovered', tests: [], ...extra,
});
const withCallers = (callers, extra = {}) => ({ callerState: 'resolved', callers, ...extra });

function localResult() {
  const useB = resultCaller('src/use.ts', 80, 'useB', untouchedAt(81));
  const main = resultCaller('src/app.ts', 7, 'main', untouchedAt(9));
  const save = change('src/store.ts', 'Store.save', 10, {
    className: 'Store', score: 9, kinds: [PARAM, BODY], baseSig: 'save(a)', headSig: 'save(a, b)', throwsAdded: ['Error'],
    ...withCallers([useB, main, resultCaller('test/store.test.ts', 5, 'saves', updatedAt(6), { test: true })]),
    staleCallers: 2, staleChangedElsewhere: 1, stale: [{ label: 'useB' }, { label: 'main' }],
    testState: 'covered', tests: ['saves'],
  });
  const load = change('src/store.ts', 'Store.load', 30, {
    className: 'Store', kinds: [{ id: 'optional-param', label: 'optional param' }],
    ...withCallers([resultCaller('src/use.ts', 120, 'loader', updatedAt(121))]),
    callersComplete: false, callersIncompleteReason: 'query-failed',
    testState: 'unknown', testReachIncompleteReason: 'the walk budget of 120 callers ran out',
  });
  const inner = change('src/store.ts', 'Store.inner', 50, { className: 'Store', kinds: [SIG], callerState: 'unknown', testState: 'unknown' });
  const webHelper = change('src/web/util.ts', 'helper', 5, { component: 'web', kinds: [SIG] });
  const apiHelper = change('src/api/util.ts', 'helper', 5, { component: 'api', kinds: [SIG], callerState: 'di' });
  const bigCallers = Array.from({ length: 11 }, (_, i) => resultCaller('src/use.ts', 1000 + i * 10, `caller${i}`, untouchedAt(1001 + i * 10)));
  const big = change('src/big.ts', 'Big', 1, {
    isConstructor: true, kinds: [SIG], ...withCallers(bigCallers),
    staleCallers: 11, stale: bigCallers.map((c) => ({ label: c.label })), testState: 'covered', tests: ['bigSpec'],
  });
  const factory = change('src/open.ts', 'createOpen', 10, withCallers([resultCaller('src/boot.ts', 1, 'boot', updatedAt(2))]));
  const uriFor = change('src/open.ts', 'createOpen.uriFor', 20, withCallers([resultCaller('src/open.ts', 100, 'createOpen', untouchedAt(105))]));
  const quiet = change('src/open.ts', 'sameUri', 60);
  const ready = change('src/ready.ts', 'READY', 3, { valueLike: true, ...withCallers([resultCaller('src/boot.ts', 1, 'boot', untouchedAt(3))]) });
  // a stale caller of Store.save that was itself edited, away from the call
  const editedCaller = change('src/use.ts', 'useB', 8, withCallers([resultCaller('src/app.ts', 7, 'main', untouchedAt(12))]));
  const findings = [save, load, inner, webHelper, apiHelper, big];
  const allChanged = [...findings, factory, uriFor, quiet, ready, editedCaller];
  return {
    allChanged, findings,
    deleted: [{ label: 'Store.old', key: 'Store>old', relPath: 'src/store.ts', file: '/repo/src/store.ts', namePos: 700, startLine: 70 }],
    outside: [{ file: '/repo/src/store.ts', relPath: 'src/store.ts', ranges: [[1, 2], [40.5, 40.5]] }],
    warnings: ['1 changed file(s) were too large to analyse'],
    unanalysable: [{ count: 2, component: 'legacy' }],
    otherFiles: [{ path: 'docs/a.md', status: 'modified' }, { path: 'README.md', status: 'modified' }, { path: 'config/x/y.json', status: 'renamed' }],
    untested: allChanged.filter((c) => c.testState === 'uncovered'), testUnknown: allChanged.filter((c) => c.testState === 'unknown'),
    testReachComputed: true, reachDepth: 3,
    excludedCallerPaths: ['src/scratch.ts'],
    fileStatus: {
      'src/store.ts': 'modified', 'src/web/util.ts': 'modified', 'src/api/util.ts': 'modified', 'src/big.ts': 'modified',
      'src/open.ts': 'added', 'src/ready.ts': 'modified', 'src/use.ts': 'modified',
      'docs/a.md': 'modified', 'README.md': 'modified', 'config/x/y.json': 'renamed',
    },
    mode: 'branch', requestedMode: 'pr', base: { ref: 'origin/main', sha: 'abcdef1234567890' }, changedFileCount: 7,
  };
}

function previewResult() {
  const go = resultCaller('src/caller.ts', 40, 'Caller.go', untouchedAt(41));
  const run = change('src/service.ts', 'Service.run', 12, {
    className: 'Service', kinds: [PARAM], ...withCallers([go, resultCaller('src/caller.ts', 60, 'Caller.stop', updatedAt(61))]),
    staleCallers: 1, stale: [{ label: 'Caller.go' }], testState: 'not-computed',
  });
  const idle = change('src/service.ts', 'Service.idle', 30, { ...withCallers([go]), testState: 'not-computed' });
  // the caller whose call was updated, so its file is part of the PR
  const stop = change('src/caller.ts', 'Caller.stop', 6, { className: 'Caller', testState: 'not-computed' });
  return {
    tierA: true, prNumber: 7, headSha: 'headsha', base: { ref: 'main', sha: 'basesha' },
    allChanged: [run, idle, stop], findings: [run],
    deleted: [{ label: 'legacy', key: 'legacy', relPath: 'src/gone.ts', file: '/repo/src/gone.ts', namePos: 1, startLine: 1 }],
    outside: [], warnings: [], unanalysable: [], untested: [], testUnknown: [], testReachComputed: false,
    otherFiles: [{ path: 'docs/new.md', status: 'added' }, { path: 'docs/sub/moved.md', status: 'renamed' }],
    fileStatus: { 'src/service.ts': 'modified', 'src/caller.ts': 'added', 'src/gone.ts': 'deleted', 'docs/new.md': 'added', 'docs/sub/moved.md': 'renamed' },
    mode: 'pr-preview', changedFileCount: 3,
  };
}

// ---- lazy caller expansion (a caller row's own callers) --------------------------------
const site = (start, updated, extra = {}) => ({ start, end: start + 4, updated, ...extra });
const caller = (relPath, pos, label, callSites, extra = {}) => ({
  file: `/repo/${relPath}`, pos, label, test: false, callSites, sites: callSites.length, ...extra,
});
const LOCAL_CALLERS = {
  // useB's callers: one in an excluded (untracked) path, one partly updated, one test
  '/repo/src/use.ts#80': { complete: true, callers: [
    caller('src/app.ts', 7, 'main', [site(9, true), site(12, false)]),
    caller('src/scratch.ts', 2, 'scratch', [site(3, false)]),
    caller('test/use.test.ts', 4, 'usesB', [site(5, false)], { test: true }),
  ] },
  // main calls useB back: a cycle under useB
  '/repo/src/app.ts#7': { complete: true, callers: [caller('src/use.ts', 80, 'useB', [site(85, false)])] },
  '/repo/src/use.ts#120': { complete: false, reason: 'command-bus callers unavailable',
    callers: [caller('src/boot.ts', 1, 'boot', [site(2, false, { unknown: true })])] },
  '/repo/src/boot.ts#1': { throws: 'tsserver crashed' },
};
const PREVIEW_CALLERS = { '/repo/src/caller.ts#40': [caller('src/main.ts', 3, 'main', [site(4, false)])] };

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
    // as the session derives it
    changedKeys: changedSymbolKeys(result.allChanged),
    classifyCallSiteUpdates: (_, sites) => ({
      updated: (sites || []).filter((s) => s.updated), unknown: (sites || []).filter((s) => s.unknown),
      untouched: (sites || []).filter((s) => !s.updated && !s.unknown),
    }),
    ...extra,
  };
}

// A review whose identity is the legacy one (file#pos and the like), with `ids` ticked.
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

// A stable, readable form of a value: rows by type and label, URIs by string.
function summarize(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (value.__isUri) return `uri:${value.toString()}`;
  if (Array.isArray(value)) return value.map((v) => summarize(v, depth + 1));
  if (depth > 0 && isNode(value)) return `<${value.type}:${value.label}>`;
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

// Expands every row depth-first, as a reviewer opening the whole tree would, and records
// the view's message and badge.
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
      rows.push({ at, item: renderItem(provider.getTreeItem(child), child, decorations) });
      if (depth < MAX_DEPTH) await visit(child, at, depth + 1);
    }
  };
  await visit(undefined, '', 0);
  await tick();
  rows.push({ flushes: decorations.flushes() });
  return { summary: summarize(provider.summarize()), rows };
}

// Every counting row of src/open.ts, by its legacy id: the file is ticked.
const OPEN_TS_TICKED = ['/repo/src/open.ts#100', '/repo/src/open.ts#200', '/repo/src/open.ts#600'];

const STATES = {
  'local, hover detail, file icons, src/open.ts and docs/a.md ticked': () => renderTree({
    state: viewState(localResult(), { rowDetail: 'hover', iconMode: 'file' }),
    resolver: localResolver,
    review: reviewWith([...OPEN_TS_TICKED, 'file:docs/a.md', '/repo/src/store.ts#300']),
  }),
  'local, inline detail, symbol icons, no review': () => renderTree({
    state: viewState(localResult(), { rowDetail: 'inline', iconMode: 'symbol' }),
    resolver: localResolver,
  }),
  'local, test reach not computed': () => {
    const result = { ...localResult(), testReachComputed: false };
    for (const c of result.allChanged) c.testState = 'not-computed';
    return renderTree({ state: viewState(result, {}), resolver: localResolver });
  },
  'PR preview, hover detail, a file without a call graph ticked': () => renderTree({
    state: viewState(previewResult(), { rowDetail: 'hover', source: { kind: 'pr', pr: { number: 7 } } }),
    resolver: previewResolver,
    review: reviewWith(['file:docs/new.md']),
  }),
  'PR preview, inline detail, symbol icons': () => renderTree({
    state: viewState(previewResult(), { rowDetail: 'inline', iconMode: 'symbol', source: { kind: 'pr', pr: { number: 7 } } }),
    resolver: previewResolver,
  }),
  'phase starting': () => renderTree({ state: null, resolver: localResolver, getPhase: () => 'starting' }),
  'phase preparing': () => renderTree({ state: null, resolver: localResolver, getPhase: () => 'preparing' }),
  'phase analysing': () => renderTree({ state: null, resolver: localResolver, getPhase: () => 'analysing' }),
  'busy while ready, with an older result': () => renderTree({ state: viewState(localResult()), resolver: localResolver, isBusy: () => true }),
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
