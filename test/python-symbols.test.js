'use strict';
// Python symbols (P2, docs/MULTI_LANGUAGE_PLAN.md): which of Pyright's document symbols are
// changed-symbol candidates (src/languages/python/provider.js), the definitions Pyright
// leaves out recovered from the text, and the shared `prepare` with Python's spec run
// through the real pipeline (`analyze()`) on a throwaway git repository. Pyright is
// replayed: its answers for test/python-symbols/texts.js are recorded in recorded.json
// (test/lsp-harness/record-python-symbols.js). The header parser is a stub here (P3 owns
// the real one), so these tests check names, places and keys, not signature kinds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');
const { collectPythonSymbols, pythonSpec, pythonProvider, scanDef } = require('../src/languages/python/provider');
const { prepareFromServerSymbols } = require('../src/languages/server-symbols');
const { LANGUAGES, useLanguagesForTest, unsupportedLanguageOf, languageFor } = require('../src/languages');
const texts = require('./python-symbols/texts');
const recorded = require('./python-symbols/recorded.json');

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A parser that reads nothing, as the placeholder does: `sig` null, header compared as text. */
const NO_PARSER = {
  parsePythonDeclaration: () => null,
  raisesOf: () => new Set(),
  pythonKindsOf: (base, head) => (!base || base.header === head.header ? [] : [{ id: 'type-changed' }]),
  renderPythonSig: () => '(…)',
};

const symbolsOf = (name) => JSON.parse(JSON.stringify(recorded.texts[name].symbols));
const collect = (name, parser = NO_PARSER) => collectPythonSymbols(symbolsOf(name), texts[name], parser);

test('every fixture text is the one its symbols were recorded for', () => {
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(recorded.texts[name], `${name} is recorded`);
    assert.equal(recorded.texts[name].sha256, sha(text), `${name} changed since it was recorded: run test/lsp-harness/record-python-symbols.js`);
  }
});

test('Python is registered after Go, needs a server, and .py is no longer "not analysed yet"', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['typescript', 'go', 'python']);
  assert.equal(languageFor('pkg/mod.py'), pythonProvider);
  assert.equal(languageFor('pkg/mod.pyi'), pythonProvider);
  assert.equal(pythonProvider.needsServer, true);
  assert.equal(pythonProvider.serverLabel, 'the Python language server (Pyright)');
  assert.equal(unsupportedLanguageOf('pkg/mod.py'), null);
  assert.equal(unsupportedLanguageOf('pkg/mod.pyi'), null);
});

test('functions, methods and nested classes are candidates; nested defs, variables and parameters are not', () => {
  const keys = collect('tool.py@base').map((s) => s.key);
  assert.deepEqual(keys, [
    'fetch', 'fetch#2', 'fetch#3', 'helper', 'removed',
    'Tool.__init__', 'Tool.size', 'Tool.size#2', 'Tool.get', 'Tool.get#2', 'Tool.get#3', 'Tool.run',
    'Tool.Inner.method', 'Tool.Inner.Deeper.deepest', 'Tool._private', 'helper#2', '_hidden',
  ]);
  assert.ok(!keys.some((k) => /inner|limit|not_a_method/.test(k)), 'a nested def, a class attribute and a docstring line are not candidates');
  // httpx/_auth.py: 19 defs, one nested inside a method (P0): 18 candidates.
  const auth = collect('httpx_auth.py');
  assert.equal(auth.length, 18);
  assert.ok(!auth.some((s) => s.simpleName === 'digest'));
  assert.equal(auth.find((s) => s.key === 'DigestAuth._build_auth_header').className, 'DigestAuth');
});

