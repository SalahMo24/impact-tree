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
const { classifyReference, returnedMemberOf, nodeAt } = require('../src/engine/edges-jsx');

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
  // Functions returned by a hook (N3): `return { f }`, used by the hook's callers.
  'lib/react.ts': [
    'export function useCallback<T>(f: T, deps: unknown[]): T { return f; }',
    'export function useMemo<T>(f: () => T, deps: unknown[]): T { return f(); }',
    'export function useRef<T>(v: T): { current: T } { return { current: v }; }',
    'export function useEffect(f: () => void, deps: unknown[]): void { f(); }',
    'export function register(x: unknown): void {}',
    '',
  ].join('\n'),
  'hooks/form.ts': [
    "import { useMemo } from '../lib/react';",
    'export function useForm() {',
    '  function submit() {}',
    '  function cancel() {}',
    '  function track() {}',
    '  function Modal() { return null; }',
    '  function onPick() {}',
    '  function unused() {}',
    '  function depOnly() {}',
    '  function refOnly() {}',
    '  function reset() {}',
    '  function called() { reset(); }',
    '  function memoOnly() {}',
    '  function listOnly() {}',
    '  const memo = useMemo(() => ({ memoOnly }), []);',
    '  const items = [1].map(() => ({ onClick: listOnly }));',
    '  return { submit, cancelIt: cancel, track, Modal, onPick, unused, depOnly, refOnly, reset, called, memo, items };',
    '}',
    // Two hooks returning one interface: property references join their consumers.
    'export interface Api { save: (x: number) => number }',
    'export function useTyped(): Api {',
    '  const saveTyped = (x: number) => x + 1;',
    '  return { save: saveTyped };',
    '}',
    'export function useOther(): Api {',
    '  const saveOther = (x: number) => x + 2;',
    '  return { save: saveOther };',
    '}',
    // The object each of these returns escapes at a call site.
    'export function useSpread() { function spreadFn() {} return { a: spreadFn }; }',
    'export function useRegister() { function registerFn() {} return { a: registerFn }; }',
    'export function useRest() { function restFn() {} return { a: restFn, b: 1 }; }',
    'export function useAny() { function anyFn() {} return { a: anyFn }; }',
    'export const useArrow = () => { function arrowFn() {} return ({ a: arrowFn }); };',
    '',
  ].join('\n'),
  'components/wizard.tsx': [
    "import { useCallback, useEffect, useRef, register } from '../lib/react';",
    "import { useForm, useTyped, useOther, useSpread, useRegister, useRest, useAny, useArrow } from '../hooks/form';",
    'export function Wizard() {',
    '  const { submit, cancelIt: stop, track, Modal, depOnly, refOnly, reset } = useForm();',
    '  const handleNext = () => { submit(); };',
    '  const onTrack = useCallback(() => track(), [track]);',
    '  const ref = useRef(refOnly);',
    '  useEffect(() => {}, [depOnly]);',
    '  reset();',
    '  return (<div>',
    '    <button onClick={handleNext} />',
    '    <button onClick={stop} />',
    '    <button onClick={onTrack} />',
    '    <Modal />',
    '  </div>);',
    '}',
    'export function Member() { const form = useForm(); return <button onClick={() => form.onPick()} />; }',
    'export function A() { const { save } = useOther(); return <button onClick={() => save(1)} />; }',
    'export function J() { const { save } = useTyped(); return <button onClick={() => save(1)} />; }',
    'export function E1() { const all = { ...useSpread() }; return null; }',
    'export function E2() { register(useRegister()); return null; }',
    'export function E3() { const { a: s, ...rest } = useRest(); return <b onClick={s} />; }',
    'export function E4() { const api: any = useAny(); api.a(1); return null; }',
    'export function E5() { const { a } = useArrow(); return <b onClick={a} />; }',
    '',
  ].join('\n'),
  'app/wizard/page.tsx': "import { Wizard, Member, A, J } from '../../components/wizard';\nexport default function Page() { return <div><Wizard /><Member /><A /><J /></div>; }\n",
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

// ---- Functions returned by a hook (N3): followed from the hook's call sites to the uses.
const HOOKS = 'hooks/form.ts';
const hookPos = (name) => { const m = new RegExp(`(?:function|const) ${name}\\b`).exec(FILES[HOOKS]); return m.index + m[0].length - name.length; };
const hookEdges = (name) => resolver.pathEdges(path.join(repo, HOOKS), hookPos(name));
const walkHook = async (name) => {
  const c = { label: name, file: path.join(repo, HOOKS), relPath: HOOKS, namePos: hookPos(name), callers: [], kinds: [] };
  return (await impactPathsFor({ units: [{ resolver, changed: [c] }], repo })).byId[`${HOOKS}#${hookPos(name)}`];
};
const rowsOf = (edges) => edges.rows.map((r) => [r.label, r.via, r.text]);
const WIZARD = FILES['components/wizard.tsx'];

test('N3: destructured and called in a handler: f -> handleNext -> Wizard -> the page, both hops labelled', async () => {
  const p = await walkHook('submit');
  assert.equal(p.complete, true, p.incompleteReasons.join('; '));
  assert.deepEqual(p.entries.map((e) => [e.type, e.name, e.via]), [['ui-route', '/wizard', ['submit', 'handleNext', 'Wizard', 'Page']]]);
  assert.deepEqual(p.entries[0].hops, [
    { at: 0, via: 'returned-member', text: 'returned by useForm, used in handleNext' },
    { at: 1, via: 'jsx-prop', text: 'passed as onClick to <button>' },
  ]);
  const edges = await hookEdges('submit');
  assert.deepEqual([edges.complete, edges.returnedBy], [true, 'useForm']);
  assert.equal(edges.rows[0].pos, WIZARD.indexOf('handleNext'));
});

