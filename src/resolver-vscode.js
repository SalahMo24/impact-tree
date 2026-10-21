'use strict';
const vscode = require('vscode');
const { isTestFile } = require('./engine/diff');
const { offsetToPosition, positionToOffset } = require('./engine/textpos');
const { makeCqrsEdges } = require('./engine/edges-cqrs');
const { createInheritanceFilter } = require('./engine/inheritance');
const { withDeadline } = require('./engine/deadline');
const { findUnseenUsers, unseenUsersReason, gitGrep } = require('./engine/unseen-users');
const { makeGit } = require('./engine/git');

// Reuses the editor's already-running language server: no second program, incremental
// for free, and any language with a call-hierarchy provider works, not just TypeScript.
//
// Deliberately never calls vscode.workspace.openTextDocument. Doing so forces the
// editor to sync the document to the extension host, which Cursor rejects for many
// files ("Documents above the size limit cannot be synchronized with extensions") and
// which costs a round trip per caller. Offsets are converted from disk instead.
function createVscodeResolver({
  retries = 4, retryDelayMs = 250, queryTimeoutMs = 5000, coldQueryTimeoutMs = 60000, coldBudgetMs = 120000,
  ts = null, trace = () => {}, filterInherited = true, repoRoot = null,
} = {}) {
  // Five seconds per provider command admits ordinary warm queries (median 384 ms
  // in the live review) but stops a 27–92 s server stall from gating caller results.
  // The provider keeps running; only this bounded wait ends. Timed-out answers are
  // incomplete and never cached. Warm-up has its own total elapsed-time budget.
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 120000) throw new RangeError('query timeout must be 1..120000 ms');
  // While the server is still loading its projects (after the window opens or a checkout),
  // every query waits behind that load; eight parallel queries at five seconds each all
  // time out. Until one caller query has answered (`callersReady`), queries go one at a
  // time, each allowed `coldQueryTimeoutMs`. The whole cold phase of an analysis is
  // bounded by `coldBudgetMs`; past it queries run in parallel at `queryTimeoutMs` again,
  // and what times out is marked retryable (the session retries it once the server is up).
  if (!Number.isSafeInteger(coldQueryTimeoutMs) || coldQueryTimeoutMs < 1 || coldQueryTimeoutMs > 120000) throw new RangeError('cold query timeout must be 1..120000 ms');
  if (!Number.isSafeInteger(coldBudgetMs) || coldBudgetMs < 0 || coldBudgetMs > 600000) throw new RangeError('cold budget must be 0..600000 ms');
  // A timed-out command still consumes a real provider request. Keep at most 32
  // outstanding requests (the maximum analysis concurrency), across generations,
  // until the underlying promises settle. Later queries report incomplete coverage
  // rather than accumulate an unbounded queue behind a stalled language server.
  let providerRequests = 0;
  const requestProvider = async (name, ...args) => {
    if (providerRequests >= 32) throw new Error('language server has 32 outstanding requests — retry when it responds');
    providerRequests++;
    try { return await vscode.commands.executeCommand(name, ...args); }
    finally { providerRequests--; }
  };
  const command = (name, ...args) => withDeadline(() => requestProvider(name, ...args), queryTimeoutMs, name);
  // Retrying is only meaningful until the language server has proven it is up. Once ANY
  // query has succeeded, retrying unsupported symbols no longer helps. Preserve
  // their unknown state without paying the startup backoff on every query.
  // `serverWarm`: the server answered a prepareCallHierarchy with an item, which needs only
  // the one file. `callersReady`: it answered an incoming-calls query, which needs the
  // file's project loaded; only that makes the server ready for caller queries.
  let serverWarm = false;
  let callersReady = false;
  // The cold phase (see coldQueryTimeoutMs). Owner: this resolver. `coldTurn` is the end
  // of the queue of cold queries; each waits for the one before it. `coldSpentMs` is the
  // time cold queries took in this analysis; clear() resets it.
  let coldTurn = Promise.resolve();
  let coldSpentMs = 0;
  const coldPhase = () => !callersReady && coldSpentMs < coldBudgetMs;
  /** A failure that a later query, with the server up, may not repeat. */
  const isRetryable = (e) => !!e && /timed out|outstanding requests/.test(String(e.message || ''));
  const notAnswered = (e) => ({ ready: false, calls: [], reason: e && e.message, ...(isRetryable(e) ? { retryable: true } : {}) });
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
  // incomingMs sums concurrent durations, so it exceeds wall time once queries overlap.
  // Keep it for cost, but record the distribution and let the caller time the phase.
  const initialStats = () => ({
    incomingCalls: 0, incomingMs: 0, cacheHits: 0, warmupRetries: 0,
    skipped: 0, resolvedEmpty: 0, cqrsEdges: 0, cqrsSuppressed: 0, durations: [], emptyAt: [],
    inheritedDropped: 0, unseenUsers: 0,
  });
  const stats = initialStats();

  // The call hierarchy reports sibling-subclass dispatch as an incoming call to an
  // override. Filtering needs only syntax, so it costs a parse of the caller file.
  const inherited = filterInherited ? createInheritanceFilter(ts, { trace }) : null;

  // Same CQRS logic as the CLI, but definition/reference come from the editor's server
  // instead of our own program.
  const cqrsProviders = {
    isTestPath,
    trace,
    async definitionAt(file, offset) {
      const p2 = offsetToPosition(file, offset);
      if (!p2) return null;
      let locs = [];
      try {
        locs = await command('vscode.executeDefinitionProvider',
          vscode.Uri.file(file), new vscode.Position(p2.line, p2.character)) || [];
      } catch (e) { throw new Error(`definition lookup failed: ${e.message}`); }
      const l = locs[0];
      if (!l) return null;
      const uri = l.uri || l.targetUri;
      const range = l.range || l.targetSelectionRange || l.targetRange;
      if (!uri || !range) return null;
      const off = positionToOffset(uri.fsPath, range.start.line, range.start.character);
      return off == null ? null : { file: uri.fsPath, offset: off };
    },
    async referencesTo(file, offset) {
      const p2 = offsetToPosition(file, offset);
      if (!p2) return [];
      // An empty reference list before the project is loaded is indistinguishable from
      // "no references", and silently becomes "this handler has no callers". Retry
      // until the server is warm, then trust the answer.
      let locs = [];
      for (let attempt = 0; attempt < (serverWarm ? 1 : 5); attempt++) {
        try {
          locs = await command('vscode.executeReferenceProvider',
            vscode.Uri.file(file), new vscode.Position(p2.line, p2.character)) || [];
        } catch (e) { throw new Error(`reference lookup failed: ${e.message}`); }
        if (locs.length) { serverWarm = true; break; }
        if (serverWarm) break;
        stats.warmupRetries++;
        await sleep(250 * (attempt + 1));
      }
      if (!locs.length) trace(`references: none for ${require('path').basename(file)}@${offset}${serverWarm ? '' : ' (server never warmed)'}`);
      const out = [];
      for (const l of locs) {
        const off = positionToOffset(l.uri.fsPath, l.range.start.line, l.range.start.character);
        if (off != null) out.push({ file: l.uri.fsPath, offset: off });
      }
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

  /** The queried position, or null when the file cannot be read. */
  function positionOf(file, pos) {
    const p = offsetToPosition(file, pos);
    return p ? { uri: vscode.Uri.file(file), position: new vscode.Position(p.line, p.character) } : null;
  }

  /** Incoming calls of a prepared item; a completed answer proves the project is loaded. */
  async function incomingCallsOf(item, timeoutMs) {
    try {
      const calls = await withDeadline(() => requestProvider('vscode.provideIncomingCalls', item), timeoutMs, 'vscode.provideIncomingCalls');
      if (!Array.isArray(calls)) return { ready: false, calls: [], reason: 'no incoming-call result' };
      callersReady = true;
      return { ready: true, calls, empty: calls.length === 0 };
    } catch (e) {
      return notAnswered(e);
    }
  }

  // A query once the server answers caller queries: each command gets queryTimeoutMs.
  async function warmQuery(file, pos) {
    const at = positionOf(file, pos);
    if (!at) return { ready: false, calls: [], reason: 'unreadable' };
    const maxAttempts = serverWarm ? 1 : retries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let items;
      try {
        items = await command('vscode.prepareCallHierarchy', at.uri, at.position);
      } catch (e) {
        return notAnswered(e);
      }
      if (items && items.length) {
        serverWarm = true;
        return incomingCallsOf(items[0], queryTimeoutMs);
      }
      if (serverWarm) break;           // no hierarchy item for this symbol
      stats.warmupRetries++;
      if (attempt < maxAttempts - 1) await sleep(retryDelayMs * (attempt + 1));
    }
    // Without a hierarchy item, provider support for this symbol is unproven.
    if (serverWarm) return { ready: false, calls: [], reason: 'no call hierarchy item' };
    return { ready: false, calls: [], reason: 'language server not ready', retryable: true };
  }

  // A query while the server is loading: one deadline for the whole query, polling until
  // the file has a hierarchy item (a server that is not up answers none).
  async function coldQuery(file, pos, budgetMs) {
    const at = positionOf(file, pos);
    if (!at) return { ready: false, calls: [], reason: 'unreadable' };
    const started = Date.now();
    const left = () => budgetMs - (Date.now() - started);
    for (let attempt = 1; left() > 0; attempt++) {
      let items;
      try {
        items = await withDeadline(() => requestProvider('vscode.prepareCallHierarchy', at.uri, at.position), left(), 'vscode.prepareCallHierarchy');
      } catch (e) {
        return notAnswered(e);
      }
      if (items && items.length) {
        serverWarm = true;
        return incomingCallsOf(items[0], Math.max(1, left()));
      }
      if (serverWarm) return { ready: false, calls: [], reason: 'no call hierarchy item' };
      stats.warmupRetries++;
      await sleep(Math.max(0, Math.min(250 * attempt, 2000, left())));
    }
    return { ready: false, calls: [], reason: `language server not ready after ${Math.round(budgetMs / 1000)} s`, retryable: true };
  }

  async function query(file, pos) {
    if (!coldPhase()) return warmQuery(file, pos);
    const startedGeneration = generation;
    let release = () => {};
    const turn = new Promise((resolve) => { release = resolve; });
    const before = coldTurn;
    coldTurn = turn;
    try {
      await before;
      // Cleared while waiting: the answer would be dropped, so ask nothing.
      if (startedGeneration !== generation) return { ready: false, calls: [], reason: 'caller query belongs to an earlier analysis' };
      // The server came up while this query waited: let the next one go at once.
      if (!coldPhase()) { release(); return warmQuery(file, pos); }
      const t = Date.now();
      try {
        return await coldQuery(file, pos, Math.min(coldQueryTimeoutMs, coldBudgetMs - coldSpentMs));
      } finally {
        coldSpentMs += Date.now() - t;
        if (callersReady) trace(`language server answered caller queries after ${coldSpentMs}ms of cold queries`);
      }
    } finally {
      release();
    }
  }

  // The first query pays for the language server loading the whole project (tens of
  // seconds on a large one). Concurrent queries all block behind it and each reports the
  // full wait. Warming up explicitly means that cost is paid once, ideally before the
  // user asks for anything. Warm means a caller query answered (`callersReady`), not only
  // a hierarchy item: an item needs one parsed file, the callers need the project.
  async function warmUp(file, pos, { timeoutMs = 15000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new RangeError('warm-up timeout must be 1..120000 ms');
    if (callersReady) return true;
    const started = Date.now();
    const left = () => timeoutMs - (Date.now() - started);
    let attempt = 0;
    while (left() > 0) {
      const at = positionOf(file, pos);
      if (!at) return false;
      try {
        const items = await withDeadline(() => requestProvider('vscode.prepareCallHierarchy', at.uri, at.position), left(), 'language-server warm-up');
        if (items && items.length && left() > 0) {
          serverWarm = true;
          await withDeadline(() => requestProvider('vscode.provideIncomingCalls', items[0]), left(), 'language-server warm-up');
          callersReady = true;
          stats.warmUpMs = Date.now() - started;
          trace(`language server warm after ${stats.warmUpMs}ms`);
          return true;
        }
      } catch { /* server still starting */ }
      attempt++;
      if (left() > 0) await sleep(Math.min(250 * attempt, 2000, left()));
    }
    trace(`language server did not warm within ${timeoutMs}ms`);
    return false;
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
    const { ready, calls, reason, empty, retryable } = isHandler ? { ready: true, calls: [], retryable: false } : await query(file, pos);
    if (startedGeneration !== generation) return staleAnswer();
    queryStates.set(key, { ready, reason, isHandler, retryable: retryable === true });
    if (ready && empty) { stats.resolvedEmpty++; stats.emptyAt.push({ file, pos }); }
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
    const out = [];
    const seen = new Set();
    for (const c of calls) {
      const f = c.from.uri.fsPath;
      const start = c.from.selectionRange.start;
      const offset = positionToOffset(f, start.line, start.character);
      if (offset == null) continue;
      const id = `${f}#${offset}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const test = isTestPath(f);
      if (!withTests && test) continue;
      const callSites = (c.fromRanges || []).map((r) => ({
        start: positionToOffset(f, r.start.line, r.start.character),
        end: positionToOffset(f, r.end.line, r.end.character),
      })).filter((x) => x.start != null);
      out.push({
        label: c.from.detail ? `${c.from.detail}.${c.from.name}` : c.from.name,
        file: f, pos: offset, test, sites: callSites.length, callSites,
      });
    }
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
    isWarm: () => callersReady,
    /**
     * The server is about to reload its projects (the worktree moved under it, as a
     * checkout does): treat it as cold until a caller query answers again.
     */
    expectReload() {
      serverWarm = false;
      callersReady = false;
      coldSpentMs = 0;
    },
    /** @returns {Promise<import('./engine/caller-contract').CallerState>} */
    async callerState(file, pos, { isConstructor = false } = {}) {
      const { callers, ...coverage } = await incomingWithStatus(file, pos);
      if (callers.length) return { state: 'resolved', callers, ...coverage };
      if (!coverage.complete) return { state: 'unknown', callers: [], ...coverage };
      const status = queryStates.get(`A${file}#${pos}`);
      if (!status?.ready) {
        return { state: 'unknown', reason: status?.reason || 'caller query did not complete', callers: [], complete: false, ...(status?.retryable ? { retryable: true } : {}) };
      }
      if (isConstructor) return { state: 'di', callers: [], complete: true };
      if (status.isHandler) return { state: 'unknown', reason: 'command-bus handler', callers: [], complete: false };
      // Empty call hierarchies also occur for value-passed callbacks. Only report
      // none after a successful reference query with no use outside the declaration.
      const p = offsetToPosition(file, pos);
      try {
        const refs = await command('vscode.executeReferenceProvider',
          vscode.Uri.file(file), new vscode.Position(p.line, p.character));
        if (!Array.isArray(refs)) return { state: 'unknown', reason: 'no reference result', callers: [], complete: false };
        const used = refs.some(r => {
          if (r.uri.fsPath !== file) return true;
          const start = positionToOffset(file, r.range.start.line, r.range.start.character);
          const end = positionToOffset(file, r.range.end.line, r.range.end.character);
          return start == null || end == null || !(start <= pos && pos < end);
        });
        if (used) return { state: 'unknown', reason: 'referenced-as-value', callers: [], complete: false };
        const unseen = await unseenUsers(file, pos);
        return unseen
          ? { state: 'unknown', reason: unseen, callers: [], complete: false }
          : { state: 'none', callers: [], complete: true };
      } catch (e) {
        return { state: 'unknown', reason: (e && e.message) || 'reference query failed', callers: [], complete: false, ...(isRetryable(e) ? { retryable: true } : {}) };
      }
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
      coldSpentMs = 0;
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
