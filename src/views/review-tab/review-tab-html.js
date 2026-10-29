// @ts-check
'use strict';
const assert = require('node:assert/strict');
const { escapeHtml } = require('../details/detail-panel-html');

// The review tab's whole document, built from the page model (review-tab-model.js). Pure.
//
// One page, three columns: the cards to the left, grouped under the model's columns (Needs
// your attention, Behaviour changes, …) with a count each; the chosen card's changes in the
// middle, each with the agent's line, the kind and verdict chips and its diff hunk; the chosen
// change's context to the right, split into what your agent said (before / after / when, who
// it affects) and what Impact Tree found (verdict, callers, entry points). The left and right
// columns stick while the middle scrolls. ⚠ means one thing: the change is one to look at
// first. Each fact is shown once: the card's sentence in its heading, the change's line on
// its row, the rest in the context.
//
// Safety, as the Pull Request tab: every text from the code, the history or the agent goes
// through `escapeHtml`; the CSP allows nothing remote; the one style and the one script carry
// a nonce; no inline `style=` or `on…=` attribute. The page only shows and hides what is
// already in it (a card, a change's context) and posts three kinds of message, each naming
// an id the panel looks up again: open a change, open a deleted function's file, open a caller.

const KIND_WORD = { changed: 'Changed', 'may-change': 'May change', new: 'New', same: 'Same behaviour' };
const KIND_TONE = { changed: 'warning', 'may-change': 'warning', new: 'plain', same: 'plain' };
const LEVEL_CLASS = ['lv0', 'lv1', 'lv2', 'lv3', 'lv4'];
const STATE_WORD = { unchanged: 'not updated', 'changed-elsewhere': 'edited elsewhere', 'updated-at-call': 'updated', updated: 'updated', unknown: 'unknown' };
const ATTENTION_WORD = 'Look at this first';
/** Hunks of these kinds start open; the rest fold until asked. */
const OPEN_HUNK_KINDS = new Set(['changed', 'may-change']);

const STYLE = `
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; margin: 0; }
main { padding: 14px 22px 40px; max-width: 1500px; }
h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
h3 { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
h4 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 14px 0 4px; }
.muted, .file, .lbl { color: var(--vscode-descriptionForeground); }
.file { font-size: 12px; }
.lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 10px 0 4px; }
.lbl:first-child { margin-top: 0; }
.counts { margin: 0 0 10px; }
.chip { display: inline-block; font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 9px; border: 1px solid var(--vscode-panel-border); margin: 2px 4px 0 0; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.chip.danger { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.chip.warning { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); }
.chip.attn { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent); font-weight: 600; }
.summary { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); border-radius: 0 6px 6px 0; padding: 8px 12px; margin: 10px 0 16px; max-width: 90ch; }
.summary .lbl { margin: 0 0 2px; }
.review { display: grid; grid-template-columns: 230px minmax(0, 1fr) 340px; align-items: start; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
.layers, .context { position: sticky; top: 0; max-height: 100vh; overflow: auto; box-sizing: border-box; }
@media (max-width: 1000px) { .review { grid-template-columns: minmax(0, 1fr); } .layers, .context { position: static; max-height: none; border: 0 !important; border-top: 1px solid var(--vscode-panel-border) !important; } }
.layers { border-right: 1px solid var(--vscode-panel-border); padding: 10px 8px; }
.layer { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; border-radius: 4px; padding: 5px 8px; margin: 0 0 2px; cursor: pointer; }
.layer:hover { background: var(--vscode-list-hoverBackground); }
.layer.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.layer.on .muted { color: inherit; opacity: .8; }
.layer .n { color: var(--vscode-descriptionForeground); margin-right: 4px; }
.layer.on .n { color: inherit; }
.layer .muted { font-size: 11px; }
.cards { padding: 12px 16px; min-width: 0; }
.card, .ctx { display: none; }
.card.on, .ctx.on { display: block; }
.card > .sentence { margin: 0 0 4px; }
details.why { margin: 0 0 8px; }
details.why summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
details.why div { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 2px 0 0 14px; }
.chg { border: 1px solid var(--vscode-panel-border); border-left: 3px solid transparent; border-radius: 6px; padding: 8px 12px; margin: 10px 0; cursor: pointer; }
.chg:hover { background: var(--vscode-list-hoverBackground); }
.chg.on { border-color: var(--vscode-focusBorder); border-left-color: var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); }
.chg .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.chg .name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.chg .open { margin-left: auto; }
.mark { color: var(--vscode-editorWarning-foreground); font-weight: 600; }
.what { margin: 3px 0 0; }
.verdict.lv0 { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.verdict.lv1 { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); }
details.diff { margin: 6px 0 0; }
details.diff summary { cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); }
pre.hunk { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 4px 0; margin: 4px 0 2px; overflow-x: auto; }
pre.hunk span { display: block; padding: 0 8px; white-space: pre; }
pre.hunk .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,160,0,.15)); }
pre.hunk .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(200,0,0,.15)); }
pre.hunk .at { color: var(--vscode-descriptionForeground); }
.link { font: inherit; background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; }
.link:hover { text-decoration: underline; }
.btn { font: inherit; font-size: 12px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 1px 8px; cursor: pointer; }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.context { border-left: 1px solid var(--vscode-panel-border); padding: 12px 14px; min-width: 0; }
.ctx h4:first-of-type { margin-top: 10px; }
.ctx dl { margin: 0; }
.ctx dt { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-top: 8px; }
.ctx dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.caller { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; margin: 3px 0; }
.keys { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 12px; }
kbd { font-family: var(--vscode-editor-font-family); font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 4px; }
`;

