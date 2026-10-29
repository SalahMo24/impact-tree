'use strict';
// The bridge between the editor and the user's own agent (src/agent-bridge.js) and the MCP
// server's client of it (src/mcp/bridge-client.js), over real sockets in a temp directory.
// The submission validator (AI3a) and the repository's HEAD are injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { createAgentBridge, STORAGE_KEY, MAX_ENTRIES_PER_HEAD, MAX_HEADS } = require('../src/agent-bridge');
const { connectBridge } = require('../src/mcp/bridge-client');
const P = require('../src/mcp/bridge-protocol');

const SHA = (c) => c.repeat(40);
const vscodeFake = { EventEmitter: class {
  constructor() { const ls = []; this.event = (l) => { ls.push(l); return { dispose() {} }; }; this.fire = (v) => { for (const l of ls) l(v); }; this.dispose = () => { ls.length = 0; }; }
} };

// A short directory: a Unix socket path is limited to about 100 bytes.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'itb-'));

/** One editor window on a fresh repository directory, with a fake session and workspace state. */
function editor({ lockDir = tmp(), repo = tmp(), validator = () => ({ ok: true }), head = SHA('a'), source = { kind: 'local' }, tierA = false, updateDelayMs = 0, idleTimeoutMs } = {}) {
  const memento = new Map();
  // `updateDelayMs` makes every storage write take that long, and records whether two ran at once.
  const writing = { now: 0, overlapped: false };
  const session = { state: { result: { mode: 'pr', base: { ref: 'main', sha: SHA('b') }, tierA }, source, cards: { clusters: [] } }, repoRoot: () => repo };
  const logs = [];
  const world = { head, validated: [] };
  const bridge = createAgentBridge(vscodeFake, {
    session, log: (m) => logs.push(m), lockDir,
    workspaceState: { get: (k) => memento.get(k), update: async (k, v) => {
      writing.now++;
      if (writing.now > 1) writing.overlapped = true;
      if (updateDelayMs) await new Promise((r) => setTimeout(r, updateDelayMs));
      memento.set(k, JSON.parse(JSON.stringify(v)));
      writing.now--;
    } },
    validator: (kind, payload, given) => { world.validated.push({ kind, payload, given }); return validator(kind, payload, given); },
    readHead: async () => world.head,
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
  });
  const stored = [];
  bridge.onDidStoreResult((e) => stored.push(e));
  return { bridge, session, memento, lockDir, repo, logs, world, stored, writing };
}

const meta = (e) => ({ head: e.world.head, base: SHA('b') });
const lockFileOf = (e) => P.lockPathFor(e.lockDir, P.realRepo(e.repo));

/** Sends raw lines on a new connection and collects the replies until it closes or `count` arrive. */
function raw(socketPath, lines, count = lines.length) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const replies = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => { for (const l of lines) socket.write(l); });
    socket.on('data', (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); }
      if (replies.length >= count) { socket.destroy(); resolve(replies); }
    });
    socket.on('close', () => resolve(replies));
    socket.on('error', (err) => (replies.length ? resolve(replies) : reject(err)));
  });
}

test('setting off: starting nothing leaves no lock file and no socket', async () => {
  const e = editor();
  assert.equal(e.bridge.address, null);
  assert.deepEqual(fs.readdirSync(e.lockDir), []);
  await e.bridge.stop();           // stopping what never started is harmless
  assert.deepEqual(fs.readdirSync(e.lockDir), []);
  assert.equal(await connectBridge({ repo: e.repo, lockDir: e.lockDir }), null);
});

test('start writes a 0600 lock file with the right fields in a 0700 directory, and a client connects', async () => {
  const lockDir = path.join(tmp(), 'bridge');
  const e = editor({ lockDir });
  await e.bridge.start();
  try {
    const lock = JSON.parse(fs.readFileSync(lockFileOf(e), 'utf8'));
    assert.equal(lock.version, 1);
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.repo, P.realRepo(e.repo));
    assert.match(lock.token, /^[0-9a-f]{64}$/);
    assert.equal(lock.socket, e.bridge.address.socket);
    assert.equal(typeof lock.startedAt, 'number');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(lockFileOf(e)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(lockDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(lock.socket).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(lockDir).filter((f) => f.endsWith('.tmp')), []);
    }
    const client = await connectBridge({ repo: e.repo, lockDir });
    assert.ok(client);
    assert.deepEqual(await client.context(), { repo: P.realRepo(e.repo), mode: 'pr', base: { ref: 'main', sha: SHA('b') }, head: SHA('a') });
    client.close();
  } finally { await e.bridge.stop(); }
});

