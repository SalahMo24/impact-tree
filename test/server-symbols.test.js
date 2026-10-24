'use strict';
// Server-backed symbols (G2, docs/MULTI_LANGUAGE_PLAN.md): the shared `prepare`
// (src/languages/server-symbols.js) with the Go provider (src/languages/go/provider.js),
// run through the real pipeline (`analyze()`) on a throwaway git repository. The language
// server is replayed: gopls' answers for the texts in test/go-symbols/texts.js are
// recorded in recorded.json (test/lsp-harness/record-go-symbols.js), so no editor and no
// gopls are needed. Covers changed, added, deleted and renamed functions, methods (and a
// receiver change), two `init`s, a function literal's edit, outside-function changes, a
// second module as a second unit, a generated file, a server with no answer, a failed
// request, an empty answer for a file with functions, and no services at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');
const { collectGoSymbols, goKindsOf, goModuleOf, renderGoSymbolSig, goProvider } = require('../src/languages/go/provider');
const { LANGUAGES } = require('../src/languages');
const texts = require('./go-symbols/texts');
const recorded = require('./go-symbols/recorded.json');

const sha = (text) => createHash('sha256').update(text).digest('hex');

test('every fixture text is the one its symbols were recorded for', () => {
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(recorded.texts[name], `${name} is recorded`);
    assert.equal(recorded.texts[name].sha256, sha(text), `${name} changed since it was recorded: run test/lsp-harness/record-go-symbols.js`);
  }
});

/** Recorded symbols by text hash; a fresh copy each time, as a server's answer would be. */
const BY_HASH = new Map(Object.values(recorded.texts).map((r) => [r.sha256, r.symbols]));
const answerFor = (text) => {
  const symbols = BY_HASH.get(sha(text));
  assert.ok(symbols, 'the test asks only about recorded texts');
  return JSON.parse(JSON.stringify(symbols));
};

/**
 * LanguageServices replaying the recording. `script[baseName][side]` overrides one answer:
 * 'null' (no answer), 'reject' (the request fails), 'empty' (an empty list).
 */
function replayServices(script = {}, { available = { ok: true } } = {}) {
  const asked = [];
  return {
    asked,
    available: async () => available,
    documentSymbols: async (doc) => {
      assert.equal(typeof doc.text, 'string', 'both sides are asked with their text');
      asked.push([path.basename(doc.file), doc.side]);
      const override = (script[path.basename(doc.file)] || {})[doc.side];
      if (override === 'null') return null;
      if (override === 'reject') throw new Error('gopls crashed');
      if (override === 'empty') return [];
      return answerFor(doc.text);
    },
    prepareCallHierarchy: async () => assert.fail('callers come from the resolver'),
    incomingCalls: async () => assert.fail('callers come from the resolver'),
    references: async () => assert.fail('callers come from the resolver'),
    implementations: async () => null,
    definitions: async () => null,
  };
}

/** A resolver that finds no caller, and records what it was made for. */
function noCallers(made) {
  return (options) => {
    made.push(options);
    return {
      callerState: async () => ({ state: 'none', callers: [], complete: true }),
      incoming: async () => [],
      incomingWithStatus: async () => ({ callers: [], complete: true }),
    };
  };
}

/** A throwaway repository: `base` on main, then `head` on a branch (null deletes a file). */
function repoWith(base, head) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-server-symbols-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      if (text === null) { fs.rmSync(abs); continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  };
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  write(base); git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feature');
  write(head); git('add', '-A'); git('commit', '-qm', 'head');
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const run = (dir, opts = {}) => analyze(dir, {
  mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true, ...opts,
});

const GO_MOD = 'module example.com/auth\n\ngo 1.22\n';
const TOOL_MOD = 'module example.com/tool\n\ngo 1.22\n';

/** The repository most tests share: one module at the root, a second under tools/. */
function goRepo() {
  return repoWith({
    'go.mod': GO_MOD, 'tools/go.mod': TOOL_MOD,
    'auth.go': texts['auth.go@base'],
    'tools/tool.go': texts['tool.go@base'],
    'gone.go': texts['tool.go@base'],
    'auth_test.go': 'package auth\n\nfunc TestX() {}\n',
  }, {
    'auth.go': texts['auth.go@head'],
    'tools/tool.go': texts['tool.go@head'],
    'gone.go': null,
    'fresh.go': texts['tool.go@head'],
    'auth_test.go': 'package auth\n\nfunc TestX() { _ = 1 }\n',
  });
}

