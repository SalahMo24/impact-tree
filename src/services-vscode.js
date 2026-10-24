// @ts-check
'use strict';
const { isTestFile } = require('./engine/diff');
const { offsetToPosition, positionToOffset } = require('./engine/textpos');
const { withDeadline } = require('./engine/deadline');

// The editor's language servers, as `LanguageServices` (src/languages/types.js): the
// editor's provider commands (`vscode.prepareCallHierarchy`, …), so any language whose
// extension provides them is answered by the server already running, incrementally and
// with no second program. Everything about talking to a server that is the same for every
// language lives here: the outstanding-request cap, per-command deadlines, the cold phase
// while the server loads its projects, retries until it is up, and warm-up. What to ask and
// how to read the answer for a language is the provider's.
//
// Deliberately never calls vscode.workspace.openTextDocument. Doing so forces the
// editor to sync the document to the extension host, which Cursor rejects for many
// files ("Documents above the size limit cannot be synchronized with extensions") and
// which costs a round trip per caller. Offsets are converted from disk instead
// (src/engine/textpos.js), which is exact: editor positions count UTF-16 code units per
// line, as JS strings do.

/**
 * The part of the `vscode` module these services use. It is passed in, not required, so
 * the services run without the editor and a test's stub is never cached in this module.
 * @typedef {object} VscodeApi
 * @property {{ executeCommand: (command: string, ...args: any[]) => PromiseLike<unknown> }} commands
 * @property {{ file: (path: string) => unknown }} Uri
 * @property {new (line: number, character: number) => unknown} Position
 * @property {{ getLanguages: () => PromiseLike<string[]> }} [languages]
 */

/**
 * The editor's services: `LanguageServices` plus the editor-only lifecycle the resolver
 * drives.
 * @typedef {import('./languages/types').LanguageServices & {
 *   callerQuery: <T>(run: (scope: import('./languages/types').LanguageServices) => Promise<T>) => Promise<T>,
 *   warmUp: (doc: import('./languages/types').DocRef, pos: number, options?: { timeoutMs?: number }) => Promise<boolean>,
 *   isWarm: () => boolean,
 *   isServerWarm: () => boolean,
 *   expectReload: () => void,
 *   beginAnalysis: () => void,
 * }} VscodeServices
 * - `isWarm()`: a caller query (incoming calls) answered, so the server has the project
 *   loaded and caller queries get the ordinary deadline.
 * - `isServerWarm()`: the server answered a call-hierarchy item or a non-empty reference
 *   list, which needs only one parsed file. Until then empty answers are retried, since a
 *   server that is not up answers nothing.
 * - `expectReload()`: the server is about to reload its projects (a checkout moved the
 *   worktree under it): treat it as cold again.
 * - `beginAnalysis()`: a new analysis starts. Cold queries still queued from the previous
 *   one ask nothing and reject, and the new analysis gets the whole cold budget.
 */

/** A request ran past its deadline or hit the outstanding-request cap. */
const RETRYABLE = /timed out|outstanding requests/;

/**
 * At most this many provider requests outstanding at once (the maximum analysis
 * concurrency), across analyses, until the underlying promises settle: a timed-out command
 * still holds a real provider request. A request past the cap rejects at once, retryable,
 * rather than queue without bound behind a stalled server.
 */
const MAX_OUTSTANDING_REQUESTS = 32;

