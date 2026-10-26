'use strict';

/**
 * J0 spike: what Eclipse JDT LS (jdtls) gives us on google/gson, answered through the
 * harness's LSP client.
 *
 *   node test/lsp-harness/j0-spike.js --repo <gson clone> --tools <java-tools dir> [--cold] [--no-switch] [--switch-only]
 *
 * `--tools` holds jdk25/<jdk>/Contents/Home (or env J0_JDK = a JAVA_HOME), jdtls/, m2/ and the scratch dirs (see TOOLS
 * below); the env vars J0_REPO / J0_TOOLS work too. `--cold` empties the -data workspace
 * first. Reads files in the clone and never writes there, except for the branch-switch
 * step, which checks out an older commit (detached) and restores the starting branch.
 * Never runs the clone's scripts. Writes a scratch Maven project (records, default methods)
 * and a base-side copy under the tools dir. Report on stdout, progress on stderr. The run
 * is bounded by OVERALL_DEADLINE_MS; jdtls is killed on exit.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { LspClient } = require('./lsp-client');
const { offsetToPosition, positionToOffset, SYMBOL_KINDS } = require('./stdio-server-services');

const OVERALL_DEADLINE_MS = 10 * 60 * 1000;
const READY_DEADLINE_MS = 6 * 60 * 1000;
const REQUEST_DEADLINE_MS = 2 * 60 * 1000;
const GIT_DEADLINE_MS = 30000;
const SWITCH_DEADLINE_MS = 3 * 60 * 1000;
const POLL_MS = 500;
const WARM_QUERIES = 7;
/** First-parent commits back from the starting branch for the branch-switch step. */
const SWITCH_BACK = 40;

const startedAt = Date.now();
const report = [];
/** @param {string} line */
function say(line = '') { report.push(line); process.stdout.write(`${line}\n`); }
/** @param {string} line */
function progress(line) { process.stderr.write(`[j0 ${stamp()}] ${line}\n`); }
function stamp() { return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`; }
/** @param {number} ms */
function fmt(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`; }
/** @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/** @param {() => Promise<any>} fn */
async function timed(fn) {
  const t0 = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
  } catch (error) {
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, error };
  }
}
/** @param {string} cwd @param {string[]} args @returns {Promise<string>} */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_DEADLINE_MS, maxBuffer: 32 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}
/** @param {string} p */
function uriOf(p) { return pathToFileURL(p).href; }

/** Scratch sources for constructs gson's main code lacks (records, default methods). */
const SCRATCH_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>j0</groupId><artifactId>scratch</artifactId><version>1</version>
  <properties><maven.compiler.release>21</maven.compiler.release></properties>
</project>
`;
const SCRATCH_JAVA = `package demo;

import java.util.List;
import java.util.Map;

/** A record. */
public record Point(int x, int y) {
  /** Compact constructor. */
  public Point {
    if (x < 0) throw new IllegalArgumentException();
  }
  public Point(int both) { this(both, both); }
  static Point origin() { return new Point(0, 0); }
}

interface Shape {
  double area();
  /** A default method. */
  default String describe(String prefix, int... extra) { return prefix + area(); }
  static Shape unit() { return () -> 1.0; }
}

class Generic<T extends Comparable<T>> {
  <K, V> Map<K, List<V>> group(List<? extends V> items, java.util.function.Function<V, K> key, T[] arr, int[][] grid) { return null; }
  void inner() {
    Runnable r = () -> System.out.println("x");
    Object o = new Object() { @Override public String toString() { return "anon"; } };
    class Local { void m() {} }
  }
  @Deprecated
  @SuppressWarnings("unchecked")
  final synchronized void annotated(final @Deprecated String s) {}
}
`;

/** The jdtls command line: the launcher jar with the copied macOS config and a -data dir. */
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
      // Keeps m2e's and jdtls' per-user files (~/.m2, ~/.eclipse) inside the tools dir.
      `-Duser.home=${path.join(tools, 'home')}`, `-Dmaven.repo.local=${path.join(tools, 'm2')}`,
      '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
      '-jar', path.join(jdtls, 'plugins', launcher), '-configuration', config, '-data', dataDir,
    ],
    env: { ...process.env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}:${process.env.PATH}` },
  };
}
/** @param {string} tools */
function jdkHome(tools) {
  if (process.env.J0_JDK) return process.env.J0_JDK;
  // jdtls 1.5x+ needs Java 25 to run (J0 found); the JDK 21 under jdk/ stays for builds.
  const dir = path.join(tools, 'jdk25');
  const jdk = fs.readdirSync(dir).find((d) => d.startsWith('jdk-'));
  if (!jdk) throw new Error(`no jdk-* in ${dir}`);
  return path.join(dir, jdk, 'Contents', 'Home');
}

/**
 * Starts jdtls, initializes and waits for ServiceReady and the end of all progress.
 * @returns {Promise<{ client: LspClient, events: any[], timings: Record<string, number> }>}
 */
