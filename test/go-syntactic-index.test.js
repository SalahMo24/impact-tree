'use strict';
// Go's syntax-only caller index (S4, docs/MULTI_LANGUAGE_PLAN.md; src/languages/go/syntactic-index.js):
// each matched call form, each reason an answer is incomplete, import aliases and dot-imports,
// a cross-package call, pointer and value receivers, and the package mapping by module or by
// suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoSyntacticIndex } = require('../src/languages/go/syntactic-index');
const { modulePathOf } = require('../src/languages/go/provider');

const MOD = [{ dir: '', path: 'example.com/m' }];

const LIB = `package lib

type Client struct {
	inner *Inner
	Base
}

type Inner struct{}

type Base struct{}

type Doer interface {
	Do() error
}

func NewClient() (*Client, error) { return &Client{}, nil }

func (c *Client) Do() error { return c.helper() }

func (c Client) helper() error { return nil }

func (i *Inner) Run() {}

func (b Base) Promoted() {}

func Plain(x int) int { return Plain(x - 1) }
`;

/** The index over `files` (path → text), and the callers of `label` in `file` as [label, sites]. */
function callersOf(files, file, label, options = { modules: MOD }) {
  const idx = createGoSyntacticIndex(Object.entries(files).map(([path, text]) => ({ path, text })), options);
  const def = idx.byFile.get(file).defs.find((d) => d.label === label);
  assert.ok(def, `${label} in ${file}`);
  const answer = idx.callersOfWithStatus({ file, className: def.recvType, name: def.name, pos: def.namePos });
  return { idx, def, answer, rows: answer.callers.map((c) => [c.label, c.callSites.length]).sort() };
}

const user = (body, imports = '"example.com/m/lib"') => `package app

import (
	"fmt"
	${imports}
)

${body}
`;

test('pkg.F( through an import, its alias, and a dot-import; bare F( in the same package', () => {
  const files = {
    'lib/lib.go': LIB,
    'app/a.go': user('func A() { lib.Plain(1); fmt.Println() }'),
    'app/b.go': user('func B() { l.Plain(2) }', 'l "example.com/m/lib"'),
    'app/c.go': user('func C() { Plain(3) }', '. "example.com/m/lib"'),
    'app/d.go': user('func D(lib int) { _ = lib }\n\nfunc E() { other.Plain(4) }', 'other "example.com/elsewhere/lib"'),
  };
  const { rows } = callersOf(files, 'lib/lib.go', 'Plain');
  assert.deepEqual(rows, [['A', 1], ['B', 1], ['C', 1], ['Plain', 1]], 'a call through another module\'s package of the same name is not one');
});

test('a local or parameter shadows the package function and the import', () => {
  const files = {
    'lib/lib.go': LIB,
    'lib/x.go': 'package lib\n\nfunc X(Plain func(int) int) { Plain(1) }\n',
    'app/a.go': user('func A(lib fake) { lib.Plain(1) }'),
  };
  assert.deepEqual(callersOf(files, 'lib/lib.go', 'Plain').rows, [['Plain', 1]]);
});

test('r.M( on the receiver, x.M( on a typed parameter, var x T, x := T{} / &T{}, x := pkg.NewT(), F().M(', () => {
  const files = {
    'lib/lib.go': LIB,
    'app/a.go': user(`func P(c *lib.Client) { c.Do() }

func V() { var c lib.Client; c.Do() }

func L() { c := lib.Client{}; c.Do() }

func R() { c := &lib.Client{}; c.Do() }

func N() { c, err := lib.NewClient(); _ = err; c.Do() }

func F() { lib.NewClient().Do() }`),
  };
  assert.deepEqual(callersOf(files, 'lib/lib.go', '(*Client).Do').rows, [['F', 1], ['L', 1], ['N', 1], ['P', 1], ['R', 1], ['V', 1]]);
  assert.deepEqual(callersOf(files, 'lib/lib.go', '(Client).helper').rows, [['(*Client).Do', 1]], 'a value-receiver method called from a pointer-receiver one');
});

test('s.f.M( through a struct field, a promoted method through an embedded field, a package variable', () => {
  const files = {
    'lib/lib.go': LIB,
    'lib/use.go': 'package lib\n\nvar defaultClient = &Client{}\n\nfunc (c *Client) Touch() { c.inner.Run(); c.Promoted() }\n\nfunc G() { defaultClient.inner.Run() }\n',
  };
  assert.deepEqual(callersOf(files, 'lib/lib.go', '(*Inner).Run').rows, [['(*Client).Touch', 1], ['G', 1]]);
  assert.deepEqual(callersOf(files, 'lib/lib.go', '(Base).Promoted').rows, [['(*Client).Touch', 1]]);
});

