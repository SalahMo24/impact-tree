// @ts-check
'use strict';

// Cluster cards: group the changed functions of a diff by how they are linked in the
// call graph, then describe how the groups meet ("seams"). Pure: no I/O, no clock.
// Everything here is deterministic so an AI step can later only name or merge clusters.
//
// What this does NOT establish: a cluster is a grouping of changes that the call graph
// (or, for lone changes, their location) puts together. It does not say the changes are
// one logical task, and a missing link may just be a call the analyzer could not see.
// `stats.incomplete` counts members whose callers were not fully found; read the links
// of those members as "at least". `stats.notUpdated` counts call lines left unedited only
// for members whose signature or throws changed (`stats.risky`): for a body-only change a
// call line has no reason to change.
//
// Two kinds of changes are taken out of the graph. A "sweep" is the same small edit made in
// many functions (see repeated-edits.js). A "mirror" is a cluster that duplicates another
// under a generated folder (hono's deno_dist); its members move into the source cluster's
// `mirrorMembers`. Every changed id appears exactly once across members, mirrorMembers,
// sweep members and a card's `moved` (the deleted side of a move). The steps that read the
// diff (sweeps, moves, commit split, generated folders) need `opts.facts` from
// cluster-hints.js; without it they do not happen.
//
// Other card kinds: `hub` (one function that glued 3 or more parts of a group together, with its one-member parts),
// `siblings` (the same lone change repeated in sibling folders), `generated` (what a
// generated folder holds that has no source twin), `moved` (a function that moved files).

const path = require('path');
const { tokenize, tokenDiff, editsByFunction, analyzeEdits, shapeSweepLabel } = require('./repeated-edits');
const { isBroadCommit, isWeakCommit } = require('./cluster-hints');

const GENERATED_NAME = /(^|[_-])(dist|gen|generated|build|out)([_-]|$)/i;
const DEFAULTS = { sweepMin: 8, maxGroup: 12, minDir: 3, viaCap: 10, testCallerCap: 200, minTypeName: 3 };

/** @typedef {{id: string, raw: any, deleted: boolean, rel: string, score: number}} Node */

/**
 * The value stored under `key`, creating it first when absent.
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {() => V} make
 * @returns {V}
 */
function getOr(map, key, make) {
  let v = map.get(key);
  if (v === undefined) { v = make(); map.set(key, v); }
  return v;
}

/** @param {any} v */
const str = (v) => (v == null ? '' : String(v));

/**
 * @param {any[]} list
 * @param {number} cap
 */
function capList(list, cap) {
  return { list: list.slice(0, cap), count: list.length };
}

/**
 * @param {any} result
 * @returns {Node[]}
 */
function collectNodes(result) {
  /** @type {Node[]} */
  const nodes = [];
  const seen = new Set();
  /** @param {any} raw @param {boolean} deleted */
  const add = (raw, deleted) => {
    const rel = str(raw.relPath || raw.file);
    let id = `${rel}#${raw.namePos}`;
    if (deleted && seen.has(id)) id += '!deleted';
    if (seen.has(id)) return; // the same symbol listed twice: keep the first
    seen.add(id);
    nodes.push({ id, raw, deleted, rel, score: Number(raw.score) || 0 });
  };
  for (const c of (result && result.allChanged) || []) add(c, false);
  for (const d of (result && result.deleted) || []) add(d, true);
  return nodes;
}

// Union-find with path halving: iterative, so a long call chain cannot blow the stack.
/** @param {number} n */
function makeUnion(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  /** @param {number} x */
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  /** @param {number} a @param {number} b */
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  return { find, union };
}

// Split one oversized group by directory. A directory group smaller than `minDir` is
// merged into its parent directory's group, repeatedly, until none is that small
// (the root directory '.' is the end of the road).
/**
 * @param {number[]} members
 * @param {Node[]} nodes
 * @param {number} minDir
 * @returns {number[][]}
 */
function splitByDir(members, nodes, minDir) {
  /** @type {Map<string, number[]>} */
  const buckets = new Map();
  for (const m of members) {
    const d = path.posix.dirname(nodes[m].rel);
    getOr(buckets, d, () => []).push(m);
  }
  /** @param {string} d */
  const depth = (d) => (d === '.' ? 0 : d.split('/').length);
  for (;;) {
    const small = [...buckets.keys()]
      .filter((d) => d !== '.' && (buckets.get(d) || []).length < minDir)
      .sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1));
    if (!small.length) break;
    const d = small[0];
    const parent = path.posix.dirname(d);
    getOr(buckets, parent, () => []).push(...(buckets.get(d) || []));
    buckets.delete(d);
  }
  return [...buckets.keys()].sort().map((d) => buckets.get(d) || []);
}

// Identifier-like words of a signature, for the approximate "type" seam.
/** @param {any} text */
function wordsOf(text) {
  return new Set(str(text).match(/[A-Za-z_$][\w$]*/g) || []);
}

/** @param {Node[]} nodes */
const byScoreThenId = (nodes) => (/** @type {number} */ a, /** @type {number} */ b) => nodes[b].score - nodes[a].score
  || (nodes[a].id < nodes[b].id ? -1 : nodes[a].id > nodes[b].id ? 1 : 0);


/** Top folder of a repo-relative path ('' for a file in the root). */
const topDir = (/** @type {string} */ rel) => (rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '');

/**
 * A path or name that reads as test support: a word of it is test, fake, mock, spy, stub or
 * fixture (camelCase and snake_case are split, so `InvocationRecorderSpy` counts and
 * `latestVersion` does not).
 * @param {string} text
 */
function isTestLike(text) {
  const words = String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => /^(test|tests|fake|fakes|mock|mocks|spy|spies|stub|stubs|fixture|fixtures)$/.test(w));
}

// Split an oversized group (still above maxGroup after the directory split) by file: a file
// holding fewer than 3 members folds into the group's largest file. A group that lives in
// one file stays whole, and so does one that is mostly new code (new files group by their
// package folder, not by file).
/**
 * @param {number[]} members
 * @param {Node[]} nodes
 * @returns {number[][] | null} null when the group is kept whole because it is new code
 */
