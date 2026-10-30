'use strict';
// The review tree's two orders (docs/UX_PLAN.md L4): the Files order and the By card order draw
// the same change rows, so a tick, a count, a filter and a walk mean the same in both. Here the
// By card order through the provider and the vscode stub: its root rows, its order, a change in
// two cards drawn once, what "Other changes" holds, the parent chain, the filters inside
// cards, switching order, and the agent's part (kind icons, the attention set, the waiting row,
// a stale result, the summary line).
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/views/changes/tree-provider');
const { createReviewState } = require('../src/session/review-state');
const { agentReviewOf, NO_AGENT_REVIEW } = require('../src/agent/agent-review');
const { resolveAgentResult } = require('../src/agent/agent-cards');
const { createReviewSidebar } = require('../src/views/sidebar/review-sidebar');

const { Checked, Unchecked } = vscode.TreeItemCheckboxState;
const BODY = { id: 'body', label: 'body' };
const SIG = { id: 'sig', label: 'signature', short: 'sig' };
const NO_SITES = { updated: [], untouched: [], unknown: [] };

const callerOf = (relPath, label) => {
  const sites = [{ start: 3, end: 6 }];
  return { file: `/r/${relPath}`, pos: 2, label, test: false, callSites: sites, sites: 1, callSiteUpdates: { ...NO_SITES, untouched: sites } };
};
const change = (relPath, label, startLine, extra = {}) => ({
  file: `/r/${relPath}`, relPath, label, namePos: startLine * 10, startLine, endLine: startLine + 3, component: '(root)',
  kinds: [BODY], throwsAdded: [], stale: [], staleCallers: 0, callerState: 'none', callers: [], score: 1,
  testState: 'covered', tests: ['spec'], ...extra,
});
const idOf = (c) => `${c.relPath}#${c.namePos}`;

// src/a.ts: `bad` (a caller not updated: red), `body` (quiet), a deleted symbol and an outside row;
// src/b.ts: `quiet`; src/c.ts: c1, c2, c3 (quiet); notes.md has no call graph.
const bad = change('src/a.ts', 'bad', 10, { kinds: [SIG], callerState: 'resolved', callers: [callerOf('src/user.ts', 'user')], staleCallers: 1, stale: [{ label: 'user' }] });
const body = change('src/a.ts', 'Holder.body', 20);
const quiet = change('src/b.ts', 'quiet', 5);
const [c1, c2, c3] = [change('src/c.ts', 'one', 5), change('src/c.ts', 'two', 15), change('src/c.ts', 'three', 25)];
const result = () => ({
  allChanged: [bad, body, quiet, c1, c2, c3], findings: [bad],
  deleted: [{ label: 'gone', key: 'gone', relPath: 'src/a.ts', file: '/r/src/a.ts', namePos: 400, startLine: 40 }],
  outside: [{ file: '/r/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 2]] }],
  otherFiles: [{ path: 'notes.md', status: 'added' }], warnings: [], unanalysable: [], untested: [], testUnknown: [],
  testReachComputed: true, reachDepth: 2, mode: 'branch', requestedMode: 'branch', base: { ref: 'origin/main', sha: '0123456789' },
  changedFileCount: 4, fileStatus: { 'src/a.ts': 'modified', 'src/b.ts': 'modified', 'src/c.ts': 'modified', 'notes.md': 'added' },
});
// K1 holds three quiet changes, K2 the red one and a quiet one, the sweep S1 holds one change of K1 again and `body`.
const engineCards = () => ({
  clusters: [
    { id: 'K1', label: 'Rename the helper and 2 related', members: [idOf(c1), idOf(c2), idOf(c3)], files: ['src/c.ts'], module: 'src', moved: [] },
    { id: 'K2', label: 'Reject bad input', members: [idOf(bad), idOf(quiet)], files: ['src/a.ts', 'src/b.ts'], module: 'src', moved: [], testHelpers: false },
  ],
  sweeps: [{ id: 'S1', label: 'same edit in 2 places', members: [idOf(c1), idOf(body)], files: ['src/a.ts', 'src/c.ts'], pattern: 'x -> y' }],
  seams: [{ type: 'call', clusters: ['K1', 'K2'], via: [] }], hints: [],
});

function agentPayload(extra = {}) {
  return {
    summary: 'Input is rejected earlier.\nSecond line.',
    attention: [idOf(c2)],
    changes: [
      { id: idOf(bad), kind: 'changed', what: 'Rejects empty input' },
      { id: idOf(c2), kind: 'may-change', what: 'Order of results may differ' },
      { id: idOf(c1), kind: 'new', what: 'Adds a helper' },
      { id: idOf(c3), kind: 'same', what: 'Same result, built with a loop' },
    ],
    cards: [
      { title: 'Validate input', summary: 'Bad input is refused.', reason: 'They share one rule.', members: [idOf(bad), idOf(c1)] },
      { title: 'The rest', members: [idOf(body), idOf(quiet), idOf(c2), idOf(c3)] },
    ],
    ...extra,
  };
}

function memoryReview() {
  const store = new Map();
  return createReviewState({ get: (k) => store.get(k), update: (k, v) => store.set(k, v) });
}

/** A provider over the sample review; `world` holds what a test changes between reads. */
function world({ order = 'cards', cards = engineCards(), agent = null, waiting = null, layout = 'flat' } = {}) {
  const w = { order, cards, agent, waiting, layout, cardsOn: true, res: result() };
  const review = memoryReview();
  const agentReview = () => {
    const src = w.agent || w.waiting ? { waiting: w.waiting, showEngine: false, results: w.agent ? [{ kind: 'cards', key: 'k1', payload: w.agent, storedAt: new Date(2026, 0, 2, 10, 7).getTime() }] : [] } : null;
    return src ? agentReviewOf(src, w.cards) : NO_AGENT_REVIEW;
  };
  let memo = null;
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result: w.res, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) }, review,
    getLayout: () => w.layout, getOrder: () => w.order, getCards: () => (w.cardsOn ? w.cards : null),
    // as extension.js keeps it: one object until the stored result, the cards or the shown state change
    getAgentReview: () => {
      const next = agentReview();
      if (memo && memo.cards === next.cards && memo.attention === next.attention && !next.waiting && !memo.waiting && memo.stale === next.stale) return memo;
      memo = next;
      return next;
    },
    getAgentNotes: () => agentReview().notes,
  });
  const item = (row) => provider.getTreeItem(row);
  const roots = async () => (await provider.getChildren()).filter((r) => r.type === 'card' || r.type === 'others');
  const labels = (rows) => rows.filter((r) => r.type !== 'spacer').map((r) => r.label);
  return { w, provider, review, item, roots, labels };
}

