'use strict';
// With no base branch set, a review is against the remote's default branch (origin/HEAD),
// not always `main`: encode/httpx's default is `master`, and "cannot resolve origin/main"
// stopped every local review there. A base set explicitly is used as given.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeGit, resolveBase, resolveBaseAsync, remoteDefaultBranch } = require('../src/engine/git');

const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** A remote whose default branch is `defaultBranch` and a clone of it, in a temp dir. */
function cloneOf(defaultBranch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'it-default-base-'));
  const origin = path.join(tmp, 'origin');
  const clone = path.join(tmp, 'clone');
  fs.mkdirSync(origin);
  run(origin, ['init', '--quiet', `--initial-branch=${defaultBranch}`]);
  run(origin, ['config', 'user.email', 't@example.com']);
  run(origin, ['config', 'user.name', 'test']);
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(origin, `f${i}.txt`), `v${i}\n`);
    run(origin, ['add', '.']);
    run(origin, ['commit', '--quiet', '-m', `c${i}`]);
  }
  run(tmp, ['clone', '--quiet', origin, clone]);
  return { tmp, clone, tip: run(origin, ['rev-parse', 'HEAD']) };
}

test('no base set: the remote\'s default branch (master here), sync and async', async (t) => {
  const { tmp, clone, tip } = cloneOf('master');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = makeGit(clone);
  assert.equal(remoteDefaultBranch(git, 'origin'), 'master');
  for (const spec of [undefined, '']) {
    const r = resolveBase(git, spec);
    assert.equal(r.ref, 'origin/master');
    assert.equal(r.sha, tip);
  }
  const a = await resolveBaseAsync(git, '', { fetch: true });
  assert.equal(a.ref, 'origin/master');
  assert.ok(a.notes.some((n) => /fetched origin\/master/.test(n)), a.notes.join('; '));
});

test('no origin/HEAD recorded: main, else master, if the remote has it', (t) => {
  const { tmp, clone } = cloneOf('master');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  run(clone, ['remote', 'set-head', 'origin', '--delete']);
  const git = makeGit(clone);
  assert.equal(remoteDefaultBranch(git, 'origin'), 'master');
  assert.equal(resolveBase(git, '').ref, 'origin/master');
});

test('a base set explicitly is used as given; a missing one names the remote\'s default', (t) => {
  const { tmp, clone } = cloneOf('master');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = makeGit(clone);
  assert.throws(() => resolveBase(git, 'main'), /cannot resolve origin\/main\..*origin's default branch is master: set impactTree\.baseBranch to master/);
});

test('a main-default remote is unchanged', (t) => {
  const { tmp, clone, tip } = cloneOf('main');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const r = resolveBase(makeGit(clone), '');
  assert.equal(r.ref, 'origin/main');
  assert.equal(r.sha, tip);
});
