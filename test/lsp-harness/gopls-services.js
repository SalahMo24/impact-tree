'use strict';

/**
 * The plan's LanguageServices operations, answered by gopls (`gopls serve`) over stdio:
 * the shared stdio services (./stdio-server-services.js) with gopls' command and the `go`
 * language id. Test code only.
 */

const { createStdioServerServices, offsetToPosition, positionToOffset, SYMBOL_KINDS, MAX_BASE_TEXT_CHARS } = require('./stdio-server-services');

/**
 * @param {{ repo: string, goplsPath: string, deadlineMs?: number, env?: NodeJS.ProcessEnv,
 *   scratchDir?: string, onNotification?: (method: string, params: any) => void }} options
 */
function createGoplsServices({ goplsPath, ...rest }) {
  return createStdioServerServices({ ...rest, command: goplsPath, args: ['serve'], languageId: 'go' });
}

module.exports = { createGoplsServices, offsetToPosition, positionToOffset, SYMBOL_KINDS, MAX_BASE_TEXT_CHARS };
