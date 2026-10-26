// @ts-check
'use strict';

// Finding the same small edit made in many functions (a rename, a changed parameter, a
// `go fix` rewrite). Pure: it works on parsed diff hunks and on signatures, no I/O.
//
// What this does NOT establish: an edit is summarised as "these few tokens became those few
// tokens" from a token diff. Two edits with the same summary are textually alike; they may
// still differ in meaning. An edit too big to summarise (over 6 tokens a side, or too large
// to diff within the work budget) is never counted as a repeat, so a function containing
// one is never called "explained".
//
// Each hunk also gets a "shape" key (identifiers abstracted to `$`, keywords and literals
// kept). It is used only where the literal key does not repeat, to catch the same change
// that differs in a name (`return async (c, next) =>` becoming `return async function name(...)`).

const MAX_SIDE = 6;
const MAX_SHAPE_SIDE = 40;
const MAX_DIFF_CELLS = 250000;

const TOKEN_RE = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s\w]/g;

/**
 * Identifiers, numbers, string literals and punctuation; whitespace is ignored.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return String(text).match(TOKEN_RE) || [];
}

/**
 * Token diff by longest common subsequence. Returns the edits, each
 * `{removed, added}` (token lists between two matched tokens), or null when the two sides
 * are too large to diff within the work budget.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{removed: string[], added: string[]}> | null}
 */
function tokenDiff(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ha = a.length, hb = b.length;
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) { ha--; hb--; }
  const x = a.slice(lo, ha), y = b.slice(lo, hb);
  if (!x.length && !y.length) return [];
  if (x.length * y.length > MAX_DIFF_CELLS) return null;
  const n = x.length, m = y.length, w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  /** @type {Array<{removed: string[], added: string[]}>} */
  const edits = [];
  let cur = { removed: /** @type {string[]} */ ([]), added: /** @type {string[]} */ ([]) };
  const flush = () => {
    if (cur.removed.length || cur.added.length) edits.push(cur);
    cur = { removed: [], added: [] };
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { flush(); i++; j++; }
    else if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) cur.removed.push(x[i++]);
    else cur.added.push(y[j++]);
  }
  flush();
  return edits;
}

