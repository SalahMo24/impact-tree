// @ts-check
'use strict';
// `node src/cli.js mcp` as a child process over a real analysis of a small git repository
// (the PR is its HEAD against `main`): the handshake answers before any analysis, the first
// tool call analyses, the tools answer from the checkout, the write-back tools check and
// report that no editor is connected, and closing the input or SIGTERM ends the process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawnMcp } = require('./mcp-child');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-mcp-checkout-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** @param {string} dir @param {string[]} args */
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** `main` with price() and total(); a `feature` commit adds a parameter to price(). HEAD is `feature`. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const write = (/** @type {string} */ rel, /** @type {string} */ text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  git(dir, ['init', '-q', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  write('.gitignore', 'node_modules\n');
  write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'commonjs', strict: true }, include: ['src'] }));
  write('src/price.ts', 'export function price(n: number): number {\n  return n * 2;\n}\n');
  write('src/cart.ts', 'import { price } from "./price";\nexport function total(xs: number[]): number {\n  return xs.reduce((a, x) => a + price(x), 0);\n}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  git(dir, ['checkout', '-q', '-b', 'feature']);
  write('src/price.ts', 'export function price(n: number, tax = 0): number {\n  return n * 2 + tax;\n}\n');
  git(dir, ['commit', '-qam', 'tax']);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(dir, 'node_modules', 'typescript'));
  return dir;
}

test('the server analyses the checkout on the first tool call and answers from it', async () => {
  const repo = makeRepo();
  const s = spawnMcp(['--repo', repo, '--base', 'main', '--allow-local-base']);
  try {
    const init = await s.handshake();
    assert.equal(init.result.serverInfo.name, 'impact-tree');
    assert.doesNotMatch(s.stderr(), /analysed/, 'initialize does not start the analysis');
    const cards = (await s.call('list_cards', {})).structuredContent;
    assert.equal(cards.total, 1);
    assert.equal(cards.pr.base, 'main');
    assert.match(s.stderr(), /analysed 1 changed functions/);
    const card = (await s.call('get_card', { id: cards.cards[0].id })).structuredContent;
    assert.equal(card.members[0].label, 'price');
    assert.equal(typeof card.complete, 'boolean');
    const change = (await s.call('get_change', { id: card.members[0].id })).structuredContent;
    assert.match(change.hunk, /tax = 0/);
    assert.deepEqual(change.callers.map((/** @type {any} */ c) => [c.label, c.file, c.line]), [['total', 'src/cart.ts', 2]]);
    const callers = (await s.call('callers_of', { file: 'src/price.ts', line: 1, name: 'price' })).structuredContent;
    assert.equal(callers.callers[0].file, 'src/cart.ts');
    const head = (await s.call('get_source', { file: 'src/price.ts', startLine: 1, endLine: 1 })).structuredContent;
    assert.equal(head.text, '1: export function price(n: number, tax = 0): number {');
    const base = (await s.call('get_source', { file: 'src/price.ts', side: 'base', startLine: 1, endLine: 1 })).structuredContent;
    assert.equal(base.text, '1: export function price(n: number): number {');
    const found = (await s.call('search_code', { pattern: 'price(x)' })).structuredContent;
    assert.deepEqual(found.hits.map((/** @type {any} */ h) => `${h.file}:${h.line}`), ['src/cart.ts:3']);
    assert.equal(found.complete, true);
    assert.deepEqual((await s.call('list_files', { prefix: 'src/' })).structuredContent.files, ['src/cart.ts', 'src/price.ts']);
    assert.equal((await s.call('get_source', { file: 'src/nope.ts' })).isError, true);
    assert.equal((await s.call('get_source', { file: '../outside' })).isError, true);
    const ev = (await s.call('check_evidence', { file: 'src/cart.ts', line: 3, callee: 'price' })).structuredContent;
    assert.deepEqual([ev.ok, ev.call], [true, true]);
    // Write-back without an editor: checked, not saved.
    const submitted = await s.call('submit_callers', { answer: { function: card.members[0].id, callers: [{ file: 'src/cart.ts', line: 3, name: 'total' }] } });
    assert.deepEqual(submitted.structuredContent, { stored: false, reason: 'no editor connected: checked, not saved' });
    const refused = await s.call('submit_callers', { answer: { function: card.members[0].id, callers: [{ file: 'src/cart.ts', line: 3, name: 'total' }, { file: 'src/price.ts', line: 3 }] } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /callers\[1\]: price is not mentioned on line 3 of src\/price\.ts/);
    const analysed = (stderr => stderr.match(/analysed/g) || [])(s.stderr());
    assert.equal(analysed.length, 1, 'the analysis ran once');
  } finally {
    const exit = await s.end();
    assert.deepEqual(exit, { code: 0, signal: null });
  }
  assert.match(s.stderr(), /shutting down \(input closed\)/);
});

test('uncommitted changes: the server analyses the branch with them, as the editor does, and says so', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'src/cart.ts'), 'import { price } from "./price";\nexport function total(xs: number[]): number {\n  return xs.reduce((a, x) => a + price(x, 1), 0);\n}\n');
  const s = spawnMcp(['--repo', repo, '--base', 'main', '--allow-local-base']);
  try {
    await s.handshake();
    const r = await s.call('list_cards', {});
    assert.ok(!r.isError, r.content[0].text);
    const labels = r.structuredContent.cards.flatMap((/** @type {any} */ c) => c.members || []).map((/** @type {any} */ m) => m.label || m);
    assert.ok(JSON.stringify(r.structuredContent).includes('total'), `the uncommitted edit of total() is analysed: ${JSON.stringify(labels)}`);
    assert.match(JSON.stringify(r.structuredContent.limits), /1 uncommitted change\(s\): the changes analysed include them/);
  } finally {
    assert.deepEqual(await s.end(), { code: 0, signal: null });
  }
});

test('a base that does not exist fails every call with the engine message, and the server still exits cleanly', async () => {
  const repo = makeRepo();
  const s = spawnMcp(['--repo', repo, '--base', 'no-such-branch']);
  await s.handshake();
  const r = await s.call('list_cards', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /The analysis failed: .*no-such-branch/);
  const again = await s.call('get_card', { id: 'K1' });
  assert.equal(again.isError, true);
  assert.deepEqual(await s.end(), { code: 0, signal: null });
});

test('SIGTERM stops the server', async () => {
  const repo = makeRepo();
  const s = spawnMcp(['--repo', repo, '--base', 'main', '--allow-local-base']);
  await s.handshake();
  await s.call('list_cards', {});
  s.child.kill('SIGTERM');
  assert.deepEqual(await s.exited, { code: 0, signal: null });
  assert.match(s.stderr(), /shutting down \(SIGTERM\)/);
});
