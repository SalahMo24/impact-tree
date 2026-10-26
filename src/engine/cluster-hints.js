// @ts-check
'use strict';

// Evidence that two clusters belong together even without a call link between them.
// `gatherHintFacts` is the only part that touches git (read-only, by ref, bounded);
// `hintsFor` is pure and works from those facts.
//
// What this does NOT establish: shared commits, shared rare words, a shared test or a
// shared folder are hints a reviewer can weigh, not proof of one logical change. Missing
// facts (a git call that failed or hit its budget) are listed in `facts.notes`; the
// absence of a hint then means "not checked", not "no relationship".

const path = require('path');
const { execFileSync, execFile, spawnSync } = require('child_process');
const { AnalysisCancelledError, throwIfCancelled, attempt } = require('./cancellation');

const LARGE_COMMIT_FILES = 30;
const MAX_TOKENS_PER_PAIR = 5;
const MAX_COMMITS_PER_PAIR = 5;
const MAX_TEXT_PER_PAIR = 3;
const MAX_TOKEN_FILES = 20;
const MAX_PATTERN_BYTES = 100000;
const GREP_MAX_BYTES = 16 * 1024 * 1024;
const MAX_LOG_COMMITS = 2000;
const GREP_TIMEOUT_MS = 60000;

// Words too common to say anything: language keywords and everyday names.
const STOP = new Set(`function return export import const string number boolean undefined require module default object
  interface extends implements typeof instanceof async await public private protected static readonly console Promise
  Record Array Error throw catch finally switch struct package defer range lambda assert assertEqual constructor
  Boolean Number String Object Symbol length push filter reduce forEach includes startsWith endsWith toString
  options option result results value values index items params param props state config context request response
  message messages status error errors errorf Errorf return_ returns nonlocal global global_ import_ except
  Optional Union Callable Awaitable Iterable Mapping Sequence Literal Protocol dataclass property classmethod
  staticmethod isinstance getattr setattr hasattr assert_ pytest unittest testing expect describe before after
  should always never target source output input string_ default_ false true`.split(/\s+/).filter(Boolean));

/**
 * Drop comments from one added line so words in comments are not mistaken for code. Block
 * comments and Python docstrings carry across lines in `state`. Approximate: it follows
 * quotes but not every string syntax.
 * @param {string} line
 * @param {string} file
 * @param {{block: boolean, doc: string}} state
 * @returns {string}
 */
function stripComments(line, file, state) {
  const hash = /\.(py|sh|rb|ya?ml|toml)$/.test(file);
  const slash = /\.(go|[cm]?[jt]sx?|java|kt|rs|c|h|cc|cpp|cs|swift|php|scala)$/.test(file);
  if (!hash && !slash) return line;
  if (hash) {
    const t = line.trim();
    const q = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : '';
    if (state.doc) {
      if (line.includes(state.doc)) state.doc = '';
      return '';
    }
    if (q) {
      if (t.indexOf(q, 3) < 0) state.doc = q;
      return '';
    }
  }
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (state.block) {
      if (c === '*' && line[i + 1] === '/') { state.block = false; i++; }
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += line[i + 1] || ''; i++; } else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (slash && c === '/' && line[i + 1] === '/') break;
    if (slash && c === '/' && line[i + 1] === '*') { state.block = true; i++; continue; }
    if (hash && c === '#') break;
    out += c;
  }
  return out;
}

/**
 * One pass over a `git diff -U0` text: its hunks (old and new side start and count, removed
 * and added lines; a deleted file's hunks are keyed by its old path), the identifier-like
 * words (length >= 6) and short string literals in the ADDED lines of code per file, with
 * comments dropped, and the number of changed files.
 * @param {string} diffText
 * @returns {{hunks: Array<{file: string, oldStart: number, oldCount: number, newStart: number, newCount: number, removed: string[], added: string[]}>,
 *   tokensByFile: Record<string, string[]>, fileCount: number}}
 */
