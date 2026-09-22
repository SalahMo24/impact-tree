#!/usr/bin/env node
'use strict';
// Guards the one class of bug the stubbed-provider tests structurally cannot see:
// an identifier used at module scope that is only declared inside a function.
// tree-smoke.js injects every collaborator, so it never loads src/extension.js and
// never notices that `review` was a local of activate(). TypeScript's own checker
// does the scope analysis; we keep only "Cannot find name" (2304) and ignore the
// ambient names a plain Node module is entitled to use.
const fs = require('fs');
const path = require('path');

// This check needs a TypeScript install but not a target repo.
const { findTypeScript } = require('./find-typescript');
const ts = findTypeScript();
if (!ts) {
  console.log('  SKIP no typescript resolvable — scope check did NOT run');
  process.exit(0);
}

const AMBIENT = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console',
  'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'URL',
  'TextEncoder', 'TextDecoder', 'global', 'globalThis', 'structuredClone', 'AbortController',
]);

const srcDir = path.join(__dirname, '..', 'src');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(srcDir);

// `vscode` is resolved by the Extension Host, not by node_modules — stub its shape away.
const shimDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'it-scope-'));
fs.writeFileSync(path.join(shimDir, 'vscode.d.ts'), 'declare module "vscode" { const v: any; export = v; }\n');

const program = ts.createProgram([...files, path.join(shimDir, 'vscode.d.ts')], {
  allowJs: true, checkJs: true, noEmit: true, moduleResolution: ts.ModuleResolutionKind.NodeJs,
  target: ts.ScriptTarget.ES2020, types: [], skipLibCheck: true,
});

let fail = 0;
const seen = [];
for (const f of files) {
  const sf = program.getSourceFile(f);
  if (!sf) continue;
  for (const d of program.getSemanticDiagnostics(sf)) {
    if (d.code !== 2304) continue;                       // Cannot find name 'x'
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const name = (msg.match(/Cannot find name '([^']+)'/) || [])[1];
    if (AMBIENT.has(name)) continue;
    const { line } = sf.getLineAndCharacterOfPosition(d.start);
    seen.push(`${path.relative(srcDir, f)}:${line + 1}  ${msg}`);
    fail++;
  }
}

seen.forEach((s) => console.log(`  FAIL ${s}`));
if (!fail) console.log(`  ok   no undeclared identifiers across ${files.length} source files`);
console.log(fail ? `\n${fail} scope error(s)` : '\nall scope checks passed');
process.exit(fail ? 1 : 0);
