// @ts-check
'use strict';
const assert = require('node:assert/strict');
const { escapeHtml } = require('./detail-panel-html');
const { reviewDataOf } = require('./pr-review-store');
const { openCount } = require('./pr-review-data');
const { treeItemId } = require('./review-tree-model');
const { attentionCountText } = require('./tree-row-models');

// The Pull Request tab's whole document, built from a plain page model. Pure: the adapter
// (pr-overview-panel.js) supplies the store's state, the tree's review progress, the kept
// summary draft, the nonce and the webview's CSP source, so the page can be tested
// without VS Code.
//
// Safety: everything from GitHub (title, description, timeline and comment bodies, names,
// branch names, paths) is text: it goes through `escapeHtml`, and line breaks are kept by
// CSS (`white-space: pre-wrap`), never by injecting GitHub's HTML or rendering its
// markdown. The CSP allows nothing remote; the one style and the one script carry a nonce.
// Nothing uses an inline `style=` or `on…=` attribute, which that CSP would block.

/** @typedef {import('./pr-review-store').ReviewStoreState} ReviewStoreState */
/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/** @typedef {'COMMENT'|'APPROVE'|'REQUEST_CHANGES'} ReviewEvent */

/** How long a pending comment's first line may be in the list, in UTF-16 code units. */
const FIRST_LINE_MAX = 120;

/** What the success message says the reviewer did. */
/** @type {Record<ReviewEvent, string>} */
const EVENT_WORDS = { COMMENT: 'commented', APPROVE: 'approved', REQUEST_CHANGES: 'requested changes' };

/** @type {Record<string, string>} */
const REVIEW_STATE_WORDS = {
  APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed',
  DISMISSED: 'left a review that was dismissed', PENDING: 'has a pending review',
};

/** @type {Record<string, string>} */
const PR_STATE_WORDS = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' };

const OWN_PR_REASON = 'GitHub does not let you approve or request changes on your own pull request.';

/**
 * Which submit buttons can be pressed, and why not. The single source of the rules the
 * page applies while the reviewer types: the HTML module uses it for the first paint and
 * the page script carries this same function's source (`toString`), so the two cannot
 * drift. It must therefore stay self-contained: no references outside its body.
 *
 * The rules are GitHub's, as the review store also enforces them: on one's own pull
 * request, approve and request changes are refused; request changes needs a summary; a
 * comment review needs a summary or a pending comment. One is ours: with the approve check
 * showing, Approve waits for "Approve anyway". While a submit or discard runs, nothing can
 * be pressed. A `reason` is shown under the buttons; the own-PR reason is shown once by
 * the page itself, so it is not repeated here.
 * @param {{ own: boolean, pendingComments: number, checkNeeded: boolean, busy: boolean,
 *   hasSummary: boolean, approveAnyway: boolean }} facts
 * @returns {{ requestChanges: { disabled: boolean, reason: string|null },
 *   approve: { disabled: boolean, reason: string|null }, comment: { disabled: boolean, reason: string|null } }}
 */
function buttonRules(facts) {
  const off = (/** @type {string|null} */ reason) => ({ disabled: true, reason });
  const on = { disabled: false, reason: null };
  if (facts.busy) return { requestChanges: off(null), approve: off(null), comment: off(null) };
  return {
    requestChanges: facts.own ? off(null) : facts.hasSummary ? on : off('Request Changes needs a summary.'),
    approve: facts.own ? off(null)
      : facts.checkNeeded && !facts.approveAnyway ? off('Check “Approve anyway” to approve with the items above still open.') : on,
    comment: facts.hasSummary || facts.pendingComments > 0 ? on : off('Comment needs a summary or a pending comment.'),
  };
}

/**
 * @typedef {object} MergeState
 * @property {'clean'|'blocked'|'conflict'|'unknown'|'done'} tone `clean` only when GitHub says so.
 * @property {string} headline
 * @property {string[]} reasons Why, plus notes (merge queue, a newer head).
 * @property {boolean} retry The headline is not an answer yet: offer Refresh or Retry.
 *
 * @typedef {{ kind: 'none' } | { kind: 'failed', message: string }
 *   | { kind: 'ready', items: import('./pr-review-data').CheckItem[], total: number, incomplete: string|null }} ChecksView
 *
 * @typedef {{ kind: 'failed', message: string } | { kind: 'ready', merge: MergeState, checks: ChecksView,
 *   reviewers: { items: import('./pr-review-data').ReviewerItem[], more: number },
 *   labels: { items: import('./pr-review-data').LabelItem[], more: number } }} OverviewView
 */

