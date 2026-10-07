'use strict';
// The GitHub boundary: deadline, cancellation, streamed size limit, page cap and response
// validation. `fetch` is injected through createGitHub's documented seam, and each test
// builds its own bodies, so the limits are exercised with small numbers and no real wait.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createGitHub } = require('../src/github');
const { isAnalysisCancelled } = require('../src/engine/cancellation');
const { createSourcesProvider } = require('../src/sources-provider');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const { findTypeScript } = require('./find-typescript');

// A test written against code that ignores the seam must fail, not reach api.github.com.
global.fetch = () => { throw new Error('the real network was reached'); };

const SLUG = { owner: 'o', repo: 'r' };
const flush = () => new Promise(setImmediate);

async function client(fetchImpl, limits) {
  const vscode = { authentication: { getSession: async () => ({ accessToken: 'secret-token', account: { label: 'me' } }) } };
  const gh = createGitHub(vscode, { fetch: fetchImpl, limits });
  await gh.signIn();
  return gh;
}

// A response whose body is a stream we can watch. `chunks` are pulled one at a time, and
// `read.bytes` counts what the consumer actually took off the stream.
function streamed(chunks, { status = 200, contentType = 'application/json' } = {}) {
  const read = { bytes: 0, pulls: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      read.pulls++;
      const next = await (typeof chunks === 'function' ? chunks(i) : chunks[i]);
      i++;
      if (next === undefined) { controller.close(); return; }
      const bytes = typeof next === 'string' ? Buffer.from(next) : next;
      read.bytes += bytes.byteLength;
      controller.enqueue(new Uint8Array(bytes));
    },
    cancel() { read.cancelled = true; },
  }, { highWaterMark: 0 });
  const res = { status, ok: status >= 200 && status < 300, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? contentType : null) }, body };
  return { res, read };
}
const json = (data, status = 200) => streamed([JSON.stringify(data)], { status }).res;
const text = (s) => streamed([s], { contentType: 'text/plain' }).res;

const pr = (n, over = {}) => ({
  number: n, title: `pr ${n}`, user: { login: 'a' }, head: { ref: 'f', sha: 'h', repo: { full_name: 'o/r' } },
  base: { ref: 'main', sha: 'b', repo: { full_name: 'o/r' } }, html_url: 'u', updated_at: 't', ...over,
});

// ---- deadline ---------------------------------------------------------------------
test('a response slower than the deadline rejects with the timeout error naming the endpoint', async () => {
  for (const stall of ['headers', 'body']) {
    const gh = await client(async () => (stall === 'headers' ? new Promise(() => {}) : streamed((i) => (i === 0 ? '[' : new Promise(() => {}))).res),
      { requestTimeoutMs: 20 });
    const started = Date.now();
    await assert.rejects(gh.getPullRequest(SLUG, 7), (e) => e.name === 'GitHubTimeoutError'
      && e.message.includes('/repos/o/r/pulls/7') && !e.message.includes('secret-token') && !isAnalysisCancelled(e));
    assert.ok(Date.now() - started < 2000, `${stall}: rejected promptly`);
  }
});

test('a fetch that honours its signal is aborted by the deadline', async () => {
  let seen;
  const gh = await client((_, init) => new Promise((_, reject) => {
    seen = init.signal;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  }), { requestTimeoutMs: 20 });
  await assert.rejects(gh.mergeBase(SLUG, 'a', 'b'), (e) => e.name === 'GitHubTimeoutError');
  assert.equal(seen.aborted, true, 'the underlying request was aborted, not just abandoned');
});

test('a file fetch times out under the same deadline', async () => {
  const gh = await client(() => new Promise(() => {}), { requestTimeoutMs: 20 });
  await assert.rejects(gh.fileAtRef(SLUG, 'src/a.ts', 'head'), (e) => e.name === 'GitHubTimeoutError' && e.message.includes('src/a.ts'));
});

// ---- size, enforced while streaming -----------------------------------------------
test('an oversized JSON body is aborted after at most the limit plus one chunk', async () => {
  for (const [limit, chunk] of [[100, 40], [64, 64], [1000, 7]]) {
    const { res, read } = streamed(() => 'x'.repeat(chunk));
    const gh = await client(async () => res, { maxJsonBytes: limit });
    await assert.rejects(gh.getPullRequest(SLUG, 1), (e) => e.name === 'GitHubResponseTooLargeError' && e.message.includes('/repos/o/r/pulls/1'));
    assert.ok(read.bytes > limit && read.bytes <= limit + chunk, `limit ${limit}, chunk ${chunk}: read ${read.bytes}`);
    assert.equal(read.cancelled, true, 'the rest of the body is released');
  }
});

