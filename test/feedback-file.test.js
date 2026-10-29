'use strict';
// Feedback round file: render/parse round-trips, statuses, naming, hunks, shell quoting,
// and the fs adapter on a temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const f = require('../src/feedback/feedback-file');
const io = require('../src/feedback/feedback-files-io');

const item = (id, extra = {}) => ({
  id, file: 'src/session.js', line: 212, symbol: 'runAnalysis', caller: null,
  quote: '} catch { /* ignore */ }', body: "Don't swallow errors here.", createdAtMs: 1, ...extra,
});
const NOW = Date.UTC(2026, 9, 20, 11, 32);
const render = (items, extra = {}) => f.renderRound({
  round: 2, sentAtMs: NOW, branch: 'feat/x', modeLabel: 'Uncommitted (agent)', checkpointSha: 'abc123', items,
  timeZone: 'Africa/Cairo', ...extra,
});
// Fill the Nth (zero-based) template "Status:" line that ends an item.
const fill = (text, n, value) => {
  let seen = -1;
  return text.replace(/^Status:.*$/gm, (m) => (++seen === n ? `Status:${value}` : m));
};

test('render matches the F3 format', () => {
  const text = render([item('a1', { caller: { label: 'caller()', file: 'src/x.js', line: 7 } }), item('b2', { line: null, symbol: null })], { branch: null });
  assert.equal(text, [
    '# Feedback round 2 · 2026-10-20 14:32',
    '<!-- impact-tree feedback v1 round=2 checkpoint=abc123 -->',
    'Branch: detached HEAD · Reviewed: Uncommitted (agent)',
    '',
    'For the agent: address each item. Under each one, write `Status: done` or',
    "`Status: skipped — reason`. Don't change anything else in this file.",
    '',
    '## 1. src/session.js:212 · runAnalysis',
    '<!-- item id=a1 -->',
    '> } catch { /* ignore */ }',
    '> caller: src/x.js:7 · caller()',
    "Don't swallow errors here.",
    'Status:',
    '',
    '## 2. src/session.js',
    '<!-- item id=b2 -->',
    '> } catch { /* ignore */ }',
    "Don't swallow errors here.",
    'Status:',
    '',
  ].join('\n'));
  assert.match(render([], { checkpointSha: null }), /checkpoint=none -->/);
});

test('render rejects invalid input', () => {
  assert.throws(() => render([item('bad id')]), TypeError);
  assert.throws(() => render([item('')]), TypeError);
  assert.throws(() => render([item('x'.repeat(65))]), TypeError);
  assert.throws(() => render([item('a'), item('a')]), /duplicate/);
  assert.throws(() => render([item('a', { line: 0 })]), TypeError);
  assert.throws(() => render([], { round: 0 }), TypeError);
  assert.throws(() => render([], { checkpointSha: 'zzzz' }), TypeError);
  assert.throws(() => render([item('a', { body: 'x'.repeat(10001) })]), RangeError);
});

test('round-trip: done, skipped (each dash style), none, unreadable', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  let text = render(ids.map((id) => item(id)));
  ['  done', ' DONE.', ' skipped — not needed', ' skipped - not needed', ' skipped: not needed', ' skipped', ' partly', ''].forEach((v, i) => { text = fill(text, i, v); });
  const p = f.parseRound(text);
  assert.equal(p.ok, true);
  assert.equal(p.round, 2);
  assert.equal(p.checkpointSha, 'abc123');
  const m = f.statusesFor(ids, p);
  assert.equal(m.get('a').status, 'done');
  assert.equal(m.get('b').status, 'done');
  for (const id of ['c', 'd', 'e']) assert.deepEqual(m.get(id), { status: 'skipped', reason: 'not needed' });
  assert.deepEqual(m.get('f'), { status: 'skipped', reason: null });
  assert.equal(m.get('g').status, 'unreadable');
  assert.deepEqual(m.get('h'), { status: 'none', reason: null });
});

test('done with trailing comment is done; "doneish" is not', () => {
  const ids = ['a', 'b'];
  let text = render(ids.map((id) => item(id)));
  text = fill(fill(text, 0, ' done — fixed in 3 places'), 1, ' doneish');
  const m = f.statusesFor(ids, f.parseRound(text));
  assert.equal(m.get('a').status, 'done');
  assert.equal(m.get('b').status, 'unreadable');
});

