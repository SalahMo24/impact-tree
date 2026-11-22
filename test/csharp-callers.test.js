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
const {
  createCsharpEditorExtras, EMPTY_ANSWER_REASON, VALUE_USE_REASON, NOT_COMPUTED, PRIMARY_CONSTRUCTOR_REASON, NOT_LOADED_REASON, isCsharpCallSite,
  PROPERTY_REASON, STALE_TARGET_REASON, SERVER_CHANGED_REASON, shortCallerName, NO_INDEX_REASON,
} = require('../src/languages/csharp/editor-extras');
const { createCsharpProvider, createServerStateTracker, NO_HIERARCHY_NOTE } = require('../src/languages/csharp/provider');
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
public sealed class Ctor { public Ctor(int a) { } }
public class Local
{
    static readonly int F = Helper.Twice(2);
    public int Run() { int Inner() => Helper.Twice(1); return Inner(); }
    public int Doubled { get { return Helper.Twice(3); } }
}
public static class Helper { public static int Twice(int x) => x * 2; }
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

test('a constructor is asked of Roslyn (not "not computed")', async () => {
  const ctor = posOf('Lib/Shapes.cs', 'constructor', 'Ctor');
  const { services, resolver } = resolverWith(new Map([[`${LIB_FILE}#${ctor}`, [row(LIB_FILE, 'Impl.Use()', USE, [])]]]));
  const answer = await resolver.incomingWithStatus(LIB_FILE, ctor);
  assert.deepEqual(services.asked, [`${LIB_FILE}#${ctor}`]);
  assert.equal(answer.complete, true, String(answer.reason));
  assert.equal(answer.callers.length, 1);
});

test('queries that start together share one session index build', async () => {
  const { sessionIndex } = require('../src/languages/csharp/editor-extras');
  /** @type {string[]} */
  const traces = [];
  const root = path.join(__dirname, '..');
  await Promise.all([sessionIndex(root, (m) => traces.push(m)), sessionIndex(root, (m) => traces.push(m))]);
  assert.equal(traces.filter((t) => /syntax index/.test(t)).length, 1, traces.join('\n'));
});

test('no item at a listed member: the file may not be in a loaded project (not retryable)', async () => {
  const { resolver } = resolverWith(new Map([[`${LIB_FILE}#${USE}`, null]]));
  const answer = await resolver.incomingWithStatus(LIB_FILE, USE);
  assert.equal(answer.complete, false);
  assert.equal(answer.reason, NOT_LOADED_REASON);
  assert.ok(!answer.retryable);
});

// ---- caller rows through the outline (review M1, M2) -----------------------------------------

test('S8: an incomplete answer is lasting for dispatch, value-use, property and primary-constructor reasons; not for a reload or a missing index', async () => {
  const { queryHierarchy, applyCallerExtras } = require('../src/languages/callers-from-hierarchy');
  /** @param {Map<string, any[]|null>} answers @param {number} pos @param {any} [extrasOptions] */
  const applied = async (answers, pos, extrasOptions = {}) => {
    const services = /** @type {any} */ (fakeServices(answers));
    const extras = createCsharpEditorExtras({ readText: textOf, repoRoot: ROOT, indexOf: async () => index, ...extrasOptions });
    const query = extras.query(LIB_FILE, pos);
    const askAt = (/** @type {string} */ f, /** @type {number} */ p) => queryHierarchy(services, { file: f, side: 'head' }, p);
    const hierarchy = query.isSuppressed() ? /** @type {const} */ ({ ready: true, rows: [] }) : await askAt(LIB_FILE, pos);
    const r = await applyCallerExtras(hierarchy, { extras, query, file: LIB_FILE, pos, withTests: true, askAt });
    assert.ok(!r.stale);
    return { complete: r.answer.complete, reason: r.answer.reason, lasting: r.lasting };
  };
  const empty = await applied(new Map([[`${LIB_FILE}#${IMPL_M}`, []], [`${LIB_FILE}#${IFOO_M}`, []]]), IMPL_M);
  assert.deepEqual([empty.complete, empty.lasting], [false, true], String(empty.reason));
  const h = posOf('Lib/Shapes.cs', 'method', 'H', 'Handlers');
  const reg = posOf('Lib/Shapes.cs', 'method', 'Reg', 'Handlers');
  const valueUse = await applied(new Map([[`${LIB_FILE}#${h}`, [row(LIB_FILE, 'Handlers.Reg()', reg, [site(LIB, 'Map(H)', 'H')])]]]), h);
  assert.deepEqual([valueUse.complete, valueUse.lasting], [false, true], String(valueUse.reason));
  const doubled = posOf('Lib/Shapes.cs', 'property', 'Doubled', 'Local');
  assert.deepEqual(await applied(new Map([[`${LIB_FILE}#${doubled}`, []]]), doubled), { complete: false, reason: PROPERTY_REASON, lasting: true });
  const ctor = posOf('Lib/Shapes.cs', 'primary-constructor', 'Svc');
  assert.equal((await applied(new Map(), ctor)).lasting, true);
  // Not lasting: the index is missing (S1/S5), or the server reloaded (M4).
  assert.equal((await applied(new Map(), ctor, { indexOf: async () => null })).lasting, false);
  const noIndex = await applied(new Map([[`${LIB_FILE}#${USE}`, []]]), USE, { indexOf: async () => null });
  assert.deepEqual([noIndex.complete, noIndex.lasting], [false, false]);
  const failed = await applied(new Map([[`${LIB_FILE}#${USE}`, []]]), USE, { indexOf: async () => { throw new Error('worker died'); } });
  assert.deepEqual([failed.complete, failed.lasting], [false, false]);
  const reload = await applied(new Map([[`${LIB_FILE}#${IMPL_M}`, []], [`${LIB_FILE}#${IFOO_M}`, []]]), IMPL_M, { serverSteady: () => false });
  assert.deepEqual(reload, { complete: false, reason: SERVER_CHANGED_REASON, lasting: false });
  // A complete answer is not "lasting" (it is cached as complete).
  const ok = await applied(new Map([[`${LIB_FILE}#${USE}`, [row(PROGRAM_FILE, 'Program.<top-level-statements-entry-point>', 0, [])]]]), USE);
  assert.deepEqual([ok.complete, ok.lasting], [true, false]);
});

