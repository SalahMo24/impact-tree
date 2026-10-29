'use strict';
// Feedback drafts in the editor (F1): where the `impactTree.feedback` controller offers a
// box, what "Add feedback" keeps, how drafts are drawn, edited and deleted, and starting a
// draft from the tree or Details. The controller runs against the stubbed comments API and
// a real drafts store over a fake memento; the pull request controller is tested in
// review-comments.test.js and is not touched by this one.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const baseStub = require('./vscode-stub');
const { createCommentsApi } = require('./extension-env');
const { feedbackContextOf, headFilesOf, drawsDrafts, relPathOf, symbolAt, draftThreadSpecs, draftLabel } = require('../src/feedback/feedback-comments-model');
const { createFeedbackComments, COMMANDS, CONTROLLER_ID, CONTROLLER_LABEL } = require('../src/feedback/feedback-comments');
const { createFeedbackDrafts } = require('../src/feedback/feedback-drafts');
const { CONTROLLER_ID: REVIEW_CONTROLLER_ID } = require('../src/diff-editor/review-comments');

const REPO = path.join(os.tmpdir(), 'it-feedback-comments-repo');
const { Uri } = baseStub;
const fileDoc = (rel) => Uri.file(path.join(REPO, rel));
const baseDoc = (rel) => Uri.from({ scheme: 'impacttree-base', path: rel, query: 'c'.repeat(40) });
const prDoc = (rel) => Uri.from({ scheme: 'impacttree-pr', path: rel, query: 'pr=7&side=head' });

// A local result: src/a.ts changed (`run` lines 10–20 holding `inner` 12–14), src/gone.ts
// deleted, notes.md added.
const change = (label, startLine, endLine, relPath = 'src/a.ts') => ({ label, relPath, startLine, endLine });
const localResult = (over = {}) => ({
  mode: 'working', changedPaths: ['src/a.ts', 'src/gone.ts', 'notes.md'],
  fileStatus: { 'src/a.ts': 'modified', 'src/gone.ts': 'deleted', 'notes.md': 'added' },
  allChanged: [change('run', 10, 20), change('inner', 12, 14)], ...over,
});
const LOCAL = { kind: 'local' };

// ---- the pure model ---------------------------------------------------------------------

test('feedback is offered on a result of the files on disk (local or a checked-out pull request), on its files that exist on disk', () => {
  const ctx = feedbackContextOf({ source: LOCAL, result: localResult(), repoRoot: REPO, analysisId: 3 });
  assert.deepEqual([...ctx.files], ['src/a.ts', 'notes.md'], 'a deleted file has no head side');
  assert.equal(ctx.analysisId, 3);
  const none = [
    { source: LOCAL, result: null },
    { source: LOCAL, result: { ...localResult(), tierA: true } },
    { source: { kind: 'pr', pr: { number: 7 } }, result: localResult() },
    { source: undefined, result: localResult() },
  ];
  for (const input of none) assert.equal(feedbackContextOf({ ...input, repoRoot: REPO, analysisId: 1 }), null, JSON.stringify(input.source));
  assert.equal(feedbackContextOf({ source: LOCAL, result: localResult(), repoRoot: null, analysisId: 1 }), null);
  assert.ok(feedbackContextOf({ source: { kind: 'checkout', pr: { number: 7 }, sha: 'a' }, result: localResult({ mode: 'pr' }), repoRoot: REPO, analysisId: 1 }),
    'a checked-out pull request');
  for (const mode of ['working', 'checkpoint', 'branch', 'pr']) {
    assert.ok(feedbackContextOf({ source: LOCAL, result: localResult({ mode }), repoRoot: REPO, analysisId: 1 }), mode);
  }
  assert.deepEqual([...headFilesOf({})], [], 'a result without a file list has no files');
});

