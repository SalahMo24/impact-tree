'use strict';
// C#'s syntax-only caller index (Part C, C8a; src/languages/csharp/syntactic-index.js): the
// receiver rules (fields, properties, primary-constructor parameters, locals, `var x = new`,
// casts, `as`, return types, static calls, `this`/`base`), namespaces and usings, partial
// types, constructors (`new T(`, `new()`, `: base(`, `: this(`, a primary base call), overload
// arity ranges, top-level statements, and what is never listed or marks the answer
// incomplete (interfaces, overrides, outside bases, extension methods, method groups,
// properties, look-alike names in another namespace, untyped receivers).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCsharpSyntacticIndex, implicitUsingsOf } = require('../src/languages/csharp/syntactic-index');

const SOURCES = [
  { path: 'Lib/Repo.cs', text: `namespace Shop.Data;

public interface IRepo { Item Get(int id); }

public class Item { public void Touch() { } public Item Self() => this; }

public class Repo : IRepo
{
    public Item Get(int id) => new Item();
    public static Repo Create() => new();
    public void Save(Item item, bool flush = false, params string[] tags) { }
    public void Save(string name) { }
}

public sealed class Box(Repo repo)
{
    private readonly Repo _repo = repo;
    public Repo Inner { get; } = repo;
    public void Run() { repo.Save("x"); _repo.Save(new Item()); Inner.Save(null, true, "a", "b"); }
}
` },
  { path: 'Lib/Other.cs', text: `namespace Other.Place
{
    public class Repo { public void Save(string name) { } }
}
` },
  { path: 'App/Service.cs', text: `using Shop.Data;
using static Shop.Data.Helpers;

namespace Shop.App
{
    public class BaseService
    {
        public BaseService() { }
        public BaseService(int x) { }
        protected void Log(string m) { }
    }

    public partial class Service : BaseService
    {
        private readonly IRepo _irepo;
        public Service(IRepo irepo) : base(1) { _irepo = irepo; }
        public Service() : this(null) { }

        public void A(Repo r, object o)
        {
            var local = new Repo();
            local.Save("a");
            r.Save("b");
            ((Repo)o).Save("c");
            (o as Repo).Save("d");
            var cast = o as Repo;
            cast.Save("e");
            Repo.Create().Save("f");
            Repo typed = new();
            typed.Save("g");
            _irepo.Get(1).Touch();
            Log("x");
            this.Log("y");
            Twice(3);
            var items = new List<int>();
            items.ForEach(x => x.Save("h"));
            Func<string, int> f = Count;
        }

        private static int Count(string s) => s.Length;
        public int Size => Count("z");
    }

    public partial class Service { public void B() { A(null, null); new Other.Place.Repo().Save("q"); } }
}
` },
  { path: 'App/Helpers.cs', text: `namespace Shop.Data;
public static class Helpers
{
    public static void Twice(int n) { }
    public static string Shout(this string s) => s;
}
public class Controller : ControllerBase
{
    public void Act() { "a".Shout(); Helpers.Shout("b"); }
}
` },
  { path: 'App/Program.cs', text: `using Shop.Data;
var repo = Repo.Create();
repo.Save("top");
Run();
static void Run() { }
` },
];

const idx = createCsharpSyntacticIndex(SOURCES, { root: '/r', scope: 'the fixture' });
const textOf = (file) => SOURCES.find((s) => `/r/${s.path}` === file).text;

/** The callers of the member keyed `key` in `rel`: rows `caller: call line`, the reason, unresolved count. */
function callersOf(rel, key) {
  const d = idx.byFile.get(`/r/${rel}`).defs.find((x) => x.key === key);
  assert.ok(d, `${rel} declares ${key}`);
  const a = idx.callersOfWithStatus({ file: `/r/${rel}`, name: d.name, pos: d.namePos });
  const rows = a.callers.flatMap((c) => c.callSites.map((s) => {
    const text = textOf(c.file);
    const line = text.slice(text.lastIndexOf('\n', s.start) + 1, text.indexOf('\n', s.start)).trim();
    return `${c.label}: ${line}`;
  })).sort();
  return { rows, reason: a.incompleteReason, unresolved: idx.unresolvedCallsTo({ name: d.name }) };
}

test('every file is indexed', () => {
  assert.equal(idx.size, SOURCES.length);
  assert.equal(idx.skipped, 0);
});

