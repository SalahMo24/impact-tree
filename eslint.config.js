'use strict';
// Lint and type checking share one enrolment list: a file is enrolled by putting
// `// @ts-check` on its first line. tsc (jsconfig.json, checkJs off) checks only files
// that carry it, and this config lints exactly the same files. Nothing else to edit.
const fs = require('fs');
const path = require('path');
const js = require('@eslint/js');
const globals = require('globals');

const ENROL_MARKER = '// @ts-check';

/**
 * Lists the JavaScript files under a directory, split by enrolment.
 * @param {string} dir Directory to scan recursively, relative to the project root.
 * @returns {{ enrolled: string[], other: string[] }} Forward-slash paths relative to the
 *   project root; `enrolled` files carry the marker on their first line.
 */
function scan(dir) {
  const result = { enrolled: [], other: [] };
  for (const entry of fs.readdirSync(path.join(__dirname, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = scan(rel);
      result.enrolled.push(...nested.enrolled);
      result.other.push(...nested.other);
    } else if (entry.name.endsWith('.js')) {
      const firstLine = fs.readFileSync(path.join(__dirname, rel), 'utf8').split('\n', 1)[0].trim();
      (firstLine === ENROL_MARKER ? result.enrolled : result.other).push(rel);
    }
  }
  return result;
}

const { enrolled, other } = scan('src');

module.exports = [
  { ignores: other },
  {
    files: enrolled,
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022, globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': 'error',
      'prefer-const': 'error',
    },
  },
];
