#!/usr/bin/env node
'use strict';
// Covers the source picker without an Extension Host. The bug this guards against is
// the one that shipped: a view that exists in code but renders nothing, because its
// states (signed out, empty, error, loading) were never exercised.
const { createSourcesProvider } = require('../src/sources-provider');
const { parseRemote } = require('../src/github');

const vscodeStub = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
};

const MODES = {
  working: { desc: 'uncommitted changes only' },
  branch: { desc: 'whole branch vs base' },
  pr: { desc: 'committed branch state vs base' },
  checkpoint: { desc: 'since a recorded checkpoint' },
};

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

function build(over = {}) {
  const o = {
    modes: MODES,
    getMode: () => 'pr',
    getRepoSlug: () => ({ owner: 'SalahMo24', repo: 'impact-tree' }),
    github: { isSignedIn: () => true, account: () => 'me' },
    getPrs: () => [],
    getPrError: () => null,
    isLoadingPrs: () => false,
    ...over,
  };
  return createSourcesProvider(vscodeStub, o);
}

(async () => {
  console.log('▸ remote parsing');
  const cases = [
    ['git@github.com:SalahMo24/impact-tree.git', 'SalahMo24', 'impact-tree'],
    ['https://github.com/SalahMo24/impact-tree.git', 'SalahMo24', 'impact-tree'],
    ['https://github.com/SalahMo24/impact-tree', 'SalahMo24', 'impact-tree'],
    ['https://github.com/SalahMo24/impact-tree/', 'SalahMo24', 'impact-tree'],
    ['ssh://git@github.com/org/sub.name.git', 'org', 'sub.name'],
  ];
  for (const [url, owner, repo] of cases) {
    const r = parseRemote(url);
    check(`parses ${url}`, r && r.owner === owner && r.repo === repo, JSON.stringify(r));
  }
  check('rejects a non-github remote', parseRemote('git@gitlab.com:a/b.git') === null);
  check('rejects an empty remote', parseRemote('') === null);

  console.log('\n▸ roots');
  const roots = await build().getChildren();
  check('exactly two source rows', roots.length === 2, String(roots.length));
  check('first is local changes', roots[0].key === 'local', roots[0].label);
  check('second is pull requests', roots[1].key === 'prs', roots[1].label);
  check('both start expanded so neither is hidden behind a twistie',
    roots.every((r) => r.expanded === true));
  check('pr row names the repo', roots[1].desc === 'SalahMo24/impact-tree', roots[1].desc);
  check('local row names the active mode', roots[0].desc === 'mode: pr', roots[0].desc);

  console.log('\n▸ local modes');
  const local = await build().getChildren(roots[0]);
  check('one row per engine mode', local.length === Object.keys(MODES).length, String(local.length));
  check('every mode carries an analyse command',
    local.every((m) => m.command === 'impactTree.analyseMode' && m.args.length === 1));
  const active = local.filter((m) => m.icon === 'check');
  check('exactly the active mode is ticked', active.length === 1 && active[0].label === 'pr',
    active.map((a) => a.label).join(','));
  check('working mode is reachable — the local review the user asked for',
    local.some((m) => m.label === 'working' && m.args[0] === 'working'));

  console.log('\n▸ pull request states');
  const prsNode = roots[1];

  const signedOut = await build({ github: { isSignedIn: () => false } }).getChildren(prsNode);
  check('signed out offers sign-in', signedOut.length === 1
    && signedOut[0].command === 'impactTree.githubSignIn', signedOut[0].label);

  const noRemote = await build({ getRepoSlug: () => null }).getChildren(prsNode);
  check('no github remote says so rather than offering sign-in',
    noRemote.length === 1 && !noRemote[0].command && /no github remote|No GitHub remote/i.test(noRemote[0].label),
    noRemote[0].label);

  const loading = await build({ isLoadingPrs: () => true }).getChildren(prsNode);
  check('loading shows a spinner', loading[0].icon === 'loading~spin');

  const errored = await build({ getPrError: () => 'GitHub rejected the token (401) — sign in again' })
    .getChildren(prsNode);
  check('an API error is shown verbatim, not swallowed as "no PRs"',
    /401/.test(errored[0].label) && errored[0].icon === 'error', errored[0].label);
  check('the error row is retryable', errored[0].command === 'impactTree.refreshPullRequests');

  const empty = await build().getChildren(prsNode);
  check('empty list is distinct from an error', empty[0].icon === 'info', empty[0].label);

  const base = { headRef: 'f/x', baseRef: 'main', draft: false, isFork: false, url: 'u', updatedAt: 't',
    requestedReviewers: [], requestedTeams: [] };
  const list = [
    { ...base, number: 12, title: 'fix thing', author: 'a' },
    { ...base, number: 13, title: 'wip', author: 'b', draft: true, isFork: true, headRepo: 'b/fork' },
    { ...base, number: 14, title: 'mine', author: 'me' },
    { ...base, number: 15, title: 'asked of me', author: 'a', requestedReviewers: ['me'] },
    { ...base, number: 16, title: 'asked of my team', author: 'b', requestedTeams: [{ id: 7, name: 'backend' }] },
  ];
  const teams = { teams: [{ id: 7, name: 'backend', parentId: null }], truncated: false, error: null };
  const grouped = build({ getPrs: () => list, getTeams: () => teams });
  const groups = await grouped.getChildren(prsNode);
  check('three groups in order: requested, yours, everyone else',
    groups.map((g) => g.key).join() === 'pr-requested,pr-mine,pr-others', groups.map((g) => g.key).join());
  check('each group counts its PRs', groups.map((g) => g.desc).join() === '2,1,2', groups.map((g) => g.desc).join());
  check('requested and yours start expanded, everyone else collapsed',
    groups.map((g) => g.expanded).join() === 'true,true,false');
  const [requested, mine, rows] = await Promise.all(groups.map((g) => grouped.getChildren(g)));
  check('direct and team requests share one group',
    requested.map((r) => r.args[0].number).join() === '15,16', requested.map((r) => r.label).join(' | '));
  check('a requested row says who it was requested from',
    /via you/.test(requested[0].desc) && /via backend/.test(requested[1].desc), requested.map((r) => r.desc).join(' | '));
  check('the signed-in user\'s PR is under yours', mine.length === 1 && mine[0].args[0].number === 14);
  check('one row per remaining PR', rows.length === 2);
  check('number and title in the label', rows[0].label === '#12  fix thing', rows[0].label);
  check('drafts use the draft icon', rows[1].icon === 'git-pull-request-draft', rows[1].icon);
  check('a fork is flagged in the row, not discovered at checkout',
    /fork/.test(rows[1].desc), rows[1].desc);
  check('clicking a PR passes the whole PR object',
    rows[0].command === 'impactTree.openPullRequest' && rows[0].args[0].number === 12);

  const none = await build({ getPrs: () => [list[0]], getTeams: () => teams }).getChildren(prsNode);
  check('empty groups stay visible with a zero count',
    none.length === 3 && none[0].desc === '0' && none[1].desc === '0' && none[2].desc === '1',
    none.map((g) => `${g.key}=${g.desc}`).join());

  const failedTeams = build({ getPrs: () => list,
    getTeams: () => ({ teams: [], truncated: false, error: 'GitHub answered 403 for /user/teams' }) });
  const [reqFailed] = await failedTeams.getChildren(prsNode);
  const reqFailedRows = await failedTeams.getChildren(reqFailed);
  check('a failed team lookup is said inside "requested", not passed off as nothing waiting',
    reqFailedRows[0].icon === 'warning' && /403/.test(reqFailedRows[0].desc), reqFailedRows[0].label);
  check('the failure row is retryable', reqFailedRows[0].command === 'impactTree.refreshPullRequests');
  check('direct requests still show when teams failed, and the count excludes the warning',
    reqFailed.desc === '1' && reqFailedRows.slice(1).map((r) => r.args[0].number).join() === '15',
    `${reqFailed.desc}: ${reqFailedRows.map((r) => r.label).join(' | ')}`);

  const cutTeams = build({ getPrs: () => list, getTeams: () => ({ ...teams, truncated: true }) });
  const cutRows = await cutTeams.getChildren((await cutTeams.getChildren(prsNode))[0]);
  check('a truncated team list is said too', cutRows[0].icon === 'warning' && /first 1 teams/.test(cutRows[0].label),
    cutRows[0].label);

  const capped = await build({ getPrs: () => list, getPrsTruncated: () => true }).getChildren(prsNode);
  check('a capped PR list is still said, after the groups',
    capped.length === 4 && capped[3].icon === 'warning' && /first 5/.test(capped[3].label), capped[3] && capped[3].label);

  console.log('\n▸ rendering');
  const p = build();
  const item = p.getTreeItem(roots[0]);
  check('group renders expanded', item.collapsibleState === vscodeStub.TreeItemCollapsibleState.Expanded);
  check('a collapsed PR group renders collapsed',
    p.getTreeItem(groups[2]).collapsibleState === vscodeStub.TreeItemCollapsibleState.Collapsed);
  const leaf = p.getTreeItem(rows[0]);
  check('pr row renders as a leaf', leaf.collapsibleState === vscodeStub.TreeItemCollapsibleState.None);
  check('pr row has a click command', leaf.command && leaf.command.command === 'impactTree.openPullRequest');

  console.log(fail ? `\n${fail} failure(s)` : '\nall source checks passed');
  process.exit(fail ? 1 : 0);
})();
