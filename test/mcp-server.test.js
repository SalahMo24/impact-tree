// @ts-check
'use strict';
// The MCP server (src/mcp/server.js, tools in src/mcp/tools.js) over a fake analysis: each
// tool's answer shape, paging and the size cap, bad arguments, and the real SDK over line
// streams (handshake, tools/list, tools/call, the write-back tools with a fake editor
// bridge). A real analysis of a git repository is test/mcp-checkout.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createImpactTools, NO_EDITOR_REASON } = require('../src/mcp/tools');
const { MAX_TEXT_CHARS } = require('../src/mcp/paging');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, parseArgs, assertNodeVersion, HELP, findRepoFor } = require('../src/mcp/server');
const { ToolError } = require('../src/mcp/paging');

const REPO = '/repo';
const files = /** @type {Record<string, string>} */ ({
  '/repo/src/a.ts': 'export function save(x) {\n  return write(x);\n}\nfunction write(x) {}\n',
  '/repo/src/b.ts': 'import { save } from "./a";\nexport function handler() {\n  save(1);\n}\n',
  '/repo/pkg/c.go': 'package pkg\n\nfunc Run() {\n\thelper()\n}\n',
});
const posOf = (/** @type {string} */ file, /** @type {string} */ needle) => files[file].indexOf(needle);

/** The tool context of a small fake PR: a TypeScript function with one caller and a Go function. */
function fakeContext() {
  const save = {
    label: 'save', relPath: 'src/a.ts', file: '/repo/src/a.ts', namePos: posOf('/repo/src/a.ts', 'save'), startLine: 1, endLine: 3,
    baseSig: '(x) => void', headSig: '(x, y?) => void', kinds: [{ id: 'params', label: 'params' }], throwsAdded: [],
    callerState: 'resolved', callersComplete: true, callersIncompleteReason: null, testState: 'uncovered', tests: [],
    callers: [{ label: 'handler', file: '/repo/src/b.ts', pos: posOf('/repo/src/b.ts', 'handler'), test: false, callState: 'untouched', callSites: [{ start: posOf('/repo/src/b.ts', 'save(1)'), end: 0 }] }],
  };
  const run = { label: 'Run', relPath: 'pkg/c.go', file: '/repo/pkg/c.go', namePos: posOf('/repo/pkg/c.go', 'Run'), startLine: 3, endLine: 5, kinds: [{ id: 'body', label: 'body' }],
    callerState: 'unknown', callersComplete: false, callersIncompleteReason: 'Go callers from syntax only', callers: [] };
  const ids = [`src/a.ts#${save.namePos}`, `pkg/c.go#${run.namePos}`];
  const result = {
    base: { ref: 'origin/main', sha: 'abc' }, allChanged: [save, run], deleted: [],
    impactPaths: { [ids[0]]: { id: ids[0], entries: [{ type: 'http', name: 'GET /x', file: 'src/b.ts', depth: 1, via: ['save', 'handler'] }], summary: { ends: { entry: 1 } }, topPaths: [{ end: 'entry', via: ['save', 'handler'] }], complete: true, incompleteReasons: [] } },
  };
  const cards = {
    clusters: [
      { id: 'K1', label: 'save', members: [ids[0]], mirrorMembers: ['deno_dist/a.ts#9'], anchor: ids[0], files: ['src/a.ts'], stats: { members: 1 }, moved: [] },
      { id: 'K2', label: 'Run', members: [ids[1]], files: ['pkg/c.go'], stats: { members: 1 }, moved: [] },
    ],
    sweeps: [], seams: [{ type: 'call', clusters: ['K1', 'K2'] }],
    hints: [{ clusters: ['K1', 'K2'], strength: 2, evidence: [{ type: 'token', token: 'save' }] }],
    hintNotes: ['rare-token hints: capped'],
  };
  const tsResolver = {
    program: () => ({ getSourceFile: (/** @type {string} */ f) => (f.endsWith('.ts') ? {} : undefined) }),
    callerState: async () => ({ state: 'resolved', complete: true, callers: save.callers }),
    findReferences: () => ({ refs: [{ file: '/repo/src/b.ts', start: posOf('/repo/src/b.ts', 'save }'), end: 0 }, { file: '/repo/src/b.ts', start: posOf('/repo/src/b.ts', 'save(1)'), end: 0 }], failed: false }),
  };
  const goResolver = {
    callersLowerBound: true,
    callerState: async () => ({ state: 'unknown', complete: false, reason: 'Go callers from syntax only: test scope', callers: [] }),
  };
  const units = [
    { component: 'web', resolver: tsResolver, files: ['/repo/src/a.ts'] },
    { component: 'go', resolver: goResolver, files: ['/repo/pkg/c.go'], scopeNote: 'Go callers from syntax only: test scope' },
  ];
  return {
    ids,
    ctx: {
      repo: REPO, result, cards, units, notes: [],
      readText: (/** @type {string} */ f) => files[f] ?? null,
      diffOf: () => '@@ -1,3 +1,3 @@\n-export function save(x) {\n+export function save(x, y) {\n',
    },
  };
}

const fakeAnalysis = () => { const f = fakeContext(); return { impl: createImpactTools(f.ctx), ids: f.ids }; };

