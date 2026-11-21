#!/usr/bin/env node
// @ts-check
'use strict';
// Gets a checkout ready to work in: `npm run setup` (also run by `npm install`, as `prepare`).
//
//   - Points git at the repository's hooks (.githooks/: lint and typecheck before a commit, the
//     quick tests before a push). The setting is shared by every worktree of the repository.
//   - In a worktree (a second working tree of the same repository), links node_modules and
//     .vscode-test to the main checkout's, so the tests and scripts/drive.js run without an
//     install or a 380 MB editor download. Both are git-ignored, links included.
//
// Prints one line per thing it did or found already done. Exit 0, or 1 when git is missing.
// `--hooks-only` skips the links (the `prepare` run: it must not need a main checkout).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function main() {
  const hooksOnly = process.argv.includes('--hooks-only');
  let root;
  try { root = git(['rev-parse', '--show-toplevel'], process.cwd()); } catch {
    // Not a git checkout (an unpacked package): nothing to set up.
    if (hooksOnly) return;
    console.error('setup: not inside a git checkout');
    process.exit(1);
  }
  const hooksDir = path.join(root, '.githooks');
  if (fs.existsSync(hooksDir)) {
    const current = (() => { try { return git(['config', '--get', 'core.hooksPath'], root); } catch { return ''; } })();
    if (current === '.githooks') console.log('hooks: already .githooks');
    else { git(['config', 'core.hooksPath', '.githooks'], root); console.log('hooks: core.hooksPath set to .githooks'); }
  }
  if (hooksOnly) return;

  const main = path.dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root));
  if (path.resolve(main) === path.resolve(root)) { console.log('links: main checkout, none needed'); return; }
  for (const name of ['node_modules', '.vscode-test']) {
    const here = path.join(root, name);
    const there = path.join(main, name);
    if (fs.existsSync(here)) { console.log(`links: ${name} already present`); continue; }
    if (!fs.existsSync(there)) { console.log(`links: ${name} missing in the main checkout ${main} too; run npm install there`); continue; }
    fs.symlinkSync(there, here);
    console.log(`links: ${name} -> ${there}`);
  }
}

main();
