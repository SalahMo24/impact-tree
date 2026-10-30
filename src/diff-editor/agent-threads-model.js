// @ts-check
'use strict';
// What a note of the user's agent says in the review diff (docs/UX_PLAN.md L6): the markdown
// of its comment, the plain text "Post to the PR" opens for editing, and the change ids that
// say which changes have a note. Pure: the adapter (`agent-threads.js`) draws them.
//
// The agent's text is data from outside. In the markdown it is escaped, so it stays text: it
// cannot form a link, an image, a command link or HTML. The only links are the ones made
// here, to callers the engine knows.

const { WORD, sameName } = require('../agent/agent-notes');

/** The command a caller name in a note opens. */
const OPEN_CALLER_COMMAND = 'impactTree.openCaller';

/** The closing line of every note: who wrote it and where the facts come from. */
const WRITTEN_BY = 'Written by your agent; the facts come from the engine.';

/** @typedef {import('../agent/agent-notes').AgentChange} AgentChange */

/**
 * The caller of a change as the Open caller command takes it: the document and the call
 * sites it opens at. Nothing else of the engine's row is sent through a link.
 * @typedef {{ type: 'caller', label: string, file: string, pos: number, callSites: Array<{ start: number, end: number }> }} CallerArg
 */

/** Text on one line. @param {unknown} s @returns {string} */
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Agent text in markdown, so it stays text: the characters that make a link, an image,
 * emphasis, code, HTML or an entity are escaped, and a line break is a space.
 * @param {unknown} s @returns {string}
 */
const escapeNote = (s) => oneLine(s).replace(/[\\`*_[\]<>~&|]/g, '\\$&');

/**
 * The link on a caller's name: the Open caller command with that caller. Parentheses are
 * encoded too, since one in a caller's name would end the markdown link early.
 * @param {CallerArg} caller @returns {string} `command:` URI.
 */
const callerCommandUri = (caller) => `command:${OPEN_CALLER_COMMAND}?${encodeURIComponent(JSON.stringify([caller])).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))}`;

/**
 * The callers of a change the agent's `affects` names, by the engine's own list: a name the
 * agent wrote names a caller when one holds the other (`sameName`, as the check that stored
 * the result). The engine's first match is used.
 * @param {string} name What the agent wrote.
 * @param {ReadonlyArray<{ label: string, file: string, pos: number, callSites?: Array<{ start: number, end: number }> }>} callers
 *   The change's direct callers.
 * @returns {CallerArg|null} Null when the engine does not know the name as a direct caller.
 */
function callerNamed(name, callers) {
  const hit = callers.find((c) => typeof c.label === 'string' && sameName(name, c.label));
  return hit ? { type: 'caller', label: hit.label, file: hit.file, pos: hit.pos, callSites: hit.callSites || [] } : null;
}

/**
 * The note's lines that are not about callers: kind and what, then before, after and when
 * when given.
 * @param {AgentChange} c
 * @returns {{ head: string, details: Array<[string, string]> }}
 */
function noteParts(c) {
  /** @type {Array<[string, string|undefined]>} */
  const given = [['Before', c.before], ['After', c.after], ['When', c.when]];
  return {
    head: WORD[c.kind],
    details: /** @type {Array<[string, string]>} */ (given.filter(([, text]) => typeof text === 'string' && text !== '')),
  };
}

/**
 * The markdown body of the note: kind and what; before, after and when as short paragraphs
 * when given; the callers it affects (a name the engine knows is a link that opens the call
 * site); the engine's verdict in italics; and who wrote it. Nothing the agent did not say is
 * added; the engine's sentence and the closing line are the engine's and the extension's own.
 * @param {AgentChange} c
 * @param {{ verdict: string, callers: ReadonlyArray<{ label: string, file: string, pos: number, callSites?: Array<{ start: number, end: number }> }> }} facts
 *   `verdict` is the engine's sentence about the change; `callers` its direct callers.
 * @returns {string}
 */
function noteMarkdown(c, { verdict, callers }) {
  const { head, details } = noteParts(c);
  const affects = (c.affects || []).map((a) => {
    const caller = callerNamed(a.name, callers);
    const name = caller ? `[${escapeNote(a.name)}](${callerCommandUri(caller)})` : escapeNote(a.name);
    return `- ${name} — ${escapeNote(a.how)}`;
  });
  return [
    `**${head}** — ${escapeNote(c.what)}`,
    ...details.map(([label, text]) => `**${label}:** ${escapeNote(text)}`),
    ...(affects.length ? [['**Affects:**', ...affects].join('\n')] : []),
    `_${escapeNote(verdict)}_`,
    `_${WRITTEN_BY}_`,
  ].join('\n\n');
}

/**
 * The note as plain text, for a comment the reviewer edits before sending: the kind line,
 * before, after and when, and the callers it affects. Not the two closing lines, which are
 * about this view and not about the change.
 * @param {AgentChange} c
 * @returns {string}
 */
function notePlainText(c) {
  const { head, details } = noteParts(c);
  const affects = (c.affects || []).map((a) => `- ${oneLine(a.name)} — ${oneLine(a.how)}`);
  return [
    `${head} — ${oneLine(c.what)}`,
    ...details.map(([label, text]) => `${label}: ${oneLine(text)}`),
    ...(affects.length ? [['Affects:', ...affects].join('\n')] : []),
  ].join('\n\n');
}

module.exports = { noteMarkdown, notePlainText, callerNamed, escapeNote, OPEN_CALLER_COMMAND, WRITTEN_BY };