test('M1: a caller row is named and placed as the outline member, never with Roslyn\'s qualified name', async () => {
  // Roslyn's form as VS Code labels it: the containing type's full name, then the item's name.
  const answers = new Map([[`${LIB_FILE}#${IMPL_M}`, [row(LIB_FILE, 'Lib.Impl.Impl.Use()', USE, [site(LIB, '{ M(1); }', 'M')])]], [`${LIB_FILE}#${IFOO_M}`, [
    row(LIB_FILE, 'Lib.Svc.Svc.Run()', RUN, [site(LIB, 'foo.M(1)', 'M')]),
  ]]]);
  const answer = await resolverWith(answers).resolver.incomingWithStatus(LIB_FILE, IMPL_M);
  assert.deepEqual(answer.callers.map((c) => [c.label, c.pos]).sort(), [['Impl.Use()', USE], ['Svc.Run()', RUN]]);
  const { collectCsharpSymbols } = require('../src/languages/csharp/provider');
  const keys = collectCsharpSymbols(/** @type {any} */ (csharpOutline(LIB, { fileName: 'Shapes.cs' })), LIB).map((s) => s.label);
  for (const c of answer.callers) assert.ok(keys.includes(c.label), `${c.label} is the changed-row label`);
});

test('M1/M2: a local function and an accessor are their member\'s rows; a row in no member keeps a short name', async () => {
  const twice = posOf('Lib/Shapes.cs', 'method', 'Twice', 'Helper');
  const run = posOf('Lib/Shapes.cs', 'method', 'Run', 'Local');
  const doubled = posOf('Lib/Shapes.cs', 'property', 'Doubled', 'Local');
  const answers = new Map([[`${LIB_FILE}#${twice}`, [
    row(LIB_FILE, 'Lib.Local.Local.F', at(LIB, 'F = Helper'), [site(LIB, 'F = Helper.Twice(2)', 'Twice')]),
    row(LIB_FILE, 'Lib.Local.Local.Inner()', at(LIB, 'Inner() =>'), [site(LIB, '=> Helper.Twice(1)', 'Twice')]),
    row(LIB_FILE, 'Lib.Local.Local.Run()', run, []),
    row(LIB_FILE, 'Lib.Local.Local.Doubled.get', at(LIB, 'get { return'), [site(LIB, 'return Helper.Twice(3)', 'Twice')]),
  ]]]);
  const answer = await resolverWith(answers).resolver.incomingWithStatus(LIB_FILE, twice);
  const by = Object.fromEntries(answer.callers.map((c) => [c.label, c]));
  assert.deepEqual(Object.keys(by).sort(), ['Local.Doubled', 'Local.F', 'Local.Run()']);
  assert.equal(by['Local.Run()'].pos, run, 'the local function is its method');
  assert.equal(by['Local.Run()'].sites, 1, 'the two rows merged, their sites joined');
  assert.equal(by['Local.Doubled'].pos, doubled, 'the accessor is its property, at the property\'s name');
  assert.equal(by['Local.F'].pos, at(LIB, 'F = Helper'), 'no outline member: Roslyn\'s position');
  assert.equal(answer.complete, true, String(answer.reason));
  // Asked at the mapped position, the property is a property: incomplete (calls through a base or interface property).
  const prop = await resolverWith(new Map([[`${LIB_FILE}#${doubled}`, []]])).resolver.incomingWithStatus(LIB_FILE, doubled);
  assert.equal(prop.complete, false);
  assert.equal(prop.reason, PROPERTY_REASON);
});

