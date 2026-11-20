'use strict';
// C# entry points (src/engine/entry-points-csharp.js, C-D7) and their walk rules in
// src/engine/impact-paths.js (app-start, MediatR), from small texts shaped after eShop and
// jellyfin. The real repositories are checked by test/lsp-harness/entry-census.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { declarationEntry, callSiteEntry, entryLanguageOf, unreachableReason } = require('../src/engine/entry-points');
const { impactPathsFor } = require('../src/engine/impact-paths');
const { blank } = require('../src/languages/csharp/lexer');

const at = (text, needle, from = 0) => { const i = text.indexOf(needle, from); assert.ok(i >= 0, needle); return i; };
const decl = (text, name, relPath = 'src/X.cs', facts) => declarationEntry({
  language: 'csharp', text, blanked: blank(text), pos: at(text, name), label: name, relPath, facts,
});
const site = (text, callerName, call, relPath = 'src/X.cs') => callSiteEntry({
  language: 'csharp', text, blanked: blank(text), callerPos: at(text, callerName), callSiteStart: at(text, call), relPath, callerLabel: callerName,
});

test('language of a .cs file', () => {
  assert.equal(entryLanguageOf('/r/A.cs'), 'csharp');
  assert.equal(entryLanguageOf('/r/A.csproj'), null);
});

// A jellyfin-style controller.
const controller = `using Microsoft.AspNetCore.Mvc;
// [HttpGet("commented")] public IActionResult Ghost() {}
[Route("Items")]
[Authorize]
public class ItemsController : BaseJellyfinApiController
{
    private readonly int _x;
    public ItemsController(int x) { _x = x; }

    /// <summary>docs [HttpGet("doc")]</summary>
    [HttpGet("{itemId}/Images")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<int> GetImages([FromRoute] Guid itemId) => Ok(1);

    [HttpPost("Create"), HttpPut("Update")]
    public ActionResult Both() => Ok();

    [HttpGet]
    public ActionResult Root() => Ok();

    [HttpGet("/Absolute/{id}")] public ActionResult Abs() => Ok();
    [HttpGet("~/Tilde")] public ActionResult Tilde() => Ok();
    [HttpGet("[action]/x")] public ActionResult Tok() => Ok();
    [HttpGet("{id:int:min(1)}")] public ActionResult Constrained(int id) => Ok();
    [AcceptVerbs("GET", "POST", Route = "Multi")] public ActionResult Verbs() => Ok();
    [Route("Own")] public ActionResult RouteOnly() => Ok();
    [HttpGet] [Route("Own2")] public ActionResult RouteAndVerb() => Ok();
    [HttpGet("Skip")] [NonAction] public ActionResult Hidden() => Ok();
    [HttpGet("S")] public static ActionResult StaticOne() => null;
    [HttpGet("P")] private ActionResult PrivateOne() => null;
    public ActionResult Plain() => Ok();
    public int Prop { get; set; }
}
`;

test('controller: class [Route] plus action template, verbs, and the route rules one by one', () => {
  const e = (n) => decl(controller, n);
  assert.deepEqual(e('GetImages('), { type: 'http', name: 'GET /Items/{itemId}/Images', method: 'GET', route: '/Items/{itemId}/Images', how: 'ItemsController action with an HTTP attribute' });
  // several [Http*] on one method
  const both = e('Both()');
  assert.equal(both.name, 'POST /Items/Create, PUT /Items/Update');
  assert.equal(both.method, 'POST|PUT');
  assert.equal(e('Root()').name, 'GET /Items');
  assert.equal(e('Abs()').name, 'GET /Absolute/{id}');        // leading / overrides the class route
  assert.equal(e('Tilde()').name, 'GET /Tilde');              // ~/ overrides it too
  assert.equal(e('Tok()').name, 'GET /Items/Tok/x');          // [action] filled
  assert.equal(e('Constrained(').name, 'GET /Items/{id:int:min(1)}');   // constraints kept
  assert.equal(e('Verbs()').name, 'GET /Items/Multi, POST /Items/Multi');
  assert.equal(e('RouteOnly()').name, 'ALL /Items/Own');      // [Route] on the action alone: any verb
  assert.equal(e('RouteAndVerb()').name, 'GET /Items/Own2');  // [HttpGet] takes the action's [Route]
  assert.equal(e('Plain()').name, 'ALL /Items');              // any public method of a controller
  // not actions
  assert.equal(e('Hidden()'), null);
  assert.equal(e('StaticOne()'), null);
  assert.equal(e('PrivateOne()'), null);
  assert.equal(e('Prop'), null);
  assert.equal(decl(controller, 'ItemsController(int'), null);   // the constructor
  assert.equal(decl(controller, 'Ghost'), null);                  // the comment is blanked
});

