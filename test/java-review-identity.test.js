'use strict';
// Review identity of Java rows (J5, docs/MULTI_LANGUAGE_PLAN.md): a change, deleted or
// outside row of a Java file is identified by its own declaration's text (`rel#key` and
// hashes), from the symbols the provider recorded during the analysis
// (`result.reviewSymbols`), not by the whole file and not by offsets. The shared code is
// Go's (go-review-identity.test.js, G5); this file checks what is Java's: a method keeps
// its tick through an edit elsewhere in the file and through an edit of its Javadoc (J2
// excludes the Javadoc from the declaration), loses it when its header or body changes, and
// an overload pair (J-D3) is identified by the key it was paired under. Run through the real
// pipeline (`analyze()`) on a throwaway git repository with jdtls' recorded answers replayed
// (test/java-symbols/). A pushed text that was never recorded gets the recorded head
// symbols with their offsets moved for the one edit made (`edited`), which is what jdtls
// answers for an edit that adds or removes characters and no structure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');
const { makeGit } = require('../src/engine/git');
const { createReviewIdentity, localRevisions } = require('../src/review-identity');
const texts = require('./java-symbols/texts');
const recorded = require('./java-symbols/recorded.json');

const sha = (text) => createHash('sha256').update(text == null ? '<absent>' : text).digest('hex');
const BASE = texts['Codec.java@base'];
const HEAD = texts['Codec.java@head'];
const BY_HASH = new Map(Object.values(recorded.texts).map((r) => [r.sha256, r.symbols]));

/**
 * `HEAD` with `oldStr` (found once) replaced by `newStr`, and the recorded head symbols
 * moved for it. A range that starts at or before the edit keeps its start, so text inserted
 * at a declaration's start (its Javadoc) is inside jdtls' range for it, as jdtls gives.
 */
function edited(oldStr, newStr) {
  const at = HEAD.indexOf(oldStr);
  assert.ok(at >= 0 && HEAD.indexOf(oldStr, at + 1) < 0, `${JSON.stringify(oldStr)} occurs once in the head`);
  const text = HEAD.slice(0, at) + newStr + HEAD.slice(at + oldStr.length);
  const delta = newStr.length - oldStr.length;
  const end = at + oldStr.length;
  const moveStart = (o) => (o > at ? o + delta : o);
  const moveEnd = (o) => (o >= end ? o + delta : o);
  const shift = (symbols) => symbols.map((s) => ({
    ...s,
    range: { start: moveStart(s.range.start), end: moveEnd(s.range.end) },
    selectionRange: { start: moveStart(s.selectionRange.start), end: moveEnd(s.selectionRange.end) },
    children: shift(s.children || []),
  }));
  BY_HASH.set(sha(text), shift(recorded.texts['Codec.java@head'].symbols));
  return text;
}
// The pushes: an edit in the body of a method that is already a row, outside every method,
// in the body and in the header of two other rows, in the body of the overload that was
// paired (J-D3), and in the Javadoc of a method that is already a row.
const ELSEWHERE = edited('  public void reset(short a) {\n  }', '  public void reset(short a) {\n    flush();\n  }');
const OUTSIDE = edited('package demo;\n', 'package demo; // outside every method\n');
const BODY = edited('  public void flush(boolean force) {\n  }', '  public void flush(boolean force) {\n    flush();\n  }');
const HEADER = edited('public void reset(byte a) {', 'public synchronized void reset(byte a) {');
const PAIRED = edited('    return Long.toString(n);\n', '    return Long.toString(n) + "";\n');
const JAVADOC = edited('  public String decode(String s, boolean strict) {', '  /** Decodes {@code s}. */\n  public String decode(String s, boolean strict) {');

const replay = {
  available: async () => ({ ok: true }),
  documentSymbols: async (doc) => {
    const symbols = BY_HASH.get(sha(doc.text));
    assert.ok(symbols, 'the test asks only about recorded or derived texts');
    return JSON.parse(JSON.stringify(symbols));
  },
};
const noCallers = () => ({
  callerState: async () => ({ state: 'none', callers: [], complete: true }),
  incoming: async () => [],
  incomingWithStatus: async () => ({ callers: [], complete: true }),
});

