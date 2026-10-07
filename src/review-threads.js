// @ts-check
'use strict';
// The pull request's review threads as the change tree and Details show them: which row a
// thread belongs to, the counts a row's description carries, the tree message's suffix and
// the Details "Threads" section. Pure: the review store's state and the tree's rows are
// handed in; nothing here reads the editor, the store or GitHub.

const { findRowAtLine } = require('./review-tree-model');
const { openCount, pendingCount } = require('./pr-review-data');
const { reviewDataOf } = require('./pr-review-store');

/**
 * @typedef {import('./tree-row-models').TreeRow} TreeRow
 * @typedef {import('./pr-review-data').ReviewThread} ReviewThread
 * @typedef {import('./pr-review-store').ReviewStoreState} ReviewStoreState
 *
 * @typedef {{ status: 'none' }
 *   | { status: 'loading' }
 *   | { status: 'failed', message: string }
 *   | { status: 'ready', threads: readonly ReviewThread[] }} ThreadsView
 *   What the tree and Details may say about threads. `none`: not a pull request review
 *   (local or agent), so nothing is shown. `loading`: the first load of this review has
 *   not answered; no counts are shown, never zeros. `failed`: the last load failed; the
 *   counts of an earlier load are not current, so none are shown and the failure is said.
 *   `ready`: the loaded threads; a reload of the same review keeps showing them until it
 *   answers, so a comment does not blank every count while the store reloads.
 *
 * @typedef {{ open: number, pending: number }} ThreadCounts `open`: unresolved threads
 *   someone has posted in (`openCount`); `pending`: the viewer's unsubmitted comments.
 */

/** @type {ThreadsView} */
const NO_THREADS = Object.freeze({ status: 'none' });

/**
 * @param {ReviewStoreState} state The review store's state.
 * @returns {ThreadsView}
 */
function threadsViewOf(state) {
  if (state.kind === 'none') return NO_THREADS;
  if (state.kind === 'failed') return { status: 'failed', message: state.error.message };
  const data = reviewDataOf(state);
  // Loading with data is a reload of the same pull request at the same head (the store
  // drops `previous` when the target changes), so its threads are still the answer shown.
  return data ? { status: 'ready', threads: data.threads } : { status: 'loading' };
}

/**
 * Which of a file's rows each of its threads belongs to. A thread on a line of the head
 * file (RIGHT side, not outdated, not file-level) belongs to the row `findRowAtLine` gives
 * for that line: the innermost change, else the outside row whose ranges hold it.
 * The file row holds every thread of its path, whatever its side or state.
 * @param {TreeRow} file A `reviewFile` or `file` row from `buildFileRows`.
 * @param {readonly ReviewThread[]} threads Every thread of the review; those of other paths are ignored.
 * @returns {Map<TreeRow, ReviewThread[]>} Only rows with at least one thread.
 */
function assignFileThreads(file, threads) {
  /** @type {Map<TreeRow, ReviewThread[]>} */
  const out = new Map();
  const add = (/** @type {TreeRow} */ row, /** @type {ReviewThread} */ t) => {
    const list = out.get(row);
    if (list) list.push(t); else out.set(row, [t]);
  };
  for (const t of threads) {
    if (t.path !== file.relPath) continue;
    add(file, t);
    if (t.side !== 'RIGHT' || t.isOutdated || t.fileLevel || t.line === null || file.type !== 'reviewFile') continue;
    const row = findRowAtLine([file], file.relPath, t.line);
    if (row && row !== file) add(row, t);
  }
  return out;
}

/**
 * @param {readonly ReviewThread[]} threads
 * @returns {ThreadCounts}
 */
const countThreads = (threads) => ({ open: openCount([...threads]), pending: pendingCount([...threads]) });

/**
 * The parts a row's description shows for its threads: `💬 N` and `✎ N`, each only when
 * not zero. Nothing for no counts (no data).
 * @param {ThreadCounts|null} counts
 * @returns {string[]}
 */
const describeThreadCounts = (counts) => (counts
  ? [counts.open ? `💬 ${counts.open}` : null, counts.pending ? `✎ ${counts.pending}` : null].filter((p) => p !== null)
  : []);

/**
 * What the tree message adds for the whole pull request: ` · 💬 N` and ` · ✎ N` when not
 * zero, or that the threads could not be loaded. Nothing while loading or for a local review.
 * @param {ThreadsView} view
 * @returns {string}
 */
