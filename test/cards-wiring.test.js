'use strict';
// The Cards view in the extension: off by default and then no view, no extra analysis option
// and no extra work; on, the local analysis asks for impact paths, cards appear when the
// analysis ends and merge hints later; hints of a replaced analysis never appear; a failure
// is a note on the view. The cards engine (AI2a) is faked through `hooks.cardsEngine`;
// every interleaving is produced by hand-released gates (docs/CODING_STYLE.md sections 5, 10).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pull, localResult, previewResult, finding, withEnv, gates } = require('./extension-env');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
const withCards = (fn) => withEnv(fn, { settings: { 'cards.enabled': true } });

// Four changes, so the view shows cards.
const four = (env) => [1, 2, 3, 4].map((n) => finding(`f${n}`, path.join(env.dir, `f${n}.ts`), n * 10));
const memberIds = (changes) => changes.map((c) => `${c.relPath}#${c.namePos}`);

// What the engine would return for `result`: two cards, the second holding the last change.
const cardsFor = (result) => {
  const ids = memberIds(result.allChanged);
  const card = (id, members) => ({ id, label: `card ${id}`, members, files: [], module: '(root)', joined: [], mirrorMembers: [], mirrorOf: null,
    moved: [], hub: false, siblings: false, generated: null, stats: { members: members.length, callers: 0, tests: 0, risky: 0, incomplete: 0 } });
  return { version: 1, clusters: [card('K1', ids.slice(0, 3)), card('K2', ids.slice(3))], sweeps: [], seams: [{ type: 'call', clusters: ['K1', 'K2'], via: [], viaCount: 0 }],
    hints: [], hintNotes: [], generatedDirs: [] };
};

/** A fake of src/engine/cards.js and cards-remote.js that records its calls in `env.seen.cardsCalls`. */
function fakeEngine(env, { hints = gates(), facts = gates() } = {}) {
  const calls = env.seen.cardsCalls;
  return {
    hints, facts,
    async gatherLocalCardFacts(args) { calls.push(['gatherLocal', args]); await facts.enter(() => undefined); return { from: 'local' }; },
    async gatherRemoteCardFacts(args) { calls.push(['gatherRemote', args]); await facts.enter(() => undefined); return { from: 'remote' }; },
    buildCardsFromFacts(result, given) { calls.push(['build', given]); return cardsFor(result); },
    async addHints(cards, given, options) {
      calls.push(['hints', options]);
      await hints.enter(() => undefined);
      return { ...cards, hints: [{ clusters: ['K1', 'K2'], strength: 2, evidence: [{ type: 'token', token: 'Shared' }] }] };
    },
  };
}

const roots = async (env) => env.cards().getChildren();
const labels = async (env) => (await roots(env)).map((n) => n.label);
const card = async (env, id) => (await roots(env)).find((n) => n.id === id);
const hintsOf = (node) => node.children.filter((c) => c.contextValue === 'cardHint').map((c) => c.label);

test('the setting is off by default: the view is hidden, the analysis asks for no impact paths, and the engine is never called', () => withEnv(async (env) => {
  const manifest = require('../package.json');
  assert.equal(manifest.contributes.configuration.properties['impactTree.cards.enabled'].default, false);
  const view = manifest.contributes.views.impactTree.find((v) => v.id === 'impactTree.cards');
  assert.equal(view.when, 'config.impactTree.cards.enabled');
  const names = manifest.contributes.views.impactTree.map((v) => v.id);
  assert.deepEqual(names, ['impactTree.sources', 'impactTree.cards', 'impactTree.details'], 'after Review, before Details');

  env.hooks.cardsEngine = fakeEngine(env);
  env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
  await env.refresh();
  await env.preview(pull(7));
  assert.deepEqual(env.seen.analyzeOptions.map((o) => o.impactPaths), [undefined]);
  assert.deepEqual(env.seen.remoteImpactPaths, [undefined]);
  assert.deepEqual(env.seen.cardsCalls, [], 'no cards work');
  assert.deepEqual(await roots(env), [], 'the provider shows nothing');
  assert.deepEqual(env.seen.errors, []);
}));

