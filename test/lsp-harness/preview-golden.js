#!/usr/bin/env node
'use strict';
/**
 * Golden outputs for the no-checkout PR preview (`analyzeRemote`), recorded on unchanged code
 * so a refactor of src/engine/analyze-remote.js can be checked to leave the output identical.
 *
 *   node test/lsp-harness/preview-golden.js [name-filter]            record
 *   node test/lsp-harness/preview-golden.js --compare [name-filter]  diff against the record
 *
 * Offline: a fake `gh` over git objects (`git diff`, `git show`); no network, no checkout. The
 * test repositories are never checked out; base/head are resolved with `git rev-parse`.
 * Goldens go to ~/Projects/impact-tree-scratchpad/preview-golden/<name>.json.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPOS = path.join(os.homedir(), 'Projects/impact-tree-test-repos');
const OUT = path.join(os.homedir(), 'Projects/impact-tree-scratchpad/preview-golden');
const DEADLINE_MS = 120000;
const VOLATILE = /^(.*Ms|elapsed.*|.*Elapsed|duration.*|.*Duration|timestamp|generatedAt)$/;

/** @type {{ name: string, repo: string, number: number, base: string, head: string, why: string }[]} */
const PRS = [
  // TypeScript: the baseline cases (base-N / pr-N are local branches; the merge base is used as the base).
  { name: 't3code-122', repo: 't3code', number: 122, base: 'base-122', head: 'pr-122', why: 'TypeScript baseline case' },
  { name: 't3code-78', repo: 't3code', number: 78, base: 'base-78', head: 'pr-78', why: 'TypeScript baseline case' },
  { name: 't3code-15', repo: 't3code', number: 15, base: 'base-15', head: 'pr-15', why: 'TypeScript baseline case' },
  { name: 't3code-13', repo: 't3code', number: 13, base: 'base-13', head: 'pr-13', why: 'TypeScript baseline case' },
  { name: 't3code-3', repo: 't3code', number: 3, base: 'base-3', head: 'pr-3', why: 'TypeScript baseline case' },
  { name: 't3code-e8dfc42', repo: 't3code', number: 8, base: 'base-e8dfc42', head: 'pr-e8dfc42', why: 'TypeScript baseline case (a commit, not a numbered PR)' },
  { name: 'hono-4461', repo: 'hono', number: 4461, base: 'base-4461', head: 'pr-4461', why: 'TypeScript baseline case' },
  { name: 'hono-4574', repo: 'hono', number: 4574, base: 'base-4574', head: 'pr-4574', why: 'TypeScript baseline case' },
  { name: 'hono-2368', repo: 'hono', number: 2368, base: 'base-2368', head: 'pr-2368', why: 'TypeScript baseline case' },
  { name: 'hono-3144', repo: 'hono', number: 3144, base: 'base-3144', head: 'pr-3144', why: 'TypeScript baseline case' },
  { name: 'hono-1774', repo: 'hono', number: 1774, base: 'base-1774', head: 'pr-1774', why: 'TypeScript baseline case' },
  { name: 'hono-2769', repo: 'hono', number: 2769, base: 'base-2769', head: 'pr-2769', why: 'TypeScript baseline case' },
  { name: 'fixture-quote-options', repo: 'fixture', number: 1, base: 'main', head: 'feature/quote-options', why: 'the small synthetic fixture repository' },
  // Python (py-verify corpora; #1600 from the seams repo, where base-1600 is the parent of the head).
  { name: 'httpx-3741', repo: 'httpx', number: 3741, base: 'b5addb64f0161ff6bfe94c124ef76f6a1fba5254', head: '83d203a86d955b7695613df6378b56f9003112ce', why: 'Python: a small open PR (py-verify-oos-corpus)' },
  { name: 'httpx-3319', repo: 'httpx', number: 3319, base: '3f76571d3429497c4ee4ecf5d8bc034b6f765957', head: '8e36f2bc685dfbe43cd7503bc1c422a6ed6e05a5', why: 'Python: properties, async, decorators, removals (py-verify-corpus)' },
  { name: 'httpx-seams-1600', repo: 'httpx-seams', number: 1600, base: 'base-1600', head: 'seams-1600', why: 'Python: immutable QueryParams, the seams PR' },
  // Go: expected today to report Go files as "not analysed in this mode".
  { name: 'cli-14752', repo: 'cli', number: 14752, base: '547bf81aa5d68f6b4274abb6926c75252f254750', head: 'a1d1667985a4f0129249ff5bd215c80c1644966a', why: 'Go: 3 removed and 8 added functions, build tags (go-verify-corpus)' },
  { name: 'cli-14390', repo: 'cli', number: 14390, base: 'cba9646b8c254a5711ef9e19e1dfc1455e88feaa', head: '1ba640d1c525a2dfc5e60071ffa9c3f948e644d1', why: 'Go: 46 Go files, renamed interface method (go-verify-corpus)' },
  // Java: expected today to report Java files as "not analysed in this mode" (google/gson, squash-merged PRs).
  { name: 'gson-3137', repo: 'gson', number: 3137, base: '216c41b6e70dc04e6856418dd76bb00c854eb6b4', head: '845664ba1c307e6c1910d07cfed2f622e0ad8df1', why: 'Java: a one-line fix in JsonReader plus its test (small)' },
  { name: 'gson-3096', repo: 'gson', number: 3096, base: '119818bc666d3b9f897d6c0ca7546ce28e9bbcac', head: 'dae37cf0fe12235b76fb09f01118a0a8c8823f42', why: 'Java: changes in MapTypeAdapterFactory and TypeAdapters, plus five test files' },
  // Docs only: hono 099c664d changes README.md alone.
  { name: 'hono-docs-only', repo: 'hono', number: 9999, base: '099c664d^', head: '099c664d', why: 'docs only: hono "docs(readme): update the badges" changes README.md alone' },
];

