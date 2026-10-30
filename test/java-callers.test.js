'use strict';
// Java's caller extras (src/languages/java/editor-extras.js, J4): method references are
// value uses, callers in jdtls' default project are dropped, and overrides, overridable
// methods, constructors, DI and annotation processing read incomplete with their reason.
// No editor: texts and hierarchy answers are hand-built in jdtls' shapes (J0 §3).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createJavaEditorExtras, filterJavaCallers, isJavaCallSite, maskJava, declarationAt,
  VALUE_USE_REASON, OVERRIDES_REASON, OVERRIDDEN_REASON, IMPLICIT_SUPER_REASON, UNBUILT_REASON,
  DI_FACTORY_REASON, GENERATED_REASON, UNREAD_TARGET_REASON,
} = require('../src/languages/java/editor-extras');
const { javaProvider } = require('../src/languages/java/provider');
const { applyCallerExtras, callersFromHierarchy, queryHierarchy } = require('../src/languages/callers-from-hierarchy');

const ROOT = '/r';

/** A caller row in `file` with a site at each occurrence of `name` in `text` (in code or not). */
function callerIn(file, text, name, label = 'caller') {
  const callSites = [];
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    if (/[\w$]/.test(text[i - 1] || '') || /[\w$]/.test(text[i + name.length] || '')) continue;
    callSites.push({ start: i, end: i + name.length });
  }
  return { label, file, pos: 0, test: false, sites: callSites.length, callSites };
}

/** The extras over `texts`, with `implementations` answering `impl` (or rejecting). */
function extrasOver(texts, { impl = [], services = undefined } = {}) {
  const asked = [];
  const svc = services === undefined ? {
    async implementations(doc, pos) {
      asked.push(`${doc.file}@${pos}`);
      if (impl instanceof Error) throw impl;
      return impl;
    },
  } : services;
  const extras = createJavaEditorExtras({ readText: (f) => (f in texts ? texts[f] : null), services: /** @type {any} */ (svc), repoRoot: ROOT });
  return { extras, asked };
}

/** The answer for the target named `name` (its first declaration with `(`) in `file`. */
async function answerFor(extras, texts, file, name, rows, { ready = true, reason = '' } = {}) {
  const text = texts[file];
  const pos = new RegExp(`\\b${name}\\s*\\(`).exec(maskJava(text)).index;
  const hierarchy = ready ? { ready: true, rows } : { ready: false, reason, retryable: false };
  const applied = await applyCallerExtras(/** @type {any} */ (hierarchy), { extras, query: extras.query(file, pos), file, pos, withTests: true });
  return /** @type {any} */ (applied).answer;
}

const CALLS = '/r/src/Calls.java';
const callsText = [
  'class Calls {',
  '  void a(Foo f) { f.run(); }',
  '  void b(Foo f) { list.forEach(f::run); }',
  '  void c(Foo f) {',
  '    // f::run in a comment',
  '    String s = "f::run";',
  '    f.run();',
  '  }',
  '  Supplier<Foo> d() { return Foo::new; }',
  '}',
].join('\n');

test('isJavaCallSite: a call, a method reference (value use), and unknown sites', () => {
  const m = maskJava(callsText);
  const at = (needle, from = 0) => { const i = callsText.indexOf(needle, from); return { start: i, end: i + needle.length }; };
  assert.equal(isJavaCallSite(m, at('run();')), null, 'a range not ending at an identifier is unknown');
  assert.equal(isJavaCallSite(m, { start: callsText.indexOf('run();'), end: callsText.indexOf('run();') + 3 }), true);
  const ref = callsText.indexOf('f::run') + 3;
  assert.equal(isJavaCallSite(m, { start: ref, end: ref + 3 }), false, '`f::run` is a value use');
  const ctor = callsText.indexOf('Foo::new') + 5;
  assert.equal(isJavaCallSite(m, { start: ctor, end: ctor + 3 }), false, '`Foo::new` is a value use');
  const inComment = callsText.indexOf('f::run in') + 3;
  assert.equal(isJavaCallSite(m, { start: inComment, end: inComment + 3 }), null, 'a site in a comment is unknown, never a value use');
  assert.equal(isJavaCallSite(null, { start: 0, end: 1 }), null);
  assert.equal(isJavaCallSite(m, { start: -1, end: 2 }), null);
});