test('By card: a row per card, cards holding an attention change first, then by size, sweeps last, Other changes closing', async () => {
  const { provider, item, roots, labels } = world();
  const rows = await roots();
  // K2 holds the red change; K1 is bigger but quiet; S1 is a sweep, so it follows the cards, and keeps only `body` (c1 is drawn under K1).
  assert.deepEqual(rows.map((r) => [r.type, r.label]), [
    ['card', 'Reject bad input'], ['card', 'Rename the helper + 2 related'], ['card', 'S1 · same edit in 2 places'], ['others', 'Other changes'],
  ]);
  assert.deepEqual(rows.map((r) => item(r).description), ['2 changes · 1 needs attention', '3 changes', '1 change', '2 files']);
  assert.deepEqual(rows.map((r) => item(r).iconPath.id), ['layers', 'layers', 'layers', 'files']);
  assert.deepEqual(rows.map((r) => item(r).collapsibleState), [2, 1, 1, 1], 'the first card starts open');
  // worst first inside a card: the red change, then the quiet one
  assert.deepEqual(labels(await provider.getChildren(rows[0])), ['bad', 'quiet']);
  assert.deepEqual(labels(await provider.getChildren(rows[1])), ['one', 'two', 'three']);
  assert.deepEqual(labels(await provider.getChildren(rows[2])), ['Holder.body'], 'a change in two cards is drawn under the first only');
  // Other changes: the file no card touches, then the rows of a.ts that no card holds (its deleted symbol and top-level lines)
  const others = await provider.getChildren(rows[3]);
  assert.deepEqual(others.map((r) => [r.type, r.label]), [['deleted', 'gone'], ['outside', 'Top-level changes'], ['file', 'notes.md']]);
});

