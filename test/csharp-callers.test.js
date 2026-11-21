'use strict';
// C#'s editor callers (Part C, C5; src/languages/csharp/editor-extras.js and the provider's
// probe): Roslyn's call hierarchy faked, as C0b measured it (`Impl.M` and `IFoo.M` disjoint,
// top-level callers named `Program.<top-level-statements-entry-point>`, no item for a primary
// constructor, method groups listed as calls), applied through the shared `applyCallerExtras`
// as the editor's resolver and the harness apply it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createCsharpSyntacticIndex } = require('../src/languages/csharp/syntactic-index');
const { csharpOutline } = require('../src/languages/csharp/outline');
const { createCsharpEditorExtras, EMPTY_ANSWER_REASON, VALUE_USE_REASON, NOT_COMPUTED, PRIMARY_CONSTRUCTOR_REASON, NOT_LOADED_REASON, isCsharpCallSite } = require('../src/languages/csharp/editor-extras');
const { createCsharpProvider, NO_HIERARCHY_NOTE } = require('../src/languages/csharp/provider');
const { createHierarchyResolver } = require('./lsp-harness/harness-languages');

const ROOT = '/repo';
const LIB = `namespace Lib;
public interface IFoo { int M(int x); }
public class Impl : IFoo
{
    public int M(int x) => x;
    public void Use() { M(1); }
}
public class Svc(IFoo foo) { public void Run() { foo.M(1); } }
public static class Handlers
{
    public static void H() { }
    public static void Reg() { Map(H); }
    static void Map(System.Action a) { }
}
`;
const PROGRAM = `using Lib;
var i = new Impl();
i.M(5);
new Svc(i).Run();
`;
const FILES = { 'Lib/Shapes.cs': LIB, 'App/Program.cs': PROGRAM };
const abs = (/** @type {string} */ rel) => path.join(ROOT, rel);
const textOf = (/** @type {string} */ file) => /** @type {Record<string, string>} */ (FILES)[path.relative(ROOT, file)] ?? null;
const index = createCsharpSyntacticIndex(Object.entries(FILES).map(([p, text]) => ({ path: p, text })), { root: ROOT, scope: 'test' });

/** The outline member `name` (of `member` kind) in `rel`: its name position. */
function posOf(/** @type {string} */ rel, /** @type {string} */ member, /** @type {string} */ name, /** @type {string|null} */ typeName = null) {
  /** @type {number|null} */
  let found = null;
  const walk = (/** @type {any[]} */ list) => {
    for (const s of list) {
      if (s.csharp && s.csharp.member === member && (s.csharp.decl ? s.csharp.decl.name : s.csharp.typeName || s.name) === name && (!typeName || s.csharp.typeName === typeName)) found = s.selectionRange.start;
      if (s.children) walk(s.children);
    }
  };
  walk(/** @type {any[]} */ (csharpOutline(/** @type {string} */ (textOf(abs(rel))), { fileName: path.basename(rel) })));
  assert.ok(found != null, `${rel}: no ${member} ${name}`);
  return /** @type {number} */ (found);
}

const LIB_FILE = abs('Lib/Shapes.cs');
const PROGRAM_FILE = abs('App/Program.cs');
const at = (/** @type {string} */ text, /** @type {string} */ needle, offset = 0) => { const i = text.indexOf(needle); assert.ok(i >= 0, needle); return i + offset; };
const site = (/** @type {string} */ text, /** @type {string} */ needle, /** @type {string} */ name) => { const s = at(text, needle) + needle.indexOf(name); return { start: s, end: s + name.length }; };

/** A caller row as Roslyn's services give it. */
const row = (/** @type {string} */ file, /** @type {string} */ label, /** @type {number} */ pos, /** @type {Array<{ start: number, end: number }>} */ callSites) => ({ file, label, pos, test: false, sites: callSites.length, callSites });

/**
 * Fake services: an item at each position in `answers` (`null`: no item), its incoming calls.
 * @param {Map<string, any[]|null>} answers keyed `file#pos`
 */
function fakeServices(answers) {
  const asked = /** @type {string[]} */ ([]);
  return {
    asked,
    available: async () => ({ ok: true }),
    async prepareCallHierarchy(/** @type {any} */ doc, /** @type {number} */ pos) {
      const id = `${doc.file}#${pos}`;
      asked.push(id);
      return answers.has(id) && answers.get(id) !== null ? [{ id }] : null;
    },
    async incomingCalls(/** @type {any} */ item) { return answers.get(item.id) || []; },
    async references() { return []; },
  };
}

