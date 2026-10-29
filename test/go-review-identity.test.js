'use strict';
// Review identity of Go rows (G5, docs/MULTI_LANGUAGE_PLAN.md): a change, deleted or outside
// row of a Go file is identified by its own declaration's text (`rel#key` and hashes), from
// the symbols the provider recorded during the analysis (`result.reviewSymbols`), not by
// the whole file and not by offsets. Run through the real pipeline (`analyze()`) on a
// throwaway git repository with gopls' recorded answers replayed (test/go-symbols/), so no
// editor, gopls or TypeScript is needed. TypeScript identities are covered, unchanged, by
// review-key.test.js and review-identity-regressions.test.js.
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
const texts = require('./go-symbols/texts');
const recorded = require('./go-symbols/recorded.json');

const sha = (text) => createHash('sha256').update(text == null ? '<absent>' : text).digest('hex');
const BY_HASH = new Map(Object.values(recorded.texts).map((r) => [r.sha256, r.symbols]));

/** LanguageServices replaying gopls' recorded answers. */
const replay = {
  available: async () => ({ ok: true }),
  documentSymbols: async (doc) => {
    const symbols = BY_HASH.get(sha(doc.text));
    assert.ok(symbols, 'the test asks only about recorded texts');
    return JSON.parse(JSON.stringify(symbols));
  },
};
const noCallers = () => ({
  callerState: async () => ({ state: 'none', callers: [], complete: true }),
  incoming: async () => [],
  incomingWithStatus: async () => ({ callers: [], complete: true }),
});

/** A TypeScript module that fails if the identity ever touches it: Go rows parse nothing. */
const noTypeScript = new Proxy({}, { get: (_target, name) => assert.fail(`TypeScript was used (${String(name)})`) });

/** `extra`: more files in the base commit, unchanged on the branch. */
function goRepo(t, extra = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-go-identity-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/auth\n\ngo 1.22\n');
  fs.writeFileSync(path.join(dir, 'auth.go'), texts['auth.go@base']);
  for (const [rel, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, rel), text);
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feature');
  /** Commits `text` as auth.go on the feature branch: a push. */
  const push = (text) => {
    fs.writeFileSync(path.join(dir, 'auth.go'), text);
    git('commit', '-qam', 'push');
  };
  push(texts['auth.go@head']);
  return { dir, push };
}

const analyseGo = (dir, opts = {}) => analyze(dir, {
  mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true,
  languageServices: replay, makeResolver: noCallers, ...opts,
});

/**
 * The persisted identity of every Go row of a result, by a readable name: each changed
 * function (as its change row), each deleted one, and the file's outside row.
 */
function idsOf(dir, result) {
  const identity = createReviewIdentity(noTypeScript, dir, localRevisions(dir, result, makeGit(dir)));
  const ids = {};
  for (const c of result.allChanged) ids[c.label] = identity({ type: 'finding', label: c.label, file: c.file, pos: c.namePos });
  for (const d of result.deleted) ids[`deleted ${d.label}`] = identity({ type: 'deleted', label: d.label, key: d.key, relPath: d.relPath, file: d.file });
  for (const o of result.outside) ids[`outside ${o.relPath}`] = identity({ type: 'outside', file: o.file, relPath: o.relPath });
  return ids;
}

/** A declaration's text on one side, from gopls' recorded range for it. */
function declaration(textName, name) {
  const symbol = recorded.texts[textName].symbols.find((s) => s.name === name);
  assert.ok(symbol, `${name} is in ${textName}`);
  return texts[textName].slice(symbol.range.start, symbol.range.end);
}

