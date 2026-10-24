// @ts-check
'use strict';
// TypeScript and JavaScript file rules: the only language analysed today. Moved here from
// `src/engine/diff.js` without change, so every existing caller keeps its answers.

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_EXT = /\.d\.(ts|mts|cts)$/;
const TEST_SUFFIX = /\.(spec|test|e2e-spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** @type {import('../types').LanguageFileRules} */
const typescriptRules = Object.freeze({
  id: 'typescript',
  displayName: 'TypeScript/JavaScript',
  handles: (relPath) => SOURCE_EXT.test(relPath) && !DECLARATION_EXT.test(relPath),
  // A test by its directory (shared by every language, see `../index.js`) or by its name.
  isTest: (relPath) => TEST_SUFFIX.test(relPath),
  // Nothing is detected as generated yet; a generated file is analysed like any other.
  isGenerated: () => false,
});

module.exports = { typescriptRules, SOURCE_EXT };
