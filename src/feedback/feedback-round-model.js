// @ts-check
'use strict';
// What happened to each item of the last feedback round (docs/UX_PLAN.md F4), as rows for
// the Changes view. Pure: statuses come from the round file (feedback-file.js) and code
// changes from a diff the caller ran; both arrive already read.
//
// Each item states two separate facts in words, the agent's status and whether the code
// near the item changed. An item needs attention (amber) when the two disagree or when
// either is not known: a "done" with no code change must never look fine.

/** @typedef {import('./feedback-file').ItemStatus} ItemStatus */
/** @typedef {'changed'|'unchanged'|'unknown'} CodeChange */
/**
 * What Send feedback remembers about a round, so the read-back does not depend on the
 * headings in the file (an agent may edit them).
 * @typedef {{ id: string, file: string, line: number|null, symbol: string|null, summary: string }} SentItem
 * @typedef {{ round: number, relPath: string, checkpointSha: string, sentAtMs: number, items: SentItem[] }} SentRound
 */

const AGENT_WORDS = Object.freeze({
  done: 'Agent: done',
  skipped: 'Agent: skipped',
  none: 'No status written',
  unreadable: 'Status unreadable',
});
const CODE_WORDS = Object.freeze({
  changed: 'Code changed',
  unchanged: 'No code change',
  unknown: 'Change unknown',
});

/**
 * Does this pair of facts need the reviewer's attention? Only two pairs are fine: the agent
 * says done and the code changed, or the agent wrote nothing but the code changed (it
 * acted and forgot the status line).
 * @param {ItemStatus} status
 * @param {CodeChange} change
 */
function needsAttention(status, change) {
  if (change !== 'changed') return true;
  return status !== 'done' && status !== 'none';
}

/** @param {SentItem} item */
const placeOf = (item) => `${item.file}${item.line != null ? `:${item.line}` : ''}${item.symbol ? ` · ${item.symbol}` : ''}`;

/**
 * @param {{ round: SentRound, statuses: Map<string, { status: ItemStatus, reason: string|null }>,
 *   changes: Map<string, CodeChange>, timeText: string }} input
 *   `statuses` from `statusesFor` (every sent id present); `changes` by item id, a missing
 *   id read as 'unknown'. `timeText` is the send time already formatted for display.
 * @returns {{ label: string, description: string, attention: number,
 *   items: Array<{ id: string, label: string, description: string, tooltip: string, attention: boolean,
 *     status: ItemStatus, reason: string|null, change: CodeChange, item: SentItem }> }}
 */
function roundRows({ round, statuses, changes, timeText }) {
  const items = round.items.map((item) => {
    const s = statuses.get(item.id) || { status: /** @type {ItemStatus} */ ('unreadable'), reason: 'not in the status list' };
    const change = changes.get(item.id) || 'unknown';
    const attention = needsAttention(s.status, change);
    const facts = `${AGENT_WORDS[s.status]} · ${CODE_WORDS[change]}`;
    const tooltip = [placeOf(item), item.summary, facts, s.reason ? `${s.status === 'skipped' ? 'Reason' : 'Why'}: ${s.reason}` : '']
      .filter(Boolean).join('\n');
    return { id: item.id, label: placeOf(item), description: facts, tooltip, attention, status: s.status, reason: s.reason, change, item };
  });
  const attention = items.filter((i) => i.attention).length;
  const description = `sent ${timeText}${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}`;
  return { label: `Feedback round ${round.round}`, description, attention, items };
}

const ROUNDS_KEY = 'impactTree.feedbackRounds';
const ROUNDS_VERSION = 1;
const KEEP_ROUNDS = 5;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The rounds stored in workspace state, validated. An unknown version or shape reads as
 * none; an invalid round is dropped whole (a half-trusted round could show a wrong item).
 * @param {unknown} raw
 * @returns {{ rounds: SentRound[], dropped: number, unreadable: boolean }}
 */
function readSentRounds(raw) {
  if (raw === undefined) return { rounds: [], dropped: 0, unreadable: false };
  if (!raw || typeof raw !== 'object' || /** @type {any} */ (raw).version !== ROUNDS_VERSION || !Array.isArray(/** @type {any} */ (raw).rounds)) {
    return { rounds: [], dropped: 0, unreadable: true };
  }
  /** @type {SentRound[]} */
  const rounds = [];
  let dropped = 0;
  for (const r of /** @type {any[]} */ (/** @type {any} */ (raw).rounds)) {
    if (isSentRound(r)) rounds.push(r);
    else dropped++;
  }
  return { rounds, dropped, unreadable: false };
}

/** @param {any} r @returns {r is SentRound} */
function isSentRound(r) {
  if (!r || typeof r !== 'object') return false;
  if (!Number.isSafeInteger(r.round) || r.round < 1) return false;
  if (typeof r.relPath !== 'string' || !r.relPath.startsWith('.impact-tree/feedback/')) return false;
  if (typeof r.checkpointSha !== 'string' || !SHA_RE.test(r.checkpointSha)) return false;
  if (!Number.isFinite(r.sentAtMs) || !Array.isArray(r.items) || r.items.length > 200) return false;
  return r.items.every((/** @type {any} */ i) => i && typeof i === 'object' && typeof i.id === 'string' && ID_RE.test(i.id)
    && typeof i.file === 'string' && i.file !== '' && (i.line === null || (Number.isInteger(i.line) && i.line >= 1))
    && (i.symbol === null || typeof i.symbol === 'string') && typeof i.summary === 'string');
}

/**
 * The stored value after adding `round`, keeping the newest `KEEP_ROUNDS`.
 * @param {SentRound[]} rounds @param {SentRound} round
 */
function withSentRound(rounds, round) {
  const next = [...rounds.filter((r) => r.round !== round.round), round].sort((a, b) => a.round - b.round).slice(-KEEP_ROUNDS);
  return { version: ROUNDS_VERSION, rounds: next };
}

/**
 * The round whose snapshot is the current checkpoint, if any.
 * @param {SentRound[]} rounds @param {string|null|undefined} checkpointSha
 */
const roundForCheckpoint = (rounds, checkpointSha) => (checkpointSha ? rounds.find((r) => r.checkpointSha === checkpointSha) || null : null);

/**
 * The first line of a draft body, for the round's memory and the tree (at most 120 characters).
 * @param {string} body
 */
function summaryOf(body) {
  const first = body.split(/\r?\n/).find((l) => l.trim()) || '';
  const t = first.trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

module.exports = {
  roundRows, needsAttention, readSentRounds, withSentRound, roundForCheckpoint, summaryOf,
  AGENT_WORDS, CODE_WORDS, ROUNDS_KEY, KEEP_ROUNDS,
};