test('only a document on disk inside the repository has a path; drafts are drawn in reviews of the files on disk only', () => {
  assert.equal(relPathOf(fileDoc('src/a.ts'), REPO), 'src/a.ts');
  assert.equal(relPathOf(baseDoc('src/a.ts'), REPO), null, 'the base side');
  assert.equal(relPathOf(prDoc('src/a.ts'), REPO), null, 'a pull request document');
  assert.equal(relPathOf(Uri.file(path.join(path.dirname(REPO), 'other.ts')), REPO), null, 'outside the repository');
  assert.equal(drawsDrafts(LOCAL), true);
  assert.equal(drawsDrafts(undefined), true, 'before the first analysis');
  assert.equal(drawsDrafts({ kind: 'pr' }), false);
  assert.equal(drawsDrafts({ kind: 'checkout' }), true, 'a checked-out pull request is on disk');
});

test('the symbol of a line is the innermost change holding it', () => {
  const r = localResult();
  assert.equal(symbolAt(r, 'src/a.ts', 13), 'inner');
  assert.equal(symbolAt(r, 'src/a.ts', 10), 'run');
  assert.equal(symbolAt(r, 'src/a.ts', 20), 'run');
  assert.equal(symbolAt(r, 'src/a.ts', 21), null);
  assert.equal(symbolAt(r, 'notes.md', 12), null, 'another file');
});

test('drafts are drawn on their line, a whole-file draft on line 1, a line past the end on the last', () => {
  const item = (id, line, over = {}) => ({ id, file: 'src/a.ts', line, symbol: null, caller: null, quote: '', body: id, createdAtMs: 1, ...over });
  const specs = draftThreadSpecs([item('b', 30), item('a', 5), item('f', null, { symbol: 'run' }), item('x', 3, { file: 'other.ts' }), item('late', 500)], 'src/a.ts', 100);
  assert.deepEqual(specs.map((s) => [s.id, s.line, s.label]), [
    ['f', 1, 'Feedback · draft · on run'],
    ['a', 5, 'Feedback · draft'],
    ['b', 30, 'Feedback · draft'],
    ['late', 100, 'Feedback · draft (line 500 is past the end of the file)'],
  ]);
  assert.equal(draftLabel({ line: 4, symbol: null, caller: { label: 'use', file: 'b.ts', line: 3 } }), 'Feedback · draft · about caller use (b.ts:3)');
  assert.equal(draftLabel({ line: null, symbol: null, caller: null }), 'Feedback · draft · on the whole file');
});

// ---- the adapter --------------------------------------------------------------------------

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

/** The parts of VS Code the feedback comments use. */
function fakeEditor() {
  const comments = createCommentsApi();
  const commands = new Map();
  const seen = { errors: [], warnings: [], shown: [], inputBoxes: [] };
  const documents = [];
  const handlers = { open: new Set(), close: new Set() };
  const subscribe = (set) => (handler) => { set.add(handler); return { dispose: () => set.delete(handler) }; };
  const answers = { inputBox: undefined };
  const vscode = {
    ...baseStub, Range, comments: comments.api,
    workspace: { textDocuments: documents, onDidOpenTextDocument: subscribe(handlers.open), onDidCloseTextDocument: subscribe(handlers.close) },
    window: {
      showErrorMessage: async (m) => { seen.errors.push(m); },
      showWarningMessage: async (m) => { seen.warnings.push(m); },
      showTextDocument: async (uri, options) => { seen.shown.push([uri.toString(), options.selection.start.line]); },
      showInputBox: async (options) => { seen.inputBoxes.push(options); return answers.inputBox; },
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return { dispose: () => commands.delete(name) }; },
      executeCommand: async () => undefined,
    },
  };
  return {
    vscode, comments, commands, seen, handlers, answers,
    run: (name, ...args) => commands.get(name)(...args),
    /** Opens a document whose line N (1-based) reads `line N`. */
    open(uri, { lineCount = 100, isDirty = false } = {}) {
      const document = { uri, lineCount, isDirty, lineAt: (i) => ({ text: `line ${i + 1}` }) };
      documents.push(document);
      for (const h of handlers.open) h(document);
      return document;
    },
    close(document) {
      documents.splice(documents.indexOf(document), 1);
      for (const h of handlers.close) h(document);
    },
  };
}

