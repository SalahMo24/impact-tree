// @ts-check
'use strict';
// Python signatures (P3, docs/MULTI_LANGUAGE_PLAN.md): a declaration's header parsed into the
// `sig` the shared diffSignature compares, the exceptions a body raises, and the change kinds.
// Headers marked (httpx) are copied verbatim from httpx (BSD-3-Clause); bodies are abbreviated.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePythonDeclaration, pythonHeaderText, raisesOf, pythonKindsOf, renderPythonSig, normalizeAnnotation, MAX_HEADER_CHARS,
} = require('../src/languages/python/signature');
const { diffSignature, KIND } = require('../src/engine/signature');

/** @param {string} text @param {boolean} [isMethod] */
function parse(text, isMethod = false) {
  const parsed = parsePythonDeclaration(text, { isMethod });
  assert.ok(parsed, `expected to parse: ${text}`);
  return parsed;
}
/** @param {string} text @param {boolean} [isMethod] @returns {string[]} `name:type` of every param */
const pairs = (text, isMethod = false) => parse(text, isMethod).sig.params.map((p) => `${p.name}:${p.type}`);
/** @param {string} baseText @param {string} headText @param {boolean} [isMethod] @returns {string[]} kind ids */
function kinds(baseText, headText, isMethod = false) {
  const side = (/** @type {string} */ t) => {
    const p = parse(t, isMethod);
    return { sig: p.sig, header: pythonHeaderText(t), binding: p.binding };
  };
  return pythonKindsOf(side(baseText), side(headText)).map((k) => /** @type {any} */ (k).id);
}

test('a plain function: params, defaults, returns, headerEnd just past the colon', () => {
  const text = 'def add(a: int, b=2) -> int:\n    return a + b\n';
  const { sig, headerEnd, decorators, binding } = parse(text);
  assert.deepEqual(sig, {
    async: false,
    params: [
      { name: 'a', type: 'int', optional: false, rest: false },
      { name: 'b', type: null, optional: true, rest: false },
    ],
    returns: 'int',
  });
  assert.equal(text.slice(0, headerEnd), 'def add(a: int, b=2) -> int:');
  assert.deepEqual(decorators, []);
  assert.equal(binding, 'function');
});

test('async def', () => {
  assert.equal(parse('async def f(x):\n    pass').sig.async, true);
  assert.equal(parse('def f(x):\n    pass').sig.async, false);
  assert.deepEqual(kinds('def f(x):\n pass', 'async def f(x):\n pass'), ['async-changed']);
});

test('a method loses its first parameter whatever it is called; renaming it is no change', () => {
  assert.deepEqual(pairs('def f(self, a):\n pass', true), ['a:null']);
  assert.deepEqual(pairs('def f(this, a):\n pass', true), ['a:null']);
  assert.deepEqual(kinds('def f(self, a):\n pass', 'def f(me, a):\n pass', true), []);
  assert.deepEqual(pairs('@classmethod\ndef f(cls, a):\n pass', true), ['a:null']);
  assert.deepEqual(pairs('def f(self):\n pass', true), []);
  // A function (not a method) keeps its first parameter.
  assert.deepEqual(pairs('def f(self, a):\n pass', false), ['self:null', 'a:null']);
  // A *args first parameter of a method is not a self.
  assert.deepEqual(pairs('def f(*args):\n pass', true), ['args:*']);
});

test('a staticmethod keeps its first parameter', () => {
  const { binding, sig } = parse('@staticmethod\ndef f(a, b):\n pass', true);
  assert.equal(binding, 'staticmethod');
  assert.deepEqual(sig.params.map((p) => p.name), ['a', 'b']);
});

test('(httpx) a method with keyword-only parameters, defaults and a return annotation', () => {
  const text = `    def build_request(
        self,
        method: str,
        url: URL | str,
        *,
        content: RequestContent | None = None,
        data: RequestData | None = None,
        timeout: TimeoutTypes | UseClientDefault = USE_CLIENT_DEFAULT,
        extensions: RequestExtensions | None = None,
    ) -> Request:
        """
        Build and return a request instance.
        """
        pass
`;
  const { sig, headerEnd } = parse(text.trimStart(), true);
  assert.deepEqual(sig.params.map((p) => `${p.name}:${p.type}:${p.optional}`), [
    'method:str:false',
    'url:URL | str:false',
    'content:keyword-only RequestContent | None:true',
    'data:keyword-only RequestData | None:true',
    'timeout:keyword-only TimeoutTypes | UseClientDefault:true',
    'extensions:keyword-only RequestExtensions | None:true',
  ]);
  assert.equal(sig.returns, 'Request');
  assert.ok(text.trimStart().slice(0, headerEnd).endsWith('-> Request:'));
});

