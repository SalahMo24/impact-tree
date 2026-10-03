'use strict';
// Changed-symbol mapping, matching, declaration forms, and pure deletions.

const { createLocalHarness } = require('./local-repo');
const { analyze } = require('../src/engine/analyze');
const { rangeOfHeader } = require('../src/engine/diff');
const { hunkRangesFromPatch } = require('../src/engine/patch');
const { changedSymbolsIn } = require('../src/engine/changed-symbols');
const { makeSymbols } = require('../src/engine/symbols');

const h = createLocalHarness();
if (!h) process.exit(0);
const {
  ts, TSCONFIG, TARGET_V1, TARGET_V2, since, J,
  write, mkRepo, headOf, byLabel, callStates, S, parse, check, finish,
} = h;

(async () => {
  // ================================================================== symbols =====
  console.log('▸ one changed range maps to every function it touches');
  {
    // Two adjacent one-liners edited together: the old mapper returned only the
    // smallest enclosing function, so `b` silently never appeared as changed.
    const sf = parse('export function a() { return 1; }\nexport function b() { return 2; }\n');
    const hit = S.mapRange(S.collect(sf), 1, 2).map((c) => c.label);
    check('both functions of a two-line range', J(hit) === J(['a', 'b']), J(hit));
    const big = Array.from({ length: 100 }, (_, i) => `export function f${i}() {\n  return ${i};\n}\n`).join('');
    const all = S.mapRange(S.collect(parse(big)), 1, 300);
    check('an added file lists all of its functions (large-range path)', all.length === 100, `${all.length}`);
  }

  console.log('▸ base and head are matched by a unique key, not the display label');
  {
    // A get/set pair shares the label `K.v`; matching on it compared the setter's head
    // against the getter's base and reported a signature change nobody made.
    const base = 'export class K {\n  get v(): number { return 1; }\n  set v(x: number) { }\n}\n';
    const head = 'export class K {\n  get v(): number { return 2; }\n  set v(x: number) { }\n}\n';
    const r = changedSymbolsIn(ts, S, { absPath: '/x.ts', relPath: 'x.ts', status: 'modified', headText: head, baseText: base, hunkRanges: [[2, 2]] });
    check('only the getter changed', r.changed.length === 1 && r.changed[0].key === 'get K.v', J(r.changed.map((c) => c.key)));
    check('as a body edit, not a signature change', r.changed[0].kinds.every((k) => k.id === 'body'), J(r.changed[0].kinds.map((k) => k.id)));
    check('and nothing is reported deleted', r.deleted.length === 0, J(r.deleted.map((d) => d.key)));
  }
  {
    // Same-named helpers inside two methods: the second shadowed the first's base.
    const src = (x) => `export class K {\n  m1() { const cb = (a: number) => a; return cb(1); }\n  m2() { const cb = (${x}) => 0; return cb(); }\n}\n`;
    const r = changedSymbolsIn(ts, S, { absPath: '/x.ts', relPath: 'x.ts', status: 'modified', headText: src('b: string'), baseText: src(''), hunkRanges: [[3, 3]] });
    const cb = r.changed.find((c) => c.key === 'K.m2>cb');
    check('the edited helper is found under its own method', !!cb, J(r.changed.map((c) => c.key)));
    check('and compared against ITS base, so the new param is seen', cb && cb.kinds.some((k) => k.id !== 'body'), cb && J(cb.kinds.map((k) => k.id)));
  }
  {
    const src = 'export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: any) {}\n';
    const keys = S.collect(parse(src)).map((c) => c.key);
    check('overloads get distinct keys', new Set(keys).size === keys.length, J(keys));
  }

  console.log('▸ declaration forms');
  {
    // A modifier before `constructor` used to become the label ("K.private").
    const [ctor] = S.collect(parse('export class K {\n  private constructor(a: number) {}\n}\n'));
    check('constructor with a modifier is labelled constructor', ctor.label === 'K.constructor', ctor.label);
    const d1 = S.collect(parse('export default (a: number) => a;\n'));
    check('export default arrow is collected', d1.length === 1 && d1[0].simpleName === 'default', J(d1.map((c) => c.label)));
    const d2 = S.collect(parse('export default function () { return 1; }\n'));
    check('anonymous export default function is collected', d2.length === 1 && d2[0].simpleName === 'default', J(d2.map((c) => c.label)));
    const cjs = S.collect(parse('exports.run = function (a) { return a; };\nmodule.exports.go = (b) => b;\n', 'x.js'));
    check('CommonJS exports are collected', J(cjs.map((c) => c.label)) === J(['run', 'go']) && cjs.every((c) => c.exported), J(cjs.map((c) => c.label)));
  }
  {
    // TypeScript < 4.8 has no getModifiers/getDecorators; the old code crashed on it.
    const old = { ...ts };
    old.getModifiers = undefined; old.getDecorators = undefined;
    let syms = null, err = null;
    try { syms = makeSymbols(old).collect(parse('export async function f() {}\n')); } catch (e) { err = e; }
    check('symbols work on a compiler without getModifiers', !err && syms.length === 1, err ? err.message : '');
    check('and still read modifiers', syms && syms[0].exported && syms[0].sig.async);
  }

  // ======================================================== pure deletions =====
  console.log('▸ a pure deletion belongs to the gap it left, not to a neighbour');
  {
    check('git header +N,0 is the gap after line N', J(rangeOfHeader('@@ -5,2 +4,0 @@')) === J([4.5, 4.5]));
    const patch = ['@@ -1,5 +1,4 @@', ' a', ' b', '-gone', ' c', ' d'].join('\n');
    check('GitHub patch deletion is the same gap', J(hunkRangesFromPatch(patch)) === J([[2.5, 2.5]]), J(hunkRangesFromPatch(patch)));
    check('a replacement is not a deletion', J(hunkRangesFromPatch('@@ -1,1 +1,1 @@\n-x\n+y')) === J([[1, 1]]));
    const sf = parse('export function a() { return 1; }\nexport function b() { return 2; }\n');
    check('a gap between two functions belongs to neither', S.mapRange(S.collect(sf), 1.5, 1.5).length === 0);
    const inner = parse('export function a() {\n  x();\n  y();\n}\n');
    check('a gap inside a function belongs to it', S.mapRange(S.collect(inner), 2.5, 2.5).map((c) => c.label)[0] === 'a');
  }
  {
    // Deleting the line AFTER a call anchored the deletion on the call's line and
    // marked a call nobody touched as "updated at call".
    const callerV1 = "import { target } from './t';\nexport function caller() {\n  target(1);\n  console.log('x');\n}\n";
    const repo = mkRepo({ 'tsconfig.json': TSCONFIG, 'src/t.ts': TARGET_V1, 'src/caller.ts': callerV1 });
    const base = headOf(repo);
    write(repo, { 'src/t.ts': TARGET_V2, 'src/caller.ts': "import { target } from './t';\nexport function caller() {\n  target(1);\n}\n" });
    const r = await analyze(repo, since(base));
    check('the untouched call site is not "updated"', J(callStates(byLabel(r, 'target'))) === J(['caller[changed-elsewhere]']), J(callStates(byLabel(r, 'target'))));
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
