'use strict';
const prKey = (r) => `${r.prNumber}:${r.headSha}:${r.base?.sha}`;

// A side that does not exist: the base of an added file, the head of a deleted one.
const isAbsentSide = (status, side) => (side === 'base' ? status === 'added' : status === 'deleted');

/**
 * The query of an `impacttree-pr:` address; the single place that builds it. The
 * address is self-sufficient: it names the PR, the head commit and the merge-base
 * commit, so a tab can be rebuilt from GitHub when its text is no longer held.
 *
 * @param {{ prNumber: number, headSha: string, base?: { sha: string } }} r The preview.
 * @param {'head'|'base'} side
 * @param {{ path: string, basePath?: string, status?: string }} [file] The file the
 *   address opens. Adds `from` (the base-side path of a renamed file) and `absent`
 *   (this side does not exist, so an empty document is the true content, not a failed
 *   fetch). Omit it for an address that is only an identity, such as a tree row's.
 * @returns {string}
 */
function prQuery(r, side, file) {
  let query = `side=${side}&revision=${encodeURIComponent(prKey(r))}`;
  if (!file) return query;
  if (side === 'base' && file.basePath && file.basePath !== file.path) query += `&from=${encodeURIComponent(file.basePath)}`;
  if (isAbsentSide(file.status, side)) query += '&absent=1';
  return query;
}

/**
 * What a tab's address says it shows.
 *
 * @param {{ path: string, query: string }} uri An `impacttree-pr:` address.
 * @returns {{ revision: string, side: 'head'|'base', path: string, commit: string,
 *   commitPath: string, absent: boolean }} `commit` and `commitPath` are where GitHub
 *   holds this side: the head commit at the file's path, or the merge base at its old path.
 */
function parsePrAddress(uri) {
  const query = new URLSearchParams(uri.query);
  const revision = query.get('revision') || '';
  const [, headSha, baseSha] = revision.split(':');
  const side = query.get('side') === 'base' ? 'base' : 'head';
  const path = uri.path.replace(/^\/+/, '');
  return {
    revision, side, path,
    commit: side === 'base' ? baseSha : headSha,
    commitPath: side === 'base' ? query.get('from') || path : path,
    absent: query.get('absent') === '1',
  };
}

/**
 * The text of the current preview, and nothing older. Owner: the extension (one per
 * activation, cleared on deactivation). Lifetime: from `add` until the next `add` or
 * `clear`, so the extension holds one revision's downloaded text however many pull
 * requests are previewed. Tabs on any other revision are rebuilt from GitHub by the
 * content provider when they open; open tabs are unaffected because VS Code holds
 * their text. Key: PR number, head commit and merge-base commit (`prKey`).
 */
function createPrDocuments() {
  let held = null;
  return {
    /**
     * Publishes a preview, releasing the one before it.
     * @param {{ prNumber: number, headSha: string, base?: { sha: string }, texts: Map<string, { head: string|null, base: string|null }> }} result
     */
    add(result) { held = { key: prKey(result), texts: result.texts }; },
    /**
     * @param {{ path: string, query: string }} uri
     * @returns {string|null} The text, `''` for a side that does not exist, or `null`
     *   when it is not held: another revision, a file that was never downloaded, or a
     *   side whose download failed. A null is never to be shown as an empty document.
     */
    read(uri) {
      const address = parsePrAddress(uri);
      if (address.absent) return '';
      if (!held || held.key !== address.revision) return null;
      const text = held.texts.get(address.path)?.[address.side];
      return typeof text === 'string' ? text : null;
    },
    clear() { held = null; },
  };
}
module.exports = { prKey, prQuery, parsePrAddress, createPrDocuments };
