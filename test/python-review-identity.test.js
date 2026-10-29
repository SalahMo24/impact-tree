'use strict';
// Review identity of Python rows (P5, docs/MULTI_LANGUAGE_PLAN.md): a change, deleted or
// outside row of a Python file is identified by its own declaration's text (`rel#key` and
// hashes), from the symbols the provider recorded during the analysis
// (`result.reviewSymbols`), not by the whole file and not by offsets. Run through the real
// pipeline (`analyze()`) on a throwaway git repository with Pyright's recorded answers
// replayed (test/python-symbols/). A pushed text that was never recorded gets the recorded
// head symbols with their offsets moved for the one edit made (`edited`), which is what
// Pyright answers for an edit that adds or removes characters and no lines of structure.
// The same shared code serves Go (go-review-identity.test.js) and TypeScript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');
const { makeGit } = require('../src/engine/git');
const { createReviewIdentity, localRevisions } = require('../src/session/review-identity');
const texts = require('./python-symbols/texts');
const recorded = require('./python-symbols/recorded.json');

const sha = (text) => createHash('sha256').update(text == null ? '<absent>' : text).digest('hex');
const HEAD = texts['tool.py@head'];
const BASE = texts['tool.py@base'];
const BY_HASH = new Map(Object.values(recorded.texts).map((r) => [r.sha256, r.symbols]));

/** `text` with `oldStr` replaced by `newStr` (found once), and the recorded head symbols moved for it. */
function edited(oldStr, newStr) {
  const at = HEAD.indexOf(oldStr);
  assert.ok(at >= 0 && HEAD.indexOf(oldStr, at + 1) < 0, `${JSON.stringify(oldStr)} occurs once in the head`);
  const text = HEAD.slice(0, at) + newStr + HEAD.slice(at + oldStr.length);
  const delta = newStr.length - oldStr.length;
  const move = (o) => (o >= at + oldStr.length ? o + delta : o);
  const shift = (symbols) => symbols.map((s) => ({
    ...s,
    range: { start: move(s.range.start), end: move(s.range.end) },
    selectionRange: { start: move(s.selectionRange.start), end: move(s.selectionRange.end) },
    children: shift(s.children || []),
  }));
  BY_HASH.set(sha(text), shift(recorded.texts['tool.py@head'].symbols));
  return text;
}
const PUSH = edited('    return inner(a) + b\n', '    return inner(a) + b + 0\n');
const OUTSIDE = edited('import typing\n', 'import typing  # used by overloads\n');
const SETTER = edited('        self._size = value', '        self._size = int(value)');
const BODY = edited('        return int(self._size)\n', '        return int(self._size) + 0\n');

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

/** A TypeScript module that fails if the identity ever touches it: Python rows parse nothing. */
const noTypeScript = new Proxy({}, { get: (_target, name) => assert.fail(`TypeScript was used (${String(name)})`) });

function pythonRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-python-identity-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "t"\n');
  fs.writeFileSync(path.join(dir, 'tool.py'), BASE);
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feature');
  const push = (text) => {
    fs.writeFileSync(path.join(dir, 'tool.py'), text);
    git('commit', '-qam', 'push');
  };
  push(HEAD);
  return { dir, push };
}

const analysePython = (dir, opts = {}) => analyze(dir, {
  mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true,
  languageServices: replay, makeResolver: noCallers, ...opts,
});

/** The persisted identity of every Python row of a result, by key (`deleted <key>`, `outside <file>`). */
function idsOf(dir, result) {
  const identity = createReviewIdentity(noTypeScript, dir, localRevisions(dir, result, makeGit(dir)));
  const ids = {};
  for (const c of result.allChanged) ids[c.key] = identity({ type: 'finding', label: c.label, file: c.file, pos: c.namePos });
  for (const d of result.deleted) ids[`deleted ${d.key}`] = identity({ type: 'deleted', label: d.label, key: d.key, relPath: d.relPath, file: d.file });
  for (const o of result.outside) ids[`outside ${o.relPath}`] = identity({ type: 'outside', file: o.file, relPath: o.relPath });
  return ids;
}

// Each declaration's text as the provider cuts it (from `def` or its decorator to the last
// code character). The first `helper` is one Pyright does not list (a later `helper`
// redefines it): the provider recovers it from the text (P2).
const DECL = {
  helperHead: 'def helper(a, b):\n    def inner(x):\n        return x * 3\n    return inner(a) + b',
  helperBase: 'def helper(a, b):\n    def inner(x):\n        return x * 2\n    return inner(a) + b',
  added: 'def added(z):\n    return z',
  removed: 'def removed():\n    pass',
};
for (const [side, text] of [[HEAD, DECL.helperHead], [BASE, DECL.helperBase], [HEAD, DECL.added], [BASE, DECL.removed]]) {
  assert.ok(side.includes(text), `the fixture declares ${JSON.stringify(text.slice(0, 20))}`);
}
const changedIds = (before, after) => Object.keys(before).filter((k) => before[k] !== after[k]);

