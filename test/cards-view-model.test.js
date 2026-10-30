'use strict';
// The Cards view's tree as data (src/views/cards/cards-view-model.js), for four live analyses trimmed to
// the fields the model reads (test/fixtures/cards/), recorded in cards-view-model.expected.json,
// plus the behaviours that matter on their own: what "no entry point" means, tags, deleted
// members, the display caps. Any difference from the recording is a visible change.
//
// Recording (only when the expected output is meant to change):
//   node test/cards-view-model.test.js --record
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cardsViewModel, MAX_MEMBERS } = require('../src/views/cards/cards-view-model');

const FIXTURES = path.join(__dirname, 'fixtures', 'cards');
const EXPECTED = path.join(__dirname, 'cards-view-model.expected.json');

const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Every node, depth first. */
function walk(nodes, visit, depth = 0) {
  for (const n of nodes) { visit(n, depth); walk(n.children || [], visit, depth + 1); }
}

/** The tree as an indented outline, one line per node. */
function outline(nodes) {
  const lines = [];
  walk(nodes, (n, d) => lines.push(`${'  '.repeat(d)}${n.label}${n.description ? `  [${n.description}]` : ''}`));
  return lines.join('\n');
}

const named = ['cli-14752', 't3code-e8dfc42', 'hono-1774', 'httpx-1600'];

function previewOf(fixture) {
  const result = clone(fixture.result);
  result.tierA = true;
  result.callersScope = [{ language: 'Go', scope: 'pr-files', unresolved: 'calls through an interface' }];
  return { result, cards: fixture.cards, preview: true };
}

const CASES = {
  ...Object.fromEntries(named.map((name) => [name, () => {
    const f = load(name);
    return cardsViewModel({ result: f.result, cards: f.cards, hintsPending: false, preview: false });
  }])),
  'cli-14752 preview': () => cardsViewModel(previewOf(load('cli-14752'))),
  'cli-14752 hints pending': () => { const f = load('cli-14752'); return cardsViewModel({ result: f.result, cards: { ...f.cards, hints: [] }, hintsPending: true }); },
  'cli-14752 hint notes': () => { const f = load('cli-14752'); return cardsViewModel({ result: f.result, cards: { ...f.cards, hintNotes: ['git log failed: timeout'] } }); },
  'cli-14752 cards not built yet': () => cardsViewModel({ result: load('cli-14752').result, cards: null }),
  'cli-14752 cards failed': () => cardsViewModel({ result: load('cli-14752').result, cards: null, error: 'the diff facts could not be read' }),
  'small pull request': () => {
    const f = load('cli-14752');
    return cardsViewModel({ result: { ...f.result, allChanged: f.result.allChanged.slice(0, 2), deleted: f.result.deleted.slice(0, 1) }, cards: f.cards, preview: true });
  },
};

if (process.argv.includes('--record')) {
  const out = {};
  for (const [name, build] of Object.entries(CASES)) out[name] = build();
  fs.writeFileSync(EXPECTED, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`recorded ${EXPECTED}`);
} else {
  const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
  for (const [name, build] of Object.entries(CASES)) {
    test(`the cards render as recorded: ${name}`, () => assert.deepEqual(build(), expected[name]));
  }
  test('every recorded case is still built', () => assert.deepEqual(Object.keys(CASES), Object.keys(expected)));

  for (const name of named) {
    test(`${name}: ids are unique, and every card target names a card or sweep of the view`, () => {
      const f = load(name);
      const nodes = cardsViewModel({ result: f.result, cards: f.cards });
      const ids = new Set();
      const tops = new Set(nodes.map((n) => n.id));
      walk(nodes, (n) => {
        assert.ok(!ids.has(n.id), `duplicate id ${n.id}`);
        ids.add(n.id);
        if (n.target && n.target.kind === 'card') assert.ok(tops.has(n.target.id), `${n.id} targets ${n.target.id}`);
      });
    });
  }
}

// ---- behaviours -------------------------------------------------------------------------

