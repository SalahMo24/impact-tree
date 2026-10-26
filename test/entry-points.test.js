'use strict';
// Entry-point recognition (src/engine/entry-points.js) from small source texts, and the
// pure helpers of the facts gatherer (src/engine/entry-facts.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { declarationEntry, callSiteEntry, cobraCommandsIn, entryLanguageOf } = require('../src/engine/entry-points');
const { reExportsOf, sourceOfTarget } = require('../src/engine/entry-facts');

const at = (text, needle, from = 0) => { const i = text.indexOf(needle, from); assert.ok(i >= 0, needle); return i; };
const decl = (language, text, name, label = name, relPath = 'src/x.ts', facts) => declarationEntry({ language, text, pos: at(text, name), label, relPath, facts });
const site = (language, text, callerName, call, relPath = 'src/x.ts', facts) => callSiteEntry({
  language, text, callerPos: at(text, callerName), callSiteStart: at(text, call), relPath, callerLabel: callerName, facts,
});

test('language of a file', () => {
  assert.equal(entryLanguageOf('/r/a.tsx'), 'ts');
  assert.equal(entryLanguageOf('/r/a.d.ts'), null);
  assert.equal(entryLanguageOf('/r/a.go'), 'go');
  assert.equal(entryLanguageOf('/r/a.py'), 'python');
  assert.equal(entryLanguageOf('/r/A.java'), null);
});

test('TS: a call inside an app.get registration makes the caller an HTTP entry', () => {
  const text = "function setup(app) {\n  app.get('/users/:id', (c) => loadUser(c));\n  cache.get('key', () => other());\n}\n";
  assert.deepEqual(site('ts', text, 'setup', 'loadUser'), { type: 'http', name: 'GET /users/:id', method: 'GET', route: '/users/:id', how: 'app.get() registration' });
  // `cache.get('key', …)`: no path argument, not a route
  assert.equal(site('ts', text, 'setup', 'other'), null);
});

test('TS: a string in the handler does not confuse the bracket scan', () => {
  const text = "function setup(router) {\n  router.post('/x', async (c) => { const s = \"(\"; return save(c); });\n}\n";
  assert.equal(site('ts', text, 'setup', 'save').name, 'POST /x');
});

test('TS: a case "x": dispatch is not recognised (not a framework pattern)', () => {
  const text = "function route(msg) {\n  switch (msg.method) {\n    case 'git.status': return status(msg);\n  }\n}\n";
  assert.equal(site('ts', text, 'route', 'status'), null);
  assert.equal(decl('ts', text, 'route'), null);
});

test('TS: NestJS decorators with the controller prefix', () => {
  const text = "@Controller('users')\nexport class UsersController {\n  @Get(':id')\n  findOne() {}\n  @Post()\n  create() {}\n  helper() {}\n}\n";
  assert.equal(decl('ts', text, 'findOne', 'UsersController.findOne').name, 'GET /users/:id');
  assert.equal(decl('ts', text, 'create', 'UsersController.create').name, 'POST /users');
  assert.equal(decl('ts', text, 'helper', 'UsersController.helper'), null);
});

test('TS: Next.js route handlers, API routes and pages', () => {
  const route = 'export async function GET(req) { return x(); }\n';
  assert.deepEqual(decl('ts', route, 'GET', 'GET', 'web/app/(shop)/items/[id]/route.ts'), { type: 'http', name: 'GET /items/[id]', method: 'GET', route: '/items/[id]', how: 'Next.js route handler' });
  const api = 'export default function handler(req, res) {}\n';
  assert.equal(decl('ts', api, 'handler', 'handler', 'pages/api/users/index.ts').name, 'ALL /api/users');
  assert.equal(decl('ts', api, 'handler', 'handler', 'src/lib/handler.ts'), null);
});

test('TS: a named handler registered in the same file, and ipcMain', () => {
  const text = "function listUsers(c) {}\nfunction pick() {}\napp.get('/users', auth, listUsers);\nipcMain.handle(PICK_CHANNEL, pick);\n";
  assert.equal(decl('ts', text, 'listUsers').name, 'GET /users');
  assert.deepEqual(decl('ts', text, 'pick'), { type: 'ipc', name: 'PICK_CHANNEL', how: 'passed to ipcMain.handle() in this file' });
});

