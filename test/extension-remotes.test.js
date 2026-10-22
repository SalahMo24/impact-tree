'use strict';
// A GitHub remote that is not named origin, and pull requests from forks, through the real
// extension: the repository the requests name, the remote a checkout fetches from, and what
// the sources view says when there is no single answer. Nothing sleeps; the network is a
// fake `fetch` that records URLs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, pull, shaFor } = require('./extension-env');

const FORK = 'https://github.com/me/repo.git';
const BASE = 'https://github.com/org/repo.git';
const SESSION = { accessToken: 'token', account: { label: 'me' } };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

// A fetch that answers every list with an empty page and records the URLs asked for.
const network = (answers = {}) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const hit = Object.keys(answers).find((k) => url.includes(k));
    return new Response(JSON.stringify(hit ? answers[hit] : []), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { urls, fetchImpl, pulls: () => urls.filter((u) => /\/pulls\?/.test(u)) };
};

const forkSetup = (extra = {}) => ({ remotes: [['origin', FORK], ['upstream', BASE]], authSession: SESSION, ...extra });

const rawPr = (number, { headRepo = 'org/repo', baseRepo = 'org/repo' } = {}) => ({
  number, title: `PR ${number}`, user: { login: 'someone' }, html_url: `https://github.com/${baseRepo}/pull/${number}`,
  head: { ref: `head${number}`, sha: shaFor(number), repo: { full_name: headRepo } },
  base: { ref: 'main', sha: shaFor(9), repo: { full_name: baseRepo } },
});

test('with origin as the fork and upstream as the base, the PR list asks upstream', async () => {
  const net = network();
  await withEnv(async (env) => {
    await settle();
    assert.ok(net.pulls().length > 0, 'the list was requested');
    for (const u of net.pulls()) assert.match(u, /^https:\/\/api\.github\.com\/repos\/org\/repo\/pulls\?/);
    assert.ok(!net.urls.some((u) => u.includes('/repos/me/')), 'the fork was never asked');
    assert.deepEqual(env.seen.errors, []);
  }, forkSetup({ fetch: net.fetchImpl }));
});

test('with impactTree.githubRemote set to origin, the requests use origin\'s repository', async () => {
  const net = network();
  await withEnv(async () => {
    await settle();
    assert.ok(net.pulls().length > 0);
    for (const u of net.pulls()) assert.match(u, /\/repos\/me\/repo\/pulls\?/);
  }, forkSetup({ fetch: net.fetchImpl, settings: { githubRemote: 'origin' } }));
});

test('changing the setting reloads the list from the other repository', async () => {
  const net = network();
  await withEnv(async (env) => {
    await settle();
    net.urls.length = 0;
    env.changeSetting('githubRemote', 'origin');
    await settle();
    assert.ok(net.pulls().length > 0 && net.pulls().every((u) => /\/repos\/me\/repo\/pulls\?/.test(u)), net.urls.join('\n'));
    net.urls.length = 0;
    env.changeSetting('githubRemote', '');
    await settle();
    assert.ok(net.pulls().every((u) => /\/repos\/org\/repo\/pulls\?/.test(u)));
  }, forkSetup({ fetch: net.fetchImpl }));
});

test('the review GraphQL names the upstream owner and repository', async () => {
  const calls = [];
  await withEnv(async (env) => {
    env.hooks.remoteResult = (pr) => ({ ...require('./extension-env').previewResult(pr), headSha: shaFor(7) });
    await env.preview({ ...pull(7), headSha: shaFor(7) });
    await settle();
    assert.ok(calls.length > 0, 'the review store queried GitHub');
    for (const v of calls) assert.deepEqual([v.owner, v.name], ['org', 'repo']);
  }, forkSetup({ graphql: async (_query, variables) => { calls.push(variables); throw new Error('stop here'); } }));
});

test('a checkout fetches pull/<n>/head from upstream, not origin', async () => {
  await withEnv(async (env) => {
    await env.openPullRequest(pull(7), 'analyse');
    assert.deepEqual(env.git.fetches, [7]);
    assert.deepEqual(env.git.fetchRemotes, ['upstream']);
    assert.deepEqual(env.seen.errors, []);
    assert.deepEqual(env.seen.analyzeRemotes, ['upstream'], 'the base is read from the same remote');
  }, forkSetup());
});

test('a checkout with the setting on origin fetches from origin', async () => {
  await withEnv(async (env) => {
    await env.openPullRequest(pull(7), 'analyse');
    assert.deepEqual(env.git.fetchRemotes, ['origin']);
  }, forkSetup({ settings: { githubRemote: 'origin' } }));
});

test('a fork PR previews against the base repository at its head commit, and checks out from the same remote', async () => {
  const net = network();
  await withEnv(async (env) => {
    const fork = { ...pull(5), headSha: shaFor(5), isFork: true, headRepo: 'someone/repo' };
    await env.preview(fork);
    assert.deepEqual(env.seen.remote, [5]);
    assert.deepEqual(env.seen.remoteSlugs, [{ owner: 'org', repo: 'repo' }], 'files are read through the base repository');
    await env.openPullRequest(fork, 'analyse');
    assert.deepEqual(env.git.fetchRemotes, ['upstream']);
    assert.deepEqual(env.git.checkouts.map((c) => c.commit), [shaFor(5)]);
    assert.deepEqual(env.seen.errors, []);
  }, forkSetup({ fetch: net.fetchImpl }));
});