/** A TypeScript module that fails if the identity ever touches it: Java rows parse nothing. */
const noTypeScript = new Proxy({}, { get: (_target, name) => assert.fail(`TypeScript was used (${String(name)})`) });

function javaRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-java-identity-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run('init', '-q', '--initial-branch=main');
  run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>\n');
  fs.mkdirSync(path.join(dir, 'src/main/java/demo'), { recursive: true });
  const file = path.join(dir, 'src/main/java/demo/Codec.java');
  fs.writeFileSync(file, BASE);
  run('add', '-A'); run('commit', '-qm', 'base');
  run('checkout', '-q', '-b', 'feature');
  const push = (text) => {
    fs.writeFileSync(file, text);
    run('commit', '-qam', 'push');
  };
  push(HEAD);
  return { dir, push };
}

const analyseJava = (dir, opts = {}) => analyze(dir, {
  mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true,
  languageServices: replay, makeResolver: noCallers, ...opts,
});

/** The persisted identity of every Java row of a result, by key (`deleted <key>`, `outside <file>`). */
function idsOf(dir, result) {
  const identity = createReviewIdentity(noTypeScript, dir, localRevisions(dir, result, makeGit(dir)));
  const ids = {};
  for (const c of result.allChanged) ids[c.key] = identity({ type: 'finding', label: c.label, file: c.file, pos: c.namePos });
  for (const d of result.deleted) ids[`deleted ${d.key}`] = identity({ type: 'deleted', label: d.label, key: d.key, relPath: d.relPath, file: d.file });
  for (const o of result.outside) ids[`outside ${o.relPath}`] = identity({ type: 'outside', file: o.file, relPath: o.relPath });
  return ids;
}
const differing = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]);

// Each declaration's text as the provider cuts it: from its first modifier (the Javadoc is
// not part of it) to the closing brace.
const DECL = {
  encodeLong: 'public String encode(long n) {\n    return Long.toString(n);\n  }',
  encodeInt: 'public String encode(int n) {\n    return Integer.toString(n);\n  }',
  flushBoolean: 'public void flush(boolean force) {\n  }',
  resetInt: 'public void reset(int a) {\n  }',
};
for (const [side, text] of [[HEAD, DECL.encodeLong], [BASE, DECL.encodeInt], [HEAD, DECL.flushBoolean], [BASE, DECL.resetInt]]) {
  assert.ok(side.includes(text), `the fixture declares ${JSON.stringify(text.slice(0, 30))}`);
}
const FILE = 'src/main/java/demo/Codec.java';
const keyOf = (r, key) => r.allChanged.find((c) => c.key === key);

