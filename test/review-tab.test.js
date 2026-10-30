'use strict';
// The review tab (U1): its page model (board columns, reading order, chips, changes and their
// context), its document (escaped, no inline style or handler, CSP), and its panel (one tab,
// re-rendered when the diff arrives, messages checked by token and looked up by id).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { reviewTabModel, hunkLines, MAX_HUNK_LINES, MAX_CHIPS } = require('../src/views/review-tab/review-tab-model');
const { buildReviewTabHtml, ATTENTION_WORD } = require('../src/views/review-tab/review-tab-html');
const { createReviewTab, parseMessage } = require('../src/views/review-tab/review-tab-panel');

const hono = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cards', 'hono-1774.json'), 'utf8'));
const byId = (f, id) => [...f.cards.clusters, ...f.cards.sweeps].find((c) => c.id === id);
const everyCardAlone = (f) => [...f.cards.clusters, ...f.cards.sweeps].map((c) => ({ title: `T ${c.id}`, members: [...c.members, ...(c.moved || []).map((m) => m.from)] }));

// A small checkout: save changed its contract and one caller was not updated; run is new.
const SAVE = { label: 'save', relPath: 'src/a.ts', file: '/r/src/a.ts', namePos: 7, startLine: 1, endLine: 3, kinds: [{ id: 'sig', label: 'signature' }],
  callerState: 'resolved', callersComplete: true, staleCallers: 1, stale: [{ label: 'handler' }], throwsAdded: [], testState: 'covered', tests: [],
  callers: [{ label: 'handler', file: '/r/src/b.ts', pos: 30, test: false, callState: 'unchanged', callSites: [{ start: 40, end: 44 }] },
    { label: 'spec', file: '/r/src/a.test.ts', pos: 5, test: true, callState: 'unchanged', callSites: [] }] };
const RUN = { label: 'run', relPath: 'src/c.ts', file: '/r/src/c.ts', namePos: 3, startLine: 4, endLine: 9, kinds: [{ id: 'body', label: 'body' }],
  callerState: 'none', callersComplete: true, staleCallers: 0, stale: [], throwsAdded: [], callers: [], testState: 'covered', tests: [] };
const SMALL = {
  result: { base: { ref: 'origin/main', sha: 'b'.repeat(40) }, allChanged: [SAVE, RUN], deleted: [{ label: 'gone', relPath: 'src/old.ts', namePos: 1 }],
    impactPaths: { 'src/a.ts#7': { entries: [{ type: 'public-api', name: 'save' }, { type: 'http', name: 'POST /save' }] } } },
  cards: { clusters: [{ id: 'K1', label: 'save and 1 related', members: ['src/a.ts#7', 'src/old.ts#1'] }, { id: 'K2', label: 'run', members: ['src/c.ts#3'] }], sweeps: [] },
};
const AGENT = {
  summary: 'Saving <now> rejects empty input.',
  attention: ['src/a.ts#7'],
  changes: [
    { id: 'src/a.ts#7', kind: 'changed', what: 'rejects empty input', before: 'saved anything', after: 'throws on empty', when: 'x is empty', affects: [{ name: 'handler', how: 'throws on save("")' }] },
    { id: 'src/c.ts#3', kind: 'new', what: 'runs the job' },
  ],
  cards: [{ title: 'Run the job', summary: 'A new job runner.', members: ['src/c.ts#3'] }, { title: 'Reject empty saves', summary: 'save checks its input.', reason: 'same feature', members: ['src/a.ts#7', 'src/old.ts#1'] }],
};
const HUNK = `diff --git a/src/a.ts b/src/a.ts\nindex 1..2\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n export function save(x) {\n+  if (!x) throw new Error('empty')\n   write(x)\n }\n`;

