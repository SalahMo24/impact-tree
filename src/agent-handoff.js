// @ts-check
'use strict';
// Where "Send feedback" hands a round to an agent (docs/UX_PLAN.md F3). The choices and
// what each one runs are decided by pure functions here; `handOff` is the only part that
// touches the editor.
//
// - Claude Code / Codex: a new terminal in the repository runs `claude '<prompt>'` /
//   `codex '<prompt>'`. The prompt is quoted for a POSIX shell (bash, zsh, fish). Windows
//   shells quote differently, so there the CLI is started without the prompt and the
//   prompt goes to the clipboard instead, and the message says so.
// - Editor chat: `workbench.action.chat.open` with `{ query, isPartialQuery: true }` fills
//   the chat input without sending it. Checked in the bundles of VS Code 1.141 (Copilot
//   Chat; `mode: 'agent'` picks its agent mode) and Cursor 3.25 (fills a new chat; ignores
//   `mode` and `isPartialQuery`). Offered only when the command exists.
// - Claude Code (VS Code): opens `vscode://anthropic.claude-code/open?prompt=<prompt>` through
//   the editor, which fills Claude Code's panel. Offered only when that extension is installed;
//   a prompt too long for a link goes to the clipboard instead, and the message says so.
// - Copy prompt: the clipboard. Save without sending: nothing beyond the file.

const path = require('path');
const fs = require('fs');
const { shellQuote } = require('./feedback-file');

const CHAT_COMMAND = 'workbench.action.chat.open';
/** Values of the `impactTree.agent` setting; `ask` shows the picker. */
const AGENT_SETTING_VALUES = Object.freeze(['ask', 'claude', 'claude-vscode', 'codex', 'chat', 'clipboard', 'save']);

/** Longest prompt (after percent-encoding) put in a link. Unit: characters. Longer: the clipboard. */
const MAX_URI_PROMPT_CHARS = 8000;
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/** @typedef {'claude'|'claude-vscode'|'codex'|'chat'|'clipboard'|'save'} AgentChoiceId */
/**
 * @typedef {{ id: AgentChoiceId, label: string, description: string, available: boolean }} AgentChoice
 *   `available` false: shown, but the description says why it may not work (an executable
 *   not found on PATH) or it cannot be used at all (no chat command); see `choicesFor`.
 */

const CLIS = Object.freeze({
  claude: { exe: 'claude', name: 'Claude Code' },
  codex: { exe: 'codex', name: 'Codex' },
});

/**
 * Is `exe` an executable file in one of the PATH folders? `exists` is injected for tests.
 * Bounded by the number of PATH entries (capped at 200).
 * @param {string} exe
 * @param {{ pathEnv: string|undefined, platform: string, exists?: (abs: string) => boolean }} env
 */
function onPath(exe, { pathEnv, platform, exists = isExecutable }) {
  if (!pathEnv) return false;
  const dirs = pathEnv.split(platform === 'win32' ? ';' : ':').filter(Boolean).slice(0, 200);
  const names = platform === 'win32' ? [`${exe}.exe`, `${exe}.cmd`, `${exe}.bat`] : [exe];
  return dirs.some((d) => names.some((n) => exists(path.join(d, n))));
}

