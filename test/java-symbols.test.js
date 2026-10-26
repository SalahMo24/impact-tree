'use strict';
// Java symbols (J2, docs/MULTI_LANGUAGE_PLAN.md): the keys of ./keys.js, which of jdtls'
// document symbols are changed-symbol candidates (src/languages/java/provider.js), the
// overload pairing (J-D3), and the shared `prepare` with Java's spec run through the real
// pipeline (`analyze()`) on a throwaway git repository. jdtls is replayed: its answers for
// test/java-symbols/texts.js are recorded in recorded.json
// (test/lsp-harness/record-java-symbols.js). The header parser is a stub here (J3 owns the
// real one), so these tests check names, places and keys, not signature kinds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { analyze } = require('../src/engine/analyze');
const { collectJavaSymbols, javaSpec, javaProvider, pairOverloads, declarationStartOf } = require('../src/languages/java/provider');
const { erasedType, memberNameOf, typeSegmentOf, javaKeyOf, splitParameters, MAX_NAME_CHARS } = require('../src/languages/java/keys');
const { prepareFromServerSymbols } = require('../src/languages/server-symbols');
const { LANGUAGES, useLanguagesForTest, unsupportedLanguageOf, languageFor } = require('../src/languages');
const texts = require('./java-symbols/texts');
const recorded = require('./java-symbols/recorded.json');

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A parser that reads nothing, as the placeholder does: `sig` null, header compared as text. */
const NO_PARSER = {
  parseJavaDeclaration: () => null,
  thrownOf: () => new Set(),
  javaKindsOf: (base, head) => (!base || base.header === head.header ? [] : [{ id: 'type-changed' }]),
  renderJavaSig: () => '(…)',
};

const symbolsOf = (name) => JSON.parse(JSON.stringify(recorded.texts[name].symbols));
const collect = (name, parser = NO_PARSER) => collectJavaSymbols(symbolsOf(name), texts[name], parser);

test('every fixture text is the one its symbols were recorded for', () => {
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(recorded.texts[name], `${name} is recorded`);
    assert.equal(recorded.texts[name].sha256, sha(text), `${name} changed since it was recorded: run test/lsp-harness/record-java-symbols.js`);
  }
});

test('Java is registered after Python, needs a server, and .java is no longer "not analysed yet"', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['typescript', 'go', 'python', 'java']);
  assert.equal(languageFor('src/main/java/a/B.java'), javaProvider);
  assert.equal(javaProvider.needsServer, true);
  assert.equal(unsupportedLanguageOf('src/main/java/a/B.java'), null);
  assert.equal(unsupportedLanguageOf('src/main/kotlin/a/B.kt'), 'Kotlin');
});

// ---- keys -------------------------------------------------------------------------------

test('a parameter type is erased, simple, and keeps arrays and varargs', () => {
  const cases = [
    ['Class<T>', 'Class'], ['Map<String, List<T>>', 'Map'], ['TypeToken<?>', 'TypeToken'],
    ['List<? extends V>', 'List'], ['Map<? super K, ? extends Map<String, V[]>>', 'Map'],
    ['List<T>[]', 'List[]'], ['Class<?>...', 'Class...'], ['int[][]', 'int[][]'], ['int [] []', 'int[][]'],
    ['String ...', 'String...'], ['T', 'T'], ['T[]', 'T[]'], ['int', 'int'],
    ['java.util.Map', 'Map'], ['java.util.Map<K, V>', 'Map'], ['Map.Entry<String, E>', 'Entry'],
    ['java.util.Map.Entry<K, V>[]', 'Entry[]'], ['Outer<String>.Inner<Integer>', 'Inner'],
    ['  Function< V ,  K >  ', 'Function'], ['@Nullable String', 'String'], ['@a.B(x = 1) List<T>', 'List'],
    ['final String', 'finalString'],
  ];
  for (const [text, want] of cases.slice(0, -1)) assert.equal(erasedType(text), want, text);
  // Modifiers are never in a type jdtls gives; the erasure does not pretend to read them.
  assert.equal(erasedType('final String'), 'finalString');
  assert.throws(() => erasedType('x'.repeat(MAX_NAME_CHARS + 1)), RangeError);
});

