// @ts-check
'use strict';
const assert = require('node:assert/strict');
const { classifyRowVerdict, stateNameOf, toneOf, LEVEL_TONES, previewLimitsNote, attentionCountText } = require('./tree-row-models');

// The detail panel's whole document: the review's progress, and the row shown in the tree
// with the reason it needs a look. Pure: the caller supplies the nonce and the webview's
// CSP source, so the panel can be tested without VS Code.
//
// Kept deliberately small. Everything else a row offers (callers, tests, threads, feedback,
// marking it reviewed, next unreviewed) is in the tree, its context menu or the diff.
//
// Safety: every value that comes from a result (labels, paths, reasons) goes through
// `escapeHtml`. The CSP allows nothing remote, and the one style and the one script are
// allowed by a nonce. Nothing uses an inline `style=` or `on…=` attribute, which that CSP
// would block.

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */

const NO_ROW_HINT = 'Select a change in the tree, or put the cursor in a changed function.';

/** @type {Record<string, string>} */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Text made safe for an HTML text node or a quoted attribute value.
 * @param {unknown} value
 * @returns {string}
 */
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);

/**
 * The caller rows under a change, one per calling function: a file group (`callerFile`)
 * stands for the callers it holds.
 * @param {TreeRow[]} impactRows The rows `buildImpactRows` gives for the change.
 * @returns {TreeRow[]}
 */
const listCallerRows = (impactRows) => impactRows.flatMap((r) => (r.type === 'callerFile' ? r.callers : r.type === 'caller' ? [r] : []));

// Colours are the theme's: a panel must read in every theme, light and dark.
const STYLE = `
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0 6px 12px 8px; }
h3 { font-family: var(--vscode-editor-font-family); font-size: 13px; font-weight: 600; margin: 6px 0 2px; word-break: break-all; }
.where { color: var(--vscode-descriptionForeground); word-break: break-all; }
.agent { margin: 8px 0; padding: 6px 8px; border-left: 2px solid var(--vscode-textLink-foreground); }
.agent .what { font-weight: 600; margin-bottom: 4px; }
.agent dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 8px; }
.agent dt { color: var(--vscode-descriptionForeground); }
.agent dd { margin: 0; }
.agent .by { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
.verdict { margin: 10px 0; padding: 7px 9px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
.verdict.lv0 { border-left-color: var(--vscode-editorError-foreground); }
.lv0 { color: var(--vscode-editorError-foreground); } .lv2 { color: var(--vscode-testing-iconPassed); }
.note { color: var(--vscode-descriptionForeground); margin-top: 4px; }
.progress { position: sticky; top: 0; z-index: 1; margin: 0 -6px 6px -8px; padding: 6px 6px 8px 8px; font-size: 12px;
  background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
.progress .nums { display: flex; gap: 10px; }
.progress progress { display: block; width: 100%; height: 4px; margin-top: 5px; border: 0; border-radius: 2px; overflow: hidden;
  appearance: none; background: var(--vscode-widget-border, var(--vscode-panel-border)); }
.progress progress::-webkit-progress-bar { background: var(--vscode-widget-border, var(--vscode-panel-border)); }
.progress progress::-webkit-progress-value { background: var(--vscode-testing-iconPassed); }
.actions { margin-top: 12px; }
button { font: inherit; border: 0; border-radius: 2px; padding: 4px 10px; margin: 0 6px 6px 0; cursor: pointer;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
`;