function fakeMemento() {
  const values = new Map();
  return { values, get: (k) => values.get(k), update: async (k, v) => { values.set(k, v); } };
}

function setup({ source = LOCAL, result = localResult(), open = [] } = {}) {
  const editor = fakeEditor();
  const drafts = createFeedbackDrafts(fakeMemento(), { now: (() => { let t = 0; return () => ++t; })() });
  const session = { source, result, analysisId: 1 };
  const contextListeners = new Set();
  const docs = open.map((uri) => editor.open(uri));
  const opened = [];
  const holds = { open: null };
  const comments = createFeedbackComments(editor.vscode, {
    drafts, getSession: () => ({ source: session.source, result: session.result }),
    getAnalysisId: () => session.analysisId, isCurrentAnalysis: (id) => id === session.analysisId,
    repoRoot: () => REPO,
    contextEvents: [(listener) => { contextListeners.add(listener); return { dispose: () => contextListeners.delete(listener) }; }],
    openDiff: async (relPath, line) => { opened.push([relPath, line]); if (holds.open) await holds.open; },
  });
  const controller = editor.comments.controllers[0];
  return {
    editor, drafts, session, comments, controller, docs, opened, holds,
    contextChanged() { for (const l of contextListeners) l(); },
    /** A new analysis replaced the result, and the session says so. */
    newResult(next = localResult()) { session.analysisId++; session.result = next; for (const l of contextListeners) l(); },
    threadsOn: (uri) => editor.comments.threadsOn(controller, uri),
    async rangesOf(document) {
      const provider = controller.commentingRangeProvider;
      if (!provider) return null;
      return provider.provideCommentingRanges(document).map((r) => [r.start.line + 1, r.end.line + 1]);
    },
    box: (uri, from, to = from) => editor.comments.startDraft(controller, uri, new Range(from - 1, 0, to - 1, 0)),
    submit: (command, t, text) => editor.comments.submit(editor.run, command, t, text),
  };
}

test('its own controller, labelled and worded for feedback', () => {
  const env = setup();
  assert.equal(env.editor.comments.controllers.length, 1);
  assert.deepEqual([env.controller.id, env.controller.label], [CONTROLLER_ID, CONTROLLER_LABEL]);
  assert.equal(CONTROLLER_LABEL, 'Impact Tree: feedback for your agent');
  assert.notEqual(CONTROLLER_ID, REVIEW_CONTROLLER_ID, 'never the pull request controller');
  assert.deepEqual(env.controller.options, { placeHolder: 'Feedback for the agent (Markdown)', prompt: 'Add feedback' });
});

test('a local result offers its files on disk whole; base sides, pull request documents and other files get nothing', async () => {
  const env = setup();
  assert.deepEqual(await env.rangesOf({ uri: fileDoc('src/a.ts'), lineCount: 40 }), [[1, 40]], 'the whole head side');
  assert.deepEqual(await env.rangesOf({ uri: fileDoc('notes.md'), lineCount: 3 }), [[1, 3]]);
  assert.deepEqual(await env.rangesOf({ uri: fileDoc('src/gone.ts'), lineCount: 3 }), [], 'deleted in this result');
  assert.deepEqual(await env.rangesOf({ uri: fileDoc('src/untouched.ts'), lineCount: 3 }), [], 'not a file of the result');
  assert.deepEqual(await env.rangesOf({ uri: baseDoc('src/a.ts'), lineCount: 40 }), [], 'the base side');
  assert.deepEqual(await env.rangesOf({ uri: prDoc('src/a.ts'), lineCount: 40 }), [], 'a pull request document');
  assert.deepEqual(await env.rangesOf({ uri: fileDoc('src/a.ts'), lineCount: 40, isDirty: true }), [], 'unsaved edits');
});

