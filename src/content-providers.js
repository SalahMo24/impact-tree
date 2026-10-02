'use strict';

/**
 * Virtual documents for the left and right of a review diff. PR text comes from
 * fetched documents; base-revision text comes from git show.
 *
 * @param {*} vscode
 * @param {{ prDocuments: object, repoRoot: () => string }} opts
 * @returns {object[]} disposables to push on the extension context
 */
function registerContentProviders(vscode, { prDocuments, repoRoot }) {
  return [
    // Tier A text: head and base come from what we fetched, never from the worktree.
    vscode.workspace.registerTextDocumentContentProvider('impacttree-pr', {
      provideTextDocumentContent: (uri) => prDocuments.read(uri),
    }),
    // base-revision contents for the left-hand side of the diff
    vscode.workspace.registerTextDocumentContentProvider('impacttree-base', {
      provideTextDocumentContent(uri) {
        const { makeGit } = require('./engine/git');
        return makeGit(repoRoot()).show(uri.query, uri.path) || '';
      },
    }),
  ];
}

module.exports = { registerContentProviders };
