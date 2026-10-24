// @ts-check
'use strict';
// The registry of languages: which language, if any, analyses a changed file. The
// pipeline asks this instead of testing extensions itself, so adding a language means
// adding its rules here, not editing the engine.

const { typescriptRules } = require('./typescript/rules');

/**
 * Registered languages, in the order they are asked. The first whose `handles` is true
 * owns the file.
 * @type {ReadonlyArray<import('./types').LanguageFileRules>}
 */
const LANGUAGES = Object.freeze([typescriptRules]);

// A directory that holds tests, in any language. Matched against a repository-relative
// path: on an absolute one, any directory above the repository named `tests/` would make
// every file in it a test.
const TEST_DIR = /(^|\/)(tests?|__tests__|__mocks__)\//;

/** @param {string} relPath @returns {string} The path with `/` separators. */
const slashed = (relPath) => String(relPath).replace(/\\/g, '/');

/**
 * The language that analyses a file, or null when none does.
 * @param {string} relPath Repository-relative.
 * @returns {import('./types').LanguageFileRules|null}
 */
function languageFor(relPath) {
  for (const language of LANGUAGES) if (language.handles(relPath)) return language;
  return null;
}

/**
 * Whether some language analyses the file.
 * @param {string} relPath Repository-relative.
 */
const isSourcePath = (relPath) => languageFor(relPath) !== null;

/**
 * Whether the file is a test: under a test directory, or named as a test by the language
 * that handles it. A file no language handles can still be a test by its directory.
 * @param {string} relPath Repository-relative.
 */
function isTestPath(relPath) {
  if (TEST_DIR.test(slashed(relPath))) return true;
  const language = languageFor(relPath);
  return language !== null && language.isTest(relPath);
}

module.exports = { LANGUAGES, languageFor, isSourcePath, isTestPath };
