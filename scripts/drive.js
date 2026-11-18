#!/usr/bin/env node
// @ts-check
'use strict';
// A development tool: run the extension from this working tree inside a real VS Code, take a few
// steps, and leave screenshots and text an agent (or a person) can read to check a change. Each
// run starts a fresh, throwaway profile, so it never touches the editor you work in.
//
//   node scripts/drive.js [--repo PATH] [--out DIR] [--keep-open] <steps…>
//
// Without --repo it opens the demo repository (scripts/demo-repo.js), built fresh for the run.
// Steps run in order; the run stops at the first one that fails (saving failure.png and the dumps).
// TEXT matches a row's visible text (label and description), ignoring case; the first row on
// screen that contains it wins, so use specific text.
//   view          open the Impact Tree side bar
//   cmd:ID        run a command by its id (impactTree.refresh), through the command palette
//   pick:TEXT     choose the entry containing TEXT in the open quick pick (after a cmd that asks)
//   key:KEY       press a key (Escape, Enter, ArrowDown…; Playwright's key names)
//   click:TEXT    select the first Review row containing TEXT (waits for it to appear)
//   expand:TEXT   open the first Review row containing TEXT, without selecting it
//   wait:TEXT     wait until TEXT shows in the Review tree, the Details view or the review tab
//   shot:NAME     save the window as NAME.png
//   dump[:NAME]   write tree.txt (the Review rows on screen), details.txt (the Details text) and
//                 review.txt (the review tab's text), or NAME-tree.txt, NAME-details.txt…
// Output (default .vscode-test/out/latest/, replaced each run): the PNGs, the dumps, summary.json
// and the extension's log. Exit code: 0 passed, 1 a step or the launch failed, 2 the run passed its
// deadline, 130 interrupted. The window shows on screen and takes focus while the run lasts.
// macOS and Linux only. See docs/driving-the-extension.md.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = require(path.join(ROOT, 'package.json'));
const { REVIEW_TAB_TITLE } = require(path.join(ROOT, 'src/views/review-tab/review-tab-html'));
const EXTENSION_ID = `${MANIFEST.publisher}.${MANIFEST.name}`;
/** Pinned so the download is cached and the workbench's markup stays the same between runs. */
const VSCODE_VERSION = '1.146.0';
const WINDOW = { width: 1400, height: 900 };
/** The whole run, launch to shutdown (the first run's VS Code download comes before it). */
const DEADLINE_MS = 60_000;
const STEP_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 3_000;

const SETTINGS = {
  'impactTree.analyseOnStartup': true,
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'telemetry.telemetryLevel': 'off',
  'workbench.tips.enabled': false,
  'workbench.colorTheme': 'Default Dark Modern',
  'git.openRepositoryInParentFolders': 'never',
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  // Lighter runs: one TypeScript server instead of two (the extension needs the full one), and
  // no animations or minimap to paint.
  'typescript.tsserver.useSyntaxServer': 'never',
  'workbench.reduceMotion': 'on',
  'editor.minimap.enabled': false,
};

/** Built-in extensions that run code and that the review needs: the TypeScript language server. */
const KEEP_BUILTINS = new Set(['vscode.typescript-language-features']);

/**
 * The built-in extensions to switch off for the run: every one that runs code (git, GitHub,
 * Copilot, the debuggers, npm, emmet…) except those the review needs. Grammars and themes run
 * nothing and stay. Each one switched off is a process or an activation less on a busy machine.
 * @param {string} executablePath
 * @returns {string[]} Their ids.
 */
function idleBuiltins(executablePath) {
  // macOS: Code.app/Contents/MacOS/Code -> Contents/Resources/app; Linux: <dir>/code -> <dir>/resources/app.
  const dir = process.platform === 'darwin'
    ? path.join(path.dirname(executablePath), '..', 'Resources', 'app', 'extensions')
    : path.join(path.dirname(executablePath), 'resources', 'app', 'extensions');
  if (!fs.existsSync(dir)) return [];
  /** @type {string[]} */
  const ids = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = `${manifest.publisher}.${manifest.name}`;
    if ((manifest.main || manifest.browser) && !KEEP_BUILTINS.has(id)) ids.push(id);
  }
  return ids;
}

