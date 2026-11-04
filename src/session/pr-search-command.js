// @ts-check
'use strict';
// "Search pull requests": a picker over the loaded open PRs that VS Code filters by
// number, title and author as the user types. A number that is not loaded (closed,
// merged, or past the list's cap) is offered as a lookup on GitHub. Picking a PR runs
// the same flow as clicking its row (impactTree.openPullRequest).

const { searchRows, lookupNumber, readRecent, rememberOpened } = require('../github/pr-search');

/** `$(name)` in a label renders as an icon; a title that contains it must not. @param {string} s */
const noIcons = (s) => s.replace(/\$\(/g, '$​(');

/**
 * @param {any} vscode
 * @param {{
 *   gh: any, repoSlug: () => ({ owner: string, repo: string } | null),
 *   getPrs: () => any[], getPrsTruncated: () => boolean, isLoadingPrs: () => boolean,
 *   getTeams: () => ({ teams: any[], error: string | null }),
 *   onDidChangePrs: (listener: () => void) => { dispose(): void },
 *   workspaceState: any, log: (s: string) => void,
 * }} deps `onDidChangePrs` fires when the PR list (or its loading state) changes, so an
 *   open picker shows a list that finished loading after it opened.
 * @returns {{ disposables: { dispose(): void }[], recordOpened: (pr: { number: number }) => void }}
 */
function registerPullRequestSearch(vscode, { gh, repoSlug, getPrs, getPrsTruncated, isLoadingPrs, getTeams, onDidChangePrs, workspaceState, log }) {
  const recordOpened = (/** @type {{ number: number }} */ pr) => {
    const slug = repoSlug();
    if (!slug || !pr || !Number.isSafeInteger(pr.number)) return;
    Promise.resolve(rememberOpened(workspaceState, slug, pr.number)).catch((e) => log(`pr search: could not save recent PRs: ${e.message}`));
  };

  async function search() {
    const slug = repoSlug();
    if (!slug) {
      vscode.window.showWarningMessage('Impact Tree: this workspace has no GitHub remote, so there are no pull requests to search.');
      return;
    }
    if (!gh.isSignedIn()) {
      const pick = await vscode.window.showInformationMessage('Sign in to GitHub to search pull requests.', 'Sign in');
      if (pick) await vscode.commands.executeCommand('impactTree.githubSignIn');
      return;
    }

    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Search by #number, title, or author';
    qp.matchOnDescription = true;

    /** @type {any[]} */
    let base = [];
    const rebuild = () => {
      const prs = getPrs() || [];
      const team = getTeams();
      qp.busy = isLoadingPrs();
      qp.title = getPrsTruncated()
        ? `Search pull requests in ${slug.owner}/${slug.repo} (first ${prs.length} loaded; type a number to find any other)`
        : `Search pull requests in ${slug.owner}/${slug.repo}`;
      base = searchRows(prs, { login: gh.account(), teams: team.error ? null : team.teams, recent: readRecent(workspaceState, slug) })
        .map((r) => (r.kind === 'separator'
          ? { label: r.label, kind: vscode.QuickPickItemKind.Separator }
          : { label: noIcons(r.label), description: noIcons(r.description), pr: r.pr }));
      showFor(qp.value);
    };
    /** @param {string} value */
    const showFor = (value) => {
      const n = lookupNumber(value, getPrs() || []);
      // alwaysShow: VS Code's filter would otherwise hide it when the label stops matching.
      qp.items = n === null ? base : [{
        label: `$(search) Look up #${n} on GitHub`,
        description: 'not in the loaded list',
        alwaysShow: true, lookup: n,
      }, ...base];
    };

    const subs = [
      qp.onDidChangeValue(showFor),
      onDidChangePrs(rebuild),
      qp.onDidAccept(async () => {
        const [item] = qp.selectedItems;
        if (!item) return;
        if (item.pr) {
          qp.hide();
          await vscode.commands.executeCommand('impactTree.openPullRequest', item.pr);
          return;
        }
        if (item.lookup) {
          qp.busy = true;
          qp.enabled = false;
          let pr;
          try {
            pr = await gh.getPullRequest(slug, item.lookup);
          } catch (err) {
            const e = /** @type {{ status?: number, message?: string }} */ (err || {});
            qp.busy = false;
            qp.enabled = true;
            log(`pr search: lookup of #${item.lookup} failed: ${e.message}`);
            vscode.window.showWarningMessage(e.status === 404
              ? `Impact Tree: ${slug.owner}/${slug.repo} has no pull request #${item.lookup}.`
              : `Impact Tree: could not look up #${item.lookup}: ${e.message}`);
            return;
          }
          qp.hide();
          await vscode.commands.executeCommand('impactTree.openPullRequest', pr);
        }
      }),
      qp.onDidHide(() => { for (const s of subs) s.dispose(); qp.dispose(); }),
    ];
    rebuild();
    qp.show();
  }

  return {
    disposables: [vscode.commands.registerCommand('impactTree.searchPullRequests', search)],
    recordOpened,
  };
}

module.exports = { registerPullRequestSearch };