const KEYWORDS = {
  ts: 'async await function return const let var class new if else for while do switch case break continue throw try catch finally typeof instanceof in of import export from default extends implements interface type enum public private protected static readonly void null undefined true false this super yield delete as',
  go: 'func return var const type struct interface map chan go defer if else for range switch case default break continue select package import fallthrough goto nil true false',
  py: 'def return class if elif else for while try except finally raise with as import from lambda yield async await pass break continue global nonlocal del in is not and or None True False assert',
};
/** @type {Record<string, Set<string>>} */
const KEYWORD_SETS = Object.fromEntries(Object.entries(KEYWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

/** @param {string} file @returns {'ts' | 'go' | 'py'} */
function langOf(file) {
  if (file.endsWith('.go')) return 'go';
  if (file.endsWith('.py')) return 'py';
  return 'ts';
}

/**
 * The shape of one edit side: identifiers (not keywords) become `$`.
 * @param {string[]} tokens @param {Set<string>} kw
 */
const shapeTokens = (tokens, kw) => tokens.map((t) => (/^[A-Za-z_$][\w$]*$/.test(t) && !kw.has(t) ? '$' : t));

/**
 * The pattern keys of a diff, `"<removed> → <added>"`, one per edit (null for an edit that
 * cannot be summarised: a side over 6 tokens, or a diff too large to compute), and the
 * hunk's shape key: all its edits' shapes joined by ` | ` (an edit over 6 tokens a side, up
 * to 40, is summarised by its token counts), or null when an edit is larger still or the
 * shape holds no keyword or literal besides `$` and punctuation.
 * @param {string} removedText
 * @param {string} addedText
 * @param {'ts' | 'go' | 'py'} [lang]
 * @returns {{keys: Array<string | null>, shape: string | null}}
 */
function editKeys(removedText, addedText, lang = 'ts') {
  const edits = tokenDiff(tokenize(removedText), tokenize(addedText));
  if (edits === null) return { keys: [null], shape: null };
  const keys = edits.map((e) => (e.removed.length > MAX_SIDE || e.added.length > MAX_SIDE ? null
    : `${e.removed.join(' ')} → ${e.added.join(' ')}`));
  if (!edits.length || edits.some((e) => e.removed.length > MAX_SHAPE_SIDE || e.added.length > MAX_SHAPE_SIDE)) return { keys, shape: null };
  const kw = KEYWORD_SETS[lang];
  // an edit too big for a literal key is summarised in the shape by its token counts
  const parts = edits.map((e) => (e.removed.length > MAX_SIDE || e.added.length > MAX_SIDE
    ? `⟪${e.removed.length} → ${e.added.length}⟫`
    : `${shapeTokens(e.removed, kw).join(' ')} → ${shapeTokens(e.added, kw).join(' ')}`));
  const meaningful = edits.some((e) => e.removed.concat(e.added).some((t) => kw.has(t) || /^(\d|["'`])/.test(t)));
  return { keys, shape: meaningful ? parts.join(' | ') : null };
}

/**
 * Attribute diff hunks to functions by head line range and summarise each edit.
 * A hunk's added lines go to the function that contains them; its removed lines (which have
 * no head line) go to the function that contains the hunk's first line.
 * @param {Array<{file: string, startLine: number, endLine: number, skip?: boolean}>} fns
 *   functions with their head file (repo-relative) and line range; `skip` for deleted ones
 * @param {Array<{file: string, newStart: number, newCount: number, removed: string[], added: string[]}>} hunks
 * @returns {Array<Array<{keys: Array<string | null>, shape: string | null}> | null>}  per function: one record per hunk, or null if no hunk reached it
 */
function editsByFunction(fns, hunks) {
  /** @type {Map<string, typeof hunks>} */
  const byFile = new Map();
  for (const h of hunks) {
    const l = byFile.get(h.file);
    if (l) l.push(h); else byFile.set(h.file, [h]);
  }
  return fns.map((f) => {
    if (f.skip) return null;
    /** @type {Array<{keys: Array<string | null>, shape: string | null}>} */
    const keys = [];
    let reached = false;
    const lang = langOf(f.file);
    for (const h of byFile.get(f.file) || []) {
      const first = h.newStart;
      const last = h.newStart + Math.max(h.newCount, 1) - 1;
      if (last < f.startLine || first > f.endLine) continue;
      const added = h.added.filter((_, k) => {
        const ln = h.newStart + k;
        return ln >= f.startLine && ln <= f.endLine;
      });
      const owns = first >= f.startLine && first <= f.endLine;
      const removed = owns ? h.removed : [];
      if (!added.length && !removed.length) continue;
      reached = true;
      keys.push(editKeys(removed.join('\n'), added.join('\n'), lang));
    }
    return reached ? keys : null;
  });
}

/**
 * A pattern says something only if its two sides together hold at least 2 non-punctuation
 * tokens (identifier, number or string): `→ )` does not, `interface { } → any` does.
 * @param {string} key
 */
function informative(key) {
  return tokenize(key.replace('→', ' ')).filter((t) => /^[\w$"'`]/.test(t)).length >= 2;
}

/**
 * Patterns that occur in at least `minFunctions` functions spread over at least
 * `minGroups` call-graph groups.
 * @param {Array<Array<string | null> | null>} edits per function (from editsByFunction)
 * @param {number[]} groupOf call-graph group of each function
 * @param {{minFunctions?: number, minGroups?: number, informative?: (key: string) => boolean}} [o]
 * @returns {Map<string, {functions: number[], groups: number}>}
 */
function repeatedPatterns(edits, groupOf, o = {}) {
  const minFunctions = o.minFunctions || 5, minGroups = o.minGroups || 2;
  /** @type {Map<string, Set<number>>} */
  const seen = new Map();
  edits.forEach((keys, i) => {
    for (const k of keys || []) {
      if (k === null || !(o.informative || informative)(k)) continue;
      const s = seen.get(k);
      if (s) s.add(i); else seen.set(k, new Set([i]));
    }
  });
  /** @type {Map<string, {functions: number[], groups: number}>} */
  const out = new Map();
  for (const [k, fns] of [...seen].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (fns.size < minFunctions) continue;
    const groups = new Set([...fns].map((i) => groupOf[i]));
    if (groups.size >= minGroups) out.set(k, { functions: [...fns].sort((a, b) => a - b), groups: groups.size });
  }
  return out;
}

/**
 * Resolve each function's hunk records into edit keys: a literal key where every edit of
 * the hunk is a repeated (informative) pattern, else the hunk's shape key where that
 * repeats, else null. Returns the repeated patterns (shape keys start with `≈ `) and the
 * resolved keys per function (null when no hunk reached it).
 * @param {Array<Array<{keys: Array<string | null>, shape: string | null}> | null>} perFn
 * @param {number[]} groupOf
 * @param {{minFunctions?: number, minGroups?: number}} [o]
 * @returns {{repeated: Map<string, {functions: number[], groups: number}>, effective: Array<Array<string | null> | null>}}
 */
function analyzeEdits(perFn, groupOf, o = {}) {
  const lit = repeatedPatterns(perFn.map((recs) => (recs ? recs.flatMap((r) => r.keys) : null)), groupOf, o);
  const litOk = (/** @type {{keys: Array<string | null>}} */ r) => r.keys.length > 0 && r.keys.every((k) => k !== null && lit.has(k));
  /** @type {Array<Array<string | null> | null>} */
  const shapeInput = perFn.map((recs) => (recs ? recs.filter((r) => !litOk(r) && r.shape !== null).map((r) => /** @type {string} */ (r.shape)) : null));
  const shp = repeatedPatterns(shapeInput, groupOf, { ...o, informative: () => true });
  /** @type {Map<string, {functions: number[], groups: number}>} */
  const repeated = new Map(lit);
  for (const [k, v] of shp) repeated.set(`≈ ${k}`, v);
  const effective = perFn.map((recs) => {
    if (!recs) return null;
    /** @type {Array<string | null>} */
    const out = [];
    for (const r of recs) {
      if (!r.keys.length) continue;
      if (litOk(r)) out.push(...r.keys);
      else if (r.shape !== null && shp.has(r.shape)) out.push(`≈ ${r.shape}`);
      else out.push(null);
    }
    return out;
  });
  return { repeated, effective };
}

/**
 * One edit of a shape key (`"<removed> → <added>"` or `⟪<removed count> → <added count>⟫`) in
 * words. An unparsable part comes back as its raw text, so a label never drops information.
 * @param {string} part
 * @returns {{text: string, isCount: boolean}}
 */
function describeShapePart(part) {
  const count = /^⟪(\d+) → (\d+)⟫$/.exec(part);
  if (count) {
    const removed = Number(count[1]), added = Number(count[2]);
    const tokens = (/** @type {number} */ n) => `${n} token${n === 1 ? '' : 's'}`;
    if (removed === 0) return { text: `${tokens(added)} added`, isCount: true };
    if (added === 0) return { text: `${tokens(removed)} removed`, isCount: true };
    return { text: `${tokens(removed)} replaced by ${added}`, isCount: true };
  }
  const arrow = part.indexOf(' → ');
  if (arrow < 0) return { text: part, isCount: false };
  const removed = part.slice(0, arrow).trim(), added = part.slice(arrow + 3).trim();
  if (removed && added) return { text: `\`${removed}\` replaced by \`${added}\``, isCount: false };
  if (added) return { text: `added \`${added}\``, isCount: false };
  return { text: `removed \`${removed}\``, isCount: false };
}

/**
 * A readable label for a sweep whose pattern is a shape key (starts with `≈ `), e.g.
 * "Similar edit in 26 functions (12 tokens added each)". `$` stands for any identifier.
 * The parts of a shape are joined by ` | `; a literal `|` token in an edit can split a part
 * in two, which makes the wording odd but loses nothing (the raw key stays in the card's
 * `pattern`). Other keys are returned unlabelled (null): they already read well.
 * @param {string} key a pattern key from analyzeEdits
 * @param {number} functions how many functions the sweep holds
 * @returns {string | null}
 */
function shapeSweepLabel(key, functions) {
  if (!key.startsWith('≈ ')) return null;
  const parts = key.slice(2).split(' | ').map(describeShapePart);
  const what = parts.length === 1 && parts[0].isCount ? `${parts[0].text} each` : `each: ${parts.map((p) => p.text).join('; ')}`;
  return `Similar edit in ${functions} function${functions === 1 ? '' : 's'} (${what})`;
}

module.exports = { shapeSweepLabel, analyzeEdits, informative, tokenize, tokenDiff, editKeys, editsByFunction, repeatedPatterns };
