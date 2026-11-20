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
  assert.deepEqual(decl(minimal, 'GetAllItemsV1(int'), { type: 'http', name: 'GET /api/catalog/items', method: 'GET', route: '/api/catalog/items', how: 'passed to v1.MapGet() in this file' });
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
