// @ts-check
'use strict';
// The worker that holds one repository's C# syntax index for the editor (C5 S2; the worker
// side is ./index-worker.js). Lifecycle copied from src/session/module-caller-pool.js: a heap
// limit, a deadline per request (the build included), `unref` while idle so tests and the
// harness exit, terminate on failure (every pending request rejects; the next request starts
// another worker), and `dispose` when the session ends or another repository is indexed
// (./editor-extras.js; the provider's `dispose`, from src/session/session.js `dispose`).
// After `dispose` no worker is started and every request rejects.
//
// Budgets (CODING_STYLE §2):
// - The editor's index bound, `EDITOR_MAX_FILES` C# files (8 000) and `EDITOR_MAX_BYTES`
//   (96 MiB, the sum of the listed files' sizes on disk). Unit: files and bytes. Valid range:
//   1..100 000 files, 1 byte..1 GiB (`checkBound`). Owner: the owner's decision of 2026-11-22
//   (PLAN-C5-SHOULD-FIX). Enforced in ./provider.js `indexRepositoryWithin`, in the worker,
//   before any file is read. Exhaustion: no index (never a partial one) and every method's
//   answer is incomplete with a reason naming the files and MiB found and the bound.
// - The worker's old-generation heap, `WORKER_HEAP_MB` (2 048 MiB; valid 256..4 096).
//   Rationale: measured on a 2 262-file corpus (13.2 MiB of C#), the build's heap peaks at
//   ~235 MiB (~17.8x the source; ~186 MiB retained after GC), so ~1.7 GB at the 96 MiB bound,
//   plus headroom. Exhaustion: the worker dies (ERR_WORKER_OUT_OF_MEMORY); pending requests
//   reject; the failure is remembered for that tree state (./editor-extras.js), a reason.
// - `BUILD_DEADLINE_MS` (60 s) per build: ~2.1 s measured for that corpus, so ~15 s at the
//   bound, with room for a slow machine. `QUERY_DEADLINE_MS` (30 s) per lookup: a lookup is
//   one walk of the index (milliseconds on the corpus), so the deadline only catches a hung
//   worker; the same 30 s as the TypeScript module-caller pool. Both valid 1..120 000 ms.
//   Exhaustion: the worker is terminated and the request rejects (a reason, incomplete). A
//   query is posted only for the build the pool serves now (`serves`), so a stale query never
//   waits behind a newer build and its deadline cannot kill that build.
// The pool owns one worker at a time; its index lives as long as that worker.

const path = require('path');
const { Worker } = require('worker_threads');
const { realClock } = require('../../engine/clock');

const EDITOR_MAX_FILES = 8000;
const EDITOR_MAX_BYTES = 96 * 1024 * 1024;
const WORKER_HEAP_MB = 2048;
const BUILD_DEADLINE_MS = 60000;
const QUERY_DEADLINE_MS = 30000;

/** @param {string} name @param {unknown} value @param {number} min @param {number} max */
function checkRange(name, value, min, max) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) throw new RangeError(`${name} must be an integer in ${min}..${max}`);
}

/** The index bound's valid range. @param {{ maxFiles: number, maxBytes: number }} bound */
function checkBound(bound) {
  checkRange('maxFiles', bound.maxFiles, 1, 100000);
  checkRange('maxBytes', bound.maxBytes, 1, 1024 * 1024 * 1024);
  return bound;
}

/**
 * One repository's index worker. A request rejects on a worker error, exit, deadline or
 * dispose; an error with `code: 'WORKER_START'` means the worker could not be started (the
 * constructor threw, or an error came before the worker was online).
 * @param {string} repo
 * @param {{ makeWorker?: (file: string, options: any) => any, clock?: import('../../engine/clock').Clock,
 *   heapMb?: number, buildMs?: number, queryMs?: number }} [options]
 */
