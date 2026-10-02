'use strict';
// The call-site rules, on small supplied inputs. No disk, no analysis: line positions
// come from the `lineOfOffset` the test hands in (here one line per 10 offsets).
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCallSiteUpdates, classifyCallerUpdateState } = require('../src/engine/call-sites');

const lineOfOffset = (offset) => (offset == null || offset < 0 ? null : Math.floor(offset / 10) + 1);
const site = (startLine, endLine = startLine) => ({ start: (startLine - 1) * 10, end: (endLine - 1) * 10 + 3 });
const classify = (callSites, changedLineRanges) => classifyCallSiteUpdates({ callSites, changedLineRanges, lineOfOffset });

test('every site on an edited line is updated', () => {
  const [a, b] = [site(2), site(8)];
  assert.deepEqual(classify([a, b], [[2, 2], [7, 9]]), { updated: [a, b], untouched: [], unknown: [] });
});

test('one edited site and one untouched site are reported separately', () => {
  const [a, b] = [site(2), site(8)];
  assert.deepEqual(classify([a, b], [[2, 3]]), { updated: [a], untouched: [b], unknown: [] });
});

test('a site with no known line is unknown, whether its start or its end is missing', () => {
  const [a, noStart, noEnd] = [site(2), { start: -1, end: 5 }, { start: 5, end: -1 }];
  assert.deepEqual(classify([a, noStart, noEnd], [[2, 2]]), { updated: [a], untouched: [], unknown: [noStart, noEnd] });
  assert.deepEqual(classify([noStart], undefined), { updated: [], untouched: [], unknown: [noStart] });
});

test('a call spanning several lines is updated when a range touches either end or the middle', () => {
  const multi = site(4, 6);
  assert.deepEqual(classify([multi], [[6, 6]]).updated, [multi], 'overlap only at the end line');
  assert.deepEqual(classify([multi], [[1, 4]]).updated, [multi], 'overlap only at the start line');
  assert.deepEqual(classify([multi], [[5, 5]]).updated, [multi], 'edit inside the span');
  assert.deepEqual(classify([multi], [[7, 9]]).untouched, [multi], 'one line after the end');
  assert.deepEqual(classify([multi], [[1, 3]]).untouched, [multi], 'one line before the start');
});

test('a deletion-gap marker updates only a site whose span contains the gap', () => {
  // [N + 0.5, N + 0.5]: lines were deleted between new lines N and N + 1
  const marker = [[5.5, 5.5]];
  const [onFive, onSix, across, endsAtFive, startsAtSix] = [site(5), site(6), site(5, 6), site(3, 5), site(6, 8)];
  const result = classify([onFive, onSix, across, endsAtFive, startsAtSix], marker);
  assert.deepEqual(result.updated, [across]);
  assert.deepEqual(result.untouched, [onFive, onSix, endsAtFive, startsAtSix]);
});

test('a file with no changed ranges leaves every positioned site untouched', () => {
  const [a, unplaced] = [site(2), { start: -1, end: -1 }];
  for (const none of [undefined, []]) {
    assert.deepEqual(classify([a, unplaced], none), { updated: [], untouched: [a], unknown: [unplaced] });
  }
});

test('missing or empty call sites classify nothing', () => {
  const nothing = { updated: [], untouched: [], unknown: [] };
  assert.deepEqual(classify([], [[1, 99]]), nothing);
  assert.deepEqual(classify(undefined, [[1, 99]]), nothing);
  assert.deepEqual(classify(null, undefined), nothing);
});

test('the input site objects are returned, not copies', () => {
  const a = { ...site(2), via: 'import' };
  assert.equal(classify([a], [[2, 2]]).updated[0], a);
});

test('a caller is updated at the call only when every call site is updated', () => {
  const updated = [site(1)], other = [site(5)];
  const state = (callSiteUpdates, callerChanged) => classifyCallerUpdateState({ callSiteUpdates, callerChanged });
  for (const callerChanged of [true, false]) {
    assert.equal(state({ updated, untouched: [], unknown: [] }, callerChanged), 'updated-at-call', `changed=${callerChanged}`);
  }
  assert.equal(state({ updated, untouched: other, unknown: [] }, true), 'changed-elsewhere');
  assert.equal(state({ updated, untouched: other, unknown: [] }, false), 'unchanged');
  assert.equal(state({ updated, untouched: [], unknown: other }, true), 'changed-elsewhere');
  assert.equal(state({ updated, untouched: [], unknown: other }, false), 'unchanged');
  assert.equal(state({ updated: [], untouched: other, unknown: [] }, true), 'changed-elsewhere');
  assert.equal(state({ updated: [], untouched: [], unknown: other }, false), 'unchanged');
});

test('a caller with no call-site evidence is never updated at the call', () => {
  const none = { updated: [], untouched: [], unknown: [] };
  assert.equal(classifyCallerUpdateState({ callSiteUpdates: none, callerChanged: true }), 'changed-elsewhere');
  assert.equal(classifyCallerUpdateState({ callSiteUpdates: none, callerChanged: false }), 'unchanged');
});
