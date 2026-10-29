'use strict';
// The editor's budget of prepared call hierarchies (MAX_PREPARED_HIERARCHIES in
// src/session/services-vscode.js), over a fake of VS Code's commands that keeps, as VS Code
// does, only the 10 newest prepared models and answers incoming calls of an evicted item with
// `[]` (`_executePrepareCallHierarchy` / `_executeProvideIncomingCalls`):
// - the fake evicts when more than 10 prepares land before their incoming calls are asked;
// - through the services, at concurrency 32, no item is evicted before it is asked and no
//   empty answer comes back;
// - a slot is freed when the incoming calls are sent, when the prepare lists no item or
//   fails, and, for a prepare our deadline gave up on, only when the server answers it;
// - a prepare waiting for a slot past its deadline rejects "timed out", retryable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscodeStub = require('./vscode-stub');
const { createVscodeServices, MAX_PREPARED_HIERARCHIES } = require('../src/session/services-vscode');
const { queryHierarchy } = require('../src/languages/callers-from-hierarchy');
const { createFakeClock } = require('./fake-clock');
const { mapLimit } = require('../src/engine/concurrency');

const flush = () => new Promise(setImmediate);
const until = async (cond, what) => {
  for (let i = 0; i < 2000 && !cond(); i++) await flush();
  assert.ok(cond(), what);
};

// VS Code's model cache size (`size > 10` → dispose the oldest).
const VSCODE_MODEL_CACHE = 10;

// Turns a message takes between the extension and the editor, each way. The same for every
// message, so messages arrive in the order they were sent (setImmediate runs in order).
const TRANSIT_TURNS = 3;
const turns = async (n) => { for (let i = 0; i < n; i++) await flush(); };

/**
 * A repository with one file, and a fake of VS Code's call-hierarchy commands. Each command
 * reaches the editor TRANSIT_TURNS turns after it is sent, and its answer comes back as long.
 * A prepare then waits `prepareDelay()` turns for the server, adds its model (evicting the
 * oldest past 10) and answers one item; incoming calls of an item look its model up on
 * arrival, as the editor does, and answer one call, or `[]` when it was evicted.
 * `answer(name, args)` may replace a command's answer (return undefined to keep the fake's).
 */
function setup(t, { prepareDelay = () => 0, answer = () => undefined } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-prepared-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.go');
  fs.writeFileSync(file, 'package a\nfunc Target() {}\nfunc Caller() { Target() }\n');
  const models = new Map();
  const stats = { evicted: 0, emptyAnswers: 0, sent: [] };
  let nextId = 0;
  const call = { from: { uri: vscodeStub.Uri.file(file), name: 'Caller', selectionRange: { start: { line: 2, character: 5 }, end: { line: 2, character: 11 } } }, fromRanges: [] };
  const vscode = {
    Uri: vscodeStub.Uri,
    Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    commands: {
      executeCommand(name, ...args) {
        stats.sent.push(name);
        const replaced = answer(name, args);
        if (replaced !== undefined) return replaced;
        if (name === 'vscode.prepareCallHierarchy') {
          return (async () => {
            await turns(TRANSIT_TURNS);
            await turns(prepareDelay());
            const id = `m${nextId++}`;
            models.set(id, true);
            for (const key of models.keys()) {
              if (models.size <= VSCODE_MODEL_CACHE) break;
              models.delete(key);
              stats.evicted++;
            }
            await turns(TRANSIT_TURNS);
            return [{ _sessionId: id }];
          })();
        }
        if (name === 'vscode.provideIncomingCalls') {
          return (async () => {
            await turns(TRANSIT_TURNS);
            const found = models.has(args[0]._sessionId);
            if (!found) stats.emptyAnswers++;
            await turns(TRANSIT_TURNS);
            return found ? [call] : [];
          })();
        }
        return Promise.resolve(undefined);
      },
    },
  };
  // coldBudgetMs 0: warm from the start, so queries run in parallel.
  const create = (options = {}) => createVscodeServices({ vscode, repoRoot: dir, coldBudgetMs: 0, ...options });
  return { file, doc: { file, side: 'head' }, models, stats, create, vscode };
}

test('the fake evicts: more than 10 prepares before their incoming calls give empty answers', async (t) => {
  const { vscode, stats } = setup(t);
  const items = await Promise.all(Array.from({ length: 16 }, () => vscode.commands.executeCommand('vscode.prepareCallHierarchy')));
  const answers = await Promise.all(items.map((i) => vscode.commands.executeCommand('vscode.provideIncomingCalls', i[0])));
  assert.equal(answers.filter((a) => a.length === 0).length, 6, 'the 6 oldest were evicted');
  assert.equal(stats.evicted, 6);
});

test(`at concurrency 32 no prepared item is evicted before it is asked (budget ${MAX_PREPARED_HIERARCHIES})`, async (t) => {
  assert.ok(MAX_PREPARED_HIERARCHIES <= VSCODE_MODEL_CACHE);
  // Prepares answer after 0..5 turns, so their answers overtake each other.
  let n = 0;
  const { create, doc, stats } = setup(t, { prepareDelay: () => (n++ * 7) % 6 });
  const services = create();
  // 32 workers (the highest `impactTree.concurrency`), as the analysis runs caller queries.
  const answers = await mapLimit(Array.from({ length: 96 }, (_, i) => i), 32, () => queryHierarchy(services, doc, 16));
  assert.equal(answers.filter((a) => !a.ready).length, 0, 'every query answered');
  assert.equal(stats.emptyAnswers, 0, 'no incoming-calls answer came from an evicted model');
  assert.ok(answers.every((a) => a.ready && a.rows.length === 1), 'every query lists its caller');
});

