// @ts-check
'use strict';
// "Impact Tree: Connect my agent…" / "Disconnect my agent…" (docs/AI_PLAN.md AI4): the editor
// side of src/agent-connect.js. Every action that runs a command or opens a link shows the
// exact command or link in a modal first; Cancel runs nothing. Owner of what is started here:
// the object returned by `createAgentConnect`; `dispose()` unregisters the VS Code provider.

const os = require('os');
const fs = require('fs');
const ac = require('./agent-connect');
const { onPath } = require('./agent-handoff');

const PROVIDER_ID = 'impactTree.mcp';

/**
 * @param {any} vscode
 * @param {{ context: any, log: (m: string) => void, run?: ac.Run, platform?: string, pathEnv?: string|undefined,
 *   home?: string, fsApi?: typeof fs, editor?: { execPath: string, version: string } }} deps
 */
function createAgentConnect(vscode, deps) {
  const { context, log } = deps;
  const run = deps.run || ac.runProcess;
  const platform = deps.platform || process.platform;
  const pathEnv = 'pathEnv' in deps ? deps.pathEnv : process.env.PATH;
  const home = deps.home || os.homedir();
  const fsApi = deps.fsApi || fs;
  const editor = deps.editor || { execPath: process.execPath, version: process.versions.node };
  const onPathExe = (/** @type {string} */ exe) => onPath(exe, { pathEnv, platform });

  /** @type {{ dispose: () => void }|null} */
  let providerReg = null;
  /** @type {{ fire: () => void, event: any, dispose: () => void }|null} */
  let changeEmitter = null;

  const storageDir = () => (context.globalStorageUri && context.globalStorageUri.fsPath) || null;

  /** Write the launcher; null (and a log line) when this window has no storage folder or the write fails. */
  function launcher() {
    const dir = storageDir();
    if (!dir) { log('agent connect: this window has no global storage folder'); return null; }
    try { return ac.ensureLauncher({ storageDir: dir, extensionPath: context.extensionPath, fsApi }).launcher; } catch (e) {
      log(`agent connect: writing the launcher failed: ${/** @type {Error} */ (e).message}`);
      return null;
    }
  }
  const runtime = () => ac.probeRuntime({ run, pathEnv, platform, editor });

  const detectAll = () => ac.detectAgents({
    run, onPathExe, appName: String(vscode.env.appName || ''), home,
    hasProviderApi: Boolean(vscode.lm && typeof vscode.lm.registerMcpServerDefinitionProvider === 'function'),
    readFile: (p) => { try { return fsApi.readFileSync(p, 'utf8'); } catch (e) { if (/** @type {any} */ (e).code === 'ENOENT') return null; throw e; } },
    appInstalled: (p) => fsApi.existsSync(p),
  });

  /** Detection, plus the one thing only this object knows: whether its provider is registered. */
  async function detect() {
    const all = await detectAll();
    all.vscode.connected = providerReg !== null;
    return all;
  }

  // ---- the VS Code / Copilot provider: registered only while the setting is on and the API exists

  /** Follow `impactTree.agents.enabled`. @param {boolean} on */
  function syncProvider(on) {
    const hasApi = Boolean(vscode.lm && typeof vscode.lm.registerMcpServerDefinitionProvider === 'function');
    if (on && hasApi && !providerReg) {
      const lm = vscode.lm;
      const emitter = new vscode.EventEmitter();
      changeEmitter = emitter;
      providerReg = lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: emitter.event,
        provideMcpServerDefinitions: async () => {
          const l = launcher();
          const rt = await runtime();
          if (!l || !rt) return [];
          const d = ac.providerDefinition({ runtime: rt, launcher: l });
          return [new vscode.McpStdioServerDefinition(d.label, d.command, d.args, d.env)];
        },
      });
    } else if (!on || !hasApi) {
      disposeProvider();
    }
  }
  function disposeProvider() {
    if (providerReg) { providerReg.dispose(); providerReg = null; }
    if (changeEmitter) { changeEmitter.dispose(); changeEmitter = null; }
  }
  /** Write the launcher when the setting turns on (called at activation too). */
  function prepareLauncher() { launcher(); }

  // ---- the commands

  /** @param {Record<ac.ConnectAgentId, ac.AgentStatus>} status @param {string} title @param {(s: ac.AgentStatus) => boolean} [keep] */
  async function pickAgent(status, title, keep = () => true) {
    const items = ac.ids.filter((id) => keep(status[id])).map((id) => ({ id, label: ac.CLI_NAMES[id], description: ac.statusText(status[id]) }));
    if (!items.length) return null;
    return vscode.window.showQuickPick(items, { title, placeHolder: 'Impact Tree works in whichever repository your agent runs in' });
  }

  /** @param {string} message @param {string} detail @param {string} button @returns {Promise<boolean>} */
  async function confirm(message, detail, button) {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  /** @param {ac.ConnectAgentId} id @param {string} what */
  async function report(id, what) {
    const after = (await detect())[id];
    vscode.window.showInformationMessage(`Impact Tree: ${what} ${ac.CLI_NAMES[id]} is now ${ac.statusText(after)}.`);
  }

  /** Run `file args`; on failure show its first stderr line. @param {string} file @param {string[]} args @param {ac.ConnectAgentId} id @returns {Promise<boolean>} */
  async function runChecked(file, args, id) {
    const r = await run(file, args, { timeoutMs: ac.ACTION_TIMEOUT_MS });
    if (r.code === 0) return true;
    log(`agent connect: ${ac.displayCommand(file, args)} failed (${r.code}): ${r.stderr.slice(0, 500)}`);
    vscode.window.showErrorMessage(`Impact Tree: ${ac.CLI_NAMES[id]} did not accept the command: ${ac.firstErrorLine(r)}`);
    return false;
  }

  async function connect() {
    const status = await detect();
    const pick = await pickAgent(status, 'Impact Tree: Connect my agent');
    if (!pick) return;
    const id = /** @type {ac.ConnectAgentId} */ (pick.id);
    const rt = await runtime();
    if (!rt) { vscode.window.showWarningMessage(`Impact Tree: ${ac.NO_RUNTIME_MESSAGE}`); return; }
    const l = launcher();
    if (!l) { vscode.window.showErrorMessage('Impact Tree: could not write its launcher for agents (this window has no storage folder, or it is not writable). See the Impact Tree log.'); return; }
    const note = rt.kind === 'editor' ? '\n\nNo Node 20 or later was found on PATH, so the editor\'s own runtime is used (ELECTRON_RUN_AS_NODE=1).' : '';
    const everywhere = '\n\nThe connection applies to every repository; Impact Tree works in the repository your agent runs in.';

    if (id === 'claude' || id === 'codex') {
      const exe = id;
      const addArgs = id === 'claude' ? ac.claudeAddArgs({ runtime: rt, launcher: l }) : ac.codexAddArgs({ runtime: rt, launcher: l });
      const removeArgs = id === 'claude' ? ac.claudeRemoveArgs() : ac.codexRemoveArgs();
      const add = ac.displayCommand(exe, addArgs);
      const exists = status[id].connected === true;
      if (exists) {
        const remove = ac.displayCommand(exe, removeArgs);
        if (!await confirm(`Impact Tree is already connected to ${ac.CLI_NAMES[id]}. Replace it?`, `This runs:\n\n${remove}\n${add}${note}${everywhere}`, 'Replace')) return;
        if (!await runChecked(exe, removeArgs, id)) return;
      } else if (!await confirm(`Connect Impact Tree to ${ac.CLI_NAMES[id]}?`, `This runs:\n\n${add}${note}${everywhere}`, 'Connect')) return;
      if (await runChecked(exe, addArgs, id)) await report(id, exists ? 'Replaced:' : 'Connected:');
      return;
    }
    if (id === 'cursor') {
      const link = ac.cursorDeeplink({ runtime: rt, launcher: l });
      if (!await confirm('Connect Impact Tree to Cursor?', `This opens the link below; Cursor asks you to confirm before it installs anything:\n\n${link}${note}${everywhere}`, 'Connect')) return;
      const opened = await vscode.env.openExternal(vscode.Uri.parse(link));
      if (opened === false) vscode.window.showErrorMessage('Impact Tree: the editor did not open the Cursor link.');
      else vscode.window.showInformationMessage('Impact Tree: Cursor was asked to add Impact Tree. Confirm in Cursor, then check its MCP settings.');
      return;
    }
    // VS Code / Copilot: nothing runs; the provider offers the server while the setting is on.
    syncProvider(true);
    if (changeEmitter) changeEmitter.fire();
    vscode.window.showInformationMessage('Impact Tree: it is now offered to Copilot as an MCP server (shown in "MCP: List Servers"; VS Code asks you to trust it before it starts). It stays offered while "impactTree.agents.enabled" is on.');
  }

  async function disconnect() {
    const status = await detect();
    const pick = await pickAgent(status, 'Impact Tree: Disconnect my agent', (s) => s.connected !== false);
    if (!pick) { vscode.window.showInformationMessage('Impact Tree: no agent is connected.'); return; }
    const id = /** @type {ac.ConnectAgentId} */ (pick.id);
    if (id === 'cursor') { vscode.window.showInformationMessage('Impact Tree: remove "impact-tree" in Cursor\'s settings under Tools & MCP. Impact Tree does not edit Cursor\'s configuration.'); return; }
    if (id === 'vscode') { vscode.window.showInformationMessage('Impact Tree: Copilot is offered the server only while "impactTree.agents.enabled" is on; turn that setting off to stop.'); return; }
    const args = id === 'claude' ? ac.claudeRemoveArgs() : ac.codexRemoveArgs();
    if (!await confirm(`Disconnect Impact Tree from ${ac.CLI_NAMES[id]}?`, `This runs:\n\n${ac.displayCommand(id, args)}`, 'Disconnect')) return;
    if (await runChecked(id, args, id)) await report(id, 'Disconnected:');
  }

  return { connect, disconnect, detect, syncProvider, prepareLauncher, dispose: disposeProvider };
}

module.exports = { createAgentConnect, PROVIDER_ID };
