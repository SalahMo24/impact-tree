'use strict';
// Run in a child process to exercise Windows path spelling on every CI host.
const assert = require('node:assert/strict');
const ts = require('typescript');
const Module = require('module');
const realFs = require('fs');
const windows = require('path').win32;
const key = file => windows.resolve(file).toLowerCase();
const files = new Map(Object.entries({
  'C:/Repo/base.ts': 'export class Base { save() {} }',
  'C:/Repo/mine.ts': "import { Base } from './base'; export class Mine extends Base { save() {} }\nexport function sameFile(receiver: Mine) { receiver.save(); }",
  'C:/Repo/barrel.ts': "export { Mine as Renamed } from './mine';",
  'C:/Repo/sub.ts': "import { Renamed } from './barrel'; export class Sub extends Renamed {}",
  'C:/Repo/direct.ts': "import { Renamed } from './barrel'; export function direct(receiver: Renamed) { receiver.save(); }",
  'C:/Repo/subclass.ts': "import { Sub } from './sub'; export function subclass(receiver: Sub) { receiver.save(); }",
}).map(([file, text]) => [key(file), text]));
const missing = file => Object.assign(new Error(`Missing fixture: ${file}`), { code: 'ENOENT' });
const fs = { ...realFs,
  readFileSync: file => { if (!files.has(key(file))) throw missing(file); return files.get(key(file)); },
  statSync: file => { if (!files.has(key(file))) throw missing(file); return { isFile: () => true }; },
  realpathSync: file => { if (!files.has(key(file))) throw missing(file); return windows.resolve(file); },
};
const original = Module._load;
Module._load = function(name, ...args) {
  return name === 'path' ? windows : name === 'fs' ? fs : original.call(this, name, ...args);
};
const { createInheritanceFilter } = require('../src/engine/inheritance');
const filter = createInheritanceFilter(ts);
const pos = files.get(key('C:/Repo/mine.ts')).indexOf('save()');
for (const target of ['C:\\Repo\\mine.ts', 'C:/Repo/mine.ts', 'C:/Repo/./mine.ts', 'c:/repo/MINE.ts']) {
  for (const file of ['C:/Repo/direct.ts', 'C:/Repo/subclass.ts', 'C:/Repo/mine.ts']) {
    const start = files.get(key(file)).indexOf('receiver.save') + 'receiver.'.length;
    const caller = { file, callSites: [{ start }] };
    const result = filter.filterAt(target, pos, [caller]);
    assert.equal(result.dropped, 0, `${target}: ${file}`);
    assert.deepEqual(result.kept, [caller]);
  }
}