test('a slot is freed when the incoming calls are sent, so the next prepare goes before that answer', async (t) => {
  const { create, doc, stats } = setup(t);
  const services = create();
  const items = await Promise.all(Array.from({ length: MAX_PREPARED_HIERARCHIES }, () => services.prepareCallHierarchy(doc, 16)));
  const prepares = () => stats.sent.filter((s) => s === 'vscode.prepareCallHierarchy').length;
  assert.equal(prepares(), MAX_PREPARED_HIERARCHIES);
  const waiting = services.prepareCallHierarchy(doc, 16);
  await flush(); await flush();
  assert.equal(prepares(), MAX_PREPARED_HIERARCHIES, 'the next prepare waits for a slot');
  const incoming = services.incomingCalls(items[0][0]);
  await until(() => prepares() === MAX_PREPARED_HIERARCHIES + 1, 'the waiting prepare is sent once an incoming call is');
  assert.equal(stats.sent.indexOf('vscode.provideIncomingCalls') < stats.sent.lastIndexOf('vscode.prepareCallHierarchy'), true, 'after it, in order');
  assert.equal((await incoming).length, 1);
  assert.equal((await waiting).length, 1);
  for (const i of [...items.slice(1), await waiting]) await services.incomingCalls(i[0]);
});

test('a prepare with no item, or one that fails, frees its slot at once', async (t) => {
  let mode = 'empty';
  const { create, doc } = setup(t, {
    answer: (name) => {
      if (name !== 'vscode.prepareCallHierarchy' || mode === 'normal') return undefined;
      return mode === 'empty' ? Promise.resolve([]) : Promise.reject(new Error('boom'));
    },
  });
  const services = create();
  mode = 'normal';
  assert.equal((await queryHierarchy(services, doc, 16)).ready, true, 'the server is up');
  mode = 'empty';
  for (let i = 0; i < MAX_PREPARED_HIERARCHIES + 2; i++) assert.deepEqual(await services.prepareCallHierarchy(doc, 16), []);
  mode = 'fail';
  for (let i = 0; i < MAX_PREPARED_HIERARCHIES + 2; i++) await assert.rejects(services.prepareCallHierarchy(doc, 16), /boom/);
  mode = 'normal';
  const answers = await Promise.all(Array.from({ length: MAX_PREPARED_HIERARCHIES }, () => queryHierarchy(services, doc, 16)));
  assert.ok(answers.every((a) => a.ready && a.rows.length === 1), 'every slot is free again');
});

test('a prepare past our deadline holds its slot until the server answers it; a wait past the deadline is retryable', async (t) => {
  const clock = createFakeClock();
  /** @type {Array<() => void>} */
  const late = [];
  let stall = true;
  const { create, doc, stats } = setup(t, {
    answer: (name) => (name === 'vscode.prepareCallHierarchy' && stall
      ? new Promise((resolve) => { late.push(() => resolve([{ _sessionId: 'late' }])); }) : undefined),
  });
  const services = create({ queryTimeoutMs: 100, clock, retries: 0 });
  const stalled = Array.from({ length: MAX_PREPARED_HIERARCHIES }, () => services.prepareCallHierarchy(doc, 16).then(() => null, (e) => e));
  await flush();
  await clock.advance(100);
  for (const e of await Promise.all(stalled)) {
    assert.match(e.message, /vscode.prepareCallHierarchy timed out after 100 ms/);
    assert.equal(e.retryable, true);
  }
  // Those prepares still run: a late answer adds a model, so their slots stay taken.
  stall = false;
  const sentBefore = stats.sent.length;
  const waiting = services.prepareCallHierarchy(doc, 16).then(() => null, (e) => e);
  await flush(); await flush();
  assert.equal(stats.sent.length, sentBefore, 'nothing sent while every slot is held');
  await clock.advance(100);
  const e = await waiting;
  assert.match(e.message, /timed out/);
  assert.equal(e.retryable, true, 'a wait past the deadline is retryable');
  assert.equal(stats.sent.length, sentBefore, 'the timed-out wait never sent its prepare');
  // The server answers the stalled prepares: their slots come back.
  for (const resolve of late) resolve();
  await flush(); await flush();
  const answer = await queryHierarchy(services, doc, 16);
  assert.equal(answer.ready, true);
  assert.equal(answer.rows.length, 1);
  assert.equal(clock.pending(), 0, 'no timer left behind');
});

test('warm-up frees the slot of its prepare', async (t) => {
  const { create, doc } = setup(t);
  const services = create();
  assert.equal(await services.warmUp(doc, 16, { timeoutMs: 1000 }), true);
  const items = await Promise.all(Array.from({ length: MAX_PREPARED_HIERARCHIES }, () => services.prepareCallHierarchy(doc, 16)));
  assert.equal(items.length, MAX_PREPARED_HIERARCHIES, 'all slots free after warm-up');
  for (const i of items) await services.incomingCalls(i[0]);
});
