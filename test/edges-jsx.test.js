'use strict';
// JSX handler edges (src/engine/edges-jsx.js) through the CLI's TypeScript resolver and the
// impact walk: a handler passed in a JSX attribute (`onClick={h}`) is followed to the
// component that renders it, for the walk only. The caller list and test reach are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');
const { createTsResolver } = require('../src/engine/resolver-ts');
const { impactPathsFor } = require('../src/engine/impact-paths');
const { walkTestReach } = require('../src/engine/test-reach');
const { classifyReference } = require('../src/engine/edges-jsx');

// Every case in one project, built once: one language service serves every test.
const FILES = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', noEmit: true, skipLibCheck: true, noLib: false, types: [] }, include: ['**/*.ts', '**/*.tsx'] }),
  'lib/handlers.ts': [
    'export function save() {}',
    'export function timed() {}',
    'export function submitter() {}',
    'export function act() {}',
    'export function spreadOnly() {}',
    'export function objOnly() {}',
    'export function childOnly() {}',
    'export function testOnly() {}',
    'export function schedule() { setTimeout(timed, 1); }',
    '',
  ].join('\n'),
  'components/button.tsx': 'export function Button(props: any) { return <button {...props} />; }\n',
  'components/form.tsx': [
    "import { Button } from './button';",
    "import { save, timed, submitter, act, spreadOnly, objOnly, childOnly } from '../lib/handlers';",
    'export function Form() {',
    '  const form = { handleSubmit: (f: any) => f };',
    '  const handlers = { onClick: spreadOnly };',
    '  return (<div>',
    '    <Button onClick={save} />',
    '    <Button',
    '      onClick={ timed }',
    '    />',
    '    <form onSubmit={form.handleSubmit(submitter)} action={act} />',
    '    <Button {...handlers} />',
    '    <Button {...{ onClick: objOnly }} />',
    '    <Button>{childOnly}</Button>',
    '  </div>);',
    '}',
    '',
  ].join('\n'),
  'app/list/page.tsx': "import { Form } from '../../components/form';\nexport default function Page() { return <Form />; }\n",
  'components/form.test.tsx': [
    "import { Form } from './form';",
    "import { testOnly } from '../lib/handlers';",
    "import { Button } from './button';",
    "test('renders', () => { render(<Form />); render(<Button onClick={testOnly} />); });",
    'declare function test(n: string, f: () => void): void;',
    'declare function render(x: any): void;',
    '',
  ].join('\n'),
  'anon/page.tsx': "import { Button } from '../components/button';\nimport { act } from '../lib/handlers';\nexport default () => <Button onClick={act} />;\n",
};

let repo;
let resolver;
test.before(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-jsx-edges-')));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  resolver = createTsResolver(ts, repo, { repoRoot: repo, filterInherited: false });
});
test.after(() => { if (resolver) resolver.dispose(); fs.rmSync(repo, { recursive: true, force: true }); });

const HANDLERS = 'lib/handlers.ts';
const posOf = (name) => FILES[HANDLERS].indexOf(`function ${name}`) + 'function '.length;
const changed = (name) => ({ label: name, file: path.join(repo, HANDLERS), relPath: HANDLERS, namePos: posOf(name), callers: [], kinds: [] });
const walk = async (name) => (await impactPathsFor({ units: [{ resolver, changed: [changed(name)] }], repo })).byId[`${HANDLERS}#${posOf(name)}`];

test('(a) onClick={h} in a component: h -> Form -> the page, the hop labelled, not a call', async () => {
  const p = await walk('save');
  assert.equal(p.complete, true, p.incompleteReasons.join('; '));
  assert.deepEqual(p.entries.map((e) => [e.type, e.name, e.via]), [['ui-route', '/list', ['save', 'Form', 'Page']]]);
  assert.deepEqual(p.entries[0].hops, [{ at: 0, via: 'jsx-prop', text: 'passed as onClick to <Button>' }]);
  // A call step carries no hop: the second step (Form -> Page, `<Form />`) is a call.
  assert.equal(p.topPaths[0].hops.length, 1);
});

test('(a) a multi-line attribute with spaces inside the braces is the same edge', async () => {
  const edges = await resolver.pathEdges(path.join(repo, HANDLERS), posOf('timed'));
  assert.deepEqual(edges.rows.map((r) => [r.label, r.via, r.text]), [['Form', 'jsx-prop', 'passed as onClick to <Button>']]);
  const form = FILES['components/form.tsx'];
  assert.equal(edges.rows[0].pos, form.indexOf('Form()'));
});

test('(b) also passed to setTimeout: the edge is followed, the answer stays a lower bound with the reason', async () => {
  const p = await walk('timed');
  assert.equal(p.complete, false);
  assert.ok(p.entries.some((e) => e.name === '/list'), 'the page is still reached');
  assert.equal(p.summary.ends.unknown, 1);
  assert.match(p.incompleteReasons.join('; '), /referenced as a value \(passed or registered\), never called directly \(in handlers\.ts\)/);
});

