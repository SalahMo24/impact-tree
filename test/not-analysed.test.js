'use strict';
// A changed file of a known language that was not analysed says so (G6,
// docs/MULTI_LANGUAGE_PLAN.md): `otherFiles[i].notAnalysed = { language, reason }`. The row
// model makes it amber and counts it toward "needs attention", the renderer and the Details
// page give the reason, a Preview lists every file of a language without `prepareSyntactic`
// as not analysed and says so in its limits note, and the command line prints a section for
// them. Go has the hook since S3, so those tests use a Go provider without it
// (`withoutSyntacticGo`); Go read from its text is tested at the end and in go-syntactic.test.js. Engine-side reasons (a
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
const { LANGUAGES, useLanguagesForTest } = require('../src/languages');

/** Registers Go without `prepareSyntactic` (a language with no text analysis) until the returned function is called. */
const withoutSyntacticGo = () => useLanguagesForTest(LANGUAGES.map((l) => (l.id === 'go' ? { ...l, prepareSyntactic: undefined } : l)));
// The same, for a command line run in a child process (`node --require`).
const WITHOUT_SYNTACTIC_GO = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'languages'))}).useLanguagesForTest(require(${JSON.stringify(path.join(__dirname, '..', 'src', 'languages'))}).LANGUAGES.map((l) => (l.id === 'go' ? { ...l, prepareSyntactic: undefined } : l)));\n`;

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

test('a file of a language no provider analyses names it, quietly, and is not mistaken for docs', () => {
  const result = resultOf({
    changedFileCount: 3, fileStatus: { 'a.go': 'modified', 'README.md': 'modified', 'svc/App.kt': 'added' },
    otherFiles: [...resultOf().otherFiles, { path: 'svc/App.kt', status: 'added', noCallable: true }],
  });
  const row = rowFor(result, 'svc/App.kt');
  assert.equal(row.level, 5, 'expected, not a failure: it stays quiet');
  assert.deepEqual(tree.countReview(rowsOf(result).rows, () => false).attention, 1, 'only the Go file needs attention');
  const py = renderTreeItem(vscode, row, view);
  assert.match(py.description, /^Kotlin  ·  not analysed yet/);
  assert.doesNotMatch(py.description, /no call graph/);
  assert.notEqual(py.iconPath && py.iconPath.color && py.iconPath.color.id, AMBER.color);
  assert.match(py.tooltip.value, /Kotlin files are not analysed yet: read the diff/);
});

test('Details gives the reason for a not-analysed file and nothing for a plain one', () => {
  const result = resultOf();
  const text = (row) => buildDetailHtml(row, { result, nonce: 'bm9uY2U=', cspSource: 'https://webview.test' })
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text(rowFor(result, 'a.go')), /Not analysed\. Go: the Go language server gave no symbols\. Nothing was established about this file/);
  assert.doesNotMatch(text(rowFor(result, 'README.md')), /Not analysed/);
});

test('the preview note says what each language\'s syntax-only search leaves unresolved', () => {
  const scope = (language, unresolved) => ({ language, scope: 'pr-files', note: `${language} callers from syntax only`, ...(unresolved ? { unresolved } : {}) });
  const note = models.previewLimitsNote(resultOf({ otherFiles: [], callersScope: [
    scope('Python', 'untyped receivers and dynamic calls'),
    scope('Go', 'calls through an interface or a function value'),
  ] }));
  assert.equal(note, `${models.PREVIEW_LIMITS_NOTE}`
    + " Python callers are from syntax only, in the PR's own files: untyped receivers and dynamic calls are not resolved; check out the PR to find them all in the editor."
    + " Go callers are from syntax only, in the PR's own files: calls through an interface or a function value are not resolved; check out the PR to find them all in the editor.");
  // Languages that leave the same things unresolved share one sentence.
  assert.match(models.previewLimitsNote(resultOf({ otherFiles: [], callersScope: [scope('A', 'x'), scope('B', 'x')] })),
    /A, B callers are from syntax only, in the PR's own files: x are not resolved/);
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

test('a preview lists every file of a language without text analysis (Go without its hook) as not analysed, with the preview reason, and leaves TypeScript alone', async (t) => {
  clearVirtualText();
  t.after(withoutSyntacticGo());
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

test('a preview of only files of a language without text analysis still lists them as not analysed', async (t) => {
  t.after(withoutSyntacticGo());
  const gh = {
    listPullRequestFiles: async () => ({ total: 1, files: [{ path: 'main.go', oldPath: 'main.go', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] }),
    fileAtRef: async () => null,
  };
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 3, headSha: 'head', mergeBaseSha: 'base', baseRef: 'main' }, repoRoot: root });
  assert.equal(r.otherFiles[0].notAnalysed.language, 'Go');
  assert.match(r.otherFiles[0].notAnalysed.reason, /^a preview cannot analyse Go/);
});

test('the command line lists not-analysed files (Go without its hook) in their own section, and --json carries the field', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-not-analysed-')));
  const preload = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-not-analysed-preload-'))), 'no-syntactic-go.js');
  fs.writeFileSync(preload, WITHOUT_SYNTACTIC_GO);
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/m\n\ngo 1.22\n');
    fs.writeFileSync(path.join(dir, 'a.go'), 'package m\n\nfunc A() int { return 1 }\n');
    git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'a.go'), 'package m\n\nfunc A() int { return 2 }\n');
    git('commit', '-qam', 'head');
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const args = ['--require', preload, cli, '--repo', dir, '--allow-local-base'];
    const text = execFileSync(process.execPath, args, { encoding: 'utf8' });
    assert.match(text, /⑤ NOT ANALYSED/);
    assert.match(text, /\? a\.go {3}Go: Go needs the editor's language server; open the repository in the editor to analyse it/);
    const json = JSON.parse(execFileSync(process.execPath, [...args, '--json'], { encoding: 'utf8' }));
    assert.deepEqual(json.otherFiles.find((f) => f.path === 'a.go').notAnalysed,
      { language: 'Go', reason: "Go needs the editor's language server; open the repository in the editor to analyse it" });
    // Without the seam, Go is read from its text (S3) and its callers from the module's (S4): rows, no section.
    const real = execFileSync(process.execPath, [cli, '--repo', dir, '--allow-local-base'], { encoding: 'utf8' });
    assert.doesNotMatch(real, /⑤ NOT ANALYSED|no callers/);
    assert.match(real, /● A {3}\[CHANGED\] {2}a\.go:3/);
    assert.match(real, /\? A {3}a\.go:3 {2}\(callers unknown: Go callers from syntax only: the module example\.com\/m \(1 Go file\(s\) indexed\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(preload), { recursive: true, force: true });
  }
});

// Python (A4): read from its text where there is no language server, so it is analysed in
// both modes, with callers from a syntax-only index (A8; test/python-syntactic.test.js has the rows).
test('a preview analyses Python from its text: no Python file is listed as not analysed', async () => {
  const gh = {
    listPullRequestFiles: async () => ({ total: 3, files: ['pkg/mod.py', 'pkg/mod.pyi', 'docs/x.md'].map((p) => ({ path: p, oldPath: p, status: 'modified', patch: '@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2' })) }),
    fileAtRef: async (_, p, ref) => (p === 'pkg/mod.py' ? `def f():\n    return ${ref === 'head' ? 2 : 1}\n` : null),
  };
  const r = await analyzeRemote({ ts, gh, slug: {}, pr: { number: 3, headSha: 'head', mergeBaseSha: 'base', baseRef: 'main' }, repoRoot: root });
  const by = Object.fromEntries(r.otherFiles.map((f) => [f.path, f.notAnalysed]));
  assert.equal(by['docs/x.md'], undefined);
  assert.equal('pkg/mod.py' in by, false, 'its function is a row');
  assert.deepEqual(r.allChanged.map((c) => `${c.relPath}#${c.key}`), ['pkg/mod.py#f']);
  assert.equal(r.allChanged[0].callerState, 'unknown');
  assert.equal(r.allChanged[0].callersComplete, false);
  // The stub cannot give pkg/mod.pyi at the head: skipped with the fetch warning, as a TypeScript file is.
  assert.ok(r.warnings.some((w) => /could not be fetched at the PR head/.test(w)));
  const note = models.previewLimitsNote(r);
  assert.doesNotMatch(note, /Python files are not analysed/);
  assert.match(note, /Python callers are from syntax only/);
});

