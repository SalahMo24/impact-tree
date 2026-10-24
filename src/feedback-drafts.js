// @ts-check
'use strict';
const { realClock } = require('./engine/clock');
// The feedback drafts of a workspace (docs/UX_PLAN.md F1): what the reviewer wrote for the
// agent on local results, not sent yet. Pure over an injected Memento (VS Code's
// `workspaceState`): no editor API, so it is tested without one.
//
// Stored value (key `impactTree.feedbackDrafts`): `{ version: 1, items: FeedbackItem[] }`.
// It is validated once, when the store is created. A value of another version or shape is
// not read at all (the store starts empty and says so in one log line); a recognised value
// keeps its valid items and drops the others, counting them in one log line. Nothing is
// half-read: a kept item passed every check below.
//
// Limits, each enforced before the change is made, never by dropping silently:
// - at most MAX_ITEMS drafts: adding one more is refused with a message for the reviewer;
// - a body of at most MAX_BODY_CHARS characters: a longer one is refused with a message;
// - a quote of at most MAX_QUOTE_LINES lines and MAX_QUOTE_CHARS characters: a longer one is
//   cut and ends with "…". The quote is context the reviewer saw, not what they wrote.
//
// Ownership: the caller owns the store; `dispose()` drops its listeners. Every change is
// persisted by awaiting the memento's update; writes go out one after another in the order
// the changes were made, so a slower earlier write can never overwrite a later one.

const crypto = require('crypto');

/**
 * @typedef {{ id: string, file: string, line: number|null, symbol: string|null,
 *   caller: { label: string, file: string, line: number }|null, quote: string,
 *   body: string, createdAtMs: number }} FeedbackItem
 *   `file` repo-relative, `line` one-based (null: the whole change or file),
 *   `quote` the code the reviewer saw (at most 5 lines / 400 characters).
 *
 * @typedef {Omit<FeedbackItem, 'id'|'createdAtMs'>} NewFeedback What a new draft is made of;
 *   the store gives it its id and creation time.
 *
 * @typedef {{ ok: true, item: FeedbackItem, warning: string|null } | { ok: false, error: Error }} ChangeResult
 *   `ok: false`: refused, nothing changed; `error.message` is written for the reviewer.
 *   `warning`: the change was made and is shown, but writing it failed, so it is held for
 *   this window only; the text is written for the reviewer.
 *
 * @typedef {{ get: (key: string) => unknown, update: (key: string, value: unknown) => PromiseLike<void> }} Memento
 */

