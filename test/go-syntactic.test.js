'use strict';
// Go without a language server (S3, docs/MULTI_LANGUAGE_PLAN.md): the text outline
// (`goOutline`, src/languages/go/outline.js) that stands in for gopls' document symbols, and
// the provider's `prepareSyntactic` hook, which the CLI and the no-checkout preview use:
// changed functions and their kinds from the text, callers from the PR files (S4),
// never "no callers" or "no impact". The outline's answers for the texts here are the ones
// gopls v0.21.0 gave for them (names, kinds, ranges and name ranges compared one by one when
// this was written); test/server-symbols.test.js checks it against the recorded fixture too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const { goOutline, skipNonCode } = require('../src/languages/go/outline');
const { collectGoSymbols, goProvider } = require('../src/languages/go/provider');
const models = require('../src/tree-row-models');
const { ts, root } = require('./bug-regressions-helpers');

/** Each symbol as [name, kind, the text its range covers]. */
const outlined = (text) => goOutline(text).map((s) => [s.name, s.kind, text.slice(s.range.start, s.range.end)]);
const nameAt = (text) => goOutline(text).map((s) => text.slice(s.selectionRange.start, s.selectionRange.end));

test('the lexer skips strings, raw strings, runes and comments', () => {
  const at = (text) => skipNonCode(text, 0);
  assert.equal(at('"a}\\"{" x'), 7, 'an interpreted string with an escaped quote');
  assert.equal(at("'}' x"), 3);
  assert.equal(at("'\\'' x"), 4, 'an escaped quote rune');
  assert.equal(at('`a\n}"` x'), 6, 'a raw string spans lines and has no escapes');
  assert.equal(at('// }\nx'), 4, 'a line comment ends before its newline');
  assert.equal(at('/* }\n */x'), 8);
  assert.equal(at('x'), 0, 'nothing starts here');
  assert.equal(at('"open\n"'), -1, 'an interpreted string does not span lines');
  assert.equal(at('/* open'), -1);
});

test('braces and `func` inside literals and comments count for nothing', () => {
  const text = [
    'package p',
    '',
    'var s = "}{\\"}"',
    "var r = '}'",
    "var q = '\\''",
    'var raw = `',
    'func fake() {',
    '}`',
    '',
    '/* func hidden() { */',
    'func real(x struct{ A int `json:"}"` }) interface{ M() } {',
    '\ts := "{"',
    "\t_ = '{'",
    '\t// }',
    '\t/* } */',
    '\treturn nil',
    '}',
    '',
    'var f = func() {}',
    '',
    'func after() {}',
    '',
  ].join('\n');
  const got = outlined(text);
  assert.deepEqual(got.map(([name]) => name), ['real', 'after'], 'no literal, comment or variable initialiser is a declaration');
  assert.ok(got[0][2].startsWith('func real(') && got[0][2].endsWith('return nil\n}'), 'the body ends at its own brace');
  assert.equal(got[1][2], 'func after() {}');
});

test('receivers are named as gopls names them: pointer, value, generic, unnamed', () => {
  const text = [
    'package p',
    '',
    'func (s *Set[T]) Add(v T) { s.m[v] = struct{}{} }',
    '',
    'func (Set[T]) Len() int { return 0 }',
    '',
    'func (p Pair[K,   V]) Key() K { var k K; return k }',
    '',
    'func (c Config) Size() int { return 0 }',
    '',
    'func (*Config) Reset() {}',
    '',
    'func Map[T, U any](xs []T, f func(T) U) []U {',
    '\treturn nil',
    '}',
    '',
  ].join('\n');
  const symbols = goOutline(text);
  assert.deepEqual(symbols.map((s) => [s.name, s.kind]), [
    ['(*Set[T]).Add', 6], ['(Set[T]).Len', 6], ['(Pair[K, V]).Key', 6], ['(Config).Size', 6], ['(*Config).Reset', 6], ['Map', 12],
  ]);
  assert.deepEqual(nameAt(text), ['Add', 'Len', 'Key', 'Size', 'Reset', 'Map'], 'the selection range is the name');
  assert.ok(symbols.every((s) => text.startsWith('func', s.range.start) && text[s.range.end - 1] === '}'));
  // Keyed as G2 keys gopls' symbols: the receiver's base type.
  assert.deepEqual(collectGoSymbols(symbols, text).map((s) => [s.key, s.className]), [
    ['(Set).Add', 'Set'], ['(Set).Len', 'Set'], ['(Pair).Key', 'Pair'], ['(Config).Size', 'Config'], ['(Config).Reset', 'Config'], ['Map', null],
  ]);
});

