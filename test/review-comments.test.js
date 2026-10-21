'use strict';
// Threads in the review diff (L4): which documents are
// a side of the pull request under review, what the drawn threads say and allow, and what
// each comment button sends, through the stubbed comments API. The store is a fake whose
// answers each test sets, except in the end-to-end tests, which run the real store over a
// GitHub client that answers at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const baseStub = require('./vscode-stub');
const { createCommentsApi, withEnv, overviewAnswer } = require('./extension-env');
const {
  commentingContextOf, documentSide, commentableLines, acceptsComment, threadSpecsFor,
  rowCommentPlace, chooseCommentLine, callerContextBlock, withCallerContext, callerDraftLabel,
} = require('../src/review-comments-model');
const {
  createReviewComments, CommentNotSentError, COMMANDS, PENDING_CONTEXT_KEY, SUGGEST_CONTEXT_KEY, CONTROLLER_ID, FILE_COMMENT_LABEL, SUGGESTION_DRAFT,
} = require('../src/review-comments');
const { createPullRequestReviewStore, reviewDataOf: reviewDataOfStore } = require('../src/pr-review-store');
const { prQuery } = require('../src/pr-documents');

const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const REPO = path.join(os.tmpdir(), 'it-review-comments-repo');
const TARGET = Object.freeze({ owner: 'o', name: 'r', number: 7, headOid: HEAD });
const { Uri } = baseStub;

// ---- fixtures ---------------------------------------------------------------------------

// A pull request preview of #7 at HEAD whose diff of src/a.ts shows base lines 8-14 and
// head lines 10-17 and 40-46.
const DIFF = { 'src/a.ts': { left: [[8, 14]], right: [[10, 17], [40, 46]] }, 'src/b.ts': { left: [], right: [[1, 30]] } };
const previewResult = (over = {}) => ({ tierA: true, prNumber: 7, headSha: HEAD, base: { sha: BASE }, diffLines: DIFF, ...over });
const prSource = (headSha = HEAD) => ({ kind: 'pr', pr: { number: 7, headSha } });
const prDoc = (relPath, side, result = previewResult()) => Uri.from({ scheme: 'impacttree-pr', path: relPath,
  query: prQuery(result, side, { path: relPath, status: 'modified' }) });
// A checkout of #7 at HEAD whose base side of the renamed src/a.ts was src/old.ts.
const checkoutResult = (over = {}) => ({ mode: 'pr', base: { sha: BASE }, basePaths: { 'src/a.ts': 'src/old.ts' }, diffLines: DIFF, ...over });
const checkoutSource = (sha = HEAD) => ({ kind: 'checkout', pr: { number: 7 }, sha });
const fileDoc = (relPath) => Uri.file(path.join(REPO, relPath));
const baseDoc = (basePath, sha = BASE) => Uri.from({ scheme: 'impacttree-base', path: basePath, query: sha });

const comment = (id, over = {}) => ({ id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', pending: false, mine: false, canEdit: false, url: `https://x/${id}`, commitOid: null, ...over });
const thread = (id, over = {}, comments = [comment(id)]) => ({ id: `T_${id}`, path: 'src/a.ts', side: 'RIGHT', line: 12,
  originalLine: 12, startLine: null, isResolved: false, isOutdated: false, fileLevel: false,
  canResolve: true, canUnresolve: false, canReply: true, comments, ...over });
const reviewModel = ({ threads = [], pending = null } = {}) => ({
  pr: { id: 'PR_7', number: 7, title: 't', body: '', url: '', state: 'OPEN', author: null, viewerDidAuthor: false,
    headRefOid: HEAD, baseRefOid: BASE, headRefName: 'f', baseRefName: 'main' },
  threads, pendingReview: pending, viewed: new Map(), timeline: [], overview: { kind: 'failed', error: new Error('not loaded in this test') }, incomplete: [],
});
const PENDING = { id: 'R_1', databaseId: 1, commentCount: 1 };
const ready = (m) => ({ kind: 'ready', target: TARGET, model: m });

// ---- which document is which side ------------------------------------------------------

const prContext = (result = previewResult()) => commentingContextOf({ target: TARGET, source: prSource(), result, head: null, repoRoot: '' });
const checkoutContext = (result = checkoutResult()) => commentingContextOf({ target: TARGET, source: checkoutSource(), result, head: HEAD, repoRoot: REPO });

test('a preview\'s head and base documents are the RIGHT and LEFT sides of their file', () => {
  const ctx = prContext();
  assert.deepEqual(documentSide(prDoc('src/a.ts', 'head'), ctx), { path: 'src/a.ts', side: 'RIGHT', exact: true });
  assert.deepEqual(documentSide(prDoc('src/a.ts', 'base'), ctx), { path: 'src/a.ts', side: 'LEFT', exact: true });
  const elsewhere = [
    prDoc('src/a.ts', 'head', previewResult({ headSha: OTHER_HEAD })),
    prDoc('src/a.ts', 'head', previewResult({ prNumber: 8 })),
    fileDoc('src/a.ts'),
    baseDoc('src/a.ts'),
  ];
  for (const uri of elsewhere) assert.equal(documentSide(uri, ctx), null, uri.toString());
  const otherBase = prDoc('src/a.ts', 'head', previewResult({ base: { sha: 'd'.repeat(40) } }));
  assert.equal(documentSide(otherBase, ctx).exact, false, 'the same head against another merge base: threads, but not this result\'s lines');
});

test('a checkout\'s files are the RIGHT side and its base documents the LEFT side, under the head path', () => {
  const ctx = checkoutContext();
  assert.deepEqual(documentSide(fileDoc('src/a.ts'), ctx), { path: 'src/a.ts', side: 'RIGHT', exact: true });
  assert.deepEqual(documentSide(baseDoc('src/old.ts'), ctx), { path: 'src/a.ts', side: 'LEFT', exact: true }, 'renamed: GitHub names it by its new path');
  assert.deepEqual(documentSide(baseDoc('src/b.ts'), ctx), { path: 'src/b.ts', side: 'LEFT', exact: true });
  for (const uri of [baseDoc('src/b.ts', 'd'.repeat(40)), Uri.file(path.join(path.dirname(REPO), 'elsewhere.ts')), prDoc('src/a.ts', 'head')]) {
    assert.equal(documentSide(uri, ctx), null, uri.toString());
  }
});

test('there is no context for a local review, another pull request, or a checkout whose HEAD moved', () => {
  const base = { target: TARGET, result: checkoutResult(), head: HEAD, repoRoot: REPO };
  assert.equal(commentingContextOf({ ...base, source: { kind: 'local' } }), null);
  assert.equal(commentingContextOf({ ...base, target: null, source: checkoutSource() }), null);
  assert.equal(commentingContextOf({ ...base, source: { kind: 'checkout', pr: { number: 8 }, sha: HEAD } }), null);
  assert.equal(commentingContextOf({ ...base, source: checkoutSource(OTHER_HEAD) }), null);
  assert.equal(commentingContextOf({ ...base, source: checkoutSource(), head: OTHER_HEAD }), null, 'the worktree is on another commit');
  assert.equal(commentingContextOf({ ...base, source: checkoutSource(), head: null }), null, 'HEAD could not be read');
  assert.equal(commentingContextOf({ ...base, source: prSource(OTHER_HEAD), result: previewResult() }), null);
  const dirty = commentingContextOf({ ...base, source: checkoutSource(), result: checkoutResult({ mode: 'branch' }) });
  assert.equal(dirty.diffLines, null, 'a dirty worktree fell back to branch mode: its diff is not GitHub\'s');
});

test('commenting is offered on the diff\'s lines of the document\'s side, within the document', () => {
  const ctx = prContext();
  const right = documentSide(prDoc('src/a.ts', 'head'), ctx);
  const left = documentSide(prDoc('src/a.ts', 'base'), ctx);
  assert.deepEqual(commentableLines(ctx, right, 100), [[10, 17], [40, 46]]);
  assert.deepEqual(commentableLines(ctx, left, 100), [[8, 14]]);
  assert.deepEqual(commentableLines(ctx, right, 44), [[10, 17], [40, 44]], 'clipped to the document');
  assert.deepEqual(commentableLines(ctx, { path: 'src/none.ts', side: 'RIGHT', exact: true }, 100), [], 'a file with no hunks');
  assert.deepEqual(commentableLines(ctx, { ...right, exact: false }, 100), [], 'another revision');
  assert.equal(acceptsComment(ctx, right, 10, 10), true);
  assert.equal(acceptsComment(ctx, right, 17, 17), true);
  assert.equal(acceptsComment(ctx, right, 9, 9), false);
  assert.equal(acceptsComment(ctx, right, 18, 18), false);
  assert.equal(acceptsComment(ctx, right, 12, 16), true, 'several lines of one hunk');
  assert.equal(acceptsComment(ctx, right, 16, 40), false, 'across two hunks');
  assert.equal(acceptsComment(ctx, left, 15, 15), false);
});

test('a drawn thread says its status and offers what GitHub allows the viewer', () => {
  const m = reviewModel({ threads: [
    thread(1),
    thread(2, { line: 15, isResolved: true, canUnresolve: true, canResolve: false }),
    thread(3, { line: 11 }, [comment(3, { pending: true, mine: true })]),
    thread(4, { line: 16, canReply: false, canResolve: false }, [comment(4), comment(5, { pending: true, mine: true, author: null })]),
    thread(6, { isOutdated: true, line: null }),
    thread(7, { fileLevel: true, line: null }),
    thread(8, { side: 'LEFT', line: 9 }),
    thread(9, { path: 'src/b.ts' }),
  ] });
  const specs = threadSpecsFor(m, 'src/a.ts', 'RIGHT');
  assert.deepEqual(specs.map((s) => [s.id, s.line, s.label, s.contextValue, s.canReply, s.resolved]), [
    ['T_3', 11, 'Pending', '', false, false],
    ['T_1', 12, 'Unresolved', 'canReply canResolve', true, false],
    ['T_2', 15, 'Resolved', 'canReply canUnresolve', true, true],
    ['T_4', 16, 'Unresolved', '', false, false],
  ], 'outdated, file-level, LEFT and other files\' threads are not drawn here');
  assert.deepEqual(specs[3].comments.map((c) => [c.author, c.pending, c.contextValue]), [['bob', false, ''], ['ghost', true, 'pendingMine']]);
  assert.deepEqual(threadSpecsFor(m, 'src/a.ts', 'LEFT').map((s) => s.id), ['T_8']);
  const multi = threadSpecsFor(reviewModel({ threads: [thread(1, { startLine: 10, line: 12 })] }), 'src/a.ts', 'RIGHT')[0];
  assert.deepEqual([multi.startLine, multi.line], [10, 12]);
});

// ---- the adapter, against a fake store --------------------------------------------------

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

/** The parts of VS Code the review comments use: comments, documents, messages, commands. */
function fakeEditor() {
  const comments = createCommentsApi();
  const commands = new Map();
  const seen = { errors: [], warnings: [], infos: [], contexts: {}, shown: [] };
  const documents = [];
  // Files on disk by URI string, which openTextDocument opens.
  const disk = new Map();
  const handlers = { open: new Set(), close: new Set(), active: new Set() };
  const subscribe = (set) => (handler) => { set.add(handler); return { dispose: () => set.delete(handler) }; };
  const makeDocument = (uri, { lineCount, isDirty = false, text = '' } = {}) => ({
    uri, lineCount: lineCount === undefined ? text.split(/\r\n|\n/).length : lineCount, isDirty, text, version: 1,
    getText() { return this.text; },
  });
  const open = (uri, options) => {
    const document = makeDocument(uri, options);
    documents.push(document);
    for (const h of handlers.open) h(document);
    return document;
  };
  // A WorkspaceEdit applied as VS Code does: positions are 0-based lines and characters.
  const applyEdit = async (edit) => {
    for (const { uri, range, newText } of edit.edits) {
      const document = documents.find((d) => d.uri.toString() === uri.toString());
      if (!document) return false;
      const lines = document.text.split('\n');
      const offset = ({ line, character }) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
      document.text = document.text.slice(0, offset(range.start)) + newText + document.text.slice(offset(range.end));
      document.version++;
      document.isDirty = true;
    }
    seen.edits = (seen.edits || 0) + 1;
    return true;
  };
  const vscode = {
    ...baseStub, Range, comments: comments.api,
    workspace: { textDocuments: documents, onDidOpenTextDocument: subscribe(handlers.open), onDidCloseTextDocument: subscribe(handlers.close),
      openTextDocument: async (uri) => {
        const existing = documents.find((d) => d.uri.toString() === uri.toString());
        if (existing) return existing;
        if (!disk.has(uri.toString())) throw new Error('file not found');
        return open(uri, { text: disk.get(uri.toString()) });
      },
      applyEdit: (edit) => applyEdit(edit),
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: subscribe(handlers.active),
      showErrorMessage: async (m) => { seen.errors.push(m); },
      showWarningMessage: async (m) => { seen.warnings.push(m); },
      showInformationMessage: async (m) => { seen.infos.push(m); },
      showTextDocument: async (document) => { seen.shown.push(document.uri.toString()); },
    },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return { dispose: () => commands.delete(name) }; },
      executeCommand: async (name, key, value) => { if (name === 'setContext') seen.contexts[key] = value; },
    },
  };
  return {
    vscode, comments, commands, seen, handlers, disk,
    run: (name, ...args) => commands.get(name)(...args),
    open: (uri, { lineCount = 100, isDirty = false, text } = {}) => open(uri, { lineCount: text === undefined ? lineCount : undefined, isDirty, text }),
    /** Makes `document` the active editor, with 1-based lines `from`..`to` selected (to the end of `to`). */
    activate(document, from = 1, to = from, { endCharacter = 1 } = {}) {
      vscode.window.activeTextEditor = { document, selection: { start: { line: from - 1, character: 0 }, end: { line: to - 1, character: endCharacter } } };
      for (const h of handlers.active) h(vscode.window.activeTextEditor);
    },
    close(document) {
      documents.splice(documents.indexOf(document), 1);
      for (const h of handlers.close) h(document);
    },
  };
}

