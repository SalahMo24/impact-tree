'use strict';
// Git diffs, rename hunks, forest roots, and caller identity.

const path = require('path');
const fs = require('fs');
const { createLocalHarness } = require('./local-repo');
const { analyze, rangesFor } = require('../src/engine/analyze');
const { makeGit } = require('../src/engine/git');
const { changedFiles, allHunks, hunks, isTestPath, isTestFile } = require('../src/engine/diff');
const { nestedIds, seedRoots } = require('../src/engine/forest');

const h = createLocalHarness();
if (!h) process.exit(0);
const {
  TMP, TSCONFIG, TARGET_V1, TARGET_V2, since, J,
  run, write, mkRepo, commit, headOf, byLabel, callStates, check, finish,
} = h;

(async () => {
  // ================================================================ git diff =====
  console.log('▸ renamed files');
  {
    // The per-file pathspec named only the new path, so git could not pair the rename
    // and every function of the moved file read as changed.
    const body = (v) => ['a', 'b', 'c', 'd'].map((n) => `export function ${n}() {\n  return 1;\n}\n`).join('\n') + `\nexport function e() {\n  return ${v};\n}\n`;
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/old.ts': body(1) });
    const base = headOf(repo);
    run(repo, ['mv', 'src/old.ts', 'src/new.ts']);
    write(repo, { 'src/new.ts': body(2) });
    commit(repo);
    const git = makeGit(repo);
    check('single-file hunks of a rename are its real edits', J(hunks(git, base, 'HEAD', 'src/new.ts', 'src/old.ts')) === J([[18, 18]]), J(hunks(git, base, 'HEAD', 'src/new.ts', 'src/old.ts')));
    const r = await analyze(repo, since(base, { headRev: 'HEAD' }));
    check('only the edited function of a moved file changed', J(r.allChanged.map((c) => c.label)) === J(['e']), J(r.allChanged.map((c) => c.label)));
  }

  console.log('▸ one git diff for all files');
  {
    const files = {};
    for (let i = 0; i < 6; i++) files[`src/f${i}.ts`] = `export function f${i}() {\n  return 1;\n}\n`;
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, ...files });
    const base = headOf(repo);
    run(repo, ['mv', 'src/f0.ts', 'src/moved.ts']);
    for (let i = 1; i < 6; i++) write(repo, { [`src/f${i}.ts`]: `export function f${i}() {\n  return 2;\n}\n` });
    write(repo, { 'src/moved.ts': 'export function f0() {\n  return 3;\n}\n' });
    commit(repo);
    const real = makeGit(repo);
    let diffCalls = 0;
    const counting = { ...real, raw: (args, o) => { if (args.includes('diff')) diffCalls++; return real.raw(args, o); } };
    const list = changedFiles(real, base, 'HEAD', null);
    const once = rangesFor(counting, base, 'HEAD', list);
    check('every file from a single diff process', diffCalls === 1, `${diffCalls} calls`);
    const perFile = Object.fromEntries(list.map((f) => [f.path, hunks(real, base, 'HEAD', f.path, f.oldPath)]));
    check('same ranges as one diff per file', J(once) === J(perFile), `${J(once)} vs ${J(perFile)}`);
    diffCalls = 0;
    const chunked = rangesFor(counting, base, 'HEAD', list, { maxChars: 30 });
    check('chunking for a huge PR keeps a rename\'s two paths together', J(chunked) === J(perFile) && diffCalls > 1, `${diffCalls} chunks, ${J(chunked['src/moved.ts'])}`);
  }

  console.log('▸ paths and user git config');
  {
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/café.ts': 'export function f() {\n  return 1;\n}\n', 'src/plain.ts': 'export function g() {\n  return 1;\n}\n' });
    const base = headOf(repo);
    write(repo, { 'src/café.ts': 'export function f() {\n  return 2;\n}\n', 'src/plain.ts': 'export function g() {\n  return 2;\n}\n' });
    let r = await analyze(repo, since(base));
    check('a non-ASCII path is analysed', J(r.allChanged.map((c) => c.label).sort()) === J(['f', 'g']), J(r.allChanged.map((c) => c.label)));
    // difftastic-style external diff replaced git's output and left no hunks at all
    run(repo, ['config', 'diff.external', '/usr/bin/true']);
    run(repo, ['config', 'color.ui', 'always']);
    r = await analyze(repo, since(base));
    check('diff.external and color.ui do not hide the change', r.allChanged.length === 2, J(r.allChanged.map((c) => c.label)));
  }
  {
    // A spaced name gets a trailing tab on its +++ line; an added line reading `++ x`
    // shows up as `+++ x` and used to be taken for the next file's header.
    const repo = mkRepo({ 'a b.ts': 'x\n', 'c.ts': 'one\n' }, { ts: false });
    const base = headOf(repo);
    write(repo, { 'a b.ts': 'x\n++ not a header\n', 'c.ts': 'two\n' });
    const h = allHunks(makeGit(repo), base, null, []);
    check('spaced path and a +++-looking body line', J(h) === J({ 'a b.ts': [[2, 2]], 'c.ts': [[1, 1]] }), J(h));
  }

  // =============================================================== roots =====
  console.log('▸ every changed symbol is reachable from a root');
  {
    // ping <-> pong nested each other and vanished; walk (recursive) was dropped from
    // the CLI forest because it counts as its own changed caller.
    const src = (v) => `export function walk(n: number): number {\n  if (n <= 0) return ${v};\n  return walk(n - 1);\n}\n\n`
      + `export function ping(n: number): number {\n  if (n <= 0) return ${v};\n  return pong(n - 1);\n}\n\n`
      + `export function pong(n: number): number {\n  if (n <= 0) return ${v};\n  return ping(n - 1);\n}\n`;
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/a.ts': src(0) });
    const base = headOf(repo);
    write(repo, { 'src/a.ts': src(1) });
    const r = await analyze(repo, { mode: 'checkpoint', checkpoint: base, deferTestReach: true });
    const roots = r.allChanged.filter((c) => c.isRoot).map((c) => c.label).sort();
    check('a recursive function stays a root', roots.includes('walk'), J(roots));
    check('exactly one member of a cycle is promoted', roots.filter((l) => l === 'ping' || l === 'pong').length === 1, J(roots));
    check('the CLI forest uses the same roots', J(r.components[0].forest.map((f) => f.label).sort()) === J(roots), J(r.components[0].forest.map((f) => f.label)));
  }
  {
    // pure graph checks: a -> b -> c chain, and a cycle reached from outside
    const mk = (label, callers) => ({ label, file: 'f', namePos: label.charCodeAt(0), score: 1,
      callers: callers.map((l) => ({ file: 'f', pos: l.charCodeAt(0) })) });
    const chain = [mk('a', ['b']), mk('b', ['c']), mk('c', [])];
    check('in a chain only the innermost callee is a root', J(seedRoots(chain).map((c) => c.label)) === J(['a']));
    const reached = [mk('r', ['x']), mk('x', ['y']), mk('y', ['x'])];
    check('a cycle reachable from a root is not promoted', nestedIds(reached).size === 2 && seedRoots(reached)[0].label === 'r');
  }

  // ======================================================== caller identity =====
  console.log('▸ callers inside a changed constructor');
  {
    // The call hierarchy names code in a constructor after its class; that id never
    // matched the constructor's own, so an edited constructor read as "unchanged".
    const k = (v) => `import { target } from './t';\nexport class K {\n  n = 0;\n  constructor() {\n    target(1);\n    this.n = ${v};\n  }\n}\n`;
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/t.ts': TARGET_V1, 'src/k.ts': k(0) });
    const base = headOf(repo);
    write(repo, { 'src/t.ts': TARGET_V2, 'src/k.ts': k(1) });
    const r = await analyze(repo, since(base));
    check('reported as changed elsewhere', J(callStates(byLabel(r, 'target'))) === J(['K[changed-elsewhere]']), J(callStates(byLabel(r, 'target'))));
  }

  console.log('▸ test classification is relative to the repo');
  {
    // Every caller of a repo cloned under some `.../tests/...` directory was a test.
    const parent = path.join(TMP, 'tests');
    fs.mkdirSync(parent);
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/t.ts': TARGET_V1, 'src/caller.ts': "import { target } from './t';\nexport function caller() {\n  return target(1);\n}\n" }, { parent });
    const base = headOf(repo);
    write(repo, { 'src/t.ts': TARGET_V2 });
    const r = await analyze(repo, since(base));
    const c = byLabel(r, 'target');
    check('a production caller under a tests/ parent is not a test', c.callers.length === 1 && !c.callers[0].test && c.staleCallers === 1, J(c.callers));
    check('isTestFile uses the relative path', !isTestFile('/x/tests/app', '/x/tests/app/src/a.ts') && isTestFile('/x/app', '/x/app/tests/a.ts'));
    check('isTestPath accepts Windows separators', isTestPath('src\\__tests__\\a.ts'));
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