test('get_card and get_change shapes', async () => {
  const { impl, ids } = fakeAnalysis();
  const card = await impl.call('get_card', { id: 'K1' });
  assert.equal(card.members[0].label, 'save');
  assert.deepEqual(card.members[0].lines, [1, 3]);
  assert.equal(card.impact.entryPoints[0].name, 'GET /x');
  assert.equal(card.complete, true);
  assert.equal(card.mergeHints[0].strength, 2);
  assert.equal(card.seams[0].type, 'call');
  const ch = await impl.call('get_change', { id: ids[0] });
  assert.equal(ch.headSig, '(x, y?) => void');
  assert.deepEqual(ch.callers[0], { label: 'handler', file: 'src/b.ts', line: 2, test: false, callState: 'untouched', callSiteLines: [3] });
  assert.match(ch.hunk, /save\(x, y\)/);
  assert.equal(ch.complete, true);
  const go = await impl.call('get_change', { id: ids[1] });
  assert.equal(go.complete, false);
  assert.deepEqual(go.reasons, ['Go callers from syntax only']);
  assert.equal(await impl.call('nope', {}), null);
});

test('list_cards reports the cards and the limits of the analysis, hint notes included', async () => {
  const { impl } = fakeAnalysis();
  const r = await impl.call('list_cards', {});
  assert.deepEqual(r.cards.map((/** @type {any} */ k) => [k.id, k.members, k.mirrored]), [['K1', 1, 1], ['K2', 1, 0]]);
  assert.deepEqual(r.cards[0].entryTypes, { http: 1 });
  assert.deepEqual(r.limits, ['rare-token hints: capped'], 'a capped step is reported, not silent');
  assert.deepEqual([r.page, r.pages, r.total], [1, 1, 2]);
});

test('callers_of, find_references and impact_paths for any function, with completeness', async () => {
  const { impl } = fakeAnalysis();
  const callers = await impl.call('callers_of', { file: 'src/a.ts', line: 1, name: 'save' });
  assert.equal(callers.complete, true);
  assert.equal(callers.callers[0].label, 'handler');
  const refs = await impl.call('find_references', { file: 'src/a.ts', line: 1, name: 'save' });
  assert.equal(refs.referencesAreCallSitesOnly, false);
  assert.deepEqual(refs.refs.map((/** @type {any} */ r) => r.line), [1, 3]);
  const goRefs = await impl.call('find_references', { file: 'pkg/c.go', line: 3, name: 'Run' });
  assert.equal(goRefs.referencesAreCallSitesOnly, true);
  assert.equal(goRefs.complete, false);
  const goCallers = await impl.call('callers_of', { file: 'pkg/c.go', line: 3, name: 'Run' });
  assert.equal(goCallers.complete, false);
  assert.ok(goCallers.reasons.some((/** @type {string} */ r) => /lower bound/.test(r)));
  const paths = await impl.call('impact_paths', { file: 'src/a.ts', line: 4, name: 'write' });
  assert.equal(paths.target.name, 'write');
  assert.equal(typeof paths.complete, 'boolean');
  assert.ok(Array.isArray(paths.reasons));
  await assert.rejects(impl.call('callers_of', { file: 'src/a.ts', line: 2, name: 'save' }), /not on line 2/);
  await assert.rejects(impl.call('callers_of', { file: '../etc/passwd', line: 1, name: 'x' }), /repository-relative/);
  await assert.rejects(impl.call('callers_of', { file: 'src/x.py', line: 1, name: 'f' }), /cannot read/);
  await assert.rejects(impl.call('callers_of', { file: 'src/a.ts', line: 1, name: 'a b' }), /single identifier/);
  await assert.rejects(impl.call('callers_of', { file: 'src/a.ts', line: 99, name: 'save' }), /has 5 lines/);
  const noUnit = await impl.call('callers_of', { file: 'src/a.ts', line: 1, name: 'save' });
  assert.equal(noUnit.complete, true);
});

test('validate_cards: every id once, mirrors count as their card, unknown ids and empty titles', async () => {
  const { impl, ids } = fakeAnalysis();
  assert.deepEqual(await impl.call('validate_cards', { answer: { cards: [{ title: 'All', members: [ids[0], 'deno_dist/a.ts#9', ids[1]] }] } }), { ok: true, errors: [], cards: 1 });
  const bad = await impl.call('validate_cards', { answer: { cards: [{ title: ' ', members: [ids[0], 'zzz#1'] }, { title: 'B', members: [ids[0]] }] } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    'cards[0]: empty title',
    'cards[0]: unknown id "zzz#1"',
    `${ids[0]} is in more than one card: cards[0], cards[1]`,
    `1 change id(s) in no card: ${ids[1]}`,
  ]);
  assert.deepEqual((await impl.call('validate_cards', { answer: {} })).errors, ['answer.cards must be an array']);
});