const STORAGE_KEY = 'impactTree.feedbackDrafts';
const VERSION = 1;
/** Drafts kept at once. Unit: items. Enforced by `add`; a stored list above it keeps the oldest. */
const MAX_ITEMS = 200;
/** Unit: UTF-16 code units (JavaScript string length). Enforced by `add` and `update`. */
const MAX_BODY_CHARS = 10000;
/** The quote is cut to this many lines, then to MAX_QUOTE_CHARS code units, ending in "…". */
const MAX_QUOTE_LINES = 5;
const MAX_QUOTE_CHARS = 400;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {v is number} */
const isLine = (v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 1;

/**
 * Whether a path is repository-relative as the store keeps it: forward slashes, no leading
 * slash or drive, no `.` or `..` segment.
 * @param {unknown} p
 * @returns {p is string}
 */
function isRepoPath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 4096 || p.includes('\\') || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * The quote as kept: at most MAX_QUOTE_LINES lines and MAX_QUOTE_CHARS code units; a cut
 * quote ends with "…" (within the limit). Line ends become `\n`.
 * @param {string} text
 * @returns {string}
 */
function clampQuote(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let out = lines.slice(0, MAX_QUOTE_LINES).join('\n');
  let cut = lines.length > MAX_QUOTE_LINES;
  if (out.length > MAX_QUOTE_CHARS) { out = out.slice(0, MAX_QUOTE_CHARS); cut = true; }
  if (!cut) return out;
  return `${out.slice(0, MAX_QUOTE_CHARS - 1)}…`;
}

/**
 * Why a body cannot be kept, or null when it can.
 * @param {unknown} body
 * @returns {string|null}
 */
function bodyProblem(body) {
  if (typeof body !== 'string' || body.trim() === '') return 'the feedback is empty; write it first';
  if (body.length > MAX_BODY_CHARS) {
    return `the feedback is ${body.length.toLocaleString('en-US')} characters long; a draft holds at most ${MAX_BODY_CHARS.toLocaleString('en-US')}. Shorten it and try again`;
  }
  return null;
}

/**
 * Why the parts of a new draft are not what the store keeps, or null when they are. The
 * quote is checked for type only: it is cut, not refused.
 * @param {unknown} input
 * @returns {string|null}
 */
function newItemProblem(input) {
  if (!isObject(input)) return 'the draft is not an object';
  if (!isRepoPath(input.file)) return 'its file is not a path inside the repository';
  if (input.line !== null && !isLine(input.line)) return 'its line is not a line number';
  if (input.symbol !== null && (typeof input.symbol !== 'string' || input.symbol === '')) return 'its symbol is not a name';
  if (input.caller !== null) {
    const c = input.caller;
    if (!isObject(c) || typeof c.label !== 'string' || c.label === '' || !isRepoPath(c.file) || !isLine(c.line)) return 'its caller is not a caller';
  }
  if (typeof input.quote !== 'string') return 'its quote is not text';
  return bodyProblem(input.body);
}

/**
 * A stored item as the store keeps it, or null when it is not one. The quote of a valid
 * item is cut to the limits.
 * @param {unknown} raw
 * @returns {FeedbackItem|null}
 */
function readItem(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  if (!Number.isSafeInteger(raw.createdAtMs) || raw.createdAtMs < 0) return null;
  if (newItemProblem(raw) !== null) return null;
  return freeze({
    id: raw.id, file: raw.file, line: raw.line, symbol: raw.symbol,
    caller: raw.caller === null ? null : { label: raw.caller.label, file: raw.caller.file, line: raw.caller.line },
    quote: clampQuote(raw.quote), body: raw.body, createdAtMs: raw.createdAtMs,
  });
}

/** @param {FeedbackItem} item @returns {FeedbackItem} */
function freeze(item) {
  if (item.caller) Object.freeze(item.caller);
  return Object.freeze(item);
}

/**
 * What a stored value holds: its valid items, oldest first, and what was not kept.
 * @param {unknown} stored The memento's value; undefined when nothing was stored.
 * @returns {{ items: FeedbackItem[], log: string|null }} `log` is the one line to log, or
 *   null when everything was kept (or nothing was stored).
 */
function readStored(stored) {
  if (stored === undefined) return { items: [], log: null };
  if (!isObject(stored) || stored.version !== VERSION || !Array.isArray(stored.items)) {
    const version = isObject(stored) ? JSON.stringify(stored.version) : typeof stored;
    return { items: [], log: `feedback drafts: the stored value is not version ${VERSION} drafts (found ${version}); starting with none` };
  }
  /** @type {FeedbackItem[]} */
  const items = [];
  const ids = new Set();
  let invalid = 0;
  for (const raw of stored.items) {
    const item = readItem(raw);
    if (!item || ids.has(item.id)) { invalid++; continue; }
    ids.add(item.id);
    items.push(item);
  }
  items.sort(byCreation);
  const over = Math.max(0, items.length - MAX_ITEMS);
  const kept = over ? items.slice(0, MAX_ITEMS) : items;
  const parts = [
    invalid ? `${invalid} invalid draft${invalid === 1 ? '' : 's'} dropped` : '',
    over ? `${over} draft${over === 1 ? '' : 's'} over the limit of ${MAX_ITEMS} dropped (the newest)` : '',
  ].filter(Boolean);
  return { items: kept, log: parts.length ? `feedback drafts: ${parts.join('; ')}; ${kept.length} kept` : null };
}

/** @param {FeedbackItem} a @param {FeedbackItem} b */
const byCreation = (a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** @returns {string} A short random id (12 hex characters of a UUID). */
const randomId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

/**
 * Creates the store over a memento, reading what it holds.
 * @param {Memento} memento
 * @param {{ log?: (message: string) => void, now?: () => number, newId?: () => string }} [options]
 *   `now` (milliseconds since the epoch) and `newId` are injected by tests.
 */
function createFeedbackDrafts(memento, { log = () => {}, now = realClock.now, newId = randomId } = {}) {
  const loaded = readStored(memento.get(STORAGE_KEY));
  if (loaded.log) log(loaded.log);
  /** @type {readonly FeedbackItem[]} Oldest first; replaced, never mutated, on each change. */
  let items = Object.freeze(loaded.items);
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let disposed = false;
  /** @type {Promise<void>} The last write; each write starts after the previous one settles. */
  let writing = Promise.resolve();

  /**
   * Makes `next` the drafts, tells the listeners, and persists it.
   * @param {FeedbackItem[]} next
   * @returns {Promise<void>} Settles when this state is written; rejects when the write failed.
   */
  function commit(next) {
    items = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch (e) { log(`feedback drafts: a listener failed: ${/** @type {Error} */ (e).message}`); }
    }
    const value = { version: VERSION, items: next.map((i) => ({ ...i, caller: i.caller && { ...i.caller } })) };
    const write = writing.then(() => memento.update(STORAGE_KEY, value));
    // The chain itself never rejects, so a failed write does not stop later ones; this
    // write's own promise is returned to the caller, which reports it.
    writing = write.then(undefined, () => undefined);
    return write;
  }

  /**
   * Waits for the write and turns its failure into a warning the reviewer can read. The
   * change stays made: the drafts shown are the drafts held.
   * @param {Promise<void>} write
   * @param {FeedbackItem} item
   * @returns {Promise<ChangeResult>}
   */
  async function settled(write, item) {
    try {
      await write;
      return { ok: true, item, warning: null };
    } catch (e) {
      const warning = `the feedback drafts could not be saved (${/** @type {Error} */ (e).message}); they are kept in this window only`;
      log(`feedback drafts: ${warning}`);
      return { ok: true, item, warning };
    }
  }

  /** @param {string} message @returns {Promise<ChangeResult>} */
  const refuse = async (message) => ({ ok: false, error: new Error(message) });

  return {
    STORAGE_KEY,
    /** @returns {readonly FeedbackItem[]} The drafts, oldest first. Frozen. */
    list: () => items,
    /** @param {string} id @returns {FeedbackItem|null} */
    get: (id) => items.find((i) => i.id === id) || null,
    /**
     * Adds a draft. Refused, changing nothing, when MAX_ITEMS drafts are held, when the body
     * is empty or longer than MAX_BODY_CHARS, or when a part is invalid.
     * @param {NewFeedback} input
     * @returns {Promise<ChangeResult>}
     */
    add(input) {
      if (disposed) return refuse('the feedback drafts are closed');
      if (items.length >= MAX_ITEMS) {
        return refuse(`there are already ${MAX_ITEMS} feedback drafts, the most kept at once. Send or delete some first`);
      }
      const problem = newItemProblem(input);
      if (problem) return refuse(problem);
      let id = newId();
      for (let tries = 0; items.some((i) => i.id === id) && tries < 8; tries++) id = newId();
      if (!ID_PATTERN.test(id) || items.some((i) => i.id === id)) return refuse('no free draft id could be made');
      const item = freeze({
        id, file: input.file, line: input.line, symbol: input.symbol,
        caller: input.caller && { label: input.caller.label, file: input.caller.file, line: input.caller.line },
        quote: clampQuote(input.quote), body: input.body, createdAtMs: Math.max(0, Math.floor(now())),
      });
      return settled(commit([...items, item]), item);
    },
    /**
     * Replaces a draft's body. Refused for an unknown id or a body `add` would refuse.
     * @param {string} id
     * @param {string} body
     * @returns {Promise<ChangeResult>}
     */
    update(id, body) {
      if (disposed) return refuse('the feedback drafts are closed');
      const at = items.findIndex((i) => i.id === id);
      if (at < 0) return refuse('that draft is no longer there');
      const problem = bodyProblem(body);
      if (problem) return refuse(problem);
      if (items[at].body === body) return Promise.resolve({ ok: true, item: items[at], warning: null });
      const item = freeze({ ...items[at], caller: items[at].caller && { ...items[at].caller }, body });
      return settled(commit(items.map((i, k) => (k === at ? item : i))), item);
    },
    /**
     * Deletes a draft.
     * @param {string} id
     * @returns {Promise<ChangeResult>} The deleted draft; refused for an unknown id.
     */
    remove(id) {
      if (disposed) return refuse('the feedback drafts are closed');
      const item = items.find((i) => i.id === id);
      if (!item) return refuse('that draft is no longer there');
      return settled(commit(items.filter((i) => i !== item)), item);
    },
    /**
     * Deletes every draft (F3 does this once they are sent).
     * @returns {Promise<{ ok: true, count: number, warning: string|null } | { ok: false, error: Error }>}
     *   `warning` as for `add`: the drafts are gone from this window but the write failed.
     */
    async clear() {
      if (disposed) return { ok: false, error: new Error('the feedback drafts are closed') };
      const count = items.length;
      if (!count) return { ok: true, count, warning: null };
      try {
        await commit([]);
        return { ok: true, count, warning: null };
      } catch (e) {
        const warning = `the feedback drafts could not be saved (${/** @type {Error} */ (e).message})`;
        log(`feedback drafts: ${warning}`);
        return { ok: true, count, warning };
      }
    },
    /**
     * Calls `listener` synchronously after every change, before it is written.
     * @param {() => void} listener
     * @returns {{ dispose(): void }}
     */
    onDidChange(listener) {
      if (disposed) return { dispose() {} };
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    /** Settles once every write started so far has settled. */
    whenWritten: () => writing,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

module.exports = {
  createFeedbackDrafts, readStored, clampQuote, isRepoPath,
  STORAGE_KEY, VERSION, MAX_ITEMS, MAX_BODY_CHARS, MAX_QUOTE_LINES, MAX_QUOTE_CHARS, ID_PATTERN,
};
