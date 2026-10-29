'use strict';
// The feedback drafts store (F1) over a fake memento: what it reads back from workspace
// state, the limits it enforces, its ids, and how it persists.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFeedbackDrafts, readStored, clampQuote, STORAGE_KEY, VERSION, MAX_ITEMS, MAX_BODY_CHARS, ID_PATTERN,
} = require('../src/feedback/feedback-drafts');

/** A memento whose writes are recorded; `hold()` makes the next write wait for release. */
function fakeMemento(initial) {
  const values = new Map(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  const writes = [];
  const held = [];
  let failNext = null;
  return {
    values, writes,
    get: (key) => values.get(key),
    async update(key, value) {
      const gate = held.shift();
      if (gate) await gate.promise;
      if (failNext) { const e = failNext; failNext = null; throw e; }
      values.set(key, JSON.parse(JSON.stringify(value)));
      writes.push(JSON.parse(JSON.stringify(value)));
    },
    hold() { let release; const promise = new Promise((r) => { release = r; }); held.push({ promise }); return release; },
    failNextWith(e) { failNext = e; },
  };
}

const input = (over = {}) => ({ file: 'src/a.ts', line: 12, symbol: 'run', caller: null, quote: 'run();', body: 'Do not swallow errors.', ...over });
const stored = (id, over = {}) => ({ id, ...input(), createdAtMs: 1000, ...over });
const counter = () => { let n = 0; return () => `id${++n}`; };
const make = (memento, over = {}) => {
  const logs = [];
  let t = 100;
  const store = createFeedbackDrafts(memento, { log: (m) => logs.push(m), now: () => t++, newId: counter(), ...over });
  return { store, logs };
};

test('nothing stored: no drafts and no log line', () => {
  const { store, logs } = make(fakeMemento());
  assert.deepEqual(store.list(), []);
  assert.deepEqual(logs, []);
});

test('a stored value of another version or shape is not read at all, with one log line', () => {
  for (const value of [{ version: 2, items: [stored('a')] }, { items: [stored('a')] }, { version: 1, items: 'x' }, [stored('a')], 'drafts', null, 7]) {
    const { store, logs } = make(fakeMemento(value));
    assert.deepEqual(store.list(), [], JSON.stringify(value));
    assert.equal(logs.length, 1, JSON.stringify(value));
    assert.match(logs[0], /not version 1 drafts .*starting with none/);
  }
});

test('invalid items are dropped and counted in one log line; valid ones are kept whole, oldest first', () => {
  const items = [
    stored('late', { createdAtMs: 3000 }),
    stored('early', { createdAtMs: 1000, line: null, symbol: null }),
    stored('bad id!'),
    stored('abs', { file: '/etc/passwd' }),
    stored('up', { file: '../outside.ts' }),
    stored('win', { file: 'src\\a.ts' }),
    stored('zero', { line: 0 }),
    stored('frac', { line: 1.5 }),
    stored('empty', { body: '   ' }),
    stored('long', { body: 'x'.repeat(MAX_BODY_CHARS + 1) }),
    stored('time', { createdAtMs: -1 }),
    stored('caller', { caller: { label: 'f', file: 'b.ts', line: 0 } }),
    stored('late'), // a duplicate id
    'not an object',
    stored('withcaller', { createdAtMs: 2000, caller: { label: 'use', file: 'src/b.ts', line: 3 } }),
  ];
  const { store, logs } = make(fakeMemento({ version: VERSION, items }));
  assert.deepEqual(store.list().map((i) => i.id), ['early', 'withcaller', 'late']);
  assert.deepEqual(store.list()[1].caller, { label: 'use', file: 'src/b.ts', line: 3 });
  assert.deepEqual(logs, ['feedback drafts: 12 invalid drafts dropped; 3 kept']);
  assert.ok(Object.isFrozen(store.list()) && Object.isFrozen(store.list()[0]), 'the list handed out cannot be changed by its readers');
});

test('a stored list above the limit keeps the oldest and says how many were dropped', () => {
  const items = Array.from({ length: MAX_ITEMS + 2 }, (_, k) => stored(`d${k}`, { createdAtMs: k }));
  const { items: kept, log } = readStored({ version: 1, items });
  assert.equal(kept.length, MAX_ITEMS);
  assert.equal(kept.at(-1).id, `d${MAX_ITEMS - 1}`);
  assert.equal(log, `feedback drafts: 2 drafts over the limit of ${MAX_ITEMS} dropped (the newest); ${MAX_ITEMS} kept`);
});

test('add gives a draft an id and a time, persists { version: 1, items }, and tells the listeners first', async () => {
  const memento = fakeMemento();
  const { store } = make(memento);
  const seen = [];
  store.onDidChange(() => seen.push(store.list().length));
  const result = await store.add(input());
  assert.equal(result.ok, true);
  assert.deepEqual(result.item, { id: 'id1', ...input(), createdAtMs: 100 });
  assert.equal(result.warning, null);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(memento.values.get(STORAGE_KEY), { version: 1, items: [{ id: 'id1', ...input(), createdAtMs: 100 }] });
  // What was written reads back as the same drafts.
  assert.deepEqual(make(memento).store.list(), store.list());
});

test('real ids are short, random and match the id pattern', async () => {
  const { store } = make(fakeMemento(), { newId: undefined });
  const a = await store.add(input()), b = await store.add(input());
  for (const r of [a, b]) assert.match(r.item.id, ID_PATTERN);
  assert.equal(a.item.id.length, 12);
  assert.notEqual(a.item.id, b.item.id);
});

test('an id already taken is not reused', async () => {
  const ids = ['same', 'same', 'other'];
  const { store } = make(fakeMemento(), { newId: () => ids.shift() });
  await store.add(input());
  const second = await store.add(input());
  assert.equal(second.item.id, 'other');
});

test('the limit: the 200th draft is added, the 201st is refused with a message and changes nothing', async () => {
  const memento = fakeMemento({ version: 1, items: Array.from({ length: MAX_ITEMS - 1 }, (_, k) => stored(`d${k}`, { createdAtMs: k })) });
  const { store } = make(memento);
  assert.equal((await store.add(input())).ok, true, 'limit minus one: added');
  assert.equal(store.list().length, MAX_ITEMS);
  const writes = memento.writes.length;
  let fired = 0;
  store.onDidChange(() => fired++);
  const refused = await store.add(input());
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /already 200 feedback drafts, the most kept at once\. Send or delete some first/);
  assert.equal(store.list().length, MAX_ITEMS);
  assert.equal(fired, 0);
  assert.equal(memento.writes.length, writes, 'nothing written');
});