test('a Java change row is rel#key with the hashes of its own head and base declarations', async (t) => {
  const repo = javaRepo(t);
  const ids = idsOf(repo.dir, await analyseJava(repo.dir));
  assert.equal(ids['Codec.flush(boolean)'], `${FILE}#Codec.flush(boolean):${sha(DECL.flushBoolean)}:${sha(null)}`, 'an added overload has no base side');
  for (const [key, id] of Object.entries(ids)) {
    if (/^(deleted|outside) /.test(key)) continue;
    assert.match(id, /^src\/main\/java\/demo\/Codec\.java#[^:]+:[0-9a-f]{64}:[0-9a-f]{64}$/, key);
    assert.doesNotMatch(id, /#@/, `${key} is not identified by its whole file`);
  }
});

test('an overload paired with its old self (J-D3) is identified by the old key, the head declaration and the base declaration', async (t) => {
  const repo = javaRepo(t);
  const ids = idsOf(repo.dir, await analyseJava(repo.dir));
  assert.equal(ids['Codec.encode(int)'], `${FILE}#Codec.encode(int):${sha(DECL.encodeLong)}:${sha(DECL.encodeInt)}`);
  assert.equal(ids['Codec.encode(long)'], undefined, 'no row under the new key');
});

test('a deleted Java method is identified by its base declaration', async (t) => {
  const repo = javaRepo(t);
  const ids = idsOf(repo.dir, await analyseJava(repo.dir));
  assert.equal(ids['deleted Codec.reset(int)'], `deleted:${FILE}#Codec.reset(int):${sha(DECL.resetInt)}`);
});

test('a push that edits one method keeps every other tick, though their offsets moved', async (t) => {
  const repo = javaRepo(t);
  const first = await analyseJava(repo.dir);
  const before = idsOf(repo.dir, first);
  repo.push(ELSEWHERE);
  const second = await analyseJava(repo.dir);
  const after = idsOf(repo.dir, second);
  assert.notEqual(keyOf(second, 'Codec.reset(byte)').namePos, keyOf(first, 'Codec.reset(byte)').namePos, 'reset(byte) moved: offsets alone would not identify it');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(differing(before, after), ['Codec.reset(short)'], 'only the method whose text changed is unticked');
});

test('an edit inside a method body unticks that method only', async (t) => {
  const repo = javaRepo(t);
  const before = idsOf(repo.dir, await analyseJava(repo.dir));
  repo.push(BODY);
  assert.deepEqual(differing(before, idsOf(repo.dir, await analyseJava(repo.dir))), ['Codec.flush(boolean)']);
});

test('an edit of a method header unticks that method only', async (t) => {
  const repo = javaRepo(t);
  const before = idsOf(repo.dir, await analyseJava(repo.dir));
  repo.push(HEADER);
  assert.deepEqual(differing(before, idsOf(repo.dir, await analyseJava(repo.dir))), ['Codec.reset(byte)']);
});

test('an edit of the paired overload unticks the row under its old key only', async (t) => {
  const repo = javaRepo(t);
  const before = idsOf(repo.dir, await analyseJava(repo.dir));
  repo.push(PAIRED);
  assert.deepEqual(differing(before, idsOf(repo.dir, await analyseJava(repo.dir))), ['Codec.encode(int)']);
});

test('an edit of only a method Javadoc keeps its tick', async (t) => {
  const repo = javaRepo(t);
  const first = await analyseJava(repo.dir);
  const before = idsOf(repo.dir, first);
  repo.push(JAVADOC);
  const second = await analyseJava(repo.dir);
  assert.notEqual(keyOf(second, 'Codec.decode(String)').namePos, keyOf(first, 'Codec.decode(String)').namePos, 'the method moved');
  // The Javadoc is outside every declaration (J2), so it is the file's outside row that
  // reads the edit; the method keeps its tick.
  assert.deepEqual(differing(before, idsOf(repo.dir, second)), [`outside ${FILE}`]);
});

test('a change outside every method changes the outside row only', async (t) => {
  const repo = javaRepo(t);
  const before = idsOf(repo.dir, await analyseJava(repo.dir));
  repo.push(OUTSIDE);
  const after = idsOf(repo.dir, await analyseJava(repo.dir));
  assert.deepEqual(differing(before, after), [`outside ${FILE}`]);
});

test('the early result (before callers) gives the same identities as the final one', async (t) => {
  const repo = javaRepo(t);
  let early = null;
  const result = await analyseJava(repo.dir, { onPrepared: (pending) => { early = pending; } });
  assert.ok(early, 'the early result was published');
  assert.deepEqual(idsOf(repo.dir, early), idsOf(repo.dir, result));
  assert.equal(Object.keys(result).includes('reviewSymbols'), false, 'not part of the JSON result');
});

test('a file edited after the analysis is identified by its whole text until the next analysis, never by stale offsets', async (t) => {
  const repo = javaRepo(t);
  const result = await analyseJava(repo.dir);
  const analysed = idsOf(repo.dir, result);
  fs.writeFileSync(path.join(repo.dir, FILE), ELSEWHERE);
  const afterEdit = idsOf(repo.dir, result);
  for (const name of Object.keys(analysed)) assert.notEqual(afterEdit[name], analysed[name], name);
  assert.ok(afterEdit['Codec.encode(int)'].startsWith(`${FILE}#@`), afterEdit['Codec.encode(int)']);
});
