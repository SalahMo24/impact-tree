'use strict';
// Callers in one file share a row, and the worst call state leads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const vscode = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');

// A caller-file group takes its worst member's state: △ (changed elsewhere) needs more
// attention than ○ (not changed), which needs more than ✓ (call updated).
test('a caller-file group shows the worst state of its callers', async () => {
  const callerOf = (pos, state) => ({
    file: '/repo/src/user.js', pos, label: `user${pos}`, test: false, sites: 1,
    callSites: [{ start: pos, end: pos + 1, updated: state === 'updated-at-call' }], state,
  });
  // A caller row resolves its own callers on expand: these are the callers of `target`.
  const target = { type: 'caller', file: '/repo/src/target.js', pos: 3, label: 'target', path: [] };
  const groupState = async (...states) => {
    const callers = states.map((s, i) => callerOf(10 + i, s));
    const provider = createTreeProvider(vscode, {
      getState: () => ({
        result: { allChanged: [], excludedCallerPaths: [] }, rowDetail: 'hover', rel: (f) => f.replace('/repo/', ''),
        changedKeys: new Set(callers.filter((c) => c.state === 'changed-elsewhere').map((c) => `${c.file}#${c.pos}`)),
        classifyCallSiteUpdates: (_, sites) => ({
          updated: sites.filter((s) => s.updated), untouched: sites.filter((s) => !s.updated), unknown: [],
        }),
      }),
      resolver: { incomingWithStatus: async () => ({ callers, complete: true }) },
    });
    const kids = await provider.getChildren(target);
    assert.deepEqual(kids.map((k) => k.type), ['callerFile'], states.join(','));
    assert.deepEqual(kids[0].callers.map((k) => k.callState), states, 'members keep their own state');
    return kids[0].callState;
  };
  assert.equal(await groupState('unchanged', 'changed-elsewhere'), 'changed-elsewhere');
  assert.equal(await groupState('changed-elsewhere', 'unchanged', 'updated-at-call'), 'changed-elsewhere');
  assert.equal(await groupState('updated-at-call', 'changed-elsewhere'), 'changed-elsewhere');
  assert.equal(await groupState('updated-at-call', 'unchanged'), 'unchanged');
  assert.equal(await groupState('unchanged', 'updated-at-call', 'unchanged'), 'unchanged');
  assert.equal(await groupState('updated-at-call', 'updated-at-call'), 'updated-at-call');
});