const fn = (label, pos, extra = {}) => ({ label, relPath: 'src/a.ts', namePos: pos, startLine: pos, kinds: [], ...extra });
const small = (extra = {}) => ({
  result: { allChanged: [fn('a', 1), fn('b', 2), fn('c', 3), fn('d', 4)], deleted: [], impactPaths: {}, warnings: [], ...(extra.result || {}) },
  cards: { clusters: [{ id: 'K1', label: 'a and 3 related', members: ['src/a.ts#1', 'src/a.ts#2', 'src/a.ts#3', 'src/a.ts#4'], files: ['src/a.ts'], module: '(root)',
    joined: [], mirrorMembers: [], mirrorOf: null, moved: [], hub: false, siblings: false, generated: null,
    stats: { members: 4, callers: 0, tests: 0, notUpdated: 0, notUpdatedOutside: 0, notUpdatedInside: 0, incomplete: 0, risky: 0, riskyAllUpdated: 0 }, ...(extra.card || {}) }],
  sweeps: [], seams: [], hints: [], hintNotes: [], generatedDirs: [] },
});
const card = (model) => model.find((n) => n.id === 'K1');
const child = (node, suffix) => node.children.find((c) => c.id === `${node.id}/${suffix}`);

test('a card with no entry point reads "none found" only when every walk finished', () => {
  const walked = (id) => ({ testOnly: false, complete: true, entries: [], topPaths: [] , id });
  const ids = ['src/a.ts#1', 'src/a.ts#2', 'src/a.ts#3', 'src/a.ts#4'];
  const done = small({ result: { impactPaths: Object.fromEntries(ids.map((i) => [i, walked(i)])) } });
  assert.equal(child(card(cardsViewModel(done)), 'entries').description, 'none found');

  const partial = small({ result: { impactPaths: { ...Object.fromEntries(ids.map((i) => [i, walked(i)])), 'src/a.ts#2': { ...walked(), complete: false } } } });
  assert.equal(child(card(cardsViewModel(partial)), 'entries').description, 'none found — search incomplete');

  const lower = small({ result: { impactPaths: Object.fromEntries(ids.map((i) => [i, { ...walked(i), topPaths: [{ end: 'unknown', via: ['a'], lowerBound: true }] }])) } });
  assert.equal(child(card(cardsViewModel(lower)), 'entries').description, 'none found — search incomplete');

  const missing = small({ result: { impactPaths: { 'src/a.ts#1': walked() } } });
  assert.equal(child(card(cardsViewModel(missing)), 'entries').description, 'none found — search incomplete', 'a change nobody walked is not "none found"');

  const none = small({ result: { impactPaths: undefined } });
  assert.equal(child(card(cardsViewModel(none)), 'entries').label, 'Entry points: not computed');
});

test('entry points are merged across members, once each, and marked "at least" when a path is a lower bound', () => {
  const entry = { type: 'main', name: 'cmd/x', how: 'func main', file: 'cmd/x/main.go' };
  const path1 = (via, lowerBound) => ({ testOnly: false, complete: true, entries: [entry], topPaths: [{ end: 'entry', entry: { type: 'main', name: 'cmd/x' }, via, lowerBound }] });
  const model = cardsViewModel(small({ result: { impactPaths: {
    'src/a.ts#1': path1(['a', 'main'], false), 'src/a.ts#2': path1(['b', 'c', 'main'], true),
    'src/a.ts#3': { testOnly: false, complete: true, entries: [], topPaths: [] }, 'src/a.ts#4': { testOnly: false, complete: true, entries: [], topPaths: [] } } } }));
  const entries = child(card(model), 'entries');
  assert.equal(entries.label, 'Entry points (1)');
  assert.equal(entries.description, 'at least');
  assert.equal(entries.children.length, 1);
  assert.match(entries.children[0].tooltip, /via a ← main/, 'the shortest path is shown');
});

test('a deleted member shows "−label" and opens what the Changes view opens for a deletion', () => {
  const s = small();
  s.result.deleted = [fn('gone', 9, { relPath: 'src/b.ts' })];
  s.cards.clusters[0].members.push('src/b.ts#9');
  const members = child(card(cardsViewModel(s)), 'members');
  const gone = members.children.find((c) => c.label === '−gone');
  assert.deepEqual(gone.target, { kind: 'deleted', relPath: 'src/b.ts', namePos: 9 });
  const live = members.children.find((c) => c.label === 'a');
  assert.deepEqual(live.target, { kind: 'change', relPath: 'src/a.ts', namePos: 1 });
});

