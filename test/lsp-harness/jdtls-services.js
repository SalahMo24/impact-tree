'use strict';

/**
 * The plan's LanguageServices operations, answered by Eclipse JDT LS (jdtls) over stdio:
 * the shared stdio services (./stdio-server-services.js) with jdtls' command and the `java`
 * language id, launched as J0 did (./j0-spike.js; tools per J-D1 in the scratchpad's
 * java-tools/: JDK 25 runs jdtls, m2e's files and the local Maven repository stay there).
 * `start` initializes with the Java settings and waits for jdtls' ServiceReady and the end
 * of its import and build progress (J0: answers before that can be empty). Test code only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStdioServerServices } = require('./stdio-server-services');

const { scratchpadPath } = require('./scratchpad');
const DEFAULT_TOOLS = scratchpadPath('java-tools');
/** ServiceReady and quiet progress, cold import included (J0: 78 s with an empty m2). */
const READY_DEADLINE_MS = 6 * 60 * 1000;
const POLL_MS = 500;

/** @param {string} tools */
function jdkHome(tools) {
  if (process.env.J0_JDK) return process.env.J0_JDK;
  const dir = path.join(tools, 'jdk25');
  const jdk = fs.readdirSync(dir).find((d) => d.startsWith('jdk-'));
  if (!jdk) throw new Error(`no jdk-* in ${dir}`);
  return path.join(dir, jdk, 'Contents', 'Home');
}

