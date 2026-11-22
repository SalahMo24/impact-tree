// @ts-check
'use strict';
// The editor's C# syntax index in a worker thread (C5 S2): built and queried here, so its
// synchronous parse never blocks the extension host. Started and owned by ./index-pool.js;
// one worker per repository. Messages (one at a time, in order):
// - `{ id, kind: 'build', state, maxFiles, maxBytes }`: (re)builds the index for the tree
//   state `state` (./editor-extras.js `treeStateOf`) unless it already holds that state
//   (a null state is never reused). Answers `{ built, files, bytes, size, ms, heapMb, reason }`
//   (`reason`: no index, past the bound or git could not list the files).
// - `{ id, kind: 'dispatchOf' | 'callersOfWithStatus', state, arg }`: the index's answer as
//   plain data; an error when the index held is not the one built for `state`.
// Every answer is `{ id, value }` or `{ id, error }` (a message).
const { parentPort, workerData } = require('worker_threads');
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

/** @param {any} message @returns {any} */
function handle(message) {
  if (message.kind === 'build') {
    if (index && message.state !== null && message.state === state) return { built: false, size: index.size, reason: null };
    index = null;
    state = null;
    const started = Date.now(); // wall-clock: log-only — the build time is traced
    const out = indexRepositoryWithin(repo, git, { maxFiles: message.maxFiles, maxBytes: message.maxBytes });
    index = out.index;
    state = message.state;
    const ms = Date.now() - started; // wall-clock: log-only — the build time is traced
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    return { built: true, files: out.files, bytes: out.bytes, size: index ? index.size : 0, ms, heapMb, reason: out.reason };
  }
  if (!index || message.state !== state) throw new Error('the C# syntax index was rebuilt for another tree state');
  if (message.kind === 'dispatchOf') {
    const found = index.dispatchOf(message.arg);
    return found && { targets: found.targets.map((/** @type {any} */ t) => ({ file: t.file, pos: t.pos, via: t.via, text: t.text })), reasons: [...found.reasons] };
  }
  if (message.kind === 'callersOfWithStatus') {
    const answer = index.callersOfWithStatus(message.arg);
    return {
      callers: answer.callers.map((/** @type {any} */ c) => ({
        file: c.file, label: c.label, pos: c.pos, callSites: c.callSites.map((/** @type {any} */ s) => ({ start: s.start, end: s.end })),
        ...(c.via ? { via: c.via, text: c.text } : {}),
      })),
      incompleteReason: answer.incompleteReason,
    };
  }
  throw new Error(`unknown request ${message.kind}`);
}

port.on('message', (message) => {
  try { port.postMessage({ id: message.id, value: handle(message) }); }
  catch (e) { port.postMessage({ id: message.id, error: (e && /** @type {any} */ (e).message) || 'the C# syntax index failed' }); }
});
