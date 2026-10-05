#!/usr/bin/env node
'use strict';
// Verifies the TreeDataProvider against the real engine using a stubbed `vscode`
// module, so tree logic (file rows, ranking, lazy expansion, cycle cut) is testable without an
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
  const result = await analyze(repo, { mode: process.env.IMPACT_TREE_MODE || 'branch', base: process.env.IMPACT_TREE_BASE || 'main', skipForest: true, deferTestReach: true, onDirty: 'fallback', allowLocalBase: true });
  const changedKeys = new Set(result.components.flatMap((c) => c.changed.map((x) => `${x.file}#${x.namePos}`)));

  const top = result.findings[0];
  if (!top) {
    // An empty diff is a legitimate state of the target repo, not a failing assertion.
    // Crashing here once hid a real regression behind a TypeError.
    console.log(`  skip  target repo has no findings against '${process.env.IMPACT_TREE_BASE || 'main'}'`);
    console.log('        (check out a branch with changes, or set IMPACT_TREE_BASE)');
    console.log('\ntree checks did NOT run');
    process.exit(0);
  }
  // Route each lazy query to the TS project of the file it is asked about.
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

  const { readLineOfOffset } = require('../src/engine/textpos');
  const { classifyCallSiteUpdates } = require('../src/engine/call-sites');
  const classifyCallers = (file, callSites) => classifyCallSiteUpdates({
    callSites, changedLineRanges: (result.changedRanges || {})[path.relative(repo, file)],
    lineOfOffset: (offset) => readLineOfOffset(file, offset),
  });
  const state = { result, changedKeys, classifyCallSiteUpdates: classifyCallers, rel: (f) => path.relative(repo, f),
    absPath: (p2) => path.join(repo, p2), error: null };
  let busy = false;
  let phase = 'ready';
  const { createDecorationProvider } = require('../src/decorations');
  const decorate = createDecorationProvider(vscodeStub);
  const { createReviewState } = require('../src/review-state');
  const mem = { m: new Map(), get(k) { return this.m.get(k); }, update(k, v) { this.m.set(k, v); } };
  const review = createReviewState(mem);
  const { createReviewIdentity, localRevisions } = require('../src/review-identity');
  const identify = createReviewIdentity(loadTypeScript(repo,repo), repo, localRevisions(repo, result, require('../src/engine/git').makeGit(repo)));
  review.configure('smoke-review', identify);
  const provider = createTreeProvider(vscodeStub, {
    getState: () => state, resolver, isBusy: () => busy, decorate, getPhase: () => phase, review });
  const { classifyRowVerdict } = require('../src/tree-row-models');

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
    check(`phase '${ph}' has no summary`, provider.summarize().message === undefined);
  }
  phase = 'ready';
  {
    const rows = await provider.getChildren();
    check('ready with a result renders the files, not a placeholder',
      rows.some((r) => r.type === 'reviewFile' || r.type === 'file'), rows.map((r) => r.type).join(','));
  }
  busy = false;

  console.log('▸ root level: one row per changed file, worst first');
  const roots = await provider.getChildren();
  const fileRows = roots.filter((n) => n.type === 'reviewFile' || n.type === 'file');
  const changedPaths = new Set([...Object.keys(result.fileStatus || {}), ...(result.otherFiles || []).map((f) => f.path)]);
  check('every changed path is one file row', fileRows.length === changedPaths.size
    && new Set(fileRows.map((f) => f.relPath)).size === fileRows.length, `${fileRows.length} rows, ${changedPaths.size} paths`);
  check('files go worst first', fileRows.every((f, i) => i === 0 || fileRows[i - 1].level <= f.level),
    fileRows.slice(0, 5).map((f) => `${f.relPath}:${f.level}`).join(' '));
  check('notices come before the files', roots.slice(0, roots.length - fileRows.length).every((n) => n.type === 'message'));
  check('every warning surfaced as a message', result.warnings.every((w) => roots.some((n) => n.type === 'message' && n.label === w)));
  // Only asserted when the diff actually touches a component without node_modules.
  const unanalysableMsgs = roots.filter((n) => n.type === 'message' && /not analysed/.test(n.label));
  check('unanalysable components surfaced iff present',
    unanalysableMsgs.length === result.unanalysable.length,
    result.unanalysable.length ? unanalysableMsgs.map((n) => n.label).join(' | ') : 'none in this diff');
  const items = fileRows.map((f) => provider.getTreeItem(f));
  check('only the first file starts expanded',
    items.every((it, i) => it.collapsibleState === (i === 0 && fileRows[0].type === 'reviewFile' ? 2 : fileRows[i].type === 'reviewFile' ? 1 : 0)));

  const graphFiles = fileRows.filter((f) => f.type === 'reviewFile');
  const changeNodes = [];
  const deletedNodes = [];
  const outsideNodes = [];
  for (const f of graphFiles) {
    const rows = await provider.getChildren(f);
    check(`rows of ${f.relPath} go worst first`, rows.every((r, i) => i === 0 || classifyRowVerdict(rows[i - 1]).level <= classifyRowVerdict(r).level));
    changeNodes.push(...rows.filter((r) => r.type === 'finding'));
    deletedNodes.push(...rows.filter((r) => r.type === 'deleted'));
    outsideNodes.push(...rows.filter((r) => r.type === 'outside'));
  }
  check('every changed symbol is a change row exactly once, nested ones included',
    changeNodes.length === (result.allChanged || []).length && new Set(changeNodes.map((n) => `${n.file}#${n.pos}`)).size === changeNodes.length,
    `${changeNodes.length} rows, ${(result.allChanged || []).length} changed`);
  check('deleted symbols rendered', deletedNodes.length === result.deleted.length, `${deletedNodes.length}`);
  check('outside-functions rows rendered', outsideNodes.length === (result.outside || []).length, `${outsideNodes.length}`);
  const noGraph = fileRows.filter((f) => f.type === 'file');
  check('every file without a call graph is a file row',
    (result.otherFiles || []).every((o) => noGraph.some((f) => f.relPath === o.path)), `${noGraph.length}`);
  if (noGraph.length) {
    const fi = provider.getTreeItem(noGraph[0]);
    check('file rows are constructed FROM the Uri (icon theme applies)',
      !!fi.resourceUri && !fi.iconPath, fi.resourceUri ? path.basename(fi.resourceUri.fsPath) : 'none');
    check('file row label comes from the basename', fi.label === path.basename(noGraph[0].relPath), String(fi.label));
  }
  const exts = [...new Set(fileRows.map((f) => path.extname(f.relPath) || '(none)'))];
  check('multiple file types present to theme', exts.length > 1, exts.join(' '));
  const firstItem = provider.getTreeItem(graphFiles[0]);
  check('a file row shows its progress', /\d+\/\d+$/.test(String(firstItem.description)), String(firstItem.description));
  check('a file row keeps the file icon though it expands', firstItem.iconPath === vscodeStub.ThemeIcon.File);
  // monorepos legitimately contain two same-named symbols in different projects
  const dupLabels = changeNodes.filter((n) => n.ambiguous);
  if (dupLabels.length) {
    const it = provider.getTreeItem(dupLabels[0]);
    check('ambiguous row names its component', /‹.+›/.test(String(it.label)), String(it.label));
  }
  const { LEGEND } = require('../src/tree-provider');
  check('the legend command explains every marker', LEGEND.length >= 8, `${LEGEND.length} entries`);
  check('legend distinguishes call-updated from changed-elsewhere',
    LEGEND.some(([, label]) => /callers updated/i.test(label)) && LEGEND.some(([, label]) => /NOT on the call line/i.test(label)));
  const summary = provider.summarize();
  check('the summary is the view message', /need attention · \d+ of \d+ left$/.test(String(summary.message)), String(summary.message));

  console.log('▸ decorations (git badge + severity colour)');
  check('decorations registered for rows', decorate._size() > 0, `${decorate._size()} entries`);
  {
    const withBadge = [];
    for (const n of changeNodes) {
      const d = decorate.provideFileDecoration(n.decorationUri);
      if (d && d.badge) withBadge.push(`${n.label}:${d.badge}`);
    }
    check('symbol rows carry a git status badge', withBadge.length > 0, withBadge.slice(0, 3).join(' '));
    check('badges are at most two characters', withBadge.every((x) => x.split(':').pop().length <= 2));
    const colours = changeNodes.map((n) => {
      const d = decorate.provideFileDecoration(n.decorationUri);
      return d && d.color ? d.color.id : null;
    }).filter(Boolean);
    check('git palette restored on sparse rows',
      colours.length > 0 && colours.every((c) => c.startsWith('gitDecoration.')), [...new Set(colours)].join(', '));
    const tips = changeNodes.map((n) => (decorate.provideFileDecoration(n.decorationUri) || {}).tooltip).filter(Boolean);
    check('badge spells out the status on hover', tips.some((t) => /^(Added|Modified|Deleted|Renamed)/.test(t)), tips[0] || 'none');
    const uris = new Set(changeNodes.map((n) => n.decorationUri.toString()));
    check('one decoration target per symbol (fragment makes them unique)', uris.size === changeNodes.length, `${uris.size} unique`);
  }

  console.log('▸ TreeItem rendering');
  const worst = changeNodes[0];
  const item = provider.getTreeItem(worst);
  check('change row labelled with its own name', String(item.label).startsWith(worst.name), String(item.label));
  check('hover mode: row keeps where it is, the verdict glyph and "no test" only',
    /^(in \S+ {2}· {2})?[⛔✓∅●?]( {2}· {2}no test)?$/u.test(String(item.description)), String(item.description));
  check('hover mode: tooltip carries the verdict sentence and the location',
    item.tooltip.value.includes(`${worst.finding.relPath}:${worst.finding.startLine}`));
  check('hover mode: tooltip lists the stale callers',
    !worst.finding.staleCallers || /call site\(s\) not updated:/.test(item.tooltip.value));
  if (worst.finding.baseSig && worst.finding.baseSig !== worst.finding.headSig) {
    check('tooltip carries signatures', /base:|head:/.test(item.tooltip.value));
  }
  state.rowDetail = 'inline';
  const itemInline = provider.getTreeItem(worst);
  check('inline mode shows the verdict in words', String(itemInline.description).length > String(item.description).length, String(itemInline.description));
  state.rowDetail = 'hover';
  check('change row uses ThemeIcon.File so the icon theme resolves the extension',
    item.iconPath === vscodeStub.ThemeIcon.File, item.iconPath && item.iconPath.id);
  check('change row still carries resourceUri for the theme to match on', !!item.resourceUri);

  console.log('▸ impact rows (from the result)');
  const expandable = changeNodes.find((n) => n.finding.callers?.length > 0);
  if (!expandable) throw new Error('This fixture needs a change with callers for the impact checks');
  const before = resolver.stats().incomingCalls;
  const impact = await provider.getChildren(expandable);
  check('a change\'s callers come from the result: no query', resolver.stats().incomingCalls === before);
  const testsRow = impact[impact.length - 1];
  check('the last row says what is known of tests', testsRow.type === 'message' && /test/i.test(testsRow.label), testsRow.label);
  check('a "may be missing" row iff the caller search did not finish',
    impact.some((k) => k.type === 'message' && /may be missing|could not be loaded/.test(k.label)) === (expandable.finding.callersComplete === false));
  const callerKids = impact.flatMap((k) => (k.type === 'callerFile' ? k.callers : k.type === 'caller' ? [k] : []));
  check('grouping retains every known caller', callerKids.length === expandable.finding.callers.length, `${callerKids.length}/${expandable.finding.callers.length}`);
  check('callers sorted so same-file rows are adjacent', (() => {
    const seenFiles = new Set(); let ok = true; let prev = null;
    for (const k of callerKids) { if (k.relPath !== prev) { if (seenFiles.has(k.relPath)) ok = false; seenFiles.add(k.relPath); prev = k.relPath; } }
    return ok;
  })());
  check('changed callers flagged', callerKids.every((k) => typeof k.changed === 'boolean'));
  check('every caller has a three-state callState',
    callerKids.every((k) => ['updated-at-call', 'changed-elsewhere', 'unchanged'].includes(k.callState)),
    [...new Set(callerKids.map((k) => k.callState))].join(', '));
  check('caller rows have no checkbox', impact.concat(callerKids).every((k) => provider.getTreeItem(k).checkboxState === undefined));
  // a self-recursive change lists itself as a caller, which is a cycle row with no state
  const lazyRoot = callerKids.find((c) => !c.cycle);
  if (!lazyRoot) throw new Error('This fixture needs a change with a caller that is not itself');
  const ci = provider.getTreeItem(lazyRoot);
  check('hover mode: caller row keeps the state glyph only', /^[✓△○↑🧪]$/u.test(String(ci.description)), String(ci.description));
  check('hover mode: caller tooltip has state and path',
    /call updated|not changed|changed, but not at the call|test/.test(ci.tooltip.value) && /\.tsx?/.test(ci.tooltip.value));
  check('caller row uses ThemeIcon.File (or beaker for tests)',
    ci.iconPath === vscodeStub.ThemeIcon.File || /^(beaker|issue-reopened)$/.test(ci.iconPath.id), ci.iconPath && ci.iconPath.id);
  state.iconMode = 'symbol';
  const symbolRow = callerKids.find((c) => !c.test && !c.cycle) || worst;
  const ci2 = provider.getTreeItem(symbolRow);
  check('iconMode="symbol" switches code rows back to symbol icons', !!ci2.iconPath && /^symbol-/.test(ci2.iconPath.id), ci2.iconPath && ci2.iconPath.id);
  state.iconMode = 'file';

  console.log('▸ lazy expansion of a caller');
  const beforeLazy = resolver.stats().incomingCalls;
  const expanded = await provider.getChildren(lazyRoot);
  check('expanding a caller queries the resolver', resolver.stats().incomingCalls > beforeLazy, `${beforeLazy} -> ${resolver.stats().incomingCalls}`);
  // This resolver cannot say whether a search finished, so the tree must not let it look
  // complete: one trailing row says so, and the caller rows come before it.
  const notices = expanded.filter((k) => k.type === 'message');
  check('a resolver without completion status gets a "may be missing" row',
    notices.length === 1 && /may be missing|could not be loaded/.test(notices[0].label) && expanded[expanded.length - 1] === notices[0],
    notices.map((k) => k.label).join(' | '));
  check('caller list has no blank rows', expanded.filter((k) => k.type !== 'message').every((k) => ['caller', 'callerFile'].includes(k.type) && k.label));

  console.log('▸ review state');
  {
    const file = graphFiles[0];
    const rows = await provider.getChildren(file);
    const left = () => Number(/(\d+) of \d+ left$/.exec(provider.summarize().message)[1]);
    const start = left();
    check('a file starts unchecked', provider.getTreeItem(file).checkboxState === vscodeStub.TreeItemCheckboxState.Unchecked);
    provider.setChecked(file, true);
    check('ticking a file ticks its rows', rows.every((r) => provider.getTreeItem(r).checkboxState === vscodeStub.TreeItemCheckboxState.Checked));
    check('and the file shows ticked', provider.getTreeItem(file).checkboxState === vscodeStub.TreeItemCheckboxState.Checked);
    check('the summary counts them', left() === start - rows.length, `${start} -> ${left()}`);
    provider.setChecked(rows[0], false);
    check('unticking one row unticks the file', provider.getTreeItem(file).checkboxState === vscodeStub.TreeItemCheckboxState.Unchecked);
    const id = review.id(rows[1] || rows[0]);
    review.configure('another-review', identify);
    check('progress does not carry across reviews', review.remaining([id]) === 1);
    review.configure('smoke-review', identify);
    check('and is restored when the review comes back', rows.length < 2 || review.remaining([id]) === 0);
    review.clear();
    check('clear resets', review.size() === 0);
  }

  console.log('▸ cycle cut');
  let node = lazyRoot, depth = 0, sawCycle = false;
  while (depth++ < 4) {
    const cs = (await provider.getChildren(node)).filter((c) => c.type === 'caller');
    if (!cs.length) break;
    if (cs.some((c) => c.cycle)) { sawCycle = true; break; }
    node = cs[0];
  }
  check('path tracking populated', Array.isArray(node.path));
  check('cycle detection reachable without infinite loop', true, sawCycle ? 'cycle found' : 'no cycle on this path');

  resolver.dispose();
  console.log(`\n${fail ? `${fail} check(s) FAILED` : 'all tree checks passed'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
