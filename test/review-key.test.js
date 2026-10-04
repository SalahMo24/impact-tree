'use strict';
// Which review a tick belongs to. A checked-out PR is its own review whatever the
// worktree's branch name says, a refresh repeats the PR's base, a `pr` run that falls
// back to `branch` is still the same review, and ticks made under the keys this
// replaces carry over. Driven through the real activate() and commands; the stored
// keys are only read where a test is about the old ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createReviewState } = require('../src/review-state');
const { pull, localResult, finding, withEnv } = require('./extension-env');
const { ts } = require('./bug-regressions-helpers');
const S = require('../src/engine/symbols').makeSymbols(ts);

const WARM = 'export function warm() { return 1; }\n';
const WARM_NAME_POS = WARM.indexOf('warm');
const onBranch = (base) => ({ ...pull(1), baseRef: base });

const rowOf = async (env) => {
  const sections = await env.tree().getChildren();
  const findings = sections.find((n) => n.type === 'section' && n.key === 'findings');
  return (await env.tree().getChildren(findings))[0];
};
const warmFinding = (env) => ({ ...finding('warm', path.join(env.dir, 'a.ts'), WARM_NAME_POS), throwsAdded: [], component: 'root' });
const showWarm = (env) => {
  env.hooks.localResult = (o) => localResult(o, { findings: [warmFinding(env)] });
};
// What a real checkout leaves behind: a detached HEAD, which the branch name cannot tell apart.
const detachOnCheckout = (env) => {
  env.hooks.beforeCheckout = () => execFileSync('git', ['checkout', '--detach', '-q'], { cwd: env.dir });
};
const checkOut = (env, pr) => env.openPullRequest(pr, 'analyse');
const storedKeys = (env) => [...env.memento.keys()];

test('a push clears an arrow function tick when its export or binding kind changes', async (t) => {
  for (const next of ['const f = () => 2;\n', 'export let f = () => 2;\n']) {
    await t.test(next.trim(), () => withEnv(async (env) => {
      const file = path.join(env.dir, 'a.ts');
      const base = 'export const f = () => 1;\n';
      let head = 'export const f = () => 2;\n';
      const commit = () => execFileSync('git', ['commit', '-qam', 'push'], { cwd: env.dir });
      fs.writeFileSync(file, head); commit();
      env.hooks.headOf = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.dir, encoding: 'utf8' }).trim();
      env.hooks.localResult = (o) => {
        const symbol = S.collect(ts.createSourceFile(file, head, ts.ScriptTarget.ES2021, true))[0];
        return { ...localResult(o, { findings: [{ ...finding('f', file, symbol.namePos), ...symbol, throwsAdded: [] }] }),
          fileStatus: { 'a.ts': 'modified' }, baseTexts: new Map([['a.ts', base]]) };
      };
      await checkOut(env, onBranch('main'));
      env.tick(await rowOf(env), true);
      assert.ok(env.isTicked(await rowOf(env)));
      head = next;
      fs.writeFileSync(file, head); commit();
      await checkOut(env, onBranch('main'));
      assert.ok(!env.isTicked(await rowOf(env)), 'the declaration changed, so the tick must clear');
    }, { changedSource: true }));
  }
});

test('two checked-out PRs keep separate ticks, and each keeps its own across a return', () => withEnv(async (env) => {
  showWarm(env); detachOnCheckout(env);
  const sameBase = (n) => ({ ...pull(n), baseRef: 'main' });

  await checkOut(env, sameBase(7));
  env.tick(await rowOf(env), true);
  assert.ok(env.isTicked(await rowOf(env)));

  await checkOut(env, sameBase(8));
  assert.ok(!env.isTicked(await rowOf(env)), 'PR 8 does not inherit the tick made on PR 7');
  env.tick(await rowOf(env), true);
  env.tick(await rowOf(env), false);

  await checkOut(env, sameBase(7));
  assert.ok(env.isTicked(await rowOf(env)), 'PR 7 still has its tick, untouched by PR 8');
}, { changedSource: true }));

test('a push to a checked-out PR keeps the ticks of rows whose content is unchanged', () => withEnv(async (env) => {
  showWarm(env);
  await checkOut(env, onBranch('main'));
  env.tick(await rowOf(env), true);

  env.hooks.headOf = () => '9'.repeat(40);
  await checkOut(env, onBranch('main'));
  assert.ok(env.isTicked(await rowOf(env)), 'the push did not touch this row, so it stays reviewed');
}, { changedSource: true }));

