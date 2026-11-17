'use strict';
// The demo repository (scripts/demo-repo.js): it builds from demo/, and the review of it tells
// the story the README's media shows — lockRow red with 2 of its 5 callers (three in the code, two
// tests) not updated, renameRow edited but not on its call, saveSnapshot updated at the call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { requireTypeScript } = require('./find-typescript');
const { buildDemoRepo, DEMO_BRANCH } = require('../scripts/demo-repo');

requireTypeScript('demo repository');
const { analyze } = require('../src/engine/analyze');
const { classifyChangeVerdict } = require('../src/views/changes/tree-row-models');

const TEMPLATE = path.join(__dirname, '..', 'demo');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-demo-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('builds the demo branch on top of a local origin/main, and rebuilds from scratch', async () => {
  const { repo, branch } = await buildDemoRepo({ templateDir: TEMPLATE, parentDir: tmp });
  assert.equal(branch, DEMO_BRANCH);
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), DEMO_BRANCH);
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'origin/HEAD']), 'origin/main');
  assert.equal(git(repo, ['rev-list', '--count', 'origin/main..HEAD']), '1');
  assert.equal(git(repo, ['status', '--porcelain']), '');

  // A reviewer's edit is gone after the next build.
  fs.writeFileSync(path.join(repo, 'src', 'rows.ts'), 'edited');
  await buildDemoRepo({ templateDir: TEMPLATE, parentDir: tmp });
  assert.notEqual(fs.readFileSync(path.join(repo, 'src', 'rows.ts'), 'utf8'), 'edited');
  assert.equal(git(repo, ['status', '--porcelain']), '');
});

test('a missing template is an error, not an empty demo', async () => {
  await assert.rejects(buildDemoRepo({ templateDir: path.join(tmp, 'nowhere'), parentDir: path.join(tmp, 'p2') }), /missing/);
});

test('the review shows the planted bug: lockRow with 2 of 5 callers not updated, 1 edited nearby', async () => {
  const { repo } = await buildDemoRepo({ templateDir: TEMPLATE, parentDir: path.join(tmp, 'review') });
  const result = await analyze(repo, { mode: 'pr', skipForest: true, deferTestReach: true });
  const lockRow = result.allChanged.find((c) => c.label === 'lockRow');
  assert.ok(lockRow, 'lockRow is a changed symbol');
  const verdict = classifyChangeVerdict(lockRow);
  assert.equal(verdict.level, 0, 'lockRow needs attention');
  assert.equal(verdict.text, '2 of 5 callers not updated (1 edited nearby)');
  const states = Object.fromEntries(lockRow.callers.map((c) => [c.label, c.callState]));
  assert.equal(states.appendEntry, 'unchanged');
  assert.equal(states.renameRow, 'changed-elsewhere');
  assert.equal(states.saveSnapshot, 'updated-at-call');
  assert.equal(states.lockIsReleased, 'unchanged');
  // Nothing else competes with it for the reviewer's first look.
  const red = result.allChanged.filter((c) => classifyChangeVerdict(c).level === 0).map((c) => c.label);
  assert.deepEqual(red, ['lockRow']);
});
