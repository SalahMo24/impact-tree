// @ts-check
'use strict';
// validateSubmission (src/engine/agent-results.js): what an agent hands back is checked
// the same way by the MCP server and by the editor. Cards: every change id exactly once;
// callers: real files and lines that mention the function. Pure; files are injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateSubmission, checkEvidence, MAX_CARDS, MAX_CALLERS, MAX_ERRORS } = require('../src/engine/agent-results');

const files = /** @type {Record<string, string>} */ ({
  'src/a.ts': 'export function save(x) {\n  return write(x);\n}\nfunction write(x) {}\n',
  'src/b.ts': 'import { save } from "./a";\nexport function handler() {\n  save(1);\n  // save is documented here\n}\n',
  'src/c.py': 'def run():\n    save(2)  # not a comment-only line\n',
});
const readText = (/** @type {string} */ f) => files[f] ?? null;
const savePos = files['src/a.ts'].indexOf('save');
const result = {
  allChanged: [
    { relPath: 'src/a.ts', namePos: savePos, label: 'save' },
    { relPath: 'src/b.ts', namePos: files['src/b.ts'].indexOf('handler'), label: 'handler' },
  ],
  deleted: [{ relPath: 'src/old.ts', namePos: 3, label: 'gone' }],
};
const [SAVE, HANDLER] = result.allChanged.map((c) => `${c.relPath}#${c.namePos}`);
const cards = {
  clusters: [
    { id: 'K1', members: [SAVE], mirrorMembers: ['dist/a.ts#9'], anchor: SAVE, moved: [{ from: 'src/old.ts#3', to: SAVE }] },
    { id: 'K2', members: [HANDLER], moved: [] },
  ],
  sweeps: [],
};
const ctx = { result, cards, readText };
const cardsOf = (/** @type {any} */ p) => validateSubmission('cards', p, ctx);
const callersOf = (/** @type {any} */ p) => validateSubmission('callers', p, ctx);