test('on: the local analysis asks for impact paths; cards appear when it ends, merge hints after', () => withCards(async (env) => {
  const engine = env.hooks.cardsEngine = fakeEngine(env);
  env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
  const hold = engine.hints.next();

  await env.refresh();
  assert.equal(env.seen.analyzeOptions[0].impactPaths, true);
  const [gathered] = env.seen.cardsCalls;
  assert.equal(gathered[0], 'gatherLocal');
  assert.deepEqual({ ...gathered[1], signal: undefined }, { repo: env.dir, base: 'HEAD', head: 'HEAD', signal: undefined });
  assert.ok(gathered[1].signal instanceof AbortSignal, 'the run\'s signal is passed');
  assert.deepEqual(env.seen.cardsCalls.map((c) => c[0]), ['gatherLocal', 'build', 'hints']);
  assert.deepEqual(env.seen.cardsCalls[1][1], { from: 'local' }, 'the cards are built from the facts');

  assert.deepEqual(await labels(env), ['Merge hints loading…', 'K1 · card K1', 'K2 · card K2']);
  assert.deepEqual(hintsOf(await card(env, 'K1')), [], 'no hints yet');

  const options = env.seen.cardsCalls[2][1];
  assert.equal(options.repo, env.dir);
  assert.equal(options.head, 'HEAD');
  assert.equal(options.signal.aborted, false, 'the background search outlives the run it started in');

  hold.release();
  await flush();
  assert.deepEqual(await labels(env), ['K1 · card K1', 'K2 · card K2']);
  assert.deepEqual(hintsOf(await card(env, 'K1')), ['May belong with K2: token Shared']);
  assert.deepEqual(env.seen.errors, []);
}));

test('hints of a replaced analysis never appear', async (t) => {
  await t.test('a newer refresh begins while the hints are being found', () => withCards(async (env) => {
    const engine = env.hooks.cardsEngine = fakeEngine(env);
    env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
    const first = engine.hints.next();
    await env.refresh();
    const olderOptions = env.seen.cardsCalls.find((c) => c[0] === 'hints')[1];
    const second = engine.hints.next();
    await env.refresh();
    assert.equal(olderOptions.signal.aborted, true, 'the older search was told to stop');
    assert.deepEqual(hintsOf(await card(env, 'K1')), [], 'the newer cards wait for their own hints');
    first.release();
    await flush();
    assert.deepEqual(hintsOf(await card(env, 'K1')), [], 'the older answer was dropped');
    assert.equal((await labels(env))[0], 'Merge hints loading…', 'and did not end the newer wait');
    second.release();
    await flush();
    assert.deepEqual(hintsOf(await card(env, 'K1')), ['May belong with K2: token Shared']);
  }));
  await t.test('a checkout starts', () => withCards(async (env) => {
    const engine = env.hooks.cardsEngine = fakeEngine(env);
    env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
    const hold = engine.hints.next();
    await env.refresh();
    const checkout = env.openPullRequest(pull(7), 'analyse');
    await flush();
    assert.equal(env.seen.cardsCalls.find((c) => c[0] === 'hints')[1].signal.aborted, true);
    hold.release();
    await checkout;
    await flush();
    assert.deepEqual(env.seen.errors, []);
  }));
  await t.test('the window closes', () => withCards(async (env) => {
    const engine = env.hooks.cardsEngine = fakeEngine(env);
    env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
    const hold = engine.hints.next();
    await env.refresh();
    env.deactivate();
    assert.equal(env.seen.cardsCalls.find((c) => c[0] === 'hints')[1].signal.aborted, true);
    hold.release();
    await flush();
    assert.deepEqual(env.seen.errors, []);
  }));
});

test('a failure of the merge hints is a note on the view; the cards stay and nothing is unhandled', () => withCards(async (env) => {
  const engine = env.hooks.cardsEngine = fakeEngine(env);
  env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
  const hold = engine.hints.next();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await env.refresh();
    hold.fail(new Error('git grep timed out'));
    await flush();
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(await labels(env), ['Cards are incomplete: merge hints could not be found: git grep timed out', 'K1 · card K1', 'K2 · card K2']);
  assert.deepEqual(env.seen.errors, [], 'no popup: the review itself is fine');
  assert.equal((await env.changeRows()).length, 4, 'the Changes view is untouched');
}));