/** @param {import('./review-tab-model').CardModel} c */
function layerHtml(c) {
  return `<button class="layer" data-card="${escapeHtml(c.id)}"><span class="n">${c.n}</span>${escapeHtml(c.title)}${c.attention ? ' <span class="mark" title="Has a change to look at first">⚠</span>' : ''}`
    + `<div class="muted">${c.changes.length} change${c.changes.length === 1 ? '' : 's'}${c.chips.length ? ' · ' + escapeHtml(c.chips.map((x) => x.text).join(' · ')) : ''}</div></button>`;
}

/** The cards under the column they belong to, with a count each. @param {import('./review-tab-model').TabModel} m */
function layersHtml(m) {
  const byId = new Map(m.cards.map((c) => [c.id, c]));
  return m.columns.map((col) => `<div class="lbl">${escapeHtml(col.label)} · ${col.cards.length}</div>`
    + (col.cards.length ? col.cards.map((id) => layerHtml(/** @type {any} */ (byId.get(id)))).join('') : '<div class="muted">None</div>')).join('');
}

/** @param {import('./review-tab-model').ChangeModel} ch */
function changeHtml(ch) {
  const attention = ch.attention ? `<span class="chip attn" title="Your agent (or, without a result, Impact Tree) put this change first">⚠ ${ATTENTION_WORD}</span>` : '';
  const tone = KIND_TONE[/** @type {keyof typeof KIND_TONE} */ (ch.kind || '')];
  const kind = ch.kind ? `<span class="chip${tone && tone !== 'plain' ? ` ${tone}` : ''}" title="Your agent's reading">${escapeHtml(KIND_WORD[/** @type {keyof typeof KIND_WORD} */ (ch.kind)] || ch.kind)}</span>` : '';
  const verdict = `<span class="chip verdict ${LEVEL_CLASS[ch.verdict.level] || ''}" title="Impact Tree's verdict">${escapeHtml(ch.verdict.text)}</span>`;
  const open = `<button class="btn open" data-act="${ch.deleted ? 'deleted' : 'change'}" data-id="${escapeHtml(ch.id)}">${ch.deleted ? 'Open file' : 'Open in diff'}</button>`;
  const hunk = ch.hunk ? `<details class="diff"${ch.attention || OPEN_HUNK_KINDS.has(String(ch.kind)) ? ' open' : ''}><summary>Diff · ${ch.hunk.lines.length}${ch.hunk.more ? ` of ${ch.hunk.lines.length + ch.hunk.more}` : ''} lines</summary>`
    + `<pre class="hunk">${ch.hunk.lines.map((l) => `<span class="${l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '@' ? 'at' : 'ctxl'}">${escapeHtml(l.s)}</span>`).join('')}</pre>`
    + (ch.hunk.more ? `<div class="muted">${ch.hunk.more} more lines in the diff</div>` : '') + '</details>' : '';
  return `<div class="chg" data-change="${escapeHtml(ch.id)}"><div class="head"><span class="name">${escapeHtml(ch.name)}</span>`
    + `<span class="file">${escapeHtml(ch.file)}${ch.line ? `:${ch.line}` : ''}</span>${attention}${kind}${verdict}${open}</div>`
    + (ch.what ? `<div class="what">${escapeHtml(ch.what)}</div>` : '') + hunk + '</div>';
}

/** @param {import('./review-tab-model').ChangeModel} ch */
function contextHtml(ch) {
  /** @type {string[]} */
  const parts = [`<h3>${escapeHtml(ch.name)}</h3><div class="file">${escapeHtml(ch.file)}${ch.line ? `:${ch.line}` : ''}</div>`];
  if (ch.kind) {
    const said = /** @type {Array<[string, string|null]>} */ ([['Before', ch.before], ['After', ch.after], ['When', ch.when]]).filter(([, v]) => v);
    parts.push('<h4>Your agent</h4><dl>');
    if (!said.length && !ch.affects.length) parts.push(`<dd class="muted">${escapeHtml(KIND_WORD[/** @type {keyof typeof KIND_WORD} */ (ch.kind)] || ch.kind)}; nothing more said.</dd>`);
    for (const [k, v] of said) parts.push(`<dt>${k}</dt><dd>${escapeHtml(/** @type {string} */ (v))}</dd>`);
    if (ch.affects.length) parts.push(`<dt>Affects</dt>${ch.affects.map((a) => `<dd><b>${escapeHtml(a.name)}</b> — ${escapeHtml(a.how)}</dd>`).join('')}`);
    parts.push('</dl>');
  }
  parts.push(`<h4>Impact Tree</h4><dl><dt>Verdict</dt><dd>${escapeHtml(ch.verdict.text)}</dd><dt>Callers</dt>`);
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
  return `<aside class="ctx" data-change="${escapeHtml(ch.id)}">${parts.join('')}</aside>`;
}

