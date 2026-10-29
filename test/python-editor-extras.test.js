'use strict';
// Python's caller extras (src/languages/python/editor-extras.js, P4): duplicated sites,
// value uses from `references`, property uses kept, duck typing with `definition` and its
// budgets, protocol methods, decorator registration, and `[]` vs `null` answers. No editor:
// texts, references, definitions and the file search are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const ex = require('../src/languages/python/editor-extras');
const { callersFromHierarchy } = require('../src/languages/callers-from-hierarchy');
const { createHierarchyResolver } = require('./lsp-harness/harness-languages');
const { pythonProvider } = require('../src/languages/python/provider');

const R = '/r';
const MODELS = `${R}/pkg/models.py`;
const MODELS_TEXT = [
  'import functools',
  '',
  'class Params:',
  '    def merge(self, other):',
  '        return self',
  '',
  '    @property',
  '    def size(self):',
  '        return 1',
  '',
  '    def __hash__(self):',
  '        return 1',
  '',
  '    def __init__(self):',
  '        pass',
  '',
  '@app.route("/x")',
  'def handler():',
  '    pass',
  '',
  '@functools.lru_cache()',
  'def cached():',
  '    pass',
  '',
  'def helper():',
  '    pass',
  '',
].join('\n');
/** @param {string} text @param {string} needle @param {number} [nth] Offset of the nth occurrence. */
const at = (text, needle, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
  assert.ok(i >= 0, `${needle} in text`);
  return i;
};
const posOf = (/** @type {string} */ name) => at(MODELS_TEXT, `def ${name}`) + 4;

/**
 * Extras over stubbed services. `files`: path → text. `refs`: the references answer.
 * `defs(file, offset)`: the definitions answer. `grepped`: repository-relative files.
 */
function make({ files = {}, refs = [], defs = () => null, grepped = null, grepFails = false, now = () => 0 } = {}) {
  const texts = { [MODELS]: MODELS_TEXT, ...files };
  const calls = { definitions: 0, references: 0, grep: 0 };
  const services = /** @type {any} */ ({
    references: async (/** @type {any} */ doc, /** @type {number} */ pos) => { calls.references++; return typeof refs === 'function' ? refs(doc, pos) : refs; },
    definitions: async (/** @type {any} */ doc, /** @type {number} */ pos) => { calls.definitions++; return defs(doc.file, pos); },
  });
  const extras = ex.createPythonEditorExtras({
    services, repoRoot: R, readText: (f) => (f in texts ? texts[f] : null), clock: { now },
    grep: async () => { calls.grep++; if (grepFails) throw new Error('grep broke'); return grepped || Object.keys(files).map((f) => f.slice(R.length + 1)); },
  });
  return { extras, calls, services };
}

/** A caller in `file` with a site at each given offset (each listed twice when `dup`). */
const caller = (file, label, offsets, dup = false) => {
  const sites = offsets.flatMap((o) => (dup ? [o, o] : [o])).map((o) => ({ start: o, end: o + 1 }));
  return { label, file, pos: 0, test: false, sites: sites.length, callSites: sites };
};

const ask = async (extras, name, callers = []) => {
  const q = extras.query(MODELS, posOf(name));
  const kept = callers.length ? q.filter(callers).kept : [];
  const more = await q.moreCallers();
  return { kept, more };
};

const def = (/** @type {number} */ pos) => [{ file: MODELS, start: pos, end: pos + 5 }];

test('duplicated fromRanges are kept once; no caller is dropped', () => {
  const { extras } = make();
  const q = extras.query(MODELS, posOf('merge'));
  const { kept, dropped } = q.filter([caller('/r/a.py', 'a', [10, 20], true), caller('/r/b.py', 'b', [5])]);
  assert.equal(dropped, 0);
  assert.deepEqual(kept[0].callSites, [{ start: 10, end: 11 }, { start: 20, end: 21 }]);
  assert.equal(kept[0].sites, 2);
  assert.equal(kept[1].sites, 1);
});

test('a reference that is not a call, an import or a listed site is a value use', async () => {
  const use = 'from pkg.models import helper\nHANDLERS = {"a": helper}\nhelper()\n';
  const file = `${R}/use.py`;
  const { extras } = make({
    files: { [file]: use },
    refs: [
      { file: MODELS, start: posOf('helper'), end: posOf('helper') + 6 },
      { file, start: at(use, 'helper'), end: at(use, 'helper') + 6 },
      { file, start: at(use, 'helper', 1), end: at(use, 'helper', 1) + 6 },
      { file, start: at(use, 'helper', 2), end: at(use, 'helper', 2) + 6 },
    ],
  });
  const { more } = await ask(extras, 'helper');
  assert.equal(more.incompleteReason, ex.VALUE_USE_REASON);
});

