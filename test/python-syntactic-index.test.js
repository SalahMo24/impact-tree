'use strict';
// Python callers without a language server (A8, docs/MULTI_LANGUAGE_PLAN.md): the syntax-only
// index (src/languages/python/syntactic-index.js), rule by rule and non-rule by non-rule, and
// its answers through the shared `createSyntacticResolver`: never complete.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPythonSyntacticIndex, pickRepositoryFiles, moduleNamesOf, REPO_MAX_FILES, REPO_MAX_BYTES, MAX_FILE_BYTES,
} = require('../src/languages/python/syntactic-index');
const { createSyntacticResolver } = require('../src/engine/resolver-syntactic');

/** The index of `files` ({ path: text }) and a lookup of a def's callers by `path`/`Qualified.name`. */
function indexOf(files, options) {
  const idx = createPythonSyntacticIndex(Object.entries(files).map(([p, text]) => ({ path: p, text })), { scope: 'the test files', ...options });
  const find = (file, qualified) => {
    const rec = idx.byFile.get(file);
    const def = [...rec.byPos.values()].find((d) => d.qualified === qualified);
    assert.ok(def, `${file}: ${qualified} is indexed`);
    return def;
  };
  const callers = (file, qualified) => {
    const d = find(file, qualified);
    const sym = idx.symbolAt(file, d.namePos);
    const r = idx.callersOfWithStatus({ file, ...sym, pos: d.namePos });
    return {
      labels: r.callers.map((c) => `${c.file}:${c.label}`).sort(),
      sites: r.callers.reduce((n, c) => n + c.callSites.length, 0),
      reason: r.incompleteReason,
      unresolved: idx.unresolvedCallsTo(sym),
    };
  };
  return { idx, find, callers };
}

test('module names: plain, packages, a src/ layout; a path that is no module has none', () => {
  assert.deepEqual(moduleNamesOf('a/b.py'), ['a.b']);
  assert.deepEqual(moduleNamesOf('a/__init__.py'), ['a']);
  assert.deepEqual(moduleNamesOf('src/pkg/m.py'), ['src.pkg.m', 'pkg.m']);
  assert.deepEqual(moduleNamesOf('libs/x/src/pkg/__init__.pyi'), ['libs.x.src.pkg', 'pkg']);
  assert.deepEqual(moduleNamesOf('my-dir/m.py'), []);
});

test('rule 1: a bare call to a def of the same module or an imported one; aliases; a local shadows it', () => {
  const { callers } = indexOf({
    'p/a.py': 'def f():\n    return 1\n\ndef g():\n    return f()\n\ndef h(f):\n    return f()\n\ndef k():\n    def f():\n        return 2\n    return f()\n',
    'p/b.py': 'from p.a import f\nfrom p.a import f as ff\n\nx = f()\n\ndef m():\n    return ff()\n',
    'p/c.py': 'def f():\n    return 3\n\ndef n():\n    return f()\n',
  });
  const r = callers('p/a.py', 'f');
  assert.deepEqual(r.labels, ['p/a.py:g', 'p/b.py:b.py', 'p/b.py:m'], 'a parameter and a nested def named f shadow it; c.py has its own f');
  assert.match(r.reason, /^Python callers from syntax only: the test files; untyped receivers and dynamic calls are not resolved$/);
});

test('import forms: `import a.b as c`, `import a.b`, relative `from .m import x as y`, `from .. import m`, parenthesised across lines, `*`', () => {
  const { callers } = indexOf({
    'pkg/__init__.py': '',
    'pkg/sub/__init__.py': 'from .impl import run\n',
    'pkg/sub/impl.py': 'def run():\n    return 1\n',
    'pkg/u1.py': 'import pkg.sub.impl as c\n\ndef a():\n    return c.run()\n',
    'pkg/u2.py': 'import pkg.sub.impl\n\ndef b():\n    return pkg.sub.impl.run()\n',
    'pkg/sub/u3.py': 'from .impl import run as go\n\ndef d():\n    return go()\n',
    'pkg/sub/deep/u4.py': 'from .. import impl\n\ndef e():\n    return impl.run()\n',
    'pkg/u5.py': 'from pkg.sub.impl import (\n    run,\n)\n\ndef f():\n    return run()\n',
    'pkg/u6.py': 'from pkg.sub.impl import *\n\ndef g():\n    return run()\n',
    'pkg/u7.py': 'import pkg.sub\n\ndef h():\n    return pkg.sub.run()\n',
  });
  assert.deepEqual(callers('pkg/sub/impl.py', 'run').labels,
    ['pkg/sub/deep/u4.py:e', 'pkg/sub/u3.py:d', 'pkg/u1.py:a', 'pkg/u2.py:b', 'pkg/u5.py:f', 'pkg/u6.py:g', 'pkg/u7.py:h']);
});