test('a body exactly at the limit is accepted, and one byte over is not', async () => {
  const body = JSON.stringify(pr(3));
  const exact = await client(async () => text(body), { maxJsonBytes: Buffer.byteLength(body) });
  assert.equal((await exact.getPullRequest(SLUG, 3)).number, 3);
  const over = await client(async () => text(body), { maxJsonBytes: Buffer.byteLength(body) - 1 });
  await assert.rejects(over.getPullRequest(SLUG, 3), { name: 'GitHubResponseTooLargeError' });
});

test('file bodies use the file limit, not the JSON limit', async () => {
  const { res, read } = streamed(() => 'y'.repeat(30), { contentType: 'text/plain' });
  const gh = await client(async () => res, { maxFileBytes: 50, maxJsonBytes: 10000 });
  await assert.rejects(gh.fileAtRef(SLUG, 'big.ts', 'head'), (e) => e.name === 'GitHubResponseTooLargeError' && e.message.includes('big.ts'));
  assert.ok(read.bytes > 50 && read.bytes <= 80, `read ${read.bytes}`);
  const ok = await client(async () => text('export const a = 1;\n'), { maxFileBytes: 50 });
  assert.equal(await ok.fileAtRef(SLUG, 'a.ts', 'head'), 'export const a = 1;\n');
});

// ---- cancellation -----------------------------------------------------------------
test('cancelling during the fetch aborts it, and the late body is never parsed or read', async () => {
  const controller = new AbortController();
  let release; const late = new Promise((r) => { release = r; });
  const { res, read } = streamed([JSON.stringify(pr(1))]);
  let init;
  const gh = await client((_, i) => { init = i; return late; });
  const pending = gh.getPullRequest(SLUG, 1, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(pending, (e) => isAnalysisCancelled(e) && e.message.includes('/repos/o/r/pulls/1'));
  assert.equal(init.signal.aborted, true);
  release(res);
  await flush();
  assert.equal(read.pulls, 0, 'the body that arrived after the cancel was never read');
});

test('cancelling mid-body rejects as a cancellation and stops reading', async () => {
  const controller = new AbortController();
  const { res, read } = streamed((i) => { if (i === 1) controller.abort(); return i < 5 ? 'x'.repeat(10) : undefined; });
  const gh = await client(async () => res);
  await assert.rejects(gh.listPullRequestFiles(SLUG, 1, { signal: controller.signal }), isAnalysisCancelled);
  assert.ok(read.pulls <= 3, `pulled ${read.pulls} chunks`);
  assert.equal(read.cancelled, true);
});

test('an already-cancelled signal sends no request, for JSON and file calls alike', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const gh = await client(async () => { calls++; return json({}); });
  await assert.rejects(gh.mergeBase(SLUG, 'a', 'b', { signal: controller.signal }), isAnalysisCancelled);
  await assert.rejects(gh.fileAtRef(SLUG, 'a.ts', 'h', { signal: controller.signal }), isAnalysisCancelled);
  await assert.rejects(gh.listOpenPullRequests(SLUG, { signal: controller.signal }), isAnalysisCancelled);
  assert.equal(calls, 0);
});

// ---- pagination -------------------------------------------------------------------
test('the open-PR list stops at the page cap and reports truncation only when more pages exist', async () => {
  const CAP = 3;
  for (const pages of [CAP - 1, CAP, CAP + 1, CAP + 4]) {
    const requested = [];
    const gh = await client(async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requested.push(page);
      const start = (page - 1) * 100;
      const n = page < pages ? 100 : page === pages ? 100 : 0;
      return json(Array.from({ length: n }, (_, i) => pr(start + i + 1)));
    }, { maxPullRequestPages: CAP });
    const r = await gh.listOpenPullRequests(SLUG);
    assert.equal(r.pullRequests.length, Math.min(pages, CAP) * 100, `${pages} full pages`);
    assert.equal(r.truncated, pages > CAP, `${pages} full pages: truncated`);
    assert.ok(Math.max(...requested) <= CAP + 1, `never past the lookahead page: ${requested}`);
  }
});

