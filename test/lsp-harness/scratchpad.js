// @ts-check
'use strict';
// Where the dev scripts in test/lsp-harness keep their tools and caches by default: the folder
// named by IMPACT_TREE_SCRATCHPAD, else ~/Projects/impact-tree-scratchpad. Outside the repository
// on purpose. Each script's own flag (--cache, --tools, --pyright, --jedi-python) still wins.
const os = require('node:os');
const path = require('node:path');

/**
 * @param {...string} parts path segments under the scratchpad
 * @returns {string} absolute path
 */
function scratchpadPath(...parts) {
  const root = process.env.IMPACT_TREE_SCRATCHPAD || path.join(os.homedir(), 'Projects', 'impact-tree-scratchpad');
  return path.join(root, ...parts);
}

module.exports = { scratchpadPath };
