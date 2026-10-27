'use strict';
// The launcher's supervisor (src/mcp/supervisor.js): a server that exits for new code is
// restarted, with the session replayed and the waiting call resent; a crash answers errors;
// and the code watch (src/mcp/code-watch.js) that decides when the code changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { supervise, RELOAD_EXIT_CODE } = require('../src/mcp/supervisor');
const { createCodeWatch } = require('../src/mcp/code-watch');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-supervisor-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// A fake server: logs what it receives to <log>, answers initialize and tools/call with its
// generation, and on tools/call exits with the code that `behaviour(generation)` names.
const FAKE = path.join(TMP, 'fake-server.js');
fs.writeFileSync(FAKE, `
const fs = require('fs');
const [log, counter, mode] = process.argv.slice(2);
const gen = (Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) || 0) + 1;
fs.writeFileSync(counter, String(gen));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    fs.appendFileSync(log, JSON.stringify({ gen, method: m.method || null, id: m.id === undefined ? null : m.id }) + '\\n');
    const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
    if (m.method === 'initialize') send({ id: m.id, result: { gen } });
    if (m.method === 'tools/call') {
      if (mode === 'reload-once' && gen === 1) process.exit(${RELOAD_EXIT_CODE});
      if (mode === 'reload-always') process.exit(${RELOAD_EXIT_CODE});
      if (mode === 'crash-once' && gen === 1) process.exit(3);
      if (mode === 'ask' && gen === 1) { send({ id: 'r1', method: 'roots/list' }); continue; }
      send({ id: m.id, result: { gen } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);

function run(mode) {
  const dir = fs.mkdtempSync(path.join(TMP, `${mode}-`));
  const log = path.join(dir, 'log'); const counter = path.join(dir, 'counter');
  const input = new PassThrough(); const output = new PassThrough();
  const got = []; const notes = [];
  const waiters = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (d) => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) !== -1) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); for (const w of [...waiters]) w(); }
  });
  const sup = supervise({
    cliPath: 'unused', args: [], input, output, log: (m) => notes.push(m),
    spawnChild: () => spawn(process.execPath, [FAKE, log, counter, mode], { stdio: ['pipe', 'pipe', 'inherit'] }),
  });
  const send = (m) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const until = (pred) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(got)}`)), 5000);
    const check = () => { const hit = got.find(pred); if (hit) { clearTimeout(t); waiters.splice(waiters.indexOf(check), 1); resolve(hit); } };
    waiters.push(check); check();
  });
  const seen = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { send, until, got, notes, seen, close: async () => { input.end(); return sup.done; } };
}

async function handshake(s) {
  s.send({ id: 1, method: 'initialize', params: {} });
  await s.until((m) => m.id === 1);
  s.send({ method: 'notifications/initialized' });
}

test('new code: the server exits, a new one gets the session replayed and the waiting call; the agent sees one answer', async () => {
  const s = run('reload-once');
  await handshake(s);
  s.send({ id: 2, method: 'tools/call', params: { name: 'submit_cards' } });
  const answer = await s.until((m) => m.id === 2);
  assert.deepEqual(answer.result, { gen: 2 }, 'answered by the new server');
  assert.equal(s.got.filter((m) => m.id === 1).length, 1, 'the replayed initialize\'s answer is dropped');
  assert.ok(s.got.some((m) => m.method === 'notifications/tools/list_changed'));
  assert.deepEqual(s.seen().filter((e) => e.gen === 2).map((e) => [e.method, e.id]),
    [['initialize', 1], ['notifications/initialized', null], ['tools/call', 2]]);
  assert.match(s.notes.join('|'), /code changed: restarting/);
  assert.equal(await s.close(), 0);
});

test('a crash: the waiting call gets an error; the next call starts a new server with the session replayed', async () => {
  const s = run('crash-once');
  await handshake(s);
  s.send({ id: 2, method: 'tools/call', params: {} });
  const failed = await s.until((m) => m.id === 2);
  assert.match(failed.error.message, /stopped \(exit 3\) before answering/);
  s.send({ id: 3, method: 'tools/call', params: {} });
  assert.deepEqual((await s.until((m) => m.id === 3)).result, { gen: 2 });
  assert.deepEqual(s.seen().filter((e) => e.gen === 2).map((e) => e.method), ['initialize', 'notifications/initialized', 'tools/call']);
  await s.close();
});

test('a server that exits on every try: the call is resent 3 times, then an error', async () => {
  const s = run('reload-always');
  await handshake(s);
  s.send({ id: 2, method: 'tools/call', params: {} });
  const failed = await s.until((m) => m.id === 2);
  assert.match(failed.error.message, /restarted several times/);
  assert.equal(s.seen().filter((e) => e.method === 'tools/call').length, 4);
  await s.close();
});

test('answers to an old server\'s own requests are not passed to the new one', async () => {
  const s = run('ask');
  await handshake(s);
  s.send({ id: 2, method: 'tools/call', params: {} });
  await s.until((m) => m.method === 'roots/list');
  s.send({ id: 'r1', result: { roots: [] } });
  s.send({ id: 'r-unknown', result: {} });
  s.send({ id: 3, method: 'initialize', params: {} });   // anything, to see what reached the server after
  await s.until((m) => m.id === 3);
  const ids = s.seen().map((e) => e.id);
  assert.ok(ids.includes('r1'), 'the answer to its own request reaches it');
  assert.ok(!ids.includes('r-unknown'), 'an answer to nothing it asked is dropped');
  await s.close();
});

test('code watch: a content change counts; touching a file or saving the same content does not', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'ext-'));
  fs.mkdirSync(path.join(root, 'src', 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const f = path.join(root, 'src', 'mcp', 'server.js');
  fs.writeFileSync(f, 'a');
  const w = createCodeWatch(root);
  assert.equal(w.changed(), false);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  fs.writeFileSync(f, 'a');
  assert.equal(w.changed(), false, 'same content');
  fs.writeFileSync(path.join(root, 'src', 'new.js'), 'x');
  assert.equal(w.changed(), true, 'a new file');
  fs.rmSync(path.join(root, 'src', 'new.js'));
  assert.equal(w.changed(), false, 'back to the same code');
  fs.writeFileSync(f, 'b');
  assert.equal(w.changed(), true);
});