test('a Go change row is rel#key with the hashes of its own head and base declarations', async (t) => {
  const repo = goRepo(t);
  const ids = idsOf(repo.dir, await analyseGo(repo.dir));
  assert.equal(ids.Login, `auth.go#Login:${sha(declaration('auth.go@head', 'Login'))}:${sha(declaration('auth.go@base', 'Login'))}`);
  assert.equal(ids['(*Config).Size'],
    `auth.go#(Config).Size:${sha(declaration('auth.go@head', '(*Config).Size'))}:${sha(declaration('auth.go@base', '(Config).Size'))}`,
    'keyed by the receiver base type, as the analysis matched it');
  assert.equal(ids.Added, `auth.go#Added:${sha(declaration('auth.go@head', 'Added'))}:${sha(null)}`, 'an added function has no base side');
  for (const [name, id] of Object.entries(ids)) {
    assert.doesNotMatch(id, /#@/, `${name} is not identified by its whole file`);
  }
});

test('a deleted Go function is identified by its base declaration', async (t) => {
  const repo = goRepo(t);
  const ids = idsOf(repo.dir, await analyseGo(repo.dir));
  assert.equal(ids['deleted removed'], `deleted:auth.go#removed:${sha(declaration('auth.go@base', 'removed'))}`);
  assert.equal(ids['deleted oldName'], `deleted:auth.go#oldName:${sha(declaration('auth.go@base', 'oldName'))}`);
});

test('a push that changes one function keeps every other row, though their offsets moved', async (t) => {
  const repo = goRepo(t);
  const first = await analyseGo(repo.dir);
  const before = idsOf(repo.dir, first);
  repo.push(texts['auth.go@push']);
  const second = await analyseGo(repo.dir);
  const after = idsOf(repo.dir, second);
  const reload = (r) => r.allChanged.find((c) => c.label === '(*Config).Reload').namePos;
  assert.notEqual(reload(second), reload(first), 'Reload moved: offsets alone would not identify it');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const changedIds = Object.keys(before).filter((name) => before[name] !== after[name]);
  assert.deepEqual(changedIds, ['helper'], 'only the function whose text changed is unticked');
});

test('a change outside every function changes the outside row only', async (t) => {
  const repo = goRepo(t);
  const before = idsOf(repo.dir, await analyseGo(repo.dir));
  repo.push(texts['auth.go@outside']);
  const after = idsOf(repo.dir, await analyseGo(repo.dir));
  const changedIds = Object.keys(before).filter((name) => before[name] !== after[name]);
  assert.deepEqual(changedIds, ['outside auth.go'], 'helper reads the constant, but its own text did not change');
  assert.match(after['outside auth.go'], /^auth\.go#outside:[0-9a-f]{64}:[0-9a-f]{64}$/);
});

test('the early result (before callers) gives the same identities as the final one', async (t) => {
  const repo = goRepo(t);
  let early = null;
  const result = await analyseGo(repo.dir, { onPrepared: (pending) => { early = pending; } });
  assert.ok(early, 'the early result was published');
  assert.deepEqual(idsOf(repo.dir, early), idsOf(repo.dir, result));
  assert.equal(Object.keys(result).includes('reviewSymbols'), false, 'not part of the JSON result');
});

test('a file edited after the analysis is identified by its whole text until the next analysis, never by stale offsets', async (t) => {
  const repo = goRepo(t);
  const result = await analyseGo(repo.dir);
  const analysed = idsOf(repo.dir, result);
  fs.writeFileSync(path.join(repo.dir, 'auth.go'), texts['auth.go@push']);
  const edited = idsOf(repo.dir, result);
  const whole = `${sha(texts['auth.go@push'])}:${sha(texts['auth.go@base'])}`;
  assert.equal(edited.Login, `auth.go#@Login:${whole}`);
  assert.equal(edited['deleted removed'], `deleted:auth.go#removed:${whole}`);
  assert.equal(edited['outside auth.go'], `auth.go#outside:${whole}`);
  for (const name of Object.keys(analysed)) assert.notEqual(edited[name], analysed[name], name);
});

test('a Go caller row: at a recorded function, that function\'s identity; in an unrecorded Go file, its whole file', async (t) => {
  const repo = goRepo(t, { 'other.go': 'package auth\n\nfunc Other() { _ = Login("x", true) }\n' });
  const result = await analyseGo(repo.dir);
  const identity = createReviewIdentity(noTypeScript, repo.dir, localRevisions(repo.dir, result, makeGit(repo.dir)));
  const helper = result.allChanged.find((c) => c.label === 'helper');
  const atHelper = identity({ type: 'caller', label: 'helper', file: helper.file, pos: helper.namePos });
  assert.equal(atHelper, identity({ type: 'finding', label: 'helper', file: helper.file, pos: helper.namePos }));
  const other = fs.readFileSync(path.join(repo.dir, 'other.go'), 'utf8');
  assert.equal(identity({ type: 'caller', label: 'Other', file: path.join(repo.dir, 'other.go'), pos: other.indexOf('Other') }),
    `other.go#@Other:${sha(other)}:${sha(other)}`, 'no symbols were recorded for it: conservative');
});
