// @ts-check
'use strict';
// C# signatures (Part C, C2): a member's header parsed into the `sig` the shared diffSignature
// compares, the C-D6 key's parameter text, the `throw new` types of its body, the change kinds
// (C-D6) and the display. The whole-repository check against Roslyn is
// `test/lsp-harness/csharp-verify.js --signatures`.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCsharpDeclaration, parseCsharpParameterList, csharpKeyParams, csharpExtensionKeyParams, thrownOf, csharpKindsOf,
  renderCsharpSig,
} = require('../src/languages/csharp/signature');
const { diffSignature, KIND } = require('../src/engine/signature');

/** @param {string} text */
function parse(text) {
  const parsed = parseCsharpDeclaration(text);
  assert.ok(parsed, `expected to parse: ${text}`);
  return parsed;
}
/** @param {string} text */
const keyOf = (text) => csharpKeyParams(parse(text).params);
/** @param {string} text @param {boolean} [inInterface] */
const side = (text, inInterface = false) => {
  const p = parseCsharpDeclaration(text);
  return { sig: p ? p.sig : null, header: p ? p.header : text, modifiers: p ? p.modifiers : [], inInterface, explicitInterface: p ? p.explicitInterface : null };
};
/** @param {string} a @param {string} b @param {boolean} [inInterface] @returns {string[]} */
const kinds = (a, b, inInterface) => csharpKindsOf(side(a, inInterface), side(b, inInterface)).map((k) => /** @type {any} */ (k).id);
/** @param {string} text */
const thrown = (text) => [...thrownOf(text, parse(text).headerEnd)].sort();

test('a method: attributes, modifiers, return type, parameters as written, sig, header and body', () => {
  const text = '/// <summary>Doc.</summary>\n[HttpGet("{id}")]\n[ProducesResponseType(StatusCodes.Status200OK)]\npublic async Task<ActionResult<Foo>> Get(\n    [FromRoute, Required] Guid id,\n    [FromQuery] string? name = null,\n    params int[] xs)\n{\n    return Ok();\n}';
  const p = parse(text);
  assert.equal(p.kind, 'method');
  assert.equal(p.name, 'Get');
  assert.deepEqual(p.attributes, ['[HttpGet("{id}")]', '[ProducesResponseType(StatusCodes.Status200OK)]']);
  assert.deepEqual(p.modifiers, ['public', 'async']);
  assert.equal(p.returns, 'Task<ActionResult<Foo>>');
  assert.deepEqual(p.params, [
    { name: 'id', type: 'Guid', keyType: 'Guid', modifiers: [], default: null, attributes: ['[FromRoute, Required]'] },
    { name: 'name', type: 'string?', keyType: 'string?', modifiers: [], default: 'null', attributes: ['[FromQuery]'] },
    { name: 'xs', type: 'int[]', keyType: 'params int[]', modifiers: ['params'], default: null, attributes: [] },
  ]);
  assert.deepEqual(p.sig, {
    async: true, name: 'Get', returns: 'Task<ActionResult<Foo>>', typeParameters: '', constraints: '',
    params: [
      { name: 'id', type: 'Guid', optional: false, rest: false, default: null },
      { name: 'name', type: 'string?', optional: true, rest: false, default: 'null' },
      { name: 'xs', type: 'params int[]', optional: false, rest: true, default: null },
    ],
  });
  assert.equal(p.header, 'public async Task<ActionResult<Foo>> Get( [FromRoute, Required] Guid id, [FromQuery] string? name = null, params int[] xs)');
  assert.equal(text[p.headerEnd], '{');
  assert.equal(p.body, 'block');
});

test('parameter modifiers this/ref/out/in/params/scoped/ref readonly, tuples, global:: and nested generics', () => {
  const text = 'public static bool TryParse(this ReadOnlySpan<char> s, out global::System.Int32 v, in (int a, string b) t, scoped ref Span<byte> buf, ref readonly int r) => false;';
  const p = parse(text);
  assert.deepEqual(p.params.map((x) => x.modifiers), [['this'], ['out'], ['in'], ['scoped', 'ref'], ['ref', 'readonly']]);
  assert.equal(csharpKeyParams(p.params), 'this ReadOnlySpan, out Int32, in (int, string), ref Span, ref readonly int');
  assert.equal(p.body, 'expression');
  assert.equal(text.slice(p.headerEnd, p.headerEnd + 2), '=>');
  assert.equal(keyOf('void M(Dictionary<string, List<int>>?[] d, int?[,] m, List<int>? l, (int, string)? t, int* p) {}'), 'Dictionary?[], int?[,], List?, (int, string)?, int*');
});

