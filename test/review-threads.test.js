'use strict';
// Review threads in the change tree (L5): which row a thread belongs to, the counts on rows
// and in the view's message, the "Unresolved threads" filter, and what a change of the
// threads repaints. Pure parts directly; the provider through the vscode stub with an
// event emitter that delivers, so a test sees exactly which rows were repainted.
const test = require('node:test');
const assert = require('node:assert/strict');
const baseStub = require('./vscode-stub');
const { createTreeProvider } = require('../src/tree-provider');
const { buildFileRows, filterFileRows, buildReviewSummary } = require('../src/review-tree-model');
const {
  threadsViewOf, assignFileThreads, countThreads, describeThreadCounts, threadsMessageSuffix, buildThreadSection,
} = require('../src/review-threads');

// An emitter that delivers, as VS Code's does.
class Emitter {
  constructor() {
    const listeners = [];
    this.event = (listener) => { listeners.push(listener); return { dispose() {} }; };
    this.fire = (value) => { for (const l of [...listeners]) l(value); };
    this.dispose = () => { listeners.length = 0; };
  }
}
const vscode = { ...baseStub, EventEmitter: Emitter };

const BODY = { id: 'body', label: 'body' };
const change = (relPath, label, startLine, endLine) => ({
  file: `/r/${relPath}`, relPath, label, namePos: startLine * 10, startLine, endLine, component: '(root)',
  kinds: [BODY], throwsAdded: [], stale: [], staleCallers: 0, callerState: 'none', callers: [], score: 1,
  testState: 'covered', tests: ['spec'],
});

// src/a.ts: `Holder` (10–40) holds `Holder.inner` (20–25); its outside lines are 1–3 and
// 50–52. src/b.ts and src/c.ts one change each; notes.md has no call graph.
function sampleResult() {
  return {
    allChanged: [change('src/a.ts', 'Holder', 10, 40), change('src/a.ts', 'Holder.inner', 20, 25),
      change('src/b.ts', 'quiet', 5, 8), change('src/c.ts', 'other', 5, 8)],
    findings: [], deleted: [], warnings: [], unanalysable: [], untested: [], testUnknown: [],
    outside: [{ file: '/r/src/a.ts', relPath: 'src/a.ts', ranges: [[1, 3], [4.5, 4.5], [50, 52]] }],
    otherFiles: [{ path: 'notes.md', status: 'added' }],
    fileStatus: { 'src/a.ts': 'modified', 'src/b.ts': 'modified', 'src/c.ts': 'modified', 'notes.md': 'added' },
    testReachComputed: true, reachDepth: 2, mode: 'branch', requestedMode: 'branch', base: { ref: 'origin/main', sha: '0123456789' },
    changedFileCount: 4,
  };
}

const comment = (id, over = {}) => ({ id: `C_${id}`, databaseId: id, author: { login: 'bob', avatarUrl: null }, body: `body ${id}`,
  createdAt: '2026-01-02T03:04:05Z', pending: false, mine: false, url: `https://x/${id}`, ...over });
const thread = (id, over = {}, comments = [comment(id)]) => ({ id: `T_${id}`, path: 'src/a.ts', side: 'RIGHT', line: 12,
  originalLine: 12, startLine: null, isResolved: false, isOutdated: false, fileLevel: false,
  canResolve: true, canUnresolve: false, canReply: true, originalCode: null, comments, ...over });
const mine = (id) => comment(id, { pending: true, mine: true });

// The threads of the sample, by where they belong.
const THREADS = [
  thread(1, { line: 22 }),                                    // inner: the innermost change wins
  thread(2, { line: 10 }),                                    // Holder's first line
  thread(3, { line: 40 }),                                    // Holder's last line
  thread(4, { line: 41 }),                                    // in no change and no outside range: the file only
  thread(5, { line: 52 }),                                    // the outside row's last line
  thread(6, { side: 'LEFT', line: 22 }),                      // base side: the file only
  thread(7, { isOutdated: true, line: null, originalLine: 22, originalCode: '  return 1;' }),   // the file only
  thread(8, { fileLevel: true, line: null, originalLine: null }),                               // the file only
  thread(9, { line: 21, isResolved: true }),                  // resolved: not counted
  thread(10, { line: 23 }, [mine(10)]),                       // only a pending comment: ✎, not 💬
  thread(11, { line: 1 }, [comment(11), mine(12)]),           // outside, posted with a pending reply
];

