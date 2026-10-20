// @ts-check
'use strict';
// The one line that points coding agents at the feedback folder (docs/UX_PLAN.md F3),
// added to AGENTS.md and CLAUDE.md after the owner agrees, once per repository. Pure text
// work here; the command that asks and writes is in feedback-send.js.

const MARKER = '<!-- impact-tree-feedback -->';
const POINTER = `${MARKER}\nReview feedback for this repository is in \`.impact-tree/feedback/\`, one file per round. When asked to address feedback, read the newest file there and write a \`Status:\` line under each item.`;
/** Instruction files the line goes into, in order. */
const FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md']);

/**
 * The file's text with the pointer appended, or null when it already has it.
 * `existing` null means the file does not exist yet.
 * @param {string|null} existing
 * @returns {string|null}
 */
function withPointer(existing) {
  if (existing == null) return `${POINTER}\n`;
  if (existing.includes(MARKER)) return null;
  const sep = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${POINTER}\n`;
}

/**
 * Which files to write: every instruction file that exists, or AGENTS.md alone when
 * none does (most agents read it).
 * @param {Record<string, boolean>} exists by file name
 * @returns {string[]}
 */
function targetsFor(exists) {
  const present = FILES.filter((f) => exists[f]);
  return present.length ? present : ['AGENTS.md'];
}

module.exports = { withPointer, targetsFor, MARKER, POINTER, FILES };
