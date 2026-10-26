// @ts-check
'use strict';
// Java signatures (J3, docs/MULTI_LANGUAGE_PLAN.md): a method's or constructor's header parsed
// into the `sig` the shared diffSignature compares, the `throw new` types of its own body, the
// change kinds (J-D4, J-D5) and the display. The whole-repository check against the JDK's
// parser is test/java-signature-oracle.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJavaDeclaration, thrownOf, javaKindsOf, renderJavaSig } = require('../src/languages/java/signature');
const { KIND } = require('../src/engine/signature');

/** @param {string} text */
function parse(text) {
  const parsed = parseJavaDeclaration(text);
  assert.ok(parsed, `expected to parse: ${text}`);
  return parsed;
}
/** @param {string} text @returns {string[]} `type name` of every param, `...` marking varargs */
const pairs = (text) => parse(text).sig.params.map((p) => `${p.type} ${p.name}${p.rest ? ' (rest)' : ''}`);
/** @param {string} text */
const side = (text) => {
  const p = parseJavaDeclaration(text);
  return { sig: p ? p.sig : null, header: p ? text.slice(0, p.headerEnd) : text, modifiers: p ? p.modifiers : [] };
};
/** @param {string} baseText @param {string} headText @returns {string[]} kind ids */
const kinds = (baseText, headText) => javaKindsOf(side(baseText), side(headText)).map((k) => /** @type {any} */ (k).id);
/** @param {string} text */
const thrown = (text) => [...thrownOf(text, parse(text).headerEnd)].sort();

test('a plain method: sig shape, modifiers, headerEnd at the body brace', () => {
  const text = 'public static int add(int a, final long b) { return a + (int) b; }';
  const { sig, headerEnd, modifiers, annotations, typeParameters } = parse(text);
  assert.deepEqual(sig, {
    async: false, name: 'add', returns: 'int', typeParameters: '', throws: [], compact: false,
    params: [
      { name: 'a', type: 'int', optional: false, rest: false },
      { name: 'b', type: 'long', optional: false, rest: false },
    ],
  });
  assert.equal(text[headerEnd], '{');
  assert.deepEqual(modifiers, ['public', 'static']);
  assert.deepEqual(annotations, []);
  assert.equal(typeParameters, '');
});

test('Javadoc, block and line comments and annotations before the declaration are skipped', () => {
  const text = [
    '/** Returns {@code x}. @Fake(")") { */',
    '// fromJson(JsonReader, Clas… a leading line comment',
    '/* block { */',
    '@Override',
    '@SuppressWarnings({"unchecked", "rawtypes"})',
    '@A(x = {1, 2}, s = ")", t = "*/", u = \'{\')',
    '@java.lang.Deprecated',
    '@B(value = @C(")")) public',
    'final String m(String s) {',
    '  return s;',
    '}',
  ].join('\n');
  const p = parse(text);
  assert.deepEqual(p.annotations, ['Override', 'SuppressWarnings', 'A', 'java.lang.Deprecated', 'B']);
  assert.deepEqual(p.modifiers, ['public', 'final']);
  assert.equal(text.slice(p.headerEnd), '{\n  return s;\n}');
  assert.deepEqual(pairs(text), ['String s']);
});

test('annotations interleaved with modifiers, and on parameters, are dropped from the sig', () => {
  const p = parse('public @Nullable static <T> T m(@Nullable final T a, final @A(")") int b) { return a; }');
  assert.deepEqual(p.modifiers, ['public', 'static']);
  assert.deepEqual(p.annotations, ['Nullable']);
  assert.deepEqual(pairs('void m(@Nullable final T a, final @A(")") int b) {}'), ['T a', 'int b']);
});

