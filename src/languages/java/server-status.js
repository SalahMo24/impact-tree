// @ts-check
'use strict';
// What the editor can see of the Java language server's project import, from the API that
// Language Support for Java (redhat.java) exports: `serverMode` and `onDidServerModeChange`
// (Standard once the projects are imported; LightWeight imports none; Hybrid while the
// Standard server starts), `serverReady()` (resolves once the first import is done) and
// `onDidProjectsImport` / `onDidClasspathUpdate` (fired when an import or a classpath update
// ends). The API has no "import started" event, so a changed build file (pom.xml, Gradle
// files) is that signal: from it until the next import event, Java caller answers read
// incomplete. With `updateBuildConfiguration: interactive` and its prompt unanswered no import
// follows, and the answers stay incomplete: the projects are still the old build file's.
//
// Also seen: a project whose build path jdtls reports as broken, through the diagnostics it
// publishes on the project folder (J6 pass 2, #1904: the root pom's `java.version` 1.6 gave
// extras/metrics/proto/codegen "Build path specifies execution environment JavaSE-1.6. There
// are no JREs installed in the workspace that are strictly compatible with this environment",
// and none of their calls was listed, even calls inside extras itself). Every Java answer then
// reads incomplete: a caller may sit in that project.
//
// A build file changed while the server was not running (J6 pass 3): jdtls starts from a
// `-data` imported at another state, reports ready, then re-imports for ~14 s (run 3, #1700
// from #2944's `-data`), and no API signal says so. So the status keeps a record of the build
// files' contents at the last import it saw end, and compares (`buildFiles` below):
// - **What is recorded:** a SHA-256 over every build file's path (relative to its workspace
//   folder) and content, folders sorted (`stampBuildFiles`). Content, not mtime: a switch that
//   goes away and back rewrites a file but not what jdtls imported.
// - **Where:** `buildFiles.store` (the editor: the extension's `workspaceState`, key
//   BUILD_FILE_RECORD_KEY, given by `setEditorJavaBuildFileStore` at activation; the harness: a
//   JSON file beside its `-data`). Format `{ version: 1, stamp }`; anything else is no record.
// - **When written:** at every `onDidProjectsImport` / `onDidClasspathUpdate` after
//   `serverReady()` resolved, with the files as they are then (an import that ends reflects
//   them; a later change is the watcher's). Events before ready are not recorded: jdtls may
//   still be on the old `-data`.
// - **When compared:** when the status is made and again when `serverReady()` resolves. A
//   different stamp, or no record (first run), makes Java answers incomplete
//   (BUILD_FILE_SINCE_IMPORT_REASON / BUILD_FILE_FIRST_REASON) until the next import event
//   after ready.
// - **Deadline:** IMPORT_CONFIRM_DEADLINE_MS (120 000 ms from ready, on the injected clock) for
//   that event; after it, answers stay incomplete, saying the re-import was not confirmed. Only
//   an import event ends it (e.g. "Java: Reload Projects"). Residual: an import that ended
//   before the status existed is not seen, so such a window stays incomplete until the next.
// - **Caps (CODING_STYLE §2), owner `stampBuildFiles`, checked before each admission:**
//   BUILD_FILE_LIMITS: 200 build files, depth 24 below a folder (Java source trees are deep: gson's are 12+), 5000 folders read, 1 MiB per
//   build file; `target/`, `build/`, `node_modules/`, `out/` and dot-folders (`.git/`) are
//   skipped. A cap reached, or a read failing, means the files are not known: incomplete
//   (BUILD_FILES_UNKNOWN_REASON) until an import event after ready. The walk is synchronous
//   (a few ms on gson); the folder cap bounds it.
//
// Owner: one per resolver (Java's editor extras); its listeners go to `own` (the editor
// passes nothing to keep them: they live as long as the window). Never throws: an API that
// is missing or fails reads as "not known", never as busy forever.

const fs = require('fs');
const path = require('path');
const { realClock } = require('../../engine/clock');

/** @param {string} folder */
const defaultHasBuildFile = (folder) => BUILD_FILE_NAMES.some((f) => { try { return fs.statSync(path.join(folder, f)).isFile(); } catch { return false; } });

