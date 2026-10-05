'use strict';
// The session owns every analysis: the newest request wins, a replaced or abandoned run
// publishes nothing, a checkout waits for the run it cancels, and nothing escapes after
// deactivation. Each scenario drives the real activate() and commands; every interleaving
// is produced by hand-released gates (docs/CODING_STYLE.md sections 5 and 10). The one
// timer, the prewarm delay in activate(), is advanced by node:test's mock clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pull, localResult, finding, withEnv, refusals } = require('./extension-env');

const flush = () => new Promise(setImmediate);
const rootRows = (env) => env.tree().getChildren();
const rootLabels = async (env) => (await rootRows(env)).map((n) => n.label);
// The view's message, which the extension sets whenever the tree repaints.
const messageOf = (env) => env.view().message;
const decorationAt = (env, file, pos) => env.decorations().provideFileDecoration(env.vscode.Uri.file(file).with({ fragment: String(pos) }));
const PREVIEW_ROW = /^Preview — PR files only/;

test('1. a newer refresh replaces an older one, whose late result, decorations and error never appear', async (t) => {
  for (const ending of ['result', 'error']) {
    await t.test(`the older run ends last with a ${ending}`, () => withEnv(async (env) => {
      const older = [finding('older', path.join(env.dir, 'old.ts'), 11), finding('olderToo', path.join(env.dir, 'old.ts'), 40)];
      const newer = finding('newer', path.join(env.dir, 'new.ts'), 22);
      env.hooks.localResult = (o, call) => (call === 1
        ? localResult(o, { baseRef: 'older-base', findings: older })
        : localResult(o, { baseRef: 'newer-base', findings: [newer] }));
      const first = env.holds.analyze.next();
      const olderRun = env.refresh();
      await first.reached;
      const second = env.holds.analyze.next();
      const newerRun = env.refresh();
      await second.reached;
      assert.equal(env.seen.signals[0]?.aborted, true, 'the older run was told to stop');
      assert.equal(env.seen.signals[1]?.aborted, false);

      second.release();
      await newerRun;
      if (ending === 'result') first.release(); else first.fail(new Error('older run blew up'));
      await olderRun;

      assert.deepEqual((await env.changeRows()).map((n) => n.label), ['newer']);
      assert.match(messageOf(env), /against newer-base /);
      assert.equal(decorationAt(env, older[0].file, older[0].namePos), undefined, 'no decoration of the older result');
      assert.notEqual(decorationAt(env, newer.file, newer.namePos), undefined);
      assert.deepEqual(env.seen.errors, []);
      assert.equal(env.seen.status.length, 1, 'one status-bar message, from the newer run');
      assert.match(env.seen.status[0], /base newer-base/);
      assert.ok(!env.seen.log.some((m) => /older-base|older run blew up/.test(m)), 'no log line claims the older run');
    }));
  }
});

test('2. selectMode during a run produces a result in the newly selected mode', async (t) => {
  for (const [from, to] of [['pr', 'branch'], ['pr', 'working']]) {
    await t.test(`${from} -> ${to}`, () => withEnv(async (env) => {
      const first = env.holds.analyze.next();
      const running = env.analyseLocally(from);
      await first.reached;
      await env.selectMode(to);
      first.release();
      await running;
      assert.deepEqual(env.seen.analyze.map((a) => a.mode), [from, to]);
      assert.match(messageOf(env), new RegExp(`^${to} mode against `), 'the view shows the selected mode');
      assert.deepEqual(env.seen.errors, []);
    }));
  }
});

test('3. computeTestReach during a run produces a result with test reachability computed', async (t) => {
  for (const order of ['older ends first', 'older ends last']) {
    await t.test(order, () => withEnv(async (env) => {
      env.hooks.localResult = (o) => localResult(o, { findings: [finding('target', path.join(env.dir, 'a.ts'), 5)] });
      const first = env.holds.analyze.next();
      const running = env.refresh();
      await first.reached;
      const second = env.holds.analyze.next();
      const reach = env.computeTestReach();
      await second.reached;
      if (order === 'older ends first') { first.release(); await running; second.release(); await reach; } else { second.release(); await reach; first.release(); await running; }
      const [row] = await env.changeRows();
      const testsRow = (await env.tree().getChildren(row)).at(-1);
      assert.notEqual(testsRow.label, 'Compute test reachability', 'the shown result has its test reach computed');
    }));
  }
});

