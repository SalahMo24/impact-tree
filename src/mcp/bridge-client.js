// @ts-check
'use strict';
// The MCP server's side of the editor bridge (src/agent/agent-bridge.js): finds the live editor
// bridge for a repository through its lock file, connects, and offers `context` (which
// review the user is looking at) and `submit` (hand a result back to the editor).
const fs = require('fs');
const net = require('net');
const path = require('path');
const { realClock } = require('../engine/clock');
const { MAX_LINE_BYTES, defaultLockDir, realRepo, readLock, pidAlive, lockPathFor, parseLock } = require('./bridge-protocol');

const CONNECT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * @typedef {{ repo: string, mode: string, base: { ref: string, sha: string }, head: string, pr?: { number: number } }} BridgeContext
 * @typedef {{ stored: boolean, reason?: string, errors?: string[] }} SubmitOutcome
 * @typedef {{ context: () => Promise<BridgeContext|null>,
 *   submit: (kind: 'cards'|'callers', payload: unknown, meta: { head: string, base: unknown }) => Promise<SubmitOutcome>,
 *   close: () => void }} Bridge
 */

/**
 * Whether the lock directory is a real directory of this user (a lock planted elsewhere is not trusted).
 * @param {string} dir @returns {boolean}
 */
function dirIsOurs(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return false;
    return typeof process.getuid !== 'function' || st.uid === process.getuid();
  } catch {
    return false;
  }
}

// How many lock files `liveEditorRepos` reads at most. Unit: files.
const MAX_LOCKS_LISTED = 50;

/**
 * The repositories of every editor window whose bridge is live (Impact Tree open in it): a
 * lock that parses, names a live process, and sits under its own repository's name. Used
 * when the server was started outside any repository (Cursor starts servers in the home
 * folder) and the agent shares no workspace folder.
 * @param {{ lockDir?: string }} [options] `lockDir`: for tests.
 * @returns {Array<{ repo: string, askedAt: number|null }>} by real path; `askedAt`: when the user last
 *   pressed "Analyse with my agent" there. Empty when the folder is missing or not this user's.
 */
