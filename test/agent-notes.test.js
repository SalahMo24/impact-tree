'use strict';
// What the user's agent said, on the Changes rows and the diff lenses (src/agent-notes.js,
// tree-item-renderer.js, tree-provider.js, review-lens.js): after the engine's text, never
// instead of it; the engine's order and counts unchanged; gone when the notes are.
const test = require('node:test');
const assert = require('node:assert/strict');
const stub = require('./vscode-stub');
// The stub's EventEmitter never calls anyone; these tests count the repaints.
const vscode = { ...stub, EventEmitter: class {
  constructor() { const ls = []; this.event = (l) => { ls.push(l); return { dispose() {} }; }; this.fire = (v) => ls.forEach((l) => l(v)); this.dispose = () => {}; }
} };
const { createTreeProvider } = require('../src/tree-provider');
const { agentNotes, rowLine, tooltipLines, callerChangeId } = require('../src/agent-notes');
const { lensPlan, lensTitles } = require('../src/review-lens');
const { treeItemId } = require('../src/review-tree-model');

const BODY = { id: 'body', label: 'body' };
const SIG = { id: 'sig', label: 'signature', short: 'sig' };
const NO_SITES = { updated: [], untouched: [], unknown: [] };
const callerOf = (relPath, label, pos) => {
  const sites = [{ start: pos + 1, end: pos + 4 }];
  return { file: `/r/${relPath}`, pos, label, test: false, callSites: sites, sites: 1, callSiteUpdates: { ...NO_SITES, untouched: sites } };
};
const change = (relPath, label, startLine, extra = {}) => ({
  file: `/r/${relPath}`, relPath, label, namePos: startLine * 10, startLine, endLine: startLine + 3, component: '(root)',
  kinds: [BODY], throwsAdded: [], stale: [], staleCallers: 0, callerState: 'none', callers: [], score: 1,
  testState: 'covered', tests: ['spec'], ...extra,
});
const resultOf = (extra = {}) => ({
  allChanged: [], findings: [], deleted: [], outside: [], otherFiles: [], warnings: [], unanalysable: [], untested: [], testUnknown: [],
  testReachComputed: true, reachDepth: 2, mode: 'branch', requestedMode: 'branch', base: { ref: 'origin/main', sha: '0123456789' },
  changedFileCount: 1, fileStatus: {}, ...extra,
});

// verify: one caller (jwt middleware) not updated; sign: no callers, fine.
const handler = callerOf('src/middleware/jwt.ts', 'jwt', 70);
const VERIFY = change('src/jwt.ts', 'verify', 10, { kinds: [SIG], callerState: 'resolved', callers: [handler], staleCallers: 1, stale: [{ label: 'jwt' }] });
const SIGN = change('src/jwt.ts', 'sign', 30);
const RESULT = resultOf({ allChanged: [VERIFY, SIGN], findings: [VERIFY, SIGN] });
const PAYLOAD = {
  cards: [],
  changes: [
    { id: 'src/jwt.ts#100', kind: 'changed', what: 'rejects tokens whose header is not {alg, typ:"JWT"}', before: 'any header', after: 'JwtHeaderInvalid',
      when: 'typ is missing', affects: [{ name: 'jwt (middleware)', how: 'now answers 401 for a bad header' }] },
    { id: 'src/jwt.ts#300', kind: 'new', what: 'takes CryptoKey and JWK keys' },
  ],
};

function providerWith(notes) {
  let current = notes;
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result: RESULT, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) },
    decorate: { register() {}, flush() {} },
    getAgentNotes: () => current,
  });
  return { provider, set: (n) => { current = n; provider.agentChanged(); } };
}
const rowsOf = async (provider) => {
  const [file] = (await provider.getChildren()).filter((r) => r.type === 'reviewFile');
  return (await provider.getChildren(file)).filter((r) => r.type === 'finding');
};
const textOf = (md) => (typeof md === 'string' ? md : md.value);

test('notes: by change id; a caller by name, loosely; nothing without behaviour entries', () => {
  const n = agentNotes(PAYLOAD);
  assert.equal(n.change('src/jwt.ts#100').kind, 'changed');
  assert.equal(n.change('nope#1'), null);
  assert.equal(n.how('src/jwt.ts#100', 'jwt'), 'now answers 401 for a bad header', 'the agent wrote "jwt (middleware)"');
  assert.equal(n.how('src/jwt.ts#100', 'other'), null);
  assert.equal(n.how('src/jwt.ts#300', 'jwt'), null);
  assert.equal(agentNotes({ cards: [] }), null);
  assert.equal(agentNotes(null), null);
  assert.equal(agentNotes({ changes: [{ id: 'a#1', kind: 'odd', what: 'x' }] }), null, 'an unknown kind is ignored');
  assert.equal(rowLine(PAYLOAD.changes[0]), '⚠ rejects tokens whose header is not {alg, typ:"JWT"}');
  assert.equal(rowLine(PAYLOAD.changes[1]), '+ takes CryptoKey and JWK keys');
  assert.deepEqual(tooltipLines(PAYLOAD.changes[1]), ['**Your agent — New:** takes CryptoKey and JWK keys']);
  assert.equal(callerChangeId('/r/src/jwt.ts#100', (f) => f.replace('/r/', '')), 'src/jwt.ts#100');
  assert.equal(callerChangeId('src/a#b.ts#7', null), 'src/a#b.ts#7', 'the last # splits');
});

