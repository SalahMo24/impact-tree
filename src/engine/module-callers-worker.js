'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { worktreeFiles, isSourcePath, clearProjectCache } = require('./diff');
const { makeGit } = require('./git');
const { loadTypeScript } = require('./analyze');
const { createModuleCallers } = require('./module-callers');

const repo = workerData.repo;
const git = makeGit(repo);
let index = null;
let identity = null;
let builds = 0;

// Validate on every analysis, in the worker. HEAD, admitted path names and nanosecond
// modification/change times cover commits, adds/deletes, edits and config/package
// changes. This is a worktree index: no result claims to be an immutable disk snapshot.
function worktreeIdentity() {
  const files = worktreeFiles(git);
  if (!files) throw new Error('git could not list the repository files');
  const hash = createHash('sha256').update(git.revParse('HEAD') || '');
  for (const rel of files) {
    if (!isSourcePath(rel) && !['package.json', 'tsconfig.json', 'jsconfig.json'].includes(path.basename(rel))) continue;
    hash.update(rel).update('\0');
    try {
      const st = fs.statSync(path.join(repo, rel), { bigint: true });
      hash.update(`${st.size}:${st.mtimeNs}:${st.ctimeNs}\0`);
    } catch { hash.update('missing\0'); }
  }
  return hash.digest('hex');
}

// Serialize requests so an index reset cannot race an outstanding syntactic query.
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue.then(async () => {
    try {
      if (message.kind === 'prepare') {
        const next = `${message.compilerPath || 'bundled'}:${message.compilerVersion}:${worktreeIdentity()}`;
        if (!index || next !== identity) {
          clearProjectCache();
          const ts = message.compilerPath ? require(message.compilerPath) : loadTypeScript(repo, repo);
          index = createModuleCallers(ts, repo, git);
          identity = next;
          builds++;
        }
        index.resetHints();
        for (const c of message.hints) index.hint(c);
        parentPort.postMessage({ id: message.id, value: { builds } });
      } else {
        const answer = await index.incomingWithStatus(...message.args);
        parentPort.postMessage({ id: message.id, value: { answer, notes: index.notes() } });
      }
    } catch (e) {
      parentPort.postMessage({ id: message.id, error: e.message || 'cross-file caller index failed' });
    }
  });
});
