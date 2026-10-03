'use strict';
// Preview documents: one revision is held, any other is fetched when a tab asks for it,
// and a failed fetch says why instead of showing an empty file. GitHub is the real
// client (src/github.js) over an injected `fetch`, so the failures are the named errors
// the content provider receives in production, not stand-ins for them.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createGitHub } = require('../src/github');
const { createPrDocuments, prQuery } = require('../src/pr-documents');
const { registerContentProviders } = require('../src/content-providers');
const { callerOpen } = require('../src/review-open');
const { createOpenReview } = require('../src/open-review');

const SLUG = { owner: 'o', repo: 'r' };
const pr = (n, headSha, mergeBase, texts = new Map()) => ({ prNumber: n, headSha, base: { sha: mergeBase }, texts });
const addressOf = (result, side, rel, file) => vscode.Uri.from({ scheme: 'impacttree-pr', path: `/${rel}`, query: prQuery(result, side, file) });

const textBody = (s) => ({
  status: 200, ok: true, headers: { get: () => 'text/plain' },
  body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from(s))); c.close(); } }),
});
const status = (code) => ({ status: code, ok: false, headers: { get: () => '' }, body: null });

// A GitHub whose `fetch` is `respond`; every requested path and ref is recorded.
async function github(respond, { signedIn = true, limits } = {}) {
  const requests = [];
  const fetch = async (url) => {
    const u = new URL(url);
    requests.push({ path: decodeURIComponent(u.pathname.replace(`/repos/${SLUG.owner}/${SLUG.repo}/contents/`, '')), ref: u.searchParams.get('ref') });
    return respond(requests.at(-1));
  };
  const gh = createGitHub({ authentication: { getSession: async () => (signedIn ? { accessToken: 't' } : undefined) } }, { fetch, limits });
  if (signedIn) await gh.signIn();
  return { gh, requests };
}

function provider(prDocuments, gh, slug = SLUG) {
  const registered = new Map();
  const editor = { ...vscode, workspace: { registerTextDocumentContentProvider: (scheme, p) => { registered.set(scheme, p); return { dispose() {} }; } } };
  registerContentProviders(editor, { prDocuments, repoRoot: () => '/repo', gh, repoSlug: () => slug });
  return registered.get('impacttree-pr');
}

// ---- retention ---------------------------------------------------------------------
test('publishing a second preview releases the first one\'s text', () => {
  const docs = createPrDocuments();
  const first = pr(1, 'h1', 'b1', new Map([['a.ts', { head: 'first', base: 'first-base' }]]));
  const second = pr(2, 'h2', 'b2', new Map([['a.ts', { head: 'second', base: 'second-base' }]]));
  docs.add(first);
  assert.equal(docs.read(addressOf(first, 'head', 'a.ts')), 'first');
  docs.add(second);
  assert.equal(docs.read(addressOf(second, 'head', 'a.ts')), 'second');
  assert.equal(docs.read(addressOf(second, 'base', 'a.ts')), 'second-base');
  for (const side of ['head', 'base']) {
    assert.equal(docs.read(addressOf(first, side, 'a.ts')), null, `first preview's ${side} is no longer held`);
  }
});

test('a new push to the same pull request replaces the held revision too', () => {
  const docs = createPrDocuments();
  const old = pr(1, 'one', 'base', new Map([['a?#.ts', { head: 'first', base: null }]]));
  const pushed = pr(1, 'two', 'base', new Map([['a?#.ts', { head: 'updated', base: null }]]));
  docs.add(old); docs.add(pushed);
  assert.equal(docs.read(addressOf(pushed, 'head', 'a?#.ts')), 'updated');
  assert.equal(docs.read(addressOf(old, 'head', 'a?#.ts')), null);
});

test('clear releases everything; a side that exists but was not fetched is not held', () => {
  const docs = createPrDocuments();
  const held = pr(3, 'h', 'b', new Map([['a.ts', { head: 'text', base: null }]]));
  docs.add(held);
  assert.equal(docs.read(addressOf(held, 'base', 'a.ts')), null, 'a failed fetch is a miss, not an empty file');
  docs.clear();
  assert.equal(docs.read(addressOf(held, 'head', 'a.ts')), null);
});

