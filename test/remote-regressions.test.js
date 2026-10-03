'use strict';
// GitHub pagination, remote analysis, and PR-preview pipeline regressions.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const { ts, root, response, client, CONCURRENCY_CASES, assertConcurrencyWarnings } = require('./bug-regressions-helpers');

test('GitHub pagination, exact caps, rate limits, and unsupported file encoding', async () => {
  const original = global.fetch;
  try {
    const gh = await client();
    global.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      const total = url.includes('/files?') ? 450 : 123;
      return response(200, Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => ({ number: (page - 1) * 100 + i, title: 't', head: { ref: 'f', sha: 'h' }, base: { ref: 'main', sha: 'b' }, filename: `f${i}.ts`, status: 'modified' })));
    };
    assert.equal((await gh.listOpenPullRequests({ owner: 'o', repo: 'r' })).pullRequests.length, 123);
    const files = await gh.listPullRequestFiles({ owner: 'o', repo: 'r' }, 1);
    assert.equal(files.files.length, 300); assert.equal(files.truncated, true);
    global.fetch = async (url) => response(200, Number(new URL(url).searchParams.get('page')) <= 3 ? Array.from({ length: 100 }, () => ({ filename: 'a.ts', status: 'modified' })) : []);
    assert.equal((await gh.listPullRequestFiles({ owner: 'o', repo: 'r' }, 1)).truncated, false);
    global.fetch = async () => response(403, {});
    await assert.rejects(gh.listOpenPullRequests({ owner: 'o', repo: 'r' }), /403/);
    assert.equal(gh.isSignedIn(), true);
    global.fetch = async () => response(200, { encoding: 'none', content: '', size: 2000000 });
    await assert.rejects(gh.fileAtRef({ owner: 'o', repo: 'r' }, 'large.ts', 'head'), /JSON/);
    global.fetch = async () => response(200, { encoding: 'base64', content: Buffer.from('source').toString('base64') });
    assert.equal(await gh.fileAtRef({ owner: 'o', repo: 'r' }, 'a.ts', 'head'), 'source');
    global.fetch = async () => response(401, {});
    await assert.rejects(gh.listOpenPullRequests({ owner: 'o', repo: 'r' }));
    assert.equal(gh.isSignedIn(), false);
  } finally { global.fetch = original; }
});

test('PR analysis uses fresh head and merge base, including remote config inheritance', async () => {
  clearVirtualText();
  const calls = [];
  const pr = { number: 2, headSha: 'fresh', baseSha: 'tip', baseRef: 'main' };
  const texts = {
    'lib/target.ts@merge': 'export function target() { return 0; }\n',
    'lib/target.ts@fresh': 'export function target(required: string) { return 1; }\n',
    'lib/use.ts@fresh': "import { target } from '@lib/target.js'; export function caller() { target(); }\n",
    'lib/use.ts@merge': "import { target } from '@lib/target.js'; export function caller() { target(); }\n",
    'tsconfig.json@fresh': '{"extends":"./tsconfig.base.json"}',
    'tsconfig.base.json@fresh': '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}',
  };
  const gh = {
    getPullRequest: async () => pr,
    mergeBase: async (_, base, head) => { assert.equal(base, 'tip'); assert.equal(head, 'fresh'); return 'merge'; },
    listPullRequestFiles: async () => ({ total: 2, files: ['lib/target.ts','lib/use.ts'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' })) }),
    fileAtRef: async (_, p, ref) => { calls.push(`${p}@${ref}`); return texts[`${p}@${ref}`] ?? null; },
  };
  const result = await analyzeRemote({ ts, gh, slug: {}, pr: { ...pr, headSha: 'stale' }, repoRoot: root });
  assert.equal(result.headSha, 'fresh'); assert.equal(result.base.sha, 'merge');
  assert.equal(calls.some((c) => c.endsWith('@tip') || c.endsWith('@stale')), false);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.allChanged.find((c) => c.label === 'target').callers.map((c) => c.label), ['caller']);
  let reads = 0;
  gh.getPullRequest = async () => ++reads === 1 ? pr : { ...pr, headSha: 'pushed-again' };
  await assert.rejects(analyzeRemote({ ts, gh, slug: {}, pr, repoRoot: root }), /changed while/);
  clearVirtualText();
});

test('remote roots retain separate recursive components beside an ordinary root', async () => {
  const text = 'export function a() { b(); }\nexport function b() { a(); }\nexport function c() { d(); }\nexport function d() { c(); }\nexport function solo() {}\n';
  const gh = { listPullRequestFiles: async () => ({ files: [{ path: 'a.ts', status: 'added', patch: '@@ -0,0 +1,5 @@\n'+text.trimEnd().split('\n').map((l) => '+'+l).join('\n') }] }), fileAtRef: async (_, p) => p === 'a.ts' ? text : null };
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 1, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: root });
  assert.equal(r.allChanged.filter((c) => c.isRoot).length, 3);
  assert.equal(r.allChanged.find((c) => c.label === 'solo').isRoot, true);
  clearVirtualText();
});

