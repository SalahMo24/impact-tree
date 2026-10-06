'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { createModuleCallers } = require('./engine/module-callers');
const { AnalysisCancelledError, throwIfCancelled } = require('./engine/cancellation');

// One worker per session/repository. A 30 s deadline bounds each prepare/query,
// including index construction (measured at 14.9 s on the large workspace). A 1 GiB
// old-generation heap limit bounds retained ASTs. Failure terminates the worker and
// returns incomplete coverage; the next analysis can build another one. Idle workers
// are unreferenced and are terminated when the session closes or a run is cancelled.
function createModuleCallerPool(repo, { timeoutMs = 30000, makeWorker = (file, options) => new Worker(file, options) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new RangeError('worker timeout must be 1..120000 ms');
  let worker = null;
  let generation = 0;
  let nextId = 0;
  const pending = new Map();
  let detach = () => {};

  function stop(error) {
    const old = worker;
    worker = null;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    // terminate() owns an asynchronous shutdown; its error cannot escape disposal.
    if (old) old.terminate().catch(() => {});
  }

  function getWorker() {
    if (worker) return worker;
    const created = makeWorker(path.join(__dirname, 'engine/module-callers-worker.js'), {
      workerData: { repo }, resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    worker = created;
    created.on('message', ({ id, value, error }) => {
      const request = pending.get(id);
      if (!request || worker !== created) return;
      pending.delete(id);
      clearTimeout(request.timer);
      if (!pending.size) created.unref();
      if (error) request.reject(new Error(error)); else request.resolve(value);
    });
    created.on('error', (error) => { if (worker === created) stop(error); });
    created.on('exit', (code) => { if (worker === created) stop(new Error(`caller index worker exited (${code})`)); });
    created.unref();
    return created;
  }

  function request(message) {
    return new Promise((resolve, reject) => {
      const target = getWorker();
      const id = ++nextId;
      const timer = setTimeout(() => stop(new Error(`cross-file caller search exceeded ${timeoutMs} ms`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      target.ref();
      try { target.postMessage({ ...message, id }); }
      catch (e) { stop(e); }
    });
  }

  function forAnalysis(ts, git, signal) {
    throwIfCancelled(signal);
    detach();
    const owner = ++generation;
    // Applicability checks only changed/expanded files. The full index is never built
    // in this host instance; all reads/parsing of the worktree happen in the worker.
    const local = createModuleCallers(ts, repo, git);
    // Use the same compiler module that collected these symbols. A monorepo may
    // carry different TypeScript versions in different components.
    const compilerPath = Object.keys(require.cache).find(file => require.cache[file].exports === ts);
    const hints = [];
    let prepared = null;
    let notes = [];
    let failure = null;
    let builds = 0;
    let activeSignal = signal;
    const onAbort = () => stop(new AnalysisCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });
    detach = () => signal?.removeEventListener('abort', onAbort);
    return {
      appliesTo: local.appliesTo,
      hint: c => hints.push({ file: c.file, namePos: c.namePos, nested: c.nested,
        className: c.className, isConstructor: c.isConstructor, simpleName: c.simpleName }),
      notes: () => notes.slice(),
      stats: () => ({ builds }),
      complete() { if (owner === generation) { detach(); activeSignal = null; } },
      async incomingWithStatus(file, pos, withTests = true) {
        throwIfCancelled(activeSignal);
        if (owner !== generation) return { callers: [], complete: false, reason: 'caller index belongs to an earlier analysis' };
        try {
          if (failure) throw failure;
          if (!prepared) prepared = request({ kind: 'prepare', hints, compilerPath, compilerVersion: ts.version });
          const status = await prepared;
          builds = status.builds;
          throwIfCancelled(activeSignal);
          if (owner !== generation) throw new AnalysisCancelledError();
          const value = await request({ kind: 'query', args: [file, pos, withTests] });
          throwIfCancelled(activeSignal);
          if (owner !== generation) throw new AnalysisCancelledError();
          notes = value.notes;
          return value.answer;
        } catch (e) {
          throwIfCancelled(activeSignal);
          failure = e;
          notes = [`cross-file callers may be missing: ${e.message}`];
          return { callers: [], complete: false, reason: e.message };
        }
      },
    };
  }

  return { forAnalysis, dispose() { detach(); generation++; stop(new AnalysisCancelledError()); } };
}

module.exports = { createModuleCallerPool };