function view(result = sampleResult(), threads = { status: 'ready', threads: THREADS }) {
  const known = { value: threads };
  const provider = createTreeProvider(vscode, {
    getState: () => ({ result, rowDetail: 'hover', rel: (f) => f.replace('/r/', ''), absPath: (p) => `/r/${p}` }),
    resolver: { incomingWithStatus: async () => ({ callers: [], complete: true }) },
    getThreads: () => known.value,
  });
  const events = [], presentations = [], threadEvents = [];
  provider.onDidChangeTreeData((row) => events.push(row));
  provider.onDidChangePresentation((e) => presentations.push(e.reason));
  provider.onDidChangeThreads((e) => threadEvents.push(e));
  const roots = async () => (await provider.getChildren()).filter((r) => r.type === 'reviewFile' || r.type === 'file');
  const fileAt = async (relPath) => (await roots()).find((f) => f.relPath === relPath);
  const rowsOf = async (file) => (await provider.getChildren(file)).filter((r) => r.type !== 'spacer');
  const rowAt = async (relPath, label) => (await rowsOf(await fileAt(relPath))).find((r) => r.label === label);
  const describe = (row) => provider.getTreeItem(row).description;
  /** Replaces what the store says and tells the provider, as the extension does on a store event. */
  const publish = (next, paths = null) => { known.value = next; provider.threadsChanged(paths); };
  return { provider, events, presentations, threadEvents, roots, fileAt, rowsOf, rowAt, describe, publish };
}

const fileRowsOf = (result = sampleResult()) => buildFileRows(result, { uriOf: () => null, absPath: (p) => `/r/${p}` }).rows;

// ---- pure ---------------------------------------------------------------------------------

test('a thread belongs to the innermost change holding its line, else the outside row, and always to its file', () => {
  const files = fileRowsOf();
  const a = files.find((f) => f.relPath === 'src/a.ts');
  const byRow = assignFileThreads(a, THREADS);
  const ids = (label) => (byRow.get(a.rows.find((r) => r.label === label)) || []).map((t) => t.id);
  assert.deepEqual(ids('Holder.inner'), ['T_1', 'T_9', 'T_10']);
  assert.deepEqual(ids('Holder'), ['T_2', 'T_3'], 'both boundary lines are inside');
  assert.deepEqual(ids('Outside functions'), ['T_5', 'T_11']);
  assert.deepEqual(byRow.get(a).map((t) => t.id), THREADS.map((t) => t.id), 'the file row has every thread of its path');
  const notes = files.find((f) => f.relPath === 'notes.md');
  assert.deepEqual([...assignFileThreads(notes, [thread(20, { path: 'notes.md', fileLevel: true, line: null })]).keys()], [notes]);
  assert.equal(assignFileThreads(files.find((f) => f.relPath === 'src/b.ts'), THREADS).size, 0, 'other paths are ignored');
});

test('counts: unresolved threads someone posted in, and the viewer\'s pending comments', () => {
  assert.deepEqual(countThreads(THREADS), { open: 9, pending: 2 });
  assert.deepEqual(describeThreadCounts({ open: 2, pending: 1 }), ['💬 2', '✎ 1']);
  assert.deepEqual(describeThreadCounts({ open: 0, pending: 3 }), ['✎ 3']);
  assert.deepEqual(describeThreadCounts({ open: 0, pending: 0 }), []);
  assert.deepEqual(describeThreadCounts(null), []);
});

test('the store\'s state: loading and failed are never zero threads', () => {
  const TARGET = { owner: 'o', name: 'r', number: 7, headOid: 'a'.repeat(40) };
  const model = { threads: THREADS };
  assert.deepEqual(threadsViewOf({ kind: 'none' }), { status: 'none' });
  assert.deepEqual(threadsViewOf({ kind: 'loading', target: TARGET, previous: null }), { status: 'loading' });
  assert.deepEqual(threadsViewOf({ kind: 'loading', target: TARGET, previous: model }), { status: 'ready', threads: THREADS },
    'a reload keeps showing the threads it is reloading');
  assert.deepEqual(threadsViewOf({ kind: 'ready', target: TARGET, model }), { status: 'ready', threads: THREADS });
  assert.deepEqual(threadsViewOf({ kind: 'failed', target: TARGET, error: new Error('timeout'), previous: model }),
    { status: 'failed', message: 'timeout' }, 'an older load is not shown as current');
});