test('Windows PR paths preserve updated-call classification', () => {
  require('child_process').execFileSync(process.execPath, [path.join(__dirname,'windows-preview.js')]);
});

test('changed nested helpers and anonymous defaults resolve through the remote pipeline', async () => {
  const text = 'export class K { run() { const helper = () => 1; return helper(); } }\nexport default () => 1;\n';
  const use = "import build from './a'; export function use() { return build(); }\n";
  const gh = {
    listPullRequestFiles: async () => ({ files: ['a.ts','use.ts'].map((p) => ({ path: p, status: 'added', patch: '@@ -0,0 +1,2 @@\n+'+(p==='a.ts'?text:use).trimEnd().split('\n').join('\n+') })) }),
    fileAtRef: async (_,p) => p==='a.ts'?text:p==='use.ts'?use:null,
  };
  const r = await analyzeRemote({ts,gh,slug:{},pr:{number:1,headSha:'head',mergeBaseSha:'base'},repoRoot:root});
  assert.deepEqual(r.allChanged.find((c) => c.simpleName==='helper').callers.map((c) => c.label),['K.run']);
  assert.deepEqual(r.allChanged.find((c) => c.simpleName==='default').callers.map((c) => c.label),['use']);
  clearVirtualText();
});

test('remote workspace metadata is loaded from the pinned head', async () => {
  const metadata=[];
  const files=[{path:'packages/lib/src/api.ts',status:'modified',patch:'@@ -1 +1 @@\n-old\n+new'},
    {path:'apps/web/use.ts',status:'modified',patch:'@@ -1 +1 @@\n-old\n+new'}];
  const r=await analyzeRemote({ts,repoRoot:'/remote',slug:'demo/repo',pr:{number:1,headSha:'head',baseSha:'base',mergeBaseSha:'base'},gh:{
    listPullRequestFiles:async()=>({files}),
    fileAtRef:async(_,file,ref)=>{
      if(file.endsWith('package.json')) { metadata.push([file,ref]); return file==='packages/lib/package.json'?JSON.stringify({name:'@demo/lib',exports:{'./api':'./src/api.ts'}}):null; }
      if(file==='packages/lib/src/api.ts') return ref==='head'?'export function target(x?:string){}':'export function target(){}';
      if(file==='apps/web/use.ts') return "import {target} from '@demo/lib/api'; export function caller(){target();}";
      return null;
    },
  }});
  assert(metadata.some(([file])=>file==='packages/lib/package.json'));
  assert(metadata.every(([,ref])=>ref==='head'));
  assert.deepEqual(r.allChanged.find(c=>c.label==='target').callers.map(c=>c.label),['caller']);
});

test('remote analysis resolves every symbol whatever impactTree.concurrency holds', async () => {
  const pr = { number: 2, headSha: 'head', mergeBaseSha: 'base' };
  const texts = {
    'lib/target.ts@base': 'export function target() { return 0; }\n',
    'lib/target.ts@head': 'export function target(required: string) { return 1; }\n',
    'lib/use.ts@head': "import { target } from './target'; export function caller() { target(); }\n",
    'lib/use.ts@base': "import { target } from './target'; export function caller() { target(); }\n",
  };
  const gh = {
    listPullRequestFiles: async () => ({ total: 2, files: ['lib/target.ts', 'lib/use.ts'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' })) }),
    fileAtRef: async (_, p, ref) => texts[`${p}@${ref}`] ?? null,
  };
  for (const [value, kind] of CONCURRENCY_CASES) {
    clearVirtualText();
    const r = await analyzeRemote({ ts, gh, slug: {}, pr, repoRoot: root, concurrency: value });
    assert.deepEqual(r.allChanged.find((c) => c.label === 'target').callers.map((c) => c.label), ['caller'], String(value));
    assertConcurrencyWarnings(r, kind, value);
  }
  clearVirtualText();
});