test('By card: a card row hovers with its files, module, entry points and seams; an agent card with the summary and why', async () => {
  const { w, provider, item, roots } = world();
  w.res.impactPaths = {
    [idOf(bad)]: { complete: true, entries: [{ type: 'public-api', name: 'POST /bad' }], topPaths: [] },
    [idOf(quiet)]: { complete: false, entries: [], topPaths: [] },
  };
  const [k2] = await roots();
  const tip = item(k2).tooltip;
  assert.match(tip, /^Reject bad input\n/);
  assert.match(tip, /Files: src\/a\.ts, src\/b\.ts/);
  assert.match(tip, /Module: src/);
  assert.match(tip, /Entry points \(at least\): POST \/bad \(public-api\)/);
  assert.match(tip, /Seams: Rename the helper \+ 2 related/);
  w.agent = agentPayload();
  provider.agentChanged();
  const a1 = (await roots()).find((r) => r.label === 'Validate input');
  assert.ok(a1);
  assert.equal(item(a1).iconPath.id, 'sparkle');
  assert.match(item(a1).tooltip, /Bad input is refused\./);
  assert.match(item(a1).tooltip, /Why grouped: They share one rule\./);
});

test('every counting row is in exactly one group, and ticks and counts are the same in both orders', async () => {
  const cardsWorld = world({ order: 'cards' });
  const filesWorld = world({ order: 'files' });
  const groups = await cardsWorld.roots();
  const under = [];
  for (const g of groups) {
    const kids = (await cardsWorld.provider.getChildren(g)).filter((r) => r.type !== 'spacer');
    under.push(...(g.type === 'others' ? kids.flatMap((r) => (r.type === 'reviewFile' || r.type === 'file' ? [r] : [r])) : kids));
  }
  assert.equal(new Set(under).size, under.length, 'no row twice');
  assert.deepEqual(cardsWorld.provider.reviewCounts(), filesWorld.provider.reviewCounts());
  assert.deepEqual(cardsWorld.provider.reviewCounts(), { total: 9, left: 9, attention: 2, attentionTotal: 2 });
  // tick the red change under its card: the Files order's file is not ticked, its row is
  const [k2] = groups;
  const [badRow] = await cardsWorld.provider.getChildren(k2);
  cardsWorld.provider.setChecked(badRow, true);
  assert.equal(cardsWorld.item(badRow).checkboxState, Checked);
  assert.deepEqual(cardsWorld.provider.reviewCounts(), { total: 9, left: 8, attention: 1, attentionTotal: 2 });
  assert.equal(cardsWorld.item(k2).checkboxState, undefined, 'a card has no checkbox');
  // the same tick, in the Files order, is on the same row
  const a = cardsWorld.provider.fileRows().find((f) => f.relPath === 'src/a.ts');
  assert.equal(a.rows[0], badRow, 'the canonical row is the one the card draws');
  assert.equal(cardsWorld.item(a).checkboxState, Unchecked);
});

test('the parent of a change is its card, whose parent is none (the sidebar falls back to the host); switching order leaves no stale card parent', async () => {
  const { w, provider, roots } = world();
  const [k2, , , others] = await roots();
  const [badRow] = await provider.getChildren(k2);
  assert.equal(provider.getParent(badRow), k2);
  assert.equal(provider.getParent(k2), undefined);
  const inOthers = await provider.getChildren(others);
  for (const r of inOthers) assert.equal(provider.getParent(r), others, `${r.type} ${r.label}`);
  // the Files order: the same row is under its file again
  w.order = 'files';
  provider.refresh('order');
  const files = await provider.getChildren();
  assert.deepEqual(files.map((r) => r.type), ['reviewFile', 'reviewFile', 'reviewFile', 'file']);
  assert.equal(provider.getParent(badRow).type, 'reviewFile');
  assert.equal(provider.getParent(badRow).relPath, 'src/a.ts');
  // and back
  w.order = 'cards';
  provider.refresh('order');
  const again = await roots();
  assert.equal(provider.getParent(badRow), again[0]);
});

test('a review without cards (none built, too few changes, or cards off) is drawn by file whatever the setting says', async () => {
  const { w, provider } = world();
  assert.equal(provider.hasCards(), true);
  w.cardsOn = false;
  assert.equal(provider.hasCards(), false);
  assert.equal(provider.getOrder(), 'files');
  provider.refresh('order');
  assert.equal((await provider.getChildren())[0].type, 'reviewFile');
  w.cardsOn = true;
  w.res.allChanged = [bad, quiet];
  w.res.deleted = [];
  assert.equal(provider.hasCards(), false, 'fewer than four changes: cards say nothing a list does not');
});

