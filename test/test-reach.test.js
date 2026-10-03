'use strict';
// Test reachability keeps its uncertainty: a failed, incomplete or budget-limited walk
// that found no test is 'unknown', never 'uncovered'. The walk is driven through its
// public function with hand-built caller graphs, and the settings that bound it are
// validated like impactTree.concurrency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { walkTestReach } = require('../src/engine/test-reach');

// graph: caller lists by node name ("who calls X"). `tests` are test files; `failing`
// throws; `partial` answers with complete:false. Nodes are files named by their label.
function resolverOf(callers, { tests = [], failing = [], partial = {}, status = true } = {}) {
  const queried = [];
  const rows = (name, withTests) => (callers[name] || [])
    .filter((c) => withTests || !tests.includes(c))
    .map((c) => ({ file: c, pos: 0, label: c, test: tests.includes(c), sites: 1, callSites: [] }));
  const resolver = {
    queried,
    async incoming(file, pos, withTests = true) {
      queried.push(file);
      if (failing.includes(file)) throw new Error(`query for ${file} failed`);
      return rows(file, withTests);
    },
  };
  if (status) {
    resolver.incomingWithStatus = async (file, pos, withTests = true) => {
      queried.push(file);
      if (failing.includes(file)) throw new Error(`query for ${file} failed`);
      const answer = { callers: rows(file, withTests), complete: !(file in partial) };
      if (file in partial) answer.reason = partial[file];
      return answer;
    };
  }
  return resolver;
}
const walk = (resolver, { depth = 6, budget = 120, signal } = {}) =>
  walkTestReach(resolver, { file: 'root', pos: 0 }, { depth, budget, signal });
const VARIANTS = [['incomingWithStatus', true], ['incoming only', false]];

for (const [variant, status] of VARIANTS) {
  test(`${variant}: a query that fails at depth 1 with no test is unknown, with its reason`, async () => {
    for (const failing of [['root'], ['a'], ['b']]) {
      const r = await walk(resolverOf({ root: ['a', 'b'], a: ['x'], b: ['y'] }, { failing, status }));
      assert.equal(r.state, 'unknown', failing.join());
      assert.match(r.incompleteReason, /failed/, failing.join());
      assert.deepEqual(r.tests, []);
    }
  });

  test(`${variant}: a test found anywhere is covered, whatever else failed`, async () => {
    const graph = { root: ['a', 'b'], a: ['bad'], b: ['t'], bad: [] };
    for (const failing of [['a'], ['root-never'], ['a', 'bad']]) {
      const r = await walk(resolverOf(graph, { tests: ['t'], failing, status }));
      assert.equal(r.state, 'covered', failing.join());
      assert.deepEqual(r.tests, ['t']);
      assert.equal(r.incompleteReason, null);
    }
    // the failing branch is walked after the one holding the test, and before it
    for (const order of [['a', 'b'], ['b', 'a']]) {
      const r = await walk(resolverOf({ root: order, a: ['t'], b: ['x'] }, { tests: ['t'], failing: ['b'], status }));
      assert.equal(r.state, 'covered', order.join());
    }
  });

  test(`${variant}: a finished walk with no test is uncovered`, async () => {
    const r = await walk(resolverOf({ root: ['a'], a: ['b'], b: [] }, { status }));
    assert.deepEqual([r.state, r.incompleteReason], ['uncovered', null]);
    assert.deepEqual((await walk(resolverOf({}, { status }))).state, 'uncovered');
  });
}

test('an incomplete answer counts as incomplete, and a test in it still counts', async () => {
  const partial = { a: 'index search stopped early' };
  const none = await walk(resolverOf({ root: ['a'], a: [] }, { partial }));
  assert.equal(none.state, 'unknown');
  assert.match(none.incompleteReason, /index search stopped early/);
  const atRoot = await walk(resolverOf({ root: [] }, { partial: { root: 'not in program' } }));
  assert.equal(atRoot.state, 'unknown');
  assert.match(atRoot.incompleteReason, /not in program/);
  const found = await walk(resolverOf({ root: ['a'], a: ['t'] }, { tests: ['t'], partial }));
  assert.equal(found.state, 'covered');
  // an incomplete answer without a reason still says why the walk is unknown
  const bare = await walk(resolverOf({ root: [] }, { partial: { root: undefined } }));
  assert.equal(bare.state, 'unknown');
  assert.ok(bare.incompleteReason && bare.incompleteReason.length > 0);
});

test('a resolver that cannot report completeness is trusted only when it does not throw', async () => {
  const r = await walk(resolverOf({ root: ['a'], a: [] }, { status: false }));
  assert.equal(r.state, 'uncovered');
});