test('the command line analyses a Python file from its text: no not-analysed section, and --json says callers are from syntax only', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-not-analysed-py-')));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "m"\n');
    fs.writeFileSync(path.join(dir, 'a.py'), 'def a():\n    return 1\n');
    git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'a.py'), 'def a():\n    return 2\n');
    git('commit', '-qam', 'head');
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const args = ['--repo', dir, '--allow-local-base'];
    const text = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.doesNotMatch(text, /⑤ NOT ANALYSED/);
    assert.match(text, /● a {3}\[CHANGED\] {2}a\.py:1/);
    assert.match(text, /\? a {3}a\.py:1 {2}\(callers unknown: Python callers from syntax only: the repository \(1 Python file\(s\) indexed\)/);
    const json = JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' }));
    assert.equal(json.otherFiles.find((f) => f.path === 'a.py'), undefined);
    assert.deepEqual(json.allChanged.map((c) => [c.key, c.callerState, c.callersComplete]), [['a', 'unknown', false]]);
    assert.match(json.allChanged[0].callersIncompleteReason, /^Python callers from syntax only: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Java (J7): read from its text where there is no language server (the preview's version is in
// java-outline.test.js), so no Java file is listed as not analysed on the command line either.
// Kotlin has no provider and stays "not analysed yet" (above).
test('the command line analyses a Java file from its text: no not-analysed section, and callers come from the syntax index, incomplete', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-not-analysed-java-')));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com');
    const file = path.join(dir, 'src/main/java/demo/A.java');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>\n');
    fs.writeFileSync(file, 'package demo;\n\npublic class A {\n  public int a() {\n    return 1;\n  }\n}\n');
    git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(file, 'package demo;\n\npublic class A {\n  public int a() {\n    return 2;\n  }\n}\n');
    git('commit', '-qam', 'head');
    const cli = path.join(__dirname, '..', 'src', 'cli.js');
    const args = ['--repo', dir, '--allow-local-base'];
    const text = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.doesNotMatch(text, /⑤ NOT ANALYSED/);
    assert.match(text, /● A\.a\(\) {3}\[CHANGED\] {2}src\/main\/java\/demo\/A\.java:4/);
    assert.doesNotMatch(text, /no callers/);
    const json = JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' }));
    assert.equal(json.otherFiles.find((f) => f.path.endsWith('A.java')), undefined);
    assert.deepEqual(json.allChanged.map((c) => [c.key, c.callersComplete]), [['A.a()', false]]);
    assert.match(json.allChanged[0].callersIncompleteReason, /^Java callers from syntax only: the repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
