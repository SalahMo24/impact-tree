// @ts-check
'use strict';
// Suggested changes in review comments, decided without the editor or git: the
// ```suggestion blocks a comment holds, the block a new suggestion starts with, whether a
// suggestion may be applied to the checkout, and the edit that applies it.
// `review-comments.js` connects these to VS Code and git.
//
// Line conventions (§9): `startLine`/`line` are GitHub's, 1-based and inclusive, on the
// head side. `TextEdit` positions are VS Code's, 0-based lines and characters. A file's
// text is handled as `lines`, its text split at each line break (`\r\n` or `\n`), so a
// file that ends with a line break has an empty last element, as VS Code's `lineCount`
// counts it.

/**
 * @typedef {{ text: string|null }} Suggestion The replacement for the commented lines, its
 *   lines joined by `\n`. Null for an empty block, which deletes the lines; a block holding
 *   one blank line is `''` and replaces them with one blank line, as on GitHub.
 *
 * @typedef {{ line: number, character: number }} Position0 0-based, as VS Code's.
 * @typedef {{ start: Position0, end: Position0, text: string }} TextEdit Replace the text
 *   from `start` to `end` with `text`.
 *
 * @typedef {object} SuggestionThread The parts of a review thread an apply depends on.
 * @property {string} path Repository-relative.
 * @property {'LEFT'|'RIGHT'} side
 * @property {number|null} line 1-based last line in the current diff; null when outdated or file-level.
 * @property {number|null} startLine 1-based first line, null for a one-line thread.
 * @property {boolean} isOutdated
 * @property {boolean} fileLevel
 *
 * @typedef {{ ok: true, path: string, startLine: number, line: number, text: string|null }
 *   | { ok: false, reason: string }} ApplyDecision `startLine`..`line` are 1-based, inclusive.
 */

/** @param {string} text @returns {string[]} */
const splitLines = (text) => text.split(/\r\n|\n/);

/**
 * The line break a file uses: that of its first line break, `\n` when it has none.
 * @param {string} text
 * @returns {'\r\n'|'\n'}
 */