function parseDiff(diffText) {
  /** @type {Record<string, Set<string>>} */
  const out = {};
  /** @type {Array<{file: string, oldStart: number, oldCount: number, newStart: number, newCount: number, removed: string[], added: string[]}>} */
  const hunks = [];
  const files = new Set();
  /** @type {string | null} */
  let file = null;
  /** @type {string | null} */
  let oldFile = null;
  /** @type {typeof hunks[number] | null} */
  let hunk = null;
  const cstate = { block: false, doc: '' };
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; oldFile = null; hunk = null; cstate.block = false; cstate.doc = ''; continue; }
    if (hunk === null && line.startsWith('--- ')) { oldFile = line.startsWith('--- a/') ? line.slice(6) : null; continue; }
    if (hunk === null && line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : oldFile; // /dev/null: a deleted file keeps its old path
      if (file) { files.add(file); if (!out[file]) out[file] = new Set(); }
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunk = m ? { file, oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), removed: [], added: [] } : null;
      if (hunk) hunks.push(hunk);
      continue;
    }
    const c = line.charCodeAt(0);
    if (c === 45 /* - */ && hunk) { hunk.removed.push(line.slice(1)); continue; }
    if (c !== 43 /* + */) continue;
    const raw = line.slice(1);
    if (hunk) hunk.added.push(raw);
    const text = stripComments(raw, file, cstate);
    for (const m of text.match(/[A-Za-z_$][\w$]{5,}/g) || []) if (!STOP.has(m)) out[file].add(m);
    const lit = /"([^"\\\n]{6,60})"|'([^'\\\n]{6,60})'/g;
    let m;
    while ((m = lit.exec(text))) {
      const s = m[1] || m[2];
      if (/[A-Za-z]/.test(s) && !STOP.has(s)) out[file].add(s);
    }
  }
  /** @type {Record<string, string[]>} */
  const tokensByFile = {};
  for (const f of Object.keys(out)) tokensByFile[f] = [...out[f]].sort();
  return { hunks, tokensByFile, fileCount: files.size };
}

/** @param {string} diffText @returns {Record<string, string[]>} */
const parseAddedTokens = (diffText) => parseDiff(diffText).tokensByFile;

/**
 * Parse `git log --name-only --format=%x01%H%x02%s` output.
 * @param {string} text
 * @returns {Array<{sha: string, subject: string, files: string[]}>}
 */
function parseLog(text) {
  const commits = [];
  for (const chunk of String(text).split('\x01')) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const head = nl < 0 ? chunk : chunk.slice(0, nl);
    const [sha, subject] = head.split('\x02');
    const files = (nl < 0 ? '' : chunk.slice(nl + 1)).split('\n').filter(Boolean);
    commits.push({ sha: sha.slice(0, 10), subject: subject || '', files });
  }
  return commits;
}

/**
 * The value stored under `key`, creating it first when absent.
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {() => V} make
 * @returns {V}
 */
function getOr(map, key, make) {
  let v = map.get(key);
  if (v === undefined) { v = make(); map.set(key, v); }
  return v;
}

/** @param {any[]} clusters @returns {Map<string, Set<string>>} */
function filesToClusters(clusters) {
  /** @type {Map<string, Set<string>>} */
  const m = new Map();
  for (const c of clusters) for (const f of c.files || []) {
    getOr(m, f, () => new Set()).add(c.id);
  }
  return m;
}

/**
 * Tokens added in files of exactly two clusters and in no other cluster's files,
 * as {token, clusters:[A,B]}, longest first (longer words are more distinctive).
 * @param {any[]} clusters
 * @param {Record<string, string[]>} tokensByFile
 */
function candidateTokens(clusters, tokensByFile) {
  const f2c = filesToClusters(clusters);
  /** @type {Map<string, Set<string>>} */
  const owners = new Map();
  for (const [file, toks] of Object.entries(tokensByFile)) {
    const cs = f2c.get(file);
    if (!cs) continue;
    for (const t of toks) {
      const set = getOr(owners, t, () => new Set());
      for (const c of cs) set.add(c);
    }
  }
  const out = [];
  for (const [token, cs] of owners) if (cs.size === 2) out.push({ token, clusters: [...cs].sort(clusterOrder) });
  out.sort((a, b) => b.token.length - a.token.length || (a.token < b.token ? -1 : 1));
  return out;
}

/** @param {string} id */
/**
 * A commit touching over half of the PR's files says little about any two clusters, but
 * only in a PR big enough to have parts: with under 10 changed files nothing is broad.
 * @param {number} commitFiles
 * @param {number | undefined} changedFileCount
 */
function isBroadCommit(commitFiles, changedFileCount) {
  return !!changedFileCount && changedFileCount >= 10 && commitFiles > 0.5 * changedFileCount;
}

/**
 * A commit whose subject says little about the change: chore, docs, style, lint, format,
 * wip, merge, revert, or fewer than 3 words.
 * @param {string} subject
 */
