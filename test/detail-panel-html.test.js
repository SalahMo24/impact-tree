'use strict';
// The detail panel's HTML, built from rows of the real row model: no vscode stub. What a
// reviewer reads is checked as text (tags stripped, entities decoded); the document's
// safety (escaping, CSP, nonces) is checked on the raw HTML.
//
// The panel is deliberately small: the progress strip, the row's title and path, why a red
// or amber row needs a look, and a Preview's limits. Nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildFileRows, buildImpactRows } = require('../src/views/changes/review-tree-model');
const { buildDetailHtml, listCallerRows, progressPresentation, escapeHtml } = require('../src/views/details/detail-panel-html');
const { STATE_NAMES, PREVIEW_LIMITS_NOTE } = require('../src/views/changes/tree-row-models');

const uriOf = (file, pos) => (file ? `uri:${file}${pos == null ? '' : `#${pos}`}` : null);
const rel = (f) => f.replace('/r/', '');
const BODY = { id: 'body', label: 'body' };
const PARAM = { id: 'required-param', label: 'required parameter changed' };
const THROW = { id: 'new-throw', label: 'new throw' };
const NONCE = 'bm9uY2Utb25l';
const CSP_SOURCE = 'https://webview.test';

const site = (start) => ({ start, end: start + 3 });
const callerOf = (relPath, label, pos, updated, extra = {}) => ({
  file: `/r/${relPath}`, pos, label, test: false, callSites: [site(pos + 5)], sites: 1,
  callSiteUpdates: updated ? { updated: [site(pos + 5)], untouched: [], unknown: [] } : { updated: [], untouched: [site(pos + 5)], unknown: [] },
  ...extra,
});
const change = (relPath, label, startLine, extra = {}) => ({
  file: `/r/${relPath}`, relPath, label, namePos: startLine * 100, startLine, endLine: startLine + 9,
  kinds: [BODY], throwsAdded: [], baseSig: '(a) => x', headSig: '(a) => x', staleCallers: 0, callerState: 'none',
  callers: [], score: 1, testState: 'covered', tests: ['spec.test.js'], ...extra,
});
const resultOf = (extra = {}) => {
  const fileStatus = {};
  for (const c of extra.allChanged || []) fileStatus[c.relPath] = 'modified';
  for (const f of extra.otherFiles || []) fileStatus[f.path] = f.status;
  return { allChanged: [], deleted: [], outside: [], otherFiles: [], testReachComputed: true, reachDepth: 2, fileStatus, ...extra };
};

// The text a reader sees, one space between pieces.
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const withoutScript = (html) => html.replace(/<script[\s\S]*?<\/script>/, '');

const render = (row, result, progress = null) => buildDetailHtml(row, { result, nonce: NONCE, cspSource: CSP_SOURCE, progress });
const rowsOf = (result) => buildFileRows(result, { uriOf, absPath: (p) => `/r/${p}` }).rows;
const findRow = (result, label) => rowsOf(result).flatMap((f) => (f.type === 'reviewFile' ? f.rows : [f])).find((r) => r.label === label || r.finding?.label === label);

test('a change that breaks a caller: title, location and why it needs a look, in red', () => {
  const stale = callerOf('src/user.ts', 'useIt', 300, false);
  const fine = callerOf('src/other.ts', 'alsoUses', 500, true);
  const bad = change('src/a.ts', 'Holder.bad', 10, { kinds: [PARAM], callerState: 'resolved', callers: [stale, fine], staleCallers: 1,
    baseSig: '(a: string) => void', headSig: '(a: string, b: number) => void' });
  const result = resultOf({ allChanged: [bad] });
  const html = render(findRow(result, 'Holder.bad'), result);
  assert.equal(textOf(html),
    'Holder.bad src/a.ts:10–19 Callers not updated. The required parameter changed, and 1 of 2 callers was not changed on the call line. Check that it still works.');
  assert.match(html, /class="verdict lv0"/, 'red');
});

test('nothing else of a change is drawn: no callers, signature, throws, tests, threads or buttons', () => {
  const c = change('src/a.ts', 'f', 10, { kinds: [PARAM, THROW], throwsAdded: ['new Error()'], callerState: 'resolved', staleCallers: 1,
    callers: [callerOf('src/u.ts', 'u', 100, false)], baseSig: '(a) => x', headSig: '(a, b) => x' });
  const result = resultOf({ allChanged: [c], testReachComputed: false });
  const html = withoutScript(render(findRow(result, 'f'), result));
  assert.doesNotMatch(textOf(html), /Callers \(|Signature|New throw|Tests|Threads|Feedback|Mark reviewed|Next unreviewed|Show callers|selected in tree|at cursor/);
  assert.doesNotMatch(html, /<button|data-act/, 'no button and no action outside a Preview');
});

test('an amber row says why without the red class; a fine row says nothing', () => {
  const cases = [
    [change('src/a.ts', 'unknown', 10, { kinds: [THROW], callerState: 'unknown', callersIncompleteReason: 'referenced-as-value' }), 'Callers unknown', 'amber'],
    [change('src/a.ts', 'lost', 10, { callerState: 'unknown', callersIncompleteReason: 'referenced-as-value' }), null, 'amber'],
    [change('src/a.ts', 'handled', 10, { kinds: [PARAM], callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, true)] }), 'Callers updated', 'fine'],
    [change('src/a.ts', 'reaches', 10, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)] }), 'Reaches callers', 'fine'],
    [change('src/a.ts', 'quiet', 10), 'No callers', 'fine'],
  ];
  for (const [c, word, tone] of cases) {
    if (word) assert.ok(STATE_NAMES.levels.includes(word), word);
    const result = resultOf({ allChanged: [c] });
    const html = render(findRow(result, c.label), result);
    if (tone === 'fine') {
      assert.equal(textOf(html), `${c.label} src/a.ts:10–19`, c.label);
      assert.doesNotMatch(html, /class="verdict/, c.label);
    } else {
      assert.match(html, /class="verdict"/, `${c.label}: amber, not lv0`);
      if (word) assert.match(textOf(html), new RegExp(`^${c.label} src/a\\.ts:10–19 ${word}\\. `), c.label);
      else assert.match(textOf(html), /Only the body changed\. Its callers could not be found/, 'an unknown body-only change is amber, never fine');
    }
  }
});

