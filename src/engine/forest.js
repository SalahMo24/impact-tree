'use strict';

const idOf = (c) => `${c.file}#${c.namePos}`;

// A changed caller nests under the changed symbol it calls (the tree hangs callers
// beneath callees), so the roots are the changed symbols that call no OTHER changed
// symbol. Recursion is not a reason to nest: `walk` calling `walk` stays a root.
//
// A cycle (`ping` <-> `pong`) nests every member under another and, with no member
// reachable from any root, the whole group vanished. So work on strongly connected
// components: a component nothing outside it reaches is promoted through its
// highest-scoring member. Returns the Set of ids that are NOT roots.
function nestedIds(changed) {
  const ids = changed.map(idOf);
  const index = new Map(ids.map((id, i) => [id, i]));
  changed.forEach((c, i) => {
    if (c.isConstructor && c.classNamePos != null) index.set(`${c.file}#${c.classNamePos}`, i);
  });
  // edge callee -> caller, both changed, self-loops dropped
  const out = changed.map((c, i) => [...new Set((c.callers || [])
    .map((x) => index.get(`${x.file}#${x.pos}`))
    .filter((j) => j !== undefined && j !== i))]);
  const nested = new Set();
  out.forEach((edges) => edges.forEach((j) => nested.add(ids[j])));

  // Tarjan, iterative: deep call chains must not blow the stack
  const n = changed.length;
  const idx = new Array(n).fill(-1), low = new Array(n).fill(0), comp = new Array(n).fill(-1);
  const onStack = new Array(n).fill(false), stack = [];
  let counter = 0, comps = 0;
  for (let s = 0; s < n; s++) {
    if (idx[s] !== -1) continue;
    const work = [[s, 0]];
    idx[s] = low[s] = counter++; stack.push(s); onStack[s] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, k] = top;
      if (k < out[v].length) {
        top[1]++;
        const w = out[v][k];
        if (idx[w] === -1) { idx[w] = low[w] = counter++; stack.push(w); onStack[w] = true; work.push([w, 0]); }
        else if (onStack[w]) low[v] = Math.min(low[v], idx[w]);
        continue;
      }
      work.pop();
      if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
      if (low[v] === idx[v]) {
        let w;
        do { w = stack.pop(); onStack[w] = false; comp[w] = comps; } while (w !== v);
        comps++;
      }
    }
  }
  const reachedFromOutside = new Array(comps).fill(false);
  out.forEach((edges, i) => edges.forEach((j) => { if (comp[j] !== comp[i]) reachedFromOutside[comp[j]] = true; }));
  const groups = Array.from({ length: comps }, () => []);
  comp.forEach((k, i) => groups[k].push(i));
  for (let k = 0; k < comps; k++) {
    if (reachedFromOutside[k]) continue;
    const members = groups[k];
    if (members.some((i) => !nested.has(ids[i]))) continue;
    const best = members.sort((a, b) => (changed[b].score || 0) - (changed[a].score || 0)
      || String(changed[a].label).localeCompare(String(changed[b].label)))[0];
    nested.delete(ids[best]);
  }
  return nested;
}

// The CLI forest uses the same rule as the view, so a change is never a root in one
// and missing from the other.
function seedRoots(changed) {
  const nested = nestedIds(changed);
  return changed.filter((c) => !nested.has(idOf(c)));
}

// Global visited set: counts distinct reachable symbols (not paths).
// Production callers only: blast radius is about reach through real code paths.
// `depth` is in call levels (the changed symbol's callers are level 1). `budget`, default
// 150, is in distinct callers visited: the walk stops as soon as that many are seen and
// `capped` is true, so a count of exactly `budget` also reads as capped (a lower bound).
async function blastRadius(resolver, file, pos, depth, budget = 150) {
  const seen = new Set();
  const walk = async (f, p, d) => {
    if (d > depth || seen.size >= budget) return;
    for (const c of await resolver.incoming(f, p, false)) {
      const id = `${c.file}#${c.pos}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size >= budget) return;
      await walk(c.file, c.pos, d + 1);
    }
  };
  await walk(file, pos, 1);
  return { count: seen.size, capped: seen.size >= budget };
}

// Path-local visited set with backtracking: cuts cycles along the current path while
// still letting a node appear under different roots (diamonds survive, cycles do not).
// `depth`, default 3, is in tree levels below the root: nodes at that level are not
// queried. `maxChildren`, default 8, is in production callers shown under one node: the
// rest are not expanded and are counted in that node's `truncated`. It limits what is
// rendered, not the query, which still loads every caller of the node.
async function buildTree(resolver, root, { depth = 3, maxChildren = 8, isChanged }) {
  const build = async (file, pos, d, onPath) => {
    if (d >= depth) return { children: [], truncated: 0 };
    // Tests only matter for the node the reviewer is looking at; deeper levels are
    // production-only so the 6000-file test program is not scanned repeatedly.
    const all = await resolver.incoming(file, pos, d === 0);
    // Tests are callers, but inlining them swamps the tree: one handler pulled in 74
    // spec files. Collapse to a count; the extension expands them on demand.
    const prod = all.filter((c) => !c.test);
    const tests = all.filter((c) => c.test);
    const shown = prod.slice(0, maxChildren);
    const children = [];
    for (const c of shown) {
      const id = `${c.file}#${c.pos}`;
      if (onPath.has(id)) { children.push({ ...c, cycle: true, children: [], truncated: 0 }); continue; }
      onPath.add(id);
      const sub = await build(c.file, c.pos, d + 1, onPath);
      onPath.delete(id);
      children.push({ ...c, changed: isChanged(id), cycle: false, ...sub });
    }
    return { children, truncated: prod.length - shown.length, testCount: tests.length, tests };
  };
  const rootId = `${root.file}#${root.namePos}`;
  return { ...root, ...(await build(root.file, root.namePos, 0, new Set([rootId]))) };
}
module.exports = { seedRoots, nestedIds, blastRadius, buildTree };
