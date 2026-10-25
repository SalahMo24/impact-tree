'use strict';

/**
 * The blast-radius text of one root in the CLI tree.
 * `blastNotComputed` is the engine's explicit marker (src/engine/analyze.js): a root past
 * `rankedRoots` was never measured, which is not the same as a blast of zero.
 * `blastNotComputedReason`: the callers themselves were not computed (a language read from
 * its text alone; src/engine/resolver-not-computed.js), said with that reason.
 * @param {{ blast: number|null, blastCapped?: boolean, blastNotComputed?: boolean, blastNotComputedReason?: string }} root
 * @param {number} rankedRoots The effective `--roots` value.
 * @returns {string}
 */
function blastText(root, rankedRoots) {
  if (root.blastNotComputedReason) return `blast ${root.blastNotComputedReason}`;
  if (root.blastNotComputed || root.blast == null) {
    return `blast not computed (top ${rankedRoots} only; raise with --roots)`;
  }
  return `blast ${root.blast}${root.blastCapped ? '+' : ''}`;
}

module.exports = { blastText };