test('generic methods: type parameters with bounds, wildcards, nested generics', () => {
  const p = parse('public static <T extends Comparable<? super T>> void sort(List<T> list, Map<String, List<int[]>> m) {}');
  assert.equal(p.typeParameters, '<T extends Comparable<? super T>>');
  assert.equal(p.sig.typeParameters, '<T extends Comparable<? super T>>');
  assert.deepEqual(pairs('void f(List<? extends Number> a, Map<String, List<int[]>> b, Class<?> c) {}'),
    ['List<? extends Number> a', 'Map<String, List<int[]>> b', 'Class<?> c']);
  assert.equal(parse('<K, V extends A & B> Map<K, V> f() { return null; }').typeParameters, '<K, V extends A & B>');
  assert.equal(parse('<K, V extends A & B> Map<K, V> f() { return null; }').sig.returns, 'Map<K, V>');
  // `>>` and `>>>` close several levels.
  assert.equal(parse('Map<String, Map<String, List<String>>> f() { return null; }').sig.returns, 'Map<String, Map<String, List<String>>>');
});

test('arrays in both styles, varargs (generic and annotated) as T...', () => {
  assert.deepEqual(pairs('void f(int[] a, String b[], int[][] c, int d[][]) {}'), ['int[] a', 'String[] b', 'int[][] c', 'int[][] d']);
  assert.equal(parse('int m()[] { return null; }').sig.returns, 'int[]');
  assert.equal(parse('int[] m()[] { return null; }').sig.returns, 'int[][]');
  assert.deepEqual(pairs('void f(String fmt, Object... args) {}'), ['String fmt', 'Object... args (rest)']);
  assert.deepEqual(pairs('<T> void f(T... items) {}'), ['T... items (rest)']);
  assert.deepEqual(pairs('void f(@Nullable String... names) {}'), ['String... names (rest)']);
  assert.deepEqual(pairs('void f(List<? super T>... ls) {}'), ['List<? super T>... ls (rest)']);
  assert.deepEqual(pairs('void f(int[]... xs) {}'), ['int[]... xs (rest)']);
});

test('qualified types are kept as written; a receiver parameter is not a parameter', () => {
  assert.deepEqual(pairs('void f(java.util.Map.Entry<String, Integer> e) {}'), ['java.util.Map.Entry<String, Integer> e']);
  assert.deepEqual(pairs('void f(Outer this, int x) {}'), ['int x']);
  assert.deepEqual(pairs('Inner(Outer Outer.this, int x) {}'), ['int x']);
});

test('constructors have no return type; throws', () => {
  const p = parse('/** doc */\nprotected Gson(GsonBuilder b) throws IOException, java.sql.SQLException { this(b, 1); }');
  assert.equal(p.sig.returns, null);
  assert.equal(p.sig.name, 'Gson');
  assert.deepEqual(p.sig.throws, ['IOException', 'java.sql.SQLException']);
  assert.deepEqual(p.modifiers, ['protected']);
  assert.equal(parse('<T> Box(T t) {}').typeParameters, '<T>');
});

test('interface default/static methods, abstract and native methods end at `;`', () => {
  assert.deepEqual(parse('default void run() { go(); }').modifiers, ['default']);
  assert.deepEqual(parse('static <T> List<T> of() { return null; }').modifiers, ['static']);
  const abs = 'public abstract <T> T read(JsonReader in) throws IOException;';
  const p = parse(abs);
  assert.equal(abs[p.headerEnd], ';');
  assert.deepEqual(p.sig.throws, ['IOException']);
  assert.deepEqual([...thrownOf(abs, p.headerEnd)], []);
  assert.equal(parse('private native int hash(Object o);').sig.returns, 'int');
  assert.equal(parse('void m();').sig.returns, 'void');
});

test('annotation type methods with default values, braces included', () => {
  const t = 'String[] alternate() default {};';
  assert.equal(t[parse(t).headerEnd], ';');
  assert.equal(parse(t).sig.returns, 'String[]');
  assert.equal(parse('int value() default 1;').sig.returns, 'int');
  // An annotation with arguments before a `default` interface method is not a default value.
  assert.equal(parse('@A(1) default void m() { }').sig.returns, 'void');
});

