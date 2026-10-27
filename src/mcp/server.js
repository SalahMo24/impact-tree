// @ts-check
'use strict';

// The Impact Tree MCP server: `node src/cli.js mcp --repo <path> [--base <ref>]`. It serves
// Impact Tree's facts about the checked-out pull request to an agent (Claude Code, Codex,
// Cursor, ...) over stdio, with the official MCP SDK (@modelcontextprotocol/server).
//
// It runs its own analysis of the checkout: mode `pr`, impact paths on, the caller resolvers
// kept alive for later queries, then the cards. The analysis starts on the first tool call,
// so `initialize` and `tools/list` answer at once; the result is kept for the process. An
// analysis that fails fails every tool call, with its message.
//
// Process: it runs as its own process, started by the agent, never inside the editor's
// extension host (it blocks its event loop for seconds while it parses and type-checks).
// Needs Node 20 or later (the SDK's requirement). Logs go to stderr only: stdout is the
// protocol.
//
// Editor bridge (src/mcp/bridge-client.js): when an editor with Impact Tree is running on the
// same repository, the server asks it for the PR's base and forwards submit_cards and
// submit_callers to it. Without one, or when it fails, the server works headless; a bridge
// failure is never fatal.

const path = require('path');
const { execFileSync } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/server');
const { serveStdio, StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { realClock } = require('../engine/clock');
const { createImpactTools } = require('./tools');
const { ToolError } = require('./paging');

const SERVER_INFO = { name: 'impact-tree', title: 'Impact Tree', version: '0.1.0' };
const INSTRUCTIONS = 'Facts about the checked-out pull request from Impact Tree: cluster cards of its changes, callers, references and impact paths to entry points. '
  + 'Answers carry complete/reasons; treat incomplete lists as lower bounds. '
  + 'submit_cards and submit_callers save your answer in the editor when one is connected; they check it first and return what to fix.';
const MIN_NODE_MAJOR = 20;

// Default deadline for all impact paths at start. Unit: ms. Chosen so start stays under
// 20 s on the corpus PRs (the walk is the part that can grow). Range: 1..600000.
const DEFAULT_DEADLINE_MS = 8000;
const MAX_DEADLINE_MS = 600000;
// Wait for the editor bridge to answer a connection attempt. Unit: ms.
const BRIDGE_CONNECT_MS = 3000;
// Wait for the editor to answer one submission. Unit: ms. The editor's work may continue
// after the wait ends; the agent is told the submission was checked but not confirmed saved.
const SUBMIT_DEADLINE_MS = 10000;
// Wait for a running analysis to stop on shutdown. Unit: ms.
const SHUTDOWN_WAIT_MS = 10000;

const log = (/** @type {string} */ msg) => { process.stderr.write(`[impact-tree mcp] ${msg}\n`); };

const HELP = `impact-tree mcp — serve Impact Tree's facts about a pull request to an AI agent over stdio (MCP)

Usage: node src/cli.js mcp --repo <path> [--base <ref>] [options]

  --repo <path>        repository checkout to analyse (default: the git repository the cwd is in); the PR is its HEAD
  --base <ref>         base branch (default: the open editor's base, else the remote's default branch)
  --remote <name>      git remote the base lives on (default: origin)
  --allow-local-base   permit a local base ref when <remote>/<ref> is missing (unsafe)
  --deadline-ms <n>    deadline for all impact paths at start, 1..${MAX_DEADLINE_MS} (default ${DEFAULT_DEADLINE_MS})

The server is started by the agent as its own process; it needs Node ${MIN_NODE_MAJOR} or later and must not run inside
an editor's extension host. It analyses on the first tool call. Tools: list_cards, get_card, get_change,
callers_of, find_references, impact_paths, validate_cards, check_evidence, get_source, list_files,
search_code (read-only) and submit_cards, submit_callers (checked, then saved in the editor if one is connected).`;

// ---------------------------------------------------------------------------------------
// Arguments

/**
 * @typedef {object} ServerOptions
 * @property {string} repo Absolute repository root; with `notRepo`, the folder the server was started in.
 * @property {true} [notRepo] No `--repo` was given and the start folder is in no git repository: the server starts and every tool returns an error.
 * @property {string} [base] Base ref; absent: the editor's, else the engine's default.
 * @property {string} remote
 * @property {boolean} allowLocalBase
 * @property {number} deadlineMs
 */

/**
 * The top of the repository `cwd` is in, or null when it is in none. Waits at most 5 s.
 * @param {string} cwd
 * @returns {string|null}
 */
function repoToplevel(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? path.resolve(out) : null;
  } catch { return null; }
}

/** What every tool answers when the server was started outside a repository. @param {string} cwd */
const notRepoMessage = (cwd) => `start your agent inside a git repository (this folder is not one): ${cwd}`;

