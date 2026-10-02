'use strict';
const path = require('path');
const fs = require('fs');

// Flags every diff we parse must carry. A user's `diff.external` (difftastic) or a
// textconv driver replaces git's own output and left us with no hunks at all, and
// `core.quotePath` turns `café.ts` into `"caf\303\251.ts"`, which then fails every
// extension check.
const PLAIN = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false'];
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

// -M turns a move into R<score>\told\tnew instead of delete + add. -z so a path with a
// tab, newline or quote in it survives intact.
function changedFiles(git, baseSha, headRev, pathspec) {
  const args = [...PLAIN, 'diff', ...DIFF_FLAGS, '-M', '--name-status', '-z', baseSha, ...(headRev ? [headRev] : []), '--'];
  const out = git.raw([...args, ...(pathspec ? [pathspec] : [])]);
  const tok = out.split('\0');
  if (tok.length && tok[tok.length - 1] === '') tok.pop();
  const files = [];
  for (let i = 0; i < tok.length;) {
    const code = tok[i++];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tok[i++], newPath = tok[i++];
      if (code.startsWith('C')) files.push({ status: 'added', oldPath: null, path: newPath });
      else files.push({ status: 'renamed', oldPath, path: newPath, similarity: Number(code.slice(1)) || null });
    } else {
      const p = tok[i++];
      if (code.startsWith('A')) files.push({ status: 'added', oldPath: null, path: p });
      else if (code.startsWith('D')) files.push({ status: 'deleted', oldPath: p, path: p });
      else files.push({ status: 'modified', oldPath: p, path: p });
    }
  }
  return files;
}

// Untracked files are part of "my uncommitted work" but invisible to `git diff`.
function untrackedFiles(git) {
  const out = git.tryRaw([...PLAIN, 'ls-files', '--others', '--exclude-standard', '-z']);
  return out ? out.split('\0').filter(Boolean) : [];
}

// Every file in the worktree git would show: tracked plus untracked-but-not-ignored.
// `null` when git could not list them, so a caller cannot mistake it for "no files".
function worktreeFiles(git) {
  const out = git.tryRaw([...PLAIN, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return out == null ? null : [...new Set(out.split('\0').filter(Boolean))];
}

// New-side changed ranges from a --unified=0 hunk header. A pure deletion
// (`+N,0`) removed lines *between* new lines N and N+1, so it is recorded as the
// fractional marker N + 0.5: it belongs to a symbol spanning that gap, never to the
// function ending at N, and it can never "cover" a call site on line N.
function rangeOfHeader(line) {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  const start = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  return count === 0 ? [start + 0.5, start + 0.5] : [start, start + count - 1];
}

// git's C-style path quoting, for the few characters quotePath=false still quotes
function unquote(p) {
  if (!p.startsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const n = body[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

// Every file's ranges from ONE `git diff`, instead of a process per file. Renames are
// paired by -M across the whole diff, so a renamed file's ranges are its real edits
// rather than the whole file reading as added.
function allHunks(git, baseSha, headRev, pathspecs) {
  const out = git.raw([...PLAIN, 'diff', ...DIFF_FLAGS, '-M', '--unified=0', baseSha, ...(headRev ? [headRev] : []),
    '--', ...(pathspecs || [])]);
  const byPath = {};
  let cur = null;
  // Body lines are skipped by count, not by content: an added line reading `++ x`
  // appears as `+++ x` and must not be mistaken for the next file's header.
  let skip = 0;
  for (const l of out.split('\n')) {
    if (skip > 0) {
      if (!l.startsWith('\\')) skip--;           // "\ No newline at end of file" is not a body line
      continue;
    }
    if (l.startsWith('diff --git ')) { cur = null; continue; }
    if (l.startsWith('+++ ')) {
      // git appends a tab to ---/+++ names containing a space
      const p = unquote(l.slice(4).replace(/\t$/, ''));
      cur = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (cur && !byPath[cur]) byPath[cur] = [];
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (!m) continue;
    skip = (m[1] === undefined ? 1 : Number(m[1])) + (m[2] === undefined ? 1 : Number(m[2]));
    if (cur) byPath[cur].push(rangeOfHeader(l));
  }
  return byPath;
}

// Single-file form, kept for callers that need one path. For a rename both paths
// must be in the pathspec, or git cannot pair them and reports the whole file added.
function hunks(git, baseSha, headRev, relPath, oldPath) {
  const specs = oldPath && oldPath !== relPath ? [oldPath, relPath] : [relPath];
  return allHunks(git, baseSha, headRev, specs)[relPath] || [];
}

// Whole-file range for a file git does not know about yet
function wholeFileRange(absPath) {
  try {
    const text = fs.readFileSync(absPath, 'utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return lines > 0 ? [[1, lines]] : [];
  } catch { return []; }
}

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_EXT = /\.d\.(ts|mts|cts)$/;
const isSourcePath = (f) => SOURCE_EXT.test(f) && !DECLARATION_EXT.test(f);
// Must be given a REPO-RELATIVE path. On an absolute one, any directory above the repo
// named `tests/` classified every caller in it as a test.
const isTestPath = (f) => /(^|\/)(tests?|__tests__|__mocks__)\//.test(String(f).replace(/\\/g, '/'))
  || /\.(spec|test|e2e-spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(f);
// Test check for an absolute path, relative to the repo it lives in
const isTestFile = (repo, abs) => isTestPath(repo ? path.relative(repo, abs) : abs);

// A "project" is the nearest ancestor directory holding a tsconfig.json or jsconfig.json,
// the same search the TypeScript server does. That covers a plain repo, a pnpm/yarn
// workspace, and a components/* monorepo without hardcoding any one layout. `null`
// means no config: the editor puts such a file in an inferred project.
//
// Cached per analysis, not per process: the extension host lives for hours, and a
// package that gains a tsconfig.json must be seen without a window reload.
const projectCache = new Map();
function clearProjectCache() { projectCache.clear(); }
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
    if (projectConfigIn(probe)) {
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
// The config file that defines the project in `dir`. tsconfig.json wins over
// jsconfig.json in the same directory, as it does for the TypeScript server.
function projectConfigIn(dir) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}
const projectLabel = (root) => (root === '' ? '(root)' : root);
// Files with no config share one project per repository, like the editor's.
const INFERRED_PROJECT = '(inferred)';

module.exports = {
  changedFiles, untrackedFiles, worktreeFiles, projectConfigIn, INFERRED_PROJECT, hunks, allHunks, rangeOfHeader, wholeFileRange,
  isTestPath, isTestFile, isSourcePath, SOURCE_EXT,
  projectRootOf, clearProjectCache, projectLabel, rel: (repo, f) => path.relative(repo, f),
};
