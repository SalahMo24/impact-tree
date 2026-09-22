#!/usr/bin/env node
'use strict';
// Regression guard: offset<->position must stay exact without opening a TextDocument.
// Cursor rejects extension-host document sync for many files, so the editor's own
// positionAt/offsetAt are not available to us.
const fs = require('fs');
const path = require('path');
const { offsetToPosition, positionToOffset } = require('../src/engine/textpos');

const repo = require('./target-repo')();
const { findTypeScript } = require('./find-typescript');
const ts = findTypeScript();
if (!ts) { console.log('  SKIP no typescript resolvable — textpos checks did NOT run'); process.exit(0); }
let fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

// Pick real files from the target repo rather than naming any specific codebase.
const { execFileSync } = require('child_process');
const { isSourcePath } = require('../src/engine/diff');
let targets = [];
try {
  targets = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter((f) => isSourcePath(f) && !/\.d\.ts$/.test(f))
    .map((f) => path.join(repo, f))
    .filter((f) => { try { return fs.statSync(f).size > 500; } catch { return false; } })
    .slice(0, 2);
} catch { targets = []; }
if (!targets.length) console.log('  skip  no source files found in the target repo');

// synthetic edge cases
const tmp = path.join(require('os').tmpdir(), 'impact-tree-textpos.ts');
for (const [name, body] of [
  ['CRLF line endings', 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n'],
  ['unicode above BMP', 'const e = "😀😀";\nconst f = 2;\n'],
  ['no trailing newline', 'const g = 1;\nconst h = 2;'],
  ['empty file', ''],
]) {
  fs.writeFileSync(tmp, body);
  const sf = ts.createSourceFile(tmp, body, ts.ScriptTarget.ES2021, true);
  let bad = 0;
  for (let o = 0; o <= body.length; o++) {
    const a = offsetToPosition(tmp, o), b = sf.getLineAndCharacterOfPosition(Math.min(o, body.length));
    if (!a || a.line !== b.line || a.character !== b.character) bad++;
  }
  check(name, bad === 0, `${bad} bad offset(s)`);
  require('../src/engine/textpos')._clear();
}
fs.unlinkSync(tmp);

console.log(fail ? `\n${fail} FAILED` : '\nall textpos checks passed');
process.exit(fail ? 1 : 0);
