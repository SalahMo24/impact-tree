// @ts-check
'use strict';

// Checks of what an agent hands back: a set of cards (names, summaries, merges) or the
// callers of one function. The MCP server (src/mcp/server.js) runs them before it forwards a
// submission, and the extension's side of the bridge runs the same ones before it stores
// one, so both reject the same inputs with the same messages.
//
// What this establishes: the shape of the submission, that every id and path it names exists
// in this analysis, and (callers) that the named line, or one next to it, mentions the
// function. It does NOT establish that a caller really calls the function at run time, nor
// that the callers listed are all of them. An accepted submission is checked, not proven.
//
// Pure apart from reading files through the injected `readText`.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------------------
// Budgets. Each is enforced at the point the submission is read, before work grows with it.

// Cards in one submission. Unit: cards. A larger submission is rejected whole.
const MAX_CARDS = 2000;
// Members listed in one card. Unit: ids. A larger list is rejected.
const MAX_MEMBERS_PER_CARD = 20000;
// Callers in one callers submission. Unit: callers. A larger list is rejected whole.
const MAX_CALLERS = 500;
// Longest title and name. Unit: UTF-16 code units.
const MAX_TITLE_CHARS = 200;
// Longest summary, reason and note. Unit: UTF-16 code units.
const MAX_FIELD_CHARS = 2000;
// Errors reported at most; the rest are counted in the last message. Unit: messages.
const MAX_ERRORS = 50;
// Largest accepted line number. Unit: lines.
const MAX_LINE = 10000000;
// Change ids named in the "in no card" message. Unit: ids.
const MAX_MISSING_LISTED = 30;

const CALLER_KINDS = ['call', 'registration', 'reference'];

/**
 * @typedef {object} ChangeInfo
 * @property {string} id `relPath#namePos`
 * @property {string} relPath
 * @property {number} namePos UTF-16 offset of the function name at the head
 * @property {boolean} deleted
 * @property {string} [label]
 */

/**
 * @typedef {object} SubmissionContext
 * @property {any} result An analysis result: `allChanged` and, when present, `deleted`.
 * @property {{ clusters: any[], sweeps?: any[] }} cards The cards the submission is about.
 * @property {(relPath: string) => string|null} [readText] The text of a repository-relative
 *   file at the analysed head, or null when it does not exist there. Needed for `'callers'`.
 *   Default: the file under `repo` on disk.
 * @property {string} [repo] Absolute repository root for the default `readText`.
 */

/**
 * @typedef {object} SubmissionResult
 * @property {boolean} ok
 * @property {string[]} errors Each names the field and what to change; at most MAX_ERRORS + 1.
 * @property {any} [normalised] Present when ok: the payload with trimmed strings, defaults
 *   filled and duplicates removed; forward this, not the raw payload.
 */

/**
 * Check what an agent submitted.
 * @param {'cards'|'callers'} kind
 * @param {unknown} payload
 *   `'cards'`: `{ summary?: string, cards: Array<{ title: string, summary?: string, members: string[], reason?: string }> }`.
 *   `'callers'`: `{ function: string | { file: string, line: number, name: string },
 *   callers: Array<{ file: string, line: number, name?: string, kind?: 'call'|'registration'|'reference', note?: string }> }`;
 *   a string `function` is a change id (`relPath#offset`).
 * @param {SubmissionContext} ctx
 * @returns {SubmissionResult}
 * @throws {TypeError} when `kind` is not one of the two, or `'callers'` has no way to read files
 */
function validateSubmission(kind, payload, ctx) {
  if (kind === 'cards') return finish(validateCards(payload, cardIds(ctx.cards)));
  if (kind === 'callers') {
    const readText = ctx.readText || (ctx.repo ? readFromDisk(ctx.repo) : null);
    if (!readText) throw new TypeError('validateSubmission("callers") needs ctx.readText or ctx.repo');
    return finish(validateCallers(payload, { changes: indexChanges(ctx.result), readText }));
  }
  throw new TypeError(`unknown submission kind ${JSON.stringify(kind)}`);
}

/** @param {{ errors: string[], normalised?: any }} r @returns {SubmissionResult} */
function finish(r) {
  const ok = r.errors.length === 0;
  const errors = r.errors.length > MAX_ERRORS
    ? [...r.errors.slice(0, MAX_ERRORS), `…and ${r.errors.length - MAX_ERRORS} more error(s)`] : r.errors;
  return ok ? { ok, errors, normalised: r.normalised } : { ok, errors };
}

