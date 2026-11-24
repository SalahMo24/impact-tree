// @ts-check
'use strict';
// C# from its text (Part C, C3): the outline (src/languages/csharp/outline.js) shaped as
// document symbols, its keys (keys.js, C-D6 and the extension-block addendum), `#if` read as
// Roslyn with no symbols, and the provider (provider.js): candidates, J-D3 pairing, and the
// preview with callers not computed. The whole-repository check against Roslyn is
// `test/lsp-harness/csharp-verify.js --syntactic --outline test/lsp-harness/csharp-outline-adapter.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const models = require('../src/views/changes/tree-row-models');
const { ts, root } = require('./bug-regressions-helpers');
const { csharpOutline, csharpOutlineParts, activeText } = require('../src/languages/csharp/outline');
const { lex } = require('../src/languages/csharp/lexer');
const { collectCsharpSymbols, pairCsharpOverloads, csharpProvider } = require('../src/languages/csharp/provider');
const { overloadNameOf } = require('../src/languages/csharp/keys');
const { outlineOf } = require('./lsp-harness/csharp-outline-adapter');

/** @param {string} text @param {string} [file] @returns {string[]} `<kind> <key>` of each member. */
const keysOf = (text, file) => outlineOf(text, file).map((m) => `${m.kind} ${m.key}`);
/** @param {string} text @returns {Record<string, string>} key → the text its range covers. */
const spans = (text) => Object.fromEntries(outlineOf(text).map((m) => [m.key, text.slice(m.start, m.end)]));
/** @param {string} text @returns {Record<string, string>} key → the name token's text. */
const names = (text) => Object.fromEntries(outlineOf(text).map((m) => [m.key, text.slice(m.nameOffset, m.nameOffset + (text.slice(m.nameOffset).match(/^[\w@]+/) || [''])[0].length)]));

const FIXTURES = path.join(__dirname, 'csharp-syntax-oracle', 'fixtures');
/** @param {string} name */
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// The syntax oracle's fixtures (`csharp-verify.js --fixture-keys` writes their expected keys
// from Roslyn): keys.cs (C-D6 keys the test repositories lack), outline.cs (every construct of
// PLAN.md §2, C# 14 extension blocks, the `field` keyword, partial properties, tuples inside
// generics, `Result` and `Result<T>` in one file, `#if` branches), toplevel.cs (top-level
// statements).
for (const name of ['keys.cs', 'outline.cs', 'toplevel.cs']) {
  test(`the oracle fixture ${name}: the outline's members and keys are Roslyn's, in source order`, () => {
    const expected = JSON.parse(fixture(name.replace(/\.cs$/, '.expected.json'))).members;
    assert.deepEqual(keysOf(fixture(name), name), expected);
  });
}

const SECTION2 = fixture('outline.cs');

test('ranges are Roslyn\'s Span: attributes in, doc comments out; names are the name token', () => {
  const s = spans(SECTION2);
  assert.equal(s['OrdersController.Get(int, string?, params string[])'],
    '[HttpGet("{id}")]\n        public async Task<IActionResult> Get(int id, string? filter = null, params string[] tags) { return Ok(); }');
  assert.equal(s['OrdersController.<init>(IOrderService, ILogger)'], '(IOrderService service, ILogger<OrdersController> log)', 'a primary constructor is its parameter list');
  assert.equal(s['OrdersController.Local()'], 'public void Local() { int Inner() => 1; Func<int, int> f = x => { return x; }; }', 'local functions and lambdas are the body');
  assert.equal(s['IOrderService.GetAsync(int, CancellationToken)'], 'Task<Order?> GetAsync(int id, CancellationToken ct = default);');
  assert.equal(s['OrdersController.operator <=(Money, Money)'], 'public static bool operator <=(Money a, Money b) => true;', '`<=` is no assignment');
  const n = names(SECTION2);
  assert.equal(n['OrdersController.<init>(IOrderService, ILogger)'], 'OrdersController');
  assert.equal(n['OrdersController.this[int]'], 'this');
  assert.equal(n['OrdersController.operator +(Money, Money)'], 'operator');
  assert.equal(n['OrdersController.Find<1>(Guid?)'], 'Find');
  assert.equal(n['Extensions.Total(this Order)'], 'Total');
});