test('repeats are keyed #2 in source order, and a method named init is not one of them', () => {
  const text = 'package p\n\nfunc init() {}\n\nfunc (c *Config) init() {}\n\nfunc init() {\n\tx()\n}\n';
  assert.deepEqual(collectGoSymbols(goOutline(text), text).map((s) => s.key), ['init', '(Config).init', 'init#2']);
});

test('a declaration without a body ends at its signature; a header may span lines', () => {
  const text = [
    'package p',
    '',
    '// add is in assembly.',
    'func add(a, b int) int',
    '',
    'func sub(a int,',
    '\tb int,',
    ') (',
    '\tr int,',
    '\terr error,',
    ') // trailing',
    '',
    'func Res() (func() int) { return nil }',
    'func ch() <-chan int { return nil }',
    'func gen[',
    '\tT any,',
    '](x T) {',
    '}',
    '',
  ].join('\n');
  const got = outlined(text);
  assert.deepEqual(got, [
    ['add', 12, 'func add(a, b int) int'],
    ['sub', 12, 'func sub(a int,\n\tb int,\n) (\n\tr int,\n\terr error,\n)'],
    ['Res', 12, 'func Res() (func() int) { return nil }'],
    ['ch', 12, 'func ch() <-chan int { return nil }'],
    ['gen', 12, 'func gen[\n\tT any,\n](x T) {\n}'],
  ]);
  const keyed = collectGoSymbols(goOutline(text), text);
  assert.deepEqual(keyed[0].sig && keyed[0].sig.params.map((p) => p.type), ['int', 'int'], 'the header parser reads a bodiless declaration');
  assert.deepEqual(keyed[1].sig && keyed[1].sig.params.map((p) => p.name), ['a', 'b']);
});

test('text that is not valid Go never throws: an unterminated literal ends the outline', () => {
  assert.deepEqual(outlined('package p\n\nfunc a() {}\n\nvar s = `open\n\nfunc b() {}\n').map(([n]) => n), ['a']);
  assert.deepEqual(outlined('package p\n\nfunc a() {\n'), [], 'an unclosed body is not a declaration this can read');
  assert.deepEqual(outlined(''), []);
});

