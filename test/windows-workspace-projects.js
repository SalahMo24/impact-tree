'use strict';
// Run in a child process: inject Windows path semantics without mutating Node's own
// path implementation. TypeScript names files with `/` on Windows, project dirs use `\`.
const assert = require('node:assert/strict');
const Module = require('module');
const realFs = require('fs');
const original = Module._load, windows = require('path').win32;
const key = (p) => String(p).replace(/\//g, '\\');
const files = new Map([
  ['C:\\Repo\\lib\\tsconfig.json', '{}'], ['C:\\Repo\\app\\tsconfig.json', '{}'],
  ['C:/Repo/app/use.ts', "import {target} from '../lib/api';"],
].map(([p, text]) => [key(p), text]));
const fs = { ...realFs,
  existsSync: (p) => files.has(key(p)) || realFs.existsSync(p),
  readFileSync: (p, ...a) => (files.has(key(p)) ? files.get(key(p)) : realFs.readFileSync(p, ...a)) };
Module._load = function(name, ...args) {
  return name === 'path' ? windows : name === 'fs' ? fs : original.call(this, name, ...args);
};
const { workspaceProjects } = require('../src/engine/workspace-projects');

// `resolved` is what TypeScript would report for the import, in whichever spelling.
const consumersWith = (resolved) => {
  const ts = {
    sys: { readDirectory: () => ['C:\\Repo\\lib\\tsconfig.json', 'C:\\Repo\\app\\tsconfig.json'], readFile: () => '{}' },
    readConfigFile: () => ({ config: {} }),
    parseJsonConfigFileContent: (_raw, _sys, dir) => ({ options: {}, fileNames: dir.endsWith('app') ? ['C:/Repo/app/use.ts'] : [] }),
    createModuleResolutionCache: () => ({}),
    preProcessFile: () => ({ importedFiles: [{ fileName: '../lib/api' }] }),
    resolveModuleName: () => ({ resolvedModule: { resolvedFileName: resolved } }),
  };
  return workspaceProjects(ts, 'C:\\Repo').consumers('C:\\Repo\\lib\\tsconfig.json');
};
assert.deepEqual(consumersWith('C:/Repo/lib/api.ts'), ['C:\\Repo\\app\\tsconfig.json']);
assert.deepEqual(consumersWith('c:/repo/LIB/api.ts'), ['C:\\Repo\\app\\tsconfig.json']);