/**
 * A store that holds the state a test gives it. Each mutation is recorded and answers with
 * the next answer queued for it (a result, or a function of the input), else `{ ok: true }`.
 */
function fakeStore(initial) {
  let state = initial;
  const listeners = new Set();
  const calls = [];
  const answers = {};
  const mutation = (name) => async (input) => {
    calls.push({ name, input });
    const answer = (answers[name] || []).shift();
    return typeof answer === 'function' ? answer(input) : answer || { ok: true };
  };
  return {
    calls, answers,
    getState: () => state,
    onDidChange(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    publish(next, paths = null) { state = next; for (const l of [...listeners]) l({ paths }); },
    listenerCount: () => listeners.size,
    addComment: mutation('addComment'), addFileComment: mutation('addFileComment'), reply: mutation('reply'), setResolved: mutation('setResolved'),
    deletePendingComment: mutation('deletePendingComment'), editComment: mutation('editComment'),
  };
}

function setup({ state = ready(reviewModel({ threads: [thread(1)] })), source = prSource(), result = previewResult(), head = HEAD, open = [], atCommit = {} } = {}) {
  const editor = fakeEditor();
  const store = fakeStore(state);
  const session = { source, result };
  const heads = { value: head, reads: 0 };
  const contextListeners = new Set();
  const docs = open.map((uri) => editor.open(uri));
  // The review diffs opened to start a comment, as (path, line).
  const opened = [];
  const failures = { open: null };
  const reads = [];
  const comments = createReviewComments(editor.vscode, {
    store, getSession: () => session, repoRoot: () => REPO,
    readHead: async () => { heads.reads++; return heads.value; },
    contextEvents: [(listener) => { contextListeners.add(listener); return { dispose: () => contextListeners.delete(listener) }; }],
    headUri: (relPath) => (session.source.kind === 'checkout' ? fileDoc(relPath) : prDoc(relPath, 'head', session.result)),
    openDiff: async (relPath, line) => { if (failures.open) throw failures.open; opened.push([relPath, line]); },
    // Files at a commit, by `${oid}:${relPath}`.
    readAtCommit: async (oid, relPath) => { reads.push([oid, relPath]); return atCommit[`${oid}:${relPath}`] ?? null; },
  });
  const controller = editor.comments.controllers[0];
  return {
    editor, store, session, heads, comments, controller, docs, opened, failures, reads, atCommit,
    idle: () => comments.whenIdle(),
    contextChanged() { for (const l of contextListeners) l(); },
    threadsOn: (uri) => editor.comments.threadsOn(controller, uri),
    contextListenerCount: () => contextListeners.size,
    /** The commenting ranges of a document, 1-based and inclusive; null when no provider is set. */
    async rangesOf(document) {
      const provider = controller.commentingRangeProvider;
      if (!provider) return null;
      const ranges = await provider.provideCommentingRanges(document, { isCancellationRequested: false });
      return ranges.map((r) => [r.start.line + 1, r.end.line + 1]);
    },
    /** The reviewer starts a comment on 1-based lines `from`..`to` of a document. */
    draft: (uri, from, to = from) => editor.comments.startDraft(controller, uri, new Range(from - 1, 0, to - 1, 0)),
    submit: (command, t, text) => editor.comments.submit(editor.run, command, t, text),
  };
}

test('one controller; a preview offers comments only on its hunk lines, per side', async () => {
  const env = setup({ open: [prDoc('src/a.ts', 'head'), prDoc('src/a.ts', 'base')] });
  await env.idle();
  assert.equal(env.editor.comments.controllers.length, 1);
  assert.deepEqual([env.controller.id, env.controller.label], [CONTROLLER_ID, 'Impact Tree: GitHub review comment']);
  const [head, base] = env.docs;
  assert.deepEqual(await env.rangesOf(head), [[10, 17], [40, 46]]);
  assert.deepEqual(await env.rangesOf(base), [[8, 14]]);
  assert.deepEqual(await env.rangesOf({ uri: prDoc('src/a.ts', 'head'), lineCount: 12 }), [[10, 12]], 'within the document');
  assert.deepEqual(await env.rangesOf({ uri: fileDoc('src/a.ts'), lineCount: 100 }), [], 'the worktree file is not the preview');
  assert.deepEqual(await env.rangesOf({ uri: prDoc('src/a.ts', 'head', previewResult({ headSha: OTHER_HEAD })), lineCount: 100 }), [],
    'another head of the same pull request');
});

test('a checkout offers comments on its files and base documents while HEAD is the pull request\'s head', async () => {
  const env = setup({ source: checkoutSource(), result: checkoutResult(), open: [fileDoc('src/a.ts'), baseDoc('src/old.ts')] });
  await env.idle();
  const [file, base] = env.docs;
  assert.deepEqual(await env.rangesOf(file), [[10, 17], [40, 46]]);
  assert.deepEqual(await env.rangesOf(base), [[8, 14]]);
  assert.deepEqual(await env.rangesOf({ ...file, isDirty: true }), [], 'unsaved edits move the lines');
  assert.equal(env.threadsOn(file.uri).length, 1);
  env.heads.value = OTHER_HEAD;   // the reviewer checked out something else
  assert.deepEqual(await env.rangesOf(file), []);
  env.contextChanged();
  await env.idle();
  assert.equal(env.threadsOn(file.uri).length, 0, 'nothing is drawn on a commit GitHub\'s lines do not describe');
  assert.equal(env.controller.commentingRangeProvider, undefined);
});

test('a local review registers no commenting and draws nothing', async () => {
  const env = setup({ state: { kind: 'none' }, source: { kind: 'local' }, result: { mode: 'pr', diffLines: DIFF }, open: [fileDoc('src/a.ts')] });
  await env.idle();
  assert.equal(env.controller.commentingRangeProvider, undefined);
  assert.equal(env.controller.threads.length, 0);
  assert.equal(env.heads.reads, 0, 'not a checkout: HEAD is not read');
  assert.equal(env.editor.seen.contexts[PENDING_CONTEXT_KEY], false);
});

test('threads are drawn where they are: resolved ones collapsed, outdated and file-level ones not at all', async () => {
  const m = reviewModel({ threads: [
    thread(1, { startLine: 11 }, [comment(1, { body: 'see [x](command:workbench.action.quit)' })]),
    thread(2, { line: 15, isResolved: true, canUnresolve: true }),
    thread(3, { line: 13 }, [comment(3, { pending: true, mine: true })]),
    thread(4, { isOutdated: true, line: null }),
    thread(5, { fileLevel: true, line: null }),
    thread(6, { side: 'LEFT', line: 9 }),
  ] });
  const env = setup({ state: ready(m), open: [prDoc('src/a.ts', 'head'), prDoc('src/a.ts', 'base')] });
  await env.idle();
  const [head, base] = env.docs;
  const drawn = env.threadsOn(head.uri);
  assert.deepEqual(drawn.map((t) => [t.range.start.line, t.range.end.line, t.label, t.collapsibleState, t.contextValue, t.canReply]), [
    [10, 11, 'Unresolved', baseStub.CommentThreadCollapsibleState.Expanded, 'canReply canResolve', true],
    [12, 12, 'Pending', baseStub.CommentThreadCollapsibleState.Expanded, '', false],
    [14, 14, 'Resolved', baseStub.CommentThreadCollapsibleState.Collapsed, 'canReply canUnresolve', true],
  ]);
  const [first] = drawn[0].comments;
  assert.equal(first.author.name, 'bob');
  assert.equal(first.body.value, 'see [x](command:workbench.action.quit)');
  assert.equal(first.body.isTrusted, false, 'GitHub text cannot run commands');
  assert.equal(first.body.supportHtml, false);
  assert.equal(first.label, undefined);
  const [pending] = drawn[1].comments;
  assert.deepEqual([pending.label, pending.contextValue], ['Pending', 'pendingMine']);
  assert.deepEqual(env.threadsOn(base.uri).map((t) => t.range.start.line), [8], 'the LEFT thread on the base side');
});

test('nothing is drawn or offered during the first load; a failed load warns once and keeps the last threads', async () => {
  const env = setup({ state: { kind: 'loading', target: TARGET, previous: null }, open: [prDoc('src/a.ts', 'head'), prDoc('src/b.ts', 'head')] });
  await env.idle();
  const [a] = env.docs;
  assert.equal(env.threadsOn(a.uri).length, 0);
  assert.deepEqual(await env.rangesOf(a), [], 'which button a comment needs is not known yet');
  const loaded = reviewModel({ threads: [thread(1)] });
  env.store.publish(ready(loaded));
  await env.idle();
  assert.equal(env.threadsOn(a.uri).length, 1);
  const error = new Error('GitHub did not answer in time');
  env.store.publish({ kind: 'loading', target: TARGET, previous: loaded }, []);
  env.store.publish({ kind: 'failed', target: TARGET, error, previous: loaded }, []);
  await env.idle();
  assert.deepEqual(env.editor.seen.warnings, ['Impact Tree: the review threads of pull request #7 could not be loaded — '
    + 'GitHub did not answer in time. The threads shown are from the last load. Refresh to try again.'], 'one warning for two open documents');
  assert.equal(env.threadsOn(a.uri).length, 1, 'the last threads stay drawn');
  env.store.publish({ kind: 'failed', target: TARGET, error, previous: loaded }, []);
  assert.equal(env.editor.seen.warnings.length, 1, 'the same failure is not repeated');
});

test('a first load that fails says that no threads are shown, not that there are none', async () => {
  const env = setup({ state: { kind: 'loading', target: TARGET, previous: null }, open: [prDoc('src/a.ts', 'head')] });
  env.store.publish({ kind: 'failed', target: TARGET, error: new Error('rate limited'), previous: null });
  await env.idle();
  assert.match(env.editor.seen.warnings[0], /could not be loaded — rate limited\. No threads are shown, which does not mean there are none\./);
  assert.equal(env.threadsOn(env.docs[0].uri).length, 0);
});

test('a change redraws only the files it names, reusing threads whose id persists', async () => {
  const m = reviewModel({ threads: [thread(1), thread(2, { line: 15 }), thread(3, { path: 'src/b.ts', line: 5 })] });
  const env = setup({ state: ready(m), open: [prDoc('src/a.ts', 'head'), prDoc('src/b.ts', 'head')] });
  await env.idle();
  const [a, b] = env.docs;
  const [one, two] = env.threadsOn(a.uri);
  const [three] = env.threadsOn(b.uri);
  one.input = 'half-written reply';
  const threeComments = three.comments;
  // GitHub now has a reply on T_1, T_2 is gone, and T_3 changed too but the event names only src/a.ts.
  const next = reviewModel({ threads: [
    thread(1, {}, [comment(1), comment(9, { pending: true, mine: true })]),
    thread(3, { path: 'src/b.ts', line: 6 }),
  ] });
  env.store.publish(ready(next), ['src/a.ts']);
  await env.idle();
  const after = env.threadsOn(a.uri);
  assert.equal(after.length, 1);
  assert.equal(after[0], one, 'the same thread object, so its reply box survives');
  assert.equal(one.input, 'half-written reply');
  assert.deepEqual(one.comments.map((c) => c.body.value), ['body 1', 'body 9']);
  assert.equal(two.disposed, true, 'a thread no longer on GitHub is removed');
  assert.equal(env.threadsOn(b.uri)[0].comments, threeComments, 'src/b.ts was not named, so not redrawn');
  assert.equal(env.threadsOn(b.uri)[0].range.start.line, 4);
  env.store.publish(ready(next), null);
  await env.idle();
  assert.equal(env.threadsOn(b.uri)[0].range.start.line, 5, 'a change naming nothing specific redraws everything');
  assert.equal(env.threadsOn(b.uri)[0], three);
});

test('a thread keeps the collapse the reviewer chose until it is resolved or reopened', async () => {
  const env = setup({ open: [prDoc('src/a.ts', 'head')] });
  await env.idle();
  const [t] = env.threadsOn(env.docs[0].uri);
  t.collapsibleState = baseStub.CommentThreadCollapsibleState.Collapsed;   // the reviewer folded it
  env.store.publish(ready(reviewModel({ threads: [thread(1, {}, [comment(1), comment(2)])] })), ['src/a.ts']);
  await env.idle();
  assert.equal(t.collapsibleState, baseStub.CommentThreadCollapsibleState.Collapsed);
  env.store.publish(ready(reviewModel({ threads: [thread(1, { isResolved: true, canUnresolve: true })] })), ['src/a.ts']);
  await env.idle();
  assert.equal(t.collapsibleState, baseStub.CommentThreadCollapsibleState.Collapsed);
  assert.equal(t.state, baseStub.CommentThreadState.Resolved);
  env.store.publish(ready(reviewModel({ threads: [thread(1)] })), ['src/a.ts']);
  await env.idle();
  assert.equal(t.collapsibleState, baseStub.CommentThreadCollapsibleState.Expanded, 'reopened');
});

test('opening a document draws its threads; closing it removes them', async () => {
  const env = setup();
  await env.idle();
  const doc = env.editor.open(prDoc('src/a.ts', 'head'));
  await env.idle();
  const [t] = env.threadsOn(doc.uri);
  assert.ok(t);
  env.editor.close(doc);
  assert.equal(t.disposed, true);
});

test('a new comment: Start review, Comment now and Add review comment each send their mode; the draft goes once drawn', async () => {
  for (const [command, mode] of [[COMMANDS.startReview, 'startReview'], [COMMANDS.commentNow, 'commentNow'], [COMMANDS.addToReview, 'addToReview']]) {
    const env = setup({ open: [prDoc('src/a.ts', 'head')] });
    await env.idle();
    const draft = env.draft(env.docs[0].uri, 40);
    const sent = await env.submit(command, draft, 'why not reuse x?');
    assert.deepEqual(sent, { sent: true }, mode);
    assert.deepEqual(env.store.calls, [{ name: 'addComment', input: { path: 'src/a.ts', side: 'RIGHT', line: 40, body: 'why not reuse x?', mode } }]);
    assert.equal(draft.disposed, true, 'the thread is drawn from GitHub\'s data instead');
  }
});

test('a comment on several lines sends its first line, and one on the base side is LEFT', async () => {
  const env = setup({ open: [prDoc('src/a.ts', 'head'), prDoc('src/a.ts', 'base')] });
  await env.idle();
  await env.submit(COMMANDS.startReview, env.draft(env.docs[0].uri, 11, 13), 'a');
  await env.submit(COMMANDS.startReview, env.draft(env.docs[1].uri, 8), 'b');
  assert.deepEqual(env.store.calls.map((c) => c.input), [
    { path: 'src/a.ts', side: 'RIGHT', line: 13, startLine: 11, body: 'a', mode: 'startReview' },
    { path: 'src/a.ts', side: 'LEFT', line: 8, body: 'b', mode: 'startReview' },
  ]);
});

test('the new-comment buttons follow whether a review is pending', async () => {
  const env = setup();
  await env.idle();
  assert.equal(env.editor.seen.contexts[PENDING_CONTEXT_KEY], false, 'Start review and Comment now');
  env.store.publish(ready(reviewModel({ threads: [thread(1)], pending: PENDING })), []);
  assert.equal(env.editor.seen.contexts[PENDING_CONTEXT_KEY], true, 'Add review comment');
  const menus = require('../package.json').contributes.menus['comments/commentThread/context'];
  const shown = (pending) => menus.filter((m) => m.when.includes('commentThreadIsEmpty') && !m.when.includes('!commentThreadIsEmpty')
    && m.when.includes(`${pending ? '' : '!'}impactTree.reviewPending`) && !(pending && m.when.includes('!impactTree.reviewPending'))).map((m) => m.command);
  assert.deepEqual(shown(false), [COMMANDS.startReview, COMMANDS.commentNow]);
  assert.deepEqual(shown(true), [COMMANDS.addToReview]);
});

test('a failed comment keeps its text in the box and its draft, and says what failed', async () => {
  const env = setup({ open: [prDoc('src/a.ts', 'head')] });
  await env.idle();
  env.store.answers.addComment = [{ ok: false, error: new Error('GitHub refused: line must be part of the diff') }];
  const draft = env.draft(env.docs[0].uri, 12);
  const result = await env.submit(COMMANDS.commentNow, draft, 'my careful words');
  assert.equal(result.sent, false);
  assert.equal(draft.input, 'my careful words', 'the box keeps the text');
  assert.equal(draft.disposed, false, 'the draft stays');
  assert.deepEqual(env.editor.seen.errors, ['Impact Tree: could not post this comment on src/a.ts line 12 — '
    + 'GitHub refused: line must be part of the diff. Your text is still in the comment box.']);
});

test('a comment outside the diff is refused before anything is sent, keeping its text', async () => {
  const env = setup({ open: [prDoc('src/a.ts', 'head')] });
  await env.idle();
  for (const [from, to] of [[9, 9], [18, 18], [16, 40]]) {
    const draft = env.draft(env.docs[0].uri, from, to);
    const result = await env.submit(COMMANDS.startReview, draft, 'x');
    assert.equal(result.sent, false, `${from}-${to}`);
    assert.equal(draft.input, 'x');
  }
  assert.deepEqual(env.store.calls, []);
  assert.match(env.editor.seen.errors[0], /line 9 of src\/a\.ts are not all in one hunk/);
  const env2 = setup({ source: checkoutSource(), result: checkoutResult(), open: [fileDoc('src/a.ts')] });
  await env2.idle();
  const draft = env2.draft(env2.docs[0].uri, 12);
  env2.heads.value = OTHER_HEAD;
  assert.equal((await env2.submit(COMMANDS.startReview, draft, 'x')).sent, false, 'HEAD moved since the box opened');
  assert.deepEqual(env2.store.calls, []);
});

test('a reply goes to the store for its thread; a failure keeps the text', async () => {
  const env = setup({ open: [prDoc('src/a.ts', 'head')] });
  await env.idle();
  const [t] = env.threadsOn(env.docs[0].uri);
  assert.deepEqual(await env.submit(COMMANDS.reply, t, 'agreed'), { sent: true });
  assert.equal(t.input, '');
  env.store.publish(ready(reviewModel({ threads: [thread(1)], pending: PENDING })), []);
  env.store.answers.reply = [{ ok: false, error: new Error('timeout') }];
  const failed = await env.submit(COMMANDS.replyToReview, t, 'into my review');
  assert.equal(failed.sent, false);
  assert.equal(t.input, 'into my review');
  assert.deepEqual(env.store.calls, [
    { name: 'reply', input: { threadId: 'T_1', body: 'agreed' } },
    { name: 'reply', input: { threadId: 'T_1', body: 'into my review' } },
  ]);
  assert.deepEqual(env.editor.seen.errors, ['Impact Tree: could not add this reply to your review — timeout. Your text is still in the comment box.']);
  assert.equal(t.disposed, false);
});

test('Resolve, Unresolve and Delete call the store for their thread or comment', async () => {
  const m = reviewModel({ threads: [thread(1), thread(2, { line: 15, isResolved: true, canUnresolve: true }),
    thread(3, { line: 13 }, [comment(3, { pending: true, mine: true })])] });
  const env = setup({ state: ready(m), open: [prDoc('src/a.ts', 'head')] });
  await env.idle();
  const [one, three, two] = env.threadsOn(env.docs[0].uri);   // drawn in line order: 12, 13, 15
  await env.editor.run(COMMANDS.resolve, one);
  await env.editor.run(COMMANDS.unresolve, two);
  await env.editor.run(COMMANDS.deletePending, three.comments[0]);
  env.store.answers.setResolved = [{ ok: false, error: new Error('no permission') }];
  await env.editor.run(COMMANDS.resolve, { thread: one, text: '' });
  assert.deepEqual(env.store.calls, [
    { name: 'setResolved', input: { threadId: 'T_1', resolved: true } },
    { name: 'setResolved', input: { threadId: 'T_2', resolved: false } },
    { name: 'deletePendingComment', input: { commentId: 'C_3' } },
    { name: 'setResolved', input: { threadId: 'T_1', resolved: true } },
  ]);
  assert.deepEqual(env.editor.seen.errors, ['Impact Tree: could not resolve the thread — no permission']);
});

// ---- editing your own comments ----------------------------------------------------------

const mineComment = (id, over = {}) => comment(id, { mine: true, canEdit: true, ...over });
const editModel = (body = 'body 1') => reviewModel({ threads: [thread(1, {}, [mineComment(1, { body }), comment(2, { mine: true })])] });
const bodyOf = (c) => (typeof c.body === 'string' ? c.body : c.body.value);

async function editSetup(state = ready(editModel())) {
  const env = setup({ state, open: [prDoc('src/a.ts', 'head')] });
  await env.idle();
  const [t] = env.threadsOn(env.docs[0].uri);
  return { env, t, mode: baseStub.CommentMode };
}

test('only a comment the viewer can edit gets the canEdit action', () => {
  const m = reviewModel({ threads: [thread(1, {}, [
    mineComment(1, { pending: true }), mineComment(2), comment(3), comment(4, { mine: true }),
  ])] });
  const [spec] = threadSpecsFor(m, 'src/a.ts', 'RIGHT');
  assert.deepEqual(spec.comments.map((c) => c.contextValue), ['pendingMine canEdit', 'canEdit', '', '']);
});

test('Edit puts the comment in edit mode, in a thread VS Code is told changed; others are left alone', async () => {
  const { env, t, mode } = await editSetup();
  const before = t.comments;
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  assert.equal(t.comments[0].mode, mode.Editing);
  assert.notEqual(t.comments, before, 'reassigned');
  assert.equal(t.collapsibleState, baseStub.CommentThreadCollapsibleState.Expanded);
  await env.editor.run(COMMANDS.editComment, t.comments[1]);
  assert.equal(t.comments[1].mode, mode.Preview, 'not editable by the viewer: nothing happens');
});

test('Save sends the edited text and returns to preview with it once the store has reloaded', async () => {
  const { env, t, mode } = await editSetup();
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  t.comments[0].body = 'a better body';
  env.store.answers.editComment = [(input) => { env.store.publish(ready(editModel(input.body)), ['src/a.ts']); return { ok: true }; }];
  await env.editor.run(COMMANDS.saveEdit, t.comments[0]);
  await env.idle();
  assert.deepEqual(env.store.calls, [{ name: 'editComment', input: { commentId: 'C_1', body: 'a better body' } }]);
  const [after] = env.threadsOn(env.docs[0].uri);
  assert.equal(after, t);
  assert.equal(after.comments[0].mode, mode.Preview);
  assert.equal(bodyOf(after.comments[0]), 'a better body');
  assert.equal(after.comments[0].body.isTrusted, false);
});

test('Save reads the text from a MarkdownString body too, and a blank text is refused in place', async () => {
  const { env, t, mode } = await editSetup();
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  t.comments[0].body = '   ';
  await env.editor.run(COMMANDS.saveEdit, t.comments[0]);
  assert.deepEqual(env.store.calls, []);
  assert.deepEqual(env.editor.seen.warnings, ['Impact Tree: write the comment first.']);
  assert.equal(t.comments[0].mode, mode.Editing);
  t.comments[0].body = new baseStub.MarkdownString('typed');
  await env.editor.run(COMMANDS.saveEdit, t.comments[0]);
  assert.deepEqual(env.store.calls, [{ name: 'editComment', input: { commentId: 'C_1', body: 'typed' } }]);
});

test('Cancel restores the original text, as untrusted Markdown, and preview mode', async () => {
  const { env, t, mode } = await editSetup();
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  t.comments[0].body = 'half-typed';
  await env.editor.run(COMMANDS.cancelEdit, t.comments[0]);
  assert.equal(t.comments[0].mode, mode.Preview);
  assert.equal(bodyOf(t.comments[0]), 'body 1');
  assert.equal(t.comments[0].body.isTrusted, false);
  assert.deepEqual(env.store.calls, []);
});

test('a failed save says so, rejects, and keeps the comment in edit mode with the edited text', async () => {
  const { env, t, mode } = await editSetup();
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  t.comments[0].body = 'my edit';
  env.store.answers.editComment = [{ ok: false, error: new Error('timeout') }];
  await assert.rejects(env.editor.run(COMMANDS.saveEdit, t.comments[0]), CommentNotSentError);
  assert.equal(t.comments[0].mode, mode.Editing);
  assert.equal(bodyOf(t.comments[0]), 'my edit');
  assert.deepEqual(env.editor.seen.errors, ['Impact Tree: could not save your edit — timeout. Your text is still in the comment box.']);
});

test('a store change that rewrites the thread does not reset an open edit; it is drawn when the edit ends', async () => {
  const { env, t, mode } = await editSetup();
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  t.comments[0].body = 'in progress';
  const next = reviewModel({ threads: [thread(1, {}, [mineComment(1, { body: 'changed elsewhere' }), comment(2, { mine: true }), comment(3)])] });
  env.store.publish(ready(next), ['src/a.ts']);
  await env.idle();
  assert.equal(t.comments.length, 2, 'not rewritten');
  assert.equal(t.comments[0].mode, mode.Editing);
  assert.equal(bodyOf(t.comments[0]), 'in progress');
  await env.editor.run(COMMANDS.cancelEdit, t.comments[0]);
  await env.idle();
  const [after] = env.threadsOn(env.docs[0].uri);
  assert.equal(after, t);
  assert.equal(after.comments.length, 3);
  assert.equal(bodyOf(after.comments[0]), 'changed elsewhere');
  assert.equal(after.comments[0].mode, mode.Preview);
});

test('a thread that goes away while being edited is still removed', async () => {
  const { env, t } = await editSetup();
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  env.store.publish(ready(reviewModel({ threads: [] })), ['src/a.ts']);
  await env.idle();
  assert.equal(t.disposed, true);
});

test('end to end: Edit and Save send updatePullRequestReviewComment and the thread shows the new text', async () => {
  const github = answeringGitHub({ threads: [rawThread(1, [rawComment(1, { viewerDidAuthor: true, viewerCanUpdate: true })])], pending: false });
  const inner = github.graphql;
  github.graphql = async (query, variables) => {
    if (!/^mutation ImpactTreeUpdateComment/.test(query)) return inner(query, variables);
    github.calls.push({ name: 'ImpactTreeUpdateComment', input: variables.input });
    github.threads = [rawThread(1, [rawComment(1, { viewerDidAuthor: true, viewerCanUpdate: true, body: variables.input.body })])];
    return { updatePullRequestReviewComment: { pullRequestReviewComment: { id: 'C_1', body: variables.input.body } } };
  };
  const env = await realStoreSetup(github);
  const [t] = env.threadsOn();
  assert.equal(t.comments[0].contextValue, 'canEdit');
  await env.editor.run(COMMANDS.editComment, t.comments[0]);
  t.comments[0].body = 'edited';
  await env.editor.run(COMMANDS.saveEdit, t.comments[0]);
  await env.comments.whenIdle();
  assert.deepEqual(github.calls.filter((c) => c.name === 'ImpactTreeUpdateComment').map((c) => c.input), [{ pullRequestReviewCommentId: 'C_1', body: 'edited' }]);
  const [after] = env.threadsOn();
  assert.equal(bodyOf(after.comments[0]), 'edited');
  assert.equal(after.comments[0].mode, baseStub.CommentMode.Preview);
  env.comments.dispose();
  env.store.dispose();
});

test('dispose disposes the controller, its threads and its subscriptions, and a pending draw publishes nothing', async () => {
  const env = setup({ source: checkoutSource(), result: checkoutResult(), open: [fileDoc('src/a.ts')] });
  await env.idle();
  const [t] = env.threadsOn(env.docs[0].uri);
  env.store.publish(ready(reviewModel({ threads: [thread(1), thread(2, { line: 15 })] })), ['src/a.ts']);   // waits for HEAD
  env.comments.dispose();
  await env.idle();
  assert.equal(env.controller.disposed, true);
  assert.equal(t.disposed, true);
  assert.equal(env.controller.threads.filter((x) => !x.disposed).length, 0, 'the draw in flight drew nothing');
  assert.equal(env.store.listenerCount(), 0);
  assert.equal(env.contextListenerCount(), 0);
  assert.equal(env.editor.handlers.open.size + env.editor.handlers.close.size, 0);
  assert.equal(env.editor.commands.size, 0);
});

// ---- end to end with the real store -----------------------------------------------------

// GitHub-shaped answers, as the L2 normaliser reads them.
const rawComment = (id, over = {}) => ({ id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', state: 'SUBMITTED', viewerDidAuthor: false, viewerCanUpdate: false, url: `https://x/${id}`, diffHunk: '', commit: null, ...over });
const rawThread = (id, comments, over = {}) => ({ id: `T_${id}`, isResolved: false, isOutdated: false, path: 'src/a.ts', line: 12,
  originalLine: 12, startLine: null, originalStartLine: null, diffSide: 'RIGHT', subjectType: 'LINE',
  viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
  comments: { totalCount: comments.length, pageInfo: { hasNextPage: false }, nodes: comments }, ...over });
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const rawAnswer = ({ threads, pending }) => ({ repository: { pullRequest: {
  id: 'PR_7', number: 7, title: 't', body: 'b', url: 'https://x', state: 'OPEN', author: null, viewerDidAuthor: false,
  headRefOid: HEAD, baseRefOid: BASE, headRefName: 'f', baseRefName: 'main',
  reviewThreads: page(threads), reviews: { nodes: pending ? [{ id: 'R_1', databaseId: 1, comments: { totalCount: 1 } }] : [] },
  files: page([]), timelineItems: { nodes: [] },
} } });

/** A GitHub that answers at once: loads from `github.threads`, and mutations change it. */
function answeringGitHub(initial) {
  const github = { threads: initial.threads, pending: initial.pending, calls: [] };
  github.graphql = async (query, variables) => {
    const name = /^(?:query|mutation) (\w+)/.exec(query)[1];
    if (name === 'ImpactTreePullRequestOverview') return overviewAnswer(variables.headOid); // not one of the calls asserted on
    github.calls.push({ name, input: variables.input });
    const { input } = variables;
    switch (name) {
      case 'ImpactTreePullRequestReview': return rawAnswer(github);
      case 'ImpactTreeAddReview': github.pending = true; return { addPullRequestReview: { pullRequestReview: { id: 'R_1', state: 'PENDING' } } };
      case 'ImpactTreeAddThread':
        github.threads = [...github.threads, rawThread(50, [rawComment(50, { state: 'PENDING', viewerDidAuthor: true, body: input.body })],
          { line: input.line, diffSide: input.side })];
        return { addPullRequestReviewThread: { thread: { id: 'T_50' } } };
      case 'ImpactTreeReply':
        github.threads = github.threads.map((t) => (t.id !== input.pullRequestReviewThreadId ? t : rawThread(Number(t.id.slice(2)),
          [...t.comments.nodes, rawComment(60, { body: input.body, state: input.pullRequestReviewId ? 'PENDING' : 'SUBMITTED', viewerDidAuthor: true })])));
        return { addPullRequestReviewThreadReply: { comment: { id: 'C_60' } } };
      default: throw new Error(`unexpected ${name}`);
    }
  };
  return github;
}

async function realStoreSetup(github) {
  const store = createPullRequestReviewStore({ gh: github, getTarget: () => TARGET, getAnalysisId: () => 1 });
  const editor = fakeEditor();
  const doc = editor.open(prDoc('src/a.ts', 'head'));
  const comments = createReviewComments(editor.vscode, {
    store, getSession: () => ({ source: prSource(), result: previewResult() }), repoRoot: () => REPO,
    readHead: async () => null, contextEvents: [],
  });
  store.sync();
  await new Promise((resolve) => setImmediate(resolve));
  await comments.whenIdle();
  const controller = editor.comments.controllers[0];
  return { store, editor, doc, comments, controller, threadsOn: () => editor.comments.threadsOn(controller, doc.uri),
    submit: (command, t, text) => editor.comments.submit(editor.run, command, t, text) };
}

test('end to end: Start review creates the pending review and the thread is drawn from the reload', async () => {
  const github = answeringGitHub({ threads: [rawThread(1, [rawComment(1)])], pending: false });
  const env = await realStoreSetup(github);
  assert.equal(env.threadsOn().length, 1);
  const draft = env.editor.comments.startDraft(env.controller, env.doc.uri, new Range(15, 0, 15, 0));
  assert.deepEqual(await env.submit(COMMANDS.startReview, draft, 'first thought'), { sent: true });
  await env.comments.whenIdle();
  assert.deepEqual(github.calls.map((c) => c.name), ['ImpactTreePullRequestReview', 'ImpactTreeAddReview', 'ImpactTreeAddThread', 'ImpactTreePullRequestReview']);
  assert.equal(draft.disposed, true);
  const drawn = env.threadsOn();
  assert.deepEqual(drawn.map((t) => [t.range.start.line, t.label]), [[11, 'Unresolved'], [15, 'Pending']]);
  assert.equal(env.editor.seen.contexts[PENDING_CONTEXT_KEY], true);
  env.comments.dispose();
  env.store.dispose();
});

test('end to end: a reply joins the pending review when there is one, and is posted now otherwise', async () => {
  for (const pending of [true, false]) {
    const github = answeringGitHub({ threads: [rawThread(1, [rawComment(1)])], pending });
    const env = await realStoreSetup(github);
    const [t] = env.threadsOn();
    assert.deepEqual(await env.submit(pending ? COMMANDS.replyToReview : COMMANDS.reply, t, 'ok'), { sent: true });
    await env.comments.whenIdle();
    const reply = github.calls.find((c) => c.name === 'ImpactTreeReply');
    assert.deepEqual(reply.input, { pullRequestReviewThreadId: 'T_1', body: 'ok', ...(pending ? { pullRequestReviewId: 'R_1' } : {}) });
    const [after] = env.threadsOn();
    assert.equal(after, t, 'the same thread, updated');
    assert.deepEqual(after.comments.map((c) => c.label), [undefined, pending ? 'Pending' : undefined]);
    env.comments.dispose();
    env.store.dispose();
  }
});

// ---- the extension ----------------------------------------------------------------------

test('the extension creates the review controller, and a local review gets no commenting or threads', () => withEnv(async (env) => {
  await env.refresh();
  const controller = env.commentController(CONTROLLER_ID);
  assert.ok(controller, 'created on activation');
  assert.equal(controller.commentingRangeProvider, undefined);
  assert.equal(controller.threads.length, 0);
  // Registered, and harmless without a comment box or thread to act on.
  for (const command of Object.values(COMMANDS)) assert.equal(await env.run(command), undefined, command);
  const contributed = require('../package.json').contributes.commands.map((c) => c.command);
  for (const command of Object.values(COMMANDS)) assert.ok(contributed.includes(command), command);
}));

// ---- starting a comment from the tree or Details (L5) -----------------------------------

const changeRow = (startLine, endLine, relPath = 'src/a.ts') => ({ type: 'finding', finding: { relPath, startLine, endLine } });
const outsideRow = (ranges, relPath = 'src/a.ts') => ({ type: 'outside', relPath, ranges });
const CALLER = { label: 'Loader.read', test: false, relPath: 'src/user.ts', siteLine: 88, callState: 'unchanged' };

test('a row\'s comment starts on its first line when the diff shows it, else on the nearest line of the row it shows', () => {
  const spans = [[10, 17], [40, 46]];
  const line = (row) => chooseCommentLine(spans, rowCommentPlace(row));
  assert.deepEqual(line(changeRow(12, 30)), { line: 12 }, 'the first line');
  assert.deepEqual(line(changeRow(20, 42)), { line: 40 }, 'the nearest commentable line inside the change');
  assert.deepEqual(line(changeRow(5, 11)), { line: 10 });
  assert.deepEqual(chooseCommentLine([[20, 25], [35, 40]], { relPath: 'x', preferred: 30, ranges: [[20, 40]] }), { line: 25 },
    'equally near: the earlier');
  assert.deepEqual(line(outsideRow([[1, 3], [44, 50]])), { line: 44 }, 'an outside row: from any of its ranges');
  assert.deepEqual(rowCommentPlace(outsideRow([[4.5, 4.5], [9, 9]])), { relPath: 'src/a.ts', preferred: 5, ranges: [[5, 5], [9, 9]] },
    'a deletion marker stands for the line after the gap');
  assert.deepEqual(line(changeRow(20, 30)),
    { problem: 'lines 20–30 of src/a.ts are not in the pull request\'s diff, where GitHub takes comments; comment on the file instead' });
  assert.deepEqual(chooseCommentLine(spans, rowCommentPlace(outsideRow([[3, 3]]))),
    { problem: 'line 3 of src/a.ts is not in the pull request\'s diff, where GitHub takes comments; comment on the file instead' });
  assert.equal(rowCommentPlace({ type: 'deleted', relPath: 'src/a.ts' }), null);
});

test('the block about a caller outside the diff, exactly', () => {
  const target = { owner: 'o', name: 'r', headOid: HEAD };
  assert.equal(callerContextBlock(CALLER, target),
    '\n\n---\n**Caller outside this PR\'s diff:** `Loader.read` in `src/user.ts`, line 88: not changed by this PR.\n'
    + `https://github.com/o/r/blob/${HEAD}/src/user.ts#L88`);
  assert.equal(withCallerContext('Is this still right?  \n', { ...CALLER, test: true, callState: 'changed-elsewhere' }, target),
    'Is this still right?\n\n---\n**Caller outside this PR\'s diff:** `Loader.read` (a test) in `src/user.ts`, line 88: '
    + `its function changed in this PR, but not this call.\nhttps://github.com/o/r/blob/${HEAD}/src/user.ts#L88`);
  for (const callState of [null, undefined, 'weird']) {
    assert.match(callerContextBlock({ ...CALLER, callState }, target), /line 88: call state unknown\.\n/);
  }
  assert.match(callerContextBlock({ ...CALLER, relPath: 'src/a b#.ts' }, target), /blob\/a{40}\/src\/a%20b%23\.ts#L88$/, 'the path is a URL path');
  assert.equal(callerDraftLabel(CALLER), 'About caller Loader.read (src/user.ts:88) — added after your text · remove');
});

test('Comment on this change opens the head-side diff and adds an empty draft at the line it chose', async () => {
  const env = setup();
  await env.idle();
  const draft = await env.comments.commentOnRow(changeRow(20, 42));
  assert.deepEqual(env.opened, [['src/a.ts', 40]]);
  assert.equal(draft.uri.toString(), prDoc('src/a.ts', 'head').toString());
  assert.deepEqual([draft.range.start.line, draft.range.end.line, draft.comments.length, draft.canReply], [39, 39, 0, true]);
  assert.equal(draft.label, undefined);
  assert.equal(draft.collapsibleState, baseStub.CommentThreadCollapsibleState.Expanded);
  assert.deepEqual(await env.submit(COMMANDS.startReview, draft, 'why?'), { sent: true });
  assert.deepEqual(env.store.calls, [{ name: 'addComment', input: { path: 'src/a.ts', side: 'RIGHT', line: 40, body: 'why?', mode: 'startReview' } }]);
});

test('a row with no line in the diff, or a review whose threads are not loaded, is refused with the reason', async () => {
  const env = setup();
  await env.idle();
  assert.equal(await env.comments.commentOnRow(changeRow(20, 30)), null);
  assert.deepEqual(env.editor.seen.warnings, ['Impact Tree: cannot comment here: lines 20–30 of src/a.ts are not in the pull request\'s diff, '
    + 'where GitHub takes comments; comment on the file instead.']);
  const loading = setup({ state: { kind: 'loading', target: TARGET, previous: null } });
  await loading.idle();
  assert.equal(await loading.comments.commentOnRow(changeRow(12, 14)), null);
  assert.match(loading.editor.seen.warnings[0], /the review threads are not loaded yet/);
  const local = setup({ state: { kind: 'none' }, source: { kind: 'local' }, result: { mode: 'pr' } });
  await local.idle();
  assert.equal(await local.comments.commentOnRow(changeRow(12, 14)), null);
  assert.match(local.editor.seen.warnings[0], /only on the pull request under review/);
  for (const e of [env, loading, local]) {
    assert.deepEqual(e.opened, [], 'no diff opened');
    assert.equal(e.controller.threads.length, 0, 'no draft');
  }
});

test('Comment on this file adds a "File comment" draft on line 1 whose submit sends a file-level comment', async () => {
  const env = setup();
  await env.idle();
  const draft = await env.comments.commentOnRow({ type: 'reviewFile', relPath: 'src/b.ts' });
  assert.deepEqual(env.opened, [['src/b.ts', 1]]);
  assert.deepEqual([draft.label, draft.range.start.line], [FILE_COMMENT_LABEL, 0]);
  assert.deepEqual(await env.submit(COMMANDS.addToReview, draft, 'overall: fine'), { sent: true });
  assert.deepEqual(env.store.calls, [{ name: 'addFileComment', input: { path: 'src/b.ts', body: 'overall: fine', mode: 'addToReview' } }]);
  assert.equal(draft.disposed, true);
  // A file without hunks still takes a file comment.
  const plain = await env.comments.commentOnRow({ type: 'file', relPath: 'docs/x.md' });
  env.store.answers.addFileComment = [{ ok: false, error: new Error('timeout') }];
  const failed = await env.submit(COMMANDS.startReview, plain, 'keep me');
  assert.equal(failed.sent, false);
  assert.equal(plain.input, 'keep me');
  assert.deepEqual(env.editor.seen.errors, ['Impact Tree: could not start a review with this comment on docs/x.md — timeout. Your text is still in the comment box.']);
});

test('a caller whose call line is in the diff is commented on at that line, with nothing added', async () => {
  const env = setup();
  await env.idle();
  const draft = await env.comments.commentOnCaller(changeRow(12, 14), { ...CALLER, relPath: 'src/b.ts', siteLine: 7 });
  assert.deepEqual(env.opened, [['src/b.ts', 7]]);
  assert.equal(draft.label, undefined);
  assert.equal(draft.contextValue, '');
  await env.submit(COMMANDS.commentNow, draft, 'this call too');
  assert.deepEqual(env.store.calls[0].input, { path: 'src/b.ts', side: 'RIGHT', line: 7, body: 'this call too', mode: 'commentNow' });
});

test('a caller outside the diff is commented on the change, with its block added after the text unless removed', async () => {
  const env = setup();
  await env.idle();
  const draft = await env.comments.commentOnCaller(changeRow(12, 14), CALLER);
  assert.deepEqual(env.opened, [['src/a.ts', 12]], 'the change\'s first line');
  assert.equal(draft.label, callerDraftLabel(CALLER));
  assert.equal(draft.contextValue, 'callerContext');
  await env.submit(COMMANDS.startReview, draft, 'Does this still work for the loader?');
  assert.equal(env.store.calls[0].input.body, 'Does this still work for the loader?\n\n---\n'
    + '**Caller outside this PR\'s diff:** `Loader.read` in `src/user.ts`, line 88: not changed by this PR.\n'
    + `https://github.com/o/r/blob/${HEAD}/src/user.ts#L88`);

  const second = await env.comments.commentOnCaller(changeRow(12, 14), CALLER);
  await env.editor.run(COMMANDS.removeCallerContext, second);
  assert.equal(second.label, undefined, 'the label goes with it');
  assert.equal(second.contextValue, '');
  await env.submit(COMMANDS.startReview, second, 'just this');
  assert.equal(env.store.calls[1].input.body, 'just this');
  const menus = require('../package.json').contributes.menus['comments/commentThread/title'];
  assert.ok(menus.some((m) => m.command === COMMANDS.removeCallerContext && m.when.includes('commentThread =~ /\\bcallerContext\\b/')));
});

test('revealing a thread opens its file at its head line, or the file for an outdated, file-level or base-side one', async () => {
  const m = reviewModel({ threads: [thread(1), thread(2, { isOutdated: true, line: null }), thread(3, { side: 'LEFT', line: 9 }),
    thread(4, { path: 'src/b.ts', fileLevel: true, line: null })] });
  const env = setup({ state: ready(m) });
  await env.idle();
  for (const id of ['T_1', 'T_2', 'T_3', 'T_4']) assert.equal(await env.comments.revealThread(id), true);
  assert.deepEqual(env.opened, [['src/a.ts', 12], ['src/a.ts', null], ['src/a.ts', null], ['src/b.ts', null]]);
  assert.equal(await env.comments.revealThread('T_gone'), false);
  assert.match(env.editor.seen.warnings[0], /not in the loaded review/);
  env.failures.open = new Error('no such file');
  assert.equal(await env.comments.revealThread('T_1'), false, 'a file that cannot be opened is not a reveal');
  assert.match(env.editor.seen.warnings[1], /cannot open src\/a\.ts: no such file/);
});


test('switching checkout PRs removes native drafts despite identical file URIs and diff spans', async () => {
  const env = setup({ source: checkoutSource(), result: checkoutResult(), open: [fileDoc('src/a.ts')] });
  await env.idle();
  const draft = env.draft(env.docs[0].uri, 12);
  const nextTarget = { ...TARGET, number: 8, headOid: OTHER_HEAD };
  const model = reviewModel(); model.pr = { ...model.pr, number: 8, headRefOid: OTHER_HEAD };
  env.session.source = { kind: 'checkout', pr: { number: 8 }, sha: OTHER_HEAD };
  env.heads.value = OTHER_HEAD;
  env.store.publish({ kind: 'ready', target: nextTarget, model });
  await env.idle();
  assert.equal(draft.disposed, true, 'native draft is removed from the editor on target change');
  assert.equal(env.controller.disposed, true);
  assert.equal((await env.submit(COMMANDS.startReview, draft, 'for the earlier PR')).sent, false);
  assert.equal(env.store.calls.length, 0);
  env.comments.dispose();
});

test('editing a checkout after opening a draft refuses submission and keeps the text', async () => {
  const env = setup({ source: checkoutSource(), result: checkoutResult(), open: [fileDoc('src/a.ts')] });
  await env.idle();
  const draft = env.draft(env.docs[0].uri, 12);
  env.docs[0].isDirty = true;
  const outcome = await env.submit(COMMANDS.startReview, draft, 'about the edited content');
  assert.equal(outcome.sent, false);
  assert.equal(draft.input, 'about the edited content');
  assert.equal(env.store.calls.length, 0);
  env.comments.dispose();
});

// ---- suggested changes (B2) ---------------------------------------------------------------

const FILE_TEXT = `${Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
const suggesting = (body, over = {}) => comment(1, { body, commitOid: HEAD, ...over });
const draftsOn = (env, uri) => env.threadsOn(uri).filter((t) => t.comments.length === 1 && t.comments[0].contextValue === SUGGESTION_DRAFT);

test('a posted comment with a suggestion block gets the hasSuggestion action; a pending one does not', () => {
  const block = 'nit\n```suggestion\nx\n```';
  const m = reviewModel({ threads: [thread(1, {}, [suggesting(block), comment(2, { body: block, pending: true, mine: true }),
    comment(3, { body: block, mine: true, canEdit: true }), comment(4, { body: '```js\nx\n```' })])] });
  const [spec] = threadSpecsFor(m, 'src/a.ts', 'RIGHT');
  assert.deepEqual(spec.comments.map((c) => c.contextValue), ['hasSuggestion', 'pendingMine', 'canEdit hasSuggestion', '']);
  const menus = require('../package.json').contributes.menus;
  assert.ok(menus['comments/comment/title'].some((m) => m.command === COMMANDS.applySuggestion
    && m.when === 'commentController == impactTree.review && comment =~ /\\bhasSuggestion\\b/'));
  assert.ok(menus['editor/context'].some((m) => m.command === COMMANDS.suggestChange && m.when === SUGGEST_CONTEXT_KEY));
  assert.ok(menus['comments/commentThread/title'].some((m) => m.command === COMMANDS.suggestChange && m.when.includes('commentThreadIsEmpty')));
  const draftButtons = menus['comments/comment/context'].filter((m) => m.when.includes(`comment == ${SUGGESTION_DRAFT}`)).map((m) => m.command);
  assert.deepEqual(draftButtons, [COMMANDS.startReview, COMMANDS.commentNow, COMMANDS.addToReview, COMMANDS.cancelEdit]);
});

test('Suggest change adds a draft in edit mode holding the selected lines in a suggestion block', async () => {
  const env = setup();
  await env.idle();
  const doc = env.editor.open(prDoc('src/a.ts', 'head'), { text: FILE_TEXT });
  const base = env.editor.open(prDoc('src/a.ts', 'base'), { text: FILE_TEXT });
  await env.idle();
  env.editor.activate(base, 11);
  assert.equal(env.editor.seen.contexts[SUGGEST_CONTEXT_KEY], false, 'the base side');
  env.editor.activate(doc, 11, 13);
  assert.equal(env.editor.seen.contexts[SUGGEST_CONTEXT_KEY], true, 'the head side of a file in the diff');
  await env.editor.run(COMMANDS.suggestChange);
  const [draft] = draftsOn(env, doc.uri);
  assert.deepEqual([draft.range.start.line, draft.range.end.line, draft.canReply], [10, 12, false]);
  const [c] = draft.comments;
  assert.equal(c.mode, baseStub.CommentMode.Editing);
  assert.equal(c.body.value, '```suggestion\nline 11\nline 12\nline 13\n```');
  assert.equal(c.body.isTrusted, false);
  assert.deepEqual([c.author.name, c.label], ['you', 'Suggestion · draft']);
  // The reviewer edits the block, then sends it with the new-comment buttons.
  c.body = '```suggestion\nline eleven\n```';
  await env.editor.run(COMMANDS.startReview, c);
  assert.deepEqual(env.store.calls, [{ name: 'addComment',
    input: { path: 'src/a.ts', side: 'RIGHT', line: 13, startLine: 11, body: '```suggestion\nline eleven\n```', mode: 'startReview' } }]);
  assert.equal(draft.disposed, true, 'drawn from GitHub\'s data instead');
  assert.equal(env.store.calls.length, 1);
});

test('whole lines selected up to the start of the next line do not take that line; the cursor line alone is one line', async () => {
  const env = setup();
  await env.idle();
  const doc = env.editor.open(prDoc('src/a.ts', 'head'), { text: FILE_TEXT });
  env.editor.activate(doc, 11, 13, { endCharacter: 0 });
  await env.editor.run(COMMANDS.suggestChange);
  env.editor.activate(doc, 15);
  await env.editor.run(COMMANDS.suggestChange);
  assert.deepEqual(draftsOn(env, doc.uri).map((t) => [t.range.start.line, t.range.end.line, t.comments[0].body.value]), [
    [10, 11, '```suggestion\nline 11\nline 12\n```'],
    [14, 14, '```suggestion\nline 15\n```'],
  ]);
});

test('a "+" draft becomes a suggestion on its lines; with a pending review it is added to the review', async () => {
  const env = setup({ state: ready(reviewModel({ threads: [], pending: PENDING })) });
  await env.idle();
  const doc = env.editor.open(prDoc('src/a.ts', 'head'), { text: FILE_TEXT });
  await env.idle();
  const plus = env.draft(doc.uri, 40, 41);
  await env.editor.run(COMMANDS.suggestChange, plus);
  assert.equal(plus.disposed, true);
  const [draft] = draftsOn(env, doc.uri);
  assert.deepEqual([draft.range.start.line, draft.range.end.line], [39, 40]);
  const [c] = draft.comments;
  assert.equal(c.body.value, '```suggestion\nline 40\nline 41\n```');
  c.body = new baseStub.MarkdownString('```suggestion\nfixed\n```');
  await env.editor.run(COMMANDS.addToReview, c);
  assert.deepEqual(env.store.calls[0].input, { path: 'src/a.ts', side: 'RIGHT', line: 41, startLine: 40, body: '```suggestion\nfixed\n```', mode: 'addToReview' });
  const file = await env.comments.commentOnRow({ type: 'reviewFile', relPath: 'src/a.ts' });
  await env.editor.run(COMMANDS.suggestChange, file);
  assert.equal(file.disposed, false);
  assert.match(env.editor.seen.warnings.at(-1), /a file comment cannot hold a suggestion/);
});

test('a failed suggestion keeps its text in edit mode; Cancel drops the draft', async () => {
  const env = setup();
  await env.idle();
  const doc = env.editor.open(prDoc('src/a.ts', 'head'), { text: FILE_TEXT });
  env.editor.activate(doc, 12);
  await env.editor.run(COMMANDS.suggestChange);
  const [draft] = draftsOn(env, doc.uri);
  const [c] = draft.comments;
  c.body = '```suggestion\nmy careful line\n```';
  env.store.answers.addComment = [{ ok: false, error: new Error('timeout') }];
  await assert.rejects(env.editor.run(COMMANDS.commentNow, c), CommentNotSentError);
  assert.equal(c.mode, baseStub.CommentMode.Editing);
  assert.equal(bodyOf(c), '```suggestion\nmy careful line\n```');
  assert.equal(draft.disposed, false);
  assert.deepEqual(env.editor.seen.errors, ['Impact Tree: could not post this comment on src/a.ts line 12 — timeout. Your text is still in the comment box.']);
  c.body = '  ';
  await env.editor.run(COMMANDS.commentNow, c);
  assert.equal(env.store.calls.length, 1, 'blank: not sent');
  await env.editor.run(COMMANDS.cancelEdit, c);
  assert.equal(draft.disposed, true);
});

test('Suggest change outside one hunk, on the base side, on unsaved edits or before the threads load says why and adds nothing', async () => {
  const env = setup();
  await env.idle();
  const doc = env.editor.open(prDoc('src/a.ts', 'head'), { text: FILE_TEXT });
  const base = env.editor.open(prDoc('src/a.ts', 'base'), { text: FILE_TEXT });
  env.editor.activate(doc, 16, 40);
  await env.editor.run(COMMANDS.suggestChange);
  env.editor.activate(doc, 9);
  await env.editor.run(COMMANDS.suggestChange);
  env.editor.activate(base, 9);
  await env.editor.run(COMMANDS.suggestChange);
  assert.deepEqual(env.editor.seen.warnings, [
    'Impact Tree: lines 16–40 of src/a.ts are not all in one hunk of the pull request\'s diff, where GitHub takes comments.',
    'Impact Tree: line 9 of src/a.ts is not in one hunk of the pull request\'s diff, where GitHub takes comments.',
    'Impact Tree: a change can be suggested only on the head side of the pull request\'s diff, where GitHub applies suggestions.',
  ]);
  const checkout = setup({ source: checkoutSource(), result: checkoutResult() });
  await checkout.idle();
  const file = checkout.editor.open(fileDoc('src/a.ts'), { text: FILE_TEXT, isDirty: true });
  checkout.editor.activate(file, 12);
  await checkout.editor.run(COMMANDS.suggestChange);
  assert.match(checkout.editor.seen.warnings[0], /src\/a\.ts has unsaved changes/);
  const loading = setup({ state: { kind: 'loading', target: TARGET, previous: null } });
  const doc2 = loading.editor.open(prDoc('src/a.ts', 'head'), { text: FILE_TEXT });
  loading.editor.activate(doc2, 12);
  await loading.editor.run(COMMANDS.suggestChange);
  assert.match(loading.editor.seen.warnings[0], /not loaded yet/);
  const none = setup();
  await none.editor.run(COMMANDS.suggestChange);
  assert.match(none.editor.seen.warnings[0], /open the head side of a file/);
  for (const e of [env, checkout, loading, none]) {
    assert.equal(e.controller.threads.filter((t) => !t.disposed && t.comments.some((c) => c.contextValue === SUGGESTION_DRAFT)).length, 0);
  }
});

// Apply: a checkout of #7 at HEAD whose src/a.ts has a thread on lines 11-12.
async function applySetup({ body = 'nit:\n```suggestion\nNEW\n```', text = FILE_TEXT, atCommit = FILE_TEXT, commentOver = {}, source = checkoutSource(), threadOver = {} } = {}) {
  const m = reviewModel({ threads: [thread(1, { startLine: 11, line: 12, ...threadOver }, [suggesting(body, commentOver)])] });
  const result = source.kind === 'pr' ? previewResult() : checkoutResult();
  const env = setup({ state: ready(m), source, result, atCommit: { [`${HEAD}:src/a.ts`]: atCommit } });
  await env.idle();
  const doc = env.editor.open(source.kind === 'pr' ? prDoc('src/a.ts', 'head') : fileDoc('src/a.ts'), { text, isDirty: false });
  await env.idle();
  const [t] = env.threadsOn(doc.uri);
  return { env, doc, c: t.comments[0], apply: () => env.editor.run(COMMANDS.applySuggestion, t.comments[0]) };
}

test('Apply suggestion replaces the thread\'s lines in the checkout, unsaved, and says so', async () => {
  const { env, doc, c, apply } = await applySetup();
  assert.equal(c.contextValue, 'hasSuggestion');
  await apply();
  assert.equal(doc.text, FILE_TEXT.replace('line 11\nline 12\n', 'NEW\n'));
  assert.equal(doc.isDirty, true, 'left unsaved, so the reviewer can see and undo it');
  assert.deepEqual(env.editor.seen.infos, ['Impact Tree: Suggestion applied to src/a.ts lines 11–12; save to keep it.']);
  assert.deepEqual(env.editor.seen.shown, [doc.uri.toString()]);
  assert.deepEqual(env.reads, [[HEAD, 'src/a.ts']]);
  assert.deepEqual(env.editor.seen.warnings, []);
});

test('Apply keeps a CRLF file\'s line breaks, and an empty suggestion deletes the lines', async () => {
  const crlf = FILE_TEXT.replace(/\n/g, '\r\n');
  const one = await applySetup({ body: '```suggestion\nA\nB\n```', text: crlf });
  await one.apply();
  assert.equal(one.doc.text, crlf.replace('line 11\r\nline 12\r\n', 'A\r\nB\r\n'));
  const two = await applySetup({ body: '```suggestion\n```' });
  await two.apply();
  assert.equal(two.doc.text, FILE_TEXT.replace('line 11\nline 12\n', ''));
  assert.match(two.env.editor.seen.infos[0], /lines 11–12/);
});

test('a stale apply is refused with the reason, and the file is left alone', async () => {
  const cases = [
    [{ atCommit: FILE_TEXT.replace('line 12', 'line twelve') }, 'Impact Tree: Lines 11–12 of src/a.ts changed since the suggestion was written.'],
    [{ text: FILE_TEXT.replace('line 11', 'edited') }, 'Impact Tree: Lines 11–12 of src/a.ts changed since the suggestion was written.'],
    [{ commentOver: { commitOid: OTHER_HEAD } }, 'Impact Tree: The checkout is at aaaaaaa, not bbbbbbb the suggestion was written on.'],
    [{ source: prSource() }, 'Impact Tree: Check out the pull request to apply a suggestion.'],
    [{ body: '```suggestion\na\n```\n```suggestion\nb\n```' }, 'Impact Tree: This comment has 2 suggestions; apply them on GitHub.'],
  ];
  for (const [over, message] of cases) {
    const { env, doc, apply } = await applySetup(over);
    const before = doc.text;
    await apply();
    assert.deepEqual(env.editor.seen.warnings, [message], message);
    assert.equal(doc.text, before);
    assert.equal(env.editor.seen.edits, undefined);
  }
  // The checkout moved off the commit after the thread was drawn.
  const moved = await applySetup();
  moved.env.heads.value = OTHER_HEAD;
  await moved.apply();
  assert.deepEqual(moved.env.editor.seen.warnings, ['Impact Tree: The checkout is at bbbbbbb, not aaaaaaa the suggestion was written on.']);
  assert.equal(moved.doc.text, FILE_TEXT);
});

test('an apply re-checks after its waits: a document edited or a comment changed meanwhile is not edited', async () => {
  const edited = await applySetup();
  // The reviewer types while the file is read at the commit.
  const original = edited.env.reads.push.bind(edited.env.reads);
  edited.env.reads.push = (entry) => { edited.doc.version++; return original(entry); };
  await edited.apply();
  assert.deepEqual(edited.env.editor.seen.warnings, ['Impact Tree: src/a.ts changed while the suggestion was being applied; try again.']);
  assert.equal(edited.doc.text, FILE_TEXT);

  const changed = await applySetup();
  changed.env.reads.push = () => {
    changed.env.store.publish(ready(reviewModel({ threads: [thread(1, { startLine: 11, line: 12 }, [suggesting('```suggestion\nOTHER\n```')])] })), []);
  };
  await changed.apply();
  assert.deepEqual(changed.env.editor.seen.warnings, ['Impact Tree: the suggestion changed on GitHub while it was being applied; try again.']);
  assert.equal(changed.doc.text, FILE_TEXT);
});

test('end to end: a posted suggestion from GitHub, with its commit, is drawn with Apply suggestion', async () => {
  const github = answeringGitHub({ threads: [rawThread(1, [rawComment(1, { body: '```suggestion\nx\n```', commit: { oid: HEAD } })])], pending: false });
  const env = await realStoreSetup(github);
  const [t] = env.threadsOn();
  assert.equal(t.comments[0].contextValue, 'hasSuggestion');
  assert.equal(reviewDataOfStore(env.store.getState()).threads[0].comments[0].commitOid, HEAD);
  await env.editor.run(COMMANDS.applySuggestion, t.comments[0]);
  assert.deepEqual(env.editor.seen.warnings, ['Impact Tree: Check out the pull request to apply a suggestion.'], 'a preview has no working tree');
  env.comments.dispose();
  env.store.dispose();
});
