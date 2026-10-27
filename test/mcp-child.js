// @ts-check
'use strict';
// Helper for tests: `node src/cli.js mcp` as a child process and a newline-JSON-RPC client
// for it, as an agent would run it.
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
/** Longest wait for one answer from the child. Unit: ms. Exhaustion: the request rejects. */
const ANSWER_TIMEOUT_MS = 5000;
/** Children still running; killed when the test process exits so a failed test cannot leave one behind. */
const live = new Set();
process.on('exit', () => { for (const c of live) c.kill('SIGKILL'); });
let afterRegistered = false;

/**
 * @param {string[]} args arguments after `mcp`
 * @param {{ cwd?: string }} [opts]
 */
function spawnMcp(args, opts = {}) {
  const child = spawn(process.execPath, [CLI, 'mcp', ...args], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(child);
  if (!afterRegistered) {
    afterRegistered = true;
    // A test that fails before end() must not leave a child that keeps the file alive.
    require('node:test').after(() => { for (const c of live) c.kill('SIGKILL'); });
  }
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  /** @type {Map<number, (m: any) => void>} */
  const waiting = new Map();
  let buf = '';
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      // The protocol is JSON lines; anything else (help text) is only kept in `stdout()`.
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { live.delete(child); resolve({ code, signal }); }));
  let next = 1;
  /** @param {string} method @param {any} [params] @returns {Promise<any>} */
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no answer to ${method} within ${ANSWER_TIMEOUT_MS} ms`));
    }, ANSWER_TIMEOUT_MS);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    child, request, exited, stderr: () => stderr, stdout: () => stdout,
    /** @param {string} name @param {any} args */
    call: async (name, args) => (await request('tools/call', { name, arguments: args })).result,
    handshake: async () => {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return init;
    },
    /** Close the agent's side and wait for the exit. */
    end: () => { child.stdin.end(); return exited; },
  };
}

module.exports = { spawnMcp, CLI };
