'use strict';
// "Choose my agent…": always shows the picker with the current agent marked, saves the pick in
// the user's impactTree.agent setting, and the hand-offs then use it without asking.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseAgent, chooseReviewAgent } = require('../src/feedback/feedback-send');

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
  assert.match(shown.messages[0], /Copy prompt now reviews with you/);
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
