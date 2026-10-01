'use strict';
const prKey = (r) => `${r.prNumber}:${r.headSha}:${r.base?.sha}`;
const prQuery = (r, side) => `side=${side}&revision=${encodeURIComponent(prKey(r))}`;
function createPrDocuments() {
  const revisions = new Map();
  return {
    add(result) { revisions.set(prKey(result), result.texts); },
    read(uri) {
      const query = new URLSearchParams(uri.query);
      const text = revisions.get(query.get('revision'))?.get(uri.path.replace(/^\/+/, ''));
      // Missing sides of a diff are empty documents, not synthetic source lines.
      return text?.[query.get('side') === 'base' ? 'base' : 'head'] || '';
    },
    clear() { revisions.clear(); },
  };
}
module.exports = { prKey, prQuery, createPrDocuments };