test('filter: a caller that only references the method is dropped, a caller with both keeps its calls; `::` in a comment or string is not a value use', () => {
  const rows = [
    callerIn(CALLS, callsText.split('\n').slice(0, 2).join('\n'), 'run', 'a'),
    { ...callerIn(CALLS, callsText, 'run', 'b'), callSites: [{ start: callsText.indexOf('f::run') + 3, end: callsText.indexOf('f::run') + 6 }], sites: 1 },
  ];
  const { kept, dropped, valueUses } = filterJavaCallers(rows, () => callsText, ROOT);
  assert.equal(dropped, 1);
  assert.equal(valueUses, 1);
  assert.deepEqual(kept.map((k) => k.label), ['a']);
  // c: the comment's and the string's `f::run` are masked; only `f.run()` would be a site.
  const cStart = callsText.indexOf('void c');
  const cRow = callerIn(CALLS, callsText, 'run', 'c');
  cRow.callSites = cRow.callSites.filter((s) => s.start > cStart && s.start < callsText.indexOf('Supplier'));
  cRow.sites = cRow.callSites.length;
  const c = filterJavaCallers([cRow], () => callsText, ROOT);
  assert.equal(c.valueUses, 0, 'the `::` inside a comment and a string are not value uses');
  assert.equal(c.kept.length, 1);
});

test('filter drops callers in jdtls\' default project and outside the repository', () => {
  const rows = [
    { label: 'TypeAdapters.read', file: '/Users/x/jdtls-data/ws/jdt.ls-java-project/src/com/google/gson/TypeAdapters.java', pos: 0, test: false, sites: 1, callSites: [{ start: 0, end: 1 }] },
    { label: 'Elsewhere.m', file: '/elsewhere/E.java', pos: 0, test: false, sites: 0, callSites: [] },
    { label: 'In.m', file: '/r/src/In.java', pos: 0, test: false, sites: 0, callSites: [] },
  ];
  const r = filterJavaCallers(rows, () => null, ROOT);
  assert.deepEqual(r.kept.map((k) => k.label), ['In.m']);
  assert.equal(r.notWorkspace, 2);
});

const T = '/r/src/T.java';
const targets = {
  [T]: [
    'package p;',
    'import java.util.*;',
    '/** Doc @Override in a comment */',
    'public final class T implements Comparable<T>, java.io.Serializable {',
    '  private static int helper(int x) { return x; }',
    '  static int util() { return 1; }',
    '  // @Override',
    '  public int plain() { return 0; }',
    '  @Override public int compareTo(T o) { return 0; }',
    '  public boolean equals(Object o) { return o == this; }',
    '  @java.lang.Override',
    '  public String toString() { return "x"; }',
    '  private final Runnable r = new Runnable() {',
    '    public void run() { String s = "}"; }',
    '  };',
    '  T(int a) { this(); }',
    '  T() { }',
    '}',
  ].join('\n'),
  '/r/src/Base.java': [
    'public abstract class Base<X> extends Parent {',
    '  public void open() { }',
    '  public final void shut() { }',
    '  protected abstract X make();',
    '  public Base() { }',
    '  public Base(int n) { super(n); }',
    '}',
  ].join('\n'),
  '/r/src/Svc.java': [
    '@Service',
    'public class Svc {',
    '  private final Repo repo;',
    '  public Svc(Repo repo) { this.repo = repo; }',
    '  @Bean Repo repo() { return new Repo(); }',
    '}',
  ].join('\n'),
  '/r/src/Inj.java': [
    'public class Inj {',
    '  @Inject',
    '  Inj(Repo repo) { }',
    '}',
  ].join('\n'),
  '/r/src/Pojo.java': [
    '@lombok.Data',
    '@Builder(toBuilder = true)',
    'public final class Pojo {',
    '  private final int n;',
    '  static int twice(int x) { return 2 * x; }',
    '}',
  ].join('\n'),
  '/r/src/Kind.java': [
    'enum Kind {',
    '  A { @Override int size() { return 1; } },',
    '  B(2) { int size() { return 2; } };',
    '  Kind() { }',
    '  Kind(int n) { }',
    '  int size() { return 0; }',
    '}',
  ].join('\n'),
  '/r/src/Pt.java': 'record Pt(int x, int y) {\n  Pt { }\n  int sum() { return x + y; }\n}',
};
const someCaller = (file = '/r/src/C.java') => ({ label: 'C.m', file, pos: 0, test: false, sites: 0, callSites: [] });

test('non-rules: a private, a static and a final class\'s method stay complete when the answer is; @Override in a comment is no override', async () => {
  const { extras, asked } = extrasOver(targets);
  for (const name of ['helper', 'util', 'plain']) {
    const answer = await answerFor(extras, targets, T, name, [someCaller()]);
    assert.deepEqual([name, answer.complete, answer.reason], [name, true, undefined]);
  }
  assert.deepEqual(asked, [], 'a method of a final class is not overridable: no implementations query');
  const pojo = await answerFor(extras, targets, '/r/src/Pojo.java', 'twice', []);
  assert.equal(pojo.complete, false, 'a member of a Lombok class is incomplete even when static');
});

