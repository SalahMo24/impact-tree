'use strict';
// The "where do I review from" view: one row for local changes, one for open PRs.
// It deliberately owns no analysis state — picking a source just fires a command and
// the results land in the main Changes view, so there is one place to read results.

const { groupPullRequests } = require('./pr-groups');

const MODE_ICON = {
  working: 'edit',
  branch: 'git-branch',
  pr: 'git-pull-request',
  checkpoint: 'history',
};

function createSourcesProvider(vscode, {
  modes, getMode, getRepoSlug, github, getPrs, getPrsTruncated = () => false, getPrError, isLoadingPrs,
  getTeams = () => ({ teams: [], truncated: false, error: null }),
  getRepoStatus = () => 'ok',
  // Why no GitHub remote was chosen: `none` when no remote points at github.com, else the
  // choice is unclear or the setting is wrong. Null when the remote is fine.
  getRemoteProblem = () => null,
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
    item.iconPath = n.avatar ? vscode.Uri.parse(n.avatar) : n.icon ? new vscode.ThemeIcon(n.icon) : undefined;
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
        // No folder or no repository: nothing here can work, so the view is empty and its
        // welcome screen (package.json) says what to do.
        if (getRepoStatus() !== 'ok') return [];
        const slug = getRepoSlug();
        return [
          N({ type: 'group', key: 'local', label: 'Local changes', icon: 'vm', expanded: true,
            desc: modes[getMode()] ? modes[getMode()].label : getMode() }),
          N({ type: 'group', key: 'prs', label: 'Pull requests', icon: 'github', expanded: true,
            desc: slug ? `${slug.owner}/${slug.repo}` : 'no github remote' }),
        ];
      }

      if (node.key === 'local') {
        const active = getMode();
        return Object.entries(modes).map(([id, m]) => N({
          type: 'mode',
          label: m.label,
          icon: id === active ? 'check' : (MODE_ICON[id] || 'circle-outline'),
          desc: m.desc,
          command: 'impactTree.analyseMode',
          args: [id],
        }));
      }

      if (node.key === 'prs') {
        const slug = getRepoSlug();
        if (!slug) {
          const problem = getRemoteProblem();
          return [N({ type: 'message', icon: 'circle-slash',
            label: problem && !problem.none ? 'Cannot tell which GitHub remote to use' : 'No GitHub remote on this workspace',
            desc: problem ? problem.text : 'No remote of this repository points at github.com.',
            tooltip: problem ? problem.text : undefined })];
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
        const prRow = (p, via) => N({
          type: 'pr',
          label: `#${p.number}  ${p.title}`,
          icon: p.draft ? 'git-pull-request-draft' : 'git-pull-request',
          // The author's avatar replaces the PR icon when GitHub gave one, so a draft has
          // to be said in words as well.
          avatar: p.authorAvatarUrl || null,
          desc: `${p.author}${p.draft ? '  ·  draft' : ''}${via ? `  ·  via ${via.join(', ')}` : ''}${p.isFork ? '  ·  fork' : ''}`,
          tooltip: `${p.title}\n\n${p.headRef} → ${p.baseRef}\nby ${p.author}\nupdated ${p.updatedAt}`
            + (via ? `\nreview requested from ${via.join(', ')}` : '')
            + (p.isFork ? `\n\nFrom fork ${p.headRepo}.` : ''),
          command: 'impactTree.openPullRequest',
          args: [p],
        });
        const team = getTeams();
        const { requested, mine, others } = groupPullRequests(prs,
          { login: github.account(), teams: team.error ? null : team.teams });
        // A team list that failed or was cut short can hide requests; say so inside the
        // group it affects, never let it pass as "nothing waiting on you".
        const teamWarnings = [];
        if (team.error) {
          teamWarnings.push(N({ type: 'message', label: 'Team review requests are not shown', icon: 'warning',
            desc: team.error, tooltip: `Your GitHub teams could not be loaded, so only reviews requested from you directly are listed here.\n\n${team.error}`,
            command: 'impactTree.refreshPullRequests' }));
        } else if (team.truncated) {
          teamWarnings.push(N({ type: 'message', label: `Only your first ${team.teams.length} teams are checked`,
            icon: 'warning', desc: 'requests to your other teams are not listed' }));
        }
        // Counts sit in the description so the label, and with it the expansion state the
        // user chose, stays the same as PRs move between groups.
        const group = (key, label, icon, expanded, prRows, notes = []) => N({
          type: 'group', key, label, icon, expanded, desc: String(prRows.length), children: [...notes, ...prRows],
        });
        const out = [
          group('pr-requested', 'Review requested', 'eye', true,
            requested.map(({ pr, via }) => prRow(pr, via)), teamWarnings),
          group('pr-mine', 'Yours', 'account', true, mine.map((p) => prRow(p))),
          group('pr-others', 'Everyone else', 'organization', false, others.map((p) => prRow(p))),
        ];
        // Same rule as the truncated-files warning: say the list is partial, never let
        // a capped list pass as every open PR.
        if (getPrsTruncated()) {
          out.push(N({ type: 'message', label: `Only the first ${prs.length} open pull requests are shown`,
            icon: 'warning', desc: 'more exist on GitHub' }));
        }
        return out;
      }
      if (node.children) return node.children;
      return [];
    },
  };
}

module.exports = { createSourcesProvider };
