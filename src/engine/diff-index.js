// @ts-check
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeGit } = require('./git');

/** The pathspec that keeps the extension's own folder out of every snapshot and diff. */
const EXCLUDE_OWN_FOLDER = ':(exclude).impact-tree';

/**
 * A private copy of the repository's index in which every untracked, non-ignored file is
 * added intent-to-add (`git add -N`). Diffing a snapshot against the worktree through it
 * reports a file that was untracked at snapshot time and still is as unchanged, instead of
 * deleted. The user's index is only read; `add -N` writes no objects.
 *
 * Owner: the caller, who must call `dispose()` (in a `finally`). The copy lives in its own
 * directory under `tempDir`, so a crash leaves at most one directory for `sweepTemp`.
 * @param {string} repo Repository root.
 * @param {{ tempDir?: string }} [options] Existing directory to create the copy in; default the OS temp dir.
 * @returns {{ env: { GIT_INDEX_FILE: string, GIT_OPTIONAL_LOCKS: string }, dispose: () => void }}
 * @throws {Error} Git could not read the repository or build the index. Nothing is left behind.
 */
function createDiffIndex(repo, { tempDir = os.tmpdir() } = {}) {
  const git = makeGit(repo);
  const realIndex = git.raw(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { env: { GIT_OPTIONAL_LOCKS: '0' } }).trim();
  const dir = fs.mkdtempSync(path.join(tempDir, 'idx-'));
  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
  const indexFile = path.join(dir, 'index');
  const env = { GIT_INDEX_FILE: indexFile, GIT_OPTIONAL_LOCKS: '0' };
  try {
    // A repository with no index yet starts from an empty one.
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, indexFile);
    git.raw(['add', '-N', '-A', '--', '.', EXCLUDE_OWN_FOLDER], { env, quiet: false });
  } catch (e) {
    dispose();
    throw e;
  }
  return { env: { GIT_INDEX_FILE: indexFile, GIT_OPTIONAL_LOCKS: '0' }, dispose };
}

module.exports = { createDiffIndex, EXCLUDE_OWN_FOLDER };
