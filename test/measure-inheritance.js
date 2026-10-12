'use strict';
// Manual benchmark; timings are not CI assertions. Compare alternating fresh processes:
// node --expose-gc --max-old-space-size=512 test/measure-inheritance.js ordinary [source-root]
// Workloads: ordinary, barrels, deep. The same fixtures and harness serve every revision.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { createHash } = require('crypto');
const ts = require('typescript');

const workload = process.argv[2] || 'ordinary';
assert(['ordinary', 'barrels', 'deep'].includes(workload));
assert.equal(typeof global.gc, 'function', 'run with --expose-gc');
const source = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const { createInheritanceFilter } = require(path.join(source, 'src/engine/inheritance'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-inheritance-bench-'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const heap = async () => { await turn(); global.gc(); return process.memoryUsage().heapUsed / 1024 / 1024; };
const rounded = number => Math.round(number * 1000) / 1000;

(async () => {
  try {
    const groups = [];
    let files = 0, bytes = 0;
    const write = (name, text) => {
      const file = path.join(root, name);
      fs.writeFileSync(file, text); files++; bytes += Buffer.byteLength(text);
      return file;
    };
    write('base.ts', 'export class Base { save() {} }\n');
    for (let i = 0; i < 100; i++) {
      const ancestors = workload === 'deep' ? Array.from({ length: 16 }, (_, j) =>
        `export class Step${i}_${j} extends ${j ? `Step${i}_${j - 1}` : `Mine${i}`} {}`).join('\n') : '';
      const model = `import { Base } from './base';\nexport class Mine${i} extends Base { save() {} }\nexport class Other${i} extends Base {}\n${ancestors}\nexport class Sub${i} extends ${workload === 'deep' ? `Step${i}_15` : `Mine${i}`} {}\n`;
      const target = write(`model${i}.ts`, model);
      if (workload === 'barrels') write(`barrel${i}.ts`, `export * from './model${i}';\n`);
      const labels = ['direct', 'sibling', 'subclass', 'port'];
      const types = [`Mine${i}`, `Other${i}`, `Sub${i}`, 'Base'];
      const caller = `import { Mine${i}, Other${i}, Sub${i} } from './${workload === 'barrels' ? 'all' : `model${i}`}';\nimport { Base } from './base';\n`
        + labels.map((label, j) => `export function ${label}${i}(receiver: ${types[j]}) { receiver.save(); }`).join('\n');
      const file = write(`caller${i}.ts`, caller);
      const callers = labels.map((label) => {
        const start = caller.indexOf('receiver.save', caller.indexOf(`function ${label}${i}`)) + 'receiver.'.length;
        return { file, label: `${label}${i}`, callSites: [{ start }] };
      });
      groups.push({ file: target, pos: model.indexOf('save()'), callers });
    }
    if (workload === 'barrels') write('all.ts', Array.from({ length: 100 }, (_, i) => `export * from './barrel${i}';`).join('\n'));
    let parses = 0;
    const compiler = { ...ts, createSourceFile(...args) { parses++; return ts.createSourceFile(...args); } };
    const filter = createInheritanceFilter(compiler);
    const baselineHeap = await heap();
    const batch = (repeats) => {
      const start = performance.now();
      let kept = 0, dropped = 0;
      const rows = [];
      for (let run = 0; run < repeats; run++) for (const group of groups) {
        const result = filter.filterAt(group.file, group.pos, group.callers);
        kept += result.kept.length; dropped += result.dropped;
        if (run === 0) rows.push(result.kept.map(c => c.label));
      }
      const ms = (performance.now() - start) / repeats;
      assert.equal(kept, 300 * repeats, 'all direct/subclass/port callers survive');
      assert.equal(dropped, 100 * repeats, 'only sibling callers are removed');
      return { ms: rounded(ms), signature: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    };
    const delayStart = performance.now();
    const coldDelay = turn().then(() => performance.now() - delayStart);
    const cold = batch(1), coldParses = parses;
    const coldEventLoopDelayMs = rounded(await coldDelay);
    const populatedHeapMiB = await heap() - baselineHeap;
    const beforeWarm = parses, warm = batch(50), warmParses = parses - beforeWarm;
    filter.clear();
    const clearedHeapMiB = await heap() - baselineHeap;
    const beforeRefresh = parses, refresh = batch(1), refreshParses = parses - beforeRefresh;
    assert.equal(warm.signature, cold.signature);
    assert.equal(refresh.signature, cold.signature);
    assert.equal(warmParses, 0);
    console.log(JSON.stringify({ node: process.version, arch: process.arch, source, workload, files, bytes,
      targets: groups.length, callSites: 400, warmRepeats: 50, cold, warm, refresh, coldParses, warmParses,
      refreshParses, populatedHeapMiB: rounded(populatedHeapMiB), clearedHeapMiB: rounded(clearedHeapMiB), coldEventLoopDelayMs }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
