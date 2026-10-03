'use strict';
// GitHub access with no dependency on the GitHub Pull Requests extension or the `gh`
// CLI: VS Code ships a built-in 'github' authentication provider, so we ask it for a
// token and call the REST API directly. A first-time user needs neither installed.
// Nothing in this module touches the worktree — checkout is the caller's decision.
//
// Every request goes through `send` -> `fetchBounded` (src/github-request.js), which owns
// the deadline, cancellation and size limits documented beside DEFAULT_LIMITS there.

const {
  DEFAULT_LIMITS, fetchBounded, GitHubAuthError, GitHubResponseError,
} = require('./github-request');

// Matches both remote forms; the optional .git and any trailing slash are stripped so
// `repo` is never captured as "impact-tree.git".
function parseRemote(url) {
  const m = String(url || '').trim().replace(/\/+$/, '')
    .match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';

// Checks the fields normalisePr reads, not the whole GitHub schema. Fields GitHub may
// legitimately leave out (a deleted user, a deleted fork) stay optional.
function checkPullRequest(p, endpoint) {
  const bad = (problem) => { throw new GitHubResponseError(endpoint, problem); };
  if (!isObject(p)) bad('a pull request is not an object');
  if (!Number.isSafeInteger(p.number)) bad('a pull request has no numeric `number`');
  if (!isString(p.title)) bad(`#${p.number} has no \`title\``);
  for (const side of ['head', 'base']) {
    if (!isObject(p[side]) || !isString(p[side].ref) || !isString(p[side].sha)) {
      bad(`#${p.number} has no \`${side}.ref\` and \`${side}.sha\``);
    }
  }
  if (p.changed_files != null && !Number.isSafeInteger(p.changed_files)) {
    bad(`#${p.number} has a non-numeric \`changed_files\``);
  }
  return p;
}

/**
 * @param {object} vscode The editor API; only `authentication.getSession` is used.
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 * @param {typeof fetch} [options.fetch] The HTTP client. Defaults to the global `fetch`,
 *   looked up per request. A seam so the request path can be driven by a fake.
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits] Overrides for DEFAULT_LIMITS;
 *   omitted limits keep their defaults. The extension passes none.
 */
function createGitHub(vscode, { log = () => {}, fetch: fetchImpl, limits: overrides } = {}) {
  let session = null;
  const limits = { ...DEFAULT_LIMITS, ...overrides };

  // silent:true asks "is there already a session?" without ever showing a modal, so the
  // view can render a sign-in row instead of ambushing the user on startup.
  async function signIn({ interactive = false } = {}) {
    try {
      session = await vscode.authentication.getSession(
        'github', ['repo'], interactive ? { createIfNone: true } : { silent: true });
    } catch (e) {
      log(`github auth failed: ${e.message}`);
      session = null;
    }
    return session;
  }

  const isSignedIn = () => !!session;
  const account = () => (session && session.account && session.account.label) || null;
  function signOutLocally() { session = null; }

  // The one door to the network: every call below goes through it, so the deadline, the
  // caller's cancellation and the size limit cannot be forgotten by a new endpoint.
  async function send({ url, endpoint, accept, maxBytes, signal, passStatuses }) {
    if (!session) throw new Error('not signed in to GitHub');
    const client = fetchImpl || globalThis.fetch;
    if (typeof client !== 'function') throw new Error('this editor build has no global fetch — cannot reach the GitHub API');
    try {
      return await fetchBounded(client, url, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }, { endpoint, deadlineMs: limits.requestTimeoutMs, maxBytes, signal, passStatuses });
    } catch (e) {
      // A revoked or under-scoped token looks identical to "no PRs" unless we say so.
      if (e instanceof GitHubAuthError) session = null;
      throw e;
    }
  }

  async function api(pathname, { signal } = {}) {
    const res = await send({
      url: `https://api.github.com${pathname}`, endpoint: pathname,
      accept: 'application/vnd.github+json', maxBytes: limits.maxJsonBytes, signal,
    });
    try { return JSON.parse(res.text); }
    catch { throw new GitHubResponseError(pathname, 'the body is not JSON'); }
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
    const listPage = async (page) => {
      const endpoint = `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`;
      const batch = await api(endpoint, { signal });
      if (!Array.isArray(batch)) throw new GitHubResponseError(endpoint, 'expected a list of pull requests');
      return batch.map((p) => checkPullRequest(p, endpoint));
    };
    const raw = [];
    for (let page = 1; page <= limits.maxPullRequestPages; page++) {
      const batch = await listPage(page);
      raw.push(...batch);
      if (batch.length < 100) return { pullRequests: raw.map(normalisePr), truncated: false };
    }
    // Every page up to the cap was full. One more request tells "exactly at the cap"
    // from "more exist" without trusting a header.
    const truncated = (await listPage(limits.maxPullRequestPages + 1)).length > 0;
    return { pullRequests: raw.map(normalisePr), truncated };
  }

  function normalisePr(p) {
    return {
      number: p.number,
      title: p.title,
      author: p.user && p.user.login,
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
    };
  }

  async function getPullRequest({ owner, repo }, number, { signal } = {}) {
    const endpoint = `/repos/${owner}/${repo}/pulls/${number}`;
    return normalisePr(checkPullRequest(await api(endpoint, { signal }), endpoint));
  }

  async function mergeBase({ owner, repo }, base, head, { signal } = {}) {
    const endpoint = `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`;
    const r = await api(endpoint, { signal });
    const sha = isObject(r) && isObject(r.merge_base_commit) ? r.merge_base_commit.sha : null;
    if (!isString(sha) || !sha) throw new GitHubResponseError(endpoint, 'no merge base commit');
    return sha;
  }

  // The PR's file list, with the unified-diff patch GitHub already computed. `patch`
  // is absent for binary files and for files over GitHub's size cap -- callers must
  // treat a missing patch as "no hunk information", not as "no changes".
  async function listPullRequestFiles({ owner, repo }, number, { max = 300, signal } = {}) {
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

  // Raw file content at a ref. Uses the contents API with a raw Accept header so we
  // get the bytes directly instead of base64 in JSON.
  async function fileAtRef({ owner, repo }, filePath, ref, { signal } = {}) {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const res = await send({
      url: `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      endpoint: `/repos/${owner}/${repo}/contents/${filePath}`,
      accept: 'application/vnd.github.raw+json', maxBytes: limits.maxFileBytes, signal,
      passStatuses: [404],
    });
    if (res.status === 404) return null;            // added on this branch, or deleted
    const body = res.text;
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
        if (/is a directory/.test(e.message)) throw e;
        throw new Error(`unexpected JSON response for ${filePath}`);
      }
    }
    return body;
  }

  return {
    signIn, isSignedIn, account, signOutLocally, listOpenPullRequests,
    listPullRequestFiles, fileAtRef, parseRemote, getPullRequest, mergeBase,
  };
}

module.exports = { createGitHub, parseRemote };
