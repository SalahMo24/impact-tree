'use strict';
// The detail panel's HTML, built from rows of the real row model: no vscode stub. What a
// reviewer reads is checked as text (tags stripped, entities decoded); the document's
// safety (escaping, CSP, nonces) is checked on the raw HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFileRows, buildImpactRows, treeItemId } = require('../src/review-tree-model');
const { buildDetailHtml, listCallerRows, describeOrigin, tidySignature } = require('../src/detail-panel-html');

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
// Line of an offset, as textpos would give it for these fixtures: one line per 10 characters.
const lineOf = (_file, offset) => Math.floor(offset / 10) + 1;

function render(row, result, { origin = 'tree', isReviewed = () => false, impactRows } = {}) {
  const impact = impactRows ?? (row && row.type === 'finding' ? buildImpactRows(row, { result, uriOf, rel }).rows : []);
  return buildDetailHtml(row, { result, isReviewed, impactRows: impact, nonce: NONCE, cspSource: CSP_SOURCE, origin, lineOf });
}
const rowsOf = (result) => buildFileRows(result, { uriOf, absPath: (p) => `/r/${p}` }).rows;
const findRow = (result, label) => rowsOf(result).flatMap((f) => (f.type === 'reviewFile' ? f.rows : [f])).find((r) => r.label === label || r.finding?.label === label);

test('a change that breaks a caller: level word, sentence, location, signatures, callers with their state, tests, buttons', () => {
  const stale = callerOf('src/user.ts', 'useIt', 300, false);
  const fine = callerOf('src/other.ts', 'alsoUses', 500, true);
  const bad = change('src/a.ts', 'Holder.bad', 10, { kinds: [PARAM], callerState: 'resolved', callers: [stale, fine], staleCallers: 1,
    baseSig: '(a: string) => void', headSig: '(a: string, b: number) => void' });
  const result = resultOf({ allChanged: [bad] });
  const text = textOf(render(findRow(result, 'Holder.bad'), result));
  assert.match(text, /^selected in tree Holder\.bad src\/a\.ts:10–19 /);
  assert.match(text, /Needs attention\. The required parameter changed, and 1 of 2 callers was not changed on the call line\./);
  assert.match(text, /Signature − \(a: string\) => void \+ \(a: string, b: number\) => void/);
  assert.match(text, /Callers \(2\) ✓ alsoUses src\/other\.ts:51 ○ useIt src\/user\.ts:31 not updated Tests/, 'sorted as the tree sorts them, with the call-site line');
  assert.match(text, /Tests Tested by spec\.test\.js/);
  assert.match(text, /Mark reviewed Next unreviewed$/);
});

test('a risky change marks the callers its verdict counts as not updated; a body-only change does not', () => {
  const callers = [
    callerOf('src/a.ts', 'edited', 100, false),
    callerOf('src/b.ts', 'updated', 200, true),
    callerOf('src/c.ts', 'left', 300, false),
    callerOf('test/t.test.ts', 't.test.ts', 0, false, { test: true }),
  ];
  // `edited` is itself a changed symbol, so its call state is "changed, but not at the call"
  const edited = change('src/a.ts', 'edited', 1, { namePos: 100 });
  const risky = change('src/x.ts', 'risky', 10, { kinds: [PARAM], callerState: 'resolved', callers, staleCallers: 2 });
  const result = resultOf({ allChanged: [risky, edited] });
  const text = textOf(render(findRow(result, 'risky'), result));
  assert.match(text, /Needs attention\. .*2 of 4 callers were not changed/);
  assert.match(text, /Callers \(4\) △ edited src\/a\.ts:11 not updated ✓ updated src\/b\.ts:21 ○ left src\/c\.ts:31 not updated ○ 🧪 t\.test\.ts test\/t\.test\.ts:1 Tests/,
    'a test caller is not counted, so it is not marked');
  assert.equal(text.match(/not updated/g).length, 2);
  const body = change('src/x.ts', 'body', 10, { callerState: 'resolved', callers });
  const plain = resultOf({ allChanged: [body, edited] });
  assert.doesNotMatch(textOf(render(findRow(plain, 'body'), plain)), /not updated/, 'unchanged callers are expected after a body-only change');
});