test('a push that changes a ticked row shows it unticked', () => withEnv(async (env) => {
  showWarm(env);
  await checkOut(env, onBranch('main'));
  env.tick(await rowOf(env), true);

  env.hooks.headOf = () => '9'.repeat(40);
  fs.writeFileSync(path.join(env.dir, 'a.ts'), 'export function warm() { return 2; }\n');
  execFileSync('git', ['commit', '-qam', 'push'], { cwd: env.dir });
  await checkOut(env, onBranch('main'));
  assert.ok(!env.isTicked(await rowOf(env)), 'the row changed, so it is reviewed again');
}, { changedSource: true }));

test('a refresh after Check out and analyse compares against the PR base, whatever it is', async (t) => {
  for (const base of ['base7', 'release/2.x', 'develop']) {
    await t.test(base, () => withEnv(async (env) => {
      await checkOut(env, onBranch(base));
      await env.refresh();
      await env.computeTestReach();
      assert.deepEqual(env.seen.analyze, [
        { mode: 'pr', base }, { mode: 'pr', base }, { mode: 'pr', base }],
      'the checkout, a plain refresh and a test-reach refresh all use the PR');
    }));
  }
});

test('picking a local mode leaves the checked-out PR: its base no longer applies', async (t) => {
  for (const pick of [(env) => env.analyseLocally('working'), (env) => env.selectMode('working')]) {
    await t.test(pick.toString().slice(0, 40), () => withEnv(async (env) => {
      await checkOut(env, onBranch('release/2.x'));
      await pick(env);
      await env.refresh();
      assert.deepEqual(env.seen.analyze.map((a) => a.base), ['release/2.x', 'main', 'main']);
    }));
  }
});

test('previewing another PR leaves the checkout, and a refresh follows the preview', () => withEnv(async (env) => {
  await checkOut(env, onBranch('release/2.x'));
  await env.preview(pull(9));
  await env.refresh();
  assert.deepEqual(env.seen.remote, [9, 9]);
  assert.equal(env.seen.analyze.length, 1, 'no further local analysis');
}));

test('ticks made in pr mode survive a refresh that falls back to branch', async (t) => {
  for (const [name, start] of [
    ['a local pr analysis', (env) => env.analyseLocally('pr')],
    ['a checked-out PR', (env) => checkOut(env, onBranch('main'))],
  ]) {
    await t.test(name, () => withEnv(async (env) => {
      showWarm(env);
      await start(env);
      env.tick(await rowOf(env), true);

      env.hooks.localResult = (o) => ({ ...localResult(o, { findings: [warmFinding(env)] }),
        mode: 'branch', requestedMode: o.mode });
      await env.refresh();
      assert.ok(env.isTicked(await rowOf(env)), 'the dirty worktree changed the diff, not the review');
    }, { changedSource: true }));
  }
});

// ---- migration -----------------------------------------------------------------------

const legacyKeys = (env, base) => ({
  shared: `impactTree.reviewed.v2:${env.dir}:HEAD:pr:${base}`,
  fallback: `impactTree.reviewed.v2:${env.dir}:feature:branch:${base}`,
});
// The ids a tick on the finding stores, taken from a run of the real code in a repository
// whose a.ts reads `source`; row identities do not depend on where the repository is.
const idsTickedFor = async (source) => {
  let ids = null;
  await withEnv(async (env) => {
    fs.writeFileSync(path.join(env.dir, 'a.ts'), source);
    showWarm(env);
    await env.refresh();
    env.tick(await rowOf(env), true);
    ids = [...env.memento.values()].flat();
  }, { changedSource: true });
  assert.ok(ids.length > 0, 'the tick was stored');
  return ids;
};

test('a tick under the old shared HEAD key shows on its unchanged row after the upgrade', async () => {
  const ids = await idsTickedFor(WARM);
  const memento = new Map();
  await withEnv(async (env) => {
    memento.set(legacyKeys(env, 'main').shared, ids);
    showWarm(env);
    await checkOut(env, onBranch('main'));
    assert.ok(env.isTicked(await rowOf(env)));
    assert.deepEqual(memento.get(legacyKeys(env, 'main').shared), ids, 'the old key is left as it was');
    assert.ok(storedKeys(env).length >= 2, 'the PR has a key of its own now');
  }, { changedSource: true, memento });
});

test('a row whose content changed after it was ticked shows unticked after the upgrade', () => idsTickedFor(WARM).then((ids) => withEnv(async (env) => {
  fs.writeFileSync(path.join(env.dir, 'a.ts'), 'export function warm() { return 2; }\n');
  env.memento.set(legacyKeys(env, 'main').shared, ids);
  showWarm(env);
  await checkOut(env, onBranch('main'));
  assert.ok(!env.isTicked(await rowOf(env)));
}, { changedSource: true })));

