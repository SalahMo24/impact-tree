'use strict';
// Which repository a window analyses. Git reports changed paths relative to the repository's
// top folder, so the analysis root must be that folder, not the workspace folder: a
// `.code-workspace` (or a dev container's `workspaceFolder`) often opens a subfolder of the
// repository, and joining git's paths onto it read no head file, so every function showed
// as deleted.

const { execFileSync } = require('child_process');
const path = require('path');
const { repoStamp } = require('../engine/git');

/**
 * The top folder of the git repository holding `dir`, or null outside one.
 * @param {string} dir
 * @returns {string|null}
 */
function gitToplevel(dir) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? path.resolve(out) : null;
  } catch { return null; }
}

/**
 * The repository a window analyses: the top folder of the first workspace folder that is
 * inside a git repository; else the first folder (so "not a git repository" is still
 * reported for it); null with no folder.
 * @param {string[]} folders the workspace folders' paths, in the window's order
 * @param {(dir: string) => string|null} toplevel
 * @returns {string|null}
 */
function pickRepoRoot(folders, toplevel) {
  if (!folders.length) return null;
  for (const folder of folders) {
    const top = toplevel(folder);
    if (top) return top;
  }
  return folders[0];
}

/**
 * `pickRepoRoot` with each folder's answer cached under its `repoStamp`, so the many callers
 * of `repoRoot()` do not each start a git process, and a later `git init` is still noticed.
 * @param {(dir: string) => string|null} [toplevel]
 * @returns {(folders: string[]) => string|null}
 */
function cachedRepoRoot(toplevel = gitToplevel) {
  /** @type {Map<string, { stamp: string, top: string|null }>} */
  const cache = new Map();
  const cachedToplevel = (/** @type {string} */ dir) => {
    const stamp = repoStamp(dir);
    const hit = cache.get(dir);
    if (hit && hit.stamp === stamp) return hit.top;
    const top = toplevel(dir);
    cache.set(dir, { stamp, top });
    return top;
  };
  return (folders) => pickRepoRoot(folders, cachedToplevel);
}

module.exports = { gitToplevel, pickRepoRoot, cachedRepoRoot };