test('controller: [controller] token, suffix stripped; [ApiController] and base-class forms; not other classes', () => {
  const text = '[ApiController]\n[Route("api/[controller]")]\npublic class OrdersController : ControllerBase\n{\n  [HttpGet("{id}")] public IActionResult Get(int id) => Ok();\n}\n'
    + 'public class Helper\n{\n  [HttpGet("x")] public void NotAnAction() {}\n}\n'
    + 'public class Widget : ISessionController\n{\n  public void Send() {}\n}\n'
    + '[ApiController]\npublic class Plain\n{\n  [HttpDelete("{id}")] public IActionResult Remove(int id) => Ok();\n}\n';
  assert.equal(decl(text, 'Get(int').name, 'GET /api/Orders/{id}');
  assert.equal(decl(text, 'NotAnAction('), null);
  assert.equal(decl(text, 'Send('), null);            // an I… interface name is no controller base
  assert.equal(decl(text, 'Remove').name, 'DELETE /{id}');   // [ApiController] alone: the action template only
});

test('controller: a [Route] inherited from the base class comes from the facts, "<inherited>" without them', () => {
  const text = 'public class GenresController : BaseJellyfinApiController\n{\n  [HttpGet] public int Get() => 1;\n  [HttpGet("{name}")] public int One(string name) => 1;\n}\n';
  assert.equal(decl(text, 'Get(').name, 'GET /<inherited>');
  assert.equal(decl(text, 'One(').name, 'GET /<inherited>/{name}');
  const facts = { csControllerRoutes: new Map([['BaseJellyfinApiController', { route: '[controller]', base: 'ControllerBase' }]]) };
  assert.equal(decl(text, 'Get(', 'a/GenresController.cs', facts).name, 'GET /Genres');
  assert.equal(decl(text, 'One(', 'a/GenresController.cs', facts).name, 'GET /Genres/{name}');
});

test('controller: conventionally routed actions (no attribute route) show /{Controller}/{Action}, said so', () => {
  // eShop Identity.API: `AccountController : Controller`, mapped by app.MapDefaultControllerRoute().
  const text = `using Microsoft.AspNetCore.Mvc;
namespace IdentityServerHost.Quickstart.UI
{
    [SecurityHeaders]
    [AllowAnonymous]
    public class AccountController : Controller
    {
        [HttpGet]
        public async Task<IActionResult> Login(string returnUrl) => View();
        [HttpPost]
        [ValidateAntiForgeryToken]
        public async Task<IActionResult> Login(LoginInputModel model, string button) => View();
        public IActionResult AccessDenied() => View();
        [ActionName("Out")] public IActionResult SignOut() => View();
        public Task<IActionResult> LogoutAsync() => null;
        [HttpGet("attr/{id}")] public IActionResult Attr(int id) => View();
    }
}
`;
  const login = decl(text, 'Login(string');
  assert.equal(login.name, 'GET /Account/Login');
  assert.match(login.how, /conventional route \(MapDefaultControllerRoute \/ MapControllerRoute\)/);
  assert.equal(decl(text, 'Login(LoginInputModel').name, 'POST /Account/Login');
  assert.equal(decl(text, 'AccessDenied').name, 'ALL /Account/AccessDenied');
  assert.equal(decl(text, 'SignOut').name, 'ALL /Account/Out');            // [ActionName]
  assert.equal(decl(text, 'LogoutAsync').name, 'ALL /Account/Logout');     // Async suffix removed
  const attr = decl(text, 'Attr(int');
  assert.equal(attr.name, 'GET /attr/{id}');                                // attribute-routed action
  assert.doesNotMatch(attr.how, /conventional/);
  // [action] in an attribute route gets the same action name
  const tok = '[Route("api/[controller]")] public class ItemsController : ControllerBase { [HttpGet("[action]")] public int GetAllAsync() => 1; }';
  assert.equal(decl(tok, 'GetAllAsync').name, 'GET /api/Items/GetAll');
  // an unknown inherited route stays <inherited>, not conventional
  assert.equal(decl('using Microsoft.AspNetCore.Mvc; public class GController : BaseApiController { public int Get() => 1; }', 'Get(').name, 'ALL /<inherited>');
});

