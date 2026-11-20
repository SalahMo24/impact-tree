// @ts-check
'use strict';
/**
 * C# verification harness (Part C). A development script, not part of `npm test`.
 *
 *   node test/lsp-harness/csharp-verify.js --syntactic --repo <C# clone> --commit <sha>
 *        --outline <module exporting outlineOf(text)> [--prs <n,n,…>] [--tools <dir>]
 *   node test/lsp-harness/csharp-verify.js --oracle-only --repo <C# clone> --commit <sha>
 *   node test/lsp-harness/csharp-verify.js --signatures [--all-kinds] --repo <C# clone> --commit <sha>
 *   node test/lsp-harness/csharp-verify.js --kinds --repo <C# clone> --commit <sha> --prs <n,n,…>
 *   node test/lsp-harness/csharp-verify.js --fixture-keys [--write]
 *
 * `--fixture-keys`: pins the oracle's key function on constructs the test repositories lack
 * (extension blocks, checked operators and conversions, indexers, generic explicit
 * implementations). Each `test/csharp-syntax-oracle/fixtures/<name>.cs` is committed into a
 * throwaway git repository in the OS temp folder and run through the oracle (seconds, no
 * cache); its members' `<kind> <key>` lines must equal `<name>.expected.json`. `--write`
 * rewrites the expected files from the oracle (review the diff by hand).
 *
 * `--signatures` (C2): src/languages/csharp/signature.js on every method and constructor's
 * text (the oracle's span; `--all-kinds` adds properties, indexers, operators, conversions),
 * every field compared with the oracle's (name, explicit interface, modifiers, attributes,
 * type parameters, return type, each parameter's name, type, modifiers, default, attributes
 * and key type, the key's parameter text, header, body kind). Exit 0 only at 100% agreement.
 * `--kinds` (C2): the PRs' members whose header changed (oracle headers, J-D3 pairing), each
 * with `csharpKindsOf`, for checking by hand.
 *
 * `--syntactic` (C0a-1): a candidate text outline against the Roslyn syntax oracle
 * (test/csharp-syntax-oracle/, README.md there for its format), which shares no code with
 * src/. Nothing of the repository is checked out, built or run: files are read from git
 * objects at the commit.
 *
 * The candidate: `require(<--outline>).outlineOf(text)` returns the file's members as
 * `{ key, kind?, nameOffset?, start, end }[]`, offsets in UTF-16 code units with the oracle's
 * meaning (Roslyn `Span`: attributes in, leading trivia and XML doc comments out) and keys per
 * C-D6 (repeats `#2` in source order). C3's outline will export this; until then an adapter.
 *
 * 1. Whole repository at --commit: each candidate member is paired with one oracle member of
 *    its file (the same key; else the same `nameOffset` when the candidate gives it; else the
 *    largest span overlap).
 *    Precision = paired / candidate members; recall = paired / oracle members; ranges = paired
 *    with start and end equal (and, separately, start and end lines equal); keys = paired with
 *    equal keys. Per kind for the oracle's members.
 * 2. `--prs`: for each PR (a merge commit "Merge pull request #N" or a squash commit "(#N)"
 *    reachable from --commit; base = its first parent), the changed members of its changed
 *    non-test .cs files, as java-verify.js computes them: rows `<path>#<key>|added|changed|removed`,
 *    J-D3 pairing (one gone and one new key of a name in a file: the new takes the old key),
 *    changed = a head member whose lines hold an added line of `git diff -U0` or a pure
 *    deletion between two of its lines. The same rule runs over the candidate's members and
 *    the oracle's; precision and recall of the candidate's rows.
 *
 * Cache: ~/Projects/impact-tree-scratchpad/csharp-tools/cache/
 *   syntax-<repo>-<sha12>-<toolhash>.json (whole commit) and
 *   prs-<repo>-<listhash>-<toolhash>.json (PR files), toolhash = sha256 of the oracle's
 *   Program.cs + SyntaxOracle.csproj (which pins the Roslyn version). The oracle is built
 *   into <tools>/oracle-syntax/ (default ~/Projects/impact-tree-scratchpad/csharp-tools) with
 *   the SDK there (<tools>/env.sh's variables), rebuilt when the toolhash changes.
 *
 * Exit code: 0 when members are 100% precise with recall >= 99%, ranges and keys all equal and
 * PR rows (if any) 100% precise with recall >= 98%; 1 otherwise; 2 on a usage error.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { scratchpadPath } = require('./scratchpad');

const ORACLE_SRC = path.join(__dirname, '..', 'csharp-syntax-oracle');
const ORACLE_FILES = ['Program.cs', 'SyntaxOracle.csproj'];
const ORACLE_DEADLINE_MS = 600000;
const MAX_LISTED = 15;

/** @param {string} repo @param {...string} args */
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
/** Test paths (C1 will own the real rule): a tests/ folder, a *Tests/ project, a *Tests.cs file. @param {string} p */
const isTestPath = (p) => /(^|\/)tests?\//i.test(p) || /Tests?(\.\w+)?\//.test(p) || /Tests?\.cs$/.test(p);
const isCs = (/** @type {string} */ p) => /\.cs$/.test(p) && !p.split('/').slice(0, -1).some((s) => s === 'bin' || s === 'obj');

