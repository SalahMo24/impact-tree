'use strict';
// Syntactic-index caller resolution: imports, shadowing, statics, and class identity.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createSyntacticIndex } = require('../src/engine/syntactic-index');
const { ts, root, build, saveCallers, holder } = require('./bug-regressions-helpers');

for (const [name, source, extra] of [
  ['renamed import', "import { target as run } from './target'; export function caller() { run(); }"],
  ['namespace import', "import * as api from './target'; export function caller() { api.target(); }"],
  ['ESM extension', "import { target } from './target.js'; export function caller() { target(); }"],
  ['default import', "import run from './target'; export function caller() { run(); }"],
  ['require namespace', "const api = require('./target'); export function caller() { api.target(); }"],
  ['require destructuring', "const { target: run } = require('./target'); export function caller() { run(); }"],
  ['renamed barrel', "import { run } from './barrel'; export function caller() { run(); }", { 'barrel.ts': "export { target as run } from './target';" }],
]) test(`syntax resolution: ${name}`, () => {
  const idx = build({ 'target.ts': 'export default function target() {}', 'caller.ts': source, ...extra });
  assert.deepEqual(idx.callersOf({ file: '/review/target.ts', name: 'target' }).map((c) => c.label), ['caller']);
});

test('lexical shadowing and reused parameter names do not invent or lose calls', () => {
  const idx = build({
    'target.ts': 'export function target() {} export class Store { save() {} } export class Other { save() {} }',
    'caller.ts': "import { target, Store, Other } from './target'; function first(repo: Store) { repo.save(); } function second(repo: Other) { repo.save(); } function shadow(target: () => void) { target(); }",
  });
  assert.deepEqual(idx.callersOf({ file: '/review/target.ts', className: 'Store', name: 'save' }).map((c) => c.label), ['first']);
  assert.deepEqual(idx.callersOf({ file: '/review/target.ts', name: 'target' }), []);
});

test('aliased and namespace class imports resolve receivers and constructors', () => {
  const idx = build({
    'store.ts': 'export class Store { constructor() {} save() {} }',
    'use.ts': "import { Store as Renamed } from './store'; import * as api from './store'; function named(repo: Renamed) { repo.save(); } function namespaced(repo: api.Store) { repo.save(); } function construct() { return new api.Store(); }",
  });
  assert.deepEqual(idx.callersOf({file:'/review/store.ts',className:'Store',name:'save'}).map((c)=>c.label), ['named','namespaced']);
  assert.deepEqual(idx.callersOf({file:'/review/store.ts',className:'Store',name:'constructor'}).map((c)=>c.label), ['construct']);
});

test('workspace package exports connect preview callers without guessing unrelated names', () => {
  const files = [
    {path:'/repo/packages/shared/src/api.ts', text:'export function target(){}'},
    {path:'/repo/apps/web/use.ts', text:"import { target as run } from '@demo/shared/api'; export function caller(){run();}"},
    {path:'/repo/apps/web/other.ts', text:"import { target } from '@other/shared/api'; export function unrelated(){target();}"},
  ];
  for (const exports of [ {'./api': './src/api.ts'}, {'./*': {types:'./src/*.ts',import:'./src/*.ts'} } ]) {
    const idx=createSyntacticIndex(ts,files,{packages:[{dir:'/repo/packages/shared',data:{name:'@demo/shared',exports}}]});
    assert.deepEqual(idx.callersOf({file:files[0].path,name:'target'}).map(c=>c.label),['caller']);
  }
  const hidden=createSyntacticIndex(ts,files,{packages:[{dir:'/repo/packages/shared',data:{name:'@demo/shared',exports:{'./different':'./src/api.ts'}}}]});
  assert.deepEqual(hidden.callersOf({file:files[0].path,name:'target'}),[]);
});