test('the filters apply to the rows inside cards; a card with nothing left is not drawn; the empty-filter row stays', async () => {
  const { provider, review, item, roots, labels } = world();
  provider.toggleFilter('attention');
  let rows = await roots();
  assert.deepEqual(rows.map((r) => r.label), ['Reject bad input', 'Other changes'], 'the red change, and the deleted symbol (always flagged)');
  assert.deepEqual(labels(await provider.getChildren(rows[0])), ['bad']);
  assert.deepEqual(item(rows[1]).description, '1 file');
  provider.toggleFilter('attention');
  provider.toggleFilter('unreviewed');
  for (const r of provider.fileRows().flatMap((f) => f.rows || [])) provider.setChecked(r, true);
  provider.setChecked(provider.fileRows().find((f) => f.type === 'file'), true);
  const all = await provider.getChildren();
  assert.deepEqual(all.map((r) => [r.type, r.label]), [['message', 'Everything is reviewed']]);
  assert.equal(review.size() > 0, true);
});

test('next and previous unreviewed follow the card order; the walk starts after a card row\'s first change', async () => {
  const { provider, roots, labels } = world();
  const rows = await roots();
  const first = provider.nextUnreviewed(null);
  assert.equal(first.label, 'bad', 'the first row of the first card');
  const second = provider.nextUnreviewed(first);
  assert.equal(second.label, 'quiet');
  assert.equal(provider.nextUnreviewed(second).label, 'one', 'on to the next card, not the next row of the file');
  assert.equal(provider.previousUnreviewed(null).label, 'notes.md');
  assert.deepEqual(labels(await provider.getChildren(rows[2])), ['Holder.body']);
  assert.equal(provider.rowAtLine('src/a.ts', 11).label, 'bad', 'reveal from the diff finds the canonical row');
  assert.equal(provider.rowById(`finding:src/a.ts:bad:${bad.namePos}`).finding, bad);
});

test('a change row in the By card order ends its description with its file', async () => {
  const cardsWorld = world({ order: 'cards' });
  const [k2] = await cardsWorld.roots();
  const [badRow] = await cardsWorld.provider.getChildren(k2);
  assert.match(cardsWorld.item(badRow).description, /a\.ts$/);
  const filesWorld = world({ order: 'files' });
  const file = filesWorld.provider.fileRows().find((f) => f.relPath === 'src/a.ts');
  assert.doesNotMatch(filesWorld.item(file.rows[0]).description, /a\.ts/);
});

// ---- the agent's part -------------------------------------------------------------------

test('the attention set: an agent-named quiet change is counted, filtered, flagged and keeps a review from being calm', async () => {
  const quietOnly = (w) => { w.res.allChanged = [quiet, c1, c2, c3]; w.res.deleted = []; w.res.outside = []; w.res.otherFiles = []; w.res.fileStatus = {}; };
  const plain = world({ order: 'files' });
  quietOnly(plain.w);
  assert.equal(plain.provider.summarize().message.includes('nothing needs attention'), true);
  assert.equal((await plain.provider.getChildren())[0].type, 'message', 'calm: nothing to flag');
  const { w, provider } = plain;
  w.cards = { clusters: [{ id: 'K1', label: 'k', members: [idOf(quiet), idOf(c1), idOf(c2), idOf(c3)], moved: [] }], sweeps: [] };
  w.agent = { attention: [idOf(c2)], changes: [{ id: idOf(c2), kind: 'changed', what: 'Order changes' }],
    cards: [{ title: 'All', members: [idOf(quiet), idOf(c1), idOf(c2), idOf(c3)] }] };
  provider.agentChanged();
  assert.deepEqual(provider.reviewCounts(), { total: 4, left: 4, attention: 1, attentionTotal: 1 });
  assert.match(provider.summarize().message, /1 needs attention/);
  assert.deepEqual(provider.summarize().badge, { value: 1, tooltip: '1 of 1 need attention still to look at' });
  assert.deepEqual(provider.attentionLeft().map((r) => r.label), ['two']);
  assert.equal(provider.reviewProgress().attention, 1);
  const roots = await provider.getChildren();
  assert.deepEqual(roots.map((r) => r.type), ['reviewFile', 'reviewFile'].slice(0, 2), 'not calm: the files are drawn, none behind "Browse all"');
  provider.toggleFilter('attention');
  const kept = await provider.getChildren();
  assert.deepEqual(kept.map((r) => r.relPath), ['src/c.ts']);
  assert.deepEqual((await provider.getChildren(kept[0])).filter((r) => r.type !== 'spacer').map((r) => r.label), ['two']);
  // the same set drives the file row's count
  provider.toggleFilter('attention');
  const cFile = (await provider.getChildren()).find((r) => r.relPath === 'src/c.ts');
  assert.match(provider.getTreeItem(cFile).description, /^1 needs attention/);
});

