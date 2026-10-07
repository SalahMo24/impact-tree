// @ts-check
'use strict';
// Viewed sync (review-loop L6): a file whose counting rows are all ticked is marked viewed
// on GitHub, one row unticked unmarks it, and a file GitHub reports VIEWED has its rows
// ticked here. Only for the review of a GitHub pull request; the store knows no target for
// a local or agent review, so nothing here acts for one.
//
// Two layers (CODING_STYLE §7). The pure core (`recordWant`, `nextWrite`, `finishWrite`,
// `noteFor`) decides, per file, what to write and what to show, from the file's record and
// what GitHub is known to hold. The adapter (`createViewedSync`) wires the provider's
// tick events and the review store to it, owns the write queue and repaints.
//
// Decisions that are easy to get wrong, recorded here because tests and UI depend on them:
// - Writes are driven by local ticks only. A load only resumes queued writes. So a file that is fully
//   ticked locally while GitHub says UNVIEWED (or DISMISSED) is left alone after a load:
//   writing there would make two devices fight over the mark. The next local tick decides.
// - GitHub never destroys local progress. `VIEWED` adds ticks; `UNVIEWED` and `DISMISSED`
//   remove none. `DISMISSED` only says "changed since viewed": rows whose content-based
//   ids are still ticked stay ticked, and the row shows `👁 changed` until all are ticked.
// - Ticks applied from GitHub's `VIEWED` go through the provider's normal tick path (so
//   repaint rules hold) under an `applying` guard, so they are never echoed back as a
//   write. The guard is explicit rather than relying on "desired equals GitHub".
// - A file whose write is queued, in flight or failed is never re-ticked from GitHub: its
//   local state is the newer intent, and a reload that still shows the old mark must not
//   undo it.

const { reviewDataOf } = require('./pr-review-store');
const { collectTickTargets, treeItemId } = require('./review-tree-model');

// The write queue is a bounded resource (CODING_STYLE §2).
//   Unit: files waiting for their write, not counting the one in flight (one write runs at a time).
//   Default: 200. Valid range: a positive safe integer.
//   Why: the store runs one GitHub operation at a time and reloads the whole review after
//   each write, so a write costs about a round trip plus a reload; 200 files is a few
//   minutes of background work, well above any one review gesture, and a larger number
//   means the reviewer ticked the whole PR at once, where retrying later is acceptable.
//   Owner: one `createViewedSync`. Enforcement: when a file would join the queue.
//   Exhaustion: the file is marked `failed` (`viewed not synced`, with Retry); its ticks
//   stay, and nothing is dropped silently. Retry is accepted once the queue has room.
const MAX_QUEUED_WRITES = 200;

/**
 * One file's sync record. Absent from the adapter's map when the file is in sync.
 * - `want`: the latest desired mark (true = viewed), set by a local tick; null once settled.
 * - `sent`: the value of the write in flight, null when none.
 * - `failed`: the last write failed and nothing was sent since; Retry sends `want` again.
 * @typedef {{ want: boolean|null, sent: boolean|null, failed: boolean }} FileSync
 */
/** @typedef {import('./tree-item-renderer').ViewedNote} ViewedNote */
/** @typedef {'VIEWED'|'UNVIEWED'|'DISMISSED'|undefined} GithubViewed */

/** @type {Readonly<FileSync>} */
const IDLE = Object.freeze({ want: null, sent: null, failed: false });

/** Whether GitHub counts the file as viewed; DISMISSED and UNVIEWED do not, nor does unknown. */
const isViewed = (/** @type {GithubViewed} */ github) => github === 'VIEWED';

/**
 * A local tick left the file's rows all ticked or not: that is the latest desired mark.
 * A newer desire replaces an older one, queued or not; an in-flight write is untouched.
 * @param {FileSync|undefined} record
 * @param {boolean} allTicked
 * @returns {FileSync}
 */
