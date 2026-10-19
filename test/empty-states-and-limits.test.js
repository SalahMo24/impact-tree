'use strict';
// UX plan P3 (errors and limits in words) and P5 (first-run and empty states): the view
// state function and its placeholder rows, the welcome screens declared in package.json,
// checkpoint mode without a checkpoint, the first-index progress, and the CLI's blast text.
// Scenarios that need the session drive the real activate() through test/extension-env.js;
// every interleaving is produced by hand-released gates (docs/CODING_STYLE.md section 5).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { viewStateOf, contextKeysOf, allUnanalysable, isNothingChanged } = require('../src/view-state');
const { buildPlaceholderRows } = require('../src/tree-row-models');
const { blastText } = require('../src/cli-format');
const { localResult, finding, withEnv } = require('./extension-env');
const manifest = require('../package.json');

const rootLabels = async (env) => (await env.tree().getChildren()).map((n) => n.label);
const checkpointError = (message) => Object.assign(new Error(message), { code: 'NO_CHECKPOINT' });
const empty = (extra = {}) => ({ ...localResult({ mode: 'pr' }), ...extra });

// ---- view state ----------------------------------------------------------------

test('the view state is a pure function of the repository, the lifecycle and the session state', () => {
  const state = (s) => viewStateOf({ phase: 'ready', busy: false, state: null, ...s });
  assert.equal(state({ repo: 'noFolder' }), 'noFolder');
  assert.equal(state({ repo: 'noGit', phase: 'analysing' }), 'noGit', 'a repository that cannot be analysed wins over a spinner');
  assert.equal(state({}), 'idle');
  assert.equal(state({ state: {} }), 'idle');
  for (const phase of ['starting', 'preparing', 'analysing', 'checkingOut']) assert.equal(state({ phase }), 'busy', phase);
  assert.equal(state({ busy: true, state: { result: empty() } }), 'busy');
  assert.equal(state({ phase: 'analysing', state: { result: empty({ callersPending: true, allChanged: [finding('f', 'a.ts', 1)] }) } }), 'shown',
    'a prepared result is reviewable while callers load');
  assert.equal(state({ state: { problem: { kind: 'noCheckpoint' } } }), 'problem');
  assert.equal(state({ state: { error: 'boom' } }), 'error');
  assert.equal(state({ state: { result: empty() } }), 'nothingChanged');
  assert.equal(state({ state: { result: empty({ allChanged: [finding('f', 'a.ts', 1)] }) } }), 'shown');
  assert.equal(state({ state: { result: empty({ otherFiles: [{ path: 'notes.md', status: 'added' }] }) } }), 'shown', 'a changed non-source file is something to review');
  assert.equal(state({ state: { result: empty({ tierA: true }) } }), 'shown', 'a preview is never judged to have nothing changed');
});

test('"no dependencies" needs every changed source file to be unanalysed, never a partial failure', () => {
  const unanalysed = empty({ changedFileCount: 2, changedPaths: ['a.ts', 'b.ts'], unanalysable: [{ component: 'web', count: 2 }],
    otherFiles: [{ path: 'a.ts' }, { path: 'b.ts' }] });
  assert.equal(allUnanalysable(unanalysed), true);
  assert.equal(viewStateOf({ phase: 'ready', busy: false, state: { result: unanalysed } }), 'noTypeScript');
  assert.equal(allUnanalysable({ ...unanalysed, unanalysable: [{ component: 'web', count: 1 }] }), false, 'one file was analysed');
  assert.equal(allUnanalysable({ ...unanalysed, otherFiles: [...unanalysed.otherFiles, { path: 'notes.md' }] }), false, 'another file is listed');
  assert.equal(allUnanalysable({ ...unanalysed, allChanged: [finding('f', 'c.ts', 1)] }), false);
  assert.equal(allUnanalysable(empty()), false, 'no failure is not a failure');
  assert.equal(isNothingChanged(unanalysed), false, 'unanalysed files are listed, so something changed');
});

test('context keys carry the state, and the mode only while nothing changed', () => {
  const keys = (state) => contextKeysOf({ phase: 'ready', busy: false, state });
  assert.deepEqual(keys(null), { 'impactTree.state': 'idle', 'impactTree.resultMode': '' });
  assert.deepEqual(keys({ result: empty({ requestedMode: 'checkpoint' }) }), { 'impactTree.state': 'nothingChanged', 'impactTree.resultMode': 'checkpoint' });
  assert.deepEqual(keys({ result: empty({ allChanged: [finding('f', 'a.ts', 1)] }) }), { 'impactTree.state': 'shown', 'impactTree.resultMode': '' });
});