test('the agent\'s cards replace the engine\'s: its title, sparkle icon, its attention change first, the kind icons the agent chose', async () => {
  const { w, provider, item, roots, labels } = world({ order: 'cards' });
  w.agent = agentPayload();
  provider.agentChanged();
  const rows = await roots();
  assert.deepEqual(rows.map((r) => [r.type, r.label]), [['card', 'The rest'], ['card', 'Validate input'], ['others', 'Other changes']]);
  assert.deepEqual(rows.slice(0, 2).map((r) => item(r).iconPath.id), ['sparkle', 'sparkle']);
  // `two` is quiet for the engine and named by the agent: it needs attention, so it is first in its card
  assert.deepEqual(rows.map((r) => item(r).description), ['4 changes · 1 needs attention', '2 changes · 1 needs attention', '2 files']);
  const [inRest, inFirst] = [await provider.getChildren(rows[0]), await provider.getChildren(rows[1])];
  assert.deepEqual(labels(inFirst), ['bad', 'one']);
  assert.deepEqual(labels(inRest), ['two', 'Holder.body', 'quiet', 'three']);
  const icon = (r) => item(r).iconPath && item(r).iconPath.id;
  assert.equal(icon(inFirst[0]), 'edit', 'changed');
  assert.equal(icon(inRest[0]), 'question', 'may change');
  assert.equal(icon(inFirst[1]), 'add', 'new');
  assert.equal(icon(inRest[3]), 'symbol-function', 'same behaviour: no kind icon, the symbol icon stays');
  assert.match(item(inFirst[0]).description, /⚠ Rejects empty input/, 'the agent\'s one line is kept');
  // the Files order draws the same kind icon for the same change
  w.order = 'files';
  provider.refresh('order');
  const a = (await provider.getChildren()).find((f) => f.relPath === 'src/a.ts');
  const badRow = (await provider.getChildren(a)).find((r) => r.label === 'bad');
  assert.equal(icon(badRow), 'edit');
});

test('while a hand-off waits the review shows one progress row with Cancel; a stale result is a notice for the reviewed row\'s hover; the summary\'s first line joins it', async () => {
  const { w, provider, item } = world({ order: 'files' });
  w.waiting = { askedAt: new Date(2026, 0, 2, 14, 58).getTime() };
  provider.agentChanged();
  let roots = await provider.getChildren();
  const row = roots.find((r) => r.type === 'message');
  assert.equal(row.label, 'Waiting for your agent… (asked 14:58)');
  assert.equal(item(row).contextValue, 'agentWaiting');
  assert.equal(item(row).iconPath.id, 'loading~spin');
  w.waiting = null;
  w.agent = agentPayload({ cards: agentPayload().cards.slice(0, 1) });
  provider.agentChanged();
  assert.equal(resolveAgentResult(w.agent, w.cards).ok, false, 'it places only some of the changes');
  roots = await provider.getChildren();
  const stale = roots.find((r) => r.notice === 'agent');
  assert.equal(stale.label, 'The agent\'s result is for another state of this branch');
  assert.equal(provider.reviewCounts().attentionTotal, 2, 'a stale result adds nothing to the attention set');
  w.agent = agentPayload();
  provider.agentChanged();
  assert.equal(provider.agentSummaryLine(), 'Input is rejected earlier.');
  assert.equal(roots.some((r) => r.type === 'message' && r.contextValue === 'agentWaiting'), false);
  // the sidebar's host row carries both in its hover
  const sidebar = createReviewSidebar(vscode, { tree: provider, getHost: () => ({ kind: 'local', mode: 'branch' }) });
  sidebar.setSources({ onDidChangeTreeData: () => ({ dispose() {} }), getChildren: async (n) => (n ? [] : [{ type: 'mode', label: 'Branch', args: ['branch'] }]), getTreeItem: (n) => new vscode.TreeItem(n.label, 0) });
  const host = await sidebar.hostRow();
  await sidebar.getChildren(host);
  assert.match(sidebar.getTreeItem(host).tooltip, /Your agent: Input is rejected earlier\./);
  w.agent = agentPayload({ cards: agentPayload().cards.slice(0, 1) });
  provider.agentChanged();
  await sidebar.getChildren(host);
  assert.match(sidebar.getTreeItem(host).tooltip, /another state of this branch — ask again, or undo it/);
});
