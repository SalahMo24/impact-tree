// @ts-check
'use strict';
const assert = require('node:assert/strict');
const { escapeHtml } = require('./detail-panel-html');

// The review tab's whole document, built from the page model (review-tab-model.js). Pure.
//
// Safety, as the Pull Request tab: every text from the code, the history or the agent goes
// through `escapeHtml`; the CSP allows nothing remote; the one style and the one script carry
// a nonce; no inline `style=` or `on…=` attribute. The page only shows and hides what is
// already in it (a card, a change's context) and posts three kinds of message, each naming
// an id the panel looks up again: open a change, open a deleted function's file, open a caller.

/** The marker read before a change's line, by the agent's kind. */
const MARK = { changed: '⚠', 'may-change': '?', new: '+', same: '=' };
const KIND_WORD = { changed: 'Changed', 'may-change': 'May change', new: 'New', same: 'Same behaviour, new way' };
const LEVEL_CLASS = ['lv0', 'lv1', 'lv2', 'lv3', 'lv4'];
const STATE_WORD = { unchanged: 'not updated', 'changed-elsewhere': 'edited elsewhere', 'updated-at-call': 'updated', updated: 'updated', unknown: 'unknown' };

const STYLE = `
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; margin: 0; }
main { padding: 14px 22px 40px; max-width: 1400px; }
h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
h3 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
.muted, .file, .lbl { color: var(--vscode-descriptionForeground); }
.lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 6px; }
.chip { display: inline-block; font-size: 11px; padding: 0 7px; border-radius: 9px; border: 1px solid var(--vscode-panel-border); margin: 3px 4px 0 0; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.chip.danger { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.chip.warning { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); }
.summary { background: var(--vscode-textBlockQuote-background); border-radius: 6px; padding: 8px 12px; margin: 10px 0 14px; }
.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 22px; }
.col { min-width: 0; }
.tile { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 10px; margin: 0 0 8px; cursor: pointer; }
.tile:hover, .tile:focus-visible { border-color: var(--vscode-focusBorder); outline: none; }
.tile.attn { border-left: 3px solid var(--vscode-editorWarning-foreground); }
.tile .t { font-weight: 600; }
.tile .s { color: var(--vscode-descriptionForeground); margin: 2px 0; }
.empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 8px 10px; }
.review { display: grid; grid-template-columns: 200px minmax(0, 1fr) 280px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
@media (max-width: 900px) { .review { grid-template-columns: minmax(0, 1fr); } .layers, .context { border: 0 !important; border-top: 1px solid var(--vscode-panel-border) !important; } }
.layers { border-right: 1px solid var(--vscode-panel-border); padding: 10px 8px; }
.layer { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; border-radius: 4px; padding: 5px 6px; cursor: pointer; }
.layer:hover { background: var(--vscode-list-hoverBackground); }
.layer.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.layer .n { color: var(--vscode-descriptionForeground); margin-right: 4px; }
.cards { padding: 10px 14px; min-width: 0; }
.card, .ctx { display: none; }
.card.on, .ctx.on { display: block; }
.why { margin: 2px 0 8px; }
.chg { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 10px; margin: 8px 0; cursor: pointer; }
.chg.on { border-color: var(--vscode-focusBorder); }
.chg .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.chg .name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.mark { font-weight: 600; }
.mark.changed, .mark.may-change { color: var(--vscode-editorWarning-foreground); }
.what { margin: 3px 0; }
.verdict.lv0 { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.verdict.lv1 { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); }
pre.hunk { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 4px 0; margin: 6px 0 2px; overflow-x: auto; }
pre.hunk span { display: block; padding: 0 8px; white-space: pre; }
pre.hunk .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,160,0,.15)); }
pre.hunk .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(200,0,0,.15)); }
pre.hunk .at { color: var(--vscode-descriptionForeground); }
.link { font: inherit; background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; }
.link:hover { text-decoration: underline; }
.context { border-left: 1px solid var(--vscode-panel-border); padding: 10px 12px; min-width: 0; }
.ctx dl { margin: 0 0 8px; }
.ctx dt { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-top: 8px; }
.ctx dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.caller { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; margin: 3px 0; }
.by { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 10px; }
`;

/** @param {import('./review-tab-model').Chip} c */
const chipHtml = (c) => `<span class="chip${c.tone === 'plain' ? '' : ` ${c.tone}`}">${escapeHtml(c.text)}</span>`;

/** @param {import('./review-tab-model').TabModel} m @param {import('./review-tab-model').CardModel} c */
function tileHtml(m, c) {
  return `<button class="tile${c.attention ? ' attn' : ''}" data-card="${escapeHtml(c.id)}"><div class="t">${escapeHtml(c.title)}</div>`
    + `<div class="s">${escapeHtml(c.sentence)}</div>${c.chips.map(chipHtml).join('')}</button>`;
}