test('the outline is shaped as server symbols: types with their members as children', () => {
  const symbols = /** @type {any[]} */ (csharpOutline('namespace N;\npublic class A { public class B { void M() { } } int P => 1; }\n'));
  assert.deepEqual(symbols.map((s) => [s.name, s.kind]), [['A', 5]]);
  assert.deepEqual(symbols[0].children.map((/** @type {any} */ s) => [s.name, s.kind]), [['B', 5], ['P', 7]]);
  assert.deepEqual(symbols[0].children[0].children.map((/** @type {any} */ s) => [s.name, s.kind]), [['M()', 6]]);
});

test('partial declarations share one key space: a true repeat is #2 in source order', () => {
  const text = 'partial class A { void M() { } }\npartial class A { void M() { } void N() { } }\n';
  assert.deepEqual(keysOf(text), ['method A.M()', 'method A.M()#2', 'method A.N()']);
});

test('top-level statements are one member keyed by the file\'s basename, from the first statement to the end of the last', () => {
  const text = 'using System;\n\n// start\nvar app = Build(args);\nusing var scope = app.Scope();\nstatic int Build(string[] a) { return 1; }\napp.Run();\n\npublic partial class Program { }\n';
  const [top] = outlineOf(text, 'src/Api/Program.cs');
  assert.equal(top.key, 'Program.cs');
  assert.equal(text.slice(top.start, top.end), 'var app = Build(args);\nusing var scope = app.Scope();\nstatic int Build(string[] a) { return 1; }\napp.Run();');
  assert.equal(top.nameOffset, top.start);
  assert.equal(outlineOf(text).length, 1, 'the local function is part of the statements');
});

test('#if is read as Roslyn with no symbols: `#if X` inactive, `#else` and `#if !X` read', () => {
  const text = [
    'class A',
    '{',
    '#if DEBUG',
    '    void OnlyDebug() { }',
    '    string s = "unterminated',
    '#elif RELEASE',
    '    void OnlyRelease() { }',
    '#else',
    '    void Otherwise() { }',
    '#endif',
    '#if !NET8_0',
    '    void NotNet8() { }',
    '#endif',
    '#define LOCAL',
    '#if LOCAL && (true || X)',
    '    void Defined() { }',
    '#endif',
    '}',
  ].join('\n');
  assert.deepEqual(keysOf(text), ['method A.Otherwise()', 'method A.NotNet8()', 'method A.Defined()']);
});

test('a file the outline cannot read is null, never a partial or wrong outline', () => {
  // `#if`/`#else` that each open the class's brace: with the `#if` branch inactive one brace
  // is left open.
  assert.equal(csharpOutline('#if NET\nclass A {\n#else\nclass A { void M() { }\n#endif\n'), null);
  assert.equal(csharpOutline('#if X\nclass A { }\n'), null, 'an #if never closed');
  assert.equal(csharpOutline('#endif\nclass A { }\n'), null);
  assert.equal(csharpOutline('#if X +\n#endif\n'), null, 'an expression it cannot read');
  assert.equal(csharpOutline('class A { string s = "open\n }'), null);
  assert.equal(csharpOutline('class A { void M( { } }'), null);
  assert.equal(csharpOutline('class A { public void 1M() { } }'), null, 'a member the header parser cannot read');
  assert.deepEqual(csharpOutline(''), []);
});

test('activeText reads only texts with a conditional directive; the outline still refuses what it did', () => {
  const pragma = '#nullable enable\n#pragma warning disable CS1\n#region R\nclass A { void M() { } }\n#endregion\n';
  assert.equal(activeText(pragma), pragma);
  assert.deepEqual(keysOf(pragma), ['method A.M()']);
  assert.equal(csharpOutline('#nullable enable\nclass A { string s = "open\n }'), null, 'an unterminated literal behind #nullable');
  assert.equal(csharpOutline('# endif\nclass A { }\n'), null, 'a directive with white space after #');
  assert.equal(csharpOutline('#define X\n#else\nclass A { }\n'), null);
  assert.equal(activeText('#if X\nclass B { }\n#endif\nclass A { }\n'), '#if X\n           \n#endif\nclass A { }\n');
});

