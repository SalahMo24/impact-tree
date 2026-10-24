'use strict';

/**
 * The plan's LanguageServices operations, answered by gopls over stdio.
 * Positions in and out are UTF-16 offsets into the document text (JS string
 * indices), which is also what LSP's default encoding counts. `null` means the
 * server gave no answer; a failure rejects. Nothing here turns a failure into [].
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { LspClient } = require('./lsp-client');

/** Default per-request deadline; cold gopls on cli/cli needs minutes for the first call. */
const DEFAULT_DEADLINE_MS = 240000;

/** LSP SymbolKind names by number. */
const SYMBOL_KINDS = [
  '', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field',
  'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number',
  'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator',
  'TypeParameter',
];

/**
 * @typedef {{ file?: string, uri?: string, side?: 'head'|'base', text: string }} DocRef
 *   `uri`, when given, is sent to the server as is (virtual and untitled documents);
 *   otherwise `file` (absolute) becomes a file: URI.
 * @typedef {{ start: number, end: number }} OffsetRange
 * @typedef {{ name: string, detail: string, kind: number, kindName: string,
 *   range: OffsetRange, selectionRange: OffsetRange, children: ServerSymbol[] }} ServerSymbol
 * @typedef {{ name: string, kind: number, detail: string, uri: string,
 *   range: OffsetRange, selectionRange: OffsetRange, raw: any }} CallItem
 * @typedef {{ from: CallItem, fromRanges: OffsetRange[] }} IncomingCall
 * @typedef {{ uri: string, start: number, end: number }} Location
 */

/** @param {string} text */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {{ line: number, character: number }}
 */
function offsetToPosition(text, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError(`offset ${offset} is outside the text (length ${text.length})`);
  }
  const starts = lineStarts(text);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

/**
 * @param {string} text
 * @param {{ line: number, character: number }} pos
 * @returns {number}
 */
function positionToOffset(text, pos) {
  const starts = lineStarts(text);
  if (pos.line >= starts.length) throw new RangeError(`line ${pos.line} is past the end of the text`);
  const lineEnd = pos.line + 1 < starts.length ? starts[pos.line + 1] : text.length;
  return Math.min(starts[pos.line] + pos.character, lineEnd);
}

/**
 * @param {{ repo: string, goplsPath: string, deadlineMs?: number, env?: NodeJS.ProcessEnv,
 *   onNotification?: (method: string, params: any) => void }} options
 */
