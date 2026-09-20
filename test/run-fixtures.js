#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/engine/analyze');
const { snapshot } = require('./record-fixture');

const repo = require('./target-repo')();
const dir = path.join(__dirname, 'fixtures');
// Fixtures are recorded against committed state. A dirty tree is a legitimate working
// condition, not a regression — skip loudly rather than fail misleadingly.
const { makeGit } = require('../src/engine/git');
const dirty = makeGit(repo).isDirty('components/');
const only = process.argv[2];
let failed = 0, ran = 0;

(async () => {

function diff(exp, act, prefix, out) {
  const ek = JSON.stringify(exp), ak = JSON.stringify(act);
  if (ek === ak) return;
  if (Array.isArray(exp) && Array.isArray(act)) {
    if (exp.length !== act.length) out.push(`${prefix}: length ${exp.length} -> ${act.length}`);
    const n = Math.max(exp.length, act.length);
    for (let i = 0; i < n; i++) diff(exp[i], act[i], `${prefix}[${i}]`, out);
    return;
  }
  if (exp && act && typeof exp === 'object' && typeof act === 'object') {
    for (const k of new Set([...Object.keys(exp), ...Object.keys(act)])) diff(exp[k], act[k], `${prefix}.${k}`, out);
    return;
  }
  out.push(`${prefix}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(act)}`);
}

const fixtureFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
if (!fixtureFiles.length) {
  console.log('▸ no recorded fixtures (they are gitignored — they embed real paths from the target repo)');
  console.log('    record one with:  IMPACT_TREE_TARGET_REPO=/path/to/repo npm run record -- my-case \'{"mode":"pr","base":"main"}\'');
}
for (const file of fixtureFiles) {
  const fx = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (only && fx.name !== only) continue;
  if (dirty.length && (fx.opts.mode || 'pr') === 'pr') {
    console.log(`▸ ${fx.name} ... SKIP — working tree dirty (${dirty.length} file(s)); fixture assumes committed state`);
    continue;
  }
  ran++;
  process.stdout.write(`▸ ${fx.name} ... `);
  let actual;
  try { actual = snapshot(await analyze(repo, fx.opts)); }
  catch (e) { console.log(`ERROR\n    ${e.message}`); failed++; continue; }
  const problems = [];
  diff(fx.snapshot, actual, '', problems);
  if (problems.length) {
    console.log(`FAIL (${problems.length})`);
    problems.slice(0, 15).forEach((p) => console.log(`    ${p}`));
    failed++;
  } else {
    console.log(`ok — ${actual.findings.length} findings, ${actual.changedFileCount} files`);
  }
}

// False-positive floor: an empty diff must produce nothing at all. Uses checkpoint=HEAD
// with a committed-only head so it holds whether or not the tree is dirty.
process.stdout.write('▸ no-op floor (HEAD vs HEAD, committed) ... ');
try {
  const r = await analyze(repo, { mode: 'checkpoint', checkpoint: 'HEAD', headRev: 'HEAD' });
  const bad = r.findings.length + r.deleted.length;
  if (bad === 0) console.log(`ok — zero findings${dirty.length ? ` (${r.changedFileCount} uncommitted file(s) ignored)` : ''}`);
  else { console.log(`FAIL — expected 0, got ${r.findings.length} findings / ${r.deleted.length} deleted`); failed++; }
  ran++;
} catch (e) { console.log(`ERROR ${e.message}`); failed++; ran++; }
if (dirty.length) console.log(`\n  note: ${dirty.length} uncommitted file(s) under components/ — commit or stash to run the pr fixtures`);

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
})();
