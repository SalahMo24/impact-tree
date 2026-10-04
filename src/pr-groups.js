// @ts-check
'use strict';
// Sorts open pull requests by the signed-in user's relation to them, so the PRs waiting
// on them are not buried in a long list. Pure: the caller fetches the PRs and teams.

/**
 * @typedef {{ number: number, author?: string, requestedReviewers: string[],
 *   requestedTeams: {id: number, name: string}[] }} GroupablePr
 * @typedef {{ id: number, name: string, parentId: number | null }} Team
 */

/** GitHub logins are case-insensitive. @param {string | null | undefined} a @param {string | null | undefined} b */
const sameLogin = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * @template {GroupablePr} P
 * @param {P[]} prs In display order; each group keeps it.
 * @param {{ login: string | null, teams: Team[] | null }} me `teams` is null when the
 *   team list could not be loaded; only direct requests are matched then.
 * @returns {{ requested: {pr: P, via: string[]}[], mine: P[], others: P[] }} Every PR
 *   lands in exactly one group, in this precedence. `via` names why it is requested:
 *   'you' for a direct request, then the requested teams the user belongs to.
 */
function groupPullRequests(prs, { login, teams }) {
  // A request to a parent team reaches the members of its child teams. Only the
  // immediate parent is known from the team list; deeper ancestors are not matched.
  const myTeamIds = new Set();
  for (const t of teams || []) {
    myTeamIds.add(t.id);
    if (t.parentId != null) myTeamIds.add(t.parentId);
  }

  const requested = [];
  const mine = [];
  const others = [];
  for (const pr of prs) {
    const via = [];
    if (pr.requestedReviewers.some((r) => sameLogin(r, login))) via.push('you');
    for (const t of pr.requestedTeams) if (myTeamIds.has(t.id)) via.push(t.name);
    if (via.length) requested.push({ pr, via });
    else if (sameLogin(pr.author, login)) mine.push(pr);
    else others.push(pr);
  }
  return { requested, mine, others };
}

module.exports = { groupPullRequests };
