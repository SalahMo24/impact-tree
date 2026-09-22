'use strict';
// GitHub access with no dependency on the GitHub Pull Requests extension or the `gh`
// CLI: VS Code ships a built-in 'github' authentication provider, so we ask it for a
// token and call the REST API directly. A first-time user needs neither installed.
// Nothing in this module touches the worktree — checkout is the caller's decision.

// Matches both remote forms; the optional .git and any trailing slash are stripped so
// `repo` is never captured as "impact-tree.git".
function parseRemote(url) {
  const m = String(url || '').trim().replace(/\/+$/, '')
    .match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function createGitHub(vscode, { log = () => {} } = {}) {
  let session = null;

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

  async function api(pathname) {
    if (!session) throw new Error('not signed in to GitHub');
    if (typeof fetch !== 'function') throw new Error('this editor build has no global fetch — cannot reach the GitHub API');
    const res = await fetch(`https://api.github.com${pathname}`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401 || res.status === 403) {
      // A revoked or under-scoped token looks identical to "no PRs" unless we say so.
      session = null;
      throw new Error(`GitHub rejected the token (${res.status}) — sign in again`);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${pathname}`);
    return res.json();
  }

  async function listOpenPullRequests({ owner, repo }) {
    const raw = await api(`/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`);
    return raw.map((p) => ({
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
    }));
  }

  // The PR's file list, with the unified-diff patch GitHub already computed. `patch`
  // is absent for binary files and for files over GitHub's size cap -- callers must
  // treat a missing patch as "no hunk information", not as "no changes".
  async function listPullRequestFiles({ owner, repo }, number, { max = 300 } = {}) {
    const out = [];
    for (let page = 1; page <= 10 && out.length < max; page++) {
      const batch = await api(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    const truncated = out.length > max;
    return {
      truncated,
      total: out.length,
      files: out.slice(0, max).map((f) => ({
        path: f.filename,
        oldPath: f.previous_filename || f.filename,
        status: f.status === 'renamed' ? 'renamed' : f.status,   // added|modified|removed|renamed
        patch: f.patch || null,
        additions: f.additions,
        deletions: f.deletions,
      })),
    };
  }

  // Raw file content at a ref. Uses the contents API with a raw Accept header so we
  // get the bytes directly instead of base64 in JSON.
  async function fileAtRef({ owner, repo }, filePath, ref) {
    if (!session) throw new Error('not signed in to GitHub');
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 404) return null;            // added on this branch, or deleted
    if (res.status === 401 || res.status === 403) {
      session = null;
      throw new Error(`GitHub rejected the token (${res.status}) — sign in again`);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} fetching ${filePath}`);
    const body = await res.text();
    // If the raw media type is not honoured (proxies and some enterprise setups strip
    // it) GitHub answers with JSON carrying base64 content. Returning that verbatim
    // would hand the parser a blob of JSON and produce zero symbols, silently.
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      try {
        const j = JSON.parse(body);
        if (j && typeof j.content === 'string' && j.encoding === 'base64') {
          return Buffer.from(j.content, 'base64').toString('utf8');
        }
        if (j && Array.isArray(j)) throw new Error(`${filePath} is a directory, not a file`);
      } catch (e) {
        if (/is a directory/.test(e.message)) throw e;
        throw new Error(`unexpected JSON response for ${filePath}`);
      }
    }
    return body;
  }

  return {
    signIn, isSignedIn, account, signOutLocally, listOpenPullRequests,
    listPullRequestFiles, fileAtRef, parseRemote,
  };
}

module.exports = { createGitHub, parseRemote };
