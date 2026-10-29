// @ts-check
'use strict';
// What the editor's resolver (src/session/resolver-vscode.js) adds for a TypeScript/JavaScript
// target to the callers the language server reports: the inheritance filter, command-bus
// (CQRS) edges, and users the server cannot see. The resolver keeps the cache, the
// analysis generation and the stats; these only decide what to add or remove.
//
// `edges-cqrs` is required when the extras are made, not at the top: tests stand in for
// it through the module cache before they create a resolver.
const { createInheritanceFilter } = require('../../engine/inheritance');
const { findUnseenUsers, unseenUsersReason, gitGrep } = require('../../engine/unseen-users');
const { makeGit } = require('../../engine/git');
const { isTestFile } = require('../../engine/diff');
const { realClock } = require('../../engine/clock');

/**
 * @param {object} options See `LanguageProvider.editorCallers` (src/languages/types.js).
 * @param {any} options.ts The TypeScript compiler module (`any`: it is loaded dynamically, see
 *   ./load.js), or null; null turns off the command-bus
 *   edges and the unseen-users search (and the inheritance filter, which needs a parser).
 * @param {any} options.services The resolver's `VscodeServices` (`any`: that type lives in the
 *   resolver, which depends on this module).
 * @param {string|null} options.repoRoot
 * @param {(message: string) => void} options.trace
 * @param {boolean} options.filterInherited
 * @param {() => void} options.onWarmupRetry
 * @param {import('../../engine/clock').Clock} [options.clock] Times the waits between
 *   reference retries (src/engine/clock.js).
 * @returns {import('../types').EditorCallerExtras}
 */
function createTypescriptEditorExtras({ ts, services, repoRoot, trace, filterInherited, onWarmupRetry, clock = realClock }) {
  /**
   * Every file this resolver is asked about is the one on disk.
   * @param {string} file Absolute path.
   */
  const headDoc = (file) => ({ file, side: 'head' });
  /** @param {string} f Absolute path. */
  const isTestPath = (f) => isTestFile(repoRoot, f);
  const { makeCqrsEdges } = require('../../engine/edges-cqrs');

  // The call hierarchy reports sibling-subclass dispatch as an incoming call to an
  // override. Filtering needs only syntax, so it costs a parse of the caller file.
  // Owner: these extras, which live as long as their resolver; `clear()` empties it.
  const inherited = filterInherited ? createInheritanceFilter(ts, { trace: /** @type {() => void} */ (trace) }) : null;

  // Same CQRS logic as the CLI, but definition/reference come from the editor's server
  // instead of our own program.
  const cqrsProviders = {
    isTestPath,
    // The CQRS helper's `trace` default is typed `() => void`; ours takes the message.
    trace: /** @type {() => void} */ (trace),
    /**
     * @param {string} file Absolute path.
     * @param {number} offset UTF-16 offset.
     */
    async definitionAt(file, offset) {
      let locations;
      try {
        locations = await services.definitions(headDoc(file), offset);
      } catch (e) { throw new Error(`definition lookup failed: ${/** @type {Error} */ (e).message}`, { cause: e }); }
      const l = locations && locations[0];
      return l && l.start != null ? { file: l.file, offset: l.start } : null;
    },
    /**
     * @param {string} file Absolute path.
     * @param {number} offset UTF-16 offset.
     */
    async referencesTo(file, offset) {
      // An empty reference list before the project is loaded is indistinguishable from
      // "no references", and silently becomes "this handler has no callers". Retry
      // until the server is warm, then trust the answer. A non-empty answer makes the
      // services count the server as warm.
      let locs = [];
      for (let attempt = 0; attempt < (services.isServerWarm() ? 1 : 5); attempt++) {
        try {
          locs = (await services.references(headDoc(file), offset)) || [];
        } catch (e) { throw new Error(`reference lookup failed: ${/** @type {Error} */ (e).message}`, { cause: e }); }
        if (locs.length) break;
        if (services.isServerWarm()) break;
        onWarmupRetry();
        await clock.sleep(250 * (attempt + 1));
      }
      if (!locs.length) trace(`references: none for ${require('path').basename(file)}@${offset}${services.isServerWarm() ? '' : ' (server never warmed)'}`);
      const out = [];
      for (const l of locs) if (l.start != null) out.push({ file: l.file, offset: l.start });
      return out;
    },
  };
  // Owner: one editor analysis generation. The helper's parsed-file cache is
  // replaced by clear(), alongside the resolver's caller answers and the inheritance
  // data. Each query captures its helper (`query`), so an obsolete provider completion
  // can only populate its old cache; that cache is released when the last obsolete query
  // settles. Source mtime/size checks and same-generation reuse remain in makeCqrsEdges.
  let cqrs = ts && makeCqrsEdges(ts, cqrsProviders);

  // The server answers from the projects it has loaded; a component's tests in their own
  // tsconfig are never among them (see engine/unseen-users.js). Before "no callers", look
  // for files that may use the symbol outside them. A search that fails is logged and
  // leaves the server's answer: it is no evidence either way.
  const grep = repoRoot ? gitGrep(makeGit(repoRoot)) : null;

  return {
    // a handler's execute() resolves through ICommandHandler.execute, so the call
    // hierarchy returns every bus.execute() site; none of them reach this handler
    suppressedReason: 'command-bus handler',
    // Callers the inheritance filter drops: sibling-subclass dispatch reported as a call.
    droppedStat: 'inheritedDropped',
    query(file, pos) {
      const queryCqrs = cqrs;
      return {
        isSuppressed: () => !!(queryCqrs && queryCqrs.isHandlerExecute(file, pos)),
        filter: (callers) => (inherited && callers.length ? inherited.filterAt(file, pos, callers) : { kept: callers, dropped: 0 }),
        // No compiler, no command-bus edges: nothing to wait for.
        moreCallers: queryCqrs && (async () => {
          let failure = null;
          let callers = [];
          try {
            const found = await queryCqrs.extraCallers(file, pos);
            callers = found.callers;
            if (found.unresolved.length) failure = `no definition found for ${found.unresolved.join(', ')}`;
          } catch (e) { failure = (e && /** @type {Error} */ (e).message) || 'lookup failed'; }
          return { callers, incompleteReason: failure && `command-bus callers unavailable — ${failure}` };
        }),
      };
    },
    async unseenUsers(file, pos) {
      if (!ts || !grep) return null;
      try {
        const found = await findUnseenUsers({ ts, repo: /** @type {string} */ (repoRoot), declFile: file, pos, grep });
        if (!found) return null;
        const reason = unseenUsersReason(found);
        if (reason) trace(`no callers from the server, but ${reason}`);
        return reason;
      } catch (e) {
        trace(`unseen-users search failed for ${require('path').basename(file)}@${pos}: ${e && /** @type {Error} */ (e).message}`);
        return null;
      }
    },
    clear() {
      inherited?.clear();
      cqrs = ts && makeCqrsEdges(ts, cqrsProviders);
    },
  };
}

module.exports = { createTypescriptEditorExtras };
