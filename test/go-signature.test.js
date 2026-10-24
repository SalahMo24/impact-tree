// @ts-check
'use strict';
// Go signatures (G3, docs/MULTI_LANGUAGE_PLAN.md): a declaration's header parsed into the
// `sig` the shared diffSignature compares. Headers marked (cli/cli) are copied verbatim from
// github.com/cli/cli (MIT); the bodies are abbreviated.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGoDeclaration, renderGoSig } = require('../src/languages/go/signature');
const { diffSignature, KIND } = require('../src/engine/signature');

/** @param {string} text */
function parse(text) {
  const parsed = parseGoDeclaration(text);
  assert.ok(parsed, `expected to parse: ${text}`);
  return parsed;
}
/** @param {string} text @returns {string[]} `name:type` of every param */
const pairs = (text) => parse(text).sig.params.map((p) => `${p.name}:${p.type}`);
/** @param {string} baseText @param {string} headText @returns {string[]} the kinds' ids */
const kinds = (baseText, headText) =>
  diffSignature({ sig: parse(baseText).sig }, { sig: parse(headText).sig }).map((k) => k.id);

test('a plain function: params, returns, headerEnd just before the body brace', () => {
  const text = 'func add(a int, b int) int { return a + b }';
  const { sig, headerEnd } = parse(text);
  assert.deepEqual(sig, {
    async: false,
    params: [
      { name: 'a', type: 'int', optional: false, rest: false },
      { name: 'b', type: 'int', optional: false, rest: false },
    ],
    returns: 'int',
  });
  assert.equal(text[headerEnd], '{');
  assert.equal(text.slice(0, headerEnd), 'func add(a int, b int) int ');
});

test('receiver first, its variable name ignored; T and *T differ; generic receivers keep brackets', () => {
  assert.deepEqual(pairs('func (r *T) Name() {}'), ['(receiver):*T']);
  assert.deepEqual(pairs('func (x *T) Name() {}'), ['(receiver):*T']);
  assert.deepEqual(pairs('func (T) Name() {}'), ['(receiver):T']);
  assert.deepEqual(pairs('func (_ T) Name() {}'), ['(receiver):T']);
  assert.deepEqual(pairs('func (l *List[T]) Add(v T) {}'), ['(receiver):*List[T]', 'v:T']);
  assert.deepEqual(pairs('func (List[T]) Len() int {}'), ['(receiver):List[T]']);
  assert.deepEqual(pairs('func (p Pair[K, V]) Key() K {}'), ['(receiver):Pair[K, V]']);
});

test('type parameters follow the receiver; grouped [K, V any] is expanded', () => {
  assert.deepEqual(pairs('func Map[T any, K comparable](xs []T) []K {}'), ['[T]:any', '[K]:comparable', 'xs:[]T']);
  assert.deepEqual(pairs('func Keys[K, V any](m map[K]V) []K {}'), ['[K]:any', '[V]:any', 'm:map[K]V']);
  assert.deepEqual(pairs('func Sum[T interface{ ~int | ~float64 }](xs ...T) T {}'),
    ['[T]:interface{ ~int | ~float64 }', 'xs:...T']);
  assert.deepEqual(pairs('func Clone[S ~[]E, E any](s S) S {}'), ['[S]:~[]E', '[E]:any', 's:S']);
});

test('grouped parameter names are expanded', () => {
  assert.deepEqual(pairs('func f(a, b int, c string) {}'), ['a:int', 'b:int', 'c:string']);
});

test('unnamed parameters are named by position; _ parameters stay distinct', () => {
  assert.deepEqual(pairs('func f(int, string) {}'), ['#1:int', '#2:string']);
  assert.deepEqual(pairs('func f(context.Context, *T) {}'), ['#1:context.Context', '#2:*T']);
  assert.deepEqual(pairs('func f(List[int], []string) {}'), ['#1:List[int]', '#2:[]string']);
  assert.deepEqual(pairs('func f(_ string, _ int, c bool) {}'), ['_#1:string', '_#2:int', 'c:bool']);
  assert.deepEqual(pairs('func f(_, _ string) {}'), ['_#1:string', '_#2:string']);
  assert.deepEqual(pairs('func f(...int) {}'), ['#1:...int']);
});

