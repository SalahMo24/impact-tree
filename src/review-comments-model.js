// @ts-check
'use strict';
// What the review diff shows of a pull request's review threads, and where a reviewer may
// start one, decided without the editor: which pull request side a document is, the lines
// GitHub accepts a comment on there, and what each drawn thread says and allows.
// `review-comments.js` connects these to VS Code's comments API.

const path = require('path');
const { parsePrAddress, prKey } = require('./pr-documents');

/**
 * @typedef {'LEFT'|'RIGHT'} Side LEFT is the base file, RIGHT the head file.
 * @typedef {import('./engine/diff-lines').DiffLines} DiffLines
 * @typedef {import('./pr-review-data').ReviewModel} ReviewModel
 * @typedef {import('./pr-review-data').ReviewThread} ReviewThread
 * @typedef {import('./pr-review-store').ReviewTarget} ReviewTarget
 *
 * @typedef {{ kind: 'pr', number: number, headOid: string, revision: string|null,
 *     diffLines: Record<string, DiffLines>|null }
 *   | { kind: 'checkout', number: number, headOid: string, repoRoot: string, baseSha: string|null,
 *     headPathOf: Record<string, string>, diffLines: Record<string, DiffLines>|null }} CommentingContext
 *   Where the pull request under review can be shown. `pr`: a preview, whose documents
 *   are `impacttree-pr:` addresses; `revision` is the shown result's (null while none
 *   is), and only a document of that revision is offered commenting. `checkout`: the
 *   pull request's head is the checked-out commit; its head side is the file on disk and
 *   its base side `impacttree-base:` at `baseSha`. `headPathOf` maps a renamed file's
 *   base path to its path in the pull request, which is the path GitHub names threads
 *   by. `diffLines` is null when no result describes the lines GitHub's diff shows.
 *
 * @typedef {{ path: string, side: Side, exact: boolean }} DocumentSide `path` is
 *   repository-relative. `exact`: the document is of the revision `diffLines` describes,
 *   so commenting may be offered on it.
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null;

/** @param {Record<string, string>|undefined} basePaths head path → base path */
function invert(basePaths) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [head, base] of Object.entries(basePaths || {})) out[base] = head;
  return out;
}

/**
 * Where the pull request under review is shown, or null when it is not shown anywhere
 * comments can be drawn: no pull request target, a local or agent review, a source for
 * another pull request or commit, or a checkout whose worktree has moved off the head.
 *
 * @param {{
 *   target: ReviewTarget|null,
 *   source: unknown,
 *   result: Record<string, any>|null,
 *   head: string|null,
 *   repoRoot: string,
 *   retainedBase?: { headOid: string, baseSha: string, headPathOf: Record<string, string> }|null,
 * }} input `target` is the review store's; `source` and `result` the session's
 *   (`result` null while a run is under way); `head` the worktree's HEAD commit, read only
 *   for a checkout (null when it could not be read). `retainedBase` is what an earlier
 *   result of the same checkout said about its base side, kept so the base documents keep
 *   their threads while the checkout is re-analysed.
 * @returns {CommentingContext|null}
 */
function commentingContextOf({ target, source, result, head, repoRoot, retainedBase = null }) {
  if (!target || !isObject(source) || !isObject(source.pr) || source.pr.number !== target.number) return null;
  if (source.kind === 'pr') {
    if (source.pr.headSha !== target.headOid) return null;
    const shown = result && result.tierA && result.prNumber === target.number && result.headSha === target.headOid ? result : null;
    return { kind: 'pr', number: target.number, headOid: target.headOid,
      revision: shown ? prKey(shown) : null, diffLines: shown ? shown.diffLines || null : null };
  }
  if (source.kind === 'checkout') {
    // GitHub's lines are the head commit's: a worktree on another commit would put a
    // comment on the wrong line, so nothing is drawn or offered there.
    if (source.sha !== target.headOid || head !== target.headOid) return null;
    // `pr` is the effective mode only when the worktree was clean: a dirty one falls back
    // to `branch`, whose diff includes the uncommitted work GitHub has not seen.
    const committed = result && result.mode === 'pr' ? result : null;
    const base = committed && committed.base && typeof committed.base.sha === 'string'
      ? { baseSha: committed.base.sha, headPathOf: invert(committed.basePaths) }
      : retainedBase && retainedBase.headOid === target.headOid ? retainedBase : null;
    return { kind: 'checkout', number: target.number, headOid: target.headOid, repoRoot,
      baseSha: base ? base.baseSha : null, headPathOf: base ? base.headPathOf : {},
      diffLines: committed ? committed.diffLines || null : null };
  }
  return null;
}