test('jdtls names are read with nesting, and the type-parameter suffix is dropped', () => {
  assert.deepEqual(memberNameOf('getAdapter(TypeToken<T>) <T>'), { simpleName: 'getAdapter', params: ['TypeToken<T>'] });
  assert.deepEqual(memberNameOf('group(List<? extends V>, Function<V, K>, T[], int[][]) <K, V>'),
    { simpleName: 'group', params: ['List<? extends V>', 'Function<V, K>', 'T[]', 'int[][]'] });
  assert.deepEqual(memberNameOf('Gson()'), { simpleName: 'Gson', params: [] });
  assert.deepEqual(memberNameOf('isAssignableFrom(Type, ParameterizedType, Map<String, Type>)').params, ['Type', 'ParameterizedType', 'Map<String, Type>']);
  assert.equal(memberNameOf('TASK'), null, 'a field');
  assert.equal(memberNameOf('broken(int'), null, 'unbalanced');
  assert.deepEqual(splitParameters(' Map<K, V> m , int[] a '), [' Map<K, V> m ', ' int[] a ']);
  assert.deepEqual(splitParameters('  '), []);
  assert.equal(typeSegmentOf('TypeToken<T>'), 'TypeToken');
  assert.equal(typeSegmentOf('Generic<T extends Comparable<T>>'), 'Generic');
  assert.equal(javaKeyOf(['Gson'], 'toJson', ['Object', 'Appendable'], false), 'Gson.toJson(Object, Appendable)');
  assert.equal(javaKeyOf(['Gson', 'FutureTypeAdapter'], 'Gson', ['GsonBuilder'], true), 'Gson.FutureTypeAdapter.<init>(GsonBuilder)');
});

// ---- candidates -------------------------------------------------------------------------

test('gson Gson.java: overloads keyed by erased parameter types, constructors, a nested class', () => {
  const all = collect('Gson.java');
  const keys = all.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'no repeats');
  assert.ok(!keys.some((k) => k.includes('#')));
  for (const k of ['Gson.<init>()', 'Gson.<init>(GsonBuilder)', 'Gson.getAdapter(TypeToken)', 'Gson.getAdapter(Class)',
    'Gson.getDelegateAdapter(TypeAdapterFactory, TypeToken)', 'Gson.toJson(Object, Appendable)', 'Gson.fromJson(String, Class)',
    'Gson.FutureTypeAdapter.write(JsonWriter, T)', 'Gson.FutureTypeAdapter.setDelegate(TypeAdapter)']) {
    assert.ok(keys.includes(k), k);
  }
  assert.equal(keys.filter((k) => k.startsWith('Gson.toJson(')).length, 8, 'J0: 8 toJson overloads');
  assert.equal(keys.filter((k) => k.startsWith('Gson.fromJson(')).length, 11, 'gson at 57731049: 11 fromJson overloads');
  // Anonymous classes inside methods (`new TypeAdapter<Number>() {…}` in `doubleAdapter`…)
  // are their method's body: none of their `read`/`write` is a candidate.
  assert.ok(!keys.some((k) => /\.(read|write)\(/.test(k) && !k.startsWith('Gson.FutureTypeAdapter.')), keys.join('\n'));
  const ctor = all.find((s) => s.key === 'Gson.<init>(GsonBuilder)');
  assert.equal(ctor.isConstructor, true);
  assert.equal(ctor.label, 'new Gson(GsonBuilder)');
  assert.equal(ctor.className, 'Gson');
  assert.equal(ctor.exported, false, 'package-private');
  const text = texts['Gson.java'];
  assert.equal(text.slice(ctor.namePos, ctor.namePos + 4), 'Gson', 'callers are asked at the constructor\'s own name');
  assert.ok(text.slice(ctor.namePos - 2, ctor.namePos).endsWith('  '), 'not the class name');
  const nested = all.find((s) => s.key === 'Gson.FutureTypeAdapter.write(JsonWriter, T)');
  assert.equal(nested.className, 'FutureTypeAdapter');
  assert.equal(nested.exported, true);
});

