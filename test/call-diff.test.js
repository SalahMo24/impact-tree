'use strict';
// The calls a changed function gained and lost, read from its text and its diff hunks.

const test = require('node:test');
const assert = require('node:assert/strict');
const { callDiff, callsOn, MAX_CALLS } = require('../src/engine/call-diff');

test('a name followed by ( is a call; keywords, declarations, strings and comments are not', () => {
  assert.deepEqual(callsOn('  if (ok(x)) return this.repo.save(row, fmt("a(b)")); // log(x)'), ['ok', 'this.repo.save', 'fmt']);
  assert.deepEqual(callsOn('function helper(a) { return new Error(String(a)); }'), ['Error']);
  assert.deepEqual(callsOn('const v = await load<Row[]>(id).then(parse);'), ['load']);
  assert.deepEqual(callsOn('    data = client.get(url)  # retry(3)', { hashComments: true }), ['client.get']);
  assert.deepEqual(callsOn('def fetch(url):', { hashComments: true }), []);
  assert.deepEqual(callsOn('func (s *Store) Save(r Row) error {'), []);
  assert.deepEqual(callsOn('  public void save(Row r) {', { self: 'save' }), [], 'the function\'s own name is left out');
  assert.deepEqual(callsOn('  x?.y?.z(1)'), ['x.y.z']);
});

test('the language\'s own helpers and calls on an expression\'s result are left out', () => {
  assert.deepEqual(callsOn('  return rows.filter(ok).map((r) => fmt(r)).join(JSON.stringify(sep));'), ['fmt']);
  assert.deepEqual(callsOn('  return effect.pipe(Effect.map(toRow), Effect.mapError(wrap));'), ['Effect.map', 'Effect.mapError']);
  assert.deepEqual(callsOn('  if words.split(" ")[0].startswith(x): n = len(store.rows())', { hashComments: true }), ['store.rows']);
  assert.deepEqual(callsOn('  cache.get(id); cache.set(id, v); this.save(v)'), ['cache.get', 'cache.set', 'this.save'], 'get and set on a named receiver are kept');
});

// A TypeScript function: line 1 to 6 at the head. The base called validate and write; the head
// calls validate, checks the cache, and writes through retry.
const HEAD = [
  'export function save(row) {',
  '  validate(row);',
  '  if (cache.has(row.id)) return cache.get(row.id);',
  '  const out = retry(() => write(row));',
  '  return out;',
  '}',
  'function other() { log(1); }',
].join('\n');
const HUNK = [
  '@@ -1,5 +1,6 @@',
  ' export function save(row) {',
  '   validate(row);',
  '-  const out = write(row);',
  '-  audit(row);',
  '+  if (cache.has(row.id)) return cache.get(row.id);',
  '+  const out = retry(() => write(row));',
  '   return out;',
  ' }',
].join('\n');

test('gained and lost calls of one function; a call kept on a rewritten line is neither', () => {
  assert.deepEqual(callDiff({ headText: HEAD, hunks: HUNK, startLine: 1, endLine: 6, self: 'save' }),
    { added: ['cache.has', 'cache.get', 'retry'], removed: ['audit'], addedMore: 0, removedMore: 0 });
});

test('only the function\'s own lines count; a hunk outside it gives null', () => {
  const outside = '@@ -7,1 +7,1 @@\n-function other() { trace(1); }\n+function other() { log(1); }';
  assert.equal(callDiff({ headText: HEAD, hunks: outside, startLine: 1, endLine: 6 }), null);
  const both = `${HUNK}\n${outside.replace('@@ -7,1 +7,1 @@', '@@ -6,1 +7,1 @@')}`;
  assert.deepEqual(callDiff({ headText: HEAD, hunks: both, startLine: 1, endLine: 6, self: 'save' }).removed, ['audit'], 'trace, removed in other(), is not this function\'s');
});

test('a new function: every call is gained', () => {
  const head = 'def fetch(url):\n    r = client.get(url)\n    return parse(r)  # not cached(r)';
  const hunk = '@@ -0,0 +1,3 @@\n+def fetch(url):\n+    r = client.get(url)\n+    return parse(r)  # not cached(r)';
  assert.deepEqual(callDiff({ headText: head, hunks: hunk, startLine: 1, endLine: 3, self: 'fetch', hashComments: true }),
    { added: ['client.get', 'parse'], removed: [], addedMore: 0, removedMore: 0 });
});

test('a call still made elsewhere in the body is not lost; long lists are cut and counted', () => {
  const head = 'function f() {\n  a();\n  b();\n}';
  const hunk = '@@ -1,4 +1,4 @@\n function f() {\n-  a(); a();\n+  a();\n   b();\n }';
  assert.deepEqual(callDiff({ headText: head, hunks: hunk, startLine: 1, endLine: 4 }), { added: [], removed: [], addedMore: 0, removedMore: 0 });
  const many = Array.from({ length: MAX_CALLS + 3 }, (_, i) => `  c${i}();`);
  const h2 = `function g() {\n${many.join('\n')}\n}`;
  const d = callDiff({ headText: h2, hunks: `@@ -1,2 +1,${many.length + 2} @@\n function g() {\n${many.map((l) => `+${l}`).join('\n')}\n }`, startLine: 1, endLine: many.length + 2 });
  assert.equal(d.added.length, MAX_CALLS);
  assert.equal(d.addedMore, 3);
});