test('(httpx) a property, an async method and a __init__ with a return of None', () => {
  const prop = `@property
    def raw(self) -> list[tuple[bytes, bytes]]:
        """
        Returns a list of the raw header items, as byte pairs.
        """
        return [(raw_key, value) for raw_key, _, value in self._list]
`;
  const p = parse(prop, true);
  assert.equal(p.binding, 'property');
  assert.deepEqual(p.sig.params, []);
  assert.equal(p.sig.returns, 'list[tuple[bytes,bytes]]');
  assert.deepEqual(pairs(`def __init__(
        self,
        headers: HeaderTypes | None = None,
        encoding: str | None = None,
    ) -> None:
        pass`, true), ['headers:HeaderTypes | None', 'encoding:str | None']);
  assert.equal(parse('async def _send_single_request(self, request: Request) -> Response:\n    pass', true).sig.async, true);
});

test('defaults with colons, commas, brackets, lambdas and string text do not end or split the header', () => {
  assert.deepEqual(pairs('def f(x: dict[str, int] = {"a": 1}, y=2):\n pass'), ['x:dict[str,int]', 'y:null']);
  assert.deepEqual(pairs('def f(f=lambda a, b: a, g=1):\n pass'), ['f:null', 'g:null']);
  assert.deepEqual(pairs('def f(s="):", t=\'(\', u=(1, 2)):\n pass'), ['s:null', 't:null', 'u:null']);
  assert.deepEqual(pairs('def f(a=lambda: 0, b=lambda x=1, *y: x):\n pass'), ['a:null', 'b:null']);
  assert.deepEqual(pairs('def f(a: "Callable[[int], str]" = None):\n pass'), ['a:"Callable[[int], str]"']);
  const text = 'def f(s="):"):\n    return s';
  assert.equal(text.slice(0, parse(text).headerEnd), 'def f(s="):"):');
  assert.deepEqual(pairs('def f(a=""" ) : """):\n pass'), ['a:null']);
  assert.equal(parse('def f(a=1) -> Callable[[int], str]:\n pass').sig.returns, 'Callable[[int],str]');
});

test('*args and **kwargs are rest; their markers are in the type', () => {
  const { sig } = parse('def f(a, *args: int, b, c=1, **kwargs: str):\n pass');
  assert.deepEqual(sig.params, [
    { name: 'a', type: null, optional: false, rest: false },
    { name: 'args', type: '* int', optional: false, rest: true },
    { name: 'b', type: 'keyword-only', optional: false, rest: false },
    { name: 'c', type: 'keyword-only', optional: true, rest: false },
    { name: 'kwargs', type: '** str', optional: false, rest: true },
  ]);
  assert.deepEqual(pairs('def f(*args, **kw):\n pass'), ['args:*', 'kw:**']);
});

test('a bare * and a bare / are not parameters but mark the ones around them', () => {
  assert.deepEqual(pairs('def f(a, /, b, *, c, d: int = 1):\n pass'),
    ['a:positional-only', 'b:null', 'c:keyword-only', 'd:keyword-only int']);
  assert.deepEqual(pairs('def f(a, b, /):\n pass'), ['a:positional-only', 'b:positional-only']);
});

test('moving a parameter across * or / is a type change', () => {
  assert.deepEqual(kinds('def f(a, b):\n pass', 'def f(a, *, b):\n pass'), ['type-changed']);
  assert.deepEqual(kinds('def f(a, b):\n pass', 'def f(a, /, b):\n pass'), ['type-changed']);
  assert.deepEqual(kinds('def f(a, /, b):\n pass', 'def f(a, b, /):\n pass'), ['type-changed']);
  assert.deepEqual(kinds('def f(a, *, b):\n pass', 'def f(a, *args, b):\n pass'), ['optional-param']);
});

test('reformatting an annotation, across lines or in spacing, is no change', () => {
  assert.deepEqual(kinds(
    'def f(x: Dict[str, int], y: "A  B"):\n pass',
    'def f(\n    x: Dict[\n        str,\n        int,\n    ],\n    y: "A  B",\n):\n pass',
  ), []);
  assert.deepEqual(kinds('def f(x: int|None)->  str:\n pass', 'def f(x: int|None) -> str:\n pass'), []);
  assert.deepEqual(kinds('def f(x=1):\n pass', 'def f(x = 2):\n pass'), []);
});

