// @ts-check
'use strict';
const assert = require('node:assert/strict');
const { classifyRowVerdict, CALL_STATE } = require('./tree-row-models');
const { treeItemId } = require('./review-tree-model');

// The detail panel's whole document, built from one row of the change tree. Pure: the
// caller supplies everything that needs the editor or the disk (the ticks, the change's
// impact rows, a call site's line, the nonce and the webview's CSP source), so the panel
// can be tested without VS Code.
//
// Safety: every value that comes from a result (labels, paths, signatures, throws,
// reasons, test names) goes through `escapeHtml`. The CSP allows nothing remote, and the
// one style and the one script are allowed by a nonce. Nothing uses an inline `style=` or
// `on…=` attribute, which that CSP would block.

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */

// Level 0 breaks callers, 1 risk unknown, 2 risk handled, 3 behaviour reaches callers, 4 quiet.
const VERDICT_WORDS = ['Needs attention', 'Risk unknown', 'Risk handled', 'Reaches callers', 'Quiet'];

const NO_ROW_HINT = 'Select a change in the tree, or put the cursor in a changed function.';

// How each call state looks in the callers table: the token's colour class follows the mockup.
/** @type {Record<string, string>} */
const CALL_STATE_CLASS = { 'updated-at-call': 'lv2', 'changed-elsewhere': 'lv1', unchanged: 'lv4' };
const UNKNOWN_CALL_STATE = { token: '?', text: 'unknown' };

/** @type {Record<string, string>} */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Text made safe for an HTML text node or a quoted attribute value.
 * @param {unknown} value
 * @returns {string}
 */
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);

/**
 * A signature as a reader wants it: without the `: ⟨inferred⟩` and ` => ⟨inferred⟩` the
 * analysis writes where no type was written. For display only; the result keeps them.
 * @param {string} signature
 * @returns {string}
 */
const tidySignature = (signature) => signature.replace(/: ⟨inferred⟩/g, '').replace(/ => ⟨inferred⟩/g, '');

/**
 * The caller rows under a change, one per calling function: a file group (`callerFile`)
 * stands for the callers it holds. The panel numbers callers in this order, and a
 * webview's `openCaller` message names one by its index here.
 * @param {TreeRow[]} impactRows The rows `buildImpactRows` gives for the change.
 * @returns {TreeRow[]}
 */
const listCallerRows = (impactRows) => impactRows.flatMap((r) => (r.type === 'callerFile' ? r.callers : r.type === 'caller' ? [r] : []));