test('a property getter with a setter is recovered from the text (httpx HTTPError.request)', () => {
  const text = texts['httpx_exceptions.py'];
  const all = collect('httpx_exceptions.py');
  const getter = all.find((s) => s.key === 'HTTPError.request');
  const setter = all.find((s) => s.key === 'HTTPError.request#2');
  assert.equal(getter.recovered, true);
  assert.equal(setter.recovered, false, 'Pyright lists the setter');
  assert.deepEqual([getter.startLine, getter.endLine, setter.startLine, setter.endLine], [96, 100, 102, 104]);
  assert.ok(text.slice(getter.start, getter.end).startsWith('@property\n    def request(self) -> Request:'));
  assert.ok(text.slice(getter.start, getter.end).endsWith('return self._request'));
  assert.ok(text.slice(setter.start, setter.end).startsWith('@request.setter'), 'decorators are in the range');
  assert.equal(text.slice(getter.namePos, getter.namePos + 7), 'request');
  assert.deepEqual([getter.binding, setter.binding], ['property', 'property']);
  assert.deepEqual(getter.decorators, ['@property']);
  assert.equal(getter.header, 'def request(self) -> Request');
  // Every def of the file is a candidate: 13 (P0 does not list this file; counted by hand).
  assert.equal(all.length, 13);
});

test('@overload stubs are recovered, in classes and at module level, keyed in source order', () => {
  const text = texts['tool.py@base'];
  const by = Object.fromEntries(collect('tool.py@base').map((s) => [s.key, s]));
  for (const k of ['fetch', 'fetch#2', 'Tool.get', 'Tool.get#2', 'helper', 'Tool.size']) assert.equal(by[k].recovered, true, k);
  for (const k of ['fetch#3', 'Tool.get#3', 'helper#2', 'Tool.size#2']) assert.equal(by[k].recovered, false, k);
  assert.equal(text.slice(by['Tool.get'].start, by['Tool.get'].end), '@typing.overload\n    def get(self, i: int) -> int: ...');
  assert.equal(text.slice(by.fetch.start, by.fetch.end), '@overload\ndef fetch(key: int) -> int: ...');
  assert.equal(by['fetch#2'].startLine, 7);
  // A redefined module function: Pyright lists the last; the first is recovered.
  assert.equal(by.helper.startLine, 13);
  assert.ok(text.slice(by.helper.start, by.helper.end).endsWith('return inner(a) + b'));
  // The getter's comment line is in its body; its end is its last statement.
  assert.ok(text.slice(by['Tool.size'].start, by['Tool.size'].end).endsWith('# the getter\n        return self._size'));
  // A setter header whose `)` is at the def's indentation is one header.
  assert.equal(by['Tool.size#2'].header, 'def size( self, value: int, ) -> None');
  assert.equal(by['Tool.run'].header, 'async def run(self) -> None');
});

test('exported, constructor and the injected parser\'s answers', () => {
  const by = Object.fromEntries(collect('tool.py@base').map((s) => [s.key, s]));
  assert.equal(by['Tool.__init__'].exported, true, 'a dunder is public');
  assert.equal(by['Tool.__init__'].isConstructor, true);
  assert.equal(by['Tool.run'].isConstructor, false);
  assert.equal(by['Tool._private'].exported, false);
  assert.equal(by._hidden.exported, false);
  assert.equal(by['Tool.Inner.Deeper.deepest'].exported, true);
  assert.equal(by['Tool.Inner.Deeper.deepest'].className, 'Deeper');

  const asked = [];
  const parser = {
    parsePythonDeclaration: (declText, options) => {
      asked.push([declText.split('\n')[0], options.isMethod]);
      return { sig: { async: false, params: [], returns: null }, headerEnd: declText.indexOf(':'), decorators: ['@x'], binding: 'staticmethod' };
    },
    raisesOf: (declText) => new Set(/raise (\w+)/.exec(declText)?.slice(1) || []),
    pythonKindsOf: () => [],
    renderPythonSig: () => 'rendered',
  };
  const ex = collectPythonSymbols(symbolsOf('httpx_exceptions.py'), texts['httpx_exceptions.py'], parser);
  const getter = ex.find((s) => s.key === 'HTTPError.request');
  assert.deepEqual([getter.decorators, getter.binding], [['@x'], 'staticmethod']);
  assert.deepEqual([...getter.throws], ['RuntimeError']);
  assert.deepEqual(getter.sig, { async: false, params: [], returns: null });
  assert.deepEqual(asked.find(([first]) => first === '@property'), ['@property', true]);
  assert.deepEqual(asked.find(([first]) => first === '@contextlib.contextmanager'), ['@contextlib.contextmanager', false], 'a module function is not a method');
  assert.equal(pythonSpec(parser).renderSig(getter), 'rendered');
  assert.equal(pythonSpec(NO_PARSER).renderSig(collect('httpx_exceptions.py')[0]), 'def __init__(self, message: str) -> None');
});

