'use strict';

/**
 * The plan's LanguageServices operations, answered by Roslyn's MIT-licensed
 * `roslyn-language-server` (Microsoft.CodeAnalysis.LanguageServer, nuget.org) over stdio:
 * the shared stdio services (./stdio-server-services.js) with Roslyn's command and the
 * `csharp` language id, launched as C0b did (the C0b spike and report (kept outside the repository; npm run -s local-notes)). Never the
 * server inside the C# extension's VSIX: its licence allows VS Code / Visual Studio only.
 *
 * Tools (C-D1) live in the scratchpad's csharp-tools/: the .NET SDK in dotnet/ (the server
 * runs on its runtime and its MSBuild loads the projects), NuGet's packages in nuget/, the
 * server in roslyn-ls/. Nothing is installed system-wide.
 *
 * `start` initializes, then opens the solution (`solution/open`) or the projects
 * (`project/open`) and waits for Roslyn's `workspace/projectInitializationComplete`
 * notification (C0b: answers before it can miss callers in projects not loaded yet). This
 * version restores by itself while it loads (`Restore` progress; the client is not asked:
 * `dotnet.projects.enableAutomaticRestore` defaults to on and `workspace/configuration` is
 * answered null), so restore beforehand (`dotnet restore`) to keep restore out of the load
 * time. Server requests are recorded in `serverRequests`. Test code only.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStdioServerServices } = require('./stdio-server-services');
const { scratchpadPath } = require('./scratchpad');

const DEFAULT_TOOLS = () => scratchpadPath('csharp-tools');
/** The server's DLL under the tools folder (osx-x64 package; `dotnet <dll>`: the apphost has no exec bit). */
const SERVER_DLL = path.join('roslyn-ls', 'osx-x64', 'tools', 'net10.0', 'osx-x64', 'Microsoft.CodeAnalysis.LanguageServer.dll');
/** Project load, restore excluded (C0b: cs-a's 40 projects load in well under this). */
const LOAD_DEADLINE_MS = 6 * 60 * 1000;
const POLL_MS = 200;

/**
 * The environment the scratchpad's env.sh sets: the SDK first on PATH, its own CLI home,
 * NuGet's packages in the scratchpad, no telemetry or first-run text.
 * @param {string} tools
 */
function dotnetEnv(tools) {
  const root = path.join(tools, 'dotnet');
  return {
    ...process.env,
    DOTNET_ROOT: root,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_HOME: path.join(tools, 'dotnet-home'),
    NUGET_PACKAGES: path.join(tools, 'nuget'),
    PATH: `${root}:${process.env.PATH}`,
  };
}

/**
 * @param {{ repo: string, solution?: string, projects?: string[], tools?: string,
 *   logDir?: string, deadlineMs?: number, scratchDir?: string, trace?: boolean }} options
 *   `solution`: a .sln/.slnx path (absolute, or relative to `repo`); else `projects`
 *   (.csproj paths). One of them is needed. `logDir`: Roslyn's own log folder (default
 *   csharp-tools/roslyn-ls/logs).
 */
