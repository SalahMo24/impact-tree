'use strict';
// The lines a pull request's diff shows per side (engine/diff-lines.js): taken from GitHub's
// own patch, or widened from a local `--unified=0` diff, which must then agree with git's
// own three-line hunks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { diffLinesFromPatch, diffLinesFromChanges } = require('../src/engine/diff-lines');
const { allHunks } = require('../src/engine/diff');
const { makeGit } = require('../src/engine/git');

test('a GitHub patch gives each side the lines of its hunks, context included', () => {
  const patch = [
    '@@ -8,7 +10,8 @@ function f() {', ' a', ' b', ' c', '-d', '+e', '+f', ' g', ' h', ' i',
    '@@ -38,6 +40,7 @@', ' j', ' k', ' l', '+m', ' n', ' o', ' p',
  ].join('\n');
  assert.deepEqual(diffLinesFromPatch(patch), { left: [[8, 14], [38, 43]], right: [[10, 17], [40, 46]] });
  assert.deepEqual(diffLinesFromPatch('@@ -0,0 +1,3 @@\n+a\n+b\n+c'), { left: [], right: [[1, 3]] }, 'an added file has no base lines');
  assert.deepEqual(diffLinesFromPatch('@@ -1,2 +0,0 @@\n-a\n-b'), { left: [[1, 2]], right: [] }, 'a deleted file has no head lines');
  assert.deepEqual(diffLinesFromPatch(undefined), { left: [], right: [] }, 'no patch (binary or too large): no lines');
});

test('a --unified=0 change is widened by three lines; changes six lines apart share a hunk, seven apart do not', () => {
  const change = (oldStart, oldCount, newStart, newCount) => ({ oldStart, oldCount, newStart, newCount });
  assert.deepEqual(diffLinesFromChanges([change(10, 1, 10, 1), change(17, 1, 17, 1)], 'modified'),
    { left: [[7, 20]], right: [[7, 20]] }, 'six unchanged lines between: one hunk');
  assert.deepEqual(diffLinesFromChanges([change(10, 1, 10, 1), change(18, 1, 18, 1)], 'modified'),
    { left: [[7, 13], [15, 21]], right: [[7, 13], [15, 21]] }, 'seven between: line 14 is in neither hunk');
  assert.deepEqual(diffLinesFromChanges([change(5, 0, 6, 2)], 'modified'), { left: [[3, 8]], right: [[3, 10]] },
    'an insertion after base line 5 shows base lines 3-8 around it');
  assert.deepEqual(diffLinesFromChanges([change(0, 0, 1, 2)], 'modified'), { left: [[1, 3]], right: [[1, 5]] },
    'lines inserted at the top of an existing file show its first three lines');
  assert.deepEqual(diffLinesFromChanges([change(0, 0, 1, 2)], 'added'), { left: [], right: [[1, 5]] }, 'an added file has no base side');
  assert.deepEqual(diffLinesFromChanges([change(1, 4, 0, 0)], 'deleted'), { left: [[1, 7]], right: [] }, 'a deleted file has no head side');
});

test('the widened local diff gives the same lines as git\'s own three-line hunks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-diff-lines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q', '--initial-branch=main'); sh('config', 'user.name', 'T'); sh('config', 'user.email', 't@example.com');
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'f.txt'), `${lines.join('\n')}\n`);
  sh('add', '.'); sh('commit', '-qm', 'base');
  const base = sh('rev-parse', 'HEAD').trim();
  const next = lines.slice();
  next[4] = 'five';                    // line 5
  next[11] = 'twelve';                 // six lines after: same hunk
  next[29] = 'thirty';                 // line 30
  next[37] = 'thirty-eight';           // seven lines after: next hunk
  next.splice(49, 2);                  // delete 50-51
  next.splice(53, 0, 'new a', 'new b'); // insert
  next.unshift('top');                 // insert before line 1
  next[next.length - 1] = 'last';      // the final line
  fs.writeFileSync(path.join(dir, 'f.txt'), `${next.join('\n')}\n`);
  sh('commit', '-qam', 'head');
  const headers = {};
  const deletions = {};
  const ranges = allHunks(makeGit(dir), base, 'HEAD', ['f.txt'], deletions, headers);
  assert.deepEqual(ranges, allHunks(makeGit(dir), base, 'HEAD', ['f.txt']), 'collecting the headers changes no existing output');
  const patch = sh('diff', '--no-ext-diff', '--no-color', '--unified=3', base, 'HEAD', '--', 'f.txt');
  // The widened spans are not clipped to the file (the diff does not give its length); the
  // document clips them, as here.
  const clip = (spans, length) => spans.map(([lo, hi]) => [lo, Math.min(hi, length)]);
  const widened = diffLinesFromChanges(headers['f.txt'], 'modified');
  assert.deepEqual({ left: clip(widened.left, lines.length), right: clip(widened.right, next.length) }, diffLinesFromPatch(patch));
});
