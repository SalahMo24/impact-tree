'use strict';
// The CLI's TypeScript resolver (src/engine/resolver-ts.js) keeps its language services' file
// versions: one snapshot for a synchronous stretch of queries (no `statSync` per program file
// per query), and an edited file re-read once the event loop has turned (the MCP server keeps
// the services between tool calls).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');
const { createTsResolver } = require('../src/engine/resolver-ts');

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

test('TypeScript resolver: one stat pass per turn, and an edit is seen in the next turn', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'it-ts-versions-')));
  const realStat = fs.statSync;
  try {
    const files = {
      'tsconfig.json': '{"compilerOptions":{"noLib":true,"types":[]},"include":["a.ts","b.ts"]}',
      'a.ts': 'export function target() {}\nexport function other() {}\n',
      'b.ts': "import { target } from './a'; export function caller() { target(); }\n",
    };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const a = path.join(dir, 'a.ts');
    const b = path.join(dir, 'b.ts');
    const at = (name) => files['a.ts'].indexOf(`function ${name}`) + 'function '.length;
    const resolver = createTsResolver(ts, dir, { filterInherited: false });
    const first = await resolver.callerState(a, at('target'));
    assert.deepEqual(first.callers.map((c) => c.label), ['caller']);

    // Same turn: further queries stat no file of the project.
    const projectStats = [];
    fs.statSync = function (p) { if (String(p).startsWith(dir)) projectStats.push(p); return realStat.apply(fs, arguments); };
    assert.equal(resolver.findReferences(a, at('other')).refs.length, 0);
    assert.ok(resolver.findReferences(a, at('target')).refs.length > 0);
    assert.deepEqual(projectStats, [], 'no stat inside one turn once the versions are known');

    // An edit in the same turn is not seen yet: one snapshot per synchronous stretch.
    fs.writeFileSync(b, "import { target, other } from './a'; export function caller() { target(); other(); }\n");
    fs.utimesSync(b, 1700000000, 1700000000);
    assert.equal(resolver.findReferences(a, at('other')).refs.length, 0);

    // Next turn: the mtimes are checked once, the edited file is re-read.
    await nextTurn();
    projectStats.length = 0;
    assert.ok(resolver.findReferences(a, at('other')).refs.length > 0, 'the edited file is re-read');
    const once = projectStats.length;
    assert.ok(once >= 2, 'each project file is stat-checked at the turn boundary');
    resolver.findReferences(a, at('target'));
    assert.equal(projectStats.length, once, 'and not again in the same turn');
    resolver.dispose();
  } finally {
    fs.statSync = realStat;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
