#!/usr/bin/env node
'use strict';
// The inheritance filter reads and resolves files off disk, so these fixtures are
// real files in a temp dir rather than in-memory strings -- a stub that answered
// module resolution for us would not be testing the part most likely to be wrong.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { requireTypeScript } = require('./find-typescript');
const ts = requireTypeScript('inheritance');

const { createInheritanceFilter } = require('../src/engine/inheritance');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'it-inherit-'));
const write = (rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
// Offset of a call site: the position of `name` in `receiver.name(`.
const siteOf = (file, snippet, member) => {
  const text = fs.readFileSync(file, 'utf8');
  const i = text.indexOf(snippet);
  if (i === -1) throw new Error(`fixture missing: ${snippet}`);
  const j = text.indexOf(member, i);
  return { start: j, end: j + member.length };
};

// ---------------------------------------------------------------- fixtures
const base = write('base.ts', 'export class Base { async save(x: unknown) {} }\n');
const port = write('port.ts', 'export interface IMine { save(x: unknown): Promise<void>; }\n');
const mine = write('mine.ts',
  "import { Base } from './base';\nimport { IMine } from './port';\n"
  + 'export class Mine extends Base implements IMine { async save(x: unknown) {} }\n');
const other = write('other.ts', "import { Base } from './base';\nexport class Other extends Base {}\n");
const sub = write('sub.ts', "import { Mine } from './mine';\nexport class SubMine extends Mine {}\n");

const callerSibling = write('caller-sibling.ts',
  "import { Other } from './other';\n"
  + 'export class A {\n'
  + '  constructor(private readonly o: Other) {}\n'
  + '  async go() { await this.o.save(1); }\n'
  + '}\n');
const callerDirect = write('caller-direct.ts',
  "import { Mine } from './mine';\n"
  + 'export class B {\n'
  + '  constructor(private readonly m: Mine) {}\n'
  + '  async go() { await this.m.save(1); }\n'
  + '}\n');
const callerPort = write('caller-port.ts',
  "import { IMine } from './port';\n"
  + 'export class C {\n'
  + '  constructor(private readonly m: IMine) {}\n'
  + '  async go() { await this.m.save(1); }\n'
  + '}\n');
const callerSub = write('caller-sub.ts',
  "import { SubMine } from './sub';\n"
  + 'export class D {\n'
  + '  constructor(private readonly m: SubMine) {}\n'
  + '  async go() { await this.m.save(1); }\n'
  + '}\n');
const callerUntyped = write('caller-untyped.ts',
  'export class E {\n'
  + '  async go(thing: any) { await thing.save(1); }\n'
  + '}\n');
const callerMixed = write('caller-mixed.ts',
  "import { Other } from './other';\nimport { Mine } from './mine';\n"
  + 'export class F {\n'
  + '  constructor(private readonly o: Other, private readonly m: Mine) {}\n'
  + '  async go() { await this.o.save(1); await this.m.save(2); }\n'
  + '}\n');

const filter = createInheritanceFilter(ts, { trace: () => {} });
const target = { file: mine, className: 'Mine', name: 'save' };

console.log('▸ lattice');
check('ancestors include the direct base', filter.ancestorsOf(mine, 'Mine').has('Base'));
check('ancestors include the implemented port', filter.ancestorsOf(mine, 'Mine').has('IMine'));
check('an ancestor declaring the method is detected',
  filter.ancestorDeclares(mine, 'Mine', 'save') === true);
check('a method no ancestor declares is not',
  filter.ancestorDeclares(mine, 'Mine', 'notAThing') === false);

console.log('\n▸ receiver typing');
check('reads a constructor-injected member type',
  filter.receiverTypeAt(callerSibling, siteOf(callerSibling, 'this.o.save', 'save').start) === 'Other');

console.log('\n▸ the bug: sibling dispatch is dropped');
{
  const caller = { file: callerSibling, callSites: [siteOf(callerSibling, 'this.o.save', 'save')] };
  check('a call on a sibling that does not declare the method is dropped',
    filter.isSiblingDispatch(target, caller) === true);
}

console.log('\n▸ real edges are kept');
{
  const keep = (name, file, snippet) => {
    const caller = { file, callSites: [siteOf(file, snippet, 'save')] };
    check(name, filter.isSiblingDispatch(target, caller) === false);
  };
  keep('a call on the target class itself', callerDirect, 'this.m.save');
  keep('a call through the port it implements', callerPort, 'this.m.save');
  keep('a call through a subclass of the target', callerSub, 'this.m.save');
  keep('an untyped receiver (undeterminable, so kept)', callerUntyped, 'thing.save');
}

console.log('\n▸ conservative by construction');
{
  // one related site among unrelated ones keeps the whole edge
  const caller = {
    file: callerMixed,
    callSites: [siteOf(callerMixed, 'this.o.save', 'save'), siteOf(callerMixed, 'this.m.save', 'save')],
  };
  check('a caller with one genuine site is kept even if another site is a sibling',
    filter.isSiblingDispatch(target, caller) === false);

  check('no call sites means no judgement', filter.isSiblingDispatch(target, { file: callerSibling, callSites: [] }) === false);
  check('a target with no class is never filtered',
    filter.isSiblingDispatch({ file: mine, className: null, name: 'save' },
      { file: callerSibling, callSites: [siteOf(callerSibling, 'this.o.save', 'save')] }) === false);

  // if nothing above declares the method, there is no inheritance to confuse
  const solo = write('solo.ts', 'export class Solo { async ping() {} }\n');
  const callerSolo = write('caller-solo.ts',
    "import { Solo } from './solo';\nexport class G {\n  constructor(private readonly s: Solo) {}\n  go() { return this.s.ping(); }\n}\n");
  check('a method with no ancestor declaration is never filtered',
    filter.isSiblingDispatch({ file: solo, className: 'Solo', name: 'ping' },
      { file: callerSolo, callSites: [siteOf(callerSolo, 'this.s.ping', 'ping')] }) === false);
}

console.log('\n▸ filterCallers reports what it removed');
{
  const callers = [
    { file: callerSibling, label: 'A.go', callSites: [siteOf(callerSibling, 'this.o.save', 'save')] },
    { file: callerDirect, label: 'B.go', callSites: [siteOf(callerDirect, 'this.m.save', 'save')] },
  ];
  const { kept, dropped } = filter.filterCallers(target, callers);
  check('drops exactly the sibling edge', dropped === 1 && kept.length === 1 && kept[0].label === 'B.go',
    `${dropped} dropped, kept ${kept.map((k) => k.label).join(',')}`);
}

console.log('\n▸ re-export forms through a barrel');
{
  // `T extends Foo`, where Foo is reached through `barrel.ts`. `foo-with.ts` declares a Foo
  // that has `save`; `foo-without.ts` declares one that does not. Which one T inherits
  // from decides whether `save` overrides anything, and so whether a sibling-dispatch
  // caller is dropped.
  const scenario = (tag, barrel, files) => {
    for (const [rel, text] of Object.entries(files)) write(`${tag}/${rel}`, text);
    write(`${tag}/barrel.ts`, barrel);
    const t = write(`${tag}/t.ts`, "import { Foo } from './barrel';\nexport class T extends Foo { async save(x: unknown) {} }\n");
    write(`${tag}/unrelated.ts`, 'export class Unrelated { async save(x: unknown) {} }\n');
    const c = write(`${tag}/caller.ts`,
      "import { Unrelated } from './unrelated';\nexport class K {\n  constructor(private readonly u: Unrelated) {}\n  go() { return this.u.save(1); }\n}\n");
    const f = createInheritanceFilter(ts, { trace: () => {} });
    return {
      declares: f.ancestorDeclares(t, 'T', 'save'),
      dropped: f.isSiblingDispatch({ file: t, className: 'T', name: 'save' },
        { file: c, callSites: [siteOf(c, 'this.u.save', 'save')] }),
    };
  };
  const withSave = 'export class Foo { async save(x: unknown) {} }\n';
  const withoutSave = 'export class Foo { async other() {} }\n';

  // `export * as ns` exports only `ns`; Foo is really the later `export *` one.
  const ns = scenario('ns',
    "export * as ns from './foo-with';\nexport * from './foo-without';\n",
    { 'foo-with.ts': withSave, 'foo-without.ts': withoutSave });
  check('`export * as ns` does not expose the module\'s classes', ns.declares === false && ns.dropped === false,
    `declares=${ns.declares} dropped=${ns.dropped}`);

  // `export { Base as Foo }` must look up Base in the source module.
  const rn = scenario('rename', "export { Base as Foo } from './m';\n",
    { 'm.ts': 'export class Base { async save(x: unknown) {} }\n' });
  check('a renamed re-export is followed under its original name', rn.declares === true && rn.dropped === true,
    `declares=${rn.declares} dropped=${rn.dropped}`);

  // An explicit named re-export beats `export *` whichever comes first.
  const starFirst = scenario('prec-star-first',
    "export * from './foo-with';\nexport { Foo } from './foo-without';\n",
    { 'foo-with.ts': withSave, 'foo-without.ts': withoutSave });
  check('a named re-export wins over an earlier `export *`', starFirst.declares === false && starFirst.dropped === false,
    `declares=${starFirst.declares} dropped=${starFirst.dropped}`);
  const starLast = scenario('prec-star-last',
    "export { Foo } from './foo-without';\nexport * from './foo-with';\n",
    { 'foo-with.ts': withSave, 'foo-without.ts': withoutSave });
  check('a named re-export wins over a later `export *`', starLast.declares === false && starLast.dropped === false,
    `declares=${starLast.declares} dropped=${starLast.dropped}`);

  // A local declaration beats `export *` regardless of order too (already the case).
  const local = scenario('prec-local', "export * from './foo-with';\n" + withoutSave, { 'foo-with.ts': withSave });
  check('a local class wins over `export *`', local.declares === false && local.dropped === false);

  // Cycle of stars still terminates and yields "unknown", which keeps the edge.
  const cyc = scenario('cycle', "export * from './a';\n", { 'a.ts': "export * from './barrel';\n" });
  check('a re-export cycle terminates and keeps the edge', cyc.dropped === false);
}

console.log('\n▸ renamed exports preserve related callers by declaration identity');
{
  write('identity/base.ts', 'export class Base { save() {} }\n');
  write('identity/base-barrel.ts', "export { Base as RenamedBase } from './base';\n");
  const mine = write('identity/mine.ts',
    "import { RenamedBase } from './base-barrel'; export class Mine extends RenamedBase { save() {} }\n"
    + 'export function sameFile(receiver: Mine) { receiver.save(); }\n');
  write('identity/other.ts', "import { Base } from './base'; export class Other extends Base {}\n");
  write('identity/barrel.ts', "export { Mine as Renamed } from './mine';\nexport { Other as RenamedSibling } from './other';\n");
  write('identity/sub.ts', "import { Renamed } from './barrel'; export class Sub extends Renamed {}\n");
  write('identity/sub-barrel.ts', "export { Sub as RenamedSub } from './sub';\n");
  write('identity/second-barrel.ts', "export { Renamed as TwiceRenamed } from './barrel';\n");
  write('identity/unrelated.ts', 'export class Mine { save() {} }\n');
  const f = createInheritanceFilter(ts);
  const target = { file: mine, className: 'Mine', name: 'save' };
  for (const [name, type, module, dropped] of [
    ['a direct call through a renamed export', 'Renamed', './barrel', false],
    ['a direct call through two renamed exports', 'TwiceRenamed', './second-barrel', false],
    ['a subclass extending a renamed export', 'Sub', './sub', false],
    ['a renamed subclass extending a renamed export', 'RenamedSub', './sub-barrel', false],
    ['a base class exported under a different name in the target', 'Base', './base', false],
    ['a renamed base-class receiver', 'RenamedBase', './base-barrel', false],
    ['an unresolved renamed receiver', 'Unknown', './missing', false],
    ['a renamed sibling receiver', 'RenamedSibling', './barrel', true],
    ['an unrelated receiver with the target class name', 'Mine', './unrelated', true],
  ]) {
    const caller = write(`identity/caller-${type}.ts`,
      `import { ${type} } from '${module}'; export function call(receiver: ${type}) { receiver.save(); }\n`);
    const actual = f.isSiblingDispatch(target, { file: caller, callSites: [siteOf(caller, 'receiver.save', 'save')] });
    check(`${name} is ${dropped ? 'dropped' : 'kept'}`, actual === dropped, `dropped=${actual}`);
  }

  const link = path.join(root, 'identity-link');
  fs.symlinkSync(path.dirname(mine), link, 'junction');
  const spellings = [
    ['original', mine],
    ['dot segment', `${path.dirname(mine)}${path.sep}.${path.sep}mine.ts`],
    ['relative', path.relative(process.cwd(), mine)],
    ['symlink', path.join(link, 'mine.ts')],
  ];
  if (path.sep === '\\') {
    spellings.push(['forward slashes', mine.replace(/\\/g, '/')]);
    spellings.push(['different case', mine.toUpperCase()]);
  }
  const pos = siteOf(mine, 'save() {}', 'save').start;
  for (const [spelling, targetFile] of spellings) {
    for (const [kind, callerFile] of [
      ['direct', path.join(root, 'identity/caller-Renamed.ts')],
      ['subclass', path.join(root, 'identity/caller-Sub.ts')],
      ['same file', mine],
    ]) {
      const caller = { file: callerFile, callSites: [siteOf(callerFile, 'receiver.save', 'save')] };
      const { kept, dropped } = f.filterAt(targetFile, pos, [caller]);
      check(`${kind} caller is kept (${spelling} target path)`, dropped === 0 && kept.length === 1,
        `dropped=${dropped}`);
    }
  }
}

{
  let detail = '';
  try {
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'windows-inheritance.js')],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { detail = String(e.stderr || e.message); }
  check('Windows slash and case variants preserve direct, subclass and same-file callers', !detail, detail);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} failure(s)` : '\nall inheritance checks passed');
process.exit(fail ? 1 : 0);
