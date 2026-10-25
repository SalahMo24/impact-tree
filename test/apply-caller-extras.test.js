'use strict';
// The one order a language's caller extras apply in (applyCallerExtras,
// src/languages/callers-from-hierarchy.js), shared by the editor's resolver and the harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCallerExtras } = require('../src/languages/callers-from-hierarchy');

const row = (file, pos, extra = {}) => ({ label: `${file}@${pos}`, file, pos, test: false, sites: 1, callSites: [{ start: pos, end: pos + 1 }], ...extra });
const base = { file: '/r/a.py', pos: 4, withTests: true };

test('an unanswered query keeps the server reason, retryable as the server said', async () => {
  const r = await applyCallerExtras({ ready: false, reason: 'timed out', retryable: true }, { ...base, extras: null, query: null });
  assert.deepEqual(r, { stale: false, answer: { callers: [], complete: false, reason: 'timed out', retryable: true }, ready: false, explainedReason: null, dropped: 0, added: 0, targetsAsked: 0 });
  const empty = await applyCallerExtras({ ready: false, reason: '', retryable: false }, { ...base, extras: null, query: null });
  assert.equal(empty.answer.reason, 'caller query did not complete', 'never an empty reason');
});

test('an explained failure shows the explanation and is not retryable', async () => {
  const seen = [];
  const extras = /** @type {any} */ ({ explainIncomplete: (reason, file, pos) => { seen.push([reason, file, pos]); return 'not in the active build'; } });
  const r = await applyCallerExtras({ ready: false, reason: 'no package metadata', retryable: true }, { ...base, extras, query: null });
  assert.deepEqual(seen, [['no package metadata', '/r/a.py', 4]]);
  assert.equal(r.answer.reason, 'not in the active build');
  assert.equal(r.answer.retryable, undefined);
  assert.equal(!r.stale && r.explainedReason, 'not in the active build');
});

test('filter replaces the callers; moreCallers adds each once, without tests when asked', async () => {
  const query = {
    isSuppressed: () => false,
    filter: (callers) => ({ kept: callers.filter((c) => c.pos !== 2), dropped: 1 }),
    moreCallers: async () => ({ callers: [row('/r/b.py', 1), row('/r/c.py', 9), row('/r/t.py', 3, { test: true })], incompleteReason: null }),
  };
  const r = await applyCallerExtras({ ready: true, rows: [row('/r/b.py', 1), row('/r/b.py', 2), row('/r/b.py', 1)] }, { ...base, withTests: false, extras: /** @type {any} */ ({}), query });
  assert.ok(!r.stale);
  assert.deepEqual(r.answer.callers.map((c) => `${c.file}#${c.pos}`), ['/r/b.py#1', '/r/c.py#9']);
  assert.equal(r.answer.complete, true);
  assert.equal(r.dropped, 1);
  assert.equal(r.added, 3, 'counted before de-duplication');
});

test('filter is not asked for an empty list; an incomplete moreCallers makes the answer incomplete', async () => {
  let filtered = 0;
  const query = { isSuppressed: () => false, filter: (c) => { filtered++; return { kept: c, dropped: 0 }; }, moreCallers: async () => ({ callers: [], incompleteReason: 'protocol method' }) };
  const r = await applyCallerExtras({ ready: true, rows: [] }, { ...base, extras: /** @type {any} */ ({}), query });
  assert.equal(filtered, 0);
  assert.deepEqual(!r.stale && r.answer, { callers: [], complete: false, reason: 'protocol method' });
});

test('a query that became stale while moreCallers ran builds no answer', async () => {
  const query = { isSuppressed: () => false, filter: (c) => ({ kept: c, dropped: 0 }), moreCallers: async () => ({ callers: [row('/r/x.py', 1)], incompleteReason: null }) };
  const r = await applyCallerExtras({ ready: true, rows: [] }, { ...base, extras: /** @type {any} */ ({}), query, isStale: () => true });
  assert.deepEqual(r, { stale: true });
});

// A5: caller targets, other positions whose incoming calls are also the target's callers.
const { MAX_CALLER_TARGETS, mergeCallerRows } = require('../src/languages/callers-from-hierarchy');
const targetsExtras = (/** @type {Array<{ file: string, pos: number }>} */ targets) => /** @type {any} */ ({ callerTargets: () => targets });
/** @param {Record<number, any>} answers By position; a missing one is ready with no rows. */
const asker = (answers) => {
  const asked = [];
  return { asked, askAt: async (/** @type {string} */ f, /** @type {number} */ p) => { asked.push(`${f}#${p}`); return answers[p] || { ready: true, rows: [] }; } };
};

test('targets: their callers are merged with the main answer, each caller once with its sites merged', async () => {
  const { asked, askAt } = asker({ 40: { ready: true, rows: [row('/r/b.py', 1, { callSites: [{ start: 1, end: 2 }, { start: 7, end: 8 }], sites: 2 }), row('/r/c.py', 3)] } });
  const r = await applyCallerExtras({ ready: true, rows: [row('/r/b.py', 1)] }, { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }, { file: '/r/a.py', pos: 40 }, { file: '/r/a.py', pos: 4 }]), query: null, askAt });
  assert.deepEqual(asked, ['/r/a.py#40'], 'a duplicate target and the target itself are not asked');
  assert.ok(!r.stale);
  assert.equal(r.answer.complete, true);
  assert.equal(r.targetsAsked, 1);
  assert.deepEqual(r.answer.callers.map((c) => [c.file, c.sites, c.callSites.map((s) => s.start)]), [['/r/b.py', 2, [1, 7]], ['/r/c.py', 1, [3]]]);
});

