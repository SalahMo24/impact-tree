// @ts-check
'use strict';
// Retention policy for the data Impact Tree stores (docs/UX_PLAN.md, F5). Pure: it
// reads no disk, git or editor state and deletes nothing. The caller gathers the
// inputs, asks the user, and carries out the plan it returns.
//
// Work is bounded by the input sizes: one sort of the round snapshots and one pass
// over each list, O(n log n) in snapshots and O(m) in review keys, with no I/O.

/** @typedef {{ id: string, sha: string, objectsDir: string, createdAtMs: number,
 *   branch: string|null, headSha: string|null, round: number|null, bytes: number }} SnapshotRecord */
/** @typedef {{ key: string, lastUsedMs: number|null, branch: string|null }} ReviewKeyInfo */
/** @typedef {{ record: SnapshotRecord, reason: string }} SnapshotDeletion */
/** @typedef {{ key: string, reason: string }} ReviewKeyDeletion */
/** @typedef {{ snapshots: SnapshotDeletion[], reviewKeys: ReviewKeyDeletion[], clearCheckpoint: boolean }} CleanupPlan */

const DAY_MS = 86400000;
const MAX_DAYS = 3650;
const MAX_KEEP_ROUNDS = 50;
// A checkpoint is recorded just after its snapshot is taken; a sweep in between must not
// take the new snapshot for a replaced one.
const REPLACED_GRACE_MS = 3600000;

/** A snapshot that is not a round and not current: a newer checkpoint took its place. */
const REASON_REPLACED = 'replaced';
const REASON_BRANCH_DELETED = 'branch deleted';
/** Only with `includeCurrent`: the user asked for the current checkpoint to go too. */
const REASON_CURRENT = 'current checkpoint';

/** @param {number} days @returns {string} */
const snapshotAgeReason = (days) => `older than ${days} days`;
/** @param {number} days @returns {string} */
const reviewAgeReason = (days) => `unused for ${days} days`;

/**
 * @param {unknown} v
 * @param {string} name
 * @param {number} min
 * @param {number} max
 */
function requireInt(v, name, min, max) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${String(v)}`);
  }
}

/**
 * @param {unknown} snapshots
 * @param {unknown} reviewKeys
 * @param {unknown} liveBranches
 */
function validateCollections(snapshots, reviewKeys, liveBranches) {
  if (!Array.isArray(snapshots)) throw new RangeError('snapshots must be an array');
  if (!Array.isArray(reviewKeys)) throw new RangeError('reviewKeys must be an array');
  if (liveBranches !== null && !(liveBranches instanceof Set)) {
    throw new RangeError('liveBranches must be a Set, or null when unknown');
  }
  for (const s of snapshots) {
    if (!s || typeof s.sha !== 'string' || !Number.isFinite(s.createdAtMs)) {
      throw new RangeError('every snapshot needs a string sha and a finite createdAtMs');
    }
  }
  for (const k of reviewKeys) {
    if (!k || typeof k.key !== 'string') throw new RangeError('every review key needs a string key');
  }
}

/**
 * Decides what to delete. A branch is "gone" only when `liveBranches` is a Set that
 * lacks it; `null` means the branch list is unknown (for instance git failed) and
 * never counts as "gone".
 *
 * Snapshot rules, per record:
 * 1. The current checkpoint (sha === currentCheckpointSha) is kept, unless `includeCurrent`
 *    (then reason 'current checkpoint' and `clearCheckpoint` is true).
 * 2. Among records with a non-null `round` (the current one counts, if it is a round),
 *    the `keepRounds` newest by createdAtMs are kept whatever their age or branch.
 * 3. Any other round record is deleted when strictly older than `snapshotMaxAgeDays`
 *    ('older than N days') or when its branch is gone ('branch deleted'); else kept.
 * 4. A record without a round that is not current was replaced by a newer
 *    checkpoint: 'replaced', once it is more than an hour old (it may be a snapshot whose
 *    checkpoint is still being recorded).
 * Review keys: deleted when lastUsedMs is known and strictly older than
 * `reviewMaxAgeDays` ('unused for N days') or when its branch is gone ('branch deleted');
 * a null lastUsedMs never ages out; `activeReviewKey` (a full workspaceState key) is never deleted.
 *
 * @param {{ nowMs: number, snapshots: SnapshotRecord[], currentCheckpointSha: string|null,
 *   liveBranches: Set<string>|null, reviewKeys: ReviewKeyInfo[], activeReviewKey?: string|null,
 *   keepRounds?: number, snapshotMaxAgeDays?: number, reviewMaxAgeDays?: number,
 *   includeCurrent?: boolean }} input
 * @returns {CleanupPlan}
 * @throws {RangeError} on invalid input; this is internal data, not user input.
 */
function planCleanup(input) {
  const {
    nowMs, snapshots, currentCheckpointSha, liveBranches, reviewKeys,
    activeReviewKey = null, keepRounds = 2, snapshotMaxAgeDays = 30,
    reviewMaxAgeDays = 90, includeCurrent = false,
  } = input;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new RangeError('nowMs must be a finite number');
  requireInt(keepRounds, 'keepRounds', 0, MAX_KEEP_ROUNDS);
  requireInt(snapshotMaxAgeDays, 'snapshotMaxAgeDays', 1, MAX_DAYS);
  requireInt(reviewMaxAgeDays, 'reviewMaxAgeDays', 1, MAX_DAYS);
  validateCollections(snapshots, reviewKeys, liveBranches);

  /** @param {string|null|undefined} branch */
  const branchGone = (branch) => liveBranches !== null && branch != null && !liveBranches.has(branch);
  const isCurrent = (/** @type {SnapshotRecord} */ r) => currentCheckpointSha != null && r.sha === currentCheckpointSha;

  const newestRounds = new Set(
    snapshots
      .filter((r) => r.round != null && !(isCurrent(r) && includeCurrent))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, keepRounds),
  );

  const snapAge = snapshotMaxAgeDays * DAY_MS;
  /** @type {SnapshotDeletion[]} */
  const doomedSnapshots = [];
  let clearCheckpoint = false;
  for (const record of snapshots) {
    if (isCurrent(record)) {
      if (includeCurrent) {
        doomedSnapshots.push({ record, reason: REASON_CURRENT });
        clearCheckpoint = true;
      }
    } else if (record.round == null) {
      if (nowMs - record.createdAtMs > REPLACED_GRACE_MS) doomedSnapshots.push({ record, reason: REASON_REPLACED });
    } else if (newestRounds.has(record)) {
      // kept: one of the newest rounds
    } else if (nowMs - record.createdAtMs > snapAge) {
      doomedSnapshots.push({ record, reason: snapshotAgeReason(snapshotMaxAgeDays) });
    } else if (branchGone(record.branch)) {
      doomedSnapshots.push({ record, reason: REASON_BRANCH_DELETED });
    }
  }

  const reviewAge = reviewMaxAgeDays * DAY_MS;
  /** @type {ReviewKeyDeletion[]} */
  const doomedKeys = [];
  for (const k of reviewKeys) {
    if (k.key === activeReviewKey) continue;
    if (k.lastUsedMs != null && Number.isFinite(k.lastUsedMs) && nowMs - k.lastUsedMs > reviewAge) {
      doomedKeys.push({ key: k.key, reason: reviewAgeReason(reviewMaxAgeDays) });
    } else if (branchGone(k.branch)) {
      doomedKeys.push({ key: k.key, reason: REASON_BRANCH_DELETED });
    }
  }
  return { snapshots: doomedSnapshots, reviewKeys: doomedKeys, clearCheckpoint };
}

/**
 * Formats a byte count with 1024-based units: B and KB are whole numbers, MB and GB
 * have one decimal. A negative or non-finite count formats as 0 B.
 * @param {number} n
 * @returns {string}
 */
function formatBytes(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(1)} GB`;
}