test('a Python change row is rel#key with the hashes of its own head and base declarations', async (t) => {
  const repo = pythonRepo(t);
  const ids = idsOf(repo.dir, await analysePython(repo.dir));
  assert.equal(ids.helper, `tool.py#helper:${sha(DECL.helperHead)}:${sha(DECL.helperBase)}`);
  assert.equal(ids.added, `tool.py#added:${sha(DECL.added)}:${sha(null)}`, 'an added function has no base side');
  for (const [key, id] of Object.entries(ids)) {
    if (/^(deleted|outside) /.test(key)) continue;
    assert.match(id, /^tool\.py#[^:]+:[0-9a-f]{64}:[0-9a-f]{64}$/, key);
    assert.doesNotMatch(id, /#@/, `${key} is not identified by its whole file`);
  }
});

test('a deleted Python function is identified by its base declaration', async (t) => {
  const repo = pythonRepo(t);
  const ids = idsOf(repo.dir, await analysePython(repo.dir));
  assert.equal(ids['deleted removed'], `deleted:tool.py#removed:${sha(DECL.removed)}`);
});

test('a push that edits one function keeps every other tick, though their offsets moved', async (t) => {
  const repo = pythonRepo(t);
  const first = await analysePython(repo.dir);
  const before = idsOf(repo.dir, first);
  repo.push(PUSH);
  const second = await analysePython(repo.dir);
  const after = idsOf(repo.dir, second);
  const namePos = (r, key) => r.allChanged.find((c) => c.key === key).namePos;
  assert.notEqual(namePos(second, 'Tool.size'), namePos(first, 'Tool.size'), 'Tool.size moved: offsets alone would not identify it');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(changedIds(before, after), ['helper'], 'only the function whose text changed is unticked');
});

test('an edit inside a method unticks that method only', async (t) => {
  const repo = pythonRepo(t);
  const before = idsOf(repo.dir, await analysePython(repo.dir));
  repo.push(BODY);
  const after = idsOf(repo.dir, await analysePython(repo.dir));
  assert.deepEqual(changedIds(before, after), ['Tool.size'], 'the recovered getter alone');
});

test('a recovered property getter and its setter have distinct, content-based ids', async (t) => {
  const repo = pythonRepo(t);
  const before = idsOf(repo.dir, await analysePython(repo.dir));
  assert.equal(before['Tool.size#2'], undefined, 'the setter is unchanged in the head');
  repo.push(SETTER);
  const result = await analysePython(repo.dir);
  const after = idsOf(repo.dir, result);
  assert.ok(after['Tool.size'] && after['Tool.size#2'], 'both are rows');
  assert.notEqual(after['Tool.size'], after['Tool.size#2']);
  assert.match(after['Tool.size#2'], /^tool\.py#Tool\.size#2:[0-9a-f]{64}:[0-9a-f]{64}$/);
  assert.equal(after['Tool.size'], before['Tool.size'], 'the getter keeps its tick');
});

test('a change outside every function changes the outside row only', async (t) => {
  const repo = pythonRepo(t);
  const before = idsOf(repo.dir, await analysePython(repo.dir));
  repo.push(OUTSIDE);
  const after = idsOf(repo.dir, await analysePython(repo.dir));
  assert.deepEqual(changedIds(before, after), ['outside tool.py']);
  assert.match(after['outside tool.py'], /^tool\.py#outside:[0-9a-f]{64}:[0-9a-f]{64}$/);
});

test('the early result (before callers) gives the same identities as the final one', async (t) => {
  const repo = pythonRepo(t);
  let early = null;
  const result = await analysePython(repo.dir, { onPrepared: (pending) => { early = pending; } });
  assert.ok(early, 'the early result was published');
  assert.deepEqual(idsOf(repo.dir, early), idsOf(repo.dir, result));
  assert.equal(Object.keys(result).includes('reviewSymbols'), false, 'not part of the JSON result');
});

test('a file edited after the analysis is identified by its whole text until the next analysis', async (t) => {
  const repo = pythonRepo(t);
  const result = await analysePython(repo.dir);
  const analysed = idsOf(repo.dir, result);
  fs.writeFileSync(path.join(repo.dir, 'tool.py'), PUSH);
  const after = idsOf(repo.dir, result);
  const whole = `${sha(PUSH)}:${sha(BASE)}`;
  assert.equal(after.helper, `tool.py#@helper:${whole}`);
  assert.equal(after['deleted removed'], `deleted:tool.py#removed:${whole}`);
  for (const key of Object.keys(analysed)) assert.notEqual(after[key], analysed[key], key);
});