/** @param {string} repo @returns {(relPath: string) => string|null} */
function readFromDisk(repo) {
  return (relPath) => { try { return fs.readFileSync(path.resolve(repo, relPath), 'utf8'); } catch { return null; } };
}

// ---------------------------------------------------------------------------------------
// Change ids

/**
 * Every changed and deleted function of an analysis by id (`relPath#namePos`).
 * @param {any} result
 * @param {(abs: string) => string} [relOf] turns a deleted entry's absolute `file` into a
 *   repository-relative path when it has no `relPath`
 * @returns {Map<string, any>} the analysis' own change objects; deleted ones carry `deletedFn: true`
 */
function indexChanges(result, relOf) {
  /** @type {Map<string, any>} */
  const changes = new Map();
  for (const c of result.allChanged || []) changes.set(`${c.relPath}#${c.namePos}`, c);
  for (const d of result.deleted || []) {
    const relPath = d.relPath || (relOf ? relOf(d.file) : '');
    changes.set(`${relPath}#${d.namePos}`, { ...d, relPath, deletedFn: true });
  }
  return changes;
}

// ---------------------------------------------------------------------------------------
// Cards

/**
 * The ids a card answer must place exactly once, and the ids that count as their owner's:
 * a mirrored (generated copy) or moved function is placed with its card.
 * @param {{ clusters: any[], sweeps?: any[] }} cards
 * @returns {{ required: Set<string>, aliases: Map<string, string> }}
 */
function cardIds(cards) {
  const all = [...cards.clusters, ...(cards.sweeps || [])];
  const required = new Set();
  /** @type {Map<string, string>} */
  const aliases = new Map();
  for (const c of all) for (const m of c.members || []) required.add(m);
  for (const c of all) {
    for (const m of c.mirrorMembers || []) if (!required.has(m)) aliases.set(m, c.anchor || c.members[0]);
    for (const mv of c.moved || []) for (const m of [mv.from, mv.to]) if (m && !required.has(m)) aliases.set(String(m), c.anchor || c.members[0]);
  }
  return { required, aliases };
}

/**
 * @param {unknown} v @param {string} where @param {number} max @param {string[]} errors
 * @returns {string|undefined} the trimmed string, or undefined when absent or invalid (and an error is added)
 */
function optionalText(v, where, max, errors) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') { errors.push(`${where} must be a string`); return undefined; }
  if (v.length > max) { errors.push(`${where} is longer than ${max} characters`); return undefined; }
  return v.trim();
}

/**
 * @param {any} answer @param {{ required: Set<string>, aliases: Map<string, string> }} ids
 * @returns {{ errors: string[], normalised?: any }}
 */
function validateCards(answer, { required, aliases }) {
  const errors = /** @type {string[]} */ ([]);
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.cards)) return { errors: ['answer.cards must be an array'] };
  if (answer.cards.length > MAX_CARDS) return { errors: [`answer.cards has ${answer.cards.length} cards; at most ${MAX_CARDS}`] };
  const summary = optionalText(answer.summary, 'answer.summary', MAX_FIELD_CHARS, errors);
  /** @type {Map<string, number[]>} */
  const placed = new Map();
  /** @type {any[]} */
  const cards = [];
  answer.cards.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const norm = checkCard(c, `cards[${i}]`, i, { required, aliases, placed, errors });
    if (norm) cards.push(norm);
  });
  for (const [id, at] of placed) if (at.length > 1) errors.push(`${id} is in more than one card: ${at.map((i) => `cards[${i}]`).join(', ')}`);
  const missing = [...required].filter((id) => !placed.has(id));
  if (missing.length) errors.push(`${missing.length} change id(s) in no card: ${missing.slice(0, MAX_MISSING_LISTED).join(', ')}${missing.length > MAX_MISSING_LISTED ? ', …' : ''}`);
  return { errors, normalised: errors.length ? undefined : { ...(summary ? { summary } : {}), cards } };
}

/**
 * One card of an answer: its errors go to `errors`, its members into `placed`.
 * @param {any} c @param {string} where @param {number} index
 * @param {{ required: Set<string>, aliases: Map<string, string>, placed: Map<string, number[]>, errors: string[] }} s
 * @returns {{ title: string, summary?: string, reason?: string, members: string[] }|null}
 */