const recordWant = (record, allTicked) => ({ ...(record || IDLE), want: allTicked, failed: false });

/**
 * The value to write now, or null when there is nothing to send: no desire, a write
 * already in flight (one per file), or GitHub already holds what is wanted.
 * @param {FileSync} record
 * @param {GithubViewed} github
 * @returns {boolean|null}
 */
function nextWrite(record, github) {
  if (record.sent !== null || record.want === null) return null;
  return record.want === isViewed(github) ? null : record.want;
}

/**
 * The record after the write in flight finished. `github` is what GitHub holds now (for a
 * successful write, after the store's reload).
 * - Settled (null): the desire is met, either because GitHub holds it, or because the
 *   write that succeeded carried it. No second write chases a stale reload.
 * - A success with a newer desire that GitHub does not hold keeps `want`, so the caller
 *   sends it next (the superseding rule). It is sent only if it differs from `github`.
 * - A failure keeps `want` and is marked `failed`; nothing is retried automatically.
 * @param {FileSync} record
 * @param {boolean} ok
 * @param {GithubViewed} github
 * @returns {FileSync|null}
 */
function finishWrite(record, ok, github) {
  const next = { ...record, sent: null };
  if (next.want === null || next.want === isViewed(github)) return null;
  if (ok && next.want === record.sent) return null;
  return ok ? next : { ...next, failed: true };
}

/**
 * What a file row says, or null when in sync.
 * @param {FileSync|undefined} record
 * @param {GithubViewed} github
 * @param {boolean} allTicked
 * @returns {ViewedNote|null}
 */
function noteFor(record, github, allTicked) {
  if (record && record.failed) return 'failed';
  if (record && record.want !== null) return 'syncing';
  return github === 'DISMISSED' && !allTicked ? 'changed' : null;
}

/** @param {{ owner: string, name: string, number: number, headOid: string }|null} target @returns {string|null} */
const keyOf = (target) => (target ? `${target.owner}/${target.name}#${target.number}@${target.headOid}` : null);

/**
 * @typedef {import('./tree-row-models').TreeRow} TreeRow
 * @typedef {{
 *   fileRows: () => TreeRow[],
 *   isReviewed: (row: TreeRow) => boolean,
 *   setCheckedBatch: (changes: Array<{ row: TreeRow, on: boolean }>) => void,
 *   refreshFiles: (relPaths: Iterable<string>) => void,
 *   onDidChangeReview: (listener: (e: import('./tree-provider').ReviewProgress) => void) => { dispose: () => void },
 *   onDidChangePresentation: (listener: (e: { reason: string }) => void) => { dispose: () => void },
 * }} ViewedProvider
 * @typedef {Pick<import('./pr-review-store').PullRequestReviewStore, 'getState'|'onDidChange'|'setViewed'>} ViewedStore
 */

/**
 * Creates the adapter. Owner of: three subscriptions (tick events, presentation events,
 * store changes), the per-file records, the write queue and the single write in flight.
 * `dispose()` removes the subscriptions, empties the queue and makes any write still in
 * flight publish nothing when it settles (GitHub may still apply it).
 * Every promise it starts is the store's `setViewed`, which settles with a result and
 * does not reject; both outcomes are handled anyway, and tagged with the generation of
 * the review they were sent for, so a result for a pull request no longer shown is dropped.
 * @param {{
 *   provider: ViewedProvider, store: ViewedStore,
 *   isCurrentAnalysis?: (analysisId: number) => boolean,
 *   log?: (message: string) => void, maxQueuedWrites?: number,
 * }} deps
 */
