'use strict';
// TypeScript's editor extras (src/languages/typescript/editor-extras.js): a function nothing
// calls but that is used as a value (`onClick={f}`) is unknown, not "no callers".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');
const Module = require('module');
const { applyCallerExtras } = require('../src/languages/callers-from-hierarchy');
const { impactPathsFor } = require('../src/engine/impact-paths');

// The CQRS helper is stood in for, as the resolver tests do: these tests are about references.
const cqrsId = require.resolve('../src/engine/edges-cqrs');
const fakeCqrs = new Module(cqrsId); fakeCqrs.loaded = true;
fakeCqrs.exports = { makeCqrsEdges: () => ({ isHandlerExecute: () => false, extraCallers: async () => ({ callers: [], unresolved: [] }) }) };
const realCqrs = require.cache[cqrsId];
require.cache[cqrsId] = fakeCqrs;
test.after(() => { if (realCqrs) require.cache[cqrsId] = realCqrs; else delete require.cache[cqrsId]; });
const { createTypescriptEditorExtras } = require('../src/languages/typescript/editor-extras');

const DECL = 'export function target() {}\n';
const NAME = DECL.indexOf('target');
/** A project in a temp dir: `files` by relative path; returns a harness over a fake server. */
function setup(t, files, references) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-ts-extras-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const abs = {};
  for (const [rel, text] of Object.entries({ 'a.ts': DECL, ...files })) { abs[rel] = path.join(dir, rel); fs.writeFileSync(abs[rel], text); }
  const asked = { references: 0 };
  const services = { isServerWarm: () => true, definitions: async () => [], references: async () => { asked.references++; return references(abs); } };
  const extras = createTypescriptEditorExtras({ ts, services, repoRoot: dir, trace() {}, filterInherited: false, onWarmupRetry() {} });
  const ask = async (rows = []) => {
    const query = extras.query(abs['a.ts'], NAME);
    const r = await applyCallerExtras({ ready: true, rows }, { extras, query, file: abs['a.ts'], pos: NAME, withTests: false });
    return { answer: r.answer, asked, abs };
  };
  return { ask, abs, asked, services };
}
const at = (file, text, needle, nth = 0) => {
  let i = -1; for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
  return { file, start: i, end: i + needle.length };
};
const self = (abs) => at(abs['a.ts'], DECL, 'target');

test('a function nothing calls but a component passes as a value is incomplete, referenced-as-value', async (t) => {
  const use = 'import { target } from "./a";\nexport const B = () => <button onClick={target} />;\n';
  const h = setup(t, { 'b.tsx': use }, (abs) => [self(abs), at(abs['b.tsx'], use, 'target'), at(abs['b.tsx'], use, 'target', 1)]);
  const { answer } = await h.ask();
  assert.deepEqual(answer, { callers: [], complete: false, reason: 'referenced-as-value' });
});

test('the impact path of such a function ends unknown with that reason', async (t) => {
  const use = 'window.addEventListener("popstate", target);\n';
  const h = setup(t, { 'b.ts': 'import { target } from "./a";\n' + use }, (abs) => [self(abs), at(abs['b.ts'], 'import { target } from "./a";\n' + use, 'target', 1)]);
  const { answer } = await h.ask();
  const resolver = { incomingWithStatus: async () => answer };
  const repo = path.dirname(h.abs['a.ts']);
  const changed = { label: 'target', file: h.abs['a.ts'], relPath: 'a.ts', namePos: NAME, callers: [] };
  const { byId } = await impactPathsFor({ units: [{ resolver, changed: [changed] }], repo });
  const paths = byId[`a.ts#${NAME}`];
  assert.deepEqual(paths.summary.ends, { entry: 0, 'top-unidentified': 0, budget: 0, unknown: 1 });
  assert.deepEqual(paths.topPaths.map((/** @type {any} */ e) => [e.end, e.reason]), [['unknown', 'referenced-as-value']]);
});

