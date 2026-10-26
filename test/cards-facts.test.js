// @ts-check
'use strict';

// The asynchronous, cancellable card facts of a checkout and the three-step cards API
// (cards.js): gatherLocalCardFacts, buildCardsFromFacts (pure), addHints (new object).
// A throwaway git repository is built here; nothing outside the temp directory is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildClusters } = require('../src/engine/clusters');
const { gatherDiffFacts, countRareTokens, hintsFor } = require('../src/engine/cluster-hints');
const { gatherLocalCardFacts, buildCardsFromFacts, addHints, buildCards } = require('../src/engine/cards');
const { isAnalysisCancelled } = require('../src/engine/cancellation');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-cards-facts-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** @param {string} dir @param {string[]} args */
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** @param {string} dir @param {Record<string, string>} files @param {string} message */
function commit(dir, files, message) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
}

/** A base commit and two feature commits touching two folders, sharing one rare word. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'a@example.com']);
  git(dir, ['config', 'user.name', 'a']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  commit(dir, {
    'package.json': JSON.stringify({ scripts: { clean: 'rimraf dist' } }),
    'a/x.ts': 'export function ax() {\n  return 1;\n}\n',
    'b/y.ts': 'export function by() {\n  return 2;\n}\n',
  }, 'base');
  const base = git(dir, ['rev-parse', 'HEAD']);
  commit(dir, { 'a/x.ts': 'export function ax() {\n  return quarantineWindow;\n}\n' }, 'change ax with the shared window');
  commit(dir, { 'b/y.ts': 'export function by() {\n  return quarantineWindow;\n}\n' }, 'change by with the shared window');
  commit(dir, { 'a/x.ts': 'export function ax() {\n  return quarantineWindow;\n}\nexport const axDone = true;\n', 'b/y.ts': 'export function by() {\n  return quarantineWindow;\n}\nexport const byDone = true;\n' }, 'finish both together');
  return { dir, base, head: git(dir, ['rev-parse', 'HEAD']) };
}

let seq = 0;
/** One changed function, as `analyze()` lists it (see clusters.test.js). */
function fn(name, file) {
  seq++;
  return {
    label: name, simpleName: name, className: null, file: `/abs/${file}`, relPath: file, namePos: seq * 10, isConstructor: false,
    classNamePos: null, component: '(root)', score: 1, baseSig: '()', headSig: '()', callers: [], callersComplete: true, stale: [],
    startLine: 1, endLine: 3, kinds: [{ id: 'body' }],
  };
}
const resultFor = (extra = {}) => ({ allChanged: [fn('ax', 'a/x.ts'), fn('by', 'b/y.ts')], mode: 'pr', ...extra });

test('async local facts equal the synchronous ones', async () => {
  const { dir, base, head } = makeRepo();
  const sync = gatherDiffFacts({ repo: dir, base, head });
  const async_ = await gatherLocalCardFacts({ repo: dir, base, head });
  assert.deepEqual(async_, sync);
  assert.equal(async_.commits.length, 3);
  assert.deepEqual(async_.generatedDirs, ['dist']);
  assert.deepEqual(async_.notes, []);
});

test('a failing git step is a note and leaves its facts empty, in both versions', async () => {
  const { dir, head } = makeRepo();
  const facts = await gatherLocalCardFacts({ repo: dir, base: 'not-a-revision', head });
  assert.deepEqual(facts.commits, []);
  assert.deepEqual(facts.hunks, []);
  assert.equal(facts.notes.length, 2);
  assert.match(facts.notes[0], /^git log failed/);
  assert.match(facts.notes[1], /^git diff failed/);
});

test('buildCardsFromFacts is pure and has no hints yet', async () => {
  const { dir, base, head } = makeRepo();
  const facts = await gatherLocalCardFacts({ repo: dir, base, head });
  const before = JSON.stringify(facts);
  const result = resultFor();
  const resultBefore = JSON.stringify(result);
  const cards = buildCardsFromFacts(result, facts);
  assert.deepEqual(cards.hints, []);
  assert.deepEqual(cards.generatedDirs, ['dist']);
  assert.equal(JSON.stringify(facts), before, 'the facts are not changed');
  assert.equal(JSON.stringify(result), resultBefore, 'the result is not changed');
  assert.equal(JSON.stringify(buildCardsFromFacts(result, facts)), JSON.stringify(cards), 'same input, same cards');
  cards.hintNotes.push('x');
  assert.deepEqual(facts.notes, [], 'hintNotes is a copy');
  assert.equal(cards.clusters.length, buildClusters(result, { facts }).clusters.length);
});

