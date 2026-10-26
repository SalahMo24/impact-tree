#!/usr/bin/env node
'use strict';
// Oracles for the entry-point detector (src/engine/entry-points.js, entry-facts.js). A
// harness script run by hand, not part of `npm test`: it needs clones of real repositories.
//
//   node test/lsp-harness/entry-oracles.js [--engine <dir>] [--cli <cli/cli clone>] [--httpx <httpx clone>]
//
// (a) --cli: every `&cobra.Command{` literal with Run/RunE (an independent brace counter)
//     against the literals the detector recognises as runnable commands. Also how many got a
//     full `gh <group> <cmd>` command line.
// (b) --httpx: names in httpx/__init__.py `__all__` (Python's own ast, no code executed)
//     against the names the facts gatherer and the detector recognise as public API at their
//     definition.
//
// The clones are only read (`git ls-files`, file reads); nothing in them is run. `--engine`
// is the Impact Tree checkout whose detector is measured (default: this checkout). Exit code
// 1 when a recall is below MIN_RECALL_PERCENT, 2 on bad arguments.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Acceptance recall of the detector against the oracle. Unit: percent.
const MIN_RECALL_PERCENT = 95;

function parseArgs(argv) {
  const out = { engine: path.join(__dirname, '..', '..'), cli: null, httpx: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--engine', '--cli', '--httpx'].includes(key) || !value) {
      console.error('usage: entry-oracles.js [--engine <dir>] [--cli <dir>] [--httpx <dir>]');
      process.exit(2);
    }
    out[key.slice(2)] = path.resolve(value);
  }
  if (!out.cli && !out.httpx) {
    console.error('give at least one of --cli, --httpx');
    process.exit(2);
  }
  return out;
}

/**
 * Lines of every `&cobra.Command{` literal that has a top-level Run/RunE key, found with a
 * brace counter that skips strings (independent of the detector).
 * @param {string} text @returns {number[]} One-based lines.
 */
