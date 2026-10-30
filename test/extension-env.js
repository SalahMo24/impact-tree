'use strict';
// The extension loaded against a throwaway repository, with only its edges faked: the
// two analysers and the network-facing async calls. Shared by the command and lifecycle
// tests so both drive the real activate() and commands through one stub.
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');
const { clearVirtualText } = require('../src/engine/textpos');

const { createPage, createFormPage } = require('./webview-page');

const SRC = path.resolve(__dirname, '../src');
const baseStub = require('./vscode-stub');

const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
};

// A queue of gates. `next()` makes the following call to `enter()` stop until the test
// releases (or fails) it; `reached` says that the call got that far.
function gates() {
  const queue = [];
  return {
    next() {
      const reached = deferred(), gate = deferred();
      queue.push({ reached, gate });
      return { reached: reached.promise, release: (v) => gate.resolve(v), fail: (e) => gate.reject(e) };
    },
    enter(passThrough) {
      const g = queue.shift();
      if (!g) return passThrough();
      g.reached.resolve();
      return g.gate.promise;
    },
  };
}

// The Go change `changedSource: 'go'` commits, and the symbols the language server gives
// for it by default (ServerSymbols: a type first, so the warm-up must skip to the function).
const GO_SOURCE = 'package a\n\ntype T struct{}\n\nfunc Warm() int { return 1 }\n';
const goSymbol = (name, kind, declaration) => {
  const start = GO_SOURCE.indexOf(declaration);
  const at = GO_SOURCE.indexOf(name, start);
  return { name, detail: '', kind, range: { start, end: start + declaration.length }, selectionRange: { start: at, end: at + name.length }, children: [] };
};
const GO_SYMBOLS = [goSymbol('T', 23, 'type T struct{}'), goSymbol('Warm', 12, 'func Warm() int { return 1 }')];

// The Python change `changedSource: 'python'` commits; its symbols are set per test through
// `hooks.serverSymbols` (the one symbols hook of the fake services, for every language).
const PY_SOURCE = 'class T:\n    x = 1\n\n    def warm(self):\n        return 1\n';
const PY_SYMBOLS = [
  { name: 'T', detail: '', kind: 5, range: { start: 0, end: PY_SOURCE.length - 1 }, selectionRange: { start: 6, end: 7 }, children: [
    { name: 'warm', detail: '', kind: 6, range: { start: 24, end: PY_SOURCE.length - 1 }, selectionRange: { start: PY_SOURCE.indexOf('warm'), end: PY_SOURCE.indexOf('warm') + 4 }, children: [] },
  ] },
];

// The Java change `changedSource: 'java'` commits; its symbols are set per test through
// `hooks.serverSymbols`. jdtls lists a method as its type's child, after the type's fields.
const JAVA_SOURCE = 'class T {\n  int x = 1;\n\n  int warm() {\n    return 1;\n  }\n}\n';
const JAVA_SYMBOLS = [
  { name: 'T', detail: '', kind: 5, range: { start: 0, end: JAVA_SOURCE.length - 1 }, selectionRange: { start: 6, end: 7 }, children: [
    { name: 'x', detail: ' : int', kind: 8, range: { start: 12, end: 22 }, selectionRange: { start: 16, end: 17 }, children: [] },
    { name: 'warm()', detail: ' : int', kind: 6, range: { start: 26, end: JAVA_SOURCE.length - 2 }, selectionRange: { start: JAVA_SOURCE.indexOf('warm'), end: JAVA_SOURCE.indexOf('warm') + 4 }, children: [] },
  ] },
];

const shaFor = (n) => String(n).repeat(40).slice(0, 40);
const pull = (n) => ({ number: n, headRef: `head${n}`, baseRef: `base${n}`, title: `PR ${n}`, url: `https://example.test/${n}` });