test('a previewed pull request or no result offers no feedback at all', async () => {
  for (const [source, result] of [[{ kind: 'pr', pr: { number: 7 } }, { tierA: true }], [LOCAL, null]]) {
    const env = setup({ source, result });
    assert.equal(env.controller.commentingRangeProvider, undefined, JSON.stringify(source));
  }
  // A local result appears, then a pull request replaces it: the provider follows.
  const env = setup({ result: null });
  env.newResult();
  assert.ok(env.controller.commentingRangeProvider);
  env.session.source = { kind: 'pr', pr: { number: 7 } };
  env.newResult({ tierA: true });
  assert.equal(env.controller.commentingRangeProvider, undefined);
});

test('Add feedback keeps file, line, symbol and quote, draws the draft and closes the box', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  const box = env.box(fileDoc('src/a.ts'), 13);
  assert.deepEqual(await env.submit(COMMANDS.add, box, 'Do not swallow errors here.'), { sent: true });
  assert.equal(box.disposed, true);
  const [item] = env.drafts.list();
  assert.deepEqual({ ...item, id: undefined, createdAtMs: undefined }, {
    id: undefined, createdAtMs: undefined, file: 'src/a.ts', line: 13, symbol: 'inner', caller: null, quote: 'line 13', body: 'Do not swallow errors here.',
  });
  const [drawn] = env.threadsOn(fileDoc('src/a.ts'));
  assert.equal(drawn.label, 'Feedback · draft');
  assert.equal(drawn.range.start.line, 12);
  assert.equal(drawn.canReply, false);
  assert.equal(drawn.contextValue, 'feedbackDraft');
  assert.equal(drawn.comments[0].body.value, 'Do not swallow errors here.');
  assert.equal(drawn.comments[0].body.isTrusted, false, 'the text is shown, never run');
  assert.equal(drawn.comments[0].contextValue, 'feedbackDraft');
});

test('several lines: the line is the first, the quote holds them (at most 5); outside a change the symbol is null', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  await env.submit(COMMANDS.add, env.box(fileDoc('src/a.ts'), 30, 31), 'two');
  await env.submit(COMMANDS.add, env.box(fileDoc('src/a.ts'), 40, 47), 'eight');
  const [two, eight] = env.drafts.list();
  assert.deepEqual([two.line, two.symbol, two.quote], [30, null, 'line 30\nline 31']);
  assert.deepEqual([eight.line, eight.quote], [40, 'line 40\nline 41\nline 42\nline 43\nline 44…']);
});

test('feedback is refused, keeping the text in the box, where it cannot be kept', async () => {
  const env = setup({ open: [fileDoc('src/a.ts'), fileDoc('src/untouched.ts')] });
  const dirty = env.editor.open(fileDoc('notes.md'), { isDirty: true });
  const cases = [
    [env.box(fileDoc('src/untouched.ts'), 3), /not a file on disk of the review shown/],
    [env.box(dirty.uri, 1), /notes\.md has unsaved changes; save it first/],
  ];
  for (const [box, why] of cases) {
    const result = await env.submit(COMMANDS.add, box, 'text');
    assert.equal(result.sent, false);
    assert.equal(box.input, 'text', 'the text stays in the box');
    assert.match(env.editor.seen.errors.at(-1), why);
  }
  const blank = env.box(fileDoc('src/a.ts'), 3);
  await env.submit(COMMANDS.add, blank, '   ');
  assert.match(env.editor.seen.warnings.at(-1), /write the feedback first/);
  const long = env.box(fileDoc('src/a.ts'), 3);
  assert.equal((await env.submit(COMMANDS.add, long, 'x'.repeat(10001))).sent, false);
  assert.match(env.editor.seen.errors.at(-1), /at most 10,000/);
  assert.equal(env.drafts.list().length, 0);
  // While a pull request is shown, a box left over from the local review cannot add.
  const left = env.box(fileDoc('src/a.ts'), 4);
  env.session.source = { kind: 'pr', pr: { number: 7 } };
  env.newResult({ tierA: true });
  assert.equal((await env.submit(COMMANDS.add, left, 'late')).sent, false);
  assert.match(env.editor.seen.errors.at(-1), /only while a local review or a checked-out pull request is shown/);
});

