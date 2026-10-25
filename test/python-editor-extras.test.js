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
    references: async () => { calls.references++; return typeof refs === 'function' ? refs() : refs; },
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
  assert.equal(extras.explainIncomplete('no incoming-call result', MODELS, posOf('__init__')), null);
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