// Budget: the unit is visited nodes (callers admitted), the root is not counted, and
// admission is checked before a node is inserted.
function wide(width) {
  const callers = { root: Array.from({ length: width }, (_, i) => `n${i}`) };
  return callers;
}
function chain(length) {
  const callers = { root: ['n0'] };
  for (let i = 0; i < length - 1; i++) callers[`n${i}`] = [`n${i + 1}`];
  return callers;
}
const SHAPES = [
  ['wide', wide, [1, 2, 5, 12]],
  ['chain', chain, [1, 2, 5, 12]],
];
for (const [name, build, sizes] of SHAPES) {
  for (const n of sizes) {
    test(`budget boundary, ${name} graph of ${n} nodes: ${n - 1} stops, ${n} and ${n + 1} finish`, async () => {
      const callers = build(n);
      const at = async (budget) => walk(resolverOf(callers), { depth: 40, budget });
      const under = await at(n - 1);
      assert.equal(under.state, 'unknown', `budget ${n - 1}`);
      assert.match(under.incompleteReason, /budget/);
      assert.deepEqual([(await at(n)).state, (await at(n)).incompleteReason], ['uncovered', null], `budget ${n}`);
      assert.equal((await at(n + 1)).state, 'uncovered', `budget ${n + 1}`);
    });
  }
}

test('a test is still found after the budget would refuse further callers', async () => {
  const r = await walk(resolverOf({ root: ['a', 'b', 't'] }, { tests: ['t'] }), { budget: 2 });
  assert.equal(r.state, 'covered');
  const deep = await walk(resolverOf({ root: ['a'], a: ['b'], b: ['t'] }, { tests: ['t'] }), { budget: 1 });
  assert.equal(deep.state, 'unknown', 'a test one level past the budget is not reached');
});

test('the budget stops work: no query starts for a node that was never admitted', async () => {
  const resolver = resolverOf(wide(30));
  await walk(resolver, { depth: 5, budget: 3 });
  assert.ok(resolver.queried.length <= 1 + 3, resolver.queried.length);
});

// Depth: a node at the depth limit is not expanded. If one was reached and no test was
// found, the walk stopped on scope, so the state is unknown; a walk that never reached
// the limit finished within its scope.
for (const length of [1, 2, 3, 5]) {
  test(`depth boundary, chain of ${length} callers: depth ${length} stops, depth ${length + 1} finishes`, async () => {
    const callers = chain(length);
    const at = (depth) => walk(resolverOf(callers), { depth });
    const stopped = await at(length);
    assert.equal(stopped.state, 'unknown');
    assert.match(stopped.incompleteReason, /depth/);
    assert.equal((await at(length + 1)).state, 'uncovered');
    assert.equal((await at(length + 3)).state, 'uncovered');
    if (length > 1) assert.equal((await at(length - 1)).state, 'unknown');
  });
}

test('a root nobody calls is uncovered at any depth, because nothing was cut off', async () => {
  for (const depth of [1, 2, 6]) assert.equal((await walk(resolverOf({}), { depth })).state, 'uncovered', String(depth));
});

test('depth cuts a branch but a test on another branch is still covered', async () => {
  const r = await walk(resolverOf({ root: ['a', 'b'], a: ['x'], x: ['y'], b: ['t'] }, { tests: ['t'] }), { depth: 2 });
  assert.equal(r.state, 'covered');
});

test('cycles, diamonds and a self-recursive root terminate with the right state', async () => {
  const shapes = {
    cycle: { root: ['a'], a: ['b'], b: ['a'] },
    selfRecursive: { root: ['root'] },
    selfRecursiveAndCaller: { root: ['root', 'a'], a: [] },
    diamond: { root: ['a', 'b'], a: ['c'], b: ['c'], c: [] },
    longCycle: { root: ['a'], a: ['b'], b: ['c'], c: ['root', 'a'] },
  };
  for (const [name, callers] of Object.entries(shapes)) {
    const resolver = resolverOf(callers);
    const r = await walk(resolver, { depth: 50 });
    assert.equal(r.state, 'uncovered', name);
    assert.ok(resolver.queried.length < 20, `${name} queried ${resolver.queried.length} times`);
  }
  const withTest = await walk(resolverOf({ root: ['a', 'b'], a: ['c', 't'], b: ['c'], c: [] }, { tests: ['t'] }), { depth: 50 });
  assert.equal(withTest.state, 'covered');
  const cycleFailing = await walk(resolverOf({ root: ['a'], a: ['b'], b: ['a'] }, { failing: ['b'] }), { depth: 50 });
  assert.equal(cycleFailing.state, 'unknown');
});

test('a diamond counts each node once against the budget', async () => {
  const callers = { root: ['a', 'b'], a: ['c'], b: ['c'], c: [] };
  assert.equal((await walk(resolverOf(callers), { depth: 9, budget: 3 })).state, 'uncovered');
  assert.equal((await walk(resolverOf(callers), { depth: 9, budget: 2 })).state, 'unknown');
});

