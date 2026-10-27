'use strict';
const path = require('path');
const { execFileSync, execFile } = require('child_process');

// A fetch can wait on the network or on a credential prompt nobody will ever answer.
// Run it off the extension host's thread, with a deadline and prompts disabled.
const FETCH_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: process.env.GIT_ASKPASS || '' };
const DEFAULT_FETCH_TIMEOUT_MS = 60000;

/**
 * @param {string} repo Repository root; every command runs there.
 * @param {{ objectDirs?: string[], env?: Record<string, string> }} [options]
 *   `objectDirs`: absolute object directories git may read besides the repository's own
 *   (`GIT_ALTERNATE_OBJECT_DIRECTORIES`), e.g. snapshot stores. `env`: extra environment for
 *   every command, e.g. `GIT_INDEX_FILE`. Both empty: the process environment is inherited as is.
 */
function makeGit(repo, { objectDirs = [], env: extraEnv = {} } = {}) {
  for (const d of objectDirs) {
    if (typeof d !== 'string' || !path.isAbsolute(d)) throw new TypeError(`objectDirs must be absolute paths, got ${JSON.stringify(d)}`);
  }
  const fixed = { ...extraEnv, ...(objectDirs.length ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirs.join(path.delimiter) } : {}) };
  const hasFixed = Object.keys(fixed).length > 0;
  // undefined (inherit) unless something has to be added, so the default path is unchanged.
  const envFor = (callEnv) => (hasFixed || callEnv ? { ...process.env, ...fixed, ...callEnv } : undefined);
  const git = (args, opts = {}) => {
    const { quiet, env, ...rest } = opts;
    return execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 28, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'], env: envFor(env), ...rest });
  };
  /** @param {string[]} args @param {{ timeoutMs?: number, env?: Record<string, string|undefined> }} [options] @returns {Promise<string>} */
  const rawAsync = (args, { timeoutMs = 0, env } = {}) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repo, maxBuffer: 1 << 28, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', env: envFor(env) },
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
          cwd: repo, env: envFor(), maxBuffer: 1 << 30, input: batchable.map((p) => `${rev}:${p}\n`).join(''),
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
    // Map(relPath -> blob id | null) without reading contents, in one process: a row for a
    // lockfile needs its identity, not its text.
    blobIds(rev, relPaths) {
      const out = new Map();
      const batchable = [...new Set(relPaths)].filter((p) => !/[\n\r]/.test(p));
      const one = (p) => this.revParse(`${rev}:${p}`);
      for (const p of relPaths) if (!batchable.includes(p)) out.set(p, one(p));
      if (!batchable.length) return out;
      let lines;
      try {
        lines = execFileSync('git', ['cat-file', '--batch-check'], {
          cwd: repo, env: envFor(), input: batchable.map((p) => `${rev}:${p}\n`).join(''), stdio: ['pipe', 'pipe', 'ignore'],
        }).toString('utf8').split('\n');
      } catch {
        for (const p of batchable) out.set(p, one(p));
        return out;
      }
      batchable.forEach((p, i) => {
        const m = /^([0-9a-f]+) (\w+) \d+$/.exec(lines[i] || '');   // "<spec> missing" otherwise
        out.set(p, m && m[2] === 'blob' ? m[1] : null);
      });
      return out;
    },
    isShallow() { try { return git(['rev-parse', '--is-shallow-repository'], { quiet: true }).trim() === 'true'; } catch { return false; } },
    isDirty(pathspec) {
      return git(['status', '--porcelain', ...(pathspec ? [pathspec] : [])])
        .split('\n').filter((l) => l && !l.startsWith('??'));
    },
    /**
     * The worktree's state from one `git status`: `dirty` the tracked changes (as isDirty
     * returns them), `untracked` the untracked, not-ignored files one by one (as
     * `ls-files --others --exclude-standard` lists them). Throws as isDirty does.
     * @returns {{ dirty: string[], untracked: string[] }}
     */
    worktreeStatus() {
      const tok = git(['-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
      const dirty = [];
      const untracked = [];
      for (let i = 0; i < tok.length; i++) {
        const entry = tok[i];
        if (!entry) continue;
        const code = entry.slice(0, 2);
        if (code === '??') untracked.push(entry.slice(3));
        else dirty.push(entry);
        if (code[0] === 'R' || code[0] === 'C') i++;   // -z puts a rename's old path in its own field
      }
      return { dirty, untracked };
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

// A remote name goes to git as an argument, so one that could be read as an option (a
// leading `-`) or that holds spaces is never accepted.
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isSafeRemoteName = (name) => typeof name === 'string' && name.length <= 255 && SAFE_REMOTE_NAME.test(name);

// `git fetch origin main` on a single-branch clone updates FETCH_HEAD and nothing else,
// so origin/main stayed wherever it was and the base was silently stale. Name the
// destination explicitly. `remote` is the git remote the base lives on ('origin' unless
// the caller found the GitHub repository under another name); it goes to git as an
// argument, so a name that could be read as an option is refused.
const checkedRemote = (remote) => {
  if (!isSafeRemoteName(remote)) throw new RangeError(`not a usable git remote name: ${JSON.stringify(remote)}`);
  return remote;
};
const stripRemote = (name, remote) => (name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name);

// The remote and branch a base name means. `<remote>/<branch>` with the default remote's
// prefix is that remote's branch. A prefix naming another remote of the repository (say
// `origin/main` while the GitHub remote is `upstream`) is kept as written: the base was
// always `origin/main` before remotes were configurable, and an explicit remote is the
// user's choice. Anything else is a branch on the default remote.
function baseOn(git, name, remote) {
  if (name.startsWith(`${remote}/`)) return { remote, branch: name.slice(remote.length + 1) };
  const slash = name.indexOf('/');
  if (slash > 0) {
    const named = name.slice(0, slash);
    const remotes = isSafeRemoteName(named) ? (git.tryRaw(['remote']) || '').split('\n').map((l) => l.trim()) : [];
    if (remotes.includes(named)) return { remote: named, branch: name.slice(slash + 1) };
  }
  return { remote, branch: name };
}
const refspecFor = (name, remote = 'origin') => {
  checkedRemote(remote);
  const branch = stripRemote(name, remote);
  return `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
};

// Async fetch of one branch into its remote-tracking ref. Never throws: returns a note.
async function fetchBranch(git, name, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, remote = 'origin' } = {}) {
  checkedRemote(remote);
  const on = baseOn(git, name, remote);
  const tracking = `${on.remote}/${on.branch}`;
  try {
    await git.rawAsync(['fetch', '--quiet', on.remote, refspecFor(on.branch, on.remote)], { timeoutMs, env: FETCH_ENV });
    return { ok: true, note: `fetched ${tracking}` };
  } catch (e) {
    return { ok: false, note: `fetch of ${tracking} failed (${e.message}) — using cached remote ref` };
  }
}

/**
 * The branch `remote` calls its default: `<remote>/HEAD` as clone (or `git remote set-head`)
 * recorded it, or, when it is not recorded, `main` or `master` if the remote has that branch.
 * Null when none is known. A repository whose default branch is `master` (encode/httpx) is
 * then reviewed against `origin/master` without a setting.
 * @param {ReturnType<typeof makeGit>} git
 * @param {string} remote A checked remote name.
 * @returns {string|null}
 */
function remoteDefaultBranch(git, remote) {
  checkedRemote(remote);
  const prefix = `refs/remotes/${remote}/`;
  // One process for the three refs (each git start costs tens of ms on a busy machine):
  // "<refname>\t<symref target>" for each that exists.
  const out = git.tryRaw(['for-each-ref', '--format=%(refname)%09%(symref)', `${prefix}HEAD`, `${prefix}main`, `${prefix}master`]) || '';
  const refs = new Map(out.split('\n').filter(Boolean).map((l) => /** @type {[string, string]} */ (l.split('\t'))));
  const head = (refs.get(`${prefix}HEAD`) || '').trim();
  if (head.startsWith(prefix) && head.length > prefix.length) return head.slice(prefix.length);
  for (const branch of ['main', 'master']) if (refs.has(`${prefix}${branch}`)) return branch;
  return null;
}

// The base branch to use when none is given: the remote's default, else `main` (whose
// absence then gives resolveBase's own error).
const baseOrDefault = (git, spec, remote) => spec || remoteDefaultBranch(git, remote) || 'main';

// resolveBase with the fetch done asynchronously, so the editor stays responsive.
async function resolveBaseAsync(git, spec, { fetch = false, allowLocal = false, timeoutMs, remote = 'origin' } = {}) {
  checkedRemote(remote);
  const notes = [];
  const base = spec && isRevExpression(spec) ? spec : baseOrDefault(git, spec, remote);
  if (fetch && !isRevExpression(base)) notes.push((await fetchBranch(git, base, { timeoutMs, remote })).note);
  const r = resolveBase(git, base, { fetch: false, allowLocal, remote });
  return { ...r, notes: [...notes, ...r.notes] };
}

function resolveBase(git, spec, { fetch = false, allowLocal = false, remote: remoteName = 'origin' } = {}) {
  checkedRemote(remoteName);
  const notes = [];
  if (spec && isRevExpression(spec)) {
    const sha = git.revParse(spec);
    if (sha) return { ref: spec, sha, notes };
    throw new Error(`cannot resolve base revision '${spec}'`);
  }
  // No base given: the remote's default branch (`origin/HEAD`), not always `main`.
  const base = baseOrDefault(git, spec, remoteName);
  const on = baseOn(git, base, remoteName);
  const name = on.remote === remoteName ? base : on.branch;
  const remote = `${on.remote}/${on.branch}`;
  if (fetch) {
    const r = git.tryRaw(['fetch', '--quiet', on.remote, refspecFor(on.branch, on.remote)]);
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
    const known = remoteDefaultBranch(git, on.remote);
    const hint = known && known !== on.branch ? ` ${on.remote}'s default branch is ${known}: set impactTree.baseBranch to ${known}, or leave it empty to use the default.` : '';
    throw new Error(`cannot resolve ${remote}. Fetch it, or pass allowLocal to fall back to local '${name}'.${hint}`);
  }
  const sha = git.revParse(name);
  if (!sha) throw new Error(`cannot resolve base ref '${name}'`);
  notes.push(`WARNING: ${remote} not found — falling back to local ${name}; diff may include others' commits`);
  return { ref: name, sha, notes };
}

/**
 * A cheap fingerprint of the repository around `dir`: where the nearest `.git` is and the mtime
 * of its config. It changes on `git init`, on removing `.git`, and on `git remote add`
 * (which rewrites the config), so answers cached under it stay current. No process is started.
 * @param {string} dir
 * @returns {string}
 */
function repoStamp(dir) {
  const fs = require('fs');
  const path = require('path');
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const dotGit = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { /* not here */ }
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (m) gitDir = path.resolve(d, m[1].trim());
        try { gitDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
      }
      let cfg = 0;
      try { cfg = fs.statSync(path.join(gitDir, 'config')).mtimeMs; } catch { /* no config */ }
      return `${dotGit}:${cfg}`;
    }
    if (path.dirname(d) === d) return 'none';
  }
}

module.exports = { repoStamp, makeGit, resolveBase, resolveBaseAsync, fetchBranch, remoteDefaultBranch, refspecFor, isSafeRemoteName, FETCH_ENV, DEFAULT_FETCH_TIMEOUT_MS };