test('Javadoc and leading comments are outside the declaration; annotations are in it', () => {
  const text = texts['Gson.java'];
  const all = collect('Gson.java');
  const toJson = all.find((s) => s.key === 'Gson.toJson(Object, Appendable)');
  const raw = symbolsOf('Gson.java').flatMap((s) => s.children).find((s) => s.name === 'toJson(Object, Appendable)');
  assert.ok(text.slice(raw.range.start).startsWith('/**'), 'jdtls\' range starts at the Javadoc (J0)');
  assert.ok(text.slice(toJson.start).startsWith('public void toJson(Object src, Appendable writer)'));
  assert.equal(toJson.header, 'public void toJson(Object src, Appendable writer) throws JsonIOException');
  const fromJson = all.find((s) => s.key === 'Gson.fromJson(String, Type)');
  assert.ok(text.slice(fromJson.start).startsWith('@SuppressWarnings('), 'an annotation starts the declaration');
  const shapes = texts['Shapes.java'];
  const annotated = collect('Shapes.java').find((s) => s.key === 'Generic.annotated(String)');
  assert.ok(shapes.slice(annotated.start).startsWith('@Deprecated'), 'a leading // comment is skipped');
  assert.equal(annotated.header, '@Deprecated @SuppressWarnings({"unchecked", "rawtypes"}) final synchronized void annotated(final @Deprecated String s)');
  assert.equal(declarationStartOf('/** a */ // b\n  int x', 0, 20), 16);
  assert.equal(declarationStartOf('/* unclosed', 0, 11), 0, 'unreadable: jdtls\' start kept');
});

test('gson FieldNamingPolicy.java: enum constant bodies keyed by the constant', () => {
  const keys = collect('FieldNamingPolicy.java').map((s) => s.key);
  assert.deepEqual(keys, [
    'FieldNamingPolicy.IDENTITY.translateName(Field)', 'FieldNamingPolicy.UPPER_CAMEL_CASE.translateName(Field)',
    'FieldNamingPolicy.UPPER_CAMEL_CASE_WITH_SPACES.translateName(Field)', 'FieldNamingPolicy.UPPER_CASE_WITH_UNDERSCORES.translateName(Field)',
    'FieldNamingPolicy.LOWER_CASE_WITH_UNDERSCORES.translateName(Field)', 'FieldNamingPolicy.LOWER_CASE_WITH_DASHES.translateName(Field)',
    'FieldNamingPolicy.LOWER_CASE_WITH_DOTS.translateName(Field)',
    'FieldNamingPolicy.separateCamelCase(String, char)', 'FieldNamingPolicy.upperCaseFirstLetter(String)',
  ]);
  assert.equal(collect('FieldNamingPolicy.java')[0].className, 'FieldNamingPolicy');
});

test('gson MapTypeAdapterFactory.java: a generic inner class and its constructor', () => {
  const all = collect('MapTypeAdapterFactory.java');
  assert.deepEqual(all.map((s) => s.key), [
    'MapTypeAdapterFactory.<init>(ConstructorConstructor, boolean)', 'MapTypeAdapterFactory.create(Gson, TypeToken)',
    'MapTypeAdapterFactory.getKeyAdapter(Gson, Type)', 'MapTypeAdapterFactory.Adapter.<init>(TypeAdapter, TypeAdapter, ObjectConstructor)',
    'MapTypeAdapterFactory.Adapter.read(JsonReader)', 'MapTypeAdapterFactory.Adapter.write(JsonWriter, Map)',
    'MapTypeAdapterFactory.Adapter.keyToString(JsonElement)',
  ]);
  assert.equal(all[3].label, 'new MapTypeAdapterFactory.Adapter(TypeAdapter, TypeAdapter, ObjectConstructor)');
});