/**
 * @param {string[]} argv the arguments after `mcp`
 * @param {{ cwd?: string, toplevel?: (cwd: string) => string|null }} [env] replaceable in tests
 * @returns {ServerOptions}
 * @throws {Error} on a value that is not valid, with a message for the person who typed it
 */
function parseArgs(argv, { cwd = process.cwd(), toplevel = repoToplevel } = {}) {
  /** @param {string} name */
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
    return v;
  };
  const deadline = get('deadline-ms');
  const deadlineMs = deadline === undefined ? DEFAULT_DEADLINE_MS : Number(deadline);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) throw new Error(`--deadline-ms must be an integer from 1 to ${MAX_DEADLINE_MS}`);
  const base = get('base');
  const explicit = get('repo');
  const top = explicit ? null : toplevel(cwd);
  return {
    repo: path.resolve(explicit || top || cwd), ...(!explicit && !top ? { notRepo: /** @type {const} */ (true) } : {}), ...(base ? { base } : {}),
    remote: get('remote') || 'origin', allowLocalBase: argv.includes('--allow-local-base'), deadlineMs,
  };
}

/**
 * @param {string} version `process.versions.node`
 * @throws {Error} below the SDK's minimum
 */
function assertNodeVersion(version) {
  if (Number(version.split('.')[0]) < MIN_NODE_MAJOR) {
    throw new Error(`the MCP server needs Node ${MIN_NODE_MAJOR} or later (this is Node ${version}); start it with a newer node, as its own process, not inside the editor's extension host`);
  }
}

// ---------------------------------------------------------------------------------------
// Analysis

/**
 * @typedef {object} Prepared
 * @property {Omit<Parameters<typeof createImpactTools>[0], 'forward' | 'signal'>} ctx What `createImpactTools` needs.
 * @property {string} headSha @property {string} baseSha
 * @property {() => void} dispose Releases the kept resolvers; idempotent.
 */

/**
 * Analyse the checkout's PR and gather what the tools read. The caller owns `dispose`.
 * @param {ServerOptions} opts @param {{ base?: string, signal?: AbortSignal }} extra
 * @returns {Promise<Prepared>}
 * @throws {Error} the engine's, such as a missing base or a dirty tree; `AnalysisCancelledError` after `signal` aborts
 */
async function prepare(opts, { base, signal }) {
  const { analyze } = require('../engine/analyze');
  const { buildCards } = require('../engine/cards');
  const { gatherEntryFacts } = require('../engine/entry-facts');
  const { entryLanguageOf } = require('../engine/entry-points');
  const { makeGit } = require('../engine/git');
  const { gitSource } = require('./code-source');
  // wall-clock: log-only — start time for the log
  const t0 = Date.now();
  const result = await analyze(opts.repo, {
    mode: 'pr', base: base || '', remote: opts.remote, allowLocalBase: opts.allowLocalBase, skipForest: true,
    impactPaths: { deadlineMs: opts.deadlineMs }, keepResolvers: true, signal,
  });
  const live = /** @type {{ units: any[], dispose: () => void }} */ (/** @type {any} */ (result).liveResolvers);
  if (!live) throw new Error('internal: analyze(keepResolvers) returned no liveResolvers');
  try {
    // wall-clock: log-only — analysis time for the log
    log(`analysed ${result.allChanged.length} changed functions in ${Date.now() - t0} ms`);
    const git = makeGit(opts.repo);
    const headSha = git.revParse('HEAD');
    if (!headSha) throw new Error(`cannot resolve HEAD in ${opts.repo}`);
    const cards = await buildCards(result, { repo: opts.repo, base: result.base.sha, head: 'HEAD', signal });
    const languages = new Set();
    for (const c of /** @type {any[]} */ ([...result.allChanged, ...(result.deleted || [])])) { const l = entryLanguageOf(c.file); if (l) languages.add(l); }
    const { facts, notes: factNotes } = gatherEntryFacts({ repo: opts.repo, git, languages });
    const notes = [`impact paths at start were capped at ${opts.deadlineMs} ms for the whole PR (--deadline-ms); paths cut by it end "budget"`,
      'blast radius and caller trees are not computed', ...factNotes];
    const diffOf = (/** @type {string} */ relPath, /** @type {string|undefined} */ oldPath) => {
      try { return git.raw(['diff', '--no-color', '-U3', result.base.sha, headSha, '--', ...(oldPath && oldPath !== relPath ? [oldPath, relPath] : [relPath])], { quiet: true }); } catch { return null; }
    };
    // wall-clock: log-only — start time for the log
    log(`ready: ${cards.clusters.length} cards in ${Date.now() - t0} ms`);
    return {
      ctx: { repo: opts.repo, result, cards, units: live.units, facts, diffOf, notes, source: gitSource(opts.repo, headSha, result.base.sha) },
      headSha, baseSha: result.base.sha, dispose: live.dispose,
    };
  } catch (e) {
    live.dispose();
    throw e;
  }
}