const IMPORTING_REASON = 'the Java language server was still importing the project';
const LIGHTWEIGHT_REASON = 'the Java language server is in lightweight mode, which imports no project';
const BUILD_FILE_REASON = 'a build file changed and the Java language server had not re-imported the project yet';
const BUILD_FILES = '**/{pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts}';
// jdtls' project-level diagnostics that mean the project's calls are not listed: an execution
// environment of Java 6 or older, or an unbound or incomplete build path. Measured (J6 pass 2):
// at JavaSE-1.6 (#1904) jdtls listed none of the calls in those projects; at JavaSE-1.7
// (#2072, the same "no JREs strictly compatible" warning) it listed them all, so 1.7 and newer
// are not matched.
const BROKEN_BUILD_PATH = /Build path specifies execution environment (?:JavaSE-1\.[0-6]|J2SE-|JRE-1\.)\b|is missing required library|build path is incomplete|Unbound classpath container/i;
const BUILD_FILE_NAMES = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
const STAMPED_NAMES = new Set([...BUILD_FILE_NAMES, 'settings.gradle', 'settings.gradle.kts']);
const SKIPPED_DIRS = new Set(['target', 'build', 'node_modules', 'out']);
const BUILD_FILE_LIMITS = Object.freeze({ maxFiles: 200, maxDepth: 24, maxDirs: 5000, maxFileBytes: 1024 * 1024 });
const IMPORT_CONFIRM_DEADLINE_MS = 120000;
const BUILD_FILE_RECORD_KEY = 'impactTree.java.buildFileRecord';
const BUILD_FILE_SINCE_IMPORT_REASON = 'a build file changed since the Java language server last imported the project';
const BUILD_FILE_FIRST_REASON = 'no import of the project by the Java language server has been seen yet in this workspace';
const BUILD_FILES_UNKNOWN_REASON = 'the build files could not all be read';
const NOT_CONFIRMED = `; the re-import was not confirmed within ${IMPORT_CONFIRM_DEADLINE_MS / 1000} s`;

/**
 * The build files' stamp over `folders` (absolute paths), within `limits`.
 * @param {string[]} folders
 * @param {{ limits?: { maxFiles: number, maxDepth: number, maxDirs: number, maxFileBytes: number }, fsImpl?: any }} [options]
 * @returns {{ stamp: string, files: number } | { stamp: null, reason: string }}
 */
function stampBuildFiles(folders, { limits = BUILD_FILE_LIMITS, fsImpl = fs } = {}) {
  const crypto = require('crypto');
  /** @type {Array<[string, Buffer]>} */
  const found = [];
  let dirs = 0;
  try {
    for (const [index, folder] of [...folders].sort().entries()) {
      /** @type {Array<[string, number]>} */
      const queue = [[folder, 0]];
      while (queue.length) {
        const [dir, depth] = /** @type {[string, number]} */ (queue.shift());
        if (++dirs > limits.maxDirs) return { stamp: null, reason: `${BUILD_FILES_UNKNOWN_REASON} (more than ${limits.maxDirs} folders)` };
        for (const e of fsImpl.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name.startsWith('.') || SKIPPED_DIRS.has(e.name)) continue;
            if (depth + 1 > limits.maxDepth) return { stamp: null, reason: `${BUILD_FILES_UNKNOWN_REASON} (folders deeper than ${limits.maxDepth})` };
            queue.push([full, depth + 1]);
          } else if (e.isFile() && STAMPED_NAMES.has(e.name)) {
            if (found.length + 1 > limits.maxFiles) return { stamp: null, reason: `${BUILD_FILES_UNKNOWN_REASON} (more than ${limits.maxFiles} build files)` };
            if (fsImpl.statSync(full).size > limits.maxFileBytes) return { stamp: null, reason: `${BUILD_FILES_UNKNOWN_REASON} (${full} is over ${limits.maxFileBytes} bytes)` };
            found.push([`${index}:${path.relative(folder, full)}`, fsImpl.readFileSync(full)]);
          }
        }
      }
    }
  } catch (e) {
    return { stamp: null, reason: `${BUILD_FILES_UNKNOWN_REASON} (${String(/** @type {any} */ (e).message).slice(0, 120)})` };
  }
  const h = crypto.createHash('sha256');
  for (const [name, body] of found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) h.update(`${name}\0${body.length}\0`).update(body);
  return { stamp: h.digest('hex'), files: found.length };
}

/**
 * @typedef {object} JavaServerStatus
 * @property {() => string|null} busyReason Why answers taken now may miss callers, or null.
 * @property {() => number} epoch Moves at every import end or build-file change the editor sees.
 */