test('shortCallerName: no namespaces, no parameters', () => {
  assert.equal(shortCallerName('Acme.Tv.TvManager.TvManager.GetChannels(Acme.Model.Tv.ChannelQuery, System.Threading.CancellationToken)'), 'TvManager.GetChannels');
  assert.equal(shortCallerName('N.BaseNfoParser<T>.BaseNfoParser<T>.F'), 'BaseNfoParser<T>.F');
  assert.equal(shortCallerName('N.Box<System.Int32>.Box<System.Int32>.F'), 'Box<Int32>.F');
  assert.equal(shortCallerName('M()'), 'M');
});

// ---- the session index against the current text (review M3) ----------------------------------

test('M3: an interface member that moved since the index was built is not asked: incomplete with a reason', async () => {
  const moved = LIB.replace('public interface IFoo { int M(int x); }', 'public interface IFoo { int Pad(int y); int M(int x); }');
  const old = createCsharpSyntacticIndex([{ path: 'Lib/Shapes.cs', text: LIB }], { root: ROOT, scope: 'test' });
  const implM = at(moved, 'public int M(int x) => x;', 'public int '.length);
  const services = fakeServices(new Map([[`${LIB_FILE}#${implM}`, [row(LIB_FILE, 'Lib.Impl.Impl.Use()', at(moved, 'Use()'), [site(moved, '{ M(1); }', 'M')])]]]));
  const extras = createCsharpEditorExtras({ readText: (f) => (f === LIB_FILE ? moved : textOf(f)), repoRoot: ROOT, indexOf: async () => old });
  const answer = await createHierarchyResolver(/** @type {any} */ (services), { extras }).incomingWithStatus(LIB_FILE, implM);
  assert.deepEqual(services.asked, [`${LIB_FILE}#${implM}`], 'the stale position (now `Pad`) is not asked');
  assert.equal(answer.complete, false);
  assert.ok(String(answer.reason).includes(STALE_TARGET_REASON), String(answer.reason));
});

test('M3: by name among overloads is ambiguous: no target, a reason (never complete)', async () => {
  const before = 'namespace L;\npublic interface IBar { void M(int x); }\npublic class Two : IBar\n{\n    public void M(string s) { }\n    public void M(int x) { }\n}\n';
  const after = before.replace('{\n    public void M(string', '{\n    public void Pad() { }\n    public void M(string');
  const file = abs('L/Two.cs');
  const idx = createCsharpSyntacticIndex([{ path: 'L/Two.cs', text: before }], { root: ROOT, scope: 'test' });
  const mInt = at(after, 'M(int x) { }');
  const direct = idx.dispatchOf({ file, pos: mInt, name: 'M', className: 'Two' });
  assert.deepEqual(direct && direct.targets, []);
  assert.match(String(direct && direct.reasons), /2 members named `M`/);
  const services = fakeServices(new Map([[`${file}#${mInt}`, []]]));
  const extras = createCsharpEditorExtras({ readText: (f) => (f === file ? after : null), repoRoot: ROOT, indexOf: async () => idx });
  const answer = await createHierarchyResolver(/** @type {any} */ (services), { extras }).incomingWithStatus(file, mInt);
  assert.equal(answer.complete, false);
  assert.match(String(answer.reason), /2 members named `M`/);
});

const GEN = `namespace G;
public sealed class User { } public sealed class Order { }
public interface IRepo<T> { void Save(T item); }
public interface IFoo { void Run(int a); }
public sealed class Multi : IRepo<User>, IRepo<Order> { public void Save(User u) { } public void Save(Order o) { } }
public sealed class Ex : IFoo { void IFoo.Run(int a) { } }
public sealed class Wrap<T> : IRepo<T> { void IRepo<T>.Save(T item) { } }
sealed class U
{
    void A(IRepo<User> u) { u.Save(null); }
    void B(IRepo<Order> o, Multi m) { o.Save(null); m.Save(new Order()); }
    void C(IFoo f) { f.Run(1); }
}
`;
const GEN_FILE = abs('G/Gen.cs');
const genIndex = createCsharpSyntacticIndex([{ path: 'G/Gen.cs', text: GEN }], { root: ROOT, scope: 'test' });
/** @param {Map<string, any[]|null>} answers @param {string} [text] the file's current text */
function genResolver(answers, text = GEN) {
  const services = fakeServices(answers);
  const extras = createCsharpEditorExtras({ readText: (f) => (f === GEN_FILE ? text : null), repoRoot: ROOT, indexOf: async () => genIndex });
  return { services, resolver: createHierarchyResolver(/** @type {any} */ (services), { extras }) };
}

