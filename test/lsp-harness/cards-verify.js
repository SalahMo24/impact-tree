#!/usr/bin/env node
'use strict';
// Invariants and regression compare for cards (src/engine/cards.js). A harness script run
// by hand, not part of `npm test`: it needs a corpus of real PRs, their recorded analysis
// results, and the repositories (read with `git log`, `git diff`, `git show`, `git grep`;
// nothing in them is run).
//
//   node test/lsp-harness/cards-verify.js --engine <dir> --corpus <corpus.json> --inputs <dir>
//        --out <dir> [--reference <dir>] [--case <name>] [--embedded]
//
// corpus.json is `{cases: [{name, repo, base, head?}]}`; `head` defaults to HEAD. For each
// case `<inputs>/<name>.json` holds an analysis result (or, with --embedded, the CLI's
// `--json --cards` output, whose `cards` field is checked as it is, without a rebuild or a
// rerun). Per case it writes `<out>/<name>.json` (the cards) and checks that:
//   - every changed id is in exactly one place (members, mirrorMembers, sweep members, or
//     the deleted side of a move), and the member total is changed plus deleted;
//   - every seam and hint names a known cluster or sweep;
//   - a second build gives byte-identical cards.
// With --reference it also compares each case's cards with `<reference>/<name>.json` and
// prints same or the differing paths. Exit code: 0 all invariants hold, 1 a failure, 2 bad
// arguments. A difference from the reference is reported, not a failure.
const fs = require('fs');
const path = require('path');

const FLAGS = ['--engine', '--corpus', '--inputs', '--out', '--reference', '--case'];
const MAX_DIFF_PATHS = 12;

/**
 * @param {string[]} argv
 * @returns {{engine: string, corpus: string, inputs: string, out: string, reference: string | null, only: string | null, embedded: boolean}}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  let embedded = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--embedded') { embedded = true; continue; }
    if (!FLAGS.includes(argv[i]) || !argv[i + 1]) usage();
    values[argv[i]] = argv[++i];
  }
  if (!values['--engine'] || !values['--corpus'] || !values['--inputs'] || !values['--out']) usage();
  return {
    engine: path.resolve(values['--engine']), corpus: path.resolve(values['--corpus']), inputs: path.resolve(values['--inputs']),
    out: path.resolve(values['--out']), reference: values['--reference'] ? path.resolve(values['--reference']) : null,
    only: values['--case'] || null, embedded,
  };
}

/** @returns {never} */
function usage() {
  console.error('usage: cards-verify.js --engine <dir> --corpus <file> --inputs <dir> --out <dir> [--reference <dir>] [--case <name>] [--embedded]');
  process.exit(2);
}

/**
 * Differing paths between two JSON values, at most `limit`.
 * @param {any} a @param {any} b @param {string} at @param {string[]} out @param {number} limit
 */
function diffPaths(a, b, at, out, limit) {
  if (out.length >= limit) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const bothContainers = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!bothContainers) { out.push(at || '(root)'); return; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths(a[k], b[k], at ? `${at}.${k}` : k, out, limit);
}

/**
 * Invariant failures of one case's cards.
 * @param {any} input analysis result
 * @param {any} cards
 * @returns {string[]}
 */
function checkCards(input, cards) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, number>} */
  const places = new Map();
  const put = (/** @type {string} */ id) => places.set(id, (places.get(id) || 0) + 1);
  for (const c of cards.clusters) { c.members.forEach(put); c.mirrorMembers.forEach(put); c.moved.forEach((/** @type {any} */ m) => put(m.from)); }
  for (const s of cards.sweeps) { s.members.forEach(put); s.mirrorMembers.forEach(put); }
  const expected = new Set(input.allChanged.map((/** @type {any} */ c) => `${c.relPath || c.file}#${c.namePos}`));
  for (const id of expected) if (places.get(/** @type {string} */ (id)) !== 1) problems.push(`changed id ${id} in ${places.get(/** @type {string} */ (id)) || 0} places`);
  for (const [id, n] of places) if (n !== 1) problems.push(`id ${id} in ${n} places`);
  const deleted = (input.deleted || []).length;
  if (places.size !== input.allChanged.length + deleted) problems.push(`member total ${places.size} != ${input.allChanged.length}+${deleted}`);
  const known = new Set([...cards.clusters, ...cards.sweeps].map((/** @type {any} */ c) => c.id));
  for (const s of cards.seams) for (const c of s.clusters) if (!known.has(c)) problems.push(`seam names unknown cluster ${c}`);
  for (const h of cards.hints) for (const c of h.clusters) if (!known.has(c)) problems.push(`hint names unknown cluster ${c}`);
  return problems;
}

/**
 * Cards of one case, from the embedded `cards` field or built twice (the second build is the
 * rerun check, so the same git facts are read twice).
 * @param {any} args @param {any} cs @param {any} input @param {(r: any, p: any) => Promise<any>} buildCards
 * @returns {Promise<{cards: any, problems: string[], ms: number}>}
 */
async function cardsFor(args, cs, input, buildCards) {
  if (args.embedded) {
    if (!input.cards) return { cards: null, problems: ['no cards field in the input'], ms: 0 };
    return { cards: input.cards, problems: checkCards(input, input.cards), ms: 0 };
  }
  const p = { repo: cs.repo, base: cs.base, head: cs.head || 'HEAD' };
  const t0 = Date.now();
  const cards = await buildCards(input, p);
  const ms = Date.now() - t0;
  const problems = checkCards(input, cards);
  if (JSON.stringify(cards) !== JSON.stringify(await buildCards(input, p))) problems.push('cards not byte-identical on rerun');
  return { cards, problems, ms };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { buildCards } = require(path.join(args.engine, 'src', 'engine', 'cards'));
  const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8')).cases;
  fs.mkdirSync(args.out, { recursive: true });
  let failures = 0, different = 0, compared = 0;
  for (const cs of corpus) {
    if (args.only && cs.name !== args.only) continue;
    const file = path.join(args.inputs, `${cs.name}.json`);
    if (!fs.existsSync(file)) { console.log(`skip ${cs.name}: no input`); continue; }
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { cards, problems, ms } = await cardsFor(args, cs, input, buildCards);
    if (cards) fs.writeFileSync(path.join(args.out, `${cs.name}.json`), JSON.stringify(cards, null, 1));
    failures += problems.length;
    const summary = cards ? `clusters=${cards.clusters.length} sweeps=${cards.sweeps.length} hints=${cards.hints.length} ${ms}ms` : '';
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${cs.name} ${summary}`);
    for (const m of problems) console.log(`  FAIL ${cs.name}: ${m}`);
    if (args.reference && cards) {
      const refFile = path.join(args.reference, `${cs.name}.json`);
      if (!fs.existsSync(refFile)) { console.log(`  reference: none for ${cs.name}`); continue; }
      compared++;
      /** @type {string[]} */
      const paths = [];
      diffPaths(JSON.parse(fs.readFileSync(refFile, 'utf8')), JSON.parse(JSON.stringify(cards)), '', paths, MAX_DIFF_PATHS);
      if (paths.length) different++;
      console.log(paths.length ? `  reference: different at ${paths.join(', ')}${paths.length >= MAX_DIFF_PATHS ? ' ...' : ''}` : '  reference: same');
    }
  }
  if (args.reference) console.log(`reference: ${compared - different} same, ${different} different of ${compared}`);
  console.log(failures ? `${failures} FAILURES` : 'all invariants hold');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