/**
 * Which side of which file of the pull request a document shows, or null when it shows
 * none (another revision, a file outside the repository, another scheme).
 * @param {{ scheme: string, path: string, query: string, fsPath: string }} uri
 * @param {CommentingContext} ctx
 * @returns {DocumentSide|null}
 */
function documentSide(uri, ctx) {
  if (ctx.kind === 'pr') {
    if (uri.scheme !== 'impacttree-pr') return null;
    const address = parsePrAddress(uri);
    const [number, headSha] = address.revision.split(':');
    if (Number(number) !== ctx.number || headSha !== ctx.headOid || !address.path) return null;
    return { path: address.path, side: address.side === 'base' ? 'LEFT' : 'RIGHT',
      exact: ctx.revision !== null && address.revision === ctx.revision };
  }
  if (uri.scheme === 'file') {
    const rel = path.relative(ctx.repoRoot, uri.fsPath);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return { path: rel.split(path.sep).join('/'), side: 'RIGHT', exact: true };
  }
  if (uri.scheme === 'impacttree-base') {
    if (ctx.baseSha === null || uri.query !== ctx.baseSha) return null;
    const basePath = uri.path.replace(/^\/+/, '');
    if (!basePath) return null;
    return { path: ctx.headPathOf[basePath] || basePath, side: 'LEFT', exact: true };
  }
  return null;
}

/**
 * The lines of a document a comment may be started on: those GitHub's diff shows on the
 * document's side, within the document.
 * @param {CommentingContext} ctx
 * @param {DocumentSide} at
 * @param {number} lineCount The document's line count.
 * @returns {Array<[number, number]>} 1-based, inclusive.
 */
function commentableLines(ctx, at, lineCount) {
  if (!at.exact || !ctx.diffLines) return [];
  const lines = ctx.diffLines[at.path];
  if (!lines) return [];
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const [lo, hi] of at.side === 'LEFT' ? lines.left : lines.right) {
    const a = Math.max(1, lo), b = Math.min(lineCount, hi);
    if (a <= b) out.push([a, b]);
  }
  return out;
}

/**
 * Whether a comment on lines `startLine`..`line` (1-based) is one GitHub accepts there:
 * both ends inside the same span of the diff on that side.
 * @param {CommentingContext} ctx
 * @param {DocumentSide} at
 * @param {number} startLine
 * @param {number} line
 * @returns {boolean}
 */
function acceptsComment(ctx, at, startLine, line) {
  if (!at.exact || !ctx.diffLines || !ctx.diffLines[at.path] || startLine > line) return false;
  const spans = at.side === 'LEFT' ? ctx.diffLines[at.path].left : ctx.diffLines[at.path].right;
  return spans.some(([lo, hi]) => lo <= startLine && line <= hi);
}