function checkCard(c, where, index, { required, aliases, placed, errors }) {
  if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return null; }
  const title = typeof c.title === 'string' ? c.title.trim() : '';
  if (typeof c.title !== 'string' || !title) errors.push(`${where}: empty title`);
  else if (title.length > MAX_TITLE_CHARS) errors.push(`${where}: title is longer than ${MAX_TITLE_CHARS} characters`);
  const summary = optionalText(c.summary, `${where}.summary`, MAX_FIELD_CHARS, errors);
  const reason = optionalText(c.reason, `${where}.reason`, MAX_FIELD_CHARS, errors);
  if (!Array.isArray(c.members) || !c.members.length) { errors.push(`${where}: members must be a non-empty array of change ids`); return null; }
  if (c.members.length > MAX_MEMBERS_PER_CARD) { errors.push(`${where}: ${c.members.length} members; at most ${MAX_MEMBERS_PER_CARD}`); return null; }
  for (const m of c.members) {
    const id = typeof m === 'string' ? (required.has(m) ? m : aliases.get(m)) : undefined;
    if (!id) { errors.push(`${where}: unknown id ${JSON.stringify(m)}`); continue; }
    if (!placed.has(id)) placed.set(id, []);
    const at = /** @type {number[]} */ (placed.get(id));
    if (!at.includes(index)) at.push(index);
    else if (m === id) errors.push(`${where}: ${id} listed twice in the same card`);
  }
  return { title, ...(summary ? { summary } : {}), ...(reason ? { reason } : {}), members: c.members };
}

// ---------------------------------------------------------------------------------------
// Evidence on a line

/**
 * 1-based line of a UTF-16 offset. @param {number[]} starts from `lineStarts` @param {number} offset
 */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Starts of the lines of `text` (UTF-16 offsets). @param {string} text */
function lineStarts(text) {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/**
 * Does `line` (1-based) or a neighbouring line of `text` mention `callee`? A comment-only
 * line is not evidence. `call` is true when the mention looks like a call, `callee(`.
 * It is a text check: it can accept a mention inside a string and miss a call split over
 * more than the three lines read.
 * @param {{ text: string, file: string, line: number, callee: string }} p `callee` is an identifier
 * @returns {{ ok: boolean, call: boolean, text: string, complete: boolean, reasons: string[] }}
 *   `complete` is false when `line` is past the end of the file
 */
function checkEvidence({ text, file, line, callee }) {
  const lines = text.split('\n');
  const from = Math.max(1, line - 1);
  const to = Math.min(lines.length, line + 1);
  const re = new RegExp(`(?<![\\w$])${escapeRe(callee)}(?![\\w$])`);
  const callRe = new RegExp(`(?<![\\w$])${escapeRe(callee)}\\s*(?:<[^>]*>)?\\s*\\(`);
  const shown = [];
  let ok = false;
  let call = false;
  for (let n = from; n <= to; n++) {
    const t = lines[n - 1];
    const code = t.replace(/\/\/.*$|#.*$/, '');
    if (re.test(code)) { ok = true; if (callRe.test(code)) call = true; }
    shown.push(`${n}: ${t.slice(0, 200)}`);
  }
  const complete = line <= lines.length;
  return { ok, call, text: shown.join('\n'), complete, reasons: complete ? [] : [`${file} has ${lines.length} lines`] };
}

// ---------------------------------------------------------------------------------------
// Callers

const IDENTIFIER = /^[\w$]+$/;

/** A repository-relative path without `..` or a drive: the only kind accepted. @param {unknown} v */
function isRelativePath(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 1024 && !path.isAbsolute(v) && !/^[A-Za-z]:/.test(v)
    && !v.split(/[\\/]/).includes('..') && !v.includes('\0');
}

/** @param {unknown} v @returns {v is number} */
const isLineNumber = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_LINE;

/**
 * @param {any} payload
 * @param {{ changes: Map<string, any>, readText: (relPath: string) => string|null }} deps
 * @returns {{ errors: string[], normalised?: any }}
 */
function validateCallers(payload, { changes, readText }) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.callers)) return { errors: ['answer.callers must be an array'] };
  if (payload.callers.length > MAX_CALLERS) return { errors: [`answer.callers has ${payload.callers.length} callers; at most ${MAX_CALLERS}`] };
  /** @type {Map<string, string|null>} */
  const cache = new Map();
  const read = (/** @type {string} */ f) => { if (!cache.has(f)) cache.set(f, readText(f)); return /** @type {string|null} */ (cache.get(f)); };
  const errors = /** @type {string[]} */ ([]);
  const fn = resolveFunction(payload.function, changes, read, errors);
  if (!fn) return { errors };
  /** @type {any[]} */
  const callers = [];
  const seen = new Set();
  payload.callers.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const norm = checkCaller(c, `callers[${i}]`, fn.name, read, errors);
    if (!norm) return;
    const key = `${norm.file}:${norm.line}:${norm.kind}`;
    if (!seen.has(key)) { seen.add(key); callers.push(norm); }
  });
  return { errors, normalised: errors.length ? undefined : { function: fn, callers } };
}