test('Cancel removes an unsaved box, never a drawn draft', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  await env.submit(COMMANDS.add, env.box(fileDoc('src/a.ts'), 5), 'kept');
  const box = env.box(fileDoc('src/a.ts'), 6);
  await env.editor.run(COMMANDS.cancel, { thread: box, text: 'never mind' });
  assert.equal(box.disposed, true);
  const [drawn] = env.threadsOn(fileDoc('src/a.ts'));
  await env.editor.run(COMMANDS.cancel, drawn);
  assert.equal(drawn.disposed, false);
  assert.equal(env.drafts.list().length, 1);
});

test('drafts are redrawn when they change and when a document opens; an unchanged draft keeps its thread', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  await env.drafts.add({ file: 'src/a.ts', line: 5, symbol: null, caller: null, quote: '', body: 'one' });
  await env.drafts.add({ file: 'notes.md', line: 2, symbol: null, caller: null, quote: '', body: 'two' });
  const [first] = env.threadsOn(fileDoc('src/a.ts'));
  assert.equal(first.range.start.line, 4);
  await env.drafts.add({ file: 'src/a.ts', line: 9, symbol: null, caller: null, quote: '', body: 'three' });
  const now = env.threadsOn(fileDoc('src/a.ts'));
  assert.equal(now.length, 2);
  assert.ok(now.includes(first), 'the unchanged draft kept its thread');
  assert.equal(env.threadsOn(fileDoc('notes.md')).length, 0, 'not open yet');
  const notes = env.editor.open(fileDoc('notes.md'));
  assert.equal(env.threadsOn(fileDoc('notes.md')).length, 1);
  env.editor.close(notes);
  assert.equal(env.threadsOn(fileDoc('notes.md')).length, 0, 'closing a document disposes its threads');
  await env.drafts.remove(env.drafts.list()[0].id);
  assert.equal(first.disposed, true);
});

test('a previewed pull request hides the drafts; a checked-out one or a local review shows them', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  await env.drafts.add({ file: 'src/a.ts', line: 5, symbol: null, caller: null, quote: '', body: 'one' });
  assert.equal(env.threadsOn(fileDoc('src/a.ts')).length, 1);
  env.session.source = { kind: 'checkout', pr: { number: 7 }, sha: 'a' };
  env.newResult(localResult({ mode: 'pr' }));
  assert.equal(env.threadsOn(fileDoc('src/a.ts')).length, 1, 'a checkout is reviewed on disk');
  assert.ok(env.controller.commentingRangeProvider, 'and offers feedback there');
  env.session.source = { kind: 'pr', pr: { number: 7 } };
  env.newResult({ tierA: true });
  assert.equal(env.threadsOn(fileDoc('src/a.ts')).length, 0, 'a Preview is not on disk');
  env.session.source = LOCAL;
  env.newResult();
  assert.equal(env.threadsOn(fileDoc('src/a.ts')).length, 1);
});

