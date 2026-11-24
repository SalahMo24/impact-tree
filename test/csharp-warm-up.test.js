'use strict';
// C#'s editor warm-up and waiting notice (Part C, C6): the warm-up target is the first method
// or constructor of the first changed C# file, read from the outline of its text on disk
// (C-D3: symbols never come from Roslyn), skipped with one log line when the editor offers no
// services or the probe said no; the probe's wait inside `prepare` is reported as a
// `server-wait` progress phase, which the session shows as a ticking message until it ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withEnv, localResult, finding, CSHARP_SOURCE } = require('./extension-env');
const { createFakeClock } = require('./fake-clock');
const { createCsharpProvider, NO_HIERARCHY_NOTE } = require('../src/languages/csharp/provider');

const flush = () => new Promise(setImmediate);
const WARM_AT = CSHARP_SOURCE.indexOf('Warm(');
const LABEL = 'the C# language server (Roslyn)';
const csharpChange = (env) => (o) => localResult(o, { findings: [finding('Warm', path.join(env.dir, 'T.cs'), WARM_AT)] });
const windowProgress = (env) => env.seen.progress.filter((p) => p.options.location === env.vscode.ProgressLocation.Window);

test('a C#-only review warms Roslyn at the first method, inside its class, from the outline', () => withEnv(async (env) => {
  env.hooks.warm = false;
  env.hooks.localPrepared = csharpChange(env);
  env.hooks.serverSymbols = () => assert.fail('symbols never come from Roslyn');
  const warm = env.holds.warmUp.next();
  const running = env.refresh();
  await warm.reached;
  assert.deepEqual(env.seen.warmUpAt.map((w) => [path.basename(w.file), w.pos]), [['T.cs', WARM_AT]], 'the method, not the field before it');
  assert.deepEqual(env.seen.servicesAsked, [], 'Roslyn is asked for nothing');
  warm.release();
  await running;
}, { changedSource: 'csharp' }));

