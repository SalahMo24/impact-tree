// @ts-check
'use strict';
// What a caller resolver adds for a Go target to the callers gopls reports
// (docs/MULTI_LANGUAGE_PLAN.md, G4; `EditorCallerExtras` in ../types.js). Applied by the
// editor's resolver (src/resolver-vscode.js) and, the same way, by the gopls test harness
// (test/lsp-harness/harness-languages.js).
//
// - Value uses are not calls. gopls lists a function used as a value (`Args: f`, `g(f)`, a
//   method value `x.M`) as an incoming call, with its `fromRanges` at the identifier (G0,
//   item 4). `filter` reads the text after each site (./call-sites.js): a caller whose
//   every readable site is a value use does not call the function and is dropped; a caller
//   with both keeps only its call sites (and the unreadable ones), so whether it was
//   updated is decided from its calls. Once a value use is seen, the function's calls
//   through that value cannot be followed: `moreCallers` reports the answer incomplete
//   with `referenced-as-value`, so even an answer left with no caller ends unknown, never
//   "no callers".
// - Build tags. gopls rejects `prepareCallHierarchy` in a file the active build excludes
//   with "no package metadata for file …" (G0, item 3); `explainIncomplete` says so in the
//   reviewer's words. Callers were not searched: the answer is incomplete, and retrying
//   does not help until the build flags change.
// - Interfaces. gopls lists a method's callers through an interface declared in the
//   workspace along with its direct callers (G0, item 3). It does not list calls through an
//   interface declared outside it (G7: `(telemetryDisablerTransport).RoundTrip`, an
//   `http.RoundTripper`, had six such callers, one in the repository, and its answer read
//   complete), and calls from outside the repository can never be listed. So for a method,
//   `moreCallers` asks the server for its implementations (the interface methods it
//   implements and the other methods implementing them): one outside the repository makes
//   the answer incomplete with `implements-outside-interface`. An implementations query
//   that fails or gives no answer makes it incomplete too, with that reason.

const path = require('path');
const { isGoCallSite } = require('./call-sites');
const { readTextOfOffsets } = require('../../engine/textpos');

/** @typedef {import('../../engine/caller-contract').CallerRow} CallerRow */

// The largest caller file read to classify its sites, in bytes on disk. Go source files
// are rarely above a few hundred KiB; a larger one (generated tables) is not read and its
// sites count as unknown: the caller is kept as the server reported it. Each query reads
// each distinct caller file of its answer at most once, and keeps the text only while it
// filters; how many caller files there are is bounded by the server's answer.
const MAX_CALLER_FILE_BYTES = 2 * 1024 * 1024;

// gopls' message when the file is not part of any package of the active build.
const NOT_IN_BUILD = /no package metadata/;
const NOT_IN_BUILD_REASON = 'not in the active build (build tags); callers were not searched';

/**
 * Sorts each caller's sites into calls, value uses and unknown ones. Pure apart from
 * `readText`.
 * @param {CallerRow[]} callers
 * @param {(file: string) => string|null} readText The caller file's text, or null.
 * @returns {{ kept: CallerRow[], dropped: number, valueUses: number }} `kept` in the input
 *   order; a caller with a value use is a copy with only its other sites. `valueUses`
 *   counts the value-use sites seen.
 */
function filterValueUses(callers, readText) {
  /** @type {Map<string, string|null>} */
  const texts = new Map();
  const textOf = (/** @type {string} */ file) => {
    if (!texts.has(file)) texts.set(file, readText(file));
    return /** @type {string|null} */ (texts.get(file));
  };
  /** @type {CallerRow[]} */
  const kept = [];
  let dropped = 0;
  let valueUses = 0;
  for (const caller of callers) {
    const sites = caller.callSites || [];
    if (!sites.length) { kept.push(caller); continue; }
    const text = textOf(caller.file);
    // Calls and unknown sites stay; only a value use is removed.
    const rest = sites.filter((site) => isGoCallSite(text, site) !== false);
    const values = sites.length - rest.length;
    valueUses += values;
    if (!values) kept.push(caller);
    else if (!rest.length) dropped++;
    else kept.push({ ...caller, callSites: rest, sites: rest.length });
  }
  return { kept, dropped, valueUses };
}

/**
 * The reason shown for a Go caller query the server did not answer, when it is one Go
 * explains: a file outside the active build. Null otherwise (the server's reason stands).
 * @param {string} reason
 * @returns {string|null}
 */
