// @ts-check
'use strict';

// "Try the demo": builds the demo repository (./demo-repo.js) and opens it. In that window
// the branch is ahead of its base, so the first run (src/session/first-run.js) reviews it by
// itself; a reviewer who edited the demo gets a fresh copy by running the command again.

const path = require('path');
const { buildDemoRepo, isDemoRepo } = require('./demo-repo');

/**
 * @param {*} vscode
 * @param {{
 *   context: any, log: (m: string) => void,
 *   telemetry?: { event: (name: string, props?: Record<string, unknown>) => void },
 *   refresh: () => Promise<unknown>,
 * }} deps `context`: the ExtensionContext. `refresh`: runs the review of the open folder.
 */
function createDemo(vscode, { context, log, telemetry, refresh }) {
  const storage = context.globalStorageUri ? context.globalStorageUri.fsPath : null;
  const templateDir = path.join(context.extensionPath || (context.extensionUri && context.extensionUri.fsPath) || '', 'demo');
  const folder = () => {
    const f = vscode.workspace.workspaceFolders;
    return f && f.length ? f[0].uri.fsPath : null;
  };
  const inDemo = () => isDemoRepo(folder(), storage);

  async function tryDemo() {
    if (!storage) {
      void vscode.window.showErrorMessage('Impact Tree: the demo needs the extension\'s storage folder, and this editor gave none.');
      return;
    }
    /** @type {{ repo: string }} */
    let built;
    try {
      built = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Impact Tree: building the demo repository…' },
        () => buildDemoRepo({ templateDir, parentDir: storage }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`demo: could not build: ${message}`);
      if (telemetry) telemetry.event('demo.started', { ok: false });
      void vscode.window.showErrorMessage(`Impact Tree: could not build the demo repository: ${message}`);
      return;
    }
    log(`demo: built ${built.repo}`);
    if (telemetry) telemetry.event('demo.started', { ok: true });
    // Already in the demo: its files were put back, so review them again here.
    if (inDemo()) { await refresh(); return; }
    // A window with a folder keeps it; an empty window becomes the demo's.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(built.repo), { forceNewWindow: folder() !== null });
  }

  return {
    inDemo,
    /** Whether the Review view offers the demo: everywhere but inside it. */
    offerDemo: () => !inDemo(),
    /** What activation does in the demo's window: show the view and say so (the first run reviews it). */
    async onActivated() {
      if (!inDemo()) return;
      log('demo: this window is the demo repository');
      if (telemetry) telemetry.event('demo.opened');
      await Promise.resolve(vscode.commands.executeCommand('impactTree.sources.focus')).then(undefined, () => {});
    },
    disposables: [vscode.commands.registerCommand('impactTree.tryDemo', tryDemo)],
  };
}

module.exports = { createDemo };
