'use strict';
/**
 * Java verification harness (J7; J6 adds the editor mode): runs the pipeline on the PRs of
 * ./java-verify-corpus.json (google/gson) and compares its changed methods and constructors
 * and their signature kinds with oracle (a), the JDK's own parser, which shares no code with
 * the engine's Java reading. A development script, not part of `npm test`:
 *
 *   node test/lsp-harness/java-verify.js --syntactic [--repo <gson clone>] [<PR number>…]
 *
 * `--syntactic` (J7): the pipeline runs without a language server, as the no-checkout
 * preview does: `analyzeRemote` offline, its `gh` a fake over the clone's git objects
 * (`git diff`, `git show <sha>:<path>`), so Java goes through `javaProvider.prepareSyntactic`
 * (the text outline, `collectJavaSymbols`, J3's parser, the shared matching). Nothing is
 * checked out and nothing of gson runs; the clone stays where it is. Without `--syntactic`
 * (the editor's jdtls path) this script stops: J6 adds that mode (a `pipelineFor` branch).
 *
 * Compared, over the PR's changed main (non-test) Java files, as the preview diffs them:
 * - Functions: rows `<path>#<key>|added|changed|removed`. Precision = ours that the oracle
 *   has; recall = the oracle's that we have. Every extra and miss is listed with file:line.
 * - Kinds, for each changed function both see: our kind ids against the oracle's expected
 *   ids (exact set equality).
 *
 * Oracle (a), test/java-signature-oracle/Members.java (javac's Tree API, parse only), run on
 * the base and head texts of the changed files (written to a temporary directory):
 * - Keys: `<types>.<name>(<erased types>)` built from the tree (Members.java's header says
 *   which members are candidates and how types are erased); constructors `<init>`, a compact
 *   record constructor with the components' types; a repeat in one file `#2`, `#3` in
 *   source order. J-D3's pairing then applies to the oracle's keys (one gone and one new
 *   method of a name in one type: the new one takes the old key).
 * - Status: removed = base key not in head; added = head key not in base; changed = a head
 *   key also in base whose lines (from its first annotation or modifier, so leading Javadoc
 *   and comments are outside, to its end) hold an added line of `git diff -U0`, or a pure
 *   deletion between two of its lines. Hunks are parsed here, not by src/engine/patch.js.
 * - Kinds: the tree's facts (parameters as written with names and varargs, return type,
 *   type parameters, declared throws, modifiers, interface membership; a compact
 *   constructor has no parameters, as J3's sig) form a `sig` per side, and the expected
 *   kinds are what `javaKindsOf` (J3's rules on the shared `diffSignature`) says for those
 *   two sigs, plus `new-throw` when the head's `throw new` types (from the tree) gain one,
 *   `body` when none. So the kind *rules* are ours; what they are fed is the JDK's.
 * Limits: a head key with no hunk whose text equals a base symbol's of the same label (the
 * engine's "renumbered repeat") is still added here; files javac cannot parse are listed and
 * skipped on both sides.
 *
 * Cache: the oracle's answer for a PR depends only on its two commits and Members.java, so
 * it is kept at ~/Projects/impact-tree-scratchpad/java-oracle/verify/<head>-<base>/
 * oracle-<Members.java hash>.json.
 *
 * Exit code: 0 when functions are 100% precise with recall >= 98% and every kind agrees,
 * 1 otherwise, 2 on a usage error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_REPO = path.join(os.homedir(), 'Projects/impact-tree-test-repos/gson');
const JAVA = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-tools/jdk/jdk-21.0.13+9/Contents/Home/bin/java');
const CACHE_ROOT = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-oracle/verify');
const MEMBERS = path.join(__dirname, '..', 'java-signature-oracle', 'Members.java');
const CORPUS = path.join(__dirname, 'java-verify-corpus.json');
const ORACLE_DEADLINE_MS = 120000;

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const isJava = (p) => /\.java$/.test(p);

/** The PR's changed Java files, renames followed: `{ path, oldPath, status }` (A/D/M/R). */
function changedJavaFiles(repo, pr) {
  const { isTestPath } = require('../../src/languages');
  return git(repo, 'diff', '--name-status', '-M', pr.base, pr.head).trim().split('\n').filter(Boolean).map((l) => {
    const [st, a, b] = l.split('\t');
    const renamed = st[0] === 'R';
    return { path: renamed ? b : a, oldPath: a, status: st[0] };
  }).filter((f) => isJava(f.path) && !isTestPath(f.path));
}

