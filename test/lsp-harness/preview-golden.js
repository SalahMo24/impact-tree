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
 * Goldens go to the scratchpad's preview-golden/<name>.json; clones are under the test-repository
 * folder (both: test/lsp-harness/scratchpad.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { scratchpadPath, testReposPath } = require('./scratchpad');

const REPOS = testReposPath();
const OUT = scratchpadPath('preview-golden');
const DEADLINE_MS = 120000;
const VOLATILE = /^(.*Ms|elapsed.*|.*Elapsed|duration.*|.*Duration|timestamp|generatedAt)$/;

/**
 * The cases: `preview-golden/cases.json` in the scratchpad, kept there because they name the test
 * repositories. Each is { name, repo (a clone's folder under the test-repository folder), number, base, head, why }.
 * @type {{ name: string, repo: string, number: number, base: string, head: string, why: string }[]}
 */
const PRS = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'));

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
      // Renames as GitHub lists them (src/github/github.js: status `renamed`, `previous_filename` as
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
  // Anything else that looks like a flag (--help too) is refused: without --compare this records.
  if (args.some((a) => a.startsWith('--') && a !== '--compare')) { console.error('usage: preview-golden.js [--compare] [name-filter]'); process.exit(2); }
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
