'use strict';
// tsconfig shapes, untracked files, base resolution, and files without a project.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createLocalHarness } = require('./local-repo');
const { analyze, loadTypeScript } = require('../src/engine/analyze');
const { makeGit, resolveBase, resolveBaseAsync } = require('../src/engine/git');
const { projectRootOf } = require('../src/engine/diff');
const textpos = require('../src/engine/textpos');

const h = createLocalHarness();
if (!h) process.exit(0);
const {
  ts, TS_DIR, TMP, TSCONFIG, TARGET_V1, TARGET_V2, fast, since, J,
  run, write, linkTs, mkRepo, commit, headOf, byLabel, callStates, check, finish, uniq,
} = h;

(async () => {
  // ============================================================ programs =====
  console.log('▸ tsconfig shapes');
  {
    // Solution-style root (Vite, Nx): `files: []` + references compiled nothing, so
    // every changed function reported zero callers.
    const repo = mkRepo({
      'tsconfig.json': J({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': J({ compilerOptions: { target: 'es2020', module: 'esnext', moduleResolution: 'bundler', composite: true }, include: ['src'] }),
      'src/t.ts': TARGET_V1,
      'src/caller.ts': "import { target } from './t';\nexport function caller() {\n  return target(1);\n}\n",
    });
    const base = headOf(repo);
    write(repo, { 'src/t.ts': TARGET_V2 });
    const r = await analyze(repo, since(base));
    const c = byLabel(r, 'target');
    check('callers found through project references', c.callerState === 'resolved' && c.callers.length === 1, `${c.callerState} ${c.callers.length}`);
  }
  {
    // A changed file no tsconfig includes: no query could see a caller, so "none"
    // was a claim we had no basis for.
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'scripts/tool.ts': TARGET_V1 });
    const base = headOf(repo);
    write(repo, { 'scripts/tool.ts': TARGET_V2 });
    const r = await analyze(repo, since(base));
    const c = byLabel(r, 'target');
    check('callers of a file outside the program are unknown', c && c.callerState === 'unknown', c && c.callerState);
    check('and a warning says why', r.warnings.some((w) => w.includes('scripts/tool.ts') && w.includes('tsconfig')), J(r.warnings));
  }
  {
    // TypeScript < 4.8 threw on getModifiers and took the whole run down with it; a
    // compiler that chokes on one file must not blank the rest either.
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/t.ts': TARGET_V1, 'src/bad.ts': 'export function bad() {\n  return 1;\n}\n' }, { ts: false });
    const shim = path.join(repo, 'node_modules', 'typescript');
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'package.json'), J({ name: 'typescript', version: '5.0.0-shim', main: 'index.js' }));
    fs.writeFileSync(path.join(shim, 'index.js'), `const ts = require(${J(TS_DIR)});\n`
      + 'module.exports = { ...ts, getModifiers(n) { if (n.getSourceFile().fileName.endsWith("bad.ts")) throw new Error("boom"); return ts.getModifiers(n); } };\n');
    const base = headOf(repo);
    write(repo, { 'src/t.ts': TARGET_V2, 'src/bad.ts': 'export function bad() {\n  return 2;\n}\n' });
    const r = await analyze(repo, since(base));
    check('the loadable file still analyses', !!byLabel(r, 'target'), J(r.allChanged.map((c) => c.label)));
    check('the failing file is named in a warning', r.warnings.some((w) => w.startsWith('src/bad.ts')), J(r.warnings));
  }

  console.log('▸ per-run caches');
  {
    // The project cache lived for the extension host's lifetime: a package that
    // gained a tsconfig.json stayed "not a project" until a window reload.
    const repo = mkRepo({ 'pkg/src/x.ts': 'export function x() {\n  return 1;\n}\n' }, { ts: false });
    const base = headOf(repo);
    write(repo, { 'pkg/src/x.ts': 'export function x() {\n  return 2;\n}\n' });
    await analyze(repo, since(base));
    check('no project before the tsconfig exists', projectRootOf(repo, 'pkg/src/x.ts') === null);
    write(repo, { 'pkg/tsconfig.json': TSCONFIG });
    linkTs(path.join(repo, 'pkg'));
    const r = await analyze(repo, since(base));
    check('a tsconfig added between runs is seen', !!byLabel(r, 'x'), J(r.allChanged.map((c) => c.label)));
  }
  {
    // Text a Tier A preview registered for a PR outlived it and replaced the file on
    // disk, shifting every call-site line of the next local run.
    const callerV1 = "import { target } from './t';\nexport function caller() {\n  return target(1);\n}\n";
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/t.ts': TARGET_V1, 'src/caller.ts': callerV1 + '\nexport function other() {\n  return 0;\n}\n' });
    const base = headOf(repo);
    write(repo, { 'src/t.ts': TARGET_V2, 'src/caller.ts': callerV1 + '\nexport function other() {\n  return 1;\n}\n' });
    textpos.registerVirtualText(path.join(repo, 'src/caller.ts'), '012345678\n'.repeat(12));
    const r = await analyze(repo, since(base));
    check('a leftover preview does not move call sites', J(callStates(byLabel(r, 'target'))) === J(['caller[unchanged]']), J(callStates(byLabel(r, 'target'))));
  }

  // =========================================================== untracked =====
  console.log('▸ untracked files');
  {
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/t.ts': TARGET_V1 });
    write(repo, { 'src/t.ts': TARGET_V2, 'src/fresh.ts': "import { target } from './t';\nexport function freshCaller() {\n  return target(1, true);\n}\n" });
    const r = await analyze(repo, { mode: 'working', ...fast });
    check('a new un-added file is part of working changes', r.changedPaths.includes('src/fresh.ts') && !!byLabel(r, 'freshCaller'), J(r.changedPaths));
    check('its call site counts as updated', J(callStates(byLabel(r, 'target'))) === J(['freshCaller[updated-at-call]']), J(callStates(byLabel(r, 'target'))));
    // Commit only the target change; the scratch file stays untracked on disk.
    run(repo, ['add', 'src/t.ts']); run(repo, ['commit', '-qm', 'pr']);
    const r2 = await analyze(repo, { mode: 'pr', base: 'HEAD~1', ...fast });
    const c = byLabel(r2, 'target');
    check('pr mode ignores callers in files outside the commit', c.callers.length === 0, J(callStates(c)));
    check('and says so', r2.warnings.some((w) => w.includes('untracked')), J(r2.warnings));
  }
  {
    // The same exclusion must reach the test-reach walk and the tree, not only the caller list.
    const tsconfig = J({ compilerOptions: { target: 'es2020', module: 'commonjs' }, include: ['src', 'test'] });
    const repo = mkRepo({ 'tsconfig.json': tsconfig, 'src/t.ts': TARGET_V1 });
    write(repo, { 'src/t.ts': TARGET_V2 });
    commit(repo);
    write(repo, {
      'src/scratch.ts': "import { target } from './t';\nexport function scratch() {\n  return target(1);\n}\n",
      'test/t.test.ts': "import { target } from '../src/t';\nexport function probe() {\n  return target(2);\n}\n",
    });
    const r = await analyze(repo, { mode: 'pr', base: 'HEAD~1' });
    const c = byLabel(r, 'target');
    check('an untracked test does not cover a symbol with no committed callers',
      c.callerState === 'none' && c.testState === 'uncovered' && c.tests.length === 0, J({ state: c.callerState, test: c.testState, tests: c.tests }));
    const tree = r.components[0].forest.find((t) => t.label === 'target');
    check('and untracked callers stay out of the tree', !!tree && (tree.children || []).length === 0, J(tree && (tree.children || []).map((k) => k.label)));
  }

  // ================================================================ bases =====
  console.log('▸ base resolution');
  {
    const repo = mkRepo({ 'a.txt': '1\n' }, { ts: false });
    let err = null;
    try { await analyze(repo, { mode: 'checkpoint', checkpoint: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }); } catch (e) { err = e; }
    check('an unknown checkpoint is a readable error', err && err.code === 'NO_CHECKPOINT', err && err.message);
  }
  {
    // Shallow CI checkout: no merge-base, and the old fallback diffed against the base
    // TIP -- every commit main gained since the branch point shown as deleted here.
    const origin = mkRepo({ 'a.txt': '1\n' }, { ts: false });
    run(origin, ['checkout', '-qb', 'feature']); write(origin, { 'mine.txt': 'x\n' }); commit(origin);
    run(origin, ['checkout', '-q', 'main']);
    for (let i = 0; i < 3; i++) { write(origin, { [`main${i}.txt`]: 'x\n' }); commit(origin); }
    const shallow = path.join(TMP, uniq('shallow'));
    run(TMP, ['clone', '-q', '--depth', '1', '--no-single-branch', '--branch', 'feature', `file://${origin}`, shallow]);
    let err = null;
    try { await analyze(shallow, { mode: 'pr', base: 'main', ...fast }); } catch (e) { err = e; }
    check('a shallow clone without a merge-base fails loudly', err && err.code === 'NO_MERGE_BASE' && /shallow/.test(err.message), err && err.message);
  }
  {
    // `git fetch origin main` on a single-branch clone moves FETCH_HEAD only.
    const origin = mkRepo({ 'a.txt': '1\n' }, { ts: false });
    run(origin, ['checkout', '-qb', 'feature']); write(origin, { 'f.txt': 'f\n' }); commit(origin);
    const sb = path.join(TMP, uniq('sb'));
    run(TMP, ['clone', '-q', '--single-branch', '--branch', 'feature', `file://${origin}`, sb]);
    run(sb, ['fetch', '-q', 'origin', 'main:refs/remotes/origin/main']);
    run(origin, ['checkout', '-q', 'main']); write(origin, { 'later.txt': 'x\n' });
    const tip = commit(origin);
    const r = resolveBase(makeGit(sb), 'main', { fetch: true });
    check('sync fetch updates the remote-tracking ref', r.sha === tip, `${r.sha.slice(0, 8)} vs ${tip.slice(0, 8)}`);
    write(origin, { 'later2.txt': 'x\n' });
    const tip2 = commit(origin);
    const r2 = await resolveBaseAsync(makeGit(sb), 'main', { fetch: true });
    check('async fetch does too', r2.sha === tip2 && r2.notes.some((n) => n.startsWith('fetched')), J(r2.notes));
    const r3 = await resolveBaseAsync(makeGit(sb), 'no-such-branch', { fetch: true, allowLocal: true }).catch((e) => e);
    check('a failed fetch is reported, not thrown as a fetch error', r3 instanceof Error ? /cannot resolve/.test(r3.message) : true, r3 && r3.message);
  }

  console.log('▸ batched blob reads');
  {
    const repo = mkRepo({ 'a.ts': 'A\n', 'dir/b c.ts': 'B\n', 'é.ts': 'E\n' }, { ts: false });
    const git = makeGit(repo);
    const m = git.showMany('HEAD', ['a.ts', 'dir/b c.ts', 'é.ts', 'missing.ts']);
    check('showMany matches show for every path', ['a.ts', 'dir/b c.ts', 'é.ts', 'missing.ts'].every((p) => m.get(p) === git.show('HEAD', p)), J([...m]));
  }

  console.log('▸ loadTypeScript');
  {
    const fake = path.join(TMP, 'ts7');
    fs.mkdirSync(path.join(fake, 'node_modules', 'typescript'), { recursive: true });
    fs.writeFileSync(path.join(fake, 'node_modules', 'typescript', 'package.json'), J({ name: 'typescript', version: '7.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(fake, 'node_modules', 'typescript', 'index.js'), 'module.exports = { version: "7.0.0" };\n');
    const got = loadTypeScript(fake, fake);
    check('a compiler without the classic API is skipped', typeof got.createSourceFile === 'function', got.version);
  }

  console.log('▸ cli help');
  {
    const help = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), '--help'], { encoding: 'utf8' });
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
    const want = /const DEFAULTS = \{ depth: (\d+), treeDepth: (\d+) \}/.exec(src);
    check('help shows the defaults the code uses', want && help.includes(`test reach (default ${want[1]})`) && help.includes(`tree depth (default ${want[2]})`), help.split('\n').filter((l) => /depth/.test(l)).join(' | '));
  }

  {
    const dir = mkRepo({ 'packages/pkg/tsconfig.json': '{"include":["src"]}',
      'packages/pkg/src/old.ts': 'export function f(a:number){\n const x=a+1;\n const y=x*2;\n return y;\n}\n' });
    const base = headOf(dir);
    run(dir, ['mv','packages/pkg/src/old.ts','packages/pkg/src/new.ts']);
    const file = path.join(dir,'packages/pkg/src/new.ts');
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('a+1','a+2'));
    run(dir,['add','-A']);
    const r = await analyze(dir,since(base));
    check('hoisted package is analysed',r.allChanged.some(c=>c.label==='f'),J(r.warnings));
    check('renamed finding retains base path',r.allChanged[0]?.oldPath==='packages/pkg/src/old.ts');
    check('rename mapping covers file and caller navigation',r.basePaths?.['packages/pkg/src/new.ts']==='packages/pkg/src/old.ts');
  }

  {
    const dir = mkRepo({
      'lib/tsconfig.json': '{"include":["*.ts"]}',
      'app/tsconfig.json': '{"include":["*.ts"]}',
      'lib/api.ts': 'export function target(){return 1;}\n',
      'app/use.ts': "import {target} from '../lib/api'; export function caller(){return target();}\n",
      'app/unrelated.ts': 'function target(){return 0;} export function unrelated(){return target();}\n',
    });
    const base=headOf(dir);
    write(dir,{'lib/api.ts':'export function target(value?:number){return value || 1;}\n'});
    const r=await analyze(dir,since(base));
    check('unchanged consuming project contributes callers',J(byLabel(r,'target')?.callers.map(c=>c.label))===J(['caller']));
    write(dir,{'app/use.ts': "import {target} from '../lib/api'; export function caller(){\n console.log('edited');\n return target();\n}\n"});
    const updated=await analyze(dir,since(base));
    check('cross-project callers are deduplicated',byLabel(updated,'target')?.callers.length===1);
    const { createTsResolver } = require('../src/engine/resolver-ts');
    const resolver=createTsResolver(ts,path.join(dir,'lib'),{repoRoot:dir});
    check('lazy queries also search consumers',(await resolver.incoming(path.join(dir,'lib/api.ts'),16)).some(c=>c.label==='caller'));
    resolver.dispose();
  }

  console.log('▸ projects without a tsconfig, and CommonJS modules');
  const CJS_TARGET = (n) => `function registerCommands(x) {\n  return [x, ${n}];\n}\nmodule.exports = { registerCommands };\n`;
  const CJS_CALLERS = {
    'src/destructured.js': "const { registerCommands } = require('./a');\nfunction activate() {\n  return registerCommands(1);\n}\nmodule.exports = { activate };\n",
    'src/namespace.js': "const a = require('./a');\nfunction viaNamespace() {\n  return a.registerCommands(2);\n}\n",
    'src/inline.js': "function inline() {\n  return require('./a').registerCommands(3);\n}\n",
    // A parameter named `require` is not the module loader.
    'src/shadowed.js': "function shadowed(require) {\n  return require('./a').registerCommands(4);\n}\n",
    'test/a.test.js': "const { registerCommands } = require('../src/a');\nfunction testsIt() {\n  return registerCommands(5);\n}\n",
  };
  const labelsOf = (c) => (c ? c.callers.map((x) => x.label).sort() : null);
  {
    // No tsconfig.json or jsconfig.json: every changed file was dropped before analysis
    // and the tree was empty with no warning.
    const repo = mkRepo({ 'src/a.js': CJS_TARGET(0), ...CJS_CALLERS });
    const base = headOf(repo);
    write(repo, { 'src/a.js': CJS_TARGET(1) });
    const r = await analyze(repo, since(base));
    const c = byLabel(r, 'registerCommands');
    check('a file with no config is analysed', !!c, J(r.allChanged.map((x) => x.label)));
    check('and the run says it used an inferred project', r.warnings.some((w) => w.includes('no tsconfig.json or jsconfig.json')), J(r.warnings));
    // TypeScript's call hierarchy does not follow require() back to the declaration:
    // these all came back empty, and the symbol showed as "unknown".
    check('destructured, namespace and inline require() callers are found',
      J(labelsOf(c)) === J(['activate', 'inline', 'testsIt', 'viaNamespace']), J(labelsOf(c)));
    check('a test caller is classified as a test', c && c.callers.find((x) => x.label === 'testsIt')?.test === true);
    check('callers carry call sites', c && c.callers.every((x) => x.callSites.length === 1), J(c && c.callers.map((x) => x.callSites)));
  }
  {
    // A jsconfig.json defines a project exactly as a tsconfig.json does.
    const repo = mkRepo({
      'jsconfig.json': J({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' }, include: ['src'] }),
      'src/a.js': 'export function target(a) {\n  return a;\n}\n',
      'src/b.js': "import { target } from './a.js';\nexport function caller() {\n  return target(1);\n}\n",
    });
    const base = headOf(repo);
    write(repo, { 'src/a.js': 'export function target(a, b) {\n  return a + b;\n}\n' });
    const r = await analyze(repo, since(base));
    const c = byLabel(r, 'target');
    check('a jsconfig.json project is analysed as a project', c && c.component === '(root)', c && c.component);
    check('its ESM callers come from TypeScript', J(labelsOf(c)) === J(['caller']), J(labelsOf(c)));
    check('no inferred-project warning', !r.warnings.some((w) => w.includes('inferred')), J(r.warnings));
  }
  {
    // ESM with no config: the inferred project still sees callers in other files.
    const repo = mkRepo({
      'src/a.mjs': 'export function target(a) {\n  return a;\n}\n',
      'src/b.mjs': "import { target } from './a.mjs';\nexport function caller() {\n  return target(1);\n}\n",
    });
    const base = headOf(repo);
    write(repo, { 'src/a.mjs': 'export function target(a, b) {\n  return a + b;\n}\n' });
    const r = await analyze(repo, since(base));
    check('ESM callers are found with no config', J(labelsOf(byLabel(r, 'target'))) === J(['caller']), J(labelsOf(byLabel(r, 'target'))));
  }
  {
    // CommonJS inside a configured project: the project loads, but TypeScript still
    // cannot report the cross-file callers.
    const repo = mkRepo({
      'tsconfig.json': J({ compilerOptions: { allowJs: true, module: 'commonjs', noEmit: true }, include: ['src'] }),
      'src/a.js': CJS_TARGET(0),
      'src/destructured.js': CJS_CALLERS['src/destructured.js'],
    });
    const base = headOf(repo);
    write(repo, { 'src/a.js': CJS_TARGET(1) });
    const r = await analyze(repo, since(base));
    check('CommonJS callers are found inside a tsconfig project', J(labelsOf(byLabel(r, 'registerCommands'))) === J(['activate']), J(labelsOf(byLabel(r, 'registerCommands'))));
  }
  {
    const repo = mkRepo({
      'src/c.js': 'exports.direct = function direct(x) {\n  return x;\n};\n',
      'src/d.js': "const { direct } = require('./c');\nfunction user() {\n  return direct(1);\n}\n",
    });
    const base = headOf(repo);
    write(repo, { 'src/c.js': 'exports.direct = function direct(x) {\n  return x + 1;\n};\n' });
    const r = await analyze(repo, since(base));
    const c = r.allChanged.find((x) => x.relPath === 'src/c.js');
    check('`exports.x = function` callers are found', J(labelsOf(c)) === J(['user']), c && `${c.label} ${c.callerState} ${J(labelsOf(c))}`);
  }
  {
    // The editor's inferred project holds only open files, so its server answers
    // "no callers" for code called from closed files. Lazy expansion goes through the
    // session's resolver, not analyze's, and must add the same callers.
    const { withModuleCallers } = require('../src/engine/module-callers');
    const repo = mkRepo({ 'src/a.js': CJS_TARGET(0), 'src/destructured.js': CJS_CALLERS['src/destructured.js'] });
    const base = headOf(repo);
    write(repo, { 'src/a.js': CJS_TARGET(1) });
    const blind = {
      incoming: async () => [],
      incomingWithStatus: async () => ({ callers: [], complete: true }),
      callerState: async () => ({ state: 'none', callers: [] }),
      clear() {}, stats: () => ({}),
    };
    const r = await analyze(repo, since(base, { makeResolver: () => blind }));
    const c = byLabel(r, 'registerCommands');
    check('an editor resolver that sees no callers is corrected', J(labelsOf(c)) === J(['activate']) && c.callerState === 'resolved', c && `${c.callerState} ${J(labelsOf(c))}`);
    check('the result carries the module callers, outside its JSON', !!r.moduleCallers && !('moduleCallers' in JSON.parse(J(r))));
    const lazy = withModuleCallers(blind, r.moduleCallers);
    const answer = await lazy.incomingWithStatus(c.file, c.namePos, true);
    check('lazy expansion sees the same callers', J(answer.callers.map((x) => x.label)) === J(['activate']) && answer.complete === true, J(answer));
    const plain = path.join(repo, 'src/destructured.js');
    check('files that need no index pass through untouched', r.moduleCallers.appliesTo(plain) === 'no-config'
      && withModuleCallers(blind, null) === blind);

    // The server's "none" is not evidence when the index could not search everything:
    // a file over the size budget is not indexed, and could hold the caller.
    const budget = mkRepo({
      'src/a.js': CJS_TARGET(0),
      'src/vendor.js': `// ${'x'.repeat(1024 * 1024)}\nmodule.exports = {};\n`,
    });
    const base2 = headOf(budget);
    write(budget, { 'src/a.js': CJS_TARGET(1) });
    const r2 = await analyze(budget, since(base2, { makeResolver: () => blind }));
    const d = byLabel(r2, 'registerCommands');
    check('an editor "none" with an unfinished index search is unknown', d && d.callerState === 'unknown', d && d.callerState);
    check('and the run names the skipped file count', r2.warnings.some((w) => w.includes('1 file(s) were not indexed')), J(r2.warnings));
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