/** A failed request, with the reason shown to the reviewer as its message. */
class ServiceError extends Error {
  /**
   * @param {string} message
   * @param {{ retryable?: boolean, cause?: unknown }} [options] `retryable`: the server did
   *   not answer in time or was not ready; the same request may succeed later.
   */
  constructor(message, { retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ServiceError';
    this.retryable = retryable;
  }
}

/**
 * A provider's or the deadline's rejection as a ServiceError. Its message is kept as is,
 * since it becomes the reason; a timeout, whether ours or the provider's own, and the
 * outstanding-request cap are retryable.
 * @param {unknown} error
 */
function asServiceError(error) {
  if (error instanceof ServiceError) return error;
  const message = error instanceof Error ? error.message : String((error && /** @type {any} */ (error).message) || '');
  return new ServiceError(message, { retryable: RETRYABLE.test(message), cause: error });
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null;

/** @param {unknown} p @returns {p is { line: number, character: number }} */
const isPosition = (p) => isObject(p) && Number.isInteger(p.line) && Number.isInteger(p.character);

/** @param {unknown} r @returns {r is { start: { line: number, character: number }, end: { line: number, character: number } }} */
const isRange = (r) => isObject(r) && isPosition(r.start) && isPosition(r.end);

/** @param {unknown} uri @returns {string|null} The file path of a `file:` URI object. */
const fsPathOf = (uri) => (isObject(uri) && typeof uri.fsPath === 'string' ? uri.fsPath : null);

/**
 * Creates the services. Budgets (all validated here; a value outside its range throws a
 * RangeError):
 * - `queryTimeoutMs` (default 5000, 1..120000): the wait for one provider command once
 *   the server answers caller queries. Five seconds admits ordinary warm queries (median
 *   384 ms in the live review) but stops a 27–92 s server stall from gating caller results.
 *   The provider keeps running; only this bounded wait ends. Exhausted: the request
 *   rejects, retryable.
 * - `coldQueryTimeoutMs` (default 60000, 1..120000): while the server is still loading its
 *   projects (after the window opens or a checkout), every query waits behind that load;
 *   eight parallel queries at five seconds each all time out. Until one caller query has
 *   answered (`isWarm()`), caller queries run one at a time (`callerQuery`), each allowed
 *   this long for the whole query.
 * - `coldBudgetMs` (default 120000, 0..600000): the total time cold caller queries may take
 *   in one analysis (`beginAnalysis()` resets it). Past it caller queries run in parallel
 *   at `queryTimeoutMs` again, and what times out is retryable (the session retries it
 *   once the server is up).
 * - `retries` (default 4, 0..20) and `retryDelayMs` (default 250, 0..10000): before the
 *   server is up, an empty call-hierarchy answer outside the cold phase is asked again up
 *   to `retries` times, waiting `retryDelayMs × attempt` between. Exhausted: rejects
 *   "language server not ready", retryable.
 * @param {object} options
 * @param {VscodeApi} options.vscode
 * @param {string|null} [options.repoRoot] Decides which callers are tests.
 * @param {number} [options.retries]
 * @param {number} [options.retryDelayMs]
 * @param {number} [options.queryTimeoutMs]
 * @param {number} [options.coldQueryTimeoutMs]
 * @param {number} [options.coldBudgetMs]
 * @param {(message: string) => void} [options.trace]
 * @param {() => void} [options.onRetry] Called for each empty answer asked again while the
 *   server is not up (the resolver's `warmupRetries`).
 * @returns {VscodeServices}
 */
function createVscodeServices({
  vscode, repoRoot = null, retries = 4, retryDelayMs = 250, queryTimeoutMs = 5000,
  coldQueryTimeoutMs = 60000, coldBudgetMs = 120000, trace = () => {}, onRetry = () => {},
}) {
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 120000) throw new RangeError('query timeout must be 1..120000 ms');
  if (!Number.isSafeInteger(coldQueryTimeoutMs) || coldQueryTimeoutMs < 1 || coldQueryTimeoutMs > 120000) throw new RangeError('cold query timeout must be 1..120000 ms');
  if (!Number.isSafeInteger(coldBudgetMs) || coldBudgetMs < 0 || coldBudgetMs > 600000) throw new RangeError('cold budget must be 0..600000 ms');
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 20) throw new RangeError('retries must be 0..20');
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10000) throw new RangeError('retry delay must be 0..10000 ms');

  // State of the server as these services have seen it. Owner: these services, which the
  // resolver keeps for the window (src/readiness.js). Reset: `expectReload()`.
  // `serverWarm`: see isServerWarm(). `callersReady`: see isWarm().
  let serverWarm = false;
  let callersReady = false;
  // The cold phase (see coldQueryTimeoutMs). Owner: these services. `coldTurn` is the end
  // of the queue of cold caller queries; each waits for the one before it. `coldSpentMs` is
  // the time cold queries took in this analysis. `analysis` counts beginAnalysis() calls:
  // a query that waited in the queue across one asks nothing, since the analysis that
  // wanted its answer is gone. Reset: beginAnalysis() and expectReload() reset coldSpentMs.
  /** @type {Promise<void>} */
  let coldTurn = Promise.resolve();
  let coldSpentMs = 0;
  let analysis = 0;
  const coldPhase = () => !callersReady && coldSpentMs < coldBudgetMs;
  // Requests sent and not yet settled (see MAX_OUTSTANDING_REQUESTS).
  let providerRequests = 0;
  const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** @param {string} name @param {unknown[]} args */
  async function requestProvider(name, args) {
    if (providerRequests >= MAX_OUTSTANDING_REQUESTS) {
      throw new ServiceError(`language server has ${MAX_OUTSTANDING_REQUESTS} outstanding requests — retry when it responds`, { retryable: true });
    }
    providerRequests++;
    try { return await vscode.commands.executeCommand(name, ...args); }
    finally { providerRequests--; }
  }

  /**
   * One provider command within `timeoutMs`.
   * @param {string} name @param {unknown[]} args @param {number} timeoutMs
   * @param {string} [label] Names the command in a timeout's reason.
   */
  async function ask(name, args, timeoutMs, label = name) {
    try { return await withDeadline(() => requestProvider(name, args), timeoutMs, label); }
    catch (e) { throw asServiceError(e); }
  }

  /**
   * The editor position of an offset into a head document, read from disk.
   * @param {import('./languages/types').DocRef} doc @param {number} pos
   */
  function editorPosition(doc, pos) {
    const p = offsetToPosition(doc.file, pos);
    if (!p) throw new ServiceError('unreadable');
    return { uri: vscode.Uri.file(doc.file), position: new vscode.Position(p.line, p.character) };
  }

  // Base-side documents are not on disk, and gopls and the Go extension serve only `file:`
  // documents (gate L1, decided: a temporary file in the extension's storage). Until G2
  // implements that, every base-side question has no answer: `null`, never "nothing".
  /** @param {import('./languages/types').DocRef} doc */
  const unserved = (doc) => doc.side !== 'head';

  /**
   * An editor location or location link as offsets; null when it is malformed.
   * @param {unknown} l @returns {import('./languages/types').ServerLocation|null}
   */
  function toLocation(l) {
    if (!isObject(l)) return null;
    const file = fsPathOf(l.uri || l.targetUri);
    const range = l.range || l.targetSelectionRange || l.targetRange;
    if (!file || !isRange(range)) return null;
    return {
      file,
      start: positionToOffset(file, range.start.line, range.start.character),
      end: positionToOffset(file, range.end.line, range.end.character),
    };
  }

  /**
   * A list of locations; null when the answer is not a list or one entry is malformed: an
   * answer we cannot read whole is no answer.
   * @param {unknown} answer
   */
  function toLocations(answer) {
    if (!Array.isArray(answer)) return null;
    /** @type {import('./languages/types').ServerLocation[]} */
    const out = [];
    for (const l of answer) {
      const location = toLocation(l);
      if (!location) return null;
      out.push(location);
    }
    return out;
  }

  /**
   * A location query at a head document's offset, with the ordinary deadline.
   * @param {string} command @param {import('./languages/types').DocRef} doc @param {number} pos
   */
  async function locationsAt(command, doc, pos) {
    if (unserved(doc)) return null;
    const at = editorPosition(doc, pos);
    return toLocations(await ask(command, [at.uri, at.position], queryTimeoutMs));
  }

  /**
   * The callers in an incoming-calls answer, as CallerRows. A call whose caller's file
   * cannot be read is left out, as its position cannot be converted; a malformed answer is
   * no answer (null).
   * @param {unknown} calls
   * @returns {import('./engine/caller-contract').CallerRow[]|null}
   */
  function toCallerRows(calls) {
    if (!Array.isArray(calls)) return null;
    /** @type {import('./engine/caller-contract').CallerRow[]} */
    const rows = [];
    for (const c of calls) {
      const from = isObject(c) ? c.from : null;
      const f = isObject(from) ? fsPathOf(from.uri) : null;
      // Only the start of the caller's name is used, so only it is required.
      const start = isObject(from) && isObject(from.selectionRange) ? from.selectionRange.start : null;
      if (!isObject(from) || !f || !isPosition(start) || typeof from.name !== 'string') return null;
      const fromRanges = c.fromRanges === undefined || c.fromRanges === null ? [] : c.fromRanges;
      if (!Array.isArray(fromRanges) || !fromRanges.every(isRange)) return null;
      const offset = positionToOffset(f, start.line, start.character);
      if (offset == null) continue;
      const callSites = fromRanges.map((r) => ({
        start: positionToOffset(f, r.start.line, r.start.character),
        end: positionToOffset(f, r.end.line, r.end.character),
      })).filter((x) => x.start != null);
      rows.push({
        label: from.detail ? `${from.detail}.${from.name}` : from.name,
        file: f, pos: offset, test: isTestFile(repoRoot, f), sites: callSites.length,
        callSites: /** @type {Array<{ start: number, end: number }>} */ (callSites),
      });
    }
    return rows;
  }

  /**
   * Incoming calls of a prepared item. Any list proves the project is loaded.
   * @param {unknown} item @param {number} timeoutMs
   */
  async function incomingCallsWithin(item, timeoutMs) {
    const calls = await ask('vscode.provideIncomingCalls', [item], timeoutMs);
    if (!Array.isArray(calls)) return null;
    callersReady = true;
    return toCallerRows(calls);
  }

  /**
   * Asking once the server answers caller queries: each command gets queryTimeoutMs, and
   * an empty call-hierarchy answer is retried only while the server is not up.
   * @type {import('./languages/types').LanguageServices}
   */
  const warmScope = {
    available,
    documentSymbols,
    async prepareCallHierarchy(doc, pos) {
      if (unserved(doc)) return null;
      const at = editorPosition(doc, pos);
      const maxAttempts = serverWarm ? 1 : retries + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const items = await ask('vscode.prepareCallHierarchy', [at.uri, at.position], queryTimeoutMs);
        if (Array.isArray(items) && items.length) { serverWarm = true; return items; }
        if (serverWarm) break;           // the server is up: no hierarchy item for this symbol
        onRetry();
        if (attempt < maxAttempts - 1) await sleep(retryDelayMs * (attempt + 1));
      }
      // Without an item from a server that is up, support for this symbol is unproven.
      if (serverWarm) return [];
      throw new ServiceError('language server not ready', { retryable: true });
    },
    incomingCalls: (item) => incomingCallsWithin(item, queryTimeoutMs),
    references,
    implementations: (doc, pos) => locationsAt('vscode.executeImplementationProvider', doc, pos),
    definitions: (doc, pos) => locationsAt('vscode.executeDefinitionProvider', doc, pos),
  };

  /**
   * Asking while the server is loading: one deadline, `budgetMs`, for the whole caller
   * query, polling until the file has a hierarchy item (a server that is not up answers
   * none). The clock starts when the scope is made, just before its query runs.
   * @param {number} budgetMs
   * @returns {import('./languages/types').LanguageServices}
   */
  function coldScope(budgetMs) {
    const started = Date.now();
    const left = () => budgetMs - (Date.now() - started);
    return {
      ...warmScope,
      async prepareCallHierarchy(doc, pos) {
        if (unserved(doc)) return null;
        const at = editorPosition(doc, pos);
        for (let attempt = 1; left() > 0; attempt++) {
          const items = await ask('vscode.prepareCallHierarchy', [at.uri, at.position], left());
          if (Array.isArray(items) && items.length) { serverWarm = true; return items; }
          if (serverWarm) return [];
          onRetry();
          await sleep(Math.max(0, Math.min(250 * attempt, 2000, left())));
        }
        throw new ServiceError(`language server not ready after ${Math.round(budgetMs / 1000)} s`, { retryable: true });
      },
      incomingCalls: (item) => incomingCallsWithin(item, Math.max(1, left())),
    };
  }

  /**
   * One caller query (see LanguageServices.callerQuery). Warm: `run` asks at once with the
   * ordinary deadlines. Cold: it waits for the cold queries before it, then asks through a
   * scope bounded by coldQueryTimeoutMs and what is left of coldBudgetMs; the turn is
   * released when `run` settles. Inside `run`, ask through the scope it is given: the
   * top-level methods do not apply the cold phase.
   * @template T
   * @param {(scope: import('./languages/types').LanguageServices) => Promise<T>} run
   * @returns {Promise<T>}
   */
  async function callerQuery(run) {
    if (!coldPhase()) return run(warmScope);
    const startedAnalysis = analysis;
    /** @type {() => void} */
    let release = () => {};
    /** @type {Promise<void>} */
    const turn = new Promise((resolve) => { release = () => resolve(); });
    const before = coldTurn;
    coldTurn = turn;
    try {
      await before;
      // A new analysis began while this waited: its answer would be dropped, so ask nothing.
      if (startedAnalysis !== analysis) throw new ServiceError('caller query belongs to an earlier analysis');
      // The server came up while this query waited: let the next one go at once.
      if (!coldPhase()) { release(); return await run(warmScope); }
      const t = Date.now();
      try {
        return await run(coldScope(Math.min(coldQueryTimeoutMs, coldBudgetMs - coldSpentMs)));
      } finally {
        coldSpentMs += Date.now() - t;
        if (callersReady) trace(`language server answered caller queries after ${coldSpentMs}ms of cold queries`);
      }
    } finally {
      release();
    }
  }

  /**
   * Whether the editor knows the language. Whether its server answers is learned from the
   * queries themselves.
   * @param {string} languageId
   * @returns {Promise<{ ok: true }|{ ok: false, reason: string }>}
   */
  async function available(languageId) {
    if (!vscode.languages) return { ok: false, reason: 'the editor does not list its languages' };
    const known = await vscode.languages.getLanguages();
    return Array.isArray(known) && known.includes(languageId)
      ? { ok: true }
      : { ok: false, reason: `the editor has no support for ${languageId} installed` };
  }

  /**
   * The symbols of a head document, as ServerSymbols with offsets and LSP kind numbers
   * (the editor's `SymbolKind` is the LSP number minus one). An answer in the flat
   * `SymbolInformation` form uses its location's range for both ranges. A malformed answer
   * is no answer. The tree is walked with an explicit stack; its size is the answer's.
   * @param {import('./languages/types').DocRef} doc
   * @returns {Promise<import('./languages/types').ServerSymbol[]|null>}
   */
  async function documentSymbols(doc) {
    if (unserved(doc)) return null;
    if (!offsetToPosition(doc.file, 0)) throw new ServiceError('unreadable');
    const answer = await ask('vscode.executeDocumentSymbolProvider', [vscode.Uri.file(doc.file)], queryTimeoutMs);
    if (!Array.isArray(answer)) return null;
    /** @param {{ start: { line: number, character: number }, end: { line: number, character: number } }} r */
    const offsets = (r) => {
      const start = positionToOffset(doc.file, r.start.line, r.start.character);
      const end = positionToOffset(doc.file, r.end.line, r.end.character);
      return start == null || end == null ? null : { start, end };
    };
    /** @type {import('./languages/types').ServerSymbol[]} */
    const roots = [];
    /** @type {Array<{ raw: unknown, into: import('./languages/types').ServerSymbol[] }>} */
    const stack = answer.map((raw) => ({ raw, into: roots })).reverse();
    while (stack.length) {
      const { raw, into } = /** @type {{ raw: unknown, into: import('./languages/types').ServerSymbol[] }} */ (stack.pop());
      if (!isObject(raw) || typeof raw.name !== 'string' || !Number.isInteger(raw.kind)) return null;
      const rawRange = isObject(raw.location) ? raw.location.range : raw.range;
      const rawSelection = isObject(raw.location) ? raw.location.range : raw.selectionRange;
      if (!isRange(rawRange) || !isRange(rawSelection)) return null;
      const range = offsets(rawRange);
      const selectionRange = offsets(rawSelection);
      if (!range || !selectionRange) return null;
      /** @type {import('./languages/types').ServerSymbol} */
      const symbol = {
        name: raw.name, detail: typeof raw.detail === 'string' ? raw.detail : '',
        kind: raw.kind + 1, range, selectionRange, children: [],
      };
      into.push(symbol);
      const children = Array.isArray(raw.children) ? raw.children : [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ raw: children[i], into: symbol.children });
    }
    return roots;
  }

  /**
   * References at a head document's offset. A non-empty list proves the server is up.
   * @param {import('./languages/types').DocRef} doc @param {number} pos
   */
  async function references(doc, pos) {
    const locations = await locationsAt('vscode.executeReferenceProvider', doc, pos);
    if (locations && locations.length) serverWarm = true;
    return locations;
  }

  // The first query pays for the language server loading the whole project (tens of
  // seconds on a large one). Concurrent queries all block behind it and each reports the
  // full wait. Warming up explicitly means that cost is paid once, ideally before the
  // user asks for anything. Warm means a caller query answered (`callersReady`), not only
  // a hierarchy item: an item needs one parsed file, the callers need the project.
  /**
   * @param {import('./languages/types').DocRef} doc @param {number} pos
   * @param {{ timeoutMs?: number }} [options] Total elapsed-time budget, 1..120000 ms.
   * @returns {Promise<boolean>} Whether the server answered a caller query in time.
   */
  async function warmUp(doc, pos, { timeoutMs = 15000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new RangeError('warm-up timeout must be 1..120000 ms');
    if (callersReady) return true;
    if (unserved(doc)) return false;
    const started = Date.now();
    const left = () => timeoutMs - (Date.now() - started);
    let attempt = 0;
    while (left() > 0) {
      const p = offsetToPosition(doc.file, pos);
      if (!p) return false;
      const at = { uri: vscode.Uri.file(doc.file), position: new vscode.Position(p.line, p.character) };
      try {
        const items = await withDeadline(() => requestProvider('vscode.prepareCallHierarchy', [at.uri, at.position]), left(), 'language-server warm-up');
        if (Array.isArray(items) && items.length && left() > 0) {
          serverWarm = true;
          await withDeadline(() => requestProvider('vscode.provideIncomingCalls', [items[0]]), left(), 'language-server warm-up');
          callersReady = true;
          trace(`language server warm after ${Date.now() - started}ms`);
          return true;
        }
      } catch { /* server still starting */ }
      attempt++;
      if (left() > 0) await sleep(Math.min(250 * attempt, 2000, left()));
    }
    trace(`language server did not warm within ${timeoutMs}ms`);
    return false;
  }

  return {
    ...warmScope,
    callerQuery,
    warmUp,
    isWarm: () => callersReady,
    isServerWarm: () => serverWarm,
    expectReload() {
      serverWarm = false;
      callersReady = false;
      coldSpentMs = 0;
    },
    beginAnalysis() {
      analysis++;
      coldSpentMs = 0;
    },
  };
}

module.exports = { createVscodeServices, ServiceError, MAX_OUTSTANDING_REQUESTS };