test('a multi-line header with comments, a trailing comma and a string containing a colon', () => {
  const text = `def f(
    a: int,  # the count: how many
    b: str = "x:y",  # default
    # a whole-line comment with ) and :
    *,
    c,
) -> None:  # done
    pass
`;
  assert.deepEqual(pairs(text), ['a:int', 'b:str', 'c:keyword-only']);
  assert.equal(pythonHeaderText(text), 'def f(a: int,b: str = "x:y",*,c) -> None');
});

test('a type, return, optional, removal and addition each give their kind', () => {
  assert.deepEqual(kinds('def f(a: int):\n pass', 'def f(a: str):\n pass'), ['type-changed']);
  assert.deepEqual(kinds('def f(a) -> int:\n pass', 'def f(a) -> str:\n pass'), ['return-changed']);
  assert.deepEqual(kinds('def f(a):\n pass', 'def f(a) -> int:\n pass'), ['return-changed']);
  assert.deepEqual(kinds('def f(a):\n pass', 'def f(a, b=1):\n pass'), ['optional-param']);
  assert.deepEqual(kinds('def f(a):\n pass', 'def f(a, b):\n pass'), ['required-param']);
  assert.deepEqual(kinds('def f(a, b):\n pass', 'def f(a):\n pass'), ['param-removed']);
  assert.deepEqual(kinds('def f(a, b):\n pass', 'def f(a, b=1):\n pass'), ['optional-param-changed']);
  assert.deepEqual(kinds('def f(a):\n pass', 'def f(a):\n return 1'), []);
});

test('typing-equivalent annotation spellings are no change (pydantic PR 13070)', () => {
  const same = (/** @type {string} */ a, /** @type {string} */ b) => assert.deepEqual(kinds(a, b, a.includes('(self')), [], `${a} vs ${b}`);
  // (pydantic) Color.as_rgb_tuple and parse_color_value, base and head of PR 13070.
  same('def as_rgb_tuple(self, *, alpha: Optional[bool] = None) -> ColorTuple:\n pass',
    'def as_rgb_tuple(self, *, alpha: bool | None = None) -> ColorTuple:\n pass');
  same('def parse_color_value(value: Union[int, str], max_val: int = 255) -> float:\n pass',
    'def parse_color_value(value: int | str, max_val: int = 255) -> float:\n pass');
  same('def f(a: Union[A, B]):\n pass', 'def f(a: B | A):\n pass');
  same('def f(a: Optional[Union[A, B]]):\n pass', 'def f(a: None | B | A):\n pass');
  same('def f(a: Union[A, None, A]):\n pass', 'def f(a: A | None):\n pass');
  same('def f(a: List[Dict[str, Tuple[int, ...]]]) -> Set[Type[X]]:\n pass',
    'def f(a: list[dict[str, tuple[int, ...]]]) -> set[type[X]]:\n pass');
  same('def f(a: typing.Optional[typing.FrozenSet[int]]):\n pass', 'def f(a: frozenset[int] | None):\n pass');
  same('def f(a: typing.Callable[[int, str], None]):\n pass', 'def f(a: collections.abc.Callable[[int, str], None]):\n pass');
  same('def f(*args: Optional[int], **kw: Union[int, str]):\n pass', 'def f(*args: int | None, **kw: str | int):\n pass');
  same('def f(a: Literal["x", "y"] | None):\n pass', 'def f(a: Optional[Literal["x", "y"]]):\n pass');
  // (pydantic) Field and _Pipeline.validate_as: typeshed's `ellipsis` is types.EllipsisType.
  same('def Field(default: ellipsis, *, alias: str | None = _Unset) -> Any:\n pass',
    'def Field(default: EllipsisType, *, alias: str | None = _Unset) -> Any:\n pass');
  same('def f(a: ellipsis):\n pass', 'def f(a: types.EllipsisType):\n pass');
});

test('annotation normalisation keeps real type changes and leaves unreadable text as written', () => {
  const changed = (/** @type {string} */ a, /** @type {string} */ b, /** @type {string[]} */ ids) =>
    assert.deepEqual(kinds(a, b), ids, `${a} vs ${b}`);
  changed('def f(a: Optional[int]):\n pass', 'def f(a: int):\n pass', ['type-changed']);
  changed('def f(a: Union[int, str]):\n pass', 'def f(a: int | bytes):\n pass', ['type-changed']);
  changed('def f(a: List[int]):\n pass', 'def f(a: list[str]):\n pass', ['type-changed']);
  changed('def f(a: Tuple[int, str]):\n pass', 'def f(a: tuple[str, int]):\n pass', ['type-changed']);
  changed('def f(a: Literal["x", "y"]):\n pass', 'def f(a: Literal["y", "x"]):\n pass', ['type-changed']);
  changed('def f() -> Optional[int]:\n pass', 'def f() -> int:\n pass', ['return-changed']);
  changed('def f(*, a: Optional[int]):\n pass', 'def f(a: int | None):\n pass', ['type-changed']);
  assert.equal(normalizeAnnotation('Optional[Union[B, A]]'), 'A | B | None');
  assert.equal(normalizeAnnotation('"Foo" | None'), '"Foo" | None');
  for (const raw of ['Tuple[()]', 'f(x)', 'A[', 'A |', 'A[B,,]', '']) assert.equal(normalizeAnnotation(raw), raw);
});

