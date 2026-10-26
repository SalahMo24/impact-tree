'use strict';
// Java without a language server (J7, docs/MULTI_LANGUAGE_PLAN.md): the text outline
// (`javaOutline`, src/languages/java/outline.js) that stands in for jdtls' document symbols,
// and the provider's `prepareSyntactic` hook, which the CLI and the no-checkout preview use:
// changed methods and their kinds from the text, callers from a syntax index (J8), never "no callers"
// or "no impact". The strongest check is the first: on every text of test/java-symbols/ the
// outline is jdtls' recorded answer, symbol for symbol (names, kinds, details, hierarchy,
// ranges and name ranges).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const { javaOutline, MAX_TEXT_CHARS } = require('../src/languages/java/outline');
const { collectJavaSymbols, javaProvider } = require('../src/languages/java/provider');
const models = require('../src/tree-row-models');
const { ts, root } = require('./bug-regressions-helpers');
const texts = require('./java-symbols/texts');
const recorded = require('./java-symbols/recorded.json');

/** Every symbol as `path/name` → the symbol, depth first. */
const flat = (symbols, prefix = '', out = []) => {
  for (const s of symbols) {
    out.push([`${prefix}/${s.name}`, s]);
    flat(s.children || [], `${prefix}/${s.name}`, out);
  }
  return out;
};
/** Each top-level-or-nested symbol as [path, kind, the text its range covers, the name's text]. */
const outlined = (text) => flat(javaOutline(text)).map(([id, s]) => [id, s.kind, text.slice(s.range.start, s.range.end), text.slice(s.selectionRange.start, s.selectionRange.end)]);
const pathsOf = (text) => flat(javaOutline(text)).map(([id]) => id);

test('the outline is jdtls\' recorded answer on every fixture text', () => {
  for (const [name, text] of Object.entries(texts)) {
    const ours = javaOutline(text);
    assert.ok(ours, `${name} is read`);
    assert.deepEqual(ours, recorded.texts[name].symbols, name);
  }
});

test('keys from the outline are the keys from jdtls\' answer', () => {
  for (const [name, text] of Object.entries(texts)) {
    const fromServer = collectJavaSymbols(recorded.texts[name].symbols, text);
    const fromText = collectJavaSymbols(/** @type {any} */ (javaOutline(text)), text);
    assert.deepEqual(fromText, fromServer, name);
  }
});

test('braces, quotes and keywords inside literals and comments count for nothing', () => {
  const text = [
    'class A {',
    '  String s = "}{ class X { void m() {} }";',
    '  char c = \'{\', q = \'"\', e = \'\\\'\';',
    '  String block = """',
    '      } " class Y { } \\""" {',
    '      """;',
    '  /* } class Z { */',
    '  // } void hidden() {',
    '  void m() { String t = "{"; }',
    '}',
  ].join('\n');
  assert.deepEqual(pathsOf(text), ['/A', '/A/s', '/A/c', '/A/q', '/A/e', '/A/block', '/A/m()']);
});

test('annotations with arguments, generics and comparisons, lambdas, switch arrows, `default`', () => {
  const text = [
    'class A<T extends Comparable<? super T>> {',
    '  @SuppressWarnings(value = {"a", "b)"}) @Ann(x = (1 + 2), y = @B({}))',
    '  <K, V extends List<K>> Map<K, V> f(java.util.Map.Entry<K, V>[] e, @Nullable final String... rest) throws IOException, E { return null; }',
    '  boolean b = x < y, c = y > z;',
    '  Map<String, Integer> m = new HashMap<String, Integer>(), n = Collections.<String, Integer>emptyMap();',
    '  int sw(int k) {',
    '    Runnable r = () -> { if (k < 2 && k > 0) {} };',
    '    return switch (k) { case 1 -> { yield 1; } default -> 2; };',
    '  }',
    '  int old(int a[], String[] b)[] { return null; }',
    '}',
    '@interface Ann {',
    '  int x() default 1;',
    '  String[] names() default {"a", "b"};',
    '  B y() default @B({});',
    '}',
  ].join('\n');
  const got = outlined(text).map(([id, kind]) => [id, kind]);
  assert.deepEqual(got, [
    ['/A<T extends Comparable<? super T>>', 5],
    ['/A<T extends Comparable<? super T>>/f(Entry<K, V>[], String...) <K, V>', 6],
    ['/A<T extends Comparable<? super T>>/b', 8],
    ['/A<T extends Comparable<? super T>>/c', 8],
    ['/A<T extends Comparable<? super T>>/m', 8],
    ['/A<T extends Comparable<? super T>>/n', 8],
    ['/A<T extends Comparable<? super T>>/sw(int)', 6],
    ['/A<T extends Comparable<? super T>>/old(int[], String[])', 6],
    ['/Ann', 11],
    ['/Ann/x()', 6],
    ['/Ann/names()', 6],
    ['/Ann/y()', 6],
  ]);
  const f = outlined(text)[1];
  assert.match(f[2], /^@SuppressWarnings[\s\S]*\{ return null; \}$/, 'the range starts at the first annotation');
  assert.equal(f[3], 'f');
  const keys = collectJavaSymbols(/** @type {any} */ (javaOutline(text)), text).map((s) => s.key);
  assert.deepEqual(keys, ['A.f(Entry[], String...)', 'A.sw(int)', 'A.old(int[], String[])', 'Ann.x()', 'Ann.names()', 'Ann.y()']);
});

