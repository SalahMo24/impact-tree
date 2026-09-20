'use strict';
const vscode = require('vscode');
const { isTestPath } = require('./engine/diff');
const { offsetToPosition, positionToOffset } = require('./engine/textpos');
const { makeCqrsEdges } = require('./engine/edges-cqrs');

// Reuses the editor's already-running language server: no second program, incremental
// for free, and any language with a call-hierarchy provider works, not just TypeScript.
//
// Deliberately never calls vscode.workspace.openTextDocument. Doing so forces the
// editor to sync the document to the extension host, which Cursor rejects for many
// files ("Documents above the size limit cannot be synchronized with extensions") and
// which costs a round trip per caller. Offsets are converted from disk instead.
function createVscodeResolver({ retries = 4, retryDelayMs = 250, ts = null, trace = () => {} } = {}) {
  // Retrying is only meaningful until the language server has proven it is up. Once ANY
  // query has succeeded, an empty result means "no callers", not "not ready" -- and the
  // backoff was costing 6s per unresolvable symbol (24s of a 50s run on 4 symbols).
  let serverWarm = false;
  const cache = new Map();
  // incomingMs sums concurrent durations, so it exceeds wall time once queries overlap.
  // Keep it for cost, but record the distribution and let the caller time the phase.
  const stats = {
    incomingCalls: 0, incomingMs: 0, cacheHits: 0, warmupRetries: 0,
    skipped: 0, resolvedEmpty: 0, cqrsEdges: 0, cqrsSuppressed: 0, durations: [], emptyAt: [],
  };

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
        locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',
          vscode.Uri.file(file), new vscode.Position(p2.line, p2.character)) || [];
      } catch { return null; }
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
          locs = await vscode.commands.executeCommand('vscode.executeReferenceProvider',
            vscode.Uri.file(file), new vscode.Position(p2.line, p2.character)) || [];
        } catch { locs = []; }
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
        items = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, position);
      } catch (e) {
        return { ready: false, calls: [], reason: e && e.message };
      }
      if (items && items.length) {
        serverWarm = true;
        try {
          const calls = await vscode.commands.executeCommand('vscode.provideIncomingCalls', items[0]);
          return { ready: true, calls: calls || [] };
        } catch (e) {
          return { ready: false, calls: [], reason: e && e.message };
        }
      }
      if (serverWarm) break;           // genuinely has no callers
      stats.warmupRetries++;
      if (attempt < maxAttempts - 1) await sleep(retryDelayMs * (attempt + 1));
    }
    // once warm, an empty answer is a real answer -- but flag it so "genuinely no
    // callers" stays distinguishable from "the server told us nothing"
    if (serverWarm) return { ready: true, calls: [], empty: true };
    return { ready: false, calls: [], reason: 'language server not ready' };
  }

  // The first query pays for the language server loading the whole project (~19s on
  // components/consumer). Concurrent queries all block behind it and each reports the
  // full wait. Warming up explicitly means that cost is paid once, ideally before the
  // user asks for anything.
  async function warmUp(file, pos, { timeoutMs = 120000 } = {}) {
    if (serverWarm) return true;
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
      const p2 = offsetToPosition(file, pos);
      if (!p2) return false;
      try {
        const items = await vscode.commands.executeCommand('vscode.prepareCallHierarchy',
          vscode.Uri.file(file), new vscode.Position(p2.line, p2.character));
        if (items && items.length) {
          serverWarm = true;
          stats.warmUpMs = Date.now() - started;
          trace(`language server warm after ${stats.warmUpMs}ms`);
          return true;
        }
      } catch { /* server still starting */ }
      attempt++;
      await sleep(Math.min(250 * attempt, 2000));
    }
    trace(`language server did not warm within ${timeoutMs}ms`);
    return false;
  }

  async function incoming(file, pos, withTests = true) {
    const key = `${withTests ? 'A' : 'P'}${file}#${pos}`;
    if (cache.has(key)) { stats.cacheHits++; return cache.get(key); }
    const t = Date.now();
    stats.incomingCalls++;
    // a handler's execute() resolves through ICommandHandler.execute, so the call
    // hierarchy returns every bus.execute() site; none of them reach this handler
    const isHandler = !!(cqrs && cqrs.isHandlerExecute(file, pos));
    if (isHandler) stats.cqrsSuppressed++;
    const { ready, calls, reason, empty } = isHandler ? { ready: true, calls: [] } : await query(file, pos);
    if (ready && empty) { stats.resolvedEmpty++; stats.emptyAt.push({ file, pos }); }
    const dt = Date.now() - t;
    stats.incomingMs += dt;
    stats.durations.push(dt);
    if (!stats.slowest || dt > stats.slowest.ms) stats.slowest = { ms: dt, file, pos };
    if (dt > 3000) trace(`slow query ${dt}ms  ${file}@${pos}`);
    if (!ready) { stats.skipped++; if (reason) stats.lastReason = reason; return []; } // not cached
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
    if (cqrs) {
      let extra = [];
      try { extra = await cqrs.extraCallers(file, pos); } catch { extra = []; }
      stats.cqrsEdges += extra.length;
      const have = new Set(out.map((c) => `${c.file}#${c.pos}`));
      for (const e of extra) {
        if (have.has(`${e.file}#${e.pos}`)) continue;
        if (!withTests && e.test) continue;
        out.push(e);
      }
    }
    cache.set(key, out);
    return out;
  }

  return {
    kind: 'vscode-callhierarchy',
    incoming,
    warmUp,
    isWarm: () => serverWarm,
    async callerState(file, pos, { isConstructor = false } = {}) {
      const callers = await incoming(file, pos);
      if (callers.length) return { state: 'resolved', callers };
      return { state: isConstructor ? 'di' : 'unknown', callers: [] };
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
    invalidate(file) { for (const k of [...cache.keys()]) if (k.includes(file)) cache.delete(k); },
    clear() { cache.clear(); },
  };
}
module.exports = { createVscodeResolver };