/**
 * @typedef {object} CommentSpec
 * @property {string} id GraphQL node id.
 * @property {string} author Login; `ghost` for a deleted account, as GitHub shows it.
 * @property {string|null} avatarUrl
 * @property {string} body Markdown, as written.
 * @property {string} createdAt ISO 8601.
 * @property {boolean} pending
 * @property {string} contextValue `pendingMine` for the viewer's own pending comment,
 *   which can be deleted; otherwise empty.
 *
 * @typedef {object} ThreadSpec
 * @property {string} id GraphQL node id.
 * @property {number} startLine 1-based first line.
 * @property {number} line 1-based last line.
 * @property {boolean} resolved
 * @property {'Pending'|'Unresolved'|'Resolved'} label Pending: only the viewer's pending
 *   comments, not yet visible to anyone else.
 * @property {boolean} canReply
 * @property {string} contextValue Space-separated actions that apply: `canReply`,
 *   `canResolve`, `canUnresolve`. Matched by the `when` clauses in package.json.
 * @property {CommentSpec[]} comments Oldest first.
 */

/**
 * What a thread shows and allows. Only a posted thread is replied to or resolved, as on
 * GitHub's own page: a thread of pending comments is still the viewer's draft.
 * @param {ReviewThread} t A thread with a line.
 * @returns {ThreadSpec}
 */
function threadSpec(t) {
  const posted = t.comments.some((c) => !c.pending);
  const label = !posted ? 'Pending' : t.isResolved ? 'Resolved' : 'Unresolved';
  const canReply = posted && t.canReply;
  const actions = [
    canReply ? 'canReply' : '',
    posted && !t.isResolved && t.canResolve ? 'canResolve' : '',
    posted && t.isResolved && t.canUnresolve ? 'canUnresolve' : '',
  ].filter(Boolean);
  const line = /** @type {number} */ (t.line);
  return {
    id: t.id, line, startLine: t.startLine !== null && t.startLine <= line ? t.startLine : line,
    resolved: t.isResolved, label, canReply, contextValue: actions.join(' '),
    comments: t.comments.map((c) => ({
      id: c.id, author: c.author ? c.author.login : 'ghost', avatarUrl: c.author ? c.author.avatarUrl : null,
      body: c.body, createdAt: c.createdAt, pending: c.pending, contextValue: c.pending && c.mine ? 'pendingMine' : '',
    })),
  };
}

/**
 * The threads drawn on one side of one file: placed on a line of the current diff, so not
 * outdated and not file-level (those are listed in Details). Sorted by line, then id.
 * @param {Pick<ReviewModel, 'threads'>} model
 * @param {string} relPath
 * @param {Side} side
 * @returns {ThreadSpec[]}
 */
function threadSpecsFor(model, relPath, side) {
  return model.threads
    .filter((t) => t.path === relPath && t.side === side && !t.isOutdated && !t.fileLevel && t.line !== null)
    .map(threadSpec)
    .sort((a, b) => a.line - b.line || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- starting a comment from the tree or Details ------------------------------------------

/**
 * @typedef {{ relPath: string, preferred: number, ranges: Array<[number, number]> }} CommentPlace
 *   Where a row's comment goes: `preferred` is the line it starts on when it can, `ranges`
 *   the row's head lines (1-based, inclusive) a nearer line may be taken from.
 */

/**
 * Where a "Comment on this change / these lines" button starts its comment: a change's
 * first line, or the first line of an outside row's first range. A deletion marker
 * (`N - 0.5`, the gap before line N) stands for line N, the line the diff shows after it.
 * @param {{ type: string, relPath?: string, finding?: { relPath: string, startLine: number, endLine: number }, ranges?: number[][] }} row
 * @returns {CommentPlace|null} Null for any other row.
 */
function rowCommentPlace(row) {
  if (row.type === 'finding' && row.finding) {
    const { relPath, startLine, endLine } = row.finding;
    return { relPath, preferred: startLine, ranges: [[startLine, endLine]] };
  }
  if (row.type === 'outside' && row.relPath && row.ranges && row.ranges.length) {
    /** @type {Array<[number, number]>} */
    const ranges = row.ranges.map(([lo, hi]) => [Math.ceil(lo), Math.max(Math.ceil(lo), Math.floor(hi))]);
    return { relPath: row.relPath, preferred: ranges[0][0], ranges };
  }
  return null;
}

/**
 * The line a comment on a row is started on: its preferred line when the diff shows it,
 * else the commentable line inside the row's ranges nearest to it (the earlier of two
 * equally near). Work is bounded by ranges × spans, not by line counts.
 * @param {Array<[number, number]>} spans The head lines GitHub's diff shows (`commentableLines`).
 * @param {CommentPlace} place
 * @returns {{ line: number } | { problem: string }}
 */
function chooseCommentLine(spans, { relPath, preferred, ranges }) {
  /** @type {number|null} */
  let best = null;
  for (const [lo, hi] of ranges) {
    for (const [a, b] of spans) {
      const from = Math.max(lo, a), to = Math.min(hi, b);
      if (from > to) continue;
      const line = Math.min(Math.max(preferred, from), to);
      if (best === null || Math.abs(line - preferred) < Math.abs(best - preferred)
        || (Math.abs(line - preferred) === Math.abs(best - preferred) && line < best)) best = line;
    }
  }
  if (best !== null) return { line: best };
  const one = ranges.length === 1 && ranges[0][0] === ranges[0][1];
  const where = ranges.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)).join(', ');
  return { problem: `${one ? 'line' : 'lines'} ${where} of ${relPath} ${one ? 'is' : 'are'} not in the pull request's diff, where GitHub takes comments; comment on the file instead` };
}