/** @param {import('./review-tab-model').TabModel} m */
function boardHtml(m) {
  const byId = new Map(m.cards.map((c) => [c.id, c]));
  return `<div class="board">${m.columns.map((col) => `<div class="col"><div class="lbl">${escapeHtml(col.label)} · ${col.cards.length}</div>`
    + (col.cards.length ? col.cards.map((id) => tileHtml(m, /** @type {any} */ (byId.get(id)))).join('') : '<div class="empty">Nothing here</div>')
    + '</div>').join('')}</div>`;
}

/** @param {import('./review-tab-model').ChangeModel} ch */
function changeHtml(ch) {
  const mark = ch.kind ? `<span class="mark ${escapeHtml(ch.kind)}" title="${escapeHtml(KIND_WORD[/** @type {keyof typeof KIND_WORD} */ (ch.kind)] || '')}">${MARK[/** @type {keyof typeof MARK} */ (ch.kind)] || ''}</span>` : '';
  const verdict = `<span class="chip verdict ${LEVEL_CLASS[ch.verdict.level] || ''}">${escapeHtml(ch.verdict.text)}</span>`;
  const hunk = ch.hunk ? `<pre class="hunk">${ch.hunk.lines.map((l) => `<span class="${l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '@' ? 'at' : 'ctxl'}">${escapeHtml(l.s)}</span>`).join('')}</pre>`
    + (ch.hunk.more ? `<div class="muted">${ch.hunk.more} more lines</div>` : '') : '';
  const open = `<button class="link" data-act="${ch.deleted ? 'deleted' : 'change'}" data-id="${escapeHtml(ch.id)}">Open in diff</button>`;
  return `<div class="chg" data-change="${escapeHtml(ch.id)}"><div class="head">${mark}<span class="name">${escapeHtml(ch.name)}</span>`
    + `<span class="file">${escapeHtml(ch.file)}${ch.line ? `:${ch.line}` : ''}</span>${verdict}</div>`
    + (ch.what ? `<div class="what">${escapeHtml(ch.what)}</div>` : '') + hunk + open + '</div>';
}

/** @param {import('./review-tab-model').ChangeModel} ch */
function contextHtml(ch) {
  /** @type {string[]} */
  const parts = [`<h3>${escapeHtml(ch.name)}</h3><div class="file">${escapeHtml(ch.file)}</div><dl>`];
  if (ch.kind) parts.push(`<dt>${escapeHtml(KIND_WORD[/** @type {keyof typeof KIND_WORD} */ (ch.kind)] || '')}</dt><dd>${escapeHtml(ch.what || '')}</dd>`);
  for (const [k, v] of /** @type {Array<[string, string|null]>} */ ([['Before', ch.before], ['After', ch.after], ['When', ch.when]])) if (v) parts.push(`<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`);
  if (ch.affects.length) parts.push(`<dt>Affects</dt>${ch.affects.map((a) => `<dd><b>${escapeHtml(a.name)}</b> — ${escapeHtml(a.how)}</dd>`).join('')}`);
  parts.push(`<dt>Callers</dt>`);
  if (!ch.callers.length) parts.push(`<dd class="muted">${ch.deleted ? 'Former callers of a deleted function are not searched.' : ch.callersComplete ? 'None found.' : 'None found; the search did not finish.'}</dd>`);
  for (const c of ch.callers) {
    const state = c.test ? 'test' : STATE_WORD[/** @type {keyof typeof STATE_WORD} */ (c.state)] || c.state;
    const tone = !c.test && c.state === 'unchanged' ? ' danger' : !c.test && c.state === 'changed-elsewhere' ? ' warning' : '';
    parts.push(`<dd class="caller"><button class="link" data-act="caller" data-id="${escapeHtml(ch.id)}" data-index="${c.index}">${escapeHtml(c.label)}</button>`
      + `<span class="chip${tone}">${escapeHtml(state)}</span><span class="file">${escapeHtml(c.file)}${c.line ? `:${c.line}` : ''}</span></dd>`);
  }
  if (ch.callersMore) parts.push(`<dd class="muted">…and ${ch.callersMore} more</dd>`);
  if (!ch.callersComplete && ch.callers.length) parts.push('<dd class="muted">More callers may be missing.</dd>');
  if (ch.entries.length) parts.push(`<dt>Reaches</dt>${ch.entries.map((e) => `<dd>${escapeHtml(e)}</dd>`).join('')}${ch.entriesMore ? `<dd class="muted">…and ${ch.entriesMore} more</dd>` : ''}`);
  parts.push('</dl>');
  if (ch.kind) parts.push('<div class="by">Behaviour notes written by your agent; callers and entry points from Impact Tree.</div>');
  return `<aside class="ctx" data-change="${escapeHtml(ch.id)}">${parts.join('')}</aside>`;
}

