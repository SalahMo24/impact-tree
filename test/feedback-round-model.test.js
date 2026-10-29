'use strict';
// The read-back of a feedback round (docs/UX_PLAN.md F4): two facts per item in words,
// attention whenever they disagree or either is unknown, and the stored round memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/feedback/feedback-round-model');

const SHA = 'a'.repeat(40);
const item = (id, extra = {}) => ({ id, file: 'src/a.ts', line: 12, symbol: 'run', summary: `fix ${id}`, ...extra });
const round = (items) => ({ round: 2, relPath: '.impact-tree/feedback/2026-10-20-2.md', checkpointSha: SHA, sentAtMs: 1, items });

test('only "done + changed" and "no status + changed" are fine; everything else needs attention', () => {
  const statuses = ['done', 'skipped', 'none', 'unreadable'];
  const changes = ['changed', 'unchanged', 'unknown'];
  const fine = [];
  for (const s of statuses) for (const c of changes) if (!m.needsAttention(s, c)) fine.push(`${s}+${c}`);
  assert.deepEqual(fine, ['done+changed', 'none+changed']);
});

test('rows say both facts in words and count attention', () => {
  const r = round([item('a'), item('b', { line: null, symbol: null }), item('c')]);
  const statuses = new Map([
    ['a', { status: 'done', reason: null }],
    ['b', { status: 'skipped', reason: 'out of scope' }],
    ['c', { status: 'done', reason: null }],
  ]);
  const changes = new Map([['a', 'changed'], ['b', 'unchanged']]);   // c missing: unknown
  const rows = m.roundRows({ round: r, statuses, changes, timeText: '14:32' });
  assert.equal(rows.label, 'Feedback round 2');
  assert.equal(rows.description, 'sent 14:32 · 2 need attention');
  assert.deepEqual(rows.items.map((i) => [i.label, i.description, i.attention]), [
    ['src/a.ts:12 · run', 'Agent: done · Code changed', false],
    ['src/a.ts', 'Agent: skipped · No code change', true],
    ['src/a.ts:12 · run', 'Agent: done · Change unknown', true],
  ]);
  assert.match(rows.items[1].tooltip, /Reason: out of scope/);
});

test('an item missing from the statuses is unreadable, never done', () => {
  const rows = m.roundRows({ round: round([item('a')]), statuses: new Map(), changes: new Map([['a', 'changed']]), timeText: 't' });
  assert.equal(rows.items[0].status, 'unreadable');
  assert.equal(rows.items[0].attention, true);
  assert.equal(rows.description, 'sent t · 1 needs attention');
});

test('stored rounds: validated, kept to the newest five, found by checkpoint', () => {
  assert.deepEqual(m.readSentRounds(undefined), { rounds: [], dropped: 0, unreadable: false });
  assert.equal(m.readSentRounds({ version: 2, rounds: [] }).unreadable, true);
  assert.equal(m.readSentRounds('x').unreadable, true);
  const good = round([item('a')]);
  const bad = { ...round([item('a')]), round: 3, items: [{ id: 'bad id!', file: 'x', line: null, symbol: null, summary: '' }] };
  const read = m.readSentRounds({ version: 1, rounds: [good, bad, { ...good, relPath: '../etc/passwd' }] });
  assert.deepEqual(read.rounds, [good]);
  assert.equal(read.dropped, 2);
  let stored = { version: 1, rounds: [] };
  for (let n = 1; n <= 7; n++) stored = m.withSentRound(stored.rounds, { ...good, round: n, checkpointSha: String(n).repeat(40) });
  assert.deepEqual(stored.rounds.map((r) => r.round), [3, 4, 5, 6, 7]);
  assert.equal(m.roundForCheckpoint(stored.rounds, '7'.repeat(40)).round, 7);
  assert.equal(m.roundForCheckpoint(stored.rounds, '1'.repeat(40)), null);
  assert.equal(m.roundForCheckpoint(stored.rounds, null), null);
});

test('summaryOf takes the first non-empty line, capped at 120 characters', () => {
  assert.equal(m.summaryOf('\n  Fix this  \nmore'), 'Fix this');
  assert.equal(m.summaryOf('x'.repeat(200)).length, 120);
  assert.equal(m.summaryOf(''), '');
});
