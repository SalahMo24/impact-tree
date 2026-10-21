// @ts-check
'use strict';
// Where feedback drafts can be written and how they are drawn, decided without the editor
// (docs/UX_PLAN.md F1). `feedback-comments.js` connects these to VS Code's comments API.
//
// Feedback is offered on a result analysed from disk: a local review (any local mode:
// Uncommitted (agent), Since checkpoint, Branch + uncommitted, Branch vs base) or a pull
// request checked out here. Only on the head side of its files: the file on disk, which is
// the code the agent will change. The base side (`impacttree-base:`) and a previewed pull
// request's documents (`impacttree-pr:`) are never offered; a Preview's files are not on disk.

const path = require('path');

/**
 * @typedef {import('./feedback-drafts').FeedbackItem} FeedbackItem
 *
 * @typedef {object} FeedbackContext A local result feedback can be written on.
 * @property {number} analysisId The analysis the result belongs to.
 * @property {object} result The shown result; compared by identity to tell a newer one.
 * @property {string} repoRoot Absolute path of the repository.
 * @property {ReadonlySet<string>} files Repository-relative paths of the result's files
 *   that exist on disk (its changed files, less deleted ones).
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null;

/**
 * The files of a result feedback can be written on: its changed files that exist on the
 * head side. Bounded by the result's own file list.
 * @param {Record<string, any>} result
 * @returns {Set<string>}
 */
function headFilesOf(result) {
  const status = isObject(result.fileStatus) ? result.fileStatus : {};
  const paths = Array.isArray(result.changedPaths) ? result.changedPaths : [];
  return new Set(paths.filter((p) => typeof p === 'string' && p !== '' && status[p] !== 'deleted'));
}

/**
 * The result feedback can be written on, or null: no result shown, or a pull request
 * previewed from GitHub (its files are not on disk). A checked-out pull request takes
 * feedback as a local review does; its GitHub comments are offered alongside.
 * @param {{ source: unknown, result: unknown, repoRoot: string|null, analysisId: number }} input
 * @returns {FeedbackContext|null}
 */
function feedbackContextOf({ source, result, repoRoot, analysisId }) {
  if (!isOnDisk(source)) return null;
  if (!isObject(result) || result.tierA || !repoRoot) return null;
  return { analysisId, result, repoRoot, files: headFilesOf(result) };
}

/**
/**
 * Whether a source's files are the ones on disk: a local review or a checked-out pull request.
 * @param {unknown} source
 * @returns {boolean}
 */
const isOnDisk = (source) => isObject(source) && (source.kind === 'local' || source.kind === 'checkout');

/**
 * Whether drafts are drawn in the editor now: in a review of the files on disk, or before
 * anything has been reviewed. Not while a previewed pull request is shown.
 * @param {unknown} source The session's source; undefined before the first analysis.
 * @returns {boolean}
 */
const drawsDrafts = (source) => source === undefined || source === null || isOnDisk(source);

/**
 * The repository-relative path of a document on disk, or null for another scheme or a
 * file outside the repository.
 * @param {{ scheme: string, fsPath: string }} uri
 * @param {string} repoRoot
 * @returns {string|null}
 */
function relPathOf(uri, repoRoot) {
  if (uri.scheme !== 'file') return null;
  const rel = path.relative(repoRoot, uri.fsPath);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * The name of the change of `result` whose lines hold `line` of `relPath`: the innermost
 * one when they nest. Null when no change holds it. Bounded by the result's changes.
 * @param {Record<string, any>} result
 * @param {string} relPath
 * @param {number} line 1-based, on the head side.
 * @returns {string|null}
 */
function symbolAt(result, relPath, line) {
  /** @type {{ label: string, span: number }|null} */
  let best = null;
  for (const c of Array.isArray(result.allChanged) ? result.allChanged : []) {
    if (!isObject(c) || c.relPath !== relPath || typeof c.label !== 'string') continue;
    if (!(c.startLine <= line && line <= c.endLine)) continue;
    const span = c.endLine - c.startLine;
    if (!best || span < best.span) best = { label: c.label, span };
  }
  return best ? best.label : null;
}

/**
 * @typedef {object} DraftThreadSpec How one draft is drawn.
 * @property {string} id The draft's id.
 * @property {number} line 1-based line the thread sits on (line 1 for a whole-file draft).
 * @property {string} label
 * @property {string} body
 */

/** The label of a drawn draft. */
const DRAFT_LABEL = 'Feedback · draft';

/**
 * The label of a draft: what it is, and what it is about when that is not its line.
 * @param {Pick<FeedbackItem, 'line'|'symbol'|'caller'>} item
 * @returns {string}
 */
function draftLabel(item) {
  const about = [
    item.line === null ? (item.symbol ? `on ${item.symbol}` : 'on the whole file') : '',
    item.caller ? `about caller ${item.caller.label} (${item.caller.file}:${item.caller.line})` : '',
  ].filter(Boolean).join(', ');
  return about ? `${DRAFT_LABEL} · ${about}` : DRAFT_LABEL;
}

/**
 * The drafts drawn on one file, by line then age. A line past the end of the document (the
 * file got shorter) is drawn on its last line; the label keeps the stored line.
 * @param {readonly FeedbackItem[]} items
 * @param {string} relPath
 * @param {number} lineCount The document's line count.
 * @returns {DraftThreadSpec[]}
 */
function draftThreadSpecs(items, relPath, lineCount) {
  const last = Math.max(1, lineCount);
  return items
    .filter((i) => i.file === relPath)
    .map((i) => {
      const line = i.line === null ? 1 : Math.min(i.line, last);
      const moved = i.line !== null && i.line > last ? ` (line ${i.line} is past the end of the file)` : '';
      return { id: i.id, line, label: `${draftLabel(i)}${moved}`, body: i.body, at: i.createdAtMs };
    })
    .sort((a, b) => a.line - b.line || a.at - b.at)
    .map(({ id, line, label, body }) => ({ id, line, label, body }));
}

module.exports = { isOnDisk, feedbackContextOf, headFilesOf, drawsDrafts, relPathOf, symbolAt, draftThreadSpecs, draftLabel, DRAFT_LABEL };
