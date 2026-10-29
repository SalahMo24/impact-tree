'use strict';
// Suggested changes (B2), decided without the editor: the ```suggestion blocks of a comment,
// the block a new suggestion starts with, whether an apply may go ahead, and its edit.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSuggestions, suggestionBlock, applyDecision, linesChanged, suggestionEdit, splitLines, eolOf,
} = require('../src/diff-editor/suggestions');

const texts = (body) => parseSuggestions(body).map((s) => s.text);

test('a suggestion block is parsed to its lines, joined by \\n', () => {
  assert.deepEqual(texts('Try this:\n```suggestion\nconst a = 1;\n```\nthanks'), ['const a = 1;']);
  assert.deepEqual(texts('```suggestion\nfunction f() {\n  return 2;\n}\n```'), ['function f() {\n  return 2;\n}'], 'multi-line');
  assert.deepEqual(texts('```suggestion\r\nline one\r\nline two\r\n```\r\n'), ['line one\nline two'], 'CRLF');
  assert.deepEqual(texts('```suggestion\n```'), [null], 'empty: delete the lines');
  assert.deepEqual(texts('```suggestion\n\n```'), [''], 'one blank line: replace with a blank line');
  assert.deepEqual(texts('  ```suggestion\n    indented\n  ```'), ['  indented'], 'the fence\'s indentation is taken off');
  assert.deepEqual(texts('```suggestion   \nx\n```   '), ['x'], 'spaces around the info string and after the closing fence');
});

test('several suggestions in one comment are each parsed, other code blocks are not', () => {
  const body = 'first\n```suggestion\na\n```\nthen\n```js\nnot = 1;\n```\n```suggestion\nb\nc\n```';
  assert.deepEqual(texts(body), ['a', 'b\nc']);
});

test('a longer fence holds ``` lines; a fence closes only with the same character, at least as long', () => {
  assert.deepEqual(texts('````suggestion\nconst md = `\n```\n`;\n````'), ['const md = `\n```\n`;'], 'four backticks hold three');
  assert.deepEqual(texts('````suggestion\nx\n`````'), ['x'], 'closed by a longer fence');
  assert.deepEqual(texts('~~~suggestion\n```\ny\n~~~'), ['```\ny'], 'tilde fence');
  assert.deepEqual(texts('````md\n```suggestion\nnot a suggestion\n```\n````'), [], 'shown inside another block');
  assert.deepEqual(texts('```suggestion\na\n``` x'), [], 'text after the closing fence does not close it: unclosed');
});

test('an unclosed fence, and info strings that are not exactly "suggestion", are not suggestions', () => {
  assert.deepEqual(texts('```suggestion\nnever closed'), []);
  assert.deepEqual(texts('```suggestion\na\n```\n```suggestion\nunclosed'), ['a'], 'the closed one before it still counts');
  for (const info of ['suggestions', 'Suggestion', 'suggestion js', 'js', '', 'suggest']) {
    assert.deepEqual(texts(`\`\`\`${info}\nx\n\`\`\``), [], JSON.stringify(info));
  }
  assert.deepEqual(texts('    ```suggestion\nx\n    ```'), [], 'four spaces: indented code, not a fence');
  assert.deepEqual(texts('``suggestion\nx\n``'), [], 'two backticks');
  assert.deepEqual(texts('```suggestion`\nx\n```'), [], 'a backtick in a backtick fence\'s info string');
  assert.deepEqual(texts(''), []);
});

test('a new suggestion\'s fence is one longer than any backtick run starting its lines, at least 3', () => {
  assert.equal(suggestionBlock(['const a = 1;']), '```suggestion\nconst a = 1;\n```');
  assert.equal(suggestionBlock(['a', '', 'b']), '```suggestion\na\n\nb\n```');
  assert.equal(suggestionBlock(['```js', 'x', '```']), '````suggestion\n```js\nx\n```\n````');
  assert.equal(suggestionBlock(['  `````']), '``````suggestion\n  `````\n``````');
  assert.equal(suggestionBlock(['const s = `a```b`;']), '```suggestion\nconst s = `a```b`;\n```', 'only a run at the line start can close it');
  for (const lines of [['x'], ['```', '````'], ['~~~', '```ts']]) {
    assert.deepEqual(texts(suggestionBlock(lines)), [lines.join('\n')], `round trip ${JSON.stringify(lines)}`);
  }
});

// ---- apply --------------------------------------------------------------------------------

const C = 'c'.repeat(40), D = 'd'.repeat(40);
const thread = (over = {}) => ({ path: 'src/a.ts', side: 'RIGHT', line: 12, startLine: 10, isOutdated: false, fileLevel: false, ...over });
const B = 'b'.repeat(40);
const origin = (over = {}) => ({ commitOid: B, startLine: 8, line: 10, ...over });
const decide = (over = {}) => applyDecision({ checkout: true, suggestions: [{ text: 'x' }], thread: thread(), commitOid: C, origin: origin(), head: C, targetHead: C, ...over });
const reason = (over) => { const d = decide(over); assert.equal(d.ok, false); return d.reason; };

test('an apply is allowed on a checkout at the suggestion\'s commit, on the thread\'s lines', () => {
  // Written on lines 8–10 of commit B; GitHub has moved it to lines 10–12 of the head C.
  assert.deepEqual(decide(), { ok: true, path: 'src/a.ts', startLine: 10, line: 12, text: 'x', origin: { commitOid: B, startLine: 8, line: 10 } });
  assert.deepEqual(decide({ thread: thread({ startLine: null }), origin: origin({ startLine: null }) }),
    { ok: true, path: 'src/a.ts', startLine: 12, line: 12, text: 'x', origin: { commitOid: B, startLine: 10, line: 10 } }, 'one line');
});