test('S3: a generic interface member is not asked; the index\'s calls through it are labelled rows (the CLI\'s), always incomplete', async () => {
  const saveOrder = at(GEN, 'Save(Order o)');
  const bPos = at(GEN, 'B(IRepo<Order>');
  // Roslyn at `Multi.Save(Order)`: the direct call `m.Save(…)` only.
  const { services, resolver } = genResolver(new Map([[`${GEN_FILE}#${saveOrder}`, [row(GEN_FILE, 'G.U.B(G.IRepo<G.Order>, G.Multi)', bPos, [site(GEN, 'm.Save(', 'Save')])]]]));
  const answer = await resolver.incomingWithStatus(GEN_FILE, saveOrder);
  assert.deepEqual(services.asked, [`${GEN_FILE}#${saveOrder}`], 'no position asked at `IRepo<T>.Save`');
  assert.deepEqual(answer.callers.map((c) => [c.label, c.via, c.text]), [['U.B(IRepo, Multi)', undefined, undefined]], 'reached directly too: the direct row');
  assert.equal(answer.complete, false);
  assert.match(String(answer.reason), /implements `IRepo.Save` of a generic interface: calls through it are listed as "through `IRepo`"/);
  // The other instantiation's overload: its row comes from the index alone, as the CLI's.
  const saveUser = at(GEN, 'Save(User u)');
  const user = await genResolver(new Map([[`${GEN_FILE}#${saveUser}`, []]])).resolver.incomingWithStatus(GEN_FILE, saveUser);
  const cli = genIndex.callersOfWithStatus({ file: GEN_FILE, pos: saveUser, name: 'Save' }).callers;
  assert.deepEqual(user.callers.map((c) => [c.label, c.pos, c.via, c.text]), cli.map((c) => [c.label, c.pos, c.via, c.text]));
  assert.deepEqual(user.callers.map((c) => [c.label, c.text]), [['U.A(IRepo)', 'through IRepo']]);
  assert.equal(user.complete, false);
  // A row where the current text has no member any more is not listed: a reason.
  const moved = GEN.replace('    void A(IRepo<User> u)', '    void Pad() { }\n    void A(IRepo<User> u)');
  const stale = await genResolver(new Map([[`${GEN_FILE}#${saveUser}`, []]]), moved).resolver.incomingWithStatus(GEN_FILE, saveUser);
  assert.deepEqual(stale.callers, []);
  assert.match(String(stale.reason), /1 caller\(s\) through a generic interface are not where the C# syntax index has them/);
});

test('S4: an explicit implementation is not asked itself; its interface member is (the stale check passes), labelled', async () => {
  const exRun = at(GEN, 'Run(int a) { }');
  const ifooRun = at(GEN, 'Run(int a); }');
  const cPos = at(GEN, 'C(IFoo f)');
  const { services, resolver } = genResolver(new Map([[`${GEN_FILE}#${ifooRun}`, [row(GEN_FILE, 'G.U.C(G.IFoo)', cPos, [site(GEN, 'f.Run(1)', 'Run')])]]]));
  const answer = await resolver.incomingWithStatus(GEN_FILE, exRun);
  assert.deepEqual(services.asked, [`${GEN_FILE}#${ifooRun}`], 'the explicit member itself is suppressed');
  assert.deepEqual(answer.callers.map((c) => [c.label, c.via, c.text]), [['U.C(IFoo)', 'interface', 'through IFoo']]);
  assert.equal(answer.complete, false);
  assert.match(String(answer.reason), /an explicit implementation of `IFoo.Run`/);
  assert.doesNotMatch(String(answer.reason), /no call-hierarchy item|STALE|not where the C# syntax index has it/);
  // Its interface member answers nothing: incomplete (an empty answer can hide a failure).
  const empty = await genResolver(new Map([[`${GEN_FILE}#${ifooRun}`, []]])).resolver.callerState(GEN_FILE, exRun);
  assert.equal(empty.state, 'unknown');
  assert.ok(String(empty.reason).includes(EMPTY_ANSWER_REASON));
  // Explicit and generic (`void IRepo<T>.Save(T)`): no Roslyn query at all, the index's rows.
  const wrapSave = at(GEN, 'Save(T item) { }');
  const g = genResolver(new Map());
  const wrap = await g.resolver.incomingWithStatus(GEN_FILE, wrapSave);
  assert.deepEqual(g.services.asked, []);
  assert.deepEqual(wrap.callers.map((c) => [c.label, c.text]), [['U.A(IRepo)', 'through IRepo'], ['U.B(IRepo, Multi)', 'through IRepo']]);
  assert.equal(wrap.complete, false);
  assert.doesNotMatch(String(wrap.reason), /returned no callers/);
});

test('M3: the session index is rebuilt after an uncommitted edit (same HEAD)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const { sessionIndex, recheckSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-cs-index-')));
  try {
    const git = (/** @type {string[]} */ args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'A.cs'), 'namespace N;\npublic class A { public void M() { } }\n');
    git(['init', '-q']);
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);
    /** @type {string[]} */
    const traces = [];
    const trace = (/** @type {string} */ m) => traces.push(m);
    const builds = () => traces.filter((t) => /index for dispatch built/.test(t)).length;
    const first = await sessionIndex(dir, trace);
    recheckSessionIndexes();
    assert.equal(await sessionIndex(dir, trace), first, 'nothing changed: the same index');
    const edited = 'namespace N;\npublic class A\n{\n    public void Pad() { M(); }\n    public void M() { }\n}\n';
    fs.writeFileSync(path.join(dir, 'A.cs'), edited);
    recheckSessionIndexes();
    const second = await sessionIndex(dir, trace);
    assert.notEqual(second, first);
    assert.equal(builds(), 2, traces.join('\n'));
    const target = { file: path.join(dir, 'A.cs'), pos: edited.indexOf('M() { }'), name: 'M', className: 'A' };
    assert.deepEqual((await second.callersOfWithStatus(target)).callers.map((/** @type {any} */ c) => c.label), ['A.Pad()'], 'the edit is in the index');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('M4: a server state change after a positive probe: the next analysis probes again; answers meanwhile are incomplete', async () => {
  let probes = 0;
  let changes = 0;
  const provider = createCsharpProvider({ probe: async () => { probes++; return { ok: true }; }, serverChanges: () => changes });
  const editorResolver = { kind: 'editor' };
  const hooks = { services: {}, makeResolver: () => editorResolver };
  await provider.prepare(ctxWith(hooks, []));
  const extras = /** @type {NonNullable<typeof provider.editorCallers>} */ (provider.editorCallers)(/** @type {any} */ ({ trace: () => {}, repoRoot: ROOT, services: {}, ts: null }));
  const twice = posOf('Lib/Shapes.cs', 'method', 'Twice', 'Helper');
  const query = extras.query(LIB_FILE, twice);
  changes++; // the server reloads its projects (state 2) during the analysis
  const more = query.moreCallers ? await query.moreCallers() : null;
  assert.equal(more && more.incompleteReason, SERVER_CHANGED_REASON);
  await provider.prepare(ctxWith(hooks, []));
  assert.equal(probes, 2, 'asked again after the change');
  await provider.prepare(ctxWith(hooks, []));
  assert.equal(probes, 2, 'no change since: kept');
});