test('a preview reads Go from the fetched text: kinds, callers from the PR\'s files (never complete), tests listed, nothing read from disk', async (t) => {
  clearVirtualText();
  const files = {
    'cmd/run.go@base': 'package cmd\n\nfunc Run(a int) error {\n\treturn nil\n}\n\nfunc (o Opts) Name() string { return "a" }\n\nfunc gone() {}\n\nfunc body() int {\n\treturn 1\n}\n',
    'cmd/run.go@head': 'package cmd\n\nfunc Run(a int, b string) error {\n\treturn nil\n}\n\nfunc (o *Opts) Name() string { return "a" }\n\nfunc body() int {\n\treturn 2\n}\n\nfunc added() {}\n',
    'cmd/run_test.go@head': 'package cmd\n\nfunc TestRun(t *testing.T) { Run(1, "b") }\n',
    'pkg/m.py@base': 'def f():\n    return 1\n', 'pkg/m.py@head': 'def f():\n    return 2\n',
  };
  const goPatch = '@@ -1,13 +1,15 @@\n package cmd\n \n-func Run(a int) error {\n+func Run(a int, b string) error {\n \treturn nil\n }\n \n-func (o Opts) Name() string { return "a" }\n+func (o *Opts) Name() string { return "a" }\n \n-func gone() {}\n-\n func body() int {\n-\treturn 1\n+\treturn 2\n }\n+\n+func added() {}\n';
  const gh = {
    listPullRequestFiles: async () => ({ total: 3, files: [
      { path: 'cmd/run.go', oldPath: 'cmd/run.go', status: 'modified', patch: goPatch },
      { path: 'cmd/run_test.go', oldPath: 'cmd/run_test.go', status: 'modified', patch: '@@ -3 +3 @@\n-a\n+b' },
      { path: 'pkg/m.py', oldPath: 'pkg/m.py', status: 'modified', patch: '@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2' },
    ] }),
    fileAtRef: async (_, p, ref) => files[`${p}@${ref}`] ?? null,
  };
  // Nothing under the repository root is read from disk: no go.mod probe, no Go text.
  const read = [];
  for (const name of ['existsSync', 'readFileSync', 'statSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (p, ...rest) => {
      if (typeof p === 'string' && p.startsWith(`${root}/`)) read.push(p);
      return original.call(fs, p, ...rest);
    });
  }
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 9, headSha: 'head', mergeBaseSha: 'base', baseRef: 'main' }, repoRoot: root });
  t.mock.restoreAll();
  assert.deepEqual(read.filter((p) => /\.go$|go\.mod$/.test(p)), []);
  const go = r.allChanged.filter((c) => c.relPath === 'cmd/run.go');
  const by = Object.fromEntries(go.map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(by).sort(), ['(Opts).Name', 'Run', 'added', 'body']);
  assert.deepEqual(by.Run.kinds.map((k) => k.id), ['required-param']);
  assert.deepEqual(by['(Opts).Name'].kinds.map((k) => k.id), ['type-changed'], 'a receiver from T to *T is one method with a changed signature');
  assert.equal(by['(Opts).Name'].label, '(*Opts).Name');
  assert.deepEqual(by.body.kinds.map((k) => k.id), ['body']);
  assert.equal(by.added.added, true);
  assert.deepEqual(r.deleted.filter((d) => d.relPath === 'cmd/run.go').map((d) => d.key), ['gone']);
  for (const c of go) {
    assert.equal(c.component, 'pull request');
    assert.equal(c.callersComplete, false, c.key);
    assert.match(c.callersIncompleteReason, /^Go callers from syntax only: the pull request's own files \(2 Go file\(s\) indexed\)/, c.key);
    assert.match(c.callersIncompleteReason, /the package's files outside the pull request were not read/, c.key);
    assert.notEqual(c.callerState, 'none', `${c.key}: never "no callers"`);
    assert.notEqual(c.testState, 'uncovered', `${c.key}: never "no test"`);
    assert.doesNotMatch(models.classifyChangeVerdict(c).sentence, /no callers|no impact/i, c.key);
  }
  assert.equal(r.allChanged.some((c) => c.relPath === 'cmd/run_test.go'), false, 'a changed test is not diffed');
  const other = Object.fromEntries(r.otherFiles.map((f) => [f.path, f]));
  assert.ok(other['cmd/run_test.go'], 'a changed test is listed');
  assert.equal(r.otherFiles.some((f) => f.notAnalysed), false, 'no Go file is "not analysed"');
  assert.ok(r.reviewSymbols.get('cmd/run.go'), 'the review identity has the symbols recorded');
  assert.deepEqual(r.callersScope.map((s) => [s.language, s.scope]), [['Go', 'pr-files'], ['Python', 'pr-files']]);
  assert.match(r.callersScope[0].note, /^Go callers from syntax only: the pull request's own files \(2 Go file\(s\) indexed\)/);
  const note = models.previewLimitsNote(r);
  assert.match(note, /Go callers are from syntax only, in the PR's own files: calls through an interface or a function value, and receivers whose type is not written are not resolved/);
  assert.match(note, /Python callers are from syntax only, in the PR's own files: untyped receivers and dynamic calls are not resolved/);
  assert.doesNotMatch(note, /not analysed|not computed/);
  assert.ok(r.warnings.some((w) => /^1 changed Go file\(s\) read from their text: changed functions and signature kinds; Go callers from syntax only: the pull request's own files/.test(w)));
  assert.deepEqual(by.Run.callers.map((c) => [c.label, c.test]), [['TestRun', true]], 'the changed test calls Run');
  assert.equal(by.Run.callerState, 'resolved');
  const expanded = await r.resolver.incomingWithStatus(by.Run.file, by.Run.namePos);
  assert.equal(expanded.complete, false);
  assert.deepEqual(expanded.callers.map((c) => c.label), ['TestRun'], 'expanding a Go row asks Go\'s index');
  assert.equal(r.allChanged.filter((c) => c.callersComplete !== false).length, 0, 'no complete answer in the preview');
  clearVirtualText();
});

test('the provider declares the hook and still needs a server in the editor', () => {
  assert.equal(typeof goProvider.prepareSyntactic, 'function');
  assert.equal(goProvider.needsServer, true);
});
