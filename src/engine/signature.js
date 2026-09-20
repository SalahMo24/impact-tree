'use strict';

// Severity is ranked by damage x invisibility to the compiler. Anything tsc already
// rejects needs less human attention than something that compiles and misbehaves.
// Grounded in measurement, not taste: adding an optional parameter that callers then
// silently omit caused a real defect, while a structurally-compatible type narrowing
// with many callers was noise -- so the former outranks the latter.
const KIND = {
  NEW_THROW:      { id: 'new-throw',      weight: 80, label: 'new throw path', short: 'new throw' },
  OPTIONAL_PARAM: { id: 'optional-param', weight: 70, label: 'optional parameter added', short: '+optional param' },
  PARAM_REMOVED:  { id: 'param-removed',  weight: 55, label: 'parameter removed', short: '-param' },
  TYPE_CHANGED:   { id: 'type-changed',   weight: 30, label: 'parameter type changed', short: 'param type' },
  REQUIRED_PARAM: { id: 'required-param', weight: 25, label: 'required parameter changed (tsc catches this)', short: 'required param' },
  RETURN_CHANGED: { id: 'return-changed', weight: 20, label: 'return type changed', short: 'return type' },
  ASYNC_CHANGED:  { id: 'async-changed',  weight: 45, label: 'async-ness changed', short: 'async' },
  BODY:           { id: 'body',           weight: 10, label: 'body only', short: 'body' },
};

function diffSignature(baseSym, headSym) {
  const changes = [];
  if (!baseSym) return changes;
  const b = baseSym.sig, h = headSym.sig;
  if (b.async !== h.async) changes.push(KIND.ASYNC_CHANGED);
  const bp = b.params, hp = h.params;
  if (hp.length > bp.length) {
    const added = hp.slice(bp.length);
    changes.push(added.every((p) => p.optional || p.rest) ? KIND.OPTIONAL_PARAM : KIND.REQUIRED_PARAM);
  } else if (hp.length < bp.length) {
    changes.push(KIND.PARAM_REMOVED);
  }
  for (let i = 0; i < Math.min(bp.length, hp.length); i++) {
    if (bp[i].type !== hp[i].type) { changes.push(KIND.TYPE_CHANGED); break; }
  }
  for (let i = 0; i < Math.min(bp.length, hp.length); i++) {
    if (bp[i].optional !== hp[i].optional) { changes.push(KIND.REQUIRED_PARAM); break; }
  }
  if ((b.returns || null) !== (h.returns || null)) changes.push(KIND.RETURN_CHANGED);
  return changes;
}

function newThrows(baseSym, headSym) {
  if (!baseSym) return [];
  return [...headSym.throws].filter((t) => !baseSym.throws.has(t));
}

// Stale-caller count is capped so a benign change with many callers cannot outrank a
// dangerous one with few. 16 type-narrowed callers must stay below 8 new-throw callers.
function score(finding) {
  const base = Math.max(0, ...finding.kinds.map((k) => k.weight), KIND.BODY.weight);
  return base + Math.min(finding.staleCallers || 0, 10) * 2;
}

module.exports = { KIND, diffSignature, newThrows, score };