test('a deleted symbol is amber with its sentence; an outside row is fine and says nothing more', () => {
  const result = resultOf({
    allChanged: [change('src/a.ts', 'f', 10)],
    deleted: [{ label: 'gone', key: 'gone', relPath: 'src/a.ts', file: '/r/src/a.ts', namePos: 40, startLine: 40 }],
    outside: [{ file: '/r/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 2], [7, 7]] }],
  });
  const gone = render(findRow(result, 'gone'), result);
  assert.match(textOf(gone), /^gone src\/a\.ts · deleted This symbol was removed\. Its former callers were not searched/);
  assert.match(gone, /class="verdict"/);
  assert.equal(textOf(render(findRow(result, 'Outside functions'), result)), 'Outside functions src/a.ts');
});

test('a file row shows its name, path and status only', () => {
  const result = resultOf({ allChanged: [
    change('src/a.ts', 'bad', 10, { kinds: [PARAM], callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)], staleCallers: 1 }),
    change('src/a.ts', 'quiet', 50),
  ], otherFiles: [{ path: 'docs/notes.md', status: 'added' }] });
  const [file, other] = rowsOf(result);
  assert.equal(file.type, 'reviewFile');
  assert.equal(textOf(render(file, result)), 'a.ts src/a.ts · modified', 'no counts: the tree has them');
  assert.equal(other.type, 'file');
  assert.equal(textOf(render(other, result)), 'notes.md docs/notes.md · added');
  assert.doesNotMatch(withoutScript(render(file, result)), /class="verdict|<button/);
});

test('a Preview says what it cannot see, with a Check out and analyse button, on every row', () => {
  const c = change('src/a.ts', 'f', 10);
  const preview = resultOf({ allChanged: [c], tierA: true });
  for (const row of [findRow(preview, 'f'), rowsOf(preview)[0]]) {
    const html = render(row, preview);
    assert.ok(textOf(html).endsWith(`${PREVIEW_LIMITS_NOTE} Check out and analyse`), row.type);
    assert.match(html, /<button data-act="checkout">Check out and analyse<\/button>/);
  }
  const local = resultOf({ allChanged: [c] });
  assert.doesNotMatch(render(findRow(local, 'f'), local), /data-preview-limits|data-act="checkout"/);
});

test('no row: a short hint, and no buttons', () => {
  const html = render(null, null);
  assert.equal(textOf(html), 'Select a change in the tree, or put the cursor in a changed function.');
  assert.doesNotMatch(withoutScript(html), /data-act/);
});

test('every value from the result is escaped', () => {
  const evil = '<script>alert("x")</script> & "q" \'s';
  const c = change(`src/${evil}.ts`, evil, 10, {
    kinds: [PARAM], callerState: 'resolved', staleCallers: 1, callers: [callerOf(`src/${evil}.ts`, evil, 100, false)],
  });
  const result = resultOf({ allChanged: [c], deleted: [{ label: evil, key: evil, relPath: `src/${evil}.ts`, file: '/r/x', namePos: 1, startLine: 1 }] });
  const html = render(findRow(result, evil), result);
  assert.equal(html.match(/<script/g).length, 1, 'only the panel\'s own script tag');
  assert.doesNotMatch(html, /alert\("x"\)/, 'a quote is never written raw');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;q&quot; &#39;s'));
  assert.ok(textOf(html).startsWith(`${evil} src/${evil}.ts:10–19 Callers not updated.`));
  const files = rowsOf(result);
  for (const r of [files[0], files[0].rows.find((x) => x.type === 'deleted')]) {
    const other = render(r, result);
    assert.equal(other.match(/<script/g).length, 1, r.type);
    assert.ok(textOf(other).includes(`src/${evil}.ts`), r.type);
  }
  assert.equal(escapeHtml('<a b="c">\'&'), '&lt;a b=&quot;c&quot;&gt;&#39;&amp;');
});

test('the document has a strict CSP, a nonce on every script and style, and nothing remote', () => {
  const c = change('src/a.ts', 'f', 10, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)] });
  const result = resultOf({ allChanged: [c], otherFiles: [{ path: 'n.md', status: 'added' }], tierA: true });
  const files = rowsOf(result);
  for (const row of [null, files[0], files[0].rows[0], files[1]]) {
    const html = render(row, result, progressPresentation({ total: 2, left: 1, attention: 1, attentionTotal: 1 }));
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    assert.ok(csp, 'a CSP meta tag');
    assert.equal(csp[1], `default-src 'none'; style-src ${CSP_SOURCE} 'nonce-${NONCE}'; script-src 'nonce-${NONCE}';`);
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
    const tags = [...html.matchAll(/<(script|style)\b([^>]*)>/g)];
    assert.deepEqual(tags.map((t) => t[1]).sort(), ['script', 'style']);
    for (const t of tags) assert.match(t[2], new RegExp(`nonce="${NONCE}"`), t[0]);
    assert.doesNotMatch(html.replaceAll(CSP_SOURCE, ''), /https?:\/\//, 'no remote URL');
    assert.doesNotMatch(html, /\sstyle="|\son[a-z]+=/, 'no inline style or handler attributes, which the CSP would block');
  }
  assert.throws(() => buildDetailHtml(null, { result: null, nonce: 'a"b', cspSource: CSP_SOURCE }), 'a nonce that is not base64');
});

