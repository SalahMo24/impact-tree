// @ts-check
'use strict';
// The feedback-round file: render one round as markdown for an agent, and read back what
// the agent wrote under each item (docs/UX_PLAN.md F3/F4). Pure: no fs, no vscode.
//
// Escaping choice (body text only): every body line that could be mistaken for structure
// (a "## " heading, an "<!-- item" or "<!-- impact-tree" comment, or a "Status:" line,
// optionally indented) is prefixed with a single backslash. Markdown renders "\##" as a
// literal "##", so it stays readable, and the parser only recognises structure at the
// start of a line, so a backslash-prefixed line can never match. Quote lines always start
// with "> ", which the parser never treats as structure. Single-line fields (file, symbol,
// branch, labels) have their line breaks replaced with a space.

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;
const MAX_BODY_CHARS = 10000;
const MAX_QUOTE_CHARS = 2000;
const MAX_REASON_CHARS = 500;
const MAX_HUNKS = 10000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-fA-F]{4,64}$/;

/**
 * @typedef {{ id: string, file: string, line: number|null, symbol: string|null,
 *   caller: { label: string, file: string, line: number }|null, quote: string,
 *   body: string, createdAtMs: number }} FeedbackItem
 * @typedef {'done'|'skipped'|'none'|'unreadable'} ItemStatus
 * @typedef {{ id: string, status: ItemStatus, reason: string|null }} ParsedItem
 * @typedef {{ ok: true, round: number, checkpointSha: string|null, items: ParsedItem[] }
 *   | { ok: false, reason: string }} ParsedRound
 */

/** @param {unknown} v @param {string} what @returns {string} */
function assertString(v, what) {
  if (typeof v !== 'string') throw new TypeError(`feedback: ${what} must be a string`);
  return v;
}

/** @param {string} s */
const oneLine = (s) => s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

/** @param {Date|number} when @param {string|undefined} timeZone */
function dateParts(when, timeZone) {
  const d = typeof when === 'number' ? new Date(when) : when;
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) throw new TypeError('feedback: invalid date');
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Escape a multi-line body so no line can be mistaken for structure. @param {string} text */
function escapeBody(text) {
  const risky = /^\s*(?:##\s|<!--\s*(?:item|impact-tree)|Status:)/i;
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n')
    .map((l) => (risky.test(l) ? `\\${l}` : l)).join('\n');
}

/**
 * @param {FeedbackItem} it
 * @param {number} index one-based
 */
function renderItem(it, index) {
  if (!it || typeof it !== 'object') throw new TypeError('feedback: item must be an object');
  if (typeof it.id !== 'string' || !ID_RE.test(it.id)) throw new TypeError('feedback: invalid item id');
  const file = oneLine(assertString(it.file, 'item.file'));
  if (!file) throw new TypeError('feedback: item.file is empty');
  if (it.line != null && !(Number.isInteger(it.line) && it.line >= 1)) throw new TypeError('feedback: invalid item.line');
  const body = assertString(it.body, 'item.body');
  const quote = assertString(it.quote, 'item.quote');
  if (body.length > MAX_BODY_CHARS) throw new RangeError('feedback: body too long');
  if (quote.length > MAX_QUOTE_CHARS) throw new RangeError('feedback: quote too long');
  let head = `## ${index}. ${file}${it.line != null ? `:${it.line}` : ''}`;
  if (it.symbol != null) {
    const sym = oneLine(assertString(it.symbol, 'item.symbol'));
    if (sym) head += ` · ${sym}`;
  }
  const out = [head, `<!-- item id=${it.id} -->`];
  const q = quote.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (q) for (const l of q.split('\n')) out.push(`> ${l}`.trimEnd());
  if (it.caller) {
    const c = it.caller;
    if (!Number.isInteger(c.line) || c.line < 1) throw new TypeError('feedback: invalid caller.line');
    out.push(`> caller: ${oneLine(assertString(c.file, 'caller.file'))}:${c.line} · ${oneLine(assertString(c.label, 'caller.label'))}`);
  }
  const b = escapeBody(body);
  if (b) out.push(b);
  out.push('Status:');
  return out.join('\n');
}

/**
 * Render one feedback round. Throws on invalid input (it is internal data).
 * `timeZone` (an IANA name) makes the title time deterministic; default is local time.
 * @param {{ round: number, sentAtMs: number, branch: string|null, modeLabel: string,
 *   checkpointSha: string|null, items: FeedbackItem[], timeZone?: string }} o
 * @returns {string}
 */
function renderRound(o) {
  if (!Number.isSafeInteger(o.round) || o.round < 1) throw new TypeError('feedback: invalid round');
  if (o.checkpointSha != null && !SHA_RE.test(o.checkpointSha)) throw new TypeError('feedback: invalid checkpoint sha');
  if (!Array.isArray(o.items)) throw new TypeError('feedback: items must be an array');
  if (o.items.length > MAX_ITEMS) throw new RangeError('feedback: too many items');
  const ids = new Set();
  for (const it of o.items) {
    if (ids.has(it && it.id)) throw new TypeError('feedback: duplicate item id');
    ids.add(it && it.id);
  }
  const { date, time } = dateParts(o.sentAtMs, o.timeZone);
  const branch = o.branch == null ? 'detached HEAD' : oneLine(assertString(o.branch, 'branch'));
  const lines = [
    `# Feedback round ${o.round} · ${date} ${time}`,
    `<!-- impact-tree feedback v1 round=${o.round} checkpoint=${o.checkpointSha == null ? 'none' : o.checkpointSha} -->`,
    `Branch: ${branch} · Reviewed: ${oneLine(assertString(o.modeLabel, 'modeLabel'))}`,
    '',
    'For the agent: address each item. Under each one, write `Status: done` or',
    '`Status: skipped — reason`. Don\'t change anything else in this file.',
  ];
  o.items.forEach((it, i) => { lines.push('', renderItem(it, i + 1)); });
  return `${lines.join('\n')}\n`;
}

/**
 * Interpret the text after "Status:". "done" followed by anything that is not a letter or
 * digit (punctuation, a dash, a comment) is done. "skipped" takes an optional separator
 * (em dash, en dash, hyphen, colon) and the rest as the reason. Empty is none; anything
 * else is unreadable. Leading markdown emphasis (`**done**`) is ignored.
 * @param {string} rest
 * @returns {{ status: ItemStatus, reason: string|null }}
 */
function readStatusText(rest) {
  const t = rest.trim().replace(/^[*_`\s]+/, '');
  if (!t) return { status: 'none', reason: null };
  if (/^done(?![\p{L}\p{N}_])/iu.test(t)) return { status: 'done', reason: null };
  const m = /^skipped(?![\p{L}\p{N}_])\s*(?:(?:—|–|--|-|:)\s*)?([\s\S]*)$/iu.exec(t);
  if (m) {
    const reason = m[1].replace(/[*_`\s]+$/, '').trim().slice(0, MAX_REASON_CHARS);
    return { status: 'skipped', reason: reason || null };
  }
  return { status: 'unreadable', reason: `unrecognised status: ${t.slice(0, 60)}` };
}

