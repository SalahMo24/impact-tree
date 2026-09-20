#!/usr/bin/env node
'use strict';
// Records a stable, comparable subset of an analysis run. Tree shape is deliberately
// excluded: it depends on depth/breadth caps, which are tuning knobs, not behaviour.
const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/engine/analyze');

function snapshot(r) {
  return {
    base: { ref: r.base.ref, sha: r.base.sha },
    changedFileCount: r.changedFileCount,
    unanalysable: r.unanalysable.sort((a, b) => a.component.localeCompare(b.component)),
    findings: r.findings.map((f) => ({
      label: f.label, component: f.component, relPath: f.relPath,
      kinds: f.kinds.map((k) => k.id).sort(),
      score: f.score, staleCallers: f.staleCallers, callerState: f.callerState,
      baseSig: f.baseSig, headSig: f.headSig, throwsAdded: f.throwsAdded.length,
    })).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)),
    deleted: r.deleted.map((d) => `${d.component}:${d.label}`).sort(),
    untested: r.untested.map((c) => `${c.component}:${c.label}`).sort(),
    unknownCallers: r.unknownCallers.map((c) => `${c.component}:${c.label}`).sort(),
  };
}

if (require.main === module) { (async () => {
  const name = process.argv[2];
  const opts = JSON.parse(process.argv[3] || '{}');
  if (!name) { console.error('usage: record-fixture.js <name> [optsJson]'); process.exit(1); }
  const repo = require('./target-repo')();
  const snap = snapshot(await analyze(repo, opts));
  const out = path.join(__dirname, 'fixtures', `${name}.json`);
  fs.writeFileSync(out, JSON.stringify({ name, opts, snapshot: snap }, null, 2) + '\n');
  console.log(`recorded ${out}: ${snap.findings.length} findings, ${snap.deleted.length} deleted, ${snap.changedFileCount} files`);
})().catch((e) => { console.error(e); process.exit(1); }); }
module.exports = { snapshot };
