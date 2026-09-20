'use strict';
const path = require('path');
const fs = require('fs');

// -M turns a move into R<score>\told\tnew instead of delete + add.
function changedFiles(git, baseSha, headRev, pathspec) {
  const args = ['diff', '-M', '--name-status', baseSha, ...(headRev ? [headRev] : []), '--'];
  const out = git.raw([...args, ...(pathspec ? [pathspec] : [])]).trim();
  const files = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const code = parts[0];
    if (code.startsWith('R')) files.push({ status: 'renamed', oldPath: parts[1], path: parts[2], similarity: Number(code.slice(1)) || null });
    else if (code.startsWith('A')) files.push({ status: 'added', oldPath: null, path: parts[1] });
    else if (code.startsWith('D')) files.push({ status: 'deleted', oldPath: parts[1], path: parts[1] });
    else files.push({ status: 'modified', oldPath: parts[1], path: parts[1] });
  }
  return files;
}

// --unified=0 gives exact new-side ranges. count omitted means 1; count 0 is a pure
// deletion, anchored as a zero-width range so it still maps to an enclosing symbol.
function hunks(git, baseSha, headRev, relPath) {
  const out = git.raw(['diff', '-M', '--unified=0', '--no-color', baseSha, ...(headRev ? [headRev] : []), '--', relPath]);
  const ranges = [];
  for (const l of out.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push(count === 0 ? [start, start] : [start, start + count - 1]);
  }
  return ranges;
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_EXT = /\.d\.(ts|mts|cts)$/;
const isSourcePath = (f) => SOURCE_EXT.test(f) && !DECLARATION_EXT.test(f);
const isTestPath = (f) => /(^|\/)(tests?|__tests__|__mocks__)\//.test(f)
  || /\.(spec|test|e2e-spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(f);

// A "project" is the nearest ancestor directory holding a tsconfig.json. That covers a
// plain repo (tsconfig at the root), a pnpm/yarn workspace, and a components/* monorepo
// without hardcoding any one layout.
const projectCache = new Map();
function projectRootOf(repoAbs, relPath) {
  let dir = path.posix.dirname(relPath.split(path.sep).join('/'));
  const seen = [];
  while (true) {
    const key = `${repoAbs}\u0000${dir}`;
    if (projectCache.has(key)) {
      const hit = projectCache.get(key);
      seen.forEach((d) => projectCache.set(`${repoAbs}\u0000${d}`, hit));
      return hit;
    }
    seen.push(dir);
    const probe = dir === '.' ? repoAbs : path.join(repoAbs, dir);
    if (fs.existsSync(path.join(probe, 'tsconfig.json'))) {
      const val = dir === '.' ? '' : dir;
      seen.forEach((d) => projectCache.set(`${repoAbs}\u0000${d}`, val));
      return val;
    }
    if (dir === '.' || dir === '/' || dir === '') {
      seen.forEach((d) => projectCache.set(`${repoAbs}\u0000${d}`, null));
      return null;
    }
    dir = path.posix.dirname(dir);
  }
}
const projectLabel = (root) => (root === '' ? '(root)' : root);

module.exports = { changedFiles, hunks, isTestPath, isSourcePath, SOURCE_EXT, projectRootOf, projectLabel, rel: (repo, f) => path.relative(repo, f) };
