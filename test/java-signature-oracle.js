// @ts-check
'use strict';
// Dev script, not part of `npm test`: checks parseJavaDeclaration and thrownOf (J3) against
// the JDK's own parser. Usage:
//   node test/java-signature-oracle.js <path-to-java-repo> [--java <java binary>] [--max-files N]
// test/java-signature-oracle/Oracle.java (JDK only: javax.tools and com.sun.source.tree) is
// run with `java`'s single-file source launch from a temp directory; it only parses the
// repository's files, never compiles or runs them. Its output (one JSON line per method and
// constructor) is cached under ~/Projects/impact-tree-scratchpad/java-oracle/, keyed by the
// repository's commit, the oracle's hash and --max-files.
//
// Each declaration's text is cut as jdtls' range gives it (J0-REPORT §1): from the Javadoc,
// block or `//` comments just before the declaration to its end. Compared: header end,
// modifiers (as a set: the Tree API does not keep their order), annotation names, type
// parameters, return type, parameter names/types/varargs (varargs written `T...`), throws,
// and the `throw new` types of the own body. Types are compared with whitespace removed and
// annotations stripped from the oracle's text (the parser drops them).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseJavaDeclaration, thrownOf } = require('../src/languages/java/signature');

const CHILD_DEADLINE_MS = 300000;
const MAX_REPORTED = 30;
const DEFAULT_JAVA = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-tools/jdk/jdk-21.0.13+9/Contents/Home/bin/java');
const CACHE_DIR = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-oracle');
const ORACLE = path.join(__dirname, 'java-signature-oracle', 'Oracle.java');