test('imports and re-exports alone are neutral: still complete with no caller', async (t) => {
  const files = {
    'b.ts': 'import { target } from "./a";\n',
    'c.ts': 'export { target } from "./a";\n',
    'd.ts': 'import { target as t2 } from "./a";\nexport { t2 };\nimport * as ns from "./a";\n',
    'e.ts': 'import target from "./a";\nexport default target;\n',
  };
  const h = setup(t, files, (abs) => [self(abs), at(abs['b.ts'], files['b.ts'], 'target'), at(abs['c.ts'], files['c.ts'], 'target'),
    at(abs['d.ts'], files['d.ts'], 'target'), at(abs['e.ts'], files['e.ts'], 'target'), at(abs['e.ts'], files['e.ts'], 'target', 1)]);
  assert.deepEqual((await h.ask()).answer, { callers: [], complete: true });
});

test('a call in a test file is not a use; the same call in production code is', async (t) => {
  const call = 'import { target } from "./a";\ntarget();\n';
  const refs = (abs, rel) => [self(abs), at(abs[rel], call, 'target', 1)];
  const inTest = setup(t, { 'a.test.ts': call }, (abs) => refs(abs, 'a.test.ts'));
  assert.equal((await inTest.ask()).answer.complete, true);
  const inProd = setup(t, { 'z.ts': call }, (abs) => refs(abs, 'z.ts'));
  assert.equal((await inProd.ask()).answer.reason, 'referenced-as-value');
});

test('a function with callers asks no references', async (t) => {
  const h = setup(t, {}, () => assert.fail('not asked'));
  const row = { label: 'user', file: '/r/u.ts', pos: 3, test: false, sites: 1, callSites: [{ start: 3, end: 4 }] };
  const { answer, asked } = await h.ask([row]);
  assert.equal(answer.complete, true);
  assert.equal(answer.callers.length, 1);
  assert.equal(asked.references, 0);
});

test('a references query that fails or answers nothing is incomplete, never none', async (t) => {
  const bad = setup(t, {}, () => { throw new Error('server down'); });
  assert.deepEqual((await bad.ask()).answer, { callers: [], complete: false, reason: 'its references could not be listed: server down' });
  const empty = setup(t, {}, () => null);
  assert.equal((await empty.ask()).answer.complete, false);
});

test('without the TypeScript compiler nothing changes: no references query', async (t) => {
  const h = setup(t, {}, () => assert.fail('not asked'));
  const extras = createTypescriptEditorExtras({ ts: null, services: h.services, repoRoot: null, trace() {}, filterInherited: false, onWarmupRetry() {} });
  assert.equal(extras.query(h.abs['a.ts'], NAME).moreCallers, null);
  assert.equal(extras.pathEdges, undefined);
});

// N2: walk-only JSX edges (`pathEdges`, src/engine/edges-jsx.js) from the server's references.
const COMPONENT = 'import { target } from "./a";\nexport const B = () => <button onClick={target} />;\n';
/** @param {any} h A `setup` harness. */
const extrasOf = (h) => createTypescriptEditorExtras({ ts, services: h.services, repoRoot: path.dirname(h.abs['a.ts']), trace() {}, filterInherited: false, onWarmupRetry() {} });

test('pathEdges: a component passing it as onClick is an edge to the component, labelled', async (t) => {
  const h = setup(t, { 'b.tsx': COMPONENT }, (abs) => [self(abs), at(abs['b.tsx'], COMPONENT, 'target'), at(abs['b.tsx'], COMPONENT, 'target', 1)]);
  const extras = extrasOf(h);
  const answer = await extras.pathEdges(h.abs['a.ts'], NAME);
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.rows.map((r) => [r.label, r.file, r.pos, r.via, r.text, r.test]),
    [['B', h.abs['b.tsx'], COMPONENT.indexOf('B ='), 'jsx-prop', 'passed as onClick to <button>', false]]);
  // Asked once: a second question is served from the generation's answers; clear() drops them.
  await extras.pathEdges(h.abs['a.ts'], NAME);
  assert.equal(h.asked.references, 1);
  extras.clear();
  await extras.pathEdges(h.abs['a.ts'], NAME);
  assert.equal(h.asked.references, 2);
});

