#!/usr/bin/env node
'use strict';
// Tier A resolution, on synthetic sources held entirely in memory. Fast, and it does
// not depend on whatever the target repo happens to contain -- the measurement
// harness in spike/ covers real code, this pins the behaviours that produce it.
const path = require('path');
const fs = require('fs');

const { requireTypeScript } = require('./find-typescript');
const ts = requireTypeScript('syntactic-index');

const { createSyntacticIndex } = require('../src/engine/syntactic-index');
const { createSyntacticResolver } = require('../src/engine/resolver-syntactic');

const R = '/proj';
const f = (p) => path.join(R, p);
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

// Locate a declaration position the way the engine does, so target positions in the
// assertions are not hand-counted offsets.
function posOf(text, needle) {
  const i = text.indexOf(needle);
  if (i === -1) throw new Error(`fixture is missing ${needle}`);
  return i;
}
const labels = (rows) => rows.map((c) => c.label).sort();

function build(files, opts) {
  return createSyntacticIndex(ts, Object.entries(files).map(([p, text]) => ({ path: f(p), text })),
    { baseDirs: [R, path.join(R, 'src')], ...opts });
}

console.log('▸ bare call through a relative import');
{
  const files = {
    'src/util.ts': 'export function compute(a: number) { return a + 1; }\n',
    'src/use.ts': "import { compute } from './util';\nexport function caller() { return compute(1); }\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/util.ts'), className: null, name: 'compute' });
  check('resolves the import', labels(got).join(',') === 'caller', JSON.stringify(labels(got)));
}

console.log('\n▸ barrel re-export');
{
  const files = {
    'src/deep/impl.ts': 'export function hidden() { return 1; }\n',
    'src/deep/index.ts': "export { hidden } from './impl';\n",
    'src/use.ts': "import { hidden } from './deep';\nexport function viaBarrel() { return hidden(); }\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/deep/impl.ts'), className: null, name: 'hidden' });
  check('follows index.ts to the declaring file', labels(got).join(',') === 'viaBarrel', JSON.stringify(labels(got)));
}

console.log('\n▸ tsconfig paths alias');
{
  const files = {
    'src/lib/thing.ts': 'export function aliased() { return 1; }\n',
    'src/app/use.ts': "import { aliased } from '@lib/thing';\nexport function viaAlias() { return aliased(); }\n",
  };
  const idx = build(files, { tsPaths: { '@lib/*': ['src/lib/*'] }, pathsBase: R });
  const got = idx.callersOf({ file: f('src/lib/thing.ts'), className: null, name: 'aliased' });
  check('resolves @lib/* through tsconfig paths', labels(got).join(',') === 'viaAlias', JSON.stringify(labels(got)));
  const idx2 = build(files);
  check('and finds nothing without the alias map, so the alias is what did it',
    idx2.callersOf({ file: f('src/lib/thing.ts'), className: null, name: 'aliased' }).length === 0);
}

console.log('\n▸ port -> adapter through implements');
{
  const files = {
    'src/port.ts': 'export interface IStore { findLatest(id: string): Promise<void>; }\n',
    'src/adapter.ts': "import { IStore } from './port';\nexport class Store implements IStore { async findLatest(id: string) {} }\n",
    'src/use.ts': "import { IStore } from './port';\nexport class Service {\n  constructor(private readonly store: IStore) {}\n  async run() { await this.store.findLatest('x'); }\n}\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/adapter.ts'), className: 'Store', name: 'findLatest' });
  check('a member typed as the port reaches the adapter',
    labels(got).join(',') === 'Service.run', JSON.stringify(labels(got)));
}

console.log('\n▸ extends chain');
{
  const files = {
    'src/base.ts': 'export class Base { async save(x: unknown) {} }\n',
    'src/mid.ts': "import { Base } from './base';\nexport class Mid extends Base {}\n",
    'src/leaf.ts': "import { Mid } from './mid';\nexport class Leaf extends Mid { async save(x: unknown) {} }\n",
    'src/use.ts': "import { Leaf } from './leaf';\nexport class Caller {\n  constructor(private readonly r: Leaf) {}\n  async go() { await this.r.save(1); }\n}\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/leaf.ts'), className: 'Leaf', name: 'save' });
  check('a call through the subclass reaches its own override',
    labels(got).join(',') === 'Caller.go', JSON.stringify(labels(got)));
  check('Leaf is a transitive subtype of Base', idx.subtypesOf(idx.classKey(f('src/base.ts'), 'Base')).has(idx.classKey(f('src/leaf.ts'), 'Leaf')));
  check('Base is a transitive supertype of Leaf', idx.supertypesOf(idx.classKey(f('src/leaf.ts'), 'Leaf')).has(idx.classKey(f('src/base.ts'), 'Base')));
}

console.log('\n▸ sibling dispatch must NOT be reported');
{
  // This is the oracle bug probe-override.js found: `this.<Other>.save()` is not a
  // call to Mine.save. Asserting the resolver stays precise here is the whole reason
  // its precision beats the TypeScript call hierarchy on inherited members.
  const files = {
    'src/base.ts': 'export class Base { async save(x: unknown) {} }\n',
    'src/mine.ts': "import { Base } from './base';\nexport class Mine extends Base { async save(x: unknown) {} }\n",
    'src/other.ts': "import { Base } from './base';\nexport class Other extends Base {}\n",
    'src/use.ts': "import { Other } from './other';\nexport class Caller {\n  constructor(private readonly o: Other) {}\n  async go() { await this.o.save(1); }\n}\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/mine.ts'), className: 'Mine', name: 'save' });
  check('a sibling subclass call is not attributed to this override',
    got.length === 0, JSON.stringify(labels(got)));
}

console.log('\n▸ CQRS severed edge');
{
  const files = {
    'src/cmd.ts': 'export class DoThing { constructor(public readonly id: string) {} }\n',
    'src/handler.ts': "import { CommandHandler } from '@nestjs/cqrs';\nimport { DoThing } from './cmd';\n@CommandHandler(DoThing)\nexport class DoThingHandler { async execute(c: DoThing) {} }\n",
    'src/caller.ts': "import { DoThing } from './cmd';\nexport class Api {\n  async post() { await this.bus.execute(new DoThing('1')); }\n}\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/handler.ts'), className: 'DoThingHandler', name: 'execute' });
  check('new Command() reaches its handler.execute',
    labels(got).join(',') === 'Api.post', JSON.stringify(labels(got)));
  check('and it is marked as a cqrs edge', got[0] && got[0].via === 'cqrs');
}

console.log('\n▸ CQRS matches by declaration, not bare class name');
{
  const files = {
    'src/a/cmd.ts': 'export class CreateUserCommand {}\n',
    'src/b/cmd.ts': 'export class CreateUserCommand {}\n',
    'src/a/handler.ts': "import { CommandHandler } from '@nestjs/cqrs';\nimport { CreateUserCommand } from './cmd';\n@CommandHandler(CreateUserCommand)\nexport class AHandler { async execute(c: CreateUserCommand) {} }\n",
    'src/b/handler.ts': "import { CommandHandler } from '@nestjs/cqrs';\nimport { CreateUserCommand } from './cmd';\n@CommandHandler(CreateUserCommand)\nexport class BHandler { async execute(c: CreateUserCommand) {} }\n",
    'src/a/api.ts': "import { CreateUserCommand } from './cmd';\nexport class ApiA { post() { this.bus.execute(new CreateUserCommand()); } }\n",
    'src/b/api.ts': "import { CreateUserCommand } from './cmd';\nexport class ApiB { post() { this.bus.execute(new CreateUserCommand()); } }\n",
    'src/c/api.ts': "import { CreateUserCommand } from '@acme/commands';\nexport class ApiC { post() { this.bus.execute(new CreateUserCommand()); } }\n",
  };
  const idx = build(files);
  const of = (cls, file) => idx.callersOfWithStatus({ file: f(file), className: cls, name: 'execute' });
  const a = of('AHandler', 'src/a/handler.ts');
  const b = of('BHandler', 'src/b/handler.ts');
  check('a dispatch reaches only the handler of the command it names (a)',
    labels(a.callers).includes('ApiA.post') && !labels(a.callers).includes('ApiB.post'), JSON.stringify(labels(a.callers)));
  check('a dispatch reaches only the handler of the command it names (b)',
    labels(b.callers).includes('ApiB.post') && !labels(b.callers).includes('ApiA.post'), JSON.stringify(labels(b.callers)));
  check('a dispatch of an unresolvable class is not matched by name', !labels(a.callers).includes('ApiC.post') && !labels(b.callers).includes('ApiC.post'));
  check('and the handler search is reported incomplete', !!a.incompleteReason && !!b.incompleteReason, String(a.incompleteReason));
}

console.log('\n▸ arrow attribution');
{
  const files = {
    'src/t.ts': 'export function target() {}\n',
    'src/use.ts': "import { target } from './t';\n"
      + 'export class S {\n'
      + '  async run() {\n'
      + '    const result = await this.tx(async () => { target(); });\n'
      + '    return result;\n'
      + '  }\n'
      + '}\n',
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/t.ts'), className: null, name: 'target' });
  check('a call inside a callback is attributed to the enclosing method, not the result variable',
    labels(got).join(',') === 'S.run', JSON.stringify(labels(got)));
}
{
  const files = {
    'src/t.ts': 'export function target() {}\n',
    'src/use.ts': "import { target } from './t';\nexport const handler = async () => { target(); };\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/t.ts'), className: null, name: 'target' });
  check('an arrow that IS the initializer takes the variable name',
    labels(got).join(',') === 'handler', JSON.stringify(labels(got)));
}

console.log('\n▸ constructor via new');
{
  const files = {
    'src/thing.ts': 'export class Thing { constructor(a: number) {} }\n',
    'src/use.ts': "import { Thing } from './thing';\nexport function make() { return new Thing(1); }\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/thing.ts'), className: 'Thing', name: 'constructor' });
  check('new X() is an incoming call to the constructor',
    labels(got).join(',') === 'make', JSON.stringify(labels(got)));
}

console.log('\n▸ typed parameter and Promise unwrap');
{
  const files = {
    'src/svc.ts': 'export class Svc { async ping() {} }\n',
    'src/use.ts': "import { Svc } from './svc';\nexport function viaParam(s: Svc) { return s.ping(); }\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/svc.ts'), className: 'Svc', name: 'ping' });
  check('a typed parameter resolves the receiver',
    labels(got).join(',') === 'viaParam', JSON.stringify(labels(got)));
}
{
  const files = {
    'src/svc.ts': 'export class Svc { async ping() {} }\n',
    'src/use.ts': "import { Svc } from './svc';\nexport class C {\n  private s!: Svc | undefined;\n  go() { return this.s.ping(); }\n}\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/svc.ts'), className: 'Svc', name: 'ping' });
  check('`Svc | undefined` unwraps to Svc', labels(got).join(',') === 'C.go', JSON.stringify(labels(got)));
}

console.log('\n▸ tsx');
{
  const files = {
    'src/api.ts': 'export function load() { return 1; }\n',
    'src/Card.tsx': "import { load } from './api';\nexport const Card = () => { const v = load(); return <div>{v}</div>; };\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/api.ts'), className: null, name: 'load' });
  check('a .tsx component is parsed as TSX and its calls are found',
    labels(got).join(',') === 'Card', JSON.stringify(labels(got)));
}

console.log('\n▸ unresolved imports do not invent edges');
{
  const files = {
    'src/use.ts': "import { compute } from 'some-package-we-do-not-have';\nexport function caller() { return compute(1); }\n",
    'src/other.ts': 'export function compute() { return 2; }\n',
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/other.ts'), className: null, name: 'compute' });
  check('an explicitly imported name is not credited to a same-named local declaration',
    got.length === 0, JSON.stringify(labels(got)));
}

console.log('\n▸ chained calls are not bare calls');
{
  // Held-out regression: an unclassifiable receiver used to be recorded as `null`,
  // the same marker as "no receiver at all", so `xs.map(..).filter(..)` matched a
  // top-level function named `filter`.
  const files = {
    'src/f.ts': 'export function filter(x: unknown) { return x; }\n',
    'src/use.ts': 'export function render(xs: number[]) { return xs.map((x) => x).filter((x) => x > 1); }\n',
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/f.ts'), className: null, name: 'filter' });
  check('a chained .filter() is not attributed to a same-named function',
    got.length === 0, JSON.stringify(labels(got)));
}
{
  const files = {
    'src/f.ts': 'export function filter(x: unknown) { return x; }\n',
    'src/use.ts': "import { filter } from './f';\nexport function render() { return filter(1); }\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/f.ts'), className: null, name: 'filter' });
  check('but a genuine bare call still resolves', labels(got).join(',') === 'render', JSON.stringify(labels(got)));
}
{
  const files = {
    'src/f.ts': 'export function load(x: unknown) { return x; }\n',
    'src/use.ts': "import { load } from './f';\nexport async function go() { return (await Promise.resolve()).valueOf(), load(1); }\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/f.ts'), className: null, name: 'load' });
  check('an unrelated unclassifiable receiver nearby does not suppress a real edge',
    labels(got).join(',') === 'go', JSON.stringify(labels(got)));
}

console.log('\n▸ call sites vs callers');
{
  const files = {
    'src/t.ts': 'export function target(a: number) { return a; }\n',
    'src/thrice.ts': "import { target } from './t';\nexport function once() { target(1); target(2); target(3); }\n",
    'src/three.ts': "import { target } from './t';\n"
      + 'export function a() { return target(1); }\n'
      + 'export function b() { return target(2); }\n'
      + 'export function c() { return target(3); }\n',
    'src/top.ts': "import { target } from './t';\nexport const x = target(1);\nexport const y = target(2);\n",
  };
  const idx = build(files);
  const got = idx.callersOf({ file: f('src/t.ts'), className: null, name: 'target' });

  const thrice = got.filter((c) => c.file === f('src/thrice.ts'));
  check('three calls from ONE function are one caller with three call sites',
    thrice.length === 1 && thrice[0].callSites.length === 3,
    `${thrice.length} row(s), ${thrice[0] && thrice[0].callSites.length} site(s)`);

  const three = got.filter((c) => c.file === f('src/three.ts'));
  check('three DIFFERENT functions in one file stay three callers',
    three.length === 3, String(three.length));

  // Regression: a module-scope call had no enclosing callable, so the edge was
  // dropped outright and a real dependency disappeared from the tree.
  const top = got.filter((c) => c.file === f('src/top.ts'));
  check('a module-scope call is attributed to the module, not discarded',
    top.length === 1 && top[0].callSites.length === 2,
    `${top.length} row(s), ${top[0] && top[0].callSites.length} site(s)`);
  check('and it is labelled by file name', top[0] && top[0].label === 'top.ts', top[0] && top[0].label);
}

let pending = Promise.resolve();
console.log('\n▸ `export * as ns` is a namespace, not `export *`');
{
  const a = 'export function f() { return 1; }\n';
  const files = {
    'src/a.ts': a,
    'src/b.ts': "export * as ns from './a';\n",
    'src/c.ts': "import { f } from './b';\nexport function viaName() { return f(); }\n",
    'src/d.ts': "import { ns } from './b';\nexport function viaNamespace() { return ns.f(); }\n",
  };
  const idx = build(files);
  const target = { file: f('src/a.ts'), className: null, name: 'f', pos: posOf(a, 'f()') };
  const got = idx.callersOf(target);
  check('`f` is not exported by the barrel, so importing it by name is no caller',
    !labels(got).includes('viaName'), JSON.stringify(labels(got)));
  check('`ns.f()` through the barrel resolves to the declaration',
    labels(got).join(',') === 'viaNamespace', JSON.stringify(labels(got)));

  // A namespace whose module is outside the source set cannot be followed. The caller
  // search for `f` is then incomplete, never a finished search that found nothing.
  const open = build({
    'src/a.ts': a,
    'src/b.ts': "export * as ns from 'not-in-the-source-set';\n",
    'src/d.ts': files['src/d.ts'],
  });
  const resolver = createSyntacticResolver(open);
  pending = resolver.incomingWithStatus(f('src/a.ts'), target.pos).then((ans) => {
    check('an unfollowable namespace member makes the search incomplete',
      ans.complete === false && /namespace/.test(ans.reason || ''), JSON.stringify(ans));
    const unrelated = build({ ...files, 'src/e.ts': "import { ns } from './b';\nexport function g() { return ns.other(); }\n" });
    check('a call that cannot be the target does not make a followable search incomplete',
      unrelated.callersOfWithStatus(target).incompleteReason == null);
  });
}
console.log('\n▸ overloads: callers attach to the implementation, not a signature');
{
  const lib = [
    'export function pick(a: string): string;',
    'export function pick(a: number): number;',
    'export function pick(a: any): any { return a; }',
    'export function sameFile() { return pick(1); }',
    'export class Box {',
    '  get(a: string): string;',
    '  get(a: number): number;',
    '  get(a: any): any { return a; }',
    '  inside() { return this.get(1); }',
    '}',
    '',
  ].join('\n');
  const idx = build({
    'src/lib.ts': lib,
    'src/use.ts': "import { pick, Box } from './lib';\nexport function crossFile() { return pick('x'); }\nexport function crossMethod(b: Box) { return b.get(2); }\n",
  });
  const fn = idx.callersOf({ file: f('src/lib.ts'), className: null, name: 'pick', pos: posOf(lib, 'pick(a: any)') });
  check('a function overload is called once from each file', labels(fn).join(',') === 'crossFile,sameFile', JSON.stringify(labels(fn)));
  const method = idx.callersOf({ file: f('src/lib.ts'), className: 'Box', name: 'get', pos: posOf(lib, 'get(a: any)') });
  check('a method overload is called once from each file', labels(method).join(',') === 'Box.inside,crossMethod', JSON.stringify(labels(method)));
}
console.log('\n▸ barrel-heavy repository: caller queries stay fast and give the same answers');
{
  // 200 modules of 10 functions, one `export *` barrel each, a root barrel over all of them,
  // and consumers calling through it by name, by alias, through a namespace import and
  // through a re-exported namespace. Generation is deterministic.
  const files = {};
  for (let i = 0; i < 200; i++) {
    const fns = Array.from({ length: 10 }, (_, j) => `export function f${i}_${j}() { return ${j}; }`);
    files[`src/m${i}.ts`] = `${fns.join('\n')}\nfunction h${i}() { return 1; }\nexport { h${i} as pub${i} };\n`;
    files[`src/b${i}.ts`] = `export * from './m${i}';\n`;
  }
  files['src/all.ts'] = Array.from({ length: 200 }, (_, i) => `export * from './b${i}';`).join('\n') + "\nexport * as lib from './b7';\n";
  for (let k = 0; k < 40; k++) {
    const named = Array.from({ length: 20 }, (_, n) => `f${(k * 5 + n * 7) % 200}_${n % 10}`);
    const aliased = Array.from({ length: 10 }, (_, n) => `f${(k * 3 + n * 11) % 200}_${(n + 3) % 10} as a${n}`);
    const pubs = Array.from({ length: 5 }, (_, n) => `pub${(k + n * 13) % 200}`);
    const body = [
      ...named.map((n) => `${n}();`),
      ...aliased.map((n) => `${n.split(' as ')[1]}();`),
      ...pubs.map((n) => `${n}();`),
      ...Array.from({ length: 20 }, (_, n) => `NS.f${(k * 9 + n * 5) % 200}_${(n * 3) % 10}();`),
      'lib.f7_1(); lib.f7_2();',
      'unknown.f1_1();',
    ];
    files[`src/u${k}.ts`] = [
      `import { ${[...named, ...aliased, ...pubs].join(', ')}, lib } from './all';`,
      "import * as NS from './all';",
      `export function user${k}() {\n  ${body.join('\n  ')}\n}`, '',
    ].join('\n');
  }
  const idx = build(files);
  const targets = [];
  for (let i = 0; i < 200; i += 4) {
    targets.push({ file: f(`src/m${i}.ts`), className: null, name: `f${i}_${i % 10}` });
    targets.push({ file: f(`src/m${i}.ts`), className: null, name: `h${i}` });
  }
  targets.push({ file: f('src/m7.ts'), className: null, name: 'f7_1' });
  const started = process.hrtime.bigint();
  const rows = targets.map((t) => ({ t: t.name, ...idx.callersOfWithStatus(t), unresolved: idx.unresolvedCallsTo(t) }));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const signature = require('crypto').createHash('sha1').update(JSON.stringify(rows)).digest('hex');
  if (process.env.PRINT_BARREL_SIGNATURE) console.log(`  signature ${signature} in ${ms.toFixed(0)} ms (${rows.reduce((n, r) => n + r.callers.length, 0)} callers)`);
  // The signature is a SHA-1 over every result of the queries above, recorded from the code
  // before the optimisation (which re-resolved every call), so it pins the answers without
  // a second resolver to maintain in the test.
  check('answers are identical to the unoptimised resolution', signature === '353caecf6c3e56d225d9b5a20f55b3f4cb46a68f', signature);
  check('the fixture exercises barrels, aliases and namespaces', rows.find((r) => r.t === 'f7_1').callers.length >= 2
    && rows.reduce((n, r) => n + r.callers.length, 0) > 20, `${rows.reduce((n, r) => n + r.callers.length, 0)} callers`);
  // Generous for CI: the optimised run takes ~0.2 s here and the unoptimised one ~15 s, so 5 s separates them with a wide margin on both sides.
  check('queries finish within the time budget', ms < 5000, `${ms.toFixed(0)} ms`);
}
pending.then(() => {
  console.log(fail ? `\n${fail} failure(s)` : '\nall syntactic-index checks passed');
  process.exit(fail ? 1 : 0);
});
