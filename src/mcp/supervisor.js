// @ts-check
'use strict';

// Keeps one MCP connection alive across new code. The agent starts the stable launcher
// (src/agent-connect.js), which runs this supervisor; it starts the real server
// (`src/cli.js mcp`) as a child and relays newline-delimited JSON-RPC both ways.
//
// When the extension's code changes, the child exits with RELOAD_EXIT_CODE instead of
// answering (src/mcp/server.js). The supervisor then starts a new child on the new code,
// replays the agent's `initialize` (its answer is dropped: the agent already has one) and
// `notifications/initialized`, resends every request still waiting for an answer, and tells
// the agent the tool list may have changed. The agent sees a slower answer, not an error,
// and nobody has to restart the server.
//
// A child that exits for any other reason: every waiting request gets an error, and the
// next request from the agent starts a new child. Messages the old child sent the agent
// (its own requests, such as roots/list) are not answered to the new one.
//
// Bounds: a request is resent at most MAX_RESENDS times (a child that keeps exiting on it
// gets an error back); a line over MAX_LINE_BYTES from the child or the agent is dropped.

const { spawn } = require('child_process');
const path = require('path');

/** Exit code a supervised server uses to ask for a restart on new code (EX_TEMPFAIL). */
const RELOAD_EXIT_CODE = 75;
/** Environment variable that tells the server it is supervised. */
const SUPERVISED_ENV = 'IMPACT_TREE_MCP_SUPERVISED';
const MAX_RESENDS = 3;
/** Unit: bytes. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * @param {{ cliPath: string, args: string[], input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
 *   log?: (m: string) => void, spawnChild?: (cliPath: string, args: string[]) => import('child_process').ChildProcess }} o
 *   `cliPath`: the extension's src/cli.js. `spawnChild` is injectable for tests.
 * @returns {{ done: Promise<number> }} resolves with the exit code to use when the agent closes its side.
 */
function supervise({ cliPath, args, input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`[impact-tree supervisor] ${m}\n`), spawnChild = defaultSpawn }) {
  /** @type {import('child_process').ChildProcess|null} */
  let child = null;
  let generation = 0;
  /** The agent's initialize request and initialized notification, replayed to each new child. */
  /** @type {any} */ let initRequest = null;
  /** @type {any} */ let initNotice = null;
  /** Agent requests waiting for an answer, by id. @type {Map<string, { msg: any, resends: number }>} */
  const waiting = new Map();
  /** Ids of replayed initialize requests whose answer is dropped. @type {Set<string>} */
  const swallow = new Set();
  /** Requests the current child sent the agent, by id (answers to other ids are dropped). @type {Set<string>} */
  let childAsked = new Set();
  let agentClosed = false;
  /** @type {(code: number) => void} */
  let finish = () => {};
  const done = new Promise((resolve) => { finish = resolve; });

  const key = (/** @type {unknown} */ id) => JSON.stringify(id);
  const toAgent = (/** @type {any} */ msg) => { output.write(`${JSON.stringify(msg)}\n`); };
  const toChild = (/** @type {any} */ msg) => { if (child && child.stdin && child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`); };

  function start() {
    const gen = ++generation;
    const c = spawnChild(cliPath, args);
    child = c;
    childAsked = new Set();
    lines(/** @type {NodeJS.ReadableStream} */ (c.stdout), (line) => {
      if (gen !== generation) return;
      let msg;
      try { msg = JSON.parse(line); } catch { log('dropped a line from the server that is not JSON'); return; }
      const isAnswer = msg && msg.id !== undefined && msg.method === undefined;
      if (isAnswer) {
        const k = key(msg.id);
        if (swallow.delete(k)) return;           // the answer to a replayed initialize
        waiting.delete(k);
      } else if (msg && msg.method !== undefined && msg.id !== undefined) {
        childAsked.add(key(msg.id));
      }
      toAgent(msg);
    });
    c.on('exit', (code, signal) => {
      if (gen !== generation) return;
      child = null;
      if (agentClosed) { finish(code === RELOAD_EXIT_CODE ? 0 : code ?? 0); return; }
      if (code === RELOAD_EXIT_CODE) {
        log('the extension\'s code changed: restarting the server on the new code');
        restart();
        return;
      }
      log(`the server stopped (${signal || `exit ${code}`}); the next request starts it again`);
      for (const [k, w] of waiting) {
        toAgent({ jsonrpc: '2.0', id: w.msg.id, error: { code: -32603, message: `Impact Tree's server stopped (${signal || `exit ${code}`}) before answering. Try the call again.` } });
        waiting.delete(k);
      }
    });
    c.on('error', (e) => log(`could not start the server: ${e.message}`));
  }

  /** A new child on the new code, with the session replayed and waiting requests resent. */
  function restart() {
    start();
    if (initRequest) { swallow.add(key(initRequest.id)); toChild(initRequest); }
    if (initNotice) toChild(initNotice);
    for (const [k, w] of [...waiting]) {
      if (w.resends >= MAX_RESENDS) {
        waiting.delete(k);
        toAgent({ jsonrpc: '2.0', id: w.msg.id, error: { code: -32603, message: 'Impact Tree\'s server restarted several times on this call. Try it again.' } });
        continue;
      }
      w.resends++;
      toChild(w.msg);
    }
    if (initRequest) toAgent({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  lines(input, (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { if (child && child.stdin && child.stdin.writable) child.stdin.write(`${line}\n`); return; }   // the server answers the parse error
    if (msg && msg.method === 'initialize' && msg.id !== undefined) initRequest = msg;
    else if (msg && msg.method === 'notifications/initialized') initNotice = msg;
    if (msg && msg.method === undefined && msg.id !== undefined) {
      // An answer to a request a server sent: only the current child's.
      if (!childAsked.delete(key(msg.id))) return;
    } else if (msg && msg.method !== undefined && msg.id !== undefined) {
      waiting.set(key(msg.id), { msg, resends: 0 });
    }
    if (!child) {
      // Stopped earlier: start again, with the session replayed (this message included if it is the initialize).
      start();
      if (initRequest && initRequest !== msg) { swallow.add(key(initRequest.id)); toChild(initRequest); if (initNotice && initNotice !== msg) toChild(initNotice); }
    }
    toChild(msg);
  }, () => {
    agentClosed = true;
    if (child && child.stdin) child.stdin.end(); else finish(0);
  });

  start();
  return { done };
}

/** @param {string} cliPath @param {string[]} args */
function defaultSpawn(cliPath, args) {
  return spawn(process.execPath, [cliPath, 'mcp', ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, [SUPERVISED_ENV]: '1' },
    cwd: process.cwd(),
  });
}

/**
 * Calls `onLine` for each complete line of `stream`, and `onEnd` when it ends.
 * @param {NodeJS.ReadableStream} stream @param {(line: string) => void} onLine @param {() => void} [onEnd]
 */
function lines(stream, onLine, onEnd) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
    if (buf.length > MAX_LINE_BYTES) buf = '';
  });
  if (onEnd) stream.on('end', onEnd);
}

/** The launcher's entry: `node launcher.cjs [server args]`. @param {string} extensionPath */
function runSupervised(extensionPath) {
  const { done } = supervise({ cliPath: path.join(extensionPath, 'src', 'cli.js'), args: process.argv.slice(2) });
  done.then((code) => process.exit(code));
}

module.exports = { supervise, runSupervised, RELOAD_EXIT_CODE, SUPERVISED_ENV };