// A local result shaped by the request it answers: its mode, and whether test reach was asked for.
const localResult = (request = {}, { baseRef = 'main', findings = [] } = {}) => ({
  mode: request.mode || 'pr', requestedMode: request.mode || 'pr', base: { ref: baseRef, sha: 'HEAD' }, changedFileCount: 0,
  findings, warnings: [], allChanged: findings, components: [], changedPaths: [], otherFiles: [], deleted: [],
  untested: [], unanalysable: [], changedRanges: {}, testReachComputed: request.deferTestReach === false });
// A changed symbol whose signature changed, so it is listed under Findings.
const finding = (label, file, namePos) => ({ label, file, namePos, relPath: path.basename(file), startLine: 1,
  kinds: [{ id: 'signature' }], staleCallers: 0, callerState: 'resolved', score: 1, callers: [], stale: [] });
const previewResult = (pr) => ({ tierA: true, pr, prNumber: pr.number, headSha: `head-of-${pr.number}`, base: { ref: 'main', sha: 'merge' },
  mode: 'pr-preview', changedFileCount: 0, findings: [], warnings: [], allChanged: [], changedPaths: [], otherFiles: [], changedRanges: {},
  deleted: [], unanalysable: [], untested: [], texts: new Map(), resolver: null });

// VS Code's comments API (`vscode.comments`), as much of it as the extension uses. A
// controller keeps every thread created through it, by the extension or by the user
// starting a comment (`startDraft`, which is what VS Code does when "+" is clicked: an
// empty thread of the controller over the picked lines). A thread's fields are plain,
// writable properties, as on the real object; disposing the controller disposes its
// threads. `submit` plays a comment box's button: the box holds the text, the button runs
// its command with `{ thread, text }`, and the box is cleared only when the command
// completes, so a command that rejects leaves the text in the box.
function createCommentsApi() {
  const controllers = [];
  const api = {
    createCommentController(id, label) {
      const controller = {
        id, label, options: undefined, commentingRangeProvider: undefined, threads: [], disposed: false,
        createCommentThread(uri, range, comments) {
          const thread = {
            uri, range, comments, collapsibleState: undefined, canReply: true, contextValue: undefined,
            label: undefined, state: undefined, disposed: false, input: '',
            dispose() { this.disposed = true; },
          };
          controller.threads.push(thread);
          return thread;
        },
        dispose() {
          this.disposed = true;
          for (const thread of this.threads) thread.dispose();
        },
      };
      controllers.push(controller);
      return controller;
    },
  };
  return {
    api, controllers,
    /** The live (not disposed) threads of a controller on a document. */
    threadsOn: (controller, uri) => controller.threads.filter((t) => !t.disposed && t.uri.toString() === uri.toString()),
    startDraft: (controller, uri, range) => controller.createCommentThread(uri, range, []),
    async submit(runCommand, command, thread, text) {
      if (thread.disposed) return { sent: false, error: new Error('The comment thread is disposed') };
      thread.input = text;
      try {
        await runCommand(command, { thread, text });
      } catch (error) {
        return { sent: false, error };
      }
      thread.input = '';
      return { sent: true };
    },
  };
}

// A webview panel as VS Code gives one: options split onto the webview, `html` kept and
// run through the form-page DOM (so the page's own script runs and its messages reach the
// extension), and `dispose()` firing onDidDispose once, as closing the tab does. Setting
// `html` after disposal throws, as VS Code does. `send` delivers a message as the page
// would; `posted` records what the extension posted to the page.
function fakeWebviewPanel(viewType, title, showOptions, options = {}) {
  const disposable = () => ({ dispose() {} });
  const received = [], disposed = [];
  let html = '';
  const state = { value: null };
  const panel = {
    viewType, title, showOptions, options, viewColumn: 1, visible: true, active: true, disposed: false, reveals: 0, loads: 0,
    posted: [], page: null,
    webview: {
      options: { enableScripts: options.enableScripts, localResourceRoots: options.localResourceRoots },
      cspSource: 'vscode-webview://test',
      get html() { return html; },
      set html(value) {
        if (panel.disposed) throw new Error('Webview is disposed');
        html = value; panel.loads++;
        panel.page = createFormPage(html, (message) => { for (const handler of [...received]) handler(message); }, state);
      },
      // Delivered later, as VS Code does, to whichever document is loaded by then.
      postMessage: async (message) => {
        if (panel.disposed) return false;
        panel.posted.push(message);
        await null;
        if (panel.page && !panel.disposed) panel.page.receive(message);
        return true;
      },
      onDidReceiveMessage: (handler) => { received.push(handler); return { dispose() { const i = received.indexOf(handler); if (i >= 0) received.splice(i, 1); } }; },
    },
    reveal(_column, preserveFocus) { panel.reveals++; panel.revealFocus = !preserveFocus; panel.visible = true; panel.active = true; },
    onDidDispose: (handler) => { disposed.push(handler); return disposable(); },
    onDidChangeViewState: () => disposable(),
    send: (message) => Promise.all(received.map((handler) => handler(message))),
    listeners: () => received.length,
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true; panel.visible = false;
      for (const handler of disposed.splice(0)) handler();
    },
  };
  return panel;
}

