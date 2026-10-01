'use strict';
const { execFileSync, execFile } = require('child_process');

// A fetch can wait on the network or on a credential prompt nobody will ever answer.
// Run it off the extension host's thread, with a deadline and prompts disabled.
const FETCH_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: process.env.GIT_ASKPASS || '' };
const DEFAULT_FETCH_TIMEOUT_MS = 60000;

function makeGit(repo) {
  const git = (args, opts = {}) => {
    const { quiet, ...rest } = opts;
    return execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 28, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'], ...rest });
  };
  const rawAsync = (args, { timeoutMs = 0, env } = {}) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repo, maxBuffer: 1 << 28, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (err.killed) err.message = `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`;
        else if (stderr) err.message = String(stderr).trim().split('\n').pop();
        reject(err);
      });
  });
  return {
    raw: git,
    rawAsync,
    tryRaw(args) { try { return git(args, { quiet: true }); } catch { return null; } },
    revParse(ref) { try { return git(['rev-parse', ref], { quiet: true }).trim(); } catch { return null; } },
    mergeBase(a, b) { try { return git(['merge-base', a, b], { quiet: true }).trim(); } catch { return null; } },
    show(rev, relPath) { try { return git(['show', `${rev}:${relPath}`], { quiet: true }); } catch { return null; } },
    // Many blobs from ONE process instead of a `git show` per file. Returns
    // Map(relPath -> text | null). A path git's batch protocol cannot carry (a newline
    // in it) falls back to `show`.
    showMany(rev, relPaths) {
      const out = new Map();
      const batchable = [...new Set(relPaths)].filter((p) => !/[\n\r]/.test(p));
      for (const p of relPaths) if (!batchable.includes(p)) out.set(p, this.show(rev, p));
      if (!batchable.length) return out;
      let buf;
      try {
        buf = execFileSync('git', ['cat-file', '--batch'], {
          cwd: repo, maxBuffer: 1 << 30, input: batchable.map((p) => `${rev}:${p}\n`).join(''),
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        for (const p of batchable) out.set(p, this.show(rev, p));
        return out;
      }
      let at = 0;
      for (const p of batchable) {
        const nl = buf.indexOf(10, at);
        if (nl === -1) { out.set(p, null); continue; }
        const header = buf.toString('utf8', at, nl);
        at = nl + 1;
        const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!m) { out.set(p, null); continue; }          // "<spec> missing" / "ambiguous"
        const size = Number(m[2]);
        out.set(p, m[1] === 'blob' ? buf.toString('utf8', at, at + size) : null);
        at += size + 1;                                  // content is followed by a newline
      }
      return out;
    },
    isShallow() { try { return git(['rev-parse', '--is-shallow-repository'], { quiet: true }).trim() === 'true'; } catch { return false; } },
    isDirty(pathspec) {
      return git(['status', '--porcelain', ...(pathspec ? [pathspec] : [])])
        .split('\n').filter((l) => l && !l.startsWith('??'));
    },
    currentBranch() { return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); },
  };
}

// The stale-local-base bug: `main` 6 commits behind `origin/main` turned a 37-file
// PR into a 130-file diff. Always prefer the fetched remote ref.
// `origin/<name>` is the right base for a BRANCH -- the stale-local-main bug turned a
// 37-file PR into a 130-file one. It is wrong for a revision expression: `HEAD~40`
// silently became `origin/HEAD~40`, which resolves (origin/HEAD is the remote's
// default branch) and pointed 421 commits away, yielding an empty diff and a tree
// that looked like "nothing changed".
const isRevExpression = (spec) => /[~^@:]/.test(spec)
  || /^[0-9a-f]{7,40}$/i.test(spec)
  || spec === 'HEAD';

// `git fetch origin main` on a single-branch clone updates FETCH_HEAD and nothing else,
// so origin/main stayed wherever it was and the base was silently stale. Name the
// destination explicitly.
const refspecFor = (name) => {
  const branch = name.replace(/^origin\//, '');
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
};

// Async fetch of one branch into its remote-tracking ref. Never throws: returns a note.
async function fetchBranch(git, name, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const remote = `origin/${name.replace(/^origin\//, '')}`;
  try {
    await git.rawAsync(['fetch', '--quiet', 'origin', refspecFor(name)], { timeoutMs, env: FETCH_ENV });
    return { ok: true, note: `fetched ${remote}` };
  } catch (e) {
    return { ok: false, note: `fetch of ${remote} failed (${e.message}) — using cached remote ref` };
  }
}

// resolveBase with the fetch done asynchronously, so the editor stays responsive.
async function resolveBaseAsync(git, spec, { fetch = false, allowLocal = false, timeoutMs } = {}) {
  const notes = [];
  if (fetch && !(spec && isRevExpression(spec))) notes.push((await fetchBranch(git, spec || 'main', { timeoutMs })).note);
  const r = resolveBase(git, spec, { fetch: false, allowLocal });
  return { ...r, notes: [...notes, ...r.notes] };
}

function resolveBase(git, spec, { fetch = false, allowLocal = false } = {}) {
  const notes = [];
  if (spec && isRevExpression(spec)) {
    const sha = git.revParse(spec);
    if (sha) return { ref: spec, sha, notes };
    throw new Error(`cannot resolve base revision '${spec}'`);
  }
  const name = spec || 'main';
  const remote = `origin/${name.replace(/^origin\//, '')}`;
  if (fetch) {
    const r = git.tryRaw(['fetch', '--quiet', 'origin', refspecFor(name)]);
    notes.push(r === null ? `fetch of ${remote} failed — using cached remote ref` : `fetched ${remote}`);
  }
  const remoteSha = git.revParse(remote);
  if (remoteSha) {
    const localSha = git.revParse(name);
    if (localSha && localSha !== remoteSha) {
      const behind = (git.tryRaw(['rev-list', '--count', `${name}..${remote}`]) || '0').trim();
      notes.push(`local ${name} is ${behind} commit(s) behind ${remote} — using ${remote}`);
    }
    return { ref: remote, sha: remoteSha, notes };
  }
  if (!allowLocal) {
    throw new Error(`cannot resolve ${remote}. Fetch it, or pass allowLocal to fall back to local '${name}'.`);
  }
  const sha = git.revParse(name);
  if (!sha) throw new Error(`cannot resolve base ref '${name}'`);
  notes.push(`WARNING: ${remote} not found — falling back to local ${name}; diff may include others' commits`);
  return { ref: name, sha, notes };
}
module.exports = { makeGit, resolveBase, resolveBaseAsync, fetchBranch, refspecFor, FETCH_ENV, DEFAULT_FETCH_TIMEOUT_MS };
