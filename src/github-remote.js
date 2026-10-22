// @ts-check
'use strict';

const { parseRemote } = require('./github');
// The rule lives with the git commands that take the name.
const { isSafeRemoteName: isSafeName } = require('./engine/git');

/**
 * A remote name goes to git as an argument, so one that could be read as an option (a
 * leading `-`) or that holds spaces is never accepted.
 * @param {unknown} name
 * @returns {name is string}
 */
const isSafeRemoteName = (name) => isSafeName(name);

/**
 * Which git remote is the GitHub repository whose pull requests are reviewed. Pure: the
 * caller runs `git remote -v` and reads the setting; nothing here touches git or the editor.
 *
 * @typedef {{ name: string, url: string }} Remote
 * @typedef {{ kind: 'ok', name: string, owner: string, repo: string }
 *   | { kind: 'none' }
 *   | { kind: 'ambiguous', names: string[] }
 *   | { kind: 'bad-setting', setting: string, reason: 'unsafe' | 'missing' | 'not-github' }
 * } RemoteChoice
 */

/**
 * The fetch URLs of `git remote -v` output, one entry per remote name (the first seen).
 * Push lines and lines that are not `name<TAB>url (fetch)` are ignored.
 * @param {string} text
 * @returns {Remote[]}
 */
function parseRemoteList(text) {
  /** @type {Remote[]} */
  const remotes = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line.trim());
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    remotes.push({ name: m[1], url: m[2] });
  }
  return remotes;
}

/**
 * @param {Remote[]} remotes
 * @param {unknown} setting The `impactTree.githubRemote` value as read.
 * @returns {RemoteChoice}
 */
function chooseGitHubRemote(remotes, setting) {
  const wanted = setting === undefined || setting === null ? '' : setting;
  if (wanted !== '') {
    const shown = typeof wanted === 'string' ? wanted : String(wanted);
    if (!isSafeRemoteName(wanted)) return { kind: 'bad-setting', setting: shown, reason: 'unsafe' };
    const remote = remotes.find((r) => r.name === wanted);
    if (!remote) return { kind: 'bad-setting', setting: wanted, reason: 'missing' };
    const slug = parseRemote(remote.url);
    if (!slug) return { kind: 'bad-setting', setting: wanted, reason: 'not-github' };
    return { kind: 'ok', name: wanted, owner: slug.owner, repo: slug.repo };
  }
  const github = [];
  for (const r of remotes) {
    const slug = isSafeRemoteName(r.name) ? parseRemote(r.url) : null;
    if (slug) github.push({ name: r.name, ...slug });
  }
  if (github.length === 0) return { kind: 'none' };
  const pick = github.find((r) => r.name === 'upstream') || github.find((r) => r.name === 'origin')
    || (github.length === 1 ? github[0] : null);
  if (!pick) return { kind: 'ambiguous', names: github.map((r) => r.name) };
  return { kind: 'ok', name: pick.name, owner: pick.owner, repo: pick.repo };
}

/**
 * One plain sentence saying why there is no GitHub repository to review, or null when
 * there is one.
 * @param {RemoteChoice} choice
 * @returns {string|null}
 */
function describeRemoteProblem(choice) {
  switch (choice.kind) {
    case 'ok': return null;
    case 'none': return 'No remote of this repository points at github.com.';
    case 'ambiguous':
      return `Several remotes point at github.com (${choice.names.join(', ')}); set impactTree.githubRemote to the one pull requests are opened against.`;
    case 'bad-setting':
      return choice.reason === 'not-github'
        ? `impactTree.githubRemote is '${choice.setting}', which does not point at github.com.`
        : choice.reason === 'unsafe'
          ? `impactTree.githubRemote is '${choice.setting}', which is not a valid remote name.`
          : `impactTree.githubRemote is '${choice.setting}', which is not a remote of this repository.`;
    default: return null;
  }
}

/**
 * The remote the base branch is read from. A repository with no GitHub remote keeps
 * `origin`, as before remotes were configurable. An ambiguous choice or a bad setting
 * has no base remote: falling back to `origin` would diff against the user's fork in the
 * setup the setting exists for, so the caller refuses with the problem instead.
 * @param {RemoteChoice} choice
 * @returns {{ name: string, problem: null } | { name: null, problem: string }}
 */
function baseRemoteOf(choice) {
  if (choice.kind === 'ok') return { name: choice.name, problem: null };
  if (choice.kind === 'none') return { name: 'origin', problem: null };
  return { name: null, problem: describeRemoteProblem(choice) || 'No GitHub remote could be chosen.' };
}

/**
 * Why a pull request cannot be used with the current GitHub remote, or null. The remote
 * can change (impactTree.githubRemote) after the pull request was listed; the same number
 * on the other repository is another pull request. A record without `baseRepo` is not
 * checked.
 * @param {{ number?: unknown, baseRepo?: unknown }} pr
 * @param {{ owner: string, repo: string }} slug
 * @returns {string|null}
 */
function otherRepositoryProblem(pr, slug) {
  const current = `${slug.owner}/${slug.repo}`;
  if (typeof pr.baseRepo !== 'string' || pr.baseRepo.toLowerCase() === current.toLowerCase()) return null;
  return `Pull request #${pr.number} is in ${pr.baseRepo}, but the GitHub remote is now ${current}. Pick the pull request again from the list.`;
}

module.exports = { parseRemoteList, chooseGitHubRemote, isSafeRemoteName, describeRemoteProblem, baseRemoteOf, otherRepositoryProblem };
