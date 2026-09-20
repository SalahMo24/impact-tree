'use strict';
// The extension analyses a repo; it does not live inside one. Tests point at a target
// via IMPACT_TREE_TARGET_REPO so the project can be developed and open-sourced
// independently of whatever codebase it is being measured against.
const path = require('path');
module.exports = function targetRepo() {
  const env = process.env.IMPACT_TREE_TARGET_REPO;
  if (env) return path.resolve(env);
  // Legacy default: the project used to live inside the repo it analysed.
  const legacy = path.resolve(__dirname, '..', '..', '..');
  if (require('fs').existsSync(path.join(legacy, '.git'))) return legacy;
  throw new Error(
    'No target repo. Set IMPACT_TREE_TARGET_REPO to a git repo to analyse, e.g.\n'
    + '  IMPACT_TREE_TARGET_REPO=/path/to/repo npm test');
};