/**
 * Collapse the Status lines found under one item into one result.
 * @param {Array<{ status: ItemStatus, reason: string|null }>} statuses
 * @returns {{ status: ItemStatus, reason: string|null }}
 */
function combine(statuses) {
  // An empty "Status:" is the template line; it is ignored when the agent wrote another.
  const real = statuses.filter((s) => s.status !== 'none');
  if (!real.length) return { status: 'none', reason: null };
  const first = real[0];
  if (real.length === 1) return first;
  const agree = real.every((s) => s.status === first.status && s.reason === first.reason);
  return agree && first.status !== 'unreadable' ? first : { status: 'unreadable', reason: 'conflicting status lines' };
}

/**
 * Read a round file back. Structure is recognised only at the start of a line (the Status
 * line may be indented up to 3 spaces), so escaped body text and quote lines never count.
 * @param {string} text
 * @returns {ParsedRound}
 */
function parseRound(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not text' };
  if (text.length > MAX_TEXT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return { ok: false, reason: 'too large' };
  const lines = text.split(/\r\n|\n|\r/);
  let header = null;
  let headerAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^<!--\s*impact-tree feedback\b/.test(lines[i])) continue;
    const m = /^<!--\s*impact-tree feedback v1 round=(\d+) checkpoint=(none|[0-9a-fA-F]{4,64})\s*-->\s*$/.exec(lines[i]);
    if (!m) return { ok: false, reason: /feedback v(?!1\b)/.test(lines[i]) ? 'unknown format version' : 'malformed header' };
    const round = Number(m[1]);
    if (!Number.isSafeInteger(round) || round < 1) return { ok: false, reason: 'malformed header' };
    header = { round, checkpointSha: m[2] === 'none' ? null : m[2] };
    headerAt = i;
    break;
  }
  if (!header) return { ok: false, reason: 'header marker missing' };

  const markerRe = /^<!--\s*item id=([A-Za-z0-9_-]{1,64})\s*-->\s*$/;
  /** @type {Map<string, Array<{ status: ItemStatus, reason: string|null }>>} */
  const found = new Map();
  const dupIds = new Set();
  /** @type {Array<{ status: ItemStatus, reason: string|null }>|null} */
  let cur = null;
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i];
    const mk = markerRe.exec(line);
    if (mk) {
      if (found.has(mk[1])) dupIds.add(mk[1]);
      else found.set(mk[1], []);
      cur = found.get(mk[1]) || null;
      continue;
    }
    if (/^## /.test(line) || /^<!--\s*(?:item|impact-tree)/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const st = /^ {0,3}Status:(.*)$/i.exec(line);
    if (st) cur.push(readStatusText(st[1]));
  }
  /** @type {ParsedItem[]} */
  const items = [];
  for (const [id, statuses] of found) {
    items.push(dupIds.has(id)
      ? { id, status: 'unreadable', reason: 'duplicate item marker' }
      : { id, ...combine(statuses) });
  }
  return { ok: true, round: header.round, checkpointSha: header.checkpointSha, items };
}

