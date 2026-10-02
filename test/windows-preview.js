'use strict';
// Run in a child process: inject Windows path semantics without mutating Node's
// own path implementation or the TypeScript loader.
const assert = require('node:assert/strict');
const ts = require('typescript');
const Module = require('module');
const original = Module._load, windows = require('path').win32;
Module._load = function(name, ...args) { return name === 'path' ? windows : original.call(this,name,...args); };
const { analyzeRemote } = require('../src/engine/analyze-remote');
const base = { 'src/t.ts': 'export function target() {}\n', 'src/c.ts': "import { target } from './t';\nexport function caller() { target(); }\n" };
const head = { 'src/t.ts': 'export function target(x: string) {}\n', 'src/c.ts': "import { target } from './t';\nexport function caller() { target('x'); }\n" };
const gh = {
  listPullRequestFiles: async () => ({ files: [
    { path: 'src/t.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' },
    { path: 'src/c.ts', status: 'modified', patch: '@@ -2 +2 @@\n-old\n+new' },
  ] }),
  fileAtRef: async (_, file, ref) => (ref === 'head' ? head : base)[file] ?? null,
};
(async () => {
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: 'C:\\repo' });
  const target = r.allChanged.find((c) => c.label === 'target');
  assert.equal(target.callers.length,1);
  assert.equal(target.callers[0].callState,'updated-at-call');
  assert.equal(target.staleCallers,0);
})().catch((e) => { console.error(e); process.exitCode = 1; });