test('records, interfaces, local classes, lambdas and anonymous classes', () => {
  const all = collect('Shapes.java');
  assert.deepEqual(all.map((s) => s.key), [
    // The compact constructor is listed as the canonical one (J0).
    'Point.<init>(int, int)', 'Point.<init>(int)', 'Point.origin()',
    'Shape.area()', 'Shape.describe(String, int...)', 'Shape.unit()',
    // An anonymous class in a field's initializer is no method's body: keyed by the field.
    'Generic.TASK.run()',
    'Generic.group(List, Function, T[], int[][])',
    // `inner`'s lambda, anonymous `toString` and local `Local.m` are its body.
    'Generic.inner()',
    'Generic.annotated(String)', 'Generic.Nested.<init>(Class...)', 'Generic.Nested.lists(Entry)',
  ]);
  const byKey = new Map(all.map((s) => [s.key, s]));
  assert.equal(byKey.get('Shape.area()').exported, true, 'an interface member is implicitly public');
  assert.equal(byKey.get('Shape.area()').inInterface, true);
  assert.equal(byKey.get('Point.origin()').inInterface, false);
  assert.equal(byKey.get('Shape.area()').modifiers, undefined, 'unparsed: no modifiers, not []');
  assert.equal(byKey.get('Point.origin()').exported, false);
  assert.equal(byKey.get('Generic.Nested.lists(Entry)').exported, true, 'protected');
  assert.equal(byKey.get('Generic.inner()').endLine - byKey.get('Generic.inner()').startLine, 4);
});

test('a parsed header supplies sig, modifiers, annotations and throws', () => {
  const parser = {
    ...NO_PARSER,
    parseJavaDeclaration: (decl) => {
      const brace = decl.indexOf('{');
      return { sig: { async: false, params: [], returns: null }, headerEnd: brace, modifiers: decl.includes('private ') ? ['private'] : ['public'], annotations: ['Override'], typeParameters: '' };
    },
    thrownOf: () => new Set(['IOException']),
  };
  const s = collect('MapTypeAdapterFactory.java', parser).find((x) => x.key === 'MapTypeAdapterFactory.Adapter.read(JsonReader)');
  assert.deepEqual(s.sig, { async: false, params: [], returns: null });
  assert.deepEqual(s.decorators, ['Override']);
  assert.deepEqual(s.modifiers, ['public']);
  assert.deepEqual([...s.throws], ['IOException']);
  assert.equal(s.header, '@Override public Map<K, V> read(JsonReader in) throws IOException');
});

test('an unparsed side has no modifiers, so only its header text is compared, never access', () => {
  const base = 'class A {\n  public static void m(int a) {}\n}\n';
  const head = 'class A {\n  public static void m(int a, ) {}\n}\n';
  const symbolsFor = (text) => {
    const at = text.indexOf('public');
    const end = text.indexOf('{}') + 2;
    return [{ name: 'A', detail: '', kind: 5, range: { start: 0, end: text.length }, selectionRange: { start: 6, end: 7 },
      children: [{ name: 'm(int)', detail: ' : void', kind: 6, range: { start: at, end }, selectionRange: { start: text.indexOf('m('), end: text.indexOf('m(') + 1 }, children: [] }] }];
  };
  // Reads the base only, as a real parser that cannot read the head's broken list.
  const parser = { ...NO_PARSER, parseJavaDeclaration: (decl) => (decl.includes(', )') ? null : { sig: { async: false, params: [], returns: null }, headerEnd: decl.indexOf('{'), modifiers: ['public', 'static'], annotations: [], typeParameters: '' }) };
  const [b] = collectJavaSymbols(symbolsFor(base), base, parser);
  const [h] = collectJavaSymbols(symbolsFor(head), head, parser);
  assert.deepEqual(b.modifiers, ['public', 'static']);
  assert.equal(h.modifiers, undefined);
  assert.equal('modifiers' in h, false);
  assert.equal(h.exported, true, 'read from the header text');
  assert.deepEqual(javaSpec(parser).kindsOf(b, h).map((k) => k.id), ['type-changed'], 'the header texts differ; no access-changed');
  // The same with J3's parser and kinds: it cannot read the head's broken list either.
  const real = require('../src/languages/java/signature');
  const [rb] = collectJavaSymbols(symbolsFor(base), base, real);
  const [rh] = collectJavaSymbols(symbolsFor(head), head, real);
  assert.deepEqual([rb.modifiers, rh.sig, 'modifiers' in rh], [['public', 'static'], null, false]);
  assert.deepEqual(javaSpec().kindsOf(rb, rh).map((k) => k.id), ['type-changed']);
});

