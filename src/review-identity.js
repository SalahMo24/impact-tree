'use strict';
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { typescriptReviewSymbols } = require('./languages/typescript/review-symbols');
const { typescriptRules } = require('./languages/typescript/rules');
const hash = (s) => createHash('sha256').update(s == null ? '<absent>' : s).digest('hex');

const symbolHash = (text, symbol) => hash((symbol.reviewPrefix || '') + text.slice(symbol.start, symbol.end));

/**
 * Persisted review identities for one completed analysis. Offsets only locate a row;
 * each identity is built from the content that was reviewed, so a change to that
 * content, or to its base, makes the row unreviewed again.
 *
 * Where a file's symbols come from:
 * - Recorded by its provider during the analysis (`revisions.recordedSymbols`; a language
 *   whose symbols come from a language server, such as Go): the identity hashes the
 *   recorded declarations' text and parses nothing. The recorded offsets are used only
 *   while the text the identity reads hashes to the one they were recorded for; when it
 *   does not (the file was edited after the analysis read it), every row of the file is
 *   identified by the whole file's head and base text until the next analysis
 *   (conservative, never stale).
 * - Otherwise, for a TypeScript or JavaScript file, parsed with the TypeScript provider's
 *   helpers (src/languages/typescript/review-symbols.js).
 * - Otherwise (a caller in a file of another language that the analysis did not record,
 *   such as an unchanged Go file): the whole file's head and base text, as above.
 *
 * @param {object|null} ts The TypeScript module. Null: loaded from `repo` the first time
 *   a symbol, deleted or outside row is identified, so a review whose rows are all files
 *   never loads it.
 * @param {string} repo Absolute repository root.
 * @param {object} revisions What was reviewed, by repository-relative path.
 * @param {(rel: string) => string|null} revisions.headText Head-side text; null when the file is absent there.
 * @param {(rel: string) => string|null} revisions.baseText Base-side text; null when the file is absent
 *   there. For a file outside the diff, its head text.
 * @param {(rel: string) => string|null} revisions.fileRevision Content token for a whole-file row; null
 *   when the content cannot be identified, which leaves that row without a persisted identity.
 * @param {(rel: string) => import('./languages/types').RecordedSymbols|null} [revisions.recordedSymbols] The
 *   symbols the analysis recorded for a file (`result.reviewSymbols`); null or omitted: none.
 * @returns {(node: object) => string|null}
 */
