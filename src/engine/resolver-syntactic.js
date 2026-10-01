'use strict';
// Resolver interface over the syntax-only index, so Tier A plugs into the same tree,
// the same lazy expansion and the same caller-state logic as the language-server
// resolvers. No language server, no program, no disk.
//
// Its answers are bounded by the file set it was built from. A symbol with no callers
// in the PR reports `unknown`, never `resolved with zero callers` -- the difference
// matters, because "nothing calls this" and "nothing in the PR calls this" lead a
// reviewer to opposite conclusions.

function createSyntacticResolver(idx, { isTestPath = () => false, hints = new Map() } = {}) {
  const cache = new Map();
  const stats = { incomingCalls: 0, cacheHits: 0, resolvedEmpty: 0, unknownTarget: 0 };

  async function incoming(file, pos, withTests = true) {
    const key = `${withTests ? 'A' : 'P'}${file}#${pos}`;
    if (cache.has(key)) { stats.cacheHits++; return cache.get(key); }
    stats.incomingCalls++;

    // Changed-symbol positions come from the symbol collector, whose anchor for a
    // constructor (and some arrow forms) is not the one the index records. Trusting
    // the index alone silently skipped caller resolution for those symbols entirely.
    const sym = hints.get(`${file}#${pos}`) || idx.symbolAt(file, pos);
    if (!sym) { stats.unknownTarget++; return []; }      // not cached: may resolve later

    const rows = idx.callersOf({ file, className: sym.className, name: sym.name, pos })
      .map((c) => ({
        label: c.label,
        file: c.file,
        pos: c.pos,
        test: isTestPath(c.file),
        sites: (c.callSites || []).length,
        callSites: c.callSites || [],
        via: c.via,
      }))
      .filter((c) => withTests || !c.test);

    if (!rows.length) stats.resolvedEmpty++;
    cache.set(key, rows);
    return rows;
  }

  return {
    kind: 'syntactic-pr-files',
    incoming,
    async callerState(file, pos, { isConstructor = false } = {}) {
      const callers = await incoming(file, pos);
      if (callers.length) return { state: 'resolved', callers };
      // Outside a checkout we cannot distinguish "nothing calls this" from "the
      // caller is in a file the PR does not touch", so never claim the former.
      return { state: isConstructor ? 'di' : 'unknown', callers: [] };
    },
    stats: () => ({ ...stats, indexedFiles: idx.size }),
    invalidate() { cache.clear(); },
    clear() { cache.clear(); },
    dispose() { cache.clear(); },
  };
}

module.exports = { createSyntacticResolver };