test('a request with the wrong token is refused and the connection closed', async () => {
  const e = editor();
  await e.bridge.start();
  try {
    const replies = await raw(e.bridge.address.socket, [JSON.stringify({ id: 1, token: 'x'.repeat(64), method: 'context', params: {} }) + '\n']);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].error.message, 'bad token');
    assert.equal(replies[0].result, undefined);
    const noToken = await raw(e.bridge.address.socket, [JSON.stringify({ id: 2, method: 'context' }) + '\n']);
    assert.equal(noToken[0].error.message, 'bad token');
  } finally { await e.bridge.stop(); }
});

test('malformed requests are refused without crashing the bridge', async () => {
  const e = editor();
  await e.bridge.start();
  try {
    assert.equal((await raw(e.bridge.address.socket, ['not json\n']))[0].error.message, 'malformed request');
    assert.equal((await raw(e.bridge.address.socket, [JSON.stringify({ id: { a: 1 }, token: 'x' }) + '\n']))[0].error.message, 'malformed request');
    const token = JSON.parse(fs.readFileSync(lockFileOf(e), 'utf8')).token;
    const [r] = await raw(e.bridge.address.socket, [JSON.stringify({ id: 3, token, method: 'rm -rf', params: {} }) + '\n']);
    assert.equal(r.error.message, 'unknown method');
    const [again] = await raw(e.bridge.address.socket, [JSON.stringify({ id: 4, token, method: 'context' }) + '\n']);
    assert.equal(again.result.head, SHA('a'));
  } finally { await e.bridge.stop(); }
});

test('a line over 2 MB is refused', async () => {
  const e = editor();
  await e.bridge.start();
  try {
    const token = JSON.parse(fs.readFileSync(lockFileOf(e), 'utf8')).token;
    const big = JSON.stringify({ id: 1, token, method: 'submit', params: { pad: 'x'.repeat(P.MAX_LINE_BYTES + 10) } }) + '\n';
    const [r] = await raw(e.bridge.address.socket, [big]);
    assert.equal(r.error.message, 'request too large');
    assert.deepEqual(e.stored, []);
  } finally { await e.bridge.stop(); }
});

test('at most 4 connections are served at once', async () => {
  const e = editor();
  await e.bridge.start();
  const held = [];
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve, reject) => { const s = net.connect(e.bridge.address.socket, resolve); s.on('error', reject); held.push(s); });
    }
    const fifth = net.connect(e.bridge.address.socket);
    fifth.on('error', () => {});
    await new Promise((resolve) => fifth.on('close', resolve));
    held[0].destroy();
  } finally { for (const s of held) s.destroy(); await e.bridge.stop(); }
});

test('a stale lock (dead pid) is ignored by the client and replaced by start', async () => {
  const e = editor();
  const file = lockFileOf(e);
  const staleSocket = path.join(e.lockDir, 'dead.sock');
  fs.writeFileSync(staleSocket, '');
  fs.writeFileSync(file, JSON.stringify({ version: 1, pid: 2 ** 22 + 12345, repo: P.realRepo(e.repo), socket: staleSocket, token: 'a'.repeat(64), startedAt: 1 }), { mode: 0o600 });
  assert.equal(await connectBridge({ repo: e.repo, lockDir: e.lockDir }), null);
  await e.bridge.start();
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.notEqual(lock.socket, staleSocket);
    assert.equal(fs.existsSync(staleSocket), false, 'the dead editor\'s socket file is removed');
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    assert.ok(client);
    client.close();
  } finally { await e.bridge.stop(); }
});