const IMPL_M = posOf('Lib/Shapes.cs', 'method', 'M', 'Impl');
const IFOO_M = posOf('Lib/Shapes.cs', 'method', 'M', 'IFoo');
const USE = posOf('Lib/Shapes.cs', 'method', 'Use', 'Impl');
const RUN = posOf('Lib/Shapes.cs', 'method', 'Run', 'Svc');

function resolverWith(/** @type {Map<string, any[]|null>} */ answers, extrasOptions = {}) {
  const services = fakeServices(answers);
  const extras = createCsharpEditorExtras({ readText: textOf, repoRoot: ROOT, indexOf: async () => index, ...extrasOptions });
  return { services, resolver: createHierarchyResolver(/** @type {any} */ (services), { extras }) };
}

test('an implementation: the interface member is asked too, its rows labelled "through IFoo"; top-level callers are the module row', async () => {
  const answers = new Map([
    [`${LIB_FILE}#${IMPL_M}`, [
      row(LIB_FILE, 'Impl.Use()', USE, [site(LIB, '{ M(1); }', 'M')]),
      row(PROGRAM_FILE, 'Program.<top-level-statements-entry-point>', 0, [site(PROGRAM, 'i.M(5)', 'M')]),
    ]],
    // Disjoint in Roslyn; Impl.Use is listed here too only to show a caller reached both ways.
    [`${LIB_FILE}#${IFOO_M}`, [
      row(LIB_FILE, 'Svc.Run()', RUN, [site(LIB, 'foo.M(1)', 'M')]),
      row(LIB_FILE, 'Impl.Use()', USE, [site(LIB, '{ M(1); }', 'M')]),
    ]],
  ]);
  const { services, resolver } = resolverWith(answers);
  const answer = await resolver.incomingWithStatus(LIB_FILE, IMPL_M);
  assert.deepEqual(services.asked.sort(), [`${LIB_FILE}#${IFOO_M}`, `${LIB_FILE}#${IMPL_M}`].sort());
  const by = Object.fromEntries(answer.callers.map((c) => [c.label, c]));
  assert.deepEqual(Object.keys(by).sort(), ['Impl.Use()', 'Program.cs', 'Svc.Run()']);
  assert.equal(by['Svc.Run()'].via, 'interface');
  assert.equal(by['Svc.Run()'].text, 'through IFoo');
  assert.equal(by['Impl.Use()'].via, undefined, 'reached both ways: unlabelled');
  assert.equal(by['Program.cs'].pos, posOf('App/Program.cs', 'top-level', 'Program.cs'), 'top-level caller: the module row, as the syntax index lists it');
  assert.equal(answer.complete, false, 'through an interface: always incomplete');
  assert.match(String(answer.reason), /implements `IFoo\.M`/);
});

test('an empty answer for an implementing method is incomplete (the empty-answer guard)', async () => {
  const { resolver } = resolverWith(new Map([[`${LIB_FILE}#${IMPL_M}`, []], [`${LIB_FILE}#${IFOO_M}`, []]]));
  const answer = await resolver.incomingWithStatus(LIB_FILE, IMPL_M);
  assert.equal(answer.complete, false);
  assert.ok(String(answer.reason).includes(EMPTY_ANSWER_REASON));
});

test('a plain method with callers is complete; without the index, an instance method is incomplete', async () => {
  const reg = posOf('Lib/Shapes.cs', 'method', 'Reg', 'Handlers');
  const answers = new Map([[`${LIB_FILE}#${USE}`, [row(PROGRAM_FILE, 'Program.<top-level-statements-entry-point>', 0, [])]]]);
  const ok = await resolverWith(answers).resolver.incomingWithStatus(LIB_FILE, USE);
  assert.equal(ok.complete, true, String(ok.reason));
  const noIndex = await resolverWith(answers, { indexOf: async () => null }).resolver.incomingWithStatus(LIB_FILE, USE);
  assert.equal(noIndex.complete, false);
  assert.match(String(noIndex.reason), /syntax index is not available/);
  assert.ok(reg > 0);
});

test('a method group is a value use: its caller is dropped and the answer incomplete', async () => {
  const h = posOf('Lib/Shapes.cs', 'method', 'H', 'Handlers');
  const reg = posOf('Lib/Shapes.cs', 'method', 'Reg', 'Handlers');
  assert.equal(isCsharpCallSite(LIB, site(LIB, 'Map(H)', 'H'), 'H'), false);
  assert.equal(isCsharpCallSite(LIB, site(LIB, '{ M(1); }', 'M'), 'M'), true);
  const { resolver } = resolverWith(new Map([[`${LIB_FILE}#${h}`, [row(LIB_FILE, 'Handlers.Reg()', reg, [site(LIB, 'Map(H)', 'H')])]]]));
  const answer = await resolver.incomingWithStatus(LIB_FILE, h);
  assert.deepEqual(answer.callers, []);
  assert.equal(answer.complete, false);
  assert.ok(String(answer.reason).includes(VALUE_USE_REASON));
});

