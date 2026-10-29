'use strict';
// Impact paths in a preview (analyzeRemote, opts impactPaths): off by default, and when on,
// computed from the PR's own fetched files with no request beyond the analysis's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');

const ROOT = '/review';
const hunk = (line) => `@@ -${line} +${line} @@\n-old\n+new`;
const TEXTS = {
  'lib/a.ts@base': 'export function target() { return 0; }\n',
  'lib/a.ts@head': 'export function target(required: string) { return 1; }\n',
  'lib/use.ts@base': 'import { target } from "./a";\nexport function useIt() { return target(); }\n',
  'lib/use.ts@head': 'import { target } from "./a";\nexport function useIt() { return target("x"); }\n',
};

function fakeHost() {
  const fetched = [];
  const gh = {
    listPullRequestFiles: async () => ({
      total: 2,
      files: ['lib/a.ts', 'lib/use.ts'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch: hunk(p === 'lib/a.ts' ? 1 : 2) })),
    }),
    fileAtRef: async (_, p, ref) => { fetched.push(`${p}@${ref}`); return TEXTS[`${p}@${ref}`] ?? null; },
  };
  return { gh, fetched };
}

const run = (gh, extra = {}) => analyzeRemote({
  ts, gh, slug: {}, pr: { number: 2, headSha: 'head', mergeBaseSha: 'base' }, repoRoot: ROOT, ...extra,
});

test('preview impact paths are off by default: no field, no warning', async () => {
  clearVirtualText();
  try {
    const r = await run(fakeHost().gh);
    assert.equal(r.impactPaths, undefined);
    assert.equal(r.impactPathsMeta, undefined);
    assert.ok(!r.warnings.some((w) => /impact paths/.test(w)));
  } finally { clearVirtualText(); }
});

test('preview impact paths use only the fetched files, mark callers as a lower bound and warn', async () => {
  clearVirtualText();
  try {
    const off = fakeHost();
    await run(off.gh);
    clearVirtualText();
    const on = fakeHost();
    const r = await run(on.gh, { impactPaths: true });
    assert.deepEqual(on.fetched.sort(), off.fetched.sort(), 'no request beyond the analysis own');
    const target = r.allChanged.find((c) => c.label === 'target');
    const paths = r.impactPaths[`lib/a.ts#${target.namePos}`];
    assert.ok(paths, 'the changed function has impact paths');
    assert.equal(paths.complete, false, 'a lower-bound search is never complete');
    assert.ok(paths.topPaths.length > 0);
    assert.ok(paths.topPaths.every((p) => p.lowerBound === true));
    assert.ok(paths.topPaths.some((p) => p.via.includes('useIt')), 'the walk went through the PR caller');
    assert.equal(r.impactPathsMeta.limits.deadlineMs, 30000);
    assert.ok(r.warnings.some((w) => /impact paths in a preview see only the pull request's own files/.test(w)));
  } finally { clearVirtualText(); }
});

test('preview impact paths take their limits from the option, and reject an invalid one', async () => {
  clearVirtualText();
  try {
    const r = await run(fakeHost().gh, { impactPaths: { maxDepth: 2 } });
    assert.equal(r.impactPathsMeta.limits.maxDepth, 2);
    clearVirtualText();
    await assert.rejects(run(fakeHost().gh, { impactPaths: { maxDepth: 0 } }), RangeError);
  } finally { clearVirtualText(); }
});

test('a preview result keeps the PR file listing for the cards, outside its JSON', async () => {
  clearVirtualText();
  try {
    const r = await run(fakeHost().gh);
    assert.deepEqual(r.listedFiles.files.map((f) => [f.path, f.patch]), [['lib/a.ts', hunk(1)], ['lib/use.ts', hunk(2)]]);
    assert.ok(!Object.keys(r).includes('listedFiles'));
    const { previewFilesOf } = require('../src/session/pr-actions');
    assert.equal(previewFilesOf(r), r.listedFiles);
  } finally { clearVirtualText(); }
});
