// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hintsFor, candidateTokens, parseAddedTokens, parseDiff, parseLog, generatedDirsFrom } = require('../src/engine/cluster-hints');

const cluster = (id, files, testCallers = []) => ({ id, files, testCallers });

test('parseLog and parseAddedTokens read git output', () => {
  const log = '\x01aaaaaaaaaaaaaaaa\x02fix thing\n\na/x.ts\nb/y.ts\n\x01bbbbbbbbbbbbbbbb\x02other\n\nc.ts\n';
  const c = parseLog(log);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { sha: 'aaaaaaaaaa', subject: 'fix thing', files: ['a/x.ts', 'b/y.ts'] });
  const diff = ['+++ b/a/x.ts', '@@ -1 +1 @@', '+const retryBudget = "retry limit hit";', '-gone', '+++ /dev/null', '+ignored_token_here'].join('\n');
  const t = parseAddedTokens(diff);
  assert.deepEqual(Object.keys(t), ['a/x.ts']);
  assert.ok(t['a/x.ts'].includes('retryBudget'));
  assert.ok(t['a/x.ts'].includes('retry limit hit'));
  assert.ok(!t['a/x.ts'].includes('const'));
});

test('a commit touching both clusters is evidence and a large one is flagged', () => {
  const cs = [cluster('K1', ['a/x.ts']), cluster('K2', ['b/y.ts']), cluster('K3', ['c/z.ts'])];
  const big = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
  const h = hintsFor(cs, { commits: [
    { sha: '1', subject: 'small change to both', files: ['a/x.ts', 'b/y.ts'] },
    { sha: '2', subject: 'big change to many files', files: ['a/x.ts', 'c/z.ts', ...big] },
  ] });
  const k12 = h.find((p) => p.clusters.join() === 'K1,K2');
  assert.ok(k12);
  assert.equal(k12.evidence[0].large, false);
  const k13 = h.find((p) => p.clusters.join() === 'K1,K3');
  assert.equal(k13.evidence[0].large, true);
  assert.equal(k13.evidence[0].files, 42);
  assert.ok(!h.find((p) => p.clusters.join() === 'K2,K3'));
});

test('a rare token shared by exactly two clusters counts; common or three-way tokens do not', () => {
  const cs = [cluster('K1', ['a/x.ts']), cluster('K2', ['b/y.ts']), cluster('K3', ['c/z.ts'])];
  const tokensByFile = {
    'a/x.ts': ['rareThing', 'commonThing', 'threeWay'],
    'b/y.ts': ['rareThing', 'commonThing', 'threeWay'],
    'c/z.ts': ['threeWay'],
  };
  assert.deepEqual(candidateTokens(cs, tokensByFile).map((c) => c.token), ['commonThing', 'rareThing']);
  const h = hintsFor(cs, { tokensByFile, tokenFiles: { rareThing: 2, commonThing: 80, threeWay: 1 } });
  const toks = h.find((p) => p.clusters.join() === 'K1,K2').evidence.filter((e) => e.type === 'token');
  assert.deepEqual(toks.map((t) => t.token), ['rareThing']);
});

test('a test calling members of both clusters, and a shared folder, are evidence; strength counts types', () => {
  const t = { label: 'shared.test.ts', relPath: 't/shared.test.ts' };
  const cs = [cluster('K1', ['d/a.ts'], [t]), cluster('K2', ['d/b.ts'], [t]), cluster('K3', ['e/c.ts'])];
  const h = hintsFor(cs, { commits: [{ sha: '1', subject: 'shared change of both', files: ['d/a.ts', 'd/b.ts'] }] });
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].evidence.map((e) => e.type), ['commit', 'test', 'folder']);
  assert.equal(h[0].strength, 2); // the shared folder is listed but does not count
});

test('no evidence, no pair; output is deterministic', () => {
  const cs = [cluster('K1', ['a/x.ts']), cluster('K2', ['b/y.ts'])];
  assert.deepEqual(hintsFor(cs, {}), []);
  const facts = { commits: [{ sha: '1', subject: 'shared change of both', files: ['a/x.ts', 'b/y.ts'] }] };
  assert.equal(JSON.stringify(hintsFor(cs, facts)), JSON.stringify(hintsFor(cs, facts)));
});

