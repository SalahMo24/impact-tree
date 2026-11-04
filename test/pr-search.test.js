'use strict';
// The rows of the "Search pull requests" picker and the recent list behind it. Users with
// many open PRs find one by number, title or author; a number that is not loaded must
// still be reachable through a GitHub lookup.
const test = require('node:test');
const assert = require('node:assert/strict');

const { searchRows, lookupNumber, addRecent, readRecent, rememberOpened, MAX_RECENT } = require('../src/github/pr-search');

const pr = (number, over = {}) => ({
  number, title: `PR ${number}`, author: 'someone', requestedReviewers: [], requestedTeams: [], ...over,
});
const shape = (rows) => rows.map((r) => (r.kind === 'separator' ? `-- ${r.label}` : r.pr.number));

test('rows follow the sidebar groups, and empty groups get no separator', () => {
  const rows = searchRows([pr(1), pr(2, { author: 'me' }), pr(3, { requestedReviewers: ['me'] })],
    { login: 'me', teams: [] });
  assert.deepEqual(shape(rows), ['-- Review requested', 3, '-- Yours', 2, '-- Everyone else', 1]);
  assert.deepEqual(shape(searchRows([pr(1)], { login: 'me', teams: [] })), ['-- Everyone else', 1]);
});

test('recently opened PRs come first, most recent first, and are not listed twice', () => {
  const rows = searchRows([pr(1), pr(2), pr(3)], { login: 'me', teams: [], recent: [3, 99, 1] });
  assert.deepEqual(shape(rows), ['-- Recently opened', 3, 1, '-- Everyone else', 2]);
});

test('a row shows number and title in the label, author and state in the description', () => {
  const [, row] = searchRows([pr(482, { title: 'Retry webhooks', author: 'priya', draft: true, isFork: true })],
    { login: 'me', teams: [] });
  assert.equal(row.label, '#482  Retry webhooks');
  assert.equal(row.description, 'priya  ·  draft  ·  fork');
  const [, req] = searchRows([pr(5, { requestedTeams: [{ id: 1, name: 'web' }] })], { login: 'me', teams: [{ id: 1, name: 'web', parentId: null }] });
  assert.equal(req.description, 'someone  ·  via web');
});

test('a number not in the loaded list is offered as a GitHub lookup', () => {
  const prs = [pr(482), pr(45)];
  assert.equal(lookupNumber('9123', prs), 9123);
  assert.equal(lookupNumber(' #9123 ', prs), 9123);
  assert.equal(lookupNumber('482', prs), null, 'loaded already');
  assert.equal(lookupNumber('#45', prs), null);
  assert.equal(lookupNumber('auth', prs), null);
  assert.equal(lookupNumber('45 fix', prs), null);
  assert.equal(lookupNumber('#0', prs), null);
  assert.equal(lookupNumber('', prs), null);
});

test('the recent list moves a PR to the front and stays short', () => {
  assert.deepEqual(addRecent([1, 2, 3], 2), [2, 1, 3]);
  let list = [];
  for (let n = 1; n <= MAX_RECENT + 2; n++) list = addRecent(list, n);
  assert.equal(list.length, MAX_RECENT);
  assert.equal(list[0], MAX_RECENT + 2);
});

test('recent lists are kept per repository and survive bad stored values', async () => {
  const store = new Map();
  const state = { get: (k) => store.get(k), update: async (k, v) => { store.set(k, v); } };
  const a = { owner: 'o', repo: 'a' };
  const b = { owner: 'o', repo: 'b' };
  await rememberOpened(state, a, 1);
  await rememberOpened(state, a, 2);
  await rememberOpened(state, b, 7);
  assert.deepEqual(readRecent(state, a), [2, 1]);
  assert.deepEqual(readRecent(state, b), [7]);
  store.set('impactTree.recentPullRequests', { 'o/a': ['x', 3] });
  assert.deepEqual(readRecent(state, a), [3]);
  store.set('impactTree.recentPullRequests', 'garbage');
  assert.deepEqual(readRecent(state, a), []);
});
