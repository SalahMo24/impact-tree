// @ts-check
'use strict';
// GitHub access with no dependency on the GitHub Pull Requests extension or the `gh`
// CLI: VS Code ships a built-in 'github' authentication provider, so we ask it for a
// token and call the REST API directly. A first-time user needs neither installed.
// Nothing in this module touches the worktree — checkout is the caller's decision.
//
// Every request goes through `send` -> `fetchBounded` (src/github-request.js), which owns
// the deadline, cancellation and size limits documented beside DEFAULT_LIMITS there.

const {
  DEFAULT_LIMITS, fetchBounded, GitHubAuthError, GitHubResponseError, GitHubGraphQLError, GitHubRateLimitError,
} = require('./github-request');

/**
 * The parts of GitHub's responses this module reads, not the whole schema. Each raw type
 * says what GitHub documents; the `check*` functions verify it at runtime because the
 * body is untrusted.
 * @typedef {{ owner: string, repo: string }} RepoSlug
 * @typedef {{ login: string, avatar_url?: string | null }} RawUser
 * @typedef {{ ref: string, sha: string, repo?: { full_name: string } | null }} RawBranch
 * @typedef {object} RawPullRequest
 * @property {number} number
 * @property {string} title
 * @property {string} html_url
 * @property {string} updated_at
 * @property {boolean} [draft]
 * @property {RawUser | null} [user] Null or absent for a deleted user.
 * @property {RawBranch} head
 * @property {RawBranch} base
 * @property {number | null} [changed_files]
 * @property {{ login: string }[] | null} [requested_reviewers]
 * @property {{ id: number, name: string }[] | null} [requested_teams]
 * @typedef {{ id: number, name: string, parent?: { id: number } | null }} RawTeam
 * @typedef {object} RawFile
 * @property {string} filename
 * @property {string} status
 * @property {string} [previous_filename]
 * @property {string} [patch] Absent for binary files and files over GitHub's size cap.
 * @property {string} [sha]
 * @property {number} additions
 * @property {number} deletions
 * @typedef {{ accessToken: string, account?: { label?: string } }} AuthSession The
 *   fields read from the editor's GitHub authentication session.
 */

/**
 * Matches both remote forms; the optional .git and any trailing slash are stripped so
 * `repo` is never captured as "impact-tree.git".
 * @param {string | null | undefined} url
 */
