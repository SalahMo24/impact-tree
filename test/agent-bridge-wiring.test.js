'use strict';
// impactTree.agents.enabled in the extension: off by default and then nothing listens and no
// lock file exists; turning it on starts the bridge, turning it off or deactivating stops it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withEnv, localResult } = require('./extension-env');
const { connectBridge } = require('../src/mcp/bridge-client');

const until = async (cond) => { for (let i = 0; i < 300; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail('timed out'); };

/** Runs `fn` with the OS temp folder (where the bridge keeps its lock files) set to a new short folder. */
async function inOwnTmp(fn) {
  const saved = process.env.TMPDIR;
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'itw-'));
  process.env.TMPDIR = own;
  try { await fn(path.join(own, 'impact-tree-bridge')); } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
}
const locks = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

test('the setting is off by default and declared in the manifest', () => {
  const prop = require('../package.json').contributes.configuration.properties['impactTree.agents.enabled'];
  assert.equal(prop.default, false);
  assert.equal(prop.type, 'boolean');
});

test('off: no lock file; on: the bridge answers with the review shown; off again: gone', () => inOwnTmp((dir) => withEnv(async (env) => {
  assert.equal(fs.existsSync(dir), false, 'default off: not even the folder');
  env.hooks.localResult = (o) => localResult(o);
  await env.refresh();
  env.changeSetting('agents.enabled', true);
  await until(() => locks(dir).length === 1);
  const client = await connectBridge({ repo: env.dir, lockDir: dir });
  assert.ok(client);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.dir, encoding: 'utf8' }).trim();
  const ctx = await client.context();
  assert.equal(ctx.head, head);
  assert.equal(ctx.repo, fs.realpathSync(env.dir));
  client.close();
  env.changeSetting('agents.enabled', false);
  await until(() => locks(dir).length === 0);
  assert.equal(await connectBridge({ repo: env.dir, lockDir: dir }), null);
})));

test('deactivating stops a running bridge', () => inOwnTmp((dir) => withEnv(async (env) => {
  await until(() => locks(dir).length === 1);
  env.dispose();
  await until(() => locks(dir).length === 0);
}, { settings: { 'agents.enabled': true } })));
