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
// Owner: one per resolver (Java's editor extras); its listeners go to `own` (the editor
// passes nothing to keep them: they live as long as the window). Never throws: an API that
// is missing or fails reads as "not known", never as busy forever.

const fs = require('fs');
const path = require('path');

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
 * @returns {JavaServerStatus}
 */
function createJavaServerStatus({ api, watch, diagnostics, own = () => {}, hasBuildFile = defaultHasBuildFile }) {
  let ready = !api || typeof api.serverReady !== 'function';
  let buildFileChanged = false;
  let epoch = 0;
  const bump = () => { epoch++; };
  const imported = () => { buildFileChanged = false; bump(); };
  if (api && typeof api.serverReady === 'function') {
    const done = () => { ready = true; bump(); };
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
      }
      return brokenProject();
    },
    epoch: () => epoch,
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
      });
    } catch { /* not known */ }
    return made;
  };
  return { busyReason: () => get()?.busyReason() ?? null, epoch: () => get()?.epoch() ?? 0 };
}

module.exports = { createJavaServerStatus, editorJavaServerStatus, IMPORTING_REASON, LIGHTWEIGHT_REASON, BUILD_FILE_REASON, BROKEN_BUILD_PATH };