// ---- oracle (a) ------------------------------------------------------------------------

/** Head lines with an added line, and pure deletions (`after`: the head line they follow). */
function hunksOf(repo, pr, f) {
  const diff = git(repo, 'diff', '-U0', '-M', pr.base, pr.head, '--', ...(f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]));
  const added = [];
  const pureDeletions = [];
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[2]);
    const count = m[3] === undefined ? 1 : Number(m[3]);
    if (count === 0) pureDeletions.push(start);
    for (let l = start; l < start + count; l++) added.push(l);
  }
  return { added, pureDeletions };
}

async function oracleFor(repo, pr, hash) {
  const cacheFile = path.join(CACHE_ROOT, `${pr.head}-${pr.base}`, `oracle-${hash}.json`);
  if (fs.existsSync(cacheFile)) return { ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')), cached: true };
  const files = changedJavaFiles(repo, pr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-java-verify-'));
  try {
    for (const f of files) {
      for (const [side, sha, p] of [['base', pr.base, f.oldPath], ['head', pr.head, f.path]]) {
        if ((side === 'base' && f.status === 'A') || (side === 'head' && f.status === 'D')) continue;
        const out = path.join(dir, side, p);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, git(repo, 'show', `${sha}:${p}`));
      }
    }
    const lines = execFileSync(JAVA, [MEMBERS, dir], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: ORACLE_DEADLINE_MS });
    const records = lines.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const answer = {
      files: files.map((f) => ({ ...f, hunks: hunksOf(repo, pr, f) })),
      skipped: records.filter((r) => r.skipped).map((r) => r.skipped),
      members: records.filter((r) => !r.skipped),
    };
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(answer));
    return { ...answer, cached: false };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One side's members keyed, repeats numbered in source order. */
function keyed(members) {
  const seen = new Map();
  return members.map((m) => {
    const base = `${[...m.path, m.name].join('.')}(${m.keyTypes.join(', ')})`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...m, key: n === 1 ? base : `${base}#${n}` };
  });
}

/** J-D3 over the oracle's keys: one gone and one new of a name pair up. */
function paired(base, head) {
  const bk = new Set(base.map((m) => m.key));
  const hk = new Set(head.map((m) => m.key));
  const nameOf = (m) => m.key.slice(0, m.key.indexOf('('));
  const groups = new Map();
  const g = (n) => { if (!groups.has(n)) groups.set(n, { gone: [], fresh: [] }); return groups.get(n); };
  for (const b of base) if (!hk.has(b.key)) g(nameOf(b)).gone.push(b);
  for (const h of head) if (!bk.has(h.key)) g(nameOf(h)).fresh.push(h);
  const rename = new Map();
  for (const { gone, fresh } of groups.values()) if (gone.length === 1 && fresh.length === 1) rename.set(fresh[0], gone[0].key);
  return head.map((h) => (rename.has(h) ? { ...h, key: rename.get(h) } : h));
}

/** The oracle's facts as the symbol `javaKindsOf` reads. */
function symbolOf(m) {
  return {
    sig: {
      async: false, name: m.name, params: m.compact ? [] : m.params.map((p) => ({ name: p.name, type: p.type, optional: false, rest: p.rest })),
      returns: m.returns, typeParameters: m.typeParameters, throws: m.throws, compact: m.compact,
    },
    modifiers: m.modifiers, inInterface: m.inInterface, header: '', throws: new Set(m.thrown),
  };
}

function expectedKinds(b, h) {
  const { javaKindsOf } = require('../../src/languages/java/signature');
  const { newThrows, KIND } = require('../../src/engine/signature');
  const bs = symbolOf(b);
  const hs = symbolOf(h);
  const kinds = javaKindsOf(bs, hs);
  if (newThrows(bs, hs).length && !kinds.includes(KIND.NEW_THROW)) kinds.push(KIND.NEW_THROW);
  return (kinds.length ? kinds : [KIND.BODY]).map((k) => k.id).sort();
}

