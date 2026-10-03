// @ts-check
'use strict';
// The answer every caller resolver gives: the TypeScript language service, the editor's
// call hierarchy, the syntactic PR index and the module-caller wrapper. Contracts only;
// each adapter implements them its own way.

/**
 * One function or method that calls the queried symbol.
 * @typedef {object} CallerRow
 * @property {string} label Display name, such as `Class.method`.
 * @property {string} file Absolute path of the file holding the caller.
 * @property {number} pos UTF-16 offset of the caller's name in `file`.
 * @property {boolean} test Whether `file` is a test file.
 * @property {number} sites How many call sites `callSites` holds.
 * @property {Array<{start: number, end: number}>} callSites UTF-16 offsets in `file`,
 *   end exclusive, of each call to the queried symbol.
 */

/**
 * Answer to `incomingWithStatus`. `complete: false` means the search did not finish for
 * its scope, so `callers` may be missing some or all callers; `reason` says why.
 * @typedef {object} CallerAnswer
 * @property {CallerRow[]} callers
 * @property {boolean} complete
 * @property {string} [reason] Present whenever `complete` is false.
 */

/**
 * Answer to `callerState`: the callers plus a verdict on what an empty or partial list means.
 * - `'resolved'`: at least one caller was found. It can still be incomplete.
 * - `'none'`: a finished search found no caller and no other use. Always complete.
 * - `'di'`: a constructor with no `new` site found, so a DI container is assumed to build
 *   it. Incomplete when the search covered only part of the code, as in a PR preview.
 * - `'unknown'`: no caller was found, and absence cannot be concluded. Always incomplete.
 * @typedef {object} CallerState
 * @property {'resolved'|'none'|'di'|'unknown'} state
 * @property {CallerRow[]} callers Empty unless `state` is `'resolved'`.
 * @property {boolean} complete
 * @property {string} [reason] Present whenever `complete` is false.
 */

module.exports = {};
