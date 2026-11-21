#!/usr/bin/env node
// @ts-check
'use strict';
// The end-of-task checks as one command, the same ones CI runs:
//
//   npm run check            lint, typecheck, the full test suite (about 1 min)
//   npm run check -- --quick lint, typecheck, the quick tier (about 25 s), while iterating
//
// Every step runs even after one fails, so one run lists every problem. A passing step prints one
// line; a failing step also prints the last lines of its output. Exit 0 when all passed, else 1.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
/** Output lines shown for a failing step. Unit: lines. */
const FAIL_TAIL_LINES = 40;

const quick = process.argv.includes('--quick');
const STEPS = [
  { name: 'lint', args: ['run', '-s', 'lint'] },
  { name: 'typecheck', args: ['run', '-s', 'typecheck'] },
  quick ? { name: 'test:quick', args: ['run', '-s', 'test:quick'] } : { name: 'test', args: ['test', '-s'] },
];

let failed = 0;
for (const step of STEPS) {
  const t0 = Date.now();
  const r = spawnSync('npm', step.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) { console.log(`ok    ${step.name}  ${secs} s`); continue; }
  failed++;
  console.log(`FAIL  ${step.name}  ${secs} s  (exit ${r.status ?? r.signal})`);
  const lines = `${r.stdout || ''}${r.stderr || ''}`.trimEnd().split('\n');
  for (const line of lines.slice(-FAIL_TAIL_LINES)) console.log(`      ${line}`);
}
console.log(failed ? `${failed} of ${STEPS.length} step(s) failed` : `all ${STEPS.length} steps passed`);
process.exit(failed ? 1 : 0);
