#!/usr/bin/env node
'use strict';
// Guards the .tsx hazard: TypeScript infers JSX from the FILENAME, so a .tsx parsed
// under the .ts script kind produces parse errors and zero JSX nodes -- wrong symbols
// rather than missing ones. Also pins the source/test classification table.
const fs = require('fs');
const os = require('os');
const path = require('path');
const targetRepo = require('./target-repo');
const { isSourcePath, isTestPath, SOURCE_EXT } = require('../src/engine/diff');
const { makeSymbols } = require('../src/engine/symbols');

const repo = targetRepo();
let fail = 0;
const check = (n, ok, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

console.log('▸ source / test classification');
for (const [p, src, tst] of [
  ['a/b.ts', true, false], ['a/b.tsx', true, false], ['a/b.js', true, false],
  ['a/b.jsx', true, false], ['a/b.mjs', true, false], ['a/b.cts', true, false],
  ['a/b.d.ts', false, false], ['a/b.md', false, false], ['a/up.sql', false, false],
  ['a/b.spec.tsx', true, true], ['a/__tests__/c.tsx', true, true],
  ['a/__mocks__/d.ts', true, true], ['components/x/tests/e.ts', true, true],
]) {
  check(`${p.padEnd(26)} source=${src} test=${tst}`, isSourcePath(p) === src && isTestPath(p) === tst,
    `got source=${isSourcePath(p)} test=${isTestPath(p)}`);
}
check('SOURCE_EXT is exported for reuse', SOURCE_EXT instanceof RegExp);

console.log('▸ JSX parsing hazard');
const { findTypeScript, findSampleFile } = require('./find-typescript');
const ts = findTypeScript();
if (!ts) { console.log('  SKIP no typescript resolvable — language checks did NOT run'); process.exit(0); }
const jsx = 'export const Card = ({ title }) => <div className="c">{title}</div>;\nexport function Badge() { return <span/>; }\n';
const countJsx = (sf) => { let n = 0; const v = (x) => { if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) n++; ts.forEachChild(x, v); }; ts.forEachChild(sf, v); return n; };
const asTsx = ts.createSourceFile('C.tsx', jsx, ts.ScriptTarget.ES2021, true);
const asTs = ts.createSourceFile('C.ts', jsx, ts.ScriptTarget.ES2021, true);
check('.tsx filename yields JSX nodes', countJsx(asTsx) === 2, `${countJsx(asTsx)} nodes`);
check('.ts filename mis-parses the same source', countJsx(asTs) === 0 && asTs.parseDiagnostics.length > 0,
  `${countJsx(asTs)} nodes, ${asTs.parseDiagnostics.length} parse errors`);

console.log('▸ symbols from a React file');
const S = makeSymbols(ts);
const syms = S.collect(asTsx);
check('arrow component collected', syms.some((s) => s.label === 'Card'), syms.map((s) => s.label).join(', '));
check('function component collected', syms.some((s) => s.label === 'Badge'));

console.log('▸ real .tsx from this repo');
// Any real .tsx in the target repo, found by search -- naming a path would hardcode
// one codebase's layout into a test that is meant to be about the parser.
const sample = findSampleFile(/\.tsx$/);
if (sample) {
  const sf = ts.createSourceFile(sample, fs.readFileSync(sample, 'utf8'), ts.ScriptTarget.ES2021, true);
  check('real component file parses without errors', sf.parseDiagnostics.length === 0, `${sf.parseDiagnostics.length} errors`);
  check('real component file yields symbols', S.collect(sf).length > 0, `${S.collect(sf).length} symbols`);
} else {
  console.log('  skip  sample .tsx not present in this target repo');
}

console.log(fail ? `\n${fail} FAILED` : '\nall language checks passed');
process.exit(fail ? 1 : 0);