test('a cancelled walk claims nothing', async () => {
  const controller = new AbortController();
  const resolver = resolverOf({ root: ['a'], a: ['b'], b: [] });
  const original = resolver.incomingWithStatus;
  resolver.incomingWithStatus = async (...args) => { controller.abort(); return original(...args); };
  const r = await walk(resolver, { signal: controller.signal });
  assert.equal(r.state, 'unknown');
  assert.match(r.incompleteReason, /cancel/);
});

// ---- the settings that bound the walk -----------------------------------------------------
const { validateReachDepth, validateTierAMaxFiles, DEFAULT_REACH_DEPTH, MAX_REACH_DEPTH,
  DEFAULT_TIER_A_MAX_FILES, MAX_TIER_A_MAX_FILES } = require('../src/engine/settings');
const SETTINGS = [
  ['impactTree.reachDepth', validateReachDepth, DEFAULT_REACH_DEPTH, 1, MAX_REACH_DEPTH, 2, 6],
  ['impactTree.tierA.maxFiles', validateTierAMaxFiles, DEFAULT_TIER_A_MAX_FILES, 1, MAX_TIER_A_MAX_FILES, 300, 3000],
];
for (const [name, validate, def, min, max, wantDefault, wantMax] of SETTINGS) {
  test(`${name}: documented range and default`, () => {
    assert.deepEqual([def, min, max], [wantDefault, 1, wantMax]);
    const setting = require('../package.json').contributes.configuration.properties[name];
    assert.deepEqual([setting.minimum, setting.maximum, setting.default], [1, wantMax, wantDefault]);
    assert.ok(setting.description.includes(String(wantMax)), 'the description states the maximum');
  });

  test(`${name}: omitted values use the default silently`, () => {
    for (const value of [undefined, null]) {
      const warnings = [];
      assert.equal(validate(value, warnings), def);
      assert.deepEqual(warnings, []);
    }
  });

  test(`${name}: unusable values use the default with exactly one warning naming the value`, () => {
    for (const value of [0, -1, -0.5, NaN, 0.5, 'abc', '3', '', Infinity, -Infinity, true, {}, []]) {
      const warnings = [];
      assert.equal(validate(value, warnings), def, String(value));
      assert.equal(warnings.length, 1, String(value));
      assert.ok(warnings[0].includes(name), warnings[0]);
      assert.ok(warnings[0].includes(typeof value === 'string' ? JSON.stringify(value) : String(value)), warnings[0]);
    }
  });

  test(`${name}: values in range are kept, fractions floored, no warning`, () => {
    for (const [value, want] of [[min, min], [max, max], [min + 1, min + 1], [max - 1, max - 1], [min + 0.7, min]]) {
      const warnings = [];
      assert.equal(validate(value, warnings), want, String(value));
      assert.deepEqual(warnings, [], String(value));
    }
  });

  test(`${name}: values above the maximum are clamped with one warning`, () => {
    for (const value of [max + 1, max * 10, 1e9, max + 1.5]) {
      const warnings = [];
      assert.equal(validate(value, warnings), max, String(value));
      assert.equal(warnings.length, 1, String(value));
      assert.ok(warnings[0].includes(name) && warnings[0].includes(String(value)), warnings[0]);
    }
  });
}

test('analyzeRemote validates impactTree.tierA.maxFiles before asking GitHub, with one warning', async () => {
  const ts = require('typescript');
  const { analyzeRemote } = require('../src/engine/analyze-remote');
  const pr = { number: 2, headSha: 'head', mergeBaseSha: 'base' };
  for (const [value, used, warns] of [[undefined, 300, 0], [null, 300, 0], [0, 300, 1], [-5, 300, 1], [NaN, 300, 1], ['x', 300, 1],
    [1, 1, 0], [250.9, 250, 0], [3000, 3000, 0], [3001, 3000, 1], [99999, 3000, 1]]) {
    let asked;
    const gh = {
      listPullRequestFiles: async (slug, number, opts) => { asked = opts.max; return { total: 0, files: [] }; },
      fileAtRef: async () => null,
    };
    const r = await analyzeRemote({ ts, gh, slug: {}, pr, repoRoot: '/review', maxFiles: value });
    assert.equal(asked, used, String(value));
    assert.equal(r.warnings.filter((w) => w.includes('impactTree.tierA.maxFiles')).length, warns, `${String(value)}: ${JSON.stringify(r.warnings)}`);
  }
});

