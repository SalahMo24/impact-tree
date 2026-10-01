#!/usr/bin/env node
'use strict';
const path = require('path');
const { analyze, MODES } = require('./engine/analyze');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes(`--${n}`);
// One source for the defaults, so the help text cannot drift from what runs.
const DEFAULTS = { depth: 2, treeDepth: 2 };
if (flag('help')) {
  console.log(`impact-tree — inverted call-graph review\n\nUsage: node src/cli.js [options]\n
  --repo <path>        repo root (default: cwd)
  --mode <m>           ${Object.keys(MODES).join(' | ')}   (default: pr)
${Object.entries(MODES).map(([k, v]) => `                         ${k.padEnd(11)} ${v.desc}`).join('\n')}
  --base <ref>         base branch for pr/branch modes (default: main; resolved to origin/<ref>)
  --checkpoint <sha>   base for checkpoint mode
  --fetch              git fetch the base before resolving
  --allow-local-base   permit a local base ref when origin/<ref> is missing (unsafe)
  --depth <n>          upward closure depth for blast radius / test reach (default ${DEFAULTS.depth})
  --tree-depth <n>     rendered tree depth (default ${DEFAULTS.treeDepth})
  --json               emit JSON instead of text`);
  process.exit(0);
}

const repo = path.resolve(arg('repo', process.cwd()));
const t0 = Date.now();

(async () => {
let result;
try {
  result = await analyze(repo, {
    mode: arg('mode', 'pr'), base: arg('base', 'main'), checkpoint: arg('checkpoint'),
    fetch: flag('fetch'), allowLocalBase: flag('allow-local-base'),
    depth: Number(arg('depth', DEFAULTS.depth)), treeDepth: Number(arg('tree-depth', DEFAULTS.treeDepth)),
    blastDepth: Number(arg('blast-depth', 1)), rankedRoots: Number(arg('roots', 6)),
    maxChildren: Number(arg('max-children', 8)),
  });
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  if (e.dirty) e.dirty.slice(0, 10).forEach((d) => console.error(`    ${d}`));
  process.exit(1);
}

if (flag('json')) {
  console.log(JSON.stringify(result, (k, v) => (v instanceof Set ? [...v] : v), 2));
  process.exit(0);
}

const rel = (f) => path.relative(repo, f);
const H = (s) => { console.log(''); console.log('='.repeat(78)); console.log(s); console.log('='.repeat(78)); };

console.log(`impact-tree — mode '${result.mode}' (${result.modeDesc})`);
console.log(`base ${result.base.ref} @ ${String(result.base.sha).slice(0, 10)}   ${result.changedFileCount} changed src file(s)`);
result.warnings.forEach((w) => console.log(`⚠ ${w}`));

H('① RANKED FINDINGS');
if (!result.findings.length) console.log('  (none)');
for (const f of result.findings) {
  console.log('');
  console.log(`[${f.score}] ${f.label}   ${f.kinds.filter((k) => k.id !== 'body').map((k) => k.label).join(' + ')}`);
  console.log(`      ${rel(f.file)}:${f.startLine}   (${f.component})`);
  if (f.baseSig && f.baseSig !== f.headSig) {
    console.log(`      base: ${f.baseSig}`);
    console.log(`      head: ${f.headSig}`);
  }
  f.throwsAdded.forEach((t) => console.log(`      + throw ${t}`));
  if (f.stale.length) {
    console.log(`      🔴 ${f.stale.length} caller(s) NOT updated in this change:`);
    f.stale.slice(0, 8).forEach((s) => console.log(`         ⚠ ${s.label}   ${rel(s.file)}`));
    if (f.stale.length > 8) console.log(`         +${f.stale.length - 8} more`);
  } else if (f.callerState === 'unknown') {
    console.log(`      ? callers unknown (referenced as a value, never called directly)`);
  } else {
    console.log(`      🟢 no un-updated callers`);
  }
}

H('② INVERTED TREE');
for (const c of result.components) {
  for (const root of c.forest.slice(0, 6)) {
    console.log('');
    console.log(`● ${root.label}   [${root.added ? 'ADDED' : 'CHANGED'}]  ${rel(root.file)}:${root.startLine}`);
    console.log(`  blast ${root.blast ?? '-'}${root.blastCapped ? '+' : ''} · score ${root.score}${root.testCount ? ` · 🧪 ${root.testCount}` : ''}${root.testState === 'uncovered' ? ' · ⚠ no test' : ''}`);
    const walk = (nodes, truncated, prefix) => {
      nodes.forEach((n, i) => {
        const last = i === nodes.length - 1 && !truncated;
        const branch = `${prefix}${last ? '└── ' : '├── '}`;
        if (n.cycle) { console.log(`${branch}↪ ${n.label}  (cycle)`); return; }
        console.log(`${branch}${n.changed ? '●' : '○'} ${n.label}${n.testCount ? `  🧪${n.testCount}` : ''}   ${rel(n.file)}`);
        walk(n.children, n.truncated, `${prefix}${last ? '    ' : '│   '}`);
      });
      if (truncated) console.log(`${prefix}└── +${truncated} more caller(s)`);
    };
    walk(root.children, root.truncated, '  ');
  }
}

H('③ DELETED');
result.deleted.length ? result.deleted.forEach((d) => console.log(`  ✕ ${d.label}   ${d.relPath}`)) : console.log('  (none)');

H('④ TEST REACHABILITY');
console.log(`  uncovered: ${result.untested.length}   callers-unknown: ${result.unknownCallers.length}`);
result.untested.forEach((c) => console.log(`  ⚠ ${c.label}   ${rel(c.file)}:${c.startLine}`));
result.unknownCallers.forEach((c) => console.log(`  ? ${c.label}   ${rel(c.file)}:${c.startLine}  (value-passed, not called)`));

H('SUMMARY');
for (const c of result.components) {
  console.log(`  ${c.component.padEnd(24)} ${String(c.changed.length).padStart(3)} changed  ${String(c.changed.filter((x) => x.kinds.some((k) => k.id !== 'body')).length).padStart(2)} findings  ${String(c.deleted.length).padStart(2)} deleted`);
}
for (const c of result.components) {
  const s = c.stats || {};
  console.log(`  ${c.component.padEnd(24)} LS: ${s.incomingCalls} incoming (${((s.incomingMs||0)/1000).toFixed(1)}s) · ${s.refCalls} findRefs (${((s.refMs||0)/1000).toFixed(1)}s) · ${s.cacheHits} cache hits`);
}
console.log(`  elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
