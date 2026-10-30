'use strict';
/**
 * Java verification harness (J7; J6 adds the editor mode): runs the pipeline on the PRs of
 * ./java-verify-corpus.json (google/gson) and compares its changed methods and constructors
 * and their signature kinds with oracle (a), the JDK's own parser, which shares no code with
 * the engine's Java reading. A development script, not part of `npm test`:
 *
 *   node test/lsp-harness/java-verify.js [--repo <dedicated gson clone>] [<PR number>…]
 *   node test/lsp-harness/java-verify.js --syntactic [--repo <gson clone>] [<PR number>…]
 *   node test/lsp-harness/java-verify.js --syntactic --callers [--preview] [--repo <gson clone>] [<PR number>…]
 *
 * `--callers` (J8): the syntax index's callers against oracle (b), javac's attribution; see
 * "the caller check" below. Exit 0 when caller precision is >= 95% (and, `--preview`, no
 * answer is complete and none reads "no callers").
 *
 * `--syntactic` (J7): the pipeline runs without a language server, as the no-checkout
 * preview does: `analyzeRemote` offline, its `gh` a fake over the clone's git objects
 * (`git diff`, `git show <sha>:<path>`), so Java goes through `javaProvider.prepareSyntactic`
 * (the text outline, `collectJavaSymbols`, J3's parser, the shared matching). Nothing is
 * checked out and nothing of gson runs; the clone stays where it is. Without `--syntactic`
 * (J6, the editor's jdtls path): see "the editor mode" below; results in J6-REPORT.md.
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

// ---- the caller check (J8): `--syntactic --callers [--preview]`, oracle (b) -----------------
//
// Oracle (b), test/java-signature-oracle/Callers.java: javac's attributed trees
// (`JavacTask.analyze()`) of every Java file of the PR's head tree (module-info.java excluded),
// annotation processing off (`-proc:none`), nothing run, no class file written. Every method
// invocation and `new` whose declaration is in the tree, with the exact overload javac chose;
// what javac cannot attribute (a classpath jar missing, errors) is listed as unattributed and
// excluded from the comparison on both sides; `new T(…) { … }` is excluded the same way.
// The tree is materialised from git objects (`git archive <head>`, Java files only) under
// ~/Projects/impact-tree-scratchpad/java-oracle/trees/ and removed after: nothing is checked
// out in the clone and nothing of gson runs (no Maven, no script, no processor).
// Classpath: the jars jdtls already downloaded (`ORACLE_JARS` under java-tools/m2), not Maven.
// Cache: java-oracle/callers/<head>/oracle-<Callers.java hash>-<classpath hash>.jsonl.
//
// Ours: `createJavaSyntacticIndex` over the scope's files at the head: the CLI's (J-D6: every
// Java file of the tree outside build-output and generated directories) or, with `--preview`,
// the PR's changed Java files (tests included), as `prepareSyntactic` builds them. Targets: the
// PR's changed and added main methods (the pipeline's rows). For each target, the call sites
// our answer lists against the oracle's whose call file is indexed. A site ours lists because
// several same-arity overloads matched is counted apart (the answer says so); a miss is
// labelled `dispatch` (the oracle's target may be reached through an override or interface),
// `unresolved` (ours counted the call as unresolved) or `implicit` (an implicit `super()`).
// The preview also checks the pipeline's rows: no complete answer, no "no callers".

const CALLERS_JAVA = path.join(__dirname, '..', 'java-signature-oracle', 'Callers.java');
const CALLERS_CACHE = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-oracle/callers');
const TREES = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-oracle/trees');
const M2 = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-tools/m2');
const ORACLE_JARS = [
  'junit/junit/4.13.2/junit-4.13.2.jar',
  'org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar',
  'org/junit/jupiter/junit-jupiter-api/6.1.3/junit-jupiter-api-6.1.3.jar',
  'org/junit/jupiter/junit-jupiter-params/6.1.3/junit-jupiter-params-6.1.3.jar',
  'org/opentest4j/opentest4j/1.3.0/opentest4j-1.3.0.jar',
  'org/apiguardian/apiguardian-api/1.1.2/apiguardian-api-1.1.2.jar',
  'com/google/errorprone/error_prone_annotations/2.41.0/error_prone_annotations-2.41.0.jar',
  'com/google/guava/guava-testlib/33.6.0-jre/guava-testlib-33.6.0-jre.jar',
  'org/checkerframework/checker-qual/3.43.0/checker-qual-3.43.0.jar',
  // The versions gson's poms ask for (pom.xml, proto/pom.xml's protobufVersion).
  'com/google/guava/guava/33.7.0-jre/guava-33.7.0-jre.jar',
  'com/google/guava/failureaccess/1.0.3/failureaccess-1.0.3.jar',
  'com/google/truth/truth/1.4.5/truth-1.4.5.jar',
  'com/google/protobuf/protobuf-java/4.35.1/protobuf-java-4.35.1.jar',
  'com/google/protobuf/protobuf-java-util/4.35.1/protobuf-java-util-4.35.1.jar',
  'com/google/testparameterinjector/test-parameter-injector/1.22/test-parameter-injector-1.22.jar',
  'com/google/code/findbugs/jsr305/3.0.2/jsr305-3.0.2.jar',
  'com/google/j2objc/j2objc-annotations/3.1/j2objc-annotations-3.1.jar',
  // metrics/pom.xml.
  'com/google/caliper/caliper/1.0-beta-3/caliper-1.0-beta-3.jar',
  'com/google/caliper/caliper-api/1.0-beta-3/caliper-api-1.0-beta-3.jar',
  'com/google/caliper/caliper-core/1.0-beta-3/caliper-core-1.0-beta-3.jar',
  'com/google/caliper/caliper-runner/1.0-beta-3/caliper-runner-1.0-beta-3.jar',
  'com/fasterxml/jackson/core/jackson-core/2.22.3/jackson-core-2.22.3.jar',
  'com/fasterxml/jackson/core/jackson-databind/2.22.3/jackson-databind-2.22.3.jar',
  'com/fasterxml/jackson/core/jackson-annotations/2.22/jackson-annotations-2.22.jar',
].map((j) => path.join(M2, j)).filter((j) => fs.existsSync(j));
const CALLERS_DEADLINE_MS = 300000;

/** The head tree's Java files, written under a fresh directory from git objects. */
function materialiseHead(repo, pr) {
  fs.mkdirSync(TREES, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TREES, `${pr.number}-`));
  const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', pr.head, '--', ':(glob)**/*.java'], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: tar });
  return dir;
}

function listJava(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.name.endsWith('.java')) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

function callersOracle(repo, pr) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(CALLERS_JAVA)).digest('hex').slice(0, 12);
  const cpHash = crypto.createHash('sha256').update(ORACLE_JARS.map((j) => path.relative(M2, j)).join(':')).digest('hex').slice(0, 12);
  const cacheFile = path.join(CALLERS_CACHE, pr.head, `oracle-${hash}-${cpHash}.jsonl`);
  let text;
  let cached = true;
  if (fs.existsSync(cacheFile)) text = fs.readFileSync(cacheFile, 'utf8');
  else {
    cached = false;
    const dir = materialiseHead(repo, pr);
    try {
      // The launcher compiles Callers.java alone (no classpath: nothing else is loaded);
      // the tree is attributed inside it with `-proc:none` (the source launcher itself runs no
      // annotation processing, JEP 330).
      text = execFileSync(JAVA, [CALLERS_JAVA, dir, ORACLE_JARS.join(path.delimiter)], {
        cwd: os.tmpdir(), encoding: 'utf8', maxBuffer: 1 << 30, timeout: CALLERS_DEADLINE_MS,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, text);
  }
  const records = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    cached, hash, cpHash,
    calls: records.filter((r) => r.call),
    unattributed: records.filter((r) => r.unattributed).map((r) => r.unattributed),
    excluded: records.filter((r) => r.excluded).map((r) => r.excluded),
    summary: records.find((r) => r.errors !== undefined) || {},
    errors: records.filter((r) => r.error).map((r) => r.error),
  };
}

/** The scope's sources at the head: `{ path, text }`. */
function scopeSources(repo, pr, preview) {
  const { javaRules } = require('../../src/languages/java/rules');
  const { NOT_SOURCE_DIRS } = require('../../src/languages/java/provider');
  if (preview) {
    return git(repo, 'diff', '--name-status', '-M', pr.base, pr.head).trim().split('\n').filter(Boolean).flatMap((l) => {
      const [st, a, b] = l.split('\t');
      if (st[0] === 'D') return [];
      const p = st[0] === 'R' ? b : a;
      return isJava(p) ? [{ path: p, text: git(repo, 'show', `${pr.head}:${p}`) }] : [];
    });
  }
  const dir = materialiseHead(repo, pr);
  try {
    return listJava(dir)
      .filter((rel) => javaRules.handles(rel) && !path.posix.dirname(rel).split('/').some((d) => NOT_SOURCE_DIRS.has(d)))
      .map((rel) => ({ path: rel, text: fs.readFileSync(path.join(dir, rel), 'utf8') }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function callerCheck(repo, pr, preview) {
  const { createJavaSyntacticIndex } = require('../../src/languages/java/syntactic-index');
  const o0 = Date.now();
  const oracle = callersOracle(repo, pr);
  const oMs = Date.now() - o0;
  const p0 = Date.now();
  const result = await syntacticPipeline(repo, pr);
  const sources = scopeSources(repo, pr, preview);
  const idx = createJavaSyntacticIndex(sources, { scope: preview ? 'the PR' : 'the tree', partialPackages: preview });
  const pMs = Date.now() - p0;
  const indexed = new Set(sources.map((s) => s.path));
  const textOf = new Map(sources.map((s) => [s.path, s.text]));
  const skip = new Set([...oracle.unattributed, ...oracle.excluded].map((u) => `${u.file}#${u.pos}`));
  const ourCalls = new Map(idx.allCalls().map((c) => [`${c.rel}#${c.pos}`, c]));
  const out = { targets: 0, tp: 0, fp: [], fn: [], sameArity: 0, skippedOurs: 0, rowsComplete: [], rowsNone: [], notIncomplete: [] };
  const rows = result.allChanged.filter((c) => isJava(c.relPath) && !require('../../src/languages').isTestPath(c.relPath));
  for (const c of rows) {
    if (preview) {
      if (c.callersComplete) out.rowsComplete.push(`#${pr.number} ${c.relPath}#${c.key}`);
      if (c.callerState === 'none') out.rowsNone.push(`#${pr.number} ${c.relPath}#${c.key}`);
    }
    const rec = idx.byFile.get(c.relPath);
    const def = rec && rec.defs.find((d) => d.key === c.key || d.label === c.label);
    if (!def) continue;
    out.targets++;
    const answer = idx.callersOfWithStatus({ file: c.relPath, name: def.name, pos: def.namePos });
    const ours = new Set(answer.callers.flatMap((r) => r.callSites.map((s) => `${r.file}#${s.start}`)));
    const theirs = new Set(oracle.calls.filter((r) => r.target.file === c.relPath && r.target.pos === def.namePos && indexed.has(r.call.file)).map((r) => `${r.call.file}#${r.call.pos}`));
    const lineOf = (site) => {
      const [file, pos] = [site.slice(0, site.lastIndexOf('#')), Number(site.slice(site.lastIndexOf('#') + 1))];
      const text = textOf.get(file) || '';
      return `${file}:${text.slice(0, pos).split('\n').length}: ${text.slice(text.lastIndexOf('\n', pos - 1) + 1, text.indexOf('\n', pos)).trim().slice(0, 100)}`;
    };
    for (const s of ours) {
      if (skip.has(s)) { out.skippedOurs++; continue; }
      if (theirs.has(s)) { out.tp++; continue; }
      const hit = ourCalls.get(s);
      // Listed for every same-arity overload while javac chose another one: expected, and the
      // answer must say so.
      if (hit && Array.isArray(hit.targets) && hit.targets.length > 1) {
        out.sameArity++;
        if (!/several overloads with the same number of arguments/.test(answer.incompleteReason || '')) out.fp.push(`#${pr.number} ${c.key} <- ${lineOf(s)} (same-arity, but the answer does not say so)`);
        continue;
      }
      out.fp.push(`#${pr.number} ${c.key} <- ${lineOf(s)}`);
    }
    for (const s of theirs) {
      if (ours.has(s)) continue;
      const o = oracle.calls.find((r) => `${r.call.file}#${r.call.pos}` === s);
      const hit = ourCalls.get(s);
      const text = textOf.get(o.call.file) || '';
      const labels = [
        o.dispatch ? 'dispatch' : null,
        hit && hit.targets === 'unresolved' ? 'unresolved' : null,
        o.name === 'super' && !text.startsWith('super', o.call.pos) ? 'implicit' : null,
        !hit ? 'no-use' : null,
      ].filter(Boolean);
      // Every miss must sit on an incomplete answer; `covered` names the reason that explains it
      // beyond the scope note (which every answer carries).
      const reason = answer.incompleteReason || '';
      const covered = [
        labels.includes('implicit') && /implicit super\(\) call is not listed/.test(reason) ? 'implicit-super reason' : null,
        labels.includes('dispatch') && /an (interface|overridable) method/.test(reason) ? 'dispatch reason' : null,
        labels.includes('unresolved') && idx.unresolvedCallsTo({ name: def.name }) > 0 ? 'unresolved count' : null,
      ].filter(Boolean);
      if (!reason) out.notIncomplete.push(`#${pr.number} ${c.key} <- ${lineOf(s)}`);
      out.fn.push(`#${pr.number} ${c.key} <- ${lineOf(s)} [${labels.join(', ') || 'resolved elsewhere'}] on an incomplete answer: ${reason ? `yes (${covered.join(', ') || 'scope note only'})` : 'NO'}`);
    }
  }
  return { out, oracle, oMs, pMs, files: sources.length };
}

async function callersMain(repo, corpus, preview) {
  const t0 = Date.now();
  const totals = { targets: 0, tp: 0, fp: [], fn: [], sameArity: 0, unattributed: 0, rowsComplete: [], rowsNone: [], notIncomplete: [] };
  // javac's errors and unattributed calls, by module directory and message, over the PRs' trees.
  const why = new Map();
  const tally = (k) => why.set(k, (why.get(k) || 0) + 1);
  console.log(`caller check (${preview ? 'preview: the PR\'s files' : 'CLI: the head tree'}), oracle (b) javac attribution; classpath ${ORACLE_JARS.length} jar(s)`);
  console.log('PR      files targets  tp  fp  fn  same-arity  unattributed  errors  precision  recall   oracle   ours');
  for (const pr of corpus) {
    const { out, oracle, oMs, pMs, files } = await callerCheck(repo, pr, preview);
    totals.targets += out.targets; totals.tp += out.tp; totals.sameArity += out.sameArity; totals.unattributed += oracle.unattributed.length;
    for (const e of oracle.errors) tally(`error ${e.file.split('/')[0]}: ${e.msg.replace(/\b(variable|class|method) \w+/, '$1 …').slice(0, 90)}`);
    for (const u of oracle.unattributed) tally(`unattributed ${u.file.split('/')[0]}/${u.file.includes('/test/') ? 'test' : 'main'}`);
    totals.fp.push(...out.fp); totals.fn.push(...out.fn); totals.rowsComplete.push(...out.rowsComplete); totals.rowsNone.push(...out.rowsNone); totals.notIncomplete.push(...out.notIncomplete);
    console.log(`#${String(pr.number).padEnd(6)} ${String(files).padStart(5)} ${String(out.targets).padStart(7)} ${String(out.tp).padStart(3)} ${String(out.fp.length).padStart(3)} ${String(out.fn.length).padStart(3)} ${String(out.sameArity).padStart(11)} ${String(oracle.unattributed.length).padStart(13)} ${String(oracle.summary.errors).padStart(7)}  ${pct(out.tp, out.tp + out.fp.length).padStart(9)} ${pct(out.tp, out.tp + out.fn.length).padStart(7)}  ${`${(oMs / 1000).toFixed(1)}s${oracle.cached ? ' c' : ''}`.padStart(7)}  ${(pMs / 1000).toFixed(1)}s`);
  }
  console.log(`total targets ${totals.targets}; precision ${pct(totals.tp, totals.tp + totals.fp.length)}; recall ${pct(totals.tp, totals.tp + totals.fn.length)}; same-arity listed ${totals.sameArity}; unattributed by javac ${totals.unattributed}`);
  const list = (title, xs) => { console.log(`${title}: ${xs.length}`); for (const x of xs) console.log(`  ${x}`); };
  list('javac errors and unattributed calls (summed over the PRs, by module)', [...why].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${n}  ${k}`));
  list('false positives', totals.fp);
  list('misses', totals.fn);
  list('misses on a complete answer (must be 0)', totals.notIncomplete);
  if (preview) { list('complete answers (must be 0)', totals.rowsComplete); list('rows reading "no callers" (must be 0)', totals.rowsNone); }
  console.log(`cache ${CALLERS_CACHE}; wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const pass = totals.tp >= 0.95 * (totals.tp + totals.fp.length) && totals.rowsComplete.length === 0 && totals.rowsNone.length === 0 && totals.notIncomplete.length === 0;
  process.exitCode = pass ? 0 : 1;
}

// ---- the editor mode (J6): jdtls, one server for the run ------------------------------------
//
// The editor's path: `analyze()` in `pr` mode over a checkout at the PR's head (base-side
// symbols through the harness's temporary copies, G2's), `javaProvider.prepareFromServerSymbols`
// on jdtls' documentSymbol answers, callers from the call hierarchy with Java's caller extras
// (J4) applied by `applyCallerExtras`, as the editor's resolver applies them
// (./harness-languages.js), at the editor's default concurrency (8). One jdtls for the whole
// run, its `-data` under java-tools/jdtls-data/gson-verify (kept between runs); between PRs the
// checkout moves (`git checkout --detach <head>` in the dedicated clone gson-verify, never
// `gson` itself), one `workspace/didChangeWatchedFiles` names every file that differs, the open
// documents are closed, and the run waits until jdtls has reported no progress for QUIET_MS.
// Callers are compared with oracle (b) (the head tree's javac attribution, J8's cache), over
// every file of the tree; a site of ours matches an oracle call in the same file whose offset
// lies in our call range (jdtls' ranges are the call expressions).

const DEFAULT_EDITOR_REPO = path.join(os.homedir(), 'Projects/impact-tree-test-repos/gson-verify');
const JDTLS_DATA = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/java-tools/jdtls-data/gson-verify');
const QUIET_MS = 2000;
const EDITOR_RUN_DEADLINE_MS = 15 * 60 * 1000;

/** jdtls with every incomingCalls counted: `{ queries, failures: [{ message, label }] }`. */
function countingJdtls(jdtls) {
  const stats = { queries: 0, failures: [] };
  const wrapped = {
    ...jdtls,
    async incomingCalls(item) {
      stats.queries++;
      try {
        return await jdtls.incomingCalls(item);
      } catch (e) {
        stats.failures.push({ message: String(e.message).slice(0, 120), label: item && item.name });
        throw e;
      }
    },
  };
  return { jdtls: wrapped, stats };
}

/** Moves the checkout to `sha` and tells jdtls which files changed. */
async function switchTo(server, repo, sha) {
  const from = git(repo, 'rev-parse', 'HEAD').trim();
  if (git(repo, 'status', '--porcelain', '--untracked-files=no').trim()) throw new Error(`${repo} has uncommitted changes`);
  if (from === sha) return { files: 0, quietMs: 0 };
  const changed = git(repo, 'diff', '--name-only', '--no-renames', from, sha).split('\n').filter(Boolean);
  git(repo, 'checkout', '-q', '--detach', sha);
  if (git(repo, 'rev-parse', 'HEAD').trim() !== sha) throw new Error(`${repo} is not at ${sha}`);
  const { pathToFileURL } = require('url');
  server.closeAll();
  // The editor's build-file watcher (src/languages/java/server-status.js) sees the checkout.
  if (server.buildFilesChanged && changed.some((p) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/.test(p))) server.buildFilesChanged();
  server.client.notify('workspace/didChangeWatchedFiles', {
    changes: changed.map((p) => ({ uri: pathToFileURL(path.join(repo, p)).toString(), type: fs.existsSync(path.join(repo, p)) ? 2 : 3 })),
  });
  return { files: changed.length, quietMs: await server.waitQuiet({ quietMs: QUIET_MS, minMs: QUIET_MS }) };
}

async function editorPipeline(server, repo, pr) {
  const { analyze } = require('../../src/engine/analyze');
  const { languageServicesOver, createHierarchyResolver } = require('./harness-languages');
  const { javaProvider } = require('../../src/languages/java/provider');
  const services = languageServicesOver(server, { repoRoot: repo });
  return analyze(repo, {
    mode: 'pr', base: pr.base, allowLocalBase: true, skipForest: true, deferTestReach: true, depth: 1,
    ...(process.env.J6_CONCURRENCY ? { concurrency: Number(process.env.J6_CONCURRENCY) } : {}),
    languageServices: services,
    makeResolver: ({ language }) => {
      const extras = language === 'java' && javaProvider.editorCallers
        ? javaProvider.editorCallers({ ts: null, services, repoRoot: repo, trace: () => {}, filterInherited: false, onWarmupRetry: () => {}, javaServerStatus: server.javaServerStatus || null })
        : null;
      return createHierarchyResolver(services, { extras });
    },
  });
}

/** The head lines the PR touched, per file (`git diff -U0`). */
function touchedLines(repo, pr) {
  const out = new Map();
  let file = null;
  for (const line of git(repo, 'diff', '-U0', '--no-renames', pr.base, pr.head).split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      if (file) out.set(file, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || !file) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let l = start; l < start + count; l++) out.get(file).add(l);
  }
  return out;
}

function editorCallerCheck(repo, pr, result, oracle) {
  const { classifyChangeVerdict, toneOf } = require('../../src/views/changes/tree-row-models');
  const { OVERRIDES_REASON } = require('../../src/languages/java/editor-extras');
  const { isTestPath } = require('../../src/languages');
  const rel = (abs) => path.relative(repo, abs).split(path.sep).join('/');
  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) { try { texts.set(file, git(repo, 'show', `${pr.head}:${file}`)); } catch { texts.set(file, ''); } }
    return texts.get(file);
  };
  const lineAt = (file, pos) => textOf(file).slice(0, pos).split('\n').length;
  const codeAt = (file, pos) => { const t = textOf(file); return t.slice(t.lastIndexOf('\n', pos - 1) + 1, t.indexOf('\n', pos)).trim().slice(0, 110); };
  const where = (file, pos) => `${file}:${lineAt(file, pos)}: ${codeAt(file, pos)}`;
  const callsByFile = new Map();
  const skippedByFile = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const r of oracle.calls) push(callsByFile, r.call.file, r);
  for (const u of [...oracle.unattributed, ...oracle.excluded]) push(skippedByFile, u.file, u.pos);
  const touched = touchedLines(repo, pr);
  const errorFiles = new Set(oracle.errors.map((e) => e.file));
  // Why jdtls may not see a module's calls of the workspace's code: no pom (no project), or a
  // pom that builds against another gson version (its calls resolve into that jar).
  const showAt = (p) => { try { return git(repo, 'show', `${pr.head}:${p}`); } catch { return null; } };
  const rootPom = showAt('pom.xml') || '';
  const workspaceVersion = (/<artifactId>gson-parent<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(rootPom) || [])[1] || '?';
  const outsideByModule = new Map();
  const outsideProject = (file) => {
    const module = file.split('/')[0];
    if (!outsideByModule.has(module)) {
      const pom = showAt(`${module}/pom.xml`);
      let why = null;
      if (pom === null) why = `outside the project: ${module} has no pom.xml at this commit`;
      else {
        const dep = /<groupId>com\.google\.code\.gson<\/groupId>\s*<artifactId>gson<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(pom);
        const v = dep ? dep[1].trim() : null;
        if (v && !/^\$\{project\.(parent\.)?version\}$/.test(v) && v !== workspaceVersion) why = `outside the project: ${module} builds against gson ${v}, not the workspace's ${workspaceVersion}`;
        else if (!new RegExp(`<module>${module}</module>`).test(rootPom)) why = `${module} is not a module of the root pom`;
      }
      outsideByModule.set(module, why);
    }
    return outsideByModule.get(module);
  };
  // The lines of the call at `pos`: from its line to its closing parenthesis (strings and chars
  // skipped), so a multi-line call updated on a later line counts as updated.
  const callLines = (file, pos) => {
    const t = textOf(file);
    let i = t.indexOf('(', pos);
    let depth = 0;
    for (; i >= 0 && i < t.length; i++) {
      const ch = t[i];
      if (ch === '"' || ch === "'") { for (i++; i < t.length && t[i] !== ch; i++) if (t[i] === '\\') i++; continue; }
      if (ch === '(') depth++;
      if (ch === ')' && --depth === 0) break;
    }
    const first = lineAt(file, pos);
    const last = i > 0 ? lineAt(file, i) : first;
    return Array.from({ length: last - first + 1 }, (_, k) => first + k);
  };
  const out = { targets: 0, tp: 0, fp: [], fn: [], notIncomplete: [], outsideOnComplete: [], fine: [], states: {}, rows: [] };
  const rows = result.allChanged.filter((c) => isJava(c.relPath) && !isTestPath(c.relPath));
  for (const c of rows) {
    out.targets++;
    out.states[c.callerState] = (out.states[c.callerState] || 0) + 1;
    const reason = c.callersComplete ? '' : String(c.callersIncompleteReason || '');
    const isTarget = (r) => r.target.file === c.relPath && r.target.pos === c.namePos;
    const theirs = oracle.calls.filter(isTarget);
    const matched = new Set();
    let tp = 0;
    for (const caller of c.callers) {
      const file = rel(caller.file);
      for (const s of caller.callSites || []) {
        // An implicit `super()` (a class or constructor without an explicit one): javac reports
        // it at the constructor's or class's position, jdtls' range is the declaration's name;
        // they meet on the line.
        const implicitSuper = (r) => r.name === 'super' && !textOf(file).startsWith('super', r.call.pos) && lineAt(file, r.call.pos) === lineAt(file, s.start);
        const inRange = (callsByFile.get(file) || []).filter((r) => (r.call.pos >= s.start && r.call.pos < s.end) || implicitSuper(r));
        const hit = inRange.find((r) => isTarget(r) && !matched.has(`${r.call.file}#${r.call.pos}`));
        if (hit) { tp++; matched.add(`${hit.call.file}#${hit.call.pos}`); continue; }
        // javac could not attribute a call in the range: left out on both sides, as J8.
        if ((skippedByFile.get(file) || []).some((p) => p >= s.start && p < s.end)) continue;
        // Not javac's target here: name what javac resolved the site's call to.
        const other = inRange[0];
        const overReport = reason.includes(OVERRIDES_REASON);
        const state = `answer ${reason ? 'incomplete' : 'COMPLETE'}`;
        const verdict = overReport ? `jdtls over-report on an override: javac resolved it to ${other ? `${other.target.file}#${other.target.pos}` : 'a method outside the tree (the JDK\'s), so oracle (b) lists no call'}; answer incomplete (overrides)`
          : codeAt(file, s.start).startsWith('@') ? `an annotation element set in an annotation (a use, not an invocation: javac records no call); ${state}`
            : other ? `javac resolved it to ${other.target.file}#${other.target.pos}${errorFiles.has(file) ? ' with errors in this file (javac artefact)' : ''}; ${state}`
              : `no call javac attributes in the range${errorFiles.has(file) ? ' (errors in this file)' : ''}; ${state}`;
        out.fp.push({ overReport, text: `#${pr.number} ${c.relPath}#${c.key} <- ${where(file, s.start)} [${verdict}]` });
      }
    }
    out.tp += tp;
    for (const r of theirs.filter((x) => !matched.has(`${x.call.file}#${x.call.pos}`))) {
      const labels = [
        r.dispatch ? 'dispatch' : null,
        r.name === 'super' && !textOf(r.call.file).startsWith('super', r.call.pos) ? 'implicit super()' : null,
        c.callerState === 'unknown' ? 'failed or unknown query' : null,
        outsideProject(r.call.file),
        errorFiles.has(r.call.file) ? 'javac errors in this file' : null,
      ].filter(Boolean);
      const line = `#${pr.number} ${c.relPath}#${c.key} <- ${where(r.call.file, r.call.pos)} [${labels.join(', ') || 'unlabelled'}] on an incomplete answer: ${reason ? `yes (${reason.slice(0, 80)})` : 'NO'}`;
      out.fn.push(line);
      // A call jdtls cannot see (outside its projects) is reported with its label, apart.
      if (!reason) (outsideProject(r.call.file) ? out.outsideOnComplete : out.notIncomplete).push(line);
    }
    // Shown as fine while javac knows a non-test caller whose call line the PR did not touch.
    const notUpdated = theirs.filter((r) => !isTestPath(r.call.file) && !callLines(r.call.file, r.call.pos).some((l) => (touched.get(r.call.file) || new Set()).has(l)));
    const verdict = classifyChangeVerdict(c);
    const fine = toneOf(verdict) === null;
    const risky = c.kinds.some((k) => k.id !== 'body');
    if (risky && fine && notUpdated.length) {
      out.fine.push(`#${pr.number} ${c.relPath}#${c.key} [${c.kinds.map((k) => k.id)}] "${verdict.text}"; ${notUpdated.slice(0, 3).map((r) => where(r.call.file, r.call.pos)).join('; ')}`);
    }
    out.rows.push({ key: c.key, state: c.callerState, complete: c.callersComplete, reason: reason.slice(0, 60), ours: c.callers.reduce((n, x) => n + (x.callSites || []).length, 0), oracle: theirs.length, tp, risky, fine, notUpdated: notUpdated.length });
  }
  return out;
}

async function editorMain(repo, corpus) {
  const { createJdtlsServices } = require('./jdtls-services');
  const t0 = Date.now();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(MEMBERS)).digest('hex').slice(0, 12);
  if (git(repo, 'status', '--porcelain', '--untracked-files=no').trim()) throw new Error(`${repo} has uncommitted changes`);
  const server = createJdtlsServices({ repo, dataDir: JDTLS_DATA, scratchDir: path.join(os.tmpdir(), 'it-java-verify-base') });
  const { jdtls, stats } = countingJdtls(server);
  const killTimer = setTimeout(() => { console.error('overall deadline hit, killing jdtls'); server.client.proc.kill('SIGKILL'); }, EDITOR_RUN_DEADLINE_MS);
  const T = { tp: 0, ours: 0, oracle: 0, kindsOk: 0, kinds: 0, headers: 0, headersOk: 0, extra: [], missed: [], wrongKinds: [], ctp: 0, cfp: [], cfn: [], notIncomplete: [], outsideOnComplete: [], fine: [], targets: 0, states: {} };
  try {
    git(repo, 'checkout', '-q', '--detach', corpus[0].head);
    await server.start();
    console.log(`jdtls ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (-data ${JDTLS_DATA}); status: ${server.javaServerStatus.busyReason() || 'not busy'}; import events ${JSON.stringify(server.importEvents)}`);
    console.log('PR      switch  quiet   ours  oracle  precision  recall   kinds | targets  c.tp  c.fp  c.fn  c.prec  c.recall | oracles  pipeline');
    for (const pr of corpus) {
      const sw = await switchTo(server, repo, pr.head);
      const o0 = Date.now();
      const oa = await oracleFor(repo, pr, hash);
      const ob = callersOracle(repo, pr);
      const oMs = Date.now() - o0;
      const p0 = Date.now();
      const result = await editorPipeline(jdtls, repo, pr);
      const pMs = Date.now() - p0;
      const cmp = comparePr(pipelineRows(result), oracleRows(oa));
      const ok = cmp.kinds.filter((k) => k.ok).length;
      const headers = cmp.kinds.filter((k) => k.expected.some((id) => id !== 'body'));
      T.tp += cmp.tp; T.ours += cmp.ours; T.oracle += cmp.oracle; T.kindsOk += ok; T.kinds += cmp.kinds.length;
      T.headers += headers.length; T.headersOk += headers.filter((k) => k.ok).length;
      T.extra.push(...cmp.extra.map((r) => `#${pr.number} ${r.id} at ${r.line}`));
      T.missed.push(...cmp.missed.map((r) => `#${pr.number} ${r.id} at ${r.line}`));
      T.wrongKinds.push(...cmp.kinds.filter((k) => !k.ok).map((k) => `#${pr.number} ${k.id} at ${k.line}: ours [${k.ours}] expected [${k.expected}]${k.header ? ` (${k.header})` : ''}`));
      const cc = editorCallerCheck(repo, pr, result, ob);
      T.targets += cc.targets; T.ctp += cc.tp; T.cfp.push(...cc.fp); T.cfn.push(...cc.fn); T.notIncomplete.push(...cc.notIncomplete); T.outsideOnComplete.push(...cc.outsideOnComplete); T.fine.push(...cc.fine);
      for (const [k, n] of Object.entries(cc.states)) T.states[k] = (T.states[k] || 0) + n;
      const notAnalysed = (result.unanalysable || []).length;
      console.log(`#${String(pr.number).padEnd(6)} ${String(sw.files).padStart(6)} ${`${(sw.quietMs / 1000).toFixed(1)}s`.padStart(6)} ${String(cmp.ours).padStart(5)} ${String(cmp.oracle).padStart(7)}  ${pct(cmp.tp, cmp.ours).padStart(9)} ${pct(cmp.tp, cmp.oracle).padStart(7)}  ${`${ok}/${cmp.kinds.length}`.padStart(6)} | ${String(cc.targets).padStart(7)} ${String(cc.tp).padStart(5)} ${String(cc.fp.length).padStart(5)} ${String(cc.fn.length).padStart(5)}  ${pct(cc.tp, cc.tp + cc.fp.length).padStart(6)}  ${pct(cc.tp, cc.tp + cc.fn.length).padStart(7)} | ${`${(oMs / 1000).toFixed(1)}s${oa.cached && ob.cached ? ' c' : ''}`.padStart(7)}  ${(pMs / 1000).toFixed(1)}s ${JSON.stringify(cc.states)}${notAnalysed ? ` (${notAnalysed} not analysed)` : ''}`);
      if (process.env.J6_ROWS) for (const r of cc.rows) console.log(`    ${JSON.stringify(r)}`);
      // J6 pass 3: the import-end events seen so far (ms from ServiceReady) and the status now.
      if (pr === corpus[0] && server.importEvents) console.log(`  import events ${JSON.stringify(server.importEvents)}; status now: ${server.javaServerStatus.busyReason() || 'not busy'}`);
    }
  } finally {
    clearTimeout(killTimer);
    await server.close().catch((e) => console.error(`closing jdtls: ${e.message}`));
  }
  console.log(`functions: ${T.ours} ours / ${T.oracle} oracle, precision ${pct(T.tp, T.ours)}, recall ${pct(T.tp, T.oracle)}; kinds ${T.kindsOk}/${T.kinds} (header changes ${T.headersOk}/${T.headers})`);
  console.log(`callers: targets ${T.targets} ${JSON.stringify(T.states)}, TP ${T.ctp}, FP ${T.cfp.length} (${T.cfp.filter((f) => f.overReport).length} over-reports on an override), FN ${T.cfn.length}; precision ${pct(T.ctp, T.ctp + T.cfp.length)}, recall ${pct(T.ctp, T.ctp + T.cfn.length)}`);
  console.log(`incomingCalls: ${stats.queries} queries, ${stats.failures.length} failed (${pct(stats.failures.length, stats.queries)}); default-project callers skipped ${server.skippedCallers()}`);
  const tally = new Map();
  for (const f of stats.failures) tally.set(`${f.message} [${f.label}]`, (tally.get(`${f.message} [${f.label}]`) || 0) + 1);
  const list = (title, xs) => { console.log(`${title}: ${xs.length}`); for (const x of xs) console.log(`  ${x}`); };
  list('incomingCalls failures by message', [...tally].map(([m, n]) => `${n}  ${m}`));
  list('function rows extra (ours, not the oracle\'s)', T.extra);
  list('function rows missed', T.missed);
  list('kinds wrong', T.wrongKinds);
  list('caller false positives', T.cfp.map((f) => f.text));
  list('caller misses', T.cfn);
  list('misses on a complete answer (must be 0)', T.notIncomplete);
  list('misses on a complete answer in a module outside jdtls\' view of the workspace (reported apart)', T.outsideOnComplete);
  list('shown as fine with a non-updated caller javac knows (must be 0)', T.fine);
  console.log(`import-end events (200/100, ms from ServiceReady): ${JSON.stringify(server.importEvents)}; record ${server.recordFile}`);
  console.log(`caches ${CACHE_ROOT}, ${CALLERS_CACHE}; jdtls -data ${JDTLS_DATA}; wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const pass = T.extra.length === 0 && T.tp >= 0.98 * T.oracle && T.wrongKinds.length === 0 && T.notIncomplete.length === 0 && T.fine.length === 0;
  process.exitCode = pass ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const repo = opt('--repo') || DEFAULT_REPO;
  const only = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--repo').map(Number);
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8')).filter((p) => !only.length || only.includes(p.number));
  if (!args.includes('--syntactic')) return editorMain(opt('--repo') || DEFAULT_EDITOR_REPO, corpus);
  if (args.includes('--callers')) return callersMain(repo, corpus, args.includes('--preview'));
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
