'use strict';
// Pyright's project for a repository (src/languages/python/pyright-project.js, A7):
// `pyrightconfig.json` (JSON with comments) wins over `[tool.pyright]` in pyproject.toml,
// `include`/`exclude` globs as Pyright reads them, and a config that cannot be read or
// parsed is "unknown", never a guess. Files are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pp = require('../src/languages/python/pyright-project');

const R = '/r';
/** @param {Record<string, string|Error>} files Name in R → text, or an error to throw. */
const reader = (files) => (/** @type {string} */ abs) => {
  const v = files[path.relative(R, abs)];
  if (v instanceof Error) throw v;
  return v === undefined ? null : v;
};

test('pyrightconfig.json with comments and trailing commas', () => {
  const p = /** @type {any} */ (pp.readPyrightProject(R, reader({
    'pyrightconfig.json': '{\n  // what is analysed\n  "include": ["src", /* and */ "tests/a.py",],\n  "exclude": ["src/gen"],\n  "x": "a // not a comment",\n}\n',
  })));
  assert.equal(p.configFile, 'pyrightconfig.json');
  assert.deepEqual(p.include, ['src', 'tests/a.py']);
  assert.deepEqual(p.exclude, ['src/gen']);
  assert.equal(p.inProject('src/m.py'), true);
  assert.equal(p.inProject('src/gen/m.py'), false);
  assert.equal(p.inProject('tests/a.py'), true);
  assert.equal(p.inProject('tests/b.py'), false);
});

test('pyproject [tool.pyright]: arrays across lines, comments, both quote styles; the next table ends it', () => {
  const toml = [
    '[project]', 'include = ["not this"]', '',
    '[tool.pyright]',
    "include = [",
    "  'pydantic',  # the package",
    '  "tests/test_pipeline.py",',
    ']',
    "exclude = ['pydantic/v1', 'pydantic/mypy.py']",
    "strict = ['tests/test_pipeline.py']",
    '',
    '[tool.codespell]', "exclude = ['x']",
  ].join('\n');
  const p = /** @type {any} */ (pp.readPyrightProject(R, reader({ 'pyproject.toml': toml })));
  assert.equal(p.configFile, 'pyproject.toml [tool.pyright]');
  assert.deepEqual(p.include, ['pydantic', 'tests/test_pipeline.py']);
  assert.deepEqual(p.exclude, ['pydantic/v1', 'pydantic/mypy.py']);
  assert.equal(p.explicit, true);
  assert.equal(p.inProject('tests/test_main.py'), false);
  assert.equal(p.inProject('pydantic/main.py'), true);
  assert.equal(p.inProject('pydantic/v1/main.py'), false);
});

test('both present: pyrightconfig.json wins; neither, or no [tool.pyright]: no project limit', () => {
  const both = /** @type {any} */ (pp.readPyrightProject(R, reader({ 'pyrightconfig.json': '{"include": ["a"]}', 'pyproject.toml': "[tool.pyright]\ninclude = ['b']\n" })));
  assert.deepEqual(both.include, ['a']);
  assert.equal(pp.readPyrightProject(R, reader({})), null);
  assert.equal(pp.readPyrightProject(R, reader({ 'pyproject.toml': '[project]\nname = "x"\n' })), null);
  // A table with neither key: Pyright's defaults, nothing explicit.
  const none = /** @type {any} */ (pp.readPyrightProject(R, reader({ 'pyproject.toml': '[tool.pyright]\nstrict = ["a"]\n' })));
  assert.equal(none.explicit, false);
  assert.equal(none.inProject('a/b.py'), true);
  assert.equal(none.inProject('node_modules/x.py'), false);
  assert.equal(none.inProject('.venv/x.py'), false);
});

test('a config that cannot be read or parsed is an unknown project, with its error', () => {
  for (const files of [
    { 'pyrightconfig.json': new Error('EACCES') },
    { 'pyrightconfig.json': '{ "include": [' },
    { 'pyrightconfig.json': '{ "include": "src" }' },
    { 'pyproject.toml': '[tool.pyright]\ninclude = [1, 2]\n' },
    { 'pyproject.toml': "[tool.pyright]\ninclude = ['a',\n" },
    { 'pyproject.toml': '[tool.pyright]\ninclude = "a"\n' },
  ]) {
    const p = /** @type {any} */ (pp.readPyrightProject(R, reader(/** @type {any} */ (files))));
    assert.ok(p && typeof p.error === 'string' && p.error.length, JSON.stringify(Object.values(files).map(String)));
    assert.equal('inProject' in p, false);
  }
});

test('the default read: absent is null, a file past CONFIG_MAX_BYTES is unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyproj-'));
  try {
    assert.equal(pp.readPyrightProject(dir), null);
    fs.writeFileSync(path.join(dir, 'pyrightconfig.json'), ' '.repeat(pp.CONFIG_MAX_BYTES + 1));
    assert.match(String(/** @type {any} */ (pp.readPyrightProject(dir)).error), /larger than/);
    fs.writeFileSync(path.join(dir, 'pyrightconfig.json'), '{"include": ["src"]}');
    assert.equal(/** @type {any} */ (pp.readPyrightProject(dir)).inProject('src/a.py'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('globs: **, *, ?, directory prefixes, ./ and trailing /', () => {
  const m = (/** @type {string} */ spec, /** @type {string} */ p) => pp.globToRegExp(spec).test(p);
  assert.equal(m('src', 'src/a/b.py'), true);
  assert.equal(m('src', 'srcx/a.py'), false);
  assert.equal(m('./src/', 'src/a.py'), true);
  assert.equal(m('.', 'anything/a.py'), true);
  assert.equal(m('**/node_modules', 'a/b/node_modules/x.py'), true);
  assert.equal(m('**/node_modules', 'node_modules/x.py'), true);
  assert.equal(m('**/.*', 'a/.venv/x.py'), true);
  assert.equal(m('**/.*', 'a/b.py'), false);
  assert.equal(m('tests/*.py', 'tests/a.py'), true);
  assert.equal(m('tests/*.py', 'tests/sub/a.py'), false);
  assert.equal(m('tests/**/*.py', 'tests/sub/deep/a.py'), true);
  assert.equal(m('tests/**/*.py', 'tests/a.py'), true);
  assert.equal(m('test_?.py', 'test_a.py'), true);
  assert.equal(m('test_?.py', 'test_ab.py'), false);
  assert.equal(m('a.b', 'axb'), false);
  assert.equal(m('tests/**', 'tests/x/y.py'), true);
});

test('parseJsonc keeps // and /* inside strings', () => {
  assert.deepEqual(pp.parseJsonc('{"a": "http://x/*y*/", /* c */ "b": [1,],}'), { a: 'http://x/*y*/', b: [1] });
});