test('imports, calls and the definition are not value uses: a module function with only calls is complete', async () => {
  const use = 'from pkg.models import (\n    helper,\n)\nhelper()\n';
  const file = `${R}/use.py`;
  const { extras, calls } = make({
    files: { [file]: use },
    refs: [
      { file, start: at(use, 'helper'), end: at(use, 'helper') + 6 },
      { file, start: at(use, 'helper', 1), end: at(use, 'helper', 1) + 6 },
    ],
  });
  const { more } = await ask(extras, 'helper', [caller(file, 'mod', [at(use, 'helper', 1)])]);
  assert.equal(more.incompleteReason, null);
  assert.equal(calls.grep, 0, 'a module function is not searched by name');
});

test('a property: attribute accesses are its callers, never value uses, and it is not searched', async () => {
  const use = 'n = p.size\np.size = 2\n';
  const file = `${R}/use.py`;
  const sites = [at(use, 'size'), at(use, 'size', 1)];
  const { extras, calls } = make({ files: { [file]: use }, refs: sites.map((s) => ({ file, start: s, end: s + 4 })) });
  const { kept, more } = await ask(extras, 'size', [caller(file, 'mod', sites)]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sites, 2);
  assert.equal(more.incompleteReason, null);
  assert.equal(calls.references, 0);
  assert.equal(calls.grep, 0);
});

test('duck typing: an unresolved code hit makes the answer incomplete with its count', async () => {
  const use = 'def f(anything, t):\n    anything.merge(1)\n    other.merge(2)\n    t.merge(3)\n';
  const file = `${R}/use.py`;
  const listedSite = at(use, 'merge', 2);
  const { extras, calls } = make({ files: { [file]: use }, defs: () => null });
  const { more } = await ask(extras, 'merge', [caller(file, 'f', [listedSite])]);
  assert.equal(more.incompleteReason, '2 calls by this name that the language server could not resolve');
  assert.equal(calls.definitions, 2, 'the listed site is not asked');
});

test('duck typing: a hit that resolves to another function is ignored (quiet when typing is good)', async () => {
  const use = 'def f(d):\n    d.merge(1)\n';
  const file = `${R}/use.py`;
  const { extras } = make({ files: { [file]: use }, defs: () => [{ file: `${R}/other.py`, start: 3, end: 8 }] });
  const { more } = await ask(extras, 'merge');
  assert.equal(more.incompleteReason, null);
});

test('duck typing: a hit that resolves to the target but is not listed is counted as missed', async () => {
  const use = 'def f(p: Params):\n    p.merge(1)\n';
  const file = `${R}/use.py`;
  const { extras } = make({ files: { [file]: use }, defs: () => def(posOf('merge')) });
  const { more } = await ask(extras, 'merge');
  assert.equal(more.incompleteReason, '1 call the language server resolves to it but did not list');
});

test('duck typing: hits in strings, comments, docstrings and on string literals are not asked; f-string fields are', async () => {
  const use = [
    'x = "a.merge(b)"',
    '# p.merge(1)',
    '"""',
    '>>> q.merge({})',
    '"""',
    'y = ", ".merge(z)',
    "w = r'\\'.merge(1)'",
    'v = f"{p.merge(1)}"',
    '',
  ].join('\n');
  const file = `${R}/use.py`;
  const { extras, calls } = make({ files: { [file]: use }, defs: () => null });
  const { more } = await ask(extras, 'merge');
  assert.equal(calls.definitions, 1);
  assert.equal(more.incompleteReason, '1 call by this name that the language server could not resolve');
});

test('duck typing: a failed definition query or an empty answer counts as unresolved', async () => {
  const use = 'a.merge(1)\nb.merge(2)\n';
  const file = `${R}/use.py`;
  let n = 0;
  const { extras } = make({ files: { [file]: use }, defs: () => { n++; if (n === 1) throw new Error('boom'); return []; } });
  const { more } = await ask(extras, 'merge');
  assert.equal(more.incompleteReason, '2 calls by this name that the language server could not resolve');
});

test('duck typing: files outside the provider (venv) are not read; a failed search is incomplete', async () => {
  const file = `${R}/.venv/lib/x.py`;
  const { extras } = make({ files: { [file]: 'a.merge(1)\n' }, defs: () => null });
  assert.equal((await ask(extras, 'merge')).more.incompleteReason, null);
  const failing = make({ grepFails: true }).extras;
  assert.match(String((await ask(failing, 'merge')).more.incompleteReason), /could not be searched: grep broke/);
});

