// @ts-check
'use strict';
// Carries out the retention policy of storage-cleanup.js (docs/UX_PLAN.md F5): gathers what
// is stored, applies the plan, and offers the "Clean up stored data" command. Feedback files
// in `.impact-tree/feedback/` are never listed, moved or deleted here.
//
// The automatic run (after startup and after each send) applies the policy without asking;
// it never deletes the current checkpoint. The command shows what it will delete, with
// sizes, and asks first; only there can the current checkpoint go too.

const { planCleanup, summarize, formatBytes, snapshotLabel, reviewLabel } = require('./storage-cleanup');
const { listReviewKeys, deleteReviewKeys } = require('./review-state');
const { makeGit } = require('./engine/git');

/** @param {unknown} e */
const errorText = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @typedef {{
 *   getSnapshotStore: () => any,
 *   workspaceState: { get: (k: string) => any, update: (k: string, v: any) => PromiseLike<void>, keys?: () => readonly string[] },
 *   session: any,
 *   review: { activeKey: () => string|null },
 *   log: (m: string) => void,
 *   now?: () => number,
 * }} CleanupDeps
 */

/**
 * Local branch names, or null when git could not list them (then no branch counts as gone).
 * @param {string} repo
 * @returns {Promise<Set<string>|null>}
 */
async function liveBranchesOf(repo) {
  try {
    const out = await makeGit(repo).rawAsync(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { timeoutMs: 10000 });
    return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * The plan for now, and the inputs it was made from.
 * @param {CleanupDeps} deps
 * @param {{ includeCurrent?: boolean }} [o]
 */
async function gather(deps, { includeCurrent = false } = {}) {
  const store = deps.getSnapshotStore();
  let repo = null;
  try { repo = deps.session.repoRoot(); } catch { /* no folder: no branches, no snapshots */ }
  const snapshots = store ? store.list() : [];
  const reviewKeys = listReviewKeys(deps.workspaceState, deps.log);
  const plan = planCleanup({
    nowMs: (deps.now || Date.now)(),
    snapshots,
    currentCheckpointSha: (deps.session.state && deps.session.state.checkpoint) || null,
    liveBranches: repo ? await liveBranchesOf(repo) : null,
    reviewKeys,
    activeReviewKey: deps.review.activeKey(),
    includeCurrent,
  });
  return { store, plan };
}

/**
 * Applies a plan. A snapshot that cannot be removed is logged and left for the next run.
 * @param {CleanupDeps} deps
 * @param {any} store
 * @param {import('./storage-cleanup').CleanupPlan} plan
 * @returns {Promise<{ snapshots: number, reviewKeys: number }>}
 */
async function apply(deps, store, plan) {
  let snapshots = 0;
  for (const { record, reason } of plan.snapshots) {
    try {
      if (await store.remove(record.id)) snapshots++;
      deps.log(`cleanup: removed snapshot ${record.id} (${reason})`);
    } catch (e) {
      deps.log(`cleanup: could not remove snapshot ${record.id}: ${errorText(e)}`);
    }
  }
  const keys = plan.reviewKeys.map((k) => k.key);
  if (keys.length) await deleteReviewKeys(/** @type {any} */ (deps.workspaceState), keys);
  if (plan.clearCheckpoint) {
    deps.session.setCheckpoint(undefined);
    await deps.workspaceState.update('impactTree.checkpoint', undefined);
  }
  return { snapshots, reviewKeys: keys.length };
}

/**
 * The automatic run. Never asks and never removes the current checkpoint. One at a time:
 * a run requested while another is going is skipped (the next trigger catches up).
 * @param {CleanupDeps} deps
 * @returns {() => Promise<void>}
 */
function createAutoCleanup(deps) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const { store, plan } = await gather(deps);
      if (!plan.snapshots.length && !plan.reviewKeys.length) return;
      const done = await apply(deps, store, plan);
      deps.log(`cleanup: removed ${done.snapshots} snapshot(s) and ${done.reviewKeys} review progress entr${done.reviewKeys === 1 ? 'y' : 'ies'}`);
    } catch (e) {
      deps.log(`cleanup: automatic run failed: ${errorText(e)}`);
    } finally {
      running = false;
    }
  };
}

