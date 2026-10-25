'use strict';
// Python without a language server (A4, docs/MULTI_LANGUAGE_PLAN.md): the text outline
// (`pythonOutline`, src/languages/python/provider.js) that stands in for Pyright's document
// symbols, and the provider's `prepareSyntactic` hook, which the CLI and the no-checkout
// preview use: changed functions and their kinds from the text, callers from a syntax-only
// index (A8: src/languages/python/syntactic-index.js; its own rules are in
// test/python-syntactic-index.test.js), never "no callers" or "no impact".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const { collectPythonSymbols, pythonOutline, pythonProvider } = require('../src/languages/python/provider');
const { isSyntaxOnlyReason } = require('../src/engine/resolver-not-computed');
const models = require('../src/tree-row-models');
const texts = require('./python-symbols/texts');
const recorded = require('./python-symbols/recorded.json');
const { ts, root } = require('./bug-regressions-helpers');

const SOURCE = [
  'import typing',                                   // 1
  '',
  'def top(a, b=1):',                                // 3
  '    """A docstring.',
  'def not_a_def(x):',                               // 5: inside the docstring
  '    """',
  '    def inner():',                                 // 7: nested def, top's body
  '        return 1',
  '    class Local:',                                 // 9: a class in a function, its body
  '        def m(self): pass',
  '    return inner()',
  '',
  'async def fetch(url):',                           // 13
  '    return url',
  '',
  'x = """',
  'def in_string():',                                // 17: a module-level string
  '"""',
  '',
  'if typing.TYPE_CHECKING:',
  '    def branch(): return 1',                       // 21
  'else:',
  '    def branch(): return 2',                       // 23
  '',
  '@typing.overload',
  'def over(a: int) -> int: ...',                    // 26
  '@typing.overload',
  'def over(a: str) -> str: ...',                    // 28
  'def over(a):',                                    // 29
  '    return a',
  '',
  'class Outer:',                                    // 32
  '    """Docs.',
  '    def doc_line(self): text in the class docstring',
  '    """',
  '    @property',
  '    def timeout(self):',                           // 37
  '        return self._t',
  '',
  '    # a comment at the body\'s indentation',
  '    @timeout.setter',
  '    def timeout(self, value):',                    // 42
  '        self._t = value',
  '',
  '    @staticmethod',
  '    def make(',                                    // 46
  '        a,',
  '        b,',
  '    ):',
  '        return a + b',
  '',
  '    class Inner:',                                 // 52
  '        async def run(self):',                     // 53
  '            def helper(): pass',
  '            return helper',
  '',
  '    if True:',
  '        def maybe(self): return 1',                // 58
  '',
  'def after(): return 0',                           // 60
  '',
].join('\n');

const keysOf = (text) => collectPythonSymbols(pythonOutline(text), text, undefined, { recover: false })
  .map((s) => `${s.key}:${s.startLine}-${s.endLine}`);

test('the outline lists module functions, methods and nested classes, keyed as the server path keys them', () => {
  assert.deepEqual(keysOf(SOURCE), [
    'top:3-11',
    'fetch:13-14',
    'branch:21-21',
    'branch#2:23-23',
    'over:25-26',
    'over#2:27-28',
    'over#3:29-30',
    'Outer.timeout:36-38',
    'Outer.timeout#2:41-43',
    'Outer.make:45-50',
    'Outer.Inner.run:53-55',
    'Outer.maybe:58-58',
    'after:60-60',
  ]);
});

test('the outline reads decorators, binding, async and methods like the server path', () => {
  const symbols = collectPythonSymbols(pythonOutline(SOURCE), SOURCE, undefined, { recover: false });
  const by = Object.fromEntries(symbols.map((s) => [s.key, s]));
  assert.equal(by['Outer.timeout'].binding, 'property');
  assert.equal(by['Outer.timeout#2'].binding, 'property');
  assert.equal(by['Outer.make'].binding, 'staticmethod');
  assert.equal(by['Outer.make'].className, 'Outer');
  assert.equal(by['Outer.Inner.run'].className, 'Inner');
  assert.match(by.fetch.header, /^async def fetch\(url\):?$/);
  assert.equal(by.top.className, null);
  assert.equal(SOURCE.slice(by['Outer.timeout'].start).startsWith('@property'), true, 'the range starts at the first decorator');
  assert.equal(SOURCE.slice(by.top.namePos).startsWith('top('), true);
  // Nothing from a string, a docstring or a function's body is listed.
  for (const name of ['not_a_def', 'in_string', 'doc_line', 'inner', 'Local', 'm', 'helper']) {
    assert.equal(symbols.some((s) => s.simpleName === name), false, `${name} is not a definition`);
  }
});