async function startJdtls({ tools, dataDir, roots, settingsXml, label }) {
  const t0 = Date.now();
  const events = [];
  const openTokens = new Set();
  let ready = null;
  let resolveReady;
  const readyPromise = new Promise((r) => { resolveReady = r; });
  const { command, args, env } = jdtlsCommand(tools, dataDir);
  const client = new LspClient({
    command, args, env, cwd: tools,
    onNotification: (method, params) => {
      const t = Date.now() - t0;
      if (method === 'language/status') {
        events.push({ t, what: `status ${params.type}: ${params.message}` });
        if (params.type === 'ServiceReady' && ready === null) { ready = t; resolveReady(); }
      } else if (method === '$/progress' && params && params.value) {
        const v = params.value;
        if (v.kind === 'begin') { openTokens.add(params.token); events.push({ t, what: `progress begin ${v.title || ''} ${v.message || ''}`.trim() }); }
        if (v.kind === 'end') { openTokens.delete(params.token); events.push({ t, what: `progress end ${v.message || ''}`.trim() }); }
      } else if (method === 'language/progressReport') {
        if (params.complete) events.push({ t, what: `progressReport done: ${params.task}` });
      } else if (method === 'window/showMessage' || method === 'language/eventNotification') {
        events.push({ t, what: `${method}: ${JSON.stringify(params).slice(0, 200)}` });
      } else if (method === 'window/logMessage' && params.type === 1) {
        events.push({ t, what: `log error: ${String(params.message).slice(0, 160)}` });
      }
    },
  });
  client.requestHandlers['workspace/configuration'] = (p) => (p.items || []).map(() => null);
  const javaSettings = {
    java: {
      configuration: { maven: { userSettings: settingsXml, globalSettings: settingsXml } },
      import: { gradle: { enabled: false }, maven: { enabled: true } },
      autobuild: { enabled: true },
      maven: { downloadSources: false },
      references: { includeDecompiledSources: false },
    },
  };
  const init = await client.request('initialize', {
    processId: process.pid,
    clientInfo: { name: 'impact-tree-lsp-harness', version: '0' },
    rootUri: uriOf(roots[0]),
    workspaceFolders: roots.map((r) => ({ uri: uriOf(r), name: path.basename(r) })),
    initializationOptions: {
      workspaceFolders: roots.map(uriOf),
      settings: javaSettings,
      extendedClientCapabilities: { progressReportProvider: false, classFileContentsSupport: false },
    },
    capabilities: {
      window: { workDoneProgress: true },
      workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } },
      textDocument: {
        synchronization: { didSave: false },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        callHierarchy: { dynamicRegistration: false },
        references: {},
      },
    },
  }, READY_DEADLINE_MS);
  const initMs = Date.now() - t0;
  client.notify('initialized', {});
  client.notify('workspace/didChangeConfiguration', { settings: javaSettings });
  progress(`${label}: initialize returned after ${fmt(initMs)}; waiting for ServiceReady`);
  let readyTimer;
  try {
    await Promise.race([readyPromise, new Promise((_, rej) => { readyTimer = setTimeout(() => rej(new Error(`${label}: no ServiceReady within ${READY_DEADLINE_MS} ms`)), READY_DEADLINE_MS); })]);
  } finally {
    clearTimeout(readyTimer);
  }
  progress(`${label}: ServiceReady after ${fmt(ready)}`);
  // Builds may still run after ServiceReady; wait until no progress token is open (bounded).
  const quietDeadline = Date.now() + READY_DEADLINE_MS;
  while (openTokens.size > 0 && Date.now() < quietDeadline) await new Promise((r) => setTimeout(r, POLL_MS));
  const quiet = Date.now() - t0;
  progress(`${label}: progress quiet after ${fmt(quiet)} (${openTokens.size} token(s) still open)`);
  return { client, events, t0, timings: { init: initMs, ready, quiet }, capabilities: init.capabilities };
}

