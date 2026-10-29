// @ts-check
'use strict';
const path = require('path');
const { createSnapshotStore } = require('../engine/snapshot-store');

/**
 * Lazily creates the snapshot store for the workspace's repository. The store lives in the
 * extension's per-workspace storage (`context.storageUri`), so nothing is written to the
 * repository. Without a storage folder or a repository folder there is no store and the
 * caller falls back to a plain commit checkpoint.
 *
 * Owner: the activation that calls this. The first store created for a repository sweeps
 * the leftovers of an interrupted run in the background; a failure is logged.
 *
 * @param {{ storageUri?: { fsPath: string } | undefined }} context
 * @param {() => string} repoRoot Throws when no folder is open.
 * @param {(message: string) => void} log
 * @param {{ now?: () => number }} [options] `now` is the store's (see createSnapshotStore).
 * @returns {() => ReturnType<typeof createSnapshotStore> | null}
 */
function createSnapshotStoreGetter(context, repoRoot, log, { now } = {}) {
  /** @type {{ repo: string, store: ReturnType<typeof createSnapshotStore> } | null} */
  let current = null;
  return () => {
    if (!context.storageUri) return null;
    let repo;
    try { repo = repoRoot(); } catch { return null; }
    if (current && current.repo === repo) return current.store;
    const store = createSnapshotStore({ root: path.join(context.storageUri.fsPath, 'impact-tree'), repo, log, ...(now ? { now } : {}) });
    current = { repo, store };
    store.sweepTemp().catch((e) => log(`snapshots: sweeping temporary files failed: ${e.message}`));
    return store;
  };
}

module.exports = { createSnapshotStoreGetter };