test('on every recorded fixture the outline gives what Pyright plus the recovery gives', () => {
  const shape = (xs) => xs.map((x) => `${x.key}@${x.namePos}[${x.start},${x.end}]${x.binding}`);
  for (const [name, text] of Object.entries(texts)) {
    const server = collectPythonSymbols(JSON.parse(JSON.stringify(recorded.texts[name].symbols)), text);
    const outline = collectPythonSymbols(pythonOutline(text), text, undefined, { recover: false });
    assert.deepEqual(shape(outline), shape(server), name);
  }
});

test('the outline of an empty, a CRLF and an unterminated text', () => {
  assert.deepEqual(pythonOutline(''), []);
  assert.deepEqual(keysOf('class A:\r\n    def f(self):\r\n        return 1\r\n\r\ndef g():\r\n    pass\r\n'), ['A.f:2-3', 'g:5-6']);
  assert.deepEqual(keysOf('def f():\n    s = """never closed\ndef g():\n    pass\n'), ['f:1-5'], 'a def line inside an unterminated string is not a definition');
  assert.deepEqual(keysOf('def f(\n'), [], 'a header with no colon is not a definition');
});

/** A throwaway repository with a base and a feature commit; returns its path. */
function repoWith(baseFiles, headFiles) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-py-syntactic-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com');
  for (const [p, t] of Object.entries(baseFiles)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); }
  git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'feature');
  for (const [p, t] of Object.entries(headFiles)) {
    if (t == null) fs.rmSync(path.join(dir, p));
    else { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); }
  }
  git('add', '-A'); git('commit', '-qm', 'head');
  return dir;
}

const BASE_PY = 'class C:\n    def keep(self, a):\n        return a\n\n    def gone(self):\n        return 0\n\ndef body():\n    return 1\n';
const HEAD_PY = 'class C:\n    def keep(self, a, b):\n        return a\n\ndef body():\n    return 2\n\nasync def added():\n    raise ValueError()\n';
// An unchanged module that calls the changed ones (rules 1, 5 and 6).
const USER_PY = 'from m import body, C\n\ndef run():\n    c = C()\n    c.keep(1)\n    return body()\n';

// Every answer is a scoped, incomplete one (A8): never complete, never "none", never "no test".
const assertSyntaxOnly = (c) => {
  assert.notEqual(c.callerState, 'none', `${c.key}: never "no callers"`);
  assert.equal(c.callersComplete, false, c.key);
  assert.ok(isSyntaxOnlyReason(c.callersIncompleteReason), c.callersIncompleteReason);
  assert.match(c.callersIncompleteReason, /untyped receivers and dynamic calls are not resolved/);
  assert.notEqual(c.testState, 'uncovered', 'never "no test"');
};