// Patches the progress strip in place, and turns a click on the Preview's button into a
// message for the extension. The extension validates every message, so this script decides
// nothing. Every message carries this page's nonce, so a delayed click cannot act on another
// analysis. The ready handshake recovers any update sent before this script installed its listener.
/** @param {string} token The validated base64 nonce of this rendered page. */
const script = (token) => `
const vscode = acquireVsCodeApi();
const token = ${JSON.stringify(token)};
const postMessage = (message) => vscode.postMessage({ ...message, token });
const setText = (selector, text) => { const el = document.querySelector(selector); if (el) el.textContent = text; };
const patchProgress = (m) => {
  const ok = m && typeof m.countText === 'string' && typeof m.attentionText === 'string'
    && Number.isSafeInteger(m.reviewed) && Number.isSafeInteger(m.total)
    && m.reviewed >= 0 && m.total > 0 && m.reviewed <= m.total && (m.attentionClass === 'lv0' || m.attentionClass === 'lv2');
  if (!ok) return;
  setText('[data-progress-count]', m.countText);
  const attention = document.querySelector('[data-progress-attention]');
  if (attention) { attention.textContent = m.attentionText; attention.setAttribute('class', m.attentionClass); }
  const meter = document.querySelector('[data-progress-meter]');
  if (meter) { meter.setAttribute('max', String(m.total)); meter.setAttribute('value', String(m.reviewed)); meter.textContent = m.countText; }
};
window.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.token === token && data.type === 'progress') patchProgress(data.model);
});
document.addEventListener('click', (event) => {
  const el = event.target instanceof Element ? event.target.closest('[data-act]') : null;
  if (!el) return;
  event.preventDefault();
  if (el.getAttribute('data-act') === 'checkout') postMessage({ type: 'checkoutAndAnalyse' });
});
postMessage({ type: 'ready' });
`;

/**
 * The review's progress strip, as text and numbers. Pure, shared by the initial HTML and
 * its later patches, so the page never formats anything itself.
 * @typedef {{ reviewed: number, total: number, countText: string, attentionText: string,
 *   attentionClass: 'lv0'|'lv2' }} ProgressPresentation
 * @param {{ total: number, left: number, attention: number }|null} progress The counts from `countReview`.
 * @returns {ProgressPresentation|null} Null when there is nothing to count.
 */
function progressPresentation(progress) {
  if (!progress || progress.total <= 0) return null;
  const reviewed = progress.total - progress.left;
  return {
    reviewed, total: progress.total,
    countText: `${reviewed} of ${progress.total} reviewed`,
    attentionText: progress.attention ? attentionCountText(progress.attention) : 'nothing needs attention',
    attentionClass: progress.attention ? 'lv0' : 'lv2',
  };
}

/** @param {ProgressPresentation|null} model @returns {string} The strip, or nothing. */
function progressHtml(model) {
  if (!model) return '';
  return `<div class="progress"><div class="nums"><span data-progress-count>${escapeHtml(model.countText)}</span>`
    + `<span class="${model.attentionClass}" data-progress-attention>${escapeHtml(model.attentionText)}</span></div>`
    + `<progress max="${model.total}" value="${model.reviewed}" data-progress-meter>${escapeHtml(model.countText)}</progress></div>`;
}

/**
 * Why a row needs a look, in the tree's words: only for a row the tree colours red or
 * amber. A fine row (and a file row, whose changes speak for themselves) gets nothing.
 * @param {TreeRow} row A `finding`, `deleted` or `outside` row.
 * @returns {string}
 */
function verdictHtml(row) {
  const v = classifyRowVerdict(row);
  const tone = toneOf(v);
  if (!tone) return '';
  const cls = tone === LEVEL_TONES[0] ? ' lv0' : '';
  const name = row.type === 'finding' ? `<b>${stateNameOf(row, v)}.</b> ` : '';
  return `<div class="verdict${cls}">${name}${escapeHtml(v.sentence)}</div>`;
}

/**
 * The notice on a file that was not analysed: amber, never the quiet look of a file with
 * nothing to find.
 * @param {TreeRow} row
 * @returns {string} Nothing for a row that was analysed.
 */
function notAnalysedHtml(row) {
  if (row.type !== 'file' || !row.notAnalysed) return '';
  return `<div class="verdict" data-not-analysed><b>Not analysed.</b> ${escapeHtml(row.notAnalysed.language)}: ${escapeHtml(row.notAnalysed.reason)}. `
    + 'Nothing was established about this file, so read its diff by hand.</div>';
}

/**
 * What a Preview cannot see, with the way out. A Preview searches only the pull request's
 * own files, so a change with no callers here may still have callers elsewhere: the page
 * must not let that read as "no impact".
 * @param {any} result The shown result.
 * @returns {string} Nothing for a result that is not a Preview.
 */