test('Edit puts the drawn comment in edit mode; Save keeps the new text; Cancel restores it', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  await env.drafts.add({ file: 'src/a.ts', line: 5, symbol: null, caller: null, quote: '', body: 'old' });
  const [thread] = env.threadsOn(fileDoc('src/a.ts'));
  const comment = thread.comments[0];
  await env.editor.run(COMMANDS.edit, comment);
  assert.equal(thread.comments[0].mode, baseStub.CommentMode.Editing);
  comment.body = 'new text'; // VS Code puts the edited text in the comment's body
  await env.editor.run(COMMANDS.saveEdit, comment);
  assert.equal(env.drafts.list()[0].body, 'new text');
  const [redrawn] = env.threadsOn(fileDoc('src/a.ts'));
  assert.equal(redrawn.comments[0].mode, baseStub.CommentMode.Preview);
  assert.equal(redrawn.comments[0].body.value, 'new text');
  await env.editor.run(COMMANDS.edit, redrawn.comments[0]);
  redrawn.comments[0].body = 'abandoned';
  await env.editor.run(COMMANDS.cancelEdit, redrawn.comments[0]);
  assert.equal(redrawn.comments[0].mode, baseStub.CommentMode.Preview);
  assert.equal(redrawn.comments[0].body.value, 'new text');
  assert.equal(env.drafts.list()[0].body, 'new text');
  // An empty edit is refused and the draft is unchanged.
  await env.editor.run(COMMANDS.edit, redrawn.comments[0]);
  redrawn.comments[0].body = ' ';
  await env.editor.run(COMMANDS.saveEdit, redrawn.comments[0]);
  assert.match(env.editor.seen.errors.at(-1), /could not save this feedback — the feedback is empty/);
  assert.equal(env.drafts.list()[0].body, 'new text');
});

test('Edit from the tree opens the draft\'s line, then edits it there; undrawn, it uses an input box', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  const { item } = await env.drafts.add({ file: 'src/a.ts', line: 5, symbol: null, caller: null, quote: '', body: 'old' });
  const row = { type: 'feedbackDraft', draftId: item.id };
  await env.editor.run(COMMANDS.edit, row);
  assert.deepEqual(env.opened, [['src/a.ts', 5]], 'the review diff at its line');
  assert.equal(env.threadsOn(fileDoc('src/a.ts'))[0].comments[0].mode, baseStub.CommentMode.Editing);
  // A draft on a file that is not open and not in the result: opened as a file, then the input box.
  const other = (await env.drafts.add({ file: 'src/other.ts', line: 7, symbol: null, caller: null, quote: '', body: 'before' })).item;
  env.editor.answers.inputBox = 'after';
  await env.editor.run(COMMANDS.edit, { type: 'feedbackDraft', draftId: other.id });
  assert.deepEqual(env.editor.seen.shown, [[fileDoc('src/other.ts').toString(), 6]]);
  assert.equal(env.editor.seen.inputBoxes[0].value, 'before', 'the box holds the text');
  assert.equal(env.drafts.get(other.id).body, 'after');
});

test('Delete removes the draft, from the comment or from the tree', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  await env.drafts.add({ file: 'src/a.ts', line: 5, symbol: null, caller: null, quote: '', body: 'one' });
  const { item } = await env.drafts.add({ file: 'src/a.ts', line: 6, symbol: null, caller: null, quote: '', body: 'two' });
  const [thread] = env.threadsOn(fileDoc('src/a.ts'));
  await env.editor.run(COMMANDS.remove, thread.comments[0]);
  await env.editor.run(COMMANDS.remove, { type: 'feedbackDraft', draftId: item.id });
  assert.equal(env.drafts.list().length, 0);
  assert.equal(env.threadsOn(fileDoc('src/a.ts')).length, 0);
});

test('a click on a draft opens its line: the review diff for a file of the result, else the file', async () => {
  const env = setup();
  const a = (await env.drafts.add({ file: 'src/a.ts', line: 5, symbol: null, caller: null, quote: '', body: 'one' })).item;
  const b = (await env.drafts.add({ file: 'src/b.ts', line: null, symbol: null, caller: null, quote: '', body: 'two' })).item;
  await env.editor.run(COMMANDS.open, { type: 'feedbackDraft', draftId: a.id });
  await env.editor.run(COMMANDS.open, { type: 'feedbackDraft', draftId: b.id });
  assert.deepEqual(env.opened, [['src/a.ts', 5]]);
  assert.deepEqual(env.editor.seen.shown, [[fileDoc('src/b.ts').toString(), 0]]);
  await env.editor.run(COMMANDS.open, { type: 'feedbackDraft', draftId: 'gone' });
  assert.match(env.editor.seen.warnings.at(-1), /no longer there/);
});