test('N3: renamed and passed in an attribute, called in useCallback (deps array neutral), rendered, x.f()', async () => {
  const cases = [['cancel', 'Wizard'], ['track', 'Wizard'], ['Modal', 'Wizard'], ['onPick', 'Member']];
  for (const [name, owner] of cases) {
    const edges = await hookEdges(name);
    assert.deepEqual(rowsOf(edges), [[owner, 'returned-member', `returned by useForm, used in ${owner}`]], name);
    assert.equal(edges.complete, true, `${name}: ${edges.reason}`);
  }
  const p = await walkHook('Modal');
  assert.deepEqual(p.entries.map((e) => [e.name, e.via]), [['/wizard', ['Modal', 'Wizard', 'Page']]]);
});

test('N3: two hooks returning one interface: each consumer is followed from its own hook only', async () => {
  assert.deepEqual(rowsOf(await hookEdges('saveTyped')), [['J', 'returned-member', 'returned by useTyped, used in J']]);
  assert.deepEqual(rowsOf(await hookEdges('saveOther')), [['A', 'returned-member', 'returned by useOther, used in A']]);
});

test('N3: a parenthesised literal returned by a const arrow is followed', async () => {
  assert.deepEqual(rowsOf(await hookEdges('arrowFn')), [['E5', 'returned-member', 'returned by useArrow, used in E5']]);
});

test('N3: the returned object escapes ({...H()}, register(H()), a rest element, any): no edge, unknown with the reason', async () => {
  for (const [name, hook] of [['spreadFn', 'useSpread'], ['registerFn', 'useRegister'], ['restFn', 'useRest'], ['anyFn', 'useAny']]) {
    const edges = await hookEdges(name);
    assert.deepEqual([edges.rows, edges.complete, edges.returnedBy], [[], false, hook], name);
    assert.equal(edges.reason, `the object ${hook} returns is passed on in wizard.tsx`, name);
    const p = await walkHook(name);
    assert.deepEqual(p.topPaths.map((e) => [e.end, e.reason]), [['unknown', `the object ${hook} returns is passed on in wizard.tsx`]], name);
  }
});

test('N3: useRef(f) is a use not followed: unknown with the reason', async () => {
  const edges = await hookEdges('refOnly');
  assert.deepEqual([edges.rows, edges.complete, edges.reason], [[], false, 'refOnly returned by useForm is used as a value in wizard.tsx']);
});

test('N3: returned and used by no caller (unused, or only in a deps array): a returned-unused top, not a value use', async () => {
  for (const name of ['unused', 'depOnly']) {
    const edges = await hookEdges(name);
    assert.deepEqual([edges.rows, edges.complete, edges.returnedBy], [[], true, 'useForm'], name);
    const p = await walkHook(name);
    assert.equal(p.complete, true, name);
    assert.deepEqual(p.topPaths.map((e) => [e.end, e.topKind, e.returnedBy]), [['top-unidentified', 'returned-unused', 'useForm']], name);
  }
});

test('N3: useMemo(() => ({ f })) and .map(() => ({ onClick: f })) are not returned by the hook: unknown as before', async () => {
  for (const name of ['memoOnly', 'listOnly']) {
    const edges = await hookEdges(name);
    assert.deepEqual([edges.rows, edges.complete, edges.returnedBy], [[], false, undefined], name);
    assert.equal(edges.reason, 'referenced as a value (passed or registered), never called directly (in form.ts)', name);
  }
});

test('N3-D1 (known limit, pinned): called inside the hook and returned, its callers are walked, not its consumers', async () => {
  // `reset` is called by `called` and used by Wizard: the walk takes the production caller
  // and never asks for edges, so Wizard is not reached through `reset` itself.
  const p = await walkHook('reset');
  assert.deepEqual(p.topPaths.map((e) => [e.end, e.topKind, e.via]), [['top-unidentified', 'returned-unused', ['reset', 'called']]]);
  assert.deepEqual(p.entries, []);
});

test('N3: the caller list and callerState of a returned function are unchanged', async () => {
  const file = path.join(repo, HOOKS);
  assert.deepEqual(await resolver.incoming(file, hookPos('submit'), true), []);
  const cs = await resolver.callerState(file, hookPos('submit'), {});
  assert.deepEqual([cs.state, cs.reason, cs.callers], ['unknown', 'referenced-as-value', []]);
});

test('returnedMemberOf: only a named function that owns the return', () => {
  const text = [
    'function useA() { return { f }; }',
    'const useB = () => ({ k: f });',
    'function useC() { return useMemo(() => ({ f }), []); }',
    'function useD() { return items.map(() => ({ onClick: f })); }',
    'export default () => ({ f });',
    'class K { m() { return { f } as const; } }',
    '',
  ].join('\n');
  const sf = ts.createSourceFile('/x.ts', text, ts.ScriptTarget.Latest, true);
  const at = [];
  for (const m of text.matchAll(/\bf\b/g)) at.push(returnedMemberOf(ts, sf, nodeAt(sf, m.index)));
  assert.deepEqual(at.map((x) => x && [x.hook.label, x.key]), [['useA', 'f'], ['useB', 'k'], null, null, null, ['K.m', 'f']]);
});
