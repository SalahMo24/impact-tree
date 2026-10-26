// @ts-check
'use strict';
// The editor's side of the bridge to the user's own agent (impactTree.agents.enabled). The
// agent starts our MCP server as a separate process; this bridge tells that server which
// review the editor is showing and takes back the results the agent submits (cards with
// titles and summaries, callers it found), re-checking each against the editor's CURRENT
// analysis before storing it in workspace state. Local only: a Unix socket (a named pipe on
// Windows) in a private temp directory, guarded by a token in a 0600 lock file.
//
// Ownership: this object owns the listening server, its open connections, the lock file and
// the socket file. `stop()` (also `dispose()`) closes all of them and removes the files, the
// lock only while it still names this process. Nothing here runs unless `start()` is called.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const P = require('./mcp/bridge-protocol');
const { realClock } = require('./engine/clock');
// Built by the MCP server's branch (AI3a); required on first use, so the editor loads without it.
const AGENT_RESULTS = './engine/agent-results';

const STORAGE_KEY = 'impactTree.agentResults.v1';
const MAX_ENTRIES_PER_HEAD = 20;
const MAX_HEADS = 10;
const IDLE_TIMEOUT_MS = 60 * 1000;
const MAX_ID_LENGTH = 64;

/**
 * @typedef {{ kind: 'cards'|'callers', key: string, payload: unknown, storedAt: number }} StoredResult
 * @typedef {(kind: string, payload: unknown, given: { result: any, cards: any }) => { ok: boolean, errors?: string[], normalised?: unknown }} Validator
 */

/**
 * @param {any} vscode
 * @param {{ session: any, workspaceState: { get: (k: string) => any, update: (k: string, v: any) => PromiseLike<void> },
 *   log: (m: string) => void, lockDir?: string, validator?: Validator, readHead?: (repo: string) => Promise<string|null>,
 *   clock?: import('./engine/clock').Clock, idleTimeoutMs?: number }} deps
 *   `lockDir`, `validator`, `readHead`, `clock`, `idleTimeoutMs`: seams for tests. The validator defaults to
 *   src/engine/agent-results.js `validateSubmission`, required on first use. `readHead` reads the
 *   repository's HEAD commit, the head of a checkout review (default: `git rev-parse HEAD`).
 */
