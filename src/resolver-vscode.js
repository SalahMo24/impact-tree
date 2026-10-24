'use strict';
const vscode = require('vscode');
const { isTestFile } = require('./engine/diff');
const { makeCqrsEdges } = require('./engine/edges-cqrs');
const { createInheritanceFilter } = require('./engine/inheritance');
const { findUnseenUsers, unseenUsersReason, gitGrep } = require('./engine/unseen-users');
const { makeGit } = require('./engine/git');
const { createVscodeServices } = require('./services-vscode');
const { callersFromHierarchy, queryHierarchy, callerRows } = require('./languages/callers-from-hierarchy');

// Callers from the editor's already-running language server. Talking to the server (the
// request cap, deadlines, the cold phase, retries, warm-up, offset conversion from disk,
// never opening documents) is `createVscodeServices` (src/services-vscode.js); reading
// call hierarchies and references into caller answers is `callersFromHierarchy`
// (src/languages/callers-from-hierarchy.js). This resolver adds the cache and the
// TypeScript-only extras: the inheritance filter, command-bus (CQRS) edges and users the
// server cannot see. Those move into the TypeScript provider in T3
// (docs/MULTI_LANGUAGE_PLAN.md).
function createVscodeResolver({
  retries = 4, retryDelayMs = 250, queryTimeoutMs = 5000, coldQueryTimeoutMs = 60000, coldBudgetMs = 120000,
  ts = null, trace = () => {}, filterInherited = true, repoRoot = null,
} = {}) {
  // incomingMs sums concurrent durations, so it exceeds wall time once queries overlap.
  // Keep it for cost, but record the distribution and let the caller time the phase.
  const initialStats = () => ({
    incomingCalls: 0, incomingMs: 0, cacheHits: 0, warmupRetries: 0,
    skipped: 0, resolvedEmpty: 0, cqrsEdges: 0, cqrsSuppressed: 0, durations: [], emptyAt: [],
    inheritedDropped: 0, unseenUsers: 0,
  });
  const stats = initialStats();
  // Validates the deadlines and budgets (see createVscodeServices for each one's range and
  // what happens when it runs out). Owner: this resolver; the server state it tracks lives
  // as long as the resolver, and clear() starts a new analysis in it.
  const services = createVscodeServices({
    vscode, repoRoot, retries, retryDelayMs, queryTimeoutMs, coldQueryTimeoutMs, coldBudgetMs, trace,
    onRetry: () => { stats.warmupRetries++; },
  });
  /** Every file this resolver is asked about is the one on disk. */
  const headDoc = (file) => ({ file, side: 'head' });
  // Cache: complete caller answers (`cache`) and how each query ended (`queryStates`).
  // Owner: this resolver, which the session keeps for the window (`session.resolver`,
  // created in src/readiness.js). Key: target file#position and whether tests were
  // searched. The repository, TypeScript module and the inherited-member setting are
  // fixed when the resolver is created, and files are assumed not to change during an
  // analysis. Invalidation: the session calls `clear()` at the start of every local
  // analysis; `invalidate(file)` drops the entries naming a file. An incomplete answer
  // is never cached. Disposal: `session.dispose()` drops the resolver and with it both maps.
  const cache = new Map();
  const queryStates = new Map();
  // Clearing starts a new analysis. The editor cannot cancel an older query, so its
  // late answer must not repopulate these maps after the replacement has cleared them.
  let generation = 0;
  const staleAnswer = () => ({ callers: [], complete: false, reason: 'caller query belongs to an earlier analysis' });
  const isTestPath = (f) => isTestFile(repoRoot, f);

  // The call hierarchy reports sibling-subclass dispatch as an incoming call to an
  // override. Filtering needs only syntax, so it costs a parse of the caller file.
  const inherited = filterInherited ? createInheritanceFilter(ts, { trace }) : null;

  // Same CQRS logic as the CLI, but definition/reference come from the editor's server
  // instead of our own program.
  const cqrsProviders = {
    isTestPath,
    trace,
    async definitionAt(file, offset) {
      let locations;
      try {
        locations = await services.definitions(headDoc(file), offset);
      } catch (e) { throw new Error(`definition lookup failed: ${e.message}`); }
      const l = locations && locations[0];
      return l && l.start != null ? { file: l.file, offset: l.start } : null;
    },
    async referencesTo(file, offset) {
      // An empty reference list before the project is loaded is indistinguishable from
      // "no references", and silently becomes "this handler has no callers". Retry
      // until the server is warm, then trust the answer. A non-empty answer makes the
      // services count the server as warm.
      let locs = [];
      for (let attempt = 0; attempt < (services.isServerWarm() ? 1 : 5); attempt++) {
        try {
          locs = (await services.references(headDoc(file), offset)) || [];
        } catch (e) { throw new Error(`reference lookup failed: ${e.message}`); }
        if (locs.length) break;
        if (services.isServerWarm()) break;
        stats.warmupRetries++;
        await sleep(250 * (attempt + 1));
      }
      if (!locs.length) trace(`references: none for ${require('path').basename(file)}@${offset}${services.isServerWarm() ? '' : ' (server never warmed)'}`);
      const out = [];
      for (const l of locs) if (l.start != null) out.push({ file: l.file, offset: l.start });
      return out;
    },
  };
  // Owner: one editor analysis generation. The helper's parsed-file cache is
  // replaced by clear(), alongside caller answers and inheritance data. Each query
  // captures its helper, so an obsolete provider completion can only populate its
  // old cache; that cache is released when the last obsolete query settles. Source
  // mtime/size checks and same-generation reuse remain in makeCqrsEdges.
  let cqrs = ts && makeCqrsEdges(ts, cqrsProviders);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function warmUp(file, pos, options) {
    const wasWarm = services.isWarm();
    const started = Date.now();
    const warm = await services.warmUp(headDoc(file), pos, options);
    if (warm && !wasWarm) stats.warmUpMs = Date.now() - started;
    return warm;
  }

  // `complete: false` means the query did not finish, so `callers` may be missing some or
  // all of them. Only complete answers are cached, so asking again can still succeed.
  /** @returns {Promise<import('./engine/caller-contract').CallerAnswer>} */
  async function incomingWithStatus(file, pos, withTests = true) {
    const startedGeneration = generation;
    const queryCqrs = cqrs;
    const key = `${withTests ? 'A' : 'P'}${file}#${pos}`;
    if (cache.has(key)) { stats.cacheHits++; return { callers: cache.get(key), complete: true }; }
    const t = Date.now();
    stats.incomingCalls++;
    // a handler's execute() resolves through ICommandHandler.execute, so the call
    // hierarchy returns every bus.execute() site; none of them reach this handler
    const isHandler = !!(queryCqrs && queryCqrs.isHandlerExecute(file, pos));
    if (isHandler) stats.cqrsSuppressed++;
    const answer = isHandler ? { ready: true, rows: [] } : await queryHierarchy(services, headDoc(file), pos);
    if (startedGeneration !== generation) return staleAnswer();
    const { ready } = answer;
    const reason = answer.ready ? undefined : answer.reason;
    const retryable = !answer.ready && answer.retryable;
    queryStates.set(key, { ready, reason, isHandler, retryable });
    if (answer.ready && !answer.rows.length) { stats.resolvedEmpty++; stats.emptyAt.push({ file, pos }); }
    const dt = Date.now() - t;
    stats.incomingMs += dt;
    stats.durations.push(dt);
    if (!stats.slowest || dt > stats.slowest.ms) stats.slowest = { ms: dt, file, pos };
    if (dt > 3000) trace(`slow query ${dt}ms  ${file}@${pos}`);
    if (!ready) {
      stats.skipped++;
      if (reason) stats.lastReason = reason;
      return { callers: [], complete: false, reason: reason || 'caller query did not complete', ...(retryable ? { retryable: true } : {}) };
    }
    const out = callerRows(answer.rows, withTests);
    if (inherited && out.length) {
      const { kept, dropped } = inherited.filterAt(file, pos, out);
      if (dropped) {
        stats.inheritedDropped += dropped;
        out.length = 0;
        out.push(...kept);
      }
    }
    let cqrsFailure = null;
    if (queryCqrs) {
      let extra = [];
      try {
        const found = await queryCqrs.extraCallers(file, pos);
        extra = found.callers;
        if (found.unresolved.length) cqrsFailure = `no definition found for ${found.unresolved.join(', ')}`;
      } catch (e) { cqrsFailure = (e && e.message) || 'lookup failed'; }
      if (startedGeneration !== generation) return staleAnswer();
      stats.cqrsEdges += extra.length;
      const have = new Set(out.map((c) => `${c.file}#${c.pos}`));
      for (const e of extra) {
        if (have.has(`${e.file}#${e.pos}`)) continue;
        if (!withTests && e.test) continue;
        out.push(e);
      }
    }
    if (cqrsFailure) return { callers: out, complete: false, reason: `command-bus callers unavailable — ${cqrsFailure}` };
    cache.set(key, out);
    return { callers: out, complete: true };
  }

  // The server answers from the projects it has loaded; a component's tests in their own
  // tsconfig are never among them (see engine/unseen-users.js). Before "no callers", look
  // for files that may use the symbol outside them. A search that fails is logged and
  // leaves the server's answer: it is no evidence either way.
  const grep = repoRoot ? gitGrep(makeGit(repoRoot)) : null;
  /** @returns {Promise<string|null>} The reason the answer is unknown, or null. */
  async function unseenUsers(file, pos) {
    if (!ts || !grep) return null;
    try {
      const found = await findUnseenUsers({ ts, repo: repoRoot, declFile: file, pos, grep });
      if (!found) return null;
      const reason = unseenUsersReason(found);
      if (reason) { stats.unseenUsers++; trace(`no callers from the server, but ${reason}`); }
      return reason;
    } catch (e) {
      trace(`unseen-users search failed for ${require('path').basename(file)}@${pos}: ${e && e.message}`);
      return null;
    }
  }

  async function incoming(file, pos, withTests = true) {
    return (await incomingWithStatus(file, pos, withTests)).callers;
  }

  return {
    kind: 'vscode-callhierarchy',
    incoming,
    incomingWithStatus,
    warmUp,
    isWarm: () => services.isWarm(),
    /**
     * The server is about to reload its projects (the worktree moved under it, as a
     * checkout does): treat it as cold until a caller query answers again.
     */
    expectReload: () => services.expectReload(),
    /** @returns {Promise<import('./engine/caller-contract').CallerState>} */
    async callerState(file, pos, { isConstructor = false } = {}) {
      return callersFromHierarchy(services, {
        doc: headDoc(file), pos, isConstructor,
        incoming: () => incomingWithStatus(file, pos),
        // A completed empty answer whose query did not finish (or was suppressed as a
        // command-bus handler) says nothing about callers.
        settle: () => {
          const status = queryStates.get(`A${file}#${pos}`);
          if (!status?.ready) {
            return { state: 'unknown', reason: status?.reason || 'caller query did not complete', callers: [], complete: false, ...(status?.retryable ? { retryable: true } : {}) };
          }
          if (status.isHandler && !isConstructor) return { state: 'unknown', reason: 'command-bus handler', callers: [], complete: false };
          return null;
        },
        unseenUsers: () => unseenUsers(file, pos),
      });
    },
    stats: () => {
      const d = stats.durations.slice().sort((a, b) => a - b);
      return {
        ...stats,
        minMs: d[0] || 0,
        medianMs: d.length ? d[Math.floor(d.length / 2)] : 0,
        maxMs: d[d.length - 1] || 0,
      };
    },
    invalidate(file) {
      for (const k of [...cache.keys()]) if (k.includes(file)) cache.delete(k);
      for (const k of [...queryStates.keys()]) if (k.slice(1).startsWith(`${file}#`)) queryStates.delete(k);
    },
    clear() {
      generation++;
      services.beginAnalysis();
      cache.clear();
      queryStates.clear();
      inherited?.clear();
      cqrs = ts && makeCqrsEdges(ts, cqrsProviders);
      for (const key of Object.keys(stats)) delete stats[key];
      Object.assign(stats, initialStats());
    },
  };
}
module.exports = { createVscodeResolver };