test('controller: a *Controller name or base needs ASP.NET evidence; [NonController] is never one', () => {
  // Unity-like: no ASP.NET using, no MVC attribute.
  assert.equal(decl('namespace Game { public class PlayerController { public void Move(int x) {} } }', 'Move('), null);
  assert.equal(decl('using UnityEngine;\nclass EnemyAI : CharacterController { public void Attack() {} }', 'Attack('), null);
  assert.equal(decl('using Microsoft.AspNetCore.Mvc;\n[NonController] public class FooController { public void Run() {} }', 'Run('), null);
  assert.equal(decl('using Microsoft.AspNetCore.Mvc;\n[NonController] public class BarController : Controller { public void Run() {} }', 'Run('), null);
  // with evidence: a using, an MVC attribute in the class, or (facts) a base chain reaching MVC
  assert.equal(decl('using Microsoft.AspNetCore.Mvc;\npublic class PingController { public string Ping() => "x"; }', 'Ping(').name, 'ALL /Ping/Ping');
  assert.equal(decl('public class PongController { [HttpGet("/pong")] public string Pong() => "x"; }', 'Pong(').name, 'GET /pong');
  const derived = 'public class UsersController : BaseApiController { public int List() => 1; }';
  assert.equal(decl(derived, 'List('), null);   // no evidence in the file and no facts
  assert.equal(decl(derived, 'List(', 'a/UsersController.cs', { csControllerRoutes: new Map([['BaseApiController', { route: 'api', base: 'ControllerBase', mvc: false }]]) }).name, 'ALL /api');
  assert.equal(decl(derived, 'List(', 'a/UsersController.cs', { csControllerRoutes: new Map([['BaseApiController', { route: null, base: 'MonoBehaviour', mvc: false }]]) }), null);
});

test('controller: overrides of framework members, Dispose and generic methods are no actions', () => {
  const text = `using Microsoft.AspNetCore.Mvc;
public class HomeController : Controller
{
    public override void OnActionExecuting(ActionExecutingContext c) { }
    public override void OnActionExecuted(ActionExecutedContext c) { }
    public override Task OnActionExecutionAsync(ActionExecutingContext c, ActionExecutionDelegate n) => null;
    public override string ToString() => "";
    public new void Dispose() { }
    [HttpGet] public IActionResult Index<T>() => View();
    [HttpGet("x")] [NonAction] public IActionResult Hidden() => View();
    public IActionResult Real() => View();
}
public class MidController : BaseController
{
    public override void OnActionExecuting(ActionExecutingContext c) { }
    public override IActionResult Shared() => View();
}
`;
  for (const n of ['OnActionExecuting(ActionExecutingContext c) { }\n    public override void OnActionExecuted', 'OnActionExecuted(', 'OnActionExecutionAsync', 'ToString', 'Dispose', 'Index<T>', 'Hidden(']) assert.equal(decl(text, n), null, n);
  assert.equal(decl(text, 'Real(').name, 'ALL /Home/Real');
  // a class on a user base: OnActionExecuting is still excluded by name; another override is an action
  const mid = text.lastIndexOf('OnActionExecuting');
  assert.equal(declarationEntry({ language: 'csharp', text, blanked: blank(text), pos: mid, label: 'MidController.OnActionExecuting', relPath: 'src/X.cs' }), null);
  assert.equal(decl(text, 'Shared(').name, 'ALL /<inherited>');
});