test('without a language server analyze() reads Python from its text: kinds, added and deleted, callers from the repository\'s syntax; Go stays not analysed', async () => {
  const dir = repoWith(
    { 'pyproject.toml': '[project]\nname = "m"\n', 'm.py': BASE_PY, 'n.py': USER_PY, 'go.mod': 'module example.com/m\n\ngo 1.22\n', 'a.go': 'package m\n\nfunc A() int { return 1 }\n' },
    { 'm.py': HEAD_PY, 'a.go': 'package m\n\nfunc A() int { return 2 }\n' });
  try {
    const r = await analyze(dir, { mode: 'pr', allowLocalBase: true, base: 'main', depth: 2 });
    const by = Object.fromEntries(r.allChanged.map((c) => [c.key, c]));
    assert.deepEqual(Object.keys(by).sort(), ['C.keep', 'added', 'body']);
    assert.deepEqual(by['C.keep'].kinds.map((k) => k.id), ['required-param']);
    assert.deepEqual(by.body.kinds.map((k) => k.id), ['body']);
    assert.equal(by.added.added, true);
    assert.deepEqual(r.deleted.map((d) => d.key), ['C.gone']);
    for (const c of r.allChanged) assertSyntaxOnly(c);
    // The CLI indexes the repository (A8-D1 (b)): the unchanged n.py is a caller.
    assert.deepEqual(by.body.callers.map((x) => [x.label, path.basename(x.file)]), [['run', 'n.py']]);
    assert.deepEqual(by['C.keep'].callers.map((x) => x.label), ['run'], 'rule 6: c = C() then c.keep(…)');
    assert.equal(by['C.keep'].callerState, 'resolved');
    assert.equal(by.added.callerState, 'unknown');
    assert.match(by.body.callersIncompleteReason, /^Python callers from syntax only: the repository \(2 Python file\(s\) indexed\)/);
    const roots = r.components.flatMap((c) => c.roots);
    assert.ok(roots.length && roots.every((x) => x.blastNotComputed || x.blastCapped), 'a blast radius from a syntax-only index is a lower bound, never an exact 0');
    assert.deepEqual(r.untested, [], 'nothing reads as untested');
    assert.ok(r.warnings.some((w) => /1 changed Python file\(s\) read from their text: changed functions and signature kinds; Python callers from syntax only: the repository/.test(w)));
    assert.equal(r.otherFiles.find((f) => f.path === 'm.py'), undefined, 'the Python file is analysed, not listed as a file');
    assert.equal(r.otherFiles.find((f) => f.path === 'a.go').notAnalysed.language, 'Go', 'Go is unchanged: not analysed');
    assert.ok(r.reviewSymbols.get('m.py'), 'the review identity has the symbols recorded');
    // In words: no surface says "no callers".
    const sentence = models.classifyChangeVerdict(by.added).sentence;
    assert.match(sentence, /no caller was found within the scope searched \(Python callers from syntax only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an __init__ with no construction found is unknown with the scope note, never "built by a DI container"', async () => {
  const dir = repoWith({ 'k.py': 'class K:\n    def __init__(self):\n        self.a = 1\n' }, { 'k.py': 'class K:\n    def __init__(self):\n        self.a = 2\n' });
  try {
    const r = await analyze(dir, { mode: 'pr', allowLocalBase: true, base: 'main' });
    assert.deepEqual(r.allChanged.map((c) => [c.key, c.callerState]), [['K.__init__', 'unknown']]);
    assertSyntaxOnly(r.allChanged[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the editor keeps Pyright: with language services the hook is not used', async () => {
  const dir = repoWith({ 'm.py': 'def a():\n    return 1\n' }, { 'm.py': 'def a():\n    return 2\n' });
  try {
    let asked = 0;
    const services = {
      available: async () => { asked++; return { ok: false, reason: 'no Python extension' }; },
      documentSymbols: async () => null,
    };
    const r = await analyze(dir, { mode: 'pr', allowLocalBase: true, base: 'main', languageServices: /** @type {any} */ (services), makeResolver: () => null });
    assert.equal(asked, 1, 'prepare asked the services');
    assert.deepEqual(r.allChanged, []);
    assert.equal(r.otherFiles.find((f) => f.path === 'm.py').notAnalysed.language, 'Python');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line prints Python rows with kinds and callers from syntax, never "no callers"', () => {
  const dir = repoWith({ 'm.py': BASE_PY, 'n.py': USER_PY }, { 'm.py': HEAD_PY });
  try {
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const text = execFileSync(process.execPath, [cli, '--repo', dir, '--allow-local-base', '--base', 'main'], { encoding: 'utf8' });
    assert.match(text, /C\.keep {3}required parameter/);
    assert.match(text, /⚠ run {3}n\.py/, 'the unchanged caller is listed as not updated');
    assert.match(text, /more callers may be missing \(Python callers from syntax only: the repository/);
    assert.match(text, /blast 1\+/);
    assert.match(text, /✕ C\.gone {3}m\.py/);
    assert.match(text, /\? added {3}m\.py:8 {2}\(callers unknown: Python callers from syntax only/);
    assert.doesNotMatch(text, /no callers|⚠ no test|blast 0(?!\+)|NOT ANALYSED|not computed: Python/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a preview reads Python from the fetched text: kinds, callers from the PR\'s own Python files and tests, limits note; Go stays not analysed', async () => {
  clearVirtualText();
  const files = {
    'pkg/m.py@base': BASE_PY, 'pkg/m.py@head': HEAD_PY,
    'tests/test_m.py@head': 'from pkg.m import body\n\ndef test_body():\n    assert body() == 2\n',
    'src/a.ts@head': 'export function a() { return 2; }\n', 'src/a.ts@base': 'export function a() { return 1; }\n',
  };
  const pyPatch = '@@ -1,9 +1,9 @@\n class C:\n-    def keep(self, a):\n+    def keep(self, a, b):\n         return a\n \n-    def gone(self):\n-        return 0\n-\n def body():\n-    return 1\n+    return 2\n+\n+async def added():\n+    raise ValueError()\n';
  const gh = {
    listPullRequestFiles: async () => ({ total: 4, files: [
      { path: 'pkg/m.py', oldPath: 'pkg/m.py', status: 'modified', patch: pyPatch },
      { path: 'tests/test_m.py', oldPath: 'tests/test_m.py', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'src/a.ts', oldPath: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'cmd/main.go', oldPath: 'cmd/main.go', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
    ] }),
    fileAtRef: async (_, p, ref) => files[`${p}@${ref}`] ?? null,
  };
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 7, headSha: 'head', mergeBaseSha: 'base', baseRef: 'main' }, repoRoot: root });
  const py = r.allChanged.filter((c) => c.relPath === 'pkg/m.py');
  const by = Object.fromEntries(py.map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(by).sort(), ['C.keep', 'added', 'body']);
  assert.deepEqual(by['C.keep'].kinds.map((k) => k.id), ['required-param']);
  assert.equal(by.added.added, true);
  assert.deepEqual(r.deleted.filter((d) => d.relPath === 'pkg/m.py').map((d) => d.key), ['C.gone']);
  for (const c of py) {
    assertSyntaxOnly(c);
    assert.match(c.callersIncompleteReason, /^Python callers from syntax only: the pull request's own files \(2 Python file\(s\) indexed\)/);
    assert.equal(c.component, 'pull request');
  }
  // The changed test is read as a caller, so it covers `body`.
  assert.deepEqual(by.body.callers.map((x) => [x.label, x.test]), [['test_body', true]]);
  assert.equal(by.body.testState, 'covered');
  assert.equal(by['C.keep'].callerState, 'unknown');
  const tsRow = r.allChanged.find((c) => c.relPath === 'src/a.ts');
  assert.ok(tsRow && !isSyntaxOnlyReason(tsRow.callersIncompleteReason), 'TypeScript keeps its own caller search');
  const by2 = Object.fromEntries(r.otherFiles.map((f) => [f.path, f.notAnalysed]));
  assert.equal(by2['tests/test_m.py'], undefined, 'a Python test is listed as a test, not as not analysed');
  assert.equal(by2['cmd/main.go'].language, 'Go');
  assert.equal('pkg/m.py' in by2, false);
  assert.deepEqual(r.callersScope.map((s) => [s.language, s.scope]), [['Python', 'pr-files']]);
  assert.match(r.callersScope[0].note, /^Python callers from syntax only: the pull request's own files/);
  assert.ok(r.reviewSymbols.get('pkg/m.py'));
  const note = models.previewLimitsNote(r);
  assert.match(note, /Python callers are from syntax only, in the PR's own files/);
  assert.match(note, /Go files are not analysed/);
  // Expanding a Python caller asks the Python index, not TypeScript's.
  const expanded = await r.resolver.incomingWithStatus(by.body.callers[0].file, by.body.callers[0].pos);
  assert.equal(expanded.complete, false);
  assert.ok(isSyntaxOnlyReason(expanded.reason), expanded.reason);
  const tsExpanded = await r.resolver.incomingWithStatus(tsRow.file, tsRow.namePos);
  assert.ok(!isSyntaxOnlyReason(tsExpanded.reason));
  clearVirtualText();
});

test('the provider declares the hook; Go has none', () => {
  assert.equal(typeof pythonProvider.prepareSyntactic, 'function');
  assert.equal(pythonProvider.needsServer, true);
  assert.equal(require('../src/languages/go/provider').goProvider.prepareSyntactic, undefined);
});
