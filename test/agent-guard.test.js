'use strict';
// scripts/agent-guard.js: which shell commands the agents' PreToolUse hook refuses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { guardBash } = require('../scripts/agent-guard');

test('bare test-file runs are refused with the runner command', () => {
  for (const [cmd, names] of [
    ['node --test test/entry-points.test.js 2>&1 | grep -E "^# (pass|fail)"', 'entry-points'],
    ['cd /abs/repo && node test/drive-guards.test.js', 'drive-guards'],
    ['time node --max-old-space-size=8192 test/callsites.test.js; node test/a.test.js', 'callsites a'],
    ['node /abs/wt/test/x.test.js && node --test test/x.test.js', 'x'],
  ]) {
    const reason = guardBash(cmd);
    assert.ok(reason, cmd);
    assert.match(reason, new RegExp(`npm run t -- ${names}\\n`), cmd);
  }
});

test('the runner, harness scripts and the explicit escape run', () => {
  for (const cmd of [
    'node test/run.js --only entry-points', 'npm run t -- entry-points', 'npm test',
    'node test/lsp-harness/csharp-verify.js --syntactic', 'IT_RAW_TEST=1 node test/x.test.js',
    'grep -n "x" test/entry-points.test.js', 'cat test/suite.js',
  ]) assert.equal(guardBash(cmd), null, cmd);
});

test('as a hook: deny JSON for a bare run, nothing otherwise, nothing on bad input', () => {
  const run = (input) => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'agent-guard.js')], { input, encoding: 'utf8' });
  const out = JSON.parse(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node --test test/x.test.js' } })));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })), '');
  assert.equal(run('not json'), '');
});