function splitByFile(members, nodes) {
  /** @type {Map<string, number[]>} */
  const byFile = new Map();
  for (const m of members) getOr(byFile, nodes[m].rel, () => []).push(m);
  if (byFile.size < 2) return [members];
  // New code means new folders: mostly added files, and no member in a modified file sharing
  // a folder with them. New files dropped into an existing folder still split by file.
  const added = members.filter((m) => nodes[m].raw.fileStatus === 'added');
  const addedDirs = new Set(added.map((m) => path.posix.dirname(nodes[m].rel)));
  const mixed = members.some((m) => nodes[m].raw.fileStatus !== 'added' && addedDirs.has(path.posix.dirname(nodes[m].rel)));
  if (added.length * 2 > members.length && !mixed) return null;
  const files = [...byFile.keys()].sort();
  const largest = files.reduce((b, f) => ((byFile.get(f) || []).length > (byFile.get(b) || []).length ? f : b), files[0]);
  /** @type {number[][]} */
  const out = [];
  const home = byFile.get(largest) || [];
  for (const f of files) {
    const g = byFile.get(f) || [];
    if (f === largest) continue;
    if (g.length < 3) home.push(...g); else out.push(g);
  }
  out.push(home);
  return out;
}

/**
 * Connected components of `members` over `adj`, leaving out `skip`. Deterministic: ordered
 * by smallest member.
 * @param {number[]} members
 * @param {number[][]} adj
 * @param {number} [skip]
 * @returns {number[][]}
 */
function componentsOf(members, adj, skip = -1) {
  const inSet = new Set(members);
  const seen = new Set();
  /** @type {number[][]} */
  const out = [];
  for (const s of members) {
    if (s === skip || seen.has(s)) continue;
    const comp = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const v = /** @type {number} */ (stack.pop());
      comp.push(v);
      for (const w of adj[v]) if (w !== skip && inSet.has(w) && !seen.has(w)) { seen.add(w); stack.push(w); }
    }
    out.push(comp.sort((a, b) => a - b));
  }
  return out;
}

/**
 * Hubs: a member whose removal splits its (connected) group into 3 or more parts of at
 * least 2 members outside the hub's own file. The hub becomes its own card, taking with it
 * every part of one member or wholly in its file (`absorbed`); the other parts become
 * separate groups. Repeats on those parts. Groups
 * without a hub are returned as they were.
 * @param {number[]} g
 * @param {number[][]} adj
 * @param {Node[]} nodes
 * @param {Set<number>[]} calls who each node calls: only parts the hub calls into count, so a
 *   router counts and a shared helper that many features call does not (its callers are its
 *   consumers, already shown as cards with call seams to it)
 * @returns {{hubs: Array<{hub: number, absorbed: number[]}>, groups: number[][]}}
 */
function splitHubs(g, adj, nodes, calls) {
  /** @type {Array<{hub: number, absorbed: number[]}>} */
  const hubs = [];
  /** @type {number[][]} */
  const groups = [];
  /** @type {number[]} */
  const rest = [];
  for (const piece of componentsOf(g, adj)) {
    const work = [piece];
    /** @type {Array<{hub: number, absorbed: number[]}>} */
    const found = [];
    /** @type {number[][]} */
    const out = [];
    while (work.length) {
      const S = /** @type {number[]} */ (work.pop());
      let best = -1, bestBig = 0;
      /** @type {number[][]} */
      let bestParts = [];
      // A part wholly in the hub's own file stays with the hub: a component calling helpers
      // in its file, or a function and its inner functions, is not a router between features.
      /** @param {number} v @param {number[]} p */
      const own = (v, p) => p.length < 2 || p.every((m) => nodes[m].rel === nodes[v].rel);
      if (S.length >= 7) {
        for (const v of S) {
          if (adj[v].filter((w) => S.includes(w)).length < 3) continue;
          const parts = componentsOf(S, adj, v);
          const big = parts.filter((p) => !own(v, p) && p.some((m) => calls[v].has(m))).length;
          if (big < 3) continue;
          if (best < 0 || big > bestBig || (big === bestBig && (nodes[v].score > nodes[best].score
            || (nodes[v].score === nodes[best].score && nodes[v].id < nodes[best].id)))) { best = v; bestBig = big; bestParts = parts; }
        }
      }
      if (best < 0) { out.push(S); continue; }
      found.push({ hub: best, absorbed: bestParts.filter((p) => own(best, p)).flat() });
      work.push(...bestParts.filter((p) => !own(best, p)));
    }
    if (!found.length) rest.push(...piece);
    else { hubs.push(...found); groups.push(...out); }
  }
  if (rest.length) groups.push(rest.sort((a, b) => a - b));
  return { hubs, groups };
}

/**
 * Split a fused group by the non-broad, non-weak commits that touched each member's file.
 * Members partition into classes by identical commit set; with 2 or more classes of at
 * least 2 members, and under 20% of members ambiguous (no commit, or sharing commits with
 * 2 or more other classes), the group splits. The ambiguous and the left-over members join
 * the class they have most call links to, else the largest. Returns null when it does not
 * split.
 * @param {number[]} g
 * @param {Node[]} nodes
 * @param {Map<string, number[]>} fileCommits file -> indexes of the usable commits
 * @param {number[][]} adj
 * @returns {number[][] | null}
 */