/** The repository's HEAD commit read from .git (no git command runs in it), or 'nogit'. @param {string} repo */
function commitOf(repo) {
  try {
    const head = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const loose = path.join(repo, '.git', ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(repo, '.git', 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : 'nogit';
  } catch { return 'nogit'; }
}

/** Whitespace removed. @param {string} t */
const squash = (t) => t.replace(/\s+/g, '');
/** Annotations removed (the parser drops them from types), then squashed. @param {string} t */
const typeText = (t) => squash(t.replace(/@[\w.]+(\((?:[^()]|\([^()]*\))*\))?/g, ''));

/**
 * The start of the comments directly before `start`, as jdtls' range includes them.
 * @param {string} src @param {number} start @returns {number}
 */
function rangeStart(src, start) {
  let s = start;
  for (;;) {
    let i = s;
    while (i > 0 && /\s/.test(src[i - 1])) i--;
    if (src.startsWith('*/', i - 2)) {
      const open = src.lastIndexOf('/*', i - 3);
      if (open < 0) return s;
      s = open;
      continue;
    }
    const lineStart = src.lastIndexOf('\n', i - 1) + 1;
    if (src.slice(lineStart, i).trimStart().startsWith('//')) { s = lineStart + src.slice(lineStart, i).search(/\S/); continue; }
    return s;
  }
}

/** @param {any} d @param {string} src @returns {{ field: string, msg: string } | null} */
function compare(d, src) {
  const from = rangeStart(src, d.start);
  const text = src.slice(from, d.end);
  const parsed = parseJavaDeclaration(text);
  if (!parsed) return { field: 'null', msg: 'parseJavaDeclaration returned null' };
  const { sig } = parsed;
  if (parsed.headerEnd !== d.headerEnd - from) return { field: 'headerEnd', msg: `headerEnd ${parsed.headerEnd} != ${d.headerEnd - from}` };
  if ([...parsed.modifiers].sort().join(' ') !== [...d.modifiers].sort().join(' ')) return { field: 'modifiers', msg: `modifiers [${parsed.modifiers}] != [${d.modifiers}]` };
  if (parsed.annotations.join(' ') !== d.annotations.join(' ')) return { field: 'annotations', msg: `annotations [${parsed.annotations}] != [${d.annotations}]` };
  if (typeText(parsed.typeParameters) !== typeText(d.typeParameters)) return { field: 'typeParameters', msg: `typeParameters ${parsed.typeParameters} != ${d.typeParameters}` };
  if (d.name === '<init>' ? sig.returns !== null : sig.name !== d.name) return { field: 'name', msg: `name ${sig.name} != ${d.name}` };
  if ((sig.returns === null ? null : typeText(sig.returns)) !== (d.returns === null ? null : typeText(d.returns))) return { field: 'returns', msg: `returns ${sig.returns} != ${d.returns}` };
  const want = sig.compact ? [] : d.params.map((/** @type {any} */ p) => ({
    name: p.name, type: p.varargs ? typeText(p.type).replace(/\[\]$/, '...') : typeText(p.type), rest: p.varargs,
  }));
  if (sig.params.length !== want.length) return { field: 'params', msg: `param count ${sig.params.length} != ${want.length}` };
  for (let i = 0; i < want.length; i++) {
    const g = sig.params[i];
    const w = want[i];
    if (g.name !== w.name) return { field: 'params', msg: `param ${i} name ${g.name} != ${w.name}` };
    if (squash(g.type) !== w.type) return { field: 'params', msg: `param ${i} (${w.name}) type ${g.type} != ${w.type}` };
    if (g.rest !== w.rest) return { field: 'params', msg: `param ${i} (${w.name}) rest ${g.rest} != ${w.rest}` };
  }
  if (sig.throws.map(typeText).join(',') !== d.throws.map(typeText).join(',')) return { field: 'throws', msg: `throws [${sig.throws}] != [${d.throws}]` };
  const thrown = [...thrownOf(text, parsed.headerEnd)].sort();
  if (thrown.join(',') !== [...d.thrown].sort().join(',')) return { field: 'thrown', msg: `thrown [${thrown}] != [${d.thrown}]` };
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const repo = args[0];
  const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
  const java = opt('--java') || DEFAULT_JAVA;
  const maxFiles = opt('--max-files') || '';
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: node test/java-signature-oracle.js <path-to-java-repo> [--java <java>] [--max-files N]');
    process.exit(2);
  }
  const root = path.resolve(repo);
  const oracleHash = crypto.createHash('sha256').update(fs.readFileSync(ORACLE)).digest('hex').slice(0, 12);
  const key = `${path.basename(root)}-${commitOf(root).slice(0, 12)}-${oracleHash}${maxFiles ? `-max${maxFiles}` : ''}.jsonl`;
  const cached = path.join(CACHE_DIR, key);
  const t0 = Date.now();
  let lines;
  if (fs.existsSync(cached)) {
    lines = fs.readFileSync(cached, 'utf8');
    console.log(`oracle output: cached ${cached}`);
  } else {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-java-oracle-cwd-'));
    try {
      lines = execFileSync(java, [ORACLE, root, ...(maxFiles ? [maxFiles] : [])], {
        cwd: workDir, encoding: 'utf8', maxBuffer: 1 << 30, timeout: CHILD_DEADLINE_MS,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cached, lines);
    console.log(`oracle output: computed in ${Date.now() - t0} ms, cached at ${cached}`);
  }
  const records = lines.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const skipped = records.filter((r) => r.skipped).map((r) => r.skipped);
  const decls = records.filter((r) => !r.skipped);
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {Record<string, number>} */
  const byField = {};
  let agreed = 0;
  let compact = 0;
  /** @type {string[]} */
  const bad = [];
  for (const d of decls) {
    if (!sources.has(d.file)) sources.set(d.file, fs.readFileSync(path.join(root, d.file), 'utf8'));
    const src = /** @type {string} */ (sources.get(d.file));
    const diff = compare(d, src);
    const parsed = diff ? null : parseJavaDeclaration(src.slice(rangeStart(src, d.start), d.end));
    if (parsed && parsed.sig.compact) compact++;
    if (diff === null) { agreed++; continue; }
    byField[diff.field] = (byField[diff.field] || 0) + 1;
    const line = src.slice(0, d.start).split('\n').length;
    bad.push(`${d.file}:${line}: ${src.slice(d.start, d.end).split('\n')[0].trim()}\n    ${diff.msg}`);
  }
  console.log(`files skipped (not parseable by javac): ${skipped.length}`);
  for (const s of skipped.slice(0, MAX_REPORTED)) console.log(`  ${s}`);
  console.log(`files: ${sources.size}, methods and constructors: ${decls.length} (compact record constructors: ${compact})`);
  console.log(`disagreements by field: ${JSON.stringify(byField)}`);
  console.log(`agree ${agreed} of ${decls.length}`);
  for (const b of bad.slice(0, MAX_REPORTED)) console.log(`- ${b}`);
  console.log(`wall time ${Date.now() - t0} ms`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

main();
