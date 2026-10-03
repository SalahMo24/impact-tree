'use strict';
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { makeSymbols } = require('./engine/symbols');
const hash = (s) => createHash('sha256').update(s == null ? '<absent>' : s).digest('hex');

/**
 * Persisted review identities for one completed analysis. Offsets only locate a row;
 * each identity is built from the content that was reviewed, so a change to that
 * content, or to its base, makes the row unreviewed again.
 *
 * @param {object} ts
 * @param {string} repo Absolute repository root.
 * @param {object} revisions What was reviewed, by repository-relative path.
 * @param {(rel: string) => string|null} revisions.headText Head-side text; null when the file is absent there.
 * @param {(rel: string) => string|null} revisions.baseText Base-side text; null when the file is absent
 *   there. For a file outside the diff, its head text.
 * @param {(rel: string) => string|null} revisions.fileRevision Content token for a whole-file row; null
 *   when the content cannot be identified, which leaves that row without a persisted identity.
 * @returns {(node: object) => string|null}
 */
function createReviewIdentity(ts, repo, { headText, baseText, fileRevision }) {
  const S = makeSymbols(ts);
  // Cache: one entry per file with the ids and hashes of its symbols. Owner: this
  // identity, built by the session for one completed analysis and replaced by the next
  // (`review.configure`). Key: absolute file path; its head and base text come from the
  // `revisions` given at creation, so the revision is the owner's context. A local
  // head is read from disk the first time a row of the file is identified and then
  // kept, so an edit after that does not change the file's ids until the next analysis.
  // Invalidation: none; the next analysis builds a new identity. Disposal: garbage with
  // the identity.
  const cache = new Map();
  const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true);
  // An entry keeps ids and hashes, not syntax trees: it lives as long as the review does.
  const read = (file) => {
    if (cache.has(file)) return cache.get(file);
    const rel = path.relative(repo, file).split(path.sep).join('/');
    const head = headText(rel);
    const base = baseText(rel);
    const headSymbols = head == null ? [] : S.collect(parse(file, head));
    const baseSymbols = base == null ? [] : base === head ? headSymbols : S.collect(parse(file, base));
    const baseSliceHash = new Map(baseSymbols.map((b) => [b.key, hash(base.slice(b.start, b.end))]));
    const byNamePos = new Map(), byClassPos = new Map();
    for (const s of headSymbols) {
      const id = `${rel}#${s.key}:${hash(head.slice(s.start, s.end))}:${baseSliceHash.get(s.key) || hash(null)}`;
      if (!byNamePos.has(s.namePos)) byNamePos.set(s.namePos, id);
      if (s.isConstructor && !byClassPos.has(s.classNamePos)) byClassPos.set(s.classNamePos, id);
    }
    const entry = { file, rel, head, baseHash: hash(base), baseSliceHash, byNamePos, byClassPos, declHashes: null };
    cache.set(file, entry);
    return entry;
  };
  // A caller the symbol collector does not record -- a named function expression,
  // module-level code -- is identified by its own declaration, or by the whole file
  // when it is the module itself.
  const unrecordedId = (entry, n) => {
    if (!entry.declHashes) entry.declHashes = entry.head == null ? new Map() : declarationHashes(parse(entry.file, entry.head));
    return `${entry.rel}#@${n.label}:${entry.declHashes.get(n.pos) || hash(entry.head)}:${entry.baseHash}`;
  };

  return (n) => {
    if (n.type === 'file') {
      const token = n.relPath ? fileRevision(n.relPath) : null;
      return token == null ? null : `file:${n.relPath}:${token}`;
    }
    const file = n.file || n.absPath || (n.relPath && path.join(repo, n.relPath));
    if (!file) return null;
    const entry = read(file);
    if (n.type === 'deleted') {
      const key = n.key || n.label;
      return `deleted:${entry.rel}#${key}:${entry.baseSliceHash.get(key) || hash(null)}`;
    }
    return entry.byNamePos.get(n.pos) || entry.byClassPos.get(n.pos) || unrecordedId(entry, n);
  };

  // Callers are anchored at their declaration's name: name start -> hash of that
  // declaration's text, for every named node in the file. One parse per file, which is
  // then dropped; an explicit stack, so a deep file cannot overflow the call stack.
  function declarationHashes(sf) {
    const out = new Map();
    const stack = [sf];
    while (stack.length) {
      const node = stack.pop();
      if (node.name && ts.isIdentifier(node.name)) {
        const at = node.name.getStart(sf);
        if (!out.has(at)) out.set(at, hash(node.getText(sf)));
      }
      ts.forEachChild(node, (k) => { stack.push(k); });
    }
    return out;
  }
}

