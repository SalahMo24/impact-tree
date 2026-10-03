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

// Loads a fresh extension against a clean temp git repo. Only the edges are faked:
// the two analysers, the editor's language-server resolver, and the network-facing
// async git calls (fetch, rev-parse of FETCH_HEAD, checkout), so the worktree itself
// never moves. `changedSource` puts a committed TypeScript change on a feature branch,
// which is what readiness needs before it will warm the language server.
function createEnv({ prewarm = false, changedSource = false, memento = new Map() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ext-commands-'));
  const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q', '--initial-branch=main'); sh('config', 'user.name', 'Test'); sh('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'README.md'), 'test');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"include":["*.ts"]}');
  sh('add', '.'); sh('commit', '-qm', 'base');
  sh('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  if (changedSource) {
    sh('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function warm() { return 1; }\n');
    sh('add', '.'); sh('commit', '-qm', 'feature');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(dir, 'node_modules', 'typescript'));
  }

  const commands = new Map();
  const seen = { warnings: [], errors: [], infos: [], log: [], status: [], modals: 0, analyze: [], remote: [],
    signals: [], callerQueries: [], warmUps: [] };
  const git = { fetches: [], checkouts: [], calls: [] };
  const holds = { fetch: gates(), modal: gates(), remote: gates(), analyze: gates(), callers: gates(), warmUp: gates() };
  const failures = new Map();
  const hooks = { beforeCheckout: null, headOf: shaFor, remoteResult: (pr) => previewResult(pr), localResult: (o) => localResult(o),
    warm: !changedSource, clearResolver: () => {} };
  const captured = { tree: null, decorations: null, checkbox: null };
  let fetchHead = null, quickPick = null;

  const disposable = () => ({ dispose() {} });
  const cfg = { get: (name, fallback) => ({ prewarm, analyseOnStartup: false, fetchBase: false })[name] ?? fallback,
    update: async () => {} };
  const vscode = { ...baseStub, ConfigurationTarget: { Workspace: 2 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(...args) { this.args = args; } },
    OverviewRulerLane: { Center: 2 },
    authentication: { getSession: async () => null },
    window: {
      createOutputChannel: () => ({ appendLine: (m) => seen.log.push(m), dispose() {}, show() {} }),
      registerFileDecorationProvider: (provider) => { captured.decorations = provider; return disposable(); },
      createTreeView: (id, options) => {
        if (id === 'impactTree.changes') captured.tree = options.treeDataProvider;
        return { dispose() {}, onDidChangeCheckboxState: (handler) => { captured.checkbox = handler; return disposable(); } };
      },
      withProgress: async (_, fn) => fn({ report() {} }),
      showQuickPick: async () => quickPick,
      showWarningMessage: async (message, options) => {
        if (options && options.modal) {
          seen.modals++;
          return holds.modal.enter(() => 'Check out');
        }
        seen.warnings.push(message);
        return undefined;
      },
      showErrorMessage: (m) => seen.errors.push(m),
      showInformationMessage: (m) => seen.infos.push(m),
      setStatusBarMessage: (m) => seen.status.push(m),
      visibleTextEditors: [],
    },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); }, executeCommand: async () => [] },
    env: { openExternal: async () => {} },
    workspace: { workspaceFolders: [{ uri: baseStub.Uri.file(dir) }], getConfiguration: () => cfg,
      registerTextDocumentContentProvider: disposable },
  };

  const fakeRawAsync = async (args, _opts, realRawAsync) => {
    git.calls.push(args);
    const cmd = args[0];
    if (cmd === 'fetch') {
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
      return { analyzeRemote: async ({ pr, signal }) => {
        seen.remote.push(pr.number);
        seen.signals.push(signal);
        await holds.remote.enter(() => undefined);
        return hooks.remoteResult(pr);
      } };
    }
    if (resolved === path.join(SRC, 'engine/analyze.js')) {
      return { ...originalLoad.call(this, name, parent, ...rest), analyze: async (_repo, o) => {
        seen.analyze.push({ mode: o.mode, base: o.base });
        seen.signals.push(o.signal);
        await holds.analyze.enter(() => undefined);
        return hooks.localResult(o, seen.analyze.length);
      } };
    }
    // The language-server resolver: its warm-up and its caller queries can be held, as a
    // slow server would, and like the real one it cannot be told to stop.
    if (resolved === path.join(SRC, 'resolver-vscode.js')) {
      return { createVscodeResolver: () => ({
        isWarm: () => hooks.warm,
        warmUp: (file) => { seen.warmUps.push(file); return holds.warmUp.enter(() => true); },
        clear: () => hooks.clearResolver(),
        stats: () => ({}),
        incoming: async () => [],
        incomingWithStatus: (file, pos) => {
          seen.callerQueries.push({ file, pos });
          return holds.callers.enter(() => ({ callers: [], complete: true }));
        },
      }) };
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
  const reload = () => { for (const n of ['../src/extension', '../src/resolver-vscode']) delete require.cache[require.resolve(n)]; };
  reload();
  const extension = require('../src/extension');
  const context = { subscriptions: [], workspaceState: { get: (k) => memento.get(k), update: async (k, v) => { memento.set(k, v); } } };
  extension.activate(context);

  const run = (name, ...args) => commands.get(name)(...args);
  return {
    seen, git, holds, hooks, vscode, dir, memento,
    // The user ticks or unticks a row, as the tree view reports it.
    tick(node, on) {
      const state = on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      captured.checkbox({ items: [[node, state]] });
    },
    isTicked: (node) => captured.tree.getTreeItem(node).checkboxState === vscode.TreeItemCheckboxState.Checked,
    tree: () => captured.tree,
    decorations: () => captured.decorations,
    failGit: (cmd, error) => failures.set(cmd, error),
    moveFetchHead: (sha) => { fetchHead = sha; },
    // The user picks an action for a PR in the sources view (showQuickPick reads the pick synchronously).
    openPullRequest(pr, id) { quickPick = { id }; return run('impactTree.openPullRequest', pr); },
    preview(pr) { quickPick = { id: 'preview' }; return run('impactTree.openPullRequest', pr); },
    refresh: () => run('impactTree.refresh'),
    analyseLocally: (mode) => run('impactTree.analyseMode', mode),
    selectMode(label) { quickPick = { label }; return run('impactTree.selectMode'); },
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

async function withEnv(fn, options) {
  const env = createEnv(options);
  try { await fn(env); } finally { env.dispose(); }
}

const refusals = (env, pattern) => env.seen.warnings.filter((w) => pattern.test(w));

module.exports = { deferred, gates, shaFor, pull, localResult, finding, previewResult, createEnv, withEnv, refusals };
