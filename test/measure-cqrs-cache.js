'use strict';
// Manual retained-heap/refresh benchmark, outside the correctness suite:
//   node --expose-gc test/measure-cqrs-cache.js [synthetic|handlers|/path/to/repo]
// Each of three generations touches 100 different files. Provider responses are
// immediate empty call hierarchies: this measures editor-side parsing/cache costs,
// excluding the language server. Same-generation probes use another position to
// bypass the caller-answer cache. Heap measurements force GC after an event-loop
// turn; compare medians from fresh processes, not timings asserted in CI.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const ts = require('typescript');
const { _clear: clearTextPositions } = require('../src/engine/textpos');

const FILES_PER_GENERATION = 100;
const GENERATIONS = 3;
const MAX_FILE_BYTES = 128 * 1024;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const heapMiB = async () => {
  await turn();
  global.gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
};
const rounded = (n) => Math.round(n * 100) / 100;

async function measure() {
  assert.equal(typeof global.gc, 'function', 'run with node --expose-gc');
  const workload = process.argv[2] || 'synthetic';
  const synthetic = workload === 'synthetic' || workload === 'handlers';
  const repo = synthetic ? fs.mkdtempSync(path.join(os.tmpdir(), 'impact-cqrs-memory-')) : fs.realpathSync(process.argv[2]);
  let resolver;
  try {
    let files;
    if (synthetic) {
      const ordinary = Array.from({ length: 300 }, (_, i) => `export function fn${i}(a: number) { return a + ${i}; }`).join('\n');
      // Same ordinary source, with real decorators to exercise the parsing fallback.
      // Queries at positions 0/1 are outside execute(), so no provider dispatch
      // lookup is needed; correctness of that lookup belongs to the regression suite.
      const text = workload === 'handlers' ? `@CommandHandler(Command) class Handler { execute() {} }\n${ordinary}` : ordinary;
      files = Array.from({ length: FILES_PER_GENERATION * GENERATIONS }, (_, i) => path.join(repo, `source${i}.ts`));
      for (const file of files) fs.writeFileSync(file, text);
    } else {
      const listed = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      files = listed.split('\0').filter((rel) => /\.(ts|tsx|js|jsx)$/.test(rel) && !rel.endsWith('.d.ts'))
        .map((rel) => path.join(repo, rel)).filter((file) => fs.statSync(file).size <= MAX_FILE_BYTES)
        .slice(0, FILES_PER_GENERATION * GENERATIONS);
    }
    assert.equal(files.length, FILES_PER_GENERATION * GENERATIONS, 'workload needs 300 source files');
    const sourceBytes = files.reduce((n, file) => n + fs.statSync(file).size, 0);
    let parses = 0;
    const compiler = { ...ts, createSourceFile(...args) { parses++; return ts.createSourceFile(...args); } };
    const stub = { ...require('./vscode-stub'), Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
      commands: { executeCommand: async (name) => name === 'vscode.prepareCallHierarchy' ? [{}] : [] } };
    const originalLoad = Module._load;
    const resolverPath = require.resolve('../src/resolver-vscode');
    const originalModule = require.cache[resolverPath];
    try {
      Module._load = function (name, ...args) { return name === 'vscode' ? stub : originalLoad.call(this, name, ...args); };
      delete require.cache[resolverPath];
      resolver = require('../src/resolver-vscode').createVscodeResolver({ ts: compiler, repoRoot: repo, filterInherited: false });
    } finally {
      Module._load = originalLoad;
      if (originalModule) require.cache[resolverPath] = originalModule;
      else delete require.cache[resolverPath];
    }
    const baseline = await heapMiB();
    const rows = [];
    const query = async (group, pos) => {
      const start = performance.now();
      for (const file of group) {
        const answer = await resolver.incomingWithStatus(file, pos);
        assert.deepEqual(answer, { callers: [], complete: true });
      }
      return performance.now() - start;
    };
    for (let i = 0; i < GENERATIONS; i++) {
      const group = files.slice(i * FILES_PER_GENERATION, (i + 1) * FILES_PER_GENERATION);
      const beforeCold = parses;
      const coldMs = await query(group, 0);
      const coldParses = parses - beforeCold;
      const beforeWarm = parses;
      const warmMs = await query(group, 1);
      const warmParses = parses - beforeWarm;
      const populatedHeapMiB = await heapMiB() - baseline;
      resolver.clear();
      const afterClearHeapMiB = await heapMiB() - baseline;
      const previousParses = parses;
      const refreshMs = await query(group, 0);
      rows.push({ generation: i + 1, coldMs: rounded(coldMs), warmMs: rounded(warmMs), refreshMs: rounded(refreshMs), coldParses, warmParses,
        populatedHeapMiB: rounded(populatedHeapMiB), afterClearHeapMiB: rounded(afterClearHeapMiB), refreshParses: parses - previousParses });
      resolver.clear();
    }
    console.log(JSON.stringify({ node: process.version, arch: process.arch, workload: synthetic ? workload : repo,
      files: files.length, sourceMiB: rounded(sourceBytes / (1024 * 1024)), rows }));
  } finally {
    resolver = null;
    clearTextPositions();
    if (synthetic) fs.rmSync(repo, { recursive: true, force: true });
  }
}

measure().catch((error) => { console.error(error); process.exitCode = 1; });
