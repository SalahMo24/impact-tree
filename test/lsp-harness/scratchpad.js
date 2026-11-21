// @ts-check
'use strict';
// Where the dev scripts keep their tools, caches and reports, and where the maintainer's test
// repositories are. Both live outside the repository and are named per machine, never here:
//
//   scratchpad        IMPACT_TREE_SCRATCHPAD, else `git config impacttree.scratchpad`
//   test repositories IMPACT_TREE_TEST_REPOS, else `git config impacttree.testRepos`
//
// The git config form is read by git hooks and editor-launched runs that do not load a shell
// profile. Each script's own flag (--cache, --tools, --repo, ...) still wins. Asking for a path
// that is not configured throws, so a module computes these when a run needs them, not at load.
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

/** @type {Map<string, string | null>} */
const cache = new Map();

/** @param {string} env @param {string} key @returns {string | null} */
function configured(env, key) {
  if (process.env[env]) return expand(/** @type {string} */ (process.env[env]));
  if (!cache.has(key)) {
    let value = null;
    try {
      value = execFileSync('git', ['config', '--get', key], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { /* not set */ }
    cache.set(key, value && expand(value));
  }
  return cache.get(key) || null;
}

/** @param {string} p */
const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/** The scratchpad folder, or null when this machine has none configured. @returns {string | null} */
const scratchpadRoot = () => configured('IMPACT_TREE_SCRATCHPAD', 'impacttree.scratchpad');

/** The folder holding the test repositories, or null. @returns {string | null} */
const testReposRoot = () => configured('IMPACT_TREE_TEST_REPOS', 'impacttree.testRepos');

/** @param {string | null} root @param {string} what @param {string} env @param {string} key @param {string[]} parts */
function under(root, what, env, key, parts) {
  if (!root) throw new Error(`no ${what} configured: set ${env} or \`git config ${key} <folder>\` (the maintainer's values: npm run -s local-notes), or pass the script's own flag`);
  return path.join(root, ...parts);
}

/** @param {...string} parts path segments under the scratchpad @returns {string} absolute path */
const scratchpadPath = (...parts) => under(scratchpadRoot(), 'scratchpad', 'IMPACT_TREE_SCRATCHPAD', 'impacttree.scratchpad', parts);

/** @param {...string} parts a clone's folder name and more @returns {string} absolute path */
const testReposPath = (...parts) => under(testReposRoot(), 'test-repository folder', 'IMPACT_TREE_TEST_REPOS', 'impacttree.testRepos', parts);

module.exports = { scratchpadPath, scratchpadRoot, testReposPath, testReposRoot };