test('F(int) and F(int?) overloads have distinct keys; a ?-only change of int is a type change', () => {
  assert.equal(keyOf('public void F(int x) {}'), 'int');
  assert.equal(keyOf('public void F(int? x) {}'), 'int?');
  assert.deepEqual(kinds('public void F(int x) {}', 'public void F(int? x) {}'), ['type-changed']);
  assert.deepEqual(kinds('public void F(Guid x) {}', 'public void F(Guid? x) {}'), ['type-changed']);
  // C-D6's closed list: string, object, dynamic and arrays.
  assert.deepEqual(kinds('public void F(string s, object o, dynamic d, int[] a, List<string> l) {}', 'public void F(string? s, object? o, dynamic? d, int[]? a, List<string?> l) {}'), []);
  assert.deepEqual(kinds('public string F() {}', 'public string? F() {}'), []);
});

test('generic methods, constraints, explicit interface implementations', () => {
  const g = parse('public T Get<T, [Foo] U>(T a) where T : class, new() where U : struct { }');
  assert.deepEqual(g.typeParameters, ['T', 'U']);
  assert.equal(g.sig.typeParameters, '<T, [Foo] U>');
  assert.equal(g.sig.constraints, 'where T : class, new() where U : struct');
  const e = parse('IEnumerator<T> System.Collections.Generic.IEnumerable<T>.GetEnumerator() { yield break; }');
  assert.equal(e.explicitInterface, 'IEnumerable<1>');
  assert.equal(e.name, 'GetEnumerator');
  assert.deepEqual(e.modifiers, []);
  assert.equal(parse('void IDisposable.Dispose() {}').explicitInterface, 'IDisposable');
  assert.deepEqual(kinds('public T Get<T>(T a) where T : class {}', 'public T Get<T>(T a) where T : struct {}'), ['type-changed']);
});

test('constructors, static constructors, operators, conversions, properties, indexers; non-members are null', () => {
  const c = parse('public Foo(int x, string y = "a") : base(x, v => { return y; }) { }');
  assert.equal(c.kind, 'constructor');
  assert.equal(c.returns, null);
  assert.equal(c.header, 'public Foo(int x, string y = "a") : base(x, v => { return y; })');
  assert.equal(parse('static Foo() { }').kind, 'static-constructor');
  const op = parse('public static Vec operator >>(Vec a, int b) => a;');
  assert.deepEqual([op.kind, op.name], ['operator', 'operator >>']);
  assert.equal(parse('public static bool operator checked +(A a, A b) => true;').name, 'operator checked +');
  const conv = parse('public static implicit operator Result<T>(T value) => new(value);');
  assert.deepEqual([conv.kind, conv.name, conv.returns], ['conversion', 'implicit operator Result', 'Result<T>']);
  const ix = parse('public int this[int i, string k = "a"] { get { return 1; } }');
  assert.deepEqual([ix.kind, ix.body, csharpKeyParams(ix.params)], ['indexer', 'accessors', 'int, string']);
  assert.deepEqual([parse('public abstract string Name { get; }').body, parse('public int Count => 3;').body], ['none', 'expression']);
  const t = parse('private static (int? Season, bool IsFolder) Check(Match m) { }');
  assert.equal(t.returns, '(int? Season, bool IsFolder)');
  for (const bad of ['private int x = 3;', 'public event EventHandler E;', '~Foo() { }', 'public class Foo { }', 'int x', 'void M(int) {}']) {
    assert.equal(parseCsharpDeclaration(bad), null, bad);
  }
});