test('overrides: @Override (qualified too), an Object method without it, and an anonymous class\'s method', async () => {
  const { extras } = extrasOver(targets);
  for (const [name, sup] of [['compareTo', 'Comparable, Serializable.compareTo'], ['equals', 'Comparable, Serializable.equals'], ['toString', 'Comparable, Serializable.toString'], ['run', 'Runnable.run']]) {
    const answer = await answerFor(extras, targets, T, name, [someCaller()]);
    assert.equal(answer.complete, false, name);
    assert.equal(answer.reason, `${OVERRIDES_REASON} (${sup})`, name);
    assert.equal(answer.callers.length, 1, 'the callers listed are kept');
  }
});

test('enum constant bodies override the enum\'s method; the enum\'s own method asks for its implementations', async () => {
  const kind = '/r/src/Kind.java';
  const text = targets[kind];
  const { extras, asked } = extrasOver(targets, { impl: [{ file: kind, start: text.indexOf('A {'), end: text.indexOf('A {') + 10 }] });
  for (const needle of ['size() { return 1', 'size() { return 2']) {
    const pos = text.indexOf(needle);
    const applied = await applyCallerExtras({ ready: true, rows: [someCaller()] }, { extras, query: extras.query(kind, pos), file: kind, pos, withTests: true });
    assert.match(/** @type {any} */ (applied).answer.reason, /^overrides or implements/);
  }
  const pos = text.indexOf('size() { return 0');
  const applied = await applyCallerExtras({ ready: true, rows: [someCaller()] }, { extras, query: extras.query(kind, pos), file: kind, pos, withTests: true });
  assert.equal(/** @type {any} */ (applied).answer.reason, OVERRIDDEN_REASON);
  assert.deepEqual(asked, [`${kind}@${pos}`]);
});

test('overridable: overridden in the workspace is incomplete; not overridden stays complete; a failed or empty query is incomplete', async () => {
  const base = '/r/src/Base.java';
  const over = extrasOver(targets, { impl: [{ file: '/r/src/Sub.java', start: 10, end: 20 }] });
  assert.equal((await answerFor(over.extras, targets, base, 'open', [someCaller()])).reason, OVERRIDDEN_REASON);
  assert.equal((await answerFor(over.extras, targets, base, 'make', [someCaller()])).reason, OVERRIDDEN_REASON, 'an abstract method');
  assert.equal(over.asked.length, 2);
  const self = targets[base].indexOf('open(');
  const none = extrasOver(targets, { impl: [{ file: base, start: self - 2, end: self + 10 }] });
  assert.equal((await answerFor(none.extras, targets, base, 'open', [someCaller()])).complete, true, 'only itself: not overridden');
  const shut = await answerFor(none.extras, targets, base, 'shut', [someCaller()]);
  assert.equal(shut.complete, true, 'a final method is not asked');
  const failed = extrasOver(targets, { impl: new Error('Internal error') });
  assert.equal((await answerFor(failed.extras, targets, base, 'open', [someCaller()])).reason, 'whether it is overridden could not be listed: Internal error');
  const nullAnswer = extrasOver(targets, { services: { implementations: async () => null } });
  assert.equal((await answerFor(nullAnswer.extras, targets, base, 'open', [someCaller()])).reason, 'whether it is overridden could not be listed (no answer)');
  const slow = createJavaEditorExtras({ readText: (f) => targets[f], services: /** @type {any} */ ({ implementations: () => new Promise(() => {}) }), repoRoot: ROOT, timeoutMs: 20 });
  assert.equal((await answerFor(slow, targets, base, 'open', [someCaller()])).reason, 'whether it is overridden could not be listed: the implementations query timed out after 20 ms');
});