test('with J3\'s parser: every fixture method is read, and an interface method needs no `public`', () => {
  const real = require('../src/languages/java/signature');
  for (const name of Object.keys(texts)) {
    for (const s of collect(name, real)) assert.ok(s.sig, `${name}: ${s.key} parsed`);
  }
  const area = collect('Shapes.java', real).find((s) => s.key === 'Shape.area()');
  assert.deepEqual(area.modifiers, []);
  assert.equal(area.inInterface, true);
  const publicArea = { ...area, modifiers: ['public'], header: `public ${area.header}` };
  assert.ok(!javaSpec().kindsOf(publicArea, area).some((k) => k.id === 'access-changed'), 'a redundant `public` removed from an interface method');
  const toJson = collect('Gson.java', real).find((s) => s.key === 'Gson.toJson(Object, Appendable)');
  assert.equal(toJson.header, 'public void toJson(Object src, Appendable writer) throws JsonIOException');
  assert.deepEqual(toJson.modifiers, ['public']);
});

test('a true repeat of a key is #2; a range outside the text is a RangeError', () => {
  const text = 'class A {\n  void m(java.util.List<String> a) {}\n  void m(List<Integer> b) {}\n}\n';
  const at = (s) => ({ start: text.indexOf(s), end: text.indexOf(s) + s.length });
  const method = (s) => ({ name: s.replace(/^void (\w+)\(([\w.]+)<\w+> \w\) \{\}$/, '$1($2)'), detail: ' : void', kind: 6, range: at(s), selectionRange: { start: at(s).start + 5, end: at(s).start + 6 }, children: [] });
  const symbols = [{ name: 'A', detail: '', kind: 5, range: { start: 0, end: text.length }, selectionRange: { start: 6, end: 7 },
    children: [method('void m(java.util.List<String> a) {}'), method('void m(List<Integer> b) {}')] }];
  assert.deepEqual(collectJavaSymbols(symbols, text, NO_PARSER).map((s) => s.key), ['A.m(List)', 'A.m(List)#2']);
  assert.throws(() => collectJavaSymbols(symbolsOf('Gson.java'), 'class X {}', NO_PARSER), RangeError);
});

// ---- overload pairing ---------------------------------------------------------------------

/** @param {string[]} keys */
const fake = (keys) => keys.map((key) => ({ key, label: key }));

test('one overload out and one in is one changed method, keyed by its old key', () => {
  const base = fake(['C.m(int)', 'C.m(String)', 'C.other()']);
  const head = fake(['C.m(long)', 'C.m(String)', 'C.other()']);
  const paired = pairOverloads(base, head);
  assert.deepEqual(paired.map((s) => s.key), ['C.m(int)', 'C.m(String)', 'C.other()']);
  assert.equal(paired[0].label, 'C.m(long)', 'the label stays the head\'s');
  assert.equal(head[0].key, 'C.m(long)', 'pure: the input is not changed');
});