test('4. a local refresh during a PR preview gives a local result, and the reverse', async (t) => {
  await t.test('local during a preview', () => withEnv(async (env) => {
    const remote = env.holds.remote.next();
    const preview = env.preview(pull(7));
    await remote.reached;
    await env.analyseLocally('pr');
    remote.release();
    await preview;
    assert.equal(env.seen.analyze.length, 1, 'the local analysis ran');
    assert.ok(!(await rootLabels(env)).some((l) => PREVIEW_ROW.test(l)), 'the preview did not take over the view');
    assert.match(messageOf(env), /^pr mode against /);
    await env.refresh();
    assert.deepEqual(env.seen.remote, [7], 'Refresh now follows the local analysis');
    assert.deepEqual(env.seen.errors, []);
  }));
  await t.test('a preview during a local run', () => withEnv(async (env) => {
    const local = env.holds.analyze.next();
    const running = env.refresh();
    await local.reached;
    await env.preview(pull(7));
    local.release();
    await running;
    assert.deepEqual(env.seen.remote, [7], 'the preview ran');
    assert.ok((await rootLabels(env)).some((l) => PREVIEW_ROW.test(l)), 'the preview is what is shown');
    assert.deepEqual(refusals(env, /already running/), []);
    assert.deepEqual(env.seen.errors, []);
  }));
});