test('constructors: this(…)/super(…) callers stay complete; a no-argument constructor of a non-final class is incomplete (implicit super())', async () => {
  const { extras } = extrasOver(targets);
  // jdtls lists `this()` / `super(n)` at the constructor's own name (J0).
  const base = '/r/src/Base.java';
  const text = targets[base];
  const one = text.indexOf('Base(int n)');
  let applied = await applyCallerExtras({ ready: true, rows: [{ label: 'Sub.Sub', file: '/r/src/Sub.java', pos: 3, test: false, sites: 1, callSites: [] }] }, { extras, query: extras.query(base, one), file: base, pos: one, withTests: true });
  assert.equal(/** @type {any} */ (applied).answer.complete, true);
  const noArg = text.indexOf('Base() {');
  applied = await applyCallerExtras({ ready: true, rows: [someCaller()] }, { extras, query: extras.query(base, noArg), file: base, pos: noArg, withTests: true });
  assert.equal(/** @type {any} */ (applied).answer.reason, IMPLICIT_SUPER_REASON);
  // A final class's no-arg constructor called by `this()`: complete.
  const t = targets[T];
  const tNoArg = t.indexOf('T() {');
  applied = await applyCallerExtras({ ready: true, rows: [{ label: 'T.T', file: T, pos: t.indexOf('T(int a)'), test: false, sites: 1, callSites: [] }] }, { extras, query: extras.query(T, tNoArg), file: T, pos: tNoArg, withTests: true });
  assert.equal(/** @type {any} */ (applied).answer.complete, true);
  // With no caller at all: unknown with a reason, not 'di'.
  const tInt = t.indexOf('T(int a)');
  applied = await applyCallerExtras({ ready: true, rows: [] }, { extras, query: extras.query(T, tInt), file: T, pos: tInt, withTests: true });
  assert.equal(/** @type {any} */ (applied).answer.reason, UNBUILT_REASON);
  // Enum and record constructors: neither is a class a subclass extends.
  const kind = targets['/r/src/Kind.java'];
  const kNoArg = kind.indexOf('Kind() {');
  applied = await applyCallerExtras({ ready: true, rows: [someCaller()] }, { extras, query: extras.query('/r/src/Kind.java', kNoArg), file: '/r/src/Kind.java', pos: kNoArg, withTests: true });
  assert.equal(/** @type {any} */ (applied).answer.complete, true);
});

test('DI: a @Service class\'s and an @Inject constructor with no caller read di; a @Bean method is incomplete', async () => {
  const { extras } = extrasOver(targets);
  for (const [file, name] of [['/r/src/Svc.java', 'Svc'], ['/r/src/Inj.java', 'Inj']]) {
    const text = targets[file];
    const pos = text.indexOf(`${name}(`);
    const services = /** @type {any} */ ({ async prepareCallHierarchy() { return [{}]; }, async incomingCalls() { return []; } });
    const state = await callersFromHierarchy(services, {
      doc: { file, side: 'head' }, pos, isConstructor: true,
      incoming: async () => /** @type {any} */ (await applyCallerExtras(await queryHierarchy(services, { file, side: 'head' }, pos), { extras, query: extras.query(file, pos), file, pos, withTests: true })).answer,
    });
    assert.deepEqual([name, state.state, state.complete], [name, 'di', true]);
  }
  assert.equal((await answerFor(extras, targets, '/r/src/Svc.java', 'repo', [someCaller()])).reason, DI_FACTORY_REASON);
});

test('annotation processing: a Lombok class\'s members are incomplete', async () => {
  const { extras } = extrasOver(targets);
  const answer = await answerFor(extras, targets, '/r/src/Pojo.java', 'twice', [someCaller()]);
  assert.equal(answer.reason, GENERATED_REASON);
});

test('value use: a method reference makes the answer incomplete with the shared reason', async () => {
  const { extras } = extrasOver({ ...targets, [CALLS]: callsText });
  const ref = callsText.indexOf('f::run') + 3;
  const answer = await answerFor(extras, targets, T, 'plain', [{ label: 'b', file: CALLS, pos: 0, test: false, sites: 1, callSites: [{ start: ref, end: ref + 3 }] }, someCaller()]);
  assert.equal(answer.reason, VALUE_USE_REASON);
  assert.deepEqual(answer.callers.map((c) => c.label), ['C.m']);
});

test('a default-project caller is dropped and the rest of the answer stands', async () => {
  const { extras } = extrasOver(targets);
  const answer = await answerFor(extras, targets, T, 'plain', [
    { label: 'Ghost.m', file: '/d/jdt.ls-java-project/src/p/T.java', pos: 0, test: false, sites: 1, callSites: [{ start: 0, end: 1 }] },
    someCaller(),
  ]);
  assert.deepEqual([answer.complete, answer.callers.map((c) => c.label)], [true, ['C.m']]);
});