function threadsMessageSuffix(view) {
  if (view.status === 'failed') return ' · ⚠ threads not loaded';
  if (view.status !== 'ready') return '';
  return describeThreadCounts(countThreads(view.threads)).map((p) => ` · ${p}`).join('');
}

/**
 * @typedef {'Pending'|'Unresolved'|'Resolved'} ThreadStatus `Pending`: only the viewer's
 *   unsubmitted comments, which no one else sees yet.
 *
 * @typedef {object} ThreadSummary One thread in the Details section.
 * @property {string} id
 * @property {string} author First comment's author login; `ghost` for a deleted account.
 * @property {string} firstLine First non-blank line of the first comment, at most `FIRST_LINE_MAX` characters.
 * @property {string} location `line 12`, `old line 9` (base side) or `file comment`; an
 *   outdated thread names the line it was written on.
 * @property {number} commentCount
 * @property {ThreadStatus} status
 * @property {boolean} outdated
 * @property {string|null} originalCode The line an outdated thread was written on; null otherwise.
 *
 * @typedef {'change'|'lines'|'file'} CommentTarget What "Comment on …" starts a comment on.
 *
 * @typedef {object} ThreadSection The Details section of one row.
 * @property {string} title `Threads (N)`, or `Threads` when nothing is known.
 * @property {ThreadSummary[]} threads
 * @property {string|null} note Why no threads are listed (loading, failed), or that there are none.
 * @property {{ target: CommentTarget, label: string }|null} action The comment button; none
 *   until the threads are loaded, since whether a review is pending decides how it is sent.
 */

const FIRST_LINE_MAX = 120;

/** @type {Record<CommentTarget, string>} */
const ACTION_LABELS = { change: 'Comment on this change', lines: 'Comment on these lines', file: 'Comment on this file' };

/**
 * @param {ReviewThread} t
 * @returns {ThreadStatus}
 */
const statusOf = (t) => (!t.comments.some((c) => !c.pending) ? 'Pending' : t.isResolved ? 'Resolved' : 'Unresolved');

/** @param {string} body @returns {string} */
function firstLineOf(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') || '';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

/**
 * @param {ReviewThread} t
 * @returns {ThreadSummary}
 */
function summariseThread(t) {
  const first = t.comments[0];
  const line = t.line ?? t.originalLine;
  const location = t.fileLevel ? 'file comment' : `${t.side === 'LEFT' ? 'old ' : ''}${line === null ? 'line unknown' : `line ${line}`}`;
  return {
    id: t.id,
    author: first && first.author ? first.author.login : 'ghost',
    firstLine: first ? firstLineOf(first.body) : '',
    location,
    commentCount: t.comments.length,
    status: statusOf(t),
    outdated: t.isOutdated,
    originalCode: t.isOutdated ? t.originalCode : null,
  };
}

/**
 * What a "Comment on …" button starts a comment on for a row, or null for a row that
 * cannot take one (a deleted symbol has no line on the head side).
 * @param {TreeRow} row
 * @returns {CommentTarget|null}
 */
function commentTargetOf(row) {
  if (row.type === 'finding') return 'change';
  if (row.type === 'outside') return 'lines';
  if (row.type === 'reviewFile' || row.type === 'file') return 'file';
  return null;
}

/**
 * The Details "Threads" section for a row. Compared as a whole to decide whether a store
 * change repaints Details, so it holds only what the section shows.
 * @param {TreeRow|null} row The row Details shows.
 * @param {ThreadsView} view
 * @param {readonly ReviewThread[]} rowThreads The row's threads (`assignFileThreads`); read only when ready.
 * @returns {ThreadSection|null} Null for no row, a deleted row, or a review that is not a pull request's.
 */
function buildThreadSection(row, view, rowThreads) {
  const target = row ? commentTargetOf(row) : null;
  if (!row || !target || view.status === 'none') return null;
  if (view.status === 'loading') return { title: 'Threads', threads: [], note: 'Loading the review threads…', action: null };
  if (view.status === 'failed') {
    return { title: 'Threads', threads: [], action: null,
      note: `The review threads could not be loaded: ${view.message}. This does not mean there are none. Refresh to try again.` };
  }
  const threads = rowThreads.map(summariseThread);
  return { title: `Threads (${threads.length})`, threads, note: threads.length ? null : 'No threads yet.',
    action: { target, label: ACTION_LABELS[target] } };
}

module.exports = {
  NO_THREADS, threadsViewOf, assignFileThreads, countThreads, describeThreadCounts, threadsMessageSuffix,
  buildThreadSection, commentTargetOf, FIRST_LINE_MAX,
};