/**
 * @param {object} deps
 * @param {any} deps.api redhat.java's exported API (or a test double); null: not known.
 * @param {(glob: string) => any} [deps.watch] `vscode.workspace.createFileSystemWatcher`.
 * @param {() => Array<[{ fsPath: string, path: string }, Array<{ message: string }>]>} [deps.diagnostics]
 *   `vscode.languages.getDiagnostics()`.
 * @param {(d: { dispose(): void }) => void} [deps.own] Takes each disposable.
 * @param {(folder: string) => boolean} [deps.hasBuildFile] Whether a project folder still has
 *   its build file on disk: jdtls keeps a project (and its diagnostic) whose pom a checkout
 *   removed (J6: gson's `codegen` after #1904), and such a stale project is not counted.
 * @param {{ folders: () => string[], store: { get(): any, set(record: any): void },
 *   stamp?: (folders: string[]) => ({ stamp: string } | { stamp: null, reason: string }) }} [deps.buildFiles]
 *   The build-file check above; absent: off.
 * @param {import('../../engine/clock').Clock} [deps.clock] Times IMPORT_CONFIRM_DEADLINE_MS.
 * @returns {JavaServerStatus}
 */
function createJavaServerStatus({ api, watch, diagnostics, own = () => {}, hasBuildFile = defaultHasBuildFile, buildFiles, clock = realClock }) {
  let ready = !api || typeof api.serverReady !== 'function';
  let buildFileChanged = false;
  let epoch = 0;
  /** Why the build files may differ from the last import seen (the check above), or null. */
  /** @type {string|null} */
  let sinceImport = null;
  let deadlinePassed = false;
  /** @type {unknown} */
  let deadlineTimer = null;
  const bump = () => { epoch++; };
  /** Compares the build files with the record (at creation and at ready). */
  const check = () => {
    if (!buildFiles) return;
    const was = sinceImport;
    try {
      const now = (buildFiles.stamp || stampBuildFiles)(buildFiles.folders());
      const rec = buildFiles.store.get();
      const recorded = rec && rec.version === 1 && typeof rec.stamp === 'string' ? rec.stamp : null;
      // A mismatch found earlier stays until an import event: comparing again does not clear it.
      if (now.stamp === null) sinceImport = /** @type {{ reason: string }} */ (now).reason;
      else if (recorded === null) sinceImport = BUILD_FILE_FIRST_REASON;
      else if (recorded !== now.stamp) sinceImport = BUILD_FILE_SINCE_IMPORT_REASON;
    } catch (e) {
      sinceImport = `${BUILD_FILES_UNKNOWN_REASON} (${String(/** @type {any} */ (e).message).slice(0, 120)})`;
    }
    if (was !== sinceImport) bump();
    if (ready && sinceImport && !deadlineTimer) {
      deadlineTimer = clock.setTimeout(() => { if (sinceImport) { deadlinePassed = true; bump(); } }, IMPORT_CONFIRM_DEADLINE_MS);
      if (clock.unref) clock.unref(deadlineTimer);
    }
  };
  const imported = () => {
    buildFileChanged = false;
    if (buildFiles && ready) {
      try {
        const now = (buildFiles.stamp || stampBuildFiles)(buildFiles.folders());
        if (now.stamp !== null) buildFiles.store.set({ version: 1, stamp: now.stamp });
      } catch { /* not recorded: the next window compares with the older record (safe) */ }
      sinceImport = null;
      deadlinePassed = false;
      if (deadlineTimer) { clock.clearTimeout(deadlineTimer); deadlineTimer = null; }
    }
    bump();
  };
  check();
  if (api && typeof api.serverReady === 'function') {
    const done = () => { ready = true; check(); bump(); };
    Promise.resolve().then(() => api.serverReady()).then(done, done);
  }
  /** @param {any} event @param {(...a: any[]) => void} fn */
  const listen = (event, fn) => { try { if (typeof event === 'function') own(event(fn)); } catch { /* not known */ } };
  if (api) {
    listen(api.onDidProjectsImport, imported);
    listen(api.onDidClasspathUpdate, imported);
    listen(api.onDidServerModeChange, bump);
  }
  if (watch) {
    try {
      const w = watch(BUILD_FILES);
      own(w);
      const changed = () => { buildFileChanged = true; bump(); };
      for (const on of [w.onDidChange, w.onDidCreate, w.onDidDelete]) own(on.call(w, changed));
    } catch { /* no watcher: build-file changes are not seen */ }
  }
  /** @returns {string|null} */
  function brokenProject() {
    if (!diagnostics) return null;
    try {
      for (const [uri, list] of diagnostics()) {
        if (/\.java$/.test(uri.path)) continue;
        const d = list.find((x) => BROKEN_BUILD_PATH.test(x.message));
        if (d && !hasBuildFile(/\.(xml|gradle|kts)$/.test(uri.fsPath) ? path.dirname(uri.fsPath) : uri.fsPath)) continue;
        if (d) return `the Java language server reported a broken build path for ${uri.fsPath} ("${d.message.slice(0, 120)}"), so calls in that project may not be listed`;
      }
    } catch { /* not known */ }
    return null;
  }
  return {
    busyReason() {
      if (api) {
        const mode = api.serverMode;
        if (mode === 'LightWeight') return LIGHTWEIGHT_REASON;
        if (!ready || mode === 'Hybrid') return IMPORTING_REASON;
        if (buildFileChanged) return BUILD_FILE_REASON;
        if (sinceImport) return deadlinePassed ? sinceImport + NOT_CONFIRMED : sinceImport;
      }
      return brokenProject();
    },
    epoch: () => epoch,
  };
}

