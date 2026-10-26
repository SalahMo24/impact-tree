// @ts-check
'use strict';

// Card facts from the GitHub API (cards-remote.js), with a fake client: no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { gatherRemoteCardFacts, zeroContextDiff } = require('../src/engine/cards-remote');
const { isAnalysisCancelled } = require('../src/engine/cancellation');

const SLUG = { owner: 'o', repo: 'r' };
const PR = { number: 7, headSha: 'headsha0000000', baseSha: 'basesha0000000' };

// GitHub's patch: 3 lines of context around the change; one hunk replaces line 4, another adds after line 20.
const PATCH = [
  '@@ -1,7 +1,7 @@',
  ' l1', ' l2', ' l3',
  '-return 1;',
  '+return quarantineWindow;',
  ' l5', ' l6', ' l7',
  '@@ -20,2 +20,3 @@',
  ' l20', ' l21',
  '+const secondRareValue = "a literal text";',
  '\\ No newline at end of file',
].join('\n');

const file = (p, patch, status = 'modified') => ({ path: p, oldPath: p, status, patch });

/** @param {any[]} commits `{sha, subject, files, isMerge?}` oldest first */
function fakeGh(commits, { files = {}, failGet = new Set(), failList = false, failFiles = new Set() } = {}) {
  const calls = { list: 0, get: [], at: [] };
  return {
    calls,
    listPullRequestCommits: async () => {
      calls.list++;
      if (failList) throw new Error('boom list');
      return { commits: commits.map((c) => ({ sha: c.sha, subject: c.subject, isMerge: !!c.isMerge })), truncated: false };
    },
    getCommit: async (_slug, sha) => {
      calls.get.push(sha);
      if (failGet.has(sha)) throw new Error(`boom ${sha}`);
      const c = commits.find((x) => x.sha === sha);
      return { sha, subject: c.subject, isMerge: !!c.isMerge, files: c.files, filesTruncated: false };
    },
    fileAtRef: async (_slug, p, ref) => {
      calls.at.push(`${p}@${ref}`);
      if (failFiles.has(`${p}@${ref}`)) throw new Error('boom file');
      return files[`${p}@${ref}`] ?? null;
    },
  };
}

test('zeroContextDiff keeps only changed lines, with git -U0 positions', () => {
  const text = zeroContextDiff(file('a/x.ts', PATCH));
  assert.deepEqual(text.split('\n').slice(3), [
    '@@ -4,1 +4,1 @@', '-return 1;', '+return quarantineWindow;',
    '@@ -21,0 +22,1 @@', '+const secondRareValue = "a literal text";',
  ]);
});

test('hunks and words come from the patches; a file without a patch is a note', async () => {
  const gh = fakeGh([]);
  const facts = await gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files: { files: [file('a/x.ts', PATCH), file('img.png', null)] } });
  assert.equal(facts.hunks.length, 2);
  assert.deepEqual(facts.hunks[0], { file: 'a/x.ts', oldStart: 4, oldCount: 1, newStart: 4, newCount: 1, removed: ['return 1;'], added: ['return quarantineWindow;'] });
  assert.deepEqual(facts.hunks[1].added, ['const secondRareValue = "a literal text";']);
  assert.ok(facts.tokensByFile['a/x.ts'].includes('quarantineWindow'));
  assert.ok(facts.tokensByFile['a/x.ts'].includes('a literal text'));
  assert.equal(facts.changedFileCount, 1);
  assert.equal(facts.notes.length, 1);
  assert.match(facts.notes[0], /1 changed file\(s\) have no patch.*img\.png/);
});

test('added and removed files and a rename read as the local diff reads them', async () => {
  const gh = fakeGh([]);
  const files = [
    file('new.ts', '@@ -0,0 +1,2 @@\n+export const freshWorkValue = 1;\n+export const other = 2;', 'added'),
    file('gone.ts', '@@ -1,1 +0,0 @@\n-export const retiredValue = 1;', 'removed'),
    { path: 'to.ts', oldPath: 'from.ts', status: 'renamed', patch: '@@ -1,1 +1,1 @@\n-const oldname = 1;\n+const renamedValue = 1;' },
  ];
  const facts = await gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files });
  assert.deepEqual(facts.hunks.map((h) => [h.file, h.oldStart, h.oldCount, h.newStart, h.newCount]),
    [['new.ts', 0, 0, 1, 2], ['gone.ts', 1, 1, 0, 0], ['to.ts', 1, 1, 1, 1]]);
  assert.equal(facts.changedFileCount, 3);
});