test('a range outside the text is a bug, not a quiet wrong declaration', () => {
  const symbols = symbolsOf('httpx_auth.py');
  assert.throws(() => collectPythonSymbols(symbols, 'x = 1\n', NO_PARSER), RangeError);
});

test('the end of a def read from the text: comments, blank lines, strings, brackets and continuations', () => {
  const end = (text) => { const s = scanDef(text, text.indexOf('def'), 0, text.length); return s && text.slice(0, s.end); };
  assert.equal(end('def f():\n    a = 1\n# a comment at the def\'s indentation\n\n    b = 2\n\nx = 3\n'), 'def f():\n    a = 1\n# a comment at the def\'s indentation\n\n    b = 2');
  assert.equal(end('def f():\n    s = """\nunindented\n"""\n    return s\nnext = 1\n'), 'def f():\n    s = """\nunindented\n"""\n    return s');
  assert.equal(end('def f(\n    a,\n) -> int:\n    return (1,\n2)\ny = 1\n'), 'def f(\n    a,\n) -> int:\n    return (1,\n2)');
  assert.equal(end('def f():\n    x = 1 + \\\n2\n    return x  # trailing\n\n\nz = 1\n'), 'def f():\n    x = 1 + \\\n2\n    return x');
  assert.equal(end('def f(a: dict[str, int] = {"k": 1}) -> "int": ...\ndef g(): ...\n'), 'def f(a: dict[str, int] = {"k": 1}) -> "int": ...');
  assert.equal(end('def f(a, b'), null, 'no header colon: not a definition the scan can place');
});

// ---- through the pipeline -------------------------------------------------------------

/** LanguageServices replaying the recording; `script[side]` overrides: 'null', 'reject', 'empty'. */
function replayServices(script = {}) {
  const byHash = new Map(Object.values(recorded.texts).map((r) => [r.sha256, r.symbols]));
  return {
    available: async () => ({ ok: true }),
    documentSymbols: async (doc) => {
      const override = script[doc.side];
      if (override === 'null') return null;
      if (override === 'reject') throw new Error('Pyright crashed');
      if (override === 'empty') return [];
      const symbols = byHash.get(sha(doc.text));
      return symbols ? JSON.parse(JSON.stringify(symbols)) : [];
    },
    prepareCallHierarchy: async () => assert.fail('callers come from the resolver'),
    incomingCalls: async () => assert.fail('callers come from the resolver'),
    references: async () => assert.fail('callers come from the resolver'),
    implementations: async () => null,
    definitions: async () => null,
  };
}

const noCallers = () => () => ({
  callerState: async () => ({ state: 'none', callers: [], complete: true }),
  incoming: async () => [],
  incomingWithStatus: async () => ({ callers: [], complete: true }),
});

function repoWith(base, head) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-python-symbols-')));
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

/** Runs `analyze()` with Python's provider on the stub parser (P3's kinds are not tested here). */
async function runPython(dir, services) {
  const stubbed = Object.freeze({ ...pythonProvider, prepare: (ctx) => prepareFromServerSymbols(ctx, pythonSpec(NO_PARSER)) });
  const restore = useLanguagesForTest([LANGUAGES[0], LANGUAGES[1], stubbed]);
  try {
    return await analyze(dir, {
      mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true,
      languageServices: services, makeResolver: noCallers(),
    });
  } finally {
    restore();
  }
}