test('5. a checkout started during an analysis cancels it, and git waits until it has settled', async (t) => {
  const cases = [['a local Refresh', 'analyze', (env) => env.refresh()], ['a PR preview', 'remote', (env) => env.preview(pull(9))]];
  for (const [name, gate, begin] of cases) {
    await t.test(`during ${name}`, () => withEnv(async (env) => {
      const held = env.holds[gate].next();
      const analysis = begin(env);
      await held.reached;
      const checkout = env.openPullRequest(pull(7), 'analyse');   // confirmed at once
      await flush(); await flush();
      assert.deepEqual(refusals(env, /PR #7/), [], 'the checkout was not refused');
      assert.deepEqual(env.git.calls, [], 'no git command runs while the analysis is still running');
      assert.equal(env.seen.signals[0]?.aborted, true, 'the running analysis was cancelled');

      held.release();
      await analysis;
      await checkout;
      assert.deepEqual(env.git.fetches, [7]);
      assert.equal(env.git.checkouts.length, 1);
      assert.deepEqual(env.seen.analyze.at(-1), { mode: 'pr', base: 'base7' }, 'then the checkout\'s own analysis ran');
      assert.equal(env.seen.status.length, 1, 'only the post-checkout analysis published');
      assert.ok(!(await rootLabels(env)).some((l) => PREVIEW_ROW.test(l)));
      assert.deepEqual(env.seen.errors, []);
    }));
  }
});

test('6. every analysis requested during a checkout is refused with a visible warning', () => withEnv(async (env) => {
  const fetch = env.holds.fetch.next();
  const checkout = env.openPullRequest(pull(7), 'analyse');
  await fetch.reached;

  await env.refresh();
  await env.preview(pull(9));
  await env.analyseLocally('branch');
  await env.selectMode('working');
  await env.computeTestReach();
  assert.equal(refusals(env, /#7.*being checked out/).length, 5, 'each request was refused with a reason');
  assert.deepEqual(env.seen.analyze, []);
  assert.deepEqual(env.seen.remote, []);

  fetch.release();
  await checkout;
  assert.deepEqual(env.seen.analyze, [{ mode: 'pr', base: 'base7' }]);
}));

test('7. a lazy expansion that resolves after a newer analysis returns no rows and registers no decorations', async (t) => {
  for (const newer of ['still running', 'finished']) {
    await t.test(`the newer analysis is ${newer}`, () => withEnv(async (env) => {
      // The change's own caller is in the result; expanding that caller row queries the resolver.
      const user = { label: 'user', file: path.join(env.dir, 'u.ts'), pos: 3, test: false, callSites: [], sites: 0 };
      const target = { ...finding('target', path.join(env.dir, 'a.ts'), 5), callers: [user] };
      env.hooks.localResult = (o) => localResult(o, { findings: [target] });
      await env.refresh();
      const callerRowOf = async () => (await env.tree().getChildren((await env.changeRows())[0]))[0];
      const row = await callerRowOf();
      assert.deepEqual([row.type, row.label], ['caller', 'user']);

      const query = env.holds.callers.next();
      const expansion = env.tree().getChildren(row);
      await query.reached;
      const held = env.holds.analyze.next();
      const next = env.refresh();
      await held.reached;
      if (newer === 'finished') { held.release(); await next; }

      const caller = { label: 'caller', file: path.join(env.dir, 'b.ts'), pos: 7, test: false, callSites: [], sites: 0 };
      query.release({ callers: [caller], complete: true });
      assert.deepEqual(await expansion, [], 'the stale expansion shows nothing');
      assert.equal(decorationAt(env, caller.file, caller.pos), undefined, 'and decorates nothing');
      if (newer === 'still running') { held.release(); await next; }

      // A fresh expansion of the current result still works.
      const again = env.holds.callers.next();
      const current = env.tree().getChildren(await callerRowOf());
      await again.reached;
      again.release({ callers: [caller], complete: true });
      assert.deepEqual((await current).map((n) => n.label), ['caller']);
      assert.notEqual(decorationAt(env, caller.file, caller.pos), undefined);
    }));
  }
});

test('8. prewarm running during a PR preview does not change the displayed phase', async (t) => {
  for (const warmUp of ['succeeds', 'fails']) {
    await t.test(`the warm-up ${warmUp}`, async (t2) => {
      t2.mock.timers.enable({ apis: ['setTimeout'] });
      await withEnv(async (env) => {
        const remote = env.holds.remote.next();
        const preview = env.preview(pull(7));
        await remote.reached;
        assert.deepEqual(await rootLabels(env), ['Analysing…']);

        const warm = env.holds.warmUp.next();
        t2.mock.timers.tick(2000);              // activate() schedules prewarm two seconds in
        await warm.reached;
        assert.deepEqual(await rootLabels(env), ['Analysing…'], 'prewarm did not take over the phase');
        if (warmUp === 'succeeds') warm.release(true); else warm.fail(new Error('server went away'));
        await flush();
        assert.deepEqual(await rootLabels(env), ['Analysing…'], 'nor did its end');

        remote.release();
        await preview;
        assert.ok((await rootLabels(env)).some((l) => PREVIEW_ROW.test(l)));
        assert.deepEqual(env.seen.errors, [], 'a prewarm failure is not an analysis error');
        if (warmUp === 'fails') assert.ok(env.seen.log.some((m) => /prepare failed: server went away/.test(m)), 'it is logged');
      }, { prewarm: true, changedSource: true });
    });
  }
});

test('8b. a prewarm on its own shows Preparing, and Ready once it ends, even when it fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withEnv(async (env) => {
    const warm = env.holds.warmUp.next();
    t.mock.timers.tick(2000);
    await warm.reached;
    assert.deepEqual(await rootLabels(env), ['Preparing…']);
    warm.fail(new Error('server went away'));
    await flush();
    assert.deepEqual(await rootLabels(env), ['Ready — click to analyse']);
    assert.deepEqual(env.seen.errors, []);
  }, { prewarm: true, changedSource: true });
});

test('9. deactivating during a run publishes nothing and shows no error', async (t) => {
  const cases = [
    ['a local run that then returns', 'analyze', (env) => env.refresh(), (g) => g.release()],
    ['a local run that then fails', 'analyze', (env) => env.refresh(), (g) => g.fail(new Error('late failure'))],
    ['a PR preview that then returns', 'remote', (env) => env.preview(pull(7)), (g) => g.release()],
    ['a PR preview that then fails', 'remote', (env) => env.preview(pull(7)), (g) => g.fail(new Error('late failure'))],
  ];
  for (const [name, gate, begin, end] of cases) {
    await t.test(name, () => withEnv(async (env) => {
      const held = env.holds[gate].next();
      const running = begin(env);
      await held.reached;
      const logged = env.seen.log.length;
      env.deactivate();
      end(held);
      await running;
      assert.deepEqual(env.seen.errors, []);
      assert.deepEqual(env.seen.status, []);
      assert.deepEqual(env.seen.log.slice(logged), [], 'nothing is logged after deactivation');
      assert.equal(env.seen.signals[0]?.aborted, true, 'deactivation cancelled the run');
    }));
  }
});

test('10. an older run\'s finally never changes the state of a newer run', async (t) => {
  for (const ending of ['returns', 'fails']) {
    await t.test(`the older run ${ending} while the newer one runs`, () => withEnv(async (env) => {
      const first = env.holds.analyze.next();
      const olderRun = env.refresh();
      await first.reached;
      const second = env.holds.analyze.next();
      const newerRun = env.analyseLocally('branch');
      await second.reached;

      if (ending === 'returns') first.release(); else first.fail(new Error('older failed'));
      await olderRun;
      assert.deepEqual(await rootLabels(env), ['Analysing…'], 'the newer run is still shown as running');

      second.release();
      await newerRun;
      assert.match(messageOf(env), /^branch mode against /);
      assert.deepEqual(env.seen.errors, []);
    }));
  }
});

test('11. a throw from repoRoot() or resolver.clear() is a failed run, not an unhandled rejection', async (t) => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  await t.test('no workspace folder', () => withEnv(async (env) => {
    const folders = env.vscode.workspace.workspaceFolders;
    env.vscode.workspace.workspaceFolders = [];
    await env.refresh();
    assert.equal(env.seen.errors.length, 1);
    assert.match(env.seen.errors[0], /no workspace folder open/);
    assert.deepEqual(await rootLabels(env), ['Impact Tree: no workspace folder open'], 'the view shows the failure');
    env.vscode.workspace.workspaceFolders = folders;
    await env.refresh();
    assert.equal(env.seen.analyze.length, 1, 'the failed run released the session');
  }));
  await t.test('the resolver cannot be cleared', () => withEnv(async (env) => {
    env.hooks.clearResolver = () => { throw new Error('clear exploded'); };
    await env.refresh();
    assert.deepEqual(env.seen.errors, ['Impact Tree: clear exploded']);
    assert.deepEqual(env.seen.analyze, []);
    env.hooks.clearResolver = () => {};
    await env.refresh();
    assert.equal(env.seen.analyze.length, 1, 'the failed run released the session');
  }));
  await flush();
  assert.deepEqual(unhandled, []);
});
