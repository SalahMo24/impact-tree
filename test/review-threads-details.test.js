'use strict';
// Review threads through the real activate() (L5): the real review store loads a PR
// preview's threads from a fake GraphQL client, and the test reads what the tree, its
// message, the context keys and Details show, and drives Details' thread and comment
// buttons through the comment controller to GitHub and back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withEnv, finding, previewResult, pull } = require('./extension-env');
const { treeItemId } = require('../src/review-tree-model');
const { CONTROLLER_ID, COMMANDS } = require('../src/review-comments');

const HEAD = 'a'.repeat(40);
const PR = { ...pull(7), headSha: HEAD };
// The GitHub a test answers through; each test sets it before its preview loads.
let github = null;
const OPTIONS = { graphql: (...args) => github.graphql(...args) };

const rawComment = (id, over = {}) => ({ id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', state: 'SUBMITTED', viewerDidAuthor: false, url: `https://x/${id}`, diffHunk: '', ...over });
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
const tokenOf = (details) => /<script nonce="([^"]+)"/.exec(details.webview.html)[1];
const send = (details, message) => details.send({ ...message, token: tokenOf(details) });
const textOf = (details) => details.displayHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const threadsTextOf = (details) => /Threads[^]*$/.exec(textOf(details))?.[0] ?? null;

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
const lastDraft = (env) => env.commentController(CONTROLLER_ID).threads.filter((t) => !t.disposed && t.comments.length === 0).at(-1);

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
  assert.match(tree.getTreeItem(aFile).description, /^(\S+ \d+  ·  )?💬 2  ·  0\/1$/);
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
  const details = env.openDetails();
  env.select([aFile]);
  assert.match(threadsTextOf(details), /^Threads The review threads could not be loaded: .*rate limited.*This does not mean there are none/);
  assert.doesNotMatch(details.displayHtml, /data-act="comment"/, 'no comment button without the threads');
}, OPTIONS));

test('Details lists the shown row\'s threads; an outdated one with its original line; a click opens the thread', () => withEnv(async (env) => {
  github = fakeGitHub(THREADS());
  const { aFile, bad } = await start(env);
  const details = env.openDetails();
  env.select([bad]);
  assert.equal(threadsTextOf(details).replace(/ Mark reviewed.*$/, ''),
    'Threads (1) bob: Why not reuse x? line 11 · 1 comment Unresolved Comment on this change');
  env.select([aFile]);
  assert.match(threadsTextOf(details), /^Threads \(2\) bob: Why not reuse x\? line 11 · 1 comment Unresolved bob: body 2 line 9 · 1 comment Unresolved Outdated old\(\); Comment on this file/);
  assert.match(details.displayHtml, /<div class="orig"[^>]*> {2}old\(\);<\/div>/, 'the code as it was, indentation kept');
  await send(details, { type: 'revealThread', id: 'T_1' });
  await send(details, { type: 'revealThread', id: 'T_2' });
  await send(details, { type: 'revealThread', id: 'T_3' });   // b.ts: not in the shown section
  const diffs = env.seen.executed.filter(([name]) => name === 'vscode.diff');
  assert.equal(diffs.length, 2);
  assert.equal(diffs[0][2].path, 'a.ts');
  assert.deepEqual(diffs[0][4].selection.start, { line: 10, character: 0 }, 'at the thread\'s line');
  assert.equal(diffs[1][4], undefined, 'an outdated thread opens the file');
}, OPTIONS));

test('comments from Details reach GitHub; the tree repaints the named file, and Details only when its section changed', () => withEnv(async (env) => {
  github = fakeGitHub(THREADS());
  const { tree, aFile, bFile, bad } = await start(env);
  const details = env.openDetails();
  env.select([bFile]);
  await send(details, { type: 'comment', id: treeItemId(bFile) });
  const fileDraft = lastDraft(env);
  assert.equal(fileDraft.label, 'File comment');
  env.select([bad]);
  const loads = details.loads;
  const events = [];
  let refreshes = 0;
  tree.onDidChangeTreeData((row) => events.push(row));
  tree.onDidChangePresentation(() => refreshes++);
  assert.deepEqual(await env.comments.submit(env.run, COMMANDS.startReview, fileDraft, 'the whole file'), { sent: true });
  await settle();
  assert.deepEqual(github.calls.slice(-3).map((c) => c.name), ['ImpactTreeAddReview', 'ImpactTreeAddThread', 'ImpactTreePullRequestReview']);
  assert.equal(github.calls.at(-2).input.subjectType, 'FILE');
  assert.deepEqual(events, [bFile], 'only the file whose threads changed');
  assert.equal(refreshes, 0);
  assert.match(tree.getTreeItem(bFile).description, /^✎ 1/);
  assert.equal(details.loads, loads, 'the shown change\'s section did not change');
  assert.match(env.view().message, / · 💬 2 · ✎ 1$/);

  await send(details, { type: 'comment', id: treeItemId(bad) });
  const draft = lastDraft(env);
  assert.deepEqual([draft.range.start.line, draft.label], [9, undefined], 'the change\'s first line');
  await env.comments.submit(env.run, COMMANDS.addToReview, draft, 'on the change');
  await settle();
  assert.equal(details.loads, loads + 1, 'its section changed');
  assert.match(threadsTextOf(details), /^Threads \(2\) .* bob: on the change line 10 · 1 comment Pending/);
  assert.ok(events.every((row) => row === bFile || row === aFile));
}, OPTIONS));

test('a caller whose call is outside the diff gets a draft on the change, labelled with the caller', () => withEnv(async (env) => {
  github = fakeGitHub(THREADS());
  const { bad } = await start(env);
  const details = env.openDetails();
  env.select([bad]);
  assert.match(details.displayHtml, /data-act="caller-comment" data-index="0"/);
  await send(details, { type: 'commentCaller', index: 0 });
  const draft = lastDraft(env);
  assert.equal(draft.label, 'About caller user (b.ts:3) — added after your text · remove');
  assert.equal(draft.range.start.line, 9);
  await env.comments.submit(env.run, COMMANDS.startReview, draft, 'Check user');
  await settle();
  assert.equal(github.calls.find((c) => c.name === 'ImpactTreeAddThread').input.body,
    'Check user\n\n---\n**Caller outside this PR\'s diff:** `user` in `b.ts`, line 3: not changed by this PR.\n'
    + `https://github.com/example/repo/blob/${HEAD}/b.ts#L3`);
}, OPTIONS));