test('signatures are shown without the inferred-type placeholders, and escaped after tidying', () => {
  const c = change('src/a.ts', 'f', 10, { kinds: [PARAM],
    baseSig: 'async ({ owner }: ⟨inferred⟩, a: ⟨inferred⟩) => ⟨inferred⟩', headSig: '(a: ⟨inferred⟩, b: Map<string, number>) => ⟨inferred⟩' });
  const result = resultOf({ allChanged: [c] });
  const html = render(findRow(result, 'f'), result);
  assert.match(textOf(html), /Signature − async \(\{ owner \}, a\) \+ \(a, b: Map<string, number>\) Tests/);
  assert.ok(html.includes('(a, b: Map&lt;string, number&gt;)'), 'escaped after tidying');
  assert.equal(c.headSig, '(a: ⟨inferred⟩, b: Map<string, number>) => ⟨inferred⟩', 'the result is not changed');
  assert.equal(tidySignature('(a: string) => void'), '(a: string) => void', 'a written type stays');
  assert.equal(tidySignature('() => ⟨inferred⟩'), '()');
});

test('each verdict level leads with its word', () => {
  const cases = [
    [change('src/a.ts', 'unknown', 10, { kinds: [THROW], callerState: 'unknown', callersIncompleteReason: 'referenced-as-value' }), 'Risk unknown', 1],
    [change('src/a.ts', 'handled', 10, { kinds: [PARAM], callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, true)] }), 'Risk handled', 2],
    [change('src/a.ts', 'reaches', 10, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)] }), 'Reaches callers', 3],
    [change('src/a.ts', 'quiet', 10), 'Quiet', 4],
  ];
  for (const [c, word, level] of cases) {
    const result = resultOf({ allChanged: [c] });
    const html = render(findRow(result, c.label), result);
    assert.match(textOf(html), new RegExp(`${c.label} src/a\\.ts:10–19 ${word}\\. `), c.label);
    assert.match(html, new RegExp(`class="verdict lv${level}"`), c.label);
    assert.doesNotMatch(textOf(html), /Signature/, 'the signature is shown only when it changed');
  }
});

test('a new throw is listed; an added symbol has no "before" signature to show', () => {
  const thrower = change('src/a.ts', 'thrower', 10, { kinds: [THROW], throwsAdded: ['new Error("bad")'], callerState: 'none', baseSig: null, headSig: '() => void' });
  const result = resultOf({ allChanged: [thrower] });
  const text = textOf(render(findRow(result, 'thrower'), result));
  assert.match(text, /New throw \+ throw new Error\("bad"\)/);
  assert.doesNotMatch(text, /Signature/);
  assert.doesNotMatch(text, /Callers/, 'no callers, no callers section');
});

test('the tests line follows the tests row: not computed, unknown, none within reach, a preview', () => {
  const c = change('src/a.ts', 'f', 10, { testState: 'unknown', testReachIncompleteReason: 'budget hit' });
  const unknown = resultOf({ allChanged: [c] });
  assert.match(textOf(render(findRow(unknown, 'f'), unknown)), /Tests Test reach unknown — budget hit/);
  const notComputed = resultOf({ allChanged: [c], testReachComputed: false });
  assert.match(textOf(render(findRow(notComputed, 'f'), notComputed)), /Tests Compute test reachability/);
  const uncovered = resultOf({ allChanged: [{ ...c, testState: 'uncovered' }] });
  assert.match(textOf(render(findRow(uncovered, 'f'), uncovered)), /Tests No test within 2 caller level\(s\)/);
  const preview = resultOf({ allChanged: [c], tierA: true, testReachComputed: false });
  assert.match(textOf(render(findRow(preview, 'f'), preview)), /Tests Tests are not searched in a PR preview/);
});

test('an unfinished caller search is said under the callers, and a preview says which callers it can see', () => {
  const c = change('src/a.ts', 'f', 10, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)], callersComplete: false,
    callersIncompleteReason: 'the server timed out' });
  const local = resultOf({ allChanged: [c] });
  assert.match(textOf(render(findRow(local, 'f'), local)), /○ u src\/u\.ts:11 More callers may be missing: the server timed out/);
  const preview = resultOf({ allChanged: [c], tierA: true });
  assert.match(textOf(render(findRow(preview, 'f'), preview)), /Callers \(1\) Preview: only callers in the pull request's own files are shown\./);
});