test('TS: TanStack Router file routes and React Router paths are UI routes', () => {
  const text = 'function ChatLayout() {}\nexport const Route = createFileRoute("/_chat")({\n  component: ChatLayout,\n});\n';
  assert.deepEqual(decl('ts', text, 'ChatLayout'), { type: 'ui-route', name: '/_chat', route: '/_chat', how: 'TanStack Router file route' });
  const rr = "function Settings() {}\nconst routes = [{ path: '/settings', element: <Settings /> }];\n";
  assert.equal(decl('ts', rr, 'Settings').name, '/settings');
});

test('TS: public API of a published package', () => {
  const text = 'export function create() {}\nfunction internal() {}\nexport class Hono {\n  route() {}\n  private build() {}\n  _hidden() {}\n}\n';
  const facts = { tsPublic: new Map([['src/hono.ts', '*']]) };
  assert.equal(decl('ts', text, 'create', 'create', 'src/hono.ts', facts).type, 'public-api');
  assert.equal(decl('ts', text, 'internal', 'internal', 'src/hono.ts', facts), null);
  assert.equal(decl('ts', text, 'route', 'Hono.route', 'src/hono.ts', facts).name, 'Hono.route');
  assert.equal(decl('ts', text, 'build', 'Hono.build', 'src/hono.ts', facts), null);
  assert.equal(decl('ts', text, '_hidden', 'Hono._hidden', 'src/hono.ts', facts), null);
  // Only the names a barrel re-exports, when the file is reached by name.
  const named = { tsPublic: new Map([['src/hono.ts', new Set(['Hono'])]]) };
  assert.equal(decl('ts', text, 'create', 'create', 'src/hono.ts', named), null);
  assert.equal(decl('ts', text, 'route', 'Hono.route', 'src/hono.ts', named).type, 'public-api');
  // A file no package exposes is not public API.
  assert.equal(decl('ts', text, 'create', 'create', 'src/other.ts', facts), null);
});

test('Go: a call inside a cobra command literal, with the parent command line', () => {
  const text = [
    'package list', '',
    'func NewCmdList(f *Factory) *cobra.Command {',
    '\tcmd := &cobra.Command{',
    '\t\tUse:   "list [flags]",',
    '\t\tShort: "List things",',
    '\t\tRunE: func(cmd *cobra.Command, args []string) error {',
    '\t\t\treturn listRun(opts)',
    '\t\t},',
    '\t}',
    '\thelper()',
    '\treturn cmd',
    '}', '',
  ].join('\n');
  const facts = { goCommandPrefix: new Map([['pkg/cmd/pr/list#NewCmdList', 'gh pr']]) };
  assert.deepEqual(site('go', text, 'NewCmdList', 'listRun', 'pkg/cmd/pr/list/list.go', facts),
    { type: 'cli-command', name: 'gh pr list', how: 'call inside a cobra.Command literal' });
  // A call after the literal is not inside it.
  assert.equal(site('go', text, 'NewCmdList', 'helper', 'pkg/cmd/pr/list/list.go', facts), null);
  // The constructor itself builds the command.
  assert.equal(decl('go', text, 'NewCmdList', 'NewCmdList', 'pkg/cmd/pr/list/list.go', facts).name, 'gh pr list');
  const cmds = cobraCommandsIn(text);
  assert.equal(cmds.length, 1);
  assert.deepEqual({ fn: cmds[0].fn, use: cmds[0].use, runs: cmds[0].runs }, { fn: 'NewCmdList', use: 'list [flags]', runs: true });
});