for (const [hits, incomplete] of [[ex.DUCK_MAX_DEFINITIONS - 1, false], [ex.DUCK_MAX_DEFINITIONS, false], [ex.DUCK_MAX_DEFINITIONS + 1, true]]) {
  test(`duck typing budget: ${hits} hits resolving elsewhere ${incomplete ? 'exceeds' : 'fits'} the ${ex.DUCK_MAX_DEFINITIONS}-query limit`, async () => {
    const use = Array.from({ length: hits }, (_, i) => `o${i}.merge(${i})`).join('\n');
    const file = `${R}/use.py`;
    const { extras, calls } = make({ files: { [file]: use }, defs: () => [{ file: `${R}/other.py`, start: 0, end: 1 }] });
    const { more } = await ask(extras, 'merge');
    assert.equal(calls.definitions, Math.min(hits, ex.DUCK_MAX_DEFINITIONS));
    if (incomplete) assert.equal(more.incompleteReason, `more than ${ex.DUCK_MAX_DEFINITIONS} calls by this name; 1 not checked`);
    else assert.equal(more.incompleteReason, null);
  });
}

test('duck typing budgets: files past the file limit, an oversized file and the deadline are reported, not skipped silently', async () => {
  const files = {};
  for (let i = 0; i <= ex.DUCK_MAX_FILES; i++) files[`${R}/f${i}.py`] = 'x = 1\n';
  const many = make({ files, defs: () => null }).extras;
  assert.equal((await ask(many, 'merge')).more.incompleteReason, `1 of ${ex.DUCK_MAX_FILES + 1} files with calls by this name not checked`);
  const big = make({ files: { [`${R}/big.py`]: 'x'.repeat(ex.DUCK_MAX_FILE_BYTES + 1) } }).extras;
  assert.equal((await ask(big, 'merge')).more.incompleteReason, '1 of 1 files with calls by this name not checked');
  let t = 0;
  const slow = make({ files: { [`${R}/a.py`]: 'a.merge(1)\n', [`${R}/b.py`]: 'b.merge(1)\n' }, defs: () => { t += ex.DUCK_DEADLINE_MS; return [{ file: `${R}/o.py`, start: 0, end: 1 }]; }, now: () => t }).extras;
  assert.equal((await ask(slow, 'merge')).more.incompleteReason, '1 of 2 files with calls by this name not checked');
});

test('a protocol (dunder) method is always incomplete; __init__ is not a protocol method', async () => {
  const { extras, calls } = make();
  const { more } = await ask(extras, '__hash__', [caller(MODELS, 'x', [1])]);
  assert.equal(more.incompleteReason, ex.PROTOCOL_REASON);
  assert.equal(calls.references, 0);
  assert.equal(ex.isProtocolName('__init__'), false);
  assert.equal(ex.isProtocolName('__eq__'), true);
  assert.equal(extras.explainIncomplete('no incoming-call result', MODELS, posOf('__hash__')), ex.PROTOCOL_REASON);
  assert.equal(extras.explainIncomplete('timed out', MODELS, posOf('__hash__')), null, 'a failure keeps its own reason');
});

test('a registering decorator with no caller is incomplete; a transparent one is not', async () => {
  const { extras } = make();
  assert.equal((await ask(extras, 'handler')).more.incompleteReason, ex.REGISTRATION_REASON);
  assert.equal((await ask(extras, 'handler', [caller(`${R}/a.py`, 'a', [1])])).more.incompleteReason, null, 'callers found: they stand');
  assert.equal((await ask(extras, 'cached')).more.incompleteReason, null, 'lru_cache leaves it called by name');
  assert.equal(extras.explainIncomplete('no incoming-call result', MODELS, posOf('handler')), ex.REGISTRATION_REASON);
  assert.equal(ex.isRegistrationDecorator('pytest.fixture'), true);
  assert.equal(ex.isRegistrationDecorator('x.setter'), false);
  assert.equal(ex.isRegistrationDecorator('typing.overload'), false);
});

test('declarationAt reads name, method-ness and decorators', () => {
  assert.deepEqual(ex.declarationAt(MODELS_TEXT, posOf('size')), { name: 'size', isMethod: true, decorators: ['property'] });
  assert.deepEqual(ex.declarationAt(MODELS_TEXT, posOf('handler')), { name: 'handler', isMethod: false, decorators: ['app.route("/x")'] });
  assert.equal(ex.declarationAt(MODELS_TEXT, 0), null);
  const multi = 'class C:\n    @app.route(\n        "/x",\n    )\n    @staticmethod\n    def h():\n        pass\n';
  assert.deepEqual(ex.declarationAt(multi, multi.indexOf('def h') + 4), { name: 'h', isMethod: true, decorators: ['app.route(', 'staticmethod'] });
});

/** A harness resolver over stub services whose incoming calls answer `incoming`. */
function resolverAnswering(incoming, refs, name, files = {}) {
  const { extras, services } = make({ refs, files });
  Object.assign(services, {
    prepareCallHierarchy: async () => [{}],
    incomingCalls: async () => incoming,
  });
  const resolver = createHierarchyResolver(services, { extras });
  return resolver.callerState(MODELS, posOf(name));
}

