'use strict';
const vscode = require('vscode');
const path = require('path');
const { languageFor } = require('./languages');
const { createVscodeServices } = require('./services-vscode');
const { realClock } = require('./engine/clock');
const { callersFromHierarchy, queryHierarchy, callerRows } = require('./languages/callers-from-hierarchy');

// Callers from the editor's already-running language server, for any language. Talking to
// the server (the request cap, deadlines, the cold phase, retries, warm-up, offset
// conversion from disk, never opening documents) is `createVscodeServices`
// (src/services-vscode.js); reading call hierarchies and references into caller answers is
// `callersFromHierarchy` (src/languages/callers-from-hierarchy.js). This resolver adds the
// cache, the analysis generation and the stats, and applies a language's own extras
// (`LanguageProvider.editorCallers`, such as TypeScript's inheritance filter, command-bus
// edges and unseen users) to the targets of that language only.
//
// `scratchDir` (absolute, or null) is where the services write temporary base-side copies
// to ask a server about (see createVscodeServices). The services are exposed as
// `resolver.services`: the analysis reads server-backed languages' symbols (Go) through
// them (`analyze()`'s `languageServices`), sharing this resolver's request cap and
// deadlines.
//
// `clock` (src/engine/clock.js) times the services' deadlines, budgets and retries, the
// language extras' retry waits, and the durations in the stats.
function createVscodeResolver({
  retries = 4, retryDelayMs = 250, queryTimeoutMs = 5000, coldQueryTimeoutMs = 60000, coldBudgetMs = 120000,
  ts = null, trace = () => {}, filterInherited = true, repoRoot = null, scratchDir = null, clock = realClock,
} = {}) {
  // incomingMs sums concurrent durations, so it exceeds wall time once queries overlap.
  // Keep it for cost, but record the distribution and let the caller time the phase.
  const initialStats = () => ({
    incomingCalls: 0, incomingMs: 0, cacheHits: 0, warmupRetries: 0,
    skipped: 0, resolvedEmpty: 0, cqrsEdges: 0, cqrsSuppressed: 0, durations: [], emptyAt: [],
    inheritedDropped: 0, unseenUsers: 0, valueUsesDropped: 0,
  });
  const stats = initialStats();
  // Validates the deadlines and budgets (see createVscodeServices for each one's range and
  // what happens when it runs out). Owner: this resolver; the server state it tracks lives
  // as long as the resolver, and clear() starts a new analysis in it.
  const services = createVscodeServices({
    vscode, scratchDir, repoRoot, retries, retryDelayMs, queryTimeoutMs, coldQueryTimeoutMs, coldBudgetMs, trace, clock,
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

  // A language's own caller extras, made the first time a target of that language is
  // asked about. Owner: this resolver; each keeps what it learns until `clear()`.
  // Key: the language id. `ts` is passed to every language's extras; only TypeScript's
  // read it. Disposal: with the resolver.
  /** @type {Map<string, import('./languages/types').EditorCallerExtras>} */
  const extrasByLanguage = new Map();
  const extrasOptions = {
    ts, services, repoRoot, trace, filterInherited, clock, onWarmupRetry: () => { stats.warmupRetries++; },
  };
  const languageOf = (file) => languageFor(repoRoot ? path.relative(repoRoot, file).split(path.sep).join('/') : file);
  /** @returns {import('./languages/types').EditorCallerExtras|null} */
  function extrasFor(file) {
    const language = languageOf(file);
    if (!language || !language.editorCallers) return null;
    let extras = extrasByLanguage.get(language.id);
    if (!extras) {
      extras = language.editorCallers(extrasOptions);
      extrasByLanguage.set(language.id, extras);
    }
    return extras;
  }

  async function warmUp(file, pos, options) {
    const wasWarm = services.isWarm();
    const started = clock.now();
    const warm = await services.warmUp(headDoc(file), pos, options);
    if (warm && !wasWarm) stats.warmUpMs = clock.now() - started;
    return warm;
  }

  // `complete: false` means the query did not finish, so `callers` may be missing some or
  // all of them. Only complete answers are cached, so asking again can still succeed.
  /** @returns {Promise<import('./engine/caller-contract').CallerAnswer>} */
  async function incomingWithStatus(file, pos, withTests = true) {
    const startedGeneration = generation;
    // Taken now, so a query that outlives `clear()` keeps its generation's extras.
    const languageExtras = extrasFor(file);
    const extras = languageExtras?.query(file, pos) ?? null;
    const key = `${withTests ? 'A' : 'P'}${file}#${pos}`;
    if (cache.has(key)) { stats.cacheHits++; return { callers: cache.get(key), complete: true }; }
    const t = clock.now();
    stats.incomingCalls++;
    // A query the language's extras know the server answers wrongly (a TypeScript
    // command-bus handler) is not asked; its empty answer settles as unknown.
    const isHandler = !!(extras && extras.isSuppressed());
    if (isHandler) stats.cqrsSuppressed++;
    const answer = isHandler ? { ready: true, rows: [] } : await queryHierarchy(services, headDoc(file), pos);
    if (startedGeneration !== generation) return staleAnswer();
    const { ready } = answer;
    // A failure the language explains (Go: a file outside the active build) shows its
    // explanation, and asking again does not help.
    const explained = !answer.ready && languageExtras?.explainIncomplete ? languageExtras.explainIncomplete(answer.reason) : null;
    const reason = answer.ready ? undefined : explained || answer.reason;
    const retryable = !answer.ready && !explained && answer.retryable;
    queryStates.set(key, { ready, reason, isHandler, retryable });
    if (answer.ready && !answer.rows.length) { stats.resolvedEmpty++; stats.emptyAt.push({ file, pos }); }
    const dt = clock.now() - t;
    stats.incomingMs += dt;
    stats.durations.push(dt);
    if (!stats.slowest || dt > stats.slowest.ms) stats.slowest = { ms: dt, file, pos };
    if (dt > 3000) trace(`slow query ${dt}ms  ${file}@${pos}`);
    if (!ready) {
      stats.skipped++;
      if (reason) stats.lastReason = reason;
      return { callers: [], complete: false, reason: reason || 'caller query did not complete', ...(retryable ? { retryable: true } : {}) };
    }
    let out = callerRows(answer.rows, withTests);
    if (extras && out.length) {
      // `kept` replaces the list even when nothing was dropped: a kept caller can be a copy
      // with fewer call sites (Go keeps only a caller's calls, not its value uses).
      const { kept, dropped } = extras.filter(out);
      // What a language's filter drops: TypeScript's inherited-member over-reports, Go's
      // callers that only use the function as a value.
      stats[languageExtras ? languageExtras.droppedStat : 'inheritedDropped'] += dropped;
      // A copy: `kept` may be `out` itself (a filter that keeps everything returns its
      // input), and `out` is added to below.
      out = kept.slice();
    }
    let extraFailure = null;
    if (extras && extras.moreCallers) {
      const more = await extras.moreCallers();
      extraFailure = more.incompleteReason;
      if (startedGeneration !== generation) return staleAnswer();
      stats.cqrsEdges += more.callers.length;
      const have = new Set(out.map((c) => `${c.file}#${c.pos}`));
      for (const e of more.callers) {
        if (have.has(`${e.file}#${e.pos}`)) continue;
        if (!withTests && e.test) continue;
        out.push(e);
      }
    }
    if (extraFailure) return { callers: out, complete: false, reason: extraFailure };
    cache.set(key, out);
    return { callers: out, complete: true };
  }

  /** @returns {Promise<string|null>} The reason the answer is unknown, or null. */
  async function unseenUsers(file, pos) {
    const extras = extrasFor(file);
    const reason = extras ? await extras.unseenUsers(file, pos) : null;
    if (reason) stats.unseenUsers++;
    return reason;
  }

  async function incoming(file, pos, withTests = true) {
    return (await incomingWithStatus(file, pos, withTests)).callers;
  }

  return {
    kind: 'vscode-callhierarchy',
    services,
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
          if (status.isHandler && !isConstructor) return { state: 'unknown', reason: extrasFor(file)?.suppressedReason || 'caller query not asked', callers: [], complete: false };
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
      for (const extras of extrasByLanguage.values()) extras.clear();
      for (const key of Object.keys(stats)) delete stats[key];
      Object.assign(stats, initialStats());
    },
  };
}
module.exports = { createVscodeResolver };
