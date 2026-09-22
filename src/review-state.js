'use strict';
// What has the reviewer already cleared? Persisted per base SHA, because "reviewed"
// means "reviewed against this diff" -- if the base moves, the judgement is stale and
// the slate should be clean rather than silently carried forward.

const KEY = 'impactTree.reviewed';

function createReviewState(memento) {
  let baseKey = null;
  let reviewed = new Set();

  const load = (base) => {
    baseKey = base || 'none';
    const raw = memento ? memento.get(`${KEY}.${baseKey}`) : null;
    reviewed = new Set(Array.isArray(raw) ? raw : []);
  };
  const persist = () => {
    if (memento) memento.update(`${KEY}.${baseKey}`, [...reviewed]);
  };

  return {
    /** Rebind to a base SHA. Judgements do not carry across bases. */
    useBase(base) { if (base !== baseKey) load(base); },
    isReviewed: (id) => reviewed.has(id),
    set(id, on) { if (on) reviewed.add(id); else reviewed.delete(id); persist(); },
    /** Mark a node and everything we already know sits under it. */
    setWithChildren(id, childIds, on) {
      this.set(id, on);
      for (const c of childIds || []) { if (on) reviewed.add(c); else reviewed.delete(c); }
      persist();
    },
    clear() { reviewed.clear(); persist(); },
    size: () => reviewed.size,
    /** how many of `ids` remain unreviewed */
    remaining: (ids) => (ids || []).filter((i) => !reviewed.has(i)).length,
  };
}

// Stable identity for a row. Symbols are (file, declaration offset); files are paths.
const nodeId = (n) => {
  if (!n) return null;
  if (n.type === 'file') return `file:${n.relPath}`;
  if (n.type === 'deleted') return `del:${n.relPath}#${n.label}`;
  if (n.type === 'finding' || n.type === 'caller') return `${n.file}#${n.pos}`;
  // A file grouping several callers of the same change; ticking it ticks them all.
  if (n.type === 'callerFile') return `cfile:${n.relPath}`;
  return null;
};

module.exports = { createReviewState, nodeId };