test('check_evidence reads the line and its neighbours', async () => {
  const { impl } = fakeAnalysis();
  const yes = await impl.call('check_evidence', { file: 'src/b.ts', line: 3, callee: 'save' });
  assert.equal(yes.ok, true);
  assert.equal(yes.call, true);
  assert.match(yes.text, /3: {3}save\(1\);/);
  const no = await impl.call('check_evidence', { file: 'src/a.ts', line: 4, callee: 'handler' });
  assert.equal(no.ok, false);
  const past = await impl.call('check_evidence', { file: 'src/a.ts', line: 90, callee: 'save' });
  assert.deepEqual([past.ok, past.complete], [false, false], 'a line past the end is incomplete, not a quiet "no"');
  await assert.rejects(impl.call('check_evidence', { file: 'src/a.ts', line: 1, callee: 'a-b' }), /identifier/);
});

test('paging and the size cap', async () => {
  const many = [];
  const allChanged = [];
  for (let i = 0; i < 300; i++) {
    many.push(`src/f${i}.ts#1`);
    allChanged.push({ label: `f${i}_${'x'.repeat(300)}`, relPath: `src/f${i}.ts`, file: `/repo/src/f${i}.ts`, namePos: 1, startLine: 1, endLine: 2, kinds: [] });
  }
  const impl = createImpactTools({ repo: REPO, result: { allChanged, deleted: [], impactPaths: {} }, cards: { clusters: [{ id: 'K1', label: 'big', members: many, stats: {} }], sweeps: [], seams: [] } });
  const p2 = await impl.call('get_card', { id: 'K1', page: 2, pageSize: 10 });
  assert.deepEqual([p2.page, p2.pageSize, p2.total, p2.pages, p2.members[0].id], [2, 10, 300, 30, 'src/f10.ts#1']);
  const last = await impl.call('get_card', { id: 'K1', page: 30, pageSize: 10 });
  assert.equal(last.members.length, 10);
  const beyond = await impl.call('get_card', { id: 'K1', page: 31, pageSize: 10 });
  assert.deepEqual(beyond.members, [], 'past the last page is empty, with the total still given');
  const huge = await impl.call('get_card', { id: 'K1', pageSize: 200 });
  assert.ok(JSON.stringify(huge).length <= MAX_TEXT_CHARS);
  assert.ok(huge.pageSize < 200);
  assert.match(huge.note, /pageSize reduced/);
  for (const bad of [0, -1, 1.5, 201, NaN, '5']) {
    await assert.rejects(impl.call('get_card', { id: 'K1', pageSize: bad }), /pageSize must be an integer/, String(bad));
  }
});

test('code access tools say so when there is no code source', async () => {
  const { impl } = fakeAnalysis();
  await assert.rejects(impl.call('get_source', { file: 'src/a.ts' }), /not available/);
  await assert.rejects(impl.call('list_files', {}), /not available/);
  await assert.rejects(impl.call('search_code', { pattern: 'ab' }), /not available/);
});

test('every input schema refuses what it should', () => {
  const { impl } = fakeAnalysis();
  const schema = (/** @type {string} */ n) => /** @type {any} */ (impl.tools.find((t) => t.name === n)).inputSchema;
  assert.equal(schema('get_card').safeParse({}).success, false, 'id is required');
  assert.equal(schema('get_card').safeParse({ id: 'K1', extra: 1 }).success, false, 'unknown keys are refused');
  assert.equal(schema('callers_of').safeParse({ file: 'a.ts', line: 0, name: 'f' }).success, false);
  assert.equal(schema('callers_of').safeParse({ file: 'a.ts', line: 1.5, name: 'f' }).success, false);
  assert.equal(schema('callers_of').safeParse({ file: 'a.ts', line: 1, name: 'f' }).success, true);
  assert.equal(schema('get_source').safeParse({ file: 'a.ts', side: 'middle' }).success, false);
  assert.equal(schema('search_code').safeParse({ pattern: 'a' }).success, false, 'one character is too short to search');
});

test('parseArgs and the Node version check', () => {
  assert.deepEqual(parseArgs(['--repo', '/r', '--base', 'dev']), { repo: '/r', base: 'dev', remote: 'origin', allowLocalBase: false, deadlineMs: 8000 });
  assert.equal(parseArgs(['--repo', '/r']).base, undefined);
  for (const bad of ['0', '-1', '1.5', 'x', '600001']) assert.throws(() => parseArgs(['--deadline-ms', bad]), /--deadline-ms must be/, bad);
  assert.throws(() => parseArgs(['--repo']), /--repo needs a value/);
  assert.throws(() => parseArgs(['--base', '--repo', '/r']), /--base needs a value/);
  assert.throws(() => assertNodeVersion('18.19.0'), /needs Node 20 or later/);
  assert.doesNotThrow(() => assertNodeVersion('20.0.0'));
  assert.doesNotThrow(() => assertNodeVersion('22.4.1'));
  assert.match(HELP, /Node 20/);
  assert.match(HELP, /extension host/);
});

// ---- the SDK over line streams -------------------------------------------------------

/**
 * A server on in-memory streams, with a fake analysis and (optionally) a fake editor bridge.
 * @param {{ connectBridge?: any, prepare?: any, base?: string }} [extra]
 */
/** Longest wait for one answer from a server under test. Unit: ms. Exhaustion: the request rejects. */
const ANSWER_TIMEOUT_MS = 5000;
/** Inputs of servers still open, so a test that fails before close() cannot keep the file alive. */
const openInputs = new Set();
test.after(() => { for (const input of openInputs) input.end(); });