function previewLimitsHtml(result) {
  if (!result || !result.tierA) return '';
  return `<div class="note" data-preview-limits>${escapeHtml(previewLimitsNote(result))}</div>`
    + '<div class="actions"><button data-act="checkout">Check out and analyse</button></div>';
}

/**
 * The title and path of a row.
 * @param {TreeRow} row
 * @returns {string}
 */
function headHtml(row) {
  if (row.type === 'finding') {
    const c = row.finding;
    return `<h3>${escapeHtml(c.label)}</h3><div class="where">${escapeHtml(c.relPath)}:${c.startLine}–${c.endLine}</div>`;
  }
  if (row.type === 'outside') return `<h3>Outside functions</h3><div class="where">${escapeHtml(row.relPath)}</div>`;
  const status = row.type === 'deleted' ? 'deleted' : row.status ?? 'changed';
  return `<h3>${escapeHtml(row.label)}</h3><div class="where">${escapeHtml(row.relPath)} · ${escapeHtml(status)}</div>`;
}

/**
 * The body for one row, or the hint when there is none.
 * @param {TreeRow|null} row
 * @param {any} result
 * @param {any} [agentChange] What the agent says the row's change does, or null.
 * @returns {string}
 */
function bodyHtml(row, result, agentChange = null) {
  if (!row) return `<p class="where">${NO_ROW_HINT}</p>`;
  const isFile = row.type === 'reviewFile' || row.type === 'file';
  return headHtml(row) + agentHtml(agentChange) + (isFile ? notAnalysedHtml(row) : verdictHtml(row)) + previewLimitsHtml(result);
}

const KIND_WORDS = { changed: 'Changed', 'may-change': 'May change', new: 'New', same: 'Same behaviour, new way' };

/**
 * What the user's agent says the change does to behaviour, when it said something.
 * @param {{ kind: string, what: string, before?: string, after?: string, when?: string, affects?: Array<{ name: string, how: string }> }|null} b
 * @returns {string}
 */
function agentHtml(b) {
  if (!b || typeof b.what !== 'string') return '';
  const word = /** @type {Record<string, string>} */ (KIND_WORDS)[b.kind] || 'Changed';
  const rows = [['Before', b.before], ['After', b.after], ['When', b.when]].filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`);
  (Array.isArray(b.affects) ? b.affects : []).forEach((a, i) => {
    rows.push(`<dt>${i ? '' : 'Affects'}</dt><dd><b>${escapeHtml(a.name)}</b> — ${escapeHtml(a.how)}</dd>`);
  });
  return `<div class="agent"><div class="what">${escapeHtml(word)}: ${escapeHtml(b.what)}</div>${rows.length ? `<dl>${rows.join('')}</dl>` : ''}<div class="by">Written by your agent</div></div>`;
}

/**
 * The detail panel's document for one row of the change tree.
 * @param {TreeRow|null} row A counting row (`finding`, `deleted`, `outside`, `file`) or a
 *   `reviewFile` row; null shows a hint. A caller or tests row is shown as the change it
 *   sits under, which the caller resolves.
 * @param {{ result: any, nonce: string, cspSource: string, progress?: ProgressPresentation|null, agentChange?: any }} opts
 *   `result` is the shown result. `nonce` is base64 and fresh per document; `cspSource` is
 *   the webview's. `progress` is the strip above the row; none when absent or null.
 * @returns {string} The whole HTML document.
 */
function buildDetailHtml(row, { result, nonce, cspSource, progress = null, agentChange = null }) {
  assert.match(nonce, /^[A-Za-z0-9+/=]+$/, 'the nonce must be base64 so it cannot break out of the CSP');
  const csp = `default-src 'none'; style-src ${escapeHtml(cspSource)} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + `<style nonce="${nonce}">${STYLE}</style></head>`
    + `<body>${progressHtml(progress)}${bodyHtml(row, result, agentChange)}`
    + `<script nonce="${nonce}">${script(nonce)}</script></body></html>`;
}

module.exports = { progressPresentation, buildDetailHtml, listCallerRows, escapeHtml };
