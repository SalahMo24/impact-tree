'use strict';
// Progress is scoped to the review (repository/branch or PR). Row identities
// include both revisions of the symbol and its parent review context.

const KEY = 'impactTree.reviewed';

function createReviewState(memento) {
  let baseKey = null;
  let reviewed = new Set();
  let identity = null;

  // A review loads under a new key for the first time when nothing is stored under it.
  // Only then are the ticks of the key it replaces copied (the first of several with
  // stored ticks), and the old keys are left untouched so an older build still finds
  // its own. Once the copy is stored (or the user has stored anything, even an empty
  // list) the new key is the only source: an untick or a clear is never undone by
  // copying again. Row identities include the reviewed content, so a copied tick shows
  // only on a row whose content is unchanged.
  const load = (base, migrateFrom) => {
    baseKey = base || 'none';
    const raw = memento ? memento.get(`${KEY}.${baseKey}`) : null;
    reviewed = new Set(Array.isArray(raw) ? raw : []);
    if (raw !== undefined || !memento || !migrateFrom) return;
    const old = [].concat(migrateFrom).map((k) => memento.get(`${KEY}.${k}`)).find(Array.isArray);
    if (!old) return;
    reviewed = new Set(old);
    persist();
  };
  const persist = () => {
    if (memento) memento.update(`${KEY}.${baseKey}`, [...reviewed]);
  };

  const id = (n) => {
    if (!identity) return nodeId(n);
    if (n.type === 'callerFile') return `group:${n.reviewParent}:${n.relPath}:${childIds(n).join('|')}`;
    if (n.type === 'changeFile' || n.type === 'insideGroup') return `${n.type}:${n.relPath}:${childIds(n).join('|')}`;
    const own = identity(n);
    return own ? `${n.type}:${n.reviewParent || 'root'}>${own}` : null;
  };
  const childIds = (n) => {
    if (n.type === 'callerFile') return (n.callers || []).map(id).filter(Boolean);
    // every change in the group, including those nested inside its rows
    if (n.type === 'changeFile' || n.type === 'insideGroup') return (n.members || []).map(id).filter(Boolean);
    if (n.type === 'finding') return (n.finding?.callers || []).map((c) => id({ ...c, type: 'caller', reviewParent: id(n) })).filter(Boolean);
    return [];
  };
  return {
    /**
     * Binds to the review `context` names, with the row identity function for it.
     * @param {string} context Key of the review being shown.
     * @param {((node: object) => string|null)|null} identify
     * @param {{ migrateFrom?: string|string[] }} [opts] `migrateFrom` is the key `context` replaces, or
     *   those it replaces in order of preference; the ticks of the first with any are copied the
     *   first time `context` is loaded.
     */
    configure(context, identify, { migrateFrom } = {}) {
      identity = identify;
      if (context !== baseKey) load(context, migrateFrom);
    },
    id, childIds,
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

// Legacy fallback for consumers without a configured review identity. The extension
// always configures content-based identities before displaying results.
const nodeId = (n) => {
  if (!n) return null;
  if (n.type === 'file') return `file:${n.relPath}`;
  if (n.type === 'deleted') return `del:${n.relPath}#${n.label}`;
  if (n.type === 'finding' || n.type === 'caller') return `${n.file}#${n.pos}`;
  // A file grouping several callers of the same change; ticking it ticks them all.
  if (n.type === 'callerFile') return `cfile:${n.relPath}`;
  if (n.type === 'changeFile' || n.type === 'insideGroup') return `${n.type}:${n.relPath}:${(n.members || []).map(nodeId).join('|')}`;
  return null;
};

module.exports = { createReviewState, nodeId };