test('the message adds the pull request\'s counts when not zero, or that threads were not loaded', () => {
  const result = sampleResult();
  const source = { kind: 'pr', pr: { number: 7 } };
  const counts = { total: 5, left: 5, attention: 0 };
  const message = (threads, filter) => buildReviewSummary(result, source, counts, filter, threadsMessageSuffix(threads)).message;
  assert.equal(message({ status: 'ready', threads: THREADS }), 'PR #7 · ⛔ 0 · 5 of 5 left · 💬 9 · ✎ 2');
  assert.equal(message({ status: 'ready', threads: THREADS }, 'threads'), 'PR #7 · ⛔ 0 · 5 of 5 left · 💬 9 · ✎ 2 · filter: unresolved threads');
  assert.equal(message({ status: 'ready', threads: [thread(1, { isResolved: true })] }), 'PR #7 · ⛔ 0 · 5 of 5 left');
  assert.equal(message({ status: 'ready', threads: [thread(1, {}, [mine(1)])] }), 'PR #7 · ⛔ 0 · 5 of 5 left · ✎ 1');
  assert.equal(message({ status: 'loading' }), 'PR #7 · ⛔ 0 · 5 of 5 left');
  assert.equal(message({ status: 'failed', message: 'x' }), 'PR #7 · ⛔ 0 · 5 of 5 left · ⚠ threads not loaded');
  assert.equal(message({ status: 'none' }), 'PR #7 · ⛔ 0 · 5 of 5 left');
});

test('the threads filter keeps rows with unresolved threads, and files whose only ones are on no row', () => {
  const files = fileRowsOf();
  const threads = [
    thread(1, { line: 22 }), thread(9, { line: 11, isResolved: true }), thread(10, { line: 30 }, [mine(10)]),
    thread(20, { path: 'src/b.ts', isOutdated: true, line: null, originalLine: 6 }),
    thread(21, { path: 'src/c.ts', line: 6, isResolved: true }),
    thread(22, { path: 'notes.md', fileLevel: true, line: null }),
  ];
  const index = new Map(files.map((f) => [f, assignFileThreads(f, threads)]));
  const openOf = (row) => {
    const file = files.find((f) => f === row || (f.rows || []).includes(row));
    return countThreads(index.get(file).get(row) || []).open;
  };
  const kept = filterFileRows(files, 'threads', () => false, openOf);
  assert.deepEqual(kept.map((e) => [e.file.relPath, e.rows.map((r) => r.label)]), [
    ['src/a.ts', ['Holder.inner']],
    ['src/b.ts', []],                 // only an outdated thread: the file, without rows
    ['notes.md', ['notes.md']],       // a file without a call graph is its own row
  ], 'resolved-only (src/c.ts) and pending-only threads (Holder) do not count');
  assert.deepEqual(filterFileRows(files, 'threads', () => false), [], 'nothing passes while the counts are not known');
});

// ---- the provider -------------------------------------------------------------------------

test('rows show their counts: file rows after the attention glyph, change and outside rows after the verdict', async () => {
  const v = view(sampleResult(), { status: 'ready', threads: [...THREADS, thread(30, { path: 'notes.md', fileLevel: true, line: null })] });
  assert.equal(v.describe(await v.fileAt('src/a.ts')), '💬 9  ·  ✎ 2  ·  0/3  ·  src');
  // the verdict glyph, then the counts
  assert.match(v.describe(await v.rowAt('src/a.ts', 'Holder.inner')), /^in Holder  ·  \S+  ·  💬 1  ·  ✎ 1$/);
  assert.match(v.describe(await v.rowAt('src/a.ts', 'Holder')), /^\S+  ·  💬 2$/);
  const outside = await v.rowAt('src/a.ts', 'Outside functions');
  assert.equal(v.describe(outside), `${outside.desc}  ·  💬 2  ·  ✎ 1`);
  assert.equal(v.describe(await v.fileAt('src/b.ts')), '0/1  ·  src', 'no threads: no counts');
  assert.equal(v.describe(await v.fileAt('notes.md')), '💬 1  ·  no call graph');
});