test('receivers: locals, parameters, casts, as, return types, target-typed new, primary-constructor parameters, fields, properties, top-level statements', () => {
  const save = callersOf('Lib/Repo.cs', 'Repo.Save(string)');
  assert.deepEqual(save.rows, [
    'Box.Run(): public void Run() { repo.Save("x"); _repo.Save(new Item()); Inner.Save(null, true, "a", "b"); }',
    'Program.cs: repo.Save("top");',
    'Service.A(Repo, object): ((Repo)o).Save("c");',
    'Service.A(Repo, object): (o as Repo).Save("d");',
    'Service.A(Repo, object): Repo.Create().Save("f");',
    'Service.A(Repo, object): cast.Save("e");',
    'Service.A(Repo, object): local.Save("a");',
    'Service.A(Repo, object): r.Save("b");',
    'Service.A(Repo, object): typed.Save("g");',
  ]);
  // `x.Save("h")` on an untyped lambda parameter: unresolved, never listed.
  assert.equal(save.unresolved, 1);
  assert.equal(save.reason, null);
});

test('overloads by arity range (optional and params parameters), a literal or `new T()` argument deciding between them', () => {
  const save = callersOf('Lib/Repo.cs', 'Repo.Save(Item, bool, params string[])');
  assert.deepEqual(save.rows, [
    'Box.Run(): public void Run() { repo.Save("x"); _repo.Save(new Item()); Inner.Save(null, true, "a", "b"); }',
    'Box.Run(): public void Run() { repo.Save("x"); _repo.Save(new Item()); Inner.Save(null, true, "a", "b"); }',
  ]);
  assert.equal(save.reason, null);
});

test('a look-alike type in another namespace is not the target', () => {
  const other = callersOf('Lib/Other.cs', 'Repo.Save(string)');
  assert.deepEqual(other.rows, ['Service.B(): public partial class Service { public void B() { A(null, null); new Other.Place.Repo().Save("q"); } }']);
});

test('constructors: new T(), new(), : base(…), : this(…), a primary constructor', () => {
  assert.deepEqual(callersOf('App/Service.cs', 'BaseService.<init>(int)').rows, ['new Service(IRepo): public Service(IRepo irepo) : base(1) { _irepo = irepo; }']);
  assert.deepEqual(callersOf('App/Service.cs', 'Service.<init>(IRepo)').rows, ['new Service(): public Service() : this(null) { }']);
  const repoNew = callersOf('Lib/Repo.cs', 'Item.Self()');
  assert.deepEqual(repoNew.rows, []);
  assert.deepEqual(callersOf('App/Service.cs', 'BaseService.<init>()').rows, []);
  assert.match(callersOf('App/Service.cs', 'BaseService.<init>()').reason, /implicit base call/);
});

test('partial parts merge: a call in one part reaches a method of the other', () => {
  assert.deepEqual(callersOf('App/Service.cs', 'Service.A(Repo, object)').rows, ['Service.B(): public partial class Service { public void B() { A(null, null); new Other.Place.Repo().Save("q"); } }']);
});

test('inherited members, this, using static and a return type through an interface', () => {
  assert.deepEqual(callersOf('App/Service.cs', 'BaseService.Log(string)').rows, ['Service.A(Repo, object): Log("x");', 'Service.A(Repo, object): this.Log("y");']);
  assert.deepEqual(callersOf('App/Helpers.cs', 'Helpers.Twice(int)').rows, ['Service.A(Repo, object): Twice(3);']);
  assert.deepEqual(callersOf('Lib/Repo.cs', 'Item.Touch()').rows, ['Service.A(Repo, object): _irepo.Get(1).Touch();']);
});

test('interfaces: the interface member lists its direct calls; an implementation is incomplete naming it', () => {
  const iget = callersOf('Lib/Repo.cs', 'IRepo.Get(int)');
  assert.deepEqual(iget.rows, ['Service.A(Repo, object): _irepo.Get(1).Touch();']);
  assert.match(iget.reason, /interface `IRepo`/);
  const get = callersOf('Lib/Repo.cs', 'Repo.Get(int)');
  assert.deepEqual(get.rows, []);
  assert.match(get.reason, /`IRepo`/);
});

test('an outside base marks public instance methods incomplete (C-D5)', () => {
  const act = callersOf('App/Helpers.cs', 'Controller.Act()');
  assert.match(act.reason, /through `ControllerBase`, which is not in the indexed files/);
  assert.ok(idx.undeclaredBase.size >= 1);
});