// ---- the oracle ------------------------------------------------------------------------

function toolHash() {
  const h = crypto.createHash('sha256');
  for (const f of ORACLE_FILES) h.update(fs.readFileSync(path.join(ORACLE_SRC, f)));
  return h.digest('hex').slice(0, 12);
}

/** @param {string} tools */
function dotnetEnv(tools) {
  const root = path.join(tools, 'dotnet');
  return {
    ...process.env, DOTNET_ROOT: root, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_HOME: path.join(tools, 'dotnet-home'), NUGET_PACKAGES: path.join(tools, 'nuget'), PATH: `${root}:${process.env.PATH}`,
  };
}

/** The built oracle (rebuilt when its source changed). @param {string} tools @param {string} hash */
function ensureOracle(tools, hash) {
  const dir = path.join(tools, 'oracle-syntax');
  const dll = path.join(dir, 'out', 'SyntaxOracle.dll');
  const stamp = path.join(dir, 'out', '.toolhash');
  if (fs.existsSync(dll) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return dll;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ORACLE_FILES) fs.copyFileSync(path.join(ORACLE_SRC, f), path.join(dir, f));
  const t0 = Date.now();
  execFileSync(path.join(tools, 'dotnet', 'dotnet'), ['build', path.join(dir, 'SyntaxOracle.csproj'), '-c', 'Release', '-o', path.join(dir, 'out'), '-nologo', '-v', 'q'],
    { cwd: dir, env: dotnetEnv(tools), stdio: ['ignore', 'pipe', 'inherit'], timeout: ORACLE_DEADLINE_MS });
  fs.writeFileSync(stamp, hash);
  console.log(`oracle built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return dll;
}

/**
 * The oracle's answer, cached. `what` is a commit, or `{ list }` (`<commit>:<path>` lines).
 * @param {{ repo: string, tools: string, what: string | { list: string[] } }} o
 * @returns {{ files: any[], cached: boolean, ms: number }}
 */
function oracle({ repo, tools, what }) {
  const hash = toolHash();
  const name = path.basename(path.resolve(repo));
  const cacheDir = path.join(tools, 'cache');
  let file;
  if (typeof what === 'string') {
    file = path.join(cacheDir, `syntax-${name}-${git(repo, 'rev-parse', `${what}^{commit}`).trim().slice(0, 12)}-${hash}.json`);
  } else {
    const lh = crypto.createHash('sha256').update(what.list.join('\n')).digest('hex').slice(0, 12);
    file = path.join(cacheDir, `prs-${name}-${lh}-${hash}.json`);
  }
  const t0 = Date.now();
  if (fs.existsSync(file)) return { files: JSON.parse(fs.readFileSync(file, 'utf8')).files, cached: true, ms: Date.now() - t0 };
  const dll = ensureOracle(tools, hash);
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${file}.tmp`;
  const t1 = Date.now();
  let arg = /** @type {string} */ (what);
  if (typeof what !== 'string') { arg = `--list=${file}.list`; fs.writeFileSync(`${file}.list`, `${what.list.join('\n')}\n`); }
  execFileSync(path.join(tools, 'dotnet', 'dotnet'), [dll, path.resolve(repo), arg, tmp],
    { env: dotnetEnv(tools), stdio: ['ignore', 'inherit', 'inherit'], timeout: ORACLE_DEADLINE_MS });
  fs.renameSync(tmp, file);
  if (typeof what !== 'string') fs.rmSync(`${file}.list`);
  return { files: JSON.parse(fs.readFileSync(file, 'utf8')).files, cached: false, ms: Date.now() - t1 };
}

// ---- reading the repository --------------------------------------------------------------

/** Texts of `<commit>:<path>` objects through one `git cat-file --batch`. @param {string} repo @param {string[]} names */
function readObjects(repo, names) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (!names.length) return out;
  const buf = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], { input: `${names.join('\n')}\n`, maxBuffer: 1 << 30 });
  let at = 0;
  for (const name of names) {
    const nl = buf.indexOf(10, at);
    const header = buf.toString('utf8', at, nl);
    at = nl + 1;
    if (header.endsWith(' missing')) continue;
    const size = Number(header.split(' ')[2]);
    out.set(name, buf.toString('utf8', at, at + size));
    at += size + 1;
  }
  return out;
}

