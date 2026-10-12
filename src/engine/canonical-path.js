'use strict';
const fs = require('fs');
const path = require('path');

// One spelling per file: TypeScript reports real paths with `/` separators, while the
// repo may be opened through a symlink and, on Windows, with `\\` and any drive case.
// A path that does not exist (deleted, virtual) keeps its lexical form; any other
// failure to resolve it propagates rather than silently dropping the file.
function canonical(file) {
  let real = file;
  try { real = fs.realpathSync(file); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  const resolved = path.resolve(real);
  return path.sep === '\\' ? resolved.toLowerCase() : resolved;
}

module.exports = { canonical };