test('[] and null answers: never "no callers" when a rule applies', async () => {
  // `[]` (what VS Code may turn Pyright's `null` into): the extras run.
  assert.deepEqual(await resolverAnswering([], [], '__hash__'), { state: 'unknown', callers: [], complete: false, reason: ex.PROTOCOL_REASON });
  assert.deepEqual(await resolverAnswering([], [], 'handler'), { state: 'unknown', callers: [], complete: false, reason: ex.REGISTRATION_REASON });
  const use = `${R}/use.py`;
  const valueRefs = [{ file: use, start: 4, end: 10 }];
  const v = await resolverAnswering([], valueRefs, 'helper', { [use]: 'x = helper\n' });
  assert.equal(v.state, 'unknown');
  assert.equal(v.reason, ex.VALUE_USE_REASON);
  // `null` (the harness passes Pyright's through): incomplete, explained for a protocol method.
  assert.equal((await resolverAnswering(null, [], '__hash__')).reason, ex.PROTOCOL_REASON);
  const plain = await resolverAnswering(null, [], 'helper');
  assert.equal(plain.state, 'unknown');
  assert.equal(plain.reason, 'no incoming-call result');
});

// P7 (httpx #3245): Pyright answers `null` at `__init__` and lists the `Cls(...)` constructions
// only at the class name, so `__init__` read "no incoming-call result" in the harness and,
// where the editor turns `null` into `[]`, the constructor path's complete "no callers" (`di`)
// while 136 constructions of `Client` existed.
// A5: the class's name is a caller target of its `__init__`, so the constructions are listed.
const CLASS_POS = at(MODELS_TEXT, 'class Params') + 6;

test('callerTargets: a class\'s __init__ gives the class name; nothing else does', () => {
  const { extras } = make();
  assert.deepEqual(extras.callerTargets?.(MODELS, posOf('__init__')), [{ file: MODELS, pos: CLASS_POS }]);
  assert.deepEqual(extras.callerTargets?.(MODELS, posOf('merge')), []);
  assert.deepEqual(extras.callerTargets?.(MODELS, posOf('helper')), []);
  assert.deepEqual(extras.callerTargets?.('/r/missing.py', 3), [], 'an unread file: none');
  const nested = 'class Outer:\n    x = 1\n\n    class Inner:\n        # c\n        def __init__(self):\n            pass\n';
  assert.deepEqual(ex.enclosingClassAt(nested, at(nested, '__init__'))?.namePos, at(nested, 'Inner'), 'a nested class: its own name');
  const decorated = '@dataclass\n@other(x=1)\nclass Cfg(Base):\n    def __init__(self):\n        pass\n';
  assert.equal(ex.enclosingClassAt(decorated, at(decorated, '__init__'))?.namePos, at(decorated, 'Cfg'));
  const local = 'def make():\n    class Local:\n        def __init__(self):\n            pass\n    return Local\n';
  assert.equal(ex.enclosingClassAt(local, at(local, '__init__')), null, 'a class in a function: none');
  const inMethod = 'class A:\n    def m(self):\n        class B:\n            def __init__(self):\n                pass\n';
  assert.equal(ex.enclosingClassAt(inMethod, at(inMethod, '__init__')), null, 'a class in a method: none');
  const moduleFn = 'def __init__():\n    pass\n';
  assert.equal(ex.enclosingClassAt(moduleFn, at(moduleFn, '__init__')), null);
});

test('classUseAt: calls, bases, annotations, isinstance and except are not value uses', () => {
  const cases = [
    ['x = Client(1)', 'call'],
    ['class Sub(Base, Client):', 'base'],
    ['def f(c: Client, d: Optional[Client] = None) -> Client:', 'inert', 0],
    ['def f(c: Client, d: Optional[Client] = None) -> Client:', 'inert', 1],
    ['def f(c: Client, d: Optional[Client] = None) -> Client:', 'inert', 2],
    ['    self.c: Client | None = None', 'inert'],
    ['if isinstance(x, (str, Client)):', 'inert'],
    ['except Client:', 'inert'],
    ['def f(c: "Client"): pass', 'inert'],
    ['make(transport_cls=Client)', 'value'],
    ['d = {"a": Client}', 'value'],
    ['f = lambda c: Client', 'value'],
    ['return Client', 'value'],
  ];
  for (const [line, want, nth = 0] of cases) {
    const start = at(line, 'Client', /** @type {number} */ (nth));
    assert.equal(ex.classUseAt(line, start, start + 6, ex.nonCodeRanges(line)), want, line);
  }
});

