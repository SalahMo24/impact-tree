// @ts-check
'use strict';

// The two commit reads of the GitHub client (listPullRequestCommits, getCommit) over an
// injected fetch: paging, the 250 cap, response validation. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHub } = require('../src/github');

const SLUG = { owner: 'o', repo: 'r' };

/** @param {(url: string) => unknown} answer  the JSON body for a URL */
async function client(answer) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const vscode = { authentication: { getSession: async () => ({ accessToken: 't', account: { label: 'me' } }) } };
  const gh = createGitHub(vscode, { fetch: fetchImpl });
  await gh.signIn();
  return { gh, urls };
}

const raw = (i, parents = 1) => ({ sha: `sha${i}`, commit: { message: `subject ${i}\n\nbody` }, parents: Array.from({ length: parents }, () => ({ sha: 'p' })) });

test('listPullRequestCommits reads the subject and the merge flag, page by page', async () => {
  const { gh, urls } = await client((url) => {
    const page = Number(/&page=(\d+)/.exec(url)?.[1]);
    return page === 1 ? Array.from({ length: 100 }, (_, i) => raw(i)) : [raw(100, 2)];
  });
  const r = await gh.listPullRequestCommits(SLUG, 3);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/repos\/o\/r\/pulls\/3\/commits\?per_page=100&page=1$/);
  assert.equal(r.commits.length, 101);
  assert.deepEqual(r.commits[0], { sha: 'sha0', subject: 'subject 0', isMerge: false });
  assert.equal(r.commits[100].isMerge, true);
  assert.equal(r.truncated, false);
});

test('listPullRequestCommits stops at its cap and says more exist', async () => {
  const { gh, urls } = await client(() => Array.from({ length: 100 }, (_, i) => raw(i)));
  const r = await gh.listPullRequestCommits(SLUG, 3, { max: 150 });
  assert.equal(r.commits.length, 150);
  assert.equal(r.truncated, true);
  assert.equal(urls.length, 2, 'no page past what the cap needs');
  const all = await gh.listPullRequestCommits(SLUG, 3);
  assert.equal(all.commits.length, 250);
  assert.equal(all.truncated, true);
});

test('listPullRequestCommits rejects a malformed answer', async () => {
  const { gh } = await client(() => ({ message: 'not a list' }));
  await assert.rejects(gh.listPullRequestCommits(SLUG, 3), /expected a list of commits/);
  const bad = await client(() => [{ sha: 'x' }]);
  await assert.rejects(bad.gh.listPullRequestCommits(SLUG, 3), /lacks a string/);
});

test('getCommit returns the changed paths and flags a full first page', async () => {
  const { gh, urls } = await client(() => ({ ...raw(1), files: [{ filename: 'a/x.ts' }, { filename: 'b.ts' }] }));
  const c = await gh.getCommit(SLUG, 'abc');
  assert.match(urls[0], /\/repos\/o\/r\/commits\/abc$/);
  assert.deepEqual(c, { sha: 'sha1', subject: 'subject 1', isMerge: false, files: ['a/x.ts', 'b.ts'], filesTruncated: false });
  const big = await client(() => ({ ...raw(1), files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) }));
  assert.equal((await big.gh.getCommit(SLUG, 'abc')).filesTruncated, true);
  const none = await client(() => raw(1));
  assert.deepEqual((await none.gh.getCommit(SLUG, 'abc')).files, []);
  const bad = await client(() => ({ ...raw(1), files: [{}] }));
  await assert.rejects(bad.gh.getCommit(SLUG, 'abc'), /lacks a string `filename`/);
});