test('a failure to gather the facts is a note on the view and does not fail the analysis', () => withCards(async (env) => {
  const engine = env.hooks.cardsEngine = fakeEngine(env);
  env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
  const hold = engine.facts.next();
  const run = env.refresh();
  await flush();
  hold.fail(new Error('bad revision'));
  await run;
  assert.deepEqual(await labels(env), ['Cards are incomplete: bad revision']);
  assert.deepEqual(env.seen.errors, []);
  assert.equal((await env.changeRows()).length, 4);
  assert.deepEqual(env.seen.cardsCalls.map((c) => c[0]), ['gatherLocal'], 'no cards, so no hints were looked for');
}));

test('a preview asks for impact paths and builds its cards from the pull request\'s files, without a repository', () => withCards(async (env) => {
  const engine = env.hooks.cardsEngine = fakeEngine(env);
  env.hooks.remoteResult = (pr) => {
    const changes = four(env);
    return { ...previewResult(pr), allChanged: changes, findings: changes, fileStatus: { 'f1.ts': 'modified' }, basePaths: { 'f1.ts': 'old.ts' } };
  };
  const hold = engine.hints.next();
  await env.preview(pull(7));
  assert.deepEqual(env.seen.remoteImpactPaths, [true]);
  const [kind, args] = env.seen.cardsCalls[0];
  assert.equal(kind, 'gatherRemote');
  assert.deepEqual({ ...args, signal: undefined, gh: undefined }, {
    gh: undefined, slug: { owner: 'example', repo: 'repo' }, pr: { number: 7, headSha: 'head-of-7', baseSha: 'merge' },
    files: [{ path: 'f1.ts', status: 'modified', oldPath: 'old.ts' }], signal: undefined });
  assert.ok(args.gh && typeof args.gh === 'object');
  const options = env.seen.cardsCalls.find((c) => c[0] === 'hints')[1];
  assert.equal('repo' in options, false, 'a preview has no repository to read');
  assert.equal(options.head, 'head-of-7');
  const top = await labels(env);
  assert.match(top[0], /^Preview — cards see the PR's own files only/);
  assert.ok(top.includes('K1 · card K1'));
  hold.release();
  await flush();
  assert.deepEqual(hintsOf(await card(env, 'K1')), ['May belong with K2: token Shared']);
  assert.deepEqual(env.seen.errors, []);
}));

test('selecting a seam reveals the other card, and a member opens the change row the Changes view opens', () => withCards(async (env) => {
  const engine = env.hooks.cardsEngine = fakeEngine(env);
  const changes = four(env);
  env.hooks.localResult = (o) => localResult(o, { findings: changes });
  engine.hints.next().release();
  await env.refresh();
  await flush();

  const provider = env.cards();
  const k1 = await card(env, 'K1');
  const seam = k1.children.find((c) => c.id === 'K1/seams').children[0];
  const item = provider.getTreeItem(seam);
  assert.equal(item.command.command, 'impactTree.revealCard');
  await env.run(item.command.command, ...item.command.arguments);
  const revealed = env.seen.revealed.at(-1);
  assert.equal(revealed.row.id, 'K2');
  assert.equal(provider.getParent(revealed.row), undefined, 'a card is a root of the view');
  assert.deepEqual(revealed.options, { select: true, focus: true, expand: false });

  const member = k1.children.find((c) => c.id === 'K1/members').children[0];
  const memberItem = provider.getTreeItem(member);
  assert.equal(memberItem.command.command, 'impactTree.openChange');
  assert.equal(memberItem.command.arguments[0].finding, changes[0], 'the same function the Changes view opens');
  assert.equal(provider.getParent(member).id, 'K1/members');
}));

test('the view follows the analysis: a new run clears the old cards at once', () => withCards(async (env) => {
  const engine = env.hooks.cardsEngine = fakeEngine(env);
  env.hooks.localResult = (o) => localResult(o, { findings: four(env) });
  engine.hints.next().release();
  await env.refresh();
  await flush();
  assert.ok((await labels(env)).includes('K1 · card K1'));
  const running = engine.hints.next();
  const held = env.holds.analyze.next();
  const next = env.refresh();
  await held.reached;
  assert.deepEqual(await labels(env), ['Cards appear here once a change is analysed.']);
  held.release();
  await next;
  running.release();
  await flush();
  assert.ok((await labels(env)).includes('K1 · card K1'));
}));