// ---------------------------------------------------------------------------------------
// The editor bridge

/**
 * @typedef {object} Bridge The editor side, built by src/mcp/bridge-client.js.
 * @property {() => Promise<{ repo: string, mode: string, base: { ref: string, sha: string }, head: string, pr?: { number: number } }|null>} context
 * @property {(kind: 'cards'|'callers', payload: any, meta: { head: string, base: string }) => Promise<{ stored: boolean, reason?: string, errors?: string[] }>} submit
 * @property {() => void} close
 */

/**
 * @typedef {(p: { repo: string, signal?: AbortSignal }) => Promise<Bridge|null>} ConnectBridge
 */

// Built by the extension side of the bridge; absent in a checkout that predates it.
const BRIDGE_MODULE = './bridge-client';

/** @type {ConnectBridge} */
async function connectEditorBridge(p) {
  /** @type {any} */
  let mod;
  try { mod = require(BRIDGE_MODULE); } catch (e) {
    if (/** @type {any} */ (e).code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
  return mod.connectBridge(p);
}

/**
 * `promise`, or a rejection after `ms`. The losing operation is not stopped: this bounds the wait only.
 * @template T
 * @param {Promise<T>} promise @param {number} ms @param {string} what
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = realClock.setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
    promise.then((v) => { realClock.clearTimeout(timer); resolve(v); }, (e) => { realClock.clearTimeout(timer); reject(e); });
  });
}

// ---------------------------------------------------------------------------------------
// Server

/**
 * @typedef {object} Config
 * @property {ServerOptions} options
 * @property {typeof prepare} [prepare] Replaceable in tests.
 * @property {ConnectBridge} [connectBridge] Replaceable in tests.
 * @property {NodeJS.ReadableStream & { setEncoding?: any }} [input] Default: standard input.
 * @property {NodeJS.WritableStream} [output] Default: standard output.
 */

/**
 * Start serving. Owner of everything started here: the returned handle; `close()` stops it.
 * The analysis and the bridge connection start now and on the first tool call respectively;
 * `close()` stops either and releases the kept resolvers and the bridge.
 * @param {Config} config
 * @returns {{ close: () => Promise<void>, closed: Promise<void> }} `closed` resolves once everything is released, after input ended or `close()` ran
 */
function startServer(config) {
  const { options } = config;
  const doPrepare = config.prepare || prepare;
  const input = config.input || process.stdin;
  const output = config.output || process.stdout;
  const abort = new AbortController();
  const bridgeAbort = new AbortController();
  /** @type {Bridge|null} */
  let bridge = null;
  /** @type {Promise<void>|null} */
  let bridgeAttempt = null;
  /** @type {Promise<ReturnType<typeof createImpactTools>>|null} */
  let started = null;
  /** @type {Prepared|null} */
  let prepared = null;
  /** @type {Promise<void>|null} */
  let closing = null;

  // The bridge connection runs once, in the background; a failure leaves the server headless.
  const connect = config.connectBridge || connectEditorBridge;
  const attemptBridge = () => {
    bridgeAttempt = withDeadline(connect({ repo: options.repo, signal: bridgeAbort.signal }), BRIDGE_CONNECT_MS, 'the editor bridge').then((b) => {
      if (closing) { if (b) b.close(); return; }
      bridge = b;
      log(b ? 'connected to the editor' : 'no editor bridge: headless');
    }).catch((e) => { bridgeAbort.abort(); log(`editor bridge unavailable, continuing headless: ${e && e.message}`); });
  };

  /** @returns {Promise<ReturnType<typeof createImpactTools>>} */
  const ready = () => {
    if (!started) started = start();
    return started;
  };
  async function start() {
    if (options.notRepo) throw new ToolError(notRepoMessage(options.repo));
    if (bridgeAttempt) await bridgeAttempt;
    const base = options.base || await editorBase();
    prepared = await doPrepare(options, { base, signal: abort.signal });
    if (closing) { prepared.dispose(); throw new Error('the server is shutting down'); }
    const { headSha, baseSha } = prepared;
    return createImpactTools({
      ...prepared.ctx, signal: abort.signal,
      forward: bridge ? (kind, normalised) => forwardToEditor(kind, normalised, { head: headSha, base: baseSha }) : undefined,
    });
  }
  /** The base the editor reviews against, when one is connected. @returns {Promise<string|undefined>} */
  async function editorBase() {
    if (!bridge) return undefined;
    try {
      const c = await withDeadline(bridge.context(), BRIDGE_CONNECT_MS, 'the editor bridge');
      return c && c.base && c.base.ref ? c.base.ref : undefined;
    } catch (e) {
      log(`editor context unavailable, using the default base: ${/** @type {Error} */ (e).message}`);
      return undefined;
    }
  }
  /**
   * @param {'cards'|'callers'} kind @param {any} normalised @param {{ head: string, base: string }} meta
   * @returns {Promise<{ stored: boolean, reason?: string, errors?: string[] }>}
   */
  async function forwardToEditor(kind, normalised, meta) {
    if (!bridge) return { stored: false, reason: 'no editor connected: checked, not saved' };
    try {
      return await withDeadline(bridge.submit(kind, normalised, meta), SUBMIT_DEADLINE_MS, 'the editor');
    } catch (e) {
      log(`editor submit failed: ${/** @type {Error} */ (e).message}`);
      return { stored: false, reason: `the editor could not be reached (${/** @type {Error} */ (e).message}): checked, not saved` };
    }
  }

  const transport = new StdioServerTransport(/** @type {any} */ (input), /** @type {any} */ (output));
  const handle = serveStdio(() => createSdkServer(ready), { transport, onerror: (e) => log(`protocol error: ${e.message}`) });
  if (!options.notRepo) attemptBridge();

  /** @type {() => void} */
  let markClosed = () => {};
  const closed = new Promise((resolve) => { markClosed = () => resolve(undefined); });
  const close = () => {
    if (!closing) closing = shutdown().finally(markClosed);
    return closing;
  };
  async function shutdown() {
    abort.abort();
    bridgeAbort.abort();
    // An analysis still running stops at its next check and disposes its own resolvers.
    if (started) await withDeadline(started.then(() => undefined, () => undefined), SHUTDOWN_WAIT_MS, 'the analysis').catch((e) => log(e.message));
    if (prepared) { try { prepared.dispose(); } catch (e) { log(`dispose failed: ${/** @type {Error} */ (e).message}`); } }
    if (bridge) { try { bridge.close(); } catch (e) { log(`bridge close failed: ${/** @type {Error} */ (e).message}`); } }
    await handle.close().catch((e) => log(`close failed: ${e.message}`));
  }
  // The agent closing our input is the normal way to stop.
  const onInputEnd = () => { close(); };
  input.once('end', onInputEnd);
  input.once('close', onInputEnd);
  return { close, closed };
}

/**
 * An SDK server with every tool registered. The tool bodies wait for `ready()` (the analysis).
 * @param {() => Promise<ReturnType<typeof createImpactTools>>} ready
 */
function createSdkServer(ready) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  // The definitions need no analysis; a body gets its tool set once `ready` resolves.
  const defs = createImpactTools({ repo: '/', result: { allChanged: [], deleted: [] }, cards: { clusters: [], sweeps: [], seams: [] } }).tools;
  for (const def of defs) {
    server.registerTool(def.name, {
      title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations,
    }, async (/** @type {any} */ args) => callTool(ready, def.name, args));
  }
  return server;
}

/**
 * Run one tool and shape its answer: the JSON as text and as structuredContent, or an error result.
 * @param {() => Promise<ReturnType<typeof createImpactTools>>} ready @param {string} name @param {any} args
 */
async function callTool(ready, name, args) {
  let impl;
  try { impl = await ready(); } catch (e) {
    if (e instanceof ToolError) return errorResult(e.message);
    return errorResult(`The analysis failed: ${(e && /** @type {Error} */ (e).message) || e}`);
  }
  try {
    const out = await impl.call(name, args);
    return { content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(out) }], structuredContent: out };
  } catch (e) {
    if (!(e instanceof ToolError)) log(`tool ${name} failed: ${e && /** @type {Error} */ (e).stack}`);
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

/** @param {string} text */
const errorResult = (text) => ({ content: [{ type: /** @type {const} */ ('text'), text }], isError: true });

// ---------------------------------------------------------------------------------------
// Command line

/**
 * `impact-tree mcp`: serve until input ends or the process is told to stop.
 * @param {string[]} argv the arguments after `mcp`
 * @returns {Promise<void>}
 */
async function runCli(argv) {
  if (argv.includes('--help')) { console.log(HELP); return; }
  let options;
  try {
    assertNodeVersion(process.versions.node);
    options = parseArgs(argv);
  } catch (e) {
    console.error(`✖ ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
  const server = startServer({ options });
  const stop = (/** @type {string} */ why) => { log(`shutting down (${why})`); server.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await server.closed;
  log('shutting down (input closed)');
  process.exit(0);
}

module.exports = {
  runCli, startServer, createSdkServer, prepare, parseArgs, repoToplevel, notRepoMessage, assertNodeVersion, HELP,
  DEFAULT_DEADLINE_MS, SUBMIT_DEADLINE_MS, BRIDGE_CONNECT_MS, MIN_NODE_MAJOR,
};