// ---- starting from the tree or Details ----------------------------------------------------

const findingRow = { type: 'finding', finding: { relPath: 'src/a.ts', startLine: 12, endLine: 14 } };
const fileRow = { type: 'reviewFile', relPath: 'src/a.ts' };

test('a change starts a box on its first line; a file on line 1, about the whole file', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  const box = await env.comments.commentOnRow(findingRow);
  assert.deepEqual(env.opened, [['src/a.ts', 12]]);
  assert.equal(box.range.start.line, 11);
  assert.equal(box.canReply, true);
  assert.deepEqual(box.comments, [], 'an empty box: VS Code shows its "Add feedback" button');
  await env.submit(COMMANDS.add, box, 'about inner');
  assert.deepEqual([env.drafts.list()[0].line, env.drafts.list()[0].symbol], [12, 'inner']);

  const whole = await env.comments.commentOnRow(fileRow);
  assert.deepEqual(env.opened.at(-1), ['src/a.ts', null]);
  assert.equal(whole.range.start.line, 0);
  assert.equal(whole.label, 'New feedback · on the whole file');
  await env.submit(COMMANDS.add, whole, 'about the file');
  const fileItem = env.drafts.list()[1];
  assert.deepEqual([fileItem.line, fileItem.symbol, fileItem.quote], [null, null, '']);
});

test('a caller in a file of the result starts a box on its call; any other on the change, naming it', async () => {
  const env = setup({ open: [fileDoc('src/a.ts'), fileDoc('notes.md')] });
  const inResult = await env.comments.commentOnCaller(findingRow, { label: 'useIt', test: false, relPath: 'notes.md', siteLine: 3, callState: 'unchanged' });
  assert.deepEqual(env.opened.at(-1), ['notes.md', 3]);
  assert.match(inResult.label, /about caller useIt \(notes\.md:3\)/);
  await env.submit(COMMANDS.add, inResult, 'update this call');
  const outside = await env.comments.commentOnCaller(findingRow, { label: 'far', test: false, relPath: 'src/far.ts', siteLine: 40, callState: 'unchanged' });
  assert.deepEqual(env.opened.at(-1), ['src/a.ts', 12], 'on the change');
  await env.submit(COMMANDS.add, outside, 'and the far caller');
  const [onCall, onChange] = env.drafts.list();
  assert.deepEqual([onCall.file, onCall.line, onCall.caller], ['notes.md', 3, { label: 'useIt', file: 'notes.md', line: 3 }]);
  assert.deepEqual([onChange.file, onChange.line, onChange.symbol, onChange.caller], ['src/a.ts', 12, 'inner', { label: 'far', file: 'src/far.ts', line: 40 }]);
  const drawn = env.threadsOn(fileDoc('src/a.ts')).find((t) => t.label.includes('far'));
  assert.equal(drawn.label, 'Feedback · draft · about caller far (src/far.ts:40)');
});

test('an obsolete result adds no box: the analysis changed while the diff opened', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  let release;
  env.holds.open = new Promise((r) => { release = r; });
  const starting = env.comments.commentOnRow(findingRow);
  env.newResult();
  release();
  assert.equal(await starting, null);
  assert.equal(env.controller.threads.filter((t) => !t.disposed && t.comments.length === 0).length, 0);
});