const explainGoIncomplete = (reason) => (NOT_IN_BUILD.test(reason) ? NOT_IN_BUILD_REASON : null);

// Why a method's answer is incomplete when it shares an interface with code outside the
// repository (see the header).
const OUTSIDE_INTERFACE_REASON = 'implements-outside-interface';

/**
 * Whether the declaration whose name is at `pos` is a method: its line, up to the name,
 * reads `func (`. Pure.
 * @param {string} text @param {number} pos
 */
function isMethodAt(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^\s*func\s*\(/.test(text.slice(lineStart, pos));
}

/**
 * Whether `file` (absolute) is outside `repoRoot` (absolute).
 * @param {string} repoRoot @param {string} file
 */
const outsideRepo = (repoRoot, file) => {
  const rel = path.relative(repoRoot, file);
  return rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
};

/**
 * Why a method's callers may be missing calls through an interface, or null. Never rejects.
 * Asks only for a method in a readable file, and only when `services` and `repoRoot` are
 * known (the editor's resolver always gives both; a test may give neither).
 * @param {{ services: import('../types').LanguageServices|null, repoRoot: string|null,
 *   readText: (file: string) => string|null, trace: (message: string) => void }} env
 * @param {string} file @param {number} pos
 * @returns {Promise<string|null>}
 */
async function interfaceReason({ services, repoRoot, readText, trace }, file, pos) {
  if (!services || !repoRoot) return null;
  const text = readText(file);
  if (typeof text !== 'string' || !isMethodAt(text, pos)) return null;
  /** @type {import('../types').ServerLocation[]|null} */
  let locations;
  try {
    locations = await services.implementations({ file, side: 'head' }, pos);
  } catch (e) {
    const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    return `the interfaces it implements could not be listed: ${message}`;
  }
  if (locations == null) return 'the interfaces it implements could not be listed (no answer)';
  const outside = locations.filter((l) => outsideRepo(repoRoot, l.file));
  if (!outside.length) return null;
  trace(`go: ${file}@${pos} shares an interface with ${outside.length} method(s) outside the repository, e.g. ${outside[0].file}`);
  return OUTSIDE_INTERFACE_REASON;
}

/**
 * Go's caller extras. Holds no state between queries: each query keeps whether it saw a
 * value use, so `clear()` has nothing to drop.
 * @param {{ trace?: (message: string) => void, readText?: (file: string) => string|null,
 *   services?: import('../types').LanguageServices|null, repoRoot?: string|null }} [options]
 *   `readText` (tests): a file's text; by default through src/engine/textpos.js, the text
 *   the sites' offsets were converted from, up to MAX_CALLER_FILE_BYTES. `services` and
 *   `repoRoot`: where a method's implementations are asked and which of them are outside
 *   the repository; without either, no method is checked.
 * @returns {import('../types').EditorCallerExtras}
 */
function createGoEditorExtras({ trace = () => {}, readText = (file) => readTextOfOffsets(file, { maxBytes: MAX_CALLER_FILE_BYTES }), services = null, repoRoot = null } = {}) {
  return {
    // Go never suppresses a query (`isSuppressed` is always false).
    suppressedReason: 'caller query not asked',
    // Callers dropped for using the function only as a value.
    droppedStat: 'valueUsesDropped',
    query(file, pos) {
      let sawValueUse = false;
      return {
        isSuppressed: () => false,
        filter(callers) {
          const { kept, dropped, valueUses } = filterValueUses(callers, readText);
          if (valueUses) {
            sawValueUse = true;
            trace(`go: ${valueUses} value use(s) among ${callers.length} caller(s); ${dropped} caller(s) only use it as a value`);
          }
          return { kept, dropped };
        },
        // Asked after `filter`; nothing to search, only whether the answer is complete. A
        // value use is the stronger reason (its calls cannot be followed at all), so a
        // method used as a value is not asked about its interfaces.
        moreCallers: async () => ({
          callers: [],
          incompleteReason: sawValueUse ? 'referenced-as-value' : await interfaceReason({ services, repoRoot, readText, trace }, file, pos),
        }),
      };
    },
    explainIncomplete: explainGoIncomplete,
    // gopls' answer is the whole workspace's (tests included); there are no users it is
    // known not to see.
    unseenUsers: async () => null,
    clear() {},
  };
}

module.exports = { createGoEditorExtras, filterValueUses, explainGoIncomplete, isMethodAt, MAX_CALLER_FILE_BYTES, NOT_IN_BUILD_REASON, OUTSIDE_INTERFACE_REASON };