function createAgentBridge(vscode, { session, workspaceState, log, lockDir = P.defaultLockDir(), validator, readHead = defaultReadHead,
  clock = realClock, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
  const emitter = new vscode.EventEmitter();
  /** @type {{ server: net.Server, sockets: Set<net.Socket>, lockFile: string, socketPath: string, token: string, repo: string } | null} */
  let running = null;
  // Each start/stop moves this on, so a start that was overtaken by a stop cleans up after itself.
  let generation = 0;
  // Storage writes run one at a time: each reads the state the previous one wrote.
  let writes = Promise.resolve();

  // ---- storage ----

  /** @returns {Record<string, StoredResult[]>} The stored results, with every field of every entry checked. */
  function readAll() {
    const raw = workspaceState.get(STORAGE_KEY);
    /** @type {Record<string, StoredResult[]>} */
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [head, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const entries = list.filter((e) => e && typeof e === 'object' && P.KINDS.includes(e.kind) && typeof e.key === 'string'
        && typeof e.storedAt === 'number' && 'payload' in e);
      if (entries.length) out[head] = entries.slice(-MAX_ENTRIES_PER_HEAD);
    }
    return out;
  }

  /** @param {string} head @returns {StoredResult[]} */
  function resultsFor(head) {
    return typeof head === 'string' ? (readAll()[head] || []).map((e) => ({ ...e })) : [];
  }

  /**
   * @param {'cards'|'callers'} kind @param {string} head @param {unknown} payload
   * @returns {Promise<{ stored: boolean, key: string, duplicate: boolean }>}
   */
  function store(kind, head, payload) {
    const key = crypto.createHash('sha256').update(kind + P.canonicalJson(payload)).digest('hex');
    const job = writes.then(async () => {
      const all = readAll();
      const list = all[head] || [];
      if (list.some((e) => e.key === key)) return { stored: true, key, duplicate: true };
      list.push({ kind, key, payload, storedAt: clock.now() });
      all[head] = list.slice(-MAX_ENTRIES_PER_HEAD);
      const heads = Object.keys(all);
      if (heads.length > MAX_HEADS) {
        const newest = (/** @type {string} */ h) => Math.max(...all[h].map((e) => e.storedAt));
        heads.sort((a, b) => newest(a) - newest(b));
        for (const old of heads.slice(0, heads.length - MAX_HEADS)) delete all[old];
      }
      await workspaceState.update(STORAGE_KEY, all);
      return { stored: true, key, duplicate: false };
    });
    writes = job.then(() => undefined, () => undefined);
    return job;
  }

  // ---- what the editor is showing ----

  /** @returns {boolean} Whether the review shown is a pull request preview (no repository the server can analyse). */
  function isPreview() {
    const state = session.state || {};
    return !!(state.source && state.source.kind === 'pr') || !!(state.result && state.result.tierA);
  }

  /**
   * @returns {Promise<{ repo: string, mode: string, base: { ref: string, sha: string }, head: string, pr?: { number: number } } | null>}
   *   Null while there is no finished checkout or local review.
   */
  async function currentContext() {
    const state = session.state || {};
    const result = state.result;
    if (!result || isPreview()) return null;
    if (!result.base || typeof result.base.ref !== 'string' || typeof result.base.sha !== 'string' || typeof result.mode !== 'string') return null;
    const repo = running ? running.repo : P.realRepo(session.repoRoot());
    const head = await readHead(repo);
    if (!head) return null;
    /** @type {any} */
    const ctx = { repo, mode: result.mode, base: { ref: result.base.ref, sha: result.base.sha }, head };
    const src = state.source;
    if (src && src.kind === 'checkout' && src.pr && Number.isSafeInteger(src.pr.number)) ctx.pr = { number: src.pr.number };
    return ctx;
  }

  /**
   * @param {unknown} params A request's params, unchecked.
   * @returns {Promise<{ stored: boolean, reason?: string, errors?: string[] }>}
   */
  async function submit(params) {
    const p = /** @type {any} */ (params);
    if (!p || typeof p !== 'object' || !P.KINDS.includes(p.kind)) return { stored: false, reason: 'unknown kind of result' };
    if (!p.payload || typeof p.payload !== 'object') return { stored: false, reason: 'the payload must be an object' };
    const meta = p.meta;
    const metaBase = meta && typeof meta.base === 'object' && meta.base ? meta.base.sha : meta && meta.base;
    if (!meta || typeof meta.head !== 'string' || typeof metaBase !== 'string') return { stored: false, reason: 'meta needs the head and base the result was made on' };
    if (isPreview()) return { stored: false, reason: 'the editor is showing a pull request preview, which has no repository to analyse; check the pull request out first' };
    const current = await currentContext();
    if (!current) return { stored: false, reason: 'the editor has no finished review to attach a result to' };
    if (meta.head !== current.head || metaBase !== current.base.sha) {
      return { stored: false, reason: `the editor's review moved to ${current.head}; re-run on it` };
    }
    let size;
    try { size = Buffer.byteLength(JSON.stringify(p.payload)); } catch { return { stored: false, reason: 'the payload cannot be serialised' }; }
    if (size > P.MAX_PAYLOAD_BYTES) return { stored: false, reason: `the payload is ${size} bytes; the limit is ${P.MAX_PAYLOAD_BYTES}` };
    const validate = validator || require(AGENT_RESULTS).validateSubmission;
    const state = session.state || {};
    const verdict = validate(p.kind, p.payload, { result: state.result, cards: state.cards || null });
    if (!verdict || !verdict.ok) {
      const errors = verdict && Array.isArray(verdict.errors) ? verdict.errors.filter((/** @type {unknown} */ e) => typeof e === 'string').slice(0, 50) : ['the result was not accepted'];
      return { stored: false, reason: 'the result does not match the editor\'s review', errors };
    }
    // The review may have moved while the head was read or the result validated.
    const after = await currentContext();
    if (!after || after.head !== current.head || after.base.sha !== current.base.sha) {
      return { stored: false, reason: `the editor's review moved to ${after ? after.head : 'another review'}; re-run on it` };
    }
    const normalised = verdict.normalised !== undefined ? verdict.normalised : p.payload;
    const saved = await store(p.kind, current.head, normalised);
    if (!saved.duplicate) emitter.fire({ kind: p.kind, head: current.head, key: saved.key });
    return saved.duplicate ? { stored: true, reason: 'already stored' } : { stored: true };
  }

  // ---- the server ----

  /**
   * @param {net.Socket} socket @param {string} token
   */
  function serve(socket, token) {
    socket.setEncoding('utf8');
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    let buffer = '';
    let overrun = false;
    const reply = (/** @type {unknown} */ message, /** @type {boolean} */ thenClose = false) => {
      if (socket.destroyed) return;
      socket.write(JSON.stringify(message) + '\n', () => { if (thenClose) socket.destroy(); });
    };
    socket.on('error', () => socket.destroy());
    socket.on('data', (/** @type {string} */ chunk) => {
      if (overrun) return;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > P.MAX_LINE_BYTES) { overrun = true; reply({ id: null, error: { message: 'request too large' } }, true); return; }
        handle(line);
      }
      if (Buffer.byteLength(buffer) > P.MAX_LINE_BYTES) {
        overrun = true;
        buffer = '';
        reply({ id: null, error: { message: 'request too large' } }, true);
      }
    });

    /** @param {string} line */
    function handle(line) {
      let req;
      try { req = JSON.parse(line); } catch { reply({ id: null, error: { message: 'malformed request' } }, true); return; }
      const id = req && (typeof req.id === 'number' || (typeof req.id === 'string' && req.id.length <= MAX_ID_LENGTH)) ? req.id : null;
      if (id === null) { reply({ id: null, error: { message: 'malformed request' } }, true); return; }
      if (typeof req.token !== 'string' || !tokenMatches(req.token, token)) { reply({ id, error: { message: 'bad token' } }, true); return; }
      if (!P.METHODS.includes(req.method)) { reply({ id, error: { message: 'unknown method' } }); return; }
      const params = req.params && typeof req.params === 'object' ? req.params : {};
      const work = req.method === 'context' ? currentContext() : submit(params);
      work.then((result) => reply({ id, result }), (e) => {
        log(`agent bridge: ${req.method} failed: ${e && e.message}`);
        reply({ id, error: { message: 'the editor could not answer' } });
      });
    }
  }

  /** @returns {Promise<void>} */
  async function start() {
    if (running) return;
    const mine = ++generation;
    let repo;
    try { repo = P.realRepo(session.repoRoot()); } catch (e) { log(`agent bridge: not started, ${/** @type {any} */ (e).message}`); return; }
    /** @type {net.Server|null} */
    let server = null;
    let socketPath = '';
    try {
      ensureDir(lockDir);
      const hash = P.repoHash(repo);
      const lockFile = P.lockPathFor(lockDir, repo);
      const old = P.readLock(lockDir, repo);
      if (old && old.pid !== process.pid && P.pidAlive(old.pid)) log(`agent bridge: replacing the bridge of process ${old.pid} for this repository`);
      if (old && path.dirname(old.socket) === lockDir && !P.pidAlive(old.pid)) fs.rmSync(old.socket, { force: true });
      const token = crypto.randomBytes(32).toString('hex');
      const tag = crypto.randomBytes(4).toString('hex');
      socketPath = process.platform === 'win32'
        ? `\\\\.\\pipe\\impact-tree-${hash}-${tag}`
        : path.join(lockDir, `${hash.slice(0, 8)}-${tag}.sock`);
      const listening = net.createServer();
      server = listening;
      listening.maxConnections = P.MAX_CONNECTIONS;
      /** @type {Set<net.Socket>} */
      const sockets = new Set();
      listening.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        serve(socket, token);
      });
      listening.on('error', (e) => log(`agent bridge: server error: ${e && e.message}`));
      await new Promise((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(socketPath, () => { listening.removeListener('error', reject); resolve(undefined); });
      });
      if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
      if (mine !== generation) { listening.close(); fs.rmSync(socketPath, { force: true }); return; }
      writeLockAtomically(lockFile, { version: 1, pid: process.pid, repo, socket: socketPath, token, startedAt: clock.now() });
      running = { server: listening, sockets, lockFile, socketPath, token, repo };
      log('agent bridge: listening for the user\'s agent (local only)');
    } catch (e) {
      log(`agent bridge: could not start: ${e && /** @type {any} */ (e).message}`);
      if (!running) {
        if (server) server.close();
        if (socketPath && process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
      }
    }
  }

  /** @returns {Promise<void>} */
  async function stop() {
    generation++;
    const r = running;
    running = null;
    if (!r) return;
    for (const s of r.sockets) s.destroy();
    await new Promise((resolve) => r.server.close(() => resolve(undefined)));
    try { fs.rmSync(r.socketPath, { force: true }); } catch { /* already gone */ }
    try {
      const lock = P.readLock(path.dirname(r.lockFile), r.repo);
      if (lock && lock.pid === process.pid && lock.token === r.token) fs.rmSync(r.lockFile, { force: true });
    } catch { /* already gone */ }
    log('agent bridge: stopped');
  }

  return {
    start, stop,
    dispose() { emitter.dispose(); stop().catch((e) => log(`agent bridge: stop failed: ${e && e.message}`)); },
    onDidStoreResult: emitter.event,
    resultsFor,
    /** For tests: the socket and lock this bridge listens on, or null. */
    get address() { return running ? { socket: running.socketPath, lockFile: running.lockFile } : null; },
  };
}

/** @param {string} a @param {string} b @returns {boolean} Constant-time equality of two hex tokens. */
function tokenMatches(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Creates `dir` (0700) or checks that an existing one is a real directory of this user, tightening its mode. @param {string} dir */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Writes `lock` as JSON with mode 0600: to a temp file, then renamed over `file`. @param {string} file @param {object} lock */
function writeLockAtomically(file, lock) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** @param {string} repo @returns {Promise<string|null>} The repository's HEAD commit, or null when git cannot say. */
async function defaultReadHead(repo) {
  try {
    const out = await require('./engine/git').makeGit(repo).rawAsync(['rev-parse', 'HEAD'], { timeoutMs: 10000 });
    const sha = out.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

module.exports = { createAgentBridge, STORAGE_KEY, MAX_ENTRIES_PER_HEAD, MAX_HEADS };
