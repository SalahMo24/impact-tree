'use strict';
// Java's syntax-only caller index (J8, docs/MULTI_LANGUAGE_PLAN.md;
// src/languages/java/syntactic-index.js): each resolution rule, each non-rule (look-alike
// names in another package, untyped receivers, same-arity overloads, method references,
// calls in comments and strings, Lombok, interface dispatch), every answer incomplete with
// its scope, and the budgets at limit-1 / limit / limit+1.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJavaSyntacticIndex, MAX_FILE_BYTES, MAX_CHAIN_DEPTH, MAX_HIERARCHY } = require('../src/languages/java/syntactic-index');
const { SOURCES } = require('./java-syntactic-fixture');

const idx = createJavaSyntacticIndex(SOURCES, { root: '/r', scope: 'the fixture' });
const textOf = (file) => SOURCES.find((s) => `/r/${s.path}` === file).text;

/** The callers of the method keyed `key` in `rel`: `{ rows: ['caller key: call line text', …], reason, unresolved }`. */
function callersOf(rel, key) {
  const d = idx.byFile.get(`/r/${rel}`).defs.find((x) => x.key === key);
  assert.ok(d, `${rel} declares ${key}`);
  const a = idx.callersOfWithStatus({ file: `/r/${rel}`, name: d.name, pos: d.namePos });
  const rows = a.callers.flatMap((c) => c.callSites.map((s) => {
    const text = textOf(c.file);
    const line = text.slice(text.lastIndexOf('\n', s.start) + 1, text.indexOf('\n', s.start)).trim();
    return `${c.label}: ${line}`;
  })).sort();
  return { rows, reason: a.incompleteReason, unresolved: idx.unresolvedCallsTo({ name: d.name }) };
}

test('every file of the fixture is indexed', () => {
  assert.equal(idx.size, SOURCES.length);
  assert.equal(idx.skipped, 0);
});

test('a field receiver, a static import and a call through the declared return type', () => {
  const close = callersOf('lib/Client.java', 'Client.close()');
  assert.deepEqual(close.rows, [
    'App.a(Client): ((Client) obj()).close();',
    'App.a(Client): field.close();',
    'Sub.b(): void b() { super.close(); ping(); close(); this.getInner(); }',
    'Sub.b(): void b() { super.close(); ping(); close(); this.getInner(); }',
  ], 'a cast, a field, `super.m(` and an inherited bare `m(`; not the comment, the string, or `o.close()` on the other package\'s Client');
  assert.equal(close.unresolved, 1, 'the untyped lambda parameter `x.close()`');
  assert.match(close.reason, /^Java callers from syntax only: the fixture; /);
  assert.doesNotMatch(close.reason, /overridable/, 'a final method');
  assert.deepEqual(callersOf('lib/Inner.java', 'Inner.run()').rows, [
    'App.a(Client): new Inner().run();',
    'App.a(Client): v.getInner().run();',
  ], '`var v = new Client(3)` then the return type of getInner(); `new T().m(` through an on-demand import');
  assert.deepEqual(callersOf('lib/Client.java', 'Client.util(String...)').rows, ['App.a(Client): util("a", "b");'], 'a static single import, varargs with 2 arguments');
  assert.deepEqual(callersOf('lib/Client.java', 'Client.create()').rows, ['App.a(Client): Client.create();'], 'a static call `T.m(`');
  assert.deepEqual(callersOf('lib/Client.java', 'Client.helper()').rows, ['Client.close(): public final void close() { helper(); }'], 'a bare call in the same class');
  assert.deepEqual(callersOf('lib/Base.java', 'Base.ping()').rows, ['Sub.b(): void b() { super.close(); ping(); close(); this.getInner(); }'], 'inherited through `extends` twice');
  assert.deepEqual(callersOf('lib/Client.java', 'Client.getInner()').rows, [
    'Anon.make(Client): void helperOf(Client k) { k.getInner(); }',
    'Anon.typed(Client): void typed(Client c) { c.<String>getInner(); }',
    'App.a(Client): v.getInner().run();',
    'Sub.b(): void b() { super.close(); ping(); close(); this.getInner(); }',
  ], '`this.m(` in a subclass');
});

test('the look-alike in another package is not a caller of either', () => {
  const other = callersOf('other/Client.java', 'Client.close()');
  assert.deepEqual(other.rows, ['App.a(Client): o.close();'], 'only the receiver typed `com.ex.other.Client`');
  assert.deepEqual(callersOf('other/Client.java', 'Client.send(String)').rows, []);
});

test('overloads by argument count: a same-arity pair is each listed, and the answer says so', () => {
  const s = callersOf('lib/Client.java', 'Client.send(String)');
  const i = callersOf('lib/Client.java', 'Client.send(int)');
  const two = callersOf('lib/Client.java', 'Client.send(String, int)');
  assert.deepEqual(s.rows, ['App.a(Client): c.send("x");']);
  assert.deepEqual(i.rows, ['App.a(Client): c.send("x");']);
  assert.deepEqual(two.rows, ['App.a(Client): c.send("x", 1);']);
  assert.match(s.reason, /1 call\(s\) match several overloads with the same number of arguments/);
  assert.doesNotMatch(two.reason, /several overloads/);
  assert.match(two.reason, /referenced as a method reference 1 time\(s\) \(`X::send`\)/, '`c::send` is a value use, not a call');
});

test('constructors by `new T(` and `this(`; the no-argument constructor says subclasses are not followed', () => {
  const none = callersOf('lib/Client.java', 'Client.<init>()');
  assert.deepEqual(none.rows, ['Client.create(): public static Client create() { return new Client(); }', 'new Client(int): public Client(int x) { this(); }']);
  assert.match(none.reason, /implicit super\(\) call is not listed/);
  assert.deepEqual(callersOf('lib/Client.java', 'Client.<init>(int)').rows, ['App.a(Client): var v = new Client(3);']);
});