/**
 * Revisions for a local analysis. The head side is the worktree. The base side is the
 * text the analysis already loaded, so building identities starts no `git show` per file.
 * @param {string} repo Absolute repository root.
 * @param {object} result An `analyze()` result.
 * @param {{show: Function, blobIds: Function}} git For bases outside `result.baseTexts`.
 */
function localRevisions(repo, result, git) {
  const inDiff = result.fileStatus || {};
  const basePathOf = (rel) => (result.basePaths && result.basePaths[rel]) || rel;
  const readHead = (rel) => {
    // A path missing from the worktree is absent on the head side: deleted or renamed away.
    try { return fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { return null; }
  };
  // `createReviewIdentity` asks for a file's head and then its base, and keeps what it
  // needs, so only the most recent head is remembered: an unchanged file's base is its head.
  // Cache: the head text of the file last asked for. Owner: this `localRevisions` call,
  // one per local analysis. Key: repository-relative path. Invalidation: replaced by the
  // next path asked for. Disposal: with the analysis's identity.
  let lastHead = { rel: null, text: null };
  const headText = (rel) => {
    if (lastHead.rel !== rel) lastHead = { rel, text: readHead(rel) };
    return lastHead.text;
  };
  // Cache: base text by base-side path. Owner, invalidation and disposal as for
  // `lastHead`. The base commit is fixed in `result.base.sha`, so the path is a full key.
  const bases = new Map();
  const baseText = (rel) => {
    if (!inDiff[rel]) return headText(rel);          // unchanged against the base
    if (inDiff[rel] === 'added') return null;
    const at = basePathOf(rel);
    if (result.baseTexts && result.baseTexts.has(at)) return result.baseTexts.get(at);
    if (!bases.has(at)) bases.set(at, git.show(result.base.sha, at));
    return bases.get(at);
  };
  // File rows need only content ids. One batch covers every changed path, and the head
  // side is hashed without being kept, so a large lockfile is not retained.
  // Cache: git blob ids of the base side, read once for every changed path. Owner,
  // invalidation and disposal as for `lastHead`; the base commit is fixed in the result.
  let blobs = null;
  const fileRevision = (rel) => {
    if (!blobs) blobs = git.blobIds(result.base.sha, Object.keys(inDiff).map(basePathOf));
    const baseBlob = inDiff[rel] === 'added' ? null : blobs.get(basePathOf(rel));
    return `${hash(readHead(rel))}:${baseBlob || 'absent'}`;
  };
  return { headText, baseText, fileRevision };
}

/**
 * Revisions for a PR preview: only what was fetched from the PR, never the local checkout.
 * @param {object} result An `analyzeRemote()` result.
 */
function previewRevisions(result) {
  const texts = result.texts || new Map();
  const listed = new Map((result.otherFiles || []).map((f) => [f.path, f]));
  return {
    headText: (rel) => (texts.has(rel) ? texts.get(rel).head : null),
    baseText: (rel) => (texts.has(rel) ? texts.get(rel).base : null),
    fileRevision: (rel) => {
      if (texts.has(rel)) return `text:${hash(texts.get(rel).head)}:${hash(texts.get(rel).base)}`;
      return listed.get(rel)?.contentId ?? null;
    },
  };
}

module.exports = { createReviewIdentity, localRevisions, previewRevisions };