test('Go: RunE naming a function, func main, http.HandleFunc', () => {
  const text = 'package main\n\nvar root = &cobra.Command{Use: "tool", RunE: runRoot}\n\nfunc runRoot(c *cobra.Command, a []string) error { return nil }\n\nfunc main() {\n\thttp.HandleFunc("GET /items", items)\n\tmux.Handle("/x", http.HandlerFunc(func(w, r) { serveX(w) }))\n}\n\nfunc items(w, r) {}\n';
  assert.equal(decl('go', text, 'runRoot', 'runRoot', 'cmd/tool/main.go').name, 'tool');
  assert.deepEqual(declarationEntry({ language: 'go', text, pos: at(text, 'main()'), label: 'main', relPath: 'cmd/tool/main.go' }), { type: 'main', name: 'cmd/tool', how: 'func main of package main' });
  assert.equal(decl('go', text, 'items(w', 'items', 'cmd/tool/main.go').name, 'GET /items');
  assert.equal(site('go', text, 'main()', 'serveX', 'cmd/tool/main.go').name, 'ALL /x');
});

test('Go: a cobra command without Run is not counted as runnable', () => {
  const text = 'package pr\n\nfunc NewCmdPR() *cobra.Command {\n\tcmd := &cobra.Command{\n\t\tUse: "pr <command>",\n\t}\n\treturn cmd\n}\n';
  assert.equal(decl('go', text, 'NewCmdPR', 'NewCmdPR', 'pkg/cmd/pr/pr.go'), null);
  assert.equal(cobraCommandsIn(text)[0].runs, false);
});

test('Python: FastAPI, Flask, click and celery decorators', () => {
  const text = [
    '@router.get("/items/{id}")', 'async def read_item(id): ...', '',
    '@app.route("/login", methods=["GET", "POST"])', 'def login(): ...', '',
    '@click.command()', '@click.option("--n")', 'def sync_db(n): ...', '',
    '@shared_task', 'def cleanup(): ...', '',
    '@property', 'def plain(self): ...', '',
  ].join('\n');
  assert.deepEqual(declarationEntry({ language: 'python', text, pos: at(text, 'read_item'), label: 'read_item', relPath: 'app/api.py' }),
    { type: 'http', name: 'GET /items/{id}', method: 'GET', route: '/items/{id}', how: '@router.get() decorator' });
  assert.equal(declarationEntry({ language: 'python', text, pos: at(text, 'def login') + 4, label: 'login', relPath: 'app/api.py' }).name, 'GET|POST /login');
  assert.deepEqual(declarationEntry({ language: 'python', text, pos: at(text, 'sync_db'), label: 'sync_db', relPath: 'app/api.py' }),
    { type: 'cli-command', name: 'sync-db', how: '@click.command decorator' });
  assert.equal(declarationEntry({ language: 'python', text, pos: at(text, 'cleanup'), label: 'cleanup', relPath: 'app/api.py' }).type, 'job');
  assert.equal(declarationEntry({ language: 'python', text, pos: at(text, 'plain'), label: 'plain', relPath: 'app/api.py' }), null);
});

test('Python: names in __all__ and public methods of exported classes', () => {
  const text = 'class Client:\n    def get(self): ...\n    def _send(self): ...\n    def __init__(self): ...\n    def __mangled(self): ...\n\ndef helper(): ...\n';
  const facts = { pyPublic: new Map([['httpx/_client.py', new Set(['Client'])]]) };
  const py = (name, label) => declarationEntry({ language: 'python', text, pos: at(text, name), label, relPath: 'httpx/_client.py', facts });
  assert.deepEqual(py('Client', 'Client'), { type: 'public-api', name: 'Client', how: 'listed in a package __all__' });
  assert.equal(py('get', 'Client.get').name, 'Client.get');
  assert.equal(py('_send', 'Client._send'), null);
  assert.equal(py('__init__', 'Client.__init__').name, 'Client.__init__');
  assert.equal(py('__init__', 'Client.__init__').how, 'special method of a class in __all__ (used through its protocol)');
  assert.equal(py('__mangled', 'Client.__mangled'), null);
  assert.equal(py('helper', 'helper'), null);
});