// Builds the test repository in `dir`. createEnv copies the first one built for each option set.
function buildRepo(dir, sh, changedSource, remotes) {
  sh('init', '-q', '--initial-branch=main'); sh('config', 'user.name', 'Test'); sh('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'README.md'), 'test');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"include":["*.ts"]}');
  sh('add', '.'); sh('commit', '-qm', 'base');
  for (const [name, url] of remotes) sh('remote', 'add', name, url);
  if (changedSource === 'go') {
    sh('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/a\n\ngo 1.22\n');
    fs.writeFileSync(path.join(dir, 'a.go'), GO_SOURCE);
    sh('add', '.'); sh('commit', '-qm', 'feature');
  } else if (changedSource === 'python') {
    sh('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "a"\n');
    fs.writeFileSync(path.join(dir, 'a.py'), PY_SOURCE);
    sh('add', '.'); sh('commit', '-qm', 'feature');
  } else if (changedSource === 'java') {
    sh('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>\n');
    fs.writeFileSync(path.join(dir, 'T.java'), JAVA_SOURCE);
    sh('add', '.'); sh('commit', '-qm', 'feature');
  } else if (changedSource) {
    sh('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function warm() { return 1; }\n');
    sh('add', '.'); sh('commit', '-qm', 'feature');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(dir, 'node_modules', 'typescript'));
  }
}
const repoTemplates = new Map();

