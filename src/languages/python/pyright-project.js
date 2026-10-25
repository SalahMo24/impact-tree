// @ts-check
'use strict';
// Which of a repository's files are in Pyright's project (A7, docs/MULTI_LANGUAGE_PLAN.md).
// Pyright, Pylance and Cursor's Python read the same configuration: `pyrightconfig.json` at
// the workspace root wins, else the `[tool.pyright]` table of the root `pyproject.toml`.
// Its call hierarchy never lists a caller in a file outside the project (measured on
// pydantic: `include = ['pydantic', 'tests/test_pipeline.py']` leaves most of `tests/` out),
// so ./editor-extras.js searches those files by name.
//
// Read here: only `include` and `exclude`, arrays of strings (paths relative to the
// config's directory, here the repository root). Pyright's defaults: `include` the whole
// root; `exclude` `**/node_modules`, `**/__pycache__`, `**/.*` when not given. A config
// with neither key (or no config) leaves nothing out that matters here (`explicit: false`):
// the default excludes hold dependency and cache folders, which the provider does not
// handle anyway.
//
// Globs, as Pyright reads them: `**` any number of directories, `*` any characters within
// one path segment, `?` one character within a segment; a path without wildcards names a
// file or a directory (everything under it). Matching is case-sensitive.
//
// TOML, a minimal reading (no dependency): the `[tool.pyright]` table runs from its header
// line to the next line that starts a table (`[…]` or `[[…]]`); in it, `include = [...]`
// and `exclude = [...]` (arrays may span lines, with comments and a trailing comma;
// elements are basic `"…"` or literal `'…'` strings). Not read: dotted keys from another
// table (`tool.pyright.include = …` at the top level), inline tables, multi-line strings;
// an element that is not a one-line string is a parse error.
//
// Bounds: one file read per config file, at most CONFIG_MAX_BYTES; a larger file is a
// failure (the project is unknown), never a guess.

const fs = require('fs');
const path = require('path');

const CONFIG_MAX_BYTES = 1024 * 1024;
const DEFAULT_EXCLUDE = ['**/node_modules', '**/__pycache__', '**/.*'];

/**
 * @typedef {{ configFile: string, explicit: boolean, include: string[], exclude: string[],
 *   inProject: (rel: string) => boolean }} PyrightProject
 * @typedef {{ configFile: string, error: string }} UnknownProject
 */

/**
 * JSON with comments and trailing commas (as Pyright reads `pyrightconfig.json`). Pure.
 * @param {string} text @returns {any} Throws on invalid JSON.
 */
function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else { out += c; i++; }
  }
  // Trailing commas: a comma followed (past whitespace) by `]` or `}`; strings were copied
  // whole above, but this pass runs on text, so skip strings again.
  let res = '';
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (c === ',' && /^\s*[\]}]/.test(out.slice(k + 1))) continue;
    res += c;
  }
  return JSON.parse(res);
}

/**
 * `include`/`exclude` of `[tool.pyright]` in a pyproject.toml's text (see the header).
 * Pure. Null when there is no `[tool.pyright]` table. Throws on a value it cannot read.
 * @param {string} text
 * @returns {{ include?: string[], exclude?: string[] }|null}
 */