// Colours are the theme's: a panel must read in every theme, light and dark.
const STYLE = `
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0 6px 12px 8px; }
.origin { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 6px 0 2px; }
h3 { font-family: var(--vscode-editor-font-family); font-size: 13px; font-weight: 600; margin: 6px 0 2px; word-break: break-all; }
h4 { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 12px 0 4px; }
h4 a { text-transform: none; letter-spacing: 0; margin-left: 6px; }
.where { color: var(--vscode-descriptionForeground); word-break: break-all; }
.verdict { margin: 10px 0; padding: 7px 9px; border-left: 3px solid var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); }
.verdict.lv0 { border-left-color: var(--vscode-editorError-foreground); }
.verdict.lv1 { border-left-color: var(--vscode-editorWarning-foreground); }
.verdict.lv2 { border-left-color: var(--vscode-testing-iconPassed); }
.verdict.lv3 { border-left-color: var(--vscode-editorInfo-foreground); }
.lv0 { color: var(--vscode-editorError-foreground); } .lv1 { color: var(--vscode-editorWarning-foreground); }
.lv2 { color: var(--vscode-testing-iconPassed); } .lv4 { color: var(--vscode-descriptionForeground); }
.sig { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); padding: 2px 6px; white-space: pre-wrap; word-break: break-all; }
.sig.old { background: var(--vscode-diffEditor-removedTextBackground); }
.sig.new { background: var(--vscode-diffEditor-insertedTextBackground); }
table { border-collapse: collapse; width: 100%; }
td { padding: 2px 4px; vertical-align: top; }
td.st { width: 18px; text-align: center; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.note { color: var(--vscode-descriptionForeground); margin-top: 4px; }
.stale { color: var(--vscode-editorError-foreground); white-space: nowrap; }
.progress { position: sticky; top: 0; z-index: 1; margin: 0 -6px 6px -8px; padding: 6px 6px 8px 8px; font-size: 12px;
  background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
.progress .nums { display: flex; gap: 10px; }
.progress .pct { margin-left: auto; color: var(--vscode-descriptionForeground); }
.progress progress { display: block; width: 100%; height: 4px; margin-top: 5px; border: 0; border-radius: 2px; overflow: hidden;
  appearance: none; background: var(--vscode-widget-border, var(--vscode-panel-border)); }
.progress progress::-webkit-progress-bar { background: var(--vscode-widget-border, var(--vscode-panel-border)); }
.progress progress::-webkit-progress-value { background: var(--vscode-testing-iconPassed); }
.actions { margin-top: 12px; }
button { font: inherit; border: 0; border-radius: 2px; padding: 4px 10px; margin: 0 6px 6px 0; cursor: pointer;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

// Turns a click on a button or caller link into a message for the extension. The extension
// validates every message, so this script decides nothing. Every action carries this
// page's nonce, so a delayed click cannot act on another row or analysis. An
// `origin` and `review` messages patch text/attributes without reloading the page.
// The ready handshake recovers any update sent before this script installed its listener.
/** @param {string} token The validated base64 nonce of this rendered page. */
const script = (token) => `
const vscode = acquireVsCodeApi();
const token = ${JSON.stringify(token)};
const postMessage = (message) => vscode.postMessage({ ...message, token });
const setText = (selector, text) => { const el = document.querySelector(selector); if (el) el.textContent = text; };
const patchProgress = (m) => {
  const ok = m && typeof m.line === 'string' && typeof m.countText === 'string' && typeof m.attentionText === 'string'
    && typeof m.percentText === 'string' && Number.isSafeInteger(m.reviewed) && Number.isSafeInteger(m.total)
    && m.reviewed >= 0 && m.total > 0 && m.reviewed <= m.total && (m.attentionClass === 'lv0' || m.attentionClass === 'lv2');
  if (!ok) return;
  setText('[data-progress-line]', m.line);
  setText('[data-progress-count]', m.countText);
  setText('[data-progress-percent]', m.percentText);
  const attention = document.querySelector('[data-progress-attention]');
  if (attention) { attention.textContent = m.attentionText; attention.setAttribute('class', m.attentionClass); }
  const meter = document.querySelector('[data-progress-meter]');
  if (meter) { meter.setAttribute('max', String(m.total)); meter.setAttribute('value', String(m.reviewed)); meter.textContent = m.percentText; }
};
window.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.token === token && data.type === 'progress') { patchProgress(data.model); return; }
  const header = document.querySelector('.origin');
  if (header && data && data.token === token && data.type === 'origin' && typeof data.text === 'string') header.textContent = data.text;
  if (!data || data.type !== 'review' || data.token !== token) return;
  const button = document.querySelector('[data-act="tick"]');
  const model = data.model;
  if (!button || !model || model.id !== button.getAttribute('data-id') || typeof model.reviewed !== 'boolean'
      || typeof model.buttonText !== 'string' || !(model.summaryText === null || typeof model.summaryText === 'string')) return;
  button.textContent = model.buttonText;
  button.setAttribute('data-on', String(!model.reviewed));
  const summary = document.querySelector('[data-review-summary]');
  if (summary && model.summaryText !== null) summary.textContent = model.summaryText;
});
document.addEventListener('click', (event) => {
  const el = event.target instanceof Element ? event.target.closest('[data-act]') : null;
  if (!el) return;
  event.preventDefault();
  const act = el.getAttribute('data-act');
  if (act === 'tick') postMessage({ type: 'tick', id: el.getAttribute('data-id'), on: el.getAttribute('data-on') === 'true' });
  else if (act === 'next') postMessage({ type: 'next' });
  else if (act === 'peek') postMessage({ type: 'showCallers', id: el.getAttribute('data-id') });
  else if (act === 'caller') postMessage({ type: 'openCaller', index: Number(el.getAttribute('data-index')) });
});
postMessage({ type: 'ready' });
`;

/**
 * The header line: where the row shown came from.
 * @param {string} origin `'tree'` or `'cursor:<line>'`, the line 1-based.
 * @returns {string}
 */
function describeOrigin(origin) {
  if (origin === 'tree') return 'selected in tree';
  const at = /^cursor:([1-9]\d*)$/.exec(origin);
  assert.ok(at, `detail panel origin must be 'tree' or 'cursor:<line>', got ${JSON.stringify(origin)}`);
  return `at cursor, line ${at[1]}`;
}

/**
 * The review's progress strip, as text and numbers. Pure, shared by the initial HTML and
 * its later patches, so the page never formats anything itself.
 * @typedef {{ line: string, reviewed: number, total: number, countText: string, attentionText: string,
 *   attentionClass: 'lv0'|'lv2', percentText: string }} ProgressPresentation
 * @param {{ line: string, total: number, left: number, attention: number }|null} progress `line`
 *   names the source (`PR #15 against main`); the counts are from `countReview`.
 * @returns {ProgressPresentation|null} Null when there is nothing to count.
 */