function connect(/** @type {any} */ extra = {}) {
  const input = new PassThrough();
  openInputs.add(input);
  const output = new PassThrough();
  const f = fakeContext();
  let prepared = 0;
  let disposed = 0;
  const bases = /** @type {Array<string|undefined>} */ ([]);
  const server = startServer({
    options: { repo: REPO, ...(extra.base ? { base: extra.base } : {}), remote: 'origin', allowLocalBase: false, deadlineMs: 1000, ...(extra.options || {}) },
    input, output, ...(extra.findRepo ? { findRepo: extra.findRepo } : {}),
    connectBridge: extra.connectBridge || (async () => null),
    prepare: extra.prepare || (async (/** @type {any} */ _o, /** @type {any} */ p) => {
      prepared++;
      bases.push(p.base);
      return { ctx: f.ctx, headSha: 'headsha', baseSha: 'basesha', dispose: () => { disposed++; } };
    }),
  });
  const waiting = new Map();
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  let next = 1;
  const request = (/** @type {string} */ method, /** @type {any} */ params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`no answer to ${method} within ${ANSWER_TIMEOUT_MS} ms`));
    }, ANSWER_TIMEOUT_MS);
    waiting.set(id, (/** @type {any} */ m) => { clearTimeout(timer); resolve(m); });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (/** @type {string} */ name, /** @type {any} */ args) => (await /** @type {any} */ (request('tools/call', { name, arguments: args }))).result;
  const handshake = async () => {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  return {
    f, request, call, handshake, state: () => ({ prepared, disposed, bases }),
    /** End the agent's side as a client does; resolves when everything is released. */
    close: async () => { openInputs.delete(input); input.end(); await server.closed; },
  };
}

test('handshake, tools/list with the 11 read-only tools, the 2 write-back tools and select_repository, and shape of results', async () => {
  const c = connect();
  const init = /** @type {any} */ (await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'impact-tree');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /submit_cards/);
  assert.equal(c.state().prepared, 0, 'initialize does not start the analysis');
  const list = /** @type {any} */ (await c.request('tools/list')).result.tools;
  assert.equal(c.state().prepared, 0, 'nor does tools/list');
  assert.deepEqual(list.map((/** @type {any} */ t) => t.name), ['list_cards', 'get_card', 'get_change', 'callers_of', 'find_references', 'impact_paths', 'validate_cards', 'check_evidence', 'get_source', 'list_files', 'search_code', 'submit_cards', 'submit_callers', 'select_repository']);
  for (const t of list) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.annotations.readOnlyHint, !t.name.startsWith('submit_'), t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
  const lc = list.find((/** @type {any} */ t) => t.name === 'list_cards');
  assert.equal(lc.inputSchema.properties.pageSize.maximum, 200);
  assert.equal(lc.inputSchema.additionalProperties, false);
  const r = await c.call('list_cards', {});
  assert.equal(r.isError, undefined);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, 'the text mirrors structuredContent');
  assert.equal(c.state().prepared, 1);
  await c.call('get_card', { id: 'K1' });
  assert.equal(c.state().prepared, 1, 'the analysis is kept for the process');
  await c.close();
  assert.equal(c.state().disposed, 1, 'closing the input releases the kept resolvers');
});

test('a 2026 client claims its protocol in _meta and still lists the tools', async () => {
  const c = connect();
  const list = /** @type {any} */ (await c.request('tools/list', { _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
  } }));
  assert.equal(list.result.tools.length, 14);
  await c.close();
});

test('bad arguments and unknown tools are reported, not run', async () => {
  const c = connect();
  await c.handshake();
  const unknownCard = await c.call('get_card', { id: 'K99' });
  assert.equal(unknownCard.isError, true);
  assert.match(unknownCard.content[0].text, /unknown card id K99/);
  for (const [name, args, pattern] of /** @type {Array<[string, any, RegExp]>} */ ([
    ['list_cards', { pageSize: 0 }, /pageSize/],
    ['list_cards', { pageSize: 201 }, /pageSize/],
    ['list_cards', { page: 1.5 }, /page/],
    ['list_cards', { surprise: true }, /surprise/],
    ['get_card', {}, /id/],
    ['callers_of', { file: 'src/a.ts', line: 'one', name: 'save' }, /line/],
    ['get_source', { file: 'a.ts', side: 'middle' }, /side/],
  ])) {
    const r = await c.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, pattern, `${name} ${JSON.stringify(args)}`);
  }
  const traversal = await c.call('callers_of', { file: '../x.ts', line: 1, name: 'f' });
  assert.equal(traversal.isError, true);
  assert.match(traversal.content[0].text, /repository-relative/);
  const unknown = /** @type {any} */ (await c.request('tools/call', { name: 'no_such_tool', arguments: {} }));
  assert.equal(unknown.error ? unknown.error.code : unknown.result.isError, unknown.error ? -32602 : true);
  await c.close();
});

test('an analysis that fails fails every tool call with its message, and nothing is left to dispose', async () => {
  const c = connect({ prepare: async () => { throw new Error('base origin/main not found'); } });
  await c.handshake();
  for (const [tool, args] of /** @type {Array<[string, any]>} */ ([['list_cards', {}], ['get_card', { id: 'K1' }]])) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /The analysis failed: base origin\/main not found/);
  }
  await c.close();
});