const memoryRecord = { /** @type {any} */ value: undefined };
/**
 * Where the editor keeps the build-file record: the extension's `workspaceState` (per
 * workspace, kept across windows), given once at activation; owner: the activation. Before it
 * is given, an in-memory record (none: incomplete until an import is seen).
 * @type {{ get(): any, set(record: any): void }}
 */
let editorBuildFileStore = { get: () => memoryRecord.value, set: (/** @type {any} */ v) => { memoryRecord.value = v; } };
/** @param {{ get: (k: string) => any, update: (k: string, v: any) => PromiseLike<void> }} workspaceState */
function setEditorJavaBuildFileStore(workspaceState) {
  editorBuildFileStore = {
    get: () => workspaceState.get(BUILD_FILE_RECORD_KEY),
    // Not kept (rejected): the next window reads no or an older record, so incomplete (safe).
    set: (record) => { Promise.resolve(workspaceState.update(BUILD_FILE_RECORD_KEY, record)).catch(() => {}); },
  };
}

/**
 * The editor's status, from the installed redhat.java; null outside VS Code or when the
 * extension is missing or inactive (no Java server answers then anyway).
 * @returns {JavaServerStatus|null}
 */
function editorJavaServerStatus() {
  let vscode;
  // By name, so the typecheck (no vscode types here) and the CLI never load it.
  const editorModule = 'vscode';
  try { vscode = require(editorModule); } catch { return null; }
  // Made once redhat.java is active (it may activate after the resolver is created).
  /** @type {JavaServerStatus|null} */
  let made = null;
  const get = () => {
    if (made) return made;
    try {
      const ext = vscode.extensions.getExtension('redhat.java');
      if (!ext || !ext.isActive || !ext.exports) return null;
      made = createJavaServerStatus({
        api: ext.exports,
        watch: (/** @type {string} */ g) => vscode.workspace.createFileSystemWatcher(g),
        diagnostics: () => /** @type {any} */ (vscode.languages.getDiagnostics()),
        buildFiles: {
          folders: () => (vscode.workspace.workspaceFolders || []).map((/** @type {any} */ w) => w.uri.fsPath),
          store: editorBuildFileStore,
        },
      });
    } catch { /* not known */ }
    return made;
  };
  return { busyReason: () => get()?.busyReason() ?? null, epoch: () => get()?.epoch() ?? 0 };
}

module.exports = {
  createJavaServerStatus, editorJavaServerStatus, setEditorJavaBuildFileStore, stampBuildFiles,
  BUILD_FILE_LIMITS, IMPORT_CONFIRM_DEADLINE_MS, BUILD_FILE_RECORD_KEY, BUILD_FILE_SINCE_IMPORT_REASON,
  BUILD_FILE_FIRST_REASON, BUILD_FILES_UNKNOWN_REASON, IMPORTING_REASON, LIGHTWEIGHT_REASON, BUILD_FILE_REASON, BROKEN_BUILD_PATH,
};
