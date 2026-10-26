'use strict';

// Severity is ranked by damage x invisibility to the compiler. Anything the compiler (or, in
// Python, the call itself) already rejects loudly needs less human attention than something
// that runs and misbehaves.
// Grounded in measurement, not taste: adding an optional parameter that callers then
// silently omit caused a real defect, while a structurally-compatible type narrowing
// with many callers was noise -- so the former outranks the latter.
const KIND = {
  NEW_THROW:      { id: 'new-throw',      weight: 80, label: 'new throw path', short: 'new throw' },
  OPTIONAL_PARAM: { id: 'optional-param', weight: 70, label: 'optional parameter added', short: '+optional param' },
  OPTIONAL_CHANGED: { id: 'optional-param-changed', weight: 70, label: 'parameter made optional', short: 'param optional' },
  PARAM_REMOVED:  { id: 'param-removed',  weight: 55, label: 'parameter removed', short: '-param' },
  TYPE_CHANGED:   { id: 'type-changed',   weight: 30, label: 'parameter type changed', short: 'param type' },
  REQUIRED_PARAM: { id: 'required-param', weight: 25, label: 'required parameter changed (old calls fail loudly)', short: 'required param' },
  // Java (J-D4): visibility reduced or `static` added/removed. Callers that lose access, or
  // call through an instance versus the class, stop compiling: as loud as a required param.
  ACCESS_CHANGED: { id: 'access-changed', weight: 25, label: 'access changed (old calls fail loudly)', short: 'access' },
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
  // Align by name where possible, allowing a rename as a substitution. Comparing
  // raw positions mistakes inserted parameters for changes to every following one.
  const cost = Array.from({ length: bp.length + 1 }, () => Array(hp.length + 1).fill(0));
  for (let i = 0; i <= bp.length; i++) cost[i][hp.length] = bp.length - i;
  for (let j = 0; j <= hp.length; j++) cost[bp.length][j] = hp.length - j;
  for (let i = bp.length - 1; i >= 0; i--) for (let j = hp.length - 1; j >= 0; j--) {
    cost[i][j] = Math.min(cost[i + 1][j + 1] + (bp[i].name === hp[j].name ? 0 : 1),
      1 + cost[i + 1][j], 1 + cost[i][j + 1]);
  }
  const add = (kind) => { if (!changes.includes(kind)) changes.push(kind); };
  let i = 0, j = 0;
  while (i < bp.length || j < hp.length) {
    if (i < bp.length && j < hp.length && cost[i][j] === cost[i + 1][j + 1] + (bp[i].name === hp[j].name ? 0 : 1)) {
      if (bp[i].type !== hp[j].type) add(KIND.TYPE_CHANGED);
      if (bp[i].optional !== hp[j].optional) add(hp[j].optional ? KIND.OPTIONAL_CHANGED : KIND.REQUIRED_PARAM);
      i++; j++;
    } else if (j < hp.length && cost[i][j] === 1 + cost[i][j + 1]) {
      add(hp[j].optional || hp[j].rest ? KIND.OPTIONAL_PARAM : KIND.REQUIRED_PARAM);
      j++;
    } else { add(KIND.PARAM_REMOVED); i++; }
  }
  if ((b.returns || null) !== (h.returns || null)) changes.push(KIND.RETURN_CHANGED);
  return changes;
}

// The leading dotted name of a thrown expression, after `new` or before a call's `(`.
const THROWN_NEW = /^new\s+([\p{L}_$][\p{L}\p{N}_$]*(?:\s*\.\s*[\p{L}_$][\p{L}\p{N}_$]*)*)/u;
const THROWN_CALL = /^([\p{L}_$][\p{L}\p{N}_$]*(?:\s*\.\s*[\p{L}_$][\p{L}\p{N}_$]*)*)\s*(?:<[^()]*>\s*)?\(/u;

/**
 * What a throw is paired by: the constructor of `new X(…)` (`new X`) or the function of a
 * factory call `f(…)` (`f(…)`). Any other expression (`throw err`) is its own key. Python and
 * Java record names, which are their own key too.
 * @param {string} text @returns {string}
 */
function throwKey(text) {
  const made = THROWN_NEW.exec(text);
  if (made) return `new ${made[1].replace(/\s+/g, '')}`;
  const called = THROWN_CALL.exec(text);
  return called ? `${called[1].replace(/\s+/g, '')}(…)` : text;
}

/**
 * The head's throws that are new, as the head writes them. A throw whose text the base also
 * has is not new. A changed text is a reworded message, not a new throw, when it takes the
 * place of a base throw with the same key that the head no longer has (hono PR 1774:
 * `new Error('…')` to `new Error(MESSAGE)`). When a key has more changed texts in the head
 * than vanished ones in the base, which one is reworded cannot be told, so all of that key's
 * changed texts are reported (t3code PR 15 adds a `throw new Error` beside one it keeps).
 * Texts are distinct (a set): two identical throws were never told apart.
 * @param {{ throws: Set<string> } | null | undefined} baseSym @param {{ throws: Set<string> }} headSym
 * @returns {string[]}
 */
function newThrows(baseSym, headSym) {
  if (!baseSym) return [];
  /** @type {Map<string, number>} key -> base texts of that key the head no longer has */
  const vanished = new Map();
  for (const t of baseSym.throws) {
    if (!headSym.throws.has(t)) vanished.set(throwKey(t), (vanished.get(throwKey(t)) || 0) + 1);
  }
  const changed = [...headSym.throws].filter((t) => !baseSym.throws.has(t));
  /** @type {Map<string, number>} */
  const changedByKey = new Map();
  for (const t of changed) changedByKey.set(throwKey(t), (changedByKey.get(throwKey(t)) || 0) + 1);
  return changed.filter((t) => (changedByKey.get(throwKey(t)) || 0) > (vanished.get(throwKey(t)) || 0));
}

// Stale-caller count is capped so a benign change with many callers cannot outrank a
// dangerous one with few. 16 type-narrowed callers must stay below 8 new-throw callers.
function score(finding) {
  const base = Math.max(0, ...finding.kinds.map((k) => k.weight), KIND.BODY.weight);
  return base + Math.min(finding.staleCallers || 0, 10) * 2;
}

module.exports = { KIND, diffSignature, newThrows, throwKey, score };