test('placeholder rows: the states with a welcome screen have no rows; messages and problems have rows', () => {
  const rows = (view) => buildPlaceholderRows({ phase: 'ready', busy: false, state: null, ...view });
  for (const view of [{}, { repo: 'noFolder' }, { repo: 'noGit' }]) assert.deepEqual(rows(view), [], JSON.stringify(view));
  assert.deepEqual(rows({ state: { result: empty() } }), [], 'nothing changed, nothing to warn about: the welcome screen speaks');
  assert.deepEqual(rows({ phase: 'checkingOut' }).map((r) => r.label), ['Checking out…']);
  const none = rows({ state: { problem: { kind: 'noCheckpoint' } } });
  assert.deepEqual(none.map((r) => r.label), ['No checkpoint yet', 'Set checkpoint now']);
  assert.match(none[0].desc, /Since checkpoint shows what changed after a commit you record/);
  assert.equal(none[1].command, 'impactTree.setCheckpoint');
  const gone = rows({ state: { problem: { kind: 'checkpointGone', detail: 'abc is not a commit' } } });
  assert.deepEqual(gone.map((r) => r.label), ['The checkpoint is gone', 'Set checkpoint now']);
  assert.equal(gone[0].tooltip, 'abc is not a commit');
  assert.equal(gone[1].command, 'impactTree.setCheckpoint');
});

test('nothing changed with warnings keeps the warnings and names the mode and base with a way to switch', () => {
  const result = empty({ mode: 'branch', requestedMode: 'pr', warnings: ['2 uncommitted change(s) — showing branch'], base: { ref: 'origin/main', sha: 'x' } });
  const shown = buildPlaceholderRows({ phase: 'ready', busy: false, state: { result } });
  assert.deepEqual(shown.map((r) => r.label), ['2 uncommitted change(s) — showing branch', 'Nothing changed — Branch + uncommitted against origin/main']);
  assert.equal(shown[1].command, 'impactTree.selectMode');
});

// ---- welcome screens in package.json ---------------------------------------------

test('every state without rows has a welcome screen with a next step, and idle offers the three ways in', () => {
  const welcome = manifest.contributes.viewsWelcome;
  const commands = new Set(manifest.contributes.commands.map((c) => c.command));
  // Contributed by VS Code or its built-in extensions, not by this one.
  const builtIn = new Set(['workbench.action.files.openFolder', 'workbench.action.openSettings', 'git.init', 'impactTree.sources.focus']);
  const forState = (view, when) => welcome.filter((w) => w.view === view && w.when.includes(`impactTree.state == ${when}`));
  for (const [view, states] of [['impactTree.changes', ['noFolder', 'noGit', 'idle', 'nothingChanged', 'noTypeScript']], ['impactTree.sources', ['noFolder', 'noGit']]]) {
    for (const state of states) assert.ok(forState(view, state).length > 0, `${view} has a welcome screen for ${state}`);
  }
  for (const entry of welcome) {
    const links = [...entry.contents.matchAll(/\]\(command:([\w.]+)/g)].map((m) => m[1]);
    assert.ok(links.length > 0, `${entry.when} offers a next step`);
    for (const command of links) assert.ok(commands.has(command) || builtIn.has(command), `${command} exists`);
  }
  const [idle] = forState('impactTree.changes', 'idle');
  const link = (label) => new RegExp(`\\[${label}\\]\\(([^)]*)\\)`).exec(idle.contents)?.[1];
  assert.equal(link('Review my branch'), 'command:impactTree.analyseMode?%5B%22pr%22%5D');
  assert.equal(link('Review uncommitted \\(agent\\) changes'), 'command:impactTree.analyseMode?%5B%22working%22%5D');
  assert.equal(link('Open a pull request'), 'command:impactTree.sources.focus');
  assert.deepEqual(JSON.parse(decodeURIComponent('%5B%22pr%22%5D')), ['pr']);
  // Nothing changed names its mode for each of the four modes and offers to switch.
  const nothing = forState('impactTree.changes', 'nothingChanged');
  assert.deepEqual(nothing.map((w) => /resultMode == (\w+)/.exec(w.when)[1]).sort(), ['branch', 'checkpoint', 'pr', 'working']);
  for (const w of nothing) assert.match(w.contents, /\[Switch mode\]\(command:impactTree\.selectMode\)/);
  assert.match(forState('impactTree.changes', 'noTypeScript')[0].contents, /npm install/);
});

// ---- checkpoint mode without a checkpoint ------------------------------------------