test('conflicting or duplicate status lines are unreadable', () => {
  const text = render([item('a')]).replace(/^Status:$/m, 'Status: done\nStatus: skipped — no');
  assert.equal(f.statusesFor(['a'], f.parseRound(text)).get('a').status, 'unreadable');
  const same = render([item('a')]).replace(/^Status:$/m, 'Status: done\nStatus: done');
  assert.equal(f.statusesFor(['a'], f.parseRound(same)).get('a').status, 'done');
  const dup = render([item('a')]);
  const twice = `${dup}\n${dup.split('\n').slice(7).join('\n')}`;
  assert.equal(f.statusesFor(['a'], f.parseRound(fill(twice, 0, ' done'))).get('a').status, 'unreadable');
});

test('missing marker and missing/unknown header', () => {
  const text = fill(render([item('a'), item('b')]), 0, ' done').replace('<!-- item id=b -->', '');
  const p = f.parseRound(text);
  const m = f.statusesFor(['a', 'b', 'zzz'], p);
  assert.equal(m.get('a').status, 'done');
  assert.deepEqual(m.get('b'), { status: 'unreadable', reason: 'item marker missing' });
  assert.deepEqual(m.get('zzz'), { status: 'unreadable', reason: 'item marker missing' });

  const noHeader = text.replace(/^<!-- impact-tree.*$/m, '');
  assert.deepEqual(f.parseRound(noHeader), { ok: false, reason: 'header marker missing' });
  const v2 = text.replace('feedback v1', 'feedback v2');
  assert.deepEqual(f.parseRound(v2), { ok: false, reason: 'unknown format version' });
  assert.equal(f.parseRound(text.replace('round=2', 'round=x')).ok, false);
  for (const [id, s] of f.statusesFor(['a'], f.parseRound(noHeader))) {
    assert.equal(id, 'a');
    assert.equal(s.status, 'unreadable');
    assert.equal(s.reason, 'header marker missing');
  }
});

test('CRLF files parse the same', () => {
  const text = fill(fill(render([item('a'), item('b')]), 0, ' done'), 1, ' skipped — later').replace(/\n/g, '\r\n');
  const m = f.statusesFor(['a', 'b'], f.parseRound(text));
  assert.equal(m.get('a').status, 'done');
  assert.deepEqual(m.get('b'), { status: 'skipped', reason: 'later' });
});

