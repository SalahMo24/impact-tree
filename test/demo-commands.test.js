'use strict';
// Try the demo (src/demo/demo-commands.js): when the Review view offers it, and what the
// demo's own window does when it opens.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createDemo } = require('../src/demo/demo-commands');
const { demoPaths } = require('../src/demo/demo-repo');
const { createSourcesProvider } = require('../src/views/sidebar/sources-provider');

const STORAGE = path.join(path.sep, 'storage');

function setup({ folder = null } = {}) {
  const seen = { commands: [], messages: [], refreshed: 0, events: [] };
  const vscode = {
    workspace: { workspaceFolders: folder ? [{ uri: { fsPath: folder } }] : undefined },
    commands: { registerCommand: (id) => ({ id, dispose() {} }), executeCommand: async (...a) => { seen.commands.push(a); } },
    window: { showInformationMessage: async (m) => { seen.messages.push(m); return undefined; }, showErrorMessage: async (m) => { seen.messages.push(m); } },
    Uri: { file: (p) => ({ fsPath: p }) },
  };
  const context = { globalStorageUri: { fsPath: STORAGE }, extensionPath: '/ext' };
  const demo = createDemo(vscode, { context, log: () => {}, telemetry: { event: (n) => seen.events.push(n) }, refresh: async () => { seen.refreshed++; } });
  return { demo, seen };
}

test('the demo window shows the view and leaves the review to the first run', async () => {
  const { demo, seen } = setup({ folder: demoPaths(STORAGE).repo });
  assert.equal(demo.inDemo(), true);
  assert.equal(demo.offerDemo(), false);
  await demo.onActivated();
  assert.equal(seen.refreshed, 0);
  assert.ok(seen.commands.some(([id]) => id === 'impactTree.sources.focus'));
  assert.deepEqual(seen.messages, []);
  assert.deepEqual(seen.events, ['demo.opened']);
});

test('another window does nothing on activation and offers the demo', async () => {
  const { demo, seen } = setup({ folder: '/work/repo' });
  await demo.onActivated();
  assert.deepEqual(seen.commands, []);
  assert.equal(demo.offerDemo(), true);
  const vscode = { EventEmitter: class { constructor() { this.event = () => {}; } fire() {} } };
  const sources = createSourcesProvider(vscode, { modes: { pr: { label: 'Branch vs base' } }, getMode: () => 'pr', getRepoSlug: () => null,
    github: {}, getPrs: () => [], getPrError: () => null, isLoadingPrs: () => false, offerDemo: demo.offerDemo });
  assert.deepEqual((await sources.getChildren()).map((r) => r.type), ['group', 'group', 'demo']);
});