/** @param {import('./review-tab-model').TabModel} m */
function reviewHtml(m) {
  if (!m.cards.length) return '<p class="muted">No cards: the changes did not group.</p>';
  const cards = m.cards.map((c) => `<section class="card" data-card="${escapeHtml(c.id)}"><h3>${escapeHtml(c.title)}</h3><div class="sentence muted">${escapeHtml(c.sentence)}</div>`
    + (c.why ? `<details class="why"><summary>Why these changes are one card</summary><div>${escapeHtml(c.why)}</div></details>` : '')
    + c.changes.map((id) => changeHtml(m.changes[id])).join('') + '</section>').join('');
  const contexts = Object.values(m.changes).map(contextHtml).join('');
  const keys = '<div class="keys"><kbd>j</kbd> <kbd>k</kbd> next / previous change · <kbd>n</kbd> <kbd>p</kbd> next / previous card</div>';
  return `<div class="review" data-el="review"><nav class="layers">${layersHtml(m)}${keys}</nav><div class="cards">${cards}</div><div class="context">${contexts}</div></div>`;
}

/** @param {import('./review-tab-model').TabModel} m */
function bodyHtml(m) {
  const attention = m.columns.find((c) => c.id === 'attention');
  const counts = [`${m.counts.changes} change${m.counts.changes === 1 ? '' : 's'}`, `${m.counts.cards} card${m.counts.cards === 1 ? '' : 's'}`,
    attention && attention.cards.length ? `${attention.cards.length} need${attention.cards.length === 1 ? 's' : ''} your attention` : null,
    m.preview ? 'preview: no diffs here' : null].filter(Boolean);
  const summary = m.summary ? `<div class="summary"><div class="lbl">Your agent's summary</div>${escapeHtml(m.summary)}</div>`
    : m.note ? `<div class="summary muted">${escapeHtml(m.note)}</div>` : '';
  return `<h2>${escapeHtml(m.title || 'Review')}</h2><div class="counts">${counts.map((t) => `<span class="chip">${escapeHtml(String(t))}</span>`).join('')}</div>`
    + summary + reviewHtml(m);
}

/** The page script: show a card and a change's context, remember them, move with the keys, and post the open actions. @param {string} token */
const script = (token) => `
const vscode = acquireVsCodeApi();
const token = ${JSON.stringify(token)};
const all = (sel) => Array.from(document.querySelectorAll(sel));
const mark = (sel, attr, value) => all(sel).forEach((e) => e.classList.toggle('on', e.getAttribute(attr) === value));
const state = vscode.getState() || {};
function showChange(id, scroll) {
  if (!id) return;
  mark('.chg', 'data-change', id); mark('.ctx', 'data-change', id);
  state.change = id; vscode.setState(state);
  const el = document.querySelector('.chg.on');
  if (scroll && el) el.scrollIntoView({ block: 'nearest' });
}
function showCard(id, scroll) {
  if (!document.querySelector('.card[data-card="' + CSS.escape(id) + '"]')) return;
  mark('.layer', 'data-card', id); mark('.card', 'data-card', id);
  state.card = id; vscode.setState(state);
  const first = document.querySelector('.card.on .chg');
  showChange(first && first.getAttribute('data-change'), false);
  if (scroll) { const r = document.querySelector('.card.on'); if (r) r.scrollIntoView({ block: 'start' }); }
}
function step(sel, attr, by) {
  const items = all(sel); const at = items.findIndex((e) => e.classList.contains('on'));
  const next = items[Math.min(items.length - 1, Math.max(0, at + by))];
  return next ? next.getAttribute(attr) : null;
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
  if (chg) { showChange(chg.getAttribute('data-change'), false); return; }
  const layer = e.target.closest('.layer');
  if (layer) showCard(layer.getAttribute('data-card'), true);
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'j' || e.key === 'k') { showChange(step('.card.on .chg', 'data-change', e.key === 'j' ? 1 : -1), true); e.preventDefault(); }
  else if (e.key === 'n' || e.key === 'p') { const id = step('.layer', 'data-card', e.key === 'n' ? 1 : -1); if (id) showCard(id, true); e.preventDefault(); }
});
const firstCard = document.querySelector('.layer');
if (state.card && document.querySelector('.card[data-card="' + CSS.escape(state.card) + '"]')) {
  showCard(state.card, false);
  if (state.change && document.querySelector('.ctx[data-change="' + CSS.escape(state.change) + '"]')) showChange(state.change, false);
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

module.exports = { buildReviewTabHtml, ATTENTION_WORD };