/** 1-based line of each offset. @param {string} text */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (/** @type {number} */ off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/** The candidate's members of a text, lines added. @param {(t: string) => any[]} outlineOf @param {string} text */
function candidateOf(outlineOf, text) {
  const lineOf = lineIndex(text);
  return outlineOf(text).map((m) => ({ ...m, startLine: lineOf(m.start), endLine: lineOf(Math.max(m.start, m.end - 1)) }));
}

// ---- 1. whole commit ----------------------------------------------------------------------

/** One-to-one pairing of candidate and oracle members of a file. @param {any[]} ours @param {any[]} theirs */
function pairMembers(ours, theirs) {
  const used = new Set();
  /** @type {Map<any, any>} */
  const pairOf = new Map();
  // 1. the same key in the file; 2. the same name offset; 3. the largest span overlap.
  const byKey = new Map(theirs.map((o) => [o.key, o]));
  for (const c of ours) {
    const o = byKey.get(c.key);
    if (o && !used.has(o)) { used.add(o); pairOf.set(c, o); }
  }
  for (const c of ours) {
    if (pairOf.has(c)) continue;
    let best = null;
    let bestScore = 0;
    for (const o of theirs) {
      if (used.has(o)) continue;
      if (c.nameOffset !== undefined) { if (o.nameOffset === c.nameOffset) { best = o; break; } continue; }
      const overlap = Math.min(c.end, o.end) - Math.max(c.start, o.start);
      const score = overlap > 0 ? overlap / Math.max(c.end - c.start, o.end - o.start) : 0;
      if (score > bestScore) { best = o; bestScore = score; }
    }
    if (best) { used.add(best); pairOf.set(c, best); }
  }
  /** @type {[any, any][]} */
  const pairs = ours.filter((c) => pairOf.has(c)).map((c) => [c, pairOf.get(c)]);
  return { pairs, extra: ours.filter((c) => !pairOf.has(c)), missed: theirs.filter((o) => !used.has(o)) };
}

const pct = (/** @type {number} */ a, /** @type {number} */ b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

/** @param {string} repo @param {string} commit @param {(t: string) => any[]} outlineOf @param {string} tools */
function wholeCommit(repo, commit, outlineOf, tools) {
  const o = oracle({ repo, tools, what: commit });
  console.log(`oracle: ${o.files.length} files, ${o.cached ? 'cached' : 'computed'} in ${(o.ms / 1000).toFixed(1)} s`);
  const sha = git(repo, 'rev-parse', `${commit}^{commit}`).trim();
  const texts = readObjects(repo, o.files.map((f) => `${sha}:${f.path}`));
  const T = { ours: 0, oracle: 0, paired: 0, ranges: 0, lines: 0, keys: 0, diagnostics: 0, topLevel: 0, hasIf: 0 };
  /** @type {Record<string, { oracle: number, paired: number, ranges: number, keys: number }>} */
  const byKind = Object.create(null);
  /** @type {Record<string, string[]>} */
  const examples = { extra: [], missed: [], range: [], key: [], threw: [] };
  for (const f of o.files) {
    const text = /** @type {string} */ (texts.get(`${sha}:${f.path}`));
    if (f.diagnostics) T.diagnostics++;
    if (f.topLevelStatements) T.topLevel++;
    if (f.hasIf) T.hasIf++;
    let ours;
    try { ours = candidateOf(outlineOf, text); } catch (e) { examples.threw.push(`${f.path}: ${/** @type {Error} */ (e).message}`); ours = []; }
    const { pairs, extra, missed } = pairMembers(ours, f.members);
    T.ours += ours.length; T.oracle += f.members.length; T.paired += pairs.length;
    for (const m of f.members) (byKind[m.kind] ||= { oracle: 0, paired: 0, ranges: 0, keys: 0 }).oracle++;
    for (const [c, m] of pairs) {
      const k = byKind[m.kind];
      k.paired++;
      const rangeOk = c.start === m.start && c.end === m.end;
      if (rangeOk) { T.ranges++; k.ranges++; } else examples.range.push(`${f.path}:${m.startLine} ${m.key}: ours [${c.start}, ${c.end}) lines ${c.startLine}-${c.endLine}, Roslyn [${m.start}, ${m.end}) lines ${m.startLine}-${m.endLine}`);
      if (c.startLine === m.startLine && c.endLine === m.endLine) T.lines++;
      if (c.key === m.key) { T.keys++; k.keys++; } else examples.key.push(`${f.path}:${m.startLine} ours ${c.key} | Roslyn ${m.key}`);
    }
    for (const c of extra) examples.extra.push(`${f.path}:${c.startLine} ${c.key}`);
    for (const m of missed) examples.missed.push(`${f.path}:${m.startLine} ${m.kind} ${m.key}`);
  }
  console.log(`files: ${o.files.length} (parse errors in ${T.diagnostics}, top-level statements in ${T.topLevel}, #if in ${T.hasIf})`);
  console.log(`members: ours ${T.ours}, Roslyn ${T.oracle}, paired ${T.paired}: precision ${pct(T.paired, T.ours)}, recall ${pct(T.paired, T.oracle)}`);
  console.log(`of the paired: ranges equal ${T.ranges} (${pct(T.ranges, T.paired)}), lines equal ${T.lines} (${pct(T.lines, T.paired)}), keys equal ${T.keys} (${pct(T.keys, T.paired)})`);
  console.log('by Roslyn kind (members / paired / ranges equal / keys equal):');
  for (const [kind, k] of Object.entries(byKind).sort((a, b) => b[1].oracle - a[1].oracle)) console.log(`  ${kind.padEnd(20)} ${String(k.oracle).padStart(6)} ${String(k.paired).padStart(6)} ${String(k.ranges).padStart(6)} ${String(k.keys).padStart(6)}`);
  for (const [what, xs] of Object.entries(examples)) {
    if (!xs.length) continue;
    console.log(`${what}: ${xs.length}`);
    for (const x of xs.slice(0, MAX_LISTED)) console.log(`  ${x}`);
  }
  return T.ours === T.paired && T.paired >= 0.99 * T.oracle && T.ranges === T.paired && T.keys === T.paired && !examples.threw.length;
}

// ---- 2. changed members per PR -------------------------------------------------------------

/** PR number → `{ number, head, base }`, from merge or squash subjects reachable from `from`. @param {string} repo @param {string} from @param {number[]} numbers */
function resolvePrs(repo, from, numbers) {
  const log = git(repo, 'log', '--first-parent', '-n', '3000', '--format=%H%x09%P%x09%s', from).split('\n').filter(Boolean);
  return numbers.map((n) => {
    const line = log.find((l) => {
      const s = l.split('\t')[2];
      return s.startsWith(`Merge pull request #${n} `) || s.endsWith(`(#${n})`);
    });
    if (!line) throw new Error(`PR #${n}: no merge or squash commit reachable from ${from}`);
    const [head, parents] = line.split('\t');
    return { number: n, head, base: parents.split(' ')[0] };
  });
}

/** @param {string} repo @param {{ head: string, base: string }} pr */
function changedFiles(repo, pr) {
  return git(repo, 'diff', '--name-status', '-M', pr.base, pr.head).trim().split('\n').filter(Boolean).map((l) => {
    const [st, a, b] = l.split('\t');
    return { path: st[0] === 'R' ? b : a, oldPath: a, status: st[0] };
  }).filter((f) => isCs(f.path) && !isTestPath(f.path));
}

/** Head lines with an added line, and pure deletions. @param {string} repo @param {{ head: string, base: string }} pr @param {{ path: string, oldPath: string }} f */
function hunksOf(repo, pr, f) {
  const diff = git(repo, 'diff', '-U0', '-M', pr.base, pr.head, '--', ...(f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]));
  /** @type {number[]} */
  const added = [];
  /** @type {number[]} */
  const pureDeletions = [];
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) pureDeletions.push(start);
    for (let l = start; l < start + count; l++) added.push(l);
  }
  return { added, pureDeletions };
}

