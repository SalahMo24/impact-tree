// @ts-check
'use strict';
// The rows of the "Search pull requests" picker, and the short list of PRs opened
// recently. Pure: the command (session/pr-search-command.js) shows the rows, and VS Code's
// picker filters them as the user types.

const { groupPullRequests } = require('./pr-groups');

/** How many recently opened PRs are kept per repository. */
const MAX_RECENT = 5;

/**
 * @typedef {import('./pr-groups').GroupablePr & { title: string, draft?: boolean, isFork?: boolean }} SearchablePr
 * @typedef {{ kind: 'separator', label: string }
 *   | { kind: 'pr', pr: SearchablePr, label: string, description: string }} SearchRow
 */

/** @param {SearchablePr} pr @param {string[]} [via] */
function prRow(pr, via) {
  const parts = [pr.author || 'unknown author'];
  if (pr.draft) parts.push('draft');
  if (pr.isFork) parts.push('fork');
  if (via && via.length) parts.push(`via ${via.join(', ')}`);
  return /** @type {SearchRow} */ ({ kind: 'pr', pr, label: `#${pr.number}  ${pr.title}`, description: parts.join('  ·  ') });
}

/**
 * Every loaded PR once, under the same groups as the sidebar, with the recently opened
 * ones first. Empty groups get no separator.
 * @param {SearchablePr[]} prs In display order.
 * @param {{ login: string | null, teams: import('./pr-groups').Team[] | null, recent?: number[] }} me
 *   `recent`: PR numbers, most recent first; numbers not in `prs` are skipped.
 * @returns {SearchRow[]}
 */
function searchRows(prs, { login, teams, recent = [] }) {
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const recentPrs = recent.map((n) => byNumber.get(n)).filter((p) => p !== undefined);
  const isRecent = new Set(recentPrs.map((p) => p.number));
  const { requested, mine, others } = groupPullRequests(prs.filter((p) => !isRecent.has(p.number)), { login, teams });

  /** @type {SearchRow[]} */
  const rows = [];
  /** @param {string} label @param {SearchRow[]} items */
  const section = (label, items) => { if (items.length) rows.push({ kind: 'separator', label }, ...items); };
  section('Recently opened', recentPrs.map((p) => prRow(p)));
  section('Review requested', requested.map(({ pr, via }) => prRow(pr, via)));
  section('Yours', mine.map((p) => prRow(p)));
  section('Everyone else', others.map((p) => prRow(p)));
  return rows;
}

/**
 * The PR number to offer looking up on GitHub: the query is a number ("482" or "#482")
 * that no loaded PR has. Null otherwise.
 * @param {string} query
 * @param {{ number: number }[]} prs
 * @returns {number | null}
 */
function lookupNumber(query, prs) {
  const m = /^#?\s*(\d{1,9})$/.exec(query.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  return prs.some((p) => p.number === n) ? null : n;
}

/**
 * The recent list with `n` moved to the front, at most MAX_RECENT long.
 * @param {number[]} recent @param {number} n @returns {number[]}
 */
function addRecent(recent, n) {
  return [n, ...recent.filter((r) => r !== n)].slice(0, MAX_RECENT);
}

/** Where the recent lists live in workspace state, keyed by "owner/repo". */
const RECENT_KEY = 'impactTree.recentPullRequests';

/**
 * @param {{ get: (key: string) => unknown }} state
 * @param {{ owner: string, repo: string }} slug
 * @returns {number[]}
 */
function readRecent(state, { owner, repo }) {
  const all = state.get(RECENT_KEY);
  const list = all && typeof all === 'object' ? /** @type {Record<string, unknown>} */ (all)[`${owner}/${repo}`] : null;
  return Array.isArray(list) ? list.filter((n) => Number.isSafeInteger(n)) : [];
}

/**
 * Records that PR `n` of `slug` was opened.
 * @param {{ get: (key: string) => unknown, update: (key: string, value: unknown) => PromiseLike<void> }} state
 * @param {{ owner: string, repo: string }} slug
 * @param {number} n
 */
async function rememberOpened(state, slug, n) {
  const all = state.get(RECENT_KEY);
  const next = { ...(all && typeof all === 'object' ? all : {}), [`${slug.owner}/${slug.repo}`]: addRecent(readRecent(state, slug), n) };
  await state.update(RECENT_KEY, next);
}

module.exports = { searchRows, lookupNumber, addRecent, readRecent, rememberOpened, MAX_RECENT };