/**
 * Status for every expected id. A missing marker or a failed parse is 'unreadable';
 * 'done' only ever comes from a parsed `Status: done`.
 * @param {string[]} expectedIds
 * @param {ParsedRound} parsed
 * @returns {Map<string, { status: ItemStatus, reason: string|null }>}
 */
function statusesFor(expectedIds, parsed) {
  const out = new Map();
  if (!parsed || !parsed.ok) {
    const reason = parsed && !parsed.ok ? parsed.reason : 'file not parsed';
    for (const id of expectedIds) out.set(id, { status: 'unreadable', reason });
    return out;
  }
  const byId = new Map(parsed.items.map((i) => [i.id, i]));
  for (const id of expectedIds) {
    const it = byId.get(id);
    out.set(id, it ? { status: it.status, reason: it.reason } : { status: 'unreadable', reason: 'item marker missing' });
  }
  return out;
}

/**
 * `YYYY-MM-DD-n.md` for the local date (or `timeZone`).
 * @param {Date|number} date @param {number} n @param {string} [timeZone]
 */
function roundFileName(date, n, timeZone) {
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('feedback: invalid round number');
  return `${dateParts(date, timeZone).date}-${n}.md`;
}

/**
 * One more than the highest round number over all dates (rounds are global per repo).
 * @param {string[]} existingFileNames
 */
function nextRoundNumber(existingFileNames) {
  let max = 0;
  for (const name of existingFileNames) {
    const m = typeof name === 'string' ? /^\d{4}-\d{2}-\d{2}-(\d+)\.md$/.exec(name) : null;
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * The one-line prompt handed to an agent. Quoting it for a shell is the caller's job
 * (see shellQuote).
 * @param {{ relPath: string }} o
 */
function promptFor(o) {
  const p = assertString(o && o.relPath, 'relPath');
  if (!p || [...p].some((c) => c < ' ' || c === '\u007f' || c === '\u2028' || c === '\u2029')) throw new TypeError('feedback: invalid relPath');
  return `Read ${p} and address each item. Under each item write "Status: done", or "Status: skipped — <reason>". Do not change anything else in that file.`;
}

/**
 * Quote one argument for a POSIX shell (single quotes; embedded quotes become '\'').
 * Newlines, $ and backticks stay literal inside single quotes.
 * @param {string} s
 */
function shellQuote(s) {
  assertString(s, 'argument');
  if (s.includes('\0')) throw new TypeError('feedback: NUL in shell argument');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Old-side ranges from `git diff -U0` output for one file. A failed diff must be passed
 * on as `null` hunks (not as an empty list); this only reads text that was obtained.
 * @param {string} diffText
 * @returns {Array<{ oldStart: number, oldCount: number }>}
 */
function parseOldHunks(diffText) {
  assertString(diffText, 'diffText');
  const out = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;
  for (const line of diffText.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    out.push({ oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]) });
    if (out.length >= MAX_HUNKS) break;
  }
  return out;
}

/**
 * Did the code near `line` change? 'unknown' when the diff could not be read.
 * @param {{ hunks: Array<{ oldStart: number, oldCount: number }>|null, line: number|null, window?: number }} o
 * @returns {'changed'|'unchanged'|'unknown'}
 */
function codeChangedNear(o) {
  const { hunks, line } = o;
  const window = o.window === undefined ? 3 : o.window;
  if (!Array.isArray(hunks)) return 'unknown';
  if (!Number.isInteger(window) || window < 0) return 'unknown';
  for (const h of hunks) {
    if (!h || !Number.isInteger(h.oldStart) || !Number.isInteger(h.oldCount) || h.oldStart < 0 || h.oldCount < 0) return 'unknown';
  }
  if (line == null) return hunks.length > 0 ? 'changed' : 'unchanged';
  if (!Number.isInteger(line) || line < 1) return 'unknown';
  const lo = line - window;
  const hi = line + window;
  for (const h of hunks) {
    // Removed/replaced lines are oldStart..oldStart+oldCount-1; a pure insertion sits
    // between oldStart and oldStart+1.
    const last = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart + h.oldCount - 1;
    if (last >= lo && h.oldStart <= hi) return 'changed';
  }
  return 'unchanged';
}

module.exports = {
  renderRound, parseRound, statusesFor, roundFileName, nextRoundNumber, promptFor, shellQuote,
  parseOldHunks, codeChangedNear, MAX_TEXT_BYTES,
};
