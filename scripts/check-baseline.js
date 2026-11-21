#!/usr/bin/env node
// @ts-check
'use strict';
// The engine-change checks that need the maintainer's local test repositories, as one command:
//
//   npm run check:baseline              both checks below
//   npm run check:baseline -- --cli     only the TypeScript CLI baseline
//   npm run check:baseline -- --preview only the preview goldens
//
// 1. TypeScript CLI baseline: baseline/compare.sh in the scratchpad folder
//    (test/lsp-harness/scratchpad.js) re-runs every recorded case with this checkout's engine and
//    diffs the normalised output. It checks out branches in the shared test repositories, so it
//    runs under with-repo-lock.sh (one at a time).
// 2. Preview goldens: test/lsp-harness/preview-golden.js --compare (no checkout, no lock).
//
// Run it when src/engine/ or a language's analysis changes, once at the end of the task. Not in CI:
// the test repositories and the recorded outputs are local to the maintainer's machine
// (`npm run -s local-notes`). The summary says "same" or lists the differing cases; full diffs stay
// in the folder compare.sh names. Exit 0 all same, 1 a difference or a failed run, 2 the scratchpad
// is not set up here.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { scratchpadPath } = require('../test/lsp-harness/scratchpad');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const only = args.includes('--cli') ? 'cli' : args.includes('--preview') ? 'preview' : null;

const compare = scratchpadPath('baseline', 'compare.sh');
const lock = scratchpadPath('with-repo-lock.sh');
for (const needed of only === 'preview' ? [] : [compare, lock]) {
  if (!fs.existsSync(needed)) { console.error(`check:baseline: ${needed} is missing: the baseline is not set up on this machine (npm run -s local-notes)`); process.exit(2); }
}

/** @param {string} name @param {string} cmd @param {string[]} argv @param {RegExp} keep lines worth showing */
function run(name, cmd, argv, keep) {
  const t0 = Date.now();
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n');
  const ok = r.status === 0;
  console.log(`${ok ? 'same' : 'DIFF'}  ${name}  ${secs} s`);
  for (const line of lines) if (ok ? /outputs kept/.test(line) : keep.test(line)) console.log(`      ${line}`);
  return ok;
}

let ok = true;
if (only !== 'preview') ok = run('TypeScript CLI baseline', 'bash', [lock, 'bash', compare, ROOT], /DIFFERENT|RUN FAILED|outputs kept|lock|engine has no/) && ok;
if (only !== 'cli') ok = run('preview goldens', 'node', [path.join(ROOT, 'test/lsp-harness/preview-golden.js'), '--compare'], /\b(DIFF|differ|missing|error|bad)\b|PR\(s\) in/i) && ok;
process.exit(ok ? 0 : 1);