function progressPresentation(progress) {
  if (!progress || progress.total <= 0) return null;
  const reviewed = progress.total - progress.left;
  return {
    line: progress.line, reviewed, total: progress.total,
    countText: `${reviewed} of ${progress.total} reviewed`,
    attentionText: progress.attention ? `⛔ ${progress.attention} need attention` : 'nothing needs attention',
    attentionClass: progress.attention ? 'lv0' : 'lv2',
    percentText: `${Math.round((100 * reviewed) / progress.total)}%`,
  };
}

/** @param {ProgressPresentation|null} model @returns {string} The strip, or nothing. */
function progressHtml(model) {
  if (!model) return '';
  return `<div class="progress"><div class="where" data-progress-line>${escapeHtml(model.line)}</div>`
    + `<div class="nums"><span data-progress-count>${escapeHtml(model.countText)}</span>`
    + `<span class="${model.attentionClass}" data-progress-attention>${escapeHtml(model.attentionText)}</span>`
    + `<span class="pct" data-progress-percent>${escapeHtml(model.percentText)}</span></div>`
    + `<progress max="${model.total}" value="${model.reviewed}" data-progress-meter>${escapeHtml(model.percentText)}</progress></div>`;
}

/** @param {ReviewPresentation|null} model The fields shared with progress patches. */
function buttonsHtml(model) {
  assert.ok(model, 'a row with review actions must have a tree identity');
  return `<div class="actions"><button data-act="tick" data-id="${escapeHtml(model.id)}" data-on="${!model.reviewed}">${escapeHtml(model.buttonText)}</button>`
    + '<button class="secondary" data-act="next">Next unreviewed</button></div>';
}
const ROW_WORDS = { mark: 'Mark reviewed', untick: 'Untick' };

/**
 * Only the fields progress can change in an existing document. Pure, shared by the
 * initial HTML and its later patches; selection/analysis changes still replace HTML.
 * @typedef {{ id: string, reviewed: boolean, buttonText: string, summaryText: string|null }} ReviewPresentation
 * @param {TreeRow|null} row
 * @param {(row: TreeRow) => boolean} isReviewed
 * @returns {ReviewPresentation|null}
 */
function reviewPresentation(row, isReviewed) {
  const id = row && treeItemId(row);
  if (!row || !id) return null;
  const reviewed = isReviewed(row);
  const words = row.type === 'reviewFile' ? { mark: 'Mark file reviewed', untick: 'Untick file' } : ROW_WORDS;
  let summaryText = null;
  if (row.type === 'reviewFile') {
    const count = row.rows.length, attention = row.attention || 0;
    const left = row.rows.filter((/** @type {TreeRow} */ r) => !isReviewed(r)).length;
    summaryText = `${count} change${count === 1 ? '' : 's'}, ${attention} need${attention === 1 ? 's' : ''} attention, ${left} left to review.`;
  }
  return { id, reviewed, buttonText: reviewed ? words.untick : words.mark, summaryText };
}