test('variadic: the ... stays in the type and rest is set', () => {
  const { sig } = parse('func f(a, b int, opts ...Opt) (T, error) {}');
  assert.deepEqual(sig.params[2], { name: 'opts', type: '...Opt', optional: false, rest: true });
  assert.equal(sig.params[0].rest, false);
  assert.equal(sig.returns, '(T, error)');
});

test('results: names dropped, a single bare result as written, none is null', () => {
  assert.equal(parse('func f() {}').sig.returns, null);
  assert.equal(parse('func f() error {}').sig.returns, 'error');
  assert.equal(parse('func f() (error) {}').sig.returns, 'error');
  assert.equal(parse('func f() (n int) {}').sig.returns, 'int');
  assert.equal(parse('func f() (n int, err error) {}').sig.returns, '(int, error)');
  assert.equal(parse('func f() (a, b int, err error) {}').sig.returns, '(int, int, error)');
  assert.equal(parse('func f() (*T, error) {}').sig.returns, '(*T, error)');
  assert.equal(parse('func f() ( int ,\n\t error ) {}').sig.returns, '(int, error)');
  assert.equal(parse('func f() []*gh.Credential {}').sig.returns, '[]*gh.Credential');
});

test('types keep their shape: qualified names, maps, channels, func, interface, struct', () => {
  assert.deepEqual(pairs('func f(c gh.Credential, m map[string][]*T, ch chan<- int, r <-chan error) {}'),
    ['c:gh.Credential', 'm:map[string][]*T', 'ch:chan<- int', 'r:<-chan error']);
  assert.deepEqual(pairs('func f(cb func(int) error, g func(a, b string) (int, error)) {}'),
    ['cb:func(int) error', 'g:func(a, b string) (int, error)']);
  assert.deepEqual(pairs('func f(x interface{ M() }, y interface{}, z any) {}'),
    ['x:interface{ M() }', 'y:interface{}', 'z:any']);
  assert.deepEqual(pairs('func f(arr [3]int, grid [N][M]byte) {}'), ['arr:[3]int', 'grid:[N][M]byte']);
});

test('whitespace is collapsed and the space just inside brackets and parens removed', () => {
  assert.deepEqual(pairs('func f(  a   int ,\n\tb  func( x  int )  error ,\n\tc  []  string,\n) {}'),
    ['a:int', 'b:func(x int) error', 'c:[] string']);
  assert.deepEqual(pairs('func f(m map[ string ] int) {}'), ['m:map[string] int']);
});

test('comments anywhere in the header are ignored', () => {
  const text = 'func /* c */ (r /* recv */ *T) // trailing\n Name( // first\n a int, /* b */ b string,\n) /* results */ (int, /* e */ error) { return }';
  assert.deepEqual(pairs(text), ['(receiver):*T', 'a:int', 'b:string']);
  assert.equal(parse(text).sig.returns, '(int, error)');
  assert.equal(parse('func f() {}').sig.returns, null);
});

test('string and raw-string literals (struct tags) in the header are not scanned for brackets', () => {
  const tagged = 'func f(v struct{ a int `json:"a}"`; b string `x:"{("` }) struct{ c int `json:"c{"` } { return }';
  const { sig, headerEnd } = parse(tagged);
  assert.equal(sig.params[0].type, 'struct{ a int `json:"a}"`; b string `x:"{("` }');
  assert.equal(sig.returns, 'struct{ c int `json:"c{"` }');
  assert.equal(tagged.slice(headerEnd), '{ return }');
});

test('the body brace is the first { at depth 0 that is not a struct/interface literal', () => {
  const a = 'func f() struct{a int} { return struct{a int}{} }';
  assert.equal(a.slice(parse(a).headerEnd), '{ return struct{a int}{} }');
  assert.equal(parse(a).sig.returns, 'struct{a int}');
  const b = 'func f() interface{} {\n\treturn nil\n}';
  assert.equal(b.slice(parse(b).headerEnd), '{\n\treturn nil\n}');
  const c = 'func f(x func() struct{}) []struct{ A int } {}';
  assert.equal(parse(c).sig.returns, '[]struct{ A int }');
  assert.deepEqual(pairs(c), ['x:func() struct{}']);
});