function createCsharpIndexPool(repo, {
  makeWorker = (file, options) => new Worker(file, options), clock = realClock, heapMb = WORKER_HEAP_MB,
  buildMs = BUILD_DEADLINE_MS, queryMs = QUERY_DEADLINE_MS,
} = {}) {
  checkRange('heapMb', heapMb, 256, 4096);
  checkRange('buildMs', buildMs, 1, 120000);
  checkRange('queryMs', queryMs, 1, 120000);
  /** @type {any} */
  let worker = null;
  let nextId = 0;
  let disposed = false;
  // The build the worker holds now (0: none: never built, or the worker stopped since).
  let serving = 0;
  let builds = 0;
  /** @type {Error|null} */
  let lastError = null;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: unknown }>} */
  const pending = new Map();

  /** @param {Error} error */
  function stop(error) {
    const old = worker;
    worker = null;
    serving = 0;
    if (old) lastError = error;
    for (const request of pending.values()) { clock.clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    // terminate() owns an asynchronous shutdown; its error cannot escape disposal.
    if (old) Promise.resolve(old.terminate()).catch(() => {});
  }

  /** @param {string} message */
  const startError = (message) => Object.assign(new Error(`the C# syntax index worker could not start: ${message}`), { code: 'WORKER_START' });

  function getWorker() {
    if (disposed) throw new Error('the C# syntax index worker was disposed');
    if (worker) return worker;
    let created;
    try {
      created = makeWorker(path.join(__dirname, 'index-worker.js'), { workerData: { repo }, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    } catch (e) {
      throw startError(e && /** @type {any} */ (e).message);
    }
    worker = created;
    let online = false;
    created.on('online', () => { online = true; });
    created.on('message', (/** @type {{ id: number, value?: any, error?: string }} */ { id, value, error }) => {
      const request = pending.get(id);
      if (!request || worker !== created) return;
      pending.delete(id);
      clock.clearTimeout(request.timer);
      if (!pending.size) created.unref();
      if (error) request.reject(new Error(error)); else request.resolve(value);
    });
    created.on('messageerror', (/** @type {Error} */ error) => { if (worker === created) stop(new Error(`the C# syntax index worker sent an unreadable answer: ${error.message}`)); });
    created.on('error', (/** @type {Error} */ error) => {
      if (worker !== created) return;
      // A real worker is online before it runs any code; an error before that is a start failure.
      const real = typeof created.threadId === 'number';
      stop(real && !online ? startError(error.message) : new Error(`the C# syntax index worker failed: ${error.message}`));
    });
    created.on('exit', (/** @type {number} */ code) => { if (worker === created) stop(new Error(`the C# syntax index worker exited (${code})`)); });
    created.unref();
    return created;
  }

  /**
   * @param {any} message @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  function request(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      const target = getWorker();
      const id = ++nextId;
      const timer = clock.setTimeout(() => stop(new Error(`the C# syntax index worker did not answer within ${timeoutMs} ms`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      target.ref();
      try { target.postMessage({ ...message, id }); } catch (e) { stop(/** @type {Error} */ (e)); }
    });
  }

  return {
    /**
     * Builds (or keeps) the index for `state` within `bound`; resolves the worker's answer
     * with `build`, the number `serves` and `query` take.
     * @param {string|null} state @param {{ maxFiles: number, maxBytes: number }} bound
     */
    async build(state, bound) {
      checkBound(bound);
      const build = ++builds;
      const answer = request({ kind: 'build', state, ...bound }, buildMs);
      serving = build;
      try {
        return { ...(await answer), build };
      } catch (e) {
        if (serving === build) serving = 0;
        throw e;
      }
    },
    /** Whether the worker still holds the index of build `build`. @param {number} build */
    serves: (build) => !disposed && build === serving,
    /**
     * A lookup in the index of build `build`; rejects at once when the pool no longer serves it.
     * @param {number} build @param {'dispatchOf'|'callersOfWithStatus'} kind @param {string|null} state @param {any} arg
     */
    async query(build, kind, state, arg) {
      if (disposed) throw new Error('the C# syntax index worker was disposed');
      if (build !== serving) {
        throw new Error(lastError && !serving ? `the C# syntax index worker stopped (${lastError.message})` : 'the C# syntax index was rebuilt for another tree state');
      }
      return request({ kind, state, arg }, queryMs);
    },
    dispose() { disposed = true; stop(new Error('the C# syntax index worker was disposed')); },
  };
}

module.exports = { createCsharpIndexPool, checkBound, EDITOR_MAX_FILES, EDITOR_MAX_BYTES, WORKER_HEAP_MB, BUILD_DEADLINE_MS, QUERY_DEADLINE_MS };