/** @param {string} reason @returns {string} */
function snapshotLabel(reason) {
  if (reason === REASON_BRANCH_DELETED) return 'Checkpoints for deleted branches';
  if (reason === REASON_REPLACED) return 'Checkpoints replaced by a newer checkpoint';
  if (reason === REASON_CURRENT) return 'The current checkpoint';
  return 'Checkpoints from older feedback rounds';
}

/** @param {string} reason @returns {string} */
function reviewLabel(reason) {
  return reason === REASON_BRANCH_DELETED
    ? 'Review progress for deleted branches'
    : 'Review progress not used for a long time';
}

/**
 * Rows for the confirmation dialog: snapshots then review progress, one row per
 * label with at least one item (zero-count rows are omitted). Snapshot sizes come from
 * each record's `bytes`; review keys have no size of their own, so `sizes.reviewKeys`
 * maps a key to its stored size (missing counts as 0).
 * @param {CleanupPlan} plan
 * @param {{ reviewKeys?: Map<string, number> }} [sizes]
 * @returns {Array<{ label: string, group: string, count: number, bytes: number }>}
 *   `group` is the label without its count, the same for every item of one kind.
 */
function summarize(plan, sizes = {}) {
  /** @type {Map<string, { label: string, count: number, bytes: number }>} */
  const rows = new Map();
  const add = (/** @type {string} */ label, /** @type {number} */ bytes) => {
    const row = rows.get(label) || { label, count: 0, bytes: 0 };
    row.count += 1;
    row.bytes += Number.isFinite(bytes) ? bytes : 0;
    rows.set(label, row);
  };
  for (const { record, reason } of plan.snapshots) add(snapshotLabel(reason), record.bytes);
  for (const { key, reason } of plan.reviewKeys) {
    add(reviewLabel(reason), (sizes.reviewKeys && sizes.reviewKeys.get(key)) || 0);
  }
  return [...rows.values()].map((r) => ({ label: `${r.label} (${r.count})`, group: r.label, count: r.count, bytes: r.bytes }));
}

module.exports = {
  planCleanup, summarize, formatBytes, snapshotLabel, reviewLabel,
  REASON_REPLACED, REASON_BRANCH_DELETED, REASON_CURRENT, snapshotAgeReason, reviewAgeReason,
};