test('records: canonical and compact constructors', () => {
  assert.deepEqual(pairs('public Point(int x, int y) { this.x = x; this.y = y; }'), ['int x', 'int y']);
  // A compact constructor has no parameter list in its text: no params, `compact: true`.
  // jdtls names it Point(int, int); a component change moves its key (J-D3).
  const c = parse('/** Checks. */\n@SuppressWarnings("x")\npublic Point {\n  if (x < 0) throw new IllegalArgumentException("x");\n}');
  assert.equal(c.sig.compact, true);
  assert.deepEqual(c.sig.params, []);
  assert.equal(c.sig.returns, null);
  assert.equal(renderJavaSig(c.sig), '(record components)');
  assert.deepEqual(thrown('public Point { if (x < 0) throw new IllegalArgumentException("x"); }'), ['IllegalArgumentException']);
});

test('bodies: text blocks, char literals and strings with braces and quotes do not end the body early', () => {
  const text = 'String f() {\n  char c = \'}\'; char q = \'\\\'\'; String s = "}\\"{";\n'
    + '  String t = """\n    } " "" \\""" {\n    """;\n  throw new IllegalStateException(s);\n}';
  assert.deepEqual(thrown(text), ['IllegalStateException']);
});

test('thrownOf: own body only; lambdas, anonymous and local classes excluded; switch rules included', () => {
  const text = [
    'void f() {',
    '  Runnable r = () -> { throw new LambdaException(); };',
    '  Supplier<X> s = x -> { if (x) { throw new NestedLambda(); } return null; };',
    '  Object o = new Object() { void g() { throw new AnonException(); } };',
    '  Comparator<T> c = new Comparator<T>() { public int compare(T a, T b) { throw new AnonGeneric(); } };',
    '  class Local { void h() { throw new LocalException(); } }',
    '  record R(int a) { R { throw new LocalRecord(); } }',
    '  enum E { A; void i() { throw new LocalEnum(); } }',
    '  if (Foo.class == null) { throw new AfterDotClass(); }',
    '  switch (k) { case 1 -> { throw new SwitchRule(); } default -> throw new SwitchDefault(); }',
    '  // throw new InComment();',
    '  String s = "throw new InString();";',
    '  throw new java.io.UncheckedIOException(e);',
    '}',
  ].join('\n');
  assert.deepEqual(thrown(text), ['AfterDotClass', 'SwitchDefault', 'SwitchRule', 'java.io.UncheckedIOException']);
  assert.deepEqual(thrown('void f() { throw new Box<String>(1); }'), ['Box']);
  // The thrown type is the method's result, not X: not read.
  assert.deepEqual(thrown('void f() { throw new X(e).initCause(c); }'), []);
  assert.deepEqual(thrown('void f() { throw e; }'), []);
});

test('unreadable text yields null, never a throw or a guess', () => {
  for (const bad of [
    '', 'not java at all', 'public class Foo { }', 'int x = 1;', 'void f(int a {',
    'void f(int a /* unterminated', 'void f(@A("open) {}', '@A(1 void f() {}',
    'void f(int) {}', 'void f(,) {}', 'enum E { A }', 'record P(int x) {}', 'public void (int a) {}',
    'void f() throws {}', 'class X { void f() {} }',
  ]) assert.equal(parseJavaDeclaration(bad), null, bad);
  assert.equal(parseJavaDeclaration(/** @type {any} */ (null)), null);
  assert.deepEqual([...thrownOf('void f() { throw new X(', 9)], []);
  // Only the header is parsed: a body that does not lex still has a signature, and thrownOf
  // returns what it read before the unterminated literal.
  const t = 'void f(int a) { throw new A(); String s = "open';
  assert.deepEqual(pairs(t), ['int a']);
  assert.deepEqual(thrown(t), ['A']);
});

test('javaKindsOf: parameter, return, varargs and generic changes', () => {
  const base = 'public int f(int a, String b) { return 0; }';
  assert.deepEqual(kinds(base, 'public int f(int a, String b) { return 1; }'), []);
  assert.deepEqual(kinds(base, 'public int f(int a, String b, long c) { return 0; }'), ['required-param']);
  assert.deepEqual(kinds(base, 'public int f(int a, String b, long... c) { return 0; }'), ['optional-param']);
  assert.deepEqual(kinds(base, 'public int f(int a) { return 0; }'), ['param-removed']);
  assert.deepEqual(kinds(base, 'public int f(long a, String b) { return 0; }'), ['type-changed']);
  assert.deepEqual(kinds(base, 'public long f(int a, String b) { return 0; }'), ['return-changed']);
  assert.deepEqual(kinds(base, 'public int f(final int a, @Nullable String b) { return 0; }'), []);
  assert.deepEqual(kinds('void f(String[] a) {}', 'void f(String... a) {}'), ['type-changed']);
  assert.deepEqual(kinds('void f(List<String> a) {}', 'void f(List<? extends String> a) {}'), ['type-changed']);
  assert.deepEqual(kinds('<T> void f(T a) {}', '<T extends Number> void f(T a) {}'), ['type-changed']);
  assert.deepEqual(kinds('@Deprecated void f() {}', 'void f() {}'), []);
});

