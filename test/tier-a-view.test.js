#!/usr/bin/env node
'use strict';
// Tier A preview, without an Extension Host: opening a caller whose file changed
// away from the call site, and the A/M/D/R badge on each row.
const path = require('path');
const { callerOpen } = require('../src/review-open');
const { createTreeProvider } = require('../src/tree-provider');
const { createDecorationProvider, STATUS_BADGE } = require('../src/decorations');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

function uri(scheme, fsPath, query, fragment) {
  const u = {
    scheme, fsPath, path: fsPath, query: query || '', fragment: fragment || '', __isUri: true,
    with(o) {
      return uri(scheme, fsPath, o.query !== undefined ? o.query : query,
        o.fragment !== undefined ? o.fragment : fragment);
    },
    toString() {
      return `${scheme}://${fsPath}${query ? '?' + query : ''}${fragment ? '#' + fragment : ''}`;
    },
  };
  return u;
}

const vscodeStub = {
  MarkdownString: class { constructor(v) { this.value = v; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: {
    file: (p) => uri('file', p, '', ''),
    parse: (s) => {
      const [base, frag] = String(s).split('#');
      const q = base.indexOf('?');
      const main = q === -1 ? base : base.slice(0, q);
      const query = q === -1 ? '' : base.slice(q + 1);
      const colon = main.indexOf(':');
      const scheme = main.slice(0, colon);
      const p = main.slice(colon + 1);
      return uri(scheme, p, query, frag || '');
    },
    from: ({ scheme, path: p, query }) => uri(scheme, p, query || '', ''),
  },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  ThemeIcon: Object.assign(
    class { constructor(id) { this.id = id; } },
    { File: { id: '__file__' }, Folder: { id: '__folder__' } }),
  TreeItem: class {
    constructor(labelOrUri, state) {
      if (labelOrUri && labelOrUri.__isUri) {
        this.resourceUri = labelOrUri;
        this.label = path.basename(labelOrUri.fsPath);
      } else this.label = labelOrUri;
      this.collapsibleState = state;
    }
  },
};

console.log('▸ opening a caller');
{
  const changed = callerOpen({
    tierA: true, rel: 'src/service.ts', absPath: '/repo/src/service.ts',
    fileChanged: true, always: false, baseSha: 'basesha', headSha: 'headsha', prNumber: 7,
  });
  check('a file changed away from the call opens as a diff', changed.kind === 'diff');
  check('the right side is the PR head, not the worktree',
    changed.right && changed.right.scheme === 'impacttree-pr' && new URLSearchParams(changed.right.query).get('side') === 'head' && new URLSearchParams(changed.right.query).get('revision') === '7:headsha:basesha',
    JSON.stringify(changed.right));
  check('the left side is the PR base',
    changed.left && new URLSearchParams(changed.left.query).get('side') === 'base');
  check('the title names the PR', changed.rhsName === 'PR #7', changed.rhsName);

  const outside = callerOpen({
    tierA: true, rel: 'src/other.ts', absPath: '/repo/src/other.ts',
    fileChanged: false, always: true, baseSha: 'basesha', headSha: 'headsha', prNumber: 7,
  });
  check('a file the PR does not touch stays a plain editor even if always-diff is on',
    outside.kind === 'editor' && outside.uri.scheme === 'file');

  const local = callerOpen({
    tierA: false, rel: 'src/service.ts', absPath: '/repo/src/service.ts',
    fileChanged: true, always: false, baseSha: 'abc', prNumber: null,
  });
  check('a local review still diffs the worktree file',
    local.kind === 'diff' && local.right.scheme === 'file' && local.rhsName === 'working');
}

console.log('\n▸ badges');
check('letters are A M D R',
  STATUS_BADGE.added === 'A' && STATUS_BADGE.modified === 'M'
  && STATUS_BADGE.deleted === 'D' && STATUS_BADGE.renamed === 'R');
check('there is no U badge — untracked is a worktree state, not a PR state',
  !Object.values(STATUS_BADGE).includes('U'));

const REPO = '/repo';
const finding = {
  label: 'Store.findLatest', file: `${REPO}/src/store.ts`, relPath: 'src/store.ts',
  namePos: 5, startLine: 2, score: 3, isRoot: true, staleCallers: 1, staleChangedElsewhere: 1,
  callerState: 'resolved', kinds: [{ id: 'param', short: 'param' }], callers: [],
  throwsAdded: [], baseSig: 'findLatest(id)', headSig: 'findLatest(id, scope)', component: 'pr',
};
const state = {
  result: {
    tierA: true,
    findings: [finding],
    allChanged: [finding],
    deleted: [],
    otherFiles: [
      { path: 'docs/new.md', status: 'added' },
      { path: 'docs/gone.md', status: 'deleted' },
      { path: 'docs/moved.md', status: 'renamed' },
    ],
    warnings: [], unanalysable: [],
    mode: 'pr-preview', base: { ref: 'main', sha: 'basesha' },
    changedFileCount: 2,
    fileStatus: {
      'src/store.ts': 'modified',
      'src/caller.ts': 'modified',
      'src/fresh.ts': 'added',
      'docs/new.md': 'added',
      'docs/gone.md': 'deleted',
      'docs/moved.md': 'renamed',
    },
  },
  rel: (f) => path.relative(REPO, f),
  absPath: (p) => path.join(REPO, p),
  fileListLayout: 'flat',
  rowDetail: 'hover',
  iconMode: 'file',
  changedKeys: new Set([`${REPO}/src/caller.ts#40`]),
  classifyCallSiteUpdates: (_, sites) => ({ updated: [], untouched: sites, unknown: [] }),
};

const decorate = createDecorationProvider(vscodeStub);
const provider = createTreeProvider(vscodeStub, {
  getState: () => state,
  resolver: {
    incoming: async () => [
      { label: 'Service.run', file: `${REPO}/src/caller.ts`, pos: 40, test: false, sites: 1, callSites: [{ start: 10, end: 18 }] },
      { label: 'Fresh.make', file: `${REPO}/src/fresh.ts`, pos: 8, test: false, sites: 1, callSites: [{ start: 4, end: 8 }] },
    ],
  },
  decorate,
});

(async () => {
  const roots = await provider.getChildren();
  const files = await provider.getChildren(roots.find((n) => n.type === 'section' && n.key === 'files'));
  const badgeOf = (node) => {
    const item = provider.getTreeItem(node);
    const d = item.resourceUri ? decorate.provideFileDecoration(item.resourceUri) : null;
    return { scheme: item.resourceUri && item.resourceUri.scheme, badge: d && d.badge, label: item.label };
  };
  const byName = Object.fromEntries(files.map((f) => [f.label, badgeOf(f)]));
  check('file rows are not file:// URIs, so git cannot paint U on them',
    files.every((f) => badgeOf(f).scheme === 'impacttree-pr'),
    files.map((f) => badgeOf(f).scheme).join(','));
  check('an added file is A', byName['new.md'] && byName['new.md'].badge === 'A', JSON.stringify(byName['new.md']));
  check('a deleted file is D', byName['gone.md'] && byName['gone.md'].badge === 'D', JSON.stringify(byName['gone.md']));
  check('a renamed file is R', byName['moved.md'] && byName['moved.md'].badge === 'R', JSON.stringify(byName['moved.md']));

  const findings = await provider.getChildren(roots.find((n) => n.type === 'section' && n.key === 'findings'));
  check('the changed symbol itself is M', badgeOf(findings[0]).badge === 'M', JSON.stringify(badgeOf(findings[0])));
  const callers = await provider.getChildren(findings[0]);
  const run = callers.find((c) => c.label === 'Service.run');
  const fresh = callers.find((c) => c.label === 'Fresh.make');
  check('a caller edited elsewhere in the file is still M',
    run && run.callState === 'changed-elsewhere' && badgeOf(run).badge === 'M',
    run && `${run.callState} ${badgeOf(run).badge}`);
  check('a caller in an added file is A',
    fresh && badgeOf(fresh).badge === 'A', fresh && badgeOf(fresh).badge);
  check('neither caller is badged U',
    [run, fresh].every((c) => badgeOf(c).badge !== 'U'));

  console.log(fail ? `\n${fail} failure(s)` : '\nall tier A view checks passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