/** A fake editor bridge that records what it is asked. */
function fakeBridge(/** @type {any} */ over = {}) {
  const seen = { submits: /** @type {any[]} */ ([]), closed: 0, contexts: 0 };
  const bridge = {
    context: async () => { seen.contexts++; return { repo: REPO, mode: 'pr', base: { ref: 'origin/dev', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, head: 'headsha' }; },
    submit: async (/** @type {string} */ kind, /** @type {any} */ payload, /** @type {any} */ meta) => { seen.submits.push({ kind, payload, meta }); return { stored: true }; },
    close: () => { seen.closed++; },
    ...over,
  };
  return { seen, connectBridge: async () => bridge };
}

test('submit_cards with an editor: checked, forwarded with the head and base, stored', async () => {
  const b = fakeBridge();
  const c = connect({ connectBridge: b.connectBridge });
  await c.handshake();
  const answer = { summary: ' whole PR ', cards: [{ title: ' Save and run ', members: [c.f.ids[0], 'deno_dist/a.ts#9', c.f.ids[1]], reason: 'both change together' }] };
  const r = await c.call('submit_cards', { answer });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { stored: true });
  assert.equal(b.seen.submits.length, 1);
  assert.deepEqual(b.seen.submits[0].meta, { head: 'headsha', base: 'basesha' });
  assert.equal(b.seen.submits[0].kind, 'cards');
  assert.equal(b.seen.submits[0].payload.cards[0].title, 'Save and run', 'the normalised payload is forwarded');
  assert.equal(b.seen.submits[0].payload.summary, 'whole PR');
  assert.deepEqual(c.state().bases, ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], 'the base is the editor\'s base commit (its ref may have moved since) when --base is absent');
  await c.close();
  assert.equal(b.seen.closed, 1, 'the bridge is closed on exit');
});