test('enums, records, anonymous classes in fields and methods, local classes', () => {
  const text = [
    'enum E {',
    '  /** Doc. */',
    '  A(1) { @Override int v() { return 1; } },',
    '  B(new Object() { }),',
    '  C;',
    '  E(int i) {}',
    '  E(Object o) {}',
    '  int v() { return 0; }',
    '}',
    'record R<T>(@Ann int x, List<T> ys) implements I {',
    '  R { if (x < 0) throw new IllegalArgumentException(); }',
    '  static final Comparator<R<?>> BY_X = new Comparator<R<?>>() { public int compare(R<?> a, R<?> b) { return 0; } };',
    '  void m() { final class Local { void n() {} } Object o = new Runnable() { public void run() {} }; Class<?> k = R.class; }',
    '}',
  ].join('\n');
  assert.deepEqual(pathsOf(text), [
    '/E', '/E/A', '/E/A/{...}', '/E/A/{...}/v()', '/E/B', '/E/B/new Object() {...}', '/E/C', '/E/E(int)', '/E/E(Object)', '/E/v()',
    '/R<T>', '/R<T>/x', '/R<T>/ys', '/R<T>/R(int, List<T>)', '/R<T>/BY_X', '/R<T>/BY_X/new Comparator() {...}',
    '/R<T>/BY_X/new Comparator() {...}/compare(R<?>, R<?>)', '/R<T>/m()', '/R<T>/m()/Local', '/R<T>/m()/Local/n()',
    '/R<T>/m()/new Runnable() {...}', '/R<T>/m()/new Runnable() {...}/run()',
  ]);
  const byPath = Object.fromEntries(outlined(text).map(([id, kind, range, name]) => [id, { kind, range, name }]));
  assert.equal(byPath['/E/A'].kind, 22);
  assert.match(byPath['/E/A'].range, /^\/\*\* Doc\. \*\/\n {2}A\(1\) \{[\s\S]*\}$/, 'a constant\'s range has its Javadoc and its body');
  assert.equal(byPath['/E/A/{...}'].kind, 10);
  assert.match(byPath['/E/A/{...}'].range, /^A\(1\) \{/, 'its body starts at its name');
  assert.equal(byPath['/R<T>/R(int, List<T>)'].kind, 9, 'the compact constructor is named by the components');
  assert.equal(byPath['/R<T>/x'].range, '@Ann int x');
  assert.equal(byPath['/R<T>/BY_X'].kind, 14);
  const keys = collectJavaSymbols(/** @type {any} */ (javaOutline(text)), text).map((s) => s.key);
  assert.deepEqual(keys, ['E.A.v()', 'E.<init>(int)', 'E.<init>(Object)', 'E.v()', 'R.<init>(int, List)', 'R.BY_X.compare(R, R)', 'R.m()']);
});

test('a comment on the line where the previous member ends is that member\'s, not the next one\'s', () => {
  const text = 'class A {\n  int a; // about a\n  // about b\n  int b;\n}\n';
  const [, a, b] = outlined(text);
  assert.equal(a[2], 'int a;');
  assert.equal(b[2], '// about b\n  int b;');
});

test('text this cannot read is null, never a partial outline', () => {
  const ok = 'class A { void m() {} }\n';
  assert.ok(javaOutline(ok));
  for (const [why, text] of [
    ['an unterminated string', 'class A { String s = "open; void m() {} }'],
    ['an unterminated text block', 'class A { String s = """\n open; }'],
    ['an unterminated block comment', 'class A { /* void m() {} }'],
    ['an unterminated char', "class A { char c = '{; }"],
    ['an unclosed body', 'class A { void m() {\n'],
    ['a stray closing brace', 'class A { void m() {} } }'],
    ['mismatched brackets', 'class A { void m() { f(]; } }'],
    ['a member it cannot parse', 'class A { int = 3; }'],
    ['an unclosed type argument list', 'class A { List<String m; }'],
  ]) assert.equal(javaOutline(text), null, why);
  assert.equal(javaOutline(`class A {}\n${' '.repeat(MAX_TEXT_CHARS)}`), null, 'longer than the budget');
  assert.deepEqual(javaOutline(''), []);
});

test('a preview reads Java from the fetched text: kinds, callers from the PR index (incomplete), nothing read from disk', async (t) => {
  clearVirtualText();
  const base = 'package a;\n\npublic class Codec {\n  public String encode(String s) {\n    return s;\n  }\n\n  public void gone() {}\n\n  int body() {\n    return 1;\n  }\n}\n';
  const head = 'package a;\n\npublic class Codec {\n  public String encode(String s, boolean strict) {\n    return s;\n  }\n\n  int body() {\n    return 2;\n  }\n\n  void added() {}\n}\n';
  const files = { 'src/main/java/a/Codec.java@base': base, 'src/main/java/a/Codec.java@head': head };
  const patch = '@@ -1,13 +1,13 @@\n package a;\n \n public class Codec {\n-  public String encode(String s) {\n+  public String encode(String s, boolean strict) {\n     return s;\n   }\n \n-  public void gone() {}\n-\n   int body() {\n-    return 1;\n+    return 2;\n   }\n+\n+  void added() {}\n }\n';
  const gh = {
    listPullRequestFiles: async () => ({ total: 1, files: [
      { path: 'src/main/java/a/Codec.java', oldPath: 'src/main/java/a/Codec.java', status: 'modified', patch },
    ] }),
    fileAtRef: async (_, p, ref) => files[`${p}@${ref}`] ?? null,
  };
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
  assert.deepEqual(read.filter((p) => /\.java$|pom\.xml$|build\.gradle/.test(p)), []);
  const java = r.allChanged.filter((c) => c.relPath === 'src/main/java/a/Codec.java');
  const by = Object.fromEntries(java.map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(by).sort(), ['Codec.added()', 'Codec.body()', 'Codec.encode(String)']);
  assert.equal(by['Codec.encode(String)'].label, 'Codec.encode(String, boolean)', 'the overload pairing keeps the base key');
  assert.deepEqual(by['Codec.encode(String)'].kinds.map((k) => k.id), ['required-param']);
  assert.deepEqual(by['Codec.body()'].kinds.map((k) => k.id), ['body']);
  assert.equal(by['Codec.added()'].added, true);
  assert.deepEqual(r.deleted.map((d) => d.key), ['Codec.gone()']);
  for (const c of java) {
    assert.equal(c.callersComplete, false, c.key);
    assert.match(c.callersIncompleteReason, /^Java callers from syntax only: the pull request's own files .*the files outside the pull request were not read/, c.key);
    assert.notEqual(c.callerState, 'none', `${c.key}: never "no callers"`);
    assert.notEqual(c.testState, 'uncovered', `${c.key}: never "no test"`);
    assert.doesNotMatch(models.classifyChangeVerdict(c).sentence, /no callers|no impact/i, c.key);
  }
  assert.equal(r.otherFiles.some((f) => f.notAnalysed), false, 'no Java file is "not analysed"');
  assert.ok(r.warnings.some((w) => /^1 changed Java file\(s\) read from their text: changed methods and signature kinds; Java callers from syntax only/.test(w)), r.warnings.join('\n'));
  assert.equal(typeof javaProvider.prepareSyntactic, 'function');
  clearVirtualText();
});
