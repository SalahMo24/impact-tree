'use strict';
// A changed file of a known language that was not analysed says so (G6,
// docs/MULTI_LANGUAGE_PLAN.md): `otherFiles[i].notAnalysed = { language, reason }`. The row
// model makes it amber and counts it toward "needs attention", the renderer and the Details
// page give the reason, a Preview lists every Go file as not analysed and says so in its
// limits note, and the command line prints a section for them. Engine-side reasons (a
// rejected prepare, a file the server gave no symbols for) are in typescript-provider.test.js
// and server-symbols.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('./vscode-stub');
const { ts, root } = require('./bug-regressions-helpers');
const { analyzeRemote } = require('../src/engine/analyze-remote');
const { clearVirtualText } = require('../src/engine/textpos');
const { renderTreeItem } = require('../src/tree-item-renderer');
const { buildDetailHtml } = require('../src/detail-panel-html');
const models = require('../src/tree-row-models');
const tree = require('../src/review-tree-model');

const uriOf = (file, pos) => (file ? `uri:${file}${pos == null ? '' : `#${pos}`}` : null);
const GO = { language: 'Go', reason: 'the Go language server gave no symbols' };
const resultOf = (extra = {}) => ({
  allChanged: [], deleted: [], outside: [], warnings: [], unanalysable: [], testReachComputed: true, reachDepth: 2,
  changedFileCount: 2, fileStatus: { 'a.go': 'modified', 'README.md': 'modified' },
  otherFiles: [{ path: 'a.go', status: 'modified', noCallable: true, notAnalysed: GO }, { path: 'README.md', status: 'modified', noCallable: true }],
  ...extra,
});
const rowsOf = (result) => tree.buildFileRows(result, { uriOf, absPath: (p) => `/r/${p}` });
const rowFor = (result, relPath) => rowsOf(result).rows.find((r) => r.relPath === relPath);
const view = { rowDetail: 'hover', iconMode: 'file', checkedOf: () => false };
const AMBER = models.LEVEL_TONES[1];

test('a not-analysed file row is amber level 1 and counts toward attention; a plain file does not', () => {
  const result = resultOf();
  const { rows, decorations } = rowsOf(result);
  const go = rows.find((r) => r.relPath === 'a.go');
  const doc = rows.find((r) => r.relPath === 'README.md');
  assert.deepEqual(go.notAnalysed, GO);
  assert.equal(go.level, 1);
  assert.equal(go.attention, 1);
  assert.equal(doc.level, 5, 'a file with no call graph stays quiet');
  assert.equal(doc.notAnalysed, undefined);
  assert.deepEqual(rows.map((r) => r.relPath), ['a.go', 'README.md'], 'the not-analysed file sorts first');
  assert.equal(tree.needsAttention(go), true);
  assert.equal(tree.needsAttention(doc), false);
  assert.deepEqual(tree.countReview(rows, () => false), { total: 2, left: 2, attention: 1 });
  assert.deepEqual(tree.listAttentionLeft(rows, () => false).map((r) => r.relPath), ['a.go']);
  assert.deepEqual(tree.listAttentionLeft(rows, (r) => r.relPath === 'a.go').map((r) => r.relPath), [], 'reviewing it clears it');
  assert.deepEqual(tree.filterFileRows(rows, 'attention', () => false).map((e) => e.file.relPath), ['a.go']);
  const tip = decorations.find((d) => d.uri === 'uri:/r/a.go');
  assert.match(tip.tooltip, /Go: not analysed — the Go language server gave no symbols/);
});

test('the renderer shows "not analysed" in amber with the reason in the tooltip', () => {
  const result = resultOf();
  const go = renderTreeItem(vscode, rowFor(result, 'a.go'), view);
  assert.match(go.description, /^not analysed/);
  assert.doesNotMatch(go.description, /no call graph/);
  assert.equal(go.iconPath.id, AMBER.fileIcon);
  assert.equal(go.iconPath.color.id, AMBER.color);
  assert.match(go.tooltip.value, /Go: not analysed — the Go language server gave no symbols/);
  const doc = renderTreeItem(vscode, rowFor(result, 'README.md'), view);
  assert.match(doc.description, /^no call graph/);
  assert.notEqual(doc.iconPath && doc.iconPath.color && doc.iconPath.color.id, AMBER.color);
});

test('Details gives the reason for a not-analysed file and nothing for a plain one', () => {
  const result = resultOf();
  const text = (row) => buildDetailHtml(row, { result, nonce: 'bm9uY2U=', cspSource: 'https://webview.test' })
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text(rowFor(result, 'a.go')), /Not analysed\. Go: the Go language server gave no symbols\. Nothing was established about this file/);
  assert.doesNotMatch(text(rowFor(result, 'README.md')), /Not analysed/);
});

