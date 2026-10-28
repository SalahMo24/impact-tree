'use strict';
// The Cards view with an agent's result (src/cards-view-model.js, src/agent-cards.js): the
// agent's cards first, the engine's facts unchanged underneath, a partial cover listing only
// the members it took, a stale result not shown. Recorded in agent-cards-view.expected.json;
// any difference from the recording is a visible change.
//
// Recording (only when the expected output is meant to change):
//   node test/agent-cards-view.test.js --record
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cardsViewModel, UNDO_COMMAND, TOGGLE_COMMAND } = require('../src/cards-view-model');
const { resolveAgentResult, latestCardsResult } = require('../src/agent-cards');

const EXPECTED = path.join(__dirname, 'agent-cards-view.expected.json');
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cards', `${name}.json`), 'utf8'));
const hono = () => load('hono-1774');
const byId = (f, id) => [...f.cards.clusters, ...f.cards.sweeps].find((c) => c.id === id);

/**
 * An agent result over the hono fixture: K1 and K2 merged (K1 listed with a mirrored copy's id), K3 split
 * in two with the second half joined to K4, every other card and sweep on its own.
 */
function agentPayload(f) {
  const k3 = byId(f, 'K3').members;
  const cards = [
    { title: 'Escape raw HTML and pick the request context', summary: 'The html helper and the Lambda request context change together.', reason: 'Both change how a request body is turned into text.',
      members: [...byId(f, 'K1').members, ...byId(f, 'K1').mirrorMembers, ...byId(f, 'K2').members] },
    { title: 'compose: keep the dispatch order', summary: 'compose and its first callers.', reason: 'Split from K3: these callers are not touched by Context.json.', members: k3.slice(0, 3) },
    { title: 'Context.json and the rest of compose', summary: 'json responses and the remaining compose changes.', reason: 'The rest of K3 calls Context.json.', members: [...k3.slice(3), ...byId(f, 'K4').members] },
  ];
  for (const id of ['K5', 'K6', 'K7', 'K8', 'K9', 'K10', 'K11', 'S1', 'S2']) {
    const c = byId(f, id);
    cards.push({ title: `Group ${id}`, members: [...c.members, ...(c.moved || []).flatMap((m) => [m.from])] });
  }
  // The behaviour review: K3's first change changed (and needs attention), its second the same, one K1 change new.
  const changes = [
    { id: k3[0], kind: 'changed', what: 'Runs middleware in registration order', before: 'ran handlers first', after: 'runs middleware first', when: 'a route has middleware',
      affects: [{ name: 'Hono.dispatch', how: 'responses now pass through middleware' }] },
    { id: k3[1], kind: 'same', what: 'Same order, built with a loop' },
    { id: byId(f, 'K1').members[0], kind: 'new', what: 'Escapes raw HTML' },
  ];
  return { summary: 'Eleven groups of related changes.\nSecond line.', attention: [k3[0]], changes, cards };
}
const result = (f, payload, extra = {}) => ({ key: 'k1', storedAtText: '10:15', payload, ...extra });
const view = (f, agent) => cardsViewModel({ result: f.result, cards: f.cards, agent });
// The recording keeps the first two levels (agent card, its rows and engine cards); the engine cards' own
// facts are the engine view's recording (cards-view-model.expected.json) and are compared below.
const slim = (nodes, depth = 0) => nodes.map((n) => {
  if (!n.children) return n;
  const { children, ...rest } = n;
  return depth >= 1 ? { ...rest, childCount: children.length } : { ...rest, children: slim(children, depth + 1) };
});

const CASES = {
  'agent result: merge, split and partial covers': () => { const f = hono(); return slim(view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: false })); },
  'agent result, engine cards shown': () => { const f = hono(); return slim(view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: true })); },
  'agent result for another state of the branch': () => {
    const f = hono();
    const payload = agentPayload(f);
    payload.cards[0].members.push('src/gone.ts#1');
    return slim(view(f, { waiting: null, result: result(f, payload), showEngine: false }));
  },
  'waiting for the agent': () => { const f = hono(); return view(f, { waiting: { askedAtText: '09:58' }, result: null, showEngine: false }); },
  'agents off': () => { const f = hono(); return slim(view(f, null)); },
};

