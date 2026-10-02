#!/usr/bin/env node
'use strict';
// Tier A end to end against a stubbed GitHub API: file list, patches and blob text
// are served from memory, so this exercises the real patch parser, symbol diffing,
// syntactic index and resolver without a network or a checkout.
const path = require('path');

const { findTypeScript } = require('./find-typescript');
const ts = findTypeScript();
if (!ts) { console.log('  SKIP no typescript resolvable — tier A checks did NOT run'); process.exit(0); }

const { analyzeRemote } = require('../src/engine/analyze-remote');
const { hunkRangesFromPatch } = require('../src/engine/patch');
const { _clear } = require('../src/engine/textpos');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

console.log('▸ patch -> changed lines');
{
  // three lines of context either side must NOT count as changed
  const patch = [
    '@@ -1,7 +1,8 @@',
    ' const a = 1;',
    ' const b = 2;',
    ' const c = 3;',
    '-const d = 4;',
    '+const d = 44;',
    '+const e = 5;',
    ' const f = 6;',
    ' const g = 7;',
    ' const h = 8;',
  ].join('\n');
  const r = hunkRangesFromPatch(patch);
  check('only the +/- lines are reported', JSON.stringify(r) === '[[4,5]]', JSON.stringify(r));
}
{
  const patch = ['@@ -10,6 +10,3 @@', ' keep', '-gone1', '-gone2', '-gone3', ' keep2', ' keep3'].join('\n');
  const r = hunkRangesFromPatch(patch);
  check('a pure deletion is marked in the gap between surviving lines',
    JSON.stringify(r) === '[[10.5,10.5]]', JSON.stringify(r));
}
{
  const patch = ['@@ -1,2 +1,2 @@', '-x', '+y', '@@ -50,2 +50,2 @@', '-p', '+q'].join('\n');
  const r = hunkRangesFromPatch(patch);
  check('multiple hunks stay separate', JSON.stringify(r) === '[[1,1],[50,50]]', JSON.stringify(r));
  check('no patch yields no ranges', hunkRangesFromPatch(null).length === 0);
}

// ---------------------------------------------------------------- fake GitHub
const REPO = '/ws';
const BASE = {
  'src/store.ts':
    'export class Store {\n'
    + '  async findLatest(id: string): Promise<string> {\n'
    + '    return id;\n'
    + '  }\n'
    + '}\n',
  'src/service.ts':
    "import { Store } from './store';\n"
    + 'export class Service {\n'
    + '  constructor(private readonly store: Store) {}\n'
    + '  async run(id: string) {\n'
    + '    return this.store.findLatest(id);\n'
    + '  }\n'
    + '}\n',
  'src/untouched.ts':
    "import { Store } from './store';\n"
    + 'export class Other {\n'
    + '  constructor(private readonly store: Store) {}\n'
    + '  async go() { return this.store.findLatest("x"); }\n'
    + '}\n',
};
const HEAD = {
  // findLatest gains a required parameter -- a breaking signature change
  'src/store.ts':
    'export class Store {\n'
    + '  async findLatest(id: string, scope: string): Promise<string> {\n'
    + '    return id + scope;\n'
    + '  }\n'
    + '}\n',
  // the service was NOT updated for it: still a one-argument call
  'src/service.ts':
    "import { Store } from './store';\n"
    + 'export class Service {\n'
    + '  constructor(private readonly store: Store) {}\n'
    + '  async run(id: string) {\n'
    + '    return this.store.findLatest(id);\n'
    + '  }\n'
    + '}\n',
  'src/untouched.ts': BASE['src/untouched.ts'],
};

