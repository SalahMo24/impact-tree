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
const { fileURLToPath } = require('url');
const { execFileSync } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/server');
const { serveStdio, StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { realClock } = require('../engine/clock');
const { z } = require('zod');
const { createImpactTools } = require('./tools');
const { ToolError } = require('./paging');
const { createCodeWatch } = require('./code-watch');
const { RELOAD_EXIT_CODE, SUPERVISED_ENV } = require('./supervisor');

const SERVER_INFO = { name: 'impact-tree', title: 'Impact Tree', version: '0.1.0' };
const INSTRUCTIONS = 'Facts about the checked-out pull request from Impact Tree: cluster cards of its changes, callers, references and impact paths to entry points. '
  + 'Answers carry complete/reasons; treat incomplete lists as lower bounds. '
  + 'submit_cards and submit_callers save your answer in the editor when one is connected; they check it first and return what to fix. '
  + 'If a tool says it cannot tell which repository to analyse, call select_repository with the repository folder; never edit the MCP configuration.';
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
 * @param {{ cwd?: string, toplevel?: (cwd: string) => string|null, workspaceFolders?: string|undefined }} [env] replaceable in tests;
 *   `workspaceFolders`: the editor's folders for this window (Cursor sets WORKSPACE_FOLDER_PATHS for each window's server)
 * @returns {ServerOptions}
 * @throws {Error} on a value that is not valid, with a message for the person who typed it
 */
function parseArgs(argv, { cwd = process.cwd(), toplevel = repoToplevel, workspaceFolders = process.env.WORKSPACE_FOLDER_PATHS } = {}) {
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
  // Started outside a repository: this window's one workspace repository, when the editor says so.
  const fromWorkspace = workspaceRepos(workspaceFolders, toplevel);
  const top = explicit ? null : toplevel(cwd) || (fromWorkspace.length === 1 ? fromWorkspace[0] : null);
  return {
    repo: path.resolve(explicit || top || cwd), ...(!explicit && !top ? { notRepo: /** @type {const} */ (true) } : {}), ...(base ? { base } : {}),
    remote: get('remote') || 'origin', allowLocalBase: argv.includes('--allow-local-base'), deadlineMs,
  };
}

/**
 * The git repositories of the editor window's folders, from WORKSPACE_FOLDER_PATHS (set by
 * Cursor for each window's MCP server). Absolute paths only, separated by the platform's
 * path delimiter or a comma; at most 50.
 * @param {string|undefined} value @param {(dir: string) => string|null} toplevel
 * @returns {string[]} sorted, unique
 */