/** The oracle's rows for a PR: `{ id, line, kinds? }`. */
function oracleRows(oracle) {
  const rows = [];
  for (const f of oracle.files) {
    const side = (s, p) => keyed(oracle.members.filter((m) => m.file === `${s}/${p}`));
    const base = f.status === 'A' ? [] : side('base', f.oldPath);
    const head = f.status === 'D' ? [] : paired(base, side('head', f.path));
    const baseByKey = new Map(base.map((m) => [m.key, m]));
    const headKeys = new Set(head.map((m) => m.key));
    for (const b of base) if (!headKeys.has(b.key)) rows.push({ id: `${f.path}#${b.key}|removed`, line: `${f.oldPath}:${b.startLine} (base)` });
    for (const h of head) {
      const b = baseByKey.get(h.key);
      if (!b) { rows.push({ id: `${f.path}#${h.key}|added`, line: `${f.path}:${h.startLine}` }); continue; }
      const touched = f.hunks.added.some((l) => h.startLine <= l && l <= h.endLine)
        || f.hunks.pureDeletions.some((after) => h.startLine <= after && after + 1 <= h.endLine);
      if (touched) rows.push({ id: `${f.path}#${h.key}|changed`, line: `${f.path}:${h.startLine}`, kinds: expectedKinds(b, h) });
    }
  }
  return rows;
}

// ---- the pipeline ----------------------------------------------------------------------

/** The no-checkout preview, offline, over the clone's git objects. */
async function syntacticPipeline(repo, pr) {
  const statusOf = { A: 'added', D: 'removed', M: 'modified' };
  const gh = {
    listPullRequestFiles: async () => {
      const files = git(repo, 'diff', '--name-status', '-M', pr.base, pr.head).trim().split('\n').filter(Boolean).map((l) => {
        const [st, a, b] = l.split('\t');
        const renamed = st[0] === 'R';
        const p = renamed ? b : a;
        const diff = git(repo, 'diff', '-M', pr.base, pr.head, '--', ...(renamed ? [a, b] : [p]));
        const at = diff.indexOf('\n@@');
        return { path: p, oldPath: renamed ? a : p, status: renamed ? 'renamed' : statusOf[st[0]] || 'modified', patch: at >= 0 ? diff.slice(at + 1) : null };
      });
      return { total: files.length, files };
    },
    fileAtRef: async (_slug, p, ref) => { try { return git(repo, 'show', `${ref}:${p}`); } catch { return null; } },
  };
  const { analyzeRemote } = require('../../src/engine/analyze-remote');
  return analyzeRemote({
    ts: require('typescript'), gh, slug: {}, repoRoot: repo,
    pr: { number: pr.number, headSha: pr.head, mergeBaseSha: pr.base, baseRef: 'base' },
  });
}

// J6: `editorPipeline(repo, pr)` (jdtls through test/lsp-harness/jdtls-services.js) goes here.

function pipelineRows(result) {
  const java = (x) => isJava(x.relPath);
  return [
    ...result.allChanged.filter(java).map((c) => ({ id: `${c.relPath}#${c.key}|${c.added ? 'added' : 'changed'}`, line: `${c.relPath}:${c.startLine}`, kinds: c.kinds.map((k) => k.id).sort(), c })),
    ...result.deleted.filter(java).map((d) => ({ id: `${d.relPath}#${d.key}|removed`, line: `${d.oldPath || d.relPath}:${d.startLine} (base)` })),
  ];
}

// ---- comparison ------------------------------------------------------------------------