/** J-D3 over keys: one gone and one new of a name pair up. @param {any[]} base @param {any[]} head */
function paired(base, head) {
  const bk = new Set(base.map((m) => m.key));
  const hk = new Set(head.map((m) => m.key));
  const nameOf = (/** @type {any} */ m) => m.key.replace(/#\d+$/, '').replace(/[([].*$/s, '');
  /** @type {Map<string, { gone: any[], fresh: any[] }>} */
  const groups = new Map();
  const g = (/** @type {string} */ n) => { if (!groups.has(n)) groups.set(n, { gone: [], fresh: [] }); return /** @type {{ gone: any[], fresh: any[] }} */ (groups.get(n)); };
  for (const b of base) if (!hk.has(b.key)) g(nameOf(b)).gone.push(b);
  for (const h of head) if (!bk.has(h.key)) g(nameOf(h)).fresh.push(h);
  const rename = new Map();
  for (const { gone, fresh } of groups.values()) if (gone.length === 1 && fresh.length === 1) rename.set(fresh[0], gone[0].key);
  return head.map((h) => (rename.has(h) ? { ...h, key: rename.get(h) } : h));
}

/** Rows of one file from its two sides' members. @param {any} f @param {any[]} baseMembers @param {any[]} headMembers */
function rowsOf(f, baseMembers, headMembers) {
  const rows = [];
  const base = f.status === 'A' ? [] : baseMembers;
  const head = f.status === 'D' ? [] : paired(base, headMembers);
  const baseKeys = new Set(base.map((m) => m.key));
  const headKeys = new Set(head.map((m) => m.key));
  for (const b of base) if (!headKeys.has(b.key)) rows.push({ id: `${f.path}#${b.key}|removed`, line: `${f.oldPath}:${b.startLine} (base)` });
  for (const h of head) {
    if (!baseKeys.has(h.key)) { rows.push({ id: `${f.path}#${h.key}|added`, line: `${f.path}:${h.startLine}` }); continue; }
    const touched = f.hunks.added.some((/** @type {number} */ l) => h.startLine <= l && l <= h.endLine)
      || f.hunks.pureDeletions.some((/** @type {number} */ after) => h.startLine <= after && after + 1 <= h.endLine);
    if (touched) rows.push({ id: `${f.path}#${h.key}|changed`, line: `${f.path}:${h.startLine}` });
  }
  return rows;
}

/** @param {string} repo @param {string} commit @param {number[]} numbers @param {(t: string) => any[]} outlineOf @param {string} tools */
function prMode(repo, commit, numbers, outlineOf, tools) {
  const prs = resolvePrs(repo, commit, numbers);
  const perPr = prs.map((pr) => ({ pr, files: changedFiles(repo, pr).map((f) => ({ ...f, hunks: hunksOf(repo, pr, f) })) }));
  /** @type {string[]} */
  const list = [];
  for (const { pr, files } of perPr) {
    for (const f of files) {
      if (f.status !== 'A') list.push(`${pr.base}:${f.oldPath}`);
      if (f.status !== 'D') list.push(`${pr.head}:${f.path}`);
    }
  }
  const unique = [...new Set(list)];
  const o = oracle({ repo, tools, what: { list: unique } });
  console.log(`PR oracle: ${o.files.length} file versions, ${o.cached ? 'cached' : 'computed'} in ${(o.ms / 1000).toFixed(1)} s`);
  const oracleBy = new Map(o.files.map((f) => [`${f.commit}:${f.path}`, f.members]));
  const texts = readObjects(repo, unique);
  const T = { tp: 0, ours: 0, oracle: 0, extra: /** @type {string[]} */ ([]), missed: /** @type {string[]} */ ([]) };
  console.log('PR       files  ours  oracle  precision  recall');
  for (const { pr, files } of perPr) {
    const ours = [];
    const theirs = [];
    for (const f of files) {
      const side = (/** @type {string} */ sha, /** @type {string} */ p) => {
        const name = `${sha}:${p}`;
        let mine = [];
        try { mine = candidateOf(outlineOf, texts.get(name) || ''); } catch { /* listed as missed rows */ }
        return { mine, roslyn: oracleBy.get(name) || [] };
      };
      const b = f.status === 'A' ? { mine: [], roslyn: [] } : side(pr.base, f.oldPath);
      const h = f.status === 'D' ? { mine: [], roslyn: [] } : side(pr.head, f.path);
      ours.push(...rowsOf(f, b.mine, h.mine));
      theirs.push(...rowsOf(f, b.roslyn, h.roslyn));
    }
    const theirIds = new Set(theirs.map((r) => r.id));
    const ourIds = new Set(ours.map((r) => r.id));
    const extra = ours.filter((r) => !theirIds.has(r.id));
    const missed = theirs.filter((r) => !ourIds.has(r.id));
    const tp = ours.length - extra.length;
    T.tp += tp; T.ours += ours.length; T.oracle += theirs.length;
    T.extra.push(...extra.map((r) => `#${pr.number} ${r.id} at ${r.line}`));
    T.missed.push(...missed.map((r) => `#${pr.number} ${r.id} at ${r.line}`));
    console.log(`#${String(pr.number).padEnd(7)} ${String(files.length).padStart(5)} ${String(ours.length).padStart(5)} ${String(theirs.length).padStart(7)}  ${pct(tp, ours.length).padStart(9)} ${pct(tp, theirs.length).padStart(7)}`);
  }
  console.log(`total          ${String(T.ours).padStart(5)} ${String(T.oracle).padStart(7)}  ${pct(T.tp, T.ours).padStart(9)} ${pct(T.tp, T.oracle).padStart(7)}`);
  for (const [title, xs] of [['extra (ours, not Roslyn\'s)', T.extra], ['missed (Roslyn\'s, not ours)', T.missed]]) {
    console.log(`${title}: ${xs.length}`);
    for (const x of /** @type {string[]} */ (xs).slice(0, MAX_LISTED)) console.log(`  ${x}`);
  }
  return T.tp === T.ours && T.tp >= 0.98 * T.oracle;
}

// ---- 3. signatures (C2) ---------------------------------------------------------------------

const SIG_KINDS = new Set(['method', 'constructor', 'static-constructor', 'primary-constructor']);
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * src/languages/csharp/signature.js against the oracle: every method and constructor's member
 * text (the oracle's span) parsed, and its name, explicit interface, modifiers, attributes,
 * type parameters, return type, parameters (name, type, modifiers, default, attributes, key
 * type), the key's parameter text, the header and the body kind compared.
 * @param {string} repo @param {string} commit @param {string} tools @param {boolean} all also properties, indexers, operators, conversions
 */
function signatures(repo, commit, tools, all) {
  const sig = require('../../src/languages/csharp/signature');
  const o = oracle({ repo, tools, what: commit });
  const sha = git(repo, 'rev-parse', `${commit}^{commit}`).trim();
  const texts = readObjects(repo, o.files.map((f) => `${sha}:${f.path}`));
  const t0 = Date.now();
  /** @type {Record<string, { n: number, agreed: number }>} */
  const byKind = Object.create(null);
  /** @type {Map<string, string[]>} */
  const diffs = new Map();
  const note = (/** @type {string} */ field, /** @type {string} */ ex) => { if (!diffs.has(field)) diffs.set(field, []); /** @type {string[]} */ (diffs.get(field)).push(ex); };
  for (const f of o.files) {
    const text = /** @type {string} */ (texts.get(`${sha}:${f.path}`));
    for (const m of f.members) {
      if (!(SIG_KINDS.has(m.kind) || (all && m.kind !== 'top-level'))) continue;
      const k = (byKind[m.kind] ||= { n: 0, agreed: 0 });
      k.n++;
      const where = `${f.path}:${m.startLine} ${m.key}`;
      const decl = text.slice(m.start, m.end);
      const before = diffs.size ? [...diffs.values()].reduce((a, x) => a + x.length, 0) : 0;
      if (m.kind === 'primary-constructor') {
        const p = sig.parseCsharpParameterList(decl);
        if (!p) note('unparsed', `${where}: ${decl.slice(0, 100)}`);
        else comparePars(p.params, m.params, where, note, sig);
      } else {
        const p = sig.parseCsharpDeclaration(decl);
        if (!p) { note('unparsed', `${where}: ${decl.slice(0, 120).replace(/\s+/g, ' ')}`); } else {
          const kind = p.kind === 'constructor' && m.kind === 'static-constructor' ? 'static-constructor' : p.kind;
          if (kind !== m.kind) note('kind', `${where}: ours ${p.kind}`);
          if (p.name !== m.name) note('name', `${where}: ours ${p.name} | Roslyn ${m.name}`);
          if ((p.explicitInterface || undefined) !== m.explicitInterface) note('explicitInterface', `${where}: ours ${p.explicitInterface} | Roslyn ${m.explicitInterface}`);
          if (!same(p.modifiers, m.modifiers)) note('modifiers', `${where}: ours ${p.modifiers} | Roslyn ${m.modifiers}`);
          if (!same(p.attributes, m.attributes)) note('attributes', `${where}: ours ${JSON.stringify(p.attributes)} | Roslyn ${JSON.stringify(m.attributes)}`);
          if (!same(p.typeParameters, m.typeParameters)) note('typeParameters', `${where}: ours ${p.typeParameters} | Roslyn ${m.typeParameters}`);
          if (p.returns !== m.returns) note('returns', `${where}: ours ${p.returns} | Roslyn ${m.returns}`);
          if (p.header !== m.header) note('header', `${where}:\n      ours   ${p.header}\n      Roslyn ${m.header}`);
          if (p.body !== m.body) note('body', `${where}: ours ${p.body} | Roslyn ${m.body}`);
          comparePars(p.params, m.params, where, note, sig);
        }
      }
      const after = [...diffs.values()].reduce((a, x) => a + x.length, 0);
      if (after === before) k.agreed++;
    }
  }
  const total = Object.values(byKind).reduce((a, k) => a + k.n, 0);
  const agreed = Object.values(byKind).reduce((a, k) => a + k.agreed, 0);
  console.log(`signatures of ${path.basename(path.resolve(repo))} at ${sha.slice(0, 12)}: ${total} members, ${agreed} agree in every field (${pct(agreed, total)}), parsed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const [kind, k] of Object.entries(byKind)) console.log(`  ${kind.padEnd(20)} ${String(k.n).padStart(6)} ${String(k.agreed).padStart(6)}`);
  for (const [field, xs] of diffs) {
    console.log(`${field}: ${xs.length}`);
    for (const x of xs.slice(0, MAX_LISTED)) console.log(`  ${x}`);
  }
  return agreed === total;
}

/**
 * @param {any[]} ours @param {any[]} theirs @param {string} where
 * @param {(field: string, ex: string) => void} note @param {any} sig
 */
function comparePars(ours, theirs, where, note, sig) {
  if (ours.length !== theirs.length) { note('param count', `${where}: ours ${ours.length} | Roslyn ${theirs.length}`); return; }
  for (let i = 0; i < ours.length; i++) {
    const a = ours[i];
    const b = theirs[i];
    for (const field of ['name', 'type', 'modifiers', 'default', 'attributes', 'keyType']) {
      if (!same(a[field], b[field])) note(`param ${field}`, `${where} #${i}: ours ${JSON.stringify(a[field])} | Roslyn ${JSON.stringify(b[field])}`);
    }
  }
  const keyText = theirs.map((p) => p.keyType).join(', ');
  if (sig.csharpKeyParams(ours) !== keyText) note('key params', `${where}: ours (${sig.csharpKeyParams(ours)})`);
}

/**
 * Members whose header changed in the PRs: base and head versions paired by key (J-D3 pairing),
 * the header texts (the oracle's) differ; each pair's `csharpKindsOf` printed for checking by
 * hand.
 * @param {string} repo @param {string} commit @param {number[]} numbers @param {string} tools
 */
function headerKinds(repo, commit, numbers, tools) {
  const sig = require('../../src/languages/csharp/signature');
  const prs = resolvePrs(repo, commit, numbers);
  const perPr = prs.map((pr) => ({ pr, files: changedFiles(repo, pr) }));
  /** @type {string[]} */
  const list = [];
  for (const { pr, files } of perPr) {
    for (const f of files) {
      if (f.status !== 'A') list.push(`${pr.base}:${f.oldPath}`);
      if (f.status !== 'D') list.push(`${pr.head}:${f.path}`);
    }
  }
  const unique = [...new Set(list)];
  const o = oracle({ repo, tools, what: { list: unique } });
  const oracleBy = new Map(o.files.map((f) => [`${f.commit}:${f.path}`, f.members]));
  const texts = readObjects(repo, unique);
  const side = (/** @type {string} */ name, /** @type {any} */ m) => {
    const text = texts.get(name) || '';
    const decl = text.slice(m.start, m.end);
    if (m.kind === 'primary-constructor') {
      const pl = sig.parseCsharpParameterList(decl);
      return { sig: pl ? pl.sig : null, header: m.header, modifiers: ['public'] };
    }
    const p = sig.parseCsharpDeclaration(decl);
    return { sig: p ? p.sig : null, header: p ? p.header : m.header, modifiers: p ? p.modifiers : m.modifiers };
  };
  let n = 0;
  for (const { pr, files } of perPr) {
    for (const f of files) {
      if (f.status === 'A' || f.status === 'D') continue;
      const bName = `${pr.base}:${f.oldPath}`;
      const hName = `${pr.head}:${f.path}`;
      const base = oracleBy.get(bName) || [];
      const head = paired(base, oracleBy.get(hName) || []);
      const byKey = new Map(base.map((/** @type {any} */ m) => [m.key, m]));
      for (const h of head) {
        const b = byKey.get(h.key);
        if (!b || b.header === h.header || h.kind === 'top-level') continue;
        n++;
        const bs = side(bName, b);
        const hs = side(hName, h);
        const kinds = sig.csharpKindsOf(bs, hs).map((/** @type {any} */ k) => k.id);
        console.log(`#${pr.number} ${f.path} ${h.key} (${h.kind})\n    - ${b.header}\n    + ${h.header}\n    kinds: ${kinds.join(', ') || '(none)'}${bs.sig && hs.sig ? '' : ' [header fallback]'}`);
      }
    }
  }
  console.log(`${n} members with a changed header`);
}

/**
 * `--fixture-keys`: each fixture's member keys against its expected file.
 * @param {string} tools @param {boolean} write @returns {boolean}
 */
function fixtureKeys(tools, write) {
  const dir = path.join(ORACLE_SRC, 'fixtures');
  const dll = ensureOracle(tools, toolHash());
  let ok = true;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.cs')).sort()) {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'csharp-fixture-'));
    try {
      fs.copyFileSync(path.join(dir, name), path.join(tmp, name));
      const g = (/** @type {string[]} */ ...a) => execFileSync('git', ['-C', tmp, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
      g('init', '-q');
      g('add', name);
      g('commit', '-q', '-m', 'fixture');
      const out = path.join(tmp, 'oracle.json');
      execFileSync(path.join(tools, 'dotnet', 'dotnet'), [dll, tmp, 'HEAD', out], { env: dotnetEnv(tools), stdio: ['ignore', 'inherit', 'inherit'], timeout: ORACLE_DEADLINE_MS });
      const file = JSON.parse(fs.readFileSync(out, 'utf8')).files[0];
      const actual = file.members.map((/** @type {any} */ m) => `${m.kind} ${m.key}`);
      const expPath = path.join(dir, name.replace(/\.cs$/, '.expected.json'));
      if (write) { fs.writeFileSync(expPath, `${JSON.stringify({ diagnostics: file.diagnostics, members: actual }, null, 2)}\n`); console.log(`${name}: wrote ${actual.length} keys`); continue; }
      const expected = fs.existsSync(expPath) ? JSON.parse(fs.readFileSync(expPath, 'utf8')) : { diagnostics: 0, members: [] };
      const missing = expected.members.filter((/** @type {string} */ k) => !actual.includes(k));
      const extra = actual.filter((/** @type {string} */ k) => !expected.members.includes(k));
      const same = missing.length === 0 && extra.length === 0 && actual.join('\n') === expected.members.join('\n') && file.diagnostics === expected.diagnostics;
      console.log(`${name}: ${actual.length} keys, ${same ? 'as expected' : 'DIFFERENT'} (parse errors ${file.diagnostics})`);
      for (const k of missing) console.log(`  - ${k}`);
      for (const k of extra) console.log(`  + ${k}`);
      if (!same && !missing.length && !extra.length) console.log('  (order or parse-error count differs)');
      ok = ok && same;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const repo = opt('--repo');
  const commit = opt('--commit') || 'HEAD';
  const tools = opt('--tools') || scratchpadPath('csharp-tools');
  if (args.includes('--fixture-keys')) {
    const t0 = Date.now();
    const ok = fixtureKeys(tools, args.includes('--write'));
    console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (!repo || !fs.existsSync(repo) || !['--syntactic', '--oracle-only', '--signatures', '--kinds'].some((a) => args.includes(a))) {
    console.error('usage: node test/lsp-harness/csharp-verify.js --syntactic --repo <clone> --commit <sha> --outline <module> [--prs <n,n,…>] [--tools <dir>]');
    console.error('       node test/lsp-harness/csharp-verify.js --oracle-only --repo <clone> --commit <sha>');
    console.error('       node test/lsp-harness/csharp-verify.js --signatures [--all-kinds] --repo <clone> --commit <sha>');
    console.error('       node test/lsp-harness/csharp-verify.js --kinds --repo <clone> --commit <sha> --prs <n,n,…>');
    console.error('       node test/lsp-harness/csharp-verify.js --fixture-keys [--write]');
    process.exit(2);
  }
  const t0 = Date.now();
  if (args.includes('--signatures')) {
    const ok = signatures(repo, commit, tools, args.includes('--all-kinds'));
    console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (args.includes('--kinds')) {
    headerKinds(repo, commit, String(opt('--prs') || '').split(',').filter(Boolean).map(Number), tools);
    console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return;
  }
  if (args.includes('--oracle-only')) {
    const o = oracle({ repo, tools, what: commit });
    /** @type {Record<string, number>} */
    const kinds = Object.create(null);
    for (const f of o.files) for (const m of f.members) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
    console.log(`oracle: ${o.files.length} files, ${o.cached ? 'cached' : 'computed'} in ${(o.ms / 1000).toFixed(1)} s; members by kind ${JSON.stringify(kinds)}`);
    console.log(`files with parse errors ${o.files.filter((f) => f.diagnostics).length}, top-level statements ${o.files.filter((f) => f.topLevelStatements).length}, #if ${o.files.filter((f) => f.hasIf).length}`);
    return;
  }
  const outlinePath = opt('--outline');
  if (!outlinePath) { console.error('--outline <module> is required with --syntactic'); process.exit(2); }
  const { outlineOf } = require(path.resolve(outlinePath));
  let pass = wholeCommit(repo, commit, outlineOf, tools);
  const prs = opt('--prs');
  if (prs) pass = prMode(repo, commit, prs.split(',').map(Number), outlineOf, tools) && pass;
  console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exitCode = pass ? 0 : 1;
}

main();
