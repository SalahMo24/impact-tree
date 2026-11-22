// @ts-check
'use strict';
// The worker that holds one repository's C# syntax index for the editor (C5 S2; the worker
// side is ./index-worker.js). Lifecycle copied from src/session/module-caller-pool.js: a heap
// limit, a deadline per request (the build included), `unref` while idle so tests and the
// harness exit, terminate on failure (every pending request rejects; the next request starts
// another worker, `epoch` counts the stops), and `dispose` when the session ends (the
// provider's `dispose`, from src/session/session.js `dispose`).
//
// Budgets (CODING_STYLE §2):
// - The editor's index bound, `EDITOR_MAX_FILES` C# files (8 000) and `EDITOR_MAX_BYTES`
//   (96 MiB, the sum of the listed files' sizes on disk). Unit: files and bytes. Owner: the
//   owner's decision of 2026-11-22 (PLAN-C5-SHOULD-FIX). Enforced in
//   ./provider.js `indexRepositoryWithin`, in the worker, before any file is read.
//   Exhaustion: no index (never a partial one) and every method's answer is incomplete with
//   a reason naming the files and MiB found and the bound. Rationale: measured ~186 MiB of
//   heap for 13.2 MiB of source (a 2 262-file corpus), so ~1.3 GB at the bound. The CLI keeps
//   its own bound (3 000 files / 64 MiB, ../repository-files.js) and behaviour.
// - The worker's old-generation heap, `WORKER_HEAP_MB` (1 536 MiB): the ~1.3 GB estimate at
//   the bound plus headroom. Exhaustion: the worker dies; pending requests reject (a reason).
// - Deadlines: `BUILD_DEADLINE_MS` (60 s; ~1.4 s measured for 2 262 files, so ~5 s at the
//   bound on that machine) per build, `QUERY_DEADLINE_MS` (30 s) per lookup. Exhaustion: the
//   worker is terminated and the request rejects (a reason, incomplete).
// The pool owns one worker at a time; its index lives as long as that worker.

const path = require('path');
const { Worker } = require('worker_threads');
const { realClock } = require('../../engine/clock');

const EDITOR_MAX_FILES = 8000;
const EDITOR_MAX_BYTES = 96 * 1024 * 1024;
const WORKER_HEAP_MB = 1536;
const BUILD_DEADLINE_MS = 60000;
const QUERY_DEADLINE_MS = 30000;

/**
 * One repository's index worker. `request` rejects on a worker error, exit, deadline or
 * dispose; an error with `code: 'WORKER_START'` means the worker could not be started.
 * @param {string} repo
 * @param {{ makeWorker?: (file: string, options: any) => any, clock?: import('../../engine/clock').Clock, heapMb?: number }} [options]
 */
function createCsharpIndexPool(repo, { makeWorker = (file, options) => new Worker(file, options), clock = realClock, heapMb = WORKER_HEAP_MB } = {}) {
  /** @type {any} */
  let worker = null;
  let nextId = 0;
  let epoch = 0;
  /** @type {Error|null} */
  let lastError = null;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: unknown }>} */
  const pending = new Map();

  /** @param {Error} error */
  function stop(error) {
    const old = worker;
    worker = null;
    if (old) { epoch++; lastError = error; }
    for (const request of pending.values()) { clock.clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    // terminate() owns an asynchronous shutdown; its error cannot escape disposal.
    if (old) Promise.resolve(old.terminate()).catch(() => {});
  }

  function getWorker() {
    if (worker) return worker;
    let created;
    try {
      created = makeWorker(path.join(__dirname, 'index-worker.js'), { workerData: { repo }, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    } catch (e) {
      const error = /** @type {any} */ (new Error(`the C# syntax index worker could not start: ${e && /** @type {any} */ (e).message}`));
      error.code = 'WORKER_START';
      throw error;
    }
    worker = created;
    created.on('message', (/** @type {{ id: number, value?: any, error?: string }} */ { id, value, error }) => {
      const request = pending.get(id);
      if (!request || worker !== created) return;
      pending.delete(id);
      clock.clearTimeout(request.timer);
      if (!pending.size) created.unref();
      if (error) request.reject(new Error(error)); else request.resolve(value);
    });
    created.on('error', (/** @type {Error} */ error) => { if (worker === created) stop(new Error(`the C# syntax index worker failed: ${error.message}`)); });
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
    request,
    /** How many times a worker stopped; an index built before the last stop is gone. */
    epoch: () => epoch,
    lastError: () => lastError,
    dispose() { stop(new Error('the C# syntax index worker was disposed')); },
  };
}

module.exports = { createCsharpIndexPool, EDITOR_MAX_FILES, EDITOR_MAX_BYTES, WORKER_HEAP_MB, BUILD_DEADLINE_MS, QUERY_DEADLINE_MS };