test('interface dispatch, overridable methods and Lombok are incomplete with their reasons', () => {
  const iface = callersOf('lib/Doer.java', 'Doer.doIt()');
  assert.deepEqual(iface.rows, ['App.a(Client): d.doIt();']);
  assert.match(iface.reason, /an interface method: calls are matched by the receiver's written type/);
  const impl = callersOf('lib/Impl.java', 'Impl.doIt()');
  assert.deepEqual(impl.rows, ['App.a(Client): new Impl().doIt();']);
  assert.match(impl.reason, /\(1 call\(s\) to the Doer declaration it overrides\)/);
  const pojo = callersOf('lib/Pojo.java', 'Pojo.touch()');
  assert.deepEqual(pojo.rows, ['App.a(Client): new Pojo().touch();']);
  assert.match(pojo.reason, /members generated by annotation processing are not read/);
  assert.equal(idx.unresolvedCallsTo({ name: 'getName' }), 1, 'a generated getter is an unresolved call, not "outside"');
});

test('anonymous-class methods, enum constants and explicit type arguments (gson corrections)', () => {
  assert.deepEqual(callersOf('lib/Doer.java', 'Doer.doIt()').rows, ['App.a(Client): d.doIt();'], 'the anonymous class\'s `public void doIt() {` is a declaration, not a call');
  const inner = callersOf('lib/Client.java', 'Client.getInner()').rows;
  assert.ok(inner.includes('Anon.make(Client): void helperOf(Client k) { k.getInner(); }'), 'a parameter of an anonymous class\'s method is typed');
  assert.ok(inner.includes('Anon.typed(Client): void typed(Client c) { c.<String>getInner(); }'), '`x.<T>m(`');
  assert.deepEqual(callersOf('app/More.java', 'Mode.<init>(int)').rows, ['Mode: FAST(1), SLOW(2, Collections.<String, Integer>emptyMap()), NONE;']);
  assert.deepEqual(callersOf('app/More.java', 'Mode.<init>(int, Map)').rows, ['Mode: FAST(1), SLOW(2, Collections.<String, Integer>emptyMap()), NONE;'], 'explicit type arguments do not add arguments');
  assert.deepEqual(callersOf('app/More.java', 'Mode.<init>()').rows, ['Mode: FAST(1), SLOW(2, Collections.<String, Integer>emptyMap()), NONE;']);
});

test('the preview says the files outside the pull request were not read; an unknown target says so', () => {
  const p = createJavaSyntacticIndex(SOURCES, { root: '/r', scope: 'the PR', partialPackages: true });
  const d = p.byFile.get('/r/lib/Client.java').defs.find((x) => x.key === 'Client.helper()');
  assert.match(p.callersOfWithStatus({ file: '/r/lib/Client.java', name: 'helper', pos: d.namePos }).incompleteReason, /the files outside the pull request were not read$/);
  assert.match(idx.callersOfWithStatus({ file: '/r/nope.java', name: 'x' }).incompleteReason, /the method was not found in the indexed files$/);
  assert.deepEqual(idx.symbolAt('/r/lib/Client.java', d.namePos), { className: 'Client', name: 'helper' });
  assert.equal(idx.symbolAt('/r/lib/Client.java', 0), null);
});

test('budget: bytes per file at limit-1, limit, limit+1', () => {
  const body = 'package p;\nclass A { void m() {} }\n';
  const pad = (n) => body + ' '.repeat(n - body.length);
  for (const [n, indexed] of [[MAX_FILE_BYTES - 1, 1], [MAX_FILE_BYTES, 1], [MAX_FILE_BYTES + 1, 0]]) {
    const i = createJavaSyntacticIndex([{ path: 'A.java', text: pad(n) }]);
    assert.equal(i.size, indexed, `${n} chars`);
    assert.equal(i.skipped, 1 - indexed);
    if (!indexed) assert.match(i.scopeNote(), /1 Java file\(s\) not indexed \(1 unreadable or over 1 MiB\)/);
  }
});

test('budget: receiver chains at limit-1, limit, limit+1', () => {
  const chain = (n) => `package p;\nclass Node { Node f; void m() {} }\nclass U { void u(Node x) { x${'.f'.repeat(n)}.m(); } }\n`;
  const resolves = (n) => {
    const i = createJavaSyntacticIndex([{ path: 'A.java', text: chain(n) }]);
    return i.allCalls().find((c) => c.kind === 'call').targets;
  };
  assert.ok(Array.isArray(resolves(MAX_CHAIN_DEPTH - 1)));
  assert.ok(Array.isArray(resolves(MAX_CHAIN_DEPTH)));
  assert.equal(resolves(MAX_CHAIN_DEPTH + 1), 'unresolved', 'past the bound the receiver is not typed');
});

test('budget: type hierarchy at limit-1, limit, limit+1', () => {
  const tower = (n) => {
    let s = 'package p;\nclass C0 { void m() {} }\n';
    for (let k = 1; k < n; k++) s += `class C${k} extends C${k - 1} {}\n`;
    return `${s}class U { void u(C${n - 1} x) { x.m(); } }\n`;
  };
  const resolves = (n) => createJavaSyntacticIndex([{ path: 'A.java', text: tower(n) }]).allCalls().find((c) => c.kind === 'call').targets;
  assert.ok(Array.isArray(resolves(MAX_HIERARCHY - 1)));
  assert.ok(Array.isArray(resolves(MAX_HIERARCHY)));
  assert.equal(resolves(MAX_HIERARCHY + 1), 'unresolved', 'past the bound the lookup is open');
});