test('A8.2: `from . import sub` in a package\'s __init__ (under an if) is the submodule: pkg.sub.f( and a re-export through it resolve', () => {
  const { callers } = indexOf({
    'pkg/__init__.py': 'import typing\n\nif typing.TYPE_CHECKING:\n    from . import dataclasses\n',
    'pkg/fields.py': 'def Field():\n    return 1\n',
    'pkg/dataclasses.py': 'import dataclasses\nfrom .fields import Field\n\ndef dataclass():\n    return 2\n',
    'tests/test_pkg.py': 'import pkg\n\n@pkg.dataclasses.dataclass()\nclass A:\n    a: int = pkg.dataclasses.Field()\n\ndef test_b():\n    return pkg.dataclasses.dataclass()\n',
  });
  assert.deepEqual(callers('pkg/dataclasses.py', 'dataclass').labels, ['tests/test_pkg.py:test_b', 'tests/test_pkg.py:test_pkg.py']);
  assert.deepEqual(callers('pkg/fields.py', 'Field').labels, ['tests/test_pkg.py:test_pkg.py'], 'a decorator and a class body are the module\'s code');
});

test('a src/ layout: imports by the package name and relative imports resolve', () => {
  const { callers } = indexOf({
    'src/lib/__init__.py': 'from ._core import make\n',
    'src/lib/_core.py': 'def make():\n    return 1\n',
    'src/lib/user.py': 'from . import _core\n\ndef u():\n    return _core.make()\n',
    'tests/test_lib.py': 'import lib\n\ndef test_make():\n    assert lib.make() == 1\n',
  });
  assert.deepEqual(callers('src/lib/_core.py', 'make').labels, ['src/lib/user.py:u', 'tests/test_lib.py:test_make']);
});

