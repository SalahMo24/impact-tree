#!/usr/bin/env node
'use strict';
// Call-site ranges drive navigation: clicking a caller must land on the line that calls
// the changed symbol, not on the caller's own declaration. Verified against whatever
// repo IMPACT_TREE_TARGET_REPO points at, so the suite carries no fixed codebase.
const path = require('path');
const fs = require('fs');
const targetRepo = require('./target-repo');
const { analyze } = require('../src/engine/analyze');

const repo = targetRepo();
let fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

(async () => {
  const r = await analyze(repo, {
    mode: process.env.IMPACT_TREE_MODE || 'branch',
    base: process.env.IMPACT_TREE_BASE || 'main',
    skipForest: true, onDirty: 'fallback', allowLocalBase: true,
  });

  const withCallers = r.allChanged.filter((c) => (c.callers || []).some((x) => (x.callSites || []).length));
  if (!withCallers.length) {
    console.log('  skip  no changed symbol in this target has a resolvable caller');
    console.log('        (point IMPACT_TREE_TARGET_REPO at a repo with a non-empty diff)');
    process.exit(0);
  }
  check('found changed symbols with callers', true, `${withCallers.length} of ${r.allChanged.length}`);

  let exact = 0, wrong = 0, differsFromDecl = 0, checked = 0;
  for (const sym of withCallers.slice(0, 25)) {
    for (const c of sym.callers) {
      if (!(c.callSites || []).length) continue;
      let text;
      try { text = fs.readFileSync(c.file, 'utf8'); } catch { continue; }
      // A constructor's call site reads `new ClassName(`, and a CQRS edge points at the
      // command being constructed -- neither contains the target's own simple name.
      if (c.via === 'cqrs') continue;
      const expect = sym.isConstructor ? sym.className : sym.simpleName;
      if (!expect) continue;
      for (const site of c.callSites) {
        checked++;
        if (text.slice(site.start, site.end).includes(expect)) exact++;
        else { wrong++; if (wrong <= 3) console.log(`        mismatch: expected '${expect}' in ${JSON.stringify(text.slice(site.start, site.end).slice(0, 40))}`); }
      }
      if (c.callSites[0].start !== c.pos) differsFromDecl++;
    }
  }
  check('every caller carries call sites', checked > 0, `${checked} site(s) checked`);
  check('call-site offsets land on the symbol', wrong === 0, `${exact} exact, ${wrong} wrong`);
  check('call site differs from the declaration', differsFromDecl > 0,
    'otherwise navigation would land on the declaration');

  console.log(fail ? `\n${fail} FAILED` : '\nall call-site checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