// ---- analyze(): the contract on real symbols --------------------------------------------
function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-reach-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  write('tsconfig.json', JSON.stringify({ include: ['src'] }));
  write('.gitignore', 'node_modules\n');
  write('src/a.ts', 'export function covered(n: number) { return n; }\nexport function lonely(n: number) { return n; }\nexport function leaf(n: number) { return n; }\n');
  write('src/b.ts', 'import { covered, leaf } from "./a";\nexport function viaCovered() { return covered(1); }\nexport function viaLeaf() { return leaf(1); }\n'
    + 'export function topOfLeaf() { return viaLeaf(); }\n');
  write('src/b.test.ts', 'import { viaCovered } from "./b";\nexport function itWorks() { return viaCovered(); }\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(repo, 'node_modules', 'typescript'));
  write('src/a.ts', 'export function covered(n: number, m = 0) { return n + m; }\nexport function lonely(n: number, m = 0) { return n + m; }\nexport function leaf(n: number, m = 0) { return n + m; }\n');
  return repo;
}

test('analyze reports testState, its reason and the validated depth through the result', async () => {
  const { analyze } = require('../src/engine/analyze');
  const repo = makeRepo();
  try {
    const run = (extra) => analyze(repo, { mode: 'working', skipForest: true, ...extra });
    const by = (r, label) => r.allChanged.find((c) => c.label === label);

    const deep = await run({ depth: 3 });
    assert.equal(deep.reachDepth, 3);
    assert.equal(by(deep, 'covered').testState, 'covered');
    assert.deepEqual(by(deep, 'covered').tests, ['itWorks']);
    assert.equal(by(deep, 'lonely').testState, 'uncovered');
    assert.equal(by(deep, 'lonely').testReachIncompleteReason, null);
    // leaf -> viaLeaf -> topOfLeaf: depth 3 expands all three levels and finds the end
    assert.equal(by(deep, 'leaf').testState, 'uncovered');
    assert.deepEqual(deep.untested.map((c) => c.label).sort(), ['leaf', 'lonely']);
    assert.deepEqual(deep.testUnknown, []);

    const shallow = await run({ depth: 1 });
    assert.equal(by(shallow, 'covered').testState, 'unknown', 'the test is two levels up');
    assert.match(by(shallow, 'covered').testReachIncompleteReason, /depth/);
    assert.equal(by(shallow, 'lonely').testState, 'uncovered');
    assert.equal(by(shallow, 'leaf').testState, 'unknown');
    assert.deepEqual(shallow.untested.map((c) => c.label), ['lonely']);
    assert.deepEqual(shallow.testUnknown.map((c) => c.label).sort(), ['covered', 'leaf']);

    const budgeted = await run({ depth: 6, reachBudget: 1 });
    assert.equal(by(budgeted, 'leaf').testState, 'unknown');
    assert.match(by(budgeted, 'leaf').testReachIncompleteReason, /budget/);

    const deferred = await run({ deferTestReach: true });
    for (const c of deferred.allChanged) assert.equal(c.testState, 'not-computed');
    assert.deepEqual([deferred.untested, deferred.testUnknown], [[], []]);
    assert.equal(deferred.testReachComputed, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('analyze fails closed when the resolver throws during the walk', async () => {
  const { analyze } = require('../src/engine/analyze');
  const repo = makeRepo();
  try {
    let armed = false;
    const r = await analyze(repo, {
      mode: 'working', skipForest: true,
      makeResolver: ({ ts, componentDir, repoRoot }) => {
        const real = require('../src/engine/resolver-ts').createTsResolver(ts, componentDir, { tsconfig: path.join(repo, 'tsconfig.json'), repoRoot });
        return {
          ...real,
          callerState: async (...a) => { armed = true; return real.callerState(...a); },
          incoming: async (...a) => { if (armed) throw new Error('language server crashed'); return real.incoming(...a); },
          incomingWithStatus: async (...a) => { if (armed) throw new Error('language server crashed'); return real.incomingWithStatus(...a); },
        };
      },
    });
    const covered = r.allChanged.find((c) => c.label === 'covered');
    assert.equal(covered.testState, 'unknown');
    assert.match(covered.testReachIncompleteReason, /language server crashed/);
    assert.deepEqual(r.untested, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('analyze validates impactTree.reachDepth and warns once', async () => {
  const { analyze } = require('../src/engine/analyze');
  const repo = makeRepo();
  try {
    const cases = [[undefined, 2, 0], [null, 2, 0], [0, 2, 1], [-1, 2, 1], [NaN, 2, 1], [0.5, 2, 1], ['3', 2, 1], [Infinity, 2, 1],
      [1, 1, 0], [4.9, 4, 0], [6, 6, 0], [7, 6, 1], [100, 6, 1]];
    for (const [value, used, warns] of cases) {
      const r = await analyze(repo, { mode: 'working', skipForest: true, deferTestReach: true, depth: value });
      assert.equal(r.reachDepth, used, String(value));
      assert.equal(r.warnings.filter((w) => w.includes('impactTree.reachDepth')).length, warns, `${String(value)}: ${JSON.stringify(r.warnings)}`);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