test('callers grouped by file in the tree are listed one by one, test callers marked', () => {
  const callers = [callerOf('src/u.ts', 'one', 100, false), callerOf('src/u.ts', 'two', 200, true), callerOf('test/a.test.ts', 'a.test.ts', 0, false, { test: true })];
  const c = change('src/a.ts', 'f', 10, { callerState: 'resolved', callers });
  const result = resultOf({ allChanged: [c] });
  const row = findRow(result, 'f');
  const impact = buildImpactRows(row, { result, uriOf, rel }).rows;
  assert.equal(impact[0].type, 'callerFile', 'the fixture groups two callers');
  assert.deepEqual(listCallerRows(impact).map((r) => r.label), ['one', 'two', 'a.test.ts']);
  const html = render(row, result);
  assert.match(textOf(html), /Callers \(3\) ○ one src\/u\.ts:11 ✓ two src\/u\.ts:21 ○ 🧪 a\.test\.ts test\/a\.test\.ts:1 /);
  assert.deepEqual([...html.matchAll(/data-act="caller" data-index="(\d+)"/g)].map((m) => m[1]), ['0', '1', '2'], 'each caller is a link');
});

test('a caller whose line cannot be read shows its path alone', () => {
  const c = change('src/a.ts', 'f', 10, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)] });
  const result = resultOf({ allChanged: [c] });
  const row = findRow(result, 'f');
  const html = buildDetailHtml(row, { result, isReviewed: () => false, impactRows: buildImpactRows(row, { result, uriOf, rel }).rows,
    nonce: NONCE, cspSource: CSP_SOURCE, origin: 'tree', lineOf: () => null });
  assert.match(textOf(html), /○ u src\/u\.ts Tests/);
});

test('a reviewed change offers Untick; the tick button says what it will do', () => {
  const c = change('src/a.ts', 'f', 10);
  const result = resultOf({ allChanged: [c] });
  const row = findRow(result, 'f');
  const on = render(row, result, { isReviewed: (r) => r === row });
  assert.match(textOf(on), /Untick Next unreviewed$/);
  const id = treeItemId(row);
  assert.ok(on.includes(`data-act="tick" data-id="${id}" data-on="false"`), 'the button names the row it ticks');
  assert.ok(render(row, result).includes(`data-act="tick" data-id="${id}" data-on="true"`));
});

test('a deleted symbol and an outside row get their shorter content', () => {
  const result = resultOf({
    allChanged: [change('src/a.ts', 'f', 10)],
    deleted: [{ label: 'gone', key: 'gone', relPath: 'src/a.ts', file: '/r/src/a.ts', namePos: 40, startLine: 40 }],
    outside: [{ file: '/r/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 2], [7, 7]] }],
  });
  const gone = textOf(render(findRow(result, 'gone'), result));
  assert.match(gone, /^selected in tree gone src\/a\.ts · deleted This symbol was removed\. Its former callers were not searched/);
  assert.match(gone, /Mark reviewed Next unreviewed$/);
  assert.doesNotMatch(gone, /Callers|Tests/);
  const out = textOf(render(findRow(result, 'Outside functions'), result, { origin: 'cursor:7' }));
  assert.match(out, /^at cursor, line 7 Outside functions src\/a\.ts · lines 1–2, 7 Changed lines that are not inside any function/);
  assert.match(out, /Mark reviewed Next unreviewed$/);
});

test('a file with a call graph: name, path, status, counts, and file-wide buttons', () => {
  const result = resultOf({ allChanged: [
    change('src/a.ts', 'bad', 10, { kinds: [PARAM], callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)], staleCallers: 1 }),
    change('src/a.ts', 'odd', 30, { kinds: [THROW], callerState: 'unknown' }),
    change('src/a.ts', 'quiet', 50),
  ] });
  const [file] = rowsOf(result);
  const quiet = file.rows.find((r) => r.label === 'quiet');
  const text = textOf(render(file, result, { isReviewed: (r) => r.label === quiet.label }));
  assert.match(text, /^selected in tree a\.ts src\/a\.ts · modified 3 changes, 2 need attention, 2 left to review\. Mark file reviewed Next unreviewed$/);
  const all = render(file, result, { isReviewed: () => true });
  assert.match(textOf(all), /0 left to review\. Untick file Next unreviewed$/);
  assert.match(all, /data-act="tick" data-id="file:src\/a\.ts" data-on="false"/);
  const one = resultOf({ allChanged: [change('src/b.ts', 'q', 10)] });
  assert.match(textOf(render(rowsOf(one)[0], one)), /1 change, 0 need attention, 1 left to review\./);
});