if (process.argv.includes('--record')) {
  const out = {};
  for (const [name, build] of Object.entries(CASES)) out[name] = build();
  fs.writeFileSync(EXPECTED, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`recorded ${EXPECTED}`);
} else {
  const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
  for (const [name, build] of Object.entries(CASES)) {
    test(`the view renders as recorded: ${name}`, () => assert.deepEqual(build(), expected[name]));
  }
  test('every recorded case is still built', () => assert.deepEqual(Object.keys(CASES), Object.keys(expected)));

  const ids = (nodes, out = []) => { for (const n of nodes) { out.push(n.id); ids(n.children || [], out); } return out; };

  test('agents off or absent: the view is the engine view, byte for byte', () => {
    const f = hono();
    assert.deepEqual(view(f, null), cardsViewModel({ result: f.result, cards: f.cards }));
    assert.deepEqual(view(f, { waiting: null, result: null, showEngine: false }), cardsViewModel({ result: f.result, cards: f.cards }));
  });

  test('every node id is unique, with the same engine card under two agent cards', () => {
    const f = hono();
    const all = ids(view(f, { waiting: { askedAtText: '09:58' }, result: result(f, agentPayload(f)), showEngine: false }));
    assert.equal(new Set(all).size, all.length);
  });

  test('the rows: waiting first, then undo and the toggle, then the agent cards', () => {
    const f = hono();
    const top = view(f, { waiting: { askedAtText: '09:58' }, result: result(f, agentPayload(f)), showEngine: false }).slice(0, 5);
    assert.deepEqual(top.map((n) => n.label), ['Waiting for your agent… (asked 09:58)', 'Agent result from 10:15 — Undo', 'Show engine cards',
      'Eleven groups of related changes.', 'Needs your attention (1)']);
    assert.equal(top[0].contextValue, 'agentWaiting');
    assert.deepEqual(top[1].target, { kind: 'command', command: UNDO_COMMAND, args: ['k1'] });
    assert.deepEqual(top[2].target, { kind: 'command', command: TOGGLE_COMMAND, args: [] });
  });

  test('a card says its changes and how many changed; its tooltip holds the summary, why it was grouped, and who wrote it', () => {
    const f = hono();
    const cards = view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: false }).filter((n) => n.contextValue === 'agentCard');
    assert.equal(cards[0].description, `${byId(f, 'K1').members.length + byId(f, 'K2').members.length} changes`);
    assert.equal(cards[1].description, '3 changes · 1 changed');
    assert.match(cards[1].tooltip, /^compose and its first callers\.\n\nWhy grouped: Split from K3: these callers are not touched by Context\.json\.\n\nWritten by your agent; the facts below come from the engine\.$/);
    assert.equal(cards[3].description, `${byId(f, 'K5').members.length} changes`);
  });

  test('under a card: its summary, its changes worst first with the agent\'s one line, then the engine\'s card', () => {
    const f = hono();
    const k3 = byId(f, 'K3').members;
    const engine = cardsViewModel({ result: f.result, cards: f.cards });
    const k3Engine = engine.find((n) => n.id === 'K3');
    const shown = view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: false }).find((n) => n.label === 'compose: keep the dispatch order');
    assert.equal(shown.children[0].label, 'compose and its first callers.');
    const rows = shown.children.slice(1, 4);
    assert.deepEqual(rows.map((r) => [r.icon, r.description]), [['warning', 'Runs middleware in registration order'], ['circle-outline', 'Same order, built with a loop'], ['symbol-method', rows[2].description]]);
    assert.equal(rows[0].contextValue, 'agentChange');
    assert.equal(rows[0].tooltip, 'Changed: Runs middleware in registration order\nBefore: ran handlers first\nAfter: runs middleware first\nWhen: a route has middleware\nAffects: Hono.dispatch — responses now pass through middleware\nWritten by your agent; the facts below come from the engine.');
    assert.equal(rows[0].target.kind, 'change', 'a row opens its change');
    assert.ok(rows[2].id.endsWith(`member:${k3[2]}`), 'a change the agent did not describe is a plain row');
    // The engine's card, same facts, only the ids moved under the agent card.
    const facts = shown.children.find((n) => n.id === 'agent:A2/engine');
    assert.equal(facts.label, 'Engine facts');
    const labels = (nodes) => nodes.map((n) => `${n.label}|${n.description || ''}|${n.tooltip || ''}|${labels(n.children || [])}`).join(';');
    assert.equal(labels(facts.children[0].children), labels(k3Engine.children));
  });

  test('needs your attention lists the changes the agent named, with their one line', () => {
    const f = hono();
    const top = view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: false });
    const att = top.find((n) => n.id === 'agent:attention');
    assert.deepEqual(att.children.map((c) => [c.icon, c.description]), [['warning', 'Runs middleware in registration order']]);
    const engineShown = view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: true });
    assert.ok(!engineShown.some((n) => n.id === 'agent:attention'), 'not with the engine cards');
    const none = agentPayload(f); delete none.attention;
    assert.ok(!view(f, { waiting: null, result: result(f, none), showEngine: false }).some((n) => n.id === 'agent:attention'));
  });

  test('a seam between cards selects the card where it first appears', () => {
    const f = hono();
    const payload = agentPayload(f);
    const shown = view(f, { waiting: null, result: result(f, payload), showEngine: false });
    const targets = [];
    (function walk(nodes) { for (const n of nodes) { if (n.target && n.target.kind === 'card') targets.push(n.target.id); walk(n.children || []); } })(shown);
    const all = new Set(ids(shown));
    assert.ok(targets.length > 0);
    for (const t of targets) assert.ok(all.has(t), `${t} is a node of this view`);
  });

  test('a result for another state is not shown; undo stays; unknown, missing and doubled ids are all stale', () => {
    const f = hono();
    const good = agentPayload(f);
    const stale = (mutate) => { const p = JSON.parse(JSON.stringify(good)); mutate(p); return resolveAgentResult(p, f.cards).ok; };
    assert.equal(resolveAgentResult(good, f.cards).ok, true);
    assert.equal(stale((p) => p.cards[0].members.push('nope#1')), false);
    assert.equal(stale((p) => p.cards.pop()), false, 'a change in no card');
    assert.equal(stale((p) => p.cards[1].members.push(p.cards[2].members[0])), false, 'a change in two cards');
    assert.equal(resolveAgentResult({ cards: 'x' }, f.cards).ok, false);
    assert.equal(resolveAgentResult(null, f.cards).ok, false);
    assert.equal(resolveAgentResult(good, null).ok, false);
    const shown = view(f, { waiting: null, result: result(f, { cards: [] }), showEngine: false });
    assert.deepEqual(shown.slice(0, 2).map((n) => n.label), ['Agent result from 10:15 — Undo', 'The agent\'s result is for another state of this branch']);
    assert.ok(shown.some((n) => n.id === 'K1'), 'the engine cards stay');
  });

  test('the toggle swaps the cards and keeps the rows', () => {
    const f = hono();
    const agentView = view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: false });
    const engineView = view(f, { waiting: null, result: result(f, agentPayload(f)), showEngine: true });
    assert.equal(agentView[1].label, 'Show engine cards');
    assert.equal(engineView[1].label, 'Show agent cards');
    assert.ok(engineView.some((n) => n.id === 'K1') && !engineView.some((n) => n.contextValue === 'agentCard'));
  });

  test('the latest cards result wins; callers results are ignored', () => {
    const r = (kind, storedAt, key) => ({ kind, storedAt, key, payload: {} });
    assert.equal(latestCardsResult([r('cards', 5, 'a'), r('callers', 9, 'b'), r('cards', 7, 'c'), r('cards', 6, 'd')]).key, 'c');
    assert.equal(latestCardsResult([r('callers', 1, 'x')]), null);
    assert.equal(latestCardsResult([]), null);
    assert.equal(latestCardsResult([r('cards', 3, 'a'), r('cards', 3, 'b')]).key, 'b', 'a tie goes to the later one stored');
  });

  test('a preview never shows agent rows', () => {
    const f = hono();
    const model = cardsViewModel({ result: { ...f.result, tierA: true }, cards: f.cards, preview: true, agent: { waiting: { askedAtText: '09:58' }, result: null, showEngine: false } });
    assert.ok(!model.some((n) => n.id.startsWith('agent:')));
  });
}
