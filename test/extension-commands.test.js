'use strict';
// Command-level regressions for src/extension.js: concurrent checkouts, Refresh after a
// failed PR preview, and the change view's message and badge. Every interleaving is produced by hand-resolved promises
// (docs/CODING_STYLE.md sections 5 and 10); nothing here sleeps or relies on timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { shaFor, pull, previewResult, localResult, finding, withEnv, refusals } = require('./extension-env');

test('a failed silent sign-in is logged and leaves the signed-out sources view, with no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await withEnv(async (env) => {
      let refreshes = 0;
      env.sources().onDidChangeTreeData(() => { refreshes++; });
      await new Promise((resolve) => setImmediate(resolve));   // let the rejected sign-in settle
      assert.deepEqual(unhandled, []);
      assert.equal(env.seen.log.filter((m) => /github: sign-in failed: no keychain/.test(m)).length, 1);
      assert.equal(refreshes, 1, 'the sources view is refreshed once, as signed out');
    }, { signIn: async () => { throw new Error('no keychain'); } });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

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

// Admission is cancel and replace: a confirmed checkout cancels the analysis that started
// under its dialog, and git waits until that analysis has settled.
test('a checkout confirmed while an analysis runs cancels it, and fetches only once it has settled', async (t) => {
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

      modal.release('Check out');
      await new Promise(setImmediate);

      assert.deepEqual(env.git.fetches, [], 'nothing is fetched while the analysis is still running');
      assert.deepEqual(env.git.checkouts, []);
      assert.deepEqual(refusals(env, /PR #7/), [], 'the checkout is not refused');

      analysis.release();
      await analysisDone;
      await checkout;
      assert.deepEqual(env.git.fetches, [7], 'the checkout went ahead once the analysis settled');
      assert.deepEqual(env.git.checkouts.map((c) => c.commit), [shaFor(7)]);
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

test('the view message and badge follow a new result and every tick', () => withEnv(async (env) => {
  const a = path.join(env.dir, 'a.ts');
  env.hooks.localResult = (o) => localResult(o, { findings: [finding('one', a, 5), finding('two', a, 40)] });
  assert.equal(env.view().message, undefined, 'nothing is shown before an analysis');
  await env.refresh();
  assert.equal(env.view().message, 'pr mode against main · 0 need attention · 2 of 2 left');
  assert.deepEqual(env.view().badge, { value: 2, tooltip: '2 of 2 left to review' });
  const [file] = (await env.tree().getChildren()).filter((r) => r.type === 'reviewFile');
  env.tick(file, true);
  assert.equal(env.view().message, 'pr mode against main · 0 need attention · 0 of 2 left');
  assert.equal(env.view().badge, undefined);
  env.tick((await env.changeRows())[1], false);
  assert.deepEqual(env.view().badge, { value: 1, tooltip: '1 of 2 left to review' });
  assert.equal(env.isTicked(file), false, 'unticking a change unticks its file');
}));

test('checkbox refreshes preserve diff commands and diagnostics report the editor actually shown', () => withEnv(async (env) => {
  const file = path.join(env.dir, 'a.ts');
  require('fs').writeFileSync(file, 'export function one() { return 1; }\n');
  env.hooks.localResult = (o) => localResult(o, { findings: [finding('one', file, 5)] });
  env.vscode.window.tabGroups = { activeTabGroup: { activeTab: { input: null } } };
  env.hooks.onCommand = (command, original, modified) => {
    if (command === 'vscode.diff') env.vscode.window.tabGroups.activeTabGroup.activeTab.input = { original, modified };
  };
  await env.refresh();
  const [row] = await env.changeRows();
  for (const on of [true, false, true]) {
    env.tick(row, on);
    await env.run('impactTree.openChange', row);
  }
  const diffs = env.seen.executed.filter(([command]) => command === 'vscode.diff');
  assert.equal(diffs.length, 3);
  assert.ok(diffs.every(([, original, modified]) => original.scheme === 'impacttree-base' && modified.fsPath === file));
  assert.equal(env.seen.log.filter((m) => /completed diff.*active=diff/.test(m)).length, 3);
  assert.equal(env.seen.log.filter((m) => /checkbox: 1 row/.test(m)).length, 3);

  // A successful command promise alone does not prove the diff is the active editor.
  env.hooks.onCommand = () => {
    env.vscode.window.tabGroups.activeTabGroup.activeTab.input = { uri: env.vscode.Uri.file(file) };
  };
  await env.run('impactTree.openChange', row);
  assert.match(env.seen.log.at(-1), /completed diff.*active=file/);

  const failure = new Error('editor refused the diff');
  env.hooks.onCommand = (command) => { if (command === 'vscode.diff') throw failure; };
  await assert.rejects(env.run('impactTree.openChange', row), (error) => error === failure);
  assert.match(env.seen.log.at(-1), /failed diff: editor refused the diff/);
}));
