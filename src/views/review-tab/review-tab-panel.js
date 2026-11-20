// @ts-check
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { reviewTabModel } = require('./review-tab-model');
const { buildReviewTabHtml, REVIEW_TAB_TITLE } = require('./review-tab-html');
const { splitDiff } = require('../../engine/card-facts');
const { hunkFor, callsFor } = require('../../engine/card-env');
const { lineStarts, lineOf } = require('../../engine/agent-results');

// The review tab (U1): one editor tab per window with the review's overview board and its
// card-by-card review, built by review-tab-model.js and review-tab-html.js. This module owns
// the webview panel, its messages, and the diff it reads for the hunks (one `git diff` per
// base and head, kept until they change). It only navigates: opening a change, a deleted
// function's file or a caller runs the commands the Changes view runs.

const VIEW_TYPE = 'impactTree.review';
/** Largest diff read for the hunks. Unit: bytes. Larger: the tab shows no hunks. */
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
/** Files read for caller line numbers per result. Unit: files. Past it, lines are left out. */
const MAX_FILES_READ = 2000;

/**
 * A message from the currently rendered page, or null.
 * @param {unknown} message @param {string|null} token
 * @returns {{ what: 'change'|'deleted'|'caller', id: string, index?: number }|null}
 */
function parseMessage(message, token) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  if (token === null || m.token !== token || m.type !== 'open') return null;
  if (typeof m.id !== 'string' || !m.id || m.id.length > 4096) return null;
  if (m.what === 'change' || m.what === 'deleted') return { what: m.what, id: m.id };
  if (m.what === 'caller' && Number.isSafeInteger(m.index) && /** @type {number} */ (m.index) >= 0) return { what: 'caller', id: m.id, index: /** @type {number} */ (m.index) };
  return null;
}

/**
 * The working tree's diff against `base`, without colour: what the checkout analysis compares.
 * @param {string} repo @param {string} base @returns {Promise<string>}
 */
