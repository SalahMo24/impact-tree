'use strict';
const { parsePrAddress } = require('./pr-documents');

// What a tab shows when its text could not be had. An empty document would pass for the
// file's real content, so each cause is named, with how to load the tab again.
function failureMessage(error, lead) {
  switch (error.name) {
    case 'GitHubAuthError': return `${lead} GitHub rejected the token, so you are signed out. Sign in to GitHub, then reopen this tab.`;
    case 'GitHubTimeoutError': return `${lead} GitHub did not answer in time. Close this tab and reopen it to try again.`;
    case 'GitHubResponseTooLargeError': return `${lead} the file is too large to load from GitHub. Open it on GitHub instead.`;
    default: return `${lead} ${error.message}. Close this tab and reopen it to try again.`;
  }
}

// Reads a revision the extension does not hold from GitHub, at the commit and path in
// the address. Nothing it returns is kept. Resolves to the text, or to a message.
async function fetchPreviewText(address, { gh, repoSlug }, signal) {
  const lead = `Impact Tree could not load ${address.commitPath} at ${String(address.commit).slice(0, 7)}:`;
  const slug = repoSlug();
  if (!slug) return `${lead} this folder has no GitHub repository to read it from.`;
  if (!gh.isSignedIn()) return `${lead} you are signed out of GitHub. Sign in, then reopen this tab.`;
  try {
    const text = await gh.fileAtRef(slug, address.commitPath, address.commit, { signal });
    // The address says this side exists, so GitHub not having it means the commit is gone.
    return text ?? `${lead} it is no longer on GitHub (the branch may have been force-pushed or deleted). Run the preview again, then reopen this tab.`;
  } catch (e) {
    return failureMessage(e, lead);
  }
}

/**
 * Virtual documents for the left and right of a review diff. PR text comes from the
 * held preview, or from GitHub when a tab asks for a revision that is not held;
 * base-revision text comes from git show.
 *
 * @param {*} vscode
 * @param {{ prDocuments: object, repoRoot: () => string, gh: object, repoSlug: () => object|null, log?: (message: string) => void }} opts
 * @returns {object[]} disposables to push on the extension context
 */
function registerContentProviders(vscode, { prDocuments, repoRoot, gh, repoSlug, log = () => {} }) {
  return [
    // Tier A text: the held preview, else GitHub at the address's commit; never the worktree.
    vscode.workspace.registerTextDocumentContentProvider('impacttree-pr', {
      async provideTextDocumentContent(uri, token) {
        const held = prDocuments.read(uri);
        if (held !== null) return held;
        const controller = new AbortController();
        const listener = token && token.onCancellationRequested(() => controller.abort());
        try {
          return await fetchPreviewText(parsePrAddress(uri), { gh, repoSlug }, controller.signal);
        } finally {
          if (listener) listener.dispose();
        }
      },
    }),
    // base-revision contents for the left-hand side of the diff
    vscode.workspace.registerTextDocumentContentProvider('impacttree-base', {
      provideTextDocumentContent(uri) {
        const { makeGit } = require('./engine/git');
        const started = Date.now();
        const text = makeGit(repoRoot()).show(uri.query, uri.path);
        // A missing blob is expected for added files. Preserve the existing empty side,
        // but record it so a failed base read can be distinguished during diagnosis.
        log(`editor: base content ${uri.toString()} ${text === null ? 'unavailable or absent' : `${text.length} characters`} in ${Date.now() - started}ms`);
        return text || '';
      },
    }),
  ];
}

module.exports = { registerContentProviders };