test('csharpOutlineParts: the outline with its active text and the tokens of it, directives left out', () => {
  const text = '#nullable enable\n#if X\nclass B { }\n#endif\nclass A { void M() { var s = $"{F(1)}"; } }\n';
  const parts = /** @type {NonNullable<ReturnType<typeof csharpOutlineParts>>} */ (csharpOutlineParts(text));
  assert.deepEqual(parts.symbols, csharpOutline(text));
  assert.equal(parts.active, activeText(text));
  /** @type {any[]} */
  const toks = [];
  lex(parts.active, 0, (t) => { if (t.kind !== 'directive') toks.push(t); });
  assert.deepEqual(parts.toks, toks);
  assert.equal(csharpOutlineParts('class A {'), null);
});

test('the provider: labels, constructors, exported, the header parser\'s sig and modifiers', () => {
  const text = 'namespace N;\npublic class A(int x)\n{\n    public A() : this(1) { }\n    internal Task<int> Run(int a) { throw new InvalidOperationException(); }\n    int I.M() => 1;\n}\n';
  const by = Object.fromEntries(collectCsharpSymbols(/** @type {any} */ (csharpOutline(text)), text).map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(by), ['A.<init>(int)', 'A.<init>()', 'A.Run(int)', 'A.I.M()']);
  assert.equal(by['A.<init>(int)'].label, 'new A(int)');
  assert.equal(by['A.<init>(int)'].isConstructor, true);
  assert.deepEqual(by['A.<init>(int)'].sig && by['A.<init>(int)'].sig.params.map((p) => p.name), ['x']);
  assert.equal(by['A.<init>()'].exported, true);
  assert.equal(by['A.Run(int)'].exported, false);
  assert.deepEqual(by['A.Run(int)'].modifiers, ['internal']);
  assert.equal(by['A.Run(int)'].sig && by['A.Run(int)'].sig.async, true, 'async from the awaitable return type');
  assert.deepEqual([...by['A.Run(int)'].throws], ['InvalidOperationException']);
  assert.equal(by['A.I.M()'].exported, true, 'an explicit implementation is callable through its interface');
});

test('J-D3 pairing: one overload out and one in keep the old key; indexers and generic arity too', () => {
  assert.equal(overloadNameOf('A<1>.M<2>(int, (string, int))'), 'A<1>.M');
  assert.equal(overloadNameOf('A.this[int]#2'), 'A.this');
  assert.equal(overloadNameOf('A.Name'), 'A.Name');
  const sym = (/** @type {string} */ key) => /** @type {any} */ ({ key });
  assert.deepEqual(pairCsharpOverloads([sym('A.M(int)'), sym('A.this[int]')], [sym('A.M(long)'), sym('A.this[string]')]).map((s) => s.key), ['A.M(int)', 'A.this[int]']);
  assert.deepEqual(pairCsharpOverloads([sym('A.M(int)'), sym('A.M(string)')], [sym('A.M(long)'), sym('A.M(bool)')]).map((s) => s.key), ['A.M(long)', 'A.M(bool)'], 'two out, two in: not paired');
});