test('extension methods: the static form is listed, the receiver form counts as unresolved', () => {
  const shout = callersOf('App/Helpers.cs', 'Helpers.Shout(this string)');
  assert.deepEqual(shout.rows, ['Controller.Act(): public void Act() { "a".Shout(); Helpers.Shout("b"); }']);
  assert.match(shout.reason, /extension method/);
  assert.equal(shout.unresolved, 1);
});

test('method groups are value uses; properties are not computed; a private static method with direct calls only is complete', () => {
  const count = callersOf('App/Service.cs', 'Service.Count(string)');
  assert.deepEqual(count.rows, ['Service.Size: public int Size => Count("z");']);
  assert.match(count.reason, /method group 1 time/);
  assert.match(callersOf('App/Service.cs', 'Service.Size').reason, /^not computed/);
  const twice = callersOf('App/Helpers.cs', 'Helpers.Twice(int)');
  assert.equal(twice.reason, null);
  assert.equal(twice.unresolved, 0);
});

test('top-level statements own their calls; a local function is not a member call', () => {
  assert.deepEqual(callersOf('Lib/Repo.cs', 'Repo.Create()').rows, ['Program.cs: var repo = Repo.Create();', 'Service.A(Repo, object): Repo.Create().Save("f");']);
});

test('the preview: no answer is complete', () => {
  const p = createCsharpSyntacticIndex(SOURCES, { root: '/r', scope: 'the PR', partial: true });
  const d = p.byFile.get('/r/App/Helpers.cs').defs.find((x) => x.key === 'Helpers.Twice(int)');
  assert.match(p.callersOfWithStatus({ file: '/r/App/Helpers.cs', name: d.name, pos: d.namePos }).incompleteReason, /outside the pull request/);
});

test('implicit usings from a project file', () => {
  assert.deepEqual(implicitUsingsOf('<Project Sdk="Microsoft.NET.Sdk"></Project>'), []);
  assert.ok(implicitUsingsOf('<Project Sdk="Microsoft.NET.Sdk.Web"><ImplicitUsings>enable</ImplicitUsings></Project>').includes('Microsoft.Extensions.Logging'));
  assert.ok(implicitUsingsOf('<Project Sdk="Microsoft.NET.Sdk"><ImplicitUsings>enable</ImplicitUsings></Project>').includes('System.Linq'));
});

test('regressions from the first oracle run: an outside call\'s result is not typed, relative namespaces, `is T ? A() : B()`', () => {
  const sources = [
    { path: 'Emby.Naming/TV/SeriesResolver.cs', text: 'namespace Emby.Naming.TV;\npublic static class SeriesResolver { public static int Resolve(string p) => 1; }\n' },
    { path: 'Emby.Server/Mig.cs', text: 'namespace Emby.Server.Migrations;\npublic class Mig { public int Step(int x) => x; public int Pick(int k) => k; }\n' },
    { path: 'Emby.Server/Run.cs', text: `using Emby.Server.Migrations;
namespace Emby.Server.Run
{
    public static class Runner
    {
        public static void Go(object sp, Kind kind, int n)
        {
            var mig = Activator.CreateInstance<Mig>(sp);
            mig.Step(1);
            var r = Naming.TV.SeriesResolver.Resolve("p");
            var x = kind is Kind.A ? Pick(n) : 0;
        }
        static int Pick(int n) => n;
    }
    public enum Kind { A, B }
}
` },
  ];
  const ix = createCsharpSyntacticIndex(sources, { root: '/r' });
  const ask = (rel, key) => {
    const d = ix.byFile.get(`/r/${rel}`).defs.find((x) => x.key === key);
    const a = ix.callersOfWithStatus({ file: `/r/${rel}`, name: d.name, pos: d.namePos });
    return { n: a.callers.length, complete: !a.incompleteReason && !ix.unresolvedCallsTo({ name: d.name }) };
  };
  // `Activator.CreateInstance<Mig>(…)` is outside: `mig` is not typed, so `Step` is not complete.
  assert.deepEqual(ask('Emby.Server/Mig.cs', 'Mig.Step(int)'), { n: 0, complete: false });
  // `Naming` inside `Emby.Server.Run` is `Emby.Naming`.
  assert.deepEqual(ask('Emby.Naming/TV/SeriesResolver.cs', 'SeriesResolver.Resolve(string)'), { n: 1, complete: true });
  // `kind is Kind.A ? Pick(n) : 0`: `Pick` is a call, not a pattern variable.
  assert.deepEqual(ask('Emby.Server/Run.cs', 'Runner.Pick(int)'), { n: 1, complete: true });
});
