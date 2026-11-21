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
  const text = 'export function create() {}\nfunction internal() {}\nexport class App {\n  route() {}\n  private build() {}\n  _hidden() {}\n}\n';
  const facts = { tsPublic: new Map([['src/app.ts', '*']]) };
  assert.equal(decl('ts', text, 'create', 'create', 'src/app.ts', facts).type, 'public-api');
  assert.equal(decl('ts', text, 'internal', 'internal', 'src/app.ts', facts), null);
  assert.equal(decl('ts', text, 'route', 'App.route', 'src/app.ts', facts).name, 'App.route');
  assert.equal(decl('ts', text, 'build', 'App.build', 'src/app.ts', facts), null);
  assert.equal(decl('ts', text, '_hidden', 'App._hidden', 'src/app.ts', facts), null);
  // Only the names a barrel re-exports, when the file is reached by name.
  const named = { tsPublic: new Map([['src/app.ts', new Set(['App'])]]) };
  assert.equal(decl('ts', text, 'create', 'create', 'src/app.ts', named), null);
  assert.equal(decl('ts', text, 'route', 'App.route', 'src/app.ts', named).type, 'public-api');
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
  const facts = { pyPublic: new Map([['webclient/_client.py', new Set(['Client'])]]) };
  const py = (name, label) => declarationEntry({ language: 'python', text, pos: at(text, name), label, relPath: 'webclient/_client.py', facts });
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
  const facts = { pyPublic: new Map([['webclient/_content.py', new Set(['ByteStream'])]]) };
  const py = (needle, label) => declarationEntry({ language: 'python', text, pos: at(text, needle) + needle.indexOf('__'), label, relPath: 'webclient/_content.py', facts });
  for (const [needle, label] of [['def __aiter__', 'ByteStream.__aiter__'], ['def __anext__', 'ByteStream.__anext__'], ['def __enter__', 'ByteStream.__enter__']]) {
    assert.deepEqual(py(needle, label), { type: 'public-api', name: label, how: 'special method of a class in __all__ (used through its protocol)' });
  }
  assert.equal(declarationEntry({ language: 'python', text, pos: text.lastIndexOf('__anext__'), label: '_Iter.__anext__', relPath: 'webclient/_content.py', facts }), null);
});

