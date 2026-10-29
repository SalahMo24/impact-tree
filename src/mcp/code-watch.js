// @ts-check
'use strict';

// Has the extension's code changed since this server started? The server answers from the
// code it loaded; when the files on disk change (an update, or a developer editing the
// extension folder), a supervised server restarts itself (src/mcp/supervisor.js).
//
// What counts: the contents of every .js file under src/ and package.json. Sizes and
// modification times are checked first on each call (about 300 stats); contents are hashed
// only when one of them changed, so touching a file (a git checkout of the same content)
// is not a change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Files looked at at most. Unit: files. Over it, the rest are not watched. */
const MAX_FILES = 3000;

/** @param {string} root @returns {string[]} The watched files, sorted. */
function watchedFiles(root) {
  const out = [path.join(root, 'package.json')];
  const stack = [path.join(root, 'src')];
  while (stack.length && out.length < MAX_FILES) {
    const dir = /** @type {string} */ (stack.pop());
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
    }
  }
  return out.slice(0, MAX_FILES).sort();
}

/** @param {string[]} files */
function statsOf(files) {
  return files.map((f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return 'gone'; } }).join('|');
}

/** @param {string[]} files */
function hashOf(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    try { h.update(fs.readFileSync(f)); } catch { h.update('\0gone'); }
  }
  return h.digest('hex');
}

/**
 * @param {string} root The extension's folder (holds src/ and package.json).
 * @returns {{ changed: () => boolean }} `changed`: whether the code differs from the code at the start.
 */
function createCodeWatch(root) {
  let files = watchedFiles(root);
  let stats = statsOf(files);
  const hash = hashOf(files);
  return {
    changed() {
      const nowFiles = watchedFiles(root);
      const nowStats = statsOf(nowFiles);
      if (nowStats === stats && nowFiles.length === files.length) return false;
      if (hashOf(nowFiles) !== hash) return true;
      files = nowFiles; stats = nowStats;   // touched, same content
      return false;
    },
  };
}

module.exports = { createCodeWatch, watchedFiles };