test('controller: an abstract or generic (open) controller gives no entry under its own name', () => {
  const text = `using Microsoft.AspNetCore.Mvc;
[Route("api/[controller]")]
public abstract class CrudController<T> : ControllerBase
{
    [HttpGet("{id}")] public T Get(int id) => default;
}
[Route("api/[controller]")]
public abstract class BaseItemsController : ControllerBase
{
    [HttpGet("all")] public int All() => 1;
}
public class GenController<T> : ControllerBase { [HttpGet("g")] public int G() => 1; }
[Route("api/[controller]")]
public class OrdersController : CrudController<Order> { [HttpGet("x")] public int X() => 1; }
`;
  assert.equal(decl(text, 'Get(int'), null);
  assert.equal(decl(text, 'All('), null);
  assert.equal(decl(text, 'G()'), null);
  assert.equal(decl(text, 'X()').name, 'GET /api/Orders/x');
});

test('minimal API: the MapGroup prefix is looked up in the enclosing method only; unseen groups read as partial', () => {
  const text = `public static class Apis
{
    public static void One(WebApplication app)
    {
        var g = app.MapGroup("/one");
        g.MapGet("/a", H1);
    }
    public static void Two(RouteGroupBuilder g)
    {
        g.MapGet("/b", H2);
        var v = g.MapGroup("v2");
        v.MapGet("/c", H3);
    }
    public static void Three(WebApplication app)
    {
        var g = Grp(app);
        g.MapGet("/d", H4);
        _field.MapGet("/e", H5);
    }
    static RouteGroupBuilder Grp(WebApplication app) => app.MapGroup("/v1");
    static int H1() => 1; static int H2() => 1; static int H3() => 1; static int H4() => 1; static int H5() => 1;
}
`;
  const one = decl(text, 'H1() =>');
  assert.equal(one.name, 'GET /one/a');
  assert.match(one.how, /a prefix the caller adds is not followed/);   // app: a WebApplication parameter
  assert.equal(decl(text, 'H2() =>').name, 'GET /<group>/b');          // not /one/b from method One
  assert.equal(decl(text, 'H3() =>').name, 'GET /<group>/v2/c');
  assert.equal(decl(text, 'H4() =>').name, 'GET /<group>/d');          // a method's return
  assert.equal(decl(text, 'H5() =>').name, 'GET /<group>/e');          // a field
  // top-level statements: app from builder.Build() adds nothing, and nothing is said
  const top = 'var app = builder.Build();\nvar api = app.MapGroup("/v1");\napi.MapGet("/x", Get);\nstatic int Get() => 1;\n';
  assert.deepEqual([decl(top, 'Get() =>').name, decl(top, 'Get() =>').how], ['GET /v1/x', 'passed to api.MapGet() in this file']);
  // MapMethods with HttpMethods.X; an interpolated route with a hole is not known
  const mm = 'var app = builder.Build();\napp.MapMethods("/check", [HttpMethods.Options], Check);\napp.MapGet($"{Base}/items", Items);\nstatic int Check() => 1;\nstatic int Items() => 1;\n';
  assert.equal(decl(mm, 'Check() =>').name, 'OPTIONS /check');
  assert.equal(decl(mm, 'Items() =>').name, 'GET /<$"{Base}/items">');
});

test('minimal API: a qualified handler matches only that class; a bare one only the calling class or a local function', () => {
  const text = `public class A
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/x", Other.Get);
        app.MapGet("/y", Handle);
        app.MapGet("/z", this.Own);
    }
    static int Handle() => 1;
    int Own() => 1;
}
public class B { public static int Get() => 1; public static int Handle() => 1; public int Own() => 1; }
public class Other { public static int Get() => 1; }
`;
  assert.equal(decl(text, 'Get() => 1; public static int Handle'), null);   // B.Get
  const other = text.lastIndexOf('Get()');
  const e = declarationEntry({ language: 'csharp', text, blanked: blank(text), pos: other, label: 'Other.Get()', relPath: 'src/X.cs' });
  assert.equal(e.name, 'GET /x');
  assert.equal(decl(text, 'Handle() => 1;\n').name, 'GET /y');               // A.Handle
  assert.equal(decl(text, 'Handle() => 1; public int'), null);               // B.Handle
  assert.equal(decl(text, 'Own() => 1;\n').name, 'GET /z');
  assert.equal(decl(text, 'Own() => 1; }'), null);
});

