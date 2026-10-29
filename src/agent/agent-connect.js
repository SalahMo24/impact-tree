// @ts-check
'use strict';
// Connecting the user's own agents to Impact Tree's MCP server (docs/AI_PLAN.md AI4). The
// server (`node src/cli.js mcp`) is started by the agent as its own process, so each agent
// is told how to start it. This file holds the decisions as pure functions (the commands,
// the link, the launcher text, the node choice) and the few effects they need, with the
// effects injected: `run` (a process runner that never rejects), `fs`, and the editor facts.
// The editor side (quick pick, modals, messages) is src/agent/agent-connect-commands.js.
//
// A connection applies to every repository (Claude Code `--scope user`; Codex and Cursor
// are global); the server works in whichever repository the agent runs in.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { onPath, isExecutable } = require('./agent-handoff');
const { shellQuote } = require('../feedback/feedback-file');

const SERVER_NAME = 'impact-tree';
const MIN_NODE_MAJOR = 20;
/** Wait for one probe (`--version`, `auth status`, ...). Unit: ms. Exhaustion: the answer is "unknown". */
const PROBE_TIMEOUT_MS = 3000;
/** Wait for a command the user agreed to run (`claude mcp add`). Unit: ms. */
const ACTION_TIMEOUT_MS = 30000;
/** Largest ~/.cursor/mcp.json read. Unit: bytes. */
const MAX_CURSOR_CONFIG_BYTES = 1 << 20;

/** @typedef {'claude'|'codex'|'cursor'|'vscode'} ConnectAgentId */
/** @typedef {{ command: string, env: Record<string, string>, kind: 'path'|'editor' }} Runtime */
/**
 * @typedef {{ code: number|null, stdout: string, stderr: string, timedOut: boolean, notFound: boolean }} RunResult
 *   `code` null: the process did not exit normally (timeout, not found).
 * @typedef {(file: string, args: string[], o?: { timeoutMs?: number, env?: Record<string,string> }) => Promise<RunResult>} Run
 */

// ---------------------------------------------------------------------------------------
// Process runner (the one effect everything else injects)

/** @type {Run} */
function runProcess(file, args, { timeoutMs = PROBE_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true, env: env ? { ...process.env, ...env } : undefined }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false, notFound: false });
        const e = /** @type {any} */ (err);
        resolve({
          code: typeof e.code === 'number' ? e.code : null, stdout: String(stdout || ''), stderr: String(stderr || ''),
          timedOut: e.killed === true, notFound: e.code === 'ENOENT',
        });
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(/** @type {Error} */ (e).message), timedOut: false, notFound: true });
    }
  });
}

// ---------------------------------------------------------------------------------------
// Node runtime

/**
 * The first executable `exe` on PATH, as an absolute path, or null. Bounded like `onPath`.
 * @param {string} exe @param {{ pathEnv: string|undefined, platform: string, exists?: (abs: string) => boolean }} env
 * @returns {string|null}
 */
function findOnPath(exe, env) {
  /** @type {string|null} */
  let found = null;
  const real = env.exists;
  onPath(exe, { ...env, exists: (abs) => {
    if (found) return false;
    const ok = real ? real(abs) : isExecutable(abs);
    if (ok) found = abs;
    return ok;
  } });
  return found;
}

/** @param {string} text `node --version` output, like "v22.16.0" @returns {number|null} the major version */
function nodeMajor(text) {
  const m = /^v?(\d+)\.\d+/.exec(String(text).trim());
  return m ? Number(m[1]) : null;
}

/**
 * Pure choice: a node from PATH when it is new enough, else the editor's own runtime when
 * that is, else nothing.
 * @param {{ pathNode: { path: string, major: number|null }|null, editor: { execPath: string, version: string } }} o
 * @returns {Runtime|null}
 */
function chooseRuntime({ pathNode, editor }) {
  if (pathNode && pathNode.major !== null && pathNode.major >= MIN_NODE_MAJOR) return { command: pathNode.path, env: {}, kind: 'path' };
  if (nodeMajor(editor.version) !== null && /** @type {number} */ (nodeMajor(editor.version)) >= MIN_NODE_MAJOR) {
    return { command: editor.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'editor' };
  }
  return null;
}