test('a short last page ends the list untruncated, whatever the cap', async () => {
  const gh = await client(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return json(Array.from({ length: page === 2 ? 23 : 100 }, (_, i) => pr(page * 1000 + i)));
  }, { maxPullRequestPages: 2 });
  const r = await gh.listOpenPullRequests(SLUG);
  assert.equal(r.pullRequests.length, 123);
  assert.equal(r.truncated, false);
});

test('the default cap is ten pages', async () => {
  let last = 0;
  const gh = await client(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    last = Math.max(last, page);
    return json(Array.from({ length: 100 }, (_, i) => pr(page * 1000 + i)));
  });
  const r = await gh.listOpenPullRequests(SLUG);
  assert.equal(r.pullRequests.length, 1000);
  assert.equal(r.truncated, true);
  assert.equal(last, 11);
});

// ---- validation -------------------------------------------------------------------
test('a malformed response is a named boundary error, one per validated endpoint', async () => {
  const cases = [
    ['open PR list is not an array', (gh) => gh.listOpenPullRequests(SLUG), { pulls: 'nope' }, '/repos/o/r/pulls'],
    ['open PR list item has no head', (gh) => gh.listOpenPullRequests(SLUG), [pr(1, { head: undefined })], '/repos/o/r/pulls'],
    ['a PR without a number', (gh) => gh.getPullRequest(SLUG, 4), pr(undefined), '/repos/o/r/pulls/4'],
    ['a PR whose head sha is not a string', (gh) => gh.getPullRequest(SLUG, 4), pr(4, { head: { ref: 'f', sha: 12 } }), '/repos/o/r/pulls/4'],
    ['a PR whose base is missing', (gh) => gh.getPullRequest(SLUG, 4), pr(4, { base: null }), '/repos/o/r/pulls/4'],
    ['a PR that is not an object', (gh) => gh.getPullRequest(SLUG, 4), [], '/repos/o/r/pulls/4'],
    ['a file list that is not an array', (gh) => gh.listPullRequestFiles(SLUG, 5), { files: [] }, '/repos/o/r/pulls/5/files'],
    ['a listed file without a filename', (gh) => gh.listPullRequestFiles(SLUG, 5), [{ status: 'added' }], '/repos/o/r/pulls/5/files'],
    ['a listed file with a numeric patch', (gh) => gh.listPullRequestFiles(SLUG, 5), [{ filename: 'a.ts', status: 'added', patch: 3 }], '/repos/o/r/pulls/5/files'],
    ['a compare without a merge base', (gh) => gh.mergeBase(SLUG, 'a', 'b'), { status: 'ahead' }, '/repos/o/r/compare/'],
    ['a merge base sha that is empty', (gh) => gh.mergeBase(SLUG, 'a', 'b'), { merge_base_commit: { sha: '' } }, '/repos/o/r/compare/'],
    ['a body that is not JSON', (gh) => gh.getPullRequest(SLUG, 4), '<html>proxy</html>', '/repos/o/r/pulls/4'],
    ['requested reviewers that are not a list', (gh) => gh.getPullRequest(SLUG, 4), pr(4, { requested_reviewers: { login: 'x' } }), '/repos/o/r/pulls/4'],
    ['a requested reviewer without a login', (gh) => gh.listOpenPullRequests(SLUG), [pr(4, { requested_reviewers: [{ id: 3 }] })], '/repos/o/r/pulls'],
    ['a requested team with a string id', (gh) => gh.listOpenPullRequests(SLUG), [pr(4, { requested_teams: [{ id: '7', name: 't' }] })], '/repos/o/r/pulls'],
    ['a requested team without a name', (gh) => gh.getPullRequest(SLUG, 4), pr(4, { requested_teams: [{ id: 7 }] }), '/repos/o/r/pulls/4'],
    ['an author avatar that is not a string', (gh) => gh.getPullRequest(SLUG, 4), pr(4, { user: { login: 'a', avatar_url: 5 } }), '/repos/o/r/pulls/4'],
    ['a team list that is not an array', (gh) => gh.listMyTeams(), { teams: [] }, '/user/teams'],
    ['a team without an id', (gh) => gh.listMyTeams(), [{ name: 't' }], '/user/teams'],
    ['a team with a fractional id', (gh) => gh.listMyTeams(), [{ id: 1.5, name: 't' }], '/user/teams'],
    ['a team whose parent has no id', (gh) => gh.listMyTeams(), [{ id: 1, name: 't', parent: {} }], '/user/teams'],
  ];
  for (const [name, call, body, endpoint] of cases) {
    const gh = await client(async () => (typeof body === 'string' ? text(body) : json(body)));
    await assert.rejects(call(gh), (e) => e.name === 'GitHubResponseError' && e.message.includes(endpoint)
      && !e.message.includes('secret-token'), name);
  }
});