test('javaKindsOf: throws added is new-throw, removed is none', () => {
  assert.deepEqual(kinds('void f() {}', 'void f() throws IOException {}'), ['new-throw']);
  assert.deepEqual(kinds('void f() throws IOException {}', 'void f() throws IOException, SQLException {}'), ['new-throw']);
  assert.deepEqual(kinds('void f() throws IOException {}', 'void f() {}'), []);
});

test('javaKindsOf: access reduced or static changed is access-changed; widened is none', () => {
  assert.deepEqual(kinds('public void f() {}', 'protected void f() {}'), ['access-changed']);
  assert.deepEqual(kinds('protected void f() {}', 'void f() {}'), ['access-changed']);
  assert.deepEqual(kinds('void f() {}', 'private void f() {}'), ['access-changed']);
  assert.deepEqual(kinds('public void f() {}', 'private void f() {}'), ['access-changed']);
  // Widening keeps every caller compiling: no kind (TypeScript has no access kind either).
  assert.deepEqual(kinds('private void f() {}', 'public void f() {}'), []);
  assert.deepEqual(kinds('void f() {}', 'protected void f() {}'), []);
  assert.deepEqual(kinds('void f() {}', 'static void f() {}'), ['access-changed']);
  assert.deepEqual(kinds('public static void f() {}', 'public void f() {}'), ['access-changed']);
  assert.deepEqual(kinds('public void f() {}', 'public final synchronized void f() {}'), []);
  // An interface member without a modifier is public, when the caller says so.
  const iface = (/** @type {string} */ t) => ({ ...side(t), inInterface: true });
  assert.deepEqual(javaKindsOf(iface('void f();'), iface('public void f();')), []);
  assert.deepEqual(javaKindsOf(iface('public void f();'), iface('void f();')), []);
  assert.deepEqual(javaKindsOf(iface('void f();'), iface('private void f() {}')).map((k) => /** @type {any} */ (k).id), ['access-changed']);
  assert.equal(KIND.ACCESS_CHANGED.weight, KIND.REQUIRED_PARAM.weight);
  assert.deepEqual(kinds('public void f(int a) {}', 'void f(int a, int b) {}'), ['required-param', 'access-changed']);
});

test('javaKindsOf: a side whose header did not parse compares header text', () => {
  const unparsed = (/** @type {string} */ h) => ({ sig: null, header: h, modifiers: undefined });
  const ok = side('void f(int a) {}');
  assert.deepEqual(javaKindsOf(ok, unparsed('void f(int a)')).map((k) => /** @type {any} */ (k).id), []);
  assert.deepEqual(javaKindsOf(unparsed('void   f(int a)'), unparsed('void f(int a) /* c */')).map((k) => /** @type {any} */ (k).id), []);
  assert.deepEqual(javaKindsOf(ok, unparsed('void f(\\u0069nt a)')).map((k) => /** @type {any} */ (k).id), ['type-changed']);
  assert.deepEqual(javaKindsOf(undefined, ok), []);
});

test('renderJavaSig', () => {
  assert.equal(renderJavaSig(parse('public static <T> T fromJson(String json, Class<T> type) throws JsonSyntaxException { return null; }').sig),
    '<T> (String json, Class<T> type): T throws JsonSyntaxException');
  assert.equal(renderJavaSig(parse('Gson(GsonBuilder b, int... flags) {}').sig), '(GsonBuilder b, int... flags)');
  assert.equal(renderJavaSig(parse('void f() {}').sig), '(): void');
});