test('no agent result: the engine\'s cards, two columns, red and amber changes need attention, a note says what the agent adds', () => {
  const f = hono();
  const m = reviewTabModel({ result: f.result, cards: f.cards, title: 'PR #1774' });
  assert.equal(m.agent, false);
  assert.deepEqual(m.columns.map((c) => c.label), ['Needs your attention', 'Other changes']);
  assert.match(m.note, /Analyse with my agent/);
  assert.equal(m.cards.length, f.cards.clusters.length + f.cards.sweeps.length);
  assert.equal(m.columns.reduce((n, c) => n + c.cards.length, 0), m.cards.length, 'every card in exactly one column');
  for (const c of m.cards) {
    // the tree's one set (G15): red or amber, and a deleted symbol is always amber there
    const flagged = (id) => m.changes[id].verdict.level <= 1 || m.changes[id].deleted;
    assert.equal(c.column, c.changes.some(flagged) ? 'attention' : 'changes', c.title);
    for (const id of c.changes) assert.equal(m.changes[id].attention, flagged(id), id);
    assert.ok(c.changes.every((id, i) => i === 0 || m.changes[id].attention <= m.changes[c.changes[i - 1]].attention), 'attention first');
    assert.ok(c.chips.length <= MAX_CHIPS);
    assert.match(c.sentence, /^\d+ changes? in \d+ files?$/);
  }
  assert.equal(m.cards[0].title, byId(f, 'K1').label, 'engine order');
});

test('with the agent\'s result: its cards in its order, three columns, its summary; changes worst first', () => {
  const f = hono();
  const payload = { summary: 'S', attention: [byId(f, 'K3').members[0]],
    changes: [{ id: byId(f, 'K3').members[0], kind: 'changed', what: 'w' }, { id: byId(f, 'K3').members[1], kind: 'same', what: 's' }, { id: byId(f, 'K5').members[0], kind: 'new', what: 'n' }],
    cards: everyCardAlone(f) };
  const m = reviewTabModel({ result: f.result, cards: f.cards, agentPayload: payload });
  assert.equal(m.agent, true);
  assert.equal(m.summary, 'S');
  assert.equal(m.note, null);
  assert.deepEqual(m.columns.map((c) => c.label), ['Needs your attention', 'Behaviour changes', 'No behaviour change']);
  const k3 = m.cards.find((c) => c.title === 'T K3');
  assert.equal(k3.column, 'attention');
  assert.deepEqual(k3.chips[0], { text: '1 changed', tone: 'warning' });
  assert.ok(k3.chips.slice(1).every((c) => c.tone === 'plain' && /^public API: /.test(c.text)), 'then where it is reached from');
  assert.deepEqual(k3.changes.slice(0, 2), [byId(f, 'K3').members[0], byId(f, 'K3').members[1]], 'changed, then same, then the rest');
  // The attention set is the tree's, with a result too (G15): a change the engine flags is attention beside the agent's own.
  const flaggedInCard = (title) => m.cards.find((c) => c.title === title).changes.some((id) => m.changes[id].verdict.level <= 1 || m.changes[id].deleted);
  assert.equal(m.cards.find((c) => c.title === 'T K5').column, flaggedInCard('T K5') ? 'attention' : 'changes');
  assert.equal(flaggedInCard('T K5'), true, 'K5 holds a change the engine flags, though the agent did not name it');
  assert.equal(m.cards.find((c) => c.title === 'T K6').column, flaggedInCard('T K6') ? 'attention' : 'none');
  assert.ok(m.cards.every((c) => (c.column === 'attention') === c.changes.some((id) => m.changes[id].attention)), 'a card is in the attention column exactly when a change in it needs attention');
  // A result for other cards is not used: back to the engine's.
  assert.equal(reviewTabModel({ result: f.result, cards: f.cards, agentPayload: { cards: [] } }).agent, false);
});