/** @param {import('./review-tab-model').TabModel} m */
function reviewHtml(m) {
  if (!m.cards.length) return '<p class="muted">No cards: the changes did not group.</p>';
  const layers = m.cards.map((c) => `<button class="layer" data-card="${escapeHtml(c.id)}"><span class="n">${c.n}</span>${escapeHtml(c.title)}${c.attention ? ' <span class="mark changed">⚠</span>' : ''}`
    + `<div class="muted">${c.changes.length} change${c.changes.length === 1 ? '' : 's'}</div></button>`).join('');
  const cards = m.cards.map((c) => `<section class="card" data-card="${escapeHtml(c.id)}"><h3>${escapeHtml(c.title)}</h3><div class="muted">${escapeHtml(c.sentence)}</div>`
    + (c.why ? `<div class="why muted">Grouped because: ${escapeHtml(c.why)}</div>` : '') + c.changes.map((id) => changeHtml(m.changes[id])).join('') + '</section>').join('');
  const contexts = Object.values(m.changes).map(contextHtml).join('');
  return `<div class="review" data-el="review"><nav class="layers"><div class="lbl">Cards</div>${layers}</nav><div class="cards">${cards}</div><div class="context">${contexts}</div></div>`;
}

/** @param {import('./review-tab-model').TabModel} m */
function bodyHtml(m) {
  const counts = [`${m.counts.changes} changes`, `${m.counts.cards} cards`, m.preview ? 'preview: no diffs here' : null].filter(Boolean);
  return `<h2>${escapeHtml(m.title || 'Review')}</h2><div>${counts.map((t) => `<span class="chip">${escapeHtml(String(t))}</span>`).join('')}</div>`
    + (m.summary ? `<div class="summary">${escapeHtml(m.summary)}</div>` : m.note ? `<div class="summary muted">${escapeHtml(m.note)}</div>` : '<div class="summary-gap"></div>')
    + boardHtml(m) + reviewHtml(m);
}

/** The page script: show a card and a change's context, remember them, and post the open actions. @param {string} token */
const script = (token) => `
const vscode = acquireVsCodeApi();
const token = ${JSON.stringify(token)};
const all = (sel) => Array.from(document.querySelectorAll(sel));
const mark = (sel, attr, value) => all(sel).forEach((e) => e.classList.toggle('on', e.getAttribute(attr) === value));
const state = vscode.getState() || {};
function showChange(id) {
  if (!id) return;
  mark('.chg', 'data-change', id); mark('.ctx', 'data-change', id);
  state.change = id; vscode.setState(state);
}
function showCard(id, scroll) {
  if (!document.querySelector('.card[data-card="' + CSS.escape(id) + '"]')) return;
  mark('.layer', 'data-card', id); mark('.card', 'data-card', id);
  state.card = id; vscode.setState(state);
  const first = document.querySelector('.card.on .chg');
  showChange(first && first.getAttribute('data-change'));
  if (scroll) { const r = document.querySelector('[data-el="review"]'); if (r) r.scrollIntoView({ block: 'start' }); }
}
document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const m = { type: 'open', what: act.getAttribute('data-act'), id: act.getAttribute('data-id'), token };
    if (act.hasAttribute('data-index')) m.index = Number(act.getAttribute('data-index'));
    vscode.postMessage(m);
    return;
  }
  const chg = e.target.closest('.chg');
  if (chg) { showChange(chg.getAttribute('data-change')); return; }
  const card = e.target.closest('[data-card]');
  if (card && (card.classList.contains('tile') || card.classList.contains('layer'))) showCard(card.getAttribute('data-card'), card.classList.contains('tile'));
});
const firstCard = document.querySelector('.col .tile') || document.querySelector('.layer');
if (state.card && document.querySelector('.card[data-card="' + CSS.escape(state.card) + '"]')) {
  showCard(state.card, false);
  if (state.change && document.querySelector('.ctx[data-change="' + CSS.escape(state.change) + '"]')) showChange(state.change);
} else if (firstCard) showCard(firstCard.getAttribute('data-card'), false);
`;

/**
 * The review tab's document.
 * @param {import('./review-tab-model').TabModel} model
 * @param {{ nonce: string, cspSource: string }} opts `nonce` is base64 and fresh per document.
 * @returns {string}
 */
function buildReviewTabHtml(model, { nonce, cspSource }) {
  assert.match(nonce, /^[A-Za-z0-9+/=]+$/, 'the nonce must be base64 so it cannot break out of the CSP');
  const csp = `default-src 'none'; style-src ${escapeHtml(cspSource)} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + `<style nonce="${nonce}">${STYLE}</style></head>`
    + `<body><main>${bodyHtml(model)}</main><script nonce="${nonce}">${script(nonce)}</script></body></html>`;
}

module.exports = { buildReviewTabHtml };