/**
 * The callers table of a change, with a note for each message row among the impact rows
 * other than the tests row (a caller search that did not finish). When the change is risky,
 * each caller its verdict counts as not updated says so: the same rule as the result's
 * `stale` list, a caller that is not a test and was not updated at the call.
 * @param {TreeRow[]} impactRows
 * @param {{ result: any, risky: boolean, lineOf: (file: string, offset: number) => number|null, id: string|undefined }} opts
 *   `id` is the change's tree id, which the "Show callers" link names.
 * @returns {string}
 */
function callersHtml(impactRows, { result, risky, lineOf, id }) {
  const callers = listCallerRows(impactRows);
  const notes = impactRows.filter((r) => r.type === 'message').slice(0, -1);
  if (!callers.length && !notes.length) return '';
  const preview = result && result.tierA ? '<div class="note">Preview: only callers in the pull request\'s own files are shown.</div>' : '';
  const rows = callers.map((c, i) => {
    const state = CALL_STATE[c.callState] || UNKNOWN_CALL_STATE;
    const offset = c.callSites && c.callSites[0] ? c.callSites[0].start : c.pos;
    const line = typeof offset === 'number' ? lineOf(c.file, offset) : null;
    const stale = risky && !c.test && c.callState !== 'updated-at-call' ? ' <span class="stale">not updated</span>' : '';
    const where = `${escapeHtml(c.relPath ?? c.file)}${line == null ? '' : `:${line}`}${stale}`;
    return `<tr><td class="st ${CALL_STATE_CLASS[c.callState] || 'lv1'}" title="${escapeHtml(state.text)}">${state.token}</td>`
      + `<td><a href="#" data-act="caller" data-index="${i}">${c.test ? '🧪 ' : ''}${escapeHtml(c.label)}</a></td><td class="where">${where}</td></tr>`;
  }).join('');
  const noteHtml = notes.map((n) => `<div class="note">${escapeHtml(n.label)}${n.tooltip ? `: ${escapeHtml(n.tooltip)}` : ''}</div>`).join('');
  const peek = callers.length ? ` <a href="#" data-act="peek" data-id="${escapeHtml(id)}">Show callers</a>` : '';
  return `<h4>Callers (${callers.length})${peek}</h4>${preview}${rows ? `<table>${rows}</table>` : ''}${noteHtml}`;
}

/**
 * The body of a change row: location, verdict, signature, new throws, callers, tests.
 * @param {TreeRow} row A `finding` row.
 * @param {{ result: any, impactRows: TreeRow[], lineOf: (file: string, offset: number) => number|null }} opts
 * @returns {string}
 */
function changeHtml(row, { result, impactRows, lineOf }) {
  const c = row.finding;
  const v = classifyRowVerdict(row);
  let h = `<h3>${escapeHtml(c.label)}</h3><div class="where">${escapeHtml(c.relPath)}:${c.startLine}–${c.endLine}</div>`;
  h += `<div class="verdict lv${v.level}"><b>${VERDICT_WORDS[v.level]}.</b> ${escapeHtml(v.sentence)}</div>`;
  // An added symbol has no signature before; a missing one is not a change.
  if (typeof c.baseSig === 'string' && typeof c.headSig === 'string' && c.baseSig !== c.headSig) {
    h += `<h4>Signature</h4><div class="sig old">− ${escapeHtml(tidySignature(c.baseSig))}</div><div class="sig new">+ ${escapeHtml(tidySignature(c.headSig))}</div>`;
  }
  const throwsAdded = c.throwsAdded || [];
  if (throwsAdded.length) h += `<h4>New throw</h4>${throwsAdded.map((/** @type {string} */ t) => `<div class="sig new">+ throw ${escapeHtml(t)}</div>`).join('')}`;
  const risky = c.kinds.some((/** @type {{ id: string }} */ k) => k.id !== 'body');
  h += callersHtml(impactRows, { result, risky, lineOf, id: treeItemId(row) });
  // `buildImpactRows` ends with the one tests row.
  const tests = impactRows.at(-1);
  if (tests && tests.type === 'message') h += `<h4>Tests</h4><div>${escapeHtml(tests.label)}${tests.desc ? ` — ${escapeHtml(tests.desc)}` : ''}</div>`;
  return h;
}