function splitByCommits(g, nodes, fileCommits, adj) {
  if (g.length < 6) return null;
  const sig = (/** @type {number} */ m) => (fileCommits.get(nodes[m].rel) || []).join(',');
  /** @type {Map<string, number[]>} */
  const classes = new Map();
  for (const m of g) getOr(classes, sig(m), () => []).push(m);
  const big = [...classes.entries()].filter((e) => e[0] !== '' && e[1].length >= 2).map((e) => e[0]).sort();
  if (big.length < 2) return null;
  /** @type {Map<string, Set<string>>} */
  const owners = new Map(); // commit -> classes (by key) whose commit set holds it
  for (const k of big) for (const c of k.split(',')) getOr(owners, c, () => new Set()).add(k);
  let ambiguous = 0;
  const amb = new Set();
  for (const m of g) {
    const k = sig(m);
    let isAmb = k === '';
    if (!isAmb) {
      const others = new Set();
      for (const c of k.split(',')) for (const o of owners.get(c) || []) if (o !== k) others.add(o);
      isAmb = others.size >= 2;
    }
    if (isAmb) { ambiguous++; amb.add(m); }
  }
  if (ambiguous * 5 >= g.length) return null;
  /** @type {Map<string, number[]>} */
  const kept = new Map();
  for (const k of big) {
    const ms = (classes.get(k) || []).filter((m) => !amb.has(m));
    if (ms.length >= 2) kept.set(k, ms);
  }
  // 2 to 5 classes read as a few features fused by a release merge; more reads as one
  // commit per file of one change (a migration), which the pattern hints link up instead
  if (kept.size < 2 || kept.size > 5) return null;
  const keys = [...kept.keys()].sort((a, b) => (kept.get(b) || []).length - (kept.get(a) || []).length || (a < b ? -1 : 1));
  const classOf = new Map();
  keys.forEach((k, ci) => (kept.get(k) || []).forEach((m) => classOf.set(m, ci)));
  const out = keys.map((k) => (kept.get(k) || []).slice());
  for (const m of g) {
    if (classOf.has(m)) continue;
    const links = new Array(keys.length).fill(0);
    for (const w of adj[m]) if (classOf.has(w)) links[classOf.get(w)]++;
    let ci = 0;
    for (let i = 1; i < links.length; i++) if (links[i] > links[ci]) ci = i;
    out[ci].push(m);
  }
  return out;
}

/**
 * Words of a function's body from the diff: its added lines (head numbering) or, for a
 * deleted function, its removed lines (base numbering), within its line range.
 * @param {Node} nd
 * @param {Map<string, any[]>} byFile hunks by file
 * @returns {Set<string>}
 */
function bodyTokens(nd, byFile) {
  const lo = Number(nd.raw.startLine) || 0, hi = Number(nd.raw.endLine) || 0;
  /** @type {string[]} */
  const lines = [];
  for (const h of byFile.get(nd.rel) || []) {
    if (nd.deleted) h.removed.forEach((/** @type {string} */ t, /** @type {number} */ k) => { const ln = h.oldStart + k; if (ln >= lo && ln <= hi) lines.push(t); });
    else h.added.forEach((/** @type {string} */ t, /** @type {number} */ k) => { const ln = h.newStart + k; if (ln >= lo && ln <= hi) lines.push(t); });
  }
  return new Set(tokenize(lines.join('\n')));
}

/**
 * A deleted function and an added function of the same name (and class) in different
 * files, with similar bodies (token Jaccard >= 0.6) or, when a body is not in the diff,
 * the same file name: one moved pair.
 *
 * Known limit: a function renamed while it moves, or renamed in place, is not matched (the
 * names must be equal); it shows as one deleted and one added function. Owner decision: this
 * is documented, not detected.
 * @param {Node[]} nodes
 * @param {any[] | undefined} hunks
 * @returns {Array<{from: number, to: number}>}
 */
function matchMoves(nodes, hunks) {
  /** @type {Map<string, any[]>} */
  const byFile = new Map();
  for (const h of hunks || []) getOr(byFile, h.file, () => []).push(h);
  /** @type {Map<string, number[]>} */
  const adds = new Map();
  nodes.forEach((nd, i) => {
    if (nd.deleted || nd.raw.added !== true) return;
    getOr(adds, `${str(nd.raw.className)}\0${str(nd.raw.simpleName)}`, () => []).push(i);
  });
  const used = new Set();
  /** @type {Array<{from: number, to: number}>} */
  const pairs = [];
  const dels = nodes.map((_, i) => i).filter((i) => nodes[i].deleted).sort((a, b) => (nodes[a].id < nodes[b].id ? -1 : 1));
  for (const d of dels) {
    const cands = (adds.get(`${str(nodes[d].raw.className)}\0${str(nodes[d].raw.simpleName)}`) || [])
      .filter((a) => !used.has(a) && nodes[a].rel !== nodes[d].rel);
    if (!cands.length) continue;
    const td = bodyTokens(nodes[d], byFile);
    let best = -1, bestSim = -1;
    for (const a of cands) {
      const ta = bodyTokens(nodes[a], byFile);
      let sim;
      if (td.size && ta.size) {
        let common = 0;
        for (const t of td) if (ta.has(t)) common++;
        sim = common / (td.size + ta.size - common);
        if (sim < 0.6) continue;
      } else {
        if (path.posix.basename(nodes[a].rel) !== path.posix.basename(nodes[d].rel)) continue;
        sim = 0.6;
      }
      if (sim > bestSim) { best = a; bestSim = sim; }
    }
    if (best >= 0) { used.add(best); pairs.push({ from: d, to: best }); }
  }
  return pairs;
}

/**
 * Pairs of clusters that duplicate each other under different top folders, neither side
 * (or both) a known generated folder: reported as `mirror` seams. (A generated copy is
 * folded into its source earlier, per function.)
 * @param {Array<{members: number[]}>} base
 * @param {Node[]} nodes
 * @param {Set<string>} generated
 * @returns {Array<{a: number, b: number, dirs: string[], files: number}>}
 */
function mirrorSeamPairs(base, nodes, generated) {
  const isGen = (/** @type {string} */ d) => generated.has(d) || GENERATED_NAME.test(d);
  /** @type {Map<string, Array<{ci: number, first: string}>>} */
  const tails = new Map();
  base.forEach((c, ci) => {
    for (const rel of new Set(c.members.map((m) => nodes[m].rel))) {
      const k = rel.indexOf('/');
      if (k < 0) continue;
      getOr(tails, rel.slice(k + 1), () => []).push({ ci, first: rel.slice(0, k) });
    }
  });
  /** @type {Map<string, {a: number, b: number, da: string, db: string, files: number}>} */
  const cand = new Map();
  for (const entries of tails.values()) {
    const e = entries.slice(0, 8);
    for (let i = 0; i < e.length; i++) for (let j = i + 1; j < e.length; j++) {
      const x = e[i].ci < e[j].ci ? e[i] : e[j], y = x === e[i] ? e[j] : e[i];
      if (x.ci === y.ci || x.first === y.first) continue;
      getOr(cand, `${x.ci}|${y.ci}|${x.first}|${y.first}`, () => ({ a: x.ci, b: y.ci, da: x.first, db: y.first, files: 0 })).files++;
    }
  }
  const names = base.map((c) => new Set(c.members.map((m) => str(nodes[m].raw.simpleName))));
  const out = [];
  for (const c of [...cand.values()].sort((p, q) => q.files - p.files || p.a - q.a || p.b - q.b || (p.da < q.da ? -1 : 1))) {
    if (isGen(c.da) !== isGen(c.db)) continue;
    const small = Math.min(names[c.a].size, names[c.b].size);
    let common = 0;
    for (const nm of names[c.a]) if (names[c.b].has(nm)) common++;
    if (small && common / small >= 0.8) out.push({ a: c.a, b: c.b, dirs: [c.da, c.db], files: c.files });
  }
  return out;
}