function comparePr(ours, oracle) {
  const oracleIds = new Map(oracle.map((r) => [r.id, r]));
  const ourIds = new Map(ours.map((r) => [r.id, r]));
  const extra = ours.filter((r) => !oracleIds.has(r.id));
  const missed = oracle.filter((r) => !ourIds.has(r.id));
  const tp = ours.length - extra.length;
  const kinds = [];
  for (const o of oracle.filter((r) => r.kinds)) {
    const r = ourIds.get(o.id);
    if (!r) continue;
    kinds.push({ id: o.id, line: o.line, ours: r.kinds, expected: o.kinds, ok: r.kinds.join(',') === o.kinds.join(','), header: r.c && r.c.baseSig !== r.c.headSig ? `${r.c.baseSig} → ${r.c.headSig}` : null });
  }
  return { tp, extra, missed, ours: ours.length, oracle: oracle.length, kinds };
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const repo = opt('--repo') || DEFAULT_REPO;
  if (!args.includes('--syntactic')) {
    console.error('usage: node test/lsp-harness/java-verify.js --syntactic [--repo <gson clone>] [<PR number>…]\n(the editor mode, with jdtls, is J6\'s)');
    process.exit(2);
  }
  const only = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--repo').map(Number);
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8')).filter((p) => !only.length || only.includes(p.number));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(MEMBERS)).digest('hex').slice(0, 12);
  const t0 = Date.now();
  const kindTally = {};
  const statusTally = {};
  const totals = { tp: 0, ours: 0, oracle: 0, kindsOk: 0, kinds: 0, extra: [], missed: [], wrongKinds: [], skipped: [] };
  console.log('PR      files  ours  oracle  precision  recall   kinds   oracle   pipeline');
  for (const pr of corpus) {
    const o0 = Date.now();
    const oracle = await oracleFor(repo, pr, hash);
    const oMs = Date.now() - o0;
    const p0 = Date.now();
    const result = await syntacticPipeline(repo, pr);
    const pMs = Date.now() - p0;
    const cmp = comparePr(pipelineRows(result), oracleRows(oracle));
    const ok = cmp.kinds.filter((k) => k.ok).length;
    totals.tp += cmp.tp; totals.ours += cmp.ours; totals.oracle += cmp.oracle;
    totals.kindsOk += ok; totals.kinds += cmp.kinds.length;
    for (const k of cmp.kinds) for (const id of k.expected) kindTally[id] = (kindTally[id] || 0) + 1;
    for (const r of oracleRows(oracle)) { const st = r.id.slice(r.id.lastIndexOf('|') + 1); statusTally[st] = (statusTally[st] || 0) + 1; }
    totals.extra.push(...cmp.extra.map((r) => `#${pr.number} ${r.id} at ${r.line}`));
    totals.missed.push(...cmp.missed.map((r) => `#${pr.number} ${r.id} at ${r.line}`));
    totals.wrongKinds.push(...cmp.kinds.filter((k) => !k.ok).map((k) => `#${pr.number} ${k.id} at ${k.line}: ours [${k.ours}] expected [${k.expected}]${k.header ? ` (${k.header})` : ''}`));
    totals.skipped.push(...oracle.skipped.map((s) => `#${pr.number} ${s}`));
    const notAnalysed = (result.warnings || []).filter((w) => /\.java: NOT analysed/.test(w));
    totals.skipped.push(...notAnalysed.map((w) => `#${pr.number} pipeline: ${w}`));
    console.log(`#${String(pr.number).padEnd(6)} ${String(oracle.files.length).padStart(5)} ${String(cmp.ours).padStart(5)} ${String(cmp.oracle).padStart(7)}  ${pct(cmp.tp, cmp.ours).padStart(9)} ${pct(cmp.tp, cmp.oracle).padStart(7)}  ${`${ok}/${cmp.kinds.length}`.padStart(6)}  ${`${(oMs / 1000).toFixed(1)}s${oracle.cached ? ' c' : ''}`.padStart(7)}  ${(pMs / 1000).toFixed(1)}s`);
  }
  console.log(`total          ${String(totals.ours).padStart(5)} ${String(totals.oracle).padStart(7)}  ${pct(totals.tp, totals.ours).padStart(9)} ${pct(totals.tp, totals.oracle).padStart(7)}  ${`${totals.kindsOk}/${totals.kinds}`.padStart(6)}`);
  console.log(`oracle rows by status ${JSON.stringify(statusTally)}; expected kinds of the matched changed rows ${JSON.stringify(kindTally)}`);
  const list = (title, xs) => { console.log(`${title}: ${xs.length}`); for (const x of xs) console.log(`  ${x}`); };
  list('extra (ours, not the oracle\'s)', totals.extra);
  list('missed (the oracle\'s, not ours)', totals.missed);
  list('kinds wrong', totals.wrongKinds);
  list('skipped files', totals.skipped);
  console.log(`cache ${CACHE_ROOT} (Members.java ${hash}); wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const pass = totals.extra.length === 0 && totals.tp >= 0.98 * totals.oracle && totals.wrongKinds.length === 0;
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