test('a change: kind, line, before/after/when, affects, verdict, hunk, callers with lines and states, entry points', () => {
  const m = reviewTabModel({ ...SMALL, agentPayload: AGENT, hunkOf: (c) => (c.relPath === 'src/a.ts' ? HUNK : null),
    lineAt: (file, pos) => (file === '/r/src/b.ts' ? 3 : null), rel: (f) => f.replace('/r/', '') });
  assert.deepEqual(m.cards.map((c) => [c.n, c.title, c.column]), [[1, 'Run the job', 'changes'], [2, 'Reject empty saves', 'attention']]);
  assert.deepEqual(m.cards[1].chips, [{ text: '1 changed', tone: 'warning' }, { text: '1 caller not updated', tone: 'danger' }, { text: 'public API: save', tone: 'plain' }]);
  assert.equal(m.cards[1].why, 'same feature');
  const save = m.changes['src/a.ts#7'];
  assert.equal(save.attention, true, 'named by the agent');
  assert.equal(m.changes['src/c.ts#3'].attention, false);
  assert.deepEqual([save.kind, save.what, save.before, save.after, save.when], ['changed', 'rejects empty input', 'saved anything', 'throws on empty', 'x is empty']);
  assert.deepEqual(save.affects, [{ name: 'handler', how: 'throws on save("")' }]);
  assert.equal(save.verdict.level, 0);
  assert.deepEqual(save.hunk.lines.map((l) => l.t), ['@', ' ', '+', ' ', ' '], 'file headers dropped');
  assert.deepEqual(save.callers, [{ label: 'handler', file: 'src/b.ts', line: 3, state: 'unchanged', test: false, index: 0 },
    { label: 'spec', file: 'src/a.test.ts', line: null, state: 'unchanged', test: true, index: 1 }]);
  assert.deepEqual(save.entries, ['public API: save', 'http: POST /save']);
  const gone = m.changes['src/old.ts#1'];
  assert.deepEqual([gone.name, gone.deleted, gone.verdict.text, gone.hunk], ['−gone', true, 'deleted', null]);
  assert.equal(m.changes['src/c.ts#3'].hunk, null, 'no diff for it');
});

test('hunk lines: at most the cap, and how many more', () => {
  const long = `@@ -1,40 +1,40 @@\n${Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n')}\n`;
  const h = hunkLines(long);
  assert.equal(h.lines.length, MAX_HUNK_LINES);
  assert.equal(h.more, 51 - MAX_HUNK_LINES);
  assert.equal(hunkLines(''), null);
  assert.equal(hunkLines('diff --git a/x b/x\nindex 1..2\n'), null);
});

test('hunk lines are cut to the function and two lines around it: a new file\'s one hunk starts at the function, not the imports', () => {
  const file = `@@ -0,0 +1,20 @@\n${Array.from({ length: 20 }, (_, i) => `+line ${i + 1}`).join('\n')}\n`;
  const h = hunkLines(file, 10, 12);
  assert.deepEqual(h.lines.map((l) => l.s), ['@@ -0,0 +1,20 @@', '+line 8', '+line 9', '+line 10', '+line 11', '+line 12', '+line 13', '+line 14']);
  // A removed line sits where the new lines are: kept when the new line it precedes is in range.
  const edit = '@@ -5,4 +5,4 @@\n a\n-b\n+B\n c\n d\n';
  assert.deepEqual(hunkLines(edit, 6, 6).lines.map((l) => l.s), ['@@ -5,4 +5,4 @@', ' a', '-b', '+B', ' c', ' d']);
  assert.equal(hunkLines(edit, 100, 101).lines.length, 6, 'no overlap: the whole hunk, not nothing');
});

test('the document: escaped, CSP with a nonce, no inline style or handler, every card and change present', () => {
  const m = reviewTabModel({ ...SMALL, agentPayload: AGENT, title: 'PR #9 <img src=x onerror=alert(1)>', hunkOf: () => HUNK });
  const html = buildReviewTabHtml(m, { nonce: 'bm9uY2U=', cspSource: 'https://webview.test' });
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src https:\/\/webview\.test 'nonce-bm9uY2U='; script-src 'nonce-bm9uY2U=';">/);
  assert.ok(!html.includes('<img src=x'), 'the title is text');
  assert.ok(html.includes('Saving &lt;now&gt; rejects empty input.'));
  assert.ok(!/<[^>]+\sstyle=/.test(html), 'no inline style attribute');
  assert.ok(!/<[^>]+\son[a-z]+=/i.test(html), 'no inline handler');
  for (const c of m.cards) assert.ok(html.includes(`class="card" data-card="${c.id}"`) && html.includes(`class="layer" data-card="${c.id}"`));
  for (const id of Object.keys(m.changes)) assert.ok(html.includes(`class="ctx" data-change="${id}"`), id);
  assert.ok(html.includes('data-act="caller" data-id="src/a.ts#7" data-index="0"'));
  assert.ok(html.includes('data-act="deleted" data-id="src/old.ts#1"'));
  assert.ok(html.includes('<span class="add">+  if (!x) throw new Error(&#39;empty&#39;)</span>'));
  assert.throws(() => buildReviewTabHtml(m, { nonce: 'a"b', cspSource: 'x' }));
});