test('(c) onSubmit={form.handleSubmit(h)} and <form action={h}> are edges', async () => {
  for (const [name, prop] of [['submitter', 'onSubmit'], ['act', 'action']]) {
    const edges = await resolver.pathEdges(path.join(repo, HANDLERS), posOf(name));
    const form = edges.rows.find((r) => r.label === 'Form');
    assert.ok(form, name);
    assert.equal(form.text, `passed as ${prop} to <form>`);
  }
  const p = await walk('submitter');
  assert.equal(p.complete, true);
  assert.deepEqual(p.entries.map((e) => e.name), ['/list']);
});

test('(d) spread props and an object literal are no edge: unknown, as before', async () => {
  for (const name of ['spreadOnly', 'objOnly']) {
    const edges = await resolver.pathEdges(path.join(repo, HANDLERS), posOf(name));
    assert.deepEqual(edges.rows, [], name);
    assert.equal(edges.complete, false, name);
    const p = await walk(name);
    assert.equal(p.complete, false, name);
    assert.deepEqual(p.entries, [], name);
    assert.deepEqual(p.topPaths.map((e) => [e.end, e.reason]), [['unknown', 'referenced as a value (passed or registered), never called directly']], name);
  }
});

test('(e) a function as a JSX child ({h}, a render prop) is no edge: unknown', async () => {
  const edges = await resolver.pathEdges(path.join(repo, HANDLERS), posOf('childOnly'));
  assert.deepEqual(edges.rows, []);
  assert.equal(edges.complete, false);
  assert.equal((await walk('childOnly')).summary.ends.unknown, 1);
});

test('(f) a test that only renders the component does not cover the handler', async () => {
  const reach = await walkTestReach(resolver, { file: path.join(repo, HANDLERS), pos: posOf('save') }, { depth: 4, budget: 50 });
  assert.equal(reach.state, 'uncovered');
  // A test that passes the handler itself is left out of the walk too: tests are not walked.
  const edges = await resolver.pathEdges(path.join(repo, HANDLERS), posOf('testOnly'));
  assert.deepEqual(edges.rows, []);
});

test('(g) the caller list of the handler is unchanged: empty, and its callerState still unknown', async () => {
  const file = path.join(repo, HANDLERS);
  assert.deepEqual(await resolver.incoming(file, posOf('save'), true), []);
  const cs = await resolver.callerState(file, posOf('save'), {});
  assert.deepEqual([cs.state, cs.reason, cs.callers], ['unknown', 'referenced-as-value', []]);
});

test('an anonymous default-export component is the module, as the call hierarchy names it', async () => {
  const edges = await resolver.pathEdges(path.join(repo, HANDLERS), posOf('act'));
  const anon = edges.rows.find((r) => r.file.endsWith(path.join('anon', 'page.tsx')));
  assert.deepEqual([anon.label, anon.pos], ['page.tsx', 0]);
  const p = await walk('act');
  // The module path ends as module-level code (a top the walk does not trace), never "(top level)".
  assert.ok(p.topPaths.every((e) => !e.via.some((l) => l.startsWith('(top level)'))));
  assert.ok(p.entries.some((e) => e.name === '/list'));
});

test('classifyReference: the callee of a call inside an attribute is a call, not an edge', () => {
  const text = 'function C() { return <B onClick={() => h()} k={h} />; }\n';
  const sf = ts.createSourceFile('/x.tsx', text, ts.ScriptTarget.Latest, true);
  assert.equal(classifyReference(ts, sf, text.indexOf('h()')).kind, 'call');
  const edge = classifyReference(ts, sf, text.indexOf('{h}') + 1);
  assert.equal(edge.kind, 'edge');
  assert.deepEqual([edge.prop, edge.element, edge.owner.label, edge.owner.pos], ['k', 'B', 'C', text.indexOf('C')]);
});

test('classifyReference: named owners follow the call hierarchy (const arrow, class method, inline callback)', () => {
  const text = [
    'const Comp = () => <B onClick={h} />;',
    'class K { render() { return <B onClick={h} />; } }',
    'function List() { return items.map((i) => <B onClick={h} />); }',
    'export default function () { return <B onClick={h} />; }',
    '',
  ].join('\n');
  const sf = ts.createSourceFile('/x.tsx', text, ts.ScriptTarget.Latest, true);
  const owners = [];
  for (let i = text.indexOf('{h}'); i >= 0; i = text.indexOf('{h}', i + 1)) owners.push(classifyReference(ts, sf, i + 1).owner);
  assert.deepEqual(owners.map((o) => o.label), ['Comp', 'K.render', 'List', 'default']);
  assert.equal(owners[3].pos, text.indexOf('default function'));
});