/** Bytes a review key takes in workspace state (its JSON text). @param {any} memento @param {string} key */
const storedBytes = (memento, key) => {
  try { return Buffer.byteLength(JSON.stringify(memento.get(key)) || '', 'utf8'); } catch { return 0; }
};

/**
 * The "Clean up stored data" command: shows each kind of stored data the policy would
 * delete with its size, plus an unticked "Also delete the current checkpoint", and deletes
 * the ticked ones after a confirmation.
 * @param {any} vscode
 * @param {CleanupDeps} deps
 * @returns {() => Promise<void>}
 */
function createCleanupCommand(vscode, deps) {
  return async () => {
    const { store, plan } = await gather(deps, { includeCurrent: true });
    const current = plan.snapshots.filter((s) => s.reason === 'current checkpoint');
    const policy = { ...plan, snapshots: plan.snapshots.filter((s) => s.reason !== 'current checkpoint'), clearCheckpoint: false };
    const sizes = new Map(plan.reviewKeys.map((k) => [k.key, storedBytes(deps.workspaceState, k.key)]));
    const rows = summarize(policy, { reviewKeys: sizes });
    if (!rows.length && !current.length) {
      vscode.window.showInformationMessage('Impact Tree: nothing to clean up. Feedback files are never deleted.');
      return;
    }
    const items = rows.map((r) => ({ label: r.label, description: formatBytes(r.bytes), picked: true, group: r.group }));
    if (current.length) {
      items.push({ label: 'Also delete the current checkpoint', description: formatBytes(current[0].record.bytes), picked: false, group: 'current' });
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true, title: 'Impact Tree: Clean up stored data',
      placeHolder: 'Your feedback files in .impact-tree/feedback/ are kept',
    });
    if (!picked || !picked.length) return;
    const chosen = new Set(picked.map((/** @type {{ group: string }} */ p) => p.group));
    const final = {
      snapshots: [
        ...policy.snapshots.filter((s) => chosen.has(snapshotLabel(s.reason))),
        ...(chosen.has('current') ? current : []),
      ],
      reviewKeys: policy.reviewKeys.filter((k) => chosen.has(reviewLabel(k.reason))),
      clearCheckpoint: chosen.has('current') && current.length > 0,
    };
    const bytes = final.snapshots.reduce((n, s) => n + s.record.bytes, 0) + final.reviewKeys.reduce((n, k) => n + (sizes.get(k.key) || 0), 0);
    const yes = await vscode.window.showWarningMessage(
      `Delete ${formatBytes(bytes)} of Impact Tree data for this workspace? Feedback files are kept.`, { modal: true }, 'Delete');
    if (yes !== 'Delete') return;
    // The plan was made before the dialogs; a checkpoint set meanwhile must not be deleted.
    const nowCurrent = (deps.session.state && deps.session.state.checkpoint) || null;
    final.snapshots = final.snapshots.filter((s) => s.reason === 'current checkpoint' ? s.record.sha === nowCurrent : s.record.sha !== nowCurrent);
    final.clearCheckpoint = final.clearCheckpoint && final.snapshots.some((s) => s.reason === 'current checkpoint');
    const done = await apply(deps, store, final);
    vscode.window.showInformationMessage(`Impact Tree: deleted ${done.snapshots} checkpoint(s) and ${done.reviewKeys} review progress entr${done.reviewKeys === 1 ? 'y' : 'ies'}.`);
    if (final.clearCheckpoint) await deps.session.refresh();
  };
}

module.exports = { createAutoCleanup, createCleanupCommand, gather, apply };