/**
 * @typedef {{members: number[], joined: Array<{id: string, by: string}>, mirror?: {members: number[], dirs: string[]},
 *   moved: Array<{from: number, to: number}>, hub?: boolean, siblings?: boolean, generated?: {dir: string}}} Card
 */

/**
 * @param {any} result  the CLI `--json` result (uses `allChanged` and `deleted`)
 * @param {{maxGroup?: number, minDir?: number, viaCap?: number, testCallerCap?: number, minTypeName?: number, sweepMin?: number,
 *   facts?: {hunks?: any[], generatedDirs?: string[], commits?: any[], changedFileCount?: number}}} [opts]
 * @returns {{version: 1, clusters: any[], sweeps: any[], seams: any[], rules: Record<string, number>}}
 */
function buildClusters(result, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const facts = o.facts || {};
  const nodes = collectNodes(result);
  const n = nodes.length;
  const rules = { sweeps: 0, shapeSweeps: 0, otherSweep: 0, mirrorsFolded: 0, generatedCards: 0, generatedMembers: 0,
    moves: 0, sweepMirrors: 0, hubs: 0, siblingCards: 0, commitSplits: 0, newCodeGroups: 0 };

  // changed-symbol lookup, same id rules as forest.nestedIds (constructor -> class name)
  const index = new Map();
  nodes.forEach((nd, i) => {
    if (nd.deleted) return; // a deleted function has no position at head to be called at
    index.set(`${nd.raw.file}#${nd.raw.namePos}`, i);
  });
  nodes.forEach((nd, i) => {
    if (!nd.deleted && nd.raw.isConstructor && nd.raw.classNamePos != null) {
      const key = `${nd.raw.file}#${nd.raw.classNamePos}`;
      if (!index.has(key)) index.set(key, i);
    }
  });
  // a signature or throws change (not body-only): the rule of tree-row-models classifyRiskyVerdict
  const risky = nodes.map((nd) => !nd.deleted && (nd.raw.kinds || []).some((/** @type {any} */ k) => k.id !== 'body'));

  // 1. edges: caller -> callee, both changed, self-loops dropped, duplicates dropped
  /** @type {Array<{callee: number, caller: number}>} */
  const edges = [];
  const edgeSeen = new Set();
  const fullUf = makeUnion(n);
  nodes.forEach((nd, i) => {
    for (const x of nd.raw.callers || []) {
      if (x.test) continue; // test callers sit at file level (pos 0): never a changed symbol
      const j = index.get(`${x.file}#${x.pos}`);
      if (j === undefined || j === i) continue;
      const key = `${i}>${j}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ callee: i, caller: j });
      fullUf.union(i, j);
    }
  });

  // 1a. moves: a deleted function and its added twin in another file
  const moves = matchMoves(nodes, facts.hunks);
  const movedFrom = new Set(moves.map((m) => m.from));
  const movedTo = new Set(moves.map((m) => m.to));

  // 1b. repeated edits: the same small edit in many functions across the call graph
  const groupOf = nodes.map((_, i) => fullUf.find(i));
  /** @type {Array<Array<string | null> | null>} */
  let edits = nodes.map(() => null);
  /** @type {Map<string, {functions: number[], groups: number}>} */
  let repeated = new Map();
  if (facts.hunks) {
    const perFn = editsByFunction(nodes.map((nd) => ({
      file: nd.rel, startLine: Number(nd.raw.startLine) || 0, endLine: Number(nd.raw.endLine) || 0, skip: nd.deleted,
    })), facts.hunks);
    const an = analyzeEdits(perFn, groupOf);
    edits = an.effective; repeated = an.repeated;
  }
  const explained = nodes.map((_, i) => {
    const keys = edits[i];
    return !!keys && keys.length > 0 && keys.every((k) => k !== null && repeated.has(k)) && !movedFrom.has(i) && !movedTo.has(i);
  });
  // each explained body-only function goes to its dominant pattern (most occurrences in the
  // function, then most functions overall, then key order); a pattern group of sweepMin or
  // more functions is a sweep. The smaller groups together form one "other repeated edits"
  // sweep when they total sweepMin or more; otherwise they go back into the graph.
  /** @type {Map<string, number[]>} */
  const byDominant = new Map();
  nodes.forEach((_, i) => {
    if (!explained[i] || risky[i]) return;
    /** @type {Map<string, number>} */
    const own = new Map();
    for (const k of edits[i] || []) if (k !== null) own.set(k, (own.get(k) || 0) + 1);
    const key = [...own.keys()].sort((a, b) => (own.get(b) || 0) - (own.get(a) || 0)
      || ((repeated.get(b) || { functions: [] }).functions.length - (repeated.get(a) || { functions: [] }).functions.length)
      || (a < b ? -1 : 1))[0];
    getOr(byDominant, key, () => []).push(i);
  });
  const allGroups = [...byDominant.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const sweepGroups = allGroups.filter((e) => e[1].length >= o.sweepMin);
  const smallGroups = allGroups.filter((e) => e[1].length < o.sweepMin);
  const otherMembers = smallGroups.flatMap((e) => e[1]);
  /** @type {Array<{key: string, label: string, members: number[], other: boolean}>} */
  const sweepList = sweepGroups.map(([key, ms]) => ({ key, label: key, members: ms.slice().sort(byScoreThenId(nodes)), other: false }));
  if (otherMembers.length >= o.sweepMin) {
    sweepList.push({ key: '', label: `Other repeated edits (${smallGroups.length} patterns)`, members: otherMembers.sort(byScoreThenId(nodes)), other: true });
  }
  const swept = new Set(sweepList.flatMap((g) => g.members));
  // a sweep member under a generated folder whose twin (same path after the first segment,
  // same name and class) is in the same sweep is a mirror of it, as in the clusters
  const genSet = new Set(facts.generatedDirs || []);
  const isGenTop = (/** @type {string} */ d) => genSet.has(d) || GENERATED_NAME.test(d);
  /** @type {Map<number, number[]>} */
  const sweepMirror = new Map();
  /** @param {Node} nd @param {string} t */
  const twinKey = (nd, t) => `${nd.rel.slice(t.length + 1)}\0${str(nd.raw.simpleName)}\0${str(nd.raw.className)}`;
  sweepList.forEach((sw, si) => {
    /** @type {Map<string, number[]>} */
    const sources = new Map();
    for (const m of sw.members) {
      const t = topDir(nodes[m].rel);
      if (t && !isGenTop(t)) getOr(sources, twinKey(nodes[m], t), () => []).push(m);
    }
    const copies = new Set();
    for (const m of sw.members) {
      const t = topDir(nodes[m].rel);
      if (!t || !isGenTop(t)) continue;
      const list = sources.get(twinKey(nodes[m], t));
      if (list && list.length) { list.shift(); copies.add(m); }
    }
    if (copies.size) {
      sweepMirror.set(si, sw.members.filter((m) => copies.has(m)));
      sw.members = sw.members.filter((m) => !copies.has(m));
    }
  });
  rules.sweepMirrors = [...sweepMirror.values()].reduce((x, l) => x + l.length, 0);
  rules.sweeps = sweepList.length;
  rules.shapeSweeps = sweepList.filter((g) => g.key.startsWith('≈')).length;
  rules.otherSweep = sweepList.some((g) => g.other) ? 1 : 0;

  // the live graph: everything except the sweeps
  const degree = new Array(n).fill(0);
  /** @type {number[][]} */
  const adj = nodes.map(() => []);
  /** @type {Set<number>[]} who each changed function calls, for the hub rule */
  const calls = nodes.map(() => new Set());
  const uf = makeUnion(n);
  for (const e of edges) {
    if (swept.has(e.callee) || swept.has(e.caller)) continue;
    degree[e.callee]++; degree[e.caller]++;
    adj[e.callee].push(e.caller); adj[e.caller].push(e.callee);
    calls[e.caller].add(e.callee);
    uf.union(e.callee, e.caller);
  }

  // commits usable for splitting: not broad (over half the PR's files) and not weak
  /** @type {Map<string, number[]>} */
  const fileCommits = new Map();
  (facts.commits || []).forEach((c, ci) => {
    if (isBroadCommit(c.files.length, facts.changedFileCount) || isWeakCommit(c.subject)) return;
    for (const f of c.files) getOr(fileCommits, f, () => []).push(ci);
  });

  // 2-4. components, then module split, hubs, commit split, then size split (non-lone nodes only)
  /** @type {Map<number, number[]>} */
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    if (degree[i] === 0) continue;
    getOr(comps, uf.find(i), () => []).push(i);
  }
  /** @type {number[][]} */
  const groups = [];
  /** @type {number[]} */
  /** @type {Array<{hub: number, absorbed: number[]}>} */
  const hubNodes = [];
  /** @param {number[]} grp */
  const sizeSplit = (grp) => {
    if (grp.length <= o.maxGroup) { groups.push(grp); return; }
    for (const d of splitByDir(grp, nodes, o.minDir)) {
      if (d.length <= o.maxGroup) { groups.push(d); continue; }
      const f = splitByFile(d, nodes);
      if (f === null) { rules.newCodeGroups++; groups.push(d); } else groups.push(...f);
    }
  };
  for (const r of [...comps.keys()].sort((a, b) => a - b)) {
    /** @type {Map<string, number[]>} */
    const byModule = new Map();
    for (const m of comps.get(r) || []) {
      getOr(byModule, str(nodes[m].raw.component), () => []).push(m);
    }
    for (const k of [...byModule.keys()].sort()) {
      const g = byModule.get(k) || [];
      const sh = splitHubs(g, adj, nodes, calls);
      hubNodes.push(...sh.hubs);
      for (const part of sh.groups) {
        const cs = splitByCommits(part, nodes, fileCommits, adj);
        if (cs) rules.commitSplits++;
        for (const sub of cs || [part]) sizeSplit(sub);
      }
    }
  }
  rules.hubs = hubNodes.length;
  const hubMembers = hubNodes.flatMap((h) => [h.hub, ...h.absorbed]);

  // provisional order so lone-change ties are stable: score desc, then anchor id
  /** @param {number[][]} gs */
  const orderGroups = (gs) => gs.map((g) => g.slice().sort(byScoreThenId(nodes)))
    .sort((a, b) => nodes[b[0]].score - nodes[a[0]].score
      || (nodes[a[0]].id < nodes[b[0]].id ? -1 : 1));
  /** @type {Card[]} */
  const base = orderGroups(groups).map((members) => ({ members, joined: [], moved: [] }));
  for (const h of hubNodes.slice().sort((a, b) => byScoreThenId(nodes)(a.hub, b.hub))) {
    base.push({ members: [h.hub, ...h.absorbed], joined: h.absorbed.map((m) => ({ id: nodes[m].id, by: 'hub' })), moved: [], hub: true });
  }

  // 5. lone changes: siblings first (same name and file name in sibling folders), then
  // CP-D1a: same file, else busiest folder, else a card per folder
  const placed = new Set(hubMembers);
  for (const g of groups) for (const m of g) placed.add(m);
  const lone = [];
  for (let i = 0; i < n; i++) if (degree[i] === 0 && !swept.has(i) && !movedFrom.has(i) && !placed.has(i)) lone.push(i);
  lone.sort(byScoreThenId(nodes));
  /** @type {Map<string, number[]>} */
  const sibKeys = new Map();
  const genNames = new Set(facts.generatedDirs || []);
  for (const i of lone) {
    if (nodes[i].deleted || genNames.has(topDir(nodes[i].rel)) || GENERATED_NAME.test(topDir(nodes[i].rel))) continue;
    getOr(sibKeys, `${str(nodes[i].raw.className)}\0${str(nodes[i].raw.simpleName)}\0${path.posix.basename(nodes[i].rel)}`, () => []).push(i);
  }
  const sibTaken = new Set();
  for (const key of [...sibKeys.keys()].sort()) {
    /** @type {Map<string, number[]>} */
    const byParent = new Map();
    for (const i of sibKeys.get(key) || []) getOr(byParent, path.posix.dirname(path.posix.dirname(nodes[i].rel)), () => []).push(i);
    for (const p of [...byParent.keys()].sort()) {
      const ms = byParent.get(p) || [];
      if (p === '.') continue; // folders directly under the root are not siblings of one family
      if (new Set(ms.map((i) => path.posix.dirname(nodes[i].rel))).size < 2) continue;
      base.push({ members: ms.slice().sort(byScoreThenId(nodes)), joined: [], moved: [], siblings: true });
      for (const i of ms) sibTaken.add(i);
      rules.siblingCards++;
    }
  }
  const fileCount = new Map(), dirCount = new Map();
  /** @param {Map<string, Map<number, number>>} map @param {string} key @param {number} ci */
  const bump = (map, key, ci) => {
    const m = getOr(map, key, () => new Map());
    m.set(ci, (m.get(ci) || 0) + 1);
  };
  base.forEach((c, ci) => {
    if (c.hub) return;
    c.members.forEach((m) => {
      bump(fileCount, nodes[m].rel, ci);
      bump(dirCount, path.posix.dirname(nodes[m].rel), ci);
    });
  });
  /** @param {Map<number, number> | undefined} m */
  const best = (m) => {
    if (!m) return -1;
    let bi = -1, bc = 0;
    for (const [ci, cnt] of m) if (cnt > bc || (cnt === bc && ci < bi)) { bi = ci; bc = cnt; }
    return bi;
  };
  /** @type {Map<string, number[]>} */
  const leftover = new Map();
  for (const i of lone) {
    if (sibTaken.has(i)) continue;
    let ci = best(fileCount.get(nodes[i].rel));
    let by = 'file';
    if (ci < 0) { ci = best(dirCount.get(path.posix.dirname(nodes[i].rel))); by = 'folder'; }
    if (ci >= 0) {
      base[ci].members.push(i);
      base[ci].joined.push({ id: nodes[i].id, by });
    } else {
      getOr(leftover, path.posix.dirname(nodes[i].rel), () => []).push(i);
    }
  }
  for (const d of [...leftover.keys()].sort()) {
    const members = leftover.get(d) || [];
    base.push({ members, joined: members.map((m) => ({ id: nodes[m].id, by: 'folder' })), moved: [] });
  }

  // 5b. generated copies: a function under a generated folder with a twin of the same path
  // and name elsewhere folds into the twin's card (mirrorMembers); one without a twin, under
  // a folder known to be generated, goes to that folder's one card
  const where = new Array(n).fill(-1);
  base.forEach((c, ci) => c.members.forEach((m) => { where[m] = ci; }));
  /** @type {Map<string, number[]>} */
  const twins = new Map();
  nodes.forEach((nd, i) => {
    const t = topDir(nd.rel);
    if (!t || isGenTop(t)) return;
    getOr(twins, `${nd.rel.slice(t.length + 1)}\0${str(nd.raw.simpleName)}\0${str(nd.raw.className)}`, () => []).push(i);
  });
  /** @type {Map<string, Card>} */
  const genCards = new Map();
  const taken = new Set();
  for (let i = 0; i < n; i++) {
    const t = topDir(nodes[i].rel);
    if (where[i] < 0 || !t || !isGenTop(t)) continue;
    const list = twins.get(`${nodes[i].rel.slice(t.length + 1)}\0${str(nodes[i].raw.simpleName)}\0${str(nodes[i].raw.className)}`) || [];
    const src = list.find((s) => where[s] >= 0 && !taken.has(s));
    /** @type {Card | null} */
    let dest = null;
    if (src !== undefined) {
      taken.add(src);
      dest = base[where[src]];
      dest.mirror = dest.mirror || { members: [], dirs: [] };
      dest.mirror.members.push(i);
      if (!dest.mirror.dirs.includes(t)) dest.mirror.dirs.push(t);
      rules.mirrorsFolded++;
    } else if (genSet.has(t)) {
      dest = getOr(genCards, t, () => ({ members: [], joined: [], moved: [], generated: { dir: t } }));
      dest.members.push(i);
      rules.generatedMembers++;
    }
    if (!dest) continue;
    const from = base[where[i]];
    from.members = from.members.filter((m) => m !== i);
    from.joined = from.joined.filter((j) => j.id !== nodes[i].id);
    where[i] = -2; // placed outside the member lists
  }
  for (const d of [...genCards.keys()].sort()) { base.push(/** @type {Card} */ (genCards.get(d))); rules.generatedCards++; }
  const kept = base.filter((c) => c.members.length > 0);
  base.length = 0;
  base.push(...kept);
  base.forEach((c, ci) => c.members.forEach((m) => { where[m] = ci; }));

  // 5c. moves: the deleted side joins the card of the added side
  for (const mv of moves) {
    const ci = where[mv.to];
    if (ci >= 0) { base[ci].moved.push(mv); rules.moves++; continue; }
    base.push({ members: [mv.from], joined: [{ id: nodes[mv.from].id, by: 'folder' }], moved: [] }); // twin placed elsewhere: stays a deletion
  }

  // 6. final order and ids (members sorted by score; cards by their top member)
  for (const c of base) c.members.sort(byScoreThenId(nodes));
  base.sort((a, b) => nodes[b.members[0]].score - nodes[a.members[0]].score
    || (nodes[a.members[0]].id < nodes[b.members[0]].id ? -1 : 1));
  const mirrorSeams = mirrorSeamPairs(base, nodes, genSet).map((s) => ({ a: base[s.a], b: base[s.b], dirs: s.dirs, files: s.files }));
  const live = base;
  const K = live.length;
  const clusterOf = new Array(n).fill(-1);
  live.forEach((c, ci) => {
    for (const m of c.members) clusterOf[m] = ci;
    for (const m of (c.mirror ? c.mirror.members : [])) clusterOf[m] = ci;
    for (const mv of c.moved) clusterOf[mv.from] = ci;
  });
  sweepList.forEach((sw, si) => { for (const m of [...sw.members, ...(sweepMirror.get(si) || [])]) clusterOf[m] = K + si; });
  /** @param {number} ci */
  const cid = (ci) => (ci < K ? `K${ci + 1}` : `S${ci - K + 1}`);

  // callers are recorded by absolute path; make them repo-relative for display
  const roots = [...new Set(nodes.filter((nd) => !nd.deleted && nd.rel
    && str(nd.raw.file).endsWith(nd.rel)).map((nd) => str(nd.raw.file).slice(0, -nd.rel.length)))]
    .sort((a, b) => b.length - a.length);
  /** @param {any} file */
  const relOf = (file) => {
    const f = str(file);
    for (const r of roots) if (r && f.startsWith(r)) return f.slice(r.length);
    return f;
  };

  // what a card says about its members: reach, tests, staleness
  /** @param {number[]} members */
  const describe = (members) => {
    const memberSet = new Set(members);
    const prod = new Set(), tests = new Map();
    /** @type {Map<number, number>} */
    const outside = new Map();
    let notUpdatedOutside = 0, notUpdatedInside = 0, incomplete = 0, riskyCount = 0, riskyAllUpdated = 0;
    for (const m of members) {
      const raw = nodes[m].raw;
      if (risky[m]) {
        riskyCount++;
        if (!(raw.stale || []).length) riskyAllUpdated++;
        for (const x of raw.stale || []) {
          const j = index.get(`${x.file}#${x.pos}`);
          if (j !== undefined && memberSet.has(j)) notUpdatedInside++; else notUpdatedOutside++;
        }
      }
      if (raw.callersComplete === false) incomplete++;
      const mine = new Set();
      for (const x of raw.callers || []) {
        if (x.test) { tests.set(`${relOf(x.file)}::${x.label}`, { label: str(x.label), relPath: relOf(x.file) }); continue; }
        const j = index.get(`${x.file}#${x.pos}`);
        if (j !== undefined && memberSet.has(j)) continue;
        prod.add(`${x.file}#${x.pos}`);
        mine.add(`${x.file}#${x.pos}`);
      }
      outside.set(m, mine.size);
    }
    const modCount = new Map();
    for (const m of members) {
      const k = str(nodes[m].raw.component);
      modCount.set(k, (modCount.get(k) || 0) + 1);
    }
    const module = [...modCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    // the anchor names the card: production code first, then a risky change, then the most
    // callers outside the card, then score, then id
    const anchor = members.slice().sort((a, b) => {
      const pa = isTestLike(nodes[a].rel) || isTestLike(str(nodes[a].raw.label)) ? 1 : 0;
      const pb = isTestLike(nodes[b].rel) || isTestLike(str(nodes[b].raw.label)) ? 1 : 0;
      return pa - pb || Number(risky[b]) - Number(risky[a]) || (outside.get(b) || 0) - (outside.get(a) || 0)
        || nodes[b].score - nodes[a].score || (nodes[a].id < nodes[b].id ? -1 : 1);
    })[0];
    return {
      module, anchor,
      testList: [...tests.keys()].sort().map((k) => tests.get(k)),
      stats: {
        members: members.length, callers: prod.size, tests: tests.size,
        notUpdated: notUpdatedOutside + notUpdatedInside, notUpdatedOutside, notUpdatedInside,
        incomplete, risky: riskyCount, riskyAllUpdated,
      },
    };
  };

  // the repeated patterns and signature deltas a card carries, for the hints step
  /** @param {number[]} members */
  const patternsOf = (members) => {
    /** @type {Map<string, number>} */
    const cnt = new Map();
    for (const m of members) for (const k of new Set(edits[m] || [])) {
      const rep = k === null ? undefined : repeated.get(k);
      if (rep && k !== null) cnt.set(k, rep.functions.length);
    }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map((e) => e[0]);
  };
  /** @param {number[]} members */
  const deltasOf = (members) => {
    const out = new Set();
    for (const m of members) {
      if (!risky[m]) continue;
      const d = tokenDiff(tokenize(str(nodes[m].raw.baseSig)), tokenize(str(nodes[m].raw.headSig)));
      for (const e of d || []) {
        if (e.removed.length > 6 || e.added.length > 6) continue;
        out.add(`${e.removed.join(' ')} → ${e.added.join(' ')}`);
      }
    }
    return [...out].sort().slice(0, 20);
  };

  const clusters = live.map((c, ci) => {
    const d = describe(c.members);
    const anchor = nodes[d.anchor];
    const others = c.members.length - 1;
    const mirrored = c.mirror ? c.mirror.members.slice().sort(byScoreThenId(nodes)) : [];
    // a card of test fakes and helpers only says so, so it is not read as production code
    const testOnly = c.members.every((m) => isTestLike(nodes[m].rel) || isTestLike(str(nodes[m].raw.label)));
    const base = others ? `${anchor.raw.label} and ${others} related` : str(anchor.raw.label);
    return {
      id: cid(ci),
      members: c.members.map((m) => nodes[m].id),
      anchor: anchor.id,
      label: testOnly ? `Test helpers: ${base}` : base,
      testHelpers: testOnly,
      files: [...new Set(c.members.map((m) => nodes[m].rel))].sort(),
      module: d.module,
      joined: c.joined,
      mirrorMembers: mirrored.map((m) => nodes[m].id),
      mirrorOf: c.mirror ? { dir: c.mirror.dirs.slice().sort()[0], dirs: c.mirror.dirs.slice().sort() } : null,
      moved: c.moved.map((mv) => ({ from: nodes[mv.from].id, to: nodes[mv.to].id })),
      hub: !!c.hub,
      siblings: !!c.siblings,
      generated: c.generated || null,
      patterns: patternsOf(c.members),
      signatureDeltas: deltasOf(c.members),
      // test callers kept for the hints step, capped; stats.tests is the full count
      testCallers: d.testList.slice(0, o.testCallerCap),
      stats: { ...d.stats, mirrored: mirrored.length },
    };
  });

  /** @type {any[]} */
  const sweeps = sweepList.map((sw, si) => {
    const d = describe(sw.members);
    const set = new Set(sw.members);
    const pats = [...repeated.entries()]
      .map(([key, v]) => ({ key, functions: v.functions.filter((i) => set.has(i)).length }))
      .filter((p) => p.functions > 0)
      .sort((x, y) => y.functions - x.functions || (x.key < y.key ? -1 : 1)).slice(0, 5);
    return {
      id: `S${si + 1}`,
      members: sw.members.map((m) => nodes[m].id),
      mirrorMembers: (sweepMirror.get(si) || []).map((m) => nodes[m].id),
      label: sw.other ? sw.label : shapeSweepLabel(sw.key, sw.members.length) || `Repeated edit in ${sw.members.length} functions: ${sw.key}`,
      pattern: sw.key,
      other: sw.other,
      patterns: pats,
      files: [...new Set(sw.members.map((m) => nodes[m].rel))].sort(),
      module: d.module,
      stats: d.stats,
    };
  });

  // 7. seams
  const seams = [];
  /** @param {number} a @param {number} b */
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // call: a call link between members of different clusters (or a cluster and a sweep)
  /** @type {Map<string, {clusters: number[], via: Array<{callee: string, caller: string}>}>} */
  const callMap = new Map();
  for (const e of edges) {
    const a = clusterOf[e.callee], b = clusterOf[e.caller];
    if (a === b || a < 0 || b < 0) continue;
    getOr(callMap, pairKey(a, b), () => ({ clusters: [Math.min(a, b), Math.max(a, b)], via: [] }))
      .via.push({ callee: nodes[e.callee].id, caller: nodes[e.caller].id });
  }
  for (const v of callMap.values()) {
    v.via.sort((x, y) => (x.callee + x.caller < y.callee + y.caller ? -1 : 1));
    const { list, count } = capList(v.via, o.viaCap);
    seams.push({ type: 'call', clusters: v.clusters.map(cid), via: list, viaCount: count });
  }

  // meeting: one unchanged production caller reaches members of two or more clusters
  /** @type {Map<string, {label: string, relPath: string, cl: Set<number>, via: Set<string>}>} */
  const meet = new Map();
  nodes.forEach((nd, i) => {
    if (clusterOf[i] < 0) return;
    for (const x of nd.raw.callers || []) {
      if (x.test) continue;
      const key = `${x.file}#${x.pos}`;
      if (index.has(key)) continue; // changed caller: that is a call link, not a meeting point
      const mt = getOr(meet, key, () => ({ label: str(x.label), relPath: relOf(x.file), cl: new Set(), via: new Set() }));
      mt.cl.add(clusterOf[i]); mt.via.add(nodes[i].id);
    }
  });
  for (const mt of meet.values()) {
    if (mt.cl.size < 2) continue;
    const { list, count } = capList([...mt.via].sort(), o.viaCap);
    seams.push({
      type: 'meeting',
      clusters: [...mt.cl].sort((a, b) => a - b).map(cid),
      at: { label: mt.label, relPath: mt.relPath },
      via: list, viaCount: count,
    });
  }

  // type (approximate): cluster A changes methods of class T and a member of cluster B
  // names T in its signature; one seam per pair of clusters (both directions merged). A
  // type changed in 3 or more clusters (a hub type such as Context) links everything, so
  // it is left out. A signature mention is not proof that B uses T's behaviour.
  /** @type {Map<string, Set<number>>} */
  const owners = new Map();
  nodes.forEach((nd, i) => {
    const t = str(nd.raw.className);
    if (t.length < o.minTypeName || clusterOf[i] < 0) return;
    getOr(owners, t, () => new Set()).add(clusterOf[i]);
  });
  /** @type {Map<string, {pair: number[], dirs: Set<string>, types: Set<string>, via: Set<string>}>} */
  const typeMap = new Map();
  nodes.forEach((nd, i) => {
    if (nd.deleted || clusterOf[i] < 0) return;
    const b = clusterOf[i];
    for (const w of wordsOf(`${str(nd.raw.headSig)} ${str(nd.raw.baseSig)}`)) {
      const own = owners.get(w);
      if (!own || own.size >= 3) continue;
      for (const a of own) {
        if (a === b) continue;
        const rec = getOr(typeMap, pairKey(a, b), () => ({ pair: [Math.min(a, b), Math.max(a, b)], dirs: new Set(), types: new Set(), via: new Set() }));
        rec.dirs.add(`${cid(a)}>${cid(b)}`); rec.types.add(w); rec.via.add(nd.id);
      }
    }
  });
  for (const v of typeMap.values()) {
    const types = capList([...v.types].sort(), o.viaCap);
    const via = capList([...v.via].sort(), o.viaCap);
    seams.push({
      type: 'type', approximate: true, clusters: v.pair.map(cid), directions: [...v.dirs].sort(),
      types: types.list, typeCount: types.count, via: via.list, viaCount: via.count,
    });
  }

  // mirror: two clusters duplicate each other but neither (or both) is a known generated folder
  for (const m of mirrorSeams) {
    const a = live.indexOf(m.a), b = live.indexOf(m.b);
    if (a < 0 || b < 0) continue;
    seams.push({ type: 'mirror', clusters: [cid(a), cid(b)], dirs: m.dirs, files: m.files });
  }

  /** @type {Record<string, number>} */
  const order = { call: 0, meeting: 1, type: 2, mirror: 3 };
  /** @param {string} id */
  const num = (id) => `${id[0]}${String(Number(id.slice(1))).padStart(6, '0')}`;
  /** @param {any} s */
  const sk = (s) => s.clusters.map((/** @type {string} */ c) => num(c)).join(',')
    + `|${s.at ? `${s.at.relPath}#${s.at.label}` : ''}`;
  seams.sort((a, b) => order[a.type] - order[b.type] || (sk(a) < sk(b) ? -1 : sk(a) > sk(b) ? 1 : 0));
  return { version: 1, clusters, sweeps, seams, rules };
}

module.exports = { buildClusters, isTestLike };