function oracleCobra(text) {
  const out = [];
  const re = /&cobra\.Command\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let top = '';
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' || ch === '`') {
        const quote = ch;
        i++;
        while (i < text.length && text[i] !== quote) { if (quote === '"' && text[i] === '\\') i++; i++; }
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      if (ch === '}' || ch === ')' || ch === ']') { depth--; if (depth === 0) break; }
      if (depth === 1) top += ch;
    }
    if (/\bRunE?\s*:/.test(top)) out.push(text.slice(0, m.index).split('\n').length);
  }
  return out;
}

/** @returns {number} Recall in percent. */
function checkCobra(engine, cli) {
  const { cobraCommandsIn, declarationEntry } = require(path.join(engine, 'src/engine/entry-points'));
  const { gatherEntryFacts } = require(path.join(engine, 'src/engine/entry-facts'));
  const { makeGit } = require(path.join(engine, 'src/engine/git'));
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: cli, encoding: 'utf8' }).trim();
  const goFiles = execFileSync('git', ['ls-files', '*.go'], { cwd: cli, encoding: 'utf8' }).split('\n')
    .filter((f) => f && !f.endsWith('_test.go') && !/(^|\/)(vendor|testdata)\//.test(f));
  const facts = gatherEntryFacts({ repo: cli, git: makeGit(cli), languages: new Set(['go']) }).facts;
  let oracle = 0;
  let found = 0;
  let hit = 0;
  let falsePositives = 0;
  let fullLine = 0;
  const missed = [];
  for (const f of goFiles) {
    const text = fs.readFileSync(path.join(cli, f), 'utf8');
    if (!text.includes('cobra.Command')) continue;
    const truth = new Set(oracleCobra(text));
    oracle += truth.size;
    const mine = cobraCommandsIn(text).filter((c) => c.runs);
    found += mine.length;
    const lines = new Set();
    for (const c of mine) {
      const line = text.slice(0, c.at).split('\n').length;
      lines.add(line);
      if (truth.has(line)) {
        hit++;
        const entry = c.fn
          ? declarationEntry({ language: 'go', text, pos: text.indexOf(c.fn, text.lastIndexOf('func', c.at)), label: c.fn, relPath: f, facts })
          : null;
        if (entry && /^gh \S+ \S+/.test(entry.name)) fullLine++;
      } else {
        falsePositives++;
        console.log(`    detector-only literal: ${f}:${line}`);
      }
    }
    for (const l of truth) if (!lines.has(l)) missed.push(`${f}:${l}`);
  }
  const recall = oracle ? (100 * hit) / oracle : 0;
  console.log(`(a) cli/cli @ ${head}: cobra literals with Run/RunE = ${oracle}; detector recognised = ${found}; matched = ${hit}`);
  console.log(`    recall ${recall.toFixed(1)}%  precision ${(100 * hit / Math.max(1, found)).toFixed(1)}%  (false positives ${falsePositives})`);
  console.log(`    of the matched, named with a 'gh <group> <cmd>' line via the constructor: ${fullLine} (${(100 * fullLine / Math.max(1, hit)).toFixed(1)}%)`);
  if (missed.length) console.log(`    missed (first 10): ${missed.slice(0, 10).join(', ')}`);
  return recall;
}

/** @returns {number} Recall in percent. */
function checkPublicApi(engine, httpx) {
  const { declarationEntry } = require(path.join(engine, 'src/engine/entry-points'));
  const { gatherEntryFacts } = require(path.join(engine, 'src/engine/entry-facts'));
  const { makeGit } = require(path.join(engine, 'src/engine/git'));
  const all = JSON.parse(execFileSync('python3', ['-I', '-c',
    'import ast,json,sys;t=ast.parse(open(sys.argv[1]).read());' +
    'print(json.dumps([e.value for n in t.body if isinstance(n,ast.Assign) and any(getattr(x,"id",None)=="__all__" for x in n.targets) for e in n.value.elts]))',
    path.join(httpx, 'httpx/__init__.py')], { encoding: 'utf8' }));
  const pyFacts = gatherEntryFacts({ repo: httpx, git: makeGit(httpx), languages: new Set(['python']) }).facts;
  let detected = 0;
  const notDetected = [];
  const factsOnly = [];
  for (const name of all) {
    let ok = false;
    let located = false;
    for (const [rel, names] of pyFacts.pyPublic || []) {
      if (!names.has(name)) continue;
      const text = fs.readFileSync(path.join(httpx, rel), 'utf8');
      const m = new RegExp(`^(?:class|def|async def)\\s+(${name})\\b|^(${name})\\s*[:=]`, 'm').exec(text);
      if (!m) continue;
      located = true;
      const pos = m.index + m[0].indexOf(name);
      const e = declarationEntry({ language: 'python', text, pos, label: name, relPath: rel, facts: pyFacts });
      if (e && e.type === 'public-api') ok = true;
    }
    if (ok) detected++;
    else if (!located && [...(pyFacts.pyPublic || [])].some(([, n]) => n.has(name))) factsOnly.push(name);
    else notDetected.push(name);
  }
  const recall = all.length ? (100 * detected) / all.length : 0;
  console.log(`(b) httpx __all__ = ${all.length} names; recognised as public API at their definition = ${detected} (${recall.toFixed(1)}%)`);
  if (factsOnly.length) console.log(`    in the facts but no def/class/assignment found to check (re-exported or defined otherwise): ${factsOnly.join(', ')}`);
  if (notDetected.length) console.log(`    not recognised: ${notDetected.join(', ')}`);
  return recall;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const recalls = [];
  if (args.cli) recalls.push(checkCobra(args.engine, args.cli));
  if (args.httpx) recalls.push(checkPublicApi(args.engine, args.httpx));
  const failed = recalls.some((r) => r < MIN_RECALL_PERCENT);
  console.log(failed ? `FAIL: a recall is below ${MIN_RECALL_PERCENT}%` : `OK: every recall is at least ${MIN_RECALL_PERCENT}%`);
  process.exit(failed ? 1 : 0);
}

main();
