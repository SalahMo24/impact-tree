// @ts-check
'use strict';

// The facts cards need, read from the GitHub API instead of a checkout (PR preview): the
// same shape as `gatherLocalCardFacts` (cards.js), so `buildCardsFromFacts` and `addHints`
// work on either. Hunks and added words come from the file patches GitHub already
// computed; commits and their files from the commits API; generated folders from
// package.json and .gitattributes at the PR's two ends.
//
// What this does NOT establish: every request can fail or be capped. A failed or capped
// step leaves its facts empty and adds a line to `notes`, so "no hint" for that step means
// "not checked". A cancelled run throws and returns nothing. Differences from the local
// facts: the hunks are re-cut to zero context from GitHub's patches (same lines as
// `git diff -U0`); only the newest `maxCommits` commits have their file lists read; merge
// commits are left out as `--no-merges` does; and a file with no patch (binary, or over
// GitHub's size cap) has no hunks or words and is not counted in `changedFileCount`.

const { emptyFacts, parseDiff, generatedDirsAtBoth } = require('./cluster-hints');
const { throwIfCancelled, attempt } = require('./cancellation');
const { mapLimit } = require('./concurrency');

/** Commit file lists read at once. Together with the 4 file requests: at most 8 in flight. */
const COMMIT_CONCURRENCY = 4;
const SHA_LENGTH = 10;
const GENERATED_FILES = ['package.json', '.gitattributes'];

/** @param {unknown} e */
const errMsg = (e) => String((e && /** @type {any} */ (e).message) || e).split('\n')[0];

/**
 * Pure: the patch of one file as the text of a `git diff -U0` for it: a header and hunks
 * with the context lines dropped. GitHub's patches carry 3 context lines per hunk; a hunk
 * here covers only the changed lines, as the local facts' hunks do.
 * @param {{path: string, oldPath?: string, status: string, patch: string}} f
 * @returns {string}
 */
function zeroContextDiff(f) {
  const oldPath = f.oldPath || f.path;
  const out = [`diff --git a/${oldPath} b/${f.path}`,
    f.status === 'added' ? '--- /dev/null' : `--- a/${oldPath}`,
    f.status === 'removed' ? '+++ /dev/null' : `+++ b/${f.path}`];
  /** @type {{oldStart: number, newStart: number, removed: string[], added: string[]} | null} */
  let run = null;
  let oldLine = 0;
  let newLine = 0;
  const flush = () => {
    if (!run) return;
    const oc = run.removed.length;
    const nc = run.added.length;
    // git names the line BEFORE an empty side
    out.push(`@@ -${oc ? run.oldStart : run.oldStart - 1},${oc} +${nc ? run.newStart : run.newStart - 1},${nc} @@`);
    for (const l of run.removed) out.push(`-${l}`);
    for (const l of run.added) out.push(`+${l}`);
    run = null;
  };
  for (const line of f.patch.split('\n')) {
    if (line.startsWith('@@ ')) {
      flush();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      // a zero count names the line before the hunk
      oldLine = m[2] === '0' ? Number(m[1]) + 1 : Number(m[1]);
      newLine = m[4] === '0' ? Number(m[3]) + 1 : Number(m[3]);
      continue;
    }
    const c = line[0];
    if (c === '-' || c === '+') {
      if (!run) run = { oldStart: oldLine, newStart: newLine, removed: [], added: [] };
      if (c === '-') { run.removed.push(line.slice(1)); oldLine++; } else { run.added.push(line.slice(1)); newLine++; }
    } else if (c === ' ') { flush(); oldLine++; newLine++; }
    // `\ No newline at end of file`, and a blank line ending the text: nothing to count
  }
  flush();
  return out.join('\n');
}

/**
 * Pure: hunks, added words and the changed-file count from the listed files' patches. A file
 * without a patch adds a note.
 * @param {Array<{path: string, oldPath?: string, status: string, patch: string | null}>} files
 * @returns {{hunks: any[], tokensByFile: Record<string, string[]>, changedFileCount: number, notes: string[]}}
 */
function diffFactsFromFiles(files) {
  /** @type {string[]} */
  const texts = [];
  /** @type {string[]} */
  const missing = [];
  for (const f of files) {
    if (f.patch) texts.push(zeroContextDiff({ ...f, patch: f.patch })); else missing.push(f.path);
  }
  const d = parseDiff(texts.join('\n'));
  /** @type {string[]} */
  const notes = [];
  if (missing.length) {
    const shown = missing.slice(0, 3).join(', ');
    notes.push(`${missing.length} changed file(s) have no patch (binary or too large), so their hunks and words are not read: ${shown}${missing.length > 3 ? ', ...' : ''}`);
  }
  return { hunks: d.hunks, tokensByFile: d.tokensByFile, changedFileCount: d.fileCount, notes };
}

