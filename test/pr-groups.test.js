'use strict';
// Which group an open PR is listed under. Review requests arrive two ways, to a person
// and to a team, and both must surface the PR as waiting on the signed-in user.
const test = require('node:test');
const assert = require('node:assert/strict');

const { groupPullRequests } = require('../src/pr-groups');

const pr = (number, over = {}) => ({
  number, author: 'someone', requestedReviewers: [], requestedTeams: [], ...over,
});
const team = (id, name, parentId = null) => ({ id, name, parentId });
const numbers = (prs) => prs.map((p) => p.number);
const requestedNumbers = (g) => g.requested.map((r) => r.pr.number);

test('a direct request, a team request and both at once all land in "requested"', () => {
  const g = groupPullRequests([
    pr(1, { requestedReviewers: ['me'] }),
    pr(2, { requestedTeams: [{ id: 10, name: 'backend' }] }),
    pr(3, { requestedReviewers: ['me'], requestedTeams: [{ id: 10, name: 'backend' }, { id: 11, name: 'web' }] }),
  ], { login: 'me', teams: [team(10, 'backend')] });
  assert.deepEqual(g.requested.map((r) => [r.pr.number, r.via]),
    [[1, ['you']], [2, ['backend']], [3, ['you', 'backend']]]);
  assert.deepEqual(g.mine, []);
  assert.deepEqual(g.others, []);
});

test('requests to other people and other teams do not count', () => {
  const g = groupPullRequests([
    pr(1, { requestedReviewers: ['someone-else'] }),
    pr(2, { requestedTeams: [{ id: 99, name: 'not-mine' }] }),
  ], { login: 'me', teams: [team(10, 'backend')] });
  assert.deepEqual(requestedNumbers(g), []);
  assert.deepEqual(numbers(g.others), [1, 2]);
});

test('logins match case-insensitively, as GitHub treats them', () => {
  const g = groupPullRequests([
    pr(1, { requestedReviewers: ['Me'] }),
    pr(2, { author: 'ME' }),
  ], { login: 'me', teams: [] });
  assert.deepEqual(requestedNumbers(g), [1]);
  assert.deepEqual(numbers(g.mine), [2]);
});

test('a request to the parent of one of my teams reaches me', () => {
  const g = groupPullRequests([pr(1, { requestedTeams: [{ id: 5, name: 'engineering' }] })],
    { login: 'me', teams: [team(10, 'backend', 5)] });
  assert.deepEqual(g.requested.map((r) => r.via), [['engineering']]);
});

test('my own PRs go to "mine" and everything else to "others"', () => {
  const g = groupPullRequests([pr(1, { author: 'me' }), pr(2), pr(3, { author: 'me' }), pr(4, { author: undefined })],
    { login: 'me', teams: [] });
  assert.deepEqual(numbers(g.mine), [1, 3]);
  assert.deepEqual(numbers(g.others), [2, 4]);
});

test('without a team list only direct requests are matched', () => {
  const g = groupPullRequests([
    pr(1, { requestedTeams: [{ id: 10, name: 'backend' }] }),
    pr(2, { requestedReviewers: ['me'] }),
  ], { login: 'me', teams: null });
  assert.deepEqual(requestedNumbers(g), [2]);
  assert.deepEqual(numbers(g.others), [1]);
});

test('without a login nothing is claimed as requested or mine', () => {
  const g = groupPullRequests([pr(1, { requestedReviewers: ['me'] }), pr(2, { author: 'me' })],
    { login: null, teams: [] });
  assert.deepEqual(requestedNumbers(g), []);
  assert.deepEqual(g.mine, []);
  assert.deepEqual(numbers(g.others), [1, 2]);
});

test('every PR lands in exactly one group, and each group keeps the input order', () => {
  const prs = [];
  for (let n = 1; n <= 30; n++) {
    prs.push(pr(n, {
      author: n % 4 === 0 ? 'me' : 'someone',
      requestedReviewers: n % 3 === 0 ? ['me'] : [],
      requestedTeams: n % 5 === 0 ? [{ id: 10, name: 'backend' }] : [],
    }));
  }
  const g = groupPullRequests(prs, { login: 'me', teams: [team(10, 'backend')] });
  const all = [...requestedNumbers(g), ...numbers(g.mine), ...numbers(g.others)];
  assert.equal(all.length, prs.length);
  assert.equal(new Set(all).size, prs.length);
  for (const list of [requestedNumbers(g), numbers(g.mine), numbers(g.others)]) {
    assert.deepEqual(list, [...list].sort((a, b) => a - b));
  }
  // A requested PR outranks authorship.
  assert.ok(requestedNumbers(g).includes(12) && !numbers(g.mine).includes(12));
});