test('each refused apply says why', () => {
  assert.equal(reason({ checkout: false }), 'Check out the pull request to apply a suggestion.');
  assert.equal(reason({ suggestions: [{ text: 'a' }, { text: 'b' }] }), 'This comment has 2 suggestions; apply them on GitHub.');
  assert.equal(reason({ suggestions: [] }), 'This comment has no suggestion.');
  for (const t of [thread({ isOutdated: true, line: null }), thread({ fileLevel: true, line: null }), thread({ side: 'LEFT' }), thread({ line: null })]) {
    assert.equal(reason({ thread: t }), 'This suggestion is on lines that are no longer in the diff.');
  }
  assert.equal(reason({ head: D }), 'The checkout is at ddddddd, not ccccccc, where GitHub places the suggestion.');
  assert.equal(reason({ head: D, commitOid: D }), 'The checkout is at ddddddd, not ccccccc, the head under review.');
  assert.match(reason({ head: null }), /HEAD could not be read/);
  assert.match(reason({ commitOid: null }), /GitHub did not say which commit/);
  for (const o of [origin({ commitOid: null }), origin({ line: null })]) {
    assert.equal(reason({ origin: o }), 'GitHub did not say which lines the suggestion was written on, so it cannot be checked against the checkout.');
  }
  assert.equal(reason({ origin: origin({ startLine: 9 }) }), 'Lines 10–12 of src/a.ts changed since the suggestion was written.', 'a different number of lines');
});

test('a stale apply is refused: the working lines differ from the lines at the commit', () => {
  const plan = { path: 'src/a.ts', startLine: 2, line: 3 };
  const atCommit = ['one', 'two', 'three', 'four'];
  assert.equal(linesChanged(plan, ['one', 'two', 'three', 'four'], atCommit), null);
  assert.equal(linesChanged(plan, ['ONE', 'two', 'three', 'FOUR'], atCommit), null, 'only the commented lines count');
  assert.equal(linesChanged(plan, ['one', 'two', 'THREE', 'four'], atCommit), 'Lines 2–3 of src/a.ts changed since the suggestion was written.');
  assert.equal(linesChanged(plan, ['one', 'two'], atCommit), 'Lines 2–3 of src/a.ts changed since the suggestion was written.', 'the file got shorter');
  assert.equal(linesChanged({ ...plan, startLine: 3 }, ['one', 'two', 'x'], atCommit), 'Line 3 of src/a.ts changed since the suggestion was written.');
  assert.equal(linesChanged(plan, splitLines('one\r\ntwo\r\nthree\r\n'), splitLines('one\ntwo\nthree\n')), null, 'line breaks are not the lines');
});

test('the head\'s lines are compared with the lines the suggestion was written on, which may be numbered differently', () => {
  // Written on lines 2–3 of the original commit; a later commit added a line above them.
  const plan = { path: 'src/a.ts', startLine: 3, line: 4 };
  const original = ['one', 'two', 'three', 'four'];
  assert.equal(linesChanged(plan, ['zero', 'one', 'two', 'three', 'four'], original, 2), null, 'shifted, not changed');
  assert.equal(linesChanged(plan, ['zero', 'one', 'TWO', 'three', 'four'], original, 2), 'Lines 3–4 of src/a.ts changed since the suggestion was written.');
  assert.equal(linesChanged(plan, ['zero', 'one', 'two', 'three'], original, 3), 'Lines 3–4 of src/a.ts changed since the suggestion was written.');
});

/** Applies a TextEdit to text, as VS Code would. */
function applyTo(text, e) {
  const lines = text.split('\n');
  const offset = ({ line, character }) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
  return text.slice(0, offset(e.start)) + e.text + text.slice(offset(e.end));
}
const applied = (text, startLine, line, replacement) => applyTo(text, suggestionEdit(splitLines(text), startLine, line, replacement, eolOf(text)));

test('the edit replaces whole lines and leaves the rest as it was', () => {
  assert.equal(applied('a\nb\nc\nd\n', 2, 3, 'X\nY\nZ'), 'a\nX\nY\nZ\nd\n');
  assert.equal(applied('a\nb\nc', 3, 3, 'C'), 'a\nb\nC', 'the last line, no final line break');
  assert.equal(applied('a\nb\n', 1, 1, null), 'b\n', 'deletion takes the line break');
  assert.equal(applied('a\nb\nc\n', 2, 2, null), 'a\nc\n');
  assert.equal(applied('a\nb\nc', 2, 3, null), 'a', 'deleting the end of a file without a final line break');
  assert.equal(applied('only', 1, 1, null), '');
  assert.equal(applied('a\nb\nc\n', 2, 2, ''), 'a\n\nc\n', 'a blank-line suggestion leaves one blank line');
});

test('a CRLF file keeps CRLF', () => {
  assert.equal(eolOf('a\r\nb'), '\r\n');
  assert.equal(eolOf('a\nb\r\n'), '\n', 'the first line break decides');
  assert.equal(applied('a\r\nb\r\nc\r\n', 2, 2, 'X\nY'), 'a\r\nX\r\nY\r\nc\r\n');
  assert.equal(applied('a\r\nb\r\nc\r\n', 2, 2, null), 'a\r\nc\r\n');
});