test('decorators may span lines and hold calls and strings; they are normalised', () => {
  const text = `@app.route(
        "/items/<id>:x",   # path
        methods=["GET", "POST"],
    )
@ cache
async def get(id):
    pass`;
  const p = parse(text);
  assert.deepEqual(p.decorators, ['app.route("/items/<id>:x",methods=["GET","POST"])', 'cache']);
  assert.equal(p.binding, 'function');
  assert.equal(p.sig.async, true);
  assert.equal(text.slice(0, p.headerEnd).endsWith('async def get(id):'), true);
});

test('bindings: property family, staticmethod, classmethod; abstract variants are not bindings', () => {
  const b = (/** @type {string} */ dec) => parse(`${dec}\ndef f(self):\n pass`, true).binding;
  assert.equal(b('@property'), 'property');
  assert.equal(b('@x.setter'), 'property');
  assert.equal(b('@x.getter'), 'property');
  assert.equal(b('@x.deleter'), 'property');
  assert.equal(b('@functools.cached_property'), 'property');
  assert.equal(b('@cached_property'), 'property');
  assert.equal(b('@staticmethod'), 'staticmethod');
  assert.equal(b('@classmethod'), 'classmethod');
  assert.equal(b('@abc.abstractmethod'), 'function');
  assert.equal(b('@abc.abstractproperty'), 'function');
  assert.equal(b('@property()'), 'function');
  assert.equal(b('@other'), 'function');
});

test('property to method, and method to staticmethod, is a type change; other decorators are not', () => {
  assert.deepEqual(kinds('@property\ndef f(self):\n pass', 'def f(self):\n pass', true), ['type-changed']);
  assert.deepEqual(kinds('def f(self):\n pass', '@classmethod\ndef f(cls):\n pass', true), ['type-changed']);
  assert.deepEqual(kinds('def f(self, a):\n pass', '@staticmethod\ndef f(a):\n pass', true), ['type-changed']);
  assert.deepEqual(kinds('def f(a):\n pass', '@lru_cache(maxsize=None)\ndef f(a):\n pass'), []);
  // binding and signature both changing give the type kind once
  assert.deepEqual(kinds('@property\ndef f(self) -> int:\n pass', 'def f(self, a: int) -> str:\n pass', true).sort(),
    ['required-param', 'return-changed', 'type-changed']);
});

test('pythonKindsOf: no base gives no kinds; an unreadable side compares normalised headers', () => {
  assert.deepEqual(pythonKindsOf(null, { sig: null, header: 'def f()', binding: 'function' }), []);
  const mk = (/** @type {string} */ header) => ({ sig: null, header, binding: 'function' });
  assert.deepEqual(pythonKindsOf(mk('def f(a)'), mk('def f(a)')), []);
  assert.deepEqual(pythonKindsOf(mk('def f(a)'), mk('def f(b)')), [KIND.TYPE_CHANGED]);
  const readable = { sig: parse('def f(a):\n pass').sig, header: 'def f(a)', binding: 'function' };
  assert.deepEqual(pythonKindsOf(readable, mk('def f(a, b)')), [KIND.TYPE_CHANGED]);
  // a binding change with an unreadable side
  assert.deepEqual(pythonKindsOf({ ...mk('h'), binding: 'property' }, mk('h')), [KIND.TYPE_CHANGED]);
  assert.deepEqual(diffSignature({ sig: readable.sig }, { sig: readable.sig }), []);
});

test('raises: the leading dotted name as written; from-clauses and calls; bare raise excluded', () => {
  const text = `def f(x):
    if x is None:
        raise ValueError("no")
    if x < 0:
        raise httpx.HTTPError("neg") from exc
    if x == 0:
        raise KeyError
    try:
        pass
    except Exception as e:
        raise
    try:
        pass
    except Exception as e:
        raise e
    raise (RuntimeError)
`;
  const { headerEnd } = parse(text);
  assert.deepEqual([...raisesOf(text, headerEnd)].sort(), ['KeyError', 'RuntimeError', 'ValueError', 'e', 'httpx.HTTPError']);
});