test('static class calls follow class bindings, not instances or shadowed names', () => {
  const idx=build({
    'store.ts':'export class Store { static save() {} load() {} }',
    'other.ts':'export class Store { static save() {} }',
    'use.ts':`import { Store as DB } from './store'; import { Store } from './other';
      export function caller(){ DB.save(); }
      export function unrelated(){ Store.save(); }
      export function shadowed(DB: {save():void}){ DB.save(); }
      export function instance(){const db=new DB(); db.save();}
      export function invalid(){DB.load();}`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'save'}).map(c=>c.label),['caller']);
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'load'}),[]);
});

test('static namespace and inherited calls keep static and instance this separate', () => {
  const idx=build({
    'store.ts':`export class Store { static save() {} static own(){this.save();} wrong(){this.save();} }
      export class Child extends Store { static parent(){super.save();} }`,
    'use.ts':`import * as api from './store'; import {Child} from './store';
      export function namespace(){api.Store.save();}
      export function inherited(){Child.save();}
      export function shadowed(api:any){api.Store.save();}`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'save'}).map(c=>c.label).sort(),
    ['Store.own','Child.parent','namespace','inherited'].sort());
});

test('workspace conditional exports use the module format TypeScript gives the importer', () => {
  // Real TypeScript on disk is the oracle: a `.ts` importer is CommonJS unless its nearest
  // package.json says `"type": "module"`, and a CommonJS import takes the `require` condition.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-exports-mode-'));
  const K = ts.ModuleKind, R = ts.ModuleResolutionKind;
  const lib = path.join(dir, 'node_modules', '@demo', 'lib');
  const libData = { name: '@demo/lib', exports: { import: './esm.ts', require: './cjs.ts' } };
  const app = path.join(dir, 'app');
  const seen = new Set();
  try {
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify(libData));
    for (const f of ['esm.ts', 'cjs.ts']) fs.writeFileSync(path.join(lib, f), 'export function target(){}');
    for (const [label, options] of [
      ['nodenext', { module: K.NodeNext, moduleResolution: R.NodeNext }],
      ['node16', { module: K.Node16, moduleResolution: R.Node16 }],
      ['bundler', { module: K.ESNext, moduleResolution: R.Bundler }],
    ]) for (const type of ['module', 'commonjs', null]) for (const ext of ['.ts', '.mts', '.cts']) {
      fs.rmSync(app, { recursive: true, force: true });
      fs.mkdirSync(app);
      const appData = type ? { type } : null;
      if (appData) fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(appData));
      const importer = path.join(app, 'use' + ext);
      const text = "import { target } from '@demo/lib'; export function caller(){ target(); }";
      fs.writeFileSync(importer, text);
      const opts = { ...options, noLib: true, types: [], noEmit: true };
      const sf = ts.createProgram([importer], opts).getSourceFile(importer);
      const mode = ts.getModeForUsageLocation(sf, sf.statements[0].moduleSpecifier, opts);
      const real = ts.resolveModuleName('@demo/lib', importer, opts, ts.sys, undefined, undefined, mode).resolvedModule;
      const where = `${label} ${type} ${ext}`;
      assert(real, `oracle resolved nothing for ${where}`);
      const expected = path.basename(real.resolvedFileName);
      seen.add(expected);
      const files = ['esm.ts', 'cjs.ts'].map((f) => ({ path: path.join(lib, f), text: 'export function target(){}' }))
        .concat({ path: importer, text });
      const packages = [{ dir: lib, data: libData }].concat(appData ? [{ dir: app, data: appData }] : []);
      const idx = createSyntacticIndex(ts, files, { packages, moduleOptions: new Map([[importer, opts]]) });
      const hits = files.slice(0, 2).filter((f) => idx.callersOf({ file: f.path, name: 'target' }).length).map((f) => path.basename(f.path));
      assert.deepEqual(hits, [expected], where);
    }
    // The matrix must exercise both conditions, or it cannot tell them apart.
    assert.deepEqual([...seen].sort(), ['cjs.ts', 'esm.ts']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an explicit require takes the require condition in any importer', () => {
  const files=[
    {path:'/repo/lib/esm.ts',text:'export function target(){}'},
    {path:'/repo/lib/cjs.ts',text:'export function target(){}'},
    {path:'/repo/app/use.ts',text:"import {target} from '@demo/lib'; const {target: other}=require('@demo/lib'); export function esm(){target();} export function cjs(){other();}"},
  ];
  const idx=createSyntacticIndex(ts,files,{packages:[{dir:'/repo/lib',data:{name:'@demo/lib',exports:{import:'./esm.ts',require:'./cjs.ts'}}},{dir:'/repo/app',data:{type:'module'}}]});
  assert.deepEqual(idx.callersOf({file:files[0].path,name:'target'}).map(c=>c.label),['esm']);
  assert.deepEqual(idx.callersOf({file:files[1].path,name:'target'}).map(c=>c.label),['cjs']);
});