test('facts: re-exports and package targets mapped to source', () => {
  const text = "export * from './a'\nexport { B, C as D } from './bc'\nimport { E } from './e'\nexport { E }\nimport F from './f'\nexport default F\n";
  const re = reExportsOf(text);
  assert.deepEqual(re.map((r) => [r.from, r.names === '*' ? '*' : [...r.names]]), [
    ['./a', '*'], ['./bc', [['B', 'B'], ['C', 'D']]], ['./e', [['E', 'E']]], ['./f', [['default', 'default']]],
  ]);
  const listed = new Set(['pkg/src/index.ts', 'pkg/src/utils/url.ts']);
  assert.equal(sourceOfTarget('pkg', './dist/cjs/index.js', listed), 'pkg/src/index.ts');
  assert.equal(sourceOfTarget('pkg', './dist/types/utils/url.d.ts', listed), 'pkg/src/utils/url.ts');
  assert.equal(sourceOfTarget('pkg', './dist/missing.js', listed), null);
});

test('Python: special methods of a public class are entries; a private class\'s are not', () => {
  const text = 'class ByteStream:\n    def __aiter__(self): ...\n    async def __anext__(self): ...\n    def __enter__(self): ...\n\nclass _Iter:\n    def __anext__(self): ...\n';
  const facts = { pyPublic: new Map([['httpx/_content.py', new Set(['ByteStream'])]]) };
  const py = (needle, label) => declarationEntry({ language: 'python', text, pos: at(text, needle) + needle.indexOf('__'), label, relPath: 'httpx/_content.py', facts });
  for (const [needle, label] of [['def __aiter__', 'ByteStream.__aiter__'], ['def __anext__', 'ByteStream.__anext__'], ['def __enter__', 'ByteStream.__enter__']]) {
    assert.deepEqual(py(needle, label), { type: 'public-api', name: label, how: 'special method of a class in __all__ (used through its protocol)' });
  }
  assert.equal(declarationEntry({ language: 'python', text, pos: text.lastIndexOf('__anext__'), label: '_Iter.__anext__', relPath: 'httpx/_content.py', facts }), null);
});

test('facts: __all__ names reached through `from .x import *` and TYPE_CHECKING imports', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { gatherEntryFacts } = require('../src/engine/entry-facts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-facts-'));
  const files = {
    'pkg/__init__.py': 'from typing import TYPE_CHECKING\nfrom ._content import *\nif TYPE_CHECKING:\n    from .main import Model\n__all__ = ["ByteStream", "Model", "VERSION"]\nVERSION = "1"\n',
    'pkg/_content.py': '__all__ = ["ByteStream"]\nclass ByteStream:\n    pass\n',
    'pkg/main.py': 'class Model:\n    pass\n',
  };
  try {
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
    const git = { tryRaw: () => Object.keys(files).join('\0') };
    const { facts } = gatherEntryFacts({ repo: dir, git, languages: new Set(['python']) });
    assert.deepEqual([...facts.pyPublic.get('pkg/_content.py')], ['ByteStream']);
    assert.deepEqual([...facts.pyPublic.get('pkg/main.py')], ['Model']);
    assert.deepEqual([...facts.pyPublic.get('pkg/__init__.py')], ['VERSION']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Go: a main under script/ or behind go:build ignore is a dev tool, its package code too', () => {
  const text = 'package main\n\nvar tasks = map[string]func(){"build": func() { builtWithTags() }}\n\nfunc main() {}\n';
  const at2 = text.indexOf('main()');
  assert.deepEqual(declarationEntry({ language: 'go', text, pos: at2, label: 'main', relPath: 'script/build.go' }),
    { type: 'dev-tool', name: 'script/build.go', how: 'func main of a developer script' });
  assert.equal(declarationEntry({ language: 'go', text, pos: 0, label: 'build.go', relPath: 'script/build.go' }).type, 'dev-tool');
  const tagged = `//go:build ignore\n\n${text}`;
  assert.equal(declarationEntry({ language: 'go', text: tagged, pos: tagged.indexOf('main()'), label: 'main', relPath: 'gen.go' }).type, 'dev-tool');
  // The application's own main stays `main`; module code of a non-script file is no entry.
  assert.equal(declarationEntry({ language: 'go', text, pos: at2, label: 'main', relPath: 'cmd/gh/main.go' }).type, 'main');
  assert.equal(declarationEntry({ language: 'go', text, pos: 0, label: 'main.go', relPath: 'cmd/gh/main.go' }), null);
});