test('rules 3 and 4: self./cls. in the class, else an indexed base; super() reaches the first base defining it; nested classes', () => {
  const { callers } = indexOf({
    'm/base.py': 'class Base:\n    def run(self):\n        return 1\n    @classmethod\n    def make(cls):\n        return cls.run(None)\n',
    'm/sub.py': [
      'from m.base import Base',
      'class Mid(Base):',
      '    pass',
      'class Sub(Mid):',
      '    def run(self):',
      '        return super().run()',
      '    def go(self):',
      '        return self.run()',
      '    class Inner:',
      '        def run(self):',
      '            return 2',
      '        def go(self):',
      '            return self.run()',
      'class Other:',
      '    def go(self):',
      '        return self.run()',
      '',
    ].join('\n'),
  });
  assert.deepEqual(callers('m/base.py', 'Base.run').labels, ['m/base.py:Base.make', 'm/sub.py:Sub.run'], 'super() through Mid, cls. in the class');
  assert.deepEqual(callers('m/sub.py', 'Sub.run').labels, ['m/sub.py:Sub.go']);
  assert.deepEqual(callers('m/sub.py', 'Sub.Inner.run').labels, ['m/sub.py:Sub.Inner.go']);
  const sub = callers('m/sub.py', 'Sub.run');
  assert.match(sub.reason, /overrides a base class's `run`, and calls typed as the base may reach it/);
  assert.equal(callers('m/base.py', 'Base.run').unresolved, 1, 'self.run() in Other (no indexed run) is unresolved');
});

test('rule 5: a construction reaches __init__, its own or a base\'s; through an alias and a module; cls(...) makes it incomplete', () => {
  const { callers } = indexOf({
    'k/a.py': 'class A:\n    def __init__(self, x):\n        self.x = x\n\nclass B(A):\n    pass\n\nclass F:\n    def __init__(self):\n        pass\n    @classmethod\n    def new(cls):\n        return cls()\n',
    'k/b.py': 'import k.a as mod\nfrom k.a import A as Alias, B\n\ndef one():\n    return Alias(1)\n\ndef two():\n    return mod.A(2), B(3)\n\ndef three():\n    return A\n',
  });
  const r = callers('k/a.py', 'A.__init__');
  assert.deepEqual(r.labels, ['k/b.py:one', 'k/b.py:two']);
  assert.equal(r.sites, 3);
  assert.match(callers('k/a.py', 'F.__init__').reason, /constructed through `cls\(\.\.\.\)`/);
});

test('rule 6: an annotated parameter (Cls, "Cls", Optional[Cls], Cls | None) or a local assigned Cls(...) in the same function', () => {
  const { callers } = indexOf({
    't/c.py': 'class Client:\n    def send(self):\n        return 1\n',
    't/u.py': [
      'import typing',
      'from typing import Optional',
      'from t.c import Client',
      'import t.c as cm',
      'def a(c: Client): return c.send()',
      'def b(c: "Client"): return c.send()',
      'def c(x: Optional[Client] = None): return x.send()',
      'def d(x: typing.Optional[cm.Client]): return x.send()',
      'def e(x: Client | None): return x.send()',
      'def f():',
      '    x = Client()',
      '    return x.send()',
      'def g():',
      '    x = Client()',
      '    def inner():',
      '        return x.send()',
      '    return inner',
      'def h(x):',
      '    return x.send()',
      'def i(x: list[Client]):',
      '    return x.send()',
      '',
    ].join('\n'),
  });
  const r = callers('t/c.py', 'Client.send');
  assert.deepEqual(r.labels, ['t/u.py:a', 't/u.py:b', 't/u.py:c', 't/u.py:d', 't/u.py:e', 't/u.py:f']);
  assert.equal(r.unresolved, 3, 'a local of another function, an untyped parameter and a generic annotation are not resolved');
});

test('non-rules: Cls.m(...), a call result\'s method, a subscript\'s, a string\'s are unresolved; strings and comments are not code', () => {
  const { callers } = indexOf({
    'n/a.py': 'class K:\n    @staticmethod\n    def m():\n        return 1\n\ndef free():\n    return 0\n',
    'n/b.py': [
      'from n.a import K, free',
      'def u():',
      '    K.m()',
      '    K().m()',
      '    [K()][0].m()',
      '    "x".m()',
      '    s = "free()"',
      '    t = f"{1}"  # free()',
      '    """',
      '    free()',
      '    """',
      '    return 1',
      '',
    ].join('\n'),
  });
  const m = callers('n/a.py', 'K.m');
  assert.deepEqual(m.labels, []);
  assert.equal(m.unresolved, 4);
  assert.deepEqual(callers('n/a.py', 'free').labels, [], 'calls in strings, comments and docstrings are not calls');
});

test('value uses: a callback, a decorator, a dict entry make the answer incomplete; a registration decorator too', () => {
  const { callers } = indexOf({
    'v/a.py': 'def hook():\n    return 1\n\n@app.route("/")\ndef view():\n    return 2\n\n@property_like\ndef other():\n    pass\n',
    'v/b.py': 'from v.a import hook\n\nHANDLERS = {"h": hook}\n\n@hook\ndef decorated():\n    pass\n\ndef register(cb=hook):\n    return run(hook)\n',
  });
  const r = callers('v/a.py', 'hook');
  assert.deepEqual(r.labels, []);
  assert.match(r.reason, /referenced as a value 4 time\(s\)/, 'the dict entry, the decorator, the default value and the argument');
  assert.match(callers('v/a.py', 'view').reason, /registered by a decorator/);
});

test('dunders: a protocol method is incomplete with the reason; __init__ is not', () => {
  const { callers } = indexOf({ 'd/a.py': 'class A:\n    def __init__(self):\n        pass\n    def __len__(self):\n        return 0\n\ndef use(a: A):\n    return a.__len__()\n' });
  const len = callers('d/a.py', 'A.__len__');
  assert.deepEqual(len.labels, ['d/a.py:use']);
  assert.match(len.reason, /called by Python itself \(protocol method\)/);
  assert.doesNotMatch(callers('d/a.py', 'A.__init__').reason, /protocol/);
});

test('properties (A8-D3 (a)): x.prop on a resolved receiver is a use of the getter; x.prop = … of the setter; on an unresolved one, nothing', () => {
  const src = [
    'class R:',
    '    @property',
    '    def size(self):',
    '        return self._s',
    '    @size.setter',
    '    def size(self, v):',
    '        self._s = v',
    '    def grow(self):',
    '        self.size = self.size + 1',
    'def read(r: R):',
    '    return r.size',
    'def anything(r):',
    '    return r.size',
    '',
  ].join('\n');
  const { idx, callers } = indexOf({ 'q/r.py': src });
  const defs = [...idx.byFile.get('q/r.py').byPos.values()].filter((d) => d.name === 'size');
  assert.deepEqual(defs.map((d) => d.property), ['getter', 'setter']);
  const at = (d) => idx.callersOfWithStatus({ file: 'q/r.py', className: 'R', name: 'size', pos: d.namePos }).callers.map((c) => c.label).sort();
  assert.deepEqual(at(defs[0]), ['R.grow', 'read']);
  assert.deepEqual(at(defs[1]), ['R.grow']);
  assert.equal(callers('q/r.py', 'R.grow').labels.length, 0);
});

test('an unresolved call is counted by name; a module that is not indexed is not one', () => {
  const { idx } = indexOf({ 'u/a.py': 'import os\n\ndef run():\n    return 1\n\ndef f(x):\n    x.run()\n    x.y.run()\n    os.run()\n    return os.path.join("a")\n' });
  assert.equal(idx.unresolvedCallsTo({ name: 'run' }), 2);
  assert.equal(idx.unresolvedCallsTo({ name: 'join' }), 0, 'join is no def: never recorded');
});

test('budgets: a file over MAX_FILE_BYTES is not indexed, and the scope note says so', () => {
  const big = `def huge():\n    return 1\n${'#'.repeat(MAX_FILE_BYTES)}\n`;
  const idx = createPythonSyntacticIndex([{ path: 'a.py', text: 'def f():\n    return 1\n' }, { path: 'big.py', text: big }], { scope: 'S', notIndexed: 2 });
  assert.equal(idx.size, 1);
  assert.equal(idx.skipped, 1);
  assert.match(idx.scopeNote(), /^Python callers from syntax only: S, 3 Python file\(s\) not indexed \(1 over 1 MiB\); untyped receivers/);
});

test('the CLI bound (A8-D1 (b)): at limit-1 and at the limit every file; past it the changed files and the files mentioning a changed name', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.py`, size: 10 }));
  const read = (p) => (p === 'f1.py' ? 'from f0 import changed_name\n' : 'x = 1\n');
  const opts = { changedPaths: new Set(['f0.py']), names: new Set(['changed_name']), maxFiles: 5, maxBytes: 1000 };
  for (const n of [4, 5]) {
    const r = pickRepositoryFiles(make(n), read, opts);
    assert.equal(r.bounded, false, `${n} files`);
    assert.equal(r.sources.length, n);
    assert.equal(r.notIndexed, 0);
  }
  const past = pickRepositoryFiles(make(6), read, opts);
  assert.equal(past.bounded, true);
  assert.deepEqual(past.sources.map((s) => s.path), ['f0.py', 'f1.py']);
  assert.equal(past.notIndexed, 4);
  // The byte bound, the same way.
  const bytes = (size) => [{ path: 'f0.py', size }, { path: 'f1.py', size: 10 }, { path: 'f2.py', size: 10 }];
  assert.equal(pickRepositoryFiles(bytes(979), read, opts).bounded, false);
  assert.equal(pickRepositoryFiles(bytes(980), read, opts).bounded, false);
  assert.equal(pickRepositoryFiles(bytes(981), read, opts).bounded, true);
  // The defaults are the agreed ones.
  assert.equal(REPO_MAX_FILES, 3000);
  assert.equal(REPO_MAX_BYTES, 64 * 1024 * 1024);
  const at = (n) => pickRepositoryFiles(Array.from({ length: n }, (_, i) => ({ path: `f${i}.py`, size: 1 })), () => 'x = 1\n', { changedPaths: new Set(['f0.py']), names: new Set(['zz']) });
  assert.equal(at(2999).bounded, false);
  assert.equal(at(3000).bounded, false);
  const over = at(3001);
  assert.equal(over.bounded, true);
  assert.equal(over.sources.length, 1);
  assert.equal(over.notIndexed, 3000);
});

test('through createSyntacticResolver no answer is complete: callers found, none found, a symbol not indexed', async () => {
  const idx = createPythonSyntacticIndex([
    { path: 'a.py', text: 'def f():\n    return 1\n\ndef g():\n    return f()\n' },
    { path: 'test_a.py', text: 'from a import g\n\ndef test_g():\n    assert g()\n' },
  ], { root: '/r', scope: 'S' });
  const resolver = createSyntacticResolver(idx, { isTestPath: (file) => file.includes('test_') });
  const f = await resolver.callerState('/r/a.py', 4);
  assert.equal(f.state, 'resolved');
  assert.deepEqual(f.callers.map((c) => c.label), ['g']);
  assert.equal(f.complete, false);
  const g = await resolver.callerState('/r/a.py', 27);
  assert.deepEqual(g.callers.map((c) => [c.label, c.test]), [['test_g', true]]);
  const t = await resolver.callerState('/r/test_a.py', 'from a import g\n\ndef '.length);
  assert.equal(t.state, 'unknown', 'none found is unknown, never none');
  assert.equal(t.complete, false);
  assert.match(t.reason, /^Python callers from syntax only: S/);
  const missing = await resolver.callerState('/r/nowhere.py', 0);
  assert.equal(missing.complete, false);
});