test('loading and failed threads show no counts, never zeros', async () => {
  for (const known of [{ status: 'loading' }, { status: 'failed', message: 'timeout' }, { status: 'none' }]) {
    const v = view(sampleResult(), known);
    const a = await v.fileAt('src/a.ts');
    assert.equal(v.describe(a), '0/3  ·  src', known.status);
    for (const row of await v.rowsOf(a)) assert.doesNotMatch(v.describe(row), /💬|✎/, `${known.status} ${row.label}`);
    assert.equal(v.provider.threadsOfRow(a), null, 'unknown, not empty');
  }
});

test('a change of the threads repaints only the file rows it names, and never refreshes the whole view', async () => {
  const v = view();
  const [a, b] = ['src/a.ts', 'src/b.ts'];
  const files = await v.roots();
  const fileOf = (p) => files.find((f) => f.relPath === p);
  v.publish({ status: 'ready', threads: [...THREADS, thread(40, { path: b, line: 6 })] }, [b]);
  assert.deepEqual(v.events, [fileOf(b)]);
  assert.equal(v.describe(fileOf(b)), '💬 1  ·  0/1  ·  src');
  assert.match(v.describe((await v.rowsOf(fileOf(b)))[0]), /💬 1$/);
  v.events.length = 0;
  v.publish({ status: 'ready', threads: THREADS }, []);
  assert.deepEqual(v.events, [], 'nothing per file changed (only pull-request-wide data)');
  v.publish({ status: 'ready', threads: THREADS }, null);
  assert.deepEqual(v.events, files, 'every shown file row, one by one: no root refresh');
  v.events.length = 0;
  v.publish({ status: 'failed', message: 'timeout' }, []);
  assert.deepEqual(v.events, files, 'the counts go away from every file');
  assert.equal(v.describe(fileOf(a)), '0/3  ·  src');
  v.events.length = 0;
  v.publish({ status: 'failed', message: 'timeout again' }, []);
  assert.deepEqual(v.events, [], 'still failed: nothing to repaint');
  assert.deepEqual(v.presentations, [], 'no refresh(): neither analysis nor filter');
  assert.equal(v.threadEvents.length, 5, 'the summary and Details hear of every change');
  assert.ok(!v.events.includes(undefined));
});

test('the threads filter: its rows, its empty states, root repaints only when files come or go, and reset when there are no threads', async () => {
  const threads = [thread(1, { line: 22 }), thread(20, { path: 'src/c.ts', fileLevel: true, line: null })];
  const v = view(sampleResult(), { status: 'ready', threads });
  v.provider.toggleFilter('threads');
  assert.deepEqual(v.presentations, ['filter']);
  const shown = await v.roots();
  assert.deepEqual(shown.map((f) => f.relPath), ['src/a.ts', 'src/c.ts']);
  assert.deepEqual((await v.provider.getChildren(shown[0])).map((r) => r.label), ['Holder.inner', ''], 'the row with threads, then the gap');
  assert.deepEqual(await v.provider.getChildren(shown[1]), [], 'a file-level thread only: the file row without rows or gap');
  assert.match(v.provider.summarize().message, / · 💬 2 · filter: unresolved threads$/);

  v.events.length = 0;
  v.publish({ status: 'ready', threads: [...threads, thread(2, { line: 12 })] }, ['src/a.ts']);
  assert.deepEqual(v.events, [shown[0]], 'same files: the one file');
  v.publish({ status: 'ready', threads: [thread(1, { line: 22 })] }, ['src/c.ts']);
  assert.deepEqual(v.events.at(-1), undefined, 'src/c.ts left the filter: the root');
  assert.deepEqual((await v.roots()).map((f) => f.relPath), ['src/a.ts']);

  v.publish({ status: 'ready', threads: [] }, ['src/a.ts']);
  assert.deepEqual((await v.provider.getChildren()).map((r) => r.label), ['No unresolved threads']);
  v.publish({ status: 'failed', message: 'x' }, []);
  assert.deepEqual((await v.provider.getChildren()).map((r) => r.label), ['The review threads could not be loaded']);
  v.publish({ status: 'loading' }, null);
  assert.deepEqual((await v.provider.getChildren()).map((r) => r.label), ['Loading the review threads…']);
  assert.equal(v.provider.getFilter(), 'threads');
  v.publish({ status: 'none' }, null);
  assert.equal(v.provider.getFilter(), 'all', 'a review without threads cannot keep the filter on');
  assert.deepEqual(v.presentations, ['filter', 'filter']);
});