test('a tick under a fallback key still shows after the key change, and that key stays', () => idsTickedFor(WARM).then((ids) => withEnv(async (env) => {
  const { fallback } = legacyKeys(env, 'main');
  env.memento.set(fallback, ids);
  env.hooks.localResult = (o) => ({ ...localResult(o, { findings: [warmFinding(env)] }),
    mode: 'branch', requestedMode: 'pr' });
  await env.analyseLocally('pr');
  assert.ok(env.isTicked(await rowOf(env)));
  assert.deepEqual(env.memento.get(fallback), ids);
}, { changedSource: true })));

const SHA = 'a'.repeat(40);
const perHeadKey = (env) => `impactTree.reviewed.v2:${env.dir}:pr-checkout:1@${SHA}:pr:main`;

test('a tick under the per-head PR key shows on its unchanged row after the upgrade, and that key stays', () => idsTickedFor(WARM).then((ids) => withEnv(async (env) => {
  env.hooks.headOf = () => SHA;
  env.memento.set(perHeadKey(env), ids);
  showWarm(env);
  await checkOut(env, onBranch('main'));
  assert.ok(env.isTicked(await rowOf(env)));
  assert.deepEqual(env.memento.get(perHeadKey(env)), ids, 'the old key is left as it was');
}, { changedSource: true })));

test('the per-head key is tried before the shared HEAD key', () => idsTickedFor(WARM).then((ids) => withEnv(async (env) => {
  env.hooks.headOf = () => SHA;
  env.memento.set(perHeadKey(env), ids);
  env.memento.set(legacyKeys(env, 'main').shared, ['stale']);
  showWarm(env);
  await checkOut(env, onBranch('main'));
  assert.ok(env.isTicked(await rowOf(env)));
  assert.ok(!storedKeys(env).some((k) => k.endsWith(':pr-checkout:1:pr:main')
    && env.memento.get(k).includes('stale')), 'the shared key was not consulted');
}, { changedSource: true })));

test('an untick after migrating from the per-head key is not undone on reload', () => idsTickedFor(WARM).then((ids) => withEnv(async (env) => {
  env.hooks.headOf = () => SHA;
  env.memento.set(perHeadKey(env), ids);
  showWarm(env);
  await checkOut(env, onBranch('main'));
  env.tick(await rowOf(env), false);
  await checkOut(env, onBranch('main'));
  assert.ok(!env.isTicked(await rowOf(env)));
}, { changedSource: true })));

test('migrateFrom may list several keys: the first with stored ticks is copied', () => {
  const store = new Map([['impactTree.reviewed.b', ['b1']], ['impactTree.reviewed.c', ['c1']]]);
  const memento = { get: (k) => store.get(k), update: (k, v) => store.set(k, v) };
  const review = createReviewState(memento);
  review.configure('new', null, { migrateFrom: ['a', 'b', 'c'] });
  assert.deepEqual([review.isReviewed('b1'), review.isReviewed('c1')], [true, false]);
  assert.deepEqual(store.get('impactTree.reviewed.b'), ['b1'], 'the old keys are never written');
  assert.deepEqual(store.get('impactTree.reviewed.c'), ['c1']);
});

test('migration happens once: later ticks and clears belong to the new key alone', () => {
  const store = new Map([['impactTree.reviewed.old', ['a', 'b']]]);
  const memento = { get: (k) => store.get(k), update: (k, v) => store.set(k, v) };
  const review = createReviewState(memento);

  review.configure('new', null, { migrateFrom: 'old' });
  assert.deepEqual([review.isReviewed('a'), review.isReviewed('b'), review.isReviewed('c')], [true, true, false]);
  review.set('a', false);
  review.configure('elsewhere', null, { migrateFrom: 'old' });
  review.configure('new', null, { migrateFrom: 'old' });
  assert.deepEqual([review.isReviewed('a'), review.isReviewed('b')], [false, true], 'an untick is not undone by copying again');
  review.clear();
  review.configure('elsewhere', null);
  review.configure('new', null, { migrateFrom: 'old' });
  assert.equal(review.size(), 0, 'a cleared review stays cleared');
  assert.deepEqual(store.get('impactTree.reviewed.old'), ['a', 'b'], 'the old key is never written');
});

test('nothing is copied when the old key is empty, or the new key already has ticks', () => {
  const store = new Map([['impactTree.reviewed.new', ['x']], ['impactTree.reviewed.old', ['a']]]);
  const memento = { get: (k) => store.get(k), update: (k, v) => store.set(k, v) };
  const review = createReviewState(memento);
  review.configure('new', null, { migrateFrom: 'old' });
  assert.deepEqual([review.isReviewed('x'), review.isReviewed('a')], [true, false]);

  review.configure('fresh', null, { migrateFrom: 'absent' });
  assert.equal(review.size(), 0);
  assert.ok(!store.has('impactTree.reviewed.fresh'), 'nothing to copy, nothing stored');
});