test('colours come only from theme variables', () => {
  const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(render(null, null))[1];
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no literal colour');
  assert.match(css, /var\(--vscode-foreground\)/);
  assert.match(css, /var\(--vscode-button-background\)/);
});

test('the progress strip shows how many rows that need attention were looked at, and drives a <progress> element; no source line or percentage', () => {
  const html = render(null, null, progressPresentation({ line: 'PR #15 against main', total: 8, left: 5, attention: 2, attentionTotal: 5 }));
  assert.equal(textOf(html), '3 of 5 looked at 2 need attention 3 of 5 looked at Select a change in the tree, or put the cursor in a changed function.');
  assert.match(html, /<progress max="5" value="3" data-progress-meter>/);
  assert.match(html, /<span class="lv0" data-progress-attention>2 need attention<\/span>/);
  assert.doesNotMatch(html, /PR #15|%</);
  const done = render(null, null, progressPresentation({ total: 2, left: 0, attention: 0, attentionTotal: 2 }));
  assert.match(done, /<span class="lv2" data-progress-attention>nothing needs attention<\/span>/);
  assert.match(textOf(done), /^2 of 2 looked at nothing needs attention/);
  assert.match(/<style[^>]*>([\s\S]*?)<\/style>/.exec(html)[1], /\.progress\s*\{[^}]*position: sticky; top: 0/);
  assert.deepEqual(progressPresentation({ total: 4, left: 1, attention: 1, attentionTotal: 2 }),
    { looked: 1, max: 2, countText: '1 of 2 looked at', attentionText: '1 needs attention', attentionClass: 'lv0' });
});

test('with nothing that needs attention the strip says how many changes there are and the meter is full', () => {
  assert.deepEqual(progressPresentation({ total: 107, left: 107, attention: 0, attentionTotal: 0 }),
    { looked: 107, max: 107, countText: '107 changes', attentionText: 'nothing needs attention', attentionClass: 'lv2' });
  assert.equal(progressPresentation({ total: 1, left: 1, attention: 0, attentionTotal: 0 }).countText, '1 change');
  const html = render(null, null, progressPresentation({ total: 3, left: 3, attention: 0, attentionTotal: 0 }));
  assert.equal(textOf(html), '3 changes nothing needs attention 3 changes Select a change in the tree, or put the cursor in a changed function.');
  assert.match(html, /<progress max="3" value="3" data-progress-meter>/);
});

test('there is no strip without counting rows', () => {
  assert.equal(progressPresentation(null), null);
  assert.equal(progressPresentation({ total: 0, left: 0, attention: 0, attentionTotal: 0 }), null);
  assert.doesNotMatch(withoutScript(render(null, null)), /<progress|data-progress/);
});

// Runs the page's script against a minimal DOM.
function runScript(html) {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
  const sent = [], listeners = new Map(), windowListeners = new Map();
  const nodes = new Map();
  const node = (key) => {
    if (!nodes.has(key)) nodes.set(key, { textContent: '', attrs: {}, setAttribute(n, v) { this.attrs[n] = v; } });
    return nodes.get(key);
  };
  class Element {
    constructor(attributes) { this.attributes = attributes; }
    closest() { return this; }
    getAttribute(name) { return this.attributes[name] ?? null; }
  }
  vm.runInNewContext(script, {
    Element, acquireVsCodeApi: () => ({ postMessage: (message) => sent.push(JSON.parse(JSON.stringify(message))) }),
    window: { addEventListener: (event, fn) => windowListeners.set(event, fn) },
    document: { addEventListener: (event, fn) => listeners.set(event, fn), querySelector: (sel) => node(sel) },
  });
  const click = (attributes) => listeners.get('click')({ target: new Element(attributes), preventDefault() {} });
  const receive = (data) => windowListeners.get('message')({ data });
  return { script, sent, click, receive, node };
}

test('the page script sends only the checkout click, with its render token; other actions send nothing', () => {
  const page = runScript(render(null, null));
  for (const act of ['tick', 'next', 'peek', 'caller', 'test-reach', 'thread', 'comment', 'feedback', 'caller-comment']) {
    page.click({ 'data-act': act, 'data-id': 'row-id', 'data-on': 'true', 'data-index': '2' });
  }
  page.click({ 'data-act': 'checkout' });
  assert.deepEqual(page.sent, [{ type: 'ready', token: NONCE }, { type: 'checkoutAndAnalyse', token: NONCE }]);
  assert.doesNotMatch(page.script, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('the page script patches the progress strip as text, only for its own token and a well-formed model', () => {
  const page = runScript(render(null, null));
  const model = progressPresentation({ total: 5, left: 2, attention: 0, attentionTotal: 3 });
  page.receive({ type: 'progress', token: 'other', model });
  page.receive({ type: 'origin', token: NONCE, text: 'at cursor, line 3' });
  page.receive({ type: 'review', token: NONCE, model: { id: 'x', reviewed: true, buttonText: 'b', summaryText: null } });
  page.receive({ type: 'progress', token: NONCE, model: { ...model, looked: 9 } });
  page.receive({ type: 'progress', token: NONCE, model: { ...model, max: 0 } });
  page.receive({ type: 'progress', token: NONCE, model: { countText: '3 of 5 reviewed', attentionText: 'x', attentionClass: 'lv2', reviewed: 3, total: 5 } });
  assert.equal(page.node('[data-progress-count]').textContent, '', 'a foreign token, an old message type or a bad model changes nothing');
  page.receive({ type: 'progress', token: NONCE, model });
  assert.equal(page.node('[data-progress-count]').textContent, '3 of 3 looked at');
  assert.equal(page.node('[data-progress-attention]').textContent, 'nothing needs attention');
  assert.equal(page.node('[data-progress-attention]').attrs.class, 'lv2');
  assert.deepEqual(page.node('[data-progress-meter]').attrs, { max: '3', value: '3' });
});

test('listCallerRows lists callers grouped by file one by one, test callers included', () => {
  const callers = [callerOf('src/u.ts', 'one', 100, false), callerOf('src/u.ts', 'two', 200, true), callerOf('test/a.test.ts', 'a.test.ts', 0, false, { test: true })];
  const c = change('src/a.ts', 'f', 10, { callerState: 'resolved', callers });
  const result = resultOf({ allChanged: [c] });
  const impact = buildImpactRows(findRow(result, 'f'), { result, uriOf, rel }).rows;
  assert.equal(impact[0].type, 'callerFile', 'the fixture groups two callers');
  assert.deepEqual(listCallerRows(impact).map((r) => r.label), ['one', 'two', 'a.test.ts']);
});

test('what the user\'s agent said a change does: kind and line, before / after / when / affects, escaped; nothing when it said nothing', () => {
  const bad = change('src/a.ts', 'Holder.bad', 10);
  const result = resultOf({ allChanged: [bad] });
  const row = findRow(result, 'Holder.bad');
  const said = { kind: 'changed', what: 'Rejects <script> paths', before: 'accepted any path', after: 'throws UnsupportedPathError', when: 'a path holds \\n',
    affects: [{ name: 'Hono.#addRoute', how: 'throws at startup' }, { name: 'SmartRouter.match', how: 'falls through' }] };
  const html = buildDetailHtml(row, { result, nonce: NONCE, cspSource: CSP_SOURCE, agentChange: said });
  assert.equal(textOf(html), 'Holder.bad src/a.ts:10–19 Changed: Rejects <script> paths Before accepted any path After throws UnsupportedPathError When a path holds \\n'
    + ' Affects Hono.#addRoute — throws at startup SmartRouter.match — falls through Written by your agent');
  assert.doesNotMatch(html, /<script> paths/, 'escaped');
  assert.equal(textOf(buildDetailHtml(row, { result, nonce: NONCE, cspSource: CSP_SOURCE, agentChange: { kind: 'same', what: 'Same result' } })),
    'Holder.bad src/a.ts:10–19 Same behaviour, new way: Same result Written by your agent');
  assert.equal(textOf(buildDetailHtml(row, { result, nonce: NONCE, cspSource: CSP_SOURCE, agentChange: null })), 'Holder.bad src/a.ts:10–19');
});