test('the document reads as one page: cards grouped under their columns, ⚠ only for attention, each fact once, both voices labelled', () => {
  const m = reviewTabModel({ ...SMALL, agentPayload: AGENT, title: 'PR #9', hunkOf: () => HUNK });
  const html = buildReviewTabHtml(m, { nonce: 'bm9uY2U=', cspSource: 'https://webview.test' });
  assert.ok(!html.includes('class="board"') && !html.includes('class="tile'), 'one navigation, not a board and a list');
  assert.match(html, /<nav class="layers"><div class="lbl">Needs your attention · 1<\/div><button class="layer" data-card="c2">/, 'the attention card under its column');
  assert.match(html, /No behaviour change · 0<\/div><div class="muted">None<\/div>/);
  assert.equal((html.match(/Reject empty saves/g) || []).length, 2, 'the card title in the nav and as the heading, nowhere else');
  assert.equal((html.match(/>rejects empty input</g) || []).length, 1, 'the change\'s line on its row only, not again in the context');
  assert.equal((html.match(/⚠/g) || []).length, 3, 'the nav entry, the attention change and the deleted symbol (always flagged, as in the tree); a changed kind is a word');
  assert.ok(html.includes(`⚠ ${ATTENTION_WORD}</span><span class="chip warning" title="Your agent's reading">Changed</span><span class="chip verdict lv0" title="Impact Tree's verdict">`));
  assert.ok(html.includes('<span class="chip" title="Your agent\'s reading">New</span>'));
  assert.ok(html.includes('<h4>Your agent</h4><dl><dt>Before</dt><dd>saved anything</dd>') && html.includes('<h4>Impact Tree</h4><dl><dt>Verdict</dt>'));
  assert.ok(html.includes('<details class="why"><summary>Why these changes are one card</summary><div>same feature</div></details>'));
  assert.ok(html.includes('<details class="diff" open><summary>Diff · 5 lines</summary>'), 'a changed function shows its diff');
  assert.ok(html.includes('<span class="chip">1 change</span><span class="chip">2 cards</span><span class="chip">1 needs your attention</span>'.replace('1 change<', '3 changes<')));
  assert.ok(html.includes('position: sticky'), 'the context follows the scroll');
  const engine = buildReviewTabHtml(reviewTabModel({ ...SMALL, hunkOf: () => HUNK }), { nonce: 'bm9uY2U=', cspSource: 'x' });
  assert.ok(engine.includes(`⚠ ${ATTENTION_WORD}`) && !engine.includes('<h4>Your agent</h4>'), 'without an agent: the engine\'s red change is pointed at, no agent section');
});

test('messages: only from the current page, of a known shape', () => {
  assert.deepEqual(parseMessage({ type: 'open', what: 'change', id: 'a#1', token: 't' }, 't'), { what: 'change', id: 'a#1' });
  assert.deepEqual(parseMessage({ type: 'open', what: 'caller', id: 'a#1', index: 2, token: 't' }, 't'), { what: 'caller', id: 'a#1', index: 2 });
  assert.equal(parseMessage({ type: 'open', what: 'change', id: 'a#1', token: 'old' }, 't'), null);
  assert.equal(parseMessage({ type: 'open', what: 'change', id: 'a#1', token: 't' }, null), null);
  assert.equal(parseMessage({ type: 'open', what: 'caller', id: 'a#1', index: -1, token: 't' }, 't'), null);
  assert.equal(parseMessage({ type: 'open', what: 'run', id: 'a#1', token: 't' }, 't'), null);
  assert.equal(parseMessage({ type: 'other', token: 't' }, 't'), null);
  assert.equal(parseMessage(null, 't'), null);
});