/**
 * What the command palette shows for a command id: "Category: Title", as package.json declares it.
 * Several commands share a title ("Impact Tree: Show all"), so an ambiguous one is refused rather
 * than guessed; a command hidden from the palette (`when: false`) cannot be run this way.
 * @param {string} id
 */
function paletteLabel(id) {
  const { contributes } = MANIFEST;
  /** @param {{ category?: string, title: string }} c */
  const label = (c) => (c.category ? `${c.category}: ${c.title}` : c.title);
  const cmd = contributes.commands.find((/** @type {{ command: string }} */ c) => c.command === id);
  if (!cmd) throw new Error(`no command ${id} in package.json`);
  const hidden = (contributes.menus.commandPalette || []).some((/** @type {{ command: string, when?: string }} */ m) => m.command === id && m.when === 'false');
  if (hidden) throw new Error(`${id} is hidden from the command palette`);
  const text = label(cmd);
  if (contributes.commands.filter((/** @type {any} */ c) => label(c) === text).length > 1) throw new Error(`${id}: several commands are titled "${text}"; the palette cannot tell them apart`);
  return text;
}

/** @param {string} step @returns {{ verb: string, arg: string }} */
const splitStep = (step) => {
  const colon = step.indexOf(':');
  return colon < 0 ? { verb: step, arg: '' } : { verb: step.slice(0, colon), arg: step.slice(colon + 1) };
};

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ repo: string|null, out: string, keepOpen: boolean, steps: string[] }} */
  const o = { repo: null, out: path.join(ROOT, '.vscode-test', 'out', 'latest'), keepOpen: false, steps: [] };
  /** @param {number} i */
  const value = (i) => {
    if (argv[i] === undefined || argv[i].startsWith('--')) throw new Error(`${argv[i - 1]} needs a path`);
    return path.resolve(argv[i]);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = value(++i);
    else if (a === '--out') o.out = value(++i);
    else if (a === '--keep-open') o.keepOpen = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.steps.push(a);
  }
  if (!o.steps.length) throw new Error('no steps given; for example: node scripts/drive.js view shot:start');
  if (o.repo && !fs.existsSync(o.repo)) throw new Error(`--repo ${o.repo} does not exist`);
  // Every step is checked before the editor starts, so a typo fails in milliseconds, not after a launch.
  for (const step of o.steps) {
    const { verb, arg } = splitStep(step);
    if (!VERBS[verb]) throw new Error(`unknown step "${step}"; steps: ${Object.keys(VERBS).join(', ')}`);
    if (NEEDS_ARG.has(verb) && !arg) throw new Error(`"${step}" needs text after the colon: ${verb}:…`);
    if (verb === 'cmd') paletteLabel(arg);
  }
  return o;
}

/**
 * Empties the output folder for this run. It is replaced each run, so it must be one this tool
 * made (it holds a summary.json) or empty; any other folder is refused rather than deleted.
 * @param {string} out
 */
function prepareOut(out) {
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length && !entries.includes('summary.json')) throw new Error(`--out ${out} is not empty and was not written by this tool; choose another folder`);
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(out, { recursive: true });
}

/**
 * The editor's environment: this process's, without what an editor terminal adds. With
 * ELECTRON_RUN_AS_NODE set, the editor starts as plain Node and the launch hangs; VSCODE_* would
 * point the new editor at the one this command was typed in. TMPDIR is the run's own, so the
 * agent bridge's socket (under the temp folder) never meets the bridge of an editor you have open.
 * @param {string} tmp
 */
function editorEnv(tmp) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_')) continue;
    env[k] = v;
  }
  env.TMPDIR = tmp;
  return env;
}

