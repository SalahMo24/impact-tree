// @ts-check
'use strict';
// The registry of languages: which language, if any, analyses a changed file. The
// pipeline asks this instead of testing extensions itself, so adding a language means
// adding its provider here, not editing the engine.

const { typescriptProvider } = require('./typescript/provider');
const { goProvider } = require('./go/provider');
const { pythonProvider } = require('./python/provider');
const { slashed } = require('./text');

/**
 * Registered languages, in the order they are asked. The first whose `handles` is true
 * owns the file.
 * @type {ReadonlyArray<import('./types').LanguageProvider>}
 */
const LANGUAGES = Object.freeze([typescriptProvider, goProvider, pythonProvider]);

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

// Common languages no provider analyses yet, by file extension, so a changed file of one
// says which language it is rather than reading like a docs or config file. Only for
// display: a file handled by a registered language never gets here.
/** @type {ReadonlyArray<[RegExp, string]>} */
const UNSUPPORTED = Object.freeze([
  [/\.java$/, 'Java'], [/\.kts?$/, 'Kotlin'], [/\.cs$/, 'C#'],
  [/\.rb$/, 'Ruby'], [/\.rs$/, 'Rust'], [/\.php$/, 'PHP'], [/\.swift$/, 'Swift'],
  [/\.(c|h)$/, 'C'], [/\.(cc|cpp|cxx|hh|hpp|hxx)$/, 'C++'], [/\.scala$/, 'Scala'],
]);

/**
 * The name of a common language that no registered provider analyses, for a file of it;
 * null for a file a provider handles or of no language listed.
 * @param {string} relPath Repository-relative.
 * @returns {string|null}
 */
function unsupportedLanguageOf(relPath) {
  if (languageFor(relPath)) return null;
  for (const [pattern, name] of UNSUPPORTED) if (pattern.test(relPath)) return name;
  return null;
}

module.exports = { LANGUAGES, languageFor, registeredLanguages, isSourcePath, isTestPath, unsupportedLanguageOf, useLanguagesForTest };