/**
 * @typedef {object} CallerContext A caller a comment is about, whose call is not on a line
 *   of the pull request's diff.
 * @property {string} label The caller's name.
 * @property {boolean} test The caller is a test.
 * @property {string} relPath Repository-relative path of its file.
 * @property {number} siteLine 1-based line of the call.
 * @property {string|null|undefined} callState `unchanged`, `changed-elsewhere`, `updated-at-call`, or unknown.
 */

/** @type {Record<string, string>} */
const CALL_NOTES = {
  unchanged: 'not changed by this PR',
  'changed-elsewhere': 'its function changed in this PR, but not this call',
  'updated-at-call': 'this call was changed by this PR',
};

/**
 * The block the extension adds after the reviewer's text for a caller outside the diff:
 * what the caller is, where its call is and what the pull request did to it, and a
 * permalink at the reviewed head commit on its own line (GitHub shows such a link as a
 * snippet of the code). Pure; its exact text is part of the contract.
 * @param {CallerContext} caller
 * @param {{ owner: string, name: string, headOid: string }} target The review store's target.
 * @returns {string} Starts with a blank line, so it follows the text as its own block.
 */
function callerContextBlock(caller, { owner, name, headOid }) {
  const note = (caller.callState && CALL_NOTES[caller.callState]) || 'call state unknown';
  const urlPath = caller.relPath.split('/').map(encodeURIComponent).join('/');
  return `\n\n---\n**Caller outside this PR's diff:** \`${caller.label}\`${caller.test ? ' (a test)' : ''} in \`${caller.relPath}\`, line ${caller.siteLine}: ${note}.\n`
    + `https://github.com/${owner}/${name}/blob/${headOid}/${urlPath}#L${caller.siteLine}`;
}

/**
 * The comment body sent for a draft about a caller: the reviewer's text, then the block.
 * @param {string} text
 * @param {CallerContext} caller
 * @param {{ owner: string, name: string, headOid: string }} target
 * @returns {string}
 */
const withCallerContext = (text, caller, target) => `${text.trimEnd()}${callerContextBlock(caller, target)}`;

/**
 * The label of a draft about a caller, saying what will be added and that it can be removed
 * (the thread's title action).
 * @param {CallerContext} caller
 * @returns {string}
 */
const callerDraftLabel = (caller) => `About caller ${caller.label} (${caller.relPath}:${caller.siteLine}) — added after your text · remove`;

module.exports = {
  commentingContextOf, documentSide, commentableLines, acceptsComment, threadSpecsFor,
  rowCommentPlace, chooseCommentLine, callerContextBlock, withCallerContext, callerDraftLabel,
};