const row = (c) => [c.relPath, c.label, c.key, c.kinds.map((k) => k.id).join('+'), c.added];

test('the Go provider is registered after TypeScript and needs a server', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['typescript', 'go']);
  assert.equal(goProvider.needsServer, true);
  assert.equal(typeof goProvider.prepare, 'function');
});

test('changed, added, deleted and renamed functions and methods, in units by module', async () => {
  const repo = goRepo();
  try {
    const services = replayServices();
    const made = [];
    const result = await run(repo.dir, { languageServices: services, makeResolver: noCallers(made) });
    assert.deepEqual(result.unanalysable, []);
    assert.deepEqual(result.warnings.filter((w) => !/falling back to local main/.test(w)), []);
    assert.deepEqual(result.components.map((c) => c.component), ['(root)', 'tools']);
    assert.deepEqual(made, [
      { language: 'go', component: '(root)', repoRoot: repo.dir, projectRoot: '' },
      { language: 'go', component: 'tools', repoRoot: repo.dir, projectRoot: 'tools' },
    ]);
    const byCodeUnits = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const changed = result.allChanged.map(row).sort((a, b) => byCodeUnits(a[0], b[0]) || byCodeUnits(a[2], b[2]));
    assert.deepEqual(changed, [
      ['auth.go', '(*Config).Reload', '(Config).Reload', 'body', false],
      // The receiver went from `Config` to `*Config`: the same method, its signature changed.
      ['auth.go', '(*Config).Size', '(Config).Size', 'type-changed', false],
      ['auth.go', 'Added', 'Added', 'body', true],
      ['auth.go', 'Login', 'Login', 'required-param', false],
      ['auth.go', 'helper', 'helper', 'body', false],
      // The second `init` changed, not the first: repeats are keyed in source order.
      ['auth.go', 'init', 'init#2', 'body', false],
      ['auth.go', 'newName', 'newName', 'body', true],
      // A function literal's edit is its parent's body change.
      ['auth.go', 'run', 'run', 'body', false],
      ['fresh.go', 'Tool', 'Tool', 'body', true],
      ['tools/tool.go', 'Tool', 'Tool', 'body', false],
    ]);
    assert.deepEqual(result.deleted.map((d) => [d.relPath, d.label]).sort(),
      [['auth.go', 'oldName'], ['auth.go', 'removed'], ['gone.go', 'Tool']]);

    const size = result.allChanged.find((c) => c.key === '(Config).Size');
    assert.equal(size.baseSig, '(receiver Config) () int');
    assert.equal(size.headSig, '(receiver *Config) () int');
    assert.equal(size.className, 'Config');
    const login = result.allChanged.find((c) => c.label === 'Login');
    const head = texts['auth.go@head'];
    assert.equal(head.slice(login.namePos, login.namePos + 5), 'Login', 'callers are asked at the name');
    assert.equal(head.slice(login.start, login.end).split('\n')[0], 'func Login(user string, force bool) error {', 'the doc comment is not part of it');
    assert.equal(login.exported, true);
    assert.equal(result.allChanged.find((c) => c.label === 'helper').exported, false);

    // The import, the constant and the blank line before `Added` changed outside every
    // function, as TypeScript reports them; the renamed function's lines are explained by
    // its deleted and added rows. An added file's package clause is outside too.
    assert.deepEqual(result.outside.map((o) => [o.relPath, o.ranges]),
      [['auth.go', [[5, 5], [8, 8], [48, 48]]], ['fresh.go', [[1, 2]]]]);
    // Tests are left out; the deleted file is asked only for its base side.
    assert.ok(!services.asked.some(([file]) => file === 'auth_test.go'));
    assert.deepEqual(services.asked.filter(([file]) => file === 'gone.go'), [['gone.go', 'base']]);
    assert.deepEqual(services.asked.filter(([file]) => file === 'fresh.go'), [['fresh.go', 'head']]);
  } finally {
    repo.remove();
  }
});