/** Kills whatever is left of the run's editor: every process started with its profile folder. */
function killLeftovers(/** @type {string} */ userData) {
  try { execFileSync('pkill', ['-9', '-f', userData], { stdio: 'ignore' }); } catch { /* none left */ }
}

/** @param {string} dir @returns {string|null} The extension's log file in the profile, if written. */
function findLog(dir) {
  const logs = path.join(dir, 'logs');
  if (!fs.existsSync(logs)) return null;
  for (const session of fs.readdirSync(logs).sort().reverse()) {
    const exthost = path.join(logs, session, 'window1', 'exthost');
    if (!fs.existsSync(exthost)) continue;
    for (const ext of fs.readdirSync(exthost)) {
      const file = path.join(exthost, ext, 'Impact Tree.log');
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** The Review tree's rows on screen. The list is virtualised: rows scrolled out of view are not in the page. */
const reviewRows = (/** @type {import('playwright').Page} */ page) =>
  page.locator('.part.sidebar .pane', { has: page.locator('.pane-header', { hasText: /^review/i }) }).locator('.monaco-list-row');

/**
 * The Review rows on screen as the reviewer sees them: visible label and description, tree level,
 * open/closed, selected, and the screen reader's text when it says something the row does not show.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ text: string, level: number, expanded: string|null, selected: boolean, aria: string }[]>}
 */
function readRows(page) {
  return reviewRows(page).evaluateAll((rows) => rows.map((r) => {
    const part = (/** @type {string} */ sel) => ((r.querySelector(sel) || {}).textContent || '').trim();
    const name = part('.label-name');
    const description = part('.label-description');
    const text = name ? [name, description].filter(Boolean).join('  ') : (r.textContent || '').trim();
    // VS Code appends ", has actions" to rows with inline buttons; that alone says nothing.
    const aria = (r.getAttribute('aria-label') || '').replace(/,? has actions$/, '').trim();
    return {
      text,
      level: Number(r.getAttribute('aria-level') || 1),
      expanded: r.getAttribute('aria-expanded'),
      selected: r.getAttribute('aria-selected') === 'true',
      aria: aria && !aria.includes(name) ? aria : '',
    };
  }));
}

/** @param {Awaited<ReturnType<typeof readRows>>[number]} r */
const rowLine = (r) => `${'  '.repeat(r.level - 1)}${r.expanded === 'true' ? 'v ' : r.expanded === 'false' ? '> ' : '  '}${r.text}`
  + `${r.selected ? '  [selected]' : ''}${r.aria ? `  (screen reader: ${r.aria})` : ''}`;

/** @param {string} haystack @param {string} needle */
const contains = (haystack, needle) => haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * Waits for the first Review row whose visible text contains `text`.
 * @param {import('playwright').Page} page @param {string} text
 * @returns {Promise<{ row: import('playwright').Locator, info: Awaited<ReturnType<typeof readRows>>[number] }>}
 */
async function findRow(page, text) {
  /** @type {Awaited<ReturnType<typeof readRows>>} */
  let rows = [];
  let index = -1;
  await poll(async () => {
    rows = await readRows(page).catch(() => []);
    index = rows.findIndex((r) => contains(r.text, text));
    return index >= 0;
  }, STEP_TIMEOUT_MS);
  if (index < 0) throw new Error(`no Review row on screen contains "${text}"; rows: ${rows.map((r) => r.text).join(' | ') || '(none)'}`);
  return { row: reviewRows(page).nth(index), info: rows[index] };
}

/**
 * The Details view's document. A webview is two frames deep: an outer frame VS Code owns (its URL
 * names the extension and `purpose=webviewView`) and the extension's page, its only child frame.
 * Details is the extension's only webview view; it exists while its pane is expanded.
 * @param {import('playwright').Page} page
 */
function detailsFrame(page) {
  const outer = page.frames().find((f) => contains(f.url(), `extensionId=${EXTENSION_ID}`) && f.url().includes('purpose=webviewView'));
  return (outer && outer.childFrames()[0]) || null;
}

/** @param {import('playwright').Page} page @returns {Promise<string>} The Details text, or '' while it is not there. */
async function detailsText(page) {
  const frame = detailsFrame(page);
  if (!frame) return '';
  return frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
}

/**
 * The review tab's document (`cmd:impactTree.openReview`), found by its page title among the
 * extension's webview panels (src/views/review-tab/review-tab-html.js REVIEW_TAB_TITLE). Null
 * while the tab is closed or behind another editor tab: its page is dropped while hidden.
 * @param {import('playwright').Page} page
 * @returns {Promise<import('playwright').Frame|null>}
 */
async function reviewFrame(page) {
  for (const outer of page.frames()) {
    if (!contains(outer.url(), `extensionId=${EXTENSION_ID}`) || outer.url().includes('purpose=webviewView')) continue;
    for (const inner of outer.childFrames()) {
      if (await inner.title().catch(() => '') === REVIEW_TAB_TITLE) return inner;
    }
  }
  return null;
}

/** @param {import('playwright').Page} page @returns {Promise<string>} The review tab's text, or '' while it is not there. */
async function reviewText(page) {
  const frame = await reviewFrame(page);
  if (!frame) return '';
  return frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
}

/** @param {() => Promise<boolean>} check @param {number} timeout */
async function poll(check, timeout) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Steps that need text after the colon. */
const NEEDS_ARG = new Set(['cmd', 'pick', 'key', 'click', 'expand', 'wait', 'shot']);

/**
 * The step verbs. Each gets the page, the output folder and the step's argument (the text after
 * the first colon), and may return a note for the step's line (which row it matched, say).
 * @type {Record<string, (ctx: { page: import('playwright').Page, out: string, files: string[] }, arg: string) => Promise<string|void>>}
 */
const VERBS = {
  async view({ page }) {
    const item = page.locator('.part.activitybar .action-item', { has: page.locator('[aria-label^="Impact Tree"]') }).first();
    await item.waitFor({ timeout: STEP_TIMEOUT_MS });
    // Clicking the open container's icon would close it: click only when another one is showing.
    // The icon's own checked state is set with the side bar, so it does not race the title's drawing.
    if (!/\bchecked\b/.test(await item.getAttribute('class') || '')) await item.click();
    await page.locator('.part.sidebar .pane-header', { hasText: /review/i }).first().waitFor({ timeout: STEP_TIMEOUT_MS });
  },
  async cmd({ page }, id) {
    const text = paletteLabel(id);
    await page.keyboard.press('F1');
    const input = page.locator('.quick-input-widget input');
    await input.waitFor({ timeout: STEP_TIMEOUT_MS });
    await input.fill(`>${text}`);
    // Pick the exact entry, not the first fuzzy match; its context (`when`) must allow it right now.
    const row = page.locator('.quick-input-list .monaco-list-row', { has: page.locator('.label-name', { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
    await row.waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => { throw new Error(`"${text}" is not in the command palette now (its when-clause may hide it)`); });
    await row.click();
  },
  async pick({ page }, text) {
    const rows = page.locator('.quick-input-widget .quick-input-list .monaco-list-row');
    /** Each entry as shown: label and description. */
    const entries = () => rows.evaluateAll((els) => els.map((e) => ['.label-name', '.label-description']
      .map((sel) => ((e.querySelector(sel) || {}).textContent || '').trim()).filter(Boolean).join('  '))).catch(() => /** @type {string[]} */ ([]));
    /** @type {string[]} */
    let shown = [];
    let index = -1;
    await poll(async () => {
      shown = await entries();
      index = shown.findIndex((e) => contains(e, text));
      return index >= 0;
    }, STEP_TIMEOUT_MS);
    if (index < 0) throw new Error(`no quick pick entry contains "${text}"; entries: ${shown.join(' | ') || '(no quick pick open)'}`);
    await rows.nth(index).click();
    return shown[index];
  },
  async key({ page }, key) {
    await page.keyboard.press(key);
  },
  async click({ page }, text) {
    const { row, info } = await findRow(page, text);
    await row.click();
    return info.text;
  },
  async expand({ page }, text) {
    const { row, info } = await findRow(page, text);
    if (info.expanded === null) throw new Error(`the row "${info.text}" has no children to open`);
    if (info.expanded === 'false') await row.locator('.monaco-tl-twistie').click();
    return info.text;
  },
  async wait({ page }, text) {
    const found = await poll(async () => (await readRows(page).catch(() => [])).some((r) => contains(r.text, text))
      || contains(await detailsText(page), text) || contains(await reviewText(page), text), STEP_TIMEOUT_MS);
    if (!found) throw new Error(`"${text}" did not show in the Review tree, Details or the review tab within ${STEP_TIMEOUT_MS / 1000} s`);
  },
  async dump({ page, out, files }, name) {
    const prefix = name ? `${name}-` : '';
    const rows = await readRows(page).catch(() => []);
    fs.writeFileSync(path.join(out, `${prefix}tree.txt`), `# Review rows on screen (the list only holds the visible ones)\n${rows.map(rowLine).join('\n')}\n`);
    const frame = detailsFrame(page);
    fs.writeFileSync(path.join(out, `${prefix}details.txt`), frame ? `${await detailsText(page)}\n` : '# the Details view is not open (expand its pane)\n');
    const review = await reviewFrame(page);
    fs.writeFileSync(path.join(out, `${prefix}review.txt`), review
      ? `${await review.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')}\n`
      : '# the review tab is not showing (open it with cmd:impactTree.openReview; a tab behind another one has no page)\n');
    files.push(`${prefix}tree.txt`, `${prefix}details.txt`, `${prefix}review.txt`);
  },
  async shot({ page, out, files }, name) {
    await page.screenshot({ path: path.join(out, `${name}.png`), scale: 'css' });
    files.push(`${name}.png`);
  },
};

/** @param {unknown} e */
const firstLine = (e) => String((e && /** @type {Error} */ (e).message) || e).split('\n')[0];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { _electron } = require('playwright');
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  const executablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  prepareOut(opts.out);

  // A short folder: the agent bridge's socket lives under it, and macOS caps socket paths at 104 bytes.
  const run = fs.mkdtempSync(path.join('/tmp', 'itd-'));
  const userData = path.join(run, 'user-data');
  const tmp = path.join(run, 'tmp');
  const started = Date.now();
  /** @type {{ step: string, ok: boolean, ms: number, note?: string, error?: string }[]} */
  const results = [];
  /** @type {string[]} */
  const files = [];
  /** @type {import('playwright').ElectronApplication|null} */
  let app = null;
  let repo = opts.repo;
  let failed = false;

  // One teardown for every way the run ends: finished, failed, past its deadline or interrupted.
  // The log is copied after the editor has gone, so its last buffered lines are in it.
  let tornDown = false;
  /** @param {number} code */
  const finish = async (code) => {
    if (tornDown) return;
    tornDown = true;
    if (app) {
      const closing = app.close().catch(() => {});
      await Promise.race([closing, new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))]);
    }
    killLeftovers(userData);
    const log = findLog(userData);
    if (log) { fs.copyFileSync(log, path.join(opts.out, 'Impact Tree.log')); files.push('Impact Tree.log'); }
    fs.writeFileSync(path.join(opts.out, 'summary.json'), JSON.stringify({
      ok: code === 0, exitCode: code, vscode: VSCODE_VERSION, repo, ms: Date.now() - started, steps: results, files,
    }, null, 2));
    fs.rmSync(run, { recursive: true, force: true });
    console.log(`${code === 0 ? 'passed' : 'FAILED'} in ${Date.now() - started} ms; output in ${opts.out}`);
    process.exit(code);
  };
  const deadline = setTimeout(() => {
    results.push({ step: 'deadline', ok: false, ms: Date.now() - started, error: `the run passed its ${DEADLINE_MS / 1000} s deadline` });
    console.log(`FAIL deadline  the run passed its ${DEADLINE_MS / 1000} s deadline; stopping the editor`);
    void finish(2);
  }, DEADLINE_MS).unref();
  process.on('SIGINT', () => {
    results.push({ step: 'interrupted', ok: false, ms: Date.now() - started });
    void finish(130);
  });

  let stage = 'preparing the run';
  try {
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
    if (!repo) {
      stage = 'building the demo repository';
      const { buildDemoRepo } = require('./demo-repo');
      ({ repo } = await buildDemoRepo({ templateDir: path.join(ROOT, 'demo'), parentDir: path.join(run, 'demo') }));
    }
    stage = 'starting the editor';
    app = await _electron.launch({
      executablePath,
      args: [
        `--extensionDevelopmentPath=${ROOT}`,
        `--user-data-dir=${userData}`,
        `--extensions-dir=${path.join(run, 'ext')}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--use-inmemory-secretstorage',
        ...idleBuiltins(executablePath).map((id) => `--disable-extension=${id}`),
        '--new-window',
        /** @type {string} */ (repo),
      ],
      env: editorEnv(tmp),
      timeout: READY_TIMEOUT_MS,
    });
    stage = 'waiting for the window';
    const page = await app.firstWindow({ timeout: READY_TIMEOUT_MS });
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setBounds({ x: 40, y: 40, ...size });
    }, WINDOW);
    stage = 'waiting for the workbench';
    await page.locator('.monaco-workbench').waitFor({ timeout: READY_TIMEOUT_MS });
    // The extension's container appears in the activity bar once the extension is registered.
    stage = 'waiting for the Impact Tree icon (the extension did not register)';
    await page.locator('.part.activitybar [aria-label^="Impact Tree"]').first().waitFor({ timeout: READY_TIMEOUT_MS });
    results.push({ step: 'ready', ok: true, ms: Date.now() - started });
    console.log(`ok   ready  ${Date.now() - started} ms`);

    for (const step of opts.steps) {
      const at = Date.now();
      const { verb, arg } = splitStep(step);
      try {
        const note = await VERBS[verb]({ page, out: opts.out, files }, arg);
        results.push({ step, ok: true, ms: Date.now() - at, ...(note ? { note } : {}) });
        console.log(`ok   ${step}  ${Date.now() - at} ms${note ? `  -> ${note}` : ''}`);
      } catch (e) {
        failed = true;
        results.push({ step, ok: false, ms: Date.now() - at, error: firstLine(e) });
        console.log(`FAIL ${step}  ${firstLine(e)}`);
        await VERBS.shot({ page, out: opts.out, files }, 'failure').catch(() => {});
        await VERBS.dump({ page, out: opts.out, files }, '').catch(() => {});
        break;
      }
    }
    if (opts.keepOpen) {
      // For a person looking around by hand; an agent never needs it. On macOS closing the last
      // window leaves the app running, so the window's own close ends the run too, as does Ctrl+C.
      clearTimeout(deadline);
      console.log('drive: the editor stays open; close its window or press Ctrl+C to end the run');
      const live = app;
      await new Promise((resolve) => { live.on('close', () => resolve(undefined)); page.on('close', () => resolve(undefined)); });
    }
  } catch (e) {
    failed = true;
    results.push({ step: 'launch', ok: false, ms: Date.now() - started, error: `${stage}: ${firstLine(e)}` });
    console.log(`FAIL launch  ${stage}: ${firstLine(e)}`);
  }
  await finish(failed ? 1 : 0);
}

main().catch((e) => { console.error(`drive: ${e.message}`); process.exit(1); });