function createRoslynServices(options) {
  const tools = options.tools || DEFAULT_TOOLS();
  const dll = path.join(tools, SERVER_DLL);
  if (!fs.existsSync(dll)) throw new Error(`no Roslyn language server at ${dll}`);
  const logDir = options.logDir || path.join(tools, 'roslyn-ls', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const abs = (/** @type {string} */ p) => (path.isAbsolute(p) ? p : path.join(options.repo, p));
  if (!options.solution && !(options.projects && options.projects.length)) throw new TypeError('Roslyn services need a solution or projects');

  const startedAt = Date.now();
  /** Every notification and server request (method, ms from start), errors and progress included. */
  /** @type {Array<{ ms: number, kind: 'notification'|'request', method: string, detail: string }>} */
  const events = [];
  /** @type {Array<{ method: string, params: any }>} */
  const serverRequests = [];
  let initializationComplete = 0;
  const openTokens = new Set();
  let lastProgressAt = 0;
  /** Roslyn's window/logMessage lines of type Error/Warning (1/2), for the report. */
  /** @type {string[]} */
  const problems = [];

  const services = createStdioServerServices({
    repo: options.repo,
    command: path.join(tools, 'dotnet', 'dotnet'),
    args: [dll, '--stdio', '--logLevel', 'Information', '--telemetryLevel', 'off', '--extensionLogDirectory', logDir],
    env: dotnetEnv(tools),
    languageId: 'csharp',
    deadlineMs: options.deadlineMs || 120000,
    ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
    onNotification: (method, params) => {
      const ms = Date.now() - startedAt;
      if (method === 'workspace/projectInitializationComplete') initializationComplete = Date.now();
      if (method === '$/progress' && params && params.value) {
        lastProgressAt = Date.now();
        if (params.value.kind === 'begin') openTokens.add(params.token);
        if (params.value.kind === 'end') openTokens.delete(params.token);
      }
      if (method === 'window/logMessage' && params && params.type <= 2) problems.push(String(params.message).slice(0, 300));
      if (method !== 'textDocument/publishDiagnostics') {
        const detail = method === '$/progress' ? `${params.value.kind} ${params.value.title || params.value.message || ''}` : JSON.stringify(params ?? null).slice(0, 200);
        events.push({ ms, kind: 'notification', method, detail });
      }
      if (options.trace) process.stderr.write(`[roslyn ${(ms / 1000).toFixed(1)}s] ${method} ${JSON.stringify(params ?? null).slice(0, 200)}\n`);
    },
  });
  // Every request the server sends its client is recorded before the default reply (null,
  // or one null per configuration item): Roslyn asks for restore and for its settings this way.
  const client = services.client;
  const reply = client.replyToServer.bind(client);
  client.replyToServer = (/** @type {any} */ msg) => {
    serverRequests.push({ method: msg.method, params: msg.params });
    events.push({ ms: Date.now() - startedAt, kind: 'request', method: msg.method, detail: JSON.stringify(msg.params ?? null).slice(0, 200) });
    if (options.trace) process.stderr.write(`[roslyn ${((Date.now() - startedAt) / 1000).toFixed(1)}s] request ${msg.method} ${JSON.stringify(msg.params ?? null).slice(0, 200)}\n`);
    reply(msg);
  };

  /**
   * initialize, open the solution or projects, wait for projectInitializationComplete.
   * Returns the capabilities and the times (ms from launch) of each stage. `onOpened` runs
   * right after the open notification (C0b: a query while the solution loads).
   * @param {{ deadlineMs?: number, onOpened?: () => void }} [opts]
   */
  const start = async (opts) => {
    const t0 = Date.now();
    const result = await client.initialize({ rootPath: options.repo, rootUri: pathToFileURL(options.repo).toString(), deadlineMs: 60000 });
    const initializedMs = Date.now() - t0;
    if (options.solution) client.notify('solution/open', { solution: pathToFileURL(abs(options.solution)).toString() });
    else client.notify('project/open', { projects: /** @type {string[]} */ (options.projects).map((p) => pathToFileURL(abs(p)).toString()) });
    if (opts && opts.onOpened) opts.onOpened();
    const deadline = Date.now() + ((opts && opts.deadlineMs) || LOAD_DEADLINE_MS);
    while (!initializationComplete && Date.now() < deadline) await new Promise((r) => setTimeout(r, POLL_MS));
    if (!initializationComplete) throw new Error(`roslyn: no workspace/projectInitializationComplete within ${(opts && opts.deadlineMs) || LOAD_DEADLINE_MS} ms`);
    return { capabilities: result, initializedMs, loadedMs: initializationComplete - t0 };
  };

  /** Resolves once no progress is open and none came for `quietMs`. */
  const waitQuiet = async ({ quietMs = 1500, deadlineMs = 120000 } = {}) => {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
      if (openTokens.size === 0 && Date.now() - lastProgressAt >= quietMs) return Date.now() - t0;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(`roslyn: not quiet within ${deadlineMs} ms (${openTokens.size} progress open)`);
  };

  /** Process ids under `pid` (Roslyn's MSBuild BuildHost and build nodes), deepest last. @param {number} pid @returns {number[]} */
  const descendants = (pid) => {
    let out = '';
    try { out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }); } catch { return []; }
    return out.split('\n').filter(Boolean).map(Number).flatMap((child) => [child, ...descendants(child)]);
  };
  // shutdown + exit, then kill what the server started: its BuildHost children hold the
  // stdio pipes open, which kept the harness alive for minutes after the server had gone (C0b).
  const close = async () => {
    const pid = client.proc.pid;
    const children = pid ? descendants(pid) : [];
    await services.close();
    for (const child of children) { try { process.kill(child, 'SIGKILL'); } catch { /* gone */ } }
    for (const stream of [client.proc.stdout, client.proc.stderr]) if (stream) stream.destroy();
  };

  return { ...services, start, waitQuiet, close, events, serverRequests, problems };
}

module.exports = { createRoslynServices, dotnetEnv, DEFAULT_TOOLS, SERVER_DLL };