test('fields are not members: null with or without an initializer, const, event fields', () => {
  for (const field of [
    'private readonly int _x;', 'public int X;', '[A] B c;', 'private List<int>? _items;', 'int a, b;',
    'private readonly int _x = 3;', 'public static readonly Foo Default = new();', 'const int Max = 10;',
    'public const string Name = "n";', 'public event EventHandler E;', 'public event EventHandler? Changed = null;',
    'static event Action A, B;',
  ]) assert.equal(parseCsharpDeclaration(field), null, field);
  // Properties still parse: accessors, `=>`, and an initializer after the accessor list.
  assert.equal(parse('public int P { get; set; }').kind, 'property');
  assert.equal(parse('public int P { get; } = 3;').kind, 'property');
  assert.equal(parse('public int P => 1;').kind, 'property');
});

test('extension blocks: the key parameter text of the classic extension method', () => {
  const m = parse('public int M(int x, ref string y) => 1;');
  assert.equal(csharpExtensionKeyParams('(Foo f)', m.params), 'this Foo, int, ref string');
  // Same text as the classic form's own parameters.
  assert.equal(csharpExtensionKeyParams('(Foo f)', m.params), keyOf('public static int M(this Foo f, int x, ref string y) => 1;'));
  assert.equal(csharpExtensionKeyParams('(N.List<T>? items)', []), 'this List?');
  assert.equal(csharpExtensionKeyParams('(ref Span<int> s)', []), 'this ref Span');
  assert.equal(keyOf('static void Bump(ref this Span<int> s) { }'), 'this ref Span');
  assert.equal(csharpExtensionKeyParams('(Foo)', []), 'this Foo');
  assert.equal(csharpExtensionKeyParams('()', []), null);
  assert.equal(csharpExtensionKeyParams('(int a, int b)', []), null);
});

test('a primary constructor parameter list', () => {
  const p = parseCsharpParameterList('(\n  IOptions<BackgroundTaskOptions> options,\n  [FromKeyedServices("k")] IEventBus bus, int n = 1)');
  assert.ok(p);
  assert.equal(csharpKeyParams(p.params), 'IOptions, IEventBus, int');
  assert.deepEqual(p.params[1].attributes, ['[FromKeyedServices("k")]']);
  assert.equal(p.sig.params[2].default, '1');
});

test('sig.async follows the awaitable return type, never the async keyword', () => {
  assert.equal(parse('public Task M() => Task.CompletedTask;').sig.async, true);
  assert.equal(parse('public ValueTask<int> M() => default;').sig.async, true);
  assert.equal(parse('public async IAsyncEnumerable<int> M() { yield return 1; }').sig.async, true);
  assert.equal(parse('public async void M() { }').sig.async, false);
  assert.deepEqual(kinds('public Task PublishAsync(E e) => x;', 'public async Task PublishAsync(E e) { }'), []);
  assert.deepEqual(kinds('public int M() => 1;', 'public Task<int> M() => 1;'), ['async-changed', 'return-changed']);
});

test('kinds: default-changed, ref/out/params changes, optional parameters, removals', () => {
  assert.deepEqual(kinds('void M(int a = 1) {}', 'void M(int a = 2) {}'), ['default-changed']);
  assert.deepEqual(kinds('void M(int a = 1) {}', 'void M(int a  =  1) {}'), []);
  assert.deepEqual(kinds('void M(int a) {}', 'void M(ref int a) {}'), ['type-changed']);
  assert.deepEqual(kinds('void M(int[] a) {}', 'void M(params int[] a) {}'), ['type-changed']);
  assert.deepEqual(kinds('void M(Foo a) {}', 'void M(this Foo a) {}'), ['type-changed']);
  assert.deepEqual(kinds('void M(Span<int> a) {}', 'void M(scoped Span<int> a) {}'), []);
  assert.deepEqual(kinds('void M(int a) {}', 'void M(int a, CancellationToken ct = default) {}'), ['optional-param']);
  assert.deepEqual(kinds('void M(int a, int b) {}', 'void M(int a) {}'), ['param-removed']);
  // Attribute changes are no kind (they show in the header diff).
  assert.deepEqual(kinds('void M([Range(0, 9)] long a) {}', 'void M(long a) {}'), []);
});

