#!/usr/bin/env node
// @ts-check
'use strict';
// A PreToolUse hook for coding agents (.claude/settings.json): refuses shell commands that redo by
// hand what a repository command already does, and says which command to run instead. Agents ran
// test files one by one (`node --test test/x.test.js`, then grep for `# pass`) hundreds of times;
// `npm run t -- <names>` gives the same answer in one line per file, with deadlines.
//
// Reads the hook's JSON on stdin; prints a deny decision as JSON, or nothing to let the call run.
// Never fails the call itself: a parse error lets it run. To run a test file directly on purpose
// (to read its whole passing output), put IT_RAW_TEST=1 in front of the command.

/** A bare test-file run: node [flags] [--test] [path/]test/NAME.test.js, not through test/run.js. */
const BARE_TEST = /(?:^|[\s;&|(])node\s+(?:--[\w-]+(?:=\S+)?\s+)*(?:\S*\/)?test\/(?!run\.js)([\w./-]+?)\.test\.js\b/g;

/**
 * @param {string} command a Bash command line
 * @returns {string|null} why it is refused, with the command to run instead; null to let it run
 */
function guardBash(command) {
  if (/\bIT_RAW_TEST=1\b/.test(command)) return null;
  const names = [...command.matchAll(BARE_TEST)].map((m) => m[1].split('/').pop());
  if (!names.length) return null;
  return `Run test files through the runner: npm run t -- ${[...new Set(names)].join(' ')}\n`
    + '(one line per file with pass/fail counts and time, failing lines included; --verbose for a failing file\'s whole output). '
    + 'To run a file directly on purpose, prefix the command with IT_RAW_TEST=1.';
}

function main() {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(input);
      if (event.tool_name !== 'Bash') return;
      const reason = guardBash(String(event.tool_input?.command ?? ''));
      if (!reason) return;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    } catch { /* not a hook event we understand: let the call run */ }
  });
}

if (require.main === module) main();

module.exports = { guardBash };
