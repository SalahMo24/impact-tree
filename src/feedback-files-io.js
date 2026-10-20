// @ts-check
'use strict';
// Small fs adapter for feedback round files. All naming/format logic lives in
// feedback-file.js; this only lists, reads (size-capped) and creates files.

const nodeFs = require('fs');
const path = require('path');
const { nextRoundNumber, roundFileName, MAX_TEXT_BYTES } = require('./feedback-file');

const MAX_LISTED = 10000;
const MAX_WRITE_TRIES = 5;
const NAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/;

/** @typedef {typeof nodeFs.promises} Fs */

/** @param {string} repoRoot */
function feedbackDir(repoRoot) {
  return path.join(repoRoot, '.impact-tree', 'feedback');
}

/** @param {Fs} fs @param {string} dir @returns {Promise<string[]>} */
async function listNames(fs, dir) {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    if (e && /** @type {any} */ (e).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Create the next round file. Never overwrites: flag 'wx', and on EEXIST tries the next
 * number (at most 5 tries, then throws). `render(round)` returns the content for that round.
 * @param {{ repoRoot: string, now: Date|number, render: (round: number) => string,
 *   timeZone?: string, fs?: Fs }} o
 * @returns {Promise<{ round: number, absPath: string, relPath: string }>}
 */
async function writeRound(o) {
  const fs = o.fs || nodeFs.promises;
  const dir = feedbackDir(o.repoRoot);
  await fs.mkdir(dir, { recursive: true });
  let round = nextRoundNumber(await listNames(fs, dir));
  for (let attempt = 0; attempt < MAX_WRITE_TRIES; attempt++) {
    const name = roundFileName(o.now, round, o.timeZone);
    const absPath = path.join(dir, name);
    const content = o.render(round);
    if (typeof content !== 'string') throw new TypeError('feedback: render must return a string');
    try {
      await fs.writeFile(absPath, content, { flag: 'wx', encoding: 'utf8' });
      return { round, absPath, relPath: `.impact-tree/feedback/${name}` };
    } catch (e) {
      if (!(e && /** @type {any} */ (e).code === 'EEXIST')) throw e;
      // Someone took this number; move past every file now in the folder.
      round = Math.max(round + 1, nextRoundNumber(await listNames(fs, dir)));
    }
  }
  throw new Error('feedback: could not create a round file (name kept colliding)');
}

/**
 * Read a round file, refusing anything over 2 MB (checked with stat before reading).
 * @param {string} absPath @param {{ fs?: Fs }} [opts]
 * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: string }>}
 */
async function readRound(absPath, opts) {
  const fs = (opts && opts.fs) || nodeFs.promises;
  try {
    const st = await fs.stat(absPath);
    if (!st.isFile()) return { ok: false, reason: 'not a file' };
    if (st.size > MAX_TEXT_BYTES) return { ok: false, reason: 'too large' };
    return { ok: true, text: await fs.readFile(absPath, 'utf8') };
  } catch (e) {
    const code = e && /** @type {any} */ (e).code;
    return { ok: false, reason: code === 'ENOENT' ? 'file missing' : `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Round files in the feedback folder, sorted by round then name. Keeps at most 10 000
 * matching entries; `truncated` says when more existed. A missing folder is an empty list.
 * @param {string} repoRoot @param {{ fs?: Fs }} [opts]
 * @returns {Promise<{ files: Array<{ name: string, date: string, round: number, absPath: string, relPath: string }>, truncated: boolean }>}
 */
async function listRounds(repoRoot, opts) {
  const fs = (opts && opts.fs) || nodeFs.promises;
  const dir = feedbackDir(repoRoot);
  const recs = [];
  for (const name of await listNames(fs, dir)) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const round = Number(m[2]);
    if (!Number.isSafeInteger(round)) continue;
    recs.push({ name, date: m[1], round, absPath: path.join(dir, name), relPath: `.impact-tree/feedback/${name}` });
  }
  recs.sort((a, b) => a.round - b.round || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const truncated = recs.length > MAX_LISTED;
  return { files: truncated ? recs.slice(0, MAX_LISTED) : recs, truncated };
}

module.exports = { feedbackDir, writeRound, readRound, listRounds };
