#!/usr/bin/env node
'use strict';
// Ground truth = the real TypeScript call hierarchy (what the extension uses today).
// Candidate = the syntax-only resolver. Compare edge by edge.
const path = require('path');
const { analyze } = require('../src/engine/analyze');
const { createTsResolver } = require('../src/engine/resolver-ts');
const { createSyntacticIndex } = require('./syntactic-resolver');

const repo = require('../test/target-repo')();

(async () => {
  const t0 = Date.now();
  const base = process.argv[2] || 'main';
  const r = await analyze(repo, { mode: 'pr', base, skipForest: true, onDirty: 'fallback', allowLocalBase: true });
  // Ground truth builds a full TS program per component; twelve at once exhausts the
  // heap and the process dies silently. Cap it, and say what was dropped.
  const limit = Number(process.argv[3] || 3);
  const counts = new Map();
  for (const c of r.allChanged) counts.set(c.component, (counts.get(c.component) || 0) + 1);
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const comps = all.slice(0, limit).map(([c]) => c);
  if (all.length > comps.length) {
    console.log(`(measuring the ${comps.length} largest of ${all.length} components; dropped ${all.slice(limit).map(([c, n]) => `${c}:${n}`).join(', ')})`);
  }
  console.log(`PR: ${r.allChanged.length} changed symbols across ${comps.join(', ')}\n`);

  let tp = 0, fp = 0, fn = 0;
  // Tier A = both endpoints inside the PR (self-verifying: the reviewer can see both).
  // Tier B = caller lives outside the PR (only reachable with a checkout).
  let atp = 0, afp = 0, afn = 0;
  const inPR = new Set(r.changedPaths);
  const isIntra = (k) => inPR.has(k.split('#')[0]);
  const missed = [], spurious = [];

  for (const comp of comps) {
    const dir = path.join(repo, 'components', comp);
    const ts = require(require.resolve('typescript', { paths: [dir] }));
    const tIdx = Date.now();
    const idx = createSyntacticIndex(ts, [path.join(dir, 'src')], { baseDirs: [dir, path.join(dir, 'src')] });
    console.log(`${comp}: indexed ${idx.size} files syntactically in ${((Date.now() - tIdx) / 1000).toFixed(1)}s`);

    const truth = createTsResolver(ts, dir);
    const syms = r.allChanged.filter((c) => c.component === comp);
    console.log(`  ${comp}: ${syms.length} changed symbols`);
    for (const sym of syms) {
      // compare by (file, declaration position) -- both sides use the caller's name
      // start, so label formatting cannot skew the result
      const key = (f, pos) => `${path.relative(repo, f)}#${pos}`;
      const realNodes = (sym.callers || []).filter((c) => !c.test);
      const guessNodes = idx.callersOf({ file: sym.file, className: sym.className, name: sym.simpleName })
        .filter((c) => !/(^|\/)tests?\//.test(path.relative(repo, c.file)));
      const labelOf = new Map();
      realNodes.forEach((c) => labelOf.set(key(c.file, c.pos), c.label));
      guessNodes.forEach((c) => labelOf.set(key(c.file, c.pos), c.label));
      const real = realNodes.map((c) => key(c.file, c.pos));
      const guess = guessNodes.map((c) => key(c.file, c.pos));
      const R = new Set(real), G = new Set(guess);
      for (const g of G) {
        if (R.has(g)) { tp++; if (isIntra(g)) atp++; }
        else { fp++; if (isIntra(g)) afp++; spurious.push(`${sym.label} <- ${labelOf.get(g)} (${g})`); }
      }
      for (const x of R) if (!G.has(x)) { fn++; if (isIntra(x)) afn++; missed.push(`${sym.label} <- ${labelOf.get(x)} (${x})`); }
    }
    truth.dispose();
  }

  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  console.log('\n' + '='.repeat(64));
  console.log(`true positives   ${tp}`);
  console.log(`false positives  ${fp}   (edges invented)`);
  console.log(`false negatives  ${fn}   (edges missed)`);
  console.log(`precision        ${(prec * 100).toFixed(1)}%`);
  console.log(`recall           ${(rec * 100).toFixed(1)}%`);
  console.log(`F1               ${((2 * prec * rec / (prec + rec || 1)) * 100).toFixed(1)}%`);
  console.log('='.repeat(64));
  const ap = atp + afp ? atp / (atp + afp) : 0;
  const ar = atp + afn ? atp / (atp + afn) : 0;
  console.log('\nTIER A — edges where BOTH ends are inside the PR (no checkout needed):');
  console.log(`  true positives ${atp}  false positives ${afp}  false negatives ${afn}`);
  console.log(`  precision ${(ap * 100).toFixed(1)}%   recall ${(ar * 100).toFixed(1)}%   F1 ${((2 * ap * ar / (ap + ar || 1)) * 100).toFixed(1)}%`);
  const btp = tp - atp, bfp = fp - afp, bfn = fn - afn;
  const bp = btp + bfp ? btp / (btp + bfp) : 0;
  const br = btp + bfn ? btp / (btp + bfn) : 0;
  console.log('\nTIER B — caller lives OUTSIDE the PR (needs the full repo / checkout):');
  console.log(`  true positives ${btp}  false positives ${bfp}  false negatives ${bfn}`);
  console.log(`  precision ${(bp * 100).toFixed(1)}%   recall ${(br * 100).toFixed(1)}%`);
  if (missed.length) { console.log('\nMISSED (sample):'); [...new Set(missed)].slice(0, 12).forEach((m) => console.log('  - ' + m)); }
  if (spurious.length) { console.log('\nINVENTED (sample):'); [...new Set(spurious)].slice(0, 12).forEach((m) => console.log('  + ' + m)); }
  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