function isWeakCommit(subject) {
  const s = String(subject || '').trim();
  return /^(chore|docs?|style|lint|format|wip|merge|revert)\b/i.test(s) || s.split(/\s+/).filter(Boolean).length < 3;
}

/** @param {string} id */
const num = (id) => Number(String(id).slice(1));
/** @param {string} a @param {string} b */
const clusterOrder = (a, b) => num(a) - num(b);

/** @param {any} e */
const errMsg = (e) => String((e && e.message) || e).split('\n')[0];

/** @param {string} repo @param {string[]} args @param {number} timeout @param {number} [maxBuffer] */
function git(repo, args, timeout, maxBuffer = 256 * 1024 * 1024) {
  return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args],
    { encoding: 'utf8', timeout, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Folders a repository generates rather than writes: those named by a `rimraf` / `rm -rf`
 * in a package.json script, and `linguist-generated` paths of .gitattributes. Pure.
 * @param {string | null} packageJson text of package.json at head
 * @param {string | null} gitattributes text of .gitattributes at head
 * @returns {string[]} top-level folder names, sorted
 */
function generatedDirsFrom(packageJson, gitattributes) {
  const dirs = new Set();
  try {
    const scripts = (packageJson ? JSON.parse(packageJson).scripts : null) || {};
    for (const cmd of Object.values(scripts)) {
      for (const seg of String(cmd).split(/&&|;|\|\|/)) {
        const w = seg.trim().split(/\s+/);
        const at = w.findIndex((x) => x === 'rimraf' || x === 'rm');
        if (at < 0) continue;
        for (const arg of w.slice(at + 1)) {
          if (arg.startsWith('-') || /[*$]/.test(arg)) continue;
          const top = arg.replace(/^\.\//, '').split('/')[0];
          if (top && top !== '.' && top !== '..') dirs.add(top);
        }
      }
    }
  } catch { /* a package.json that does not parse names no generated folder */ }
  for (const line of String(gitattributes || '').split('\n')) {
    const w = line.trim().split(/\s+/);
    if (w.length < 2 || w[0].startsWith('#')) continue;
    // only the attribute set (bare, or =true); `=false`, `-linguist-generated` and other attributes do not count
    const gen = w.slice(1).some((a) => a === 'linguist-generated' || a === 'linguist-generated=true');
    if (!gen) continue;
    // and only a pattern that covers a whole top folder (`gen`, `gen/`, `gen/**`), not a glob inside one
    const m = /^\/?([^/*?[\s]+)(?:\/(?:\*\*)?)?$/.exec(w[0]);
    if (m) dirs.add(m[1]);
  }
  return [...dirs].sort();
}

const LOG_TIMEOUT_MS = 30000;
const DIFF_TIMEOUT_MS = 60000;
const SHOW_TIMEOUT_MS = 5000;
const SHOW_MAX_BYTES = 4 * 1024 * 1024;
const BIG_MAX_BYTES = 256 * 1024 * 1024;
const GENERATED_FILES = ['package.json', '.gitattributes'];

/** @typedef {{commits: any[], hunks: any[], tokensByFile: Record<string, string[]>, changedFileCount: number,
 *   generatedDirs: string[], tokenFiles: Record<string, number>, tokenCountsPartial: boolean, notes: string[]}} Facts */

/** @returns {Facts} facts with nothing gathered */
function emptyFacts() {
  return { commits: [], hunks: [], tokensByFile: {}, changedFileCount: 0, generatedDirs: [], tokenFiles: {}, tokenCountsPartial: false, notes: [] };
}

/** @param {string} base @param {string} head */
const logArgs = (base, head) => ['log', `--max-count=${MAX_LOG_COMMITS}`, '--no-merges', '--name-only',
  '--format=%x01%H%x02%s', `${base}..${head}`];
/** @param {string} base @param {string} head */
const diffArgs = (base, head) => ['diff', '-U0', '--no-color', '--no-ext-diff', `${base}...${head}`];

/** Pure: record `git log` output in `facts`. @param {Facts} facts @param {string} text */
function applyLog(facts, text) {
  facts.commits = parseLog(text);
  if (facts.commits.length >= MAX_LOG_COMMITS) facts.notes.push(`git log capped at ${MAX_LOG_COMMITS} commits`);
}

/** Pure: record `git diff -U0` output in `facts`. @param {Facts} facts @param {string} text */
function applyDiff(facts, text) {
  const d = parseDiff(text);
  facts.hunks = d.hunks; facts.tokensByFile = d.tokensByFile; facts.changedFileCount = d.fileCount;
}

/**
 * Pure: generated folders from the package.json and .gitattributes texts read at head and
 * at base (a PR that deletes a generated folder also deletes the script that made it).
 * @param {{head: Array<string | null>, base: Array<string | null>}} texts `[package.json, .gitattributes]` at each side
 * @returns {string[]}
 */
function generatedDirsAtBoth({ head, base }) {
  return [...new Set([...generatedDirsFrom(head[0], head[1]), ...generatedDirsFrom(base[0], base[1])])].sort();
}

/**
 * Read-only git facts for clustering and `hintsFor`: 1 `git log`, 1 `git diff -U0`, and 2
 * `git show` pairs for package.json and .gitattributes (at head and at base). Every call has a timeout; a
 * failed step is recorded in `notes` and leaves its facts empty (so "no hint" there means
 * "not checked"). Blocks the caller until git answers; `gatherDiffFactsAsync` is the same
 * without blocking.
 * @param {{repo: string, base: string, head: string}} p
 * @returns {Facts}
 */
function gatherDiffFacts({ repo, base, head }) {
  const facts = emptyFacts();
  try { applyLog(facts, git(repo, logArgs(base, head), LOG_TIMEOUT_MS)); }
  catch (e) { facts.notes.push(`git log failed: ${errMsg(e)}`); }
  try { applyDiff(facts, git(repo, diffArgs(base, head), DIFF_TIMEOUT_MS)); }
  catch (e) { facts.notes.push(`git diff failed: ${errMsg(e)}`); }
  /** @param {string} ref @param {string} f @returns {string | null} */
  const show = (ref, f) => { try { return git(repo, ['show', `${ref}:${f}`], SHOW_TIMEOUT_MS, SHOW_MAX_BYTES); } catch { return null; } };
  facts.generatedDirs = generatedDirsAtBoth({ head: GENERATED_FILES.map((f) => show(head, f)), base: GENERATED_FILES.map((f) => show(base, f)) });
  return facts;
}

/**
 * Run git without blocking the event loop; same timeouts and buffers as `git`. A stopped
 * run kills the child and rejects with `AnalysisCancelledError`.
 * @param {string} repo @param {string[]} args @param {number} timeout @param {number} maxBuffer
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
function gitAsync(repo, args, timeout, maxBuffer, signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, '-c', 'core.quotepath=off', ...args],
      { encoding: 'utf8', timeout, maxBuffer, signal }, (err, stdout) => {
        if (signal && signal.aborted) { reject(new AnalysisCancelledError()); return; }
        if (err) { reject(err); return; }
        resolve(stdout);
      });
  });
}

/**
 * `gatherDiffFacts` without blocking: the same git calls, timeouts and facts, run as child
 * processes the caller can stop with `signal` (it then rejects with `AnalysisCancelledError`
 * and no facts). A failed git call is a note, as in the sync version. At most 6 children
 * at once (log, diff, 4 `git show`).
 * @param {{repo: string, base: string, head: string, signal?: AbortSignal}} p
 * @returns {Promise<Facts>}
 */
async function gatherDiffFactsAsync({ repo, base, head, signal }) {
  const facts = emptyFacts();
  /** @param {string[]} args @param {number} timeout @param {number} [maxBuffer] */
  const run = (args, timeout, maxBuffer = BIG_MAX_BYTES) => gitAsync(repo, args, timeout, maxBuffer, signal);
  /** @param {string} ref @param {string} f @returns {Promise<string | null>} */
  const show = async (ref, f) => {
    const r = await attempt(run(['show', `${ref}:${f}`], SHOW_TIMEOUT_MS, SHOW_MAX_BYTES));
    return r.ok ? r.value : null; // a missing file is not an error
  };
  const [log, diff, ...shown] = await Promise.all([
    attempt(run(logArgs(base, head), LOG_TIMEOUT_MS)),
    attempt(run(diffArgs(base, head), DIFF_TIMEOUT_MS)),
    ...[head, base].flatMap((ref) => GENERATED_FILES.map((f) => show(ref, f))),
  ]);
  throwIfCancelled(signal);
  if (log.ok) applyLog(facts, log.value); else facts.notes.push(`git log failed: ${errMsg(log.error)}`);
  if (diff.ok) applyDiff(facts, diff.value); else facts.notes.push(`git diff failed: ${errMsg(diff.error)}`);
  facts.generatedDirs = generatedDirsAtBoth({ head: shown.slice(0, 2), base: shown.slice(2, 4) });
  return facts;
}

/**
 * One PCRE alternation of literal tokens (each quoted with the Q..E escape), as many as fit
 * in `maxBytes`. git's -F with many patterns took 17 s on a 3000-file repo; this takes 0.5 s.
 * @param {string[]} tokens
 * @param {number} maxBytes
 * @returns {{pattern: string, used: number}}
 */
function pcreAlternation(tokens, maxBytes) {
  const BS = String.fromCharCode(92);
  let pattern = '';
  let used = 0;
  for (const t of tokens) {
    const piece = `${BS}Q${t.split(`${BS}E`).join('')}${BS}E`;
    if (pattern.length + piece.length + 1 > maxBytes) break;
    pattern += (pattern ? '|' : '') + piece;
    used++;
  }
  return { pattern, used };
}

/**
 * Pure: the facts restricted to files of `clusters`, and the tokens to count (added in
 * exactly two clusters) as one PCRE pattern. `cands` is already cut to what fits.
 * @param {Facts} facts
 * @param {any[]} clusters
 * @returns {{out: Facts, cands: string[], pattern: string}}
 */
function rareTokenPlan(facts, clusters) {
  const f2c = filesToClusters(clusters);
  /** @type {Record<string, string[]>} */
  const tokensByFile = {};
  for (const f of Object.keys(facts.tokensByFile)) if (f2c.has(f)) tokensByFile[f] = facts.tokensByFile[f];
  const out = { ...facts, tokensByFile, tokenFiles: {}, tokenCountsPartial: false, notes: facts.notes.slice() };
  const cands = candidateTokens(clusters, tokensByFile).map((c) => c.token).filter((t) => !t.includes('\n'));
  if (!cands.length) return { out, cands, pattern: '' };
  const { pattern, used } = pcreAlternation(cands, MAX_PATTERN_BYTES);
  if (used < cands.length) out.notes.push(`token counts cover ${used} of ${cands.length} candidates (pattern size cap)`);
  cands.length = used;
  return { out, cands, pattern };
}

/** @param {string} pattern @param {string} head */
const grepArgs = (pattern, head) => ['grep', '-I', '-o', '-w', '-P', '--null', '-e', pattern, head, '--'];

/**
 * Pure: fold one `git grep` outcome into the plan's facts: the per-token file counts, or a
 * note when the search did not run to its end.
 * @param {{out: Facts, cands: string[]}} plan
 * @param {{stdout: string, status: number | null, error?: any}} run `error` is a spawn,
 *   timeout or buffer failure when there was one; a buffer overflow keeps `stdout` as far as it got
 * @param {string} head
 * @returns {Facts}
 */
function applyGrep({ out, cands }, { stdout, status, error }, head) {
  const overflow = error && (error.code === 'ENOBUFS' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  if (error && !overflow) { out.notes.push(`git grep failed: ${errMsg(error)}`); return out; }
  if (status !== 0 && status !== 1 && !error) { out.notes.push(`git grep exited ${status}: token counts not gathered`); return out; }
  let text = String(stdout || '');
  if (overflow) { // cut at the last whole line
    out.tokenCountsPartial = true;
    text = text.slice(0, text.lastIndexOf('\n') + 1);
    out.notes.push('token counts partial: git grep output hit its size cap');
  }
  /** @type {Map<string, Set<string>>} */
  const filesOf = new Map();
  const prefixLen = head.length + 1;
  for (const line of text.split('\n')) {
    const z = line.indexOf('\0');
    if (z < 0) continue;
    getOr(filesOf, line.slice(z + 1), () => new Set()).add(line.slice(prefixLen, z));
  }
  for (const t of cands) out.tokenFiles[t] = (filesOf.get(t) || new Set()).size;
  return out;
}

/**
 * Count, with ONE `git grep -o -w -P`, in how many files at head each candidate token
 * (added in exactly two clusters) occurs. Output is capped at 16 MB (about 200k matches); a
 * capped run sets `tokenCountsPartial` and the counts are then lower bounds. Blocks until
 * git answers; `countRareTokensAsync` does not.
 * @param {any} facts  from gatherDiffFacts; returned with `tokenFiles` filled
 * @param {any[]} clusters
 * @param {{repo: string, head: string}} p
 * @returns {Facts}
 */
function countRareTokens(facts, clusters, { repo, head }) {
  const plan = rareTokenPlan(facts, clusters);
  if (!plan.cands.length) return plan.out;
  const res = spawnSync('git', ['-C', repo, ...grepArgs(plan.pattern, head)],
    { encoding: 'utf8', timeout: GREP_TIMEOUT_MS, maxBuffer: GREP_MAX_BYTES });
  return applyGrep(plan, { stdout: String(res.stdout || ''), status: res.status, error: res.error }, head);
}

/**
 * `countRareTokens` without blocking, stoppable with `signal` (it then rejects with
 * `AnalysisCancelledError`). Same pattern, caps, timeout and notes.
 * @param {any} facts
 * @param {any[]} clusters
 * @param {{repo: string, head: string, signal?: AbortSignal}} p
 * @returns {Promise<Facts>}
 */
async function countRareTokensAsync(facts, clusters, { repo, head, signal }) {
  const plan = rareTokenPlan(facts, clusters);
  if (!plan.cands.length) return plan.out;
  throwIfCancelled(signal);
  /** @type {{stdout: string, status: number | null, error?: any}} */
  const run = await new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...grepArgs(plan.pattern, head)],
      { encoding: 'utf8', timeout: GREP_TIMEOUT_MS, maxBuffer: GREP_MAX_BYTES, signal }, (error, stdout) => {
        if (signal && signal.aborted) { reject(new AnalysisCancelledError()); return; }
        // a non-zero exit arrives as an error whose `code` is the exit status (git grep: 1 = no match)
        const exited = error && typeof (/** @type {any} */ (error)).code === 'number';
        resolve({ stdout, status: !error ? 0 : exited ? (/** @type {any} */ (error)).code : null, error: exited ? undefined : error });
      });
  });
  return applyGrep(plan, run, head);
}

/**
 * Pair-wise evidence between clusters. Pure.
 * @param {any[]} clusters  `buildClusters(...).clusters`
 * @param {{commits?: any[], tokensByFile?: Record<string, string[]>, tokenFiles?: Record<string, number>, changedFileCount?: number, tokenCountsPartial?: boolean}} facts
 * @returns {Array<{clusters: [string, string], evidence: any[], strength: number, omitted?: Record<string, number>}>}
 */
function hintsFor(clusters, facts) {
  const f = facts || {};
  /** @type {Map<string, any>} */
  const pairs = new Map(); // "A|B" -> {clusters, commit: [], token: [], test: [], folder: []}
  /** @param {string} a @param {string} b */
  const slot = (a, b) => {
    const [x, y] = [a, b].sort(clusterOrder);
    const key = `${x}|${y}`;
    if (!pairs.has(key)) pairs.set(key, { clusters: [x, y], commit: [], token: [], pattern: [], sig: [], test: null, folder: null });
    return pairs.get(key);
  };
  /** @param {Iterable<string>} ids @param {(a: string, b: string) => void} fn */
  const eachPair = (ids, fn) => {
    const l = [...ids].sort(clusterOrder);
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) fn(l[i], l[j]);
  };

  // commits touching files of both clusters
  const f2c = filesToClusters(clusters);
  for (const c of f.commits || []) {
    const touched = new Set();
    for (const file of c.files) for (const id of f2c.get(file) || []) touched.add(id);
    if (touched.size < 2) continue;
    const item = { type: 'commit', sha: c.sha, subject: c.subject, files: c.files.length,
      large: c.files.length > LARGE_COMMIT_FILES, weak: isWeakCommit(c.subject),
      // a commit touching over half of the PR's files says little about any two clusters
      broad: isBroadCommit(c.files.length, f.changedFileCount) };
    eachPair(touched, (a, b) => slot(a, b).commit.push(item));
  }

  // rare tokens added in exactly these two clusters
  for (const { token, clusters: cs } of candidateTokens(clusters, f.tokensByFile || {})) {
    const n = (f.tokenFiles || {})[token];
    if (n === undefined || n > MAX_TOKEN_FILES) continue;
    const s = slot(cs[0], cs[1]);
    if (s.token.length < MAX_TOKENS_PER_PAIR) s.token.push(f.tokenCountsPartial ? { type: 'token', token, files: n, partial: true } : { type: 'token', token, files: n });
  }

  // the same repeated edit, or the same signature delta, in both clusters
  /** @param {'patterns' | 'signatureDeltas'} field @param {'pattern' | 'delta'} what */
  const sharedText = (field, what) => {
    /** @type {Map<string, Set<string>>} */
    const owners = new Map();
    for (const c of clusters) for (const k of c[field] || []) getOr(owners, k, () => new Set()).add(c.id);
    /** @type {Map<string, any[]>} */
    const perPair = new Map();
    for (const [k, ids] of [...owners].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (ids.size < 2) continue;
      eachPair(ids, (a, b) => {
        const l = getOr(perPair, `${a}|${b}`, () => []);
        if (l.length < MAX_TEXT_PER_PAIR) l.push({ type: field === 'patterns' ? 'pattern' : 'signature-change', [what]: k, sharedBy: ids.size });
      });
    }
    return perPair;
  };
  for (const [k, l] of sharedText('patterns', 'pattern')) { const [a, b] = k.split('|'); slot(a, b).pattern = l; }
  for (const [k, l] of sharedText('signatureDeltas', 'delta')) { const [a, b] = k.split('|'); slot(a, b).sig = l; }

  // the same test calls members of both clusters
  /** @type {Map<string, {label: string, relPath: string, ids: Set<string>}>} */
  const tests = new Map();
  for (const c of clusters) for (const t of c.testCallers || []) {
    const k = `${t.relPath}::${t.label}`;
    getOr(tests, k, () => ({ label: t.label, relPath: t.relPath, ids: new Set() })).ids.add(c.id);
  }
  const testPairs = new Map();
  for (const t of [...tests.values()].sort((a, b) => (a.relPath + a.label < b.relPath + b.label ? -1 : 1))) {
    eachPair(t.ids, (a, b) => {
      const k = `${a}|${b}`;
      if (!testPairs.has(k)) testPairs.set(k, { a, b, callers: [] });
      testPairs.get(k).callers.push({ label: t.label, relPath: t.relPath });
    });
  }
  for (const { a, b, callers } of testPairs.values()) {
    slot(a, b).test = { type: 'test', callers: callers.slice(0, 5), count: callers.length };
  }

  // a shared directory
  /** @type {Map<string, Set<string>>} */
  const dirs = new Map();
  for (const c of clusters) for (const file of c.files || []) {
    const d = path.posix.dirname(file);
    getOr(dirs, d, () => new Set()).add(c.id);
  }
  for (const d of [...dirs.keys()].sort()) {
    eachPair(dirs.get(d) || [], (a, b) => {
      const s = slot(a, b);
      if (!s.folder) s.folder = { type: 'folder', dir: d };
    });
  }

  const out = [];
  for (const p of pairs.values()) {
    const commits = p.commit.slice().sort((/** @type {any} */ x, /** @type {any} */ y) => Number(x.broad || x.weak) - Number(y.broad || y.weak)
      || Number(x.large) - Number(y.large) || (x.sha < y.sha ? -1 : 1));
    const evidence = [...commits.slice(0, MAX_COMMITS_PER_PAIR), ...p.token, ...p.pattern, ...p.sig];
    if (p.test) evidence.push(p.test);
    if (p.folder) evidence.push(p.folder);
    // a shared folder, a weak commit and a commit touching most of the PR are listed but do not count:
    // a pair held together by them alone is not reported
    const counted = evidence.filter((e) => e.type !== 'folder' && !(e.type === 'commit' && (e.broad || e.weak)));
    const strength = new Set(counted.map((e) => e.type)).size;
    if (!strength) continue;
    /** @type {any} */
    const h = { clusters: p.clusters, evidence, strength };
    if (commits.length > MAX_COMMITS_PER_PAIR) h.omitted = { commit: commits.length - MAX_COMMITS_PER_PAIR };
    out.push(h);
  }
  out.sort((a, b) => b.strength - a.strength || b.evidence.length - a.evidence.length
    || clusterOrder(a.clusters[0], b.clusters[0]) || clusterOrder(a.clusters[1], b.clusters[1]));
  return out;
}

module.exports = { isBroadCommit, isWeakCommit, stripComments, hintsFor, gatherDiffFacts, gatherDiffFactsAsync, countRareTokens, countRareTokensAsync, emptyFacts, generatedDirsFrom, generatedDirsAtBoth, candidateTokens, parseDiff, parseAddedTokens, parseLog };
