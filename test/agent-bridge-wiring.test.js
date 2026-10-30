'use strict';
// The bridge to the user's agent in the extension: started with the window, with no setting to
// turn it on; deactivating stops it and removes its lock file.
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

test('no setting gates the agents or the cards any more', () => {
  const props = require('../package.json').contributes.configuration.properties;
  assert.equal(props['impactTree.agents.enabled'], undefined);
  assert.equal(props['impactTree.cards.enabled'], undefined);
});

test('the bridge starts with the window and answers with the review shown', () => inOwnTmp((dir) => withEnv(async (env) => {
  env.hooks.localResult = (o) => localResult(o);
  await env.refresh();
  await until(() => locks(dir).length === 1);
  const client = await connectBridge({ repo: env.dir, lockDir: dir });
  assert.ok(client);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.dir, encoding: 'utf8' }).trim();
  const ctx = await client.context();
  assert.equal(ctx.head, head);
  assert.equal(ctx.repo, fs.realpathSync(env.dir));
  client.close();
})));

test('deactivating stops a running bridge', () => inOwnTmp((dir) => withEnv(async (env) => {
  await until(() => locks(dir).length === 1);
  env.dispose();
  await until(() => locks(dir).length === 0);
  assert.equal(await connectBridge({ repo: env.dir, lockDir: dir }), null);
})));
