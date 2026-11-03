'use strict';
// The repository a window analyses is the git top folder, not the workspace folder: a
// `.code-workspace` or dev container that opens a subfolder showed every function as deleted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gitToplevel, pickRepoRoot, cachedRepoRoot } = require('../src/session/repo-root');

const real = (p) => fs.realpathSync(p);

function makeRepo() {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), 'it-repo-root-')));
  fs.mkdirSync(path.join(dir, 'packages', 'app'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('a subfolder resolves to its repository top folder', () => {
  const repo = makeRepo();
  assert.strictEqual(real(gitToplevel(path.join(repo, 'packages', 'app'))), repo);
  assert.strictEqual(real(gitToplevel(repo)), repo);
});

test('outside a repository there is no top folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-no-repo-'));
  assert.strictEqual(gitToplevel(dir), null);
});

test('multi-root: the first folder inside a repository wins; else the first folder', () => {
  const tops = { '/notes': null, '/r/app': '/r', '/s': '/s' };
  const top = (/** @type {string} */ d) => tops[/** @type {keyof typeof tops} */ (d)];
  assert.strictEqual(pickRepoRoot(['/notes', '/r/app', '/s'], top), '/r');
  assert.strictEqual(pickRepoRoot(['/notes'], top), '/notes');
  assert.strictEqual(pickRepoRoot([], top), null);
});

test('answers are cached until the repository around the folder changes', () => {
  const repo = makeRepo();
  const sub = path.join(repo, 'packages', 'app');
  let calls = 0;
  const resolve = cachedRepoRoot((d) => { calls++; return gitToplevel(d); });
  assert.strictEqual(real(resolve([sub])), repo);
  resolve([sub]);
  assert.strictEqual(calls, 1);
  execFileSync('git', ['init', '-q'], { cwd: sub });  // a nested repo appears
  assert.strictEqual(real(resolve([sub])), sub);
  assert.strictEqual(calls, 2);
});