const git = (/** @type {string} */ repo, /** @type {string[]} */ args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });

/** Run one PR through analyzeRemote with a git-objects-only `gh`. */
async function runPr(/** @type {typeof PRS[number]} */ pr) {
  const repo = fs.realpathSync(path.join(REPOS, pr.repo));
  const head = git(repo, ['rev-parse', `${pr.head}^{commit}`]).trim();
  const tip = git(repo, ['rev-parse', `${pr.base}^{commit}`]).trim();
  const base = git(repo, ['merge-base', tip, head]).trim();
  const statusOf = /** @type {Record<string,string>} */ ({ A: 'added', D: 'removed', M: 'modified' });
  const gh = {
    listPullRequestFiles: async () => {
      // Renames as GitHub lists them (src/github.js: status `renamed`, `previous_filename` as
      // `oldPath`), with git's default similarity.
      const files = git(repo, ['diff', '--name-status', '-M', base, head]).trim().split('\n').filter(Boolean).map((l) => {
        const [s, a, b] = l.split('\t');
        const renamed = s[0] === 'R';
        const p = renamed ? b : a;
        const diff = git(repo, ['diff', '-M', base, head, '--', ...(renamed ? [a, b] : [p])]);
        const at = diff.indexOf('\n@@');
        return { path: p, oldPath: renamed ? a : p, status: renamed ? 'renamed' : statusOf[s[0]] || 'modified', patch: at >= 0 ? diff.slice(at + 1) : null };
      });
      return { total: files.length, files };
    },
    fileAtRef: async (/** @type {any} */ _slug, /** @type {string} */ p, /** @type {string} */ ref) => {
      try { return git(repo, ['show', `${ref}:${p}`]); } catch { return null; }
    },
  };
  const { analyzeRemote } = require('../../src/engine/analyze-remote');
  const result = await analyzeRemote({
    ts: require('typescript'), gh, slug: { owner: 'golden', repo: pr.repo }, repoRoot: repo,
    pr: { number: pr.number, headSha: head, baseSha: base, mergeBaseSha: base, baseRef: 'base' },
  });
  return { result, repo, base, head };
}

const sortKey = (/** @type {any} */ row) => {
  const where = row && (row.relPath || row.file || row.path || '');
  const what = row && (row.label || row.key || row.id || '');
  return `${where}\u0000${what}\u0000${JSON.stringify(row)}`;
};