/**
 * The body of a file row: a file with a call graph sums up its rows; one without says so.
 * @param {TreeRow} row A `reviewFile` or `file` row.
 * @param {(row: TreeRow) => boolean} isReviewed
 * @returns {string}
 */
function fileHtml(row, isReviewed) {
  const head = `<h3>${escapeHtml(row.label)}</h3><div class="where">${escapeHtml(row.relPath)} · ${escapeHtml(row.status ?? 'changed')}</div>`;
  if (row.type === 'file') {
    return `${head}<div class="verdict lv4">No call graph for this file (tests, config, docs). Read the diff and tick the file.</div>${buttonsHtml(reviewPresentation(row, isReviewed))}`;
  }
  const model = reviewPresentation(row, isReviewed);
  assert.ok(model, 'a file shown in Details must have a tree identity');
  return `${head}<div class="verdict lv${row.level}" data-review-summary>${model.summaryText}</div>${buttonsHtml(model)}`;
}

/**
 * The body for one row, or the hint when there is none.
 * @param {TreeRow|null} row
 * @param {{ result: any, isReviewed: (row: TreeRow) => boolean, impactRows: TreeRow[], lineOf: (file: string, offset: number) => number|null }} opts
 * @returns {string}
 */
function bodyHtml(row, { result, isReviewed, impactRows, lineOf }) {
  if (!row) return `<p class="where">${NO_ROW_HINT}</p>`;
  if (row.type === 'reviewFile' || row.type === 'file') return fileHtml(row, isReviewed);
  const v = classifyRowVerdict(row);
  let h;
  if (row.type === 'finding') h = changeHtml(row, { result, impactRows, lineOf });
  else if (row.type === 'deleted') h = `<h3>${escapeHtml(row.label)}</h3><div class="where">${escapeHtml(row.relPath)} · deleted</div><div class="verdict lv${v.level}">${escapeHtml(v.sentence)}</div>`;
  else h = `<h3>Outside functions</h3><div class="where">${escapeHtml(row.relPath)} · ${escapeHtml(v.text)}</div><div class="verdict lv${v.level}">${escapeHtml(v.sentence)}</div>`;
  return h + buttonsHtml(reviewPresentation(row, isReviewed));
}

/**
 * The detail panel's document for one row of the change tree.
 * @param {TreeRow|null} row A counting row (`finding`, `deleted`, `outside`, `file`) or a
 *   `reviewFile` row; null shows a hint. A caller or tests row is shown as the change it
 *   sits under, which the caller resolves.
 * @param {{
 *   result: any, isReviewed: (row: TreeRow) => boolean, impactRows: TreeRow[],
 *   nonce: string, cspSource: string, origin: string,
 *   lineOf: (file: string, offset: number) => number|null,
 *   progress?: ProgressPresentation|null,
 * }} opts `result` is the shown result. `isReviewed` says whether a counting row is ticked.
 *   `impactRows` are `buildImpactRows`'s rows for a change row (ignored otherwise).
 *   `nonce` is base64 and fresh per document; `cspSource` is the webview's. `origin` is
 *   `'tree'` or `'cursor:<line>'` (1-based). `lineOf` gives the 1-based line of an offset
 *   in a file, or null when it cannot be read. `progress` is the strip above the row; none
 *   when absent or null.
 * @returns {string} The whole HTML document.
 */
function buildDetailHtml(row, { result, isReviewed, impactRows, nonce, cspSource, origin, lineOf, progress = null }) {
  assert.match(nonce, /^[A-Za-z0-9+/=]+$/, 'the nonce must be base64 so it cannot break out of the CSP');
  const header = row ? `<div class="origin">${describeOrigin(origin)}</div>` : '';
  const csp = `default-src 'none'; style-src ${escapeHtml(cspSource)} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + `<style nonce="${nonce}">${STYLE}</style></head>`
    + `<body>${progressHtml(progress)}${header}${bodyHtml(row, { result, isReviewed, impactRows, lineOf })}`
    + `<script nonce="${nonce}">${script(nonce)}</script></body></html>`;
}

module.exports = { reviewPresentation, progressPresentation, buildDetailHtml, listCallerRows, describeOrigin, tidySignature, escapeHtml, VERDICT_WORDS };