/** @param {any[]} syms @param {string} text @param {number} depth @param {string[]} out @param {(s: any) => boolean} [filter] */
function dumpTree(syms, text, depth, out, filter) {
  for (const s of syms || []) {
    if (!filter || filter(s) || depth === 0) {
      const lines = text.split('\n');
      const startLine = lines[s.range.start.line] || '';
      const sel = sliceRange(text, s.selectionRange);
      out.push(`${'  '.repeat(depth + 2)}${SYMBOL_KINDS[s.kind]} ${JSON.stringify(s.name)} detail=${JSON.stringify(s.detail)} range=L${s.range.start.line + 1}-L${s.range.end.line + 1} starts=${JSON.stringify(startLine.trim().slice(0, 28))} sel=${JSON.stringify(sel)}`);
    }
    dumpTree(s.children, text, depth + 1, out, filter);
  }
}
/** @param {string} text @param {{ start: any, end: any }} r */
function sliceRange(text, r) { return text.slice(positionToOffset(text, r.start), positionToOffset(text, r.end)); }
/** @param {any[]} syms @param {string} prefix @param {string[]} out */
function flatNames(syms, prefix, out) {
  for (const s of syms || []) {
    const key = `${prefix}${s.name}`;
    out.push(`${SYMBOL_KINDS[s.kind]}:${key}`);
    flatNames(s.children, `${key}.`, out);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, env) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : process.env[env]; };
  const repo = opt('--repo', 'J0_REPO');
  const tools = opt('--tools', 'J0_TOOLS');
  const cold = argv.includes('--cold');
  const doSwitch = !argv.includes('--no-switch');
  // J5: only the import and the branch switch (warm `-data`), for the freshness check.
  const switchOnly = argv.includes('--switch-only');
  if (!repo || !tools || !path.isAbsolute(repo) || !path.isAbsolute(tools)) {
    throw new Error('usage: node j0-spike.js --repo <abs gson clone> --tools <abs java-tools dir> [--cold] [--no-switch] [--switch-only]');
  }
  const dataDir = path.join(tools, 'jdtls-data', opt('--data-name', 'J0_DATA_NAME') || 'gson');
  const m2 = path.join(tools, 'm2');
  const settingsXml = path.join(tools, 'maven-settings.xml');
  fs.mkdirSync(m2, { recursive: true });
  fs.writeFileSync(settingsXml, `<settings><localRepository>${m2}</localRepository></settings>\n`);
  const scratch = path.join(tools, 'scratch-proj');
  fs.mkdirSync(path.join(scratch, 'src/main/java/demo'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'pom.xml'), SCRATCH_POM);
  fs.writeFileSync(path.join(scratch, 'src/main/java/demo/Point.java'), SCRATCH_JAVA);
  if (cold) fs.rmSync(dataDir, { recursive: true, force: true });
  const startBranch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (startBranch === 'HEAD') throw new Error('the clone is on a detached HEAD; check out its default branch first');
  if ((await git(repo, ['status', '--porcelain'])).trim()) throw new Error('the clone has local changes; refusing to switch branches');
  const head = (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim();
  const javaVersion = await new Promise((resolve) => execFile(path.join(jdkHome(tools), 'bin', 'java'), ['-version'], (e, o, er) => resolve(String(er).split('\n')[1] || '')));
  const jdtlsJar = fs.readdirSync(path.join(tools, 'jdtls', 'plugins')).find((f) => f.startsWith('org.eclipse.jdt.ls.core_'));
  say('# J0 spike measurements');
  say(`machine: ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0].model}, ${os.cpus().length} cpus, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB`);
  say(`java: ${javaVersion.trim()}; jdtls: ${jdtlsJar}; node ${process.version}`);
  say(`repo ${repo} @ ${startBranch} ${head}; -data ${dataDir} (${cold ? 'emptied: cold' : 'kept'}); m2 ${m2}`);
  say('');

  let current = null;
  const killTimer = setTimeout(() => {
    progress('OVERALL DEADLINE HIT: killing jdtls and failing');
    if (current) current.client.proc.kill('SIGKILL');
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 2000);
  }, OVERALL_DEADLINE_MS);
  const roots = [repo, scratch];
  try {
    // ---- 4a. import ----------------------------------------------------------
    current = await startJdtls({ tools, dataDir, roots, settingsXml, label: cold ? 'cold' : 'warm-1' });
    const c = current.client;
    const file = (p) => (path.isAbsolute(p) ? p : path.join(repo, p));
    const read = (p) => fs.readFileSync(file(p), 'utf8');
    const opened = new Set();
    const open = (abs, text) => {
      const uri = uriOf(abs);
      if (!opened.has(uri)) { c.didOpen({ uri, languageId: 'java', text }); opened.add(uri); }
      return uri;
    };
    const symbolsOf = (uri) => c.request('textDocument/documentSymbol', { textDocument: { uri } }, REQUEST_DEADLINE_MS);
    const gsonPath = 'gson/src/main/java/com/google/gson/Gson.java';
    const gsonText = read(gsonPath);
    const gsonUri = open(file(gsonPath), gsonText);
    const first = await timed(() => symbolsOf(gsonUri));
    if (first.error) throw first.error;
    say(`## 4. Timings (${cold ? 'cold' : 'warm'} start)`);
    say(`- initialize returned: ${fmt(current.timings.init)}; ServiceReady: ${fmt(current.timings.ready)}; no progress open: ${fmt(current.timings.quiet)}`);
    say(`- first documentSymbol (Gson.java) after quiet: ${fmt(first.ms)}; spawn to first symbols: ${fmt(current.timings.quiet + first.ms)}`);
    say('- jdtls events (ms since spawn):');
    for (const e of current.events.slice(0, 40)) say(`    ${String(e.t).padStart(7)}  ${e.what}`);
    if (current.events.length > 40) say(`    ... ${current.events.length - 40} more`);
    say(`- m2 after import: ${fs.readdirSync(m2).length} top-level entries; ~/.m2 exists: ${fs.existsSync(path.join(os.homedir(), '.m2'))}`);
    say('');

    const gb = 'gson/src/main/java/com/google/gson/';
    let w = c;
    let wFirst = first;
    if (!switchOnly) {
    // ---- 1. documentSymbol -----------------------------------------------------
    say('## 1. documentSymbol');
    const gsonSyms = first.value;
    const isHier = gsonSyms.length > 0 && 'selectionRange' in gsonSyms[0];
    say(`- Gson.java: ${isHier ? 'hierarchical DocumentSymbol' : 'flat SymbolInformation'}; top level: ${gsonSyms.map((s) => `${SYMBOL_KINDS[s.kind]} ${s.name}`).join(', ')}`);
    const gsonFlat = flatNames(gsonSyms, '', []);
    const kinds = {};
    for (const n of gsonFlat) { const k = n.split(':')[0]; kinds[k] = (kinds[k] || 0) + 1; }
    say(`- Gson.java kinds (all depths): ${JSON.stringify(kinds)}`);
    const out = [];
    dumpTree(gsonSyms, gsonText, 0, out, (s) => /^(toJson|fromJson|Gson|getAdapter|getDelegateAdapter|doubleAdapter|longAdapter|atomicLongAdapter|new |<lambda|lambda|read|write)/.test(s.name) || SYMBOL_KINDS[s.kind] === 'Class' || SYMBOL_KINDS[s.kind] === 'Constructor');
    say('- Gson.java selected symbols (kind name detail range starts sel):');
    for (const l of out) say(l);
    for (const p of [
      'gson/src/main/java/com/google/gson/FieldNamingPolicy.java',
      'gson/src/main/java/com/google/gson/GsonBuilder.java',
      'gson/src/main/java/com/google/gson/reflect/TypeToken.java',
      'gson/src/test/java/com/google/gson/functional/Java17RecordTest.java',
    ]) {
      const text = read(p);
      const r = await timed(() => symbolsOf(open(file(p), text)));
      if (r.error) { say(`- ${p}: ERROR ${r.error.message}`); continue; }
      const lines = [];
      const filter = /GsonBuilder|TypeToken/.test(p) ? (s) => /\.\.\.|\[\]|excludeFieldsWithModifiers|setExclusionStrategies|getParameterized|getArray|isAssignableFrom|TypeToken\(/.test(s.name) || SYMBOL_KINDS[s.kind] !== 'Method' : undefined;
      dumpTree(r.value, text, 0, lines, filter);
      say(`- ${p} (${fmt(r.ms)}, ${flatNames(r.value, '', []).length} symbols${filter ? ', filtered' : ''}):`);
      for (const l of lines.slice(0, 60)) say(l);
      if (lines.length > 60) say(`      ... ${lines.length - 60} more`);
    }
    const scratchFile = path.join(scratch, 'src/main/java/demo/Point.java');
    const sr = await timed(() => symbolsOf(open(scratchFile, SCRATCH_JAVA)));
    const sl = [];
    if (!sr.error) dumpTree(sr.value, SCRATCH_JAVA, 0, sl);
    say(`- scratch Point.java (records, default/static interface methods, generics, arrays, varargs, lambda, anonymous, local class, annotations) (${fmt(sr.ms)}):`);
    for (const l of sr.error ? [`ERROR ${sr.error.message}`] : sl) say(l);
    say('');

    // ---- 2. base side ----------------------------------------------------------
    say('## 2. Base side (a copy outside the project, untitled:)');
    const baseDir = path.join(tools, 'tmp-base');
    fs.mkdirSync(baseDir, { recursive: true });
    const baseFile = path.join(baseDir, 'Gson.java');
    fs.writeFileSync(baseFile, gsonText);
    const headNames = gsonFlat.join('\n');
    const evBase = current.events.length;
    for (const [label, uri] of [['file: copy outside the project', uriOf(baseFile)], ['untitled:', 'untitled:Gson.java'], ['untitled: (path-like)', `untitled:${baseDir}/Untitled-1.java`]]) {
      c.didOpen({ uri, languageId: 'java', text: gsonText });
      const r = await timed(() => symbolsOf(uri));
      const r2 = await timed(() => symbolsOf(uri));
      if (r.error) { say(`- ${label}: ERROR ${r.error.message} (${fmt(r.ms)})`); c.didClose(uri); continue; }
      const names = flatNames(r.value || [], '', []);
      const same = names.join('\n') === headNames;
      say(`- ${label}: ${r.value === null ? 'null' : `${names.length} symbols`} in ${fmt(r.ms)} (again ${fmt(r2.ms)}); names identical to the project file: ${same}`);
      if (!same && r.value) {
        const hs = new Set(gsonFlat);
        const bs = new Set(names);
        say(`    only in project: ${gsonFlat.filter((n) => !bs.has(n)).slice(0, 8).join(', ')}; only in copy: ${names.filter((n) => !hs.has(n)).slice(0, 8).join(', ')}`);
      }
      // Does a semantic request answer there? (non-project files are syntax only)
      const off = gsonText.indexOf('public String toJson(Object src) {') + 'public String '.length;
      const prep = await timed(() => c.request('textDocument/prepareCallHierarchy', { textDocument: { uri }, position: offsetToPosition(gsonText, off) }, REQUEST_DEADLINE_MS));
      if (prep.value && prep.value[0]) {
        const inc = await timed(() => c.request('callHierarchy/incomingCalls', { item: prep.value[0] }, REQUEST_DEADLINE_MS));
        say(`    incomingCalls from that item: ${inc.error ? inc.error.message : `${(inc.value || []).length} caller(s)`} (${fmt(inc.ms)}); ${(inc.value || []).slice(0, 3).map((x) => `${x.from.name}@${x.from.uri.replace(uriOf(repo) + '/', '')}`).join(', ')}`);
      }
      say(`    prepareCallHierarchy there: ${prep.error ? `error ${prep.error.message}` : prep.value === null ? 'null' : `${prep.value.length} item(s) ${prep.value.map((i) => `${i.name} detail=${JSON.stringify(i.detail)} uri=${i.uri.replace(repo, '<repo>')}`).join('; ')}`} (${fmt(prep.ms)})`);
      c.didClose(uri);
    }
    say(`- jdtls events during the base-side step: ${current.events.slice(evBase).map((e) => e.what).slice(0, 10).join(' | ') || '(none)'}`);
    say('');

    // ---- 3. call hierarchy -----------------------------------------------------
    say('## 3. Call hierarchy');
    /**
     * @param {string} label @param {string} relPath @param {string} anchor text before the name
     * @param {string} name @param {{ refs?: boolean, nth?: number }} [o]
     */
    async function callersOf(label, relPath, anchor, name, o = {}) {
      const text = read(relPath);
      const uri = open(file(relPath), text);
      let at = -1;
      for (let i = 0, from = 0; i <= (o.nth || 0); i++) { at = text.indexOf(anchor, from); from = at + 1; if (at < 0) break; }
      if (at < 0) { say(`- ${label}: anchor not found`); return null; }
      const pos = offsetToPosition(text, at + anchor.indexOf(name));
      const prep = await timed(() => c.request('textDocument/prepareCallHierarchy', { textDocument: { uri }, position: pos }, REQUEST_DEADLINE_MS));
      if (prep.error || !prep.value || prep.value.length === 0) { say(`- ${label}: prepare -> ${prep.error ? prep.error.message : JSON.stringify(prep.value)}`); return null; }
      const item = prep.value[0];
      const inc = await timed(() => c.request('callHierarchy/incomingCalls', { item }, REQUEST_DEADLINE_MS));
      if (inc.error) { say(`- ${label}: incoming error ${inc.error.message}`); return null; }
      const calls = inc.value || [];
      const where = calls.map((x) => `${x.from.name}${x.from.detail ? ` [${x.from.detail}]` : ''} @${x.from.uri.replace(uriOf(repo) + '/', '')}:${x.fromRanges.map((r) => r.start.line + 1).join('/')}`);
      say(`- ${label}: item ${JSON.stringify(item.name)} kind=${SYMBOL_KINDS[item.kind]} detail=${JSON.stringify(item.detail)}; ${calls.length} caller(s), ${calls.reduce((n, x) => n + x.fromRanges.length, 0)} call site(s) (prepare ${fmt(prep.ms)}, incoming ${fmt(inc.ms)})`);
      const modules = {};
      for (const x of calls) { const m = x.from.uri.replace(uriOf(repo) + '/', '').split('/src/')[0] + (x.from.uri.includes('/src/test/') ? ' (test)' : ''); modules[m] = (modules[m] || 0) + 1; }
      say(`    by module: ${JSON.stringify(modules)}`);
      for (const w of where.slice(0, 14)) say(`    ${w}`);
      if (where.length > 14) say(`    ... ${where.length - 14} more`);
      if (o.refs) {
        const refs = await timed(() => c.request('textDocument/references', { textDocument: { uri }, position: pos, context: { includeDeclaration: false } }, REQUEST_DEADLINE_MS));
        const locs = refs.value || [];
        const lines = locs.map((l) => `${l.uri.replace(uriOf(repo) + '/', '')}:${l.range.start.line + 1}`);
        say(`    references: ${refs.error ? refs.error.message : `${locs.length}`} (${fmt(refs.ms)}); method-reference sites (\`::${name}\`) among them: ${locs.filter((l) => { const t = fs.readFileSync(new URL(l.uri), 'utf8'); return t.slice(positionToOffset(t, l.range.start) - 2, positionToOffset(t, l.range.start)) === '::'; }).length}`);
        for (const l of lines.slice(0, 10)) say(`      ${l}`);
      }
      return { item, calls };
    }
    await callersOf('constructor Gson(GsonBuilder) [this( and new Gson(]', `${gb}Gson.java`, '  Gson(GsonBuilder builder)', 'Gson');
    await callersOf('constructor LinkedTreeMap(Comparator, boolean) [this( and new]', `${gb}internal/LinkedTreeMap.java`, 'public LinkedTreeMap(Comparator<? super K> comparator, boolean', 'LinkedTreeMap');
    await callersOf('constructor JsonParseException(String) [super( from subclasses]', `${gb}JsonParseException.java`, 'public JsonParseException(String msg)', 'JsonParseException');
    await callersOf('interface method TypeAdapterFactory.create', `${gb}TypeAdapterFactory.java`, '\n  <T> TypeAdapter<T> create(', 'create');
    await callersOf('abstract method TypeAdapter.write', `${gb}TypeAdapter.java`, 'public abstract void write(', 'write');
    await callersOf('override JsonTreeWriter.beginArray (overrides JsonWriter.beginArray)', `${gb}internal/bind/JsonTreeWriter.java`, 'public JsonWriter beginArray(', 'beginArray');
    await callersOf('base JsonWriter.beginArray', `${gb}stream/JsonWriter.java`, 'public JsonWriter beginArray(', 'beginArray');
    await callersOf('super.appendFields target TestTypes.Nested.appendFields (super. call in InheritanceTest)', 'gson/src/test/java/com/google/gson/common/TestTypes.java', 'public void appendFields(', 'appendFields');
    await callersOf('override InheritanceTest.SubTypeOfNested.appendFields (base calls appendFields(sb))', 'gson/src/test/java/com/google/gson/functional/InheritanceTest.java', 'public void appendFields(', 'appendFields');
    await callersOf('method reference JsonStreamParser.next (parser::next in tests)', `${gb}JsonStreamParser.java`, 'public JsonElement next(', 'next', { refs: true });
    await callersOf('method reference JsonElement.isJsonNull (JsonElement::isJsonNull)', `${gb}JsonElement.java`, 'public boolean isJsonNull(', 'isJsonNull', { refs: true });
    await callersOf('Gson.getDelegateAdapter (callers in extras, tests)', `${gb}Gson.java`, 'public <T> TypeAdapter<T> getDelegateAdapter(', 'getDelegateAdapter');
    await callersOf('overload Gson.toJson(Object, Appendable)', `${gb}Gson.java`, 'public void toJson(Object src, Appendable writer)', 'toJson');
    await callersOf('scratch: record canonical constructor Point(int, int) [this( and new]', scratchFile, 'public record Point(', 'Point');
    await callersOf('scratch: interface Shape.area (called from default method)', scratchFile, 'double area()', 'area');
    say('');

    // ---- 4b. per-query timings --------------------------------------------------
    say('## 4b. Per-query times after warm-up (median of ' + WARM_QUERIES + ')');
    const perQuery = async (label, fn) => {
      const ms = [];
      for (let i = 0; i < WARM_QUERIES; i++) { const r = await timed(fn); if (r.error) { say(`- ${label}: error ${r.error.message}`); return; } ms.push(r.ms); }
      say(`- ${label}: median ${fmt(median(ms))} (min ${fmt(Math.min(...ms))}, max ${fmt(Math.max(...ms))})`);
    };
    const tjPos = offsetToPosition(gsonText, gsonText.indexOf('public void toJson(Object src, Appendable writer)') + 'public void '.length);
    await perQuery('documentSymbol Gson.java', () => symbolsOf(gsonUri));
    const builderUri = uriOf(file(`${gb}GsonBuilder.java`));
    await perQuery('documentSymbol GsonBuilder.java', () => symbolsOf(builderUri));
    await perQuery('prepareCallHierarchy toJson(Object, Appendable)', () => c.request('textDocument/prepareCallHierarchy', { textDocument: { uri: gsonUri }, position: tjPos }, REQUEST_DEADLINE_MS));
    const tjItem = (await c.request('textDocument/prepareCallHierarchy', { textDocument: { uri: gsonUri }, position: tjPos }, REQUEST_DEADLINE_MS))[0];
    await perQuery('incomingCalls toJson(Object, Appendable)', () => c.request('callHierarchy/incomingCalls', { item: tjItem }, REQUEST_DEADLINE_MS));
    const gaPos = offsetToPosition(gsonText, gsonText.indexOf('public <T> TypeAdapter<T> getAdapter(TypeToken<T> type)') + 'public <T> TypeAdapter<T> '.length);
    const gaItem = (await c.request('textDocument/prepareCallHierarchy', { textDocument: { uri: gsonUri }, position: gaPos }, REQUEST_DEADLINE_MS))[0];
    await perQuery(`incomingCalls getAdapter(TypeToken) (many callers)`, () => c.request('callHierarchy/incomingCalls', { item: gaItem }, REQUEST_DEADLINE_MS));
    say('');

    // ---- 4c. warm restart ------------------------------------------------------
    await c.close();
    progress('closed; restarting on the same -data (warm)');
    current = await startJdtls({ tools, dataDir, roots, settingsXml, label: 'warm' });
    w = current.client;
    w.didOpen({ uri: gsonUri, languageId: 'java', text: gsonText });
    wFirst = await timed(() => w.request('textDocument/documentSymbol', { textDocument: { uri: gsonUri } }, REQUEST_DEADLINE_MS));
    const wPrep = await timed(() => w.request('textDocument/prepareCallHierarchy', { textDocument: { uri: gsonUri }, position: tjPos }, REQUEST_DEADLINE_MS));
    const wInc = wPrep.value ? await timed(() => w.request('callHierarchy/incomingCalls', { item: wPrep.value[0] }, REQUEST_DEADLINE_MS)) : { ms: 0, value: null };
    say('## 4c. Warm restart (same -data)');
    say(`- initialize: ${fmt(current.timings.init)}; ServiceReady: ${fmt(current.timings.ready)}; quiet: ${fmt(current.timings.quiet)}`);
    say(`- first documentSymbol: ${fmt(wFirst.ms)}; first prepare+incoming toJson(Object, Appendable): ${fmt(wPrep.ms)} + ${fmt(wInc.ms)} -> ${(wInc.value || []).length} caller(s)`);
    say('- events:');
    for (const e of current.events.slice(0, 25)) say(`    ${String(e.t).padStart(7)}  ${e.what}`);
    say('');

    }

    // ---- 4d. branch switch -----------------------------------------------------
    if (doSwitch) {
      say('## 4d. Branch switch');
      const target = (await git(repo, ['rev-parse', `HEAD~${SWITCH_BACK}`])).trim();
      const changed = (await git(repo, ['diff', '--name-only', 'HEAD', target])).trim().split('\n').filter(Boolean);
      const javaChanged = changed.filter((f) => f.endsWith('.java'));
      const pomsChanged = changed.filter((f) => f.endsWith('pom.xml'));
      // The probe file: the changed main-code file whose line count moves most, so stale
      // symbol ranges cannot pass for fresh ones.
      let probe = null;
      for (const f of javaChanged.filter((x) => x.includes('/src/main/') && fs.existsSync(file(x)))) {
        let old;
        try { old = await git(repo, ['show', `${target}:${f}`]); } catch { continue; }
        const delta = Math.abs(old.split('\n').length - read(f).split('\n').length);
        if (!probe || delta > probe.delta) probe = { f, old, delta };
      }
      if (!probe) throw new Error('no changed main-code .java file to probe the branch switch');
      const probeUri = uriOf(file(probe.f));
      const probeNow = read(probe.f);
      const snap = (v) => JSON.stringify(flatNames(v, '', [])) + JSON.stringify((function sel(ss) { return ss.map((x) => [x.selectionRange, sel(x.children || [])]); })(v));
      const beforeProbe = snap(await w.request('textDocument/documentSymbol', { textDocument: { uri: probeUri } }, REQUEST_DEADLINE_MS));
      const oldGson = await git(repo, ['show', `${target}:${gsonPath}`]);
      say(`- checkout HEAD~${SWITCH_BACK} = ${target.slice(0, 10)}: ${changed.length} files differ (${javaChanged.length} .java, ${pomsChanged.length} pom.xml); probe file ${probe.f} (line count differs by ${probe.delta}, ${probeNow.length} -> ${probe.old.length} chars)`);
      // An editor keeps the document open; the harness closes it so the server reads disk.
      w.didClose(gsonUri);
      const before = flatNames(wFirst.value, '', []).join('\n');
      // The call-hierarchy targets of the freshness check (J5): the callers of each, as they
      // stand before the switch, so an answer that merely equals the old one is visible.
      const TARGETS = [
        { name: 'getAdapter(TypeToken)', needle: 'public <T> TypeAdapter<T> getAdapter(TypeToken<T> type)', skip: 'public <T> TypeAdapter<T> ' },
        { name: 'toJson(Object, Appendable)', needle: 'public void toJson(Object src, Appendable writer)', skip: 'public void ' },
      ];
      const relOf = (u) => u.replace(uriOf(repo) + '/', '');
      const locationsOf = (calls) => calls.flatMap((x) => x.fromRanges.map((rg) => `${relOf(x.from.uri)}:${rg.start.line + 1}:${rg.start.character}`)).sort();
      const askAt = async (client, text, tgt) => {
        const at = text.indexOf(tgt.needle);
        if (at < 0) return null;
        const pos = offsetToPosition(text, at + tgt.skip.length);
        const prep = await timed(() => client.request('textDocument/prepareCallHierarchy', { textDocument: { uri: gsonUri }, position: pos }, REQUEST_DEADLINE_MS));
        if (prep.error || !prep.value || !prep.value[0]) return null;
        const inc = await timed(() => client.request('callHierarchy/incomingCalls', { item: prep.value[0] }, REQUEST_DEADLINE_MS));
        return inc.error ? null : (inc.value || []);
      };
      const preSets = {};
      for (const tgt of TARGETS) { const a = await askAt(w, gsonText, tgt); preSets[tgt.name] = a ? locationsOf(a) : null; say(`- before the switch: ${tgt.name} has ${preSets[tgt.name] ? preSets[tgt.name].length : 'no'} call site(s)`); }
      const tSwitch = Date.now();
      try {
        await git(repo, ['checkout', '-q', target]);
        const changes = changed.map((f) => ({ uri: uriOf(file(f)), type: fs.existsSync(file(f)) ? 2 : 3 }));
        w.notify('workspace/didChangeWatchedFiles', { changes });
        const tNotified = Date.now() - tSwitch;
        // Symbols reflect the change when every method's selectionRange spells its name in the old text.
        let symsOk = null;
        const deadline = Date.now() + SWITCH_DEADLINE_MS;
        while (Date.now() < deadline) {
          const r = await timed(() => w.request('textDocument/documentSymbol', { textDocument: { uri: probeUri } }, REQUEST_DEADLINE_MS));
          if (!r.error && r.value) {
            const consistent = (function check(ss) { return ss.every((s) => { const t = sliceRange(probe.old, s.selectionRange); return (s.name.startsWith(t) || t.startsWith('package ')) && check(s.children || []); }); })(r.value);
            if (consistent && snap(r.value) !== beforeProbe) { symsOk = Date.now() - tSwitch; break; }
          }
          await new Promise((res) => setTimeout(res, POLL_MS));
        }
        void before;
        say(`- didChangeWatchedFiles sent ${fmt(tNotified)} after checkout; documentSymbol (probe file, not open, from disk) matches the old text after ${symsOk === null ? 'NEVER within deadline' : fmt(symsOk)}`);
        // Call hierarchy in the target tree. J0's check (each range's text spells the method
        // name) never passed: jdtls' `fromRanges` are the whole call expression (`toJson(src,
        // writer)`), not the name. The check is now the stronger one: the warm server's answer
        // equals that of a fresh jdtls (new `-data`) started on the same tree after the
        // switch, location for location, and each range's text starts with the method's name.
        const startsWithName = (calls, name) => calls.every((x) => x.fromRanges.every((rg) => sliceRange(fs.readFileSync(new URL(x.from.uri), 'utf8'), rg).startsWith(name)));
        const freshData = path.join(tools, 'jdtls-data', 'switch-fresh');
        fs.rmSync(freshData, { recursive: true, force: true });
        const freshStart = Date.now();
        let fresh = null;
        startJdtls({ tools, dataDir: freshData, roots, settingsXml, label: 'fresh-at-target' }).then((f) => { fresh = f; }, () => {});
        const expected = {};
        for (const tgt of TARGETS) {
          const bare = tgt.name.slice(0, tgt.name.indexOf('('));
          let chOk = null;
          let lastWarm = null;
          let polls = 0;
          let firstSeen = null;
          let firstDiff = null;
          while (Date.now() < deadline) {
            if (fresh && !(tgt.name in expected)) {
              const answer = await askAt(fresh.client, oldGson, tgt);
              expected[tgt.name] = answer ? locationsOf(answer) : null;
              say(`- fresh jdtls (new -data) at the target tree: ${tgt.name} has ${expected[tgt.name] ? expected[tgt.name].length : 'no'} call site(s), asked ${fmt(Date.now() - tSwitch)} after checkout (fresh server started ${fmt(freshStart - tSwitch)} after it); names ok: ${answer ? startsWithName(answer, bare) : 'n/a'}; differs from before the switch: ${JSON.stringify(expected[tgt.name]) !== JSON.stringify(preSets[tgt.name])}`);
            }
            const calls = await askAt(w, oldGson, tgt);
            if (calls) {
              lastWarm = locationsOf(calls);
              if (firstSeen === null) firstSeen = Date.now() - tSwitch;
              const same = JSON.stringify(lastWarm) === JSON.stringify(preSets[tgt.name]);
              if (!same && firstDiff === null) firstDiff = Date.now() - tSwitch;
              if (polls++ < 8 || (!same && polls < 12)) say(`    poll ${polls}: ${tgt.name} ${lastWarm.length} call site(s) at ${fmt(Date.now() - tSwitch)}; equals the pre-switch set: ${same}`);
              if (expected[tgt.name] && JSON.stringify(lastWarm) === JSON.stringify(expected[tgt.name])) { chOk = Date.now() - tSwitch; break; }
            }
            await new Promise((res) => setTimeout(res, POLL_MS));
          }
          say(`- ${tgt.name}: the warm server's answer equals the fresh server's after ${chOk === null ? 'NEVER within deadline' : fmt(chOk)} (first answer ${firstSeen === null ? 'never' : fmt(firstSeen)}; first answer that differs from the pre-switch one ${firstDiff === null ? 'never' : fmt(firstDiff)}; last ${lastWarm ? lastWarm.length : 'no'} call site(s); fresh ${expected[tgt.name] ? expected[tgt.name].length : 'none'})`);
          if (chOk === null && lastWarm && expected[tgt.name]) say(`    only in warm: ${lastWarm.filter((x) => !expected[tgt.name].includes(x)).slice(0, 6).join(', ')}; only in fresh: ${expected[tgt.name].filter((x) => !lastWarm.includes(x)).slice(0, 6).join(', ')}`);
        }
        try { if (fresh) fresh.client.proc.kill('SIGKILL'); } catch { /* already gone */ }
        say(`- events since checkout: ${current.events.filter((e) => e.t >= tSwitch - current.t0).map((e) => `${e.t - (tSwitch - current.t0)}ms ${e.what}`).slice(0, 12).join(' | ') || '(none)'}`);
      } finally {
        await git(repo, ['checkout', '-q', startBranch]);
        w.notify('workspace/didChangeWatchedFiles', { changes: changed.map((f) => ({ uri: uriOf(file(f)), type: fs.existsSync(file(f)) ? 2 : 3 })) });
        progress(`restored ${startBranch}`);
      }
      say('');
    }
    await w.close();
    current = null;
    say(`total wall time: ${fmt(Date.now() - startedAt)}; ~/.m2 exists: ${fs.existsSync(path.join(os.homedir(), '.m2'))}`);
  } finally {
    clearTimeout(killTimer);
    if (current) { current.client.proc.kill('SIGKILL'); }
  }
}

main().catch((err) => {
  progress(`FAILED: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