test('a fork PR listed by GitHub says only where it comes from', async () => {
  const net = network({ '/pulls?': [rawPr(5, { headRepo: 'someone/repo' })] });
  await withEnv(async (env) => {
    await settle();
    const sources = env.sources();
    const [, prs] = await sources.getChildren();
    const groups = await sources.getChildren(prs);
    const rows = (await Promise.all(groups.map((g) => sources.getChildren(g)))).flat();
    const row = rows.find((r) => r.type === 'pr');
    assert.ok(row, 'the fork PR is listed');
    assert.match(row.tooltip, /From fork someone\/repo\.$/);
    assert.ok(!/fetch/.test(row.tooltip));
  }, forkSetup({ fetch: net.fetchImpl }));
});

test('several GitHub remotes with no upstream or origin: the list says so, no request is made, no checkout runs', async () => {
  const net = network();
  await withEnv(async (env) => {
    await settle();
    assert.deepEqual(net.urls, [], 'no request was made');
    const sources = env.sources();
    const [, prs] = await sources.getChildren();
    const [row] = await sources.getChildren(prs);
    assert.match(row.desc, /Several remotes point at github\.com \(a, b\); set impactTree\.githubRemote/);
    assert.ok(!/No GitHub remote/.test(row.label), 'not shown as "no pull requests" or "no remote"');
    await env.openPullRequest(pull(7), 'analyse');
    assert.deepEqual(env.git.fetches, []);
    assert.equal(env.seen.modals, 0);
    assert.match(env.seen.errors[0], /cannot check out PR #7\. Several remotes point at github\.com/);
  }, { remotes: [['a', 'https://github.com/x/repo.git'], ['b', 'https://github.com/y/repo.git']], authSession: SESSION, fetch: net.fetchImpl });
});

test('a setting naming a missing remote is shown and nothing falls back', async () => {
  const net = network();
  await withEnv(async (env) => {
    await settle();
    assert.deepEqual(net.urls, []);
    const sources = env.sources();
    const [, prs] = await sources.getChildren();
    const [row] = await sources.getChildren(prs);
    assert.match(row.desc, /impactTree\.githubRemote is 'gone', which is not a remote of this repository/);
    await env.openPullRequest(pull(7), 'analyse');
    assert.deepEqual(env.git.fetches, []);
  }, forkSetup({ fetch: net.fetchImpl, settings: { githubRemote: 'gone' } }));
});

test('a repository with no GitHub remote keeps origin as the base remote and says there is no remote', async () => {
  await withEnv(async (env) => {
    await env.refresh();
    assert.deepEqual(env.seen.analyzeRemotes, ['origin']);
    const sources = env.sources();
    const [, prs] = await sources.getChildren();
    const [row] = await sources.getChildren(prs);
    assert.match(row.label, /No GitHub remote/);
  }, { remotes: [['origin', 'https://gitlab.com/o/r.git']] });
});

test('an ambiguous choice or a bad setting stops the analysis instead of diffing against origin', async () => {
  await withEnv(async (env) => {
    await env.refresh();
    assert.deepEqual(env.seen.analyzeRemotes, [], 'nothing was analysed');
    assert.ok(env.seen.errors.some((m) => /Cannot resolve the base branch: Several remotes point at github\.com \(a, b\)/.test(m)), env.seen.errors.join('\n'));
  }, { remotes: [['origin', 'https://gitlab.com/o/r.git'], ['a', 'https://github.com/x/repo.git'], ['b', 'https://github.com/y/repo.git']] });
  await withEnv(async (env) => {
    await env.refresh();
    assert.deepEqual(env.seen.analyzeRemotes, []);
    assert.ok(env.seen.errors.some((m) => /Cannot resolve the base branch: impactTree\.githubRemote is 'gone'/.test(m)), env.seen.errors.join('\n'));
  }, forkSetup({ settings: { githubRemote: 'gone' } }));
});

test('a review stays on its repository when the setting moves the GitHub remote', async () => {
  const calls = [];
  await withEnv(async (env) => {
    const pr = { ...pull(7), headSha: shaFor(7), baseRepo: 'org/repo' };
    env.hooks.remoteResult = (p) => ({ ...require('./extension-env').previewResult(p), headSha: shaFor(7) });
    await env.preview(pr);
    await settle();
    assert.ok(calls.length > 0 && calls.every((v) => v.owner === 'org'));
    calls.length = 0;
    env.changeSetting('githubRemote', 'origin');
    await settle();
    assert.ok(!calls.some((v) => v.owner === 'me'), 'the same number on the fork was never read');
    await env.openPullRequest(pr, 'analyse');
    assert.deepEqual(env.git.fetches, [], 'nor checked out');
    assert.ok(env.seen.errors.some((m) => /PR #7\. Pull request #7 is in org\/repo, but the GitHub remote is now me\/repo/.test(m)), env.seen.errors.join('\n'));
  }, forkSetup({ graphql: async (_query, variables) => { calls.push(variables); throw new Error('stop here'); } }));
});