function eolOf(text) {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

// A fence line: up to 3 spaces, a run of 3+ backticks or tildes, then the info string.
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * The suggestions in a comment body: fenced code blocks whose info string is exactly
 * `suggestion` (trimmed). A fence opens with 3 or more backticks or tildes after up to 3
 * spaces (a backtick fence's info string has no backtick) and closes with a line of the
 * same character, at least as long, with nothing else but spaces on it. Every fenced
 * block is skipped whole, so a ```suggestion shown inside a longer fence is not one; an
 * unclosed fence runs to the end of the body and is not a suggestion. The lines inside
 * lose the opening fence's indentation, as Markdown does. Pure; one pass over the body,
 * so its work is bounded by the body's length (GitHub caps it at 65,536 characters).
 * @param {string} body Markdown, from GitHub: untrusted text, only read here.
 * @returns {Suggestion[]}
 */
function parseSuggestions(body) {
  const lines = splitLines(body);
  /** @type {Suggestion[]} */
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    i++;
    if (!open) continue;
    const [, indent, fence, info] = open;
    if (fence[0] === '`' && info.includes('`')) continue; // inline code, not a fence
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    const start = i;
    while (i < lines.length && !close.test(lines[i])) i++;
    if (i >= lines.length) break; // unclosed: the rest of the body is its content
    if (info.trim() === 'suggestion') {
      const strip = new RegExp(`^ {0,${indent.length}}`);
      const content = lines.slice(start, i).map((l) => l.replace(strip, ''));
      out.push({ text: content.length === 0 ? null : content.join('\n') });
    }
    i++; // past the closing fence
  }
  return out;
}

/**
 * The ```suggestion block a new suggestion starts with, holding `lines` as they read. Its
 * fence is one backtick longer than the longest backtick run that starts a line of
 * `lines` (after up to 3 spaces), and at least 3, so no line closes it. Pure.
 * @param {string[]} lines The commented lines' current text, without line breaks.
 * @returns {string}
 */
function suggestionBlock(lines) {
  let longest = 0;
  for (const l of lines) {
    const run = /^ {0,3}(`+)/.exec(l);
    if (run && run[1].length > longest) longest = run[1].length;
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}suggestion\n${lines.join('\n')}\n${fence}`;
}

/** @param {string} oid */
const short = (oid) => oid.slice(0, 7);

/**
 * @param {string} path
 * @param {number} startLine
 * @param {number} line
 */
const linesOf = (path, startLine, line) => (startLine === line ? `line ${line}` : `lines ${startLine}–${line}`) + ` of ${path}`;

/**
 * Whether a comment's suggestion may be applied to the checkout, before its lines are
 * compared: a checkout, one suggestion, a thread on head lines of the current diff, and
 * the checkout at the commit the suggestion was written on, which is the head under
 * review. Each refusal says why. Pure.
 * @param {object} input
 * @param {boolean} input.checkout The review is of a checkout (a preview has no working tree).
 * @param {Suggestion[]} input.suggestions The comment's (`parseSuggestions`).
 * @param {SuggestionThread} input.thread
 * @param {string|null} input.commitOid The comment's commit, as GitHub gave it.
 * @param {string|null} input.head The checkout's HEAD commit; null when it could not be read.
 * @param {string} input.targetHead The head commit under review.
 * @returns {ApplyDecision}
 */
function applyDecision({ checkout, suggestions, thread, commitOid, head, targetHead }) {
  if (!checkout) return { ok: false, reason: 'Check out the pull request to apply a suggestion.' };
  if (suggestions.length === 0) return { ok: false, reason: 'This comment has no suggestion.' };
  if (suggestions.length > 1) return { ok: false, reason: `This comment has ${suggestions.length} suggestions; apply them on GitHub.` };
  if (thread.isOutdated || thread.fileLevel || thread.side !== 'RIGHT' || thread.line === null) {
    return { ok: false, reason: 'This suggestion is on lines that are no longer in the diff.' };
  }
  if (head === null) return { ok: false, reason: 'The checkout\'s HEAD could not be read, so the suggestion cannot be checked against it.' };
  if (commitOid === null) return { ok: false, reason: 'GitHub did not say which commit the suggestion was written on, so it cannot be checked against the checkout.' };
  if (head !== commitOid) return { ok: false, reason: `The checkout is at ${short(head)}, not ${short(commitOid)} the suggestion was written on.` };
  if (head !== targetHead) return { ok: false, reason: `The checkout is at ${short(head)}, not ${short(targetHead)}, the head under review.` };
  const line = thread.line;
  const startLine = thread.startLine !== null && thread.startLine <= line ? thread.startLine : line;
  return { ok: true, path: thread.path, startLine, line, text: suggestions[0].text };
}

/**
 * Why the working file's commented lines are not the lines the suggestion was written
 * on, or null when they are the same. Lines past either file's end differ. Pure.
 * @param {{ path: string, startLine: number, line: number }} plan 1-based, inclusive.
 * @param {string[]} workingLines The working file (the open document, else the file on disk).
 * @param {string[]} commitLines The file at the commit the suggestion was written on.
 * @returns {string|null}
 */
function linesChanged({ path, startLine, line }, workingLines, commitLines) {
  for (let n = startLine; n <= line; n++) {
    const a = workingLines[n - 1], b = commitLines[n - 1];
    if (a === undefined || b === undefined || a !== b) {
      const where = linesOf(path, startLine, line);
      return `${where[0].toUpperCase()}${where.slice(1)} changed since the suggestion was written.`;
    }
  }
  return null;
}

/**
 * The edit that replaces whole lines `startLine`..`line` (1-based, inclusive) with a
 * suggestion's text, keeping the file's line breaks: the replacement's lines are joined
 * with `eol`, and the line break after the last replaced line is kept. A null text (an
 * empty block) deletes the lines with their line breaks; `''` leaves one blank line. Pure.
 * @param {string[]} lines The file (`splitLines`); `line` is within it.
 * @param {number} startLine
 * @param {number} line
 * @param {string|null} text
 * @param {'\r\n'|'\n'} eol
 * @returns {TextEdit}
 */
function suggestionEdit(lines, startLine, line, text, eol) {
  const first = startLine - 1, last = line - 1; // 0-based
  if (text !== null) {
    return { start: { line: first, character: 0 }, end: { line: last, character: lines[last].length }, text: splitLines(text).join(eol) };
  }
  // Deleting: take the line break after the last line, or, at the end of the file, the
  // one before the first.
  if (last + 1 < lines.length) return { start: { line: first, character: 0 }, end: { line: last + 1, character: 0 }, text: '' };
  if (first > 0) return { start: { line: first - 1, character: lines[first - 1].length }, end: { line: last, character: lines[last].length }, text: '' };
  return { start: { line: 0, character: 0 }, end: { line: last, character: lines[last].length }, text: '' };
}

module.exports = { parseSuggestions, suggestionBlock, applyDecision, linesChanged, suggestionEdit, splitLines, eolOf, linesOf };