test('the preview note names the languages the preview cannot analyse, only when the PR has such files', () => {
  assert.equal(models.previewLimitsNote(resultOf({ otherFiles: [] })), models.PREVIEW_LIMITS_NOTE);
  assert.equal(models.previewLimitsNote(resultOf()),
    `${models.PREVIEW_LIMITS_NOTE} Go files are not analysed; check out the PR to analyse them in the editor.`);
  const notice = models.buildNoticeRows(resultOf({ tierA: true })).find((r) => /^Preview/.test(r.label));
  assert.match(notice.desc, /Go files are not analysed/);
  const tierA = resultOf({ tierA: true });
  const details = buildDetailHtml(rowFor(tierA, 'README.md'), { result: tierA, nonce: 'bm9uY2U=', cspSource: 'x' });
  assert.match(details, /Go files are not analysed/);
});

test('a preview lists every Go file as not analysed, with the preview reason, and leaves TypeScript alone', async () => {
  clearVirtualText();
  const texts = { 'src/a.ts@head': 'export function a() { return 2; }\n', 'src/a.ts@base': 'export function a() { return 1; }\n' };
  const patch = '@@ -1 +1 @@\n-old\n+new';
  const gh = {
    listPullRequestFiles: async () => ({ total: 4, files: ['src/a.ts', 'cmd/main.go', 'cmd/main_test.go', 'docs/x.md'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch })) }),
    fileAtRef: async (_, p, ref) => texts[`${p}@${ref}`] ?? null,
  };
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 3, headSha: 'head', mergeBaseSha: 'base', baseRef: 'main' }, repoRoot: root });
  const by = Object.fromEntries(r.otherFiles.map((f) => [f.path, f.notAnalysed]));
  const reason = 'a preview cannot analyse Go; check out the pull request to analyse it in the editor';
  assert.deepEqual(by, { 'cmd/main.go': { language: 'Go', reason }, 'cmd/main_test.go': { language: 'Go', reason }, 'docs/x.md': undefined });
  assert.equal(r.otherFiles.some((f) => f.path === 'src/a.ts' && f.notAnalysed), false, 'TypeScript is analysed');
  assert.ok(!('notAnalysed' in r.otherFiles.find((f) => f.path === 'docs/x.md')));
  assert.equal(r.allChanged.some((c) => c.relPath.endsWith('.go')), false);
  clearVirtualText();
});

test('a preview of only Go files still lists them as not analysed', async () => {
  const gh = {
    listPullRequestFiles: async () => ({ total: 1, files: [{ path: 'main.go', oldPath: 'main.go', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] }),
    fileAtRef: async () => null,
  };
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 3, headSha: 'head', mergeBaseSha: 'base', baseRef: 'main' }, repoRoot: root });
  assert.equal(r.otherFiles[0].notAnalysed.language, 'Go');
  assert.match(r.otherFiles[0].notAnalysed.reason, /^a preview cannot analyse Go/);
});

test('the command line lists not-analysed Go files in their own section, and --json carries the field', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-not-analysed-')));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/m\n\ngo 1.22\n');
    fs.writeFileSync(path.join(dir, 'a.go'), 'package m\n\nfunc A() int { return 1 }\n');
    git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'a.go'), 'package m\n\nfunc A() int { return 2 }\n');
    git('commit', '-qam', 'head');
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const args = ['--repo', dir, '--allow-local-base'];
    const text = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.match(text, /⑤ NOT ANALYSED/);
    assert.match(text, /\? a\.go {3}Go: Go needs the editor's language server; open the repository in the editor to analyse it/);
    const json = JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' }));
    assert.deepEqual(json.otherFiles.find((f) => f.path === 'a.go').notAnalysed,
      { language: 'Go', reason: "Go needs the editor's language server; open the repository in the editor to analyse it" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