test('__init__: its class\'s constructions are its callers (null at __init__ itself)', async () => {
  const use = 'from pkg.models import Params\n\ndef build():\n    return Params()\n';
  const file = `${R}/use.py`;
  const site = at(use, 'Params()');
  const refs = (/** @type {any} */ _doc, /** @type {number} */ pos) => (pos === CLASS_POS
    ? [{ file: MODELS, start: CLASS_POS, end: CLASS_POS + 6 }, { file, start: at(use, 'Params'), end: at(use, 'Params') + 6 }, { file, start: site, end: site + 6 }]
    : [{ file: MODELS, start: posOf('__init__'), end: posOf('__init__') + 8 }]);
  const { extras, services } = make({ files: { [file]: use }, refs });
  assert.equal(extras.explainIncomplete('no incoming-call result', MODELS, posOf('__init__')), null, 'the class answers instead');
  assert.equal(extras.explainIncomplete('timed out', MODELS, posOf('__init__')), null);
  const asked = [];
  Object.assign(services, {
    prepareCallHierarchy: async (/** @type {any} */ _doc, /** @type {number} */ pos) => { asked.push(pos); return [{ pos }]; },
    incomingCalls: async (/** @type {any} */ item) => (item.pos === CLASS_POS ? [caller(file, 'build', [site], true)] : null),
  });
  const state = await createHierarchyResolver(services, { extras }).callerState(MODELS, posOf('__init__'), { isConstructor: true });
  assert.deepEqual(asked.sort(), [posOf('__init__'), CLASS_POS].sort());
  assert.equal(state.state, 'resolved');
  assert.equal(state.complete, true, state.reason);
  assert.deepEqual(state.callers.map((c) => [c.file, c.sites]), [[file, 1]]);
});

test('__init__ with no construction and no reference is the constructor path\'s "no callers"', async () => {
  const { extras, services } = make({ refs: (/** @type {any} */ _d, /** @type {number} */ pos) => [{ file: MODELS, start: pos, end: pos + 1 }] });
  Object.assign(services, { prepareCallHierarchy: async () => [{}], incomingCalls: async () => [] });
  const state = await createHierarchyResolver(services, { extras }).callerState(MODELS, posOf('__init__'), { isConstructor: true });
  assert.deepEqual(state, { state: 'di', callers: [], complete: true });
});

test('__init__ rules: class value uses, subclasses and cls(...) keep it incomplete', async () => {
  const file = `${R}/use.py`;
  const ask2 = async (/** @type {string} */ use, extraModels = MODELS_TEXT) => {
    const refsAtClass = [...use.matchAll(/Params/g)].map((m) => ({ file, start: /** @type {number} */ (m.index), end: /** @type {number} */ (m.index) + 6 }));
    const { extras } = make({ files: { [file]: use, [MODELS]: extraModels }, refs: (/** @type {any} */ _d, /** @type {number} */ pos) => (pos === CLASS_POS ? refsAtClass : []) });
    const q = extras.query(MODELS, at(extraModels, 'def __init__') + 4);
    return (await q.moreCallers()).incompleteReason;
  };
  assert.equal(await ask2('make(transport_cls=Params)\n'), ex.VALUE_USE_REASON);
  assert.equal(await ask2('def f(p: Params) -> Params:\n    return isinstance(p, Params)\n'), null, 'annotations and isinstance do not construct');
  assert.equal(await ask2('class Sub(Params):\n    pass\n'), ex.SUBCLASS_REASON);
  const withFactory = MODELS_TEXT.replace('    def __init__(self):', '    @classmethod\n    def make(cls):\n        return cls()\n\n    def __init__(self):');
  assert.equal(await ask2('', withFactory), ex.FACTORY_REASON);
  const withType = MODELS_TEXT.replace('    def __init__(self):', '    def copy(self):\n        return type(self)()  # cls(\n\n    def __init__(self):');
  assert.equal(await ask2('', withType), ex.FACTORY_REASON);
  const commentOnly = MODELS_TEXT.replace('    def __init__(self):', '    # cls() here\n    def __init__(self):');
  assert.equal(await ask2('', commentOnly), null, 'a comment is not a factory call');
  // No duck-typing search for a constructor.
  const { extras, calls } = make({ refs: [] });
  await extras.query(MODELS, posOf('__init__')).moreCallers();
  assert.equal(calls.grep, 0);
});

test('__init__ of a class in a function stays incomplete', async () => {
  const file = `${R}/local.py`;
  const text = 'def make():\n    class Local:\n        def __init__(self):\n            pass\n    return Local\n';
  const { extras } = make({ files: { [file]: text } });
  const pos = at(text, '__init__');
  assert.deepEqual(extras.callerTargets?.(file, pos), []);
  assert.equal(extras.explainIncomplete('no incoming-call result', file, pos), ex.CONSTRUCTOR_REASON);
  assert.equal((await extras.query(file, pos).moreCallers()).incompleteReason, ex.CONSTRUCTOR_REASON);
});