test('targets: a main null reads as no calls there; an explained or failed main stays incomplete with the targets\' callers', async () => {
  const { askAt } = asker({ 40: { ready: true, rows: [row('/r/c.py', 3)] } });
  const nul = { ready: false, reason: 'no incoming-call result', retryable: false };
  const ok = await applyCallerExtras(/** @type {any} */ (nul), { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }]), query: null, askAt });
  assert.ok(!ok.stale && ok.ready && ok.answer.complete);
  assert.equal(!ok.stale && ok.answer.callers.length, 1);
  const explained = await applyCallerExtras(/** @type {any} */ (nul), { ...base, extras: { ...targetsExtras([{ file: '/r/a.py', pos: 40 }]), explainIncomplete: () => 'protocol' }, query: null, askAt });
  assert.deepEqual(!explained.stale && [explained.answer.complete, explained.answer.reason, explained.answer.callers.length, explained.answer.retryable], [false, 'protocol', 1, undefined]);
  const failed = await applyCallerExtras({ ready: false, reason: 'timed out', retryable: true }, { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }]), query: null, askAt });
  assert.deepEqual(!failed.stale && [failed.answer.complete, failed.answer.reason, failed.answer.callers.length, failed.answer.retryable], [false, 'timed out', 1, true]);
  // A target's null is no calls there, as the editor's `[]`.
  const nullTarget = asker({ 40: nul });
  const both = await applyCallerExtras(/** @type {any} */ (nul), { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }]), query: null, askAt: nullTarget.askAt });
  assert.deepEqual(!both.stale && [both.ready, both.answer.complete, both.answer.callers.length], [true, true, 0]);
  // Without targets the null stays "no answer".
  const plain = await applyCallerExtras(/** @type {any} */ (nul), { ...base, extras: targetsExtras([]), query: null, askAt });
  assert.equal(!plain.stale && plain.answer.complete, false);
});

test('targets: one not answered makes the answer incomplete with its reason; moreCallers is not asked', async () => {
  let more = 0;
  const query = { isSuppressed: () => false, filter: (c) => ({ kept: c, dropped: 0 }), moreCallers: async () => { more++; return { callers: [], incompleteReason: null }; } };
  const { askAt } = asker({ 40: { ready: false, reason: 'timed out', retryable: true }, 41: { ready: false, reason: 'no call hierarchy item', retryable: false } });
  const one = await applyCallerExtras({ ready: true, rows: [row('/r/b.py', 1)] }, { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }]), query, askAt });
  assert.deepEqual(!one.stale && [one.ready, one.answer.complete, one.answer.reason, one.answer.retryable, one.answer.callers.length], [false, false, 'at another position of its callers: timed out', true, 1]);
  const two = await applyCallerExtras({ ready: true, rows: [] }, { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }, { file: '/r/a.py', pos: 41 }]), query, askAt });
  assert.equal(!two.stale && two.answer.reason, 'at another position of its callers: timed out; at another position of its callers: no call hierarchy item');
  assert.equal(!two.stale && two.answer.retryable, undefined, 'one part not retryable: not retryable');
  const rejected = await applyCallerExtras({ ready: true, rows: [] }, { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }]), query, askAt: async () => { throw new Error('boom'); } });
  assert.equal(!rejected.stale && rejected.answer.complete, false);
  assert.equal(more, 0);
  const noAsk = await applyCallerExtras({ ready: true, rows: [] }, { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }]), query: null });
  assert.equal(!noAsk.stale && noAsk.answer.complete, false, 'targets that cannot be asked: incomplete');
});

test('targets: at most MAX_CALLER_TARGETS asked; past it the answer is incomplete', async () => {
  const targets = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => ({ file: '/r/a.py', pos: 100 + i }));
  for (const n of [MAX_CALLER_TARGETS - 1, MAX_CALLER_TARGETS, MAX_CALLER_TARGETS + 1]) {
    const { asked, askAt } = asker({});
    const r = await applyCallerExtras({ ready: true, rows: [] }, { ...base, extras: targetsExtras(targets(n)), query: null, askAt });
    assert.equal(asked.length, Math.min(n, MAX_CALLER_TARGETS), `n=${n}`);
    assert.equal(!r.stale && r.answer.complete, n <= MAX_CALLER_TARGETS, `n=${n}`);
    if (n > MAX_CALLER_TARGETS) assert.match(!r.stale ? r.answer.reason || '' : '', /1 more position of its callers not asked/);
  }
});

test('targets: a query that became stale while the targets ran builds no answer', async () => {
  let stale = false;
  const r = await applyCallerExtras({ ready: true, rows: [] }, { ...base, extras: targetsExtras([{ file: '/r/a.py', pos: 40 }]), query: null, askAt: async () => { stale = true; return { ready: true, rows: [] }; }, isStale: () => stale });
  assert.deepEqual(r, { stale: true });
});

test('mergeCallerRows: a row without call sites keeps the larger count; inputs unchanged', () => {
  const a = row('/r/b.py', 1);
  const b = { ...row('/r/b.py', 1), callSites: undefined, sites: 3 };
  const merged = mergeCallerRows([[a], [/** @type {any} */ (b)]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sites, 3);
  assert.equal(a.sites, 1);
});