test('outside a review of the files on disk nothing is started, and it says why', async () => {
  const env = setup({ source: { kind: 'pr', pr: { number: 7 } }, result: { tierA: true } });
  assert.equal(await env.comments.commentOnRow(findingRow), null);
  assert.match(env.editor.seen.warnings.at(-1), /feedback can be started only while a local review or a checked-out pull request is shown/);
  assert.equal(env.comments.available(), false);
  assert.deepEqual(env.opened, []);
  const local = setup();
  assert.equal(local.comments.available(), true);
  assert.equal(await local.comments.commentOnRow({ type: 'reviewFile', relPath: 'src/gone.ts' }), null);
  assert.match(local.editor.seen.warnings.at(-1), /src\/gone\.ts is not a file on disk/);
});

test('dispose ends the controller, its threads and its commands; a pending start adds nothing', async () => {
  const env = setup({ open: [fileDoc('src/a.ts')] });
  await env.drafts.add({ file: 'src/a.ts', line: 5, symbol: null, caller: null, quote: '', body: 'one' });
  const [thread] = env.threadsOn(fileDoc('src/a.ts'));
  let release;
  env.holds.open = new Promise((r) => { release = r; });
  const starting = env.comments.commentOnRow(findingRow);
  env.comments.dispose();
  release();
  assert.equal(await starting, null);
  assert.equal(thread.disposed, true);
  assert.equal(env.controller.disposed, true);
  assert.equal(env.editor.commands.size, 0);
  await env.drafts.add({ file: 'src/a.ts', line: 6, symbol: null, caller: null, quote: '', body: 'two' });
  assert.equal(env.threadsOn(fileDoc('src/a.ts')).length, 0, 'nothing is drawn after dispose');
});

test('the contributions: comment buttons, comment and tree actions scoped to the feedback controller and rows', () => {
  const { contributes } = require('../package.json');
  const { menus } = contributes;
  const FB = 'commentController == impactTree.feedback';
  const pick = (menu) => menus[menu].filter((m) => m.command.startsWith('impactTree.feedback.')).map((m) => [m.command, m.when]);
  assert.deepEqual(pick('comments/commentThread/context'), [
    [COMMANDS.add, `${FB} && commentThreadIsEmpty`], [COMMANDS.cancel, `${FB} && commentThreadIsEmpty`]]);
  assert.deepEqual(pick('comments/comment/title'), [[COMMANDS.edit, `${FB} && comment == feedbackDraft`], [COMMANDS.remove, `${FB} && comment == feedbackDraft`]]);
  assert.deepEqual(pick('comments/comment/context'), [[COMMANDS.saveEdit, `${FB} && comment == feedbackDraft`], [COMMANDS.cancelEdit, `${FB} && comment == feedbackDraft`]]);
  // The draft commands act on draft rows only (a sent round's rows have their own, F4).
  const draftCommands = new Set(Object.values(COMMANDS));
  for (const m of menus['view/item/context'].filter((x) => draftCommands.has(x.command))) {
    assert.equal(m.when, 'view == impactTree.sources && viewItem == feedbackDraft');
  }
  // Every other comment menu entry still belongs to the pull request controller.
  for (const menu of ['comments/commentThread/context', 'comments/commentThread/title', 'comments/comment/title', 'comments/comment/context']) {
    for (const m of menus[menu] || []) assert.match(m.when, /^commentController == impactTree\.(review|feedback) /, `${menu} ${m.command}`);
  }
  const declared = new Map(contributes.commands.map((c) => [c.command, c]));
  for (const id of [...Object.values(COMMANDS), 'impactTree.feedback.showDrafts']) {
    assert.equal(declared.get(id).category, 'Impact Tree', id);
  }
  assert.equal(declared.get(COMMANDS.add).title, 'Add feedback');
  assert.ok(!declared.has('impactTree.feedback.send'), 'Send feedback comes with F3');
  const palette = new Map(menus.commandPalette.map((m) => [m.command, m.when]));
  for (const id of Object.values(COMMANDS)) assert.equal(palette.get(id), 'false', id);
  assert.equal(palette.get('impactTree.feedback.showDrafts'), 'impactTree.hasFeedbackDrafts');
});