// ---- addresses -----------------------------------------------------------------------
test('an address carries the base path only when it differs, and marks an absent side', () => {
  const r = pr(7, 'head', 'merge');
  const params = (side, file) => Object.fromEntries(new URLSearchParams(prQuery(r, side, file)));
  const rename = { path: 'new/name.ts', basePath: 'old/name.ts', status: 'renamed' };
  assert.equal(params('base', rename).from, 'old/name.ts');
  assert.equal(params('head', rename).from, undefined, 'the head side never needs the old path');
  assert.equal(params('base', { path: 'same.ts', basePath: 'same.ts', status: 'modified' }).from, undefined);
  assert.equal(params('base', { path: 'same.ts', status: 'modified' }).from, undefined);
  assert.equal(params('base', { path: 'a.ts', status: 'added' }).absent, '1');
  assert.equal(params('head', { path: 'a.ts', status: 'added' }).absent, undefined);
  assert.equal(params('head', { path: 'a.ts', status: 'deleted' }).absent, '1');
  assert.equal(params('base', { path: 'a.ts', status: 'deleted' }).absent, undefined);
  assert.equal(prQuery(r, 'head'), `side=head&revision=${encodeURIComponent('7:head:merge')}`, 'no file, no extra fields');
});

test('callerOpen builds the same rename and absent-side addresses', () => {
  const plan = (extra) => callerOpen({ tierA: true, rel: 'src/new.ts', fileChanged: true, absPath: '/x/src/new.ts', baseSha: 'merge', prNumber: 7, headSha: 'head', ...extra });
  const renamed = plan({ baseRel: 'src/old.ts', status: 'renamed' });
  assert.equal(new URLSearchParams(renamed.left.query).get('from'), 'src/old.ts');
  assert.equal(new URLSearchParams(renamed.right.query).get('from'), null);
  assert.equal(new URLSearchParams(plan({ status: 'added' }).left.query).get('absent'), '1');
  assert.equal(new URLSearchParams(plan({ status: 'deleted' }).right.query).get('absent'), '1');
});

test('the openers address the base side of a renamed file by its old path', async () => {
  const diffs = [];
  const result = { ...pr(7, 'head', 'merge'), basePaths: { 'src/new.ts': 'src/old.ts' },
    fileStatus: { 'src/new.ts': 'renamed', 'src/added.ts': 'added' } };
  const session = { isTierA: () => true, state: { result, changedPaths: new Set(['src/new.ts']) }, repoRoot: () => '/repo' };
  const editor = { ...vscode, Range: class {}, commands: { executeCommand: async (name, ...args) => { if (name === 'vscode.diff') diffs.push(args); } },
    window: { showWarningMessage() {} } };
  const open = createOpenReview(editor, session);
  await open.openChange({ finding: { relPath: 'src/new.ts', file: '/repo/src/new.ts', startLine: 1 } });
  await open.openChange({ finding: { relPath: 'src/added.ts', file: '/repo/src/added.ts', startLine: 1 } });
  const q = (uri) => new URLSearchParams(uri.query);
  assert.equal(q(diffs[0][0]).get('from'), 'src/old.ts');
  assert.equal(q(diffs[0][1]).get('from'), null);
  assert.equal(q(diffs[1][0]).get('absent'), '1');
});

// ---- fetch on a miss -----------------------------------------------------------------
test('a revision that is not held is fetched at the address\'s commit and path, and nothing is kept', async () => {
  const docs = createPrDocuments();
  const { gh, requests } = await github(({ path, ref }) => textBody(`${path}@${ref}`));
  const read = provider(docs, gh).provideTextDocumentContent;
  const gone = pr(4, 'headsha', 'mergesha');
  docs.add(pr(5, 'other', 'otherbase'));
  const renamed = { path: 'src/new.ts', basePath: 'src/old.ts', status: 'renamed' };

  assert.equal(await read(addressOf(gone, 'head', 'src/new.ts', renamed)), 'src/new.ts@headsha');
  assert.equal(await read(addressOf(gone, 'base', 'src/new.ts', renamed)), 'src/old.ts@mergesha');
  assert.equal(await read(addressOf(gone, 'base', 'src/same.ts', { path: 'src/same.ts', status: 'modified' })), 'src/same.ts@mergesha');
  assert.equal(requests.length, 3);

  await read(addressOf(gone, 'head', 'src/new.ts'));
  assert.equal(requests.length, 4, 'the same tab asked again fetches again: nothing was kept');
  assert.equal(docs.read(addressOf(gone, 'head', 'src/new.ts')), null, 'and the fetched text is not held');
});