test('the client ignores a malformed lock, a wrong version, and a lock naming another repository', async () => {
  const e = editor();
  await e.bridge.start();
  try {
    const file = lockFileOf(e);
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const bad of ['{not json', JSON.stringify({ ...good, version: 2 }), JSON.stringify({ ...good, repo: '/somewhere/else' }),
      JSON.stringify({ ...good, token: 'short' }), JSON.stringify({ ...good, pid: 'x' })]) {
      fs.writeFileSync(file, bad);
      assert.equal(await connectBridge({ repo: e.repo, lockDir: e.lockDir }), null, bad.slice(0, 30));
    }
    fs.writeFileSync(file, JSON.stringify(good));
    assert.equal(await connectBridge({ repo: e.repo, lockDir: e.lockDir, signal: AbortSignal.abort() }), null, 'an aborted signal');
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    assert.ok(client);
    client.close();
  } finally { await e.bridge.stop(); }
});

test('context: the current review; null while it is a preview or nothing is finished', async () => {
  const e = editor({ source: { kind: 'checkout', pr: { number: 42 } } });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    assert.deepEqual((await client.context()).pr, { number: 42 });
    e.session.state = { ...e.session.state, source: { kind: 'pr', pr: { number: 42 } } };
    assert.equal(await client.context(), null, 'a preview');
    e.session.state = { ...e.session.state, source: { kind: 'local' }, result: { ...e.session.state.result, tierA: true } };
    assert.equal(await client.context(), null, 'a tier A result is a preview too');
    e.session.state = { ...e.session.state, result: null };
    assert.equal(await client.context(), null, 'no finished review');
    client.close();
  } finally { await e.bridge.stop(); }
});

test('submit: a preview is refused with a reason', async () => {
  const e = editor({ source: { kind: 'pr', pr: { number: 7 } } });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    const out = await client.submit('cards', { a: 1 }, meta(e));
    assert.equal(out.stored, false);
    assert.match(out.reason, /preview/);
    assert.equal(e.world.validated.length, 0);
    client.close();
  } finally { await e.bridge.stop(); }
});

test('submit: a moved head or base is refused; the validator sees the current analysis', async () => {
  const e = editor();
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    const moved = await client.submit('cards', { a: 1 }, { head: SHA('c'), base: SHA('b') });
    assert.equal(moved.stored, false);
    assert.equal(moved.reason, `the editor's review moved to ${SHA('a')}; re-run on it`);
    assert.equal((await client.submit('cards', { a: 1 }, { head: SHA('a'), base: SHA('d') })).stored, false);
    assert.equal(e.world.validated.length, 0);
    assert.equal((await client.submit('cards', { a: 1 }, meta(e))).stored, true);
    assert.equal(e.world.validated[0].given.result, e.session.state.result);
    assert.equal(e.world.validated[0].given.cards, e.session.state.cards);
    assert.equal(e.world.validated[0].given.repo, require('fs').realpathSync(e.repo));   // submitted callers are read from it
    client.close();
  } finally { await e.bridge.stop(); }
});

test('submit: a validator that throws refuses the result with a reason, and the bridge keeps serving', async () => {
  const e = editor({ validator: () => { throw new TypeError('no readText'); } });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    const out = await client.submit('callers', { a: 1 }, meta(e));
    assert.deepEqual(out, { stored: false, reason: 'the editor could not check the result' });
    assert.ok(await client.context());
    client.close();
  } finally { await e.bridge.stop(); }
});

test('submit: validator errors are returned and nothing is stored', async () => {
  const e = editor({ validator: () => ({ ok: false, errors: ['card 3 names a change that is not in the review'] }) });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    const out = await client.submit('cards', { a: 1 }, meta(e));
    assert.equal(out.stored, false);
    assert.deepEqual(out.errors, ['card 3 names a change that is not in the review']);
    assert.equal(e.memento.has(STORAGE_KEY), false);
    assert.deepEqual(e.stored, []);
    client.close();
  } finally { await e.bridge.stop(); }
});