test('uncommitted changes are noted in a local mode and not in pr mode', () => {
  const facts = { commits: [], hunks: [], tokensByFile: {}, changedFileCount: 0, generatedDirs: [], tokenFiles: {}, tokenCountsPartial: false, notes: ['n1'] };
  const dirty = buildCardsFromFacts(resultFor({ mode: 'checkpoint', dirtyCount: 2 }), facts);
  assert.equal(dirty.hintNotes.length, 2);
  assert.match(dirty.hintNotes[0], /2 file\(s\) with uncommitted changes/);
  assert.equal(dirty.hintNotes[1], 'n1');
  assert.deepEqual(buildCardsFromFacts(resultFor({ dirtyCount: 2 }), facts).hintNotes, ['n1']);
});

test('addHints returns a new object with hints; the cards given are not changed', async () => {
  const { dir, base, head } = makeRepo();
  const facts = await gatherLocalCardFacts({ repo: dir, base, head });
  const cards = buildCardsFromFacts(resultFor(), facts);
  const before = JSON.stringify(cards);
  const withHints = await addHints(cards, facts, { repo: dir, head });
  assert.notEqual(withHints, cards);
  assert.equal(JSON.stringify(cards), before, 'the input cards are not changed');
  assert.deepEqual(cards.hints, []);
  const pair = withHints.hints.find((h) => h.clusters.join() === 'K1,K2');
  assert.ok(pair, 'the two clusters share commits and a rare word');
  assert.ok(pair.evidence.some((e) => e.type === 'token' && e.token === 'quarantineWindow'));
  assert.ok(pair.evidence.some((e) => e.type === 'commit'));
});

test('buildCards equals the synchronous composition of the same steps', async () => {
  const { dir, base, head } = makeRepo();
  const result = resultFor();
  const facts = gatherDiffFacts({ repo: dir, base, head });
  const built = buildClusters(result, { facts });
  const counted = countRareTokens(facts, built.clusters, { repo: dir, head });
  const expected = { ...built, hints: hintsFor(built.clusters, counted), hintNotes: counted.notes.slice(), generatedDirs: counted.generatedDirs };
  const actual = await buildCards(result, { repo: dir, base, head });
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test('addHints without a repo counts no words and says so', async () => {
  const { dir, base, head } = makeRepo();
  const facts = await gatherLocalCardFacts({ repo: dir, base, head });
  const cards = buildCardsFromFacts(resultFor(), facts);
  const preview = await addHints(cards, facts);
  assert.notEqual(preview, cards);
  assert.deepEqual(preview.hintNotes, [...cards.hintNotes, 'preview: rare-token hints not checked (no checkout)']);
  assert.deepEqual(cards.hintNotes, [], 'the input notes are not changed');
  const pair = preview.hints.find((h) => h.clusters.join() === 'K1,K2');
  assert.ok(pair, 'the commits still link the clusters');
  assert.ok(!pair.evidence.some((e) => e.type === 'token'));
});

test('an aborted signal rejects with the cancellation error and returns no facts', async () => {
  const { dir, base, head } = makeRepo();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(gatherLocalCardFacts({ repo: dir, base, head, signal: ac.signal }), isAnalysisCancelled);
  const facts = await gatherLocalCardFacts({ repo: dir, base, head });
  const cards = buildCardsFromFacts(resultFor(), facts);
  await assert.rejects(addHints(cards, facts, { repo: dir, head, signal: ac.signal }), isAnalysisCancelled);
  await assert.rejects(addHints(cards, facts, { signal: ac.signal }), isAnalysisCancelled);
  await assert.rejects(buildCards(resultFor(), { repo: dir, base, head, signal: ac.signal }), isAnalysisCancelled);
});

test('aborting while git runs kills the search and rejects', async () => {
  const { dir, base, head } = makeRepo();
  const facts = await gatherLocalCardFacts({ repo: dir, base, head });
  const cards = buildCardsFromFacts(resultFor(), facts);
  const ac = new AbortController();
  const pending = addHints(cards, facts, { repo: dir, head, signal: ac.signal });
  ac.abort(); // the child is already started: addHints is past its first check
  await assert.rejects(pending, isAnalysisCancelled);
});
