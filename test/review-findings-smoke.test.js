'use strict';
// Hand-released language-server answers and analysis runs reproduce the review races.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vscode = require('./vscode-stub');
const { deferred, withEnv, pull } = require('./extension-env');
const flush = () => new Promise(setImmediate);

test('a replaced caller query cannot overwrite the replacement analysis cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-review-cache-'));
  const target = path.join(dir, 'target.ts'), caller = path.join(dir, 'caller.ts');
  fs.writeFileSync(target, 'function target() {}\n');
  fs.writeFileSync(caller, 'function oldCaller() { target(); }\n');
  const held = deferred();
  let queries = 0;
  const editor = { ...vscode, Position: class {
    constructor(line, character) { this.line = line; this.character = character; }
  }, commands: { executeCommand: async (name) => {
    if (name === 'vscode.prepareCallHierarchy') return [{}];
    if (name === 'vscode.provideIncomingCalls') return ++queries === 1 ? held.promise : [];
    throw new Error(`unexpected command ${name}`);
  } } };
  const originalLoad = Module._load;
  const modulePath = require.resolve('../src/resolver-vscode');
  const previous = require.cache[modulePath];
  let older;
  try {
    delete require.cache[modulePath];
    Module._load = function (name, ...args) {
      return name === 'vscode' ? editor : originalLoad.call(this, name, ...args);
    };
    const { createVscodeResolver } = require(modulePath);
    Module._load = originalLoad;
    const resolver = createVscodeResolver({ repoRoot: dir, filterInherited: false });
    older = resolver.incomingWithStatus(target, 9);
    await flush();
    assert.equal(queries, 1);
    resolver.clear();
    assert.deepEqual((await resolver.incomingWithStatus(target, 9)).callers, []);
    held.resolve([{ from: { uri: vscode.Uri.file(caller), name: 'oldCaller',
      selectionRange: { start: { line: 0, character: 9 } } }, fromRanges: [] }]);
    await older;
    assert.deepEqual((await resolver.incomingWithStatus(target, 9)).callers, [],
      'expanding the new result must keep the new caller answer');
    assert.equal(queries, 2, 'the replacement answer remains cached');
  } finally {
    held.resolve([]);
    if (older) await older;
    Module._load = originalLoad;
    delete require.cache[modulePath];
    if (previous) require.cache[modulePath] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkout waits for replaced runs even after the newest run finishes', () => withEnv(async (env) => {
  const held = env.holds.analyze.next();
  const older = env.refresh();
  await held.reached;
  await env.refresh();
  const checkout = env.openPullRequest(pull(7), 'analyse');
  try {
    await flush(); await flush();
    assert.deepEqual(env.git.calls, [], 'git must wait for every outstanding analysis');
  } finally {
    held.release();
    await older;
    await checkout;
  }
  assert.equal(env.git.checkouts.length, 1, 'checkout proceeds after the replaced run settles');
}));
