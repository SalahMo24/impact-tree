// @ts-check
'use strict';
// The caller resolver of a unit whose callers are not computed: a language analysed from
// its text alone, where there is no language server (Python in the CLI and the no-checkout
// preview; docs/MULTI_LANGUAGE_PLAN.md, A4). Its changed functions and their kinds are
// known; who calls them is not searched at all. Every answer says so (CODING_STYLE §1):
// `callerState` is `'unknown'` and incomplete with the reason, the state TypeScript's
// preview gives a function whose callers it cannot see, so nothing reads as "no callers",
// "uncovered" or a blast radius of zero.

/** The words every not-computed reason starts with, so a surface can tell it from a search's. */
const NOT_COMPUTED = 'not computed';

/**
 * @param {string} language Display name ("Python").
 * @returns {string} The reason a reviewer reads after "callers ".
 */
const notComputedReason = (language) => `${NOT_COMPUTED}: ${language} callers need its language server; open the repository in the editor to find them`;

/** @param {unknown} reason @returns {boolean} Whether a caller reason is a not-computed one. */
const isNotComputedReason = (reason) => typeof reason === 'string' && reason.startsWith(`${NOT_COMPUTED}:`);

/**
 * A resolver that searches nothing. `callersNotComputed` carries the reason, so the
 * pipeline marks blast radii as not computed rather than counting zero callers.
 * @param {string} reason From `notComputedReason`.
 */
function createNotComputedResolver(reason) {
  return Object.freeze({
    callersNotComputed: reason,
    callerState: async () => ({ state: /** @type {'unknown'} */ ('unknown'), callers: [], complete: false, reason }),
    incoming: async () => [],
    incomingWithStatus: async () => ({ callers: [], complete: false, reason }),
    stats: () => ({}),
  });
}

module.exports = { createNotComputedResolver, notComputedReason, isNotComputedReason };
