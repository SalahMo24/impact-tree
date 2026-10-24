// @ts-check
'use strict';
// Keeps the "Feedback round N" group up to date (docs/UX_PLAN.md F4): when the checkpoint
// is the snapshot of a sent round and a local review is shown, it reads the agent's
// statuses and the code changes since the snapshot, and builds the group's rows.
//
// Ownership: one refresh at a time is current; a newer request supersedes an older one,
// whose result is dropped (and whose remaining diffs are skipped). Refreshes are asked for
// after each analysis, when a round file changes on disk, and after a send. Disposed with
// the window: no refresh publishes afterwards.

const { readSentRounds, roundForCheckpoint, roundRows, ROUNDS_KEY } = require('./feedback-round-model');
const { codeChangesFor, statusesOf } = require('./feedback-readback');

/** @typedef {ReturnType<typeof roundRows> & { relPath: string }} RoundView */

/**
 * @param {{
 *   workspaceState: { get: (k: string) => any },
 *   session: any,
 *   getSnapshotStore: () => any,
 *   onChange: () => void,
 *   log: (m: string) => void,
 *   formatTime?: (ms: number) => string,
 * }} deps
 */
function createFeedbackRoundView({ workspaceState, session, getSnapshotStore, onChange, log, formatTime = defaultTime }) {
  /** @type {RoundView|null} */
  let current = null;
  let generation = 0;
  let disposed = false;

  const publish = (/** @type {RoundView|null} */ next) => {
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    current = next;
    if (changed) onChange();
  };

  async function refresh() {
    if (disposed) return;
    const mine = ++generation;
    const isCurrent = () => !disposed && mine === generation;
    const state = session.state;
    const local = !state || !state.source || state.source.kind === 'local';
    const store = getSnapshotStore();
    const read = readSentRounds(workspaceState.get(ROUNDS_KEY));
    if (read.unreadable) log('feedback: the stored rounds are unreadable and were ignored');
    const round = local && store ? roundForCheckpoint(read.rounds, state && state.checkpoint) : null;
    if (!round) { publish(null); return; }
    let repo;
    try { repo = session.repoRoot(); } catch { publish(null); return; }
    try {
      const [statuses, changes] = await Promise.all([
        statusesOf({ repo, round }),
        codeChangesFor({ repo, round, objectDirs: store.objectDirs(), withDiffIndex: store.withDiffIndex, isCurrent }),
      ]);
      if (!isCurrent()) return;
      publish({ ...roundRows({ round, statuses, changes, timeText: formatTime(round.sentAtMs) }), relPath: round.relPath });
    } catch (e) {
      log(`feedback: reading round ${round.round} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!isCurrent()) return;
      // Every item unknown, rather than no group: the round was sent and must stay visible.
      publish({ ...roundRows({ round, statuses: new Map(), changes: new Map(), timeText: formatTime(round.sentAtMs) }), relPath: round.relPath });
    }
  }

  return {
    /** Asks for a refresh; owned here, a failure is logged. @returns {Promise<void>} */
    refresh: () => refresh().catch((e) => log(`feedback: round refresh failed: ${e && e.message}`)),
    /** @returns {RoundView|null} What the group shows now. */
    current: () => current,
    dispose() { disposed = true; generation++; },
  };
}

/** @param {number} ms */
function defaultTime(ms) {
  const d = new Date(ms);
  // wall-clock: display — whether a round's date is today, to label it with a time or a date
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

module.exports = { createFeedbackRoundView };
