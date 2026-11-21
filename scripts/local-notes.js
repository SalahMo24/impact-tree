#!/usr/bin/env node
// @ts-check
'use strict';
// Prints the maintainer's local notes: machine paths, the test repositories the oracles and the
// baseline run against, tool installs, editor log locations. They are kept outside the repository
// (AGENTS.local.md in the scratchpad folder, test/lsp-harness/scratchpad.js) because they describe
// one machine, not the project.
//
//   npm run -s local-notes
//
// Exit 0 with the notes, or 1 when this machine has none (then the local runs are not available here).

const fs = require('node:fs');
const { scratchpadPath } = require('../test/lsp-harness/scratchpad');

const file = scratchpadPath('AGENTS.local.md');
if (!fs.existsSync(file)) { console.log('no local notes on this machine: oracle, baseline and editor-log steps are not available here'); process.exit(1); }
process.stdout.write(fs.readFileSync(file, 'utf8'));