test('M4: the state tracker waits for "loaded" after a reload, not the one-shot initial load', async () => {
  const tracker = createServerStateTracker();
  /** @type {(e: { state: number }) => void} */
  let fire = () => {};
  tracker.subscribe({ experimental: { languageServerEvents: { onServerStateChange: (/** @type {any} */ f) => { fire = f; } } } });
  let initial = 0;
  const initialLoad = async () => { initial++; };
  await tracker.loaded(initialLoad);
  assert.equal(initial, 1, 'no state reported yet: the extension\'s initialisation answers');
  fire({ state: 2 });
  let done = false;
  const wait = tracker.loaded(initialLoad).then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'loading: not trusted');
  assert.equal(initial, 1, 'the one-shot promise is not asked while loading');
  fire({ state: 3 });
  await wait;
  assert.equal(done, true);
  assert.equal(tracker.changes, 2);
});

// ---- the session index in its worker (S1, S2, S5) -------------------------------------------

/** A committed repository holding FILES; removed by the caller. */
function csharpRepo() {
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-cs-worker-')));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const git = (/** @type {string[]} */ args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A fake worker: `answer(message)` gives `{ value }`, `{ error }`, `'exit'`, `'error'` or
 * nothing (never answers); `{ value, delay }` answers after `delay` ms. `messages`: what it got.
 * @param {(message: any) => any} answer
 */
function fakeWorker(answer) {
  const { EventEmitter } = require('node:events');
  const w = Object.assign(new EventEmitter(), {
    terminated: false,
    /** @type {any[]} */
    messages: [],
    ref() {}, unref() {},
    async terminate() { w.terminated = true; },
    postMessage(/** @type {any} */ message) {
      w.messages.push(message);
      const out = answer(message);
      setTimeout(() => {
        if (w.terminated) return;
        if (out === 'exit') w.emit('exit', 1);
        else if (out === 'error') w.emit('error', new Error('worker crashed'));
        else if (out) w.emit('message', { id: message.id, value: out.value, error: out.error });
      }, (out && out.delay) || 0);
    },
  });
  return w;
}

const BUILT = { built: true, files: 2, bytes: 10, size: 2, ms: 1, heapMb: 1, heapPeakMb: 2, reason: null };
/** A counting fake worker factory: `workers` made, each answering with `answer`. @param {(message: any) => any} answer */
function fakeWorkers(answer) {
  /** @type {any[]} */
  const workers = [];
  return { workers, builds: () => workers.flatMap((w) => w.messages).filter((m) => m.kind === 'build').length, makeWorker: () => { const w = fakeWorker(answer); workers.push(w); return w; } };
}
/** Edits Lib/Shapes.cs in `dir` (a new tree state). @param {string} dir @param {string} text */
const editLib = (dir, text) => require('node:fs').writeFileSync(path.join(dir, 'Lib/Shapes.cs'), text);

const IMPL_ARG = (/** @type {string} */ dir) => ({ file: path.join(dir, 'Lib/Shapes.cs'), pos: IMPL_M, name: 'M', className: 'Impl' });
const CTOR_ARG = (/** @type {string} */ dir) => ({ file: path.join(dir, 'Lib/Shapes.cs'), pos: posOf('Lib/Shapes.cs', 'primary-constructor', 'Svc'), name: 'Svc', className: 'Svc' });

test('S2: the worker\'s answers equal the in-thread index\'s; build, files and heap traced', async () => {
  const { sessionIndex } = require('../src/languages/csharp/editor-extras');
  const { indexRepositoryWithin } = require('../src/languages/csharp/provider');
  const { makeGit } = require('../src/engine/git');
  const repo = csharpRepo();
  try {
    /** @type {string[]} */
    const traces = [];
    const viaWorker = await sessionIndex(repo.dir, (m) => traces.push(m));
    const local = indexRepositoryWithin(repo.dir, makeGit(repo.dir), { maxFiles: 10, maxBytes: 1024 * 1024 }).index;
    assert.ok(local);
    assert.match(traces.join('\n'), /built in \d+ms in its worker \(2 of 2 file\(s\), \d+ MiB; worker heap peak \d+ MiB, \d+ MiB after\)/);
    const plain = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(await viaWorker.dispatchOf(IMPL_ARG(repo.dir)), plain(local.dispatchOf(IMPL_ARG(repo.dir))));
    assert.equal((await viaWorker.dispatchOf(IMPL_ARG(repo.dir))).targets.length, 1, 'IFoo.M');
    const ctor = await viaWorker.callersOfWithStatus(CTOR_ARG(repo.dir));
    assert.deepEqual(ctor, plain(local.callersOfWithStatus(CTOR_ARG(repo.dir))));
    assert.ok(ctor.callers.length >= 1, 'new Svc(i)');
  } finally {
    repo.done();
  }
});

test('S1: past the editor\'s bound, no index: every method says why, with both numbers', async () => {
  const { sessionIndex } = require('../src/languages/csharp/editor-extras');
  const repo = csharpRepo();
  try {
    const indexOf = () => sessionIndex(repo.dir, () => {}, { maxFiles: 1 });
    await assert.rejects(indexOf(), /2 C# file\(s\), [\d.]+ MiB, over the editor's bound of 1 files or 96 MiB/);
    const file = path.join(repo.dir, 'Lib/Shapes.cs');
    const services = fakeServices(new Map([[`${file}#${IMPL_M}`, []]]));
    const extras = createCsharpEditorExtras({ readText: (f) => textOf(abs(path.relative(repo.dir, f))), repoRoot: repo.dir, indexOf });
    const resolver = createHierarchyResolver(/** @type {any} */ (services), { extras });
    const answer = await resolver.incomingWithStatus(file, IMPL_M);
    assert.equal(answer.complete, false);
    assert.ok(String(answer.reason).startsWith(NO_INDEX_REASON), String(answer.reason));
    assert.match(String(answer.reason), /2 C# file\(s\).*bound of 1 files/);
    const ctor = await resolver.incomingWithStatus(file, CTOR_ARG(repo.dir).pos);
    assert.equal(ctor.complete, false);
    assert.match(String(ctor.reason), /primary constructor.*not available \(the repository has 2 C# file\(s\)/);
  } finally {
    repo.done();
  }
});

test('S5: a worker that fails, times out or dies mid-lookup: a reason, incomplete (never rejected, never complete)', async () => {
  const { sessionIndex, LOOKUP_FAILED_REASON } = require('../src/languages/csharp/editor-extras');
  const built = { value: { built: true, files: 2, bytes: 10, size: 2, ms: 1, heapMb: 1, reason: null } };
  const cases = [
    { name: 'crash at build', answer: () => 'error', expect: /worker failed: worker crashed/ },
    { name: 'timeout at build', answer: () => null, expect: /did not answer within 30 ms/ },
    { name: 'death at lookup', answer: (/** @type {any} */ m) => (m.kind === 'build' ? built : 'exit'), expect: /exited \(1\)/ },
    { name: 'throw in lookup', answer: (/** @type {any} */ m) => (m.kind === 'build' ? built : { error: 'boom' }), expect: /boom/ },
  ];
  for (const c of cases) {
    const repo = csharpRepo();
    try {
      /** @type {any[]} */
      const workers = [];
      const options = { makeWorker: () => { const w = fakeWorker(c.answer); workers.push(w); return w; }, buildMs: 30, queryMs: 30 };
      const file = path.join(repo.dir, 'Lib/Shapes.cs');
      const services = fakeServices(new Map([[`${file}#${IMPL_M}`, []]]));
      const extras = createCsharpEditorExtras({ readText: (f) => textOf(abs(path.relative(repo.dir, f))), repoRoot: repo.dir, indexOf: () => sessionIndex(repo.dir, () => {}, options) });
      const resolver = createHierarchyResolver(/** @type {any} */ (services), { extras });
      const answer = await resolver.incomingWithStatus(file, IMPL_M);
      assert.equal(answer.complete, false, c.name);
      assert.match(String(answer.reason), c.expect, c.name);
      if (c.name.endsWith('lookup')) assert.ok(String(answer.reason).startsWith(LOOKUP_FAILED_REASON), String(answer.reason));
      else assert.ok(String(answer.reason).startsWith(NO_INDEX_REASON), String(answer.reason));
      const ctor = await resolver.incomingWithStatus(file, CTOR_ARG(repo.dir).pos);
      assert.equal(ctor.complete, false, c.name);
      assert.match(String(ctor.reason), /primary constructor/, c.name);
      if (c.name !== 'throw in lookup') assert.ok(workers[0].terminated, `${c.name}: the worker is terminated`);
    } finally {
      repo.done();
    }
  }
});

test('S2: a worker that cannot start: the index is built in this thread within the CLI\'s bound', async () => {
  const { sessionIndex } = require('../src/languages/csharp/editor-extras');
  const repo = csharpRepo();
  try {
    /** @type {string[]} */
    const traces = [];
    const idx = await sessionIndex(repo.dir, (m) => traces.push(m), { makeWorker: () => { throw new Error('no threads'); } });
    assert.match(traces.join('\n'), /could not start: no threads; building the syntax index in this thread within the CLI's bound/);
    assert.equal((await idx.dispatchOf(IMPL_ARG(repo.dir))).targets.length, 1);
  } finally {
    repo.done();
  }
});

test('S2: disposing ends the workers; the next lookup starts another', async () => {
  const { sessionIndex, disposeSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const repo = csharpRepo();
  try {
    const { workers, makeWorker } = fakeWorkers(() => ({ value: BUILT }));
    await sessionIndex(repo.dir, () => {}, { makeWorker });
    disposeSessionIndexes();
    assert.ok(workers[0].terminated);
    await sessionIndex(repo.dir, () => {}, { makeWorker });
    assert.equal(workers.length, 2);
    disposeSessionIndexes();
  } finally {
    repo.done();
  }
});

test('S2: a dispose during the tree-state check starts no worker; the build rejects', async () => {
  const { sessionIndex, disposeSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const repo = csharpRepo();
  try {
    const { workers, makeWorker } = fakeWorkers(() => ({ value: BUILT }));
    const pending = sessionIndex(repo.dir, () => {}, { makeWorker });
    disposeSessionIndexes();
    await assert.rejects(pending, /disposed/);
    assert.equal(workers.length, 0);
  } finally {
    repo.done();
  }
});

test('S2: one repository at a time: indexing another terminates the previous worker', async () => {
  const { sessionIndex, disposeSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const a = csharpRepo();
  const b = csharpRepo();
  try {
    const { workers, makeWorker } = fakeWorkers(() => ({ value: BUILT }));
    await sessionIndex(a.dir, () => {}, { makeWorker });
    await sessionIndex(b.dir, () => {}, { makeWorker });
    assert.deepEqual(workers.map((w) => w.terminated), [true, false]);
    disposeSessionIndexes();
  } finally {
    a.done();
    b.done();
  }
});

test('S1: a failed build is remembered for its tree state and retried at the next one; a dead worker is rebuilt', async () => {
  const { sessionIndex, recheckSessionIndexes, disposeSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const repo = csharpRepo();
  try {
    let crash = true;
    const fakes = fakeWorkers((m) => (m.kind !== 'build' ? 'exit' : crash ? 'error' : { value: BUILT }));
    const options = { makeWorker: fakes.makeWorker };
    await assert.rejects(sessionIndex(repo.dir, () => {}, options), /worker crashed/);
    recheckSessionIndexes();
    await assert.rejects(sessionIndex(repo.dir, () => {}, options), /worker crashed/, 'the same state: the failure, remembered');
    assert.equal(fakes.builds(), 1, 'not rebuilt');
    crash = false;
    editLib(repo.dir, `${LIB}\n// edited\n`);
    recheckSessionIndexes();
    const idx = await sessionIndex(repo.dir, () => {}, options);
    assert.equal(fakes.builds(), 2, 'a new tree state: built again');
    await assert.rejects(idx.dispatchOf(IMPL_ARG(repo.dir)), /exited \(1\)/);
    recheckSessionIndexes();
    await sessionIndex(repo.dir, () => {}, options);
    assert.equal(fakes.builds(), 3, 'the worker died: rebuilt at the next analysis');
    assert.equal(fakes.workers.length, 3);
    disposeSessionIndexes();
  } finally {
    repo.done();
  }
});

test('S1: past the bound is remembered for the tree state (no second build)', async () => {
  const { sessionIndex, recheckSessionIndexes, disposeSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const repo = csharpRepo();
  try {
    const fakes = fakeWorkers(() => ({ value: { ...BUILT, size: 0, reason: 'over the bound' } }));
    await assert.rejects(sessionIndex(repo.dir, () => {}, { makeWorker: fakes.makeWorker }), /over the bound/);
    recheckSessionIndexes();
    await assert.rejects(sessionIndex(repo.dir, () => {}, { makeWorker: fakes.makeWorker }), /over the bound/);
    assert.equal(fakes.builds(), 1);
    disposeSessionIndexes();
  } finally {
    repo.done();
  }
});

test('S2: a query of an earlier build is not posted behind a newer build (its deadline cannot kill it)', async () => {
  const { sessionIndex, recheckSessionIndexes, disposeSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const repo = csharpRepo();
  try {
    let slow = false;
    const fakes = fakeWorkers((m) => (m.kind === 'build' ? { value: BUILT, delay: slow ? 120 : 0 } : { value: { targets: [], reasons: [] } }));
    const options = { makeWorker: fakes.makeWorker, queryMs: 30 };
    const first = await sessionIndex(repo.dir, () => {}, options);
    slow = true;
    editLib(repo.dir, `${LIB}\n// edited\n`);
    recheckSessionIndexes();
    const second = sessionIndex(repo.dir, () => {}, options);
    while (fakes.builds() < 2) await new Promise((r) => setTimeout(r, 2));
    await assert.rejects(first.dispatchOf(IMPL_ARG(repo.dir)), /rebuilt for another tree state/);
    const idx = await second;
    assert.deepEqual(await idx.dispatchOf(IMPL_ARG(repo.dir)), { targets: [], reasons: [] });
    assert.equal(fakes.workers.length, 1, 'the worker was not killed');
    assert.ok(!fakes.workers[0].messages.some((/** @type {any} */ m) => m.kind === 'dispatchOf' && m.state !== fakes.workers[0].messages[1].state));
    disposeSessionIndexes();
  } finally {
    repo.done();
  }
});

test('S2: the in-thread fallback is refused above its bound; options are range-checked', async () => {
  const { sessionIndex, disposeSessionIndexes } = require('../src/languages/csharp/editor-extras');
  const { createCsharpIndexPool } = require('../src/languages/csharp/index-pool');
  const repo = csharpRepo();
  try {
    const options = { makeWorker: () => { throw new Error('no threads'); }, fallbackBound: { maxFiles: 1, maxBytes: 1024 * 1024 } };
    await assert.rejects(sessionIndex(repo.dir, () => {}, options), /2 C# file\(s\), [\d.]+ MiB, over the bound of an index built without its worker of 1 files/);
    disposeSessionIndexes();
    await assert.rejects(sessionIndex(repo.dir, () => {}, { maxFiles: 0 }), RangeError);
    assert.throws(() => createCsharpIndexPool(repo.dir, { queryMs: 0 }), RangeError);
    assert.throws(() => createCsharpIndexPool(repo.dir, { heapMb: 100000 }), RangeError);
    disposeSessionIndexes();
  } finally {
    repo.done();
  }
});
