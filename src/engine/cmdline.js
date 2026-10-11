// @ts-check
'use strict';

// Windows' CreateProcess rejects a command line over 32,767 characters (terminator
// included). Leave a margin under it rather than sitting on the edge.
const COMMAND_LINE_BUDGET = 30000;
// `git` may be spawned by absolute path (C:\Program Files\Git\cmd\git.exe); MAX_PATH covers it.
const EXECUTABLE_ALLOWANCE = 260;

// What one argument costs once Windows has quoted it: the text, a separating space and a
// pair of quotes. A quote or a backslash may need an escape, so count each twice.
const argCost = (/** @type {string} */ a) => a.length + 3 + (a.match(/["\\]/g) || []).length;

/**
 * Split path groups into batches so `git <fixedArgs> <batch>` never exceeds `maxChars`.
 * Batching rather than `--pathspec-from-file=-`: it works on every git version we support
 * and for every command, while the stdin form needs git 2.26+ and per-command support.
 * A group (a rename's old and new path) is never split, because git can only pair a
 * rename when both paths are in the same pathspec. One group larger than the budget
 * still gets a batch of its own.
 * @param {string[]} fixedArgs Every argument of the command except the paths.
 * @param {string[][]} groups
 * @param {number} [maxChars] Whole command line, executable included.
 * @returns {string[][]} Flat path lists, one per command.
 */
function batchPaths(fixedArgs, groups, maxChars = COMMAND_LINE_BUDGET) {
  const fixed = EXECUTABLE_ALLOWANCE + fixedArgs.reduce((n, a) => n + argCost(a), 0);
  const batches = [];
  let batch = [], size = fixed;
  for (const g of groups) {
    const len = g.reduce((n, p) => n + argCost(p), 0);
    if (batch.length && size + len > maxChars) { batches.push(batch); batch = []; size = fixed; }
    batch.push(...g); size += len;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

module.exports = { batchPaths, COMMAND_LINE_BUDGET };
