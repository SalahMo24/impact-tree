// @ts-check
'use strict';
// The registry of languages: which language, if any, analyses a changed file. The
// pipeline asks this instead of testing extensions itself, so adding a language means
// adding its provider here, not editing the engine.

const { typescriptProvider } = require('./typescript/provider');
const { goProvider } = require('./go/provider');

/**
 * Registered languages, in the order they are asked. The first whose `handles` is true
 * owns the file.
 * @type {ReadonlyArray<import('./types').LanguageProvider>}
 */
const LANGUAGES = Object.freeze([typescriptProvider, goProvider]);

// The languages every answer below comes from: `LANGUAGES`, except while a test has put
// others in their place (`useLanguagesForTest`). Owner: this module. Never changed by
// production code.
/** @type {ReadonlyArray<import('./types').LanguageProvider>} */
let active = LANGUAGES;

/**
 * Test seam: answer from `languages` instead of `LANGUAGES` until the returned function
 * is called, so a test can add a language (a provider that fails, say) without one
 * existing. Tests only; nothing in `src/` calls it.
 * @param {ReadonlyArray<import('./types').LanguageProvider>} languages
 * @returns {() => void} Restores the registered languages.
 */
function useLanguagesForTest(languages) {
  const previous = active;
  active = Object.freeze(languages.slice());
  return () => { active = previous; };
}

/**
 * The languages asked, in order.
 * @returns {ReadonlyArray<import('./types').LanguageProvider>}
 */
const registeredLanguages = () => active;

// A directory that holds tests, in any language. Matched against a repository-relative
// path: on an absolute one, any directory above the repository named `tests/` would make
// every file in it a test.
const TEST_DIR = /(^|\/)(tests?|__tests__|__mocks__)\//;

/** @param {string} relPath @returns {string} The path with `/` separators. */
const slashed = (relPath) => String(relPath).replace(/\\/g, '/');

/**
 * The language that analyses a file, or null when none does.
 * @param {string} relPath Repository-relative.
 * @returns {import('./types').LanguageProvider|null}
 */
function languageFor(relPath) {
  for (const language of active) if (language.handles(relPath)) return language;
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

module.exports = { LANGUAGES, languageFor, registeredLanguages, isSourcePath, isTestPath, useLanguagesForTest };