/**
 * S2 (docs/MULTI_LANGUAGE_PLAN.md, Part S) replaced the result's `callersNotComputed` and
 * `callersSyntaxOnly` with `callersScope: [{ language, scope, note }]`; the goldens were recorded
 * before. This puts the two old fields back exactly as the old code wrote them, in
 * `callersScope`'s place among the keys, and drops it: `callersNotComputed` the names of scope
 * `not-computed`, always there (possibly empty) except in the result of a PR with nothing to
 * analyse (no `callersPending`), which had neither; `callersSyntaxOnly` the names of scope
 * `pr-files`, only when there are some.
 * @param {any} result
 */
function withOldCallerScopeFields(result) {
  /** @type {any} */ const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (k !== 'callersScope') { out[k] = v; continue; }
    if (!('callersPending' in result)) continue;
    const names = (/** @type {string} */ scope) => v.filter((/** @type {any} */ s) => s.scope === scope).map((/** @type {any} */ s) => s.language);
    out.callersNotComputed = names('not-computed');
    if (names('pr-files').length) out.callersSyntaxOnly = names('pr-files');
  }
  return out;
}

/** Volatile fields dropped, machine paths replaced, top-level row lists sorted by (path, label). */
function normalise(/** @type {any} */ result, /** @type {string} */ repo) {
  let text = JSON.stringify(withOldCallerScopeFields(result));
  text = text.split(repo).join('<REPO>').split(REPOS).join('<REPOS>').split(os.homedir()).join('<HOME>');
  for (const t of new Set(text.match(/\/(private\/)?var\/folders\/[^"\s]*|\/tmp\/[^"\s]*/g) || [])) text = text.split(t).join('<TMP>');
  const strip = (/** @type {any} */ o) => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === 'object') {
      /** @type {any} */ const r = {};
      for (const k of Object.keys(o)) if (k.includes('/') || !VOLATILE.test(k)) r[k] = strip(o[k]);
      return r;
    }
    return o;
  };
  const out = strip(JSON.parse(text));
  for (const k of Object.keys(out)) {
    if (Array.isArray(out[k]) && out[k].length && out[k].every((/** @type {any} */ x) => x && typeof x === 'object' && !Array.isArray(x))) {
      out[k].sort((/** @type {any} */ a, /** @type {any} */ b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    }
  }
  return JSON.stringify(out, null, 2) + '\n';
}

function diffLines(/** @type {string} */ a, /** @type {string} */ b) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-golden-'));
  fs.writeFileSync(path.join(tmp, 'recorded'), a);
  fs.writeFileSync(path.join(tmp, 'now'), b);
  try { execFileSync('diff', ['-u', path.join(tmp, 'recorded'), path.join(tmp, 'now')], { encoding: 'utf8', maxBuffer: 1 << 28 }); return ''; }
  catch (/** @type {any} */ e) { return String(e.stdout || e.message).split('\n').slice(0, 40).join('\n'); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  const compare = args.includes('--compare');
  const filter = args.find((a) => !a.startsWith('--'));
  const picked = PRS.filter((p) => !filter || p.name.includes(filter));
  if (!picked.length) { console.error(`no PR matches "${filter}"`); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  let bad = 0;
  const t00 = Date.now();
  for (const pr of picked) {
    const t0 = Date.now();
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    let verdict;
    try {
      /** @type {any} */ let timer;
      const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`over the ${DEADLINE_MS / 1000} s deadline`)), DEADLINE_MS); });
      const { result, repo } = await Promise.race([runPr(pr), deadline]);
      clearTimeout(timer);
      const text = normalise(result, repo);
      const file = path.join(OUT, `${pr.name}.json`);
      if (!compare) { fs.writeFileSync(file, text); verdict = `recorded (${(text.length / 1024).toFixed(0)} KB)`; }
      else if (!fs.existsSync(file)) { verdict = 'RUN FAILED (no recorded file)'; bad++; }
      else {
        const d = diffLines(fs.readFileSync(file, 'utf8'), text);
        if (d) { verdict = `DIFFERENT\n${d}`; bad++; } else verdict = 'same';
      }
    } catch (/** @type {any} */ e) { verdict = `RUN FAILED: ${e.message}`; bad++; }
    console.log(`${pr.name}  ${secs()} s  ${verdict}`);
  }
  console.log(`${picked.length} PR(s) in ${((Date.now() - t00) / 1000).toFixed(1)} s${bad ? `, ${bad} bad` : ''}`);
  process.exit(bad ? 1 : 0);
}

main();