function workingTreeDiff(repo, base) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, 'diff', '--no-color', '-U3', '--no-ext-diff', base, '--'], { maxBuffer: MAX_DIFF_BYTES, timeout: 30000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * @param {any} vscode
 * @param {{
 *   getState: () => any, agentPayload: () => unknown, repoRoot: () => string|null, log: (m: string) => void,
 *   diffText?: (repo: string, base: string) => Promise<string>, readText?: (abs: string) => string|null,
 * }} deps `getState`: the session state (result, cards, rel, source). `agentPayload`: the latest stored
 *   agent result for the shown head, or null. `diffText` and `readText` are injectable for tests.
 * @returns {{ open: () => void, refresh: () => void, disposables: Array<{ dispose(): any }> }}
 */
function createReviewTab(vscode, { getState, agentPayload, repoRoot, log, diffText = workingTreeDiff, readText = defaultRead }) {
  /** @type {{ panel: any, token: string|null, subscriptions: Array<{ dispose(): any }> }|null} */
  let current = null;
  /** The diff for the hunks, by `repo base`; a read in flight is the promise. */
  /** @type {{ key: string, diffOf: ((relPath: string, oldPath: string|undefined) => string|null)|null, pending: boolean }|null} */
  let diff = null;
  /** What the rendered page's ids name. @type {{ changed: Map<string, any>, deleted: Map<string, any> }} */
  let shown = { changed: new Map(), deleted: new Map() };
  let disposed = false;
  // A render builds the whole page on the extension host's thread (on a large PR ~200 ms and
  // hundreds of file reads), and refreshes come in bursts (result, cards, hints, the agent).
  // So a refresh only marks the page stale: a visible tab renders once in the next turn, a
  // hidden one when it is shown again. Opening the tab and the diff's arrival render at once.
  /** The page no longer shows the current state. */
  let stale = false;
  /** A render is queued for the next turn. */
  let queued = false;
  // Cache: what the page reads from the files of one result. Owner: this tab. Key: the
  // result object (line starts per file) and, for the hunks and gained/lost calls, the diff
  // too; the result's offsets are of the files as analysed, which a new analysis replaces.
  // Invalidation: a new result or diff replaces it. Size: one line-start array per caller
  // file (at most MAX_FILES_READ) and one small answer per changed function.
  /** @type {{ result: any, diffOf: any, env: { ctx: { diffOf: any }, diffCache: Map<string, string|null> }, starts: Map<string, number[]|null>, calls: Map<any, any> }|null} */
  let memo = null;
  /** @param {any} result @param {any} diffOf */
  function memoFor(result, diffOf) {
    if (memo && memo.result === result && memo.diffOf === diffOf) return memo;
    const starts = memo && memo.result === result ? memo.starts : new Map();
    memo = { result, diffOf, env: { ctx: { diffOf }, diffCache: new Map() }, starts, calls: new Map() };
    return memo;
  }
  const isVisible = () => !!current && current.panel.visible !== false;

  /** The diff of the shown checkout, read once per base; a render follows when it arrives. */
  function diffOfNow(/** @type {any} */ result) {
    const repo = repoRoot();
    if (!repo || result.tierA || !result.base || !result.base.sha) return null;
    const key = `${repo} ${result.base.sha}`;
    if (diff && diff.key === key) return diff.diffOf;
    diff = { key, diffOf: null, pending: true };
    const mine = diff;
    diffText(repo, result.base.sha).then((text) => {
      if (diff !== mine) return;
      mine.diffOf = splitDiff(text);
      mine.pending = false;
      if (isVisible()) render(); else stale = true;
    }, (e) => { if (diff === mine) mine.pending = false; log(`review tab: no diff for the hunks: ${e && e.message}`); });
    return null;
  }

  /** @returns {string|null} The page, or null when there is nothing to show (and why goes in its place). */
  function pageHtml(/** @type {string} */ nonce, /** @type {string} */ cspSource) {
    const state = getState();
    const message = (/** @type {string} */ text) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head><body><p>${text}</p></body></html>`;
    if (!state || !state.result) return message('Review a branch or a pull request first.');
    if (!state.cards) return message(state.cardsError ? 'Cards could not be built for this review.' : 'Cards are built when the analysis finishes.');
    const result = state.result;
    const diffOf = diffOfNow(result);
    const { env, starts, calls } = memoFor(result, diffOf);
    const callsOf = (/** @type {any} */ c) => {
      if (!calls.has(c)) calls.set(c, callsFor(env, c, readText));
      return calls.get(c);
    };
    const lineAt = (/** @type {string} */ file, /** @type {number} */ pos) => {
      if (!starts.has(file)) {
        if (starts.size >= MAX_FILES_READ) return null;
        const t = readText(file);
        starts.set(file, t === null ? null : lineStarts(t));
      }
      const s = starts.get(file);
      return s ? lineOf(s, pos) : null;
    };
    const model = reviewTabModel({
      result, cards: state.cards, agentPayload: agentPayload(), title: titleOf(state),
      hunkOf: (c) => (diffOf ? hunkFor(env, c).text : null), callsOf: (c) => (diffOf ? callsOf(c) : null), lineAt, rel: state.rel || ((/** @type {string} */ f) => f),
    });
    shown = {
      changed: new Map((result.allChanged || []).map((/** @type {any} */ c) => [`${c.relPath}#${c.namePos}`, c])),
      deleted: new Map((result.deleted || []).map((/** @type {any} */ d) => [`${d.relPath || d.file}#${d.namePos}`, d])),
    };
    return buildReviewTabHtml(model, { nonce, cspSource });
  }

  function render() {
    if (!current || disposed) return;
    stale = false;
    const nonce = crypto.randomBytes(16).toString('base64');
    try {
      current.panel.webview.html = pageHtml(nonce, current.panel.webview.cspSource);
      current.token = nonce;
    } catch (e) {
      log(`review tab: could not render: ${e && /** @type {any} */ (e).stack}`);
    }
  }

  /** Marks the page stale; renders it in the next turn when the tab is visible. */
  function requestRender() {
    if (!current || disposed) return;
    stale = true;
    if (queued || !isVisible()) return;
    queued = true;
    // wall-clock: next-turn — the refreshes of one turn make one render
    setTimeout(() => { queued = false; if (stale && isVisible()) render(); }, 0);
  }

  /** @param {unknown} message */
  async function onMessage(message) {
    const m = parseMessage(message, current ? current.token : null);
    if (!m) return;
    if (m.what === 'change') {
      const finding = shown.changed.get(m.id);
      if (finding) await vscode.commands.executeCommand('impactTree.openChange', { type: 'finding', label: finding.label, finding, file: finding.file, pos: finding.namePos });
    } else if (m.what === 'deleted') {
      const d = shown.deleted.get(m.id);
      if (d) await vscode.commands.executeCommand('impactTree.openFile', { type: 'deleted', relPath: d.relPath || d.file, label: d.label });
    } else {
      const finding = shown.changed.get(m.id);
      const caller = finding && (finding.callers || [])[/** @type {number} */ (m.index)];
      if (caller) await vscode.commands.executeCommand('impactTree.openCaller', caller);
    }
  }

  function open() {
    if (disposed) return;
    if (current) { current.panel.reveal(undefined, false); render(); return; }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, REVIEW_TAB_TITLE, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false });
    const opened = { panel, token: /** @type {string|null} */ (null), subscriptions: /** @type {Array<{ dispose(): any }>} */ ([]) };
    current = opened;
    opened.subscriptions = [
      panel.webview.onDidReceiveMessage((/** @type {unknown} */ m) => onMessage(m).catch((/** @type {any} */ e) => log(`review tab: ${e && e.message}`))),
      // Shown again: render what changed while it was hidden.
      panel.onDidChangeViewState(() => { if (current === opened && stale && isVisible()) render(); }),
      panel.onDidDispose(() => {
        for (const s of opened.subscriptions) s.dispose();
        opened.token = null;
        if (current === opened) { current = null; memo = null; }
      }),
    ];
    render();
  }

  return {
    open,
    /**
     * Shows the review again (analysis, cards or the agent's result changed): in the next
     * turn, once for all the refreshes of this one, or when a hidden tab is shown again.
     * Nothing when the tab is closed.
     */
    refresh: () => requestRender(),
    disposables: [{ dispose() { disposed = true; if (current) current.panel.dispose(); current = null; } }],
  };
}

/** @param {any} state */
function titleOf(state) {
  const r = state.result;
  if (r.prNumber) return `PR #${r.prNumber}${r.prTitle ? ` ${r.prTitle}` : ''}`;
  const src = state.source;
  if (src && src.pr && src.pr.number) return `PR #${src.pr.number}${src.pr.title ? ` ${src.pr.title}` : ''}`;
  return `Changes against ${r.base && r.base.ref ? r.base.ref : 'the base'}`;
}

/** @param {string} abs @returns {string|null} */
function defaultRead(abs) {
  try { return fs.readFileSync(path.resolve(abs), 'utf8'); } catch { return null; }
}

module.exports = { createReviewTab, parseMessage, VIEW_TYPE };
