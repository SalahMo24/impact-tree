'use strict';
// The "where do I review from" view: one row for local changes, one for open PRs.
// It deliberately owns no analysis state — picking a source just fires a command and
// the results land in the main Changes view, so there is one place to read results.

const MODE_ICON = {
  working: 'edit',
  branch: 'git-branch',
  pr: 'git-pull-request',
  checkpoint: 'history',
};

function createSourcesProvider(vscode, {
  modes, getMode, getRepoSlug, github, getPrs, getPrsTruncated = () => false, getPrError, isLoadingPrs,
}) {
  const _emitter = new vscode.EventEmitter();
  const N = (o) => o;

  function toItem(n) {
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    if (n.type === 'group') {
      const item = new vscode.TreeItem(n.label,
        n.expanded ? vscode.TreeItemCollapsibleState.Expanded : collapsed);
      item.iconPath = new vscode.ThemeIcon(n.icon);
      item.description = n.desc;
      item.contextValue = `source-${n.key}`;
      return item;
    }
    const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = n.icon ? new vscode.ThemeIcon(n.icon) : undefined;
    item.description = n.desc;
    if (n.tooltip) item.tooltip = n.tooltip;
    if (n.command) item.command = { command: n.command, title: n.label, arguments: n.args || [] };
    return item;
  }

  return {
    onDidChangeTreeData: _emitter.event,
    refresh() { _emitter.fire(); },
    getTreeItem: toItem,
    async getChildren(node) {
      if (!node) {
        const slug = getRepoSlug();
        return [
          N({ type: 'group', key: 'local', label: 'Local changes', icon: 'vm', expanded: true,
            desc: `mode: ${getMode()}` }),
          N({ type: 'group', key: 'prs', label: 'Pull requests', icon: 'github', expanded: true,
            desc: slug ? `${slug.owner}/${slug.repo}` : 'no github remote' }),
        ];
      }

      if (node.key === 'local') {
        const active = getMode();
        return Object.entries(modes).map(([id, m]) => N({
          type: 'mode',
          label: id,
          icon: id === active ? 'check' : (MODE_ICON[id] || 'circle-outline'),
          desc: m.desc,
          command: 'impactTree.analyseMode',
          args: [id],
        }));
      }

      if (node.key === 'prs') {
        const slug = getRepoSlug();
        if (!slug) {
          return [N({ type: 'message', label: 'No GitHub remote on this workspace', icon: 'circle-slash',
            desc: 'origin does not point at github.com' })];
        }
        if (!github.isSignedIn()) {
          return [N({ type: 'message', label: 'Sign in to GitHub', icon: 'sign-in',
            desc: 'lists open pull requests', command: 'impactTree.githubSignIn' })];
        }
        if (isLoadingPrs()) {
          return [N({ type: 'message', label: 'Loading pull requests…', icon: 'loading~spin' })];
        }
        const err = getPrError();
        if (err) {
          return [N({ type: 'message', label: err, icon: 'error',
            desc: 'click to retry', command: 'impactTree.refreshPullRequests' })];
        }
        const prs = getPrs();
        if (!prs || !prs.length) {
          return [N({ type: 'message', label: 'No open pull requests', icon: 'info',
            desc: 'click to refresh', command: 'impactTree.refreshPullRequests' })];
        }
        const rows = prs.map((p) => N({
          type: 'pr',
          label: `#${p.number}  ${p.title}`,
          icon: p.draft ? 'git-pull-request-draft' : 'git-pull-request',
          desc: `${p.author}${p.isFork ? '  ·  fork' : ''}`,
          tooltip: `${p.title}\n\n${p.headRef} → ${p.baseRef}\nby ${p.author}\nupdated ${p.updatedAt}`
            + (p.isFork ? `\n\nFrom fork ${p.headRepo} — analysing it needs a fetch from that fork.` : ''),
          command: 'impactTree.openPullRequest',
          args: [p],
        }));
        // Same rule as the truncated-files warning: say the list is partial, never let
        // a capped list pass as every open PR.
        if (getPrsTruncated()) {
          rows.push(N({ type: 'message', label: `Only the first ${prs.length} open pull requests are shown`,
            icon: 'warning', desc: 'more exist on GitHub' }));
        }
        return rows;
      }
      return [];
    },
  };
}

module.exports = { createSourcesProvider };
