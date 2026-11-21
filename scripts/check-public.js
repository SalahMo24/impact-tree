#!/usr/bin/env node
// @ts-check
'use strict';
// The repository is public. This refuses staged lines that name the maintainer's machine or the
// local test codebases: patterns from public-denylist.txt in the scratchpad folder
// (test/lsp-harness/scratchpad.js), kept outside the repository so the list itself stays private.
//
//   npm run -s check:public            the staged changes (the pre-commit hook runs this)
//   npm run -s check:public -- <ref>   the changes since <ref>, such as origin/main
//
// Only added lines are checked: what is already in the history is out of its reach. Without a
// denylist on the machine it prints a note and passes. Exit 0 clean, 1 a match (each printed).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { scratchpadPath } = require('../test/lsp-harness/scratchpad');

const list = scratchpadPath('public-denylist.txt');
if (!fs.existsSync(list)) { console.log('check:public: no denylist on this machine; skipped'); process.exit(0); }
const patterns = fs.readFileSync(list, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => new RegExp(l, 'i'));

const ref = process.argv[2];
const diff = execFileSync('git', ['diff', '-U0', '--no-color', ...(ref ? [ref] : ['--cached'])], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
let file = '';
let line = 0;
let hits = 0;
for (const text of diff.split('\n')) {
  if (text.startsWith('+++ ')) { file = text.replace(/^\+\+\+ (b\/)?/, ''); continue; }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
  if (hunk) { line = Number(hunk[1]); continue; }
  if (!text.startsWith('+')) continue;
  if (patterns.some((p) => p.test(text))) { hits++; console.log(`${file}:${line}: names a local path or test codebase`); }
  line++;
}
if (hits) console.log(`check:public: ${hits} line(s) would publish machine or test-codebase details; move them to the local notes (npm run -s local-notes)`);
process.exit(hits ? 1 : 0);
