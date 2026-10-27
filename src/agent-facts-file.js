// @ts-check
'use strict';

// Writes the card facts that do not fit in the agent prompt to
// `.impact-tree/cards/facts-<head>.json` in the repository, where the agent reads them. The
// folder holds a `.gitignore` of `*`, so the checkout stays clean (git ignores the folder,
// the .gitignore included). Earlier facts files of that folder are replaced: only the latest
// hand-off is kept.

const nodeFs = require('fs');
const path = require('path');

const FACTS_DIR = path.join('.impact-tree', 'cards');
const FACTS_RE = /^facts-[0-9a-f]{7,64}\.json$/;

/**
 * @param {string} repoRoot
 * @param {string} head The head commit the facts are for.
 * @param {string} text The facts as JSON.
 * @param {{ fs?: typeof nodeFs.promises }} [opts]
 * @returns {Promise<{ absPath: string, relPath: string }>}
 */
async function writeFactsFile(repoRoot, head, text, opts) {
  const fs = (opts && opts.fs) || nodeFs.promises;
  if (!/^[0-9a-f]{7,64}$/i.test(head)) throw new TypeError('writeFactsFile: head must be a commit id');
  const dir = path.join(repoRoot, FACTS_DIR);
  await fs.mkdir(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  try { await fs.writeFile(ignore, '*\n', { flag: 'wx' }); } catch (e) { if (!(e && /** @type {any} */ (e).code === 'EEXIST')) throw e; }
  const name = `facts-${head.toLowerCase().slice(0, 12)}.json`;
  for (const old of await fs.readdir(dir)) {
    if (old !== name && FACTS_RE.test(old)) await fs.rm(path.join(dir, old), { force: true });
  }
  const absPath = path.join(dir, name);
  await fs.writeFile(absPath, text, 'utf8');
  return { absPath, relPath: `.impact-tree/cards/${name}` };
}

module.exports = { writeFactsFile, FACTS_DIR };
