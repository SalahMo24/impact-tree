'use strict';

/**
 * The plan's LanguageServices operations, answered by Pyright (`pyright-langserver --stdio`)
 * over stdio: the gopls harness services (./gopls-services.js) with Pyright's command and
 * the `python` language id, so offsets, base-side temporary copies and "null is no answer"
 * are exactly Go's. Pyright asks `workspace/configuration`; the client answers `null` for
 * every item (Pyright's defaults; P0 measured the same callers with and without an
 * environment). Test code only.
 */

const path = require('node:path');
const { createGoplsServices } = require('./gopls-services');

/** The MIT `pyright` npm package installed per P-D1 (P0). */
const DEFAULT_PYRIGHT = path.join('/Users/salah/Projects/impact-tree-scratchpad/py-tools', 'node_modules', '.bin', 'pyright-langserver');

/**
 * @param {{ repo: string, pyrightPath?: string, deadlineMs?: number, scratchDir?: string }} options
 */
function createPyrightServices(options) {
  return createGoplsServices({
    repo: options.repo,
    goplsPath: options.pyrightPath || DEFAULT_PYRIGHT,
    args: ['--stdio'],
    languageId: 'python',
    deadlineMs: options.deadlineMs || 60000,
    ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
  });
}

module.exports = { createPyrightServices, DEFAULT_PYRIGHT };
