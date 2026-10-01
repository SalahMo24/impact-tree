'use strict';
// Command-level regressions for src/extension.js: concurrent checkouts, and Refresh
// after a failed PR preview. Every interleaving is produced by hand-resolved promises
// (docs/CODING_STYLE.md sections 5 and 10); nothing here sleeps or relies on timers.
const test = require('node:test');
const assert = require('node:assert/strict');
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

const localResult = () => ({ mode: 'pr', requestedMode: 'pr', base: { ref: 'main', sha: 'HEAD' }, changedFileCount: 0,
  findings: [], warnings: [], allChanged: [], components: [], changedPaths: [], otherFiles: [], deleted: [],
  untested: [], unanalysable: [], changedRanges: {} });
const previewResult = (pr) => ({ tierA: true, pr, prNumber: pr.number, headSha: `head-of-${pr.number}`, base: { ref: 'main', sha: 'merge' },
  changedFileCount: 0, findings: [], warnings: [], allChanged: [], changedPaths: [], otherFiles: [], changedRanges: {},
  texts: new Map(), resolver: null });

// Loads a fresh extension against a clean temp git repo. Only the edges are faked:
// the two analysers, and the network-facing async git calls (fetch, rev-parse of
// FETCH_HEAD, checkout), so the worktree itself never moves.
function createEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ext-commands-'));
  const sh = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  sh('init', '-q', '--initial-branch=main'); sh('config', 'user.name', 'Test'); sh('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'README.md'), 'test');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"include":["*.ts"]}');
  sh('add', '.'); sh('commit', '-qm', 'base');
  sh('remote', 'add', 'origin', 'https://github.com/example/repo.git');

  const commands = new Map();
  const seen = { warnings: [], errors: [], infos: [], log: [], modals: 0, analyze: [], remote: [] };
  const git = { fetches: [], checkouts: [], calls: [] };
  const holds = { fetch: gates(), modal: gates(), remote: gates(), analyze: gates() };
  const failures = new Map();
  const hooks = { beforeCheckout: null, remoteResult: (pr) => previewResult(pr) };
  let fetchHead = null, quickPick = null;

  const disposable = () => ({ dispose() {} });
  const cfg = { get: (name, fallback) => ({ prewarm: false, analyseOnStartup: false, fetchBase: false })[name] ?? fallback,
    update: async () => {} };
  const vscode = { ...baseStub, ConfigurationTarget: { Workspace: 2 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(...args) { this.args = args; } },
    OverviewRulerLane: { Center: 2 },
    authentication: { getSession: async () => null },
    window: {
      createOutputChannel: () => ({ appendLine: (m) => seen.log.push(m), dispose() {}, show() {} }),
      registerFileDecorationProvider: disposable,
      createTreeView: () => ({ dispose() {}, onDidChangeCheckboxState: disposable }),
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
      setStatusBarMessage() {},
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
      fetchHead = shaFor(git.fetches.at(-1));
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
      return { analyzeRemote: async ({ pr }) => {
        seen.remote.push(pr.number);
        await holds.remote.enter(() => undefined);
        return hooks.remoteResult(pr);
      } };
    }
    if (resolved === path.join(SRC, 'engine/analyze.js')) {
      return { ...originalLoad.call(this, name, parent, ...rest), analyze: async (_repo, o) => {
        seen.analyze.push({ mode: o.mode, base: o.base });
        await holds.analyze.enter(() => undefined);
        return localResult();
      } };
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
  const context = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
  extension.activate(context);

  const run = (name, ...args) => commands.get(name)(...args);
  return {
    seen, git, holds, hooks,
    failGit: (cmd, error) => failures.set(cmd, error),
    moveFetchHead: (sha) => { fetchHead = sha; },
    // The user picks an action for a PR in the sources view (showQuickPick reads the pick synchronously).
    openPullRequest(pr, id) { quickPick = { id }; return run('impactTree.openPullRequest', pr); },
    preview(pr) { quickPick = { id: 'preview' }; return run('impactTree.openPullRequest', pr); },
    refresh: () => run('impactTree.refresh'),
    analyseLocally: (mode) => run('impactTree.analyseMode', mode),
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

async function withEnv(fn) {
  const env = createEnv();
  try { await fn(env); } finally { env.dispose(); }
}

const refusals = (env, pattern) => env.seen.warnings.filter((w) => pattern.test(w));

test('Refresh after a failed PR preview previews the same PR again, not a local analysis', () => withEnv(async (env) => {
  let attempt = 0;
  env.hooks.remoteResult = (pr) => { if (++attempt === 1) throw new Error('The PR changed while its files were loading'); return previewResult(pr); };

  await env.openPullRequest(pull(7), 'preview');
  assert.deepEqual(env.seen.errors, ['Impact Tree: The PR changed while its files were loading']);
  assert.deepEqual(env.seen.remote, [7]);

  await env.refresh();
  assert.deepEqual(env.seen.remote, [7, 7], 'Refresh re-previews PR 7');
  assert.deepEqual(env.seen.analyze, [], 'the failed preview must not turn Refresh into a local analysis');
  assert.equal(env.seen.errors.length, 1, 'the retry succeeded, so no new error');
}));

test('Refresh retries the PR whose preview failed last, not an earlier successful one', () => withEnv(async (env) => {
  env.hooks.remoteResult = (pr) => { if (pr.number === 8) throw new Error('boom'); return previewResult(pr); };
  await env.openPullRequest(pull(7), 'preview');
  await env.openPullRequest(pull(8), 'preview');
  assert.deepEqual(env.seen.remote, [7, 8]);

  await env.refresh();
  assert.deepEqual(env.seen.remote, [7, 8, 8]);
  assert.deepEqual(env.seen.analyze, []);
}));

test('Refresh follows what is being viewed: PR preview, then local analysis, then local again', () => withEnv(async (env) => {
  await env.openPullRequest(pull(7), 'preview');
  await env.refresh();
  assert.deepEqual(env.seen.remote, [7, 7], 'Refresh of a successful preview re-previews it');
  assert.deepEqual(env.seen.analyze, []);

  await env.analyseLocally('pr');
  assert.equal(env.seen.analyze.length, 1, 'choosing a local mode leaves the preview');
  const remoteBefore = env.seen.remote.length;

  await env.refresh();
  assert.equal(env.seen.analyze.length, 2, 'Refresh after a local analysis is a local analysis');
  assert.equal(env.seen.remote.length, remoteBefore, 'and does not preview a PR any more');
  assert.deepEqual(env.seen.errors, []);
}));

test('Refresh with nothing opened yet runs a local analysis', () => withEnv(async (env) => {
  await env.refresh();
  assert.equal(env.seen.analyze.length, 1);
  assert.deepEqual(env.seen.remote, []);
  assert.deepEqual(env.seen.errors, []);
}));

test('a second checkout started while the first fetch is pending is refused and the first PR is the one reported', () => withEnv(async (env) => {
  const fetch = env.holds.fetch.next();
  const first = env.openPullRequest(pull(7), 'analyse');
  await fetch.reached;

  await env.openPullRequest(pull(8), 'analyse');
  assert.equal(refusals(env, /#7.*being checked out/).length, 1, 'the user is told why PR 8 did not start');
  assert.equal(env.seen.modals, 1, 'PR 8 never even asked for confirmation');
  assert.deepEqual(env.git.fetches, [7]);

  fetch.release();
  await first;

  assert.deepEqual(env.git.fetches, [7], 'only one fetch ever ran');
  assert.deepEqual(env.git.checkouts.map((c) => c.commit), [shaFor(7)], 'the worktree is on PR 7');
  assert.equal(env.seen.infos.length, 1);
  assert.match(env.seen.infos[0], /on PR #7\b/);
  assert.ok(env.seen.log.some((m) => /checked out PR #7 /.test(m)));
  assert.ok(!env.seen.log.some((m) => /PR #8\b/.test(m)), 'nothing is logged as PR 8');
  assert.deepEqual(env.seen.analyze, [{ mode: 'pr', base: 'base7' }], 'the post-checkout analysis is against PR 7');
  assert.deepEqual(env.seen.errors, []);
}));

test('Refresh and a PR preview requested during a checkout are refused until it finishes', () => withEnv(async (env) => {
  const fetch = env.holds.fetch.next();
  const checkout = env.openPullRequest(pull(7), 'analyse');
  await fetch.reached;

  await env.refresh();
  await env.preview(pull(9));
  assert.equal(refusals(env, /#7.*being checked out/).length, 2, 'both requests were refused with a warning');
  assert.deepEqual(env.seen.analyze, [], 'no local analysis ran under the moving worktree');
  assert.deepEqual(env.seen.remote, [], 'no preview ran during the checkout');

  fetch.release();
  await checkout;
  assert.deepEqual(env.seen.analyze, [{ mode: 'pr', base: 'base7' }], 'only the checkout\'s own analysis ran');
  assert.deepEqual(env.seen.remote, []);
}));

test('Refresh of a PR preview is refused during a checkout, and works again afterwards', () => withEnv(async (env) => {
  await env.preview(pull(5));
  assert.deepEqual(env.seen.remote, [5]);

  const fetch = env.holds.fetch.next();
  const checkout = env.openPullRequest(pull(7), 'analyse');
  await fetch.reached;
  await env.refresh();
  assert.deepEqual(env.seen.remote, [5], 'Refresh did not re-preview mid-checkout');
  assert.equal(refusals(env, /being checked out/).length, 1);

  fetch.release();
  await checkout;
  // The checkout moved the user to a local analysis, so Refresh now follows that.
  await env.refresh();
  assert.deepEqual(env.seen.remote, [5]);
  assert.equal(env.seen.analyze.length, 2);
}));

test('a checkout lands on the commit it fetched, even if FETCH_HEAD is rewritten before checkout', () => withEnv(async (env) => {
  const fetch = env.holds.fetch.next();
  const checkout = env.openPullRequest(pull(7), 'analyse');
  await fetch.reached;
  // Another fetch finishing at this moment would leave FETCH_HEAD at PR 99's head.
  env.hooks.beforeCheckout = () => env.moveFetchHead(shaFor(99));
  fetch.release();
  await checkout;

  assert.equal(env.git.checkouts.length, 1);
  assert.notEqual(env.git.checkouts[0].ref, 'FETCH_HEAD', 'the checkout does not name the moving FETCH_HEAD');
  assert.equal(env.git.checkouts[0].commit, shaFor(7), 'the worktree is on the commit that was fetched for PR 7');
}));

test('a failed fetch, resolve or checkout releases the checkout lock', async (t) => {
  for (const step of ['fetch', 'rev-parse', 'checkout']) {
    await t.test(`failing ${step}`, () => withEnv(async (env) => {
      env.failGit(step, new Error(`${step} went wrong`));
      await env.openPullRequest(pull(7), 'analyse');
      assert.equal(env.seen.errors.length, 1);
      assert.match(env.seen.errors[0], new RegExp(`checkout failed .* ${step} went wrong`));
      assert.deepEqual(env.seen.analyze, [], 'no analysis after a failed checkout');

      await env.refresh();
      assert.equal(env.seen.analyze.length, 1, 'Refresh is allowed again');
      await env.openPullRequest(pull(8), 'analyse');
      assert.deepEqual(refusals(env, /being checked out/), [], 'nothing is refused as "being checked out"');
      assert.equal(env.seen.modals, 2, 'the retry asked for confirmation again');
      assert.deepEqual(env.git.fetches, [7, 8]);
    }));
  }
});

test('a successful checkout releases the lock for the next checkout', () => withEnv(async (env) => {
  await env.openPullRequest(pull(7), 'analyse');
  await env.openPullRequest(pull(8), 'analyse');
  assert.deepEqual(refusals(env, /being checked out/), []);
  assert.deepEqual(env.git.checkouts.map((c) => c.commit), [shaFor(7), shaFor(8)]);
  assert.deepEqual(env.seen.analyze.map((a) => a.base), ['base7', 'base8']);
}));

test('a checkout is refused after its confirmation if an analysis started while the dialog was open', async (t) => {
  const cases = [
    ['a PR preview', 'remote', (env) => env.preview(pull(9))],
    ['a local Refresh', 'analyze', (env) => env.refresh()],
  ];
  for (const [name, gate, begin] of cases) {
    await t.test(`while ${name} runs`, () => withEnv(async (env) => {
      const modal = env.holds.modal.next();
      const checkout = env.openPullRequest(pull(7), 'analyse');
      await modal.reached;

      const analysis = env.holds[gate].next();
      const analysisDone = begin(env);
      await analysis.reached;                  // it is running now, under the open dialog

      const fetch = env.holds.fetch.next();    // lets a wrongly accepted checkout be observed instead of hanging
      modal.release('Check out');
      await Promise.race([checkout, fetch.reached]);

      assert.deepEqual(env.git.fetches, [], 'the confirmed checkout did not start');
      assert.deepEqual(env.git.checkouts, []);
      assert.equal(refusals(env, /analysis is running.*PR #7/).length, 1, 'the user is told why');

      analysis.release();
      await analysisDone;
      assert.deepEqual(env.seen.errors, []);
    }));
  }
});

test('of two checkouts whose dialogs are both open, the one confirmed first proceeds and the late one is refused', () => withEnv(async (env) => {
  const firstDialog = env.holds.modal.next();
  const first = env.openPullRequest(pull(7), 'analyse');
  await firstDialog.reached;
  const fetch = env.holds.fetch.next();
  const second = env.openPullRequest(pull(8), 'analyse');   // its dialog is answered at once: confirmed first
  await fetch.reached;                                      // PR 8 is mid-fetch

  firstDialog.release('Check out');                         // PR 7 is confirmed late
  await first;
  assert.equal(refusals(env, /#8.*being checked out/).length, 1, 'the late confirmation is refused with a reason');
  assert.deepEqual(env.git.fetches, [8], 'PR 7 never fetched');

  fetch.release();
  await second;
  assert.deepEqual(env.git.fetches, [8]);
  assert.deepEqual(env.git.checkouts.map((c) => c.commit), [shaFor(8)]);
  assert.match(env.seen.infos.at(-1), /on PR #8\b/);
  assert.deepEqual(env.seen.analyze, [{ mode: 'pr', base: 'base8' }]);
}));