test('every local that shadows an import hides it from static and bare calls', () => {
  const idx=build({
    'store.ts':'export class Store { static save() {} } export function target() {}',
    'use.ts':`import { Store, target } from './store';
      export function ok(){ Store.save(); target(); }
      export function param({ Store, target }: any){ Store.save(); target(); }
      export function nested([, { Store, target }]: any){ Store.save(); target(); }
      export function loop(xs: any[]){ for (const { Store, target } of xs) { Store.save(); target(); } }
      export function caught(){ try {} catch ({ Store, target }) { Store.save(); target(); } }
      export function clause(x: number){ switch (x) { case 1: const Store = make(), target = make(); break; default: Store.save(); target(); } }
      export function hoisted(x: boolean){ if (x) { var Store = make(), target = make(); } Store.save(); target(); }
      export function local(){ class Store { static save() {} } function target() {} Store.save(); target(); }
      export const named = function Store(){ Store.save(); };`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',className:'Store',name:'save'}).map(c=>c.label),['ok']);
  assert.deepEqual(idx.callersOf({file:root+'/store.ts',name:'target'}).map(c=>c.label),['ok']);
});

test('typed locals in switch clauses and hoisted vars keep their receiver type', () => {
  const idx=build({
    'svc.ts':'export class Svc { run() {} }',
    'use.ts':`import { Svc } from './svc';
      export function inCase(x: number){ switch (x) { case 1: const s: Svc = get(); s.run(); } }
      export function inDefault(x: number){ switch (x) { default: const s = new Svc(); s.run(); } }
      export function otherClause(x: number){ switch (x) { case 1: const s: Svc = get(); break; case 2: s.run(); } }
      export function hoistedVar(x: boolean){ if (x) { var s: Svc = get(); } s.run(); }`,
  });
  assert.deepEqual(idx.callersOf({file:root+'/svc.ts',className:'Svc',name:'run'}).map(c=>c.label).sort(),
    ['hoistedVar','inCase','inDefault','otherClause']);
});

test('a same-named unrelated class does not hide a real caller through inheritance', () => {
  const idx = build({
    'a/base.ts': 'export class Base { save() {} }',
    'a/user-repo.ts': "import { Base } from './base'; export class UserRepo extends Base {}",
    'z/user-repo.ts': 'export class UserRepo { save() {} }',
    'c/svc.ts': holder("import { UserRepo } from '../a/user-repo';", 'UserRepo'),
  });
  assert.deepEqual(saveCallers(idx, 'a/base.ts', 'Base'), ['Svc.run']);
});

test('a same-named class elsewhere does not invent a caller of an unrelated class', () => {
  const idx = build({
    'a/repo.ts': 'export class Repo { save() {} }',
    'b/base.ts': 'export class Base { save() {} }',
    'b/repo.ts': "import { Base } from './base'; export class Repo extends Base {}",
    'c/u.ts': holder("import { Base } from '../b/base';", 'Base'),
  });
  assert.deepEqual(saveCallers(idx, 'a/repo.ts', 'Repo'), []);
  assert.deepEqual(saveCallers(idx, 'b/base.ts', 'Base'), ['Svc.run']);
});

test('two same-named hierarchies each reach only their own callers', () => {
  const idx = build({
    'a/base.ts': 'export class Base { save() {} }',
    'a/repo.ts': "import { Base } from './base'; export class Repo extends Base {}",
    'b/base.ts': 'export class Base { save() {} }',
    'b/repo.ts': "import { Base } from './base'; export class Repo extends Base {}",
    'c/ua.ts': holder("import { Repo } from '../a/repo';", 'Repo', 'UserA'),
    'c/ub.ts': holder("import { Repo } from '../b/repo';", 'Repo', 'UserB'),
  });
  assert.deepEqual(saveCallers(idx, 'a/base.ts', 'Base'), ['UserA.run']);
  assert.deepEqual(saveCallers(idx, 'b/base.ts', 'Base'), ['UserB.run']);
});

test('a caller typed as the port still finds the adapter, not a same-named adapter elsewhere', () => {
  const idx = build({
    'a/port.ts': 'export interface Port { save(): void; }',
    'a/adapter.ts': "import { Port } from './port'; export class Adapter implements Port { save() {} }",
    'b/adapter.ts': 'export class Adapter { save() {} }',
    'c/svc.ts': holder("import { Port } from '../a/port';", 'Port'),
  });
  assert.deepEqual(saveCallers(idx, 'a/adapter.ts', 'Adapter'), ['Svc.run']);
  assert.deepEqual(saveCallers(idx, 'b/adapter.ts', 'Adapter'), []);
});

const externalImpl = { 'a/impl.ts': "import { Port } from 'external-lib'; export class Impl implements Port { save() {} }", 'c/svc.ts': holder("import { Port } from 'external-lib';", 'Port') };

test('a heritage parent outside the source set still links by its name', () => {
  assert.deepEqual(saveCallers(build(externalImpl), 'a/impl.ts', 'Impl'), ['Svc.run']);
});

test('an unresolved name never meets a same-named class that is in the source set', () => {
  const idx = build({
    ...externalImpl,
    'b/port.ts': 'export interface Port { save(): void; }',
    'c/other.ts': holder("import { Port } from '../b/port';", 'Port', 'Other'),
  });
  assert.deepEqual(saveCallers(idx, 'a/impl.ts', 'Impl'), ['Svc.run']);
});

test('this and super calls reach only the base class the subclass actually extends', () => {
  const idx = build({
    'a/base.ts': 'export class Base { save() {} }',
    'b/base.ts': 'export class Base { save() {} }',
    'c/child.ts': "import { Base } from '../a/base'; export class Child extends Base { run() { this.save(); } again() { super.save(); } }",
  });
  assert.deepEqual(saveCallers(idx, 'a/base.ts', 'Base').sort(), ['Child.again', 'Child.run']);
  assert.deepEqual(saveCallers(idx, 'b/base.ts', 'Base'), []);
});

test('a CQRS handler is not confused with a same-named class elsewhere', () => {
  const idx = build({
    'a/cmd.ts': 'export class DoThing {}',
    'a/handler.ts': "import { CommandHandler } from '@nestjs/cqrs'; import { DoThing } from './cmd'; @CommandHandler(DoThing) export class Handler { execute() {} }",
    'b/handler.ts': 'export class Handler { execute() {} }',
    'c/api.ts': "import { DoThing } from '../a/cmd'; export class Api { post() { this.bus.execute(new DoThing()); } }",
  });
  const executeCallers = (file) => idx.callersOf({ file: path.join(root, file), className: 'Handler', name: 'execute' }).map((c) => c.label);
  assert.deepEqual(executeCallers('a/handler.ts'), ['Api.post']);
  assert.deepEqual(executeCallers('b/handler.ts'), []);
});