function parseRemote(url) {
  const m = String(url || '').trim().replace(/\/+$/, '')
    .match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v @returns {v is string} */
const isString = (v) => typeof v === 'string';

/**
 * Checks the fields normalisePr reads, not the whole GitHub schema. Fields GitHub may
 * legitimately leave out (a deleted user, a deleted fork) stay optional.
 * @param {RawPullRequest} p
 * @param {string} endpoint
 */
function checkPullRequest(p, endpoint) {
  /** @param {string} problem @returns {never} */
  const bad = (problem) => { throw new GitHubResponseError(endpoint, problem); };
  if (!isObject(p)) bad('a pull request is not an object');
  if (!Number.isSafeInteger(p.number)) bad('a pull request has no numeric `number`');
  if (!isString(p.title)) bad(`#${p.number} has no \`title\``);
  for (const side of /** @type {const} */ (['head', 'base'])) {
    if (!isObject(p[side]) || !isString(p[side].ref) || !isString(p[side].sha)) {
      bad(`#${p.number} has no \`${side}.ref\` and \`${side}.sha\``);
    }
  }
  if (isObject(p.user) && p.user.avatar_url != null && !isString(p.user.avatar_url)) {
    bad(`#${p.number} has a non-string \`user.avatar_url\``);
  }
  if (p.changed_files != null && !Number.isSafeInteger(p.changed_files)) {
    bad(`#${p.number} has a non-numeric \`changed_files\``);
  }
  // Review requests decide which group a PR is listed under, so a malformed entry must
  // fail here rather than quietly drop the PR out of "Review requested".
  if (p.requested_reviewers != null && (!Array.isArray(p.requested_reviewers)
    || !p.requested_reviewers.every((u) => isObject(u) && isString(u.login)))) {
    bad(`#${p.number} has a \`requested_reviewers\` entry without a string \`login\``);
  }
  if (p.requested_teams != null && (!Array.isArray(p.requested_teams)
    || !p.requested_teams.every((t) => isObject(t) && Number.isSafeInteger(t.id) && isString(t.name)))) {
    bad(`#${p.number} has a \`requested_teams\` entry without a numeric \`id\` and string \`name\``);
  }
  return p;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * One entry of a GraphQL `errors` array: a string `message`, an optional `path` of
 * field names and list indexes, and GitHub's optional `type` (e.g. `RATE_LIMITED`,
 * `NOT_FOUND`).
 * @param {unknown} e
 * @param {string} endpoint
 * @returns {{ message: string, path: (string|number)[]|null, type: string|null }}
 */
function checkGraphQLError(e, endpoint) {
  if (!isObject(e) || !isString(e.message)) {
    throw new GitHubResponseError(endpoint, 'an `errors` entry has no string `message`');
  }
  const { path } = e;
  if (path != null && !(Array.isArray(path) && path.every((p) => isString(p) || Number.isSafeInteger(p)))) {
    throw new GitHubResponseError(endpoint, 'an `errors` entry has a malformed `path`');
  }
  return { message: e.message, path: path == null ? null : path, type: isString(e.type) ? e.type : null };
}

/**
 * The tree row shows avatars at 16px, so ask for a small image (`s` is GitHub's size
 * parameter, in pixels; 32 stays sharp on high-DPI screens). Anything but an https URL
 * is dropped and the row falls back to its PR icon.
 * @param {unknown} raw
 */
function avatarUrl(raw) {
  if (!isString(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  url.searchParams.set('s', '32');
  return url.toString();
}

/**
 * Checks the fields listMyTeams reads. `parent` is null for a top-level team.
 * @param {RawTeam} t
 * @param {string} endpoint
 */
function checkTeam(t, endpoint) {
  /** @param {string} problem @returns {never} */
  const bad = (problem) => { throw new GitHubResponseError(endpoint, problem); };
  if (!isObject(t) || !Number.isSafeInteger(t.id) || !isString(t.name)) {
    bad('a team has no numeric `id` and string `name`');
  }
  if (t.parent != null && !(isObject(t.parent) && Number.isSafeInteger(t.parent.id))) {
    bad(`team ${t.id} has a \`parent\` without a numeric \`id\``);
  }
  return t;
}

/**
 * @param {{ authentication: { getSession: (providerId: string, scopes: string[],
 *   options: { silent: true } | { createIfNone: true }) => PromiseLike<AuthSession | undefined> } }} vscode
 *   The editor API; only `authentication.getSession` is used.
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 * @param {typeof fetch} [options.fetch] The HTTP client. Defaults to the global `fetch`,
 *   looked up per request. A seam so the request path can be driven by a fake.
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits] Overrides for DEFAULT_LIMITS;
 *   omitted limits keep their defaults. The extension passes none.
 */
function createGitHub(vscode, { log = () => {}, fetch: fetchImpl, limits: overrides } = {}) {
  /** @type {AuthSession | null | undefined} */
  let session = null;
  const limits = { ...DEFAULT_LIMITS, ...overrides };

  /**
   * silent:true asks "is there already a session?" without ever showing a modal, so the
   * view can render a sign-in row instead of ambushing the user on startup.
   * @param {{ interactive?: boolean }} [options]
   */
  async function signIn({ interactive = false } = {}) {
    try {
      session = await vscode.authentication.getSession(
        'github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
    } catch (e) {
      // The editor rejects with an Error.
      log(`github auth failed: ${/** @type {Error} */ (e).message}`);
      session = null;
    }
    return session;
  }

  const isSignedIn = () => !!session;
  const account = () => (session && session.account && session.account.label) || null;
  function signOutLocally() { session = null; }

  /**
   * The one door to the network: every call below goes through it, so the deadline, the
   * caller's cancellation and the size limit cannot be forgotten by a new endpoint.
   * @param {object} request
   * @param {string} request.url
   * @param {string} request.endpoint
   * @param {string} request.accept
   * @param {number} request.maxBytes
   * @param {AbortSignal} [request.signal]
   * @param {number[]} [request.passStatuses]
   * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} [request.method] Defaults to GET.
   * @param {unknown} [request.body] Sent as JSON; only with a non-GET method. A write is
   *   sent once: nothing here or below retries it.
   */
  async function send({ url, endpoint, accept, maxBytes, signal, passStatuses, method = 'GET', body }) {
    if (!METHODS.has(method)) throw new TypeError(`unsupported HTTP method ${method}`);
    if (body !== undefined && method === 'GET') throw new TypeError('a GET request cannot carry a body');
    if (!session) throw new Error('not signed in to GitHub');
    const client = fetchImpl || globalThis.fetch;
    if (typeof client !== 'function') throw new Error('this editor build has no global fetch — cannot reach the GitHub API');
    try {
      return await fetchBounded(client, url, {
        method,
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, { endpoint, deadlineMs: limits.requestTimeoutMs, maxBytes, signal, passStatuses });
    } catch (e) {
      // A revoked or under-scoped token looks identical to "no PRs" unless we say so.
      if (e instanceof GitHubAuthError) session = null;
      throw e;
    }
  }

  /**
   * @param {string} pathname
   * @param {{ signal?: AbortSignal, method?: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',
   *   body?: unknown }} [options]
   * @returns {Promise<unknown>}
   */
  async function api(pathname, { signal, method, body } = {}) {
    const res = await send({
      url: `https://api.github.com${pathname}`, endpoint: pathname,
      accept: 'application/vnd.github+json', maxBytes: limits.maxJsonBytes, signal,
      method, body,
    });
    // No `passStatuses` here, so the body was read.
    try { return JSON.parse(/** @type {string} */ (res.text)); }
    catch { throw new GitHubResponseError(pathname, 'the body is not JSON'); }
  }

  /**
   * Runs one GraphQL operation. The answer is complete or it is an error: a non-empty
   * `errors` array rejects even when `data` came with it.
   * @param {string} query
   * @param {Record<string, unknown>} [variables]
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Record<string, unknown>>} The envelope's `data` object.
   * @throws {GitHubGraphQLError} GitHub reported errors.
   * @throws {GitHubRateLimitError} One of them was `RATE_LIMITED`.
   * @throws {GitHubResponseError} The envelope is not `{ data, errors? }`.
   */
  async function graphql(query, variables, { signal } = {}) {
    if (!isString(query) || query.trim() === '') throw new TypeError('a GraphQL query must be a non-empty string');
    if (variables != null && !isObject(variables)) throw new TypeError('GraphQL variables must be an object');
    const endpoint = '/graphql';
    const envelope = await api(endpoint, {
      signal, method: 'POST', body: { query, variables: variables || {} },
    });
    if (!isObject(envelope)) throw new GitHubResponseError(endpoint, 'the answer is not an object');
    const { errors, data } = envelope;
    if (errors != null) {
      if (!Array.isArray(errors)) throw new GitHubResponseError(endpoint, '`errors` is not a list');
      if (errors.length > 0) {
        const checked = errors.map((e) => checkGraphQLError(e, endpoint));
        // GraphQL reports its rate limit in a 200; callers handle it like the REST one.
        if (checked.some((e) => e.type === 'RATE_LIMITED')) throw new GitHubRateLimitError(endpoint, 200, null);
        throw new GitHubGraphQLError(endpoint, checked);
      }
    }
    if (!isObject(data)) throw new GitHubResponseError(endpoint, 'no `data` object and no `errors`');
    return data;
  }

  /**
   * Pages of 100 from `endpointFor(page)`, up to `maxPages`. Every page up to the cap
   * being full is ambiguous, so one more request tells "exactly at the cap" from "more
   * exist" without trusting a header.
   * @template T The raw item shape `check` verifies and returns.
   * @param {(page: number) => string} endpointFor
   * @param {number} maxPages
   * @param {string} what Names the items in the error for a body that is not a list.
   * @param {(item: T, endpoint: string) => T} check
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ items: T[], truncated: boolean }>}
   */
  async function listPages(endpointFor, maxPages, what, check, signal) {
    /** @param {number} page */
    const listPage = async (page) => {
      const endpoint = endpointFor(page);
      const batch = await api(endpoint, { signal });
      if (!Array.isArray(batch)) throw new GitHubResponseError(endpoint, `expected a list of ${what}`);
      // Each item is verified by `check`, which is what makes the cast hold.
      return /** @type {T[]} */ (batch).map((item) => check(item, endpoint));
    };
    /** @type {T[]} */
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await listPage(page);
      items.push(...batch);
      if (batch.length < 100) return { items, truncated: false };
    }
    return { items, truncated: (await listPage(maxPages + 1)).length > 0 };
  }

  /**
   * The open pull requests, most recently updated first, up to
   * `limits.maxPullRequestPages` pages of 100.
   * @param {{owner: string, repo: string}} slug
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{pullRequests: object[], truncated: boolean}>} `truncated` is true
   *   only when GitHub has a page beyond the cap; a list that exactly fills the cap is not.
   */
  async function listOpenPullRequests({ owner, repo }, { signal } = {}) {
    const { items, truncated } = await listPages(
      (page) => `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
      limits.maxPullRequestPages, 'pull requests', checkPullRequest, signal);
    return { pullRequests: items.map(normalisePr), truncated };
  }

  /**
   * The signed-in user's teams across every organization, up to `limits.maxTeamPages`
   * pages of 100. Needs the `repo` scope the session already holds (`user` or
   * `read:org` also work). An organization that blocks this app answers with an error,
   * which the caller reports instead of treating as "no teams".
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{teams: {id: number, name: string, parentId: number | null}[],
   *   truncated: boolean}>} `truncated` follows listOpenPullRequests' rule.
   */
  async function listMyTeams({ signal } = {}) {
    const { items, truncated } = await listPages(
      (page) => `/user/teams?per_page=100&page=${page}`,
      limits.maxTeamPages, 'teams', checkTeam, signal);
    return {
      teams: items.map((t) => ({ id: t.id, name: t.name, parentId: t.parent ? t.parent.id : null })),
      truncated,
    };
  }

  /** @param {RawPullRequest} p */
  function normalisePr(p) {
    return {
      number: p.number,
      title: p.title,
      author: p.user && p.user.login,
      authorAvatarUrl: avatarUrl(p.user && p.user.avatar_url),
      headRef: p.head && p.head.ref,
      headSha: p.head && p.head.sha,
      headRepo: p.head && p.head.repo && p.head.repo.full_name,
      baseRef: p.base && p.base.ref,
      baseSha: p.base && p.base.sha,
      draft: !!p.draft,
      url: p.html_url,
      updatedAt: p.updated_at,
      // A PR from a fork cannot be checked out from `origin` alone; the view has to say
      // so rather than fail at checkout time with a confusing git error.
      isFork: !!(p.head && p.head.repo && p.base && p.base.repo
        && p.head.repo.full_name !== p.base.repo.full_name),
      changedFiles: p.changed_files,
      // Pending requests only: GitHub drops a reviewer from this list once they review.
      requestedReviewers: (p.requested_reviewers || []).map((u) => u.login),
      requestedTeams: (p.requested_teams || []).map((t) => ({ id: t.id, name: t.name })),
    };
  }

  /**
   * @param {RepoSlug} slug
   * @param {number} number
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function getPullRequest({ owner, repo }, number, { signal } = {}) {
    const endpoint = `/repos/${owner}/${repo}/pulls/${number}`;
    // `checkPullRequest` verifies the body, which is what makes the cast hold.
    return normalisePr(checkPullRequest(/** @type {RawPullRequest} */ (await api(endpoint, { signal })), endpoint));
  }

  /**
   * @param {RepoSlug} slug
   * @param {string} base
   * @param {string} head
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function mergeBase({ owner, repo }, base, head, { signal } = {}) {
    const endpoint = `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`;
    const r = await api(endpoint, { signal });
    const sha = isObject(r) && isObject(r.merge_base_commit) ? r.merge_base_commit.sha : null;
    if (!isString(sha) || !sha) throw new GitHubResponseError(endpoint, 'no merge base commit');
    return sha;
  }

  /**
   * The PR's file list, with the unified-diff patch GitHub already computed. `patch`
   * is absent for binary files and for files over GitHub's size cap -- callers must
   * treat a missing patch as "no hunk information", not as "no changes".
   * @param {RepoSlug} slug
   * @param {number} number
   * @param {{ max?: number, signal?: AbortSignal }} [options]
   */
  async function listPullRequestFiles({ owner, repo }, number, { max = 300, signal } = {}) {
    /** @type {RawFile[]} */
    const out = [];
    const limit = Math.min(3000, Math.max(1, max));
    let more = false;
    for (let page = 1; page <= 30; page++) {
      const endpoint = `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`;
      const batch = await api(endpoint, { signal });
      if (!Array.isArray(batch)) throw new GitHubResponseError(endpoint, 'expected a list of files');
      for (const f of batch) {
        if (!isObject(f) || !isString(f.filename) || !isString(f.status)
          || (f.patch != null && !isString(f.patch))) {
          throw new GitHubResponseError(endpoint, 'a listed file lacks a string `filename` or `status`, or has a non-string `patch`');
        }
      }
      out.push(...batch);
      more = batch.length === 100;
      if (!more || out.length > limit) break;
    }
    const truncated = out.length > limit || more;
    return {
      truncated,
      total: out.length,
      totalIsLowerBound: more,
      files: out.slice(0, limit).map((f) => ({
        path: f.filename,
        oldPath: f.previous_filename || f.filename,
        status: f.status === 'renamed' ? 'renamed' : f.status,   // added|modified|removed|renamed
        patch: f.patch || null,
        sha: typeof f.sha === 'string' ? f.sha : null,
        additions: f.additions,
        deletions: f.deletions,
      })),
    };
  }

  /**
   * Raw file content at a ref. Uses the contents API with a raw Accept header so we
   * get the bytes directly instead of base64 in JSON.
   * @param {RepoSlug} slug
   * @param {string} filePath
   * @param {string} ref
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function fileAtRef({ owner, repo }, filePath, ref, { signal } = {}) {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const res = await send({
      url: `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      endpoint: `/repos/${owner}/${repo}/contents/${filePath}`,
      accept: 'application/vnd.github.raw+json', maxBytes: limits.maxFileBytes, signal,
      passStatuses: [404],
    });
    if (res.status === 404) return null;            // added on this branch, or deleted
    const body = /** @type {string} */ (res.text);   // null only for the passed 404, returned above
    // If the raw media type is not honoured (proxies and some enterprise setups strip
    // it) GitHub answers with JSON carrying base64 content. Returning that verbatim
    // would hand the parser a blob of JSON and produce zero symbols, silently.
    if (res.contentType.includes('application/json')) {
      try {
        const j = JSON.parse(body);
        if (j && typeof j.content === 'string' && j.encoding === 'base64') {
          return Buffer.from(j.content, 'base64').toString('utf8');
        }
        if (j && Array.isArray(j)) throw new Error(`${filePath} is a directory, not a file`);
        throw new Error(`unsupported file encoding for ${filePath}`);
      } catch (e) {
        if (/is a directory/.test(/** @type {Error} */ (e).message)) throw e;   // every throw above is an Error
        throw new Error(`unexpected JSON response for ${filePath}`, { cause: e });
      }
    }
    return body;
  }

  return {
    signIn, isSignedIn, account, signOutLocally, graphql, listOpenPullRequests, listMyTeams,
    listPullRequestFiles, fileAtRef, parseRemote, getPullRequest, mergeBase,
  };
}

module.exports = { createGitHub, parseRemote };