test('kinds: access per C-D6 lattice, static added or removed; virtual removed and sealed added are none', () => {
  assert.deepEqual(kinds('internal static string M() {}', 'public static string M() {}'), []);
  assert.deepEqual(kinds('public void M() {}', 'internal void M() {}'), ['access-changed']);
  assert.deepEqual(kinds('protected void M() {}', 'internal void M() {}'), ['access-changed']);
  assert.deepEqual(kinds('internal void M() {}', 'protected void M() {}'), ['access-changed']);
  assert.deepEqual(kinds('protected void M() {}', 'protected internal void M() {}'), []);
  assert.deepEqual(kinds('private protected void M() {}', 'protected void M() {}'), []);
  assert.deepEqual(kinds('void M() {}', 'private void M() {}'), []);
  assert.deepEqual(kinds('void M();', 'public void M();', true), []);
  assert.deepEqual(kinds('void M();', 'internal void M();', true), ['access-changed']);
  assert.deepEqual(kinds('public void M() {}', 'public static void M() {}'), ['access-changed']);
  assert.deepEqual(kinds('public virtual void M() {}', 'public void M() {}'), []);
  assert.deepEqual(kinds('public override void M() {}', 'public sealed override void M() {}'), []);
});

test('an unreadable header falls back to comparing header text', () => {
  assert.deepEqual(csharpKindsOf({ sig: null, header: 'void M(int)', modifiers: [] }, { sig: null, header: 'void  M(int)', modifiers: [] }), []);
  assert.deepEqual(csharpKindsOf({ sig: null, header: 'void M(int)', modifiers: [] }, { sig: null, header: 'void M(long)', modifiers: [] }).map((k) => /** @type {any} */ (k).id), ['type-changed']);
  assert.deepEqual(csharpKindsOf(null, side('void M() {}')), []);
});

test('thrownOf: throw statements and expressions, lambdas included, guards and rethrows not', () => {
  assert.deepEqual(thrown('void M(string s) { ArgumentNullException.ThrowIfNull(s); if (s == "") throw new ArgumentException("e", nameof(s)); try { } catch (Exception e) { throw; } throw e; }'), ['ArgumentException']);
  assert.deepEqual(thrown('string M(string? s) => s ?? throw new System.ArgumentNullException(nameof(s));'), ['System.ArgumentNullException']);
  assert.deepEqual(thrown('void M() { Action a = () => throw new InvalidOperationException(); void L() { throw new NotSupportedException { HelpLink = "x" }; } }'), ['InvalidOperationException', 'NotSupportedException']);
  assert.deepEqual(thrown('void M() { throw new Failure<int>(1); throw new X().WithData(1); }'), ['Failure']);
  assert.deepEqual(thrown('void M() { var s = "throw new Fake()"; /* throw new Nope() */ }'), []);
  assert.deepEqual([...thrownOf('void M();', parse('void M();').headerEnd)], []);
});

test('renderCsharpSig', () => {
  assert.equal(renderCsharpSig(parse('public T Get<T>(ref int a, string? b = null) where T : class {}').sig), '<T> (ref int a, string? b = null): T where T : class');
  assert.equal(renderCsharpSig(parse('public Foo(int a) {}').sig), '(int a)');
});

test('shared diffSignature: default-changed only when both sides carry default text (C# sigs)', () => {
  const sig = (/** @type {any} */ p) => ({ sig: { async: false, returns: null, params: [{ name: 'a', type: 'int', optional: true, rest: false, ...p }] } });
  assert.deepEqual(diffSignature(sig({ default: '1' }), sig({ default: '2' })), [KIND.DEFAULT_CHANGED]);
  assert.deepEqual(diffSignature(sig({ default: '1' }), sig({ default: '1' })), []);
  // TypeScript, Python, Go and Java params have no `default`: unchanged behaviour.
  assert.deepEqual(diffSignature(sig({}), sig({})), []);
  assert.equal(KIND.DEFAULT_CHANGED.id, 'default-changed');
  assert.equal(KIND.DEFAULT_CHANGED.label, 'default value changed (callers that omit it get the new value)');
  assert.ok(KIND.DEFAULT_CHANGED.weight < KIND.OPTIONAL_PARAM.weight && KIND.DEFAULT_CHANGED.weight > KIND.PARAM_REMOVED.weight);
});