test('commits: newest first, merges left out, files from each commit', async () => {
  const gh = fakeGh([
    { sha: 'aaaaaaaaaaaaaaaa', subject: 'first change', files: ['a/x.ts'] },
    { sha: 'bbbbbbbbbbbbbbbb', subject: 'merge main', files: ['q.ts'], isMerge: true },
    { sha: 'cccccccccccccccc', subject: 'second change', files: ['a/x.ts', 'b/y.ts'] },
  ]);
  const facts = await gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files: [] });
  assert.deepEqual(facts.commits, [
    { sha: 'cccccccccc', subject: 'second change', files: ['a/x.ts', 'b/y.ts'] },
    { sha: 'aaaaaaaaaa', subject: 'first change', files: ['a/x.ts'] },
  ]);
  assert.deepEqual(gh.calls.get.sort(), ['aaaaaaaaaaaaaaaa', 'cccccccccccccccc'], 'no request for the merge');
  assert.deepEqual(facts.notes, []);
});

test('commits are capped at maxCommits requests, newest first, with a note', async () => {
  const commits = Array.from({ length: 5 }, (_, i) => ({ sha: `c${i}`.padEnd(12, '0'), subject: `change number ${i}`, files: [`f${i}.ts`] }));
  const gh = fakeGh(commits);
  const facts = await gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files: [], maxCommits: 3 });
  assert.equal(gh.calls.get.length, 3);
  assert.deepEqual(facts.commits.map((c) => c.subject), ['change number 4', 'change number 3', 'change number 2']);
  assert.deepEqual(facts.notes, ['commit file lists read for the newest 3 of 5 commits (request cap)']);
  const exact = await gatherRemoteCardFacts({ gh: fakeGh(commits), slug: SLUG, pr: PR, files: [], maxCommits: 5 });
  assert.deepEqual(exact.notes, [], 'exactly at the cap is not capped');
  await assert.rejects(gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files: [], maxCommits: 0 }), RangeError);
});

test('a failed request is a note and leaves its facts empty; the rest is kept', async () => {
  const commits = [
    { sha: 'aaaaaaaaaaaa', subject: 'works fine here', files: ['a.ts'] },
    { sha: 'bbbbbbbbbbbb', subject: 'this one fails', files: ['b.ts'] },
  ];
  const gh = fakeGh(commits, { failGet: new Set(['bbbbbbbbbbbb']), failFiles: new Set([`package.json@${PR.headSha}`]) });
  const facts = await gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files: [file('a/x.ts', PATCH)] });
  assert.deepEqual(facts.commits.map((c) => c.subject), ['works fine here']);
  assert.equal(facts.hunks.length, 2);
  assert.equal(facts.notes.length, 2);
  assert.match(facts.notes[0], /^1 commit request\(s\) failed.*boom bbbbbbbbbbbb/);
  assert.match(facts.notes[1], /^package\.json at headsha000 could not be read: boom file/);

  const noList = await gatherRemoteCardFacts({ gh: fakeGh(commits, { failList: true }), slug: SLUG, pr: PR, files: [] });
  assert.deepEqual(noList.commits, []);
  assert.deepEqual(noList.notes, ['commit list failed: boom list']);
});

test('generatedDirs come from package.json and .gitattributes at head and base; a missing file is no error', async () => {
  const gh = fakeGh([], { files: {
    [`package.json@${PR.headSha}`]: JSON.stringify({ scripts: { clean: 'rimraf dist' } }),
    [`.gitattributes@${PR.baseSha}`]: 'gen/** linguist-generated\n',
  } });
  const facts = await gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files: [] });
  assert.deepEqual(facts.generatedDirs, ['dist', 'gen']);
  assert.deepEqual(facts.notes, []);
  assert.equal(gh.calls.at.length, 4);
});

test('an aborted signal rejects with the cancellation error, before and during the requests', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(gatherRemoteCardFacts({ gh: fakeGh([]), slug: SLUG, pr: PR, files: [], signal: ac.signal }), isAnalysisCancelled);

  const ac2 = new AbortController();
  const gh = fakeGh([{ sha: 'aaaaaaaaaaaa', subject: 'one commit here', files: ['a.ts'] }]);
  gh.getCommit = async () => { ac2.abort(); throw Object.assign(new Error('cancelled'), { name: 'AnalysisCancelledError', code: 'ANALYSIS_CANCELLED' }); };
  await assert.rejects(gatherRemoteCardFacts({ gh, slug: SLUG, pr: PR, files: [], signal: ac2.signal }), isAnalysisCancelled);
});