test('a typed method with complete callers and no stray hits is complete', async () => {
  const use = 'def f(p: Params):\n    p.merge(1)\n';
  const file = `${R}/use.py`;
  const site = at(use, 'merge');
  const { extras, services } = make({ files: { [file]: use }, refs: [{ file, start: site, end: site + 5 }], defs: () => def(posOf('merge')) });
  Object.assign(services, { prepareCallHierarchy: async () => [{}], incomingCalls: async () => [caller(file, 'f', [site], true)] });
  const state = await createHierarchyResolver(services, { extras }).callerState(MODELS, posOf('merge'));
  assert.equal(state.state, 'resolved');
  assert.equal(state.complete, true);
  assert.equal(state.callers[0].sites, 1);
});

test('the provider supplies the extras', () => {
  assert.equal(typeof pythonProvider.editorCallers, 'function');
  const e = /** @type {any} */ (pythonProvider.editorCallers)({ services: null, repoRoot: null, trace: () => {} });
  assert.equal(e.droppedStat, 'valueUsesDropped');
  void callersFromHierarchy;
});

test('a target whose file cannot be read is incomplete, never complete by default', async () => {
  const extras = ex.createPythonEditorExtras({ services: /** @type {any} */ ({}), repoRoot: R, readText: () => null, grep: async () => [] });
  const more = await extras.query(MODELS, posOf('merge')).moreCallers();
  assert.equal(more.incompleteReason, ex.UNREAD_TARGET_REASON);
});

test('without language services or a repository the checks cannot run: incomplete', async () => {
  for (const options of [{ services: null, repoRoot: R }, { services: /** @type {any} */ ({}), repoRoot: null }]) {
    const extras = ex.createPythonEditorExtras({ ...options, readText: (f) => (f === MODELS ? MODELS_TEXT : null), grep: async () => [] });
    const more = await extras.query(MODELS, posOf('merge')).moreCallers();
    assert.equal(more.incompleteReason, ex.NO_SERVICES_REASON);
  }
  // A protocol method says why it is incomplete even then.
  const extras = ex.createPythonEditorExtras({ readText: (f) => (f === MODELS ? MODELS_TEXT : null) });
  assert.equal((await extras.query(MODELS, posOf('__hash__')).moreCallers()).incompleteReason, ex.PROTOCOL_REASON);
});

test('hits on string literals are skipped from one scan of the file, however many there are', async () => {
  const file = `${R}/many.py`;
  const many = `${'x = ", ".merge(a)\n'.repeat(5000)}obj.merge(b)\n`;
  const { extras, calls } = make({ files: { [file]: many }, refs: [], defs: () => null });
  const { more } = await ask(extras, 'merge');
  assert.equal(calls.definitions, 1, 'only the hit on an untyped receiver is asked');
  assert.match(String(more.incompleteReason), /^1 call by this name that the language server could not resolve/);
});