test('submit: stored under the head keyed by kind and normalised payload, event fired, duplicates ignored', async () => {
  const e = editor({ validator: (kind, payload) => ({ ok: true, normalised: { ...payload, normalised: true } }) });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    assert.deepEqual(await client.submit('cards', { b: 1, a: 2 }, meta(e)), { stored: true });
    assert.equal(e.stored.length, 1);
    assert.equal(e.stored[0].kind, 'cards');
    assert.equal(e.stored[0].head, SHA('a'));
    const [entry] = e.bridge.resultsFor(SHA('a'));
    assert.equal(entry.key, e.stored[0].key);
    assert.deepEqual(entry.payload, { b: 1, a: 2, normalised: true });
    assert.equal(typeof entry.storedAt, 'number');
    // Same content with the keys in another order: the same entry.
    const again = await client.submit('cards', { a: 2, b: 1 }, meta(e));
    assert.equal(again.stored, true);
    assert.equal(e.stored.length, 1, 'no second event');
    assert.equal(e.bridge.resultsFor(SHA('a')).length, 1);
    // The same payload as another kind is another entry.
    await client.submit('callers', { b: 1, a: 2 }, meta(e));
    assert.equal(e.bridge.resultsFor(SHA('a')).length, 2);
    assert.deepEqual(e.bridge.resultsFor(SHA('z')), []);
    client.close();
  } finally { await e.bridge.stop(); }
});

test('submit: a payload over 512 KB is refused; a bad kind or shape is refused', async () => {
  const e = editor();
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    const big = await client.submit('cards', { text: 'x'.repeat(P.MAX_PAYLOAD_BYTES + 1) }, meta(e));
    assert.equal(big.stored, false);
    assert.match(big.reason, /limit/);
    assert.equal((await client.submit('nope', { a: 1 }, meta(e))).stored, false);
    assert.equal((await client.submit('cards', 'text', meta(e))).stored, false);
    assert.equal((await client.submit('cards', { a: 1 }, { head: 5 })).stored, false);
    assert.equal(e.world.validated.length, 0);
    client.close();
  } finally { await e.bridge.stop(); }
});

test('storage caps: 20 entries per head (oldest dropped) and 10 heads (oldest head dropped)', async () => {
  let clock = 1000;
  const e = editor();
  const bridge = createAgentBridge(vscodeFake, {
    session: e.session, log: () => {}, lockDir: e.lockDir, clock: { now: () => clock++ }, validator: () => ({ ok: true }), readHead: async () => e.world.head,
    workspaceState: { get: (k) => e.memento.get(k), update: async (k, v) => { e.memento.set(k, JSON.parse(JSON.stringify(v))); } },
  });
  await bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    for (let i = 0; i < MAX_ENTRIES_PER_HEAD + 3; i++) await client.submit('cards', { n: i }, meta(e));
    const list = bridge.resultsFor(SHA('a'));
    assert.equal(list.length, MAX_ENTRIES_PER_HEAD);
    assert.deepEqual(list.map((x) => x.payload.n), Array.from({ length: MAX_ENTRIES_PER_HEAD }, (_, i) => i + 3));
    for (let h = 0; h < MAX_HEADS + 2; h++) {
      e.world.head = (h + 1).toString(16).padStart(2, '0').repeat(20);
      assert.equal((await client.submit('callers', { h }, meta(e))).stored, true);
    }
    const kept = Object.keys(e.memento.get(STORAGE_KEY));
    assert.equal(kept.length, MAX_HEADS);
    assert.equal(kept.includes(SHA('a')), false, 'the oldest head went first');
    assert.equal(bridge.resultsFor('01'.repeat(20)).length, 0);
    assert.equal(bridge.resultsFor('0c'.repeat(20)).length, 1);
    client.close();
  } finally { await bridge.stop(); }
});

test('corrupt stored data is ignored, not trusted', async () => {
  const e = editor();
  e.memento.set(STORAGE_KEY, { [SHA('a')]: [{ kind: 'bogus', key: 1 }, 'x', { kind: 'cards', key: 'k', storedAt: 5, payload: {} }], other: 'text' });
  assert.deepEqual(e.bridge.resultsFor(SHA('a')).map((x) => x.key), ['k']);
  assert.deepEqual(e.bridge.resultsFor('other'), []);
  e.memento.set(STORAGE_KEY, [1, 2]);
  assert.deepEqual(e.bridge.resultsFor(SHA('a')), []);
});

