'use strict';
const { score } = require('./signature');

// Pending coverage never looks like a successful search with no callers. These fields
// are also the initial values consumed by scoring, the tree and review identity.
function initialisePending(changed) {
  for (const c of changed) {
    Object.assign(c, {
      callerState: 'unknown', callersComplete: false,
      callersIncompleteReason: 'caller analysis is still running', callers: [],
      stale: [], staleCallers: 0, staleChangedElsewhere: 0,
      tests: [], testState: 'not-computed', testReachIncompleteReason: null,
    });
    c.score = score(c);
  }
}

// An early result and the final result must not share mutable symbol/caller rows. Maps
// of pinned source text can be shared; they are never changed by caller resolution.
function snapshot(result) {
  const changed = new Map(result.allChanged.map(c => [c, { ...c }]));
  const copy = {
    ...result, warnings: result.warnings.slice(),
    allChanged: result.allChanged.map(c => changed.get(c)),
    findings: result.findings.map(c => changed.get(c)),
    unknownCallers: result.unknownCallers.map(c => changed.get(c)),
    components: result.components.map(c => ({ ...c,
      changed: c.changed.map(r => changed.get(r)), roots: c.roots.map(r => changed.get(r)),
    })),
  };
  return copy;
}

module.exports = { initialisePending, snapshot };