function createReviewIdentity(ts, repo, { headText, baseText, fileRevision, recordedSymbols = () => null }) {
  /** @type {ReturnType<typeof typescriptReviewSymbols>|null} */
  let steps = null;
  const typescript = () => {
    if (!steps) steps = typescriptReviewSymbols(ts || require('./languages/typescript/load').loadTypeScript(repo, repo));
    return steps;
  };
  // Cache: one entry per file with the ids and hashes of its symbols. Owner: this
  // identity, built by the session for one completed analysis and replaced by the next
  // (`review.configure`). Key: absolute file path; its head and base text come from the
  // `revisions` given at creation, so the revision is the owner's context. A local
  // head is read from disk the first time a row of the file is identified and then
  // kept, so an edit after that does not change the file's ids until the next analysis.
  // Invalidation: none; the next analysis builds a new identity. Disposal: garbage with
  // the identity.
  const cache = new Map();
  // An entry keeps ids and hashes, not syntax trees: it lives as long as the review does.
  const read = (file) => {
    if (cache.has(file)) return cache.get(file);
    const rel = path.relative(repo, file).split(path.sep).join('/');
    const head = headText(rel);
    const base = baseText(rel);
    const recorded = recordedSymbols(rel);
    if (recorded || !typescriptRules.handles(rel)) {
      const entry = recorded && matches(recorded.head, head) && matches(recorded.base, base)
        ? fromRecorded(file, rel, head, base, recorded)
        : { file, rel, head, baseHash: hash(base), wholeFile: `${hash(head)}:${hash(base)}` };
      cache.set(file, entry);
      return entry;
    }
    const { parse, collect, blankSpans } = typescript();
    const headSf = head == null ? null : parse(file, head);
    const baseSf = base == null ? null : base === head ? headSf : parse(file, base);
    const headSymbols = headSf ? collect(headSf) : [];
    const baseSymbols = baseSf ? baseSf === headSf ? headSymbols : collect(baseSf) : [];
    const baseSliceHash = new Map(baseSymbols.map((b) => [b.key, symbolHash(base, b)]));
    const byNamePos = new Map(), byClassPos = new Map();
    for (const s of headSymbols) {
      const id = `${rel}#${s.key}:${symbolHash(head, s)}:${baseSliceHash.get(s.key) || hash(null)}`;
      if (!byNamePos.has(s.namePos)) byNamePos.set(s.namePos, id);
      if (s.isConstructor && !byClassPos.has(s.classNamePos)) byClassPos.set(s.classNamePos, id);
    }
    const entry = {
      file, rel, head, baseHash: hash(base), baseSliceHash, byNamePos, byClassPos, declHashes: null,
      // Of everything outside the callables, on each side; see `outsideId`.
      outsideHash: `${hash(blankSpans(headSf, headSymbols))}:${hash(blankSpans(baseSf, baseSymbols))}`,
    };
    cache.set(file, entry);
    return entry;
  };
  // A file whose symbols were recorded: the same ids as a parsed file's, from the recorded
  // offsets. A caller at no recorded name (`declHashes` empty) is identified by the head.
  const fromRecorded = (file, rel, head, base, recorded) => {
    const headSymbols = recorded.head ? recorded.head.symbols : [];
    const baseSymbols = recorded.base ? recorded.base.symbols : [];
    const baseSliceHash = new Map(baseSymbols.map((b) => [b.key, symbolHash(base, b)]));
    const byNamePos = new Map();
    for (const s of headSymbols) {
      if (!byNamePos.has(s.namePos)) byNamePos.set(s.namePos, `${rel}#${s.key}:${symbolHash(head, s)}:${baseSliceHash.get(s.key) || hash(null)}`);
    }
    return {
      file, rel, head, baseHash: hash(base), baseSliceHash, byNamePos, byClassPos: new Map(), declHashes: new Map(),
      outsideHash: `${hash(withoutLines(head, headSymbols))}:${hash(withoutLines(base, baseSymbols))}`,
    };
  };

  // A caller the symbol collector does not record -- a named function expression,
  // module-level code -- is identified by its own declaration, or by the whole file
  // when it is the module itself.
  const unrecordedId = (entry, n) => {
    if (!entry.declHashes) {
      const { parse, declarationHashes } = typescript();
      entry.declHashes = entry.head == null ? new Map() : declarationHashes(parse(entry.file, entry.head));
    }
    return `${entry.rel}#@${n.label}:${entry.declHashes.get(n.pos) || hash(entry.head)}:${entry.baseHash}`;
  };

  // The changed lines outside every callable are identified by everything outside them: each
  // side's text with every callable's lines cut out. A body edit leaves that text
  // as it was; an edit to an import, a constant or a type changes it, and so does a changed
  // base, as for a symbol. Not the row's ranges: line numbers move when a function above grows.
  const outsideId = (entry) => `${entry.rel}#outside:${entry.outsideHash}`;

  return (n) => {
    if (n.type === 'file') {
      const token = n.relPath ? fileRevision(n.relPath) : null;
      return token == null ? null : `file:${n.relPath}:${token}`;
    }
    const file = n.file || n.absPath || (n.relPath && path.join(repo, n.relPath));
    if (!file) return null;
    const entry = read(file);
    if (entry.wholeFile) {
      if (n.type === 'outside') return `${entry.rel}#outside:${entry.wholeFile}`;
      if (n.type === 'deleted') return `deleted:${entry.rel}#${n.key || n.label}:${entry.wholeFile}`;
      return `${entry.rel}#@${n.label}:${entry.wholeFile}`;
    }
    if (n.type === 'outside') return outsideId(entry);
    if (n.type === 'deleted') {
      const key = n.key || n.label;
      return `deleted:${entry.rel}#${key}:${entry.baseSliceHash.get(key) || hash(null)}`;
    }
    return entry.byNamePos.get(n.pos) || entry.byClassPos.get(n.pos) || unrecordedId(entry, n);
  };
}

/**
 * Whether a recorded side describes `text`: both absent, or the text hashes to the one the
 * offsets were recorded for.
 * @param {import('./languages/types').RecordedSide|null} side
 * @param {string|null} text
 */
const matches = (side, text) => (side == null ? text == null : text != null && hash(text) === side.textHash);

/**
 * A side's text without its symbols' lines, for an outside row's identity: whole lines are
 * cut, from the line a symbol starts on to the line it ends on, so adding or removing a
 * function leaves nothing behind but blank separator lines. Each run of blank lines then
 * counts as one, and blank lines at either end are dropped: moving or removing a function
 * keeps the identity, while a line added or removed anywhere else changes it. Residual:
 * growing an existing run of blank lines (inside a raw string, say) does not. Null stays
 * null (an absent side). Language-neutral: it reads only line numbers.
 * @param {string|null} text
 * @param {Array<{ startLine: number, endLine: number }>} symbols One-based, inclusive.
 * @returns {string|null}
 */
function withoutLines(text, symbols) {
  if (text == null) return null;
  const cut = new Set();
  for (const s of symbols) for (let line = s.startLine; line <= s.endLine; line++) cut.add(line);
  const kept = [];
  text.split('\n').forEach((line, index) => {
    if (cut.has(index + 1)) return;
    const blank = line.trim() === '';
    if (blank && (!kept.length || kept[kept.length - 1] === '')) return;
    kept.push(blank ? '' : line);
  });
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.join('\n');
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
  // Recorded by the providers whose symbols come from a language server (Go); a result
  // from before they recorded any has none.
  const recordedSymbols = (rel) => (result.reviewSymbols && result.reviewSymbols.get(rel)) || null;
  return { headText, baseText, fileRevision, recordedSymbols };
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
    // Recorded for the files a language read from its text (Python); TypeScript is parsed.
    recordedSymbols: (rel) => (result.reviewSymbols && result.reviewSymbols.get(rel)) || null,
  };
}

module.exports = { createReviewIdentity, localRevisions, previewRevisions };