test('a file with no answer, a failed answer or an empty answer for its functions is not analysed, with the reason', async () => {
  const repo = repoWith({
    'go.mod': GO_MOD, 'nil.go': texts['plain.go@base'], 'flaky.go': texts['plain.go@base'],
    'empty.go': texts['plain.go@base'], 'ok.go': texts['plain.go@base'],
  }, {
    'nil.go': texts['plain.go@head'], 'flaky.go': texts['plain.go@head'],
    'empty.go': texts['plain.go@head'], 'ok.go': texts['plain.go@head'],
  });
  try {
    const services = replayServices({ 'nil.go': { head: 'null' }, 'flaky.go': { base: 'reject' }, 'empty.go': { head: 'empty' } });
    const result = await run(repo.dir, { languageServices: services, makeResolver: noCallers([]) });
    const warnings = result.warnings.filter((w) => !/falling back to local main/.test(w));
    assert.deepEqual(warnings.sort(), [
      'empty.go: NOT analysed — the Go language server listed no symbols, though the file declares functions',
      'flaky.go: NOT analysed — the Go language server could not list the symbols for its base version: gopls crashed',
      'nil.go: NOT analysed — the Go language server gave no symbols',
    ]);
    assert.deepEqual(result.unanalysable, [{ component: '(root)', count: 3 }]);
    assert.deepEqual(result.allChanged.map((c) => [c.relPath, c.label]), [['ok.go', 'Plain']], 'the others are still analysed');
    // Not analysed files stay listed as files; none of them reads as "nothing changed".
    assert.deepEqual(result.otherFiles.map((f) => f.path).sort(), ['empty.go', 'flaky.go', 'nil.go']);
    // ... and each carries its own reason, so the tree can say it on the file's row.
    assert.deepEqual(Object.fromEntries(result.otherFiles.map((f) => [f.path, f.notAnalysed])), {
      'empty.go': { language: 'Go', reason: 'the Go language server listed no symbols, though the file declares functions' },
      'flaky.go': { language: 'Go', reason: 'the Go language server could not list the symbols for its base version: gopls crashed' },
      'nil.go': { language: 'Go', reason: 'the Go language server gave no symbols' },
    });
    assert.equal('notAnalysed' in (result.allChanged[0] || {}), false);
  } finally {
    repo.remove();
  }
});

test('a generated file is listed, not analysed, and counted in one warning', async () => {
  const repo = repoWith({ 'go.mod': GO_MOD, 'api.pb.go': texts['api.pb.go@base'], 'plain.go': texts['plain.go@base'] },
    { 'api.pb.go': texts['api.pb.go@head'], 'plain.go': texts['plain.go@head'] });
  try {
    const services = replayServices();
    const result = await run(repo.dir, { languageServices: services, makeResolver: noCallers([]) });
    assert.ok(result.warnings.includes('1 generated Go file(s) listed but not analysed: api.pb.go'), result.warnings.join('\n'));
    assert.deepEqual(result.unanalysable, [], 'deliberately not analysed is not a failure');
    assert.ok(!services.asked.some(([file]) => file === 'api.pb.go'), 'the server is not asked about it');
    assert.deepEqual(result.otherFiles.map((f) => [f.path, f.noCallable]), [['api.pb.go', true]]);
    assert.equal(result.otherFiles[0].notAnalysed, undefined, 'a deliberate skip is not a failure to analyse');
    assert.deepEqual(result.allChanged.map((c) => c.label), ['Plain']);
  } finally {
    repo.remove();
  }
});

test('without language services (the CLI) every Go file is reported as not analysed, with the reason', async () => {
  const repo = goRepo();
  try {
    const result = await run(repo.dir);
    assert.ok(result.warnings.includes("4 changed Go file(s) NOT analysed — Go needs the editor's language server; open the repository in the editor to analyse it"),
      result.warnings.join('\n'));
    assert.deepEqual(result.unanalysable, [{ component: 'Go', count: 4 }]);
    assert.deepEqual(result.allChanged, []);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.otherFiles.filter((f) => f.path.endsWith('.go')).map((f) => f.path).sort(),
      ['auth.go', 'auth_test.go', 'fresh.go', 'gone.go', 'tools/tool.go']);
    const reason = "Go needs the editor's language server; open the repository in the editor to analyse it";
    assert.deepEqual(result.otherFiles.filter((f) => f.notAnalysed).map((f) => [f.path, f.notAnalysed]).sort(),
      ['auth.go', 'fresh.go', 'gone.go', 'tools/tool.go'].map((p) => [p, { language: 'Go', reason }]),
      'every file the provider was given carries the reason; the test file was never its to analyse');
  } finally {
    repo.remove();
  }
});