test('pathEdges: another value use keeps it incomplete; a failed query is never cached', async (t) => {
  const use = 'import { target } from "./a";\nwindow.addEventListener("x", target);\n';
  const h = setup(t, { 'b.tsx': COMPONENT, 'c.ts': use }, (abs) => [self(abs), at(abs['b.tsx'], COMPONENT, 'target', 1), at(abs['c.ts'], use, 'target', 1)]);
  const answer = await extrasOf(h).pathEdges(h.abs['a.ts'], NAME);
  assert.equal(answer.rows.length, 1);
  assert.equal(answer.complete, false);
  assert.match(answer.reason, /referenced as a value .* \(in c\.ts\)/);

  let fail = true;
  const flaky = setup(t, { 'b.tsx': COMPONENT }, (abs) => { if (fail) throw new Error('server down'); return [at(abs['b.tsx'], COMPONENT, 'target', 1)]; });
  const fx = extrasOf(flaky);
  assert.deepEqual(await fx.pathEdges(flaky.abs['a.ts'], NAME), { rows: [], complete: false, reason: 'its references could not be listed: server down' });
  fail = false;
  assert.equal((await fx.pathEdges(flaky.abs['a.ts'], NAME)).rows.length, 1);
});

// Through the editor's resolver (src/session/resolver-vscode.js) with the vscode stub: the
// handler's caller answer stays referenced-as-value, and the walk follows the edge.
test('the editor resolver: callers unchanged, the impact walk goes on through the JSX edge', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-ts-resolver-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.ts');
  const b = path.join(dir, 'b.tsx');
  fs.writeFileSync(a, DECL);
  fs.writeFileSync(b, COMPONENT);
  const lineChar = (text, offset) => { const before = text.slice(0, offset).split('\n'); return { line: before.length - 1, character: before[before.length - 1].length }; };
  const loc = (file, text, offset) => ({ uri: { fsPath: file }, range: { start: lineChar(text, offset), end: lineChar(text, offset + 6) } });
  const refsOfTarget = [loc(a, DECL, NAME), loc(b, COMPONENT, COMPONENT.indexOf('target')), loc(b, COMPONENT, COMPONENT.lastIndexOf('target'))];
  const original = Module._load;
  const stub = { ...require('./vscode-stub'), Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    commands: { executeCommand: async (name, uri) => {
      if (name === 'vscode.prepareCallHierarchy') return [{}];
      if (name === 'vscode.provideIncomingCalls') return [];
      if (name === 'vscode.executeReferenceProvider') return uri.fsPath === a ? refsOfTarget : [];
      return undefined;
    } } };
  Module._load = function (name, ...args) { return name === 'vscode' ? stub : original.call(this, name, ...args); };
  delete require.cache[require.resolve('../src/session/resolver-vscode')];
  t.after(() => { Module._load = original; delete require.cache[require.resolve('../src/session/resolver-vscode')]; });
  const { createVscodeResolver } = require('../src/session/resolver-vscode');
  const { createFakeClock } = require('./fake-clock');
  const resolver = createVscodeResolver({ ts, repoRoot: dir, retries: 0, clock: createFakeClock() });

  // The caller list is what N0 made it: no caller, referenced as a value.
  assert.deepEqual(await resolver.incomingWithStatus(a, NAME, true), { callers: [], complete: false, reason: 'referenced-as-value' });
  const edges = await resolver.pathEdges(a, NAME);
  assert.deepEqual(edges.rows.map((r) => [r.label, r.text]), [['B', 'passed as onClick to <button>']]);
  assert.equal(resolver.stats().pathEdgeQueries, 1);

  const changed = { label: 'target', file: a, relPath: 'a.ts', namePos: NAME, callers: [] };
  const { byId } = await impactPathsFor({ units: [{ resolver, changed: [changed] }], repo: dir });
  const p = byId[`a.ts#${NAME}`];
  // B has no caller and no reference: a top, reached through a step that is not a call.
  assert.deepEqual(p.topPaths.map((e) => [e.end, e.topKind, e.via, e.hops]),
    [['top-unidentified', 'function', ['target', 'B'], [{ at: 0, via: 'jsx-prop', text: 'passed as onClick to <button>' }]]]);
  assert.equal(p.complete, true);
});
