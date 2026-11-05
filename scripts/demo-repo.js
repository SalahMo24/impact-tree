// @ts-check
'use strict';

// Builds the demo repository the "Try the demo" command opens: a tiny TypeScript row store
// whose one branch holds a change with a caller left behind on purpose (demo/README.md).
// The repository is local only: `main` is pushed to a bare repository beside it, which is
// its `origin`, so the default review (Branch vs base, against origin/main) shows the change
// with no network and no GitHub sign-in.
//
// The files come from the extension's demo/ folder: demo/base is the first commit on main,
// demo/pr is copied over it for the commit on the demo branch. Every build starts from
// scratch, so a reviewer who edited the demo gets the planted change back.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEMO_FOLDER = 'impact-tree-demo';
const ORIGIN_FOLDER = 'impact-tree-demo-origin.git';
const DEMO_BRANCH = 'demo/lock-timeout';
/** A random id per build, inside .git so the working tree stays the demo's own files. */
const BUILD_ID_FILE = 'impact-tree-demo-build';
/** Each git command is local and small; 15 s only guards against a hung process (a credential or editor prompt). */
const GIT_TIMEOUT_MS = 15000;
/**
 * Settings that make the build the same on every machine: no signing prompt, no hooks from a
 * global template, no line-ending rewrite, a fixed author.
 */
const GIT_CONFIG = ['-c', 'user.name=Impact Tree demo', '-c', 'user.email=demo@impact-tree.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'init.templateDir='];

/**
 * @typedef {(cwd: string, args: string[]) => Promise<void>} RunGit Runs one git command; rejects on failure.
 */

/** @type {RunGit} */
const defaultRunGit = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', [...GIT_CONFIG, ...args], { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, _stdout, stderr) => {
      if (!err) { resolve(); return; }
      const detail = String(stderr || '').trim().split('\n').pop();
      reject(new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`));
    });
});

/**
 * Where the demo lives under `parentDir` (the extension's global storage).
 * @param {string} parentDir
 * @returns {{ repo: string, origin: string }}
 */
const demoPaths = (parentDir) => ({ repo: path.join(parentDir, DEMO_FOLDER), origin: path.join(parentDir, ORIGIN_FOLDER) });

/**
 * Whether `folder` is the demo repository built under `parentDir`.
 * @param {string|null|undefined} folder @param {string|null|undefined} parentDir
 */
function isDemoRepo(folder, parentDir) {
  if (!folder || !parentDir) return false;
  return path.resolve(folder) === path.resolve(demoPaths(parentDir).repo);
}

/**
 * Builds the demo repository under `parentDir`, replacing any earlier copy.
 * @param {{ templateDir: string, parentDir: string, runGit?: RunGit }} o `templateDir`: the
 *   extension's demo/ folder (holds base/ and pr/).
 * @returns {Promise<{ repo: string, branch: string }>}
 * Rejects when the template is missing or a git command failed (git not installed, for one).
 */
async function buildDemoRepo({ templateDir, parentDir, runGit = defaultRunGit }) {
  const base = path.join(templateDir, 'base');
  const pr = path.join(templateDir, 'pr');
  if (!fs.existsSync(base) || !fs.existsSync(pr)) throw new Error(`the demo's files are missing from ${templateDir}`);
  const { repo, origin } = demoPaths(parentDir);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(origin, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(origin, { recursive: true });

  await runGit(origin, ['init', '-q', '--bare']);
  fs.cpSync(base, repo, { recursive: true });
  await runGit(repo, ['init', '-q']);
  // `checkout -b` names the first branch on every git version; `init -b` needs git 2.28.
  await runGit(repo, ['checkout', '-q', '-b', 'main']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-q', '-m', 'Row store with row locks']);
  await runGit(repo, ['remote', 'add', 'origin', origin]);
  await runGit(repo, ['push', '-q', 'origin', 'main']);
  // origin/HEAD is how the review finds the base branch when none is set.
  await runGit(repo, ['remote', 'set-head', 'origin', 'main']);
  await runGit(repo, ['checkout', '-q', '-b', DEMO_BRANCH]);
  fs.cpSync(pr, repo, { recursive: true });
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-q', '-m', 'Lock rows with a timeout']);
  fs.writeFileSync(path.join(repo, '.git', BUILD_ID_FILE), `${crypto.randomUUID()}\n`);
  return { repo, branch: DEMO_BRANCH };
}

/**
 * Which build of the demo `repo` holds: a random id written by `buildDemoRepo`, so every build
 * has its own, even two in the same second.
 * @param {string} repo
 * @returns {string|null} Null when it cannot be read (not a demo).
 */
function demoBuildId(repo) {
  try {
    const id = fs.readFileSync(path.join(repo, '.git', BUILD_ID_FILE), 'utf8').trim();
    return /^[0-9a-f-]{36}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

module.exports = { buildDemoRepo, isDemoRepo, demoPaths, demoBuildId, DEMO_BRANCH };