test('checkpoint mode with no checkpoint starts no analysis, pops nothing up and offers Set checkpoint now', () => withEnv(async (env) => {
  await env.analyseLocally('checkpoint');
  assert.deepEqual(env.seen.analyze, [], 'no analysis was started');
  assert.deepEqual(env.seen.errors, []);
  assert.deepEqual(env.seen.warnings, []);
  assert.deepEqual(await rootLabels(env), ['No checkpoint yet', 'Set checkpoint now']);
  const [, button] = await env.tree().getChildren();
  assert.equal(env.tree().getTreeItem(button).command.command, 'impactTree.setCheckpoint');
  assert.equal(env.seen.contexts['impactTree.state'], 'problem');
}));

test('Set checkpoint now records HEAD and, in checkpoint mode, analyses since it', () => withEnv(async (env) => {
  await env.analyseLocally('checkpoint');
  await env.run('impactTree.setCheckpoint');
  assert.match(env.memento.get('impactTree.checkpoint'), /^[0-9a-f]{40}$/);
  assert.deepEqual(env.seen.analyze.map((a) => a.mode), ['checkpoint'], 'the mode that was waiting for a checkpoint ran');
  assert.deepEqual(await rootLabels(env), [], 'the problem rows are gone');
  assert.notEqual(env.seen.contexts['impactTree.state'], 'problem');
  assert.deepEqual(env.seen.errors, []);
}, { settings: { mode: 'checkpoint' } }));

test('Set checkpoint now outside checkpoint mode records the checkpoint and starts nothing', () => withEnv(async (env) => {
  await env.run('impactTree.setCheckpoint');
  assert.match(env.memento.get('impactTree.checkpoint'), /^[0-9a-f]{40}$/);
  assert.deepEqual(env.seen.analyze, []);
}));

test('a recorded checkpoint that is no longer a commit says it is gone, with no popup', () => withEnv(async (env) => {
  env.hooks.localResult = () => { throw checkpointError('checkpoint deadbeef0000 is not a commit in this repository — record a new checkpoint'); };
  await env.analyseLocally('checkpoint');
  assert.deepEqual(env.seen.analyze.map((a) => a.mode), ['checkpoint'], 'the engine found it, so the analysis did start');
  assert.deepEqual(env.seen.errors, []);
  assert.deepEqual(await rootLabels(env), ['The checkpoint is gone', 'Set checkpoint now']);
  assert.match((await env.tree().getChildren())[0].tooltip, /not a commit/);
}, { memento: new Map([['impactTree.checkpoint', 'deadbeef00000000000000000000000000000000']]) }));

test('a different failure is still an error with a popup', () => withEnv(async (env) => {
  env.hooks.localResult = () => { throw new Error('git exploded'); };
  await env.analyseLocally('checkpoint');
  assert.deepEqual(env.seen.errors, ['Impact Tree: git exploded']);
}, { memento: new Map([['impactTree.checkpoint', 'deadbeef00000000000000000000000000000000']]) }));

test('an obsolete run cannot publish the checkpoint message over a newer run', () => withEnv(async (env) => {
  const first = env.holds.analyze.next();
  const older = env.analyseLocally('checkpoint');
  await first.reached;
  const second = env.holds.analyze.next();
  const newer = env.analyseLocally('working');
  await second.reached;
  second.release();
  await newer;
  first.fail(checkpointError('checkpoint deadbeef0000 is not a commit'));
  await older;
  assert.deepEqual(await rootLabels(env), [], 'the newer run is what is shown');
  assert.match(env.view().message, /^Uncommitted \(agent\) · /);
  assert.notEqual(env.seen.contexts['impactTree.state'], 'problem');
  assert.deepEqual(env.seen.errors, []);
}, { memento: new Map([['impactTree.checkpoint', 'deadbeef00000000000000000000000000000000']]) }));

test('the engine keeps its guard for callers outside the extension, now with a code', async () => {
  const { analyze } = require('../src/engine/analyze');
  await assert.rejects(() => analyze(process.cwd(), { mode: 'checkpoint' }), (e) => e.code === 'NO_CHECKPOINT' && /requires opts.checkpoint/.test(e.message));
});

// ---- first-index progress --------------------------------------------------------------

const prepared = (env) => (o) => localResult(o, { findings: [finding('warm', path.join(env.dir, 'a.ts'), 1)] });