/**
 * The function a callers submission is about: a change id, or file + line + name.
 * @param {any} spec @param {Map<string, any>} changes @param {(f: string) => string|null} read @param {string[]} errors
 * @returns {{ file: string, line: number, name: string, id?: string }|null}
 */
function resolveFunction(spec, changes, read, errors) {
  if (typeof spec === 'string') {
    const c = changes.get(spec);
    if (!c) { errors.push(`function: unknown change id ${JSON.stringify(spec)}`); return null; }
    if (c.deletedFn) { errors.push(`function: ${spec} is a deleted function; callers of a deleted function are not accepted`); return null; }
    const text = read(c.relPath);
    if (text === null) { errors.push(`function: ${c.relPath} does not exist at the analysed head`); return null; }
    const name = /^[\w$]+/.exec(text.slice(c.namePos, c.namePos + MAX_TITLE_CHARS));
    if (!name) { errors.push(`function: no identifier at offset ${c.namePos} of ${c.relPath}`); return null; }
    const line = lineOf(lineStarts(text), c.namePos);
    return { id: spec, file: c.relPath, line, name: name[0] };
  }
  if (!spec || typeof spec !== 'object') { errors.push('function must be a change id or { file, line, name }'); return null; }
  if (!isRelativePath(spec.file)) { errors.push('function.file must be a repository-relative path'); return null; }
  if (!isLineNumber(spec.line)) { errors.push(`function.line must be an integer from 1 to ${MAX_LINE}`); return null; }
  if (typeof spec.name !== 'string' || !IDENTIFIER.test(spec.name)) { errors.push('function.name must be a single identifier'); return null; }
  const text = read(spec.file);
  if (text === null) { errors.push(`function.file ${spec.file} does not exist at the analysed head`); return null; }
  const lines = text.split('\n');
  if (spec.line > lines.length) { errors.push(`function.line: ${spec.file} has ${lines.length} lines`); return null; }
  if (!new RegExp(`(?<![\\w$])${escapeRe(spec.name)}(?![\\w$])`).test(lines[spec.line - 1])) {
    errors.push(`function: ${spec.name} is not on line ${spec.line} of ${spec.file}`);
    return null;
  }
  return { file: spec.file, line: spec.line, name: spec.name };
}

/**
 * One caller: a path that exists at the head, a line that mentions the function.
 * @param {any} c @param {string} where @param {string} callee @param {(f: string) => string|null} read @param {string[]} errors
 * @returns {{ file: string, line: number, kind: string, name?: string, note?: string }|null}
 */
function checkCaller(c, where, callee, read, errors) {
  if (!c || typeof c !== 'object') { errors.push(`${where} is not an object`); return null; }
  const before = errors.length;
  if (!isRelativePath(c.file)) errors.push(`${where}.file must be a repository-relative path`);
  if (!isLineNumber(c.line)) errors.push(`${where}.line must be an integer from 1 to ${MAX_LINE}`);
  if (c.kind !== undefined && !CALLER_KINDS.includes(c.kind)) errors.push(`${where}.kind must be one of ${CALLER_KINDS.join(', ')}`);
  const name = optionalText(c.name, `${where}.name`, MAX_TITLE_CHARS, errors);
  const note = optionalText(c.note, `${where}.note`, MAX_FIELD_CHARS, errors);
  if (errors.length > before) return null;
  const text = read(c.file);
  if (text === null) { errors.push(`${where}: ${c.file} does not exist at the analysed head`); return null; }
  const evidence = checkEvidence({ text, file: c.file, line: c.line, callee });
  if (!evidence.complete) { errors.push(`${where}: ${evidence.reasons[0]}, so line ${c.line} does not exist`); return null; }
  if (!evidence.ok) { errors.push(`${where}: ${callee} is not mentioned on line ${c.line} of ${c.file} (lines ${Math.max(1, c.line - 1)}-${c.line + 1} read)`); return null; }
  return { file: c.file, line: c.line, kind: c.kind || 'call', ...(name ? { name } : {}), ...(note ? { note } : {}) };
}

module.exports = {
  validateSubmission, checkEvidence, indexChanges, cardIds, isRelativePath, lineStarts, lineOf, escapeRe,
  MAX_CARDS, MAX_CALLERS, MAX_ERRORS, MAX_LINE, IDENTIFIER,
};