test('facts: a repository\'s facts are reused while its listing and the files read are unchanged', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { gatherEntryFacts, _clearEntryFactsCache } = require('../src/engine/entry-facts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-facts-cache-'));
  const write = (rel, text) => { fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  try {
    _clearEntryFactsCache();
    write('package.json', '{"name":"p","main":"dist/index.js"}');
    write('src/index.ts', 'export { a } from "./a";\n');
    write('src/a.ts', 'export function a() {}\n');
    let listing = ['package.json', 'src/index.ts', 'src/a.ts'].join('\0');
    const git = { tryRaw: () => listing };
    const first = gatherEntryFacts({ repo: dir, git, languages: new Set(['ts']) });
    assert.deepEqual([...first.facts.tsPublic.get('src/a.ts')], ['a']);
    // Nothing changed: the same facts object, without reading again.
    const again = gatherEntryFacts({ repo: dir, git, languages: new Set(['ts']) });
    assert.equal(again.facts, first.facts);
    assert.notEqual(again.notes, first.notes, 'the notes are the caller\'s own copy');
    // Another language set is another entry.
    assert.notEqual(gatherEntryFacts({ repo: dir, git, languages: new Set(['ts', 'go']) }).facts, first.facts);
    // A file that was read changed (same size, later mtime): read again, new facts.
    write('src/index.ts', 'export { b } from "./a";\n');
    fs.utimesSync(path.join(dir, 'src/index.ts'), new Date(), new Date(Date.now() + 5000));
    const edited = gatherEntryFacts({ repo: dir, git, languages: new Set(['ts']) });
    assert.notEqual(edited.facts, first.facts);
    assert.deepEqual([...edited.facts.tsPublic.get('src/a.ts')], ['b']);
    // The listing changed (a file added): read again.
    write('src/c.ts', 'export function c() {}\n');
    listing += '\0src/c.ts';
    assert.notEqual(gatherEntryFacts({ repo: dir, git, languages: new Set(['ts']) }).facts, edited.facts);
    // A preview reads another revision than the disk and is never served from the cache.
    const preview = gatherEntryFacts({ repo: dir, git, languages: new Set(['ts']), readRel: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8') });
    assert.notEqual(gatherEntryFacts({ repo: dir, git, languages: new Set(['ts']), readRel: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8') }).facts, preview.facts);
  } finally {
    _clearEntryFactsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// Next.js rules that need the Next gate: `nextRoots` (a package.json with `next`, or a
// next.config.*) and `packageRoots` (every package.json), as entry-facts gathers them.
const NEXT = { nextRoots: new Set(['']), packageRoots: new Set(['']) };
const nx = (text, name, relPath, facts = NEXT, label = name) => decl('ts', text, name, label, relPath, facts);

test('Next.js: layout and template are UI routes that keep route groups; segment files use the page route', () => {
  const layout = 'export default function RootLayout({ children }) { return children; }\n';
  assert.deepEqual(nx(layout, 'RootLayout', 'app/layout.tsx'), { type: 'ui-route', name: '/*', route: '/*', how: 'Next.js layout' });
  const nested = 'const Shell = () => null;\nexport default Shell;\n';
  assert.equal(nx(nested, 'Shell', 'src/app/[locale]/(public)/layout.tsx').name, '/[locale]/(public)/*');
  assert.equal(nx(nested, 'Shell', 'app/dash/template.tsx').how, 'Next.js template');
  const loading = 'export default async function Loading() {}\n';
  assert.deepEqual(nx(loading, 'Loading', 'app/(shop)/items/loading.tsx'), { type: 'ui-route', name: '/items', route: '/items', how: 'Next.js loading' });
  for (const f of ['error', 'global-error', 'not-found', 'default']) assert.equal(nx('export default function X() {}\n', 'X', `app/a/${f}.tsx`).how, `Next.js ${f}`);
  // The default export only: a helper in the file is not the layout.
  assert.equal(nx(`${layout}function helper() {}\n`, 'helper', 'app/layout.tsx'), null);
  // Pinned: these forms are not recognised.
  assert.equal(nx('function X() {}\nexport { X as default };\n', 'X', 'app/layout.tsx'), null);
  assert.equal(nx('function X() {}\nexport default memo(X);\n', 'X', 'app/layout.tsx'), null);
  // `app/` must sit at the app root or its `src/`.
  assert.equal(nx(layout, 'RootLayout', 'components/app/layout.tsx'), null);
});

test('Next.js: the new rules need a Next.js app (negatives: no gate, other package, no facts)', () => {
  const layout = 'export default function RootLayout() {}\n';
  assert.equal(nx(layout, 'RootLayout', 'app/layout.tsx', {}), null);
  assert.equal(nx(layout, 'RootLayout', 'app/layout.tsx', { nextRoots: new Set(), packageRoots: new Set(['']) }), null);
  const page = 'export default function Page() {}\n';
  assert.equal(nx(page, 'Page', 'src/pages/Page.tsx', {}), null);
  // A monorepo: the nearest package root decides.
  const mono = { nextRoots: new Set(['apps/web']), packageRoots: new Set(['', 'apps/web', 'packages/ui']) };
  assert.equal(nx(layout, 'RootLayout', 'apps/web/app/layout.tsx', mono).name, '/*');
  assert.equal(nx(layout, 'RootLayout', 'packages/ui/app/layout.tsx', mono), null);
  assert.equal(nx(layout, 'RootLayout', 'app/layout.tsx', mono), null);
  const nested = { nextRoots: new Set(['']), packageRoots: new Set(['', 'tools/x']) };
  assert.equal(nx(layout, 'RootLayout', 'tools/x/app/layout.tsx', nested), null);
});

test('Next.js: generateMetadata, generateStaticParams and generateViewport belong to their segment', () => {
  const page = 'export async function generateMetadata() { return {}; }\nexport const generateStaticParams = async () => [];\nexport default function Page() {}\n';
  assert.deepEqual(nx(page, 'generateMetadata', 'app/(g)/blog/[slug]/page.tsx'), { type: 'ui-route', name: '/blog/[slug]', route: '/blog/[slug]', how: 'Next.js metadata' });
  assert.equal(nx(page, 'generateStaticParams', 'app/blog/[slug]/page.tsx').how, 'Next.js static params');
  const layout = 'export function generateViewport() {}\n';
  assert.deepEqual(nx(layout, 'generateViewport', 'app/(g)/layout.tsx'), { type: 'ui-route', name: '/(g)/*', route: '/(g)/*', how: 'Next.js viewport' });
  // Not exported, in a comment, in another file, or without the gate.
  assert.equal(nx('async function generateMetadata() {}\n', 'generateMetadata', 'app/page.tsx'), null);
  assert.equal(nx('// export async function generateMetadata() {}\nfunction generateMetadata() {}\n', 'generateMetadata', 'app/page.tsx'), null);
  assert.equal(nx(page, 'generateMetadata', 'app/blog/other.tsx'), null);
  assert.equal(nx(page, 'generateMetadata', 'app/blog/page.tsx', {}), null);
});

test('Next.js: middleware and proxy at the app root or src/, not nested', () => {
  const mw = 'export function middleware(req) { return next(); }\nexport const config = {};\n';
  assert.deepEqual(nx(mw, 'middleware', 'middleware.ts'), { type: 'http', name: 'ALL * (Next.js middleware)', method: 'ALL', route: '*', how: 'Next.js middleware' });
  assert.equal(nx(mw, 'middleware', 'src/middleware.ts').type, 'http');
  assert.equal(nx(mw, 'middleware', 'src/lib/middleware.ts'), null);
  assert.equal(nx(mw, 'middleware', 'app/middleware.ts'), null);
  assert.equal(nx(mw, 'middleware', 'middleware.ts', {}), null);
  assert.equal(nx('export default async function guard(req) {}\n', 'guard', 'proxy.ts').name, 'ALL * (Next.js proxy)');
  assert.equal(nx('function helper() {}\nexport function middleware() {}\n', 'helper', 'middleware.ts'), null);
  // Another app's root in a monorepo.
  const mono = { nextRoots: new Set(['apps/web']), packageRoots: new Set(['', 'apps/web']) };
  assert.equal(nx(mw, 'middleware', 'apps/web/middleware.ts', mono).type, 'http');
  assert.equal(nx(mw, 'middleware', 'middleware.ts', mono), null);
});

test('Next.js: server actions, by file directive and inline, as pass-through entries', () => {
  const file = "'use server'\nimport x from 'y';\nexport async function addLead(f) { return x(f); }\nasync function inner() {}\nexport function sync() {}\nexport const upd = async (a) => a;\nasync function late() {}\nexport { late };\n";
  assert.deepEqual(nx(file, 'addLead', 'app/actions.ts'), { type: 'server-action', name: 'addLead', how: 'Next.js server action', passThrough: true });
  assert.equal(nx(file, 'upd', 'lib/actions.ts').type, 'server-action');
  assert.equal(nx(file, 'late', 'lib/actions.ts').type, 'server-action');
  // Not exported, or not async.
  assert.equal(nx(file, 'inner', 'lib/actions.ts'), null);
  assert.equal(nx(file, 'sync', 'lib/actions.ts'), null);
  // Directive after comments counts; in a comment, a string, or after code it does not.
  assert.equal(nx('// header\n/* x */\n"use server";\nexport async function a() {}\n', 'a', 'x.ts').type, 'server-action');
  assert.equal(nx("// 'use server'\nexport async function a() {}\n", 'a', 'x.ts'), null);
  assert.equal(nx("/* 'use server' */\nexport async function a() {}\n", 'a', 'x.ts'), null);
  assert.equal(nx("import x from 'y';\n'use server'\nexport async function a() {}\n", 'a', 'x.ts'), null);
  assert.equal(nx("const s = \"use server\";\nexport async function a() {}\n", 'a', 'x.ts'), null);
  // Without the gate: nothing.
  assert.equal(nx(file, 'addLead', 'app/actions.ts', {}), null);
  // Inline: the body starts with the directive.
  const inline = "export default function Page() {\n  async function save(data: { a: string }): Promise<void> {\n    'use server';\n    await db(data);\n  }\n  const other = async (x) => { 'use server'; return x; };\n  async function plain() { go(); 'use server'; }\n  return null;\n}\n";
  assert.equal(nx(inline, 'save', 'app/page.tsx').type, 'server-action');
  assert.equal(nx(inline, 'other', 'app/page.tsx').type, 'server-action');
  assert.equal(nx(inline, 'plain', 'app/page.tsx'), null);
});

test('Next.js: the existing three rules do not need the gate', () => {
  assert.equal(decl('ts', 'export default function Page() {}\n', 'Page', 'Page', 'app/page.tsx').how, 'Next.js page');
});

test('facts: Next.js apps are found by a next dependency or a next.config, per package root', () => {
  const files = {
    'package.json': JSON.stringify({ name: 'root', private: true }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '15.0.0' } }),
    'apps/docs/package.json': JSON.stringify({ name: 'docs', devDependencies: { next: '15.0.0' } }),
    'apps/legacy/next.config.mjs': 'export default {};\n',
    'packages/ui/package.json': JSON.stringify({ name: 'ui', dependencies: { react: '19' } }),
    'node_modules/next/package.json': JSON.stringify({ name: 'next' }),
  };
  const { gatherEntryFacts } = require('../src/engine/entry-facts');
  const { facts } = gatherEntryFacts({
    repo: '/r', languages: new Set(['ts']), readRel: (rel) => files[rel] ?? null,
    git: { tryRaw: () => Object.keys(files).join('\0') },
  });
  assert.deepEqual([...facts.nextRoots].sort(), ['apps/docs', 'apps/legacy', 'apps/web']);
  assert.ok(facts.packageRoots.has('') && facts.packageRoots.has('packages/ui'));
  // A repository with no next at all has an empty set: the new rules never fire.
  const none = gatherEntryFacts({ repo: '/r', languages: new Set(['ts']), readRel: (rel) => (rel === 'package.json' ? '{}' : null), git: { tryRaw: () => 'package.json' } });
  assert.equal(none.facts.nextRoots.size, 0);
});

test('entry facts: an unknown language key is an error, not an empty answer', () => {
  const { gatherEntryFacts } = require('../src/engine/entry-facts');
  const git = { tryRaw: () => 'package.json' };
  assert.throws(() => gatherEntryFacts({ repo: '/r', git, languages: new Set(['typescript']), readRel: () => '{}' }), /unknown language 'typescript'/);
});
