'use strict';
const { execFileSync } = require('child_process');

function makeGit(repo) {
  const git = (args, opts = {}) =>
    execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 28, encoding: 'utf8', stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'], ...opts });
  return {
    raw: git,
    tryRaw(args) { try { return git(args, { quiet: true }); } catch { return null; } },
    revParse(ref) { try { return git(['rev-parse', ref], { quiet: true }).trim(); } catch { return null; } },
    mergeBase(a, b) { try { return git(['merge-base', a, b], { quiet: true }).trim(); } catch { return null; } },
    show(rev, relPath) { try { return git(['show', `${rev}:${relPath}`], { quiet: true }); } catch { return null; } },
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
    const r = git.tryRaw(['fetch', 'origin', name.replace(/^origin\//, ''), '--quiet']);
    notes.push(r === null ? `fetch of origin/${name} failed — using cached remote ref` : `fetched origin/${name}`);
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
module.exports = { makeGit, resolveBase };
