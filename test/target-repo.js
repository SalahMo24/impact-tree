'use strict';
// The extension analyses a repo; it does not live inside one. Tests point at a target
// via IMPACT_TREE_TARGET_REPO so the project can be developed and published
// independently of whatever codebase it is measured against.
//
// The documented public target is pingdotgg/t3code: a pnpm monorepo of TypeScript and
// React, which exercises workspace layouts, tsconfig `paths` and JSX. Note what it
// does NOT contain -- NestJS, a DI container, CQRS -- so the port/adapter, command
// handler and deep-inheritance paths are covered by the synthetic fixtures in
// test/syntactic-index.test.js and test/inheritance.test.js instead, not here.
const path = require('path');
const fs = require('fs');

const PUBLIC_TARGET = 'https://github.com/pingdotgg/t3code';

module.exports = function targetRepo() {
  const env = process.env.IMPACT_TREE_TARGET_REPO;
  if (env) return path.resolve(env);
  // A sibling clone is the usual local setup.
  for (const guess of ['../t3code', '../../t3code']) {
    const p = path.resolve(__dirname, '..', guess);
    if (fs.existsSync(path.join(p, '.git'))) return p;
  }
  throw new Error(
    'No target repo. Clone the public one next to this project:\n'
    + `  git clone ${PUBLIC_TARGET}\n`
    + 'or point at any git repo:\n'
    + '  IMPACT_TREE_TARGET_REPO=/path/to/repo npm test');
};
module.exports.PUBLIC_TARGET = PUBLIC_TARGET;