test('stop removes the lock and the socket, and the client then finds nothing; start again works', async () => {
  const e = editor();
  await e.bridge.start();
  const { socket, lockFile } = e.bridge.address;
  const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
  await e.bridge.stop();
  assert.equal(fs.existsSync(lockFile), false);
  if (process.platform !== 'win32') assert.equal(fs.existsSync(socket), false);
  assert.equal(e.bridge.address, null);
  await assert.rejects(() => client.context());
  assert.equal(await connectBridge({ repo: e.repo, lockDir: e.lockDir }), null);
  await e.bridge.start();
  assert.ok(fs.existsSync(lockFile));
  e.bridge.dispose();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(lockFile), false);
});

test('stop leaves a lock that another process has taken over', async () => {
  const e = editor();
  await e.bridge.start();
  const { lockFile } = e.bridge.address;
  const mine = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, JSON.stringify({ ...mine, pid: process.ppid, token: 'f'.repeat(64) }));
  await e.bridge.stop();
  assert.equal(fs.existsSync(lockFile), true);
});

test('two editors on different repositories do not see each other', async () => {
  const lockDir = tmp();
  const one = editor({ lockDir, head: SHA('1') });
  const two = editor({ lockDir, head: SHA('2') });
  await one.bridge.start();
  await two.bridge.start();
  try {
    assert.notEqual(lockFileOf(one), lockFileOf(two));
    const c1 = await connectBridge({ repo: one.repo, lockDir });
    const c2 = await connectBridge({ repo: two.repo, lockDir });
    assert.equal((await c1.context()).head, SHA('1'));
    assert.equal((await c2.context()).head, SHA('2'));
    await c1.submit('cards', { a: 1 }, meta(one));
    assert.equal(one.bridge.resultsFor(SHA('1')).length, 1);
    assert.equal(two.bridge.resultsFor(SHA('1')).length, 0);
    assert.equal(await connectBridge({ repo: tmp(), lockDir }), null, 'a third repository has no bridge');
    c1.close(); c2.close();
  } finally { await one.bridge.stop(); await two.bridge.stop(); }
});

test('a start overtaken by a stop leaves nothing behind', async () => {
  const e = editor();
  const starting = e.bridge.start();
  await e.bridge.stop();
  await starting;
  assert.equal(e.bridge.address, null);
  assert.deepEqual(fs.readdirSync(e.lockDir), []);
});

test('a client request that is not answered in time fails', async () => {
  const lockDir = tmp();
  const repo = tmp();
  const socketPath = path.join(lockDir, 'silent.sock');
  const server = net.createServer((s) => s.on('data', () => {}));
  await new Promise((r) => server.listen(socketPath, r));
  fs.writeFileSync(P.lockPathFor(lockDir, P.realRepo(repo)), JSON.stringify({ version: 1, pid: process.pid, repo: P.realRepo(repo), socket: socketPath, token: 'a'.repeat(64), startedAt: 1 }));
  try {
    const client = await connectBridge({ repo, lockDir, requestTimeoutMs: 100 });
    await assert.rejects(() => client.context(), /in time/);
    client.close();
  } finally { server.close(); }
});

// ---- AI5: Undo and the request log ----

test('removeResult: takes out one result, fires an event, drops an empty head, ignores an unknown key', async () => {
  const e = editor({ validator: (kind, payload) => ({ ok: true, normalised: payload }) });
  const removed = [];
  e.bridge.onDidRemoveResult((x) => removed.push(x));
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    await client.submit('cards', { n: 1 }, meta(e));
    await client.submit('cards', { n: 2 }, meta(e));
    const [first, second] = e.bridge.resultsFor(SHA('a'));
    assert.equal(await e.bridge.removeResult(SHA('a'), 'no-such-key'), false);
    assert.equal(await e.bridge.removeResult(SHA('z'), first.key), false, 'another head');
    assert.deepEqual(removed, []);
    assert.equal(await e.bridge.removeResult(SHA('a'), first.key), true);
    assert.deepEqual(e.bridge.resultsFor(SHA('a')).map((r) => r.key), [second.key]);
    assert.deepEqual(removed, [{ kind: 'cards', head: SHA('a'), key: first.key }]);
    assert.equal(await e.bridge.removeResult(SHA('a'), second.key), true);
    assert.deepEqual(e.memento.get(STORAGE_KEY), {}, 'the head is dropped');
    // Removed means storable again.
    assert.deepEqual(await client.submit('cards', { n: 1 }, meta(e)), { stored: true });
    client.close();
  } finally { await e.bridge.stop(); }
});

