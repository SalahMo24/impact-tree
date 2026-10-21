'use strict';
// Before an empty answer from the editor's language server becomes "no callers", files
// that may use the symbol outside the projects it loaded are looked for (a component's
// tests in their own tsconfig). Only files that import the declaring module count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');
const { findUnseenUsers, unseenUsersReason, symbolNameAt, specifierNames, gitGrep, MAX_CANDIDATES } = require('../src/engine/unseen-users');
const { makeGit } = require('../src/engine/git');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A monorepo with two packages that each hold a `state-enums.ts` and a bootstrap class. */
function monorepo(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-unseen-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  for (const pkg of ['consumer', 'vas']) {
    write(`components/${pkg}/package.json`, '{}');
    write(`components/${pkg}/src/data/state-enums.ts`, 'export const other = 1;\nexport function validState(s: string) { return s; }\n');
    write(`components/${pkg}/src/data/boot.ts`, 'export class Boot {\n  async onModuleInit() {}\n}\n');
  }
  // Uses through a baseUrl alias, from tests the source tsconfig does not include.
  write('components/consumer/tests/state-enums.spec.ts', "import { validState } from 'src/data/state-enums';\nvalidState('a');\n");
  write('components/consumer/tests/boot.spec.ts', "import { Boot } from 'src/data/boot';\nnew Boot().onModuleInit();\n");
  // The other package's copies, and a file naming the method of another class.
  write('components/vas/tests/state-enums.spec.ts', "import { validState } from 'src/data/state-enums';\nvalidState('b');\n");
  write('components/consumer/src/other.ts', "import { Other } from './other-class';\nnew Other().onModuleInit();\n");
  write('components/consumer/README.md', 'validState is documented here\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', '.']);
  return repo;
}
const at = (file, word) => fs.readFileSync(file, 'utf8').indexOf(word);
const find = (repo, rel, word) => {
  const declFile = path.join(repo, rel);
  return findUnseenUsers({ ts, repo, declFile, pos: at(declFile, word), grep: gitGrep(makeGit(repo)) });
};

test('a function used only from a test project is found there, not in another package\'s copy', async (t) => {
  const repo = monorepo(t);
  const found = await find(repo, 'components/consumer/src/data/state-enums.ts', 'validState');
  assert.deepEqual(found, { files: ['components/consumer/tests/state-enums.spec.ts'], unchecked: 0 });
  assert.equal(unseenUsersReason(found), "used in a file the editor's search did not reach (components/consumer/tests/state-enums.spec.ts)");
});

test('a member counts only in files that import its module and name its class', async (t) => {
  const repo = monorepo(t);
  const found = await find(repo, 'components/consumer/src/data/boot.ts', 'onModuleInit');
  assert.deepEqual(found.files, ['components/consumer/tests/boot.spec.ts']);
});

test('an untracked file is searched too', async (t) => {
  const repo = monorepo(t);
  fs.writeFileSync(path.join(repo, 'components/consumer/tests/new.spec.ts'), "import { validState } from '../src/data/state-enums';\nvalidState('c');\n");
  const found = await find(repo, 'components/consumer/src/data/state-enums.ts', 'validState');
  assert.deepEqual(found.files.sort(), ['components/consumer/tests/new.spec.ts', 'components/consumer/tests/state-enums.spec.ts']);
});

test('nothing outside the declaring file: no reason, and the answer stays "no callers"', async (t) => {
  const repo = monorepo(t);
  const found = await find(repo, 'components/consumer/src/data/state-enums.ts', 'other');
  assert.deepEqual(found, { files: [], unchecked: 0 });
  assert.equal(unseenUsersReason(found), null);
});

test('no name at the position, or an unreadable file, gives no answer', async (t) => {
  const repo = monorepo(t);
  const declFile = path.join(repo, 'components/consumer/src/data/state-enums.ts');
  assert.equal(await findUnseenUsers({ ts, repo, declFile, pos: 0, grep: async () => { throw new Error('not reached'); } }), null);
  assert.equal(await findUnseenUsers({ ts, repo, declFile: path.join(repo, 'gone.ts'), pos: 0, grep: async () => [] }), null);
});

test('a failed search rejects, so the caller can tell it from "nothing found"', async () => {
  const failing = { rawAsync: async () => { throw Object.assign(new Error('fatal: bad'), { code: 128 }); } };
  await assert.rejects(gitGrep(failing)('x', 1000), /bad/);
  const none = { rawAsync: async () => { throw Object.assign(new Error(''), { code: 1 }); } };
  assert.deepEqual(await gitGrep(none)('x', 1000), []);
});

test('past the candidate limit the rest is unchecked, and the reason says so', async () => {
  const listed = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => `f${i}.ts`);
  const found = await findUnseenUsers({ ts, repo: '/r', declFile: '/r/a.ts', pos: 16, grep: async () => listed,
    readFile: (abs) => (abs === '/r/a.ts' ? 'export function target() {}' : 'nothing here') });
  assert.deepEqual(found, { files: [], unchecked: 5 });
  assert.match(unseenUsersReason(found), /5 files name it and were not checked/);
  assert.match(unseenUsersReason({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], unchecked: 0 }), /4 files .*\(a\.ts, b\.ts, c\.ts and 1 more\)$/);
});

test('names: top-level functions and variables, members with their class; none for an anonymous class', () => {
  const text = 'export function f() {}\nexport const v = () => 1;\nclass C { m() {} p = 1; }\nexport default class { n() {} }\n';
  const name = (word) => symbolNameAt(ts, text, 'x.ts', text.indexOf(word));
  assert.deepEqual(name('f()'), { name: 'f', className: null });
  assert.deepEqual(name('v ='), { name: 'v', className: null });
  assert.deepEqual(name('m()'), { name: 'm', className: 'C' });
  assert.deepEqual(name('p ='), { name: 'p', className: 'C' });
  assert.equal(name('n()'), null);
});

test('specifiers: relative ones must resolve to the file; aliases must stay in the package', () => {
  const declFile = '/r/pkg/src/data/state-enums.ts';
  const o = { declFile, packageRoot: '/r/pkg', importerRoot: '/r/pkg' };
  assert.equal(specifierNames('../src/data/state-enums', '/r/pkg/tests/a.ts', o), true);
  assert.equal(specifierNames('./state-enums.js', '/r/pkg/src/data/a.ts', o), true);
  assert.equal(specifierNames('../other/state-enums', '/r/pkg/src/data/a.ts', o), false, 'another file of that name');
  assert.equal(specifierNames('src/data/state-enums', '/r/pkg/tests/a.ts', o), true);
  assert.equal(specifierNames('data/state-enums', '/r/pkg/tests/a.ts', o), true);
  assert.equal(specifierNames('src/data/state-enums', '/r/vas/tests/a.ts', { ...o, importerRoot: '/r/vas' }), false, 'another package');
  assert.equal(specifierNames('src/data', '/r/pkg/tests/a.ts', { ...o, declFile: '/r/pkg/src/data/index.ts' }), true, 'a folder\'s index');
});
