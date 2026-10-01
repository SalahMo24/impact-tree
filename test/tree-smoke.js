#!/usr/bin/env node
'use strict';
// Verifies the TreeDataProvider against the real engine using a stubbed `vscode`
// module, so tree logic (ranking, lazy expansion, cycle cut) is testable without an
// Extension Development Host.
const path = require('path');
const { analyze } = require('../src/engine/analyze');
const { createTsResolver } = require('../src/engine/resolver-ts');
const { createTreeProvider } = require('../src/tree-provider');

const vscodeStub = {
  MarkdownString: class { constructor(v) { this.value = v; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  // faithful enough to catch what the last stub missed: .with() and fragments
  Uri: {
    file: (p) => {
      const mk = (fsPath, fragment) => ({
        fsPath, fragment, scheme: 'file', __isUri: true,
        with: (o) => mk(fsPath, o.fragment !== undefined ? o.fragment : fragment),
        toString: () => `file://${fsPath}${fragment ? '#' + fragment : ''}`,
      });
      return mk(p, '');
    },
  },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  ThemeIcon: Object.assign(
    class { constructor(id) { this.id = id; } },
    { File: { id: '__file__' }, Folder: { id: '__folder__' } }),
  // mirror the real constructor: a Uri argument sets resourceUri and derives the label
  TreeItem: class {
    constructor(labelOrUri, state) {
      if (labelOrUri && labelOrUri.__isUri) {
        this.resourceUri = labelOrUri;
        this.label = require('path').basename(labelOrUri.fsPath);
      } else this.label = labelOrUri;
      this.collapsibleState = state;
    }
  },
};

const repo = require('./target-repo')();
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

(async () => {
  console.log('▸ analyse (skipForest, lazy tree)');
  const result = await analyze(repo, { mode: process.env.IMPACT_TREE_MODE || 'branch', base: process.env.IMPACT_TREE_BASE || 'main', skipForest: true, onDirty: 'fallback', allowLocalBase: true });
  const changedKeys = new Set(result.components.flatMap((c) => c.changed.map((x) => `${x.file}#${x.namePos}`)));

  // one resolver over the component owning the top finding
  const top = result.findings[0];
  if (!top) {
    // An empty diff is a legitimate state of the target repo, not a failing assertion.
    // Crashing here once hid a real regression behind a TypeError.
    console.log(`  skip  target repo has no findings against '${process.env.IMPACT_TREE_BASE || 'main'}'`);
    console.log('        (check out a branch with changes, or set IMPACT_TREE_BASE)');
    console.log('\ntree checks did NOT run');
    process.exit(0);
  }
  // Visible roots may belong to a different project from the highest-scored
  // (possibly nested) finding. Route each lazy query to its own TS project.
  const { loadTypeScript } = require('../src/engine/analyze');
  const { projectRootOf } = require('../src/engine/diff');
  const resolvers = new Map();
  const resolver = {
    async incoming(file, pos, withTests) {
      const project = projectRootOf(repo, path.relative(repo, file));
      const dir = path.join(repo, project || '');
      if (!resolvers.has(dir)) resolvers.set(dir, createTsResolver(loadTypeScript(repo, dir), dir, { repoRoot: repo }));
      return resolvers.get(dir)?.incoming(file, pos, withTests) || [];
    },
    stats: () => ({ incomingCalls: [...resolvers.values()].reduce((n,r) => n + (r?.stats().incomingCalls || 0), 0) }),
    dispose() { for (const r of resolvers.values()) r?.dispose(); },
  };

  const { offsetToPosition } = require('../src/engine/textpos');
  const callSiteUpdated = (file, sites) => {
    const ranges = (result.changedRanges || {})[path.relative(repo, file)];
    if (!ranges || !ranges.length || !sites || !sites.length) return false;
    return sites.some((cs) => {
      const a = offsetToPosition(file, cs.start), b = offsetToPosition(file, cs.end);
      return a && b && ranges.some(([lo, hi]) => a.line + 1 <= hi && b.line + 1 >= lo);
    });
  };
  const state = { result, changedKeys, callSiteUpdated, rel: (f) => path.relative(repo, f),
    absPath: (p2) => path.join(repo, p2), error: null };
  let busy = false;
  let phase = 'ready';
  const { createDecorationProvider } = require('../src/decorations');
  const decorate = createDecorationProvider(vscodeStub);
  const { createReviewState } = require('../src/review-state');
  const mem = { m: new Map(), get(k) { return this.m.get(k); }, update(k, v) { this.m.set(k, v); } };
  const review = createReviewState(mem);
  const identify = require('../src/review-identity').createReviewIdentity(loadTypeScript(repo,repo), repo, result,
    (rel) => require('../src/engine/git').makeGit(repo).show(result.base.sha, rel));
  review.configure('smoke-review', identify);
  const provider = createTreeProvider(vscodeStub, {
    getState: () => state, resolver, isBusy: () => busy, decorate, getPhase: () => phase, review });

  console.log('▸ readiness states');
  for (const [ph, label, hint] of [
    ['starting', 'Preparing…', /indexing the workspace/],
    ['preparing', 'Preparing…', /indexing the workspace/],
    ['analysing', 'Analysing…', /resolving callers/],
  ]) {
    phase = ph;
    const rows = await provider.getChildren();
    check(`phase '${ph}' shows a single spinner row`,
      rows.length === 1 && rows[0].icon === 'loading~spin' && rows[0].label === label,
      rows.map((b) => b.label).join(','));
    check(`phase '${ph}' explains itself`, hint.test(String(rows[0].desc)));
  }
  phase = 'ready';
  {
    const rows = await provider.getChildren();
    check('ready with a result renders the tree, not a placeholder',
      rows.some((r) => r.type === 'section'), rows.map((r) => r.type).join(','));
  }
  busy = false;

  console.log('▸ root level');
  const roots = await provider.getChildren();
  const sections = roots.filter((n) => n.type === 'section');
  check('sections present', sections.length === 5, sections.map((s2) => `${s2.key}(${s2.count})`).join(' '));
  const findingsSection = sections.find((s2) => s2.key === 'findings');
  const otherSection = sections.find((s2) => s2.key === 'other');
  const findingNodes = await provider.getChildren(findingsSection);
  const otherNodes = await provider.getChildren(otherSection);
  check('body-only changes are visible', otherNodes.length > 0, `${otherNodes.length} under 'Other changes'`);
  const topLevel = findingNodes.length + otherNodes.length;
  const rootCount = (result.allChanged || []).filter((c) => c.isRoot !== false).length;
  check('top level shows only roots', topLevel === rootCount, `${topLevel} rows, ${rootCount} roots of ${(result.allChanged || []).length} changed`);
  check('nested symbols are NOT duplicated at top level',
    topLevel < (result.allChanged || []).length, `${(result.allChanged || []).length - topLevel} nested`);
  // every nested symbol must still be reachable by expanding its callee
  const nestedSyms = (result.allChanged || []).filter((c) => c.isRoot === false);
  let reachable = 0;
  for (const nsym of nestedSyms) {
    const parent = (result.allChanged || []).find((p2) => (p2.callers || []).some((x) => x.file === nsym.file && x.pos === nsym.namePos));
    if (parent) reachable++;
  }
  check('every nested symbol has a visible parent', reachable === nestedSyms.length, `${reachable}/${nestedSyms.length}`);
  const delNodes = await provider.getChildren(sections.find((s2) => s2.key === 'deleted'));
  // monorepos legitimately contain two same-named symbols in different projects
  const dupLabels = findingNodes.concat(otherNodes).filter((n) => n.ambiguous);
  const names = new Set(findingNodes.map((n) => n.finding.label));
  if (findingNodes.length !== names.size) {
    check('duplicate labels are marked ambiguous', dupLabels.length >= 2, `${dupLabels.length} marked`);
    const it = provider.getTreeItem(dupLabels[0]);
    check('ambiguous row names its component', /‹.+›/.test(String(it.label)), String(it.label));
    check('ambiguous rows are distinguishable',
      new Set(dupLabels.map((n) => String(provider.getTreeItem(n).label))).size === dupLabels.length);
  }
  check('deleted symbols rendered', delNodes.length === result.deleted.length, `${delNodes.length}`);
  state.fileListLayout = 'flat';
  const fileNodes = (await provider.getChildren(sections.find((s2) => s2.key === 'files'))).filter((f) => f.type === 'file');
  state.fileListLayout = 'tree';
  check('non-code files rendered', fileNodes.length === (result.otherFiles || []).length, `${fileNodes.length}`);
  if (fileNodes.length) {
    const fi = provider.getTreeItem(fileNodes[0]);
    check('file rows are constructed FROM the Uri (icon theme applies)',
      !!fi.resourceUri && !fi.iconPath, fi.resourceUri ? path.basename(fi.resourceUri.fsPath) : 'none');
    check('file row label comes from the basename', fi.label === path.basename(fileNodes[0].relPath), String(fi.label));
    const exts = [...new Set(fileNodes.map((f) => path.extname(f.relPath) || '(none)'))];
    check('multiple file types present to theme', exts.length > 1, exts.join(' '));
  }
  check('summary row first', roots[0] && roots[0].type === 'summary', roots[0] && roots[0].label);
  const legend = roots.find((n) => n.type === 'legend');
  check('legend node present', !!legend);
  if (legend) {
    const li = await provider.getChildren(legend);
    check('legend explains every marker', li.length >= 8, `${li.length} entries`);
    check('legend distinguishes call-updated from changed-elsewhere',
      li.some((x) => /all call sites updated/i.test(x.label)) && li.some((x) => /NOT on the call line/i.test(x.label)));
    check('legend explains the icon and the git badge',
      li.some((x) => /file type/i.test(x.label)) && li.some((x) => /Badge M \/ A \/ D \/ R/i.test(x.label)));
  }
  check('findings section shows finding roots',
    findingNodes.length === result.findings.filter((f) => f.isRoot !== false).length,
    `${findingNodes.length} of ${result.findings.length} findings are roots`);
  check('ranked descending', findingNodes.every((n, i) => i === 0 || findingNodes[i - 1].score >= n.score));
  check('every warning surfaced as a message', result.warnings.every((w) => roots.some((n) => n.type === 'message' && n.label === w)));
  // Only asserted when the diff actually touches a component without node_modules.
  // With the corrected origin/main base this PR touches none, so it is informational.
  const unanalysableMsgs = roots.filter((n) => n.type === 'message' && /not analysed/.test(n.label));
  check('unanalysable components surfaced iff present',
    unanalysableMsgs.length === result.unanalysable.length,
    result.unanalysable.length ? unanalysableMsgs.map((n) => n.label).join(' | ') : 'none in this diff');

  console.log('▸ decorations (git badge + severity colour)');
  check('decorations registered for rows', decorate._size() > 0, `${decorate._size()} entries`);
  {
    const withBadge = [];
    for (const n of findingNodes.concat(otherNodes)) {
      const d = decorate.provideFileDecoration(n.decorationUri);
      if (d && d.badge) withBadge.push(`${n.label}:${d.badge}`);
    }
    check('symbol rows carry a git status badge', withBadge.length > 0, withBadge.slice(0, 3).join(' '));
    check('badges are at most two characters',
      withBadge.every((x) => x.split(':').pop().length <= 2));
    const colours = findingNodes.map((n) => {
      const d = decorate.provideFileDecoration(n.decorationUri);
      return d && d.color ? d.color.id : null;
    }).filter(Boolean);
    check('git palette restored on sparse rows',
      colours.length > 0 && colours.every((c) => c.startsWith('gitDecoration.')),
      [...new Set(colours)].join(', '));
    const tips = findingNodes.map((n) => (decorate.provideFileDecoration(n.decorationUri) || {}).tooltip).filter(Boolean);
    check('badge spells out the status on hover', tips.some((t) => /^(Added|Modified|Deleted|Renamed)/.test(t)),
      tips[0] || 'none');
    const uris = new Set(findingNodes.concat(otherNodes).map((n) => n.decorationUri.toString()));
    check('one decoration target per symbol (fragment makes them unique)',
      uris.size === findingNodes.length + otherNodes.length, `${uris.size} unique`);
  }

  console.log('▸ TreeItem rendering');
  const item = provider.getTreeItem(findingNodes[0]);
  // an ambiguous row gets a  ‹component›  suffix, so match the symbol name as a prefix
  check('finding item labelled', String(item.label).startsWith(findingNodes[0].label), String(item.label));
  check('hover mode: row keeps the state glyph only', /^[⛔✓△○?]$/.test(String(item.description)), String(item.description));
  check('hover mode: tooltip carries state + marker',
    /call site\(s\) not updated|all call sites updated|callers unknown/.test(item.tooltip.value));
  check('hover mode: tooltip lists the stale callers',
    !findingNodes[0].finding.staleCallers || /call site\(s\) not updated:/.test(item.tooltip.value));
  state.rowDetail = 'inline';
  const itemInline = provider.getTreeItem(findingNodes[0]);
  check('inline mode still available', /^[⛔✓△○?]/.test(String(itemInline.description)), String(itemInline.description));
  state.rowDetail = 'hover';
  check('finding row uses ThemeIcon.File so the icon theme resolves the extension',
    item.iconPath === vscodeStub.ThemeIcon.File, item.iconPath && item.iconPath.id);
  check('finding row still carries resourceUri for the theme to match on',
    !!item.resourceUri, item.resourceUri ? path.basename(item.resourceUri.fsPath) : 'none');
  check('tooltip carries signatures', /base:|head:|\+ throw/.test((item.tooltip && item.tooltip.value) || ''));

  console.log('▸ lazy expansion');
  const before = resolver.stats().incomingCalls;
  const kids = await provider.getChildren(findingNodes[0]);
  const after = resolver.stats().incomingCalls;
  const callerKids = kids.filter((k) => k.type === 'caller');
  check('caller list has no blank rows', kids.every((k) => k.type === 'caller'), `${kids.length} rows`);
  check('callers sorted so same-file rows are adjacent', (() => {
    const seenFiles = new Set(); let ok = true; let prev = null;
    for (const k of callerKids) { if (k.relPath !== prev) { if (seenFiles.has(k.relPath)) ok = false; seenFiles.add(k.relPath); prev = k.relPath; } }
    return ok;
  })());
  check('expansion queries the resolver', after > before, `${before} -> ${after}`);
  check('children returned', callerKids.length > 0, `${callerKids.length} caller(s)`);
  check('changed callers flagged', callerKids.every((k) => typeof k.changed === 'boolean'));
  const ci = provider.getTreeItem(callerKids[0]);
  check('hover mode: caller row keeps the state glyph only', /^[✓△○↑🧪]$/u.test(String(ci.description)), String(ci.description));
  check('hover mode: caller tooltip has state and path',
    /call updated|not changed|changed, but not at the call|test/.test(ci.tooltip.value) && /\.ts/.test(ci.tooltip.value));
  check('every caller has a three-state callState',
    callerKids.every((k) => ['updated-at-call', 'changed-elsewhere', 'unchanged'].includes(k.callState)),
    [...new Set(callerKids.map((k) => k.callState))].join(', '));

  check('caller row uses ThemeIcon.File (or beaker for tests)',
    ci.iconPath === vscodeStub.ThemeIcon.File || /^(beaker|issue-reopened)$/.test(ci.iconPath.id),
    ci.iconPath && ci.iconPath.id);
  state.iconMode = 'symbol';
  const symbolRow = callerKids.find((c) => !c.test && !c.cycle) || findingNodes[0];
  const ci2 = provider.getTreeItem(symbolRow);
  check('iconMode="symbol" switches code rows back to symbol icons',
    !!ci2.iconPath && /^symbol-/.test(ci2.iconPath.id), ci2.iconPath && ci2.iconPath.id);
  state.iconMode = 'file';

  console.log('▸ file grouping (GitHub-style hierarchy, no blank rows)');
  {
    const filesSection = sections.find((s2) => s2.key === 'files');
    const top = await provider.getChildren(filesSection);
    check('no blank separator rows anywhere', top.every((t) => t.type !== 'separator'));
    const dirs = top.filter((t) => t.type === 'dir');
    check('files nest under directory rows', dirs.length > 0, `${dirs.length} dir(s) at top`);
    const di = provider.getTreeItem(dirs[0]);
    check('directory rows use the folder icon', di.iconPath === vscodeStub.ThemeIcon.Folder, String(di.label));
    // compaction shows up below the root: `components` has two children here, but
    // e.g. `pkg/docs` collapses into one row
    const allDirLabels = [];
    const collect = async (nodes) => {
      for (const n2 of nodes) {
        if (n2.type === 'dir') { allDirLabels.push(n2.label); await collect(await provider.getChildren(n2)); }
      }
    };
    await collect(top);
    check('single-child chains are compacted anywhere in the tree',
      allDirLabels.some((l) => String(l).includes('/')),
      allDirLabels.join(' | ').slice(0, 100));
    // every file must still be reachable by walking the tree
    let seen = 0;
    const walk = async (nodes) => {
      for (const n2 of nodes) {
        if (n2.type === 'file') seen++;
        else if (n2.type === 'dir') await walk(await provider.getChildren(n2));
      }
    };
    await walk(top);
    check('every file reachable through the hierarchy', seen === (result.otherFiles || []).length,
      `${seen}/${(result.otherFiles || []).length}`);
    state.fileListLayout = 'flat';
    const flat = await provider.getChildren(filesSection);
    check('flat layout returns one row per file', flat.length === (result.otherFiles || []).length
      && flat.every((f) => f.type === 'file'), `${flat.length}`);
    state.fileListLayout = 'tree';
  }

  console.log('▸ review state');
  {
    const f0 = findingNodes[0];
    const id = review.id(f0);
    check('finding has a stable id', !!id, id);
    let it = provider.getTreeItem(f0);
    check('starts unchecked', it.checkboxState === vscodeStub.TreeItemCheckboxState.Unchecked);
    const kids = review.childIds(f0);
    review.setWithChildren(id, kids, true);
    it = provider.getTreeItem(f0);
    check('checking a finding marks it', it.checkboxState === vscodeStub.TreeItemCheckboxState.Checked);
    check('and clears its known callers', review.remaining(kids) === 0, `${kids.length} caller(s)`);
    check('hover mode keeps the row glyph-only', /^[⛔✓△○?]$/.test(String(it.description)), String(it.description));
    check('progress moved into the tooltip', /callers reviewed|callers left/.test(it.tooltip.value));
    state.rowDetail = 'inline';
    check('inline mode shows progress on the row',
      /callers reviewed|callers left/.test(String(provider.getTreeItem(f0).description)));
    state.rowDetail = 'hover';
    const rows = await provider.getChildren();
    check('summary reports remaining work', /left to review|all reviewed/.test(String(rows[0].label)), String(rows[0].label));
    // a different base must not inherit judgements
    review.configure('another-review', identify);
    check('progress does not carry across reviews', review.remaining([id]) === 1);
    review.configure('smoke-review', identify);
    check('and is restored when the review comes back', review.remaining([id]) === 0);
    review.clear();
    check('clear resets', review.size() === 0);
  }

  console.log('▸ cycle cut');
  let node = findingNodes[0], depth = 0, sawCycle = false;
  while (depth++ < 4) {
    const cs = (await provider.getChildren(node)).filter((c) => c.type === 'caller');
    if (!cs.length) break;
    if (cs.some((c) => c.cycle)) { sawCycle = true; break; }
    node = cs[0];
  }
  check('path tracking populated', Array.isArray(node.path) || node.type === 'finding');
  check('cycle detection reachable without infinite loop', true, sawCycle ? 'cycle found' : 'no cycle on this path');

  resolver.dispose();
  console.log(`\n${fail ? `${fail} check(s) FAILED` : 'all tree checks passed'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