test('a declaration with no body ends its header at the end of the text', () => {
  const text = 'func archSum(p []byte) uint32';
  const parsed = parse(text);
  assert.equal(parsed.headerEnd, text.length);
  assert.equal(parsed.sig.returns, 'uint32');
  assert.equal(parse('func f()\n// trailing note').headerEnd, 'func f()\n// trailing note'.length);
});

test('unicode identifiers; headerEnd counts UTF-16 units', () => {
  const text = 'func (ü *Typ) Größe(名前 string) int { return 1 }';
  const { sig, headerEnd } = parse(text);
  assert.deepEqual(sig.params.map((p) => p.name), ['(receiver)', '名前']);
  assert.equal(text[headerEnd], '{');
  const astral = 'func f(a string /* 😀 */) int {}';
  assert.equal(astral[parse(astral).headerEnd], '{');
});

test('text it cannot parse is null, never a throw', () => {
  for (const bad of ['', 'x := 1', 'type T struct{}', 'func', 'func (', 'func f(', 'func f(a int', 'func f(a, b) int)',
    'func f() /* unterminated', 'func f(s "unterminated) {}', 'func f(a int) (int, {}', 'func (a, b T) m() {}',
    'func () {}', 'func f(a int, , b int) {}', 'func f(a, int string, c) {}']) {
    assert.equal(parseGoDeclaration(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseGoDeclaration(/** @type {any} */ (undefined)), null);
});

test('cli/cli headers, verbatim', () => {
  const cases = [
    // [header, params, returns]
    ['func (r Remotes) FindByName(names ...string) (*Remote, error) {', ['(receiver):Remotes', 'names:...string'], '(*Remote, error)'],
    ['func IndexesFor(options []string, answers ...string) ([]int, error) {', ['options:[]string', 'answers:...string'], '([]int, error)'],
    ['func (b *browser) Browse(_ string) error {', ['(receiver):*browser', '_#1:string'], 'error'],
    ['func (e *em) Dispatch(_ []string, _ io.Reader, _, _ io.Writer) (bool, error) {',
      ['(receiver):*em', '_#1:[]string', '_#2:io.Reader', '_#3:io.Writer', '_#4:io.Writer'], '(bool, error)'],
    ['func (m *MockPrompter) RegisterMarkdownEditor(prompt string, stub func(string, string, bool) (string, error)) {',
      ['(receiver):*MockPrompter', 'prompt:string', 'stub:func(string, string, bool) (string, error)'], null],
    ['func readRecords[T any](path string) ([]T, error) {', ['[T]:any', 'path:string'], '([]T, error)'],
    ['func (o Option[T]) UnwrapOr(value T) T {', ['(receiver):Option[T]', 'value:T'], 'T'],
    ['func (rs *relayServer) Err() <-chan error {', ['(receiver):*relayServer'], '<-chan error'],
    ['func handleChannels(ctx context.Context, server *relayServer, chans <-chan ssh.NewChannel) error {',
      ['ctx:context.Context', 'server:*relayServer', 'chans:<-chan ssh.NewChannel'], 'error'],
    ['func TranslateRemotes(gitRemotes git.RemoteSet, translator Translator) (remotes Remotes) {',
      ['gitRemotes:git.RemoteSet', 'translator:Translator'], 'Remotes'],
    ['func Lock(ctx context.Context, path string) (f *os.File, unlock func(), err error) {',
      ['ctx:context.Context', 'path:string'], '(*os.File, func(), error)'],
    ['func NewTelemetryAPIServer(svc TelemetryAPI, opts ...interface{}) TwirpServer {',
      ['svc:TelemetryAPI', 'opts:...interface{}'], 'TwirpServer'],
    ['func (*NotifyCodespaceOfClientActivityRequest) ProtoMessage() {}', ['(receiver):*NotifyCodespaceOfClientActivityRequest'], null],
    ['func (mock *PrompterMock) ConfirmCalls() []struct {\n\tPrompt       string\n\tDefaultValue bool\n} {\n\tvar calls []struct {\n\t\tPrompt       string\n\t\tDefaultValue bool\n\t}\n\treturn calls\n}',
      ['(receiver):*PrompterMock'], '[]struct { Prompt string DefaultValue bool }'],
    ['func newMultiSelectSearchField(\n\ttitle, searchTitle string,\n\tdefaults, persistent []string,\n\tsearchFunc func(string) MultiSelectSearchResult,\n) *multiSelectSearchField {\n\tti := textinput.New()\n}',
      ['title:string', 'searchTitle:string', 'defaults:[]string', 'persistent:[]string', 'searchFunc:func(string) MultiSelectSearchResult'],
      '*multiSelectSearchField'],
    ['func paginateAttributes[N projectAttribute](c *Client, p pager[N], variables map[string]any, queryName string, firstKey string, afterKey string, limit int, nodes []N) ([]N, error) {',
      ['[N]:projectAttribute', 'c:*Client', 'p:pager[N]', 'variables:map[string]any', 'queryName:string', 'firstKey:string', 'afterKey:string', 'limit:int', 'nodes:[]N'], '([]N, error)'],
  ];
  for (const [header, params, returns] of cases) {
    const text = String(header);
    const { sig, headerEnd } = parse(text);
    assert.deepEqual(sig.params.map((p) => `${p.name}:${p.type}`), params, text);
    assert.equal(sig.returns, returns, text);
    assert.equal(text[headerEnd], '{', text);
  }
});

test('renaming a receiver variable or a result name is no change', () => {
  const a = parse('func (r *T) Do(x int) (n int, err error) { return }').sig;
  const b = parse('func (self *T) Do(x int) (count int, e error) { return }').sig;
  const c = parse('func (*T) Do(x int) (int, error) { return }').sig;
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(diffSignature({ sig: a }, { sig: b }), []);
});

test('diffSignature on parsed Go signatures', () => {
  const base = 'func (r *T) Run(a int, b string) (int, error) { return }';
  assert.deepEqual(kinds(base, 'func (r *T) Run(a int) (int, error) { return }'), [KIND.PARAM_REMOVED.id]);
  assert.deepEqual(kinds(base, 'func (r *T) Run(a int64, b string) (int, error) { return }'), [KIND.TYPE_CHANGED.id]);
  assert.deepEqual(kinds(base, 'func (r T) Run(a int, b string) (int, error) { return }'), [KIND.TYPE_CHANGED.id]);
  assert.deepEqual(kinds(base, 'func (r *T) Run(a int, b string, opts ...Opt) (int, error) { return }'), [KIND.OPTIONAL_PARAM.id]);
  assert.deepEqual(kinds(base, 'func (r *T) Run(a int, b string) error { return }'), [KIND.RETURN_CHANGED.id]);
  assert.deepEqual(kinds(base, 'func (r *T) Run(a int, b string, c bool) (int, error) { return }'), [KIND.REQUIRED_PARAM.id]);
  assert.deepEqual(kinds(base, 'func (r *T) Run(a int, b string) (int, error) { return 1 }'), []);
  assert.deepEqual(kinds('func F[T any](x T) {}', 'func F[T comparable](x T) {}'), [KIND.TYPE_CHANGED.id]);
});

test('renderGoSig is readable and stable', () => {
  const r = (/** @type {string} */ t) => renderGoSig(parse(t).sig);
  assert.equal(r('func (r *T) Do(a, b int, opts ...Opt) (n int, err error) {}'), '(receiver *T) (a int, b int, opts ...Opt) (int, error)');
  assert.equal(r('func Map[T any, K comparable](xs []T) []K {}'), '[T any, K comparable] (xs []T) []K');
  assert.equal(r('func f(int, string) {}'), '(int, string)');
  assert.equal(r('func f(_ int, _ bool) error {}'), '(_ int, _ bool) error');
  assert.equal(r('func f() {}'), '()');
});