test('parseDiff keeps hunks with their new-side range', () => {
  const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3,2 +3 @@ ctx', '-old1', '-old2', '+new1', '@@ -9 +8,0 @@', '-gone'].join('\n');
  const d = parseDiff(diff);
  assert.equal(d.fileCount, 1);
  assert.deepEqual(d.hunks.map((h) => [h.newStart, h.newCount, h.removed.length, h.added.length]), [[3, 1, 2, 1], [8, 0, 1, 0]]);
});

test('generatedDirsFrom reads rimraf targets and linguist-generated paths', () => {
  const pkg = JSON.stringify({ scripts: { denoify: 'rimraf deno_dist && denoify', build: 'rimraf dist ./out/x' } });
  const attrs = '# c\ngen/** linguist-generated\n.github/actions/*/lib/* linguist-generated\nother/** linguist-vendored\nt/ linguist-generated=true\nkeep/** linguist-generated=false\n*.pb.go linguist-generated\n';
  assert.deepEqual(generatedDirsFrom(pkg, attrs), ['deno_dist', 'dist', 'gen', 'out', 't']);
  assert.deepEqual(generatedDirsFrom('not json', null), []);
});

test('a folder-only pair is dropped; a broad commit is listed but does not count', () => {
  const cs = [cluster('K1', ['d/a.ts']), cluster('K2', ['d/b.ts']), cluster('K3', ['e/c.ts'])];
  const h = hintsFor(cs, { changedFileCount: 12, commits: [{ sha: '1', subject: 'wide change to every file', files: ['d/a.ts', 'e/c.ts', 'd/b.ts', 'f1', 'f2', 'f3', 'f4'] }] });
  assert.deepEqual(h, []);
  const h2 = hintsFor(cs, { changedFileCount: 10, commits: [{ sha: '1', subject: 'narrow change to two files', files: ['d/a.ts', 'd/b.ts'] }] });
  assert.equal(h2.length, 1);
  assert.equal(h2[0].strength, 1);
  assert.deepEqual(h2[0].evidence.map((e) => e.type), ['commit', 'folder']);
});

test('a shared repeated pattern or signature delta is evidence', () => {
  const a = { ...cluster('K1', ['a/x.ts']), patterns: ['x → y'], signatureDeltas: ['A → B'] };
  const b = { ...cluster('K2', ['b/y.ts']), patterns: ['x → y'], signatureDeltas: ['A → B', 'C → D'] };
  const c = { ...cluster('K3', ['c/z.ts']), patterns: [], signatureDeltas: ['C → D'] };
  const h = hintsFor([a, b, c], {});
  const ab = h.find((p) => p.clusters.join() === 'K1,K2');
  assert.deepEqual(ab.evidence.map((e) => e.type), ['pattern', 'signature-change']);
  assert.equal(ab.strength, 2);
  assert.equal(h.find((p) => p.clusters.join() === 'K2,K3').evidence[0].delta, 'C → D');
});

test('a weak commit is listed but does not count toward strength', () => {
  const cs = [cluster('K1', ['a/x.ts']), cluster('K2', ['b/y.ts'])];
  const h = hintsFor(cs, { commits: [{ sha: '1', subject: 'chore: bump deps', files: ['a/x.ts', 'b/y.ts'] }, { sha: '2', subject: 'fix', files: ['a/x.ts', 'b/y.ts'] }] });
  assert.deepEqual(h, []);
});

test('comments are not tokens', () => {
  const diff = ['diff --git a/a.go b/a.go', '--- a/a.go', '+++ b/a.go', '@@ -1 +1,3 @@', '+// therefore genuinely careful', '+x := realIdentifier // trailing explanation', '+/* block', '+ still comment words */ y := 1'].join('\n');
  const t = parseDiff(diff).tokensByFile['a.go'];
  assert.deepEqual(t, ['realIdentifier']);
});

test('a deleted file keeps its old path for its hunks', () => {
  const diff = ['diff --git a/old.ts b/old.ts', 'deleted file mode 100644', '--- a/old.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n');
  const d = parseDiff(diff);
  assert.equal(d.hunks[0].file, 'old.ts');
  assert.equal(d.hunks[0].oldStart, 1);
});

test('nothing is broad in a PR of under 10 changed files', () => {
  const cs = [cluster('K1', ['a/x.ts']), cluster('K2', ['b/y.ts'])];
  const h = hintsFor(cs, { changedFileCount: 2, commits: [{ sha: '1', subject: 'the only commit here', files: ['a/x.ts', 'b/y.ts'] }] });
  assert.equal(h[0].strength, 1);
  assert.equal(h[0].evidence[0].broad, false);
});
