// @ts-check
'use strict';

// Cards for an analysis result: the clusters and sweeps of `buildClusters` plus the
// evidence between clusters (`hints`) that `hintsFor` finds. Checkout mode only: the diff
// facts and rare-token counts come from the repository's history (an I/O step, see
// cluster-hints.js); the preview has no checkout and builds its cards separately.
//
// What this does NOT establish: see clusters.js and cluster-hints.js. `hintNotes` lists the
// steps that failed or were capped; "no hint" for a step named there means "not checked".
// Impact paths are not merged into cards.

const { buildClusters } = require('./clusters');
const { gatherDiffFacts, countRareTokens, hintsFor } = require('./cluster-hints');

/**
 * @param {any} result an `analyze()` result (needs `allChanged`; `deleted` when present)
 * @param {{repo: string, base: string, head: string}} p `repo` is the repository root,
 *   `base` and `head` are revisions (`base` a pinned sha, `head` `'HEAD'` in pr mode)
 * @returns {{version: 1, clusters: any[], sweeps: any[], seams: any[], rules: Record<string, number>,
 *   hints: any[], hintNotes: string[], generatedDirs: string[]}}
 */
function buildCards(result, { repo, base, head }) {
  const facts = gatherDiffFacts({ repo, base, head });
  const built = buildClusters(result, { facts });
  const counted = countRareTokens(facts, built.clusters, { repo, head });
  const hintNotes = counted.notes.slice();
  // Clusters include uncommitted edits; the hints read history up to `head` only.
  if (result.mode !== 'pr' && result.dirtyCount > 0) {
    hintNotes.unshift(`hints read committed history only: ${result.dirtyCount} file(s) with uncommitted changes are in the cards but not in the hints`);
  }
  return { ...built, hints: hintsFor(built.clusters, counted), hintNotes, generatedDirs: counted.generatedDirs };
}

module.exports = { buildCards };