test('an untyped receiver is an unresolved call, never a caller; an interface makes a method incomplete', () => {
  const files = {
    'lib/lib.go': LIB,
    'app/a.go': user('func U(x any) { x.Do(); get().Do() }\n\nfunc I(d lib.Doer) { d.Do() }'),
  };
  const { idx, answer, rows } = callersOf(files, 'lib/lib.go', '(*Client).Do');
  assert.deepEqual(rows, []);
  assert.equal(idx.unresolvedCallsTo({ name: 'Do' }), 1, '`get()` is not indexed: its result is not typed');
  assert.match(answer.incompleteReason, /an interface in the indexed files declares `Do` \(lib\.Doer\), and a call through it may reach any implementation \(1 such call\(s\) named Do\)/);
});

test('a function value is not a call and makes the answer incomplete', () => {
  const files = {
    'lib/lib.go': LIB,
    'app/a.go': user('func A() { f := lib.Plain; _ = f; cmd := &Cmd{RunE: lib.Plain}; _ = cmd }'),
  };
  const { answer, rows } = callersOf(files, 'lib/lib.go', 'Plain');
  assert.deepEqual(rows, [['Plain', 1]]);
  assert.match(answer.incompleteReason, /referenced as a value 2 time\(s\)/);
});

test('build-tag variants: a call is matched to each, and each answer says so', () => {
  const files = {
    'd/on.go': '//go:build on\n\npackage d\n\nfunc Config() int { return 1 }\n',
    'd/off.go': '//go:build !on\n\npackage d\n\nfunc Config() int { return 0 }\n',
    'd/use.go': 'package d\n\nfunc Use() int { return Config() }\n',
  };
  const on = callersOf(files, 'd/on.go', 'Config');
  assert.deepEqual(on.rows, [['Use', 1]]);
  assert.match(on.answer.incompleteReason, /other build-tag variants of it in off\.go: a call is matched to each/);
  assert.deepEqual(callersOf(files, 'd/off.go', 'Config').rows, [['Use', 1]]);
});

test('every answer is incomplete with the scope note; the preview adds the package\'s missing files', () => {
  const files = { 'lib/lib.go': LIB };
  const cli = callersOf(files, 'lib/lib.go', 'NewClient', { modules: MOD, scope: 'the module example.com/m (1 Go file(s) indexed)' });
  assert.deepEqual(cli.rows, []);
  assert.equal(cli.answer.incompleteReason, 'Go callers from syntax only: the module example.com/m (1 Go file(s) indexed); calls through an interface or a function value, and receivers whose type is not written, are not resolved');
  const preview = callersOf(files, 'lib/lib.go', 'NewClient', { partialPackages: true });
  assert.match(preview.answer.incompleteReason, /; the package's files outside the pull request were not read$/);
});

test('without modules (the preview) an import names an indexed directory by its suffix', () => {
  const files = {
    'pkg/lib/lib.go': LIB,
    'cmd/a.go': user('func A() { lib.Plain(1) }', '"github.com/o/r/v2/pkg/lib"'),
    'cmd/b.go': user('func B() { lib.Plain(1) }', '"github.com/o/r/v2/pkg/lib"'),
    // Another module's package in a directory of the same name is not the indexed one.
    'cmd/c.go': user('func C() { lib.Plain(1) }', '"github.com/other/x/pkg/lib"'),
  };
  assert.deepEqual(callersOf(files, 'pkg/lib/lib.go', 'Plain', {}).rows, [['A', 1], ['B', 1], ['Plain', 1]]);
});

test('an external test package calls through its import; names in comments, strings and interfaces are not uses', () => {
  const files = {
    'lib/lib.go': LIB,
    'lib/lib_test.go': 'package lib_test\n\nimport "example.com/m/lib"\n\nfunc TestPlain(t *testing.T) {\n\t// Plain(0)\n\t_ = "Plain(1)"\n\tlib.Plain(2)\n}\n',
    'lib/iface.go': 'package lib\n\ntype P interface {\n\tPlain(x int) int\n}\n',
  };
  assert.deepEqual(callersOf(files, 'lib/lib.go', 'Plain').rows, [['Plain', 1], ['TestPlain', 1]]);
});

test('symbolAt and a file over the size limit', () => {
  const { idx, def } = callersOf({ 'lib/lib.go': LIB, 'big.go': `package big\n\n// ${'x'.repeat(1024 * 1024)}\n` }, 'lib/lib.go', '(*Client).Do');
  assert.deepEqual(idx.symbolAt('lib/lib.go', def.namePos), { className: 'Client', name: 'Do' });
  assert.equal(idx.symbolAt('lib/lib.go', def.namePos + 1), null);
  assert.equal(idx.skipped, 1);
  assert.match(idx.scopeNote(), /1 Go file\(s\) not indexed \(1 over 1 MiB\)/);
});

test('modulePathOf reads go.mod', () => {
  assert.equal(modulePathOf('// c\nmodule github.com/cli/cli/v2\n\ngo 1.22\n'), 'github.com/cli/cli/v2');
  assert.equal(modulePathOf('go 1.22\n'), null);
});
