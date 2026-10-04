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
    const own = identity(n);
    return own ? `${n.type}:${n.reviewParent || 'root'}>${own}` : null;
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
    id,
    /** Rebind to a base SHA. Judgements do not carry across bases. */
    useBase(base) { if (base !== baseKey) load(base); },
    isReviewed: (id) => reviewed.has(id),
    set(id, on) { if (on) reviewed.add(id); else reviewed.delete(id); persist(); },
    /** Marks every id in `ids` reviewed or not, and stores them once. */
    setAll(ids, on) {
      for (const i of ids) { if (on) reviewed.add(i); else reviewed.delete(i); }
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
  if (n.type === 'outside') return `outside:${n.relPath}`;
  if (n.type === 'finding' || n.type === 'caller') return `${n.file}#${n.pos}`;
  return null;
};

module.exports = { createReviewState, nodeId };
