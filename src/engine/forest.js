'use strict';

// Roots are changed symbols that no *changed* symbol calls. Everything else nests, so
// one change does not appear both as its own root and inside another tree.
function seedRoots(changed, changedKeys) {
  return changed.filter((c) => !(c.callers || []).some((x) => changedKeys.has(`${x.file}#${x.pos}`)));
}

// Global visited set: counts distinct reachable symbols (not paths).
// Production callers only: blast radius is about reach through real code paths.
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
module.exports = { seedRoots, blastRadius, buildTree };
