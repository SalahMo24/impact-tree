'use strict';
// "Choose my agent…": always shows the picker with the current agent marked, saves the pick in
// the user's impactTree.agent setting, and the hand-offs then use it without asking.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAgent, chooseReviewAgent } = require('../src/feedback/feedback-send');
const { AGENT_BUTTONS, agentButtonFor } = require('../src/agent/agent-handoff');

/** A vscode with one setting, a scripted picker and recorded messages. */
function fakeVscode({ saved = 'ask', pick = (items) => items[0], commands = [] } = {}) {
  const settings = { agent: saved };
  const shown = { pickers: [], messages: [], updates: [] };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    env: { appName: 'Visual Studio Code' },
    extensions: { getExtension: () => undefined },
    commands: { getCommands: async () => commands },
    workspace: { getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : d),
      update: async (k, v, target) => { settings[k] = v; shown.updates.push([k, v, target]); },
    }) },
    window: {
      showQuickPick: async (items, opts) => { shown.pickers.push({ items, opts }); return pick(items); },
      showInformationMessage: (m) => { shown.messages.push(m); },
    },
  };
  return { vscode, settings, shown };
}

test('the switch marks the current agent, offers Ask each time, and leaves out Save without sending', async () => {
  const { vscode, shown } = fakeVscode({ saved: 'codex', pick: () => undefined });
  assert.equal(await chooseReviewAgent(vscode), null);
  const { items } = shown.pickers[0];
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('claude') && ids.includes('codex') && ids.includes('clipboard') && ids.includes('ask'));
  assert.equal(ids.includes('save'), false);
  assert.match(items.find((i) => i.id === 'codex').description, /current$/);
  assert.equal(items.filter((i) => /current$/.test(i.description || '')).length, 1);
  assert.deepEqual(shown.updates, [], 'dismissed: nothing saved');
});

test('a pick is saved for the user and the next hand-off uses it without asking', async () => {
  const { vscode, settings, shown } = fakeVscode({ pick: (items) => items.find((i) => i.id === 'clipboard') });
  assert.equal(await chooseReviewAgent(vscode), 'clipboard');
  assert.deepEqual(shown.updates, [['agent', 'clipboard', 1]]);
  assert.match(shown.messages[0], /no agent is started; prompts are copied/);
  const choice = await chooseAgent(vscode, false, { title: 'Analyse with…', exclude: ['save'] });
  assert.equal(choice.id, 'clipboard');
  assert.equal(shown.pickers.length, 1, 'no second picker');
  assert.equal(settings.agent, 'clipboard');
});

test('Ask each time makes the next hand-off ask', async () => {
  const { vscode, shown } = fakeVscode({ saved: 'claude', pick: (items) => items.find((i) => i.id === 'ask') });
  assert.equal(await chooseReviewAgent(vscode), 'ask');
  assert.match(shown.messages[0], /asked which agent/);
  await chooseAgent(vscode, false, { title: 'Analyse with…', exclude: ['save'] });
  assert.equal(shown.pickers.length, 2, 'the hand-off asked');
});

test('a saved agent this editor cannot reach is named in the picker', async () => {
  const { vscode, shown } = fakeVscode({ saved: 'chat', pick: () => undefined });
  await chooseReviewAgent(vscode);
  assert.match(shown.pickers[0].opts.placeHolder, /"chat" is saved but not available here/);
});

test('the manifest offers the switch in the palette and on the reviewed row', () => {
  const pkg = require('../package.json');
  const cmd = pkg.contributes.commands.find((c) => c.command === 'impactTree.chooseAgent');
  assert.equal(cmd.title, 'Choose my agent…');
  assert.equal(pkg.contributes.menus.commandPalette.some((m) => m.command === 'impactTree.chooseAgent'), false, 'never hidden from the palette');
  assert.ok(pkg.contributes.menus['view/item/context'].some((m) => m.command === 'impactTree.chooseAgent' && /viewItem == reviewHost/.test(m.when)));
});

test('the switch groups the routes under their agent', async () => {
  const { vscode, shown } = fakeVscode({ pick: () => undefined, commands: ['workbench.action.chat.open'] });
  vscode.QuickPickItemKind = { Separator: -1 };
  await chooseReviewAgent(vscode);
  const rows = shown.pickers[0].items.map((i) => (i.kind === -1 ? `# ${i.label}` : i.id));
  assert.deepEqual(rows, ['# Claude Code', 'claude', '# Codex', 'codex', '# Copilot', 'chat', '# No agent', 'clipboard', 'ask']);
  assert.equal(shown.pickers[0].items.find((i) => i.id === 'claude').label, '$(terminal) In a terminal');
});

test('in Cursor, the editor chat sits under Cursor and a pick names the route', async () => {
  const { vscode, shown } = fakeVscode({ pick: (items) => items.find((i) => i.id === 'chat'), commands: ['workbench.action.chat.open'] });
  vscode.env.appName = 'Cursor';
  vscode.QuickPickItemKind = { Separator: -1 };
  assert.equal(await chooseReviewAgent(vscode), 'chat');
  const rows = shown.pickers[0].items.map((i) => (i.kind === -1 ? `# ${i.label}` : i.id));
  assert.deepEqual(rows.slice(rows.indexOf('# Cursor'), rows.indexOf('# No agent')), ['# Cursor', 'cursor-chat', 'chat']);
  assert.match(shown.messages[0], /Cursor's editor chat now reviews with you/);
});

test('the agent button shows the saved agent, with one command and icon per route', () => {
  assert.equal(agentButtonFor('claude', 'Visual Studio Code'), 'claude');
  assert.equal(agentButtonFor('chat', 'Cursor'), 'chat-cursor');
  assert.equal(agentButtonFor('chat', 'Visual Studio Code'), 'chat-copilot');
  for (const v of ['ask', 'save', 'nonsense', undefined]) assert.equal(agentButtonFor(v, 'Visual Studio Code'), 'ask');
  const { contributes } = require('../package.json');
  const inline = contributes.menus['view/item/context'].filter((m) => m.group === 'inline@9');
  assert.deepEqual(inline.map((m) => m.command).sort(), ['impactTree.chooseAgent', ...AGENT_BUTTONS.map((id) => `impactTree.chooseAgent.${id}`)].sort());
  for (const id of AGENT_BUTTONS) {
    const cmd = contributes.commands.find((c) => c.command === `impactTree.chooseAgent.${id}`);
    assert.ok(cmd && cmd.icon, `${id} has an icon`);
    if (typeof cmd.icon === 'object') for (const p of [cmd.icon.light, cmd.icon.dark]) assert.ok(require('fs').existsSync(require('path').join(__dirname, '..', p)), p);
    assert.ok(contributes.menus.commandPalette.some((m) => m.command === cmd.command && m.when === 'false'), `${id} is hidden from the palette`);
  }
});