test('body that looks like structure is neutralised', () => {
  const body = 'First\n## 2. fake.js\n<!-- item id=fake -->\n<!-- impact-tree feedback v1 round=9 checkpoint=none -->\nStatus: done\n   status: done\nlast';
  const text = render([item('a', { body }), item('b')]);
  const p = f.parseRound(text);
  assert.equal(p.round, 2);
  assert.deepEqual(p.items.map((i) => i.id), ['a', 'b']);
  assert.deepEqual(p.items.map((i) => i.status), ['none', 'none']);
  assert.match(text, /^\\## 2\. fake\.js$/m);
  assert.match(text, /^\\Status: done$/m);
  assert.match(text, /^First$/m);
  // The agent's real answer still lands on the right item.
  assert.equal(f.statusesFor(['a'], f.parseRound(fill(text, 0, ' done'))).get('a').status, 'done');
});

test('quote and single-line fields cannot inject structure', () => {
  const text = render([item('a', { quote: 'x\n## 3. y\nStatus: done', file: 'a\n## 9. b.js', symbol: 'f\nStatus: done' })]);
  const p = f.parseRound(text);
  assert.deepEqual(p.items, [{ id: 'a', status: 'none', reason: null }]);
});

test('size bound', () => {
  assert.deepEqual(f.parseRound('x'.repeat(2 * 1024 * 1024 + 1)), { ok: false, reason: 'too large' });
  assert.equal(f.parseRound('x'.repeat(100)).ok, false);
});

test('statusesFor never yields done without evidence', () => {
  const parsed = { ok: true, round: 1, checkpointSha: null, items: [{ id: 'a', status: 'done', reason: null }] };
  assert.equal(f.statusesFor(['b'], parsed).get('b').status, 'unreadable');
  const failed = f.statusesFor(['a', 'b'], { ok: false, reason: 'too large' });
  for (const s of failed.values()) assert.deepEqual(s, { status: 'unreadable', reason: 'too large' });
});

test('roundFileName and nextRoundNumber', () => {
  assert.equal(f.roundFileName(NOW, 3, 'UTC'), '2026-10-20-3.md');
  assert.equal(f.roundFileName(new Date(Date.UTC(2026, 0, 1, 23, 30)), 1, 'Africa/Cairo'), '2026-01-02-1.md');
  assert.throws(() => f.roundFileName(NOW, 0), TypeError);
  assert.equal(f.nextRoundNumber([]), 1);
  assert.equal(f.nextRoundNumber(['2026-10-18-2.md', '2026-10-19-7.md', '2026-10-20-3.md']), 8);
  assert.equal(f.nextRoundNumber(['notes.md', '2026-10-20-x.md', '2026-10-20-9.txt', '2026-10-20-4.md.bak', 'x2026-10-20-50.md', '2026-10-20-2.md']), 3);
});

test('promptFor is one line; shellQuote survives a real shell', () => {
  const p = f.promptFor({ relPath: '.impact-tree/feedback/2026-10-20-2.md' });
  assert.equal(p, 'Read .impact-tree/feedback/2026-10-20-2.md and address each item. Under each item write "Status: done", or "Status: skipped — <reason>". Do not change anything else in that file.');
  assert.doesNotMatch(p, /[\r\n]/);
  assert.throws(() => f.promptFor({ relPath: 'a\nb' }), TypeError);
  assert.throws(() => f.promptFor({ relPath: '' }), TypeError);
  assert.equal(f.shellQuote("it's"), "'it'\\''s'");
  if (process.platform !== 'win32') {
    for (const s of ["it's", '$HOME `id` $(id)', 'a\nb', '"dq" \\ back', "''", '', p]) {
      assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${f.shellQuote(s)}`], { encoding: 'utf8' }), s);
    }
  }
  assert.throws(() => f.shellQuote('a\0b'), TypeError);
});

test('parseOldHunks reads old-side ranges, count defaults to 1', () => {
  const diff = [
    'diff --git a/x b/x', '--- a/x', '+++ b/x',
    '@@ -5 +5 @@ fn', '-a', '+b',
    '@@ -10,0 +11,2 @@', '+x', '+y',
    '@@ -20,3 +22 @@', '-1', '-2', '-3', '+z',
    '@@@ -1,2 -1,2 +1,2 @@@',
  ].join('\n');
  assert.deepEqual(f.parseOldHunks(diff), [
    { oldStart: 5, oldCount: 1 }, { oldStart: 10, oldCount: 0 }, { oldStart: 20, oldCount: 3 },
  ]);
  assert.deepEqual(f.parseOldHunks(''), []);
});

test('codeChangedNear', () => {
  const near = (hunks, line, window) => f.codeChangedNear({ hunks, line, window });
  assert.equal(near(null, 10), 'unknown');
  assert.equal(near(null, null), 'unknown');
  assert.equal(near([], null), 'unchanged');
  assert.equal(near([{ oldStart: 99, oldCount: 1 }], null), 'changed');
  // insertion directly before the line (after line-1)
  assert.equal(near([{ oldStart: 9, oldCount: 0 }], 10), 'changed');
  assert.equal(near([{ oldStart: 10, oldCount: 0 }], 10), 'changed');
  // inside the window (default 3), and its edges
  assert.equal(near([{ oldStart: 13, oldCount: 1 }], 10), 'changed');
  assert.equal(near([{ oldStart: 14, oldCount: 1 }], 10), 'unchanged');
  assert.equal(near([{ oldStart: 7, oldCount: 1 }], 10), 'changed');
  assert.equal(near([{ oldStart: 6, oldCount: 1 }], 10), 'unchanged');
  // a range ending inside the window
  assert.equal(near([{ oldStart: 1, oldCount: 8 }], 10), 'changed');
  assert.equal(near([{ oldStart: 1, oldCount: 5 }], 10), 'unchanged');
  // insertion past the window / before it
  assert.equal(near([{ oldStart: 14, oldCount: 0 }], 10), 'unchanged');
  assert.equal(near([{ oldStart: 5, oldCount: 0 }], 10), 'unchanged');
  assert.equal(near([{ oldStart: 6, oldCount: 0 }], 10), 'changed');
  assert.equal(near([{ oldStart: 0, oldCount: 0 }], 1), 'changed');
  assert.equal(near([{ oldStart: 12, oldCount: 1 }], 10, 0), 'unchanged');
  // malformed input is unknown, never "unchanged"
  assert.equal(near([{ oldStart: 'x', oldCount: 1 }], 10), 'unknown');
  assert.equal(near([], 0), 'unknown');
});

test('writeRound creates dirs, numbers globally, never overwrites', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'it-feedback-'));
  try {
    const now = Date.UTC(2026, 9, 20, 12, 0);
    const a = await io.writeRound({ repoRoot: root, now, timeZone: 'UTC', render: (n) => `round ${n}\n` });
    assert.equal(a.round, 1);
    assert.equal(a.relPath, '.impact-tree/feedback/2026-10-20-1.md');
    assert.equal(a.absPath, path.join(io.feedbackDir(root), '2026-10-20-1.md'));
    assert.equal(fs.readFileSync(a.absPath, 'utf8'), 'round 1\n');
    // An older file from another date raises the global counter.
    fs.writeFileSync(path.join(io.feedbackDir(root), '2026-01-01-5.md'), 'old');
    const b = await io.writeRound({ repoRoot: root, now, timeZone: 'UTC', render: (n) => `round ${n}\n` });
    assert.equal(b.round, 6);
    assert.equal(fs.readFileSync(a.absPath, 'utf8'), 'round 1\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('writeRound retries on EEXIST and gives up after 5 tries without clobbering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'it-feedback-'));
  try {
    const now = Date.UTC(2026, 9, 20, 12, 0);
    const dir = io.feedbackDir(root);
    fs.mkdirSync(dir, { recursive: true });
    // A listing that hides existing files simulates a race with another writer.
    const racy = { ...fs.promises, readdir: async () => [] };
    fs.writeFileSync(path.join(dir, '2026-10-20-1.md'), 'keep1');
    fs.writeFileSync(path.join(dir, '2026-10-20-2.md'), 'keep2');
    const got = await io.writeRound({ repoRoot: root, now, timeZone: 'UTC', fs: racy, render: (n) => `r${n}` });
    assert.equal(got.round, 3);
    for (let n = 4; n <= 7; n++) fs.writeFileSync(path.join(dir, `2026-10-20-${n}.md`), `keep${n}`);
    await assert.rejects(io.writeRound({ repoRoot: root, now, timeZone: 'UTC', fs: { ...racy, readdir: async () => ['2026-10-20-2.md'] }, render: () => 'x' }), /colliding/);
    assert.equal(fs.readFileSync(path.join(dir, '2026-10-20-1.md'), 'utf8'), 'keep1');
    assert.equal(fs.readFileSync(path.join(dir, '2026-10-20-2.md'), 'utf8'), 'keep2');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('readRound caps size; listRounds sorts, ignores junk, and handles a missing folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'it-feedback-'));
  try {
    assert.deepEqual(await io.listRounds(root), { files: [], truncated: false });
    assert.deepEqual(await io.readRound(path.join(root, 'nope.md')), { ok: false, reason: 'file missing' });
    const dir = io.feedbackDir(root);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ['2026-10-20-10.md', '2026-10-19-2.md', 'README.md', '2026-10-21-1.md']) fs.writeFileSync(path.join(dir, n), 'hi');
    const l = await io.listRounds(root);
    assert.deepEqual(l.files.map((x) => x.round), [1, 2, 10]);
    assert.equal(l.truncated, false);
    assert.equal(l.files[2].relPath, '.impact-tree/feedback/2026-10-20-10.md');
    assert.deepEqual(await io.readRound(l.files[0].absPath), { ok: true, text: 'hi' });
    const big = path.join(dir, '2026-10-22-11.md');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    assert.deepEqual(await io.readRound(big), { ok: false, reason: 'too large' });
    assert.deepEqual(await io.readRound(dir), { ok: false, reason: 'not a file' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('listRounds keeps the newest rounds when there are more than 10 000', async () => {
  const names = Array.from({ length: 10002 }, (_, i) => `2026-10-20-${i + 1}.md`);
  const l = await io.listRounds('/repo', { fs: /** @type {any} */ ({ readdir: async () => names }) });
  assert.equal(l.truncated, true);
  assert.equal(l.files.length, 10000);
  assert.equal(l.files[0].round, 3);
  assert.equal(l.files[l.files.length - 1].round, 10002);
});