/** @param {string} tools @param {string} dataDir */
function jdtlsCommand(tools, dataDir) {
  const javaHome = jdkHome(tools);
  const jdtls = path.join(tools, 'jdtls');
  const launcher = fs.readdirSync(path.join(jdtls, 'plugins')).find((f) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(f));
  if (!launcher) throw new Error(`no equinox launcher jar in ${jdtls}/plugins`);
  const config = path.join(tools, 'jdtls-config');
  if (!fs.existsSync(config)) fs.cpSync(path.join(jdtls, os.arch() === 'arm64' ? 'config_mac_arm' : 'config_mac'), config, { recursive: true });
  return {
    command: path.join(javaHome, 'bin', 'java'),
    args: [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dlog.level=WARNING', '-Xmx2G',
      `-Duser.home=${path.join(tools, 'home')}`, `-Dmaven.repo.local=${path.join(tools, 'm2')}`,
      '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
      '-jar', path.join(jdtls, 'plugins', launcher), '-configuration', config, '-data', dataDir,
    ],
    env: { ...process.env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}:${process.env.PATH}` },
  };
}

/**
 * @param {{ repo: string, tools?: string, dataDir: string, deadlineMs?: number, scratchDir?: string }} options
 *   `dataDir` is jdtls' `-data` workspace: keep one per repository between runs (warm start).
 */
function createJdtlsServices(options) {
  const tools = options.tools || DEFAULT_TOOLS;
  const settingsXml = path.join(tools, 'maven-settings.xml');
  const { command, args, env } = jdtlsCommand(tools, options.dataDir);
  let ready = false;
  let readyAt = 0;
  /** @type {() => void} */
  let resolveServerReady = () => {};
  const serverReady = new Promise((r) => { resolveServerReady = () => r(undefined); });
  /** Every import-end event (200 / 100) with its time from ServiceReady (negative: before). */
  /** @type {Array<{ eventType: number, msFromReady: number|null }>} */
  const importEvents = [];
  /** Every `$/progress` begin/end with its time from ServiceReady (null: before), for J6's start measurements. */
  /** @type {Array<{ kind: string, title: string, msFromReady: number|null }>} */
  const progressEvents = [];
  const openTokens = new Set();
  let lastProgressAt = 0;
  /** @type {Map<string, Array<{ message: string }>>} */
  const projectDiagnostics = new Map();
  /** @type {Array<(params: any) => void>} */
  const eventListeners = [];
  const services = createStdioServerServices({
    repo: options.repo, command, args, env, languageId: 'java',
    deadlineMs: options.deadlineMs || 120000,
    ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
    // jdtls keeps a base-side copy in its default project and lists it as a caller after
    // the copy is deleted (J2's runs: ENOENT). Not a workspace caller: left out, as the
    // editor's Java extras drop it (src/languages/java/editor-extras.js).
    skipCallerUri: (uri) => uri.includes('/jdt.ls-java-project/'),
    onNotification: (method, params) => {
      // J6_TRACE=1: every notification but Java diagnostics, timed, on stderr (debugging a switch).
      if (process.env.J6_TRACE && !(method === 'textDocument/publishDiagnostics' && /\.java$/.test(params.uri))) {
        process.stderr.write(`[jdtls ${new Date().toISOString().slice(11, 23)}] ${method} ${JSON.stringify(params).slice(0, 300)}\n`);
      }
      if (method === 'language/eventNotification' && params) for (const l of eventListeners) l(params);
      // Project-level diagnostics (a project folder or a build file), read by the Java status.
      if (method === 'textDocument/publishDiagnostics' && params && !/\.java$/.test(params.uri)) projectDiagnostics.set(params.uri, params.diagnostics || []);
      if (method === 'language/status' && params && params.type === 'ServiceReady') { if (!ready) { readyAt = Date.now(); resolveServerReady(); } ready = true; }
      if (method === '$/progress' && params && params.value) {
        lastProgressAt = Date.now();
        if (params.value.kind === 'begin' || params.value.kind === 'end') progressEvents.push({ kind: params.value.kind, title: String(params.value.title || params.token).slice(0, 60), msFromReady: readyAt ? Date.now() - readyAt : null });
        if (params.value.kind === 'begin') openTokens.add(params.token);
        if (params.value.kind === 'end') openTokens.delete(params.token);
      }
    },
  });
  const javaSettings = {
    java: {
      // `automatic`: a pom changed by a checkout is re-imported without asking. jdtls' default,
      // `interactive`, asks the client, which the harness never answers: J6's runs kept the
      // previous commit's module versions after a switch, and extras/metrics/proto lost their
      // link to the workspace's gson (their calls missed on complete answers).
      configuration: { maven: { userSettings: settingsXml, globalSettings: settingsXml }, updateBuildConfiguration: 'automatic' },
      import: { gradle: { enabled: false }, maven: { enabled: true } },
      autobuild: { enabled: true },
      maven: { downloadSources: false },
      references: { includeDecompiledSources: false },
    },
  };
  const start = async (/** @type {{ deadlineMs?: number }|undefined} */ opts) => {
    const rootUri = pathToFileURL(options.repo).toString();
    const result = await services.client.initialize({
      rootPath: options.repo, rootUri, deadlineMs: (opts && opts.deadlineMs) || READY_DEADLINE_MS,
      initializationOptions: {
        workspaceFolders: [rootUri], settings: javaSettings,
        extendedClientCapabilities: { progressReportProvider: false, classFileContentsSupport: false },
      },
    });
    services.client.notify('workspace/didChangeConfiguration', { settings: javaSettings });
    const deadline = Date.now() + READY_DEADLINE_MS;
    while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, POLL_MS));
    if (!ready) throw new Error(`jdtls: no ServiceReady within ${READY_DEADLINE_MS} ms`);
    while (openTokens.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, POLL_MS));
    return result;
  };
  /**
   * Resolves once no progress is open and none was reported for `quietMs` (at least
   * `minMs` after the call); rejects after `deadlineMs`. After a commit switch (J6): jdtls
   * refreshes, rebuilds and, when a pom changed, re-imports; answers before that are stale.
   * @param {{ quietMs?: number, minMs?: number, deadlineMs?: number }} [opts]
   */
  const waitQuiet = async ({ quietMs = 1500, minMs = 1000, deadlineMs = 120000 } = {}) => {
    const t0 = Date.now();
    const deadline = t0 + deadlineMs;
    while (Date.now() < deadline) {
      const now = Date.now();
      if (now - t0 >= minMs && openTokens.size === 0 && now - lastProgressAt >= quietMs) return now - t0;
      await new Promise((r) => setTimeout(r, POLL_MS / 5));
    }
    throw new Error(`jdtls: not quiet within ${deadlineMs} ms (${openTokens.size} progress open)`);
  };
  // What the editor reads from redhat.java (src/languages/java/server-status.js), built from
  // jdtls' own notifications the way redhat.java builds its API: `onDidProjectsImport` and
  // `onDidClasspathUpdate` are jdtls' `language/eventNotification` 200 and 100, the build-file
  // watcher is `buildFilesChanged()` (called by the harness after a checkout that changed a
  // pom), and the project diagnostics are the ones jdtls published. Progress is not read: the
  // editor cannot see it.
  const { createJavaServerStatus } = require('../../src/languages/java/server-status');
  const { fileURLToPath } = require('url');
  /** @type {Record<string, Function>} */
  const on = {};
  const handler = (/** @type {string} */ name) => (/** @type {Function} */ fn) => { on[name] = fn; return { dispose() {} }; };
  // The build-file record (server-status.js, J6 pass 3) is a JSON file beside the `-data`, as
  // the editor's is in workspaceState beside redhat.java's workspace storage.
  const recordFile = `${options.dataDir.replace(/\/$/, '')}.build-file-record.json`;
  const javaServerStatus = createJavaServerStatus({
    api: { serverMode: 'Standard', serverReady: () => serverReady, onDidProjectsImport: handler('imported'), onDidClasspathUpdate: handler('classpath') },
    watch: () => ({ onDidChange: handler('buildFile'), onDidCreate: handler('buildFileCreated'), onDidDelete: handler('buildFileDeleted'), dispose() {} }),
    diagnostics: () => [...projectDiagnostics].map(([uri, list]) => [{ path: uri, fsPath: fileURLToPath(uri) }, list]),
    buildFiles: {
      folders: () => [options.repo],
      store: {
        get: () => { try { return JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { return undefined; } },
        set: (/** @type {any} */ record) => fs.writeFileSync(recordFile, JSON.stringify(record)),
      },
    },
  });
  eventListeners.push((/** @type {any} */ params) => {
    if (params.eventType === 200 || params.eventType === 100) importEvents.push({ eventType: params.eventType, msFromReady: readyAt ? Date.now() - readyAt : null });
  });
  eventListeners.push((/** @type {any} */ params) => {
    if (params.eventType === 200 && on.imported) on.imported(params.data);
    if (params.eventType === 100 && on.classpath) on.classpath(params.data);
  });
  const buildFilesChanged = () => { if (on.buildFile) on.buildFile(); };
  return { ...services, start, waitQuiet, javaServerStatus, buildFilesChanged, importEvents, progressEvents, readyAt: () => readyAt, recordFile };
}

module.exports = { createJdtlsServices, DEFAULT_TOOLS };
