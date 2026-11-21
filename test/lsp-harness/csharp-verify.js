// @ts-check
'use strict';
/**
 * C# verification harness (Part C). A development script, not part of `npm test`.
 *
 *   node test/lsp-harness/csharp-verify.js --syntactic --repo <C# clone> --commit <sha>
 *        --outline <module exporting outlineOf(text, path)> [--prs <n,n,…>] [--tools <dir>]
 *   node test/lsp-harness/csharp-verify.js --syntactic --callers [--preview | --both] --repo <C# clone> --commit <sha> [--oracle <semantic json>]
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
 * `--syntactic --callers [--preview]` (C8a): the syntax index's callers against the semantic
 * oracle (C0a-2); see "the caller check" below. Exit 0 when direct precision >= 95%, no miss
 * sits on an answer marked complete and (`--preview`) no answer is complete.
 *
 * `--syntactic` (C0a-1): a candidate text outline against the Roslyn syntax oracle
 * (test/csharp-syntax-oracle/, README.md there for its format), which shares no code with
 * src/. Nothing of the repository is checked out, built or run: files are read from git
 * objects at the commit.
 *
 * The candidate: `require(<--outline>).outlineOf(text, path)` returns the file's members as
 * `{ key, kind?, nameOffset?, start, end }[]`, offsets in UTF-16 code units with the oracle's
 * meaning (Roslyn `Span`: attributes in, leading trivia and XML doc comments out) and keys per
 * C-D6 (repeats `#2` in source order); it throws for a file it cannot read. C3's outline:
 * `--outline test/lsp-harness/csharp-outline-adapter.js`.
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
 * Cache: <tools>/cache/
 *   syntax-<repo>-<sha12>-<toolhash>.json (whole commit) and
 *   prs-<repo>-<listhash>-<toolhash>.json (PR files), toolhash = sha256 of the oracle's
 *   Program.cs + SyntaxOracle.csproj (which pins the Roslyn version). The oracle is built
 *   into <tools>/oracle-syntax/ (default the scratchpad's csharp-tools/, scratchpad.js) with
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

/**
 * The candidate's members of a text, lines added. `outlineOf` is given the file's path too
 * (top-level statements are keyed by its basename).
 * @param {(t: string, file: string) => any[]} outlineOf @param {string} text @param {string} file
 */
function candidateOf(outlineOf, text, file) {
  const lineOf = lineIndex(text);
  return outlineOf(text, file).map((m) => ({ ...m, startLine: lineOf(m.start), endLine: lineOf(Math.max(m.start, m.end - 1)) }));
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

/** @param {string} repo @param {string} commit @param {(t: string, file: string) => any[]} outlineOf @param {string} tools */
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
    try { ours = candidateOf(outlineOf, text, f.path); } catch (e) { examples.threw.push(`${f.path}: ${/** @type {Error} */ (e).message}`); ours = []; }
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

/** @param {string} repo @param {string} commit @param {number[]} numbers @param {(t: string, file: string) => any[]} outlineOf @param {string} tools */
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
        try { mine = candidateOf(outlineOf, texts.get(name) || '', p); } catch { /* listed as missed rows */ }
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

// ---- the caller check (C8a): `--syntactic --callers [--preview]` ---------------------------
//
// The syntax index (src/languages/csharp/syntactic-index.js) over every C# file of the tree at
// --commit outside bin/obj (the CLI's scope, C-D8; test projects included, as the CLI), read
// from git objects; implicit usings and Razor/XAML projects from the tree's .csproj files as
// the provider reads them (`projectFacts`). `--preview`: the same files, built as the preview
// builds its index (`partial`, the web SDK's implicit usings): no answer may be complete.
// Targets: every method and constructor the index declares in a non-test file. Compared with
// the semantic oracle (C0a-2, `--oracle <json>`, default the cached run at the commit) by call site
// (target key + target file + site file + site offset): precision = our non-test call sites
// that are an oracle edge of that target (any `via`: a call bound to an interface or virtual
// member is a direct row of that member); recall over the oracle's direct edges (`via` absent,
// kinds invocation, object-creation, initializer) whose target the index declares; edges with
// `via` (through an interface or override) reported apart. C8b's labelled sites (a call the index
// resolved to an interface member or base method the target implements or overrides, not to the
// target) are scored as may-calls: the oracle binds that site to a member (`via` interface or
// override-base) whose implementations or overrides (transitively) include the target; reported
// by the oracle's implementation count. Misses on an answer marked complete must be 0.

/**
 * The cached semantic oracle run (test/csharp-semantic-oracle/run.sh) for this commit and the
 * oracle's current sources: `semantic-<name>-<sha12>-<toolhash>.json`, toolhash as run.sh computes it.
 * @param {string} tools @param {string} repo @param {string} commit @returns {string}
 */
function semanticCacheFor(tools, repo, commit) {
  const dir = path.join(tools, 'cache');
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', commit], { encoding: 'utf8' }).trim().slice(0, 12);
  const oracle = path.join(__dirname, '..', 'csharp-semantic-oracle');
  const srcs = [path.join(oracle, 'Program.cs'), path.join(oracle, 'SemanticOracle.csproj'), path.join(__dirname, '..', 'csharp-syntax-oracle', 'Program.cs')];
  const hash = crypto.createHash('sha256').update(Buffer.concat(srcs.map((f) => fs.readFileSync(f)))).digest('hex').slice(0, 12);
  const found = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.startsWith('semantic-') && f.endsWith(`-${sha}-${hash}.json`));
  if (found.length !== 1) throw new Error(`${found.length ? 'several' : 'no'} cached semantic oracle runs for ${sha} (tool ${hash}) in ${dir}: run test/csharp-semantic-oracle/run.sh first, or pass --oracle <json>`);
  return path.join(dir, found[0]);
}

