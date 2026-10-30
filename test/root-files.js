'use strict';
// The file (and folder) rows a review shows at the top of its tree, wherever they sit: the
// root rows with the calm state's "Browse all" container opened (a review where nothing
// needs attention keeps its files there, collapsed) and the message rows left out.
/**
 * @param {{ getChildren: (row?: any) => Promise<any[]>|any[] }} provider
 * @returns {Promise<any[]>}
 */
async function rootFiles(provider) {
  const out = [];
  for (const row of await provider.getChildren()) {
    if (row.type === 'browse') out.push(...await provider.getChildren(row));
    else if (row.type !== 'message') out.push(row);
  }
  return out;
}
module.exports = { rootFiles };
