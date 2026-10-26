'use strict';
// Impact paths (src/engine/impact-paths.js) over fake resolvers: how each path ends, the
// limits at, below and above their value, cycles, diamonds, lower-bound answers, the
// deadline on a fake clock, and cancellation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { impactPathsFor, createImpactWalker, validateLimits, withoutScopeNote } = require('../src/engine/impact-paths');
const { createFakeClock } = require('./fake-clock');

const REPO = '/repo';
const abs = (rel) => `${REPO}/${rel}`;

/**
 * A graph of functions, each `name -> { file, callers: [names], test?, text? }`. Every
 * function sits at offset 10 of its file (files hold one function each unless shared).
 */
function fakeGraph(nodes, { status = {}, state = {}, lowerBound = false, onQuery } = {}) {
  const byKey = new Map();
  const rowOf = (name) => ({ label: name, file: abs(nodes[name].file), pos: nodes[name].pos ?? 10, test: !!nodes[name].test, sites: 0, callSites: [] });
  for (const name of Object.keys(nodes)) byKey.set(`${abs(nodes[name].file)}#${nodes[name].pos ?? 10}`, name);
  const queries = [];
  const callersOf = async (file, pos, withTests) => {
    const name = byKey.get(`${file}#${pos}`);
    queries.push(name);
    if (onQuery) await onQuery(name);
    return (nodes[name].callers || []).map(rowOf).filter((r) => withTests || !r.test);
  };
  const resolver = {
    incoming: async (file, pos, withTests) => callersOf(file, pos, withTests),
    callerState: async (file, pos) => {
      const name = byKey.get(`${file}#${pos}`);
      return state[name] || { state: 'none', callers: [], complete: true };
    },
    ...(lowerBound ? { callersLowerBound: true } : {}),
  };
  if (Object.keys(status).length || lowerBound) {
    resolver.incomingWithStatus = async (file, pos, withTests) => {
      const callers = await callersOf(file, pos, withTests);
      const name = byKey.get(`${file}#${pos}`);
      return status[name] || { callers, complete: true };
    };
  }
  const texts = {};
  for (const name of Object.keys(nodes)) texts[abs(nodes[name].file)] = nodes[name].text ?? `// ${name}\n`;
  return { resolver, queries, readText: (f) => texts[f] ?? null, changed: (name, extra = {}) => ({ label: name, file: abs(nodes[name].file), relPath: nodes[name].file, namePos: nodes[name].pos ?? 10, callers: [], ...extra }) };
}

const run = (g, name, opts = {}) => impactPathsFor({ units: [{ resolver: g.resolver, changed: [g.changed(name, opts.extra)] }], repo: REPO, readText: g.readText, ...opts })
  .then((r) => r.byId[`${g.changed(name).relPath}#${g.changed(name).namePos}`]);

// A route file: `handler` calls the walked function inside `app.get('/x', …)`.
const routeText = "function handler(app) {\n  app.get('/x', (c) => mid(c));\n}\n";

test('a path ends at an entry found through the call site, with the full path', async () => {
  const g = fakeGraph({
    leaf: { file: 'a.ts', callers: ['mid'] },
    mid: { file: 'b.ts', callers: ['handler'] },
    handler: { file: 'r.ts', pos: 9, text: routeText },
  });
  // The caller row carries the call-site offset.
  const orig = g.resolver.incoming;
  g.resolver.incoming = async (file, pos, t) => (await orig(file, pos, t)).map((r) => (r.label === 'handler' ? { ...r, callSites: [{ start: routeText.indexOf('mid(c)'), end: 0 }] } : r));
  const r = await run(g, 'leaf');
  assert.deepEqual(r.entries.map((e) => [e.type, e.name, e.file, e.depth, e.via.join('<')]), [['http', 'GET /x', 'r.ts', 2, 'leaf<mid<handler']]);
  assert.deepEqual(r.summary.ends, { entry: 1, 'top-unidentified': 0, budget: 0, unknown: 0 });
  assert.equal(r.complete, true);
  assert.deepEqual(r.incompleteReasons, []);
});

test('a changed function that is itself an entry counts at depth 0 and is not walked', async () => {
  const text = "@Controller('u')\nclass C {\n  @Get()\n  list() {}\n}\n";
  const g = fakeGraph({ list: { file: 'c.ts', pos: text.indexOf('list'), text, callers: ['x'] }, x: { file: 'x.ts' } });
  const r = await run(g, 'list');
  assert.equal(r.entries[0].depth, 0);
  assert.equal(r.entries[0].name, 'GET /u');
  assert.deepEqual(g.queries, []);
});

test('a top with no callers is top-unidentified; one passed as a value is unknown', async () => {
  const g = fakeGraph({
    leaf: { file: 'a.ts', callers: ['top', 'valued'] },
    top: { file: 't.ts' },
    valued: { file: 'v.ts' },
  }, { state: { valued: { state: 'unknown', callers: [], complete: false, reason: 'referenced-as-value' } } });
  const r = await run(g, 'leaf');
  assert.deepEqual(r.summary.ends, { entry: 0, 'top-unidentified': 1, budget: 0, unknown: 1 });
  assert.equal(r.complete, false);
  assert.deepEqual(r.incompleteReasons, ['referenced as a value (passed or registered), never called directly']);
  assert.equal(r.topPaths.find((p) => p.end === 'top-unidentified').topKind, 'function');
});

