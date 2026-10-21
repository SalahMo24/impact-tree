// @ts-check
'use strict';
// Reads what happened to a sent feedback round (docs/UX_PLAN.md F4): the agent's statuses
// from the round file, and whether the code near each item changed since the round's
// snapshot. I/O only; the meaning is decided in feedback-round-model.js.

const path = require('path');
const { makeGit } = require('./engine/git');
const { EXCLUDE_OWN_FOLDER } = require('./engine/diff-index');
const { parseRound, statusesFor, parseOldHunks, codeChangedNear } = require('./feedback-file');
const { readRound } = require('./feedback-files-io');

/** Distinct files diffed per read-back; items in further files read 'unknown'. */
const MAX_FILES = 50;
/** Deadline of one file's diff. */
const DIFF_TIMEOUT_MS = 10000;

/** @typedef {import('./feedback-round-model').SentRound} SentRound */
/** @typedef {import('./feedback-round-model').CodeChange} CodeChange */

/**
 * Whether the code near each item changed since the round's snapshot. Diffs go through a
 * temporary intent-to-add index, so a file that was untracked when the round was sent is
 * compared too. A file whose diff fails, or beyond `MAX_FILES`, gives 'unknown' for its
 * items; nothing defaults to 'unchanged'.
 * @param {{ repo: string, round: SentRound, objectDirs: string[],
 *   withDiffIndex: <T>(fn: (env: Record<string, string>) => Promise<T>) => Promise<T>,
 *   isCurrent?: () => boolean }} o
 *   `isCurrent` is asked between files; once it is false the remaining files are not diffed
 *   (their items read 'unknown') and the caller is expected to drop the result.
 * @returns {Promise<Map<string, CodeChange>>} by item id
 */
async function codeChangesFor({ repo, round, objectDirs, withDiffIndex, isCurrent = () => true }) {
  const files = [...new Set(round.items.map((i) => i.file))];
  /** @type {Map<string, Array<{ oldStart: number, oldCount: number }>|null>} */
  const hunksByFile = new Map();
  await withDiffIndex(async (env) => {
    const git = makeGit(repo, { objectDirs, env });
    for (const file of files.slice(0, MAX_FILES)) {
      if (!isCurrent()) break;
      try {
        const out = await git.rawAsync(
          ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', round.checkpointSha, '--', file, EXCLUDE_OWN_FOLDER],
          { timeoutMs: DIFF_TIMEOUT_MS },
        );
        // A binary file has a diff with no hunks; "unchanged" would be a guess.
        hunksByFile.set(file, /^Binary files /m.test(out) ? null : parseOldHunks(out));
      } catch {
        hunksByFile.set(file, null);
      }
    }
  });
  /** @type {Map<string, CodeChange>} */
  const out = new Map();
  for (const item of round.items) {
    const hunks = hunksByFile.has(item.file) ? hunksByFile.get(item.file) || null : null;
    out.set(item.id, codeChangedNear({ hunks, line: item.line }));
  }
  return out;
}

/**
 * The agent's status for every item of the round, from its file. A missing or unreadable
 * file makes every item 'unreadable' with the reason.
 * @param {{ repo: string, round: SentRound }} o
 */
async function statusesOf({ repo, round }) {
  const ids = round.items.map((i) => i.id);
  const read = await readRound(path.join(repo, round.relPath));
  const parsed = read.ok ? parseRound(read.text) : { ok: /** @type {false} */ (false), reason: read.reason };
  return statusesFor(ids, parsed);
}

module.exports = { codeChangesFor, statusesOf, MAX_FILES };