// eShop's CatalogApi: groups, versioned groups, method groups and lambdas.
const minimal = `public static class CatalogApi
{
    public static IEndpointRouteBuilder MapCatalogApi(this IEndpointRouteBuilder app)
    {
        var vApi = app.NewVersionedApi("Catalog");
        var api = vApi.MapGroup("api/catalog").HasApiVersion(1, 0);
        var v1 = vApi.MapGroup("api/catalog").HasApiVersion(1, 0);
        v1.MapGet("/items", GetAllItemsV1).WithName("x");
        api.MapGet("/items/{id:int}", GetItemById);
        api.MapPut("/cancel", CancelOrder);
        api.MapMethods("/m", new[] { "GET", "post" }, Multi);
        api.MapGet("/catalogtypes", async (CatalogContext c) => await c.Types.ToListAsync());
        // api.MapGet("/ghost", Ghost);
        return app;
    }
    public static async Task<Ok> GetAllItemsV1(int x) => null;
    public static async Task<Ok> GetItemById(int id) => null;
    public static async Task<Ok> CancelOrder(int id) => null;
    public static async Task<Ok> Multi(int id) => null;
    public static async Task<Ok> Ghost(int id) => null;
}
`;

test('minimal API: a method group registered in the same file, with the MapGroup prefix', () => {
  assert.deepEqual(decl(minimal, 'GetAllItemsV1(int'), { type: 'http', name: 'GET /api/catalog/items', method: 'GET', route: '/api/catalog/items', how: 'passed to v1.MapGet() in this file; a prefix the caller adds is not followed' });
  assert.equal(decl(minimal, 'GetItemById(int').name, 'GET /api/catalog/items/{id:int}');
  assert.equal(decl(minimal, 'CancelOrder(int').name, 'PUT /api/catalog/cancel');
  assert.equal(decl(minimal, 'Multi(int').name, 'GET|POST /api/catalog/m');
  assert.equal(decl(minimal, 'Ghost(int'), null);
  assert.equal(decl(minimal, 'MapCatalogApi'), null);
});

test('minimal API: a call inside the lambda handler makes its function a call-site entry', () => {
  const text = 'var app = builder.Build();\nvar api = app.MapGroup("/v1");\napp.MapGet("/x", (HttpContext c) => H(c));\napi.MapPost("/y", async (c) => { await Save(c); });\nother.Map("k", () => Skip());\nvoid H2() => Plain();\n';
  assert.deepEqual(site(text, 'var app', 'H(c)'), { type: 'http', name: 'GET /x', method: 'GET', route: '/x', how: 'app.MapGet() registration' });
  assert.equal(site(text, 'var app', 'Save(c)').name, 'POST /v1/y');
  assert.equal(site(text, 'var app', 'Skip()'), null);     // plain Map needs a path starting with /
  assert.equal(site(text, 'var app', 'Plain()'), null);
});

test('gRPC, hosted services, integration handlers, SignalR hubs and Main', () => {
  const text = `public class BasketService : Basket.BasketBase
{
    public override Task<R> GetBasket(Req r, ServerCallContext context) => null;
    public Task<R> Helper(Req r, ServerCallContext context) => null;
}
public sealed class Worker(ILogger l) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken t) { }
    public void Other() { }
}
public class Notifier : IHostedService, IDisposable
{
    public Task StartAsync(CancellationToken t) => Task.CompletedTask;
    public Task StopAsync(CancellationToken t) => Task.CompletedTask;
}
public class PaidHandler : IIntegrationEventHandler<PaidIntegrationEvent>
{
    public async Task Handle(PaidIntegrationEvent @event) { }
}
public interface IIntegrationEventHandler<in T> : IIntegrationEventHandler { Task Handle(T e); }
public class ChatHub : Hub<IChat>
{
    public Task Send(string m) => null;
    private void Hidden() { }
}
public class Program { public static void Main(string[] args) { } }
`;
  assert.deepEqual(decl(text, 'GetBasket'), { type: 'http', name: 'Basket/GetBasket', method: 'GRPC', route: '/Basket/GetBasket', how: 'gRPC method of BasketService' });
  assert.equal(decl(text, 'Helper'), null);     // no override
  assert.deepEqual([decl(text, 'ExecuteAsync').type, decl(text, 'ExecuteAsync').name], ['job', 'Worker.ExecuteAsync']);
  assert.equal(decl(text, 'Other'), null);
  assert.deepEqual([decl(text, 'StartAsync').type, decl(text, 'StopAsync').name], ['job', 'Notifier.StopAsync']);
  assert.deepEqual([decl(text, 'Handle(PaidIntegrationEvent').type, decl(text, 'Handle(PaidIntegrationEvent').name], ['event', 'PaidIntegrationEvent']);
  assert.equal(decl(text, 'Handle(T e'), null);  // the interface's own declaration
  assert.deepEqual([decl(text, 'Send(').type, decl(text, 'Send').name], ['event', 'ChatHub.Send']);
  assert.equal(decl(text, 'Hidden'), null);
  assert.deepEqual(decl(text, 'Main', 'src/App/Program.cs'), { type: 'main', name: 'src/App/Program.cs', how: 'static Main' });
});