const PR_FILES = [
  {
    filename: 'src/store.ts', status: 'modified', additions: 2, deletions: 2,
    patch: ['@@ -1,5 +1,5 @@', ' export class Store {',
      '-  async findLatest(id: string): Promise<string> {', '-    return id;',
      '+  async findLatest(id: string, scope: string): Promise<string> {', '+    return id + scope;',
      '   }', ' }'].join('\n'),
  },
  {
    // in the PR but with no symbol-level change: it is here to be a caller
    filename: 'src/service.ts', status: 'modified', additions: 1, deletions: 1,
    patch: ['@@ -1,4 +1,4 @@', "-import { Store } from './store';", "+import { Store } from './store';",
      ' export class Service {'].join('\n'),
  },
  { filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b' },
];

const calls = { files: 0, blobs: [] };
const gh = {
  async listPullRequestFiles(slug, number, { max = 300 } = {}) {
    calls.files++;
    return {
      truncated: false,
      total: PR_FILES.length,
      files: PR_FILES.slice(0, max).map((f) => ({
        path: f.filename, oldPath: f.filename, status: f.status, patch: f.patch,
        additions: f.additions, deletions: f.deletions,
      })),
    };
  },
  async fileAtRef(slug, filePath, ref) {
    calls.blobs.push(`${filePath}@${ref}`);
    const src = ref === 'headsha' ? HEAD : BASE;
    return Object.prototype.hasOwnProperty.call(src, filePath) ? src[filePath] : null;
  },
};
const pr = { number: 7, headSha: 'headsha', baseSha: 'basesha', mergeBaseSha: 'basesha', baseRef: 'main' };

(async () => {
  _clear();
  const r = await analyzeRemote({ ts, gh, slug: { owner: 'o', repo: 'r' }, pr, repoRoot: REPO });

  console.log('\n▸ shape');
  check('marked as a tier A result', r.tierA === true && r.coverage === 'pr-files-only');
  check('carries the PR number', r.prNumber === 7);
  check('non-source files are listed',
    r.otherFiles.some((f) => f.path === 'README.md' && !f.noCallable),
    JSON.stringify(r.otherFiles));
  // service.ts changed (an import line) but no callable in it changed. It must still
  // be visible: a review tool that silently omits a changed file is worse than one
  // that shows it with nothing to say about it.
  check('a changed source file with no changed callable is still listed',
    r.otherFiles.some((f) => f.path === 'src/service.ts' && f.noCallable === true),
    JSON.stringify(r.otherFiles.map((f) => f.path)));
  check('every changed source file is reachable somewhere in the result', (() => {
    const shown = new Set([
      ...r.allChanged.map((c) => c.relPath),
      ...r.deleted.map((d) => d.relPath),
      ...r.otherFiles.map((f) => f.path),
    ]);
    return r.changedPaths.every((p2) => shown.has(p2));
  })());
  check('only source files are analysed', r.changedFileCount === 2, String(r.changedFileCount));
  check('test reach is not claimed', r.testReachComputed === false && r.untested.length === 0);

  console.log('\n▸ fetching');
  check('one file-list request', calls.files === 1);
  check('head and base fetched per source file', calls.blobs.filter((c) => !c.includes('tsconfig.json') && !c.includes('package.json')).length === 4, calls.blobs.join(' '));
  check('README was never fetched', !calls.blobs.some((b) => b.startsWith('README')));

  console.log('\n▸ the change');
  const finding = r.findings.find((f) => f.label.includes('findLatest'));
  check('the signature change is a finding', !!finding, r.findings.map((f) => f.label).join(', '));
  check('classified as a new required parameter',
    !!finding && finding.kinds.some((k) => /param/i.test(k.id)),
    finding && finding.kinds.map((k) => k.id).join(','));

  console.log('\n▸ callers, from PR files alone');
  check('the un-updated caller is found',
    !!finding && finding.callers.some((c) => c.label === 'Service.run'),
    finding && finding.callers.map((c) => c.label).join(', '));
  const svc = finding && finding.callers.find((c) => c.label === 'Service.run');
  check('it is reported as stale — the call site was not updated',
    !!svc && svc.callState !== 'updated-at-call', svc && svc.callState);
  check('its file is in the PR, so opening it has a diff to show',
    !!svc && r.changedPaths.includes(path.relative(REPO, svc.file)),
    svc && path.relative(REPO, svc.file));
  check('that file is modified — the badge is M, not the worktree status',
    !!svc && r.fileStatus[path.relative(REPO, svc.file)] === 'modified',
    svc && r.fileStatus[path.relative(REPO, svc.file)]);
  check('staleCallers counts it', !!finding && finding.staleCallers >= 1, finding && String(finding.staleCallers));
  check('a caller in a file the PR does not touch is NOT invented',
    !!finding && !finding.callers.some((c) => c.label === 'Other.go'),
    finding && finding.callers.map((c) => c.label).join(', '));

  console.log('\n▸ honesty about coverage');
  check('a symbol with no in-PR caller reports unknown, not zero callers',
    r.allChanged.every((c) => c.callerState !== 'resolved' || c.callers.length > 0));
  check('text is returned for the diff views',
    r.texts.get('src/store.ts') && r.texts.get('src/store.ts').head.includes('scope: string'));
  check('base text is returned too',
    r.texts.get('src/store.ts') && !r.texts.get('src/store.ts').base.includes('scope: string'));

  console.log('\n▸ nothing read from disk');
  check('paths are workspace-relative but never required to exist',
    r.allChanged.every((c) => c.file.startsWith(path.join(REPO, 'src'))),
    r.allChanged.map((c) => c.file).join(', '));

  console.log('\n▸ empty PR');
  const ghEmpty = {
    async listPullRequestFiles() { return { truncated: false, total: 1, files: [{ path: 'docs/x.md', oldPath: 'docs/x.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] }; },
    async fileAtRef() { return null; },
  };
  const r2 = await analyzeRemote({ ts, gh: ghEmpty, slug: { owner: 'o', repo: 'r' }, pr, repoRoot: REPO });
  check('a docs-only PR yields no findings and says so',
    r2.findings.length === 0 && r2.warnings.some((w) => /no analysable source/.test(w)),
    r2.warnings.join(' | '));
  check('and still lists the file', r2.otherFiles.length === 1);
  check('and still records its status', r2.fileStatus['docs/x.md'] === 'modified', JSON.stringify(r2.fileStatus));

  console.log('\n▸ file status letters');
  const ghStatus = {
    async listPullRequestFiles() {
      return {
        truncated: false, total: 6,
        files: [
          { path: 'added.md', oldPath: 'added.md', status: 'added', patch: '@@ -0,0 +1 @@\n+a' },
          { path: 'gone.md', oldPath: 'gone.md', status: 'removed', patch: '@@ -1 +0,0 @@\n-a' },
          { path: 'now.md', oldPath: 'was.md', status: 'renamed', patch: '@@ -1 +1 @@\n-a\n+b' },
          { path: 'copy.md', oldPath: 'orig.md', status: 'copied', patch: '@@ -0,0 +1 @@\n+a' },
          { path: 'mode.md', oldPath: 'mode.md', status: 'changed', patch: '@@ -1 +1 @@\n-a\n+a' },
          { path: 'same.md', oldPath: 'same.md', status: 'unchanged', patch: null },
        ],
      };
    },
    async fileAtRef() { return null; },
  };
  const rStatus = await analyzeRemote({ ts, gh: ghStatus, slug: { owner: 'o', repo: 'r' }, pr, repoRoot: REPO });
  check('added stays added', rStatus.fileStatus['added.md'] === 'added');
  check('removed becomes deleted', rStatus.fileStatus['gone.md'] === 'deleted', rStatus.fileStatus['gone.md']);
  check('renamed stays renamed', rStatus.fileStatus['now.md'] === 'renamed');
  check('copied is a new path, so added', rStatus.fileStatus['copy.md'] === 'added', rStatus.fileStatus['copy.md']);
  check('a mode-only change is modified', rStatus.fileStatus['mode.md'] === 'modified', rStatus.fileStatus['mode.md']);
  check('unchanged is not rewritten into a letter', rStatus.fileStatus['same.md'] === 'unchanged');

  console.log('\n▸ failure reporting (the bugs that produced an empty tree)');
  {
    // base fetch fails -> every modified file looks added -> zero findings.
    // Silence here is what made this look like "the PR has no findings".
    const ghNoBase = {
      listPullRequestFiles: gh.listPullRequestFiles,
      async fileAtRef(slug, filePath, ref) {
        if (ref !== 'headsha') return null;
        return HEAD[filePath] != null ? HEAD[filePath] : null;
      },
    };
    _clear();
    const r3 = await analyzeRemote({ ts, gh: ghNoBase, slug: { owner: 'o', repo: 'r' }, pr, repoRoot: REPO });
    check('a missing base revision is reported, not silently swallowed',
      r3.warnings.some((w) => /no base revision/.test(w)), r3.warnings.join(' | '));
    check('and the tree is not claimed to be finding-free by accident',
      r3.warnings.length > 0);
  }
  {
    // a head fetch that throws must not also null the base, and must be named
    const ghFlaky = {
      listPullRequestFiles: gh.listPullRequestFiles,
      async fileAtRef(slug, filePath, ref) {
        if (filePath === 'src/service.ts' && ref === 'headsha') throw new Error('502 bad gateway');
        const src = ref === 'headsha' ? HEAD : BASE;
        return Object.prototype.hasOwnProperty.call(src, filePath) ? src[filePath] : null;
      },
    };
    _clear();
    const r4 = await analyzeRemote({ ts, gh: ghFlaky, slug: { owner: 'o', repo: 'r' }, pr, repoRoot: REPO });
    check('a failed fetch names the file and the reason',
      r4.warnings.some((w) => /service\.ts.*502/.test(w)), r4.warnings.join(' | '));
    check('the other file still analyses', r4.allChanged.some((c) => c.label.includes('findLatest')),
      r4.allChanged.map((c) => c.label).join(', '));
    check('skipped files are counted', r4.warnings.some((w) => /could not be fetched at the PR head/.test(w)));
  }
  {
    // the diff views look text up by the relative path, with no leading slash
    _clear();
    const r5 = await analyzeRemote({ ts, gh, slug: { owner: 'o', repo: 'r' }, pr, repoRoot: REPO });
    const keys = [...r5.texts.keys()];
    check('text is keyed by plain relative path, as Uri.parse yields it',
      keys.every((k) => !k.startsWith('/')) && keys.includes('src/store.ts'), keys.join(', '));
  }

  console.log(fail ? `\n${fail} failure(s)` : '\nall tier A checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
