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

const DEFAULT_TOOLS = '/Users/salah/Projects/impact-tree-scratchpad/java-tools';
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
  const openTokens = new Set();
  const services = createStdioServerServices({
    repo: options.repo, command, args, env, languageId: 'java',
    deadlineMs: options.deadlineMs || 120000,
    ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
    onNotification: (method, params) => {
      if (method === 'language/status' && params && params.type === 'ServiceReady') ready = true;
      if (method === '$/progress' && params && params.value) {
        if (params.value.kind === 'begin') openTokens.add(params.token);
        if (params.value.kind === 'end') openTokens.delete(params.token);
      }
    },
  });
  const javaSettings = {
    java: {
      configuration: { maven: { userSettings: settingsXml, globalSettings: settingsXml } },
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
  return { ...services, start };
}

module.exports = { createJdtlsServices, DEFAULT_TOOLS };