test('module-level code is a top of kind module, not queried', async () => {
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['m.ts'] }, 'm.ts': { file: 'm.ts', pos: 0 } });
  const r = await run(g, 'leaf');
  assert.equal(r.topPaths[0].topKind, 'module');
  assert.deepEqual(g.queries, ['leaf']);
  assert.equal(r.complete, false);
  assert.deepEqual(r.incompleteReasons, ['module-level code on a path: what loads the module is not traced']);
});

test('an incomplete answer ends a path unknown and still walks the callers it found', async () => {
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['up'] }, up: { file: 'u.ts' } },
    { status: { leaf: { callers: [{ label: 'up', file: abs('u.ts'), pos: 10, test: false, sites: 0, callSites: [] }], complete: false, reason: 'query-failed' } } });
  const r = await run(g, 'leaf');
  assert.deepEqual(r.summary.ends, { entry: 0, 'top-unidentified': 1, budget: 0, unknown: 1 });
  assert.deepEqual(r.incompleteReasons, ['query-failed']);
});

test('a lower-bound resolver: the scope note alone is not a gap, every path is marked', async () => {
  const note = 'Go callers from syntax only: the module (3 Go file(s) indexed); calls through an interface are not resolved';
  const g = fakeGraph({ leaf: { file: 'a.go', callers: ['top'] }, top: { file: 't.go' } }, {
    lowerBound: true,
    status: {
      leaf: { callers: [{ label: 'top', file: abs('t.go'), pos: 10, test: false, sites: 0, callSites: [] }], complete: false, reason: note },
      top: { callers: [], complete: false, reason: `${note}; 2 call(s) named top on a receiver that could not be resolved` },
    },
  });
  const w = createImpactWalker({ repo: REPO, readText: g.readText });
  await w.walk(g.resolver, [g.changed('leaf')], { scopeNote: note });
  const r = w.byId['a.go#10'];
  assert.deepEqual(r.summary.ends, { entry: 0, 'top-unidentified': 0, budget: 0, unknown: 1 });
  assert.ok(r.topPaths.every((p) => p.lowerBound));
  assert.equal(r.complete, false);
  assert.deepEqual(r.incompleteReasons, ['2 call(s) named top on a receiver that could not be resolved', 'callers come from a syntax-only index: each answer is a lower bound']);
  assert.deepEqual(withoutScopeNote({ callers: [], complete: false, reason: note }, note), { callers: [], complete: true, reason: undefined });
});

test('depth limit: a chain one longer than maxDepth ends budget, one equal does not', async () => {
  const chain = (n) => {
    const nodes = {};
    for (let i = 0; i <= n; i++) nodes[`f${i}`] = { file: `f${i}.ts`, callers: i < n ? [`f${i + 1}`] : [] };
    return fakeGraph(nodes);
  };
  const atLimit = await run(chain(2), 'f0', { limits: { maxDepth: 3 } });
  assert.deepEqual(atLimit.summary.ends, { entry: 0, 'top-unidentified': 1, budget: 0, unknown: 0 });
  const over = await run(chain(3), 'f0', { limits: { maxDepth: 3 } });
  assert.deepEqual(over.summary.ends, { entry: 0, 'top-unidentified': 0, budget: 1, unknown: 0 });
  assert.deepEqual(over.incompleteReasons, ['depth limit of 3 caller levels']);
});

test('node limit: exactly maxNodes callers finish, one more ends budget', async () => {
  const wide = (n) => {
    const nodes = { leaf: { file: 'a.ts', callers: [] } };
    for (let i = 0; i < n; i++) { nodes[`c${i}`] = { file: `c${i}.ts` }; nodes.leaf.callers.push(`c${i}`); }
    return fakeGraph(nodes);
  };
  const exact = await run(wide(3), 'leaf', { limits: { maxNodes: 3 } });
  assert.equal(exact.summary.visited, 3);
  assert.equal(exact.complete, true);
  const over = await run(wide(4), 'leaf', { limits: { maxNodes: 3 } });
  assert.equal(over.summary.visited, 3);
  assert.equal(over.complete, false);
  assert.ok(over.summary.ends.budget >= 1);
});

test('cycles are cut and a diamond reaches its entry once', async () => {
  const text = 'package main\n\nfunc main() {}\n';
  const g = fakeGraph({
    leaf: { file: 'a.go', callers: ['b', 'c'] },
    b: { file: 'b.go', callers: ['main', 'leaf'] },
    c: { file: 'c.go', callers: ['main', 'c'] },
    main: { file: 'cmd/x/main.go', pos: text.indexOf('main()'), text },
  });
  const r = await run(g, 'leaf');
  assert.equal(r.entries.length, 1);
  assert.deepEqual([r.entries[0].type, r.entries[0].name, r.entries[0].depth], ['main', 'cmd/x', 2]);
  assert.equal(r.summary.visited, 3);
});