/**
 * @typedef {object} AttentionItem
 * @property {string} id The row's tree id, which "reveal row" names.
 * @property {string} name
 * @property {string} where Repository-relative path.
 *
 * @typedef {object} ApproveCheck What stands against approving. Present only when
 *   something does, and never on one's own pull request (approve is refused there anyway).
 * @property {boolean} progressKnown False when the tree shows no review (e.g. it is
 *   analysing): the unreviewed rows are then unknown, which is not "none".
 * @property {AttentionItem[]} attention Unreviewed rows needing attention, in tree order.
 * @property {number} unresolvedThreads Unresolved threads someone has posted in.
 * @property {number} left Rows not ticked; meaningful only when `progressKnown`.
 * @property {number} total Counting rows; meaningful only when `progressKnown`.
 *
 * @typedef {object} PendingComment
 * @property {string} threadId
 * @property {string} where `path:line`, or `path · file comment`.
 * @property {string} firstLine The body's first non-blank line, clipped.
 *
 * @typedef {object} TimelineEntry
 * @property {string} who
 * @property {string} what
 * @property {string} when `YYYY-MM-DD HH:MM` UTC, or GitHub's text when not ISO 8601.
 * @property {string} body
 *
 * @typedef {object} PageModel
 * @property {'loading'|'failed'|'ready'} kind `loading`/`failed`: no review data to show
 *   yet; `ready`: data is shown (possibly while refreshing, or after a failed refresh).
 * @property {number|null} number The pull request number; null only for an invalid target.
 * @property {string|null} loadError The last load's failure, if it failed.
 * @property {boolean} refreshing A load is running; shown data is the previous load's.
 * @property {{ title: string, number: number, state: string, author: string, headRefName: string,
 *   baseRefName: string, body: string }|null} pr
 * @property {TimelineEntry[]} timeline Oldest first.
 * @property {{ commentCount: number, comments: PendingComment[] }|null} pending The viewer's
 *   pending review, when there is one.
 * @property {boolean} own The viewer opened the pull request.
 * @property {ApproveCheck|null} check
 * @property {OverviewView} overview Checks, merge state, reviewers and labels.
 * @property {string[]} incomplete Why the loaded data is not the whole story.
 * @property {string} draft The summary text to show.
 * @property {string|null} error The last submit or discard failure.
 * @property {null|'submit'|'discard'} busy The action running.
 */

/**
 * `2026-01-02T03:04:05Z` as `2026-01-02 03:04`. Other text is shown as it is.
 * @param {string} iso
 * @returns {string}
 */