test('raises: comments, strings and docstrings are ignored', () => {
  const text = `def f(x):
    """
    Raises:
        raise Docstring
    """
    # raise Commented
    s = "raise InString"
    t = '''
    raise InTriple
    '''
    return s + t  # raise Trailing
`;
  assert.deepEqual([...raisesOf(text, parse(text).headerEnd)], []);
});

test('raises: nested def, async def and class bodies are not the parent\'s', () => {
  const text = `def outer(x):
    def inner():
        raise Inner
        if x:
            raise AlsoInner
    async def ainner():
        raise AsyncInner
    class C:
        def m(self):
            raise InClass
        raise InClassBody
    f = lambda: 0
    if x:
        raise Outer("a")
    def last(): raise OneLiner
    raise AfterAll
`;
  assert.deepEqual([...raisesOf(text, parse(text).headerEnd)].sort(), ['AfterAll', 'Outer']);
});

test('raises: a one-line function body and a continued call', () => {
  const one = 'def f(): raise Boom';
  assert.deepEqual([...raisesOf(one, parse(one).headerEnd)], ['Boom']);
  const cont = 'def f(x):\n    y = g(\n        1,\n    )\n    raise \\\n        Late(\n    y)\n';
  assert.deepEqual([...raisesOf(cont, parse(cont).headerEnd)], ['Late']);
});

test('(httpx) raises in real bodies', () => {
  const text = `    def _send_single_request(self, request: Request) -> Response:
        """
        Sends a single request, without handling any redirections.
        """
        transport = self._transport_for_url(request.url)
        start = time.perf_counter()

        if not isinstance(request.stream, SyncByteStream):
            raise RuntimeError(
                "Attempted to send an async request with a sync Client instance."
            )
`.trimStart();
  assert.deepEqual([...raisesOf(text, parse(text, true).headerEnd)], ['RuntimeError']);
});

test('unreadable text gives null, never a throw or a guess', () => {
  const bad = [
    '',
    'x = 1',
    'class C:\n    pass',
    'def f(a, b:\n    pass',
    'def f(a, "unterminated):\n    pass',
    'def f(a, b)\n    pass',
    'def f(a))\n    pass',
    'def f((a, b)):\n    pass',
    'def f(a,, b):\n    pass',
    'def f(*):\n    pass',
    'def f(a, /, /):\n    pass',
    'def f(/, a):\n    pass',
    'def f(**kw, a):\n    pass',
    'def f(a) -> :\n    pass',
    'def (a):\n    pass',
    '@\ndef f():\n    pass',
    '@dec(\ndef f():\n    pass',
  ];
  for (const text of bad) assert.equal(parsePythonDeclaration(text, { isMethod: false }), null, JSON.stringify(text));
  // @ts-expect-error not a string
  assert.equal(parsePythonDeclaration(undefined, { isMethod: false }), null);
});

test('size bound: the header may end at MAX_HEADER_CHARS; one more and it is unreadable', () => {
  /** @param {number} total @returns {string} a header whose colon is the `total`th character */
  const headerOfLength = (total) => {
    const head = 'def f(a,';
    const tail = '):';
    return `${head}${' '.repeat(total - head.length - tail.length)}${tail}`;
  };
  const atBound = `${headerOfLength(MAX_HEADER_CHARS)}\n    raise X\n`;
  const parsed = parsePythonDeclaration(atBound, { isMethod: false });
  assert.ok(parsed);
  assert.equal(parsed.headerEnd, MAX_HEADER_CHARS);
  assert.deepEqual([...raisesOf(atBound, parsed.headerEnd)], ['X']);
  assert.ok(parsePythonDeclaration(headerOfLength(MAX_HEADER_CHARS - 1), { isMethod: false }));
  assert.equal(parsePythonDeclaration(headerOfLength(MAX_HEADER_CHARS + 1), { isMethod: false }), null);
});

test('renderPythonSig shows defaults, rest, keyword-only and positional-only parameters', () => {
  const r = (/** @type {string} */ t, isMethod = false) => renderPythonSig(parse(t, isMethod).sig);
  assert.equal(r('def f(a: int, b=1, *args, c: str, **kw) -> T:\n pass'), '(a: int, b=…, *args, c: str, **kw) -> T');
  assert.equal(r('def f(a, *, c: str = "x") -> T:\n pass'), '(a, *, c: str = …) -> T');
  assert.equal(r('def f(a, b, /, c):\n pass'), '(a, b, /, c)');
  assert.equal(r('def f(a, /):\n pass'), '(a, /)');
  assert.equal(r('def f(self, a):\n pass', true), '(a)');
  assert.equal(r('def f():\n pass'), '()');
});
