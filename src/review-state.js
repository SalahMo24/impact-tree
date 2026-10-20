'use strict';
// Progress is scoped to the review (repository/branch or PR). Row identities
// include both revisions of the symbol and its parent review context.

const KEY = 'impactTree.reviewed';
const PREFIX = `${KEY}.`;
const META_KEY = 'impactTree.reviewedMeta';
const META_VERSION = 1;
const META_MAX_ENTRIES = 1000;

// Last-use bookkeeping for cleanup (docs/UX_PLAN.md F5), stored apart from the ticks so
// an older build that reads only `impactTree.reviewed.*` is unaffected:
//   impactTree.reviewedMeta = { version: 1, keys: { [baseKey]: { lastUsedMs, branch } } }
// `baseKey` is the part after `impactTree.reviewed.`. A key without an entry (stored
// before this existed) is "never stamped": cleanup never ages it out.

/**
 * Reads the meta, dropping anything invalid. An unknown version or shape reads as empty.
 * @param {{ get: (k: string) => any }|null|undefined} memento
 * @param {((m: string) => void)|null} [log] Told once per call when stored meta is unusable.
 * @returns {Record<string, { lastUsedMs: number, branch: string|null }>}
 */
function readMeta(memento, log) {
  const raw = memento ? memento.get(META_KEY) : undefined;
  if (raw === undefined) return {};
  const keys = raw && typeof raw === 'object' && raw.version === META_VERSION ? raw.keys : null;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    if (log) log('review progress usage data is unreadable and was ignored');
    return {};
  }
  const out = Object.create(null);
  for (const k of Object.keys(keys)) {
    const e = keys[k];
    if (e && Number.isFinite(e.lastUsedMs) && (e.branch === null || typeof e.branch === 'string')) {
      out[k] = { lastUsedMs: e.lastUsedMs, branch: e.branch };
    }
  }
  return out;
}

/** Stores `keys`, keeping the `META_MAX_ENTRIES` most recently used. */
function writeMeta(memento, keys) {
  const names = Object.keys(keys);
  if (names.length > META_MAX_ENTRIES) {
    names.sort((a, b) => keys[b].lastUsedMs - keys[a].lastUsedMs);
    names.length = META_MAX_ENTRIES;
  }
  const kept = {};
  for (const n of names) kept[n] = keys[n];
  return memento.update(META_KEY, { version: META_VERSION, keys: kept });
}

/**
 * The review keys stored in `memento`, joined with their usage data, for cleanup.
 * `key` is the full workspaceState key. Returns [] when the memento cannot list keys.
 * @param {{ keys?: () => readonly string[], get: (k: string) => any }|null|undefined} memento
 * @param {((m: string) => void)|null} [log]
 * @returns {Array<{ key: string, lastUsedMs: number|null, branch: string|null }>}
 */
function listReviewKeys(memento, log) {
  if (!memento || typeof memento.keys !== 'function') return [];
  const meta = readMeta(memento, log);
  return memento.keys()
    .filter((k) => k.startsWith(PREFIX) && k !== META_KEY && memento.get(k) !== undefined)
    .map((key) => {
      const e = meta[key.slice(PREFIX.length)];
      return { key, lastUsedMs: e ? e.lastUsedMs : null, branch: e ? e.branch : null };
    });
}

/**
 * Removes review keys and their usage data. Keys outside `impactTree.reviewed.` are ignored.
 * @param {{ get: (k: string) => any, update: (k: string, v: any) => any }} memento
 * @param {string[]} keys Full workspaceState keys.
 * @returns {Promise<void>}
 */
async function deleteReviewKeys(memento, keys) {
  const doomed = keys.filter((k) => k.startsWith(PREFIX) && k !== META_KEY);
  if (!doomed.length) return;
  const meta = readMeta(memento);
  for (const k of doomed) delete meta[k.slice(PREFIX.length)];
  await Promise.all(doomed.map((k) => memento.update(k, undefined)));
  await writeMeta(memento, meta);
}

/**
 * @param {object|null} memento VS Code Memento (workspaceState) or a stand-in; null keeps nothing.
 * @param {{ now?: () => number, log?: ((m: string) => void)|null }} [opts] `now` is the clock for
 *   last-use stamps.
 */
function createReviewState(memento, { now = Date.now, log = null } = {}) {
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
  const load = (base, migrateFrom, branch) => {
    baseKey = base || 'none';
    stamp(branch);
    const raw = memento ? memento.get(`${KEY}.${baseKey}`) : null;
    reviewed = new Set(Array.isArray(raw) ? raw : []);
    if (raw !== undefined || !memento || !migrateFrom) return;
    const old = [].concat(migrateFrom).map((k) => memento.get(`${KEY}.${k}`)).find(Array.isArray);
    if (!old) return;
    reviewed = new Set(old);
    persist();
  };
  let metaLogged = false;
  // Records that the review under baseKey was used now; `branch` is null for a review that
  // belongs to no branch (a pull request) or whose branch is unknown. An existing branch is
  // kept when the caller does not know it (useBase).
  const stamp = (branch) => {
    if (!memento) return;
    const meta = readMeta(memento, metaLogged ? null : log);
    metaLogged = true;
    const prev = meta[baseKey];
    meta[baseKey] = { lastUsedMs: now(), branch: branch === undefined ? (prev ? prev.branch : null) : branch };
    // A lost stamp only delays cleanup; it must not surface as an unhandled rejection.
    Promise.resolve(writeMeta(memento, meta)).then(undefined, (e) => { if (log) log(`review progress usage was not saved: ${e && e.message}`); });
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
     * @param {{ migrateFrom?: string|string[], branch?: string|null }} [opts] `branch` is the local branch
     *   the review belongs to for cleanup; null (the default) for pull requests and when unknown.
     *   `migrateFrom` is the key `context` replaces, or
     *   those it replaces in order of preference; the ticks of the first with any are copied the
     *   first time `context` is loaded.
     */
    configure(context, identify, { migrateFrom, branch = null } = {}) {
      identity = identify;
      if (context !== baseKey) load(context, migrateFrom, branch);
    },
    id,
    /** Rebind to a base SHA. Judgements do not carry across bases. */
    useBase(base) { if (base !== baseKey) load(base, undefined, undefined); },
    isReviewed: (id) => reviewed.has(id),
    set(id, on) { if (on) reviewed.add(id); else reviewed.delete(id); persist(); },
    /** Marks every id in `ids` reviewed or not, and stores them once. */
    setAll(ids, on) {
      for (const i of ids) { if (on) reviewed.add(i); else reviewed.delete(i); }
      persist();
    },
    clear() { reviewed.clear(); persist(); },
    size: () => reviewed.size,
    /** The workspaceState key of the review now loaded, or null before one is; cleanup keeps it. */
    activeKey: () => (memento && baseKey ? `${KEY}.${baseKey}` : null),
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

module.exports = { createReviewState, nodeId, listReviewKeys, deleteReviewKeys, META_KEY, META_MAX_ENTRIES };