test('next unreviewed under the threads filter walks only rows with unresolved threads', async () => {
  const v = view(sampleResult(), { status: 'ready', threads: [thread(1, { line: 22 }), thread(2, { path: 'src/b.ts', line: 6 })] });
  v.provider.toggleFilter('threads');
  const first = v.provider.nextUnreviewed(null);
  assert.equal(first.label, 'Holder.inner');
  assert.equal(v.provider.nextUnreviewed(first).label, 'quiet');
});

// ---- the Details section model ------------------------------------------------------------

test('the Threads section: each thread\'s author, first line, place, comments and status; outdated ones keep their code', () => {
  const files = fileRowsOf();
  const a = files.find((f) => f.relPath === 'src/a.ts');
  const inner = a.rows.find((r) => r.label === 'Holder.inner');
  const threads = [
    thread(1, { line: 22 }, [comment(1, { body: '\n  Why not reuse x?  \nmore text' }), comment(2)]),
    thread(9, { line: 21, isResolved: true }, [comment(9, { author: null })]),
    thread(10, { line: 23 }, [mine(10)]),
  ];
  const section = buildThreadSection(inner, { status: 'ready', threads }, threads);
  assert.deepEqual(section, {
    title: 'Threads (3)', note: null, action: { target: 'change', label: 'Comment on this change' },
    threads: [
      { id: 'T_1', author: 'bob', firstLine: 'Why not reuse x?', location: 'line 22', commentCount: 2, status: 'Unresolved', outdated: false, originalCode: null },
      { id: 'T_9', author: 'ghost', firstLine: 'body 9', location: 'line 21', commentCount: 1, status: 'Resolved', outdated: false, originalCode: null },
      { id: 'T_10', author: 'bob', firstLine: 'body 10', location: 'line 23', commentCount: 1, status: 'Pending', outdated: false, originalCode: null },
    ],
  });
  const fileThreads = [
    thread(7, { isOutdated: true, line: null, originalLine: 22, originalCode: '  return 1;' }),
    thread(8, { fileLevel: true, line: null, originalLine: null }),
    thread(6, { side: 'LEFT', line: 9 }),
    thread(5, { isOutdated: true, line: null, originalLine: null, originalCode: null, isResolved: true }),
  ];
  const fileSection = buildThreadSection(a, { status: 'ready', threads: fileThreads }, fileThreads);
  assert.deepEqual(fileSection.threads.map((t) => [t.location, t.status, t.outdated, t.originalCode]), [
    ['line 22', 'Unresolved', true, '  return 1;'],
    ['file comment', 'Unresolved', false, null],
    ['old line 9', 'Unresolved', false, null],
    ['line unknown', 'Resolved', true, null],
  ]);
  assert.deepEqual(fileSection.action, { target: 'file', label: 'Comment on this file' });
  const outside = a.rows.find((r) => r.type === 'outside');
  assert.deepEqual(buildThreadSection(outside, { status: 'ready', threads: [] }, []),
    { title: 'Threads (0)', threads: [], note: 'No threads yet.', action: { target: 'lines', label: 'Comment on these lines' } });
  const long = buildThreadSection(inner, { status: 'ready', threads: [] }, [thread(3, {}, [comment(3, { body: 'x'.repeat(200) })])]);
  assert.equal(long.threads[0].firstLine, `${'x'.repeat(119)}…`);
});

test('the Threads section says when threads are loading or not loaded, offers no comment then, and is absent without a pull request', () => {
  const [a] = fileRowsOf();
  assert.deepEqual(buildThreadSection(a, { status: 'loading' }, []), { title: 'Threads', threads: [], note: 'Loading the review threads…', action: null });
  assert.deepEqual(buildThreadSection(a, { status: 'failed', message: 'timeout' }, []), { title: 'Threads', threads: [], action: null,
    note: 'The review threads could not be loaded: timeout. This does not mean there are none. Refresh to try again.' });
  assert.equal(buildThreadSection(a, { status: 'none' }, []), null);
  assert.equal(buildThreadSection(null, { status: 'ready', threads: [] }, []), null);
  assert.equal(buildThreadSection({ type: 'deleted', relPath: 'src/a.ts', label: 'gone' }, { status: 'ready', threads: [] }, []), null);
});
