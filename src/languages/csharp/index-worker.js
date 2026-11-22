// @ts-check
'use strict';
// The editor's C# syntax index in a worker thread (C5 S2): built and queried here, so its
// synchronous parse never blocks the extension host. Started and owned by ./index-pool.js;
// one worker per repository. Messages are handled one at a time, in order, so a query waits
// behind a build sent before it (the pool sends queries only for the build it serves now):
// - `{ id, kind: 'build', state, maxFiles, maxBytes }`: (re)builds the index for the tree
//   state `state` (./editor-extras.js `treeStateOf`) unless it already holds that state with
//   that bound (a null state is never reused). Answers `{ built, files, bytes, size, ms,
//   heapMb, heapPeakMb, reason }` (`built: false`: the earlier build's figures; `reason`: no
//   index, past the bound or git could not list the files).
// - `{ id, kind: 'dispatchOf' | 'callersOfWithStatus', state, arg }`: the index's answer as
//   plain data; an error when the index held is not the one built for `state`.
// Every answer is `{ id, value }` or `{ id, error }` (a message).
const { parentPort, workerData } = require('worker_threads');
const v8 = require('v8');
const { makeGit } = require('../../engine/git');
const { indexRepositoryWithin } = require('./provider');

if (!parentPort) throw new Error('the C# index worker runs in a worker thread');
const port = parentPort;
const repo = /** @type {string} */ (workerData.repo);
const git = makeGit(repo);
/** @type {any} */
let index = null;
/** @type {string|null} */
let state = null;
// The last build's answer, given again when the same state and bound are asked.
/** @type {any} */
let last = null;

/** @param {any} message @returns {any} */
function handle(message) {
  if (message.kind === 'build') {
    const key = `${message.maxFiles}:${message.maxBytes}`;
    if (index && last && message.state !== null && message.state === state && last.key === key) return { ...last.answer, built: false };
    index = null;
    state = null;
    last = null;
    const started = Date.now(); // wall-clock: log-only — the build time is traced
    const out = indexRepositoryWithin(repo, git, { maxFiles: message.maxFiles, maxBytes: message.maxBytes });
    index = out.index;
    state = message.state;
    const ms = Date.now() - started; // wall-clock: log-only — the build time is traced
    const mib = (/** @type {number} */ n) => Math.round(n / 1024 / 1024);
    // The peak: the heap the worker's V8 holds (`total_heap_size`, all spaces) right after the
    // build, before a collection; `heapMb` is what is in use.
    const answer = {
      built: true, files: out.files, bytes: out.bytes, size: index ? index.size : 0, ms,
      heapMb: mib(process.memoryUsage().heapUsed), heapPeakMb: mib(v8.getHeapStatistics().total_heap_size), reason: out.reason,
    };
    if (index) last = { key, answer };
    return answer;
  }
  if (!index || message.state !== state) throw new Error('the C# syntax index was rebuilt for another tree state');
  if (message.kind === 'dispatchOf') {
    const found = index.dispatchOf(message.arg);
    return found && {
      targets: found.targets.map((/** @type {any} */ t) => ({ file: t.file, pos: t.pos, via: t.via, text: t.text })),
      reasons: [...found.reasons], rows: (found.rows || []).map(plainRow),
    };
  }
  if (message.kind === 'callersOfWithStatus') {
    const answer = index.callersOfWithStatus(message.arg);
    return { callers: answer.callers.map(plainRow), incompleteReason: answer.incompleteReason };
  }
  throw new Error(`unknown request ${message.kind}`);
}

/** A caller row of the index as plain data. @param {any} c */
function plainRow(c) {
  return {
    file: c.file, label: c.label, pos: c.pos, callSites: c.callSites.map((/** @type {any} */ s) => ({ start: s.start, end: s.end })),
    ...(c.via ? { via: c.via, text: c.text } : {}),
  };
}

port.on('message', (message) => {
  try { port.postMessage({ id: message.id, value: handle(message) }); }
  catch (e) { port.postMessage({ id: message.id, error: (e && /** @type {any} */ (e).message) || 'the C# syntax index failed' }); }
});
