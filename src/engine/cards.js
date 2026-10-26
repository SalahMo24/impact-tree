// @ts-check
'use strict';

// Cards for an analysis result: the clusters and sweeps of `buildClusters` plus the
// evidence between clusters (`hints`) that `hintsFor` finds. Three steps, so a caller can
// show the cards at once and add the slow evidence when it arrives:
//   1. gatherLocalCardFacts (checkout) or gatherRemoteCardFacts (preview, cards-remote.js):
//      the I/O, asynchronous and cancellable;
//   2. buildCardsFromFacts: pure and fast; cards with `hints: []`;
//   3. addHints: the rare-token search (checkout only) and `hintsFor`; a new Cards object.
// `buildCards` runs all three for the checkout.
//
// What this does NOT establish: see clusters.js and cluster-hints.js. `hintNotes` lists the
// steps that failed or were capped; "no hint" for a step named there means "not checked".
// Cards before `addHints` have `hints: []`, which means "not computed", not "none found".
// Impact paths are not merged into cards.

const { buildClusters } = require('./clusters');
const { gatherDiffFactsAsync, countRareTokensAsync, hintsFor } = require('./cluster-hints');
const { throwIfCancelled } = require('./cancellation');

const NO_CHECKOUT_NOTE = 'preview: rare-token hints not checked (no checkout)';

/**
 * @typedef {import('./cluster-hints').Facts} Facts
 * @typedef {{version: 1, clusters: any[], sweeps: any[], seams: any[], rules: Record<string, number>,
 *   hints: any[], hintNotes: string[], generatedDirs: string[]}} Cards
 */

/**
 * The git facts of a checkout, gathered with child processes that do not block the caller.
 * @param {{repo: string, base: string, head: string, signal?: AbortSignal}} p `base` is a
 *   pinned sha, `head` a revision (`'HEAD'` in pr mode)
 * @returns {Promise<Facts>}
 * @throws {import('./cancellation').AnalysisCancelledError} when `signal` aborted; no facts
 */
function gatherLocalCardFacts({ repo, base, head, signal }) {
  return gatherDiffFactsAsync({ repo, base, head, signal });
}

/**
 * Cards from an analysis result and its facts. Pure and synchronous; `hints` is empty
 * until `addHints`. The notes carry the facts' notes, and say when uncommitted edits are
 * in the cards but not in the history the hints read.
 * @param {any} result an `analyze()` result (needs `allChanged`; `deleted` when present)
 * @param {Facts} facts
 * @returns {Cards}
 */
function buildCardsFromFacts(result, facts) {
  const built = buildClusters(result, { facts });
  const hintNotes = facts.notes.slice();
  if (result.mode !== 'pr' && result.dirtyCount > 0) {
    hintNotes.unshift(`hints read committed history only: ${result.dirtyCount} file(s) with uncommitted changes are in the cards but not in the hints`);
  }
  return { ...built, hints: [], hintNotes, generatedDirs: facts.generatedDirs };
}

/**
 * A new Cards object with `hints`; `cards` is not changed. With `repo`, the rare words
 * shared by two clusters are counted with one `git grep` at `head`. Without it (the preview
 * has no checkout) no word is counted, the hints rest on the other evidence, and a note
 * says so.
 * @param {Cards} cards
 * @param {Facts} facts  the facts `cards` was built from
 * @param {{repo?: string, head?: string, signal?: AbortSignal}} [p]
 * @returns {Promise<Cards>}
 * @throws {import('./cancellation').AnalysisCancelledError} when `signal` aborted
 */
async function addHints(cards, facts, { repo, head = 'HEAD', signal } = {}) {
  throwIfCancelled(signal);
  /** @type {Facts} */
  let counted;
  /** @type {string[]} */
  let added;
  if (repo !== undefined) {
    counted = await countRareTokensAsync(facts, cards.clusters, { repo, head, signal });
    added = counted.notes.slice(facts.notes.length); // the notes the search itself added
  } else {
    counted = { ...facts, tokenFiles: {}, tokenCountsPartial: false };
    added = [NO_CHECKOUT_NOTE];
  }
  throwIfCancelled(signal);
  return { ...cards, hints: hintsFor(cards.clusters, counted), hintNotes: [...cards.hintNotes, ...added] };
}

/**
 * Gather, build, add hints: the cards of a checkout in one call.
 * @param {any} result
 * @param {{repo: string, base: string, head: string, signal?: AbortSignal}} p
 * @returns {Promise<Cards>}
 */
async function buildCards(result, { repo, base, head, signal }) {
  const facts = await gatherLocalCardFacts({ repo, base, head, signal });
  return addHints(buildCardsFromFacts(result, facts), facts, { repo, head, signal });
}

module.exports = { buildCards, gatherLocalCardFacts, buildCardsFromFacts, addHints };
