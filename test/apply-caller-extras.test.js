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
  assert.deepEqual(r, { stale: false, answer: { callers: [], complete: false, reason: 'timed out', retryable: true }, explainedReason: null, dropped: 0, added: 0 });
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
