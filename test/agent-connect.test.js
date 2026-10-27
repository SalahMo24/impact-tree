// @ts-check
'use strict';
// Connecting the user's agents (src/agent-connect.js, src/agent-connect-commands.js) with fake
// processes and a fake editor: nothing here runs claude, codex or opens a link.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ac = require('../src/agent-connect');
const { createAgentConnect } = require('../src/agent-connect-commands');
const { planHandOff, handOff, choicesFor, MAX_URI_PROMPT_CHARS } = require('../src/agent-handoff');

const PATH_RT = /** @type {ac.Runtime} */ ({ command: '/usr/bin/node', env: {}, kind: 'path' });
const EDITOR_RT = /** @type {ac.Runtime} */ ({ command: '/Apps/Code Helper', env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'editor' });
const L = '/store/mcp/impact-tree-mcp.cjs';
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, notFound: false });
const fail = (stderr = '', code = 1) => ({ code, stdout: '', stderr, timedOut: false, notFound: false });
const timeout = { code: null, stdout: '', stderr: '', timedOut: true, notFound: false };

test('argv per agent, with and without the editor runtime', () => {
  assert.deepEqual(ac.claudeAddArgs({ runtime: PATH_RT, launcher: L }), ['mcp', 'add', '--scope', 'user', 'impact-tree', '--', '/usr/bin/node', L]);
  assert.deepEqual(ac.claudeAddArgs({ runtime: EDITOR_RT, launcher: L, scope: 'local' }),
    ['mcp', 'add', '--scope', 'local', 'impact-tree', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', '/Apps/Code Helper', L]);
  assert.deepEqual(ac.codexAddArgs({ runtime: PATH_RT, launcher: L }), ['mcp', 'add', 'impact-tree', '--', '/usr/bin/node', L]);
  assert.deepEqual(ac.codexAddArgs({ runtime: EDITOR_RT, launcher: L }),
    ['mcp', 'add', 'impact-tree', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', '/Apps/Code Helper', L]);
  assert.deepEqual(ac.claudeRemoveArgs(), ['mcp', 'remove', '--scope', 'user', 'impact-tree']);
  assert.deepEqual(ac.codexRemoveArgs(), ['mcp', 'remove', 'impact-tree']);
  assert.equal(ac.displayCommand('claude', ac.claudeAddArgs({ runtime: EDITOR_RT, launcher: L })),
    "claude mcp add --scope user impact-tree -e ELECTRON_RUN_AS_NODE=1 -- '/Apps/Code Helper' /store/mcp/impact-tree-mcp.cjs");
});

test('Cursor link decodes back to the entry; provider definition', () => {
  const link = ac.cursorDeeplink({ runtime: EDITOR_RT, launcher: L });
  assert.ok(link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=impact-tree&config='));
  assert.deepEqual(ac.decodeCursorDeeplink(link), { name: 'impact-tree', config: { command: '/Apps/Code Helper', args: [L], env: { ELECTRON_RUN_AS_NODE: '1' } } });
  assert.deepEqual(ac.decodeCursorDeeplink(ac.cursorDeeplink({ runtime: PATH_RT, launcher: L })).config, { command: '/usr/bin/node', args: [L] });
  assert.deepEqual(ac.providerDefinition({ runtime: PATH_RT, launcher: L }), { label: 'Impact Tree', command: '/usr/bin/node', args: [L], env: {} });
});

test('node choice: versions 18/20/22, PATH missing, editor fallback', () => {
  const editor = (/** @type {string} */ version) => ({ execPath: '/Apps/Code Helper', version });
  const pn = (/** @type {number|null} */ major) => ({ path: '/usr/bin/node', major });
  assert.equal(ac.chooseRuntime({ pathNode: pn(22), editor: editor('18.0.0') })?.kind, 'path');
  assert.equal(ac.chooseRuntime({ pathNode: pn(20), editor: editor('18.0.0') })?.kind, 'path');
  assert.deepEqual(ac.chooseRuntime({ pathNode: pn(18), editor: editor('20.1.0') }), EDITOR_RT);
  assert.equal(ac.chooseRuntime({ pathNode: null, editor: editor('22.0.0') })?.kind, 'editor');
  assert.equal(ac.chooseRuntime({ pathNode: pn(null), editor: editor('22.0.0') })?.kind, 'editor');
  assert.equal(ac.chooseRuntime({ pathNode: pn(18), editor: editor('18.19.0') }), null);
  assert.equal(ac.chooseRuntime({ pathNode: null, editor: editor('18.19.0') }), null);
});

test('node probe: absolute path from PATH, --version run with a timeout; missing node', async () => {
  const calls = /** @type {any[]} */ ([]);
  const run = async (/** @type {string} */ f, /** @type {string[]} */ a, /** @type {any} */ o) => { calls.push([f, a, o && o.timeoutMs]); return ok('v22.1.0\n'); };
  const exists = (/** @type {string} */ p) => p === '/b/node';
  const rt = await ac.probeRuntime({ run, pathEnv: '/a:/b', platform: 'darwin', editor: { execPath: '/e', version: '18.0.0' }, exists });
  assert.deepEqual(rt, { command: '/b/node', env: {}, kind: 'path' });
  assert.deepEqual(calls, [['/b/node', ['--version'], 3000]]);
  const none = await ac.probeRuntime({ run, pathEnv: '/a', platform: 'darwin', editor: { execPath: '/e', version: '18.0.0' }, exists });
  assert.equal(none, null);
  const hung = await ac.probeRuntime({ run: async () => timeout, pathEnv: '/b', platform: 'darwin', editor: { execPath: '/e', version: '20.0.0' }, exists });
  assert.equal(hung?.kind, 'editor');
});

test('launcher: content, atomic write, rewrite only on change, missing folder message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-launcher-'));
  try {
    const ext = path.join(dir, 'ext');
    fs.mkdirSync(path.join(ext, 'src', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'src', 'mcp', 'server.js'), "exports.runCli = async (argv) => { console.log('ARGS ' + JSON.stringify(argv)); };\n");
    const a = ac.ensureLauncher({ storageDir: path.join(dir, 'store'), extensionPath: ext });
    assert.equal(a.launcher, path.join(dir, 'store', 'mcp', 'impact-tree-mcp.cjs'));
    assert.equal(a.written, true);
    assert.deepEqual(fs.readdirSync(path.dirname(a.launcher)), ['impact-tree-mcp.cjs'], 'no temp file left');
    assert.equal(ac.ensureLauncher({ storageDir: path.join(dir, 'store'), extensionPath: ext }).written, false);
    const { execFileSync, spawnSync } = require('node:child_process');
    assert.equal(execFileSync(process.execPath, [a.launcher, '--repo', '/x'], { encoding: 'utf8' }).trim(), 'ARGS ["--repo","/x"]');
    // A new extension folder rewrites it.
    assert.equal(ac.ensureLauncher({ storageDir: path.join(dir, 'store'), extensionPath: path.join(dir, 'ext2') }).written, true);
    const gone = spawnSync(process.execPath, [a.launcher], { encoding: 'utf8' });
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /Impact Tree: its extension folder is gone/);
    // A failed rename leaves no temp file behind and the error reaches the caller.
    const fsApi = { ...fs, renameSync: () => { throw new Error('rename failed'); } };
    assert.throws(() => ac.ensureLauncher({ storageDir: path.join(dir, 'store'), extensionPath: ext, fsApi }), /rename failed/);
    assert.deepEqual(fs.readdirSync(path.dirname(a.launcher)), ['impact-tree-mcp.cjs']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A fake process runner answering by command line. @param {Record<string, any>} answers key: "file arg arg" */
function fakeRun(answers) {
  const calls = /** @type {string[]} */ ([]);
  const run = async (/** @type {string} */ f, /** @type {string[]} */ a) => {
    const key = [f, ...a].join(' ');
    calls.push(key);
    if (!(key in answers)) return { code: null, stdout: '', stderr: '', timedOut: false, notFound: true };
    const v = answers[key];
    return typeof v === 'function' ? v() : v;
  };
  return { run, calls };
}
const baseDetect = (/** @type {any} */ over) => ({
  appName: 'Visual Studio Code', hasProviderApi: false, home: '/home/u', readFile: () => null, appInstalled: () => false, onPathExe: () => false, ...over,
});

test('detection: signed in/out, connected or not, timeouts are unknown, not installed', async () => {
  const { run } = fakeRun({ 'claude auth status': ok('x'), 'claude mcp get impact-tree': fail('not found'), 'codex login status': fail('', 1), 'codex mcp get impact-tree': ok() });
  const st = await ac.detectAgents(baseDetect({ run, onPathExe: (/** @type {string} */ e) => e === 'claude' || e === 'codex' }));
  assert.deepEqual(st.claude, { installed: true, signedIn: true, connected: false });
  assert.deepEqual(st.codex, { installed: true, signedIn: false, connected: true });
  assert.deepEqual(st.cursor, { installed: false, signedIn: null, connected: false });
  assert.equal(st.vscode.installed, false);
  const slow = await ac.detectAgents(baseDetect({ run: async () => timeout, onPathExe: () => true }));
  assert.deepEqual(slow.claude, { installed: true, signedIn: 'unknown', connected: 'unknown' });
  assert.equal(slow.codex.connected, 'unknown');
  const throwing = await ac.detectAgents(baseDetect({ run: async () => { throw new Error('boom'); }, onPathExe: () => true }));
  assert.deepEqual(throwing.claude, { installed: true, signedIn: 'unknown', connected: 'unknown' });
  const absent = await ac.detectAgents(baseDetect({ run }));
  assert.deepEqual(absent.claude, { installed: false, signedIn: null, connected: false });
  assert.equal(ac.statusText(st.claude), 'installed · signed in · not connected');
  assert.equal(ac.statusText(absent.claude), 'not found');
});

test('detection: codex without `mcp get` falls back to `mcp list`; unknown stays unknown', async () => {
  const noGet = fail("error: unrecognized subcommand 'get'", 2);
  const yes = fakeRun({ 'codex login status': ok(), 'codex mcp get impact-tree': noGet, 'codex mcp list': ok('Name  Command\nimpact-tree  node\n') });
  const on = (/** @type {any} */ r) => ac.detectAgents(baseDetect({ run: r.run, onPathExe: (/** @type {string} */ e) => e === 'codex' }));
  assert.equal((await on(yes)).codex.connected, true);
  const no = fakeRun({ 'codex login status': ok(), 'codex mcp get impact-tree': noGet, 'codex mcp list': ok('Name  Command\nother  node\n') });
  assert.equal((await on(no)).codex.connected, false);
  const bad = fakeRun({ 'codex login status': ok(), 'codex mcp get impact-tree': noGet, 'codex mcp list': timeout });
  assert.equal((await on(bad)).codex.connected, 'unknown');
});

test('detection: Cursor from the app or its config file; VS Code needs the API and not Cursor', async () => {
  const { run } = fakeRun({});
  const cfg = (/** @type {string|null} */ text) => baseDetect({ run, appInstalled: (/** @type {string} */ p) => p === '/Applications/Cursor.app', readFile: (/** @type {string} */ p) => { assert.equal(p, '/home/u/.cursor/mcp.json'); return text; } });
  assert.deepEqual((await ac.detectAgents(cfg('{"mcpServers":{"impact-tree":{}}}'))).cursor, { installed: true, signedIn: null, connected: true });
  assert.equal((await ac.detectAgents(cfg('{"mcpServers":{"other":{}}}'))).cursor.connected, false);
  assert.equal((await ac.detectAgents(cfg(null))).cursor.connected, false);
  assert.equal((await ac.detectAgents(cfg('{not json'))).cursor.connected, 'unknown');
  assert.equal((await ac.detectAgents(cfg('{"mcpServers":[]}'))).cursor.connected, 'unknown');
  assert.equal((await ac.detectAgents(baseDetect({ run, appName: 'Cursor', hasProviderApi: true }))).cursor.installed, true);
  assert.equal((await ac.detectAgents(baseDetect({ run, appName: 'Cursor', hasProviderApi: true }))).vscode.installed, false);
  assert.equal((await ac.detectAgents(baseDetect({ run, hasProviderApi: true }))).vscode.installed, true);
});

// ---- the commands, with a fake editor ---------------------------------------------------

/**
 * @param {{ runAnswers?: Record<string, any>, modal?: string|undefined, pick?: string, api?: boolean, nodeVersion?: string, claudeConnected?: boolean }} o
 */
function harness(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-connect-'));
  const ext = path.join(dir, 'ext');
  fs.mkdirSync(path.join(ext, 'src', 'mcp'), { recursive: true });
  const claudeConnected = o.claudeConnected === true;
  const { run, calls } = fakeRun({
    'claude auth status': ok(), 'claude mcp get impact-tree': claudeConnected ? ok() : fail('none'),
    '/bin/node --version': ok('v22.0.0\n'), ...(o.runAnswers || {}),
  });
  const messages = /** @type {string[]} */ ([]);
  const modals = /** @type {any[]} */ ([]);
  const opened = /** @type {string[]} */ ([]);
  const registered = /** @type {any[]} */ ([]);
  const vscode = {
    env: { appName: 'Visual Studio Code', openExternal: async (/** @type {any} */ u) => { opened.push(u.toString()); return true; } },
    Uri: { parse: (/** @type {string} */ s) => ({ toString: () => s }) },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    McpStdioServerDefinition: class { constructor(/** @type {any} */ label, /** @type {any} */ command, /** @type {any} */ args, /** @type {any} */ env) { Object.assign(this, { label, command, args, env }); } },
    ...(o.api ? { lm: { registerMcpServerDefinitionProvider: (/** @type {string} */ id, /** @type {any} */ p) => { const r = { id, p, disposed: false, dispose() { r.disposed = true; } }; registered.push(r); return r; } } } : {}),
    window: {
      showQuickPick: async (/** @type {any[]} */ items) => items.find((i) => i.id === o.pick),
      showWarningMessage: async (/** @type {string} */ m, /** @type {any} */ opts, /** @type {string} */ button) => { if (!opts) { messages.push(m); return undefined; } modals.push({ m, detail: opts.detail, button }); return o.modal === undefined ? undefined : o.modal; },
      showInformationMessage: async (/** @type {string} */ m) => { messages.push(m); },
      showErrorMessage: async (/** @type {string} */ m) => { messages.push(m); },
    },
  };
  const ctl = createAgentConnect(vscode, {
    context: { globalStorageUri: { fsPath: path.join(dir, 'store') }, extensionPath: ext }, log: () => {}, run, platform: 'darwin', pathEnv: '/bin',
    home: dir, editor: { execPath: '/Apps/Helper', version: o.nodeVersion || '18.0.0' },
  });
  // `exists` for PATH: the fake `claude` and `node` are "found"; createAgentConnect uses the real fs for PATH, so point it at a real folder.
  return { ctl, calls, messages, modals, opened, registered, vscode, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }), dir };
}
/** A PATH folder with executable stubs, so the real PATH lookup finds `claude`, `node`. @param {string} dir @param {string[]} names */
function stubPath(dir, names) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const n of names) { fs.writeFileSync(path.join(bin, n), '#!/bin/sh\n', { mode: 0o755 }); }
  return bin;
}
/** Build the harness with a real PATH folder. */
function connectHarness(/** @type {any} */ o, /** @type {string[]} */ names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-bin-'));
  const bin = stubPath(dir, names);
  const h = harness({ ...o, runAnswers: { [`${bin}/node --version`]: ok('v22.0.0\n'), ...(o.runAnswers || {}) } });
  const ctl = createAgentConnect(h.vscode, {
    context: { globalStorageUri: { fsPath: path.join(h.dir, 'store') }, extensionPath: path.join(h.dir, 'ext') }, log: () => {}, run: async (f, a, x) => {
      const key = [f, ...a].join(' ');
      h.calls.push(key);
      const answers = { 'claude auth status': ok(), 'claude mcp get impact-tree': o.claudeConnected ? ok() : fail('none'), [`${bin}/node --version`]: ok('v22.0.0\n'), ...(o.runAnswers || {}) };
      if (o.addResult && /^(claude|codex) mcp add /.test(key)) return o.addResult;
      if (/^(claude|codex) mcp (add|remove) /.test(key) && !(key in answers)) return ok();
      return key in answers ? answers[key] : { code: null, stdout: '', stderr: '', timedOut: false, notFound: true };
    }, platform: 'darwin', pathEnv: bin, home: h.dir, editor: { execPath: '/Apps/Helper', version: o.nodeVersion || '18.0.0' },
  });
  return { ...h, ctl, bin, cleanup: () => { h.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('Cancel runs nothing: no add, no remove, no link', async () => {
  const h = connectHarness({ pick: 'claude', modal: undefined }, ['claude', 'node']);
  try {
    await h.ctl.connect();
    assert.equal(h.modals.length, 1);
    assert.match(h.modals[0].detail, /claude mcp add --scope user impact-tree -- \S*\/node \S*impact-tree-mcp\.cjs/);
    assert.deepEqual(h.calls.filter((c) => /mcp (add|remove)/.test(c)), []);
    const c = connectHarness({ pick: 'cursor', modal: undefined }, ['cursor', 'node']);
    try { await c.ctl.connect(); assert.deepEqual(c.opened, []); assert.equal(c.modals.length, 1); } finally { c.cleanup(); }
  } finally { h.cleanup(); }
});

test('Connect runs exactly the shown command; success is reported after re-detecting', async () => {
  const h = connectHarness({ pick: 'claude', modal: 'Connect' }, ['claude', 'node']);
  try {
    await h.ctl.connect();
    const adds = h.calls.filter((c) => /mcp add/.test(c));
    assert.equal(adds.length, 1);
    assert.ok(h.modals[0].detail.includes(`claude ${adds[0].replace(/^claude /, '')}`));
    assert.match(h.messages.at(-1) || '', /Connected: Claude Code is now installed · signed in/);
  } finally { h.cleanup(); }
});

test('Replace removes, then adds; a failed add shows only the first stderr line', async () => {
  const h = connectHarness({ pick: 'claude', modal: 'Replace', claudeConnected: true }, ['claude', 'node']);
  try {
    await h.ctl.connect();
    assert.equal(h.modals[0].button, 'Replace');
    const order = h.calls.filter((c) => /mcp (add|remove)/.test(c));
    assert.equal(order.length, 2);
    assert.match(order[0], /^claude mcp remove --scope user impact-tree$/);
    assert.match(order[1], /^claude mcp add /);
  } finally { h.cleanup(); }
  const f = connectHarness({ pick: 'claude', modal: 'Connect', addResult: fail('boom: bad thing\nsecond line') }, ['claude', 'node']);
  try {
    await f.ctl.connect();
    assert.match(f.messages.at(-1) || '', /^Impact Tree: Claude Code did not accept the command: boom: bad thing$/);
  } finally { f.cleanup(); }
});

test('no usable node: explains and stops; editor runtime sets ELECTRON_RUN_AS_NODE in the command', async () => {
  const none = connectHarness({ pick: 'claude', modal: 'Connect', nodeVersion: '18.0.0', runAnswers: {} }, ['claude']);
  try {
    await none.ctl.connect();
    assert.deepEqual(none.modals, []);
    assert.match(none.messages.at(-1) || '', /need Node 20 or later: install it and try again/);
    assert.deepEqual(none.calls.filter((c) => /mcp add/.test(c)), []);
  } finally { none.cleanup(); }
  const ed = connectHarness({ pick: 'claude', modal: undefined, nodeVersion: '22.0.0' }, ['claude']);
  try {
    await ed.ctl.connect();
    assert.match(ed.modals[0].detail, /-e ELECTRON_RUN_AS_NODE=1 -- \/Apps\/Helper \S+impact-tree-mcp\.cjs/);
  } finally { ed.cleanup(); }
});

test('Cursor: the link is shown, then opened after Connect', async () => {
  const h = connectHarness({ pick: 'cursor', modal: 'Connect' }, ['cursor', 'node']);
  try {
    await h.ctl.connect();
    assert.equal(h.opened.length, 1);
    assert.ok(h.modals[0].detail.includes(h.opened[0]));
    assert.deepEqual(ac.decodeCursorDeeplink(h.opened[0]).config.args.map((/** @type {string} */ a) => path.basename(a)), ['impact-tree-mcp.cjs']);
  } finally { h.cleanup(); }
});

test('Disconnect runs the remove command after asking; Cursor is only explained', async () => {
  const h = connectHarness({ pick: 'claude', modal: 'Disconnect', claudeConnected: true }, ['claude']);
  try {
    await h.ctl.disconnect();
    assert.equal(h.calls.filter((c) => /^claude mcp remove --scope user impact-tree$/.test(c)).length, 1);
  } finally { h.cleanup(); }
  const c = connectHarness({ pick: 'cursor', modal: 'Disconnect' }, ['cursor']);
  try {
    // Cursor must be listed: its config file says connected.
    fs.mkdirSync(path.join(c.dir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(c.dir, '.cursor', 'mcp.json'), '{"mcpServers":{"impact-tree":{}}}');
    await c.ctl.disconnect();
    assert.deepEqual(c.modals, []);
    assert.match(c.messages.at(-1) || '', /remove "impact-tree" in Cursor/);
    assert.equal(fs.readFileSync(path.join(c.dir, '.cursor', 'mcp.json'), 'utf8'), '{"mcpServers":{"impact-tree":{}}}');
  } finally { c.cleanup(); }
});

test('provider: registered only when the API exists and the setting is on; stops when off', async () => {
  const noApi = harness({ api: false });
  try { noApi.ctl.syncProvider(true); assert.deepEqual(noApi.registered, []); } finally { noApi.cleanup(); }
  const h = harness({ api: true, nodeVersion: '22.0.0' });
  try {
    h.ctl.syncProvider(false);
    assert.deepEqual(h.registered, []);
    h.ctl.syncProvider(true);
    h.ctl.syncProvider(true);
    assert.equal(h.registered.length, 1);
    assert.equal(h.registered[0].id, 'impactTree.mcp');
    const defs = await h.registered[0].p.provideMcpServerDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].label, 'Impact Tree');
    assert.equal(defs[0].command, '/Apps/Helper');
    assert.deepEqual(defs[0].env, { ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(path.basename(defs[0].args[0]), 'impact-tree-mcp.cjs');
    h.ctl.syncProvider(false);
    assert.equal(h.registered[0].disposed, true);
  } finally { h.cleanup(); }
});

// ---- hand-off to Claude Code's VS Code extension ----------------------------------------

test('hand-off: Claude Code (VS Code) link, listed only with the extension, long prompts go to the clipboard', async () => {
  const base = { cliFound: () => true, chatAvailable: false };
  assert.ok(!choicesFor(base).some((c) => c.id === 'claude-vscode'));
  assert.equal(choicesFor({ ...base, claudeExtension: true }).find((c) => c.id === 'claude-vscode')?.label, 'Claude Code (VS Code)');
  const prompt = 'Read it & fix: "a b" ü';
  const plan = planHandOff('claude-vscode', { prompt, platform: 'darwin' });
  assert.deepEqual(plan, { kind: 'uri', uri: `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}` });
  const opened = /** @type {string[]} */ ([]);
  const clip = /** @type {string[]} */ ([]);
  const vscode = { env: { openExternal: async (/** @type {any} */ u) => { opened.push(u.s); return true; }, clipboard: { writeText: async (/** @type {string} */ t) => { clip.push(t); } } }, Uri: { parse: (/** @type {string} */ s) => ({ s }) } };
  assert.match(await handOff(vscode, 'claude-vscode', { prompt, repoRoot: '/r' }), /press Enter/);
  assert.deepEqual(opened, [`vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`]);
  const long = 'x'.repeat(MAX_URI_PROMPT_CHARS + 1);
  const msg = await handOff(vscode, 'claude-vscode', { prompt: long, repoRoot: '/r' });
  assert.equal(opened.length, 1, 'no link for a long prompt');
  assert.deepEqual(clip, [long]);
  assert.match(msg, /too long for a link/);
});