test('changed, added and deleted Python functions, a recovered getter and a nested def\'s edit', async () => {
  const repo = repoWith({ 'pyproject.toml': '[project]\nname = "t"\n', 'pkg/tool.py': texts['tool.py@base'] },
    { 'pkg/tool.py': texts['tool.py@head'] });
  try {
    const result = await runPython(repo.dir, replayServices());
    assert.deepEqual(result.unanalysable, []);
    assert.deepEqual(result.components.map((c) => c.component), ['(root)']);
    const changed = result.allChanged.map((c) => [c.key, c.added]).sort();
    assert.deepEqual(changed, [
      ['Tool.Inner.Deeper.deepest', false],
      // The getter, which Pyright does not list: its change is its own row, not outside.
      ['Tool.size', false],
      ['added', true],
      ['fetch#2', false],
      // `inner` changed: its parent's body (P-D5). The first `helper`, not the second.
      ['helper', false],
    ]);
    assert.deepEqual(result.deleted.map((d) => d.key), ['removed']);
    // Only the two blank lines added before `added` are outside every function (as Go's
    // blank line before an added function): no def's change is.
    assert.deepEqual(result.outside.map((o) => o.ranges), [[[75, 76]]]);
    assert.deepEqual(texts['tool.py@head'].split('\n').slice(74, 76), ['', '']);
  } finally {
    repo.remove();
  }
});

test('no answer, a failed request, or an empty answer for a text with a def: not analysed, with the reason', async () => {
  const cases = [
    ['null', 'head', /pkg\/tool\.py: NOT analysed — the Python language server gave no symbols$/],
    ['reject', 'base', /the Python language server could not list the symbols for its base version: Pyright crashed/],
    ['empty', 'head', /the Python language server listed no symbols, though the file declares functions/],
    ['empty', 'base', /the Python language server listed no symbols for its base version, though the file declares functions/],
  ];
  for (const [answer, side, reason] of cases) {
    const repo = repoWith({ 'pkg/tool.py': texts['tool.py@base'] }, { 'pkg/tool.py': texts['tool.py@head'] });
    try {
      const result = await runPython(repo.dir, replayServices({ [side]: answer }));
      assert.ok(result.warnings.some((w) => reason.test(w)), `${answer} on ${side}: ${result.warnings.join(' | ')}`);
      assert.equal(result.allChanged.length, 0);
      assert.equal(result.deleted.length, 0);
      assert.deepEqual(result.unanalysable, [{ component: '(no pyproject.toml)', count: 1 }]);
      const file = result.otherFiles.find((f) => f.path === 'pkg/tool.py');
      // Listed, with the reason on the file (the tree shows "not analysed" before anything
      // else, test/not-analysed.test.js).
      assert.ok(file && file.notAnalysed && file.notAnalysed.language === 'Python' && result.warnings.some((w) => reason.test(w) && w.endsWith(file.notAnalysed.reason)), `the file stays listed, marked not analysed: ${JSON.stringify(file)}`);
    } finally {
      repo.remove();
    }
  }
});

test('an empty answer for a text with no def is an analysed file with no function', async () => {
  const repo = repoWith({ 'pkg/consts.py': 'LIMIT = 1\n' }, { 'pkg/consts.py': 'LIMIT = 2\n' });
  try {
    const result = await runPython(repo.dir, replayServices());
    assert.deepEqual(result.unanalysable, []);
    assert.equal(result.allChanged.length, 0);
    // Listed as a file with no changed function: analysed, not "not analysed".
    assert.deepEqual(result.otherFiles, [{ path: 'pkg/consts.py', status: 'modified', noCallable: true }]);
  } finally {
    repo.remove();
  }
});
