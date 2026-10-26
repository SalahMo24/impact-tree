// @ts-check
'use strict';

// The code of a pull request at its two commits, read from git objects (no checkout of
// either is needed): get_source, list_files and search_code read through it. Scope: the
// files of the repository at the head and base commits given; nothing else on disk.

const { makeGit } = require('../engine/git');

// Texts kept in the cache. Unit: files. Past this the cache starts again (it is a speed-up
// only; every entry can be read again).
const MAX_CACHED_TEXTS = 5000;

/**
 * @typedef {object} CodeSource
 * @property {(side: 'head'|'base', relPath: string) => string|null} show The text of a file
 *   at the head or base; null when it does not exist there.
 * @property {() => string[]} list Repository-relative paths at the head.
 * @property {(pattern: string, prefix: string, max: number) => { hits: Array<{ file: string, line: number, text: string }>, capped: boolean }} grep
 *   Fixed-string search at the head, under `prefix`; `capped` when more than `max` lines match.
 * @property {string} headSha
 * @property {string} baseSha
 */

/**
 * @param {string} repo Absolute repository root.
 * @param {string} headSha @param {string} baseSha Full commit ids; they name the code.
 * @returns {CodeSource}
 */
function gitSource(repo, headSha, baseSha) {
  // Paths and prefixes from an agent are literal: no `:(top)`-style pathspec magic.
  const git = makeGit(repo, { env: { GIT_LITERAL_PATHSPECS: '1' } });
  /** @type {Map<string, string|null>} */
  const cache = new Map();
  /** @type {string[]|null} */
  let listed = null;
  return {
    headSha, baseSha,
    show(side, relPath) {
      const key = `${side}:${relPath}`;
      if (!cache.has(key)) {
        const text = git.show(side === 'head' ? headSha : baseSha, relPath);
        if (cache.size >= MAX_CACHED_TEXTS) cache.clear();
        cache.set(key, text);
      }
      return /** @type {string|null} */ (cache.get(key));
    },
    list() {
      if (!listed) listed = git.raw(['ls-tree', '-r', '--name-only', '-z', headSha]).split('\0').filter(Boolean);
      return listed;
    },
    grep(pattern, prefix, max) {
      let out = '';
      try {
        out = git.raw(['grep', '-F', '-n', '-I', '--no-color', '-e', pattern, headSha, '--', ...(prefix ? [prefix] : [])], { quiet: true });
      } catch (e) {
        // `git grep` exits 1 when nothing matches; any other failure is not "no hits".
        if (/** @type {any} */ (e).status !== 1) throw new Error(`git grep failed: ${/** @type {Error} */ (e).message.split('\n')[0]}`, { cause: e });
      }
      const lines = out.split('\n').filter(Boolean);
      const hits = lines.slice(0, max).map((l) => {
        const rest = l.slice(headSha.length + 1);
        const m = /^(.*?):(\d+):(.*)$/.exec(rest);
        return m ? { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) } : { file: rest, line: 0, text: '' };
      });
      return { hits, capped: lines.length > max };
    },
  };
}

module.exports = { gitSource, MAX_CACHED_TEXTS };