function createViewedSync({ provider, store, isCurrentAnalysis = () => true, log = () => {}, maxQueuedWrites = MAX_QUEUED_WRITES }) {
  if (!Number.isSafeInteger(maxQueuedWrites) || maxQueuedWrites < 1) throw new RangeError('maxQueuedWrites must be a positive integer');
  let disposed = false;
  // Bumped when the review the records belong to changes (or on dispose); a write result
  // carries the generation it was sent in and is ignored when it is not the current one.
  let generation = 0;
  /** @type {string|null} */
  let key = null;
  /** @type {Map<string, FileSync>} */
  const records = new Map();
  /** Paths waiting to be sent, oldest first. Bounded by `maxQueuedWrites` (see above). @type {string[]} */
  let queue = [];
  let writing = false;
  let applying = false;
  /** The viewed map last seen, to repaint only files whose GitHub state changed. @type {Map<string, string>|null} */
  let seen = null;

  const targetKey = () => {
    const state = store.getState();
    return state.kind === 'none' ? null : keyOf(state.target);
  };
  const modelOf = () => reviewDataOf(store.getState());
  /** @param {string} path @returns {GithubViewed} */
  const githubOf = (path) => { const model = modelOf(); return model ? model.viewed.get(path) : undefined; };
  /** Acting needs a pull request under review and data to compare with. */
  const active = () => key !== null && modelOf() !== null;
  /** @param {TreeRow} file */
  const allTicked = (file) => { const rows = collectTickTargets(file); return rows.length > 0 && rows.every(provider.isReviewed); };

  /** The review changed: nothing recorded for the old one means anything now. */
  function resetIfRetargeted() {
    const now = targetKey();
    if (now === key) return;
    const paths = [...records.keys()];
    key = now;
    generation++;
    records.clear();
    queue = [];
    writing = false;
    seen = null;
    if (paths.length) provider.refreshFiles(paths);
  }

  /** Puts a path in the queue, or fails it when the queue is full. @param {string} path */
  function enqueue(path) {
    if (queue.includes(path)) return;
    if (queue.length >= maxQueuedWrites) {
      const record = records.get(path);
      if (record) records.set(path, { ...record, failed: true });
      log(`viewed sync: the write queue is full (${maxQueuedWrites} files); ${path} was not queued`);
      return;
    }
    queue.push(path);
  }

  /** Sends the next write if none is in flight. Settled files drop out without a write. */
  function pump() {
    if (disposed || writing || store.getState().kind !== 'ready') return;
    /** @type {string[]} */
    const settled = [];
    while (queue.length) {
      const path = /** @type {string} */ (queue.shift());
      const record = records.get(path);
      if (!record || record.failed) continue;
      const value = nextWrite(record, githubOf(path));
      if (value === null) { records.delete(path); settled.push(path); continue; }
      records.set(path, { ...record, sent: value });
      writing = true;
      send(path, value);
      break;
    }
    if (settled.length) provider.refreshFiles(settled);
  }

  /** @param {string} path @param {boolean} viewed */
  function send(path, viewed) {
    const sentIn = generation;
    store.setViewed({ path, viewed }).then(
      (result) => done(sentIn, path, result),
      (error) => done(sentIn, path, { ok: false, error: error instanceof Error ? error : new Error(String(error)) }),
    ).catch((e) => log(`viewed sync: handling a result failed: ${e && e.message}`));
  }

  /**
   * @param {number} sentIn
   * @param {string} path
   * @param {{ ok: true } | { ok: false, error: Error }} result
   */
  function done(sentIn, path, result) {
    if (disposed || sentIn !== generation) return;
    writing = false;
    if (!result.ok) log(`viewed sync: marking ${path} ${records.get(path)?.sent ? 'viewed' : 'unviewed'} failed: ${result.error.message}`);
    const record = records.get(path);
    if (record) {
      const ready = store.getState().kind === 'ready';
      // A successful mutation may be followed by a failed reload. Its sent value is
      // still known; the preserved pre-write model must not cancel a newer desire.
      const github = ready ? githubOf(path) : result.ok ? (record.sent ? 'VIEWED' : 'UNVIEWED') : undefined;
      const next = !ready && !result.ok ? { ...record, sent: null, failed: true } : finishWrite(record, result.ok, github);
      if (!next) records.delete(path); else records.set(path, next);
      if (next && !next.failed) enqueue(path);
      provider.refreshFiles([path]);
    }
    pump();
  }

  /** @param {import('./tree-provider').ReviewProgress} event */
  function onTick(event) {
    if (disposed || applying) return;
    resetIfRetargeted();
    if (!active() || !isCurrentAnalysis(event.analysisId)) return;
    const changed = new Set(event.changedIds);
    for (const file of provider.fileRows()) {
      if (!changed.has(/** @type {string} */ (treeItemId(file)))) continue;
      const path = file.relPath;
      const record = recordWant(records.get(path), allTicked(file));
      records.set(path, record);
      if (record.sent === null) {
        if (store.getState().kind === 'ready' && nextWrite(record, githubOf(path)) === null) records.delete(path); else enqueue(path);
        pump();   // a free lane takes the first file at once, so it does not count against the queue
      }
    }
    // The tick repaints the files it touched, after this listener, and reads the new notes.
  }

  /**
   * Applies what GitHub holds to the shown review: ticks the rows of VIEWED files (a file
   * with a queued, running or failed write keeps its local state), and clears a failed
   * mark GitHub now agrees with. Repaints files whose GitHub state changed.
   */
  function reconcile() {
    if (disposed) return;
    resetIfRetargeted();
    const model = modelOf();
    if (!active() || !model || store.getState().kind !== 'ready') { seen = null; return; }
    /** @type {Array<{ row: TreeRow, on: boolean }>} */
    const ticks = [];
    const repaint = new Set();
    for (const file of provider.fileRows()) {
      const path = file.relPath;
      const github = model.viewed.get(path);
      const record = records.get(path);
      if (record && record.failed && record.want === isViewed(github)) { records.delete(path); repaint.add(path); }
      else if (!record && github === 'VIEWED' && !allTicked(file)) ticks.push({ row: file, on: true });
      if ((seen ? seen.get(path) : undefined) !== github) repaint.add(path);
    }
    seen = new Map(model.viewed);
    if (ticks.length) {
      applying = true;
      try { provider.setCheckedBatch(ticks); } finally { applying = false; }
    }
    // A tick repaints its own file; the rest are repainted here.
    for (const { row } of ticks) repaint.delete(row.relPath);
    if (repaint.size) provider.refreshFiles(repaint);
    pump();
  }

  key = targetKey();
  const subscriptions = [
    provider.onDidChangeReview(onTick),
    provider.onDidChangePresentation((e) => { if (e.reason === 'analysis') reconcile(); }),
    store.onDidChange(() => reconcile()),
  ];
  reconcile();

  return {
    /**
     * What a file row shows about the viewed mark.
     * @param {string} relPath
     * @param {boolean} ticked Whether all the file's counting rows are ticked.
     * @returns {ViewedNote|null}
     */
    statusOf(relPath, ticked) {
      if (disposed || !active()) return null;
      return noteFor(records.get(relPath), githubOf(relPath), ticked);
    },
    /**
     * Sends a failed file's current desired state again.
     * @param {string} relPath
     * @returns {boolean} Whether a retry was started: false for a file that has not failed.
     */
    retry(relPath) {
      const record = records.get(relPath);
      if (disposed || !record || !record.failed) return false;
      if (queue.length >= maxQueuedWrites) { log(`viewed sync: the write queue is full; retry ${relPath} later`); return false; }
      records.set(relPath, { ...record, failed: false });
      enqueue(relPath);
      provider.refreshFiles([relPath]);
      pump();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      for (const s of subscriptions) s.dispose();
      records.clear();
      queue = [];
      seen = null;
    },
  };
}

module.exports = { MAX_QUEUED_WRITES, recordWant, nextWrite, finishWrite, noteFor, createViewedSync };