function pyprojectPyright(text) {
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex((l) => /^\s*\[\s*tool\s*\.\s*pyright\s*\]\s*(?:#.*)?$/.test(l));
  if (head < 0) return null;
  let end = head + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const body = lines.slice(head + 1, end).join('\n');
  /** @type {{ include?: string[], exclude?: string[] }} */
  const out = {};
  for (const m of body.matchAll(/^[ \t]*(include|exclude)[ \t]*=[ \t]*/gm)) {
    const key = /** @type {'include'|'exclude'} */ (m[1]);
    out[key] = tomlStringArray(body, /** @type {number} */ (m.index) + m[0].length, key);
  }
  return out;
}

/**
 * A TOML array of one-line strings starting at `at` (its `[`). Pure; throws when it is not.
 * @param {string} text @param {number} at @param {string} key For the error.
 * @returns {string[]}
 */
function tomlStringArray(text, at, key) {
  if (text[at] !== '[') throw new Error(`[tool.pyright] ${key} is not an array`);
  /** @type {string[]} */
  const items = [];
  let i = at + 1;
  let wantValue = true;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (c === ']') return items;
    if (c === ',' && !wantValue) { wantValue = true; i++; continue; }
    if ((c === '"' || c === "'") && wantValue && !text.startsWith(c.repeat(3), i)) {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        if (c === '"' && text[j] === '\\') { s += text[j + 1] === '\\' ? '\\' : text[j + 1]; j += 2; continue; }
        s += text[j++];
      }
      if (text[j] !== c) throw new Error(`[tool.pyright] ${key}: unterminated string`);
      items.push(s);
      i = j + 1;
      wantValue = false;
      continue;
    }
    throw new Error(`[tool.pyright] ${key}: not an array of strings`);
  }
  throw new Error(`[tool.pyright] ${key}: unterminated array`);
}

/**
 * A Pyright include/exclude entry as a regular expression over repository-relative paths
 * (`/`-separated) that matches the named file or anything under the named directory. Pure.
 * @param {string} spec
 * @returns {RegExp}
 */
function globToRegExp(spec) {
  const s = spec.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (s === '.' || s === '') return /^/;
  let re = '';
  const parts = s.split('/');
  parts.forEach((part, k) => {
    const last = k === parts.length - 1;
    if (part === '**') { re += last ? '.*' : '(?:[^/]+/)*'; return; }
    re += part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (!last) re += '/';
  });
  return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * The project from a parsed config's values. Pure.
 * @param {string} configFile @param {{ include?: unknown, exclude?: unknown }} cfg
 * @returns {PyrightProject}
 */
function projectOf(configFile, cfg) {
  for (const key of /** @type {const} */ (['include', 'exclude'])) {
    const v = cfg[key];
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new Error(`${key} is not an array of strings`);
  }
  const explicit = cfg.include !== undefined || cfg.exclude !== undefined;
  const include = /** @type {string[]|undefined} */ (cfg.include) || ['.'];
  const exclude = /** @type {string[]|undefined} */ (cfg.exclude) || DEFAULT_EXCLUDE;
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return {
    configFile, explicit, include, exclude,
    inProject: (rel) => {
      const p = rel.replace(/\\/g, '/');
      return inc.some((r) => r.test(p)) && !exc.some((r) => r.test(p));
    },
  };
}

/**
 * Reads a file up to CONFIG_MAX_BYTES: its text, null when it does not exist; throws when
 * it cannot be read or is larger.
 * @param {string} abs @returns {string|null}
 */
function readConfigFile(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (e) {
    if (e && /** @type {any} */ (e).code === 'ENOENT') return null;
    throw e;
  }
  if (st.size > CONFIG_MAX_BYTES) throw new Error(`larger than ${CONFIG_MAX_BYTES} bytes`);
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Pyright's project for the repository at `repoRoot` (see the header).
 * @param {string} repoRoot
 * @param {(abs: string) => string|null} [read] A file's text, null when absent; throws on a
 *   failure (tests).
 * @returns {PyrightProject|UnknownProject|null} Null: no config file, the whole workspace.
 */
function readPyrightProject(repoRoot, read = readConfigFile) {
  for (const name of ['pyrightconfig.json', 'pyproject.toml']) {
    const abs = path.join(repoRoot, name);
    let text;
    try { text = read(abs); } catch (e) {
      return { configFile: name, error: e instanceof Error ? e.message : String(e) };
    }
    if (text == null) continue;
    try {
      if (name === 'pyrightconfig.json') {
        const cfg = parseJsonc(text);
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a JSON object');
        return projectOf(name, cfg);
      }
      const cfg = pyprojectPyright(text);
      return cfg ? projectOf(`${name} [tool.pyright]`, cfg) : null;
    } catch (e) {
      return { configFile: name, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return null;
}

module.exports = { readPyrightProject, parseJsonc, pyprojectPyright, globToRegExp, projectOf, CONFIG_MAX_BYTES, DEFAULT_EXCLUDE };
