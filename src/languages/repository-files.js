// @ts-check
'use strict';
// Which of a repository's files a syntax-only caller index reads in the CLI, where the whole
// repository is on disk (Python: A8-D1 (b); Go: S-D1 (a)). Shared by the languages whose
// `prepareSyntactic` indexes the repository; each lists its own files and says which are
// always kept.
//
// Budgets (CODING_STYLE §2), both enforced here before a file is read:
// - files: `REPO_MAX_FILES` (3000); bytes: `REPO_MAX_BYTES` (64 MiB), the sum of the listed
//   sizes on disk. Owner: this module. Exhaustion: only the kept files and the files whose
//   text mentions a changed name are indexed (up to the same bounds), and the caller's scope
//   note says so with the count left out.
// - bytes per file: `maxFileBytes` (the index's own per-file limit, 1 MiB by default): a
//   larger file is not read once the bound is exceeded (the index would skip it anyway).

const REPO_MAX_FILES = 3000;
const REPO_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/**
 * The CLI's file set: every listed file while both bounds hold (`maxFiles` files, `maxBytes`
 * bytes); past either, the files `keep` accepts (by default the changed files) plus the
 * files whose text mentions a changed name, and the count left out.
 * @param {Array<{ path: string, size: number }>} listed The repository's files of the language.
 * @param {(relPath: string) => string|null} read Reads one file's text.
 * @param {{ changedPaths: Set<string>, names: Set<string>, keep?: (relPath: string) => boolean,
 *   maxFiles?: number, maxBytes?: number, maxFileBytes?: number }} options `keep`: files
 *   always indexed when bounded (Go: every file of a changed package); default
 *   `changedPaths.has`.
 * @returns {{ sources: Array<{ path: string, text: string }>, notIndexed: number, bounded: boolean }}
 */
function pickRepositoryFiles(listed, read, { changedPaths, names, keep = (rel) => changedPaths.has(rel), maxFiles = REPO_MAX_FILES, maxBytes = REPO_MAX_BYTES, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
  const total = listed.reduce((n, f) => n + f.size, 0);
  if (listed.length <= maxFiles && total <= maxBytes) {
    const sources = [];
    for (const f of listed) { const text = read(f.path); if (text != null) sources.push({ path: f.path, text }); }
    return { sources, notIndexed: listed.length - sources.length, bounded: false };
  }
  const words = [...names].filter(Boolean);
  const mention = words.length ? new RegExp(`\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`) : null;
  const sources = [];
  let bytes = 0;
  for (const f of listed) {
    if (f.size > maxFileBytes) continue;
    const kept = keep(f.path);
    if (!kept && (sources.length >= maxFiles || bytes + f.size > maxBytes)) continue;
    const text = read(f.path);
    if (text == null) continue;
    if (kept || (mention && mention.test(text))) { sources.push({ path: f.path, text }); bytes += f.size; }
  }
  return { sources, notIndexed: listed.length - sources.length, bounded: true };
}

module.exports = { pickRepositoryFiles, REPO_MAX_FILES, REPO_MAX_BYTES };