test('without language services, prepare is the outline path with callers from the syntax index (C8a)', async () => {
  assert.equal(csharpProvider.needsServer, true, 'C5: the editor asks Roslyn');
  assert.equal(csharpProvider.serverLabel, 'the C# language server (Roslyn)');
  const base = 'namespace N;\npublic class A\n{\n    public int Run(int a) { return 1; }\n    public void Gone() { }\n}\n';
  const head = 'namespace N;\npublic class A\n{\n    public int Run(int a, string b) { return 2; }\n}\n';
  /** @type {string[]} */
  const warnings = [];
  const unit = { component: 'pull request', projectRoot: '' };
  const answer = await csharpProvider.prepare(/** @type {any} */ ({
    repo: '/nowhere', files: [{ path: 'src/A.cs', status: 'modified' }, { path: 'src/B.cs', status: 'modified' }],
    baseTexts: new Map([['src/A.cs', base], ['src/B.cs', 'class B {\n#if X\n#else\n{\n#endif\n}\n']]),
    headTexts: new Map([['src/A.cs', head], ['src/B.cs', 'class B {\n#if X\n#else\n{\n#endif\n}\n']]),
    changedRanges: { 'src/A.cs': [[4, 4]], 'src/B.cs': [[1, 1]] }, deletions: { 'src/A.cs': [5] },
    warnings, unanalysable: new Map(), notAnalysedFiles: new Map(), report: () => {}, hooks: {}, unit,
    syntacticSources: [{ path: 'src/A.cs', text: head }, { path: 'src/C.cs', text: 'namespace N;\nclass C { void M(A a) { a.Run(1, "x"); } }\n' }],
  }));
  assert.equal(answer.units.length, 1);
  const [u] = answer.units;
  const changed = /** @type {any[]} */ (u.changed);
  assert.deepEqual(changed.map((c) => [c.key, c.kinds.map((/** @type {any} */ k) => k.id)]), [['A.Run(int)', ['required-param']]]);
  assert.deepEqual(/** @type {any[]} */ (u.deleted).map((d) => d.key), ['A.Gone()']);
  const state = await u.resolver.callerState(changed[0].file, changed[0].namePos);
  assert.equal(state.state, 'resolved');
  assert.deepEqual(state.callers.map((/** @type {any} */ c) => c.label), ['C.M(A)']);
  assert.equal(state.complete, false, 'the preview: never complete');
  assert.equal(/** @type {any} */ (u.resolver).callersLowerBound, true);
  assert.ok(warnings.some((w) => /src\/B\.cs: NOT analysed/.test(w)), 'unbalanced #if braces: the file is not analysed');
});

test('a preview reads C# from the fetched text: a [CHANGED]-able member, callers from the PR files (incomplete), C# named in callersScope and the limits note, never "not analysed" (C6)', async () => {
  clearVirtualText();
  const base = 'namespace N;\npublic class Codec\n{\n    public int Run(int a)\n    {\n        return 1;\n    }\n}\n';
  const head = 'namespace N;\npublic class Codec\n{\n    public int Run(int a)\n    {\n        return 2;\n    }\n}\n';
  const patch = '@@ -3,6 +3,6 @@\n {\n     public int Run(int a)\n     {\n-        return 1;\n+        return 2;\n     }\n }\n';
  const files = { 'src/Codec.cs@base': base, 'src/Codec.cs@head': head };
  const gh = {
    listPullRequestFiles: async () => ({ total: 1, files: [{ path: 'src/Codec.cs', oldPath: 'src/Codec.cs', status: 'modified', patch }] }),
    fileAtRef: async (/** @type {any} */ _, /** @type {string} */ p, /** @type {string} */ ref) => /** @type {Record<string, string>} */ (files)[`${p}@${ref}`] ?? null,
  };
  const r = await analyzeRemote(/** @type {any} */ ({ ts, gh, slug: {}, pr: { number: 9, headSha: 'head', mergeBaseSha: 'base', baseRef: 'main' }, repoRoot: root }));
  assert.deepEqual(r.allChanged.map((/** @type {any} */ c) => c.key), ['Codec.Run(int)']);
  assert.equal(r.allChanged[0].callersComplete, false);
  assert.equal(r.otherFiles.some((/** @type {any} */ f) => f.notAnalysed), false, 'no C# file is "not analysed"');
  assert.deepEqual(r.callersScope.map((/** @type {any} */ s) => [s.language, s.scope]), [['C#', 'pr-files']]);
  assert.match(models.previewLimitsNote(r), /C# callers are from syntax only, in the PR's own files: calls through an interface or an override beyond the indexed files/);
  clearVirtualText();
});