test('a body over 10 000 characters is refused, as is an empty one; exactly 10 000 is kept', async () => {
  const { store } = make(fakeMemento());
  const long = await store.add(input({ body: 'x'.repeat(MAX_BODY_CHARS + 1) }));
  assert.equal(long.ok, false);
  assert.match(long.error.message, /10,001 characters long; a draft holds at most 10,000\. Shorten it/);
  assert.equal((await store.add(input({ body: ' \n ' }))).ok, false);
  assert.equal((await store.add(input({ body: 'x'.repeat(MAX_BODY_CHARS) }))).ok, true);
  assert.equal(store.list().length, 1);
  const tooLong = await store.update(store.list()[0].id, 'y'.repeat(MAX_BODY_CHARS + 1));
  assert.equal(tooLong.ok, false);
  assert.equal(store.list()[0].body.length, MAX_BODY_CHARS, 'a refused update changes nothing');
});

test('invalid parts are refused', async () => {
  const { store } = make(fakeMemento());
  for (const bad of [{ file: '' }, { file: 'a/../b.ts' }, { line: 0 }, { line: '3' }, { symbol: '' }, { caller: { label: 'x', file: 'b.ts' } }, { quote: null }]) {
    assert.equal((await store.add(input(bad))).ok, false, JSON.stringify(bad));
  }
  assert.equal(store.list().length, 0);
});

test('the quote is cut to 5 lines and 400 characters, ending in "…"', () => {
  assert.equal(clampQuote('a\nb'), 'a\nb');
  assert.equal(clampQuote('1\n2\n3\n4\n5'), '1\n2\n3\n4\n5', 'exactly five lines');
  assert.equal(clampQuote('1\n2\n3\n4\n5\n6'), '1\n2\n3\n4\n5…');
  assert.equal(clampQuote('x'.repeat(400)), 'x'.repeat(400), 'exactly 400');
  const cut = clampQuote('x'.repeat(401));
  assert.equal(cut.length, 400);
  assert.ok(cut.endsWith('…'));
  assert.equal(clampQuote('a\r\nb'), 'a\nb');
});

test('update and remove change one draft; an unknown id is refused', async () => {
  const memento = fakeMemento();
  const { store } = make(memento);
  const a = (await store.add(input())).item;
  const b = (await store.add(input({ line: 30 }))).item;
  const updated = await store.update(a.id, 'New text');
  assert.equal(updated.ok, true);
  assert.equal(store.get(a.id).body, 'New text');
  assert.equal(store.get(a.id).createdAtMs, a.createdAtMs, 'an edit keeps its place');
  assert.equal((await store.remove(b.id)).ok, true);
  assert.deepEqual(store.list().map((i) => i.id), [a.id]);
  assert.equal((await store.remove(b.id)).ok, false);
  assert.equal((await store.update('nope', 'x')).ok, false);
  assert.deepEqual(memento.values.get(STORAGE_KEY).items.map((i) => [i.id, i.body]), [[a.id, 'New text']]);
  const cleared = await store.clear();
  assert.deepEqual(cleared, { ok: true, count: 1, warning: null });
  assert.deepEqual(memento.values.get(STORAGE_KEY), { version: 1, items: [] });
});

test('writes go out in order: a slow earlier write never overwrites a later one', async () => {
  const memento = fakeMemento();
  const { store } = make(memento);
  const release = memento.hold();
  const first = store.add(input());
  const second = store.add(input({ line: 2 }));
  assert.equal(store.list().length, 2, 'both are held at once');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(memento.writes.map((w) => w.items.length), [1, 2]);
  assert.equal(memento.values.get(STORAGE_KEY).items.length, 2);
});

test('a failed write keeps the draft for this window and says so; the next write still goes out', async () => {
  const memento = fakeMemento();
  const { store, logs } = make(memento);
  memento.failNextWith(new Error('disk full'));
  const result = await store.add(input());
  assert.equal(result.ok, true);
  assert.match(result.warning, /could not be saved \(disk full\); they are kept in this window only/);
  assert.equal(store.list().length, 1);
  assert.equal(logs.length, 1);
  await store.add(input());
  assert.equal(memento.values.get(STORAGE_KEY).items.length, 2);
});

test('after dispose, nothing changes and listeners are gone', async () => {
  const { store } = make(fakeMemento());
  let fired = 0;
  store.onDidChange(() => fired++);
  store.dispose();
  assert.equal((await store.add(input())).ok, false);
  assert.equal(fired, 0);
});