test('well-formed responses still pass validation, including optional gaps', async () => {
  const gh = await client(async (url) => {
    if (url.includes('/files')) return json([{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@' }, { filename: 'b.png', status: 'added' }]);
    if (url.includes('/compare/')) return json({ merge_base_commit: { sha: 'abc' } });
    return json(pr(9, { user: null, head: { ref: 'f', sha: 'h', repo: null }, changed_files: 4 }));
  });
  const p = await gh.getPullRequest(SLUG, 9);
  assert.deepEqual([p.number, p.author, p.headRepo, p.changedFiles], [9, null, null, 4]);
  assert.equal((await gh.listPullRequestFiles(SLUG, 9)).files.length, 2);
  assert.equal(await gh.mergeBase(SLUG, 'a', 'b'), 'abc');
});

test('review requests are read from the PR, and a PR without them has none', async () => {
  const gh = await client(async () => json([
    pr(1, { requested_reviewers: [{ login: 'x' }, { login: 'y' }], requested_teams: [{ id: 7, name: 'backend', slug: 'backend' }] }),
    pr(2, { requested_reviewers: null }),
    pr(3),
  ]));
  const [a, b, c] = (await gh.listOpenPullRequests(SLUG)).pullRequests;
  assert.deepEqual([a.requestedReviewers, a.requestedTeams], [['x', 'y'], [{ id: 7, name: 'backend' }]]);
  for (const p of [b, c]) assert.deepEqual([p.requestedReviewers, p.requestedTeams], [[], []]);
});

test('an author avatar is asked for at row size, and only an https URL is kept', async () => {
  const cases = [
    ['https://avatars.githubusercontent.com/u/9?v=4', 'https://avatars.githubusercontent.com/u/9?v=4&s=32'],
    ['https://avatars.githubusercontent.com/u/9?s=460', 'https://avatars.githubusercontent.com/u/9?s=32'],
    ['https://avatars.githubusercontent.com/in/15368', 'https://avatars.githubusercontent.com/in/15368?s=32'],
    ['http://avatars.example/u/9', null],
    ['javascript:alert(1)', null],
    ['not a url', null],
    [undefined, null],
  ];
  const gh = await client(async () => json(cases.map(([avatar], i) => pr(i + 1, { user: { login: 'a', avatar_url: avatar } }))));
  const got = (await gh.listOpenPullRequests(SLUG)).pullRequests.map((p) => p.authorAvatarUrl);
  assert.deepEqual(got, cases.map(([, want]) => want));
});

test('teams carry their parent, and the team list stops at its page cap like the PR list', async () => {
  const one = await client(async () => json([{ id: 1, name: 'web', parent: { id: 9 } }, { id: 2, name: 'all', parent: null }, { id: 3, name: 'ops' }]));
  assert.deepEqual(await one.listMyTeams(), { teams: [
    { id: 1, name: 'web', parentId: 9 }, { id: 2, name: 'all', parentId: null }, { id: 3, name: 'ops', parentId: null },
  ], truncated: false });

  const CAP = 2;
  for (const pages of [CAP - 1, CAP, CAP + 1]) {
    const requested = [];
    const gh = await client(async (url) => {
      const u = new URL(url);
      assert.equal(u.pathname, '/user/teams');
      const page = Number(u.searchParams.get('page'));
      requested.push(page);
      return json(page <= pages ? Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, name: `t${i}` })) : []);
    }, { maxTeamPages: CAP });
    const r = await gh.listMyTeams();
    assert.equal(r.teams.length, Math.min(pages, CAP) * 100, `${pages} full pages`);
    assert.equal(r.truncated, pages > CAP, `${pages} full pages: truncated`);
    assert.ok(Math.max(...requested) <= CAP + 1, `never past the lookahead page: ${requested}`);
  }
});