function liveEditorRepos({ lockDir = defaultLockDir() } = {}) {
  if (!dirIsOurs(lockDir)) return [];
  let names;
  try { names = fs.readdirSync(lockDir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).sort().slice(0, MAX_LOCKS_LISTED); } catch { return []; }
  /** @type {Map<string, number|null>} */
  const repos = new Map();
  for (const name of names) {
    let lock;
    try {
      const file = path.join(lockDir, name);
      if (fs.statSync(file).size > 64 * 1024) continue;
      lock = parseLock(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { continue; }
    if (!lock || !pidAlive(lock.pid) || lockPathFor(lockDir, lock.repo) !== path.join(lockDir, name)) continue;
    repos.set(lock.repo, typeof lock.askedAt === 'number' ? lock.askedAt : null);
  }
  return [...repos.keys()].sort().map((repo) => ({ repo, askedAt: /** @type {number|null} */ (repos.get(repo)) }));
}

/**
 * Connects to the editor bridge of `repo`. The editor closes a connection that stays idle (an
 * agent reading facts for minutes), so the returned bridge reopens one, from the lock file
 * again, whenever it finds its connection closed; only `close()` ends it for good.
 * @param {{ repo: string, signal?: AbortSignal, lockDir?: string, connectTimeoutMs?: number, requestTimeoutMs?: number,
 *   clock?: import('../engine/clock').Clock }} options
 *   `lockDir`, `connectTimeoutMs`, `requestTimeoutMs`, `clock`: for tests.
 * @returns {Promise<Bridge|null>} Null when no live editor bridge answers for `repo` (no lock, a malformed or
 *   stale one, a refused or slow connection, or an aborted `signal`). Never rejects.
 */
async function connectBridge(options) {
  const first = await openBridge(options);
  if (!first) return null;
  let inner = first;
  let ended = false;
  /** @returns {Promise<ReturnType<typeof makeBridge>>} */
  const live = async () => {
    if (ended) throw new Error('the editor bridge was closed');
    if (!inner.closed) return inner;
    const next = await openBridge(options);
    if (!next) throw new Error('the editor bridge is closed and the editor window no longer answers');
    inner = next;
    return inner;
  };
  return {
    async context() { return (await live()).context(); },
    async submit(kind, payload, meta) { return (await live()).submit(kind, payload, meta); },
    close() { ended = true; inner.close(); },
  };
}

/**
 * One connection to the editor bridge of `repo`, found through its lock file.
 * @param {Parameters<typeof connectBridge>[0]} options
 * @returns {Promise<ReturnType<typeof makeBridge>|null>} Null as `connectBridge` describes. Never rejects.
 */
async function openBridge({ repo, signal, lockDir = defaultLockDir(), connectTimeoutMs = CONNECT_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, clock = realClock }) {
  try {
    if (typeof repo !== 'string' || repo === '' || (signal && signal.aborted)) return null;
    const real = realRepo(repo);
    if (!dirIsOurs(lockDir)) return null;
    const lock = readLock(lockDir, real);
    if (!lock || lock.repo !== real || !pidAlive(lock.pid)) return null;
    // A lock names its own socket; only one inside the lock directory (or a Windows pipe) is followed.
    if (process.platform !== 'win32' && path.dirname(lock.socket) !== lockDir) return null;
    const socket = await openSocket(lock.socket, signal, connectTimeoutMs, clock);
    return socket ? makeBridge(socket, lock.token, requestTimeoutMs, clock) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} socketPath @param {AbortSignal|undefined} signal @param {number} timeoutMs
 * @param {import('../engine/clock').Clock} clock
 * @returns {Promise<net.Socket|null>}
 */
function openSocket(socketPath, signal, timeoutMs, clock) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let done = false;
    const finish = (/** @type {net.Socket|null} */ result) => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      socket.removeListener('error', onError);
      if (!result) socket.destroy();
      resolve(result);
    };
    const onError = () => finish(null);
    const onAbort = () => finish(null);
    const timer = clock.setTimeout(() => finish(null), timeoutMs);
    socket.once('connect', () => finish(socket));
    socket.on('error', onError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {net.Socket} socket @param {string} token @param {number} requestTimeoutMs
 * @param {import('../engine/clock').Clock} clock
 * @returns {Bridge & { readonly closed: boolean }}
 */
function makeBridge(socket, token, requestTimeoutMs, clock) {
  let nextId = 1;
  let closed = false;
  let buffer = '';
  /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: unknown }>} */
  const pending = new Map();

  const failAll = (/** @type {string} */ message) => {
    for (const [id, p] of pending) { clock.clearTimeout(p.timer); pending.delete(id); p.reject(new Error(message)); }
  };
  const shut = (/** @type {string} */ message) => {
    closed = true;
    socket.destroy();
    failAll(message);
  };

  socket.setEncoding('utf8');
  socket.on('data', (/** @type {string} */ chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES * 2) { shut('the editor bridge sent an oversized line'); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  });
  socket.on('error', () => shut('the editor bridge connection failed'));
  socket.on('close', () => { closed = true; failAll('the editor bridge closed the connection'); });

  /** @param {string} line */
  function handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { shut('the editor bridge sent malformed data'); return; }
    if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    clock.clearTimeout(p.timer);
    if (message.error && typeof message.error === 'object') p.reject(new Error(String(message.error.message || 'the editor bridge refused the request')));
    else p.resolve(message.result);
  }

  /** @param {'context'|'submit'} method @param {unknown} params @returns {Promise<unknown>} */
  function request(method, params) {
    if (closed) return Promise.reject(new Error('the editor bridge is closed'));
    const id = nextId++;
    const line = JSON.stringify({ id, token, method, params }) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return Promise.reject(new Error('the request is larger than the bridge accepts'));
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => { pending.delete(id); reject(new Error(`the editor bridge did not answer ${method} in time`)); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.write(line, (err) => {
        if (err && pending.delete(id)) { clock.clearTimeout(timer); reject(new Error('the editor bridge connection failed')); }
      });
    });
  }

  return {
    async context() {
      const out = /** @type {any} */ (await request('context', {}));
      if (out === null) return null;
      // A boundary: the answer comes from another process.
      if (!out || typeof out !== 'object' || typeof out.repo !== 'string' || typeof out.mode !== 'string' || typeof out.head !== 'string'
        || !out.base || typeof out.base.ref !== 'string' || typeof out.base.sha !== 'string') {
        throw new Error('the editor bridge sent an unexpected context');
      }
      /** @type {BridgeContext} */
      const ctx = { repo: out.repo, mode: out.mode, base: { ref: out.base.ref, sha: out.base.sha }, head: out.head };
      if (out.pr && typeof out.pr.number === 'number') ctx.pr = { number: out.pr.number };
      return ctx;
    },
    async submit(kind, payload, meta) {
      const out = /** @type {any} */ (await request('submit', { kind, payload, meta }));
      if (!out || typeof out !== 'object' || typeof out.stored !== 'boolean') throw new Error('the editor bridge sent an unexpected answer');
      /** @type {SubmitOutcome} */
      const outcome = { stored: out.stored };
      if (typeof out.reason === 'string') outcome.reason = out.reason;
      if (Array.isArray(out.errors)) outcome.errors = out.errors.filter((/** @type {unknown} */ e) => typeof e === 'string').slice(0, 50);
      return outcome;
    },
    close() { shut('the editor bridge was closed'); },
    /** Whether this connection is gone (closed by either side or failed). */
    get closed() { return closed; },
  };
}

module.exports = { connectBridge, liveEditorRepos, lockPathFor };