function fakeVscode() {
  const panels = []; const commands = [];
  const vscode = {
    ViewColumn: { Active: -1 },
    window: {
      createWebviewPanel: () => {
        let onMsg = null; let onDispose = null;
        const panel = { webview: { html: '', cspSource: 'https://webview.test', onDidReceiveMessage: (l) => { onMsg = l; return { dispose() {} }; } },
          onDidDispose: (l) => { onDispose = l; return { dispose() {} }; }, reveal: () => { panel.revealed = (panel.revealed || 0) + 1; },
          dispose: () => onDispose && onDispose(), send: (m) => onMsg(m) };
        panels.push(panel);
        return panel;
      },
    },
    commands: { executeCommand: async (...a) => { commands.push(a); } },
  };
  return { vscode, panels, commands };
}

test('the panel: one tab; hunks once the diff arrives; opening a change or caller by id; stale or unknown messages ignored', async () => {
  const { vscode, panels, commands } = fakeVscode();
  let release; const diffDone = new Promise((r) => { release = r; });
  let diffReads = 0;
  const tab = createReviewTab(vscode, {
    getState: () => ({ result: SMALL.result, cards: SMALL.cards, rel: (f) => f.replace('/r/', '') }), agentPayload: () => AGENT,
    repoRoot: () => '/r', log: () => {}, readText: () => 'a\nb\nc\nd\n',
    diffText: async () => { diffReads++; await diffDone; return HUNK; },
  });
  tab.open();
  tab.open();
  assert.equal(panels.length, 1);
  assert.equal(panels[0].revealed, 1);
  assert.ok(!panels[0].webview.html.includes('class="hunk"'), 'no hunk before the diff');
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(panels[0].webview.html.includes('class="hunk"'), 're-rendered with the hunk');
  assert.equal(diffReads, 1, 'one diff per base');
  const token = /'nonce-([^']+)'/.exec(panels[0].webview.html)[1];
  await panels[0].send({ type: 'open', what: 'change', id: 'src/a.ts#7', token });
  await panels[0].send({ type: 'open', what: 'caller', id: 'src/a.ts#7', index: 0, token });
  await panels[0].send({ type: 'open', what: 'deleted', id: 'src/old.ts#1', token });
  await panels[0].send({ type: 'open', what: 'change', id: 'nope#1', token });
  await panels[0].send({ type: 'open', what: 'caller', id: 'src/a.ts#7', index: 9, token });
  await panels[0].send({ type: 'open', what: 'change', id: 'src/a.ts#7', token: 'stale' });
  assert.deepEqual(commands.map((c) => c[0]), ['impactTree.openChange', 'impactTree.openCaller', 'impactTree.openFile']);
  assert.equal(commands[0][1].finding, SAVE);
  assert.equal(commands[1][1], SAVE.callers[0]);
  assert.deepEqual(commands[2][1], { type: 'deleted', relPath: 'src/old.ts', label: 'gone' });
  panels[0].dispose();
  tab.open();
  assert.equal(panels.length, 2, 'a closed tab opens anew');
});

test('the panel says why there is nothing to show', () => {
  const page = (state) => {
    const { vscode, panels } = fakeVscode();
    createReviewTab(vscode, { getState: () => state, agentPayload: () => null, repoRoot: () => null, log: () => {} }).open();
    return panels[0].webview.html;
  };
  assert.match(page(null), /Review a branch or a pull request first/);
  assert.match(page({ result: SMALL.result, cards: null }), /Cards are built when the analysis finishes/);
  assert.match(page({ result: { ...SMALL.result, tierA: true }, cards: SMALL.cards }), /preview: no diffs here/);
});