test('submit_cards with errors: nothing is forwarded, the errors say what to fix', async () => {
  const b = fakeBridge();
  const c = connect({ connectBridge: b.connectBridge });
  await c.handshake();
  const r = await c.call('submit_cards', { answer: { cards: [{ title: 'Only save', members: [c.f.ids[0]] }] } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /submit_cards rejected/);
  assert.match(r.content[0].text, /1 change id\(s\) in no card: pkg\/c\.go#/);
  assert.equal(b.seen.submits.length, 0);
  await c.close();
});

test('submit without an editor: checked, ok, stored false with the reason', async () => {
  const c = connect();
  await c.handshake();
  const r = await c.call('submit_cards', { answer: { cards: [{ title: 'All', members: [...c.f.ids] }] } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent, { stored: false, reason: NO_EDITOR_REASON });
  const callers = await c.call('submit_callers', { answer: { function: 'src/a.ts#' + c.f.ids[0].split('#')[1], callers: [{ file: 'src/b.ts', line: 3, name: 'handler' }] } });
  assert.deepEqual(callers.structuredContent, { stored: false, reason: NO_EDITOR_REASON });
  await c.close();
});

test('submit_callers: evidence is checked, the editor answer is relayed, editor errors become a tool error', async () => {
  const answers = [{ stored: true }, { stored: false, reason: 'the review is closed' }, { stored: false, errors: ['unknown function'] }];
  const b = fakeBridge({ submit: async () => answers.shift() });
  const c = connect({ connectBridge: b.connectBridge });
  await c.handshake();
  const fn = { file: 'src/a.ts', line: 1, name: 'save' };
  const good = { function: fn, callers: [{ file: 'src/b.ts', line: 3, name: 'handler', kind: 'call' }] };
  assert.deepEqual((await c.call('submit_callers', { answer: good })).structuredContent, { stored: true });
  assert.deepEqual((await c.call('submit_callers', { answer: good })).structuredContent, { stored: false, reason: 'the review is closed' });
  const rejected = await c.call('submit_callers', { answer: good });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /editor rejected the callers submission[\s\S]*unknown function/);
  const noEvidence = await c.call('submit_callers', { answer: { function: { file: 'src/a.ts', line: 4, name: 'write' }, callers: [{ file: 'src/b.ts', line: 2 }, { file: 'src/missing.ts', line: 1 }] } });
  assert.equal(noEvidence.isError, true);
  assert.match(noEvidence.content[0].text, /callers\[0\]: write is not mentioned on line 2/);
  assert.match(noEvidence.content[0].text, /callers\[1\]: src\/missing\.ts does not exist at the analysed head/);
  await c.close();
});

test('a bridge that fails is never fatal: connect failure, context failure, submit failure', async () => {
  // Connect fails: headless, base falls back to the default.
  const down = connect({ connectBridge: async () => { throw new Error('socket refused'); } });
  await down.handshake();
  const r = await down.call('submit_cards', { answer: { cards: [{ title: 'All', members: [...down.f.ids] }] } });
  assert.deepEqual(r.structuredContent, { stored: false, reason: NO_EDITOR_REASON });
  assert.deepEqual(down.state().bases, [undefined]);
  await down.close();
  // Context and submit throw: the analysis still runs and the agent is told it was not saved.
  const b = fakeBridge({ context: async () => { throw new Error('boom'); }, submit: async () => { throw new Error('socket closed'); } });
  const flaky = connect({ connectBridge: b.connectBridge });
  await flaky.handshake();
  const s = await flaky.call('submit_cards', { answer: { cards: [{ title: 'All', members: [...flaky.f.ids] }] } });
  assert.equal(s.isError, undefined);
  assert.equal(s.structuredContent.stored, false);
  assert.match(s.structuredContent.reason, /socket closed.*checked, not saved/);
  assert.deepEqual(flaky.state().bases, [undefined]);
  await flaky.close();
});

test('--base wins over the editor base', async () => {
  const b = fakeBridge();
  const c = connect({ connectBridge: b.connectBridge, base: 'release' });
  await c.handshake();
  await c.call('list_cards', {});
  assert.deepEqual(c.state().bases, ['release']);
  assert.equal(b.seen.contexts, 0, 'the editor is not asked when --base is given');
  await c.close();
});

// ---- the real process ----------------------------------------------------------------

test('node src/cli.js mcp: handshake and tools/list over stdio without any analysis, and --help', async () => {
  const { spawnMcp } = require('./mcp-child');
  const os = require('node:os');
  const s = spawnMcp(['--repo', os.tmpdir()]);
  const init = await s.handshake();
  assert.equal(init.result.serverInfo.name, 'impact-tree');
  const list = (await s.request('tools/list')).result.tools;
  assert.equal(list.length, 14);
  assert.ok(list.every((/** @type {any} */ t) => t.inputSchema && t.inputSchema.type === 'object'));
  assert.deepEqual(await s.end(), { code: 0, signal: null }, 'closing the input ends the server');
  assert.doesNotMatch(s.stderr(), /analysed/, 'a client that only lists tools never pays for an analysis');
  const help = spawnMcp(['--help']);
  assert.deepEqual(await help.exited, { code: 0, signal: null });
  assert.match(help.stdout(), /impact-tree mcp/);
  assert.match(help.stdout(), /Node 20/);
  const bad = spawnMcp(['--deadline-ms', '0']);
  assert.equal((await bad.exited).code, 1);
  assert.match(bad.stderr(), /--deadline-ms must be/);
});

// ---- the default repository -----------------------------------------------------------

test('default repository: the git top of the start folder, or "not a repository"', async () => {
  const asked = /** @type {string[]} */ ([]);
  const fake = (/** @type {string|null} */ top) => ({ cwd: '/work/sub/dir', toplevel: (/** @type {string} */ c) => { asked.push(c); return top; } });
  assert.deepEqual(parseArgs([], fake('/work')), { repo: '/work', remote: 'origin', allowLocalBase: false, deadlineMs: 8000 });
  assert.deepEqual(asked, ['/work/sub/dir']);
  assert.equal(parseArgs(['--repo', '/r'], fake('/work')).repo, '/r');
  assert.equal(asked.length, 1, '--repo skips the lookup');
  assert.deepEqual(parseArgs([], fake(null)), { repo: '/work/sub/dir', notRepo: true, remote: 'origin', allowLocalBase: false, deadlineMs: 8000 });
});

test('default repository: the real lookup finds the top from a subfolder and null outside', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { repoToplevel } = require('../src/mcp/server');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-toplevel-')));
  try {
    execFileSync('git', ['init', '-q', path.join(dir, 'r')]);
    fs.mkdirSync(path.join(dir, 'r', 'a', 'b'), { recursive: true });
    assert.equal(fs.realpathSync(/** @type {string} */ (repoToplevel(path.join(dir, 'r', 'a', 'b')))), path.join(dir, 'r'));
    fs.mkdirSync(path.join(dir, 'plain'));
    // Outside any repository (the temp folder is in none).
    if (!repoToplevel(path.join(dir, 'plain'))) assert.equal(repoToplevel(path.join(dir, 'plain')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('not in a repository: the server starts, lists its tools, and every tool returns the error', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let prepared = 0;
  const server = startServer({
    options: { repo: '/not/a/repo', notRepo: true, remote: 'origin', allowLocalBase: false, deadlineMs: 1000 }, input, output,
    prepare: async () => { prepared++; throw new Error('must not analyse'); },
    // No agent workspace folders and no editor window: the lookup must not see this machine's real ones.
    findRepo: (/** @type {any} */ p) => findRepoFor({ ...p, editorRepos: () => [] }),
  });
  const lines = /** @type {any[]} */ ([]);
  output.setEncoding('utf8');
  let buf = '';
  output.on('data', (d) => { buf += d; let nl; while ((nl = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
  const send = (/** @type {any} */ m) => input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const until = async (/** @type {number} */ id) => { for (let i = 0; i < 200; i++) { const m = lines.find((l) => l.id === id); if (m) return m; await new Promise((r) => setTimeout(r, 10)); } throw new Error('no answer to ' + id); };
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal((await until(1)).result.serverInfo.name, 'impact-tree');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  const tools = (await until(2)).result.tools;
  assert.ok(tools.length >= 10);
  let id = 3;
  // The SDK checks arguments first, so give each required one a value of its type.
  const dummy = (/** @type {any} */ sch) => (sch.type === 'number' || sch.type === 'integer' ? 1 : sch.type === 'array' ? [] : sch.type === 'boolean' ? true : sch.enum ? sch.enum[0]
    : sch.type === 'object' ? Object.fromEntries((sch.required || []).map((/** @type {string} */ k) => [k, dummy(sch.properties[k] || {})])) : 'xx');
  const argsOf = (/** @type {any} */ t) => dummy(t.inputSchema);
  for (const t of tools.filter((/** @type {any} */ x) => x.name !== 'select_repository')) {
    const n = id++;
    send({ id: n, method: 'tools/call', params: { name: t.name, arguments: argsOf(t) } });
    const r = (await until(n)).result;
    assert.equal(r.isError, true, t.name);
    assert.ok(r.content[0].text.startsWith('start your agent inside a git repository (this folder is not one): /not/a/repo. Also tried: '), t.name);
    assert.match(r.content[0].text, /does not share its workspace folders.*no editor window has Impact Tree's agents setting.*call select_repository/, t.name);
  }
  assert.equal(prepared, 0);
  input.end(); await server.closed;
});

// ---- finding the repository when the start folder is in none -----------------------------

const sdkWithRoots = (/** @type {string[]|null} */ uris) => ({ server: {
  getClientCapabilities: () => (uris ? { roots: {} } : {}),
  listRoots: async () => ({ roots: (uris || []).map((uri) => ({ uri })) }),
} });
const tops = (/** @type {Record<string,string>} */ map) => (/** @type {string} */ dir) => map[dir] || null;

test('findRepoFor: the agent\'s one workspace repository, else the one editor window; several or none is an error', async () => {
  const toplevel = tops({ '/w/hono': '/w/hono', '/w/hono/src': '/w/hono', '/w/cli': '/w/cli', '/e/one': '/e/one', '/e/two': '/e/two' });
  const none = () => [];
  assert.deepEqual(await findRepoFor({ cwd: '/home', sdk: sdkWithRoots(['file:///w/hono/src', 'file:///w/notes']), toplevel, editorRepos: none }),
    { repo: '/w/hono', from: 'the agent\'s workspace folder' });
  await assert.rejects(findRepoFor({ cwd: '/home', sdk: sdkWithRoots(['file:///w/hono', 'file:///w/cli']), toplevel, editorRepos: () => [{ repo: '/e/one', askedAt: null }] }),
    (e) => e instanceof ToolError && /several git repositories; call select_repository with the repository to review \(one of: \/w\/cli, \/w\/hono\); do not change the MCP configuration/.test(e.message));
  // No roots from the agent: the editor window decides; one that is no longer a repository is skipped.
  assert.deepEqual(await findRepoFor({ cwd: '/home', sdk: sdkWithRoots(null), toplevel, editorRepos: () => [{ repo: '/e/one', askedAt: null }, { repo: '/gone', askedAt: null }] }),
    { repo: '/e/one', from: 'the editor window with Impact Tree\'s agents setting on' });
  assert.deepEqual((await findRepoFor({ cwd: '/home', sdk: sdkWithRoots(['https://x/y']), toplevel, editorRepos: () => [{ repo: '/e/two', askedAt: null }] })).repo, '/e/two');
  await assert.rejects(findRepoFor({ cwd: '/home', sdk: null, toplevel, editorRepos: () => [{ repo: '/e/one', askedAt: null }, { repo: '/e/two', askedAt: null }] }),
    (e) => e instanceof ToolError && /more than one editor window .*call select_repository .*one of: \/e\/one, \/e\/two/.test(e.message));
  await assert.rejects(findRepoFor({ cwd: '/home', sdk: sdkWithRoots([]), toplevel, editorRepos: none }),
    (e) => e instanceof ToolError && /this folder is not one\): \/home\. Also tried: none of the agent's workspace folders/.test(e.message));
  const failing = { server: { getClientCapabilities: () => ({ roots: {} }), listRoots: async () => { throw new Error('boom'); } } };
  await assert.rejects(findRepoFor({ cwd: '/home', sdk: failing, toplevel, editorRepos: none }), /workspace folders could not be read \(boom\)/);
});

test('not in a repository: a failed lookup is not kept; the next call looks again and analyses what it finds', async () => {
  let lookups = 0;
  const s = connect({
    options: { repo: '/home', notRepo: true },
    findRepo: async () => { lookups++; if (lookups === 1) throw new ToolError('not yet'); return { repo: REPO, from: 'test' }; },
  });
  await s.handshake();
  const first = await s.call('list_cards', {});
  assert.equal(first.isError, true);
  assert.equal(first.content[0].text, 'not yet');
  assert.equal(s.state().prepared, 0);
  const second = await s.call('list_cards', {});
  assert.ok(!second.isError, second.content[0].text);
  assert.equal(lookups, 2);
  assert.equal(s.state().prepared, 1);
  await s.close();
});

test('liveEditorRepos: only live, well-formed locks filed under their own repository', () => {
  const P = require('../src/mcp/bridge-protocol');
  const { liveEditorRepos } = require('../src/mcp/bridge-client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itl-'));
  fs.chmodSync(dir, 0o700);
  const lock = (/** @type {string} */ repo, /** @type {number} */ pid) => ({ version: 1, pid, repo, socket: path.join(dir, 'x.sock'), token: 'a'.repeat(64), startedAt: 1 });
  fs.writeFileSync(P.lockPathFor(dir, '/r/live'), JSON.stringify(lock('/r/live', process.pid)));
  fs.writeFileSync(P.lockPathFor(dir, '/r/dead'), JSON.stringify(lock('/r/dead', 2 ** 30)));
  fs.writeFileSync(P.lockPathFor(dir, '/r/bad'), '{not json');
  fs.writeFileSync(P.lockPathFor(dir, '/r/elsewhere'), JSON.stringify(lock('/r/other', process.pid)));   // filed under another name
  assert.deepEqual(liveEditorRepos({ lockDir: dir }), [{ repo: '/r/live', askedAt: null }]);
  fs.writeFileSync(P.lockPathFor(dir, '/r/live'), JSON.stringify({ ...lock('/r/live', process.pid), askedAt: 1234 }));
  assert.deepEqual(liveEditorRepos({ lockDir: dir }), [{ repo: '/r/live', askedAt: 1234 }]);
  fs.writeFileSync(P.lockPathFor(dir, '/r/live'), JSON.stringify({ ...lock('/r/live', process.pid), askedAt: 'soon' }));
  assert.deepEqual(liveEditorRepos({ lockDir: dir }), [], 'a lock with a malformed askedAt is not trusted');
  assert.deepEqual(liveEditorRepos({ lockDir: path.join(dir, 'missing') }), []);
});

test('findRepoFor: among several editor windows, the one where "Analyse with my agent" was pressed last in the past 30 minutes', async () => {
  const toplevel = tops({ '/e/one': '/e/one', '/e/two': '/e/two', '/e/three': '/e/three' });
  const now = () => 10_000_000;
  const editors = (/** @type {Array<number|null>} */ asked) => () => ['/e/one', '/e/two', '/e/three'].map((repo, i) => ({ repo, askedAt: asked[i] }));
  assert.deepEqual(await findRepoFor({ cwd: '/home', sdk: null, toplevel, now, editorRepos: editors([null, 9_000_000, 9_500_000]) }),
    { repo: '/e/three', from: 'the editor window where "Analyse with my agent" was pressed last' });
  // Pressed more than 30 minutes ago, or (clock skew) in the future: not counted.
  await assert.rejects(findRepoFor({ cwd: '/home', sdk: null, toplevel, now, editorRepos: editors([null, 10_000_000 - 31 * 60_000, 10_000_001]) }),
    (e) => e instanceof ToolError && /call select_repository/.test(e.message));
});

test('select_repository: names the repository when the server cannot tell; switching drops the analysis so far', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const make = (/** @type {string} */ name) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `it-sel-${name}-`))); execFileSync('git', ['init', '-q'], { cwd: d }); return d; };
  const one = make('one'); const two = make('two');
  const seenRepos = /** @type {string[]} */ ([]);
  const s = connect({
    options: { repo: '/home', notRepo: true },
    findRepo: async () => { throw new ToolError('more than one editor window; call select_repository'); },
    prepare: async (/** @type {any} */ o) => { seenRepos.push(o.repo); return { ctx: fakeContext().ctx, headSha: 'h', baseSha: 'b', dispose: () => {} }; },
  });
  await s.handshake();
  assert.equal((await s.call('list_cards', {})).isError, true);
  const bad = await s.call('select_repository', { repo: 'relative/path' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not a folder inside a git repository/);
  assert.deepEqual((await s.call('select_repository', { repo: path.join(one, '.') })).structuredContent, { repo: one, changed: true });
  assert.ok(!(await s.call('list_cards', {})).isError);
  assert.deepEqual((await s.call('select_repository', { repo: one })).structuredContent, { repo: one, changed: false });
  assert.deepEqual((await s.call('select_repository', { repo: two })).structuredContent, { repo: two, changed: true });
  assert.ok(!(await s.call('list_cards', {})).isError);
  assert.deepEqual(seenRepos, [one, two]);
  assert.equal(s.state().disposed, 0, 'the fake prepare above has its own dispose');
  await s.close();
});

test('list_cards with detail: members, entry points, seams and merge hints per card; without it, the short form', async () => {
  const s = connect();
  await s.handshake();
  const short = (await s.call('list_cards', {})).structuredContent;
  assert.equal(short.cards[0].memberList, undefined);
  const full = (await s.call('list_cards', { detail: true })).structuredContent;
  assert.equal(full.cards.length, short.cards.length);
  for (const c of full.cards) {
    assert.ok(Array.isArray(c.memberList) && c.memberList.length === Math.min(c.members, 40), c.id);
    assert.ok(c.memberList.every((/** @type {any} */ m) => typeof m.id === 'string' && typeof m.label === 'string'), c.id);
    assert.ok(Array.isArray(c.entryPoints) && typeof c.entryPointsTotal === 'number' && Array.isArray(c.seamsWith) && Array.isArray(c.mergeHints), c.id);
    assert.ok(!c.seamsWith.includes(c.id), 'a card has no seam with itself');
  }
  assert.ok(JSON.stringify(full).length <= MAX_TEXT_CHARS);
  await s.close();
});