/**
 * Probe PATH for node (`--version`, 3 s) and choose.
 * @param {{ run: Run, pathEnv: string|undefined, platform: string, editor: { execPath: string, version: string }, exists?: (abs: string) => boolean }} o
 * @returns {Promise<Runtime|null>}
 */
async function probeRuntime({ run, pathEnv, platform, editor, exists }) {
  const abs = findOnPath('node', { pathEnv, platform, exists });
  /** @type {{ path: string, major: number|null }|null} */
  let pathNode = null;
  if (abs) {
    const r = await run(abs, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
    pathNode = { path: abs, major: r.code === 0 ? nodeMajor(r.stdout) : null };
  }
  return chooseRuntime({ pathNode, editor });
}

const NO_RUNTIME_MESSAGE = "Impact Tree's agent tools need Node 20 or later: install it and try again.";

// ---------------------------------------------------------------------------------------
// The launcher

/**
 * Text of the stable launcher: a CommonJS script that starts the MCP server of the extension
 * at `extensionPath`. The extension's folder changes on every update, so agents are
 * registered against this file, which each activation rewrites.
 * @param {string} extensionPath absolute
 * @returns {string}
 */
function launcherSource(extensionPath) {
  const supervisor = path.join(extensionPath, 'src', 'mcp', 'supervisor.js');
  // The supervisor runs the server as a child and restarts it when the extension's code
  // changes, so an update (or an edited development folder) needs no restart by hand.
  return `'use strict';
// Written by the Impact Tree extension; rewritten when it activates. Do not edit.
const fs = require('fs');
const extension = ${JSON.stringify(extensionPath)};
const supervisor = ${JSON.stringify(supervisor)};
if (!fs.existsSync(supervisor)) {
  process.stderr.write('Impact Tree: its extension folder is gone (' + extension + '). Reload the editor with Impact Tree installed, or run "Impact Tree: Connect my agent" again.\\n');
  process.exit(1);
}
require(supervisor).runSupervised(extension);
`;
}

/**
 * Write the launcher under `storageDir/mcp/` when its content differs: temp file, then rename.
 * @param {{ storageDir: string, extensionPath: string, fsApi?: Pick<typeof fs, 'mkdirSync'|'readFileSync'|'writeFileSync'|'renameSync'|'rmSync'> }} o
 * @returns {{ launcher: string, written: boolean }}
 * @throws {Error} when the folder or file cannot be written
 */
function ensureLauncher({ storageDir, extensionPath, fsApi = fs }) {
  const dir = path.join(storageDir, 'mcp');
  const launcher = path.join(dir, 'impact-tree-mcp.cjs');
  const text = launcherSource(extensionPath);
  fsApi.mkdirSync(dir, { recursive: true });
  try { if (fsApi.readFileSync(launcher, 'utf8') === text) return { launcher, written: false }; } catch { /* absent: write it */ }
  const tmp = `${launcher}.${process.pid}.tmp`;
  try {
    fsApi.writeFileSync(tmp, text, { mode: 0o644 });
    fsApi.renameSync(tmp, launcher);
  } catch (e) {
    try { fsApi.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return { launcher, written: true };
}

// ---------------------------------------------------------------------------------------
// What connecting does, as data

/** @param {Record<string,string>} env @returns {string[]} KEY=value, sorted */
const envPairs = (env) => Object.keys(env).sort().map((k) => `${k}=${env[k]}`);

/**
 * `claude mcp add` arguments (the file is `claude`).
 * @param {{ runtime: Runtime, launcher: string, scope?: 'user'|'local' }} o
 * @returns {string[]}
 */
function claudeAddArgs({ runtime, launcher, scope = 'user' }) {
  const env = envPairs(runtime.env).flatMap((p) => ['-e', p]);
  return ['mcp', 'add', '--scope', scope, SERVER_NAME, ...env, '--', runtime.command, launcher];
}
/** @param {'user'|'local'} [scope] @returns {string[]} */
const claudeRemoveArgs = (scope = 'user') => ['mcp', 'remove', '--scope', scope, SERVER_NAME];

/**
 * `codex mcp add` arguments (the file is `codex`).
 * @param {{ runtime: Runtime, launcher: string }} o
 * @returns {string[]}
 */
function codexAddArgs({ runtime, launcher }) {
  const env = envPairs(runtime.env).flatMap((p) => ['--env', p]);
  return ['mcp', 'add', SERVER_NAME, ...env, '--', runtime.command, launcher];
}
const codexRemoveArgs = () => ['mcp', 'remove', SERVER_NAME];

/**
 * Cursor's install link (https://cursor.com/docs/mcp/install-links): `config` is the base64 of
 * the JSON of the server entry (command, args, env), not wrapped in its name. The base64 is
 * percent-encoded so `+`, `/` and `=` survive the query string.
 * @param {{ runtime: Runtime, launcher: string }} o
 * @returns {string}
 */
function cursorDeeplink({ runtime, launcher }) {
  const config = { command: runtime.command, args: [launcher], ...(Object.keys(runtime.env).length ? { env: runtime.env } : {}) };
  const b64 = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(b64)}`;
}

/** The inverse of `cursorDeeplink`, for tests. @param {string} link @returns {{ name: string, config: any }} */
function decodeCursorDeeplink(link) {
  const u = new URL(link);
  return { name: String(u.searchParams.get('name')), config: JSON.parse(Buffer.from(String(u.searchParams.get('config')), 'base64').toString('utf8')) };
}

/**
 * The server definition for VS Code's provider API: what `McpStdioServerDefinition` takes.
 * @param {{ runtime: Runtime, launcher: string }} o
 * @returns {{ label: string, command: string, args: string[], env: Record<string,string> }}
 */
function providerDefinition({ runtime, launcher }) {
  return { label: 'Impact Tree', command: runtime.command, args: [launcher], env: runtime.env };
}

/** A command line for a person to read (not to run through a shell). @param {string} file @param {string[]} args */
const displayCommand = (file, args) => [file, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a))).join(' ');

// ---------------------------------------------------------------------------------------
// Detection

/**
 * @typedef {object} AgentStatus
 * @property {boolean|'unknown'} installed
 * @property {boolean|'unknown'|null} signedIn null: not applicable
 * @property {boolean|'unknown'} connected
 */

const ids = /** @type {ConnectAgentId[]} */ (['claude', 'codex', 'cursor', 'vscode']);
const CLI_NAMES = /** @type {Record<ConnectAgentId, string>} */ ({ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', vscode: 'VS Code / Copilot' });

/** @param {RunResult} r @returns {boolean|'unknown'} exit 0 yes, other exit no, no exit unknown */
const byExit = (r) => (r.timedOut || r.notFound || r.code === null ? 'unknown' : r.code === 0);

/**
 * Is Impact Tree registered with Codex? `mcp get`, or `mcp list` when this Codex has no `get`.
 * @param {Run} run @returns {Promise<boolean|'unknown'>}
 */
async function codexConnected(run) {
  const got = await run('codex', ['mcp', 'get', SERVER_NAME], { timeoutMs: PROBE_TIMEOUT_MS });
  if (got.timedOut || got.notFound) return 'unknown';
  if (got.code === 0) return true;
  const noGet = /unrecognized subcommand|unknown (sub)?command|unexpected argument|invalid subcommand/i.test(got.stderr + got.stdout);
  if (!noGet) return false;
  const list = await run('codex', ['mcp', 'list'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (list.code !== 0) return 'unknown';
  return new RegExp(`(^|\\s)${SERVER_NAME}(\\s|$)`, 'm').test(list.stdout);
}

/**
 * Is `impact-tree` in Cursor's global MCP file? Invalid JSON or an unexpected shape: unknown.
 * @param {{ home: string, readFile: (p: string) => string|null }} o @returns {boolean|'unknown'}
 */
function cursorConnected({ home, readFile }) {
  let text;
  try { text = readFile(path.join(home, '.cursor', 'mcp.json')); } catch { return 'unknown'; }
  if (text === null) return false;
  if (text.length > MAX_CURSOR_CONFIG_BYTES) return 'unknown';
  let json;
  try { json = JSON.parse(text); } catch { return 'unknown'; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'unknown';
  const servers = json.mcpServers;
  if (servers === undefined) return false;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'unknown';
  return Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
}

/**
 * What each agent has: installed, signed in, connected. Probes run in parallel, each with a
 * timeout; a probe that fails answers "unknown". Never throws.
 * @param {{ run: Run, onPathExe: (exe: string) => boolean, appName: string, hasProviderApi: boolean, home: string,
 *   readFile: (p: string) => string|null, appInstalled: (p: string) => boolean }} o
 * @returns {Promise<Record<ConnectAgentId, AgentStatus>>}
 */
async function detectAgents(o) {
  const safe = async (/** @type {() => any} */ f) => { try { return await f(); } catch { return 'unknown'; } };
  const inCursor = /cursor/i.test(o.appName);
  const claudeIn = o.onPathExe('claude');
  const codexIn = o.onPathExe('codex');
  const [claudeAuth, claudeConn, codexAuth, codexConn] = await Promise.all([
    claudeIn ? safe(async () => byExit(await o.run('claude', ['auth', 'status'], { timeoutMs: PROBE_TIMEOUT_MS }))) : null,
    claudeIn ? safe(async () => byExit(await o.run('claude', ['mcp', 'get', SERVER_NAME], { timeoutMs: PROBE_TIMEOUT_MS }))) : false,
    codexIn ? safe(async () => byExit(await o.run('codex', ['login', 'status'], { timeoutMs: PROBE_TIMEOUT_MS }))) : null,
    codexIn ? safe(() => codexConnected(o.run)) : false,
  ]);
  const cursorInstalled = inCursor || o.appInstalled('/Applications/Cursor.app') || o.onPathExe('cursor');
  return {
    claude: { installed: claudeIn, signedIn: claudeIn ? claudeAuth : null, connected: claudeConn },
    codex: { installed: codexIn, signedIn: codexIn ? codexAuth : null, connected: codexConn },
    cursor: { installed: cursorInstalled, signedIn: null, connected: cursorInstalled ? await safe(() => cursorConnected(o)) : false },
    vscode: { installed: o.hasProviderApi && !inCursor, signedIn: null, connected: 'unknown' },
  };
}

/** One line for the picker. @param {AgentStatus} s @returns {string} */
function statusText(s) {
  if (s.installed === false) return 'not found';
  const parts = [s.installed === 'unknown' ? 'installed: unknown' : 'installed'];
  if (s.signedIn === true) parts.push('signed in');
  else if (s.signedIn === false) parts.push('not signed in');
  else if (s.signedIn === 'unknown') parts.push('sign-in unknown');
  if (s.connected === true) parts.push('connected');
  else if (s.connected === 'unknown') parts.push('connection unknown');
  else parts.push('not connected');
  return parts.join(' · ');
}

/** First line of a command's stderr, for an error message. @param {RunResult} r @returns {string} */
function firstErrorLine(r) {
  if (r.timedOut) return 'it did not finish in time';
  if (r.notFound) return 'the program was not found';
  const line = String(r.stderr || r.stdout).split('\n').map((l) => l.trim()).find(Boolean);
  return (line || `it exited with code ${r.code}`).slice(0, 300);
}

module.exports = {
  SERVER_NAME, MIN_NODE_MAJOR, PROBE_TIMEOUT_MS, ACTION_TIMEOUT_MS, CLI_NAMES, NO_RUNTIME_MESSAGE, ids,
  runProcess, findOnPath, nodeMajor, chooseRuntime, probeRuntime, launcherSource, ensureLauncher,
  claudeAddArgs, claudeRemoveArgs, codexAddArgs, codexRemoveArgs, cursorDeeplink, decodeCursorDeeplink, providerDefinition,
  displayCommand, detectAgents, cursorConnected, statusText, firstErrorLine,
};