test('tests are counted from the direct callers and never walked', async () => {
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['spec', 'top'] }, spec: { file: 'a.test.ts', test: true, callers: ['x'] }, top: { file: 't.ts' }, x: { file: 'x.ts' } });
  const r = await run(g, 'leaf', { extra: { callers: [{ label: 'spec', file: abs('a.test.ts'), pos: 10, test: true }] } });
  assert.equal(r.summary.testCallers, 1);
  assert.ok(!g.queries.includes('spec'));
});

test('topPaths prefer a path through a caller not updated, then entries, then shortest', async () => {
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['p', 'q'] }, p: { file: 'p.ts' }, q: { file: 'q.ts' } });
  const r = await run(g, 'leaf', { extra: { kinds: [{ id: 'params' }], stale: [{ file: abs('q.ts'), pos: 10, callState: 'untouched' }] } });
  assert.deepEqual(r.topPaths[0].via, ['leaf', 'q']);
  assert.equal(r.topPaths[0].throughStale, true);
});

test('throughStale needs a signature or throw change, and a caller that is not itself changed', async () => {
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['p', 'q'] }, p: { file: 'p.ts' }, q: { file: 'q.ts' } });
  const stale = [{ file: abs('q.ts'), pos: 10, callState: 'untouched' }, { file: abs('p.ts'), pos: 10, callState: 'changed-elsewhere' }];
  const bodyOnly = await run(g, 'leaf', { extra: { kinds: [{ id: 'body' }], stale } });
  assert.ok(bodyOnly.topPaths.every((p) => !p.throughStale));
  const risky = await run(g, 'leaf', { extra: { kinds: [{ id: 'body' }, { id: 'throws' }], stale } });
  assert.deepEqual(risky.topPaths.filter((p) => p.throughStale).map((p) => p.via.join('<')), ['leaf<q']);
});

test('a function only tests call: test-only top, and testOnly when every path ends so', async () => {
  const g = fakeGraph({ helper: { file: 'h.ts', callers: ['spec'] }, spec: { file: 'h.test.ts', test: true } },
    { state: { helper: { state: 'resolved', callers: [{ label: 'spec', file: abs('h.test.ts'), pos: 10, test: true }], complete: true } } });
  const r = await run(g, 'helper');
  assert.equal(r.testOnly, true);
  assert.equal(r.topPaths[0].topKind, 'test-only');
  // One production top besides: not test-only.
  const g2 = fakeGraph({ leaf: { file: 'a.ts', callers: ['helper', 'top'] }, helper: { file: 'h.ts', callers: ['spec'] }, spec: { file: 'h.test.ts', test: true }, top: { file: 't.ts' } },
    { state: { helper: { state: 'resolved', callers: [{ label: 'spec', file: abs('h.test.ts'), pos: 10, test: true }], complete: true } } });
  const r2 = await run(g2, 'leaf');
  assert.equal(r2.testOnly, false);
  assert.deepEqual(r2.topPaths.map((p) => p.topKind).sort(), ['function', 'test-only']);
});

test('a package bin file\'s module code ends a path as app start, not as an entry', async () => {
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['index.ts'] }, 'index.ts': { file: 'src/index.ts', pos: 0 } });
  const r = await run(g, 'leaf', { facts: { binFiles: new Map([['src/index.ts', 't3']]) } });
  assert.deepEqual(r.entries, []);
  assert.deepEqual([r.topPaths[0].end, r.topPaths[0].topKind, r.topPaths[0].bin], ['top-unidentified', 'app-start', 't3']);
  assert.equal(r.complete, true);
});

test('the deadline ends every open path budget once it passes', async () => {
  const clock = createFakeClock();
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['b'] }, b: { file: 'b.ts', callers: ['c'] }, c: { file: 'c.ts' } }, {
    onQuery: () => clock.advance(60),
  });
  const r = await run(g, 'leaf', { clock, limits: { deadlineMs: 100 } });
  assert.deepEqual(g.queries, ['leaf', 'b']);
  assert.deepEqual(r.summary.ends, { entry: 0, 'top-unidentified': 0, budget: 1, unknown: 0 });
  assert.deepEqual(r.incompleteReasons, ['deadline of 100 ms for all impact paths']);
});

test('invalid limits are refused, cancellation rejects', async () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '8']) assert.throws(() => validateLimits({ maxDepth: bad }), RangeError);
  assert.deepEqual(validateLimits(undefined), { maxDepth: 8, maxNodes: 300, deadlineMs: 30000 });
  const controller = new AbortController();
  const g = fakeGraph({ leaf: { file: 'a.ts', callers: ['b'] }, b: { file: 'b.ts' } }, { onQuery: () => controller.abort() });
  await assert.rejects(run(g, 'leaf', { signal: controller.signal }), (e) => e.code === 'ANALYSIS_CANCELLED');
});