test('two out and two in, or one out and two in, are not paired; unrelated methods are untouched', () => {
  assert.deepEqual(pairOverloads(fake(['C.m(int)', 'C.m(long)']), fake(['C.m(short)', 'C.m(byte)'])).map((s) => s.key), ['C.m(short)', 'C.m(byte)']);
  assert.deepEqual(pairOverloads(fake(['C.m(int)']), fake(['C.m(short)', 'C.m(byte)'])).map((s) => s.key), ['C.m(short)', 'C.m(byte)']);
  // Different names, or the same name in another type, never pair.
  assert.deepEqual(pairOverloads(fake(['C.a(int)', 'D.m(int)']), fake(['C.b(int)', 'E.m(int)'])).map((s) => s.key), ['C.b(int)', 'E.m(int)']);
  const same = fake(['C.x()', 'C.y(int)']);
  assert.equal(pairOverloads(same, fake(['C.x()', 'C.y(int)']))[0].key, 'C.x()');
  // Constructors pair by their type.
  assert.deepEqual(pairOverloads(fake(['C.<init>(int)']), fake(['C.<init>(int, int)'])).map((s) => s.key), ['C.<init>(int)']);
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
      if (override === 'reject') throw new Error('jdtls crashed');
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-java-symbols-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(dir, rel);
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

/** Runs `analyze()` with Java's provider on the stub parser (J3's kinds are not tested here). */
async function runJava(dir, services, parser = NO_PARSER) {
  const stubbed = Object.freeze({ ...javaProvider, prepare: (ctx) => prepareFromServerSymbols(ctx, javaSpec(parser)) });
  const restore = useLanguagesForTest([LANGUAGES[0], LANGUAGES[1], LANGUAGES[2], stubbed]);
  try {
    return await analyze(dir, {
      mode: 'pr', base: 'main', allowLocalBase: true, skipForest: true, deferTestReach: true,
      languageServices: services, makeResolver: noCallers(),
    });
  } finally {
    restore();
  }
}

test('overloads through the pipeline: paired ones are changed, unpaired ones added and deleted', async () => {
  const file = 'src/main/java/demo/Codec.java';
  const repo = repoWith({ 'pom.xml': '<project/>\n', [file]: texts['Codec.java@base'] }, { [file]: texts['Codec.java@head'] });
  try {
    const result = await runJava(repo.dir, replayServices());
    assert.deepEqual(result.unanalysable, []);
    assert.deepEqual(result.components.map((c) => c.component), ['(root)']);
    const changed = result.allChanged.map((c) => [c.key, c.label, c.added, c.kinds.map((k) => k.id).join(',')]).sort();
    assert.deepEqual(changed, [
      ['Codec.decode(String)', 'Codec.decode(String, boolean)', false, 'type-changed'],
      ['Codec.encode(int)', 'Codec.encode(long)', false, 'type-changed'],
      ['Codec.flush(boolean)', 'Codec.flush(boolean)', true, 'body'],
      ['Codec.reset(byte)', 'Codec.reset(byte)', true, 'body'],
      ['Codec.reset(short)', 'Codec.reset(short)', true, 'body'],
    ]);
    assert.deepEqual(result.deleted.map((d) => d.key).sort(), ['Codec.reset(int)', 'Codec.reset(long)']);
    // With J3's parser the paired rows say what changed.
    const real = await runJava(repo.dir, replayServices(), require('../src/languages/java/signature'));
    const kinds = Object.fromEntries(real.allChanged.filter((c) => !c.added).map((c) => [c.key, c.kinds.map((k) => k.id).join(',')]));
    assert.deepEqual(kinds, { 'Codec.encode(int)': 'type-changed', 'Codec.decode(String)': 'required-param' });
  } finally {
    repo.remove();
  }
});

test('a Javadoc-only edit is outside every method, not a changed method', async () => {
  const file = 'src/main/java/com/google/gson/FieldNamingPolicy.java';
  const base = texts['FieldNamingPolicy.java'];
  // The Javadoc of `separateCamelCase`, which jdtls' range includes (J0).
  const head = base.replace('define word separation into separate words that', 'word separation into separate words that');
  assert.notEqual(head, base);
  // The head text was not recorded: replay the base's symbols shifted by the edit, which is
  // what jdtls answers for an edit inside a comment.
  const delta = head.length - base.length;
  const editAt = base.indexOf('define word separation');
  const shift = (s) => ({ ...s,
    range: { start: s.range.start > editAt ? s.range.start + delta : s.range.start, end: s.range.end > editAt ? s.range.end + delta : s.range.end },
    selectionRange: { start: s.selectionRange.start > editAt ? s.selectionRange.start + delta : s.selectionRange.start, end: s.selectionRange.end > editAt ? s.selectionRange.end + delta : s.selectionRange.end },
    children: s.children.map(shift) });
  const services = replayServices();
  const replay = services.documentSymbols;
  services.documentSymbols = async (doc) => (doc.text === head ? symbolsOf('FieldNamingPolicy.java').map(shift) : replay(doc));
  const repo = repoWith({ 'pom.xml': '<project/>\n', [file]: base }, { [file]: head });
  try {
    const result = await runJava(repo.dir, services);
    assert.deepEqual(result.allChanged.map((c) => c.key), []);
    assert.deepEqual(result.deleted, []);
    // No changed method: the file is listed whole, for its diff (as a Go doc-comment edit).
    const listed = result.otherFiles.find((f) => f.path === file);
    assert.ok(listed && listed.noCallable && !listed.notAnalysed, JSON.stringify(listed));
  } finally {
    repo.remove();
  }
});

test('no answer, a failed request, or an empty answer for a text with a class: not analysed, with the reason', async () => {
  const file = 'src/main/java/demo/Codec.java';
  const cases = [
    ['null', 'head', /Codec\.java: NOT analysed — the Java language server gave no symbols$/],
    ['reject', 'base', /the Java language server could not list the symbols for its base version: jdtls crashed/],
    ['empty', 'head', /the Java language server listed no symbols, though the file declares functions/],
  ];
  for (const [answer, side, reason] of cases) {
    const repo = repoWith({ [file]: texts['Codec.java@base'] }, { [file]: texts['Codec.java@head'] });
    try {
      const result = await runJava(repo.dir, replayServices({ [side]: answer }));
      assert.ok(result.warnings.some((w) => reason.test(w)), `${answer} on ${side}: ${result.warnings.join(' | ')}`);
      assert.equal(result.allChanged.length, 0);
      assert.deepEqual(result.unanalysable, [{ component: '(no pom.xml or build.gradle)', count: 1 }]);
      const listed = result.otherFiles.find((f) => f.path === file);
      assert.ok(listed && listed.notAnalysed && listed.notAnalysed.language === 'Java', JSON.stringify(listed));
    } finally {
      repo.remove();
    }
  }
});

test('the editor without Java support: the install hint', async () => {
  const file = 'src/main/java/demo/Codec.java';
  const repo = repoWith({ [file]: texts['Codec.java@base'] }, { [file]: texts['Codec.java@head'] });
  try {
    const services = { ...replayServices(), available: async () => ({ ok: false, reason: 'no Java extension' }) };
    const result = await runJava(repo.dir, services);
    assert.ok(result.warnings.some((w) => w.includes('Install the Extension Pack for Java / Language Support for Java by Red Hat (redhat.java) to analyse Java files (no Java extension)')), result.warnings.join(' | '));
    assert.equal(result.allChanged.length, 0);
  } finally {
    repo.remove();
  }
});

test('the editor without Java support: the install hint once for several files, and no rows of unknowns', async () => {
  const one = 'src/main/java/demo/Codec.java';
  const two = 'src/main/java/demo/Other.java';
  const repo = repoWith({ [one]: texts['Codec.java@base'], [two]: texts['Codec.java@base'] }, { [one]: texts['Codec.java@head'], [two]: texts['Codec.java@head'] });
  try {
    const services = { ...replayServices(), available: async () => ({ ok: false, reason: 'no Java extension' }) };
    const result = await runJava(repo.dir, services);
    assert.equal(result.warnings.filter((w) => w.includes('Install the Extension Pack for Java')).length, 1, result.warnings.join(' | '));
    assert.deepEqual(result.allChanged, [], 'no method row with unknown callers');
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.otherFiles.filter((f) => f.notAnalysed).map((f) => f.path).sort(), [one, two], 'both files say they were not analysed');
  } finally {
    repo.remove();
  }
});

test('a generated Java file is listed but not analysed, with a warning, and the server is not asked', async () => {
  const file = 'mod/target/generated-sources/demo/Codec.java';
  const repo = repoWith({ [file]: texts['Codec.java@base'] }, { [file]: texts['Codec.java@head'] });
  try {
    const services = { ...replayServices(), documentSymbols: async () => assert.fail('a generated file is not asked about') };
    const result = await runJava(repo.dir, services);
    assert.deepEqual(result.allChanged, []);
    assert.ok(result.warnings.some((w) => /^1 generated Java file\(s\) listed but not analysed: mod\/target\/generated-sources\/demo\/Codec\.java$/.test(w)), result.warnings.join(' | '));
    const listed = result.otherFiles.find((f) => f.path === file);
    assert.ok(listed, 'listed for its diff');
    assert.equal(listed.notAnalysed, undefined, 'deliberately skipped, not a failure (it does not count toward attention)');
  } finally {
    repo.remove();
  }
});