test('a user-started first index shows elapsed seconds in the status bar and the view, with no percentage, and clears them', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  await withEnv(async (env) => {
    env.hooks.warm = false;
    env.hooks.localPrepared = prepared(env);
    const warm = env.holds.warmUp.next();
    const running = env.refresh();
    await warm.reached;
    const windowProgress = env.seen.progress.filter((p) => p.options.location === env.vscode.ProgressLocation.Window);
    assert.equal(windowProgress.length, 1, 'one status-bar progress');
    assert.equal(windowProgress[0].options.title, 'Impact Tree');
    assert.match(env.view().message, /(^| · )Indexing the workspace, first run only — usually 10–35 s… 0 s$/);
    t.mock.timers.tick(3000);
    assert.match(env.view().message, /(^| · )Indexing the workspace, first run only — usually 10–35 s… 3 s$/);
    assert.equal(windowProgress[0].messages.at(-1), 'Indexing the workspace, first run only — usually 10–35 s… 3 s');
    assert.ok(![...windowProgress[0].messages, env.view().message].some((m) => /%/.test(m)), 'no invented percentage');
    warm.release();
    await running;
    assert.equal(windowProgress[0].settled, true);
    assert.ok(!/Indexing/.test(env.view().message ?? ''), 'the message is cleared');
    t.mock.timers.tick(5000);
    assert.ok(!/Indexing/.test(env.view().message ?? ''), 'the timer is gone');
  }, { changedSource: true });
});

test('a failed or replaced first index clears the progress and its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  await withEnv(async (env) => {
    env.hooks.warm = false;
    env.hooks.localPrepared = prepared(env);
    const warm = env.holds.warmUp.next();
    const older = env.refresh();
    await warm.reached;
    assert.match(env.view().message, /^Indexing the workspace/);
    // A newer run replaces the older one while the index is still being built.
    const newer = env.refresh();
    await Promise.resolve();
    warm.fail(new Error('server went away'));
    await Promise.all([older, newer]);
    assert.ok(env.seen.progress.filter((p) => p.options.location === env.vscode.ProgressLocation.Window).every((p) => p.settled), 'no progress left open');
    t.mock.timers.tick(5000);
    assert.ok(!/Indexing/.test(env.view().message ?? ''), 'no timer survives the runs');
  }, { changedSource: true });
});

test('a background prewarm shows no window progress', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  await withEnv(async (env) => {
    const warm = env.holds.warmUp.next();
    t.mock.timers.tick(2000);
    await warm.reached;
    assert.deepEqual(env.seen.progress.filter((p) => p.options.location === env.vscode.ProgressLocation.Window), []);
    assert.ok(!/Indexing/.test(env.view().message ?? ''));
    warm.release();
  }, { prewarm: true, changedSource: true });
});

// ---- context keys on transitions ---------------------------------------------------------

test('context keys are sent when the state changes, not on every repaint', () => withEnv(async (env) => {
  const sent = [];
  const execute = env.vscode.commands.executeCommand;
  env.vscode.commands.executeCommand = async (name, ...args) => { if (name === 'setContext') sent.push(`${args[0]}=${args[1]}`); return execute(name, ...args); };
  await env.refresh();
  assert.equal(env.seen.contexts['impactTree.state'], 'nothingChanged');
  assert.equal(env.seen.contexts['impactTree.resultMode'], 'pr');
  const before = sent.length;
  env.tree().refresh?.();
  await env.refresh();
  assert.equal(new Set(sent.slice(before)).size, sent.slice(before).length, 'no key is sent twice with the same value in a row');
  assert.ok(sent.includes('impactTree.state=nothingChanged'));
}));

test('the Review view is empty without a repository, so its welcome screen shows', () => withEnv(async (env) => {
  assert.ok((await env.sources().getChildren()).length > 0);
  env.vscode.workspace.workspaceFolders = [];
  await env.refresh();
  assert.deepEqual(await env.sources().getChildren(), []);
  assert.equal(env.seen.contexts['impactTree.state'], 'noFolder');
}));

// ---- CLI -------------------------------------------------------------------------------------

test('the CLI says "not computed" for a root past the ranked roots, and prints a computed blast as a number', () => {
  const past = { blast: null, blastCapped: false, blastNotComputed: true };
  assert.equal(blastText(past, 6), 'blast not computed (top 6 only; raise with --roots)');
  assert.equal(blastText(past, 12), 'blast not computed (top 12 only; raise with --roots)', 'N is the effective value');
  assert.equal(blastText({ blast: 0, blastCapped: false, blastNotComputed: false }, 6), 'blast 0', 'computed as zero is not "not computed"');
  assert.equal(blastText({ blast: 40, blastCapped: true, blastNotComputed: false }, 6), 'blast 40+');
  assert.equal(blastText({ blast: null }, 6), 'blast not computed (top 6 only; raise with --roots)', 'a result with no figure never reads as zero');
});