test('a primary constructor is not asked: the syntax index\'s callers, incomplete', async () => {
  const ctor = posOf('Lib/Shapes.cs', 'primary-constructor', 'Svc');
  const { services, resolver } = resolverWith(new Map());
  const answer = await resolver.incomingWithStatus(LIB_FILE, ctor);
  assert.deepEqual(services.asked, []);
  assert.deepEqual(answer.callers.map((c) => [c.label, c.pos]), [['Program.cs', posOf('App/Program.cs', 'top-level', 'Program.cs')]]);
  assert.equal(answer.complete, false);
  assert.ok(String(answer.reason).startsWith(PRIMARY_CONSTRUCTOR_REASON));
});

test('top-level statements are never asked of Roslyn: not computed', async () => {
  const top = posOf('App/Program.cs', 'top-level', 'Program.cs');
  const { services, resolver } = resolverWith(new Map());
  const state = await resolver.callerState(PROGRAM_FILE, top);
  assert.deepEqual(services.asked, []);
  assert.equal(state.state, 'unknown');
  assert.equal(state.reason, NOT_COMPUTED['top-level']);
});

test('no item at a listed member: the file may not be in a loaded project (not retryable)', async () => {
  const { resolver } = resolverWith(new Map([[`${LIB_FILE}#${USE}`, null]]));
  const answer = await resolver.incomingWithStatus(LIB_FILE, USE);
  assert.equal(answer.complete, false);
  assert.equal(answer.reason, NOT_LOADED_REASON);
  assert.ok(!answer.retryable);
});

// ---- the provider's probe (C-D3 as C0b changed it) ------------------------------------------

const BASE = 'namespace N;\npublic class A\n{\n    public int Run(int a) { return 1; }\n}\n';
const HEAD = 'namespace N;\npublic class A\n{\n    public int Run(int a, string b) { return 2; }\n}\n';
const ctxWith = (/** @type {any} */ hooks, /** @type {string[]} */ warnings) => /** @type {any} */ ({
  repo: '/nowhere', files: [{ path: 'src/A.cs', status: 'modified' }],
  baseTexts: new Map([['src/A.cs', BASE]]), headTexts: new Map([['src/A.cs', HEAD]]),
  changedRanges: { 'src/A.cs': [[4, 4]] }, deletions: {},
  warnings, unanalysable: new Map(), notAnalysedFiles: new Map(), report: () => {}, hooks,
  unit: { component: 'pull request', projectRoot: '' }, syntacticSources: [{ path: 'src/A.cs', text: HEAD }],
});

test('no provider → the syntax path with a note, asked again at the next analysis', async () => {
  let probes = 0;
  const provider = createCsharpProvider({ probe: async () => { probes++; return { ok: false, reason: 'the C# extension (ms-dotnettools.csharp) is not installed' }; } });
  const editorResolver = { kind: 'editor' };
  const hooks = { services: {}, makeResolver: () => editorResolver };
  for (let n = 0; n < 2; n++) {
    /** @type {string[]} */
    const warnings = [];
    const answer = await provider.prepare(ctxWith(hooks, warnings));
    assert.equal(answer.units.length, 1);
    assert.notEqual(answer.units[0].resolver, editorResolver);
    assert.equal(/** @type {any} */ (answer.units[0].resolver).callersLowerBound, true, 'the syntax index');
    assert.ok(warnings.some((w) => w.startsWith(NO_HIERARCHY_NOTE)), warnings.join('\n'));
  }
  assert.equal(probes, 2, 'a negative answer is asked again');
});

test('a positive probe is kept: the editor\'s resolver, the outline\'s members', async () => {
  let probes = 0;
  const provider = createCsharpProvider({ probe: async () => { probes++; return { ok: true }; } });
  const editorResolver = { kind: 'editor' };
  const hooks = { services: {}, makeResolver: () => editorResolver };
  for (let n = 0; n < 2; n++) {
    /** @type {string[]} */
    const warnings = [];
    const answer = await provider.prepare(ctxWith(hooks, warnings));
    assert.equal(answer.units[0].resolver, editorResolver);
    assert.deepEqual(answer.units[0].changed.map((/** @type {any} */ c) => c.key), ['A.Run(int)']);
    assert.ok(!warnings.some((w) => w.startsWith(NO_HIERARCHY_NOTE)));
  }
  assert.equal(probes, 1);
  // Without services (the CLI) the syntax path, never the probe.
  const cli = await provider.prepare(ctxWith({}, []));
  assert.equal(/** @type {any} */ (cli.units[0].resolver).callersLowerBound, true);
  assert.equal(probes, 1);
});