test('cards: a complete answer is ok and normalised', () => {
  const r = cardsOf({ summary: '  The PR  ', cards: [
    { title: ' Save ', summary: ' s ', members: [SAVE, 'dist/a.ts#9', 'src/old.ts#3'], reason: ' r ' },
    { title: 'Handler', members: [HANDLER] },
  ] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.normalised, { summary: 'The PR', cards: [
    { title: 'Save', summary: 's', reason: 'r', members: [SAVE, 'dist/a.ts#9', 'src/old.ts#3'] },
    { title: 'Handler', members: [HANDLER] },
  ] });
});

test('cards: merges and splits are expressed by the members lists', () => {
  assert.equal(cardsOf({ cards: [{ title: 'Both', members: [SAVE, HANDLER], reason: 'merged K1 and K2' }] }).ok, true);
  assert.equal(cardsOf({ cards: [{ title: 'A', members: [SAVE] }, { title: 'B', members: [HANDLER] }] }).ok, true);
});

test('cards: every error kind, with its message', () => {
  assert.deepEqual(cardsOf({}).errors, ['answer.cards must be an array']);
  assert.deepEqual(cardsOf(null).errors, ['answer.cards must be an array']);
  const bad = cardsOf({ cards: [{ title: ' ', members: [SAVE, 'zzz#1'] }, { title: 'B', members: [SAVE, 3] }, 'x', { title: 'C', members: [] }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.normalised, undefined);
  assert.deepEqual(bad.errors, [
    'cards[0]: empty title',
    'cards[0]: unknown id "zzz#1"',
    'cards[1]: unknown id 3',
    'cards[2] is not an object',
    'cards[3]: members must be a non-empty array of change ids',
    `${SAVE} is in more than one card: cards[0], cards[1]`,
    `1 change id(s) in no card: ${HANDLER}`,
  ]);
  assert.match(cardsOf({ cards: [{ title: 'A', members: [SAVE, SAVE, HANDLER] }] }).errors[0], /listed twice in the same card/);
  assert.match(cardsOf({ cards: [{ title: 'x'.repeat(201), members: [SAVE, HANDLER] }] }).errors[0], /title is longer than 200/);
  assert.match(cardsOf({ cards: [{ title: 'A', summary: 5, members: [SAVE, HANDLER] }] }).errors[0], /summary must be a string/);
  assert.match(cardsOf({ summary: 'x'.repeat(2001), cards: [{ title: 'A', members: [SAVE, HANDLER] }] }).errors[0], /answer\.summary is longer than 2000/);
});

test('cards: an alias counts as its card, and an alias of an already placed card is not a second placement', () => {
  // The mirror and the moved id are in K1's card with SAVE; listing them elsewhere is a second placement.
  const r = cardsOf({ cards: [{ title: 'A', members: [SAVE, HANDLER] }, { title: 'B', members: ['dist/a.ts#9'] }] });
  assert.deepEqual(r.errors, [`${SAVE} is in more than one card: cards[0], cards[1]`]);
});

test('cards: bounds', () => {
  const many = cardsOf({ cards: Array.from({ length: MAX_CARDS + 1 }, () => ({ title: 'x', members: [SAVE] })) });
  assert.equal(many.ok, false);
  assert.match(many.errors[0], /at most 2000/);
  const exact = cardsOf({ cards: Array.from({ length: MAX_CARDS }, () => ({ title: 'x', members: [SAVE] })) });
  assert.match(exact.errors.join('|'), /more than one card/, 'exactly the limit is looked at, not refused for its size');
  const noisy = cardsOf({ cards: Array.from({ length: MAX_ERRORS + 10 }, () => ({ title: '', members: [SAVE, HANDLER] })) });
  assert.equal(noisy.errors.length, MAX_ERRORS + 1);
  assert.match(noisy.errors[MAX_ERRORS], /and \d+ more error/);
});

test('callers: by change id or by file, line and name; the normalised form names both', () => {
  const caller = { file: 'src/b.ts', line: 3, name: 'handler', note: ' direct ' };
  const byId = callersOf({ function: SAVE, callers: [caller] });
  assert.equal(byId.ok, true, byId.errors.join('; '));
  assert.deepEqual(byId.normalised, { function: { id: SAVE, file: 'src/a.ts', line: 1, name: 'save' }, callers: [{ file: 'src/b.ts', line: 3, kind: 'call', name: 'handler', note: 'direct' }] });
  const byLoc = callersOf({ function: { file: 'src/a.ts', line: 1, name: 'save' }, callers: [{ file: 'src/b.ts', line: 3, kind: 'registration' }] });
  assert.equal(byLoc.ok, true);
  assert.deepEqual(byLoc.normalised.function, { file: 'src/a.ts', line: 1, name: 'save' });
  assert.equal(byLoc.normalised.callers[0].kind, 'registration');
  assert.equal(callersOf({ function: SAVE, callers: [] }).ok, true, 'no callers found is a valid answer');
});

test('callers: the function must exist', () => {
  assert.deepEqual(callersOf({ function: 'src/a.ts#999', callers: [] }).errors, ['function: unknown change id "src/a.ts#999"']);
  assert.match(callersOf({ function: 'src/old.ts#3', callers: [] }).errors[0], /deleted function/);
  assert.deepEqual(callersOf({ function: { file: 'src/a.ts', line: 2, name: 'save' }, callers: [] }).errors, ['function: save is not on line 2 of src/a.ts']);
  assert.deepEqual(callersOf({ function: { file: 'src/none.ts', line: 1, name: 'save' }, callers: [] }).errors, ['function.file src/none.ts does not exist at the analysed head']);
  assert.deepEqual(callersOf({ function: { file: 'src/a.ts', line: 50, name: 'save' }, callers: [] }).errors, ['function.line: src/a.ts has 5 lines']);
  assert.match(callersOf({ function: { file: '../a.ts', line: 1, name: 'save' }, callers: [] }).errors[0], /repository-relative/);
  assert.match(callersOf({ function: { file: 'src/a.ts', line: 0, name: 'save' }, callers: [] }).errors[0], /function\.line/);
  assert.match(callersOf({ function: { file: 'src/a.ts', line: 1, name: 'a b' }, callers: [] }).errors[0], /single identifier/);
  assert.match(callersOf({ function: 5, callers: [] }).errors[0], /change id or/);
  assert.deepEqual(callersOf({ function: SAVE }).errors, ['answer.callers must be an array']);
});

test('callers: each caller needs a path that exists and a line that mentions the function', () => {
  const r = callersOf({ function: SAVE, callers: [
    { file: 'src/b.ts', line: 3 },
    { file: '/etc/passwd', line: 1 },
    { file: 'src/b.ts', line: 0 },
    { file: 'src/b.ts', line: 3.5 },
    { file: 'src/b.ts', line: 3, kind: 'jump' },
    { file: 'src/none.ts', line: 1 },
    { file: 'src/b.ts', line: 400 },
    { file: 'src/a.ts', line: 3 },
    { file: 'src/b.ts', line: 3, note: 7 },
    null,
  ] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    'callers[1].file must be a repository-relative path',
    'callers[2].line must be an integer from 1 to 10000000',
    'callers[3].line must be an integer from 1 to 10000000',
    'callers[4].kind must be one of call, registration, reference',
    'callers[5]: src/none.ts does not exist at the analysed head',
    'callers[6]: src/b.ts has 6 lines, so line 400 does not exist',
    'callers[7]: save is not mentioned on line 3 of src/a.ts (lines 2-4 read)',
    'callers[8].note must be a string',
    'callers[9] is not an object',
  ]);
});

test('callers: a comment-only line is not evidence, a trailing comment does not hide the call', () => {
  const one = (/** @type {number} */ line) => callersOf({ function: SAVE, callers: [{ file: 'src/b.ts', line }] });
  assert.equal(one(4).ok, true, 'line 4 is a comment, but line 3 next to it calls save');
  assert.equal(one(5).ok, false, 'lines 4 and 5 are a comment and a brace: the comment does not count');
  const py = validateSubmission('callers', { function: SAVE, callers: [{ file: 'src/c.py', line: 2 }] }, ctx);
  assert.equal(py.ok, true, 'code before a trailing # comment still counts');
});

test('callers: duplicates are removed and the list is bounded', () => {
  const dup = callersOf({ function: SAVE, callers: [{ file: 'src/b.ts', line: 3 }, { file: 'src/b.ts', line: 3, name: 'again' }] });
  assert.equal(dup.normalised.callers.length, 1);
  const tooMany = callersOf({ function: SAVE, callers: Array.from({ length: MAX_CALLERS + 1 }, () => ({ file: 'src/b.ts', line: 3 })) });
  assert.match(tooMany.errors[0], /at most 500/);
  assert.equal(callersOf({ function: SAVE, callers: Array.from({ length: MAX_CALLERS }, () => ({ file: 'src/b.ts', line: 3 })) }).ok, true);
});

test('callers read each file once however many callers name it', () => {
  let reads = 0;
  const counting = { ...ctx, readText: (/** @type {string} */ f) => { reads++; return readText(f); } };
  const r = validateSubmission('callers', { function: SAVE, callers: [{ file: 'src/b.ts', line: 3 }, { file: 'src/b.ts', line: 2 }, { file: 'src/b.ts', line: 4 }] }, counting);
  assert.equal(r.ok, true);
  assert.equal(reads, 2, 'src/a.ts for the function, src/b.ts once');
});

test('callers without readText read from repo on disk; with neither it is a programming error', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-agent-results-')));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
    const r = validateSubmission('callers', { function: SAVE, callers: [{ file: 'src/b.ts', line: 3 }] }, { result, cards, repo: dir });
    assert.equal(r.ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => validateSubmission('callers', { function: SAVE, callers: [] }, { result, cards }), TypeError);
  assert.throws(() => validateSubmission(/** @type {any} */ ('other'), {}, ctx), /unknown submission kind/);
});

test('checkEvidence: the rule check_evidence and callers share', () => {
  const e = checkEvidence({ text: files['src/b.ts'], file: 'src/b.ts', line: 3, callee: 'save' });
  assert.deepEqual([e.ok, e.call, e.complete], [true, true, true]);
  assert.match(e.text, /^2: export function handler/);
  const ref = checkEvidence({ text: 'const f = save;\n', file: 'x.ts', line: 1, callee: 'save' });
  assert.deepEqual([ref.ok, ref.call], [true, false], 'a reference is evidence, but not a call');
  assert.equal(checkEvidence({ text: 'savedata(1)\n', file: 'x.ts', line: 1, callee: 'save' }).ok, false, 'whole words only');
  assert.equal(checkEvidence({ text: 'a\n', file: 'x.ts', line: 1, callee: 'a.b' }).ok, false, 'the callee is an identifier');
});
