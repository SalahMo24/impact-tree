// @ts-check
'use strict';

// Argument checks, paging and the size cap of the MCP tools' answers. Every tool result
// is kept under MAX_TEXT_CHARS (a client puts the text in a model's context): lists page
// with `page`/`pageSize`, and a single object has its long fields cut.

// Largest tool result text. Unit: UTF-16 code units. A larger page is shrunk until it fits.
const MAX_TEXT_CHARS = 40000;
// Page sizes. Unit: list items.
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
// Highest page number accepted. Unit: pages.
const MAX_PAGE = 100000;

/** A refusal the agent can act on: reported as an error result, not logged as a defect. */
class ToolError extends Error {}

/**
 * An optional integer argument.
 * @param {unknown} value @param {number} fallback used when omitted @param {number} max @param {string} name
 * @returns {number} a safe integer from 1 to `max`
 * @throws {ToolError} when supplied and not such an integer
 */
function intArg(value, fallback, max, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > max) {
    throw new ToolError(`${name} must be an integer from 1 to ${max}`);
  }
  return /** @type {number} */ (value);
}

/**
 * One page of `items` under `key` in `base`, shrunk until the JSON fits MAX_TEXT_CHARS.
 * `total` is the number of items before paging; `pages` is at least 1.
 * @param {Record<string, unknown>} base @param {string} key @param {any[]} items
 * @param {{ page?: unknown, pageSize?: unknown }} args
 */
function paged(base, key, items, args) {
  const page = intArg(args.page, 1, MAX_PAGE, 'page');
  const asked = intArg(args.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize');
  let size = asked;
  for (;;) {
    const start = (page - 1) * size;
    const out = { ...base, [key]: items.slice(start, start + size), page, pageSize: size, total: items.length, pages: Math.max(1, Math.ceil(items.length / size)) };
    if (JSON.stringify(out).length <= MAX_TEXT_CHARS || size === 1) {
      return size < asked ? { ...out, note: `pageSize reduced to ${size} so the result stays under ${MAX_TEXT_CHARS} characters` } : out;
    }
    size = Math.max(1, Math.floor(size / 2));
  }
}

/**
 * `obj` itself when it fits MAX_TEXT_CHARS, else a copy with the long `hunk` and the long
 * lists cut (and the cut named in `cut`, with the full length in `<key>Total`).
 * @param {any} obj
 */
function fitObject(obj) {
  let text = JSON.stringify(obj);
  if (text.length <= MAX_TEXT_CHARS) return obj;
  const copy = JSON.parse(text);
  if (copy.hunk && typeof copy.hunk === 'string') copy.hunk = `${copy.hunk.slice(0, 2000)}\n… (cut)`;
  for (const k of ['callers', 'topPaths', 'members', 'seams', 'mergeHints', 'refs']) {
    text = JSON.stringify(copy);
    if (text.length <= MAX_TEXT_CHARS) break;
    if (Array.isArray(copy[k])) { copy[`${k}Total`] = copy[k].length; copy[k] = copy[k].slice(0, 20); copy.cut = `${k} cut to 20; use the paged tools for all of them`; }
  }
  return copy;
}

module.exports = { ToolError, intArg, paged, fitObject, MAX_TEXT_CHARS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_PAGE };