function workspaceRepos(value, toplevel) {
  if (typeof value !== 'string' || value === '' || value.length > 64 * 1024) return [];
  const repos = new Set();
  for (const dir of value.split(new RegExp(`[${path.delimiter === ';' ? ';' : ':'},]`)).map((d) => d.trim()).filter((d) => path.isAbsolute(d)).slice(0, 50)) {
    const top = toplevel(dir);
    if (top) repos.add(top);
  }
  return [...repos].sort();
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
    // Uncommitted changes: analyse the branch with them, as the editor does, instead of refusing.
    onDirty: 'fallback', impactPaths: { deadlineMs: opts.deadlineMs }, keepResolvers: true, signal,
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
    if (result.mode !== 'pr') {
      notes.unshift(`the checkout has ${result.dirtyCount} uncommitted change(s): the changes analysed include them (branch + uncommitted), `
        + 'but diffs and source read from git show the last commit');
    }
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
// Finding the repository when the start folder is in none

// Wait for the agent's list of workspace folders (MCP roots). Unit: ms.
const ROOTS_DEADLINE_MS = 3000;

/**
 * The git repositories of the agent's workspace folders (MCP roots), when the agent shares
 * them. `note` says why there are none.
 * @param {any} sdk the connected McpServer, or null
 * @param {(cwd: string) => string|null} toplevel
 * @returns {Promise<{ repos: string[], note?: string }>}
 */
async function rootRepos(sdk, toplevel) {
  const caps = sdk && sdk.server && typeof sdk.server.getClientCapabilities === 'function' ? sdk.server.getClientCapabilities() : null;
  if (!caps || !caps.roots) return { repos: [], note: 'the agent does not share its workspace folders (MCP roots)' };
  let listed;
  try {
    listed = await withDeadline(sdk.server.listRoots(), ROOTS_DEADLINE_MS, 'the agent\'s workspace folders');
  } catch (e) {
    return { repos: [], note: `the agent's workspace folders could not be read (${/** @type {Error} */ (e).message})` };
  }
  const repos = new Set();
  for (const root of (listed && Array.isArray(listed.roots) ? listed.roots : []).slice(0, 50)) {
    if (!root || typeof root.uri !== 'string' || !root.uri.startsWith('file:')) continue;
    let dir;
    try { dir = fileURLToPath(root.uri); } catch { continue; }
    const top = toplevel(dir);
    if (top) repos.add(top);
  }
  return repos.size ? { repos: [...repos].sort() } : { repos: [], note: 'none of the agent\'s workspace folders is in a git repository' };
}

// How recent a press of "Analyse with my agent" picks its editor window among several. Unit: ms.
const ASKED_RECENTLY_MS = 30 * 60 * 1000;

/** @param {string[]} repos @returns {string} what the agent should do when the server cannot tell the repository */
const chooseWithTool = (repos) => `call select_repository with the repository to review${repos.length ? ` (one of: ${repos.join(', ')})` : ''}; do not change the MCP configuration`;

/**
 * The repository to analyse when the server started outside any (Cursor starts its servers
 * in the home folder), in this order: the agent's one workspace repository; the one editor
 * window with Impact Tree's agents setting on; among several, the window where the user last
 * pressed "Analyse with my agent" in the past 30 minutes. Otherwise an error that tells the
 * agent to call `select_repository`, never a guess.
 * @param {{ cwd: string, sdk: any, toplevel?: (cwd: string) => string|null,
 *   editorRepos?: () => Array<{ repo: string, askedAt: number|null }>, now?: () => number, workspaceFolders?: string|undefined }} p
 * @returns {Promise<{ repo: string, from: string }>}
 * @throws {ToolError} when there is no single candidate; the message says what was tried and what to do
 */
async function findRepoFor({ cwd, sdk, toplevel = repoToplevel, editorRepos, now = () => realClock.now(), workspaceFolders = process.env.WORKSPACE_FOLDER_PATHS }) {
  const fromWindow = workspaceRepos(workspaceFolders, toplevel);
  if (fromWindow.length === 1) return { repo: fromWindow[0], from: 'the editor window\'s workspace folder' };
  if (fromWindow.length > 1) throw new ToolError(`the editor window has several git repositories; ${chooseWithTool(fromWindow)}`);
  const fromRoots = await rootRepos(sdk, toplevel);
  if (fromRoots.repos.length === 1) return { repo: fromRoots.repos[0], from: 'the agent\'s workspace folder' };
  if (fromRoots.repos.length > 1) throw new ToolError(`the agent's workspace has several git repositories; ${chooseWithTool(fromRoots.repos)}`);
  const listEditors = editorRepos || (() => require('./bridge-client').liveEditorRepos());
  const editors = listEditors().filter((e) => toplevel(e.repo) === e.repo);
  if (editors.length === 1) return { repo: editors[0].repo, from: 'the editor window with Impact Tree\'s agents setting on' };
  if (editors.length > 1) {
    const asked = editors.filter((e) => e.askedAt !== null && now() - e.askedAt >= 0 && now() - e.askedAt <= ASKED_RECENTLY_MS)
      .sort((a, b) => /** @type {number} */ (b.askedAt) - /** @type {number} */ (a.askedAt));
    if (asked.length) return { repo: asked[0].repo, from: 'the editor window where "Analyse with my agent" was pressed last' };
    throw new ToolError(`more than one editor window has Impact Tree's agents setting on; ${chooseWithTool(editors.map((e) => e.repo))}`);
  }
  throw new ToolError(`${notRepoMessage(cwd)}. Also tried: ${fromRoots.note}; no editor window has Impact Tree's agents setting (impactTree.agents.enabled) on. `
    + `If you know the repository, ${chooseWithTool([])}`);
}

// ---------------------------------------------------------------------------------------
// Following the review and the code

const OUTDATED_MESSAGE = 'Impact Tree was updated after this MCP server started, and it still runs the old code. '
  + 'Restart the impact-tree server in your agent\'s MCP settings (turn it off and on), then make the same call again. Do not stop its process by hand.';

/** @param {string|null|undefined} sha @returns {string} */
const short = (sha) => (sha ? sha.slice(0, 8) : 'none');
/** Two commit ids name the same commit: equal, or one a prefix (7+ characters) of the other. @param {string|null|undefined} a @param {string|null|undefined} b */
const sameCommit = (a, b) => {
  if (!a || !b) return false;
  const x = a.toLowerCase(); const y = b.toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/** @param {{ base?: { sha?: string } }|null} ctx @returns {string|undefined} the editor's base commit, when it is one */
const baseCommitOf = (ctx) => (ctx && ctx.base && typeof ctx.base.sha === 'string' && /^[0-9a-f]{40}$/.test(ctx.base.sha) ? ctx.base.sha : undefined);

/** @param {string} repo @returns {string|null} the checkout's HEAD commit, or null when git cannot say */
function headCommitOf(repo) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch { return null; }
}

// The files whose change means this process runs outdated code (an extension update or a
// new checkout of the extension). Relative to this file.

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
 * @property {typeof findRepoFor} [findRepo] Replaceable in tests.
 * @property {(repo: string) => string|null} [headOf] Replaceable in tests: the checkout's HEAD commit.
 * @property {() => string} [codeStamp] Replaceable in tests: changes when the server's code files change.
 * @property {() => void} [onOutdated] Called when the code changed, before the tool fails; default: exit for the supervisor when supervised.
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
  let options = config.options;
  const findRepo = config.findRepo || findRepoFor;
  /** @type {any} */
  let sdk = null;
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
  const headOf = config.headOf || headCommitOf;
  // Whether the extension's code changed since this process started (tests inject a stamp).
  const codeChanged = config.codeStamp
    ? ((stamp, atStart) => () => stamp() !== atStart)(config.codeStamp, config.codeStamp())
    : ((watch) => () => watch.changed())(createCodeWatch(path.join(__dirname, '..', '..')));
  // Supervised (src/mcp/supervisor.js): exit and let the supervisor restart on the new code and resend the call.
  const onOutdated = config.onOutdated || (process.env[SUPERVISED_ENV] === '1' ? () => process.exit(RELOAD_EXIT_CODE) : null);
  /** What the kept analysis was made for: the checkout's head and, without --base, the editor's base commit. */
  /** @type {{ head: string, editorBase: string|null }|null} */
  let preparedFor = null;
  // Review checks run one at a time, so two calls never both start a new analysis.
  /** @type {Promise<unknown>} */
  let lane = Promise.resolve();

  // The bridge connection runs once, in the background; a failure leaves the server headless.
  const connect = config.connectBridge || connectEditorBridge;
  const attemptBridge = () => {
    const repo = options.repo;
    // Its own signal: a failed attempt must not cancel later ones (reconnects, a chosen repository).
    const attempt = new AbortController();
    bridgeAbort.signal.addEventListener('abort', () => attempt.abort(), { once: true });
    bridgeAttempt = withDeadline(connect({ repo, signal: attempt.signal }), BRIDGE_CONNECT_MS, 'the editor bridge').then((b) => {
      // Closed meanwhile, or the agent chose another repository: this connection is not wanted.
      if (closing || options.repo !== repo) { if (b) b.close(); return; }
      bridge = b;
      log(b ? 'connected to the editor' : 'no editor bridge: headless');
    }).catch((e) => { attempt.abort(); log(`editor bridge unavailable, continuing headless: ${e && e.message}`); });
  };

  /** @returns {Promise<ReturnType<typeof createImpactTools>>} */
  const ready = () => {
    if (!started) {
      const attempt = start();
      started = attempt;
      // No repository found yet: the next call looks again (the agent may open a folder).
      attempt.catch(() => { if (options.notRepo && started === attempt) started = null; });
    }
    return started;
  };
  async function start() {
    if (options.notRepo) {
      const found = await findRepo({ cwd: options.repo, sdk });
      options = { ...options, repo: found.repo, notRepo: undefined };
      log(`repository from ${found.from}: ${found.repo}`);
      attemptBridge();
    }
    if (bridgeAttempt) await bridgeAttempt;
    const editorBase = options.base ? undefined : baseCommitOf(await editorContext());
    const base = options.base || editorBase;
    prepared = await doPrepare(options, { base, signal: abort.signal });
    if (closing) { prepared.dispose(); throw new Error('the server is shutting down'); }
    const { headSha, baseSha } = prepared;
    preparedFor = { head: headSha, editorBase: editorBase || null };
    return createImpactTools({
      ...prepared.ctx, signal: abort.signal,
      forward: bridge ? (kind, normalised) => forwardToEditor(kind, normalised, { head: headSha, base: baseSha }) : undefined,
    });
  }
  /** The review the editor shows, when one is connected. @returns {Promise<import('./bridge-client').BridgeContext|null>} */
  async function editorContext() {
    if (!bridge) return null;
    try {
      return await withDeadline(bridge.context(), BRIDGE_CONNECT_MS, 'the editor bridge');
    } catch (e) {
      log(`editor context unavailable: ${/** @type {Error} */ (e).message}`);
      return null;
    }
  }

  /**
   * Before a tool runs: is this still the code the server started with, and the review its
   * analysis was made for? When the checkout's head or the editor's base commit moved, the
   * analysis is dropped (the next call makes a new one) and `notice` says so.
   * @returns {Promise<{ notice: string|null, ctx: import('./bridge-client').BridgeContext|null }>}
   * @throws {ToolError} when the extension's code changed after this process started
   */
  async function checkReview() {
    if (codeChanged()) {
      if (onOutdated) { log('the extension\'s code changed: exiting so the supervisor restarts on the new code'); onOutdated(); }
      throw new ToolError(OUTDATED_MESSAGE);
    }
    // With --base the editor's base does not matter; its context is read only for list_cards.
    const ctx = options.base ? null : await editorContext();
    if (options.notRepo || !prepared || !preparedFor) return { notice: null, ctx };
    const head = headOf(options.repo);
    const editorBase = baseCommitOf(ctx) || null;
    const movedHead = head !== null && head !== preparedFor.head;
    // Only a base the editor named, both times: an editor connecting later does not count as a move.
    const movedBase = editorBase !== null && preparedFor.editorBase !== null && editorBase !== preparedFor.editorBase;
    if (!movedHead && !movedBase) return { notice: null, ctx };
    const was = preparedFor;
    const what = [movedHead && `head ${short(was.head)} → ${short(/** @type {string} */ (head))}`,
      movedBase && `base ${short(was.editorBase)} → ${short(editorBase)}`].filter(Boolean).join(', ');
    log(`the review moved (${what}): the analysis is made again`);
    try { prepared.dispose(); } catch (e) { log(`dispose failed: ${/** @type {Error} */ (e).message}`); }
    prepared = null; preparedFor = null; started = null;
    return { notice: `The review changed since the analysis was made (${what}); Impact Tree analyses it again. Card and change ids from earlier calls no longer apply: call list_cards again before you submit.`, ctx };
  }

  /**
   * One tool call: the review check first (one at a time), then the tool. After a move, only
   * list_cards answers (from the new analysis); any other tool returns the notice, since the
   * ids it was given may name the old analysis. list_cards carries the review it describes.
   * @param {string} name @param {any} args
   */
  async function invoke(name, args) {
    /** @type {{ notice: string|null, ctx: any }} */
    let checked;
    try {
      const turn = lane.then(checkReview, checkReview);
      lane = turn.catch(() => undefined);
      checked = await turn;
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
    if (name === 'submit_cards' && args && args.review) {
      // Cards written from facts handed over with the prompt: when they are for the review the
      // editor shows now, a dropped analysis is simply made again by the call below.
      const refused = await stampRefusal(args.review, checked.ctx);
      if (refused) return errorResult(refused);
    } else if (checked.notice && name !== 'list_cards') {
      return errorResult(checked.notice);
    }
    const res = /** @type {any} */ (await callTool(ready, name, args));
    if (name !== 'list_cards' || res.isError || !prepared || !preparedFor) return res;
    const ctx = checked.ctx || await editorContext();
    const review = {
      head: prepared.headSha, base: prepared.baseSha,
      editorHead: ctx ? ctx.head : null,
      matchesEditor: ctx ? ctx.head === prepared.headSha && (Boolean(options.base) || baseCommitOf(ctx) === preparedFor.editorBase) : null,
      ...(checked.notice ? { reanalysed: checked.notice } : {}),
    };
    const out = { review, ...res.structuredContent };
    return { content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(out) }], structuredContent: out };
  }
  /**
   * Why cards stamped with `stamp` (from the prompt's facts) cannot be saved, or null when
   * they are for the current review: the checkout's head and the editor's base commit (or,
   * with no editor base, the base of the analysis).
   * @param {{ head: string, base: string }} stamp @param {any} ctx The editor's context, or null.
   * @returns {Promise<string|null>}
   */
  async function stampRefusal(stamp, ctx) {
    if (options.notRepo) return null;   // no repository yet: the tool call says so
    const was = `These cards were written for head ${short(stamp.head)}, base ${short(stamp.base)}`;
    const again = 'Nothing was saved. Tell the user to click "Analyse with my agent" again for the current review.';
    const head = headOf(options.repo);
    if (head !== null && !sameCommit(head, stamp.head)) {
      return `${was}, but ${options.repo} is now at ${short(head)}. If that is the wrong folder, call select_repository with the repository folder from the prompt and submit again; otherwise: ${again}`;
    }
    const editorBase = options.base ? null : baseCommitOf(ctx) || null;
    if (editorBase !== null && !sameCommit(editorBase, stamp.base)) return `${was}, but the editor now reviews against base ${short(editorBase)}. ${again}`;
    if (editorBase === null) {
      try { await ready(); } catch { return null; }   // the tool call reports the failure
      if (prepared && !sameCommit(prepared.baseSha, stamp.base)) return `${was}, but the analysis here is against base ${short(prepared.baseSha)}. ${again}`;
    }
    return null;
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

  /**
   * `select_repository`: the agent names the repository (the server could not tell, or several
   * windows are open). Switching to another repository drops the analysis made so far.
   * @param {string} asked
   * @returns {Promise<{ repo: string, changed: boolean, head: string|null }>}
   */
  async function selectRepository(asked) {
    const top = path.isAbsolute(asked) ? repoToplevel(asked) : null;
    if (!top) throw new ToolError(`not a folder inside a git repository: ${asked} (give an absolute path)`);
    if (!options.notRepo && options.repo === top) {
      // The same repository: still follow its review (a new head or editor base means a new analysis).
      const checked = await checkReview();
      return { repo: top, changed: Boolean(checked.notice), head: headOf(top) };
    }
    if (started) await started.then(() => undefined, () => undefined);
    if (prepared) { try { prepared.dispose(); } catch (e) { log(`dispose failed: ${/** @type {Error} */ (e).message}`); } prepared = null; }
    started = null;
    if (bridge) { try { bridge.close(); } catch { /* already closed */ } bridge = null; }
    options = { ...options, repo: top, notRepo: undefined };
    preparedFor = null;
    log(`repository chosen by the agent: ${top}`);
    attemptBridge();
    return { repo: top, changed: true, head: headOf(top) };
  }

  const transport = new StdioServerTransport(/** @type {any} */ (input), /** @type {any} */ (output));
  const handle = serveStdio(() => { sdk = createSdkServer(ready, selectRepository, invoke); return sdk; }, { transport, onerror: (e) => log(`protocol error: ${e.message}`) });
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
 * @param {(repo: string) => Promise<{ repo: string, changed: boolean, head: string|null }>} [selectRepository]
 * @param {(name: string, args: any) => Promise<any>} [invoke] runs a tool (default: straight to `ready`)
 */
function createSdkServer(ready, selectRepository, invoke = (name, args) => callTool(ready, name, args)) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  // The definitions need no analysis; a body gets its tool set once `ready` resolves.
  const defs = createImpactTools({ repo: '/', result: { allChanged: [], deleted: [] }, cards: { clusters: [], sweeps: [], seams: [] } }).tools;
  for (const def of defs) {
    server.registerTool(def.name, {
      title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations,
    }, async (/** @type {any} */ args) => invoke(def.name, args));
  }
  if (selectRepository) {
    server.registerTool('select_repository', {
      title: 'Choose the repository',
      description: 'Use when a tool says it cannot tell which repository to analyse: give the absolute path of the repository folder to review (the one named in your task). Switching repositories drops the analysis made so far.',
      inputSchema: z.object({ repo: z.string().min(1).max(4096).describe('Absolute path of the repository folder, or of a folder inside it.') }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (/** @type {any} */ args) => {
      try {
        const out = await selectRepository(String(args.repo));
        return { content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(out) }], structuredContent: out };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    });
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
  runCli, startServer, createSdkServer, prepare, parseArgs, repoToplevel, notRepoMessage, assertNodeVersion, HELP, findRepoFor, rootRepos,
  DEFAULT_DEADLINE_MS, SUBMIT_DEADLINE_MS, BRIDGE_CONNECT_MS, MIN_NODE_MAJOR,
};