test('a file without a call graph says so and can be ticked', () => {
  const result = resultOf({ otherFiles: [{ path: 'docs/notes.md', status: 'added' }] });
  const [file] = rowsOf(result);
  assert.equal(file.type, 'file');
  const text = textOf(render(file, result));
  assert.match(text, /^selected in tree notes\.md docs\/notes\.md · added No call graph for this file \(tests, config, docs\)\. Read the diff and tick the file\. Mark reviewed Next unreviewed$/);
});

test('no row: a short hint, and no buttons', () => {
  const html = render(null, null);
  assert.equal(textOf(html), 'Select a change in the tree, or put the cursor in a changed function.');
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/, ''), /data-act/);
});

test('every value from the result is escaped', () => {
  const evil = '<script>alert("x")</script> & "q" \'s';
  const c = change(`src/${evil}.ts`, evil, 10, {
    kinds: [PARAM], callerState: 'resolved', callersComplete: false, callersIncompleteReason: evil, staleCallers: 1,
    callers: [callerOf(`src/${evil}.ts`, evil, 100, false)], baseSig: `(${evil}) => void`, headSig: `(${evil}, b) => void`,
    throwsAdded: [evil], tests: [evil],
  });
  const result = resultOf({ allChanged: [c], deleted: [{ label: evil, key: evil, relPath: `src/${evil}.ts`, file: '/r/x', namePos: 1, startLine: 1 }] });
  const row = findRow(result, evil);
  const impact = buildImpactRows(row, { result, uriOf, rel }).rows;
  const html = render(row, result, { impactRows: impact });
  assert.equal(html.match(/<script/g).length, 1, 'only the panel\'s own script tag');
  assert.doesNotMatch(html, /alert\("x"\)/, 'a quote is never written raw');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;q&quot; &#39;s'));
  const text = textOf(html);
  for (const where of [`${evil} src/${evil}.ts:10–19`, `− (${evil}) => void`, `+ throw ${evil}`, `Tested by ${evil}`, `: ${evil}`]) {
    assert.ok(text.includes(where), where);
  }
  const files = rowsOf(result);
  for (const r of [files[0], files[0].rows.find((x) => x.type === 'deleted')]) {
    const other = render(r, result);
    assert.equal(other.match(/<script/g).length, 1, r.type);
    assert.ok(textOf(other).includes(`src/${evil}.ts`), r.type);
  }
});

test('the document has a strict CSP, a nonce on every script and style, and nothing remote', () => {
  const c = change('src/a.ts', 'f', 10, { callerState: 'resolved', callers: [callerOf('src/u.ts', 'u', 100, false)] });
  const result = resultOf({ allChanged: [c], otherFiles: [{ path: 'n.md', status: 'added' }] });
  const files = rowsOf(result);
  for (const row of [null, files[0], files[0].rows[0], files[1]]) {
    const html = render(row, result);
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
});

test('colours come only from theme variables', () => {
  const html = render(null, null);
  const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no literal colour');
  assert.match(css, /var\(--vscode-foreground\)/);
  assert.match(css, /var\(--vscode-button-background\)/);
});

test('the page script sends the row id with a tick, and only rewrites the header text on an origin message', () => {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(render(null, null))[1];
  assert.match(script, /type: 'tick', id: el\.getAttribute\('data-id'\)/);
  assert.match(script, /addEventListener\('message'/);
  assert.match(script, /\.textContent = /, 'set as text, never as HTML');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('the header names where the row came from; an unknown origin is a programming error', () => {
  const result = resultOf({ allChanged: [change('src/a.ts', 'f', 10)] });
  const row = findRow(result, 'f');
  assert.match(textOf(render(row, result, { origin: 'cursor:12' })), /^at cursor, line 12 f /);
  assert.equal(describeOrigin('cursor:12'), 'at cursor, line 12');
  assert.equal(describeOrigin('tree'), 'selected in tree');
  assert.throws(() => render(row, result, { origin: 'cursor:' }));
  assert.throws(() => buildDetailHtml(row, { result, isReviewed: () => false, impactRows: [], nonce: 'a"b', cspSource: CSP_SOURCE, origin: 'tree', lineOf }));
});