// ---- statuses ---------------------------------------------------------------------
test('statuses keep their meaning: 401 signs out, other failures name the endpoint, 404 is an absent file', async () => {
  const unauthorised = await client(async () => json({}, 401));
  await assert.rejects(unauthorised.getPullRequest(SLUG, 1), { name: 'GitHubAuthError', message: /rejected the token \(401\)/ });
  assert.equal(unauthorised.isSignedIn(), false);
  const files401 = await client(async () => json({}, 401));
  await assert.rejects(files401.fileAtRef(SLUG, 'a.ts', 'h'), { name: 'GitHubAuthError' });
  assert.equal(files401.isSignedIn(), false);

  const broken = await client(async () => json({}, 502));
  await assert.rejects(broken.fileAtRef(SLUG, 'a.ts', 'h'), (e) => e.name === 'GitHubHttpError' && e.status === 502 && e.message.includes('a.ts'));
  await assert.rejects(broken.getPullRequest(SLUG, 1), (e) => e.name === 'GitHubHttpError' && e.message.includes('/repos/o/r/pulls/1'));
  assert.equal(broken.isSignedIn(), true);

  const missing = await client(async () => json({}, 404));
  assert.equal(await missing.fileAtRef(SLUG, 'gone.ts', 'h'), null);
});

test('the token reaches GitHub but never an error message', async () => {
  let auth;
  const gh = await client(async (_, init) => { auth = init.headers.Authorization; return json({}, 500); });
  await assert.rejects(gh.mergeBase(SLUG, 'a', 'b'), (e) => !/secret-token/.test(e.message));
  assert.equal(auth, 'Bearer secret-token');
});

// ---- sources view -----------------------------------------------------------------
test('the sources view warns when the open-PR list was truncated, and only then', async () => {
  const vscodeStub = {
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  };
  const list = [{ number: 1, title: 't', author: 'a', headRef: 'f', baseRef: 'main', draft: false, isFork: false, updatedAt: 't',
    requestedReviewers: [], requestedTeams: [] }];
  const rows = async (truncated) => createSourcesProvider(vscodeStub, {
    modes: {}, getMode: () => 'pr', getRepoSlug: () => SLUG, github: { isSignedIn: () => true, account: () => 'me' },
    getPrs: () => list, getPrsTruncated: () => truncated, getPrError: () => null, isLoadingPrs: () => false,
  }).getChildren({ key: 'prs' });
  const full = await rows(true);
  assert.equal(full.length, 4, 'the three PR groups, then one warning');
  assert.equal(full[3].icon, 'warning');
  assert.match(full[3].label, /first 1 open pull request/i);
  assert.ok((await rows(false)).every((r) => r.type === 'group'));
});