/** @param {string} repo @param {string} commit @param {string} oracleFile @param {boolean} preview */
function callersCheck(repo, commit, oracleFile, preview) {
  const { createCsharpSyntacticIndex, WEB_IMPLICIT_USINGS } = require('../../src/languages/csharp/syntactic-index');
  const { projectFacts, NOT_SOURCE_DIRS } = require('../../src/languages/csharp/provider');
  const sha = git(repo, 'rev-parse', commit).trim();
  const all = git(repo, 'ls-tree', '-r', '--name-only', sha).split('\n').filter(Boolean);
  const csFiles = all.filter((p) => /\.cs$/.test(p) && !path.posix.dirname(p).split('/').some((d) => NOT_SOURCE_DIRS.has(d)));
  const projects = all.filter((p) => /\.csproj$/i.test(p));
  const t0 = Date.now();
  const texts = readObjects(repo, [...csFiles, ...projects].map((p) => `${sha}:${p}`));
  const readMs = Date.now() - t0;
  const read = (/** @type {string} */ rel) => texts.get(`${sha}:${rel}`) ?? null;
  const facts = projectFacts(projects, all, read);
  const sources = csFiles.map((p) => ({ path: p, text: /** @type {string} */ (read(p)) })).filter((s) => s.text != null);
  const t1 = Date.now();
  const idx = createCsharpSyntacticIndex(sources, preview
    ? { scope: 'the tree, as the preview', partial: true, implicitUsings: WEB_IMPLICIT_USINGS }
    : { scope: 'the tree', projects, projectUsings: facts.usingsByProject, uiDirs: facts.uiDirs });
  const buildMs = Date.now() - t1;
  const o = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
  if (o.commit && !sha.startsWith(String(o.commit).slice(0, 12)) && !String(o.commit).startsWith(sha.slice(0, 12))) {
    console.error(`oracle commit ${o.commit} is not ${sha}`);
    process.exit(2);
  }
  const lineOfSite = new Map();
  /** @param {string} rel @param {number} off */
  const lineAt = (rel, off) => {
    if (!lineOfSite.has(rel)) lineOfSite.set(rel, lineIndex(/** @type {string} */ (read(rel))));
    return lineOfSite.get(rel)(off);
  };
  // Oracle edges by site; direct ones by target.
  const SITE_KINDS = new Set(['invocation', 'object-creation', 'initializer']);
  /** @type {Map<string, any>} */
  const oracleSites = new Map();
  /** @type {Map<string, any[]>} */
  const directByTarget = new Map();
  /** @type {Map<string, any[]>} */
  const viaByTarget = new Map();
  // Implementations and overrides (transitive) of each interface or virtual member, by `file|key`.
  /** @type {Map<string, Set<string>>} */
  const implsOf = new Map();
  for (const i of o.interfaces || []) implsOf.set(`${i.file}|${i.member}`, new Set(i.implementations.map((/** @type {any} */ x) => `${x.file}|${x.key}`)));
  /** @type {Map<string, string[]>} */
  const overridesOf = new Map();
  for (const v of o.overrides || []) overridesOf.set(`${v.file}|${v.member}`, v.overrides.map((/** @type {any} */ x) => `${x.file}|${x.key}`));
  for (const k of overridesOf.keys()) {
    const all = new Set();
    const stack = [...(overridesOf.get(k) || [])];
    while (stack.length) { const x = /** @type {string} */ (stack.pop()); if (all.has(x)) continue; all.add(x); stack.push(...(overridesOf.get(x) || [])); }
    implsOf.set(k, new Set([...(implsOf.get(k) || []), ...all]));
  }
  // An interface member's implementation may itself be overridden (`IGroupState.M` →
  // `AbstractGroupState.M`, overridden by `IdleGroupState.M`): the call may run those too.
  for (const i of o.interfaces || []) {
    const set = /** @type {Set<string>} */ (implsOf.get(`${i.file}|${i.member}`));
    for (const impl of [...set]) for (const x of implsOf.get(impl) || []) set.add(x);
  }
  /** @type {Map<string, any[]>} Oracle via edges by site. */
  const viaAtSite = new Map();
  /** @type {Map<string, any[]>} Oracle via edges by the implementation or override they may run. */
  const viaByImpl = new Map();
  // Property and indexer reads and writes (C8b), by target and site.
  /** @type {Set<string>} */
  const propSites = new Set();
  for (const e of o.edges) {
    if (/^property-/.test(e.kind) && !isTestPath(e.file)) propSites.add(`${e.targetFile}|${e.target}|${e.file}|${e.start}`);
  }
  for (const e of o.edges) {
    if (!SITE_KINDS.has(e.kind) || isTestPath(e.file) || isTestPath(e.targetFile)) continue;
    if (e.via) {
      const sk = `${e.file}|${e.start}`;
      if (!viaAtSite.has(sk)) viaAtSite.set(sk, []);
      /** @type {any[]} */ (viaAtSite.get(sk)).push(e);
      for (const impl of implsOf.get(`${e.targetFile}|${e.target}`) || []) {
        if (!viaByImpl.has(impl)) viaByImpl.set(impl, []);
        /** @type {any[]} */ (viaByImpl.get(impl)).push(e);
      }
    }
    const tk = `${e.targetFile}|${e.target}`;
    oracleSites.set(`${tk}|${e.file}|${e.start}`, e);
    const into = e.via ? viaByTarget : directByTarget;
    if (!into.has(tk)) into.set(tk, []);
    /** @type {any[]} */ (into.get(tk)).push(e);
  }
  const t2 = Date.now();
  let targets = 0;
  let complete = 0;
  let ours = 0;
  let hits = 0;
  let keyAgree = 0;
  let oracleDirect = 0;
  let found = 0;
  let viaTotal = 0;
  let viaFound = 0;
  let sameArity = 0;
  let outsideOracle = 0;
  let labelledSites = 0;
  let labelledRows = 0;
  let labelledMay = 0;
  let throughTotal = 0;
  let throughFound = 0;
  let extensionIncomplete = 0;
  /** @type {Record<string, { sites: number, may: number }>} */
  const byImpls = Object.create(null);
  /** @type {string[]} */
  const labelledWrong = [];
  const projectDirs = o.projects.map((/** @type {any} */ p) => path.posix.dirname(p.path)).map((/** @type {string} */ d) => (d === '.' ? '' : d));
  const inOracle = (/** @type {string} */ rel) => projectDirs.some((/** @type {string} */ d) => d === '' || rel.startsWith(`${d}/`));
  /** @type {string[]} */
  const fps = [];
  /** @type {string[]} */
  const missesOnComplete = [];
  /** @type {Record<string, number>} */
  const missReasons = Object.create(null);
  /** @type {Record<string, number>} */
  const incompleteBy = Object.create(null);
  let propOurs = 0;
  let propHits = 0;
  let propComplete = 0;
  /** @type {string[]} */
  const propFps = [];
  for (const rec of idx.byFile.values()) {
    if (isTestPath(rec.rel) || !inOracle(rec.rel)) continue;
    for (const d of rec.defs) {
      if (d.member === 'property' || d.member === 'indexer') {
        const a = idx.callersOfWithStatus({ file: rec.file, name: d.name, pos: d.namePos });
        if (!a.incompleteReason) propComplete++;
        for (const c of a.callers) {
          if (isTestPath(c.file) || !inOracle(c.file)) continue;
          for (const st of c.callSites) {
            propOurs++;
            if (propSites.has(`${rec.rel}|${d.key}|${c.file}|${st.start}`)) propHits++;
            else propFps.push(`${c.label} → ${d.key}  (${c.file}:${lineAt(c.file, st.start)}: ${String(read(c.file)).split('\n')[lineAt(c.file, st.start) - 1].trim().slice(0, 110)})`);
          }
        }
        continue;
      }
      if (!['method', 'constructor', 'primary-constructor'].includes(d.member)) continue;
      targets++;
      const tk = `${rec.rel}|${d.key}`;
      const a = idx.callersOfWithStatus({ file: rec.file, name: d.name, pos: d.namePos });
      const unresolved = idx.unresolvedCallsTo({ name: d.name });
      const isComplete = !a.incompleteReason && !unresolved;
      if (isComplete) complete++;
      if (/an extension method/.test(a.incompleteReason || '')) extensionIncomplete++;
      else for (const r of [...(a.incompleteReason ? a.incompleteReason.split('; ') : []), ...(unresolved ? ['unresolved calls of the name'] : [])]) {
        const k = r.replace(/`[^`]*`/g, '`…`').replace(/\d+/g, 'N').slice(0, 60);
        incompleteBy[k] = (incompleteBy[k] || 0) + 1;
      }
      /** @type {Set<string>} */
      const mine = new Set();
      /** @type {Set<string>} */
      const mineThrough = new Set();
      for (const c of a.callers) {
        if (c.via) labelledRows++;
        const crel = c.file;
        if (isTestPath(crel)) continue;
        // A file of no project the oracle loaded (`fuzz/…`): it has no edges to compare.
        if (!inOracle(crel)) { outsideOracle += c.callSites.length; continue; }
        const callerRec = idx.byFile.get(c.file);
        const callerKey = callerRec && callerRec.byPos.get(c.pos) ? callerRec.byPos.get(c.pos).key : null;
        for (const s of c.callSites) {
          // A site the index bound to another member (an interface member or a base method):
          // a may-call through dispatch, scored apart.
          const bound = idx.targetsAt(c.file, s.start);
          if (Array.isArray(bound) && !bound.includes(d)) {
            labelledSites++;
            mineThrough.add(`${crel}|${s.start}`);
            const es = (viaAtSite.get(`${crel}|${s.start}`) || []).filter((e) => (implsOf.get(`${e.targetFile}|${e.target}`) || new Set()).has(tk));
            const n = es.length ? Number(es[0].implementations || es[0].overrides || 1) : 0;
            const bucket = !es.length ? 'none' : n <= 1 ? '1' : n <= 5 ? '2-5' : '6+';
            byImpls[bucket] = byImpls[bucket] || { sites: 0, may: 0 };
            byImpls[bucket].sites++;
            if (es.length) { labelledMay++; byImpls[bucket].may++; } else labelledWrong.push(`${c.label} → ${d.key} [${c.text || 'mixed row'}]  (${crel}:${lineAt(crel, s.start)}: ${String(read(crel)).split('\n')[lineAt(crel, s.start) - 1].trim().slice(0, 110)})`);
            continue;
          }
          ours++;
          const sk = `${tk}|${crel}|${s.start}`;
          mine.add(sk);
          const e = oracleSites.get(sk);
          if (e) { hits++; if (e.caller === callerKey || (e.caller == null && callerKey == null)) keyAgree++; continue; }
          // Listed for every overload of one argument count while Roslyn chose another one:
          // counted apart, and the answer must say so (as java-verify.js).
          const hit = idx.targetsAt(c.file, s.start);
          if (Array.isArray(hit) && hit.length > 1 && /several overloads with the same number of arguments/.test(a.incompleteReason || '')) { sameArity++; continue; }
          fps.push(`${c.label} → ${d.key}  (${crel}:${lineAt(crel, s.start)}: ${String(read(crel)).split('\n')[lineAt(crel, s.start) - 1].trim().slice(0, 110)})`);
        }
      }
      for (const e of directByTarget.get(tk) || []) {
        oracleDirect++;
        if (mine.has(`${tk}|${e.file}|${e.start}`)) { found++; continue; }
        if (isComplete) missesOnComplete.push(`${e.caller} → ${d.key}  (${e.file}:${e.line})`);
        const why = a.incompleteReason ? 'incomplete' : unresolved ? 'unresolved' : 'complete';
        missReasons[`${e.kind}/${why}`] = (missReasons[`${e.kind}/${why}`] || 0) + 1;
      }
      for (const e of viaByTarget.get(tk) || []) { viaTotal++; if (mine.has(`${tk}|${e.file}|${e.start}`)) viaFound++; }
      for (const e of viaByImpl.get(tk) || []) { if (e.kind !== 'invocation') continue; throughTotal++; if (mineThrough.has(`${e.file}|${e.start}`)) throughFound++; }
    }
  }
  const queryMs = Date.now() - t2;
  console.log(`caller check (${preview ? 'preview: the tree as the preview indexes it' : 'CLI: the tree'}) at ${sha.slice(0, 12)}; oracle ${path.basename(oracleFile)}`);
  console.log(`index: ${idx.size} files indexed, ${idx.skipped} skipped; read ${readMs} ms, build ${buildMs} ms, queries ${queryMs} ms; implicit usings ${facts.usings.length}, Razor/XAML projects ${facts.uiDirs.length}`);
  console.log(`targets (non-test methods and constructors): ${targets}; complete answers ${complete} (${pct(complete, targets)}); hit by the undeclared-base rule ${idx.undeclaredBase.size}`);
  console.log(`direct precision ${pct(hits, ours - sameArity)} on unambiguous rows (${hits}/${ours - sameArity} call sites; caller keys equal on ${keyAgree}); ${pct(hits, ours)} with the ${sameArity} same-arity rows counted; recall ${pct(found, oracleDirect)} (${found}/${oracleDirect} direct oracle edges)`);
  console.log(`call sites in files of no project the oracle loaded (not compared): ${outsideOracle}`);
  console.log(`edges through an interface or an override: ${viaFound}/${viaTotal} found as direct rows of the dispatched member`);
  console.log(`C8b labelled (through) sites: ${labelledSites} on ${labelledRows} labelled rows; may-call ${pct(labelledMay, labelledSites)} (${labelledMay}/${labelledSites}); by the oracle's implementation count ${JSON.stringify(byImpls)}`);
  console.log(`C8b recall of calls through an interface or override on their implementations: ${pct(throughFound, throughTotal)} (${throughFound}/${throughTotal} invocations)`);
  console.log(`extension methods incomplete for that reason: ${extensionIncomplete}`);
  console.log(`properties and indexers (C8b): ${propHits}/${propOurs} sites are oracle property edges (${pct(propHits, propOurs)}); complete answers ${propComplete} (must be 0); not oracle edges (${propFps.length}):`);
  for (const f of propFps.slice(0, 25)) console.log(`  ${f}`);
  console.log(`misses by kind/answer: ${JSON.stringify(missReasons)}`);
  console.log(`incomplete reasons (targets): ${JSON.stringify(Object.entries(incompleteBy).sort((x, y) => y[1] - x[1]).slice(0, 14))}`);
  console.log(`false positives (${fps.length}):`);
  for (const f of fps) console.log(`  ${f}`);
  console.log(`labelled sites that are not may-calls (${labelledWrong.length}, must be 0):`);
  for (const f of labelledWrong.slice(0, 40)) console.log(`  ${f}`);
  console.log(`misses on an answer marked complete (${missesOnComplete.length}, must be 0):`);
  for (const m of missesOnComplete.slice(0, 60)) console.log(`  ${m}`);
  if (preview && complete) console.log(`FAIL: ${complete} complete answer(s) in the preview`);
  return ours > 0 && hits / (ours - sameArity) >= 0.95 && !missesOnComplete.length && !labelledWrong.length && (!preview || !complete);
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
    console.error('       node test/lsp-harness/csharp-verify.js --syntactic --callers [--preview] --repo <clone> --commit <sha> [--oracle <semantic json>]');
    console.error('       node test/lsp-harness/csharp-verify.js --oracle-only --repo <clone> --commit <sha>');
    console.error('       node test/lsp-harness/csharp-verify.js --signatures [--all-kinds] --repo <clone> --commit <sha>');
    console.error('       node test/lsp-harness/csharp-verify.js --kinds --repo <clone> --commit <sha> --prs <n,n,…>');
    console.error('       node test/lsp-harness/csharp-verify.js --fixture-keys [--write]');
    process.exit(2);
  }
  const t0 = Date.now();
  if (args.includes('--syntactic') && args.includes('--callers')) {
    const oracleFile = opt('--oracle') || semanticCacheFor(tools, repo, commit);
    // `--both`: the CLI check, then the preview check, in one process (one read of the tree).
    let ok = args.includes('--both') ? callersCheck(repo, commit, oracleFile, false) : true;
    if (args.includes('--both')) console.log('');
    ok = callersCheck(repo, commit, oracleFile, args.includes('--preview') || args.includes('--both')) && ok;
    console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exitCode = ok ? 0 : 1;
    return;
  }
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