test('MediatR: Handle is no entry; its reason is given for a handler nothing calls', () => {
  const text = 'public class CancelHandler : IRequestHandler<CancelCommand, bool>\n{\n  public async Task<bool> Handle(CancelCommand c, CancellationToken t) => true;\n}\n'
    + 'public class Other { public bool Handle(int x) => true; }\n';
  const input = (n) => ({ text, blanked: blank(text), pos: at(text, n), label: n, relPath: 'a/H.cs' });
  assert.equal(decl(text, 'Handle(CancelCommand'), null);
  assert.match(unreachableReason(input('Handle(CancelCommand')), /MediatR handler: dispatched by `Send`\/`Publish`, which is not followed yet/);
  assert.equal(unreachableReason(input('Handle(int')), null);
});

// -- the walk: app-start for top-level statements, MediatR ending unknown, top kind from the entry --

const REPO = '/repo';
function walkOf(text, { file = 'src/Api/Program.cs', pos, label, facts, resolver = {} }) {
  const changed = { label, file: `${REPO}/${file}`, relPath: file, namePos: pos, callers: [] };
  return impactPathsFor({
    units: [{ resolver: { incoming: async () => [], callerState: async () => ({ state: 'none', callers: [], complete: true }), ...resolver }, changed: [changed] }],
    repo: REPO, facts, readText: () => text,
  }).then((r) => r.byId[`${file}#${pos}`]);
}

test('walk: top-level statements end at app-start named after the project (file name without facts), module row at its first statement', async () => {
  const text = 'using X;\nvar app = Build();\napp.Run();\n';
  const pos = at(text, 'var app');   // not 0: the C# module row sits at its first statement
  const withFacts = await walkOf(text, { pos, label: 'Program.cs', facts: { csProjects: new Map([['src/Api/Program.cs', 'Api']]) } });
  assert.deepEqual([withFacts.topPaths[0].end, withFacts.topPaths[0].topKind, withFacts.topPaths[0].bin], ['top-unidentified', 'app-start', 'Api']);
  const preview = await walkOf(text, { pos, label: 'Program.cs', facts: {} });
  assert.equal(preview.topPaths[0].bin, 'Program.cs');
  assert.equal(withFacts.incompleteReasons.some((r) => /not traced/.test(r)), false);
});

test('walk: a caller-less MediatR handler ends unknown with the reason, never a top', async () => {
  const text = 'public class CancelHandler : IRequestHandler<CancelCommand, bool>\n{\n  public async Task<bool> Handle(CancelCommand c) => true;\n}\n';
  const pos = at(text, 'Handle(');
  const r = await walkOf(text, { file: 'src/Ordering/CancelHandler.cs', pos, label: 'CancelHandler.Handle(CancelCommand)' });
  assert.deepEqual(r.summary.ends, { entry: 0, 'top-unidentified': 0, budget: 0, unknown: 1 });
  assert.match(r.incompleteReasons.join(' '), /MediatR handler: dispatched by `Send`\/`Publish`, which is not followed yet/);
  assert.equal(r.complete, false);
});

test('walk: a changed controller action is an entry at depth 0', async () => {
  const pos = at(controller, 'GetImages');
  const r = await walkOf(controller, { file: 'Jellyfin.Api/Controllers/ItemsController.cs', pos, label: 'ItemsController.GetImages(Guid)', facts: {} });
  assert.deepEqual(r.entries.map((e) => [e.type, e.name, e.depth]), [['http', 'GET /Items/{itemId}/Images', 0]]);
});
