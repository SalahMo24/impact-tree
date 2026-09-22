#!/usr/bin/env node
'use strict';
// Regression guard for the Tier A failure: a monorepo installs per package, so the
// repo root has no typescript of its own and the lookup came up empty. The extension
// also has to work on a repo with no install at all, via its own bundled copy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTypeScript } = require('../src/engine/analyze');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'it-loadts-'));
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };

// A fake typescript install, distinguishable from the real one by its version.
function fakeTypeScript(dir, version) {
  const mod = mk(path.join(dir, 'node_modules', 'typescript'));
  fs.writeFileSync(path.join(mod, 'package.json'),
    JSON.stringify({ name: 'typescript', version, main: 'index.js' }));
  // Must expose the compiler API, or the loader rightly rejects it and these tests
  // would pass by falling back to the bundled copy instead of proving search order.
  fs.writeFileSync(path.join(mod, 'index.js'),
    `module.exports = { version: '${version}', createSourceFile() {}, createLanguageService() {} };\n`);
}

console.log('▸ monorepo with no root install');
{
  const repo = mk(path.join(tmp, 'mono'));
  mk(path.join(repo, 'components', 'svc', 'src'));
  fakeTypeScript(path.join(repo, 'components', 'svc'), '9.9.9-nested');
  const ts = loadTypeScript(repo, repo);
  check('finds a per-package install two levels down', ts.version === '9.9.9-nested', ts.version);
}

console.log('\n▸ one level down');
{
  const repo = mk(path.join(tmp, 'flat'));
  mk(path.join(repo, 'app'));
  fakeTypeScript(path.join(repo, 'app'), '9.9.8-onelevel');
  const ts = loadTypeScript(repo, repo);
  check('finds a package one level down', ts.version === '9.9.8-onelevel', ts.version);
}

console.log('\n▸ the project dir wins');
{
  const repo = mk(path.join(tmp, 'pref'));
  const proj = mk(path.join(repo, 'packages', 'a'));
  mk(path.join(repo, 'packages', 'b'));
  fakeTypeScript(repo, '1.0.0-root');
  fakeTypeScript(proj, '2.0.0-project');
  const ts = loadTypeScript(repo, proj);
  check('the project\'s own version is preferred over the root', ts.version === '2.0.0-project', ts.version);
}

console.log('\n▸ repo with no typescript anywhere');
{
  const repo = mk(path.join(tmp, 'bare'));
  mk(path.join(repo, 'src'));
  const ts = loadTypeScript(repo, repo);
  check('falls back to the copy shipped with the extension', !!ts && typeof ts.createSourceFile === 'function',
    ts && ts.version);
  check('and that copy is a real typescript', !!ts && !/^9\.9\./.test(ts.version), ts && ts.version);
}

console.log('\n▸ a typescript without the classic compiler API');
{
  // TypeScript 7 is the native rewrite: it exports `version` and `unstable/*` only.
  // Loading it would hand the engine a module with no createSourceFile, failing far
  // from the cause. It must be rejected in favour of a usable one.
  const repo = mk(path.join(tmp, 'ts7'));
  const proj = mk(path.join(repo, 'app'));
  const mod = mk(path.join(proj, 'node_modules', 'typescript'));
  fs.writeFileSync(path.join(mod, 'package.json'),
    JSON.stringify({ name: 'typescript', version: '7.0.2', main: 'index.js' }));
  fs.writeFileSync(path.join(mod, 'index.js'),
    "module.exports = { version: '7.0.2', versionMajorMinor: '7.0' };\n");
  const ts = loadTypeScript(repo, proj);
  check('a v7-shaped package is rejected', ts.version !== '7.0.2', ts.version);
  check('and a usable compiler is returned instead',
    typeof ts.createSourceFile === 'function' && typeof ts.createLanguageService === 'function');
}
{
  // ...but if a sibling has a real one, prefer that over the bundled copy
  const repo = mk(path.join(tmp, 'ts7-sibling'));
  const bad = mk(path.join(repo, 'a'));
  const good = mk(path.join(repo, 'b'));
  const mod = mk(path.join(bad, 'node_modules', 'typescript'));
  fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2', main: 'index.js' }));
  fs.writeFileSync(path.join(mod, 'index.js'), "module.exports = { version: '7.0.2' };\n");
  fakeTypeScript(good, '9.9.7-usable');
  const ts = loadTypeScript(repo, repo);
  check('a v7 sibling is skipped and the usable one is chosen',
    ts.version === '9.9.7-usable', ts.version);
}

console.log('\n▸ node_modules without typescript in it');
{
  const repo = mk(path.join(tmp, 'partial'));
  mk(path.join(repo, 'pkg', 'node_modules', 'lodash'));
  const ts = loadTypeScript(repo, repo);
  check('does not throw; falls through to the bundled copy',
    !!ts && typeof ts.createSourceFile === 'function');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failure(s)` : '\nall loadTypeScript checks passed');
process.exit(fail ? 1 : 0);