test('a change row: the engine\'s text first, then the agent\'s line; the tooltip leads with the agent\'s section, escaped', async () => {
  const { provider } = providerWith(agentNotes(PAYLOAD));
  const [verify, sign] = await rowsOf(provider);
  assert.equal(verify.finding.label, 'verify', 'the engine\'s order is kept');
  const item = provider.getTreeItem(verify);
  assert.equal(item.description, '1 of 1 caller not updated  ·  ⚠ rejects tokens whose header is not {alg, typ:"JWT"}');
  const tip = textOf(item.tooltip);
  assert.match(tip, /^\*\*verify\*\*\n\n\*\*Your agent — Changed:\*\* rejects tokens whose header is not \\\{alg, typ:"JWT"\\\}\n\nBefore: any header\n/);
  assert.match(tip, /Affects:\n- jwt \\\(middleware\\\) — now answers 401 for a bad header\n\n---\n\n/);
  assert.match(tip, /\n\n---\n\nThe signature, and 1 of 1 caller was not changed on the call line\./, 'the engine\'s sentence follows');
  assert.equal(provider.getTreeItem(sign).description, 'no callers  ·  + takes CryptoKey and JWK keys');
});

test('a direct caller the agent named shows how it is affected', async () => {
  const { provider } = providerWith(agentNotes(PAYLOAD));
  const [verify] = await rowsOf(provider);
  const under = await provider.getChildren(verify);
  const caller = under.find((r) => r.type === 'caller');
  const item = provider.getTreeItem(caller);
  assert.match(item.description, /  ·  now answers 401 for a bad header$/);
  assert.match(textOf(item.tooltip), /\*\*Your agent:\*\* now answers 401 for a bad header$/);
});

test('no notes, or notes taken away: the rows are the engine\'s, byte for byte', async () => {
  const plain = providerWith(null).provider;
  const [verifyPlain] = await rowsOf(plain);
  const before = plain.getTreeItem(verifyPlain);
  const live = providerWith(agentNotes(PAYLOAD));
  let fired = 0; let agentFired = 0;
  live.provider.onDidChangeTreeData(() => { fired++; });
  live.provider.onDidChangeAgent(() => { agentFired++; });
  live.set(null);   // undo, toggle, or a new head
  assert.deepEqual([fired, agentFired], [1, 1], 'rows repaint, then lenses');
  const [verify] = await rowsOf(live.provider);
  const after = live.provider.getTreeItem(verify);
  assert.equal(after.description, before.description);
  assert.equal(textOf(after.tooltip), textOf(before.tooltip));
});

test('lenses: the agent\'s line first for changed and may-change, at any engine level; none for new or same', async () => {
  const { provider } = providerWith(agentNotes(PAYLOAD));
  const rows = await rowsOf(provider);
  const notes = agentNotes({ changes: [PAYLOAD.changes[0], { id: 'src/jwt.ts#300', kind: 'may-change', what: 'x'.repeat(150) }] });
  const plan = lensPlan(rows, () => false, agentNotes(PAYLOAD).change);
  assert.deepEqual(plan.map((e) => [e.id, lensTitles(e)]), [[treeItemId(rows[0]), {
    agent: '⚠ rejects tokens whose header is not {alg, typ:"JWT"}', verdict: '1 of 1 caller not updated', callers: 'Show callers', tick: 'Mark reviewed' }]],
  'sign is new and fine: no lens');
  // A fine change the agent says may change gets a lens of its own, the line cut to 100 characters; no verdict.
  const [, maybe] = lensPlan(rows, () => false, notes.change);
  assert.equal(maybe.verdict, null);
  assert.equal(lensTitles(maybe).agent.length, 100);
  assert.ok(lensTitles(maybe).agent.startsWith('? xxx') && lensTitles(maybe).agent.endsWith('…'));
  // Without notes, only the engine's lenses, as before.
  assert.deepEqual(lensPlan(rows, () => false).map((e) => lensTitles(e).agent), [null]);
});
