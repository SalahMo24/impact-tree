'use strict';
// Throwaway git repos for local (Tier B) analysis checks. Each suite creates its
// own temp tree so the files can run independently.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { requireTypeScript } = require('./find-typescript');

const J = JSON.stringify;
const TSCONFIG = J({ compilerOptions: { target: 'es2020', lib: ['es2020'], types: [], skipLibCheck: true, module: 'commonjs', strict: false, experimentalDecorators: true }, include: ['src'] });
const TARGET_V1 = 'export function target(a: number) {\n  return a;\n}\n';
const TARGET_V2 = 'export function target(a: number, strict?: boolean) {\n  return a;\n}\n';
const fast = { skipForest: true, deferTestReach: true };
const since = (base, extra = {}) => ({ mode: 'checkpoint', checkpoint: base, ...fast, ...extra });

function createLocalHarness() {
  const ts = requireTypeScript('local analysis');
  const TS_DIR = path.dirname(require.resolve('typescript/package.json', { paths: [path.dirname(require.resolve('./find-typescript'))] }));
  const { makeSymbols } = require('../src/engine/symbols');
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-local-')));
  const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let seq = 0;
  // An initialised, configured repo built once per process; each test repo starts as a copy.
  let template = null;
  const emptyRepo = () => {
    if (template) return template;
    template = path.join(TMP, '.template');
    fs.mkdirSync(template);
    run(template, ['init', '-q', '--initial-branch=main']);
    run(template, ['config', 'user.email', 't@example.com']);
    run(template, ['config', 'user.name', 'test']);
    return template;
  };
  let fail = 0;
  const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
    if (!cond) fail++;
  };
  function write(dir, files) {
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(dir, rel);
      if (text === null) { fs.rmSync(p, { force: true }); continue; }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
  }
  function linkTs(dir, target = TS_DIR) {
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(target, path.join(dir, 'node_modules', 'typescript'));
  }
  function mkRepo(files, { parent = TMP, name = `r${seq++}`, ts: withTs = true } = {}) {
    const dir = path.join(parent, name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(emptyRepo(), dir, { recursive: true });
    write(dir, { '.gitignore': 'node_modules\n', ...files });
    run(dir, ['add', '-A']);
    run(dir, ['commit', '-qm', 'base']);
    if (withTs) linkTs(dir);
    return dir;
  }
  const commit = (dir) => { run(dir, ['add', '-A']); run(dir, ['commit', '-qm', 'c']); return run(dir, ['rev-parse', 'HEAD']).trim(); };
  const headOf = (dir) => run(dir, ['rev-parse', 'HEAD']).trim();
  const byLabel = (r, label) => r.allChanged.find((c) => c.label === label);
  const callStates = (c) => (c ? c.callers.map((x) => `${x.label}[${x.callState}]`) : null);
  const S = makeSymbols(ts);
  const parse = (text, name = 'x.ts') => ts.createSourceFile(name, text, ts.ScriptTarget.ES2021, true);
  const finish = () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(fail ? `\n${fail} FAILED` : '\nall local analysis checks passed');
    process.exit(fail ? 1 : 0);
  };
  const uniq = (prefix) => `${prefix}${seq++}`;
  return {
    ts, TS_DIR, TMP, TSCONFIG, TARGET_V1, TARGET_V2, fast, since, J,
    run, write, linkTs, mkRepo, commit, headOf, byLabel, callStates, S, parse, check, finish, uniq,
  };
}

module.exports = { createLocalHarness, TSCONFIG, TARGET_V1, TARGET_V2, fast, since, J };