test('removeResult runs in the queue of the other writes: none overlaps, none is lost', async () => {
  const e = editor({ validator: (kind, payload) => ({ ok: true, normalised: payload }), updateDelayMs: 15 });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    await client.submit('cards', { n: 1 }, meta(e));
    const [one] = e.bridge.resultsFor(SHA('a'));
    const [, removed] = await Promise.all([client.submit('cards', { n: 2 }, meta(e)), e.bridge.removeResult(SHA('a'), one.key), client.submit('cards', { n: 3 }, meta(e))]);
    assert.equal(removed, true);
    assert.equal(e.writing.overlapped, false);
    assert.deepEqual(e.bridge.resultsFor(SHA('a')).map((r) => r.payload.n).sort(), [2, 3]);
    client.close();
  } finally { await e.bridge.stop(); }
});

test('the log has one line per request and never the payload', async () => {
  const secret = 'SECRET-TITLE-DO-NOT-LOG';
  let verdict = { ok: true };
  const e = editor({ validator: () => verdict });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    await client.context();
    await client.submit('cards', { cards: [{ title: secret }] }, meta(e));
    await client.submit('cards', { cards: [{ title: secret }] }, meta(e));
    verdict = { ok: false, errors: [`${secret} is wrong`] };
    await client.submit('callers', { function: secret }, meta(e));
    await client.submit('cards', { cards: [{ title: secret }] }, { head: SHA('f'), base: SHA('b') });
    client.close();
    const lines = e.logs.filter((l) => l.startsWith('agent: '));
    assert.deepEqual(lines, [
      'agent: context asked',
      'agent: cards submitted — stored',
      'agent: cards submitted — already stored',
      'agent: callers submitted — refused: the result does not match the editor\'s review',
      `agent: cards submitted — refused: the editor's review moved to ${SHA('a')}; re-run on it`,
    ]);
    assert.ok(!e.logs.some((l) => l.includes(secret)));
  } finally { await e.bridge.stop(); }
});

test('markAsked writes when this window asked into its lock, and the client lists it', async () => {
  const e = editor();
  assert.equal(e.bridge.markAsked(), false, 'not running: nothing to mark');
  await e.bridge.start();
  try {
    const before = JSON.parse(fs.readFileSync(e.bridge.address.lockFile, 'utf8'));
    assert.equal(before.askedAt, undefined);
    assert.equal(e.bridge.markAsked(), true);
    const after = JSON.parse(fs.readFileSync(e.bridge.address.lockFile, 'utf8'));
    assert.equal(typeof after.askedAt, 'number');
    assert.deepEqual({ ...after, askedAt: undefined }, { ...before, askedAt: undefined }, 'the rest of the lock is unchanged');
    assert.equal(fs.statSync(e.bridge.address.lockFile).mode & 0o777, 0o600);
    const { liveEditorRepos } = require('../src/mcp/bridge-client');
    assert.deepEqual(liveEditorRepos({ lockDir: e.lockDir }), [{ repo: fs.realpathSync(e.repo), askedAt: after.askedAt }]);
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    assert.ok(await client.context(), 'the client still connects with the new lock');
    client.close();
  } finally { await e.bridge.stop(); }
});

test('the client reopens its connection after the editor closed it for being idle; close() ends it for good', async () => {
  const e = editor({ idleTimeoutMs: 100 });
  await e.bridge.start();
  try {
    const client = await connectBridge({ repo: e.repo, lockDir: e.lockDir });
    assert.ok(await client.context());
    await new Promise((r) => setTimeout(r, 300));   // the editor drops the idle connection
    assert.equal((await client.submit('cards', { a: 1 }, meta(e))).stored, true, 'a submit after the idle gap reconnects');
    assert.ok(await client.context());
    client.close();
    await assert.rejects(client.context(), /closed/);
  } finally { await e.bridge.stop(); }
});