// A5 through the editor's resolver (src/session/resolver-vscode.js) with the vscode stub: an
// `__init__` lists its class's constructions, the merged answer is cached, the target query
// is counted, and a target answer that outlives `clear()` is not used.
test('the editor resolver lists an __init__\'s constructions from its class (A5)', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const Module = require('module'), original = Module._load;
  const { createFakeClock } = require('./fake-clock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-py-resolver-'));
  const target = path.join(dir, 'models.py');
  const text = 'class Params:\n    def __init__(self):\n        pass\n';
  fs.writeFileSync(target, text);
  const useFile = path.join(dir, 'use.py');
  fs.writeFileSync(useFile, 'from models import Params\n\ndef build():\n    return Params()\n');
  /** @type {(() => void)|null} */
  let hold = null;
  let holdNext = false;
  const stub = { ...require('./vscode-stub'), Position: class { constructor(/** @type {number} */ line, /** @type {number} */ character) { Object.assign(this, { line, character }); } },
    commands: { executeCommand: async (/** @type {string} */ name, /** @type {any} */ a, /** @type {any} */ b) => {
      if (name === 'vscode.prepareCallHierarchy') return [{ line: b.line }];
      if (name === 'vscode.provideIncomingCalls') {
        if (a.line !== 0) return []; // VS Code's `[]` for Pyright's `null` at `__init__`
        if (holdNext) await new Promise((resolve) => { hold = () => resolve(undefined); });
        return [{ from: { uri: { fsPath: useFile }, name: 'build', selectionRange: { start: { line: 2, character: 4 } } },
          fromRanges: [{ start: { line: 3, character: 11 }, end: { line: 3, character: 17 } }, { start: { line: 3, character: 11 }, end: { line: 3, character: 17 } }] }];
      }
      if (name === 'vscode.executeReferenceProvider') return [];
      return undefined;
    } } };
  try {
    Module._load = function (/** @type {string} */ name, /** @type {any[]} */ ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
    delete require.cache[require.resolve('../src/session/resolver-vscode')];
    const { createVscodeResolver } = require('../src/session/resolver-vscode');
    const clock = createFakeClock();
    const resolver = createVscodeResolver({ repoRoot: dir, retries: 0, clock });
    const initPos = text.indexOf('__init__');
    const pending = resolver.callerState(target, initPos, { isConstructor: true });
    await clock.advance(120000);
    const state = await pending;
    assert.equal(state.state, 'resolved');
    assert.equal(state.complete, true, state.reason);
    assert.deepEqual(state.callers.map((/** @type {any} */ c) => [c.label, c.sites]), [['build', 1]]);
    assert.equal(resolver.stats().callerTargetQueries, 1);
    const again = await resolver.incomingWithStatus(target, initPos);
    assert.equal(again.complete, true);
    assert.equal(resolver.stats().cacheHits, 1, 'the merged complete answer is cached');

    // A target answer that arrives after `clear()` belongs to the earlier analysis.
    resolver.clear();
    holdNext = true;
    const late = resolver.incomingWithStatus(target, initPos);
    for (let i = 0; i < 50 && !hold; i++) await clock.advance(10);
    assert.ok(hold, 'the class query is in flight');
    resolver.clear();
    /** @type {() => void} */ (hold)();
    await clock.advance(1000);
    assert.deepEqual(await late, { callers: [], complete: false, reason: 'caller query belongs to an earlier analysis' });
  } finally {
    Module._load = original;
    delete require.cache[require.resolve('../src/session/resolver-vscode')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A7: callers in files outside Pyright's project. `config`: pyproject.toml text (or an
// Error to throw); the search returns every stubbed file.
const PYPROJECT = "[tool.pyright]\ninclude = ['pkg', 'tests/test_in.py']\n";
function makeOutside({ files = {}, config = /** @type {any} */ (PYPROJECT), grepFails = false, now = () => 0, defs = () => null } = {}) {
  const texts = { [MODELS]: MODELS_TEXT, ...files };
  const calls = { grep: 0, configReads: 0 };
  const extras = ex.createPythonEditorExtras({
    services: /** @type {any} */ ({ references: async () => [], definitions: async (/** @type {any} */ d, /** @type {number} */ p) => defs(d.file, p) }),
    repoRoot: R, readText: (f) => (f in texts ? texts[f] : null), clock: { now },
    grep: async () => { calls.grep++; if (grepFails) throw new Error('grep broke'); return Object.keys(texts).map((f) => f.slice(R.length + 1)); },
    readConfig: (abs) => {
      calls.configReads++;
      if (!abs.endsWith('pyproject.toml')) return null;
      if (config instanceof Error) throw config;
      return config;
    },
  });
  return { extras, calls };
}
const OUT_REASON = (/** @type {number} */ n) => `${n} call${n === 1 ? '' : 's'} by this name in files outside the language server's project (pyproject.toml [tool.pyright])`;

test('outside the project: a module function called from an excluded test is incomplete; from an included file, no effect', async () => {
  const out = makeOutside({ files: { [`${R}/tests/test_out.py`]: 'from pkg.models import helper\n\ndef test_x():\n    helper()\n' } });
  assert.equal((await ask(out.extras, 'helper')).more.incompleteReason, OUT_REASON(2)); // the import and the call
  const inside = makeOutside({ files: { [`${R}/tests/test_in.py`]: 'from pkg.models import helper\nhelper()\n', [`${R}/pkg/use.py`]: 'helper()\n' } });
  assert.equal((await ask(inside.extras, 'helper')).more.incompleteReason, null);
});

test('outside the project: strings, comments, other names, `def`/`class` by that name and listed sites do not count', async () => {
  const text = [
    '# helper()', 's = "helper()"', 'doc = """', 'helper()', '"""', 'helpers()', 'x.helper_two()', 'def helper():', '    pass',
    'class helper(Base):', '    pass', 'y = helper', 'mod.helper()', '',
  ].join('\n');
  const file = `${R}/tests/test_out.py`;
  const { extras } = makeOutside({ files: { [file]: text } });
  const site = text.indexOf('mod.helper') + 4;
  // Only `mod.helper()`; at a listed site it is not counted either.
  assert.equal((await ask(extras, 'helper')).more.incompleteReason, OUT_REASON(1));
  const listed = makeOutside({ files: { [file]: text } }).extras;
  assert.equal((await ask(listed, 'helper', [caller(file, 't', [site])])).more.incompleteReason, null);
  // A file with its own module-level `helper` and no import of it: only `mod.helper()`.
  const own = makeOutside({ files: { [file]: 'def helper():\n    pass\n\nhelper()\nmod.helper()\n' } }).extras;
  assert.equal((await ask(own, 'helper')).more.incompleteReason, OUT_REASON(1));
  const imported = makeOutside({ files: { [file]: 'from pkg.models import helper\ndef helper():\n    pass\nhelper()\n' } }).extras;
  assert.equal((await ask(imported, 'helper')).more.incompleteReason, OUT_REASON(2));
  // An f-string's fields are code.
  const f = makeOutside({ files: { [file]: 'x = f"{helper()}"\n' } }).extras;
  assert.equal((await ask(f, 'helper')).more.incompleteReason, OUT_REASON(1));
});

test('outside the project: no config, or neither key, means no search; a method is left to the duck search', async () => {
  for (const config of [null, '[tool.pyright]\nstrict = ["x"]\n']) {
    const { extras, calls } = makeOutside({ config, files: { [`${R}/tests/test_out.py`]: 'helper()\n' } });
    assert.equal((await ask(extras, 'helper')).more.incompleteReason, null);
    assert.equal(calls.grep, 0);
  }
  // A method: the duck search reads every file and asks `definition` (here: another function).
  const { extras } = makeOutside({ files: { [`${R}/tests/test_out.py`]: 'merge(1)\no.merge(2)\n' }, defs: () => [{ file: `${R}/o.py`, start: 0, end: 1 }] });
  assert.equal((await ask(extras, 'merge')).more.incompleteReason, null);
});

test('outside the project: an unreadable config searches every file and names the error; a failed grep is incomplete', async () => {
  const { extras } = makeOutside({ config: new Error('EACCES'), files: { [`${R}/pkg/use.py`]: 'helper()\n' } });
  assert.equal((await ask(extras, 'helper')).more.incompleteReason, '1 call by this name the language server did not list; its project could not be read (pyproject.toml: EACCES)');
  const clean = makeOutside({ config: '[tool.pyright]\ninclude = [1]\n' }).extras;
  assert.equal((await ask(clean, 'helper')).more.incompleteReason, null); // no use anywhere
  const failing = makeOutside({ grepFails: true }).extras;
  assert.match(String((await ask(failing, 'helper')).more.incompleteReason), /outside the language server's project could not be searched: grep broke/);
});

for (const [n, unchecked] of [[ex.OUTSIDE_MAX_FILES - 1, 0], [ex.OUTSIDE_MAX_FILES, 0], [ex.OUTSIDE_MAX_FILES + 1, 1]]) {
  test(`outside the project budget: ${n} files outside ${unchecked ? 'exceed' : 'fit'} the ${ex.OUTSIDE_MAX_FILES}-file limit`, async () => {
    /** @type {Record<string, string>} */
    const files = {};
    for (let i = 0; i < n; i++) files[`${R}/tests/t${i}.py`] = 'x = 1\n';
    const { extras } = makeOutside({ files });
    const reason = (await ask(extras, 'helper')).more.incompleteReason;
    assert.equal(reason, unchecked ? `1 of ${n} files outside the language server's project with this name not checked` : null);
  });
}

test('outside the project budgets: an oversized file, the total bytes and the deadline are reported, with what was found', async () => {
  const big = makeOutside({ files: { [`${R}/tests/big.py`]: 'x'.repeat(ex.OUTSIDE_MAX_FILE_BYTES + 1) } }).extras;
  assert.equal((await ask(big, 'helper')).more.incompleteReason, "1 of 1 files outside the language server's project with this name not checked");
  /** @type {Record<string, string>} */
  const files = {};
  const body = `helper()\n${'x'.repeat(ex.OUTSIDE_MAX_FILE_BYTES - 100)}`;
  const count = Math.ceil(ex.OUTSIDE_MAX_TOTAL_BYTES / body.length) + 1;
  for (let i = 0; i < count; i++) files[`${R}/tests/t${i}.py`] = body;
  const total = makeOutside({ files }).extras;
  const read = Math.floor(ex.OUTSIDE_MAX_TOTAL_BYTES / body.length);
  assert.equal((await ask(total, 'helper')).more.incompleteReason, `${OUT_REASON(read)}; ${count - read} of ${count} files outside the language server's project with this name not checked`);
  let t = 0;
  const slow = makeOutside({ files: { [`${R}/tests/a.py`]: 'helper()\n', [`${R}/tests/b.py`]: 'helper()\n' }, now: () => { const v = t; t += ex.OUTSIDE_DEADLINE_MS / 2; return v; } }).extras;
  assert.equal((await ask(slow, 'helper')).more.incompleteReason, `${OUT_REASON(1)}; 1 of 2 files outside the language server's project with this name not checked`);
});

test('outside the project: __init__ is searched by its class name; clear() reads the config again', async () => {
  const { extras, calls } = makeOutside({ files: { [`${R}/tests/test_out.py`]: 'Params()\n' } });
  const q = extras.query(MODELS, posOf('__init__'));
  assert.equal((await q.moreCallers()).incompleteReason, OUT_REASON(1));
  await ask(extras, 'helper');
  assert.equal(calls.configReads, 2); // pyrightconfig.json (absent), then pyproject.toml, once per instance
  extras.clear();
  await ask(extras, 'helper');
  assert.equal(calls.configReads, 4);
});
