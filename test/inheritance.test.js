#!/usr/bin/env node
'use strict';
// The inheritance filter reads and resolves files off disk, so these fixtures are
// real files in a temp dir rather than in-memory strings -- a stub that answered
// module resolution for us would not be testing the part most likely to be wrong.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findTypeScript } = require('./find-typescript');
const ts = findTypeScript();
if (!ts) { console.log('  SKIP no typescript resolvable — inheritance checks did NOT run'); process.exit(0); }

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

fs.rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} failure(s)` : '\nall inheritance checks passed');
process.exit(fail ? 1 : 0);