test('the held revision is served without any network call', async () => {
  const docs = createPrDocuments();
  const held = pr(9, 'h', 'm', new Map([['a.ts', { head: 'H', base: 'B' }], ['e.ts', { head: '', base: null }]]));
  docs.add(held);
  const { gh, requests } = await github(() => { throw new Error('the network was reached'); });
  const read = provider(docs, gh).provideTextDocumentContent;
  assert.equal(await read(addressOf(held, 'head', 'a.ts')), 'H');
  assert.equal(await read(addressOf(held, 'base', 'a.ts')), 'B');
  assert.equal(await read(addressOf(held, 'head', 'e.ts')), '', 'an empty file is held text, not a miss');
  assert.deepEqual(requests, []);
});

test('a held revision without this file (never downloaded) is fetched, not shown empty', async () => {
  const docs = createPrDocuments();
  const held = pr(9, 'h', 'm', new Map());
  docs.add(held);
  const { gh, requests } = await github(({ path, ref }) => textBody(`${path}@${ref}`));
  assert.equal(await provider(docs, gh).provideTextDocumentContent(addressOf(held, 'head', 'README.md')), 'README.md@h');
  assert.equal(requests.length, 1);
});

test('the absent side of an added or deleted file is an empty document, with no request', async () => {
  const docs = createPrDocuments();
  const { gh, requests } = await github(() => { throw new Error('the network was reached'); });
  const read = provider(docs, gh).provideTextDocumentContent;
  const gone = pr(4, 'h', 'm');
  assert.equal(await read(addressOf(gone, 'base', 'new.ts', { path: 'new.ts', status: 'added' })), '');
  assert.equal(await read(addressOf(gone, 'head', 'old.ts', { path: 'old.ts', status: 'deleted' })), '');
  const held = pr(5, 'h', 'm', new Map([['new.ts', { head: 'x', base: null }]]));
  docs.add(held);
  assert.equal(await read(addressOf(held, 'base', 'new.ts', { path: 'new.ts', status: 'added' })), '');
  assert.deepEqual(requests, []);
});

// ---- failures ------------------------------------------------------------------------
test('each failure shows a message naming its cause, never an empty document', async () => {
  const gone = pr(4, 'headsha1234', 'mergesha5678');
  // [cause, setup, the cause as named, how to get the tab back]
  const cases = [
    ['signed out', { respond: () => textBody('x'), signedIn: false }, /signed out/i, /reopen/i],
    ['token rejected', { respond: () => status(401) }, /signed out|sign in/i, /reopen/i],
    ['gone', { respond: () => status(404) }, /no longer.*GitHub/i, /run the preview again, then reopen/i],
    ['timeout', { respond: () => new Promise(() => {}), limits: { requestTimeoutMs: 20 } }, /did not answer in time/i, /reopen/i],
    ['too large', { respond: () => textBody('x'.repeat(100)), limits: { maxFileBytes: 10 } }, /too large/i, /on GitHub instead/i],
    ['server error', { respond: () => status(500) }, /500/, /reopen/i],
  ];
  for (const [name, { respond, signedIn, limits }, expected, recovery] of cases) {
    const { gh } = await github(respond, { signedIn, limits });
    for (const side of ['head', 'base']) {
      const shown = await provider(createPrDocuments(), gh).provideTextDocumentContent(addressOf(gone, side, 'a.ts', { path: 'a.ts', status: 'modified' }));
      assert.match(shown, expected, `${name} (${side})`);
      assert.match(shown, recovery, `${name} (${side}) says what to do next`);
    }
  }
});

test('without a GitHub remote the tab says so', async () => {
  const { gh } = await github(() => textBody('x'));
  const shown = await provider(createPrDocuments(), gh, null).provideTextDocumentContent(addressOf(pr(4, 'h', 'm'), 'head', 'a.ts'));
  assert.match(shown, /repository/i);
});
