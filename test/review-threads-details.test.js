'use strict';
// Review threads through the real activate() (L5): the real review store loads a PR
// preview's threads from a fake GraphQL client, and the test reads what the tree, its
// message and the context keys show. Details shows no threads: they are in the tree and
// the diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withEnv, finding, previewResult, pull, overviewAnswer } = require('./extension-env');

const HEAD = 'a'.repeat(40);
const PR = { ...pull(7), headSha: HEAD };
// The GitHub a test answers through; each test sets it before its preview loads.
let github = null;
const OPTIONS = { graphql: (...args) => github.graphql(...args) };

const rawComment = (id, over = {}) => ({ id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', state: 'SUBMITTED', viewerDidAuthor: false, viewerCanUpdate: false, url: `https://x/${id}`, diffHunk: '', commit: null, originalCommit: null, originalLine: null, originalStartLine: null, ...over });
const rawThread = (id, over = {}, comments = [rawComment(id)]) => ({ id: `T_${id}`, isResolved: false, isOutdated: false, path: 'a.ts',
  line: 11, originalLine: 11, startLine: null, originalStartLine: null, diffSide: 'RIGHT', subjectType: 'LINE',
  viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
  comments: { totalCount: comments.length, pageInfo: { hasNextPage: false }, nodes: comments }, ...over });
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

/** A GitHub that answers at once: loads from `threads`; review and thread mutations change them. */
function fakeGitHub(threads) {
  const gh = { threads, pending: false, calls: [], nextId: 100 };
  gh.graphql = async (query, variables) => {
    const name = /^(?:query|mutation) (\w+)/.exec(query)[1];
    if (name === 'ImpactTreePullRequestOverview') return overviewAnswer(variables.headOid); // not one of the calls asserted on
    gh.calls.push({ name, input: variables.input });
    const { input } = variables;
    switch (name) {
      case 'ImpactTreePullRequestReview': return { repository: { pullRequest: {
        id: 'PR_7', number: 7, title: 't', body: 'b', url: 'https://x', state: 'OPEN', author: null, viewerDidAuthor: false,
        headRefOid: HEAD, baseRefOid: 'c'.repeat(40), headRefName: 'f', baseRefName: 'main', reviewThreads: page(gh.threads),
        reviews: { nodes: gh.pending ? [{ id: 'R_1', databaseId: 1, comments: { totalCount: 1 } }] : [] },
        files: page([]), timelineItems: { nodes: [] } } } };
      case 'ImpactTreeAddReview': gh.pending = true; return { addPullRequestReview: { pullRequestReview: { id: 'R_1', state: 'PENDING' } } };
      case 'ImpactTreeAddThread': {
        const id = gh.nextId++;
        const file = input.subjectType === 'FILE';
        gh.threads = [...gh.threads, rawThread(id, { path: input.path, subjectType: input.subjectType, line: file ? null : input.line,
          diffSide: input.side || 'RIGHT' }, [rawComment(id, { state: 'PENDING', viewerDidAuthor: true, body: input.body })])];
        return { addPullRequestReviewThread: { thread: { id: `T_${id}` } } };
      }
      default: throw new Error(`unexpected ${name}`);
    }
  };
  return gh;
}

// a.ts: `bad` (lines 10–12) with a caller in b.ts whose call (line 3) is not in the diff;
// b.ts: `quiet` (lines 5–6). GitHub's diff shows a.ts 8–14 and b.ts 5–6.
function usePreview(env) {
  const a = path.join(env.dir, 'a.ts'), b = path.join(env.dir, 'b.ts');
  fs.writeFileSync(b, 'const one = 1;\nfoo;\nuser(bad());\n');
  const SITE = { start: 22, end: 25 };
  const caller = { file: b, pos: 7, label: 'user', test: false, callSites: [SITE], sites: 1, callState: 'unchanged',
    callSiteUpdates: { updated: [], untouched: [SITE], unknown: [] } };
  const bad = { ...finding('bad', a, 10), relPath: 'a.ts', startLine: 10, endLine: 12, staleCallers: 1, callers: [caller], throwsAdded: [] };
  const quiet = { ...finding('quiet', b, 5), relPath: 'b.ts', startLine: 5, endLine: 6, kinds: [{ id: 'body', label: 'body' }], throwsAdded: [] };
  env.hooks.remoteResult = (pr) => ({ ...previewResult(pr), headSha: pr.headSha, allChanged: [bad, quiet], findings: [bad],
    fileStatus: { 'a.ts': 'modified', 'b.ts': 'modified' }, changedPaths: ['a.ts', 'b.ts'],
    diffLines: { 'a.ts': { left: [[8, 14]], right: [[8, 14]] }, 'b.ts': { left: [[5, 6]], right: [[5, 6]] } } });
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const textOf = (details) => details.displayHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function start(env) {
  usePreview(env);
  await env.preview(PR);
  await settle();
  const tree = env.tree();
  const files = await tree.getChildren();
  const aFile = files.find((f) => f.relPath === 'a.ts'), bFile = files.find((f) => f.relPath === 'b.ts');
  const [bad] = (await tree.getChildren(aFile)).filter((r) => r.type === 'finding');
  return { tree, aFile, bFile, bad };
}

const THREADS = () => [
  rawThread(1, {}, [rawComment(1, { body: 'Why not reuse x?\nsecond line' })]),
  rawThread(2, { isOutdated: true, line: null, originalLine: 9 }, [rawComment(2, { diffHunk: '@@ -8,2 +8,2 @@\n ctx\n-  old();' })]),
  rawThread(3, { path: 'b.ts', line: 5, isResolved: true }),
];

test('a preview\'s threads show as counts on rows, in the message, and turn on the threads filter', () => withEnv(async (env) => {
  github = fakeGitHub(THREADS());
  const { tree, aFile, bFile, bad } = await start(env);
  assert.match(env.view().message, / · 💬 2$/, 'the resolved thread is not counted');
  assert.equal(env.seen.contexts['impactTree.hasReviewThreads'], true);
  assert.match(tree.getTreeItem(aFile).description, /^(\d+ needs? attention  ·  )?💬 2  ·  0\/1$/);
  assert.match(tree.getTreeItem(bad).description, /  ·  💬 1$/);
  assert.doesNotMatch(String(tree.getTreeItem(bFile).description), /💬/);
  await env.run('impactTree.filterThreads');
  assert.deepEqual((await tree.getChildren()).filter((r) => r.relPath).map((f) => f.relPath), ['a.ts']);
  assert.match(env.view().message, /· filter: unresolved threads$/);
}, OPTIONS));

test('a failed load shows no counts and says so; the threads filter is not offered', () => withEnv(async (env) => {
  github = { graphql: async () => { throw new Error('rate limited'); } };
  const { tree, aFile } = await start(env);
  assert.doesNotMatch(String(tree.getTreeItem(aFile).description), /💬|✎/);
  assert.match(env.view().message, / · ⚠ threads not loaded$/);
  assert.equal(env.seen.contexts['impactTree.hasReviewThreads'], false);
}, OPTIONS));

test('Details shows no threads section and no comment buttons, with threads loaded', () => withEnv(async (env) => {
  github = fakeGitHub(THREADS());
  const { aFile, bad } = await start(env);
  const details = env.openDetails();
  for (const row of [bad, aFile]) {
    env.select([row]);
    assert.doesNotMatch(textOf(details), /Threads|Why not reuse/, row.type);
    assert.doesNotMatch(details.displayHtml, /data-act="(comment|caller-comment|thread)"/, row.type);
  }
}, OPTIONS));