// Loads a fresh extension against a clean temp git repo. Only the edges are faked:
// the two analysers, the editor's language-server resolver, and the network-facing
// async git calls (fetch, rev-parse of FETCH_HEAD, checkout), so the worktree itself
// never moves. `changedSource` puts a committed TypeScript change on a feature branch,
// which is what readiness needs before it will warm the language server; `'go'` puts a
// Go change there instead (with `go.mod`), warmed through the resolver's `services`, whose
// answers a test sets in `hooks.serverAvailable` and `hooks.serverSymbols`. `clock` (a fake
// clock, test/fake-clock.js) is handed to activate() through its test seam, so the
// activation's timers and deadlines move only when the test advances it.
function createEnv({ prewarm = false, changedSource = false, memento = new Map(), signIn = null, graphql = null, settings = {},
  remotes = [['origin', 'https://github.com/example/repo.git']], authSession = null, fetch = null, clock = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ext-commands-'));
  const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const templateKey = JSON.stringify([changedSource, remotes]);
  if (repoTemplates.has(templateKey)) {
    fs.cpSync(repoTemplates.get(templateKey), dir, { recursive: true });
  } else {
    buildRepo(dir, sh, changedSource, remotes);
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ext-template-'));
    fs.cpSync(dir, copy, { recursive: true });
    repoTemplates.set(templateKey, copy);
    process.once('exit', () => fs.rmSync(copy, { recursive: true, force: true }));
  }

  const commands = new Map();
  // `contexts` holds the latest value of each context key the extension set; `revealed`
  // the rows the change view was asked to reveal, with their options; `statusBar` is the
  // extension's status bar item.
  // `executed` the commands run through `executeCommand`, with their arguments.
  // `statusBars` every status bar item created, in order (`statusBar` is the first, the
  // review progress); `panels` every webview panel created, in order.
  const seen = { warnings: [], errors: [], infos: [], log: [], status: [], modals: 0, analyze: [], remote: [], remoteSlugs: [], analyzeRemotes: [],
    signals: [], remoteImpactPaths: [], cardsCalls: [], progress: [], callerQueries: [], warmUps: [], warmUpAt: [], servicesAsked: [], analyzeOptions: [], contexts: {}, revealed: [], statusBar: null, statusBars: [], panels: [], executed: [],
    focus: 'editor', focusedRow: null, editorSpaces: 0 };
  // `fetchRemotes`: the remote each `fetch` named, in step with `fetches`.
  const git = { fetches: [], fetchRemotes: [], checkouts: [], calls: [] };
  const holds = { fetch: gates(), modal: gates(), remote: gates(), analyze: gates(), callers: gates(), warmUp: gates() };
  const failures = new Map();
  const hooks = { serverAvailable: () => ({ ok: true }), serverSymbols: () => GO_SYMBOLS, beforeCheckout: null, headOf: shaFor, remoteResult: (pr) => previewResult(pr), localResult: (o) => localResult(o),
    warm: !changedSource, clearResolver: () => {}, onCommand: null };
  const captured = { tree: null, view: null, cards: null, cardsView: null, decorations: null, checkbox: null, sources: null, webviews: new Map(),
    selection: [], cursor: [], treeVisibility: [], lenses: null };
  let fetchHead = null, quickPick = null;
  const comments = createCommentsApi();

  const disposable = () => ({ dispose() {} });
  const liveSettings = { ...settings };
  const configListeners = [];
  const cfg = { get: (name, fallback) => ({ prewarm, analyseOnStartup: false, fetchBase: false, ...liveSettings })[name] ?? fallback,
    update: async () => {} };
  const vscode = { ...baseStub, ConfigurationTarget: { Global: 1, Workspace: 2 }, ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 }, ViewColumn: { Active: -1, Beside: -2, One: 1 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(...args) { this.args = args; [this.start, this.end] = [{ line: args[0], character: args[1] }, { line: args[2], character: args[3] }]; } },
    OverviewRulerLane: { Center: 2 },
    // Unlike the shared stub's, this one delivers events, so a test can see a view refresh.
    EventEmitter: class {
      constructor() {
        const listeners = [];
        this.event = (listener) => { listeners.push(listener); return disposable(); };
        this.fire = (value) => { for (const listener of listeners) listener(value); };
        this.dispose = () => { listeners.length = 0; };
      }
    },
    languages: { registerCodeLensProvider: (selector, provider) => { captured.lenses = { selector, provider }; return disposable(); } },
    authentication: { getSession: async () => authSession },
    window: {
      createOutputChannel: () => ({ appendLine: (m) => seen.log.push(m), dispose() {}, show() {} }),
      registerFileDecorationProvider: (provider) => { captured.decorations = provider; return disposable(); },
      // The view object is kept, so a test reads the message and badge the extension sets on it.
      createTreeView: (id, options) => {
        // A test sets `selection` as the user's selection; `reveal` records what was asked.
        const view = { dispose() {}, visible: true, selection: [], onDidChangeCheckboxState: (handler) => { captured.checkbox = handler; return disposable(); },
          onDidChangeSelection: (handler) => { if (id === 'impactTree.sources') captured.selection.push(handler); return disposable(); },
          onDidChangeVisibility: (handler) => { if (id === 'impactTree.sources') captured.treeVisibility.push(handler); return disposable(); },
          reveal: async (row, options) => {
            // Opening the reviewed row when a review starts (select and focus both false) is
            // kept apart, so the reveals a test counts are the ones the reviewer asked for.
            if (options && options.select === false && options.focus === false) { (seen.hostReveals = seen.hostReveals || []).push(row); return; }
            seen.revealed.push({ row, options });
            if (options.focus) { seen.focus = 'tree'; seen.focusedRow = row; }
          } };
        // The Review view joins the sources rows and the review (review-sidebar.js): `tree` is the
        // review's own provider, `sidebar` the joined one.
        if (id === 'impactTree.sources') {
          captured.sidebar = options.treeDataProvider; captured.tree = options.treeDataProvider.reviewTree; captured.view = view;
          captured.sources = options.treeDataProvider;
        }
        return view;
      },
      // `progress` records each withProgress call: its options and every message reported to it.
      withProgress: async (options, fn) => {
        const record = { options, messages: [], settled: false };
        seen.progress.push(record);
        try { return await fn({ report: (m) => { if (m && m.message) record.messages.push(m.message); } }); } finally { record.settled = true; }
      },
      showQuickPick: async () => quickPick,
      showWarningMessage: async (message, options) => {
        if (options && options.modal) {
          seen.modals++;
          return holds.modal.enter(() => seen.modalAnswer ?? 'Check out');
        }
        seen.warnings.push(message);
        return undefined;
      },
      showErrorMessage: (m) => seen.errors.push(m),
      showInformationMessage: (m) => seen.infos.push(m),
      setStatusBarMessage: (m) => seen.status.push(m),
      createStatusBarItem: (alignment, priority) => {
        const item = { alignment, priority, text: '', visible: false, disposed: false,
          show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; this.visible = false; } };
        seen.statusBars.push(item);
        if (!seen.statusBar) seen.statusBar = item;
        return item;
      },
      createWebviewPanel: (...args) => {
        const panel = fakeWebviewPanel(...args);
        seen.panels.push(panel);
        return panel;
      },
      visibleTextEditors: [],
      activeTextEditor: undefined,
      onDidChangeTextEditorSelection: (handler) => { captured.cursor.push(handler); return disposable(); },
      onDidChangeActiveTextEditor: disposable,
      onDidChangeVisibleTextEditors: disposable,
      registerWebviewViewProvider: (id, provider) => { captured.webviews.set(id, provider); return disposable(); },
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); },
      executeCommand: async (name, ...args) => {
        if (name === 'setContext') { seen.contexts[args[0]] = args[1]; return undefined; }
        seen.executed.push([name, ...args]);
        if (hooks.onCommand) await hooks.onCommand(name, ...args);
        return [];
      } },
    env: { openExternal: async () => {} },
    comments: comments.api,
    workspace: { workspaceFolders: [{ uri: baseStub.Uri.file(dir) }], getConfiguration: () => cfg, onDidChangeWorkspaceFolders: disposable,
      onDidChangeConfiguration: (listener) => { configListeners.push(listener); return disposable(); },
      registerTextDocumentContentProvider: disposable,
      textDocuments: [], onDidOpenTextDocument: disposable, onDidCloseTextDocument: disposable,
      createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} }) },
  };

  const fakeRawAsync = async (args, _opts, realRawAsync) => {
    git.calls.push(args);
    const cmd = args[0];
    if (cmd === 'fetch') {
      git.fetchRemotes.push(args[1]);
      git.fetches.push(Number(/pull\/(\d+)\/head/.exec(args.join(' '))[1]));
      await holds.fetch.enter(() => undefined);
      if (failures.has('fetch')) throw failures.get('fetch');
      fetchHead = hooks.headOf(git.fetches.at(-1));
      return '';
    }
    if (cmd === 'rev-parse' && args.includes('FETCH_HEAD^{commit}')) {
      if (failures.has('rev-parse')) throw failures.get('rev-parse');
      if (!fetchHead) throw new Error('fatal: Needed a single revision');
      return `${fetchHead}\n`;
    }
    if (cmd === 'checkout') {
      if (hooks.beforeCheckout) hooks.beforeCheckout();
      if (failures.has('checkout')) throw failures.get('checkout');
      const ref = args.find((a) => a !== 'checkout' && !a.startsWith('-'));
      // FETCH_HEAD is a moving name, a sha is not: record what the worktree really lands on.
      git.checkouts.push({ ref, commit: ref === 'FETCH_HEAD' ? fetchHead : ref });
      return '';
    }
    return realRawAsync(args, _opts);
  };

  const originalLoad = Module._load;
  Module._load = function (name, parent, ...rest) {
    if (name === 'vscode') return vscode;
    let resolved = null;
    try { resolved = Module._resolveFilename(name, parent); } catch { /* not a file module */ }
    if (resolved === path.join(SRC, 'engine/analyze-remote.js')) {
      return { analyzeRemote: async ({ pr, slug, signal, onPrepared, impactPaths }) => {
        seen.remote.push(pr.number);
        seen.remoteImpactPaths.push(impactPaths);
        seen.remoteSlugs.push(slug);
        seen.signals.push(signal);
        if (hooks.remotePrepared) await onPrepared(hooks.remotePrepared(pr));
        await holds.remote.enter(() => undefined);
        return hooks.remoteResult(pr);
      } };
    }
    if (resolved === path.join(SRC, 'engine/analyze.js')) {
      return { ...originalLoad.call(this, name, parent, ...rest), analyze: async (_repo, o) => {
        seen.analyze.push({ mode: o.mode, base: o.base });
        seen.analyzeRemotes.push(o.remote);
        seen.analyzeOptions.push({ fetch: o.fetch, early: typeof o.onPrepared === 'function', impactPaths: o.impactPaths });
        seen.signals.push(o.signal);
        if (hooks.localPrepared) await o.onPrepared(hooks.localPrepared(o));
        await holds.analyze.enter(() => undefined);
        return hooks.localResult(o, seen.analyze.length);
      } };
    }
    // The cards engine (src/engine/cards.js, cards-remote.js), faked by `hooks.cardsEngine`: each
    // call is recorded in `seen.cardsCalls`, and the hook may hold or fail it. The real modules
    // are asked for only when no hook is set. Matched by the name the session requires.
    if (hooks.cardsEngine && parent && parent.filename && parent.filename.startsWith(path.join(SRC, 'session') + path.sep)
      && /^\.\.\/engine\/cards(-remote)?$/.test(name)) {
      return hooks.cardsEngine;
    }
    // The language-server resolver: its warm-up and its caller queries can be held, as a
    // slow server would, and like the real one it cannot be told to stop.
    if (resolved === path.join(SRC, 'session/resolver-vscode.js')) {
      return { createVscodeResolver: () => ({
        isWarm: () => hooks.warm,
        expectReload: () => { seen.reloads = (seen.reloads || 0) + 1; },
        warmUp: (file, pos) => { seen.warmUps.push(file); seen.warmUpAt.push({ file, pos }); return holds.warmUp.enter(() => true); },
        services: {
          available: async (languageId) => { seen.servicesAsked.push(['available', languageId]); return hooks.serverAvailable(); },
          documentSymbols: async (doc) => { seen.servicesAsked.push(['documentSymbols', doc.file, doc.side]); return hooks.serverSymbols(doc); },
        },
        clear: () => hooks.clearResolver(),
        stats: () => ({}),
        incoming: async () => [],
        incomingWithStatus: (file, pos) => {
          seen.callerQueries.push({ file, pos });
          return holds.callers.enter(() => ({ callers: [], complete: true }));
        },
      }) };
    }
    // The silent sign-in at startup, replaced when a test needs it to fail in a way the real
    // one cannot; GitHub's GraphQL endpoint, replaced when a test answers it (the review store
    // reads and writes through it). GitHub's HTTP client is always replaced: a test's own
    // `fetch`, or one that refuses, so no test reaches api.github.com (the PR list loads at
    // startup) and none depends on the network or on GitHub's answer to a made-up repository.
    if (resolved === path.join(SRC, 'github/github.js')) {
      const real = originalLoad.call(this, name, parent, ...rest);
      const client = fetch || offlineFetch;
      return { ...real, createGitHub: (vs, o) => ({ ...real.createGitHub(vs, { ...o, fetch: client }), ...(signIn ? { signIn } : {}), ...(graphql ? { graphql } : {}) }) };
    }
    if (resolved === path.join(SRC, 'engine/git.js')) {
      const real = originalLoad.call(this, name, parent, ...rest);
      return { ...real, makeGit: (repo) => {
        const g = real.makeGit(repo);
        return { ...g, rawAsync: (args, o) => fakeRawAsync(args, o, g.rawAsync) };
      } };
    }
    return originalLoad.call(this, name, parent, ...rest);
  };
  const reload = () => { for (const n of ['../src/extension', '../src/session/resolver-vscode']) delete require.cache[require.resolve(n)]; };
  reload();
  const extension = require('../src/extension');
  const context = { subscriptions: [], workspaceState: { get: (k) => memento.get(k), update: async (k, v) => { memento.set(k, v); } } };
  extension.activate(context, clock ? { clock } : undefined);

  const run = (name, ...args) => commands.get(name)(...args);
  return {
    /** The user changes an impactTree setting; the extension is told as the editor would. */
    changeSetting(name, value) {
      liveSettings[name] = value;
      for (const listener of configListeners) listener({ affectsConfiguration: (key) => key === `impactTree.${name}` || key === 'impactTree' });
    },
    seen, git, holds, hooks, vscode, dir, memento, run, comments,
    /** The comment controller the extension created with this id. */
    commentController: (id) => comments.controllers.find((c) => c.id === id),
    // The user ticks or unticks a row, as the tree view reports it.
    tick(node, on) {
      const state = on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      captured.checkbox({ items: [[node, state]] });
    },
    isTicked: (node) => captured.tree.getTreeItem(node).checkboxState === vscode.TreeItemCheckboxState.Checked,
    // Model Space being delivered to the focused control: the tree's checkbox event,
    // or a space typed into the editor. Native keyboard handling is VS Code's boundary.
    pressSpace() {
      if (seen.focus !== 'tree' || !seen.focusedRow) { seen.editorSpaces++; return; }
      const item = captured.tree.getTreeItem(seen.focusedRow);
      if (item.checkboxState === undefined) return;
      const on = item.checkboxState !== vscode.TreeItemCheckboxState.Checked;
      captured.checkbox({ items: [[seen.focusedRow, on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked]] });
    },
    tree: () => captured.tree,
    view: () => captured.view,
    // Collapses or shows the change view as VS Code does, firing its visibility event.
    setTreeVisible(visible) { captured.view.visible = visible; for (const handler of captured.treeVisibility) handler({ visible }); },
    // The change rows of every file the tree shows, in display order.
    async changeRows() {
      const rows = [];
      // A review with nothing to flag keeps its files in one collapsed "Browse all" row.
      const tops = [];
      for (const top of await captured.tree.getChildren()) {
        if (top.type === 'browse') tops.push(...await captured.tree.getChildren(top)); else tops.push(top);
      }
      for (const top of tops) {
        if (top.type === 'reviewFile') rows.push(...await captured.tree.getChildren(top));
      }
      return rows.filter((r) => r.type === 'finding');
    },
    sources: () => captured.sources,
    /** The Cards view's data provider and its tree view object. */
    cards: () => captured.cards,
    cardsView: () => captured.cardsView,
    // The user selects rows in the change view, as the view reports it.
    select(rows) {
      captured.view.selection = rows;
      for (const handler of captured.selection) handler({ selection: rows });
    },
    // The user puts the cursor on a 1-based line of a document; `kind` is how it moved.
    moveCursor(uri, line, { kind = vscode.TextEditorSelectionChangeKind.Keyboard, active = true } = {}) {
      const editor = { document: { uri }, selection: { active: { line: line - 1, character: 0 } } };
      if (active) { vscode.window.activeTextEditor = editor; seen.focus = 'editor'; }
      for (const handler of captured.cursor) handler({ textEditor: editor, selections: [editor.selection], kind });
    },
    // Opens the Details view as VS Code does: a fake webview that keeps the last HTML set and
    // counts the sets (`loads`), records what the extension posts to the page (`posted`), and
    // lets a test post a message as the page's script would, or hide and show the view.
    openDetails() {
      const listeners = [], shown = [];
      let html = '', page = null;
      const details = { loads: 0, posted: [] };
      Object.defineProperty(details, 'displayHtml', { get: () => page ? page.html() : html });
      const webview = { options: null, cspSource: 'vscode-webview://test',
        get html() { return html; }, set html(value) { html = value; details.loads++; page = createPage(html); },
        onDidReceiveMessage: (handler) => { listeners.push(handler); return disposable(); },
        postMessage: async (message) => { details.posted.push(message); if (page) page.receive(message); return true; } };
      const webviewView = { webview, visible: true, onDidDispose: () => disposable(),
        onDidChangeVisibility: (handler) => { shown.push(handler); return disposable(); } };
      captured.webviews.get('impactTree.details').resolveWebviewView(webviewView, {}, { isCancellationRequested: false });
      return Object.assign(details, { webview,
        send: (message) => Promise.all(listeners.map((handler) => handler(message))),
        setVisible(visible) { webviewView.visible = visible; for (const handler of shown) handler(); } });
    },
    // The CodeLens provider the extension registered, and the lenses it gives for a document.
    lensProvider: () => captured.lenses,
    lensesFor: (uri) => captured.lenses.provider.provideCodeLenses({ uri }),
    decorations: () => captured.decorations,
    failGit: (cmd, error) => failures.set(cmd, error),
    moveFetchHead: (sha) => { fetchHead = sha; },
    // The user picks an action for a PR in the sources view (showQuickPick reads the pick synchronously).
    openPullRequest(pr, id) { quickPick = { id }; return run('impactTree.openPullRequest', pr); },
    preview(pr) { quickPick = { id: 'preview' }; return run('impactTree.openPullRequest', pr); },
    refresh: () => run('impactTree.refresh'),
    analyseLocally: (mode) => run('impactTree.analyseMode', mode),
    selectMode(id) { quickPick = { id, label: require('../src/engine/mode-labels').modeLabel(id) }; return run('impactTree.selectMode'); },
    computeTestReach: () => run('impactTree.computeTestReach'),
    deactivate: () => extension.deactivate(),
    dispose() {
      context.subscriptions.forEach((s) => s.dispose());
      extension.deactivate();
      Module._load = originalLoad;
      reload();
      clearVirtualText();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** GitHub's HTTP client in a test that gave none: every request fails, as offline. */
async function offlineFetch(url) {
  throw new TypeError(`fetch failed: tests do not reach the network (${url})`);
}

async function withEnv(fn, options) {
  const env = createEnv(options);
  try { await fn(env); } finally { env.dispose(); }
}

const refusals = (env, pattern) => env.seen.warnings.filter((w) => pattern.test(w));

/**
 * GitHub's answer to the Pull Request tab's overview query (ImpactTreePullRequestOverview):
 * clean, no checks, reviewers or labels. A fake GraphQL transport answers that query
 * (and not the review's) with this, and keeps it out of the calls it asserts on.
 * @param {string} headOid The reviewed commit.
 */
const overviewAnswer = (headOid) => ({ repository: {
  mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerPermission: 'WRITE',
  pullRequest: {
    headRefOid: headOid, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    isMergeQueueEnabled: false, isInMergeQueue: false,
    labels: { totalCount: 0, nodes: [] }, assignees: { totalCount: 0, nodes: [] }, milestone: null, reviewRequests: { totalCount: 0, nodes: [] }, latestReviews: { totalCount: 0, nodes: [] },
  },
  object: { statusCheckRollup: null },
} });

module.exports = { GO_SOURCE, PY_SOURCE, PY_SYMBOLS, JAVA_SOURCE, JAVA_SYMBOLS, overviewAnswer, fakeWebviewPanel, deferred, gates, shaFor, pull, localResult, finding, previewResult, createEnv, withEnv, refusals, createCommentsApi };
