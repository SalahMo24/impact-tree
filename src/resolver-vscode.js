'use strict';
const vscode = require('vscode');
const { isTestFile } = require('./engine/diff');
const { offsetToPosition, positionToOffset } = require('./engine/textpos');
const { makeCqrsEdges } = require('./engine/edges-cqrs');
const { createInheritanceFilter } = require('./engine/inheritance');
const { withDeadline } = require('./engine/deadline');

// Reuses the editor's already-running language server: no second program, incremental
// for free, and any language with a call-hierarchy provider works, not just TypeScript.
//
// Deliberately never calls vscode.workspace.openTextDocument. Doing so forces the
// editor to sync the document to the extension host, which Cursor rejects for many
// files ("Documents above the size limit cannot be synchronized with extensions") and
// which costs a round trip per caller. Offsets are converted from disk instead.
function createVscodeResolver({ retries = 4, retryDelayMs = 250, queryTimeoutMs = 5000, ts = null, trace = () => {}, filterInherited = true, repoRoot = null } = {}) {
  // Five seconds per provider command admits ordinary warm queries (median 384 ms
  // in the live review) but stops a 27–92 s server stall from gating caller results.
  // The provider keeps running; only this bounded wait ends. Timed-out answers are
  // incomplete and never cached. Warm-up has its own total elapsed-time budget.
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 120000) throw new RangeError('query timeout must be 1..120000 ms');
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
  let serverWarm = false;
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
    inheritedDropped: 0,
  });
  const stats = initialStats();

  // The call hierarchy reports sibling-subclass dispatch as an incoming call to an
  // override. Filtering needs only syntax, so it costs a parse of the caller file.
  const inherited = filterInherited ? createInheritanceFilter(ts, { trace }) : null;

  // Same CQRS logic as the CLI, but definition/reference come from the editor's server
  // instead of our own program.
  const cqrs = ts && makeCqrsEdges(ts, {
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
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function query(file, pos) {
    const p = offsetToPosition(file, pos);
    if (!p) return { ready: false, calls: [], reason: 'unreadable' };
    const uri = vscode.Uri.file(file);
    const position = new vscode.Position(p.line, p.character);
    const maxAttempts = serverWarm ? 1 : retries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let items;
      try {
        items = await command('vscode.prepareCallHierarchy', uri, position);
      } catch (e) {
        return { ready: false, calls: [], reason: e && e.message };
      }
      if (items && items.length) {
        serverWarm = true;
        try {
          const calls = await command('vscode.provideIncomingCalls', items[0]);
          if (!Array.isArray(calls)) return { ready: false, calls: [], reason: 'no incoming-call result' };
          return { ready: true, calls, empty: calls.length === 0 };
        } catch (e) {
          return { ready: false, calls: [], reason: e && e.message };
        }
      }
      if (serverWarm) break;           // no hierarchy item for this symbol
      stats.warmupRetries++;
      if (attempt < maxAttempts - 1) await sleep(retryDelayMs * (attempt + 1));
    }
    // Without a hierarchy item, provider support for this symbol is unproven.
    if (serverWarm) return { ready: false, calls: [], reason: 'no call hierarchy item' };
    return { ready: false, calls: [], reason: 'language server not ready' };
  }

  // The first query pays for the language server loading the whole project (tens of
  // seconds on a large one). Concurrent queries all block behind it and each reports the
  // full wait. Warming up explicitly means that cost is paid once, ideally before the
  // user asks for anything.
  async function warmUp(file, pos, { timeoutMs = 15000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new RangeError('warm-up timeout must be 1..120000 ms');
    if (serverWarm) return true;
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
      const p2 = offsetToPosition(file, pos);
      if (!p2) return false;
      try {
        const remaining = timeoutMs - (Date.now() - started);
        const items = await withDeadline(() => requestProvider('vscode.prepareCallHierarchy',
          vscode.Uri.file(file), new vscode.Position(p2.line, p2.character)), remaining, 'language-server warm-up');
        if (items && items.length) {
          serverWarm = true;
          stats.warmUpMs = Date.now() - started;
          trace(`language server warm after ${stats.warmUpMs}ms`);
          return true;
        }
      } catch { /* server still starting */ }
      attempt++;
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining > 0) await sleep(Math.min(250 * attempt, 2000, remaining));
    }
    trace(`language server did not warm within ${timeoutMs}ms`);
    return false;
  }

  // `complete: false` means the query did not finish, so `callers` may be missing some or
  // all of them. Only complete answers are cached, so asking again can still succeed.
  /** @returns {Promise<import('./engine/caller-contract').CallerAnswer>} */
  async function incomingWithStatus(file, pos, withTests = true) {
    const startedGeneration = generation;
    const key = `${withTests ? 'A' : 'P'}${file}#${pos}`;
    if (cache.has(key)) { stats.cacheHits++; return { callers: cache.get(key), complete: true }; }
    const t = Date.now();
    stats.incomingCalls++;
    // a handler's execute() resolves through ICommandHandler.execute, so the call
    // hierarchy returns every bus.execute() site; none of them reach this handler
    const isHandler = !!(cqrs && cqrs.isHandlerExecute(file, pos));
    if (isHandler) stats.cqrsSuppressed++;
    const { ready, calls, reason, empty } = isHandler ? { ready: true, calls: [] } : await query(file, pos);
    if (startedGeneration !== generation) return staleAnswer();
    queryStates.set(key, { ready, reason, isHandler });
    if (ready && empty) { stats.resolvedEmpty++; stats.emptyAt.push({ file, pos }); }
    const dt = Date.now() - t;
    stats.incomingMs += dt;
    stats.durations.push(dt);
    if (!stats.slowest || dt > stats.slowest.ms) stats.slowest = { ms: dt, file, pos };
    if (dt > 3000) trace(`slow query ${dt}ms  ${file}@${pos}`);
    if (!ready) {
      stats.skipped++;
      if (reason) stats.lastReason = reason;
      return { callers: [], complete: false, reason: reason || 'caller query did not complete' };
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
    if (cqrs) {
      let extra = [];
      try { extra = await cqrs.extraCallers(file, pos); } catch (e) { cqrsFailure = (e && e.message) || 'lookup failed'; }
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

  async function incoming(file, pos, withTests = true) {
    return (await incomingWithStatus(file, pos, withTests)).callers;
  }

  return {
    kind: 'vscode-callhierarchy',
    incoming,
    incomingWithStatus,
    warmUp,
    isWarm: () => serverWarm,
    /** @returns {Promise<import('./engine/caller-contract').CallerState>} */
    async callerState(file, pos, { isConstructor = false } = {}) {
      const { callers, ...coverage } = await incomingWithStatus(file, pos);
      if (callers.length) return { state: 'resolved', callers, ...coverage };
      if (!coverage.complete) return { state: 'unknown', callers: [], ...coverage };
      const status = queryStates.get(`A${file}#${pos}`);
      if (!status?.ready) return { state: 'unknown', reason: status?.reason || 'caller query did not complete', callers: [], complete: false };
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
        return used
          ? { state: 'unknown', reason: 'referenced-as-value', callers: [], complete: false }
          : { state: 'none', callers: [], complete: true };
      } catch (e) {
        return { state: 'unknown', reason: (e && e.message) || 'reference query failed', callers: [], complete: false };
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
      cache.clear();
      queryStates.clear();
      inherited?.clear();
      for (const key of Object.keys(stats)) delete stats[key];
      Object.assign(stats, initialStats());
    },
  };
}
module.exports = { createVscodeResolver };
