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
  // C8b (C-D5): the implementation lists the interface member's calls, labelled, and stays incomplete.
  const get = callersOf('Lib/Repo.cs', 'Repo.Get(int)');
  assert.deepEqual(get.rows, ['Service.A(Repo, object): _irepo.Get(1).Touch();']);
  assert.match(get.reason, /implements `IRepo.Get`: calls through it are listed as "through `IRepo`" and may also reach implementations outside the indexed files/);
  const d = idx.byFile.get('/r/Lib/Repo.cs').defs.find((x) => x.key === 'Repo.Get(int)');
  const row = idx.callersOfWithStatus({ file: d.file.file, name: d.name, pos: d.namePos }).callers[0];
  assert.deepEqual([row.via, row.text], ['interface', 'through IRepo']);
});

test('an outside base marks public instance methods incomplete (C-D5)', () => {
  const act = callersOf('App/Helpers.cs', 'Controller.Act()');
  assert.match(act.reason, /through `ControllerBase`, which is not in the indexed files/);
  assert.ok(idx.undeclaredBase.size >= 1);
});

test('extension methods: the static form is listed; on an outside receiver (`string`) the receiver form stays unresolved', () => {
  const shout = callersOf('App/Helpers.cs', 'Helpers.Shout(this string)');
  assert.deepEqual(shout.rows, ['Controller.Act(): public void Act() { "a".Shout(); Helpers.Shout("b"); }']);
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

test('verify-run fixes: an outside base may hold the overload, overloads differing in generic arguments, interpolation holes, await', () => {
  const sources = [{ path: 'A.cs', text: `namespace N;
public class Base : ControllerBase
{
    protected IActionResult Ok<T>(IEnumerable<T>? items) => null;
    protected void Note(string s) { }
}
public class Api : Base
{
    private readonly Svc _svc;
    public async Task Get(object o, string s)
    {
        Ok(o);
        Note(s);
        var dto = await _svc.LoadAsync().ConfigureAwait(false);
        dto.Touch();
        var msg = $"size {s}{Size(3)} and {Size(4):N0}";
    }
    private static string Size(long n) => "";
}
public class Svc { public Task<Dto> LoadAsync() => null; }
public class Dto { public void Touch() { } }
public static class Find
{
    public static A? Best(IReadOnlyList<A>? r, int y) => null;
    public static B? Best(IReadOnlyList<B>? r, int y) => null;
    public static void Use(object rs) { Best(rs, 1); }
}
public class A { } public class B { }
` }];
  const ix = createCsharpSyntacticIndex(sources, { root: '/r' });
  const ask = (key) => {
    const d = ix.byFile.get('/r/A.cs').defs.find((x) => x.key === key);
    assert.ok(d, key);
    const a = ix.callersOfWithStatus({ file: '/r/A.cs', name: d.name, pos: d.namePos });
    return { n: a.callers.reduce((m, c) => m + c.callSites.length, 0), reason: a.incompleteReason, unresolved: ix.unresolvedCallsTo({ name: d.name }) };
  };
  // `Ok(o)`: `o` is not surely an IEnumerable, so ControllerBase.Ok(object) may be the one called.
  assert.deepEqual([ask('Base.Ok<1>(IEnumerable?)').n, ask('Base.Ok<1>(IEnumerable?)').unresolved], [0, 1]);
  // `Note(s)`: a string surely fits, so it is listed.
  assert.equal(ask('Base.Note(string)').n, 1);
  assert.equal(ask('Dto.Touch()').n, 1);
  assert.equal(ask('Api.Size(long)').n, 2);
  const best1 = ask('Find.Best(IReadOnlyList?, int)');
  const best2 = ask('Find.Best(IReadOnlyList?, int)#2');
  assert.deepEqual([best1.n, best2.n], [1, 1]);
  assert.match(best2.reason, /several overloads with the same number of arguments/);
});

// ---- the C8a review's blockers (REVIEW-C8a B1–B6): never a wrong caller, never complete while one is missed ----

/** The answer for the member keyed `key` over in-memory `files` ({ path: text }): caller labels, reason, unresolved count, complete. */
function answerFor(files, key, opts = {}) {
  const ix = createCsharpSyntacticIndex(Object.entries(files).map(([p, text]) => ({ path: p, text })), { root: '/r', ...opts });
  for (const rec of ix.byFile.values()) {
    const d = rec.defs.find((x) => x.key === key);
    if (!d) continue;
    const a = ix.callersOfWithStatus({ file: rec.file, name: d.name, pos: d.namePos });
    const unresolved = ix.unresolvedCallsTo({ name: d.name });
    return { callers: a.callers.map((c) => c.label).sort(), reason: a.incompleteReason || '', unresolved, complete: !a.incompleteReason && !unresolved };
  }
  throw new Error(`no member keyed ${key}`);
}

test('B1: a file that was not indexed (unreadable as C#, over 1 MiB, left out by the caller) makes the answer incomplete', () => {
  const a = 'namespace N; sealed class C { internal static void M() { } static void K() { M(); } }';
  const bad = answerFor({ 'a.cs': a, 'bad.cs': 'namespace N; sealed class Bad { void R() { C.M(); }\n#if X\n }' }, 'C.M()');
  assert.deepEqual([bad.callers, bad.complete, bad.unresolved], [['C.K()'], false, 1]);
  assert.match(bad.reason, /1 use\(s\) of the name `M` in C# file\(s\) that were not indexed/);
  const big = answerFor({ 'a.cs': a, 'big.cs': `namespace N; sealed class Big { void R() { C.M(); } } //${'x'.repeat(1024 * 1024 + 5)}` }, 'C.M()');
  assert.equal(big.complete, false);
  assert.match(big.reason, /not indexed \(over 1 MiB/);
  const left = answerFor({ 'a.cs': a }, 'C.M()', { notIndexed: 7 });
  assert.equal(left.complete, false);
  assert.match(left.reason, /7 C# file\(s\) could not be read/);
  // A name the skipped file does not use stays complete.
  assert.equal(answerFor({ 'a.cs': a, 'bad.cs': 'namespace N; sealed class Bad { void R() { C.Other(); }\n#if X\n }' }, 'C.M()').complete, true);
});

test('B2: a call under an inactive `#if` branch makes the answer incomplete, with its own reason', () => {
  const r = answerFor({ 'a.cs': `namespace N; public static class C { internal static void M() { } static void K() { M(); }
#if DEBUG
  static void Dbg() { M(); }
#endif
}` }, 'C.M()');
  assert.deepEqual([r.callers, r.complete, r.unresolved], [['C.K()'], false, 1]);
  assert.match(r.reason, /1 use\(s\) of the name `M` in code under an inactive `#if` branch/);
});

test('B3: `var x = new T(…).Chain()` types x by the chain, not as T; `var y = (x).M()` is not a cast', () => {
  const files = { 'a.cs': `namespace N; public sealed class Client { internal void Send() { } internal void Close() { } }
public sealed class Builder { internal Client Build() => new Client(); internal void Close() { } }
sealed class U { void R() { var c = new Builder().Build(); c.Send(); c.Close(); var b = new Builder() { }; b.Close(); } }` };
  assert.deepEqual(answerFor(files, 'Client.Close()').callers, ['U.R()']);
  assert.deepEqual(answerFor(files, 'Client.Send()').callers, ['U.R()']);
  const builderClose = answerFor(files, 'Builder.Close()');
  assert.deepEqual([builderClose.callers, builderClose.complete], [['U.R()'], true]); // `b.Close()` only
  const paren = { 'a.cs': `namespace N; public sealed class x { internal void Z() { } }
public sealed class Y { internal Y Get() => null; internal void Z() { } }
sealed class U { void R(Y x) { var y = (x).Get(); y.Z(); } void S(object o) { var z = (x)o; z.Z(); } }` };
  assert.deepEqual(answerFor(paren, 'x.Z()').callers, ['U.S(object)']);
  assert.equal(answerFor(paren, 'Y.Z()').complete, false);
});

test('B4: an implementation the index cannot match by key text is incomplete (inherited, generic, spelled differently)', () => {
  const inherited = answerFor({ 'a.cs': `namespace N;
public interface IFoo { void M(); }
public class B { public void M() { } }
public class D : B, IFoo { }
public class U { void Run(IFoo f) { f.M(); } void Direct(B b) { b.M(); } }` }, 'B.M()');
  assert.deepEqual([inherited.callers, inherited.complete], [['U.Direct(B)', 'U.Run(IFoo)'], false]);
  assert.match(inherited.reason, /implements `IFoo.M`: calls through it are listed/);
  const generic = answerFor({ 'a.cs': `namespace N; public sealed class User { }
public interface IHandler<T> { void Handle(T item); }
public sealed class UserHandler : IHandler<User> { public void Handle(User u) { } }
sealed class Svc { void R(UserHandler c) { c.Handle(null); } }` }, 'UserHandler.Handle(User)');
  assert.equal(generic.complete, false);
  assert.match(generic.reason, /implements `IHandler.Handle`/);
  const spelled = answerFor({ 'a.cs': `namespace N; public interface IX { void Put(System.String s, int? n); void Go(params int[] a); }
public sealed class X : IX { public void Put(string s, System.Nullable<int> n) { } public void Go(int[] a) { } }
sealed class Svc { void R(X c) { c.Put("a", 1); c.Go(null); } }` }, 'X.Put(string, Nullable)');
  assert.equal(spelled.complete, false);
  assert.match(spelled.reason, /implements `IX.Put`/);
  // A derived type's outside interface may be implemented by the inherited public method.
  const outside = answerFor({ 'a.cs': `namespace N; public class B { public void Dispose() { } } public class D : B, IDisposable { }
sealed class U { void R(B b) { b.Dispose(); } }` }, 'B.Dispose()');
  assert.equal(outside.complete, false);
  assert.match(outside.reason, /`IDisposable` \(of `D`\), not in the indexed files/);
});

test('B5: a member inherited from an outside base hides an indexed type of the same name', () => {
  const r = answerFor({ 'User.cs': 'namespace App.Models; public class User { public bool IsInRole(string r) => true; public static User Make() => null; }',
    'C.cs': `using App.Models; using Microsoft.AspNetCore.Mvc; namespace App.Controllers;
public class HomeController : ControllerBase { public bool Get() { return User.IsInRole("admin"); } public object New() => User.Make(); }
public class Other { void X(User u) { u.IsInRole("a"); } }` }, 'User.IsInRole(string)');
  assert.deepEqual([r.callers, r.complete, r.unresolved], [['Other.X(User)'], false, 1]);
  // A static method of the type is still meant.
  const s = answerFor({ 'User.cs': 'namespace App.Models; public class User { public static User Make() => null; }',
    'C.cs': 'using App.Models; namespace App.Controllers; public class HomeController : ControllerBase { public object New() => User.Make(); }' }, 'User.Make()');
  assert.deepEqual(s.callers, ['HomeController.New()']);
  // A type written as a receiver never reaches an instance method.
  const inst = answerFor({ 'a.cs': 'namespace N; public sealed class Job { internal void Run() { } } sealed class U { void R() { Job.Run(); } }' }, 'Job.Run()');
  assert.deepEqual([inst.callers, inst.complete], [[], false]);
});

test('B6: a method group in any position is a value use (return, named argument, conditional, initializer, collection expression)', () => {
  const files = { 'a.cs': `using System; namespace N;
public class C {
  static void A() { } static void B2() { } static void C3() { } static void D4() { } static void F6() { }
  Action Get() { return A; }
  void Use(bool c) { Reg(handler: B2); Action x = c ? C3 : null; var l = new Action[] { D4 }; Action[] z = [F6]; A(); B2(); C3(); D4(); F6(); }
  void Reg(Action handler) { }
}` };
  for (const key of ['C.A()', 'C.B2()', 'C.C3()', 'C.D4()', 'C.F6()']) {
    const r = answerFor(files, key);
    assert.deepEqual([key, r.callers, r.complete], [key, ['C.Use(bool)'], false]);
    assert.match(r.reason, /used as a method group 1 time\(s\)/);
  }
  // A local or a parameter of a method's name is not the method.
  const local = answerFor({ 'a.cs': 'namespace N; sealed class C { static void A() { } void U(int A) { var y = A; } void V() { int A = 1; Use(A); } void W() { A(); } static void Use(int a) { } }' }, 'C.A()');
  assert.deepEqual([local.callers, local.complete], [['C.W()'], true]);
});

// ---- the C8a review's should-fix S1, S2, S3, S7: project scope, pattern locals, names not placed ----

const TWO_PROJECTS = { projects: ['p1/p1.csproj', 'p2/p2.csproj'] };

test('S1: `global using`, global aliases, `global using static` and implicit usings hold in their own project only', () => {
  const files = {
    'p1/G.cs': 'global using App.Models; global using F = App.Models.File; global using static App.Models.Helpers;',
    'p1/M.cs': 'namespace App.Models; public static class File { public static bool Exists(string p) => true; } public static class Helpers { public static void Go() { } }',
    'p1/V.cs': 'namespace X; sealed class V { bool R() => File.Exists("y"); void S() { Go(); } }',
    'p2/U.cs': 'using System.IO; namespace Other; sealed class U { bool R() { return File.Exists("x"); } bool A() => F.Exists("z"); void S() { Go(); } }',
  };
  const exists = answerFor(files, 'File.Exists(string)', TWO_PROJECTS);
  assert.deepEqual([exists.callers, exists.complete], [['V.R()'], true]);
  const go = answerFor(files, 'Helpers.Go()', TWO_PROJECTS);
  assert.deepEqual([go.callers, go.complete], [['V.S()'], true]);
  // Implicit usings by project directory.
  const implicit = {
    'p1/M.cs': 'namespace App.Models; public static class File { public static bool Exists(string p) => true; }',
    'p1/V.cs': 'namespace X; sealed class V { bool R() => File.Exists("y"); }',
    'p2/U.cs': 'namespace Other; sealed class U { bool R() => File.Exists("x"); }',
  };
  const byProject = answerFor(implicit, 'File.Exists(string)', { ...TWO_PROJECTS, projectUsings: { p1: ['App.Models'], p2: ['System.IO'] } });
  assert.deepEqual([byProject.callers, byProject.complete], [['V.R()'], true]);
  // Without projects every file is of one project (the preview's single set, never complete).
  assert.deepEqual(answerFor(files, 'File.Exists(string)').callers, ['U.A()', 'U.R()', 'V.R()']);
  assert.equal(answerFor(files, 'File.Exists(string)', { partial: true }).complete, false);
});

test('S2: types of one namespace and name in two projects are two types; a name resolves in its own project first', () => {
  const startup = answerFor({
    'p1/Startup.cs': 'namespace App; public class Startup { public void Configure(int a) { } }',
    'p2/Startup.cs': 'namespace App; public class Startup { public void Init() { Configure(1); } }',
  }, 'Startup.Configure(int)', TWO_PROJECTS);
  assert.deepEqual(startup.callers, []);
  const files = {
    'p1/Helper.cs': 'namespace App; static class Helper { public static void Do() { } } class U1 { void R() { Helper.Do(); } }',
    'p2/Helper.cs': 'namespace App; static class Helper { public static void Do() { } } class U2 { void R() { Helper.Do(); } }',
  };
  const ask = (/** @type {object} */ opts) => {
    const ix = createCsharpSyntacticIndex(Object.entries(files).map(([p, text]) => ({ path: p, text })), { root: '/r', ...opts });
    return [...ix.byFile.values()].filter((rec) => rec.defs.some((x) => x.key === 'Helper.Do()')).map((rec) => {
      const d = rec.defs.find((x) => x.key === 'Helper.Do()');
      const a = ix.callersOfWithStatus({ file: rec.file, name: d.name, pos: d.namePos });
      return [rec.rel, a.callers.map((c) => c.label), !a.incompleteReason && !ix.unresolvedCallsTo({ name: 'Do' })];
    });
  };
  assert.deepEqual(ask(TWO_PROJECTS), [['p1/Helper.cs', ['U1.R()'], true], ['p2/Helper.cs', ['U2.R()'], true]]);
  // A third project that sees both cannot tell: unresolved, so neither answer is complete.
  files['p3/U3.cs'] = 'namespace App; class U3 { void R() { Helper.Do(); } }';
  assert.deepEqual(ask({ projects: [...TWO_PROJECTS.projects, 'p3/p3.csproj'] }).map((r) => r[2]), [false, false]);
  delete files['p3/U3.cs'];
  // No projects known: two non-`partial` types of one key are ambiguous, never merged.
  assert.deepEqual(ask({}).map((r) => [r[1], r[2]]), [[[], false], [[], false]]);
  // `partial` parts of two projects do not merge either.
  const parts = answerFor({
    'p1/P.cs': 'namespace App; public sealed partial class P { internal void A() { } }',
    'p2/P.cs': 'namespace App; public sealed partial class P { void B() { A(); } }',
  }, 'P.A()', TWO_PROJECTS);
  assert.deepEqual(parts.callers, []);
});

test('S3: locals declared by patterns, switch arms, `case`, LINQ and further declarators shadow a field of the name', () => {
  const head = 'namespace N; sealed class Bar { internal void M() { } } sealed class Foo { internal void M() { } }\n';
  /** @param {string} body Members of `U`, which has a field `item` of type Bar. */
  const both = (body) => {
    const files = { 'a.cs': `${head}sealed class U { Bar item; ${body} }` };
    return { bar: answerFor(files, 'Bar.M()'), foo: answerFor(files, 'Foo.M()') };
  };
  // Typed forms: the call reaches Foo.M, never Bar.M.
  for (const body of [
    'void R(object o) { switch (o) { case Foo item: item.M(); break; } }',
    'void R(object o) { switch (o) { case Foo item when item != null: item.M(); break; } }',
    'int R(object o) => o switch { Foo item => Do(() => item.M()), _ => 0 }; int Do(System.Action a) => 0;',
    'void R(object o) { if (o is Foo { } item) item.M(); }',
    'void R(object o) { if (o is Foo(var a) item) item.M(); }',
    'void R(object o) { if (o is string and Foo item) item.M(); }',
    'void R(object o) { switch (o) { case 1: Foo item = null; item.M(); break; } }',
    'void R() { Foo a = null, item = null; item.M(); }',
    'void R(System.Collections.Generic.List<Foo> xs) { var q = from Foo item in xs select Wrap(() => item.M()); } int Wrap(System.Action a) => 0;',
  ]) {
    const r = both(body);
    assert.deepEqual([body, r.bar.callers, r.foo.callers.length], [body, [], 1]);
  }
  // Untyped forms: unresolved, so Bar.M is incomplete and lists nothing.
  for (const body of [
    'void R(object o) { if (o is var item) item.M(); }',
    'void R(object o) { if (o is { } item) item.M(); }',
    'int R(object o) => o switch { var item => Do(() => item.M()) }; int Do(System.Action a) => 0;',
    'void R(System.Collections.Generic.List<Foo> xs) { var q = from item in xs select Wrap(() => item.M()); } int Wrap(System.Action a) => 0;',
    'void R(System.Collections.Generic.List<Foo> xs) { var q = from x in xs let item = x select Wrap(() => item.M()); } int Wrap(System.Action a) => 0;',
    'void R(System.Collections.Generic.List<Foo> xs, System.Collections.Generic.List<Foo> ys) { var q = from x in xs join item in ys on x equals item select Wrap(() => item.M()); } int Wrap(System.Action a) => 0;',
    'void R(System.Collections.Generic.List<Foo> xs) { var q = from x in xs group x by x into item select Wrap(() => item.M()); } int Wrap(System.Action a) => 0;',
    'void R(System.Collections.Generic.List<Foo> xs) { xs.ForEach(async item => item.M()); }',
  ]) {
    const r = both(body);
    assert.deepEqual([body, r.bar.callers, r.bar.complete], [body, [], false]);
  }
  // The field itself still types the name where no local hides it.
  assert.deepEqual(both('void R() { item.M(); }').bar.callers, ['U.R()']);
  // A parameter list or a tuple is not a declarator list: `F(out Foo a, item)` keeps the field.
  assert.deepEqual(both('void R() { F(out Foo a, item); item.M(); } static void F(out Foo a, Bar b) { a = null; }').bar.callers, ['U.R()']);
});

test('S7: a name the index cannot place is unresolved, not outside', () => {
  // A member imported by `using static`: typed through the indexed type; unknown through an outside one.
  const hub = 'namespace N; public sealed class Svc { internal void M() { } } public static class Hub { public static Svc Instance { get; } = new Svc(); }';
  const typed = answerFor({ 'a.cs': hub, 'b.cs': 'using static N.Hub; namespace Z; sealed class U { void R() { Instance.M(); } }' }, 'Svc.M()');
  assert.deepEqual([typed.callers, typed.complete], [['U.R()'], true]);
  const outside = answerFor({ 'a.cs': hub, 'b.cs': 'using static Lib.Hub; namespace Z; sealed class U { void R() { Instance.M(); } }' }, 'Svc.M()');
  assert.deepEqual([outside.callers, outside.complete], [[], false]);
  // A nested type named through a derived type, through `using static`.
  const inherited = answerFor({ 'a.cs': 'namespace N; public class B { public sealed class Inner { internal void M() { } } } public class D : B { } sealed class U { void R(D.Inner i) { i.M(); } }' }, 'B.Inner.M()');
  assert.deepEqual([inherited.callers, inherited.complete], [['U.R(Inner)'], true]);
  const viaStatic = answerFor({ 'm.cs': 'namespace L; public static class Outer { public sealed class Inner { internal void M() { } } }',
    'u.cs': 'using static L.Outer; namespace App; sealed class U { void R(Inner f) { f.M(); } }' }, 'Outer.Inner.M()');
  assert.deepEqual([viaStatic.callers, viaStatic.complete], [['U.R(Inner)'], true]);
  // A nested name an indexed type does not declare (an outside base's): not placed.
  const notFound = answerFor({ 'a.cs': 'namespace N; public sealed class Foo { internal void M() { } } public class D : Outside { } sealed class U { void R(D.Foo f) { f.M(); } }' }, 'Foo.M()');
  assert.deepEqual([notFound.callers, notFound.complete], [[], false]);
  // An alias declared in a namespace block, relative to it.
  const relative = answerFor({ 'm.cs': 'namespace App.Models { public sealed class Foo { internal void M() { } } }',
    'u.cs': 'namespace App { using F = Models.Foo; sealed class U { void R(F f) { f.M(); } } }' }, 'Foo.M()');
  assert.deepEqual([relative.callers, relative.complete], [['U.R(F)'], true]);
  // A `using` in a namespace block binds before the enclosing namespaces' types.
  const files = { 'x.cs': 'namespace X { public sealed class Foo { internal void M() { } } } namespace N1 { public sealed class Foo { internal void M() { } } }',
    'u.cs': 'namespace N1.N2 { using X; sealed class U { void R(Foo f) { f.M(); } } }' };
  assert.deepEqual(answerFor(files, 'Foo.M()').callers, ['U.R(Foo)']);
  assert.deepEqual(answerFor(files, 'Foo.M()#2').callers, []);
  // A capitalised name that is nothing the index declares, with no `using static`, stays outside.
  const bcl = answerFor({ 'a.cs': 'namespace N; public sealed class Foo { internal static void Exists() { } } sealed class U { void R() { Console.Exists(); } }' }, 'Foo.Exists()');
  assert.deepEqual([bcl.callers, bcl.complete], [[], true]);
});

test('S8: parameters typed `Foo?`, `G<int>`, `global::N.Foo` are typed receivers', () => {
  const files = { 'a.cs': `namespace N; public sealed class Foo { public void A() { } public void B() { } public void E() { } }
public sealed class G<T> { public void Z() { } }
sealed class U { void R(Foo a, Foo? b, G<int> g, global::N.Foo e) { a.A(); b.B(); g.Z(); e.E(); } }` };
  for (const key of ['Foo.A()', 'Foo.B()', 'G<1>.Z()', 'Foo.E()']) assert.deepEqual(answerFor(files, key), { callers: ['U.R(Foo, Foo?, G, Foo)'], reason: '', unresolved: 0, complete: true }, key);
});

test('nits: an outside first base named like `IOException` is a class; an indexed extension of the name keeps an unsure instance call unresolved', () => {
  const io = answerFor({ 'a.cs': `namespace N; public class MyError : IOException { public void Log(object o) { } }
sealed class U { void R(MyError e) { e.Log(Path.GetTempPath()); } }` }, 'MyError.Log(object)');
  // An argument of a type not known: `IOException` may declare an overload that wins, so the call is not listed.
  assert.deepEqual([io.callers, io.complete], [[], false]);
  const ext = answerFor({ 'a.cs': `namespace N; public sealed class C { public void Put(C other) { } }
public static class Ext { public static void Put(this C c, string s) { } }
sealed class U { void R(C c, object x) { c.Put(x); c.Put(c); } }` }, 'C.Put(C)');
  assert.deepEqual([ext.callers, ext.unresolved], [['U.R(C, object)'], 1]);
});

/** Rows `label [text]` of the member keyed `key` (C8b labels). */
function labelled(files, key) {
  const ix = createCsharpSyntacticIndex(Object.entries(files).map(([p, text]) => ({ path: p, text })), { root: '/r' });
  for (const rec of ix.byFile.values()) {
    const d = rec.defs.find((x) => x.key === key);
    if (!d) continue;
    const a = ix.callersOfWithStatus({ file: rec.file, name: d.name, pos: d.namePos });
    return { rows: a.callers.map((c) => `${c.label}${c.via ? ` [${c.via}: ${c.text}]` : ''} x${c.callSites.length}`).sort(), reason: a.incompleteReason || '' };
  }
  throw new Error(`no member keyed ${key}`);
}

test('C-D5: calls through an interface are listed on the implementation, labelled; transitive, generic arguments checked', () => {
  const files = { 'a.cs': `namespace N; public sealed class User { } public sealed class Other { }
public interface IHandler<T> { void Handle(T item); }
public interface IUserHandler : IHandler<User> { }
public sealed class UserHandler : IUserHandler { public void Handle(User u) { } }
public sealed class OtherHandler : IHandler<Other> { public void Handle(Other o) { } }
sealed class Svc
{
    private readonly IHandler<User> _h;
    void A(IHandler<Other> o, IUserHandler u, UserHandler d) { _h.Handle(null); o.Handle(null); u.Handle(null); }
    void B(UserHandler d, IUserHandler u) { d.Handle(null); u.Handle(null); }
    void C<T>(IHandler<T> any) { any.Handle(default); }
}` };
  const r = labelled(files, 'UserHandler.Handle(User)');
  assert.deepEqual(r.rows, ['Svc.A(IHandler, IUserHandler, UserHandler) [interface: through IHandler] x2', 'Svc.B(UserHandler, IUserHandler) x2', 'Svc.C<1>(IHandler) [interface: through IHandler] x1']);
  assert.match(r.reason, /may also reach 1 other implementation\(s\) in the indexed files/);
  assert.match(r.reason, /1 call\(s\) through a generic interface whose type arguments are not known or differ/);
  assert.deepEqual(labelled(files, 'OtherHandler.Handle(Other)').rows, ['Svc.A(IHandler, IUserHandler, UserHandler) [interface: through IHandler] x1', 'Svc.C<1>(IHandler) [interface: through IHandler] x1']);
});

test('C-D5: an explicit implementation, another overload or a hiding class is not labelled; overrides list calls written on the base', () => {
  const files = { 'a.cs': `namespace N;
public interface IFoo { void M(int a); }
public class Impl : IFoo { public void M(string s) { } void IFoo.M(int a) { } }
public abstract class Base { public virtual void Run() { } public void Template() { Run(); } }
public class Leaf : Base { public override void Run() { base.Run(); } }
public class Sibling : Base { }
sealed class U { void R(IFoo f, Base b, Sibling s, Leaf l) { f.M(1); b.Run(); s.Run(); l.Run(); } }` };
  assert.deepEqual(labelled(files, 'Impl.M(string)').rows, []);
  const leaf = labelled(files, 'Leaf.Run()');
  assert.deepEqual(leaf.rows, ['Base.Template() [override: through Base] x1', 'U.R(IFoo, Base, Sibling, Leaf) x2']);
  assert.match(leaf.reason, /an override of `Base.Run`: calls written on that type are listed/);
});

test('C8b extension methods: `x.M()` by the `this` type and the namespaces in scope; undecided ones stay unresolved', () => {
  const files = {
    'ext.cs': `namespace Lib.Ext;
public static class FooExt { public static void Go(this N.Foo f, int n) { } public static void Any<T>(this T x) { } public static void Seq(this IEnumerable<int> xs) { } }`,
    'a.cs': `using Lib.Ext;
namespace N;
public class Foo { } public sealed class Bar : Foo { }
sealed class U { void R(Foo f, Bar b, List<int> xs) { f.Go(1); b.Go(2); f.Any(); xs.Seq(); FooExt.Go(f, 3); } }`,
    'b.cs': `namespace M; sealed class V { void R(N.Foo f) { f.Go(1); } }`,
  };
  const go = answerFor(files, 'FooExt.Go(this Foo, int)');
  assert.deepEqual([go.callers, go.unresolved, go.complete], [['U.R(Foo, Bar, List)'], 0, true]);
  const any = answerFor(files, 'FooExt.Any<1>(this T)');
  assert.equal(any.unresolved, 1);
  const seq = answerFor(files, 'FooExt.Seq(this IEnumerable)');
  assert.deepEqual([seq.callers, seq.unresolved], [[], 1]);
  const ix = createCsharpSyntacticIndex(Object.entries(files).map(([p, text]) => ({ path: p, text })), { root: '/r' });
  const d = ix.byFile.get('/r/ext.cs').defs.find((x) => x.key === 'FooExt.Go(this Foo, int)');
  assert.equal(ix.callersOfWithStatus({ file: '/r/ext.cs', name: 'Go', pos: d.namePos }).callers[0].callSites.length, 3);
});

test('C8b: a generic method that cannot infer its type parameter is not called without type arguments; a call matching several interface overloads is not labelled', () => {
  const files = { 'a.cs': `namespace N;
public interface IL { T Get<T>(System.Guid id); object Get(System.Guid id); void Put(string s); void Put(object o); }
public sealed class L : IL { public T Get<T>(System.Guid id) => default; public object Get(System.Guid id) => null; public void Put(string s) { } public void Put(object o) { } }
sealed class U { void R(IL l, System.Guid g) { l.Get(g); l.Get<int>(g); l.Put(null); } }` };
  assert.deepEqual(labelled(files, 'L.Get(Guid)').rows, ['U.R(IL, Guid) [interface: through IL] x1']);
  assert.deepEqual(labelled(files, 'L.Get<1>(Guid)').rows, ['U.R(IL, Guid) [interface: through IL] x1']);
  const put = labelled(files, 'L.Put(string)');
  assert.deepEqual(put.rows, []);
  assert.match(put.reason, /1 call\(s\) through an interface or a base type that match several overloads are not listed/);
  assert.doesNotMatch(put.reason, /may implement a member/);
});