test('the C# warm-up target, without an editor: first method or constructor of the first file only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csharp-warm-'));
  try {
    const files = {
      'Fields.cs': 'class K { int x; public int M() { return 1; } }',
      'Ctor.cs': 'class K { int x; public K() { } public int M() { return 1; } }',
      'Nested.cs': 'class A { class B { void Deep() { } } void Late() { } }',
      'Space.cs': 'namespace N { class K { int x; void M() { void Local() { } } } }',
      'None.cs': 'class K { int x; string P { get; set; } }',
      'Broken.cs': 'class K { void M( }',
    };
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const services = { available: async () => assert.fail('not asked'), documentSymbols: async () => assert.fail('not asked') };
    const log = () => {};
    const provider = createCsharpProvider({ load: async () => ({ ok: true }) });
    const target = (list) => provider.warmUpTarget({ repo: dir, files: list, services, log });
    const at = (name, needle) => ({ file: path.join(dir, name), pos: files[name].indexOf(needle) });
    assert.deepEqual(await target(['Fields.cs']), at('Fields.cs', 'M()'), 'the method, not the field');
    assert.deepEqual(await target(['Ctor.cs']), at('Ctor.cs', 'K() {'), 'a constructor counts');
    assert.deepEqual(await target(['Nested.cs']), at('Nested.cs', 'Deep'), 'through a nested type');
    assert.deepEqual(await target(['Space.cs']), at('Space.cs', 'M()'), 'through a namespace, not the local function');
    assert.equal(await target(['None.cs']), null, 'properties and fields only: none');
    assert.equal(await target(['Broken.cs']), null, 'an unreadable file: none');
    assert.equal(await target(['Missing.cs']), null, 'a file not on disk: none');
    const first = await target(['None.cs', 'Fields.cs']);
    assert.equal(first, null, 'only the first changed C# file is looked at');
    assert.equal(provider.serverLabel, LABEL);
    // Skipped, with one log line each.
    const logged = [];
    assert.equal(await provider.warmUpTarget({ repo: dir, files: ['Fields.cs'], services: null, log: (m) => logged.push(m) }), null);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^warm-up: C# skipped — /);
    // After a no from the probe: skipped, naming its reason; a later yes warms again.
    let answer = { ok: false, reason: 'the C# extension (ms-dotnettools.csharp) is not installed' };
    const probed = createCsharpProvider({ load: async () => answer });
    const hooks = { services: {}, makeResolver: () => ({}) };
    const ctx = { repo: '/nowhere', files: [], baseTexts: new Map(), headTexts: new Map(), changedRanges: {}, deletions: {}, warnings: [], unanalysable: new Map(), notAnalysedFiles: new Map(), report: () => {}, hooks, unit: { component: 'pull request', projectRoot: '' }, syntacticSources: [] };
    await probed.prepare(ctx);
    assert.ok(ctx.warnings.some((w) => w.startsWith(NO_HIERARCHY_NOTE)));
    const loggedNo = [];
    assert.equal(await probed.warmUpTarget({ repo: dir, files: ['Fields.cs'], services, log: (m) => loggedNo.push(m) }), null);
    assert.deepEqual(loggedNo, ['warm-up: C# skipped — the C# extension (ms-dotnettools.csharp) is not installed']);
    answer = { ok: true };
    await probed.prepare({ ...ctx, warnings: [] });
    assert.deepEqual(await probed.warmUpTarget({ repo: dir, files: ['Fields.cs'], services, log }), at('Fields.cs', 'M()'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the provider's server-wait events -------------------------------------------------------

const BASE = 'namespace N;\npublic class A\n{\n    public int Run(int a) { return 1; }\n}\n';
const HEAD = 'namespace N;\npublic class A\n{\n    public int Run(int a, string b) { return 2; }\n}\n';
const makeCtx = (events, signal) => ({
  repo: '/nowhere', files: [{ path: 'src/A.cs', status: 'modified' }],
  baseTexts: new Map([['src/A.cs', BASE]]), headTexts: new Map([['src/A.cs', HEAD]]),
  changedRanges: { 'src/A.cs': [[4, 4]] }, deletions: {},
  warnings: [], unanalysable: new Map(), notAnalysedFiles: new Map(), report: (e) => { if (e.phase === 'server-wait') events.push(e); },
  hooks: { services: {}, makeResolver: () => ({ kind: 'editor' }) },
  unit: { component: 'pull request', projectRoot: '' }, syntacticSources: [{ path: 'src/A.cs', text: HEAD }],
  ...(signal ? { signal } : {}),
});
const START = { phase: 'server-wait', label: LABEL, note: '(callers from the syntax index after 1 s)' };
const END = { phase: 'server-wait', done: true };

test('the probe\'s wait is reported: start before it, end after it, whether yes, no, timeout or abort', async () => {
  const { isAnalysisCancelled } = require('../src/engine/cancellation');
  const clock = createFakeClock();
  /** @type {Array<(a: any) => void>} */
  const resolvers = [];
  let changes = 0;
  const provider = createCsharpProvider({ load: () => new Promise((resolve) => { resolvers.push(resolve); }), serverChanges: () => changes, deadlineMs: 1000, clock });
  // Yes.
  let events = [];
  let pending = provider.prepare(makeCtx(events));
  await flush();
  assert.deepEqual(events, [START], 'reported before the wait');
  resolvers[0]({ ok: true });
  await pending;
  assert.deepEqual(events, [START, END]);
  // A settled yes reused: no events (the load is not waited on).
  events = [];
  await provider.prepare(makeCtx(events));
  assert.deepEqual(events, [], 'a ready yes is reused silently');
  // A state change: a new load; a no ends the notice.
  changes++;
  events = [];
  pending = provider.prepare(makeCtx(events));
  await flush();
  assert.deepEqual(events, [START]);
  resolvers[1]({ ok: false, reason: 'the C# extension is not active' });
  await pending;
  assert.deepEqual(events, [START, END]);
  // The no is asked again: a timeout ends it too, and the next analysis (past the deadline) falls back at once, silently.
  events = [];
  pending = provider.prepare(makeCtx(events));
  await flush();
  await clock.advance(1000);
  await pending;
  assert.deepEqual(events, [START, END]);
  events = [];
  const warnings = [];
  await provider.prepare({ ...makeCtx(events), warnings });
  assert.deepEqual(events, [], 'past its deadline: at once, no notice');
  assert.ok(warnings.some((w) => w.includes('still loading')), warnings.join('\n'));
  // Abort: a new state change starts a fresh load; aborting ends the notice.
  changes++;
  events = [];
  const c = new AbortController();
  pending = provider.prepare(makeCtx(events, c.signal));
  await flush();
  assert.deepEqual(events, [START]);
  c.abort();
  await assert.rejects(pending, (e) => isAnalysisCancelled(e));
  assert.deepEqual(events, [START, END]);
  // A load that settled while no analysis waited, as a yes: reused, no events.
  changes++;
  const early = new AbortController();
  events = [];
  pending = provider.prepare(makeCtx(events, early.signal));
  await flush();
  early.abort();
  await assert.rejects(pending);
  resolvers[resolvers.length - 1]({ ok: true });
  await flush();
  events = [];
  await provider.prepare(makeCtx(events));
  assert.deepEqual(events, [], 'a yes settled between analyses is reused silently');
});

test('after an aborted wait, the next analysis\'s notice names the time left of the deadline, not the whole of it (C6 review)', async () => {
  const clock = createFakeClock();
  const provider = createCsharpProvider({ load: () => new Promise(() => {}), serverChanges: () => 0, deadlineMs: 10000, clock });
  let events = [];
  const c = new AbortController();
  const first = provider.prepare(makeCtx(events, c.signal));
  await flush();
  assert.equal(events[0].note, '(callers from the syntax index after 10 s)');
  await clock.advance(6000);
  c.abort();
  await assert.rejects(first);
  events = [];
  const second = provider.prepare(makeCtx(events));
  await flush();
  assert.equal(events[0].note, '(callers from the syntax index after 4 s)');
  await clock.advance(4000);
  await second;
});

// ---- the session's notice ------------------------------------------------------------------

test('the session shows the wait as a ticking message in the status bar and the Changes view, and clears it when the wait ends', async () => {
  const clock = createFakeClock();
  await withEnv(async (env) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    env.hooks.localProgress = async (onProgress) => {
      onProgress({ phase: 'server-wait', label: LABEL, note: '(callers from the syntax index after 90 s)' });
      await gate;
      onProgress({ phase: 'server-wait', done: true });
    };
    env.hooks.localPrepared = csharpChange(env);
    const running = env.refresh();
    for (let i = 0; i < 200 && !/Waiting for/.test(env.view().message ?? ''); i++) await flush();
    const text = (s) => `Waiting for ${LABEL} to load the projects… ${s} s (callers from the syntax index after 90 s)`;
    assert.match(env.view().message, new RegExp(`(^| · )${text(0).replace(/[().]/g, '\\$&')}$`));
    await clock.advance(12000);
    assert.ok(env.view().message.endsWith(text(12)), env.view().message);
    assert.equal(windowProgress(env)[0].messages.at(-1), text(12));
    release();
    await running;
    assert.ok(!/Waiting for/.test(env.view().message ?? ''), 'the message is cleared');
    assert.ok(windowProgress(env)[0].settled, 'the status-bar progress ended');
    await clock.advance(5000);
    assert.equal(windowProgress(env)[0].messages.at(-1), text(12), 'the timer stopped');
  }, { changedSource: 'csharp', clock });
});

test('a run replaced mid-wait leaves the newer run\'s notice in place, which goes when that run ends (C6 review)', async () => {
  const clock = createFakeClock();
  await withEnv(async (env) => {
    /** @type {Array<() => void>} */
    const gates = [];
    let n = 0;
    env.hooks.localProgress = async (onProgress) => {
      const which = ++n;
      onProgress({ phase: 'server-wait', label: LABEL, note: `(run ${which})` });
      await new Promise((resolve) => { gates.push(() => resolve(undefined)); });
      onProgress({ phase: 'server-wait', done: true });
    };
    env.hooks.localPrepared = csharpChange(env);
    const shows = (s) => (env.view().message ?? '').includes(s);
    const first = env.refresh();
    for (let i = 0; i < 200 && !shows('(run 1)'); i++) await flush();
    assert.ok(shows('(run 1)'), env.view().message);
    const second = env.refresh();
    for (let i = 0; i < 200 && !shows('(run 2)'); i++) await flush();
    assert.ok(shows('(run 2)'), env.view().message);
    gates[0]();
    await first.catch(() => {});
    await flush();
    assert.ok(shows('(run 2)'), `the older run's end leaves the newer run's text: ${env.view().message}`);
    assert.ok(!shows('(run 1)'));
    gates[1]();
    await second;
    assert.ok(!/Waiting for/.test(env.view().message ?? ''), env.view().message);
  }, { changedSource: 'csharp', clock });
});

test('a wait that never reports its end is cleared when the analysis ends', async () => {
  await withEnv(async (env) => {
    env.hooks.localProgress = async (onProgress) => { onProgress({ phase: 'server-wait', label: LABEL }); };
    env.hooks.localPrepared = csharpChange(env);
    await env.refresh();
    assert.ok(!/Waiting for/.test(env.view().message ?? ''), env.view().message);
    assert.ok(windowProgress(env)[0].settled);
  }, { changedSource: 'csharp' });
});