function createGoplsServices(options) {
  const deadlineMs = options.deadlineMs || DEFAULT_DEADLINE_MS;
  const repoUri = pathToFileURL(options.repo).toString();
  /** @type {Map<string, string>} uri -> text of every document opened here */
  const open = new Map();
  /** @type {Map<string, string>} uri -> text read from disk for answers in unopened files */
  const diskTexts = new Map();
  const client = new LspClient({
    command: options.goplsPath,
    args: ['serve'],
    cwd: options.repo,
    env: options.env,
    onNotification: options.onNotification,
  });

  /** @param {DocRef} doc */
  function uriOf(doc) {
    if (doc.uri) return doc.uri;
    if (!doc.file || !path.isAbsolute(doc.file)) throw new TypeError('DocRef needs an absolute file or a uri');
    return pathToFileURL(doc.file).toString();
  }

  /** @param {DocRef} doc */
  function ensureOpen(doc) {
    const uri = uriOf(doc);
    const known = open.get(uri);
    if (known === doc.text) return uri;
    if (known !== undefined) client.didClose(uri);
    client.didOpen({ uri, languageId: 'go', text: doc.text });
    open.set(uri, doc.text);
    return uri;
  }

  /** @param {string} uri */
  function textOfUri(uri) {
    const opened = open.get(uri);
    if (opened !== undefined) return opened;
    let text = diskTexts.get(uri);
    if (text === undefined) {
      text = fs.readFileSync(fileURLToPath(uri), 'utf8'); // throws on failure: no silent empty text
      diskTexts.set(uri, text);
    }
    return text;
  }

  /** @param {string} uri @param {any} range */
  function rangeToOffsets(uri, range) {
    const text = textOfUri(uri);
    return { start: positionToOffset(text, range.start), end: positionToOffset(text, range.end) };
  }

  /** @param {string} uri @param {any} raw @returns {ServerSymbol} */
  function convertSymbol(uri, raw) {
    if (!raw.range || !raw.selectionRange) {
      throw new Error(`gopls returned a flat SymbolInformation for ${uri}, not a hierarchical DocumentSymbol`);
    }
    return {
      name: raw.name,
      detail: raw.detail || '',
      kind: raw.kind,
      kindName: SYMBOL_KINDS[raw.kind] || String(raw.kind),
      range: rangeToOffsets(uri, raw.range),
      selectionRange: rangeToOffsets(uri, raw.selectionRange),
      children: (raw.children || []).map((child) => convertSymbol(uri, child)),
    };
  }

  /** @param {any} raw @returns {CallItem} */
  function convertItem(raw) {
    return {
      name: raw.name,
      kind: raw.kind,
      detail: raw.detail || '',
      uri: raw.uri,
      range: rangeToOffsets(raw.uri, raw.range),
      selectionRange: rangeToOffsets(raw.uri, raw.selectionRange),
      raw,
    };
  }

  /** @param {any} loc @returns {Location} */
  function convertLocation(loc) {
    const uri = loc.targetUri || loc.uri;
    const range = loc.targetSelectionRange || loc.range;
    return { uri, ...rangeToOffsets(uri, range) };
  }

  /** @param {any} result @returns {Location[]|null} */
  function convertLocations(result) {
    if (result === null) return null;
    return (Array.isArray(result) ? result : [result]).map(convertLocation);
  }

  return {
    client,

    /** @param {{ deadlineMs?: number }} [opts] */
    async start(opts) {
      return client.initialize({
        rootPath: options.repo,
        rootUri: repoUri,
        deadlineMs: (opts && opts.deadlineMs) || 60000,
      });
    },

    /** @param {string} languageId @returns {Promise<{ ok: true }|{ ok: false, reason: string }>} */
    async available(languageId) {
      return languageId === 'go' ? { ok: true } : { ok: false, reason: `gopls does not serve ${languageId}` };
    },

    /** @param {DocRef} doc @returns {Promise<ServerSymbol[]|null>} */
    async documentSymbols(doc) {
      const uri = ensureOpen(doc);
      const result = await client.request('textDocument/documentSymbol', { textDocument: { uri } }, deadlineMs);
      if (result === null) return null;
      return result.map((raw) => convertSymbol(uri, raw));
    },

    /** @param {DocRef} doc @param {number} pos @returns {Promise<CallItem[]|null>} */
    async prepareCallHierarchy(doc, pos) {
      const uri = ensureOpen(doc);
      const result = await client.request('textDocument/prepareCallHierarchy', {
        textDocument: { uri }, position: offsetToPosition(doc.text, pos),
      }, deadlineMs);
      if (result === null) return null;
      return result.map(convertItem);
    },

    /** @param {CallItem} item @returns {Promise<IncomingCall[]|null>} */
    async incomingCalls(item) {
      const result = await client.request('callHierarchy/incomingCalls', { item: item.raw }, deadlineMs);
      if (result === null) return null;
      return result.map((call) => ({
        from: convertItem(call.from),
        fromRanges: call.fromRanges.map((r) => rangeToOffsets(call.from.uri, r)),
      }));
    },

    /** @param {DocRef} doc @param {number} pos @returns {Promise<Location[]|null>} */
    async references(doc, pos) {
      const uri = ensureOpen(doc);
      const result = await client.request('textDocument/references', {
        textDocument: { uri }, position: offsetToPosition(doc.text, pos), context: { includeDeclaration: false },
      }, deadlineMs);
      return convertLocations(result);
    },

    /** @param {DocRef} doc @param {number} pos @returns {Promise<Location[]|null>} */
    async implementations(doc, pos) {
      const uri = ensureOpen(doc);
      const result = await client.request('textDocument/implementation', {
        textDocument: { uri }, position: offsetToPosition(doc.text, pos),
      }, deadlineMs);
      return convertLocations(result);
    },

    /** Text of an opened or on-disk document, for printing evidence. @param {string} uri */
    textOfUri,

    async close() {
      await client.close();
    },
  };
}

module.exports = { createGoplsServices, offsetToPosition, positionToOffset, SYMBOL_KINDS };
