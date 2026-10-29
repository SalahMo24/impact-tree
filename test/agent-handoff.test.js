'use strict';
// Sending a feedback round to an agent (docs/UX_PLAN.md F3): the picker's choices, what
// each choice runs, and the AGENTS.md / CLAUDE.md pointer text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { choicesFor, planHandOff, handOff, onPath } = require('../src/agent/agent-handoff');
const { withPointer, targetsFor, MARKER } = require('../src/agent/agent-pointer');

const PROMPT = 'Read .impact-tree/feedback/2026-10-20-2.md and address each item. Under each item write "Status: done". Don\'t `rm` $HOME';

test('choices: CLIs stay listed when missing, but say so; chat only when its command exists', () => {
  const ids = (c) => c.map((x) => x.id);
  const all = choicesFor({ cliFound: () => true, chatAvailable: true });
  assert.deepEqual(ids(all), ['claude', 'codex', 'chat', 'clipboard', 'save']);
  assert.equal(all[0].description, 'runs claude in a terminal');
  const none = choicesFor({ cliFound: (exe) => exe === 'claude', chatAvailable: false });
  assert.deepEqual(ids(none), ['claude', 'codex', 'clipboard', 'save']);
  assert.equal(none[1].available, false);
  assert.equal(none[1].description, 'codex was not found on PATH');
});

test('terminal hand-off quotes the prompt as one POSIX argument', () => {
  const plan = planHandOff('claude', { prompt: PROMPT, platform: 'darwin' });
  assert.equal(plan.kind, 'terminal');
  if (plan.kind !== 'terminal') return;
  assert.equal(plan.name, 'Impact Tree · Claude Code');
  assert.ok(plan.command.startsWith("claude '"));
  // The shell reads back exactly the prompt.
  const { execFileSync } = require('child_process');
  const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${plan.command.slice('claude '.length)}`], { encoding: 'utf8' });
  assert.equal(echoed, PROMPT);
  assert.equal(plan.alsoClipboard, false);
});

test('on Windows the CLI starts without the prompt and the prompt goes to the clipboard', () => {
  const plan = planHandOff('codex', { prompt: PROMPT, platform: 'win32' });
  assert.deepEqual(plan, { kind: 'terminal', name: 'Impact Tree · Codex', command: 'codex', alsoClipboard: true });
});

test('chat fills the input without sending; clipboard and save do what they say', async () => {
  assert.deepEqual(planHandOff('chat', { prompt: 'p', platform: 'darwin' }), { kind: 'chat', args: { query: 'p', isPartialQuery: true, mode: 'agent' } });
  const calls = [];
  const vscode = {
    env: { clipboard: { writeText: async (t) => { calls.push(['clip', t]); } } },
    commands: { executeCommand: async (...a) => { calls.push(['cmd', ...a]); } },
    window: { createTerminal: (o) => ({ show: () => calls.push(['show', o.name, o.cwd]), sendText: (t, nl) => calls.push(['send', t, nl]) }) },
  };
  assert.match(await handOff(vscode, 'chat', { prompt: 'p', repoRoot: '/r' }), /press Enter/);
  assert.match(await handOff(vscode, 'clipboard', { prompt: 'p', repoRoot: '/r' }), /clipboard/);
  assert.match(await handOff(vscode, 'save', { prompt: 'p', repoRoot: '/r' }), /Not sent/);
  await handOff(vscode, 'codex', { prompt: 'p', repoRoot: '/r', platform: 'linux' });
  assert.deepEqual(calls, [
    ['cmd', 'workbench.action.chat.open', { query: 'p', isPartialQuery: true, mode: 'agent' }],
    ['clip', 'p'],
    ['show', 'Impact Tree · Codex', '/r'],
    ['send', "codex 'p'", true],
  ]);
  assert.throws(() => planHandOff(/** @type {any} */ ('cursor'), { prompt: 'p', platform: 'darwin' }), /unknown agent choice/);
});

test('onPath looks in every PATH folder, with Windows extensions', () => {
  const seen = [];
  const exists = (abs) => { seen.push(abs); return abs === '/usr/local/bin/claude'; };
  assert.equal(onPath('claude', { pathEnv: '/usr/bin::/usr/local/bin', platform: 'darwin', exists }), true);
  assert.deepEqual(seen, ['/usr/bin/claude', '/usr/local/bin/claude']);
  assert.equal(onPath('codex', { pathEnv: '/usr/bin', platform: 'darwin', exists }), false);
  assert.equal(onPath('codex', { pathEnv: undefined, platform: 'darwin', exists }), false);
  const win = [];
  onPath('codex', { pathEnv: 'C:\\bin', platform: 'win32', exists: (a) => { win.push(a); return false; } });
  assert.equal(win.length, 3);
});

test('the pointer is added once, after existing text, and creates AGENTS.md when no file exists', () => {
  const created = withPointer(null);
  assert.ok(created.startsWith(MARKER));
  assert.equal(withPointer(created), null);
  assert.equal(withPointer('# Rules\n- x\n'), `# Rules\n- x\n\n${created}`);
  assert.equal(withPointer('# Rules'), `# Rules\n\n${created}`);
  assert.equal(withPointer(''), created);
  assert.deepEqual(targetsFor({}), ['AGENTS.md']);
  assert.deepEqual(targetsFor({ 'CLAUDE.md': true }), ['CLAUDE.md']);
  assert.deepEqual(targetsFor({ 'AGENTS.md': true, 'CLAUDE.md': true }), ['AGENTS.md', 'CLAUDE.md']);
});