/** @param {string} abs */
function isExecutable(abs) {
  try {
    fs.accessSync(abs, fs.constants.X_OK);
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * The picker's choices, in order. A CLI not found on PATH stays listed (the editor's PATH
 * can differ from a login shell's) with a description saying it was not found; the
 * editor chat is listed only when its command exists.
 * @param {{ cliFound: (exe: string) => boolean, chatAvailable: boolean, claudeExtension?: boolean }} probe
 * @returns {AgentChoice[]}
 */
function choicesFor({ cliFound, chatAvailable, claudeExtension = false }) {
  /** @type {AgentChoice[]} */
  const out = [];
  for (const id of /** @type {const} */ (['claude', 'codex'])) {
    const { exe, name } = CLIS[id];
    const found = cliFound(exe);
    out.push({ id, label: name, description: found ? `runs ${exe} in a terminal` : `${exe} was not found on PATH`, available: found });
  }
  if (claudeExtension) out.push({ id: 'claude-vscode', label: 'Claude Code (VS Code)', description: "fills Claude Code's panel; you press Enter", available: true });
  if (chatAvailable) out.push({ id: 'chat', label: 'Editor chat', description: 'fills the chat; you press Enter', available: true });
  out.push({ id: 'clipboard', label: 'Copy prompt', description: 'paste into any agent', available: true });
  out.push({ id: 'save', label: 'Save without sending', description: 'only write the feedback file', available: true });
  return out;
}

/**
 * What a hand-off does, as data.
 * @param {AgentChoiceId} id
 * @param {{ prompt: string, platform: string }} o
 * @returns {{ kind: 'terminal', name: string, command: string, alsoClipboard: boolean }
 *   | { kind: 'uri', uri: string } | { kind: 'uri-too-long', length: number }
 *   | { kind: 'chat', args: { query: string, isPartialQuery: true, mode: 'agent' } }
 *   | { kind: 'clipboard' } | { kind: 'none' }}
 */
function planHandOff(id, { prompt, platform }) {
  if (id === 'claude' || id === 'codex') {
    const { exe, name } = CLIS[id];
    const posix = platform !== 'win32';
    return { kind: 'terminal', name: `Impact Tree · ${name}`, command: posix ? `${exe} ${shellQuote(prompt)}` : exe, alsoClipboard: !posix };
  }
  if (id === 'claude-vscode') {
    const encoded = encodeURIComponent(prompt);
    if (encoded.length > MAX_URI_PROMPT_CHARS) return { kind: 'uri-too-long', length: encoded.length };
    return { kind: 'uri', uri: `vscode://${CLAUDE_EXTENSION_ID}/open?prompt=${encoded}` };
  }
  if (id === 'chat') return { kind: 'chat', args: { query: prompt, isPartialQuery: true, mode: 'agent' } };
  if (id === 'clipboard') return { kind: 'clipboard' };
  if (id === 'save') return { kind: 'none' };
  throw new TypeError(`unknown agent choice ${String(id)}`);
}

/**
 * Carries out a hand-off. Resolves to the sentence the success message ends with.
 * @param {any} vscode
 * @param {AgentChoiceId} id
 * @param {{ prompt: string, repoRoot: string, platform?: string }} o
 * @returns {Promise<string>}
 */
async function handOff(vscode, id, { prompt, repoRoot, platform = process.platform }) {
  const plan = planHandOff(id, { prompt, platform });
  if (plan.kind === 'terminal') {
    if (plan.alsoClipboard) await vscode.env.clipboard.writeText(prompt);
    const terminal = vscode.window.createTerminal({ name: plan.name, cwd: repoRoot });
    terminal.show();
    terminal.sendText(plan.command, true);
    const name = CLIS[/** @type {'claude'|'codex'} */ (id)].name;
    return plan.alsoClipboard ? `Started ${name} in a terminal; the prompt is on the clipboard to paste.` : `Started ${name} in a terminal.`;
  }
  if (plan.kind === 'uri') {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(plan.uri));
    if (opened === false) throw new Error('the editor did not open the link');
    return 'The prompt is in Claude Code; press Enter to send it.';
  }
  if (plan.kind === 'uri-too-long') {
    await vscode.env.clipboard.writeText(prompt);
    return `The prompt is too long for a link to Claude Code (${plan.length} characters, the cap is ${MAX_URI_PROMPT_CHARS}), so it is on the clipboard to paste.`;
  }
  if (plan.kind === 'chat') {
    await vscode.commands.executeCommand(CHAT_COMMAND, plan.args);
    return 'The prompt is in the chat; press Enter to send it.';
  }
  if (plan.kind === 'clipboard') {
    await vscode.env.clipboard.writeText(prompt);
    return 'The prompt is on the clipboard.';
  }
  return 'Not sent to an agent.';
}

module.exports = { choicesFor, planHandOff, handOff, onPath, isExecutable, MAX_URI_PROMPT_CHARS, CLAUDE_EXTENSION_ID, CHAT_COMMAND, AGENT_SETTING_VALUES };