test('-32603: a rejected incomingCalls is incomplete with the error, never empty and complete', async () => {
  const { extras } = extrasOver(targets);
  const services = /** @type {any} */ ({
    async prepareCallHierarchy() { return [{}]; },
    async incomingCalls() { throw Object.assign(new Error('Internal error'), { code: -32603 }); },
  });
  const file = T;
  const pos = targets[T].indexOf('plain(');
  const hierarchy = await queryHierarchy(services, { file, side: 'head' }, pos);
  const applied = /** @type {any} */ (await applyCallerExtras(hierarchy, { extras, query: extras.query(file, pos), file, pos, withTests: true }));
  assert.deepEqual([applied.answer.complete, applied.answer.reason, applied.answer.callers.length], [false, 'Internal error', 0]);
  const state = await callersFromHierarchy(services, { doc: { file, side: 'head' }, pos, incoming: async () => applied.answer });
  assert.deepEqual([state.state, state.complete], ['unknown', false]);
});

test('-32603 (J6): asked once more through Java\'s retryRejected; a second rejection stays incomplete; other errors are not retried', async () => {
  const { extras } = extrasOver(targets);
  const retryRejected = extras.retryRejected ?? null;
  const file = T;
  const pos = targets[T].indexOf('plain(');
  const rows = [someCaller()];
  /** @param {Array<Error|null>} script @returns {{ services: any, asked: () => number }} */
  const over = (script) => {
    let n = 0;
    return {
      asked: () => n,
      services: {
        async prepareCallHierarchy() { return [{}]; },
        async incomingCalls() { const e = script[n++]; if (e) throw e; return rows; },
      },
    };
  };
  const internal = () => new Error('LSP callHierarchy/incomingCalls failed: Internal error. (code -32603)');
  const once = over([internal(), null]);
  assert.deepEqual(await queryHierarchy(once.services, { file, side: 'head' }, pos, { retryRejected }), { ready: true, rows });
  assert.equal(once.asked(), 2);
  const twice = over([internal(), internal(), null]);
  const failed = await queryHierarchy(twice.services, { file, side: 'head' }, pos, { retryRejected });
  assert.deepEqual([failed.ready, twice.asked()], [false, 2]);
  assert.match(String(failed.reason), /-32603/);
  // VS Code's command reports the message alone.
  assert.equal((await queryHierarchy(over([new Error('Internal error.'), null]).services, { file, side: 'head' }, pos, { retryRejected })).ready, true);
  const other = over([new Error('LSP callHierarchy/incomingCalls failed: Invalid params (code -32602)'), null]);
  assert.equal((await queryHierarchy(other.services, { file, side: 'head' }, pos, { retryRejected })).ready, false);
  assert.equal(other.asked(), 1);
  const retryable = over([Object.assign(internal(), { retryable: true }), null]);
  assert.deepEqual(await queryHierarchy(retryable.services, { file, side: 'head' }, pos, { retryRejected }), { ready: false, reason: internal().message, retryable: true });
  assert.equal(retryable.asked(), 1);
  // Without the option (every other language): never asked again.
  const plain = over([internal(), null]);
  assert.equal((await queryHierarchy(plain.services, { file, side: 'head' }, pos)).ready, false);
  assert.equal(plain.asked(), 1);
});

test('the target\'s file unreadable: incomplete', async () => {
  const { extras } = extrasOver({});
  const applied = /** @type {any} */ (await applyCallerExtras({ ready: true, rows: [someCaller()] }, { extras, query: extras.query('/r/src/Gone.java', 5), file: '/r/src/Gone.java', pos: 5, withTests: true }));
  assert.equal(applied.answer.reason, UNREAD_TARGET_REASON);
});

test('declarationAt reads the enclosing type, its annotations and supertypes', () => {
  const t = targets['/r/src/Pojo.java'];
  const d = declarationAt(maskJava(t), t.indexOf('twice'));
  assert.deepEqual([d.type.kind, d.type.name, d.type.annotations, [...d.modifiers]], ['class', 'Pojo', ['Data', 'Builder'], ['static', 'int']]);
  const r = targets['/r/src/Pt.java'];
  assert.equal(declarationAt(maskJava(r), r.indexOf('sum')).type.kind, 'record');
  assert.equal(declarationAt(maskJava(r), r.indexOf('Pt {')), null, 'a compact constructor has no `(`');
  const b = targets['/r/src/Base.java'];
  assert.deepEqual(declarationAt(maskJava(b), b.indexOf('open')).type.supertypes, ['Parent']);
});

test('javaProvider.editorCallers builds Java\'s extras', () => {
  assert.equal(typeof javaProvider.editorCallers, 'function');
  const extras = /** @type {Function} */ (javaProvider.editorCallers)({ ts: null, services: null, repoRoot: ROOT, trace() {}, filterInherited: false, onWarmupRetry() {} });
  assert.equal(extras.droppedStat, 'valueUsesDropped');
  assert.equal(typeof extras.query, 'function');
});
