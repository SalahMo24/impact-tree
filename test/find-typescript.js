'use strict';
// Tests need a TypeScript install, but this project deliberately has no node_modules
// of its own and must not assume the target repo's layout. Look alongside the tests,
// then at the target repo root, then one and two levels down -- monorepos usually
// install per-package rather than at the root.
const path = require('path');
const fs = require('fs');

function candidateDirs() {
  const out = [__dirname, path.join(__dirname, '..')];
  let repo = null;
  try { repo = require('./target-repo')(); } catch { return out; }
  out.push(repo);
  const kids = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
        .map((e) => path.join(d, e.name));
    } catch { return []; }
  };
  for (const a of kids(repo)) { out.push(a); for (const b of kids(a)) out.push(b); }
  return out;
}

// Returns the typescript module, or null. Callers decide whether to skip or fail --
// a silent pass on a missing dependency is worse than either.
function findTypeScript() {
  for (const base of candidateDirs()) {
    try { return require(require.resolve('typescript', { paths: [base] })); } catch { /* next */ }
  }
  return null;
}

// First directory that actually contains a typescript install -- useful when a test
// needs a real project directory rather than just the compiler.
function findProjectWithTypeScript() {
  for (const base of candidateDirs()) {
    try { require.resolve('typescript', { paths: [base] }); return base; } catch { /* next */ }
  }
  return null;
}

// Any real file matching `re`, searched breadth-first under the target repo. Lets a
// test assert against genuine source without naming a path inside someone's codebase.
function findSampleFile(re, { limit = 20000 } = {}) {
  let repo = null;
  try { repo = require('./target-repo')(); } catch { return null; }
  const queue = [repo];
  let seen = 0;
  while (queue.length) {
    const dir = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > limit) return null;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        queue.push(p);
      } else if (re.test(p)) return p;
    }
  }
  return null;
}

module.exports = { findTypeScript, findProjectWithTypeScript, findSampleFile };
