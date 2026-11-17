'use strict';
// What the usage events say (src/telemetry/usage.js): names from outside become fixed words,
// settings are sent only as their known values, and each command reports its first run once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelProps, clientFamily, cardsAnswerCounts, settingsProps, enumSettingsOf, withCommandUsage } = require('../src/telemetry/usage');

test('a model id becomes its family and version number, never the id as written', () => {
  assert.deepEqual(modelProps('claude-opus-5-5'), { model: 'claude-opus', modelVersion: '5.5' });
  assert.deepEqual(modelProps('claude-sonnet-4-20250514'), { model: 'claude-sonnet', modelVersion: '4' }, 'a date is not a version');
  assert.deepEqual(modelProps('claude-3-5-haiku-latest'), { model: 'claude-haiku', modelVersion: '3.5' });
  assert.deepEqual(modelProps('Claude Fable 5.1'), { model: 'claude-fable', modelVersion: '5.1' });
  assert.deepEqual(modelProps('gpt-5.1-codex'), { model: 'gpt-codex', modelVersion: '5.1' });
  assert.deepEqual(modelProps('gpt-4o'), { model: 'gpt', modelVersion: '4' });
  assert.deepEqual(modelProps('o3'), { model: 'openai-o', modelVersion: '3' });
  assert.deepEqual(modelProps('gemini-2.5-pro'), { model: 'gemini', modelVersion: '2.5' });
  assert.deepEqual(modelProps('my-company/internal-model'), { model: 'other' }, 'an unknown name is not sent');
  assert.deepEqual(modelProps(''), { model: 'unknown' });
  assert.deepEqual(modelProps(undefined), { model: 'unknown' });
});

test('an MCP client name becomes its family', () => {
  assert.equal(clientFamily('claude-code'), 'claude-code');
  assert.equal(clientFamily('cursor-vscode'), 'cursor');
  assert.equal(clientFamily('codex-mcp-client'), 'codex');
  assert.equal(clientFamily('Visual Studio Code'), 'copilot');
  assert.equal(clientFamily('acme-secret-tool'), 'other');
  assert.equal(clientFamily(null), 'unknown');
});

test('a cards answer is counted, never read out', () => {
  assert.deepEqual(cardsAnswerCounts({ attention: ['x'], cards: [{}, {}], changes: [{ kind: 'new', shape: '+ a' }, { kind: 'may-change', shape: '' }] }),
    { notes: 2, changed: 0, mayChange: 1, same: 0, new: 1, shapes: 1, attention: 1, cards: 2 });
  assert.deepEqual(cardsAnswerCounts(null), { notes: 0, changed: 0, mayChange: 0, same: 0, new: 0, shapes: 0, attention: 0, cards: 0 });
});

test('settings: enum values only when known, booleans and depth as they are, free text only as set or not', () => {
  const enums = enumSettingsOf(require('../package.json'));
  assert.deepEqual(enums.reviewOrder, ['files', 'cards']);
  const values = { mode: 'branch', agent: 'my own thing', reviewOrder: 'cards', prewarm: false, reachDepth: 3, githubRemote: 'secret-remote', baseBranch: '' };
  const out = settingsProps({ get: (k) => values[k] }, enums);
  assert.equal(out['set.mode'], 'branch');
  assert.equal(out['set.agent'], 'other');
  assert.equal(out['set.reviewOrder'], 'cards');
  assert.equal(out['set.prewarm'], false);
  assert.equal(out['set.reachDepth'], 3);
  assert.equal(out['set.githubRemote'], true);
  assert.equal(out['set.baseBranch'], false);
  assert.ok(!JSON.stringify(out).includes('secret'));
});

test('a command reports its first run once, without our prefix, and runs as before; other API parts are the editor\'s', () => {
  const registered = new Map();
  const api = { window: { name: 'w' }, commands: { registerCommand: (id, fn) => { registered.set(id, fn); return { dispose() {} }; }, executeCommand: () => 'x' } };
  const reported = [];
  let on = false;
  const wrapped = withCommandUsage(api, () => (on ? (c) => reported.push(c) : null));
  assert.equal(wrapped.window, api.window);
  assert.equal(wrapped.commands.executeCommand(), 'x');
  wrapped.commands.registerCommand('impactTree.refresh', function (a) { return [this, a]; }, 'self');
  assert.deepEqual(registered.get('impactTree.refresh')(1), ['self', 1]);
  assert.deepEqual(reported, [], 'nothing before telemetry exists, and that run is not lost');
  on = true;
  registered.get('impactTree.refresh')(2);
  registered.get('impactTree.refresh')(3);
  assert.deepEqual(reported, ['refresh']);
});
