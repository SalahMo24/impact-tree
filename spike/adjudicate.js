#!/usr/bin/env node
'use strict';
// Are the "misses" my resolver's fault, or the oracle's? For each false negative,
// look at the caller's source and classify WHY the edge was not found. That tells us
// which part of the 22% is a fixable bug and which needs a type checker.
const path = require('path');
const fs = require('fs');
const { analyze } = require('../src/engine/analyze');
const { createSyntacticIndex } = require('./syntactic-resolver');

const repo = require('../test/target-repo')();

(async () => {
  const base = process.argv[2] || 'main';
  const limit = Number(process.argv[3] || 2);
  const r = await analyze(repo, { mode: 'pr', base, skipForest: true, onDirty: 'fallback', allowLocalBase: true });
  const counts = new Map();
  for (const c of r.allChanged) counts.set(c.component, (counts.get(c.component) || 0) + 1);
  const comps = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([c]) => c);

  const cat = {};
  const bump = (k, ex) => { cat[k] = cat[k] || { n: 0, ex: [] }; cat[k].n++; if (cat[k].ex.length < 3 && ex) cat[k].ex.push(ex); };

  for (const comp of comps) {
    const dir = path.join(repo, 'components', comp);
    const ts = require(require.resolve('typescript', { paths: [dir] }));
    const idx = createSyntacticIndex(ts, [path.join(dir, 'src')], { baseDirs: [dir, path.join(dir, 'src')] });

    for (const sym of r.allChanged.filter((c) => c.component === comp)) {
      const guess = new Set(idx.callersOf({ file: sym.file, className: sym.className, name: sym.simpleName })
        .map((c) => `${c.file}#${c.pos}`));
      for (const real of (sym.callers || []).filter((c) => !c.test)) {
        const key = `${real.file}#${real.pos}`;
        if (guess.has(key)) continue;

        const rec = idx.byFile.get(real.file);
        const relCaller = path.relative(repo, real.file);
        const where = `${sym.label} <- ${real.label} (${path.basename(relCaller)})`;
        if (!rec) { bump('caller file not indexed (outside src/ or a test)', where); continue; }

        const hits = rec.calls.filter((c) => c.name === sym.simpleName
          || (sym.isConstructor && c.receiver && c.receiver.kind === 'new'));
        if (!hits.length) {
          const txt = fs.existsSync(real.file) ? fs.readFileSync(real.file, 'utf8') : '';
          bump(txt.includes(sym.simpleName)
            ? 'name present but no call node — re-export, alias or inherited dispatch'
            : 'ORACLE-ONLY — target name absent from the caller file', where);
          continue;
        }
        const h = hits[0];
        if (!h.receiver) {
          bump('bare call — module resolution failed (FIXABLE)', where);
        } else if (h.receiver.kind === 'new') {
          bump('new X() — class name did not match target (FIXABLE)', where);
        } else if (h.receiver.kind === 'thisMember') {
          const tn = (rec.classes.get(h.ownerClass) || { members: new Map() }).members.get(h.receiver.name);
          if (!tn) bump('this.x.foo() — member has no type annotation (needs checker)', where);
          else bump(`this.x.foo() — declared type '${tn}' not linked to target (FIXABLE via implements/extends)`, where);
        } else if (h.receiver.kind === 'ident') {
          const tn = rec.localTypes.get(h.receiver.name);
          bump(tn ? `obj.foo() — local type '${tn}' not linked (FIXABLE)` : 'obj.foo() — untyped local/param (needs checker)', where);
        } else {
          bump('other receiver shape', where);
        }
      }
    }
  }

  const rows = Object.entries(cat).sort((a, b) => b[1].n - a[1].n);
  const total = rows.reduce((s, [, v]) => s + v.n, 0);
  console.log(`\nadjudicated ${total} missed edges\n${'='.repeat(70)}`);
  for (const [k, v] of rows) {
    console.log(`${String(v.n).padStart(4)}  ${Math.round(100 * v.n / total)}%  ${k}`);
    v.ex.forEach((e) => console.log(`         e.g. ${e}`));
  }
  const fixable = rows.filter(([k]) => /FIXABLE/.test(k)).reduce((s, [, v]) => s + v.n, 0);
  const oracle = rows.filter(([k]) => /ORACLE-ONLY/.test(k)).reduce((s, [, v]) => s + v.n, 0);
  console.log('='.repeat(70));
  console.log(`fixable without a type checker : ${fixable} (${Math.round(100 * fixable / total)}%)`);
  console.log(`oracle-only (my resolver may be right) : ${oracle} (${Math.round(100 * oracle / total)}%)`);
})().catch((e) => { console.error(e); process.exit(1); });