// ---- PR preview -------------------------------------------------------------------
const ts = findTypeScript();
test('a file that is too large or too slow is skipped with the fetch-failed warning, and the preview stays incomplete', { skip: !ts && 'no typescript resolvable' }, async () => {
  const files = ['small.ts', 'huge.ts', 'slow.ts'];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/pulls/1')) return json(pr(1, { head: { ref: 'f', sha: 'head' }, base: { ref: 'main', sha: 'tip' }, changed_files: 3 }));
    if (u.pathname.includes('/compare/')) return json({ merge_base_commit: { sha: 'base' } });
    if (u.pathname.endsWith('/files')) return json(files.map((f) => ({ filename: f, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' })));
    if (u.pathname.endsWith('/contents/slow.ts')) return new Promise(() => {});
    if (u.pathname.endsWith('/contents/huge.ts')) return streamed(() => 'z'.repeat(40), { contentType: 'text/plain' }).res;
    if (u.pathname.endsWith('.json')) return json({}, 404);
    return text(u.searchParams.get('ref') === 'head' ? 'export function a(x: string) { return 1; }\n' : 'export function a() { return 0; }\n');
  };
  const gh = await client(fetchImpl, { maxFileBytes: 100, requestTimeoutMs: 50 });
  try {
    const result = await analyzeRemote({
      ts, gh, slug: SLUG, pr: { number: 1, headSha: 'head', baseSha: 'tip' }, repoRoot: path.resolve('/remote'), concurrency: 3,
    });
    const warnings = result.warnings.join('\n');
    assert.match(warnings, /huge\.ts: head fetch failed — .*larger than/);
    assert.match(warnings, /slow\.ts: head fetch failed — .*did not answer/);
    assert.match(warnings, /slow\.ts: base fetch failed/);
    assert.ok(result.warnings.length >= 4, 'every failed side is reported');
  } finally { clearVirtualText(); }
});

test('analyzeRemote hands its signal to every GitHub call, including the configuration reads', { skip: !ts && 'no typescript resolvable' }, async () => {
  const controller = new AbortController();
  const seen = {};
  const note = (name) => (...args) => { (seen[name] = seen[name] || []).push(args[args.length - 1]); };
  const track = (name, fn) => async (...args) => { note(name)(...args); return fn(...args); };
  const gh = {
    getPullRequest: track('getPullRequest', async () => ({ number: 1, headSha: 'head', baseSha: 'tip', baseRef: 'main' })),
    mergeBase: track('mergeBase', async () => 'base'),
    listPullRequestFiles: track('listPullRequestFiles', async () => ({
      total: 1, files: [{ path: 'a.ts', oldPath: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }] })),
    fileAtRef: track('fileAtRef', async (_s, p) => (p === 'a.ts' ? 'export function a(x: string) { return 1; }\n' : null)),
  };
  try {
    await analyzeRemote({ ts, gh, slug: SLUG, pr: { number: 1 }, repoRoot: path.resolve('/remote'), concurrency: 1, signal: controller.signal });
  } finally { clearVirtualText(); }
  for (const name of ['getPullRequest', 'mergeBase', 'listPullRequestFiles', 'fileAtRef']) {
    assert.ok(seen[name] && seen[name].length, `${name} was called`);
    for (const options of seen[name]) assert.equal(options.signal, controller.signal, `${name} received the signal`);
  }
  assert.ok(seen.fileAtRef.length > 2, 'file fetches and the tsconfig/package.json reads all carry it');
});

// ---- GraphQL and writes (L1) ------------------------------------------------------
// A response with chosen headers; `streamed` only knows content-type.
function withHeaders(status, headers, data = {}) {
  const { res } = streamed([JSON.stringify(data)], { status });
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  res.headers = { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : lower[n.toLowerCase()] ?? null) };
  return res;
}

test('graphql POSTs the query and variables as JSON to /graphql with auth headers', async () => {
  const calls = [];
  const gh = await client(async (url, init) => { calls.push({ url, init }); return json({ data: { viewer: { login: 'me' } } }); });
  const data = await gh.graphql('query($n:Int!){ x(n:$n) }', { n: 3 });
  assert.deepEqual(data, { viewer: { login: 'me' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'query($n:Int!){ x(n:$n) }', variables: { n: 3 } });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
});

test('reads stay GET with no body and no content type', async () => {
  const calls = [];
  const gh = await client(async (url, init) => { calls.push(init); return json(pr(1)); });
  await gh.getPullRequest(SLUG, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers['Content-Type'], undefined);
});

test('graphql errors reject with messages and paths, with or without partial data', async () => {
  const errors = [{ message: 'boom', path: ['repository', 'pullRequest', 0] }, { message: 'second' }];
  for (const envelope of [{ errors }, { data: { repository: null }, errors }]) {
    const gh = await client(async () => json(envelope));
    await assert.rejects(gh.graphql('{ x }'), (e) => e.name === 'GitHubGraphQLError'
      && JSON.stringify(e.messages) === '["boom","second"]'
      && JSON.stringify(e.errors[0].path) === '["repository","pullRequest",0]' && e.errors[1].path === null
      && e.message.includes('boom'));
  }
});

test('a graphql answer that is not a valid envelope is a response error', async () => {
  for (const body of [[], 'x', { data: null }, {}, { data: {}, errors: 'bad' }, { errors: [{ nope: 1 }] }, { errors: [{ message: 'm', path: [{}] }] }]) {
    const gh = await client(async () => json(body));
    await assert.rejects(gh.graphql('{ x }'), { name: 'GitHubResponseError' }, JSON.stringify(body));
  }
  const gh = await client(async () => json({ data: {}, errors: [] }));
  assert.deepEqual(await gh.graphql('{ x }'), {}, 'an empty errors array is not an error');
});

test('graphql rejects bad arguments before sending anything', async () => {
  let sent = 0;
  const gh = await client(async () => { sent++; return json({ data: {} }); });
  await assert.rejects(gh.graphql(''), TypeError);
  await assert.rejects(gh.graphql('{ x }', [1]), TypeError);
  assert.equal(sent, 0);
});

test('graphql 401 signs out; plain 403 stays an HTTP error and keeps the session', async () => {
  const unauthorised = await client(async () => json({}, 401));
  await assert.rejects(unauthorised.graphql('{ x }'), { name: 'GitHubAuthError' });
  assert.equal(unauthorised.isSignedIn(), false);
  const forbidden = await client(async () => withHeaders(403, { 'x-ratelimit-remaining': '4999' }));
  await assert.rejects(forbidden.graphql('{ x }'), (e) => e.name === 'GitHubHttpError' && e.status === 403);
  assert.equal(forbidden.isSignedIn(), true);
  const bare = await client(async () => withHeaders(403, {}));
  await assert.rejects(bare.graphql('{ x }'), { name: 'GitHubHttpError' });
});

test('rate limits become GitHubRateLimitError with the reset time when given, and keep the session', async () => {
  const resetSeconds = 1893456000;
  const cases = [
    [withHeaders(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': resetSeconds }), 403, resetSeconds * 1000],
    [withHeaders(403, { 'x-ratelimit-remaining': '0' }), 403, null],
    [withHeaders(429, { 'x-ratelimit-reset': resetSeconds }), 429, resetSeconds * 1000],
    [withHeaders(429, {}), 429, null],
    [withHeaders(429, { 'retry-after': 'soon' }), 429, null],
    // a secondary rate limit: requests remain, but GitHub asks to wait
    [withHeaders(403, { 'x-ratelimit-remaining': '4000', 'retry-after': '0' }), 403, 'now'],
  ];
  for (const [res, status, resetAt] of cases) {
    const gh = await client(async () => res);
    await assert.rejects(gh.graphql('{ x }'), (e) => e.name === 'GitHubRateLimitError'
      && e.status === status && (resetAt === 'now' ? Math.abs(e.resetAt - Date.now()) < 5000 : e.resetAt === resetAt));
    assert.equal(gh.isSignedIn(), true);
  }
  const before = Date.now();
  const gh = await client(async () => withHeaders(429, { 'retry-after': '60' }));
  await assert.rejects(gh.graphql('{ x }'), (e) => e.name === 'GitHubRateLimitError'
    && e.resetAt >= before + 60000 && e.resetAt <= Date.now() + 60000);
  const rest = await client(async () => withHeaders(429, { 'retry-after': '5', 'x-ratelimit-reset': resetSeconds }));
  await assert.rejects(rest.getPullRequest(SLUG, 1), (e) => e.name === 'GitHubRateLimitError' && e.resetAt < resetSeconds * 1000);
});

test('a rate-limited request is sent once, never retried', async () => {
  let sent = 0;
  const gh = await client(async () => { sent++; return withHeaders(429, { 'retry-after': '0' }); });
  await assert.rejects(gh.graphql('mutation { x }'), { name: 'GitHubRateLimitError' });
  assert.equal(sent, 1);
});

test('graphql honours the deadline, the size limit and the caller signal', async () => {
  const slow = await client(() => new Promise(() => {}), { requestTimeoutMs: 20 });
  await assert.rejects(slow.graphql('{ x }'), (e) => e.name === 'GitHubTimeoutError' && e.message.includes('/graphql'));

  const { res, read } = streamed(['{"data":{"a":"', 'x'.repeat(50), '"}}']);
  const big = await client(async () => res, { maxJsonBytes: 20 });
  await assert.rejects(big.graphql('{ x }'), { name: 'GitHubResponseTooLargeError' });
  assert.equal(read.cancelled, true);

  let sent = 0;
  const controller = new AbortController();
  controller.abort();
  const gh = await client(async () => { sent++; return json({ data: {} }); });
  await assert.rejects(gh.graphql('{ x }', {}, { signal: controller.signal }),
    (e) => e.name === 'GitHubCancelledError' && isAnalysisCancelled(e));
  assert.equal(sent, 0);

  const mid = new AbortController();
  const late = await client((_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    setImmediate(() => mid.abort());
  }));
  await assert.rejects(late.graphql('{ x }', {}, { signal: mid.signal }), { name: 'GitHubCancelledError' });
});

test('a GraphQL RATE_LIMITED error is a rate limit; other types are kept on the error', async () => {
  const limited = await client(async () => json({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }));
  await assert.rejects(limited.graphql('{ x }'), (e) => e.name === 'GitHubRateLimitError' && e.status === 200);
  assert.equal(limited.isSignedIn(), true);
  const missing = await client(async () => json({ data: { node: null }, errors: [{ type: 'NOT_FOUND', message: 'gone', path: ['node'] }] }));
  await assert.rejects(missing.graphql('{ x }'), (e) => e.name === 'GitHubGraphQLError' && e.errors[0].type === 'NOT_FOUND');
});