function formatWhen(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/**
 * The first non-blank line of a body, trimmed and clipped to `FIRST_LINE_MAX`.
 * @param {string} body
 * @returns {string}
 */
function firstLineOf(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') || '';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

/**
 * @param {TreeRow} row A counting row.
 * @returns {AttentionItem|null}
 */
function attentionItem(row) {
  const id = treeItemId(row);
  if (!id) return null;
  return { id, name: String(row.label), where: String(row.relPath ?? row.finding?.relPath ?? '') };
}

/**
 * The approve check for loaded data, or null when nothing stands against approving.
 * @param {import('./pr-review-data').ReviewModel} data
 * @param {{ attentionLeft: TreeRow[]|null, counts: { total: number, left: number }|null }} progress
 * @returns {ApproveCheck|null}
 */
function approveCheckOf(data, { attentionLeft, counts }) {
  if (data.pr.viewerDidAuthor) return null;
  const progressKnown = attentionLeft !== null && counts !== null;
  const attention = (attentionLeft || []).map(attentionItem).filter((i) => i !== null);
  const unresolvedThreads = openCount(data.threads);
  if (progressKnown && attention.length === 0 && unresolvedThreads === 0) return null;
  return {
    progressKnown, attention: /** @type {AttentionItem[]} */ (attention), unresolvedThreads,
    left: counts ? counts.left : 0, total: counts ? counts.total : 0,
  };
}

/**
 * Whether the pull request can be merged, in words. Never `clean` when unsure. Pure.
 * @param {{ state: string, baseRefName: string }} pr
 * @param {import('./pr-review-data').PullRequestOverview} overview
 * @returns {MergeState}
 */
function mergeStateOf(pr, overview) {
  if (overview.kind === 'failed') {
    return { tone: 'unknown', headline: `Merge state could not be loaded: ${overview.error.message}`, reasons: [], retry: true };
  }
  if (pr.state === 'MERGED') return { tone: 'done', headline: 'Merged.', reasons: [], retry: false };
  if (pr.state === 'CLOSED') return { tone: 'done', headline: 'Closed without merging.', reasons: [], retry: false };
  const { merge, checks } = overview;
  const base = pr.baseRefName;
  /** @type {MergeState} */
  let result;
  if (merge.isDraft || merge.mergeStateStatus === 'DRAFT') {
    result = { tone: 'blocked', headline: 'This pull request is a draft.', reasons: ['Mark it ready for review on GitHub.'], retry: false };
  } else if (merge.mergeable === 'CONFLICTING' || merge.mergeStateStatus === 'DIRTY') {
    result = { tone: 'conflict', headline: `This branch has conflicts with ${base}.`, reasons: ['Resolve them in the checkout and push, or on GitHub.'], retry: false };
  } else if (merge.mergeable === 'UNKNOWN' || merge.mergeStateStatus === 'UNKNOWN') {
    result = { tone: 'unknown', headline: 'GitHub is still working out whether this can merge.', reasons: [], retry: true };
  } else if (merge.mergeStateStatus === 'BLOCKED') {
    /** @type {string[]} */
    const reasons = [];
    const required = checks.kind === 'ready' ? checks.items.filter((c) => c.required) : [];
    for (const c of required) if (c.state === 'failed') reasons.push(`Required check ${c.name} failed`);
    for (const c of required) if (c.state === 'pending') reasons.push(`Required check ${c.name} has not finished`);
    if (merge.reviewDecision === 'CHANGES_REQUESTED') reasons.push('Changes were requested');
    if (merge.reviewDecision === 'REVIEW_REQUIRED') reasons.push('An approving review is required');
    if (checks.kind === 'failed' || (checks.kind === 'ready' && checks.incomplete !== null)) reasons.push('The required checks could not all be read');
    if (!reasons.length) reasons.push('Branch protection blocks the merge; GitHub does not say why here.');
    result = { tone: 'blocked', headline: 'Merging is blocked:', reasons, retry: false };
  } else if (merge.mergeStateStatus === 'BEHIND') {
    result = { tone: 'blocked', headline: `This branch is behind ${base} and must be updated first.`, reasons: [], retry: false };
  } else if (merge.mergeStateStatus === 'UNSTABLE') {
    result = { tone: 'clean', headline: `No conflicts with ${base}. Some checks that are not required are failing.`, reasons: [], retry: false };
  } else {
    result = { tone: 'clean', headline: `No conflicts with ${base}. Ready to merge.`, reasons: [], retry: false };
  }
  if (merge.isMergeQueueEnabled) result.reasons.push('This branch uses a merge queue: merge on GitHub.');
  if (merge.headMoved) result.reasons.push('GitHub has a newer head than the one reviewed; refresh the analysis.');
  return result;
}

/**
 * @param {import('./pr-review-data').PullRequestOverview} overview
 * @param {{ state: string, baseRefName: string }} pr
 * @returns {OverviewView}
 */
function overviewViewOf(overview, pr) {
  if (overview.kind === 'failed') return { kind: 'failed', message: overview.error.message };
  const c = overview.checks;
  /** @type {ChecksView} */
  const checks = c.kind === 'failed' ? { kind: 'failed', message: c.error.message } : c;
  return { kind: 'ready', merge: mergeStateOf(pr, overview), checks, reviewers: overview.reviewers, labels: overview.labels };
}

/**
 * The page model for the store's state. Pure.
 * @param {ReviewStoreState} state
 * @param {{ attentionLeft: TreeRow[]|null, counts: { total: number, left: number }|null,
 *   draft: string, error: string|null, busy: null|'submit'|'discard' }} panel `attentionLeft`
 *   and `counts` come from the tree (null while it shows no review); the rest is the panel's.
 * @returns {PageModel|null} Null when no pull request is under review.
 */
function pageModelOf(state, { attentionLeft, counts, draft, error, busy }) {
  if (state.kind === 'none') return null;
  const data = reviewDataOf(state);
  const number = state.target ? state.target.number : null;
  const loadError = state.kind === 'failed' ? state.error.message : null;
  /** @type {PageModel} */
  const model = {
    kind: data ? 'ready' : state.kind === 'failed' ? 'failed' : 'loading',
    number, loadError, refreshing: state.kind === 'loading', pr: null, timeline: [], pending: null,
    own: false, check: null, overview: { kind: 'failed', message: 'not loaded' }, incomplete: [], draft, error, busy,
  };
  if (!data) return model;
  const { pr } = data;
  model.pr = { title: pr.title, number: pr.number, state: pr.state, author: pr.author ? pr.author.login : 'ghost',
    headRefName: pr.headRefName, baseRefName: pr.baseRefName, body: pr.body };
  model.timeline = data.timeline.map((item) => ({
    who: item.author ? item.author.login : 'ghost',
    what: item.kind === 'comment' ? 'commented' : REVIEW_STATE_WORDS[item.reviewState || ''] || 'reviewed',
    when: formatWhen(item.createdAt),
    body: item.body,
  }));
  if (data.pendingReview) {
    /** @type {PendingComment[]} */
    const comments = [];
    for (const t of data.threads) {
      for (const c of t.comments) {
        if (!c.pending || !c.mine) continue;
        const line = t.line ?? t.originalLine;
        const where = t.fileLevel ? `${t.path} · file comment` : `${t.path}${line === null ? '' : `:${line}`}`;
        comments.push({ threadId: t.id, where, firstLine: firstLineOf(c.body) });
      }
    }
    model.pending = { commentCount: data.pendingReview.commentCount, comments };
  }
  model.overview = overviewViewOf(data.overview, pr);
  model.own = pr.viewerDidAuthor;
  model.check = approveCheckOf(data, { attentionLeft, counts });
  model.incomplete = data.incomplete;
  return model;
}

/**
 * The success message after a submit.
 * @param {ReviewEvent} event
 * @param {number} number
 * @returns {string}
 */
const submittedMessage = (event, number) => `Review submitted: you ${EVENT_WORDS[event]} on PR #${number}`;

/**
 * The review status bar item's text: shown only while the viewer's pending review holds
 * comments.
 * @param {ReviewStoreState} state
 * @returns {{ text: string, number: number }|null} Null when the item is hidden.
 */
function pendingStatusOf(state) {
  const data = reviewDataOf(state);
  const pending = data && data.pendingReview;
  if (!data || !pending || pending.commentCount <= 0) return null;
  return { text: `✎ ${pending.commentCount} pending · Submit review…`, number: data.pr.number };
}

// Colours are the theme's: a tab must read in every theme, light and dark.
const STYLE = `
body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; }
main { max-width: 1000px; padding: 12px 24px 40px; }
h2 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
h2 .num, .where, .when, .note { color: var(--vscode-descriptionForeground); }
h2 .num { font-weight: 400; }
h4 { color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 16px 0 6px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 18px; }
@media (max-width: 560px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.box { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-top: 6px; }
.row { display: flex; gap: 8px; align-items: baseline; padding: 5px 10px; border-top: 1px solid var(--vscode-panel-border); }
.row:first-child { border-top: 0; }
.row .n { flex: 1; overflow-wrap: anywhere; }
.sum { padding: 7px 10px; font-weight: 600; display: flex; gap: 8px; }
details summary { cursor: pointer; padding: 5px 10px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
.ctx, .dim { color: var(--vscode-descriptionForeground); }
.req { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 6px; color: var(--vscode-descriptionForeground); }
.ok { color: var(--vscode-testing-iconPassed); }
.bad { color: var(--vscode-testing-iconFailed); }
.wait { color: var(--vscode-editorWarning-foreground); }
.unk { color: var(--vscode-descriptionForeground); }
.merge { border-left: 3px solid var(--vscode-testing-iconPassed); background: var(--vscode-textBlockQuote-background); padding: 8px 10px; margin-top: 6px; }
.merge.blocked { border-left-color: var(--vscode-editorWarning-foreground); }
.merge.conflict { border-left-color: var(--vscode-testing-iconFailed); }
.merge.unknown, .merge.done { border-left-color: var(--vscode-descriptionForeground); }
.merge ul { margin: 4px 0 4px 18px; padding: 0; }
.side .p { display: flex; gap: 6px; align-items: baseline; margin: 3px 0; }
.side .p .s { margin-left: auto; font-size: 12px; }
.lbl { display: inline-block; border-radius: 10px; padding: 0 8px; font-size: 12px; margin: 2px 3px 2px 0; border: 1px solid var(--vscode-panel-border); }
.meta { margin-bottom: 12px; }
.state { border-radius: 10px; padding: 1px 9px; font-size: 12px; margin-right: 6px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
.state.OPEN { color: var(--vscode-button-foreground); background: var(--vscode-testing-iconPassed); }
code { font-family: var(--vscode-editor-font-family); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.desc { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px 12px; }
.tl { border-left: 2px solid var(--vscode-panel-border); margin-left: 8px; padding-left: 14px; }
.ev { margin: 10px 0; }
.ev .text { margin-top: 2px; }
.pending a { display: block; padding: 4px 8px; margin: 4px 0; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
textarea { box-sizing: border-box; width: 100%; min-height: 90px; padding: 6px; font: inherit; resize: vertical;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
.check { margin: 10px 0; padding: 8px 10px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
.check ul { margin: 4px 0 6px 16px; padding: 0; }
.err { color: var(--vscode-errorForeground); margin-top: 6px; }
.banner { margin: 0 0 12px; padding: 6px 10px; border-left: 3px solid var(--vscode-editorError-foreground); background: var(--vscode-textBlockQuote-background); }
.reason { color: var(--vscode-descriptionForeground); margin-top: 4px; }
.btns { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
.btns .cancel { margin-right: auto; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
button { font: inherit; border: 0; border-radius: 2px; padding: 4px 12px; cursor: pointer;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button[disabled] { opacity: .5; cursor: default; }
[hidden] { display: none !important; }
`;

// The page's behaviour: applies `buttonRules` as the reviewer types or ticks "Approve
// anyway", keeps the summary in webview state and the extension, and turns clicks into
// messages. The extension validates every message and decides everything that matters,
// including the approve check; this script only mirrors the rules up front. Every message
// carries this page's nonce, so a click on an older page acts on nothing.
/** @param {string} token The validated base64 nonce. @param {string} draftKey The kept draft identity. */
const script = (token, draftKey) => `
const vscode = acquireVsCodeApi();
const token = ${JSON.stringify(token)};
const draftKey = ${JSON.stringify(draftKey)};
const post = (message) => vscode.postMessage({ ...message, token });
const el = (name) => document.querySelector('[data-el="' + name + '"]');
${buttonRules.toString()}
const facts = () => {
  const form = el('form'), summary = el('summary'), anyway = el('anyway');
  return {
    own: form.getAttribute('data-own') === 'true',
    pendingComments: Number(form.getAttribute('data-pending')),
    checkNeeded: form.getAttribute('data-check') === 'true',
    busy: form.getAttribute('data-busy') === 'true',
    hasSummary: !!summary && summary.value.trim() !== '',
    approveAnyway: !!anyway && anyway.checked === true,
  };
};
const update = () => {
  if (!el('form')) return;
  const rules = buttonRules(facts());
  for (const name of ['requestChanges', 'approve', 'comment']) {
    const button = el(name), reason = el('reason-' + name);
    if (button) { if (rules[name].disabled) button.setAttribute('disabled', ''); else button.removeAttribute('disabled'); }
    if (reason) {
      reason.textContent = rules[name].reason || '';
      if (rules[name].reason) reason.removeAttribute('hidden'); else reason.setAttribute('hidden', '');
    }
  }
};
let edited = false;
const saveDraft = () => { const summary = el('summary'); if (summary) vscode.setState({ draftKey, body: summary.value }); };
const saved = vscode.getState();
if (el('summary') && saved && saved.draftKey === draftKey && typeof saved.body === 'string') el('summary').value = saved.body;
document.addEventListener('input', (event) => {
  if (event.target !== el('summary')) return;
  update();
  edited = true;
  saveDraft();
  post({ type: 'draft', body: el('summary').value });
});
document.addEventListener('change', (event) => { if (event.target === el('anyway')) update(); });
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
  if (!target) return;
  event.preventDefault();
  const act = target.getAttribute('data-act');
  if (act === 'submit') {
    if (target.hasAttribute('disabled')) return;
    saveDraft();
    post({ type: 'submit', event: target.getAttribute('data-event'), body: el('summary').value, approveAnyway: facts().approveAnyway });
  } else if (act === 'discard') { if (!target.hasAttribute('disabled')) post({ type: 'discard' }); }
  else if (act === 'revealThread') post({ type: 'revealThread', threadId: target.getAttribute('data-thread') });
  else if (act === 'revealRow') post({ type: 'revealRow', rowId: target.getAttribute('data-row') });
  else if (act === 'retry') post({ type: 'retry' });
  else if (act === 'openLink') post({ type: 'openLink', url: target.getAttribute('data-url') });
});
window.addEventListener('message', (event) => {
  const data = event.data;
  if (edited || !data || data.token !== token || data.type !== 'draft' || typeof data.body !== 'string') return;
  const summary = el('summary');
  if (summary && summary.value !== data.body) { summary.value = data.body; saveDraft(); update(); }
});
update();
post(el('summary') ? { type: 'ready', body: el('summary').value } : { type: 'ready' });
`;

/** @param {string|null} loadError @returns {string} */
const retryBanner = (loadError) => (loadError === null ? ''
  : `<div class="banner" role="alert">Could not load the review from GitHub: <span class="text">${escapeHtml(loadError)}</span> `
    + '<button class="secondary" data-act="retry">Retry</button></div>');

/** @param {NonNullable<PageModel['pr']>} pr @returns {string} */
function headerHtml(pr) {
  const stateWords = PR_STATE_WORDS[pr.state] || pr.state;
  return `<h2>${escapeHtml(pr.title)} <span class="num">#${pr.number}</span></h2>`
    + `<div class="meta"><span class="state ${escapeHtml(pr.state)}">${escapeHtml(stateWords)}</span>`
    + `${escapeHtml(pr.author)} wants to merge into <code>${escapeHtml(pr.baseRefName)}</code>`
    + ` from <code>${escapeHtml(pr.headRefName)}</code></div>`
    + (pr.body.trim() === '' ? '<div class="desc note">No description provided.</div>'
      : `<div class="desc text" data-el="description">${escapeHtml(pr.body)}</div>`);
}

/** @param {TimelineEntry[]} timeline @returns {string} */
function timelineHtml(timeline) {
  if (!timeline.length) return '';
  const items = timeline.map((e) => `<div class="ev"><b>${escapeHtml(e.who)}</b> ${escapeHtml(e.what)} `
    + `<span class="when">${escapeHtml(e.when)}</span>${e.body.trim() === '' ? '' : `<div class="text">${escapeHtml(e.body)}</div>`}</div>`).join('');
  return `<h4>Timeline</h4><div class="tl">${items}</div>`;
}

/** @param {PageModel['pending']} pending @returns {string} */
function pendingHtml(pending) {
  if (!pending) return '';
  const n = pending.commentCount;
  const items = pending.comments.map((c) => `<a href="#" data-act="revealThread" data-thread="${escapeHtml(c.threadId)}">`
    + `<span class="where">${escapeHtml(c.where)}</span> ${escapeHtml(c.firstLine)}</a>`).join('');
  return `<div class="pending"><div class="where">Your pending review has ${n} comment${n === 1 ? '' : 's'}${n ? ':' : '.'}</div>${items}</div>`;
}

/** @param {ApproveCheck|null} check @returns {string} */
function checkHtml(check) {
  if (!check) return '';
  const items = [];
  if (!check.progressKnown) items.push('<li>The tree is not showing this review, so which changes are left is not known.</li>');
  const a = check.attention.length;
  if (a) {
    const links = check.attention.map((i) => `<a href="#" data-act="revealRow" data-row="${escapeHtml(i.id)}" title="${escapeHtml(i.where)}">${escapeHtml(i.name)}</a>`
      + ` <span class="where">${escapeHtml(i.where)}</span>`).join(', ');
    items.push(`<li>${attentionCountText(a)} and ${a === 1 ? 'is' : 'are'} not reviewed: ${links}</li>`);
  }
  const t = check.unresolvedThreads;
  if (t) items.push(`<li>${t} thread${t === 1 ? ' is' : 's are'} unresolved</li>`);
  if (check.progressKnown) items.push(`<li>${check.left} of ${check.total} rows are not reviewed</li>`);
  return `<div class="check" data-el="check"><b>Before you approve:</b><ul>${items.join('')}</ul>`
    + '<label><input type="checkbox" data-el="anyway"> Approve anyway</label></div>';
}

/**
 * The summary box, the approve check, the buttons and their reasons, and the error area.
 * @param {PageModel} model A `ready` model.
 * @returns {string}
 */
function formHtml(model) {
  const pendingComments = model.pending ? model.pending.commentCount : 0;
  const rules = buttonRules({ own: model.own, pendingComments, checkNeeded: model.check !== null, busy: model.busy !== null,
    hasSummary: model.draft.trim() !== '', approveAnyway: false });
  const disabled = (/** @type {{ disabled: boolean }} */ r) => (r.disabled ? ' disabled' : '');
  const reason = (/** @type {string} */ name, /** @type {{ reason: string|null }} */ r) => `<div class="reason" data-el="reason-${name}"${r.reason ? '' : ' hidden'}>${escapeHtml(r.reason || '')}</div>`;
  const commentLabel = pendingComments > 0 ? 'Submit Review' : 'Comment';
  const cancel = model.pending
    ? `<button class="secondary cancel" data-act="discard" data-el="cancel"${model.busy ? ' disabled' : ''}>Cancel review</button>` : '';
  const busyNote = model.busy === 'submit' ? '<div class="note">Submitting your review…</div>'
    : model.busy === 'discard' ? '<div class="note">Discarding your pending review…</div>' : '';
  return `<div data-el="form" data-own="${model.own}" data-pending="${pendingComments}" data-check="${model.check !== null}" data-busy="${model.busy !== null}">`
    + `<h4>Finish your review</h4>${pendingHtml(model.pending)}`
    + `<textarea data-el="summary" placeholder="Leave a summary (Request Changes needs one)">${escapeHtml(model.draft)}</textarea>`
    + checkHtml(model.check)
    + '<div class="btns">'
    + cancel
    + `<button class="secondary" data-act="submit" data-event="REQUEST_CHANGES" data-el="requestChanges"${disabled(rules.requestChanges)}>Request Changes</button>`
    + `<button class="secondary" data-act="submit" data-event="APPROVE" data-el="approve"${disabled(rules.approve)}>Approve</button>`
    + `<button data-act="submit" data-event="COMMENT" data-el="comment"${disabled(rules.comment)}>${commentLabel}</button>`
    + '</div>'
    + (model.own ? `<div class="reason" data-el="reason-own">${escapeHtml(OWN_PR_REASON)}</div>` : '')
    + reason('requestChanges', rules.requestChanges) + reason('approve', rules.approve) + reason('comment', rules.comment)
    + busyNote
    + `<div class="err text" data-el="error" role="alert"${model.error ? '' : ' hidden'}>${escapeHtml(model.error || '')}</div>`
    + '</div>';
}

const RE_HEX = /^[0-9a-f]{6}$/;
/** @param {{ color: string|null }} label @returns {boolean} */
const hasColor = (label) => label.color !== null && RE_HEX.test(label.color);

/**
 * One border colour rule per label with a valid colour, for the nonce'd stylesheet: a
 * label colour cannot be an inline `style=` (the CSP blocks it). Only 6-digit hex gets in.
 * @param {PageModel} model
 * @returns {string}
 */
function labelCss(model) {
  if (model.overview.kind !== 'ready') return '';
  return model.overview.labels.items.map((l, i) => (hasColor(l) ? `.lbl-${i} { border-color: #${l.color}; }\n` : '')).join('');
}

const retryButton = '<button class="secondary" data-act="retry">Retry</button>';

/** @type {Record<string, { icon: string, cls: string, words: string }>} */
const CHECK_LOOK = {
  failed: { icon: '✗', cls: 'bad', words: 'Failed' },
  pending: { icon: '●', cls: 'wait', words: 'Pending' },
  passed: { icon: '✓', cls: 'ok', words: 'Passed' },
  skipped: { icon: '○', cls: 'unk', words: 'Skipped' },
};

/** @param {import('./pr-review-data').CheckItem} c @returns {string} */
function checkRowHtml(c) {
  const look = CHECK_LOOK[c.state];
  return `<div class="row" data-el="check-row"><span class="${look.cls}">${look.icon}</span>`
    + `<span class="n">${escapeHtml(c.name)}${c.context === null ? '' : ` <span class="ctx">· ${escapeHtml(c.context)}</span>`}`
    + `${c.detail ? ` <span class="ctx">${escapeHtml(c.detail)}</span>` : ''}${c.required ? ' <span class="req">Required</span>' : ''}</span>`
    + `<span class="${look.cls}">${look.words}</span>`
    + (c.url === null ? '' : `<a href="#" data-act="openLink" data-url="${escapeHtml(c.url)}">Details</a>`) + '</div>';
}

/** @param {ChecksView} checks @returns {string} */
function checksHtml(checks) {
  if (checks.kind === 'failed') {
    return '<h4>Checks</h4><div class="banner" role="alert" data-el="checks-failed">Checks could not be loaded: '
      + `<span class="text">${escapeHtml(checks.message)}</span>. They are not shown, which does not mean there are none. ${retryButton}</div>`;
  }
  if (checks.kind === 'none' || checks.items.length === 0) return '<h4>Checks</h4><div class="note" data-el="checks-none">No checks reported for this commit.</div>';
  const by = (/** @type {string} */ state) => checks.items.filter((c) => c.state === state);
  const failed = by('failed'), pending = by('pending'), passed = by('passed'), skipped = by('skipped');
  const tail = skipped.length ? `, ${skipped.length} skipped` : '';
  let icon, text;
  if (failed.length || pending.length) {
    icon = failed.length ? '<span class="bad">✗</span>' : '<span class="wait">●</span>';
    text = `${failed.length} failing, ${pending.length} pending, ${passed.length} passed${tail}`;
  } else if (checks.incomplete !== null) {
    icon = '<span class="unk">?</span>';
    text = `None of the ${checks.items.length} loaded checks is failing or pending`;
  } else if (passed.length) {
    icon = '<span class="ok">✓</span>';
    text = `All ${passed.length} checks passed${tail}`;
  } else {
    icon = '<span class="unk">○</span>';
    text = `${skipped.length} skipped`;
  }
  const done = passed.length + skipped.length;
  const folded = done === 0 ? '' : `<details data-el="checks-passed"><summary>${passed.length} passed${tail}</summary>${[...passed, ...skipped].map(checkRowHtml).join('')}</details>`;
  return `<h4>Checks</h4><div class="box" data-el="checks"><div class="sum">${icon} <span>${escapeHtml(text)}</span></div>`
    + `${[...failed, ...pending].map(checkRowHtml).join('')}${folded}</div>`
    + (checks.incomplete === null ? '' : `<div class="note" data-el="checks-incomplete">${escapeHtml(`Only the first ${checks.items.length} of ${checks.total} checks were loaded.`)}</div>`);
}

/** @param {OverviewView} view @returns {string} */
function mergeHtml(view) {
  if (view.kind === 'failed') {
    return '<h4>Merge</h4><div class="merge unknown" data-el="merge"><span class="unk">?</span> '
      + `Merge state could not be loaded: <span class="text">${escapeHtml(view.message)}</span> ${retryButton}</div>`;
  }
  const m = view.merge;
  const icon = { clean: '<span class="ok">✓</span>', blocked: '<span class="wait">●</span>', conflict: '<span class="bad">✗</span>',
    unknown: '<span class="unk">?</span>', done: '<span class="unk">✓</span>' }[m.tone];
  const refresh = m.retry ? ' <a href="#" data-act="retry">Refresh</a> in a moment.' : '';
  const reasons = m.reasons.length ? `<ul>${m.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';
  return `<h4>Merge</h4><div class="merge ${m.tone}" data-el="merge">${icon} ${escapeHtml(m.headline)}${refresh}${reasons}</div>`;
}

/** @type {Record<string, { icon: string, cls: string, words: string }>} */
const REVIEWER_LOOK = {
  APPROVED: { icon: '✓', cls: 'ok', words: 'Approved' },
  CHANGES_REQUESTED: { icon: '✗', cls: 'bad', words: 'Changes requested' },
  AWAITING: { icon: '●', cls: 'wait', words: 'Awaiting review' },
  COMMENTED: { icon: '💬', cls: 'dim', words: 'Commented' },
  DISMISSED: { icon: '○', cls: 'unk', words: 'Dismissed' },
};

/** @param {OverviewView} view @returns {string} */
function reviewersHtml(view) {
  if (view.kind === 'failed') return `<h4>Reviewers</h4><div class="note" data-el="reviewers">Reviewers could not be loaded: ${escapeHtml(view.message)}</div>`;
  const { items, more } = view.reviewers;
  const rows = items.map((r) => {
    const look = REVIEWER_LOOK[r.state];
    return `<div class="p"><span class="${look.cls}">${look.icon}</span><span>${escapeHtml(r.name)}</span><span class="s ${look.cls}">${look.words}</span></div>`;
  }).join('');
  const note = more ? `<div class="note">${more} more reviewer${more === 1 ? ' was' : 's were'} not loaded.</div>` : '';
  return `<h4>Reviewers</h4><div data-el="reviewers">${rows || '<div class="note">No reviewers.</div>'}${note}</div>`;
}

/** @param {OverviewView} view @returns {string} */
function labelsHtml(view) {
  if (view.kind === 'failed') return `<h4>Labels</h4><div class="note" data-el="labels">Labels could not be loaded: ${escapeHtml(view.message)}</div>`;
  const { items, more } = view.labels;
  const chips = items.map((l, i) => `<span class="lbl${hasColor(l) ? ` lbl-${i}` : ''}">${escapeHtml(l.name)}</span>`).join('');
  const note = more ? `<div class="note">${more} more label${more === 1 ? ' was' : 's were'} not loaded.</div>` : '';
  return `<h4>Labels</h4><div data-el="labels">${chips || '<div class="note">No labels.</div>'}${note}</div>`;
}

/** @param {PageModel} model @returns {string} */
function bodyHtml(model) {
  const named = model.number === null ? 'the pull request' : `pull request #${model.number}`;
  if (model.kind === 'loading') return `<p class="note">Loading ${named} from GitHub…</p>`;
  if (model.kind === 'failed') return retryBanner(model.loadError);
  const pr = /** @type {NonNullable<PageModel['pr']>} */ (model.pr);
  const incomplete = model.incomplete.length
    ? `<div class="banner">Not everything was loaded:<ul>${model.incomplete.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>` : '';
  return retryBanner(model.loadError)
    + (model.refreshing ? '<p class="note">Refreshing from GitHub…</p>' : '')
    + incomplete + headerHtml(pr)
    + `<div class="cols"><div>${timelineHtml(model.timeline)}${checksHtml(model.overview.kind === 'ready' ? model.overview.checks : { kind: 'failed', message: model.overview.message })}`
    + `${mergeHtml(model.overview)}${formHtml(model)}</div><div class="side">${reviewersHtml(model.overview)}${labelsHtml(model.overview)}</div></div>`;
}

/**
 * The Pull Request tab's document.
 * @param {PageModel} model From `pageModelOf`.
 * @param {{ nonce: string, cspSource: string, draftKey?: string }} opts `nonce` is base64 and fresh per document.
 * @returns {string}
 */
function buildPullRequestHtml(model, { nonce, cspSource, draftKey = nonce }) {
  assert.match(nonce, /^[A-Za-z0-9+/=]+$/, 'the nonce must be base64 so it cannot break out of the CSP');
  const csp = `default-src 'none'; style-src ${escapeHtml(cspSource)} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + `<style nonce="${nonce}">${STYLE}${labelCss(model)}</style></head>`
    + `<body><main>${bodyHtml(model)}</main><script nonce="${nonce}">${script(nonce, draftKey)}</script></body></html>`;
}

module.exports = {
  buildPullRequestHtml, pageModelOf, mergeStateOf, buttonRules, pendingStatusOf, submittedMessage, firstLineOf, formatWhen,
  OWN_PR_REASON,
};