test('tags: mirrored into generated dir, moved, generated, hub and sibling folders', () => {
  const s = small({ card: { mirrorMembers: ['x'], mirrorOf: { dir: 'dist', dirs: ['dist'] }, moved: [{ from: 'a', to: 'b' }], generated: { dir: 'gen' }, hub: true, siblings: true } });
  assert.equal(card(cardsViewModel(s)).description, '4 changes · mirrored into generated dir · moved · generated · hub · same function in sibling folders');
  assert.equal(card(cardsViewModel(small())).description, '4 changes');
});

test('the impact line counts signature changes and callers not updated outside the card, and says what is missing', () => {
  const s = small({ card: { stats: { members: 4, callers: 5, tests: 1, notUpdated: 3, notUpdatedOutside: 2, notUpdatedInside: 1, incomplete: 2, risky: 3, riskyAllUpdated: 0 } } });
  const line = child(card(cardsViewModel(s)), 'impact');
  assert.equal(line.label, '3 signature or throw changes, 2 callers not updated outside this card, 1 inside it, callers possibly missing for 2 of 4');
});

test('only hints of strength 1 or more are shown, under both cards they involve', () => {
  const s = small();
  s.cards.clusters.push({ ...clone(s.cards.clusters[0]), id: 'K2', label: 'other', members: [] });
  s.cards.hints = [{ clusters: ['K1', 'K2'], strength: 0, evidence: [{ type: 'token', token: 'weak' }] },
    { clusters: ['K1', 'K2'], strength: 2, evidence: [{ type: 'token', token: 'Strong' }, { type: 'folder', dir: 'src' }] }];
  const model = cardsViewModel(s);
  const hint = (id) => model.find((n) => n.id === id).children.filter((c) => c.contextValue === 'cardHint');
  assert.deepEqual(hint('K1').map((h) => h.label), ['May belong with other: token Strong, folder src']);
  assert.deepEqual(hint('K2').map((h) => h.label), ['May belong with a + 3 related: token Strong, folder src']);
  assert.deepEqual(hint('K1')[0].target, { kind: 'card', id: 'K2' });
});

test('a card with more members than the display limit lists the limit and says how many are left', () => {
  const s = small();
  const ids = [];
  for (let i = 1; i <= MAX_MEMBERS + 3; i++) { s.result.allChanged.push(fn(`f${i}`, 100 + i)); ids.push(`src/a.ts#${100 + i}`); }
  s.cards.clusters[0].members.push(...ids);
  const members = child(card(cardsViewModel(s)), 'members');
  assert.equal(members.label, `Members (${4 + ids.length})`);
  assert.equal(members.children.length, MAX_MEMBERS + 1);
  assert.equal(members.children.at(-1).label, `…and ${4 + ids.length - MAX_MEMBERS} more`);
});

test('used only by tests is shown when some member is reached only from tests', () => {
  const ids = ['src/a.ts#1', 'src/a.ts#2', 'src/a.ts#3', 'src/a.ts#4'];
  const s = small({ result: { impactPaths: Object.fromEntries(ids.map((i, k) => [i, { testOnly: k < 2, complete: true, entries: [], topPaths: [] }])) } });
  assert.equal(child(card(cardsViewModel(s)), 'test-only').label, 'Used only by tests: 2 of 4');
});

test('used only by tests says the search was incomplete when a member\'s walk was (a preview, say)', () => {
  const ids = small().cards.clusters[0].members;
  const s = small({ result: { impactPaths: Object.fromEntries(ids.map((i, k) => [i, { testOnly: k < 2, complete: k !== 1, entries: [], topPaths: [] }])) } });
  const node = child(card(cardsViewModel(s)), 'test-only');
  assert.equal(node.label, 'Only tests found calling: 2 of 4 (search incomplete)');
  assert.match(node.tooltip, /incomplete for 1 of them/);
});

test('the outline of cli-14752 (for review)', () => {
  const f = load('cli-14752');
  assert.match(outline(cardsViewModel({ result: f.result, cards: f.cards })), /^[^K]/);
});