/**
 * The facts of a PR from the GitHub API.
 * @param {object} p
 * @param {any} p.gh  the client of `createGitHub` (`listPullRequestCommits`, `getCommit`, `fileAtRef`)
 * @param {{owner: string, repo: string}} p.slug
 * @param {{number: number, headSha: string, baseSha: string}} p.pr
 * @param {Array<{path: string, oldPath?: string, status: string, patch: string | null}>
 *   | {files: Array<any>, truncated?: boolean}} p.files  what `listPullRequestFiles` returned
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.maxCommits]  commits whose file lists are requested; a positive integer
 * @returns {Promise<import('./cluster-hints').Facts>}
 * @throws {import('./cancellation').AnalysisCancelledError} when `signal` aborted; no facts
 */
async function gatherRemoteCardFacts({ gh, slug, pr, files, signal, maxCommits = 30 }) {
  if (!Number.isSafeInteger(maxCommits) || maxCommits < 1) throw new RangeError(`maxCommits must be a positive integer, got ${maxCommits}`);
  throwIfCancelled(signal);
  const facts = emptyFacts();
  const list = Array.isArray(files) ? files : files.files;
  if (!Array.isArray(files) && files.truncated) facts.notes.push('the file list was truncated: hunks and words cover the listed files only');
  const diff = diffFactsFromFiles(list);
  facts.hunks = diff.hunks;
  facts.tokensByFile = diff.tokensByFile;
  facts.changedFileCount = diff.changedFileCount;
  facts.notes.push(...diff.notes);

  const [commits, generated] = await Promise.all([
    gatherCommits({ gh, slug, number: pr.number, signal, maxCommits }),
    gatherGeneratedDirs({ gh, slug, pr, signal }),
  ]);
  throwIfCancelled(signal);
  facts.commits = commits.commits;
  facts.generatedDirs = generated.dirs;
  facts.notes.push(...commits.notes, ...generated.notes);
  return facts;
}

/**
 * @param {{gh: any, slug: {owner: string, repo: string}, number: number, signal?: AbortSignal, maxCommits: number}} p
 * @returns {Promise<{commits: Array<{sha: string, subject: string, files: string[]}>, notes: string[]}>}
 */
async function gatherCommits({ gh, slug, number, signal, maxCommits }) {
  /** @type {string[]} */
  const notes = [];
  const listed = await attempt(gh.listPullRequestCommits(slug, number, { signal }));
  if (!listed.ok) return { commits: [], notes: [`commit list failed: ${errMsg(listed.error)}`] };
  if (listed.value.truncated) notes.push('GitHub lists at most 250 commits for a PR: older commits are not read');
  // newest first, merges out: the order and the filter of the local `git log --no-merges`
  const all = listed.value.commits.filter((/** @type {any} */ c) => !c.isMerge).reverse();
  const chosen = all.slice(0, maxCommits);
  if (all.length > maxCommits) notes.push(`commit file lists read for the newest ${maxCommits} of ${all.length} commits (request cap)`);
  const results = await mapLimit(chosen, COMMIT_CONCURRENCY, (c) => attempt(gh.getCommit(slug, c.sha, { signal })), { signal });
  /** @type {Array<{sha: string, subject: string, files: string[]}>} */
  const commits = [];
  /** @type {string[]} */
  const failures = [];
  let cut = 0;
  results.forEach((r, i) => {
    if (!r.ok) { failures.push(errMsg(r.error)); return; }
    if (r.value.filesTruncated) cut++;
    commits.push({ sha: chosen[i].sha.slice(0, SHA_LENGTH), subject: chosen[i].subject, files: r.value.files });
  });
  if (failures.length) notes.push(`${failures.length} commit request(s) failed, those commits are left out (first: ${failures[0]})`);
  if (cut) notes.push(`${cut} commit(s) changed more files than GitHub lists at once: their file lists may be incomplete`);
  return { commits, notes };
}

/**
 * @param {{gh: any, slug: {owner: string, repo: string}, pr: {headSha: string, baseSha: string}, signal?: AbortSignal}} p
 * @returns {Promise<{dirs: string[], notes: string[]}>}
 */
async function gatherGeneratedDirs({ gh, slug, pr, signal }) {
  const reads = [pr.headSha, pr.baseSha].flatMap((ref) => GENERATED_FILES.map((file) => ({ ref, file })));
  const got = await Promise.all(reads.map(({ ref, file }) => attempt(gh.fileAtRef(slug, file, ref, { signal }))));
  // a null text: the file does not exist there, which is not an error
  const texts = got.map((r) => (r.ok ? r.value : null));
  const notes = got.flatMap((r, i) => (r.ok ? [] : [`${reads[i].file} at ${reads[i].ref.slice(0, SHA_LENGTH)} could not be read: ${errMsg(r.error)}`]));
  return { dirs: generatedDirsAtBoth({ head: [texts[0], texts[1]], base: [texts[2], texts[3]] }), notes };
}

module.exports = { gatherRemoteCardFacts, zeroContextDiff, diffFactsFromFiles };
