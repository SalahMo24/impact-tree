'use strict';
// Added functions are read by key, like deleted ones (src/engine/changed-symbols.js
// `changedFromSymbols`): a renamed class's methods are added even when their bodies are
// unchanged diff lines (httpx #3741: six `URLPattern.*` deleted, only two
// `WildcardURLPattern.*` reported added), and a renumbered repeat is not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { changedFromSymbols } = require('../src/engine/changed-symbols');

/** Symbols for the `def` lines of `text`, keyed by `prefix + name` with `#n` repeats. */
function symbolsOf(text, prefix) {
  const lines = text.split('\n');
  const starts = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.length + 1; }
  const defs = [];
  lines.forEach((l, i) => { const m = /^\s*def (\w+)/.exec(l); if (m) defs.push({ name: m[1], line: i + 1 }); });
  const seen = new Map();
  return defs.map((d, i) => {
    const endLine = (defs[i + 1] ? defs[i + 1].line : lines.length + 1) - 1;
    const label = `${prefix}${d.name}`;
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    const start = starts[d.line - 1];
    const end = starts[endLine - 1] + lines[endLine - 1].length;
    return { label, key: n === 1 ? label : `${label}#${n}`, simpleName: d.name, namePos: start, start, end,
      startLine: d.line, endLine, span: endLine - d.line, sig: null, throws: new Set(), isConstructor: false };
  });
}
const renderSig = () => '()';
const kindsOf = () => [];
const file = (headText, baseText, hunkRanges) => ({ absPath: '/r/a.py', relPath: 'a.py', status: 'modified', headText, baseText, hunkRanges, hunkDeletions: [] });
const keys = (rows) => rows.map((c) => `${c.key}${c.added ? '+' : ''}`).sort();

const body = 'def matches(self):\n    return 1\ndef priority(self):\n    return 2\n';

test('a renamed class: every method is added, even with no hunk on its lines', () => {
  // Line 1 is the `class` line that changed; the method lines are unchanged in the diff.
  const head = `class New:\n${body}`;
  const base = `class Old:\n${body}`;
  const r = changedFromSymbols(file(head, base, [[1, 1]]), {
    headCallables: symbolsOf(head, 'New.'), baseCallables: symbolsOf(base, 'Old.'), renderSig, kindsOf,
  });
  assert.deepEqual(keys(r.changed), ['New.matches+', 'New.priority+']);
  assert.deepEqual(r.deleted.map((d) => d.key).sort(), ['Old.matches', 'Old.priority']);
});

test('a renumbered repeat with unchanged text is not added; the inserted one is', () => {
  const old = 'def foo():\n    return 1\n';
  const inserted = 'def foo():\n    return 2\n';
  const head = `${inserted}${old}`;
  // The hunk is the inserted function (lines 1-2); the old `foo` is now `foo#2`, untouched.
  const r = changedFromSymbols(file(head, old, [[1, 2]]), {
    headCallables: symbolsOf(head, ''), baseCallables: symbolsOf(old, ''), renderSig, kindsOf,
  });
  assert.deepEqual(keys(r.changed), ['foo'], 'foo#2 is the old foo, unchanged: not a row');
  assert.deepEqual(r.deleted, []);
});

test('without head text the comparison cannot be made: the new key is reported', () => {
  const old = 'def foo():\n    return 1\n';
  const head = `def foo():\n    return 2\n${old}`;
  const r = changedFromSymbols({ ...file(undefined, old, [[1, 2]]) }, {
    headCallables: symbolsOf(head, ''), baseCallables: symbolsOf(old, ''), renderSig, kindsOf,
  });
  assert.deepEqual(keys(r.changed), ['foo', 'foo#2+'], 'more rows, never fewer');
});

test('unchanged: an added function a hunk reaches, and an untouched existing one', () => {
  const base = 'def keep():\n    return 1\n';
  const head = `${base}def fresh():\n    return 3\n`;
  const r = changedFromSymbols(file(head, base, [[3, 4]]), {
    headCallables: symbolsOf(head, ''), baseCallables: symbolsOf(base, ''), renderSig, kindsOf,
  });
  assert.deepEqual(keys(r.changed), ['fresh+']);
});