test('an editor that does not know Go says to install the Go extension', async () => {
  const repo = goRepo();
  try {
    const services = replayServices({}, { available: { ok: false, reason: 'the editor has no support for go installed' } });
    const result = await run(repo.dir, { languageServices: services, makeResolver: noCallers([]) });
    assert.ok(result.warnings.includes('4 changed Go file(s) NOT analysed — Install the Go extension to analyse Go files (the editor has no support for go installed)'),
      result.warnings.join('\n'));
    assert.deepEqual(services.asked, []);
  } finally {
    repo.remove();
  }
});

test('Go symbols: functions and methods only, keyed by receiver base type, repeats numbered', () => {
  const text = texts['auth.go@base'];
  const symbols = collectGoSymbols(recorded.texts['auth.go@base'].symbols, text);
  assert.deepEqual(symbols.map((s) => [s.label, s.key, s.simpleName, s.className]), [
    ['init', 'init', 'init', null],
    ['init', 'init#2', 'init', null],
    ['Login', 'Login', 'Login', null],
    ['helper', 'helper', 'helper', null],
    ['removed', 'removed', 'removed', null],
    ['oldName', 'oldName', 'oldName', null],
    ['(*Config).Reload', '(Config).Reload', 'Reload', 'Config'],
    ['(Config).Size', '(Config).Size', 'Size', 'Config'],
    ['run', 'run', 'run', null],
  ]);
  const reload = symbols.find((s) => s.simpleName === 'Reload');
  assert.equal(text.slice(reload.namePos, reload.namePos + 6), 'Reload');
  assert.equal(reload.startLine, 36);
  assert.equal(reload.endLine, 39);
  assert.equal(reload.span, 3);
  assert.equal(reload.isConstructor, false);
  assert.deepEqual([...reload.throws], []);
  assert.equal(reload.header, 'func (c *Config) Reload() error');
});

test('a header the parser cannot read is compared as text, never assumed unchanged', () => {
  const unreadable = { parseGoDeclaration: () => null, renderGoSig: () => assert.fail('nothing to render') };
  const base = collectGoSymbols(recorded.texts['auth.go@base'].symbols, texts['auth.go@base'], unreadable);
  const head = collectGoSymbols(recorded.texts['auth.go@head'].symbols, texts['auth.go@head'], unreadable);
  const pair = (key) => [base.find((s) => s.key === key), head.find((s) => s.key === key)];
  assert.equal(pair('Login')[0].sig, null);
  assert.deepEqual(goKindsOf(...pair('Login')).map((k) => k.id), ['type-changed'], 'the header text changed');
  assert.deepEqual(goKindsOf(...pair('helper')), [], 'same header: a body change');
  assert.deepEqual(goKindsOf(undefined, pair('Login')[1]), [], 'an added function has no kinds of its own');
  assert.equal(renderGoSymbolSig(unreadable)(pair('Login')[1]), 'func Login(user string, force bool) error');
  // One side readable and the other not: still compared as text.
  const parsedBase = collectGoSymbols(recorded.texts['auth.go@base'].symbols, texts['auth.go@base']);
  assert.deepEqual(goKindsOf(parsedBase.find((s) => s.key === 'helper'), pair('helper')[1]), []);
});

test('a symbol range outside its text is an error, not a guess', () => {
  const symbols = [{ name: 'f', detail: '', kind: 12, range: { start: 0, end: 99 }, selectionRange: { start: 5, end: 6 }, children: [] }];
  assert.throws(() => collectGoSymbols(symbols, 'func f() {}\n'), /outside its text/);
});

test('a Go file belongs to the module of the nearest go.mod above it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-go-modules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tools', 'gen'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'go.mod'), TOOL_MOD);
  assert.deepEqual(goModuleOf('tools/gen/x.go', dir), { component: 'tools', projectRoot: 'tools' });
  assert.deepEqual(goModuleOf('a/b.go', dir), { component: '(no go.mod)', projectRoot: '' });
  fs.writeFileSync(path.join(dir, 'go.mod'), GO_MOD);
  assert.deepEqual(goModuleOf('a/b.go', dir), { component: '(root)', projectRoot: '' });
  assert.deepEqual(goModuleOf('main.go', dir), { component: '(root)', projectRoot: '' });
});
