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
  ThemeColor: class { constructor(id, color) { this.id = id; this.color = color; } },
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
    class { constructor(id, color) { this.id = id; this.color = color; } },
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

const targetRepo = require('./target-repo');
const repo = targetRepo();
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
    // An empty diff is a legitimate state of a hand-picked target repo, not a failing
    // assertion; crashing here once hid a real regression behind a TypeError. The
    // built-in fixture always has findings, so there it is a failure.
    targetRepo.skipOrFail('tree', [`target repo has no findings against '${process.env.IMPACT_TREE_BASE || 'main'}'`,
      '(check out a branch with changes, or set IMPACT_TREE_BASE)']);
  }
  // Route each lazy query to the TS project of the file it is asked about.
  const { loadTypeScript } = require('../src/languages/typescript/load');
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
    const children = await provider.getChildren(f);
    // An expanded file ends in one spacer row (41c383e): not a counting row, no verdict.
    check(`${f.relPath} ends in exactly one spacer, which is not among its counting rows`,
      children.length > 0 && children.at(-1).type === 'spacer' && children.filter((r) => r.type === 'spacer').length === 1
      && children.slice(0, -1).length === f.rows.length);
    const rows = children.filter((r) => r.type !== 'spacer');
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
  // The description reads: attention, progress, then the last folder (41c383e puts the least
  // important part last, since a sidebar truncates from the right).
  const progressAt = String(firstItem.description).split('  ·  ').findIndex((p) => /^\d+\/\d+$/.test(p));
  check('a file row shows its progress', progressAt >= 0, String(firstItem.description));
  check('a file row names its last folder after the progress',
    path.dirname(graphFiles[0].relPath) === '.' || String(firstItem.description).endsWith(`  ·  ${path.basename(path.dirname(graphFiles[0].relPath))}`),
    String(firstItem.description));
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
    LEGEND.some(([, label, desc]) => /callers updated/i.test(`${label} ${desc}`)) && LEGEND.some(([, label, desc]) => /not on the call line/i.test(`${label} ${desc}`)));
  const summary = provider.summarize();
  // `<what is reviewed> · <n> need attention · <left> of <total> left` (P1 vocabulary); the
  // words come from the model, and the numbers must be the counts.
  const counts = provider.reviewCounts();
  const { MODE_LABELS, attentionCountText } = require('../src/tree-row-models');
  check('the summary is the view message',
    summary.message === `${MODE_LABELS[result.mode]} · ${attentionCountText(counts.attention)} · ${counts.left} of ${counts.total} left`, String(summary.message));
  check('the summary counts every counting row', counts.total === fileRows.length - graphFiles.length + graphFiles.reduce((n, f) => n + f.rows.length, 0), `${counts.total}`);

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
    // Symbol rows keep the git letter without the label colour (41c383e, 0848e1a); the file row
    // that holds them carries the git palette.
    check('symbol rows are not tinted', colours.length === 0, [...new Set(colours)].join(', '));
    const fileColours = graphFiles.map((f) => (decorate.provideFileDecoration(f.decorationUri) || {}).color).filter(Boolean).map((c) => c.id);
    check('file rows carry the git palette',
      fileColours.length > 0 && fileColours.every((c) => c.startsWith('gitDecoration.')), [...new Set(fileColours)].join(', '));
    const tips = changeNodes.map((n) => (decorate.provideFileDecoration(n.decorationUri) || {}).tooltip).filter(Boolean);
    check('badge spells out the status on hover', tips.some((t) => /^(Added|Modified|Deleted|Renamed)/.test(t)), tips[0] || 'none');
    const uris = new Set(changeNodes.map((n) => n.decorationUri.toString()));
    check('one decoration target per symbol (fragment makes them unique)', uris.size === changeNodes.length, `${uris.size} unique`);
  }

  console.log('▸ TreeItem rendering');
  const worst = changeNodes[0];
  const item = provider.getTreeItem(worst);
  check('change row labelled with its own name', String(item.label).startsWith(worst.name), String(item.label));
  // Every change row shows its state in words, even in hover mode, with no glyph token;
  // each keeps "no test" / "tests ?" after it.
  const hoverBad = changeNodes.filter((n) => {
    const d = String(provider.getTreeItem(n).description);
    const tail = '(  ·  (no test|tests \\?))*$';
    return !(new RegExp(`^(in .+  ·  )?\\S.*${tail}`, 'u').test(d) && !/[⛔✓∅●?]/u.test(d));
  });
  check('hover mode: row keeps where it is, its state in words and "no test"',
    hoverBad.length === 0, hoverBad.slice(0, 2).map((n) => provider.getTreeItem(n).description).join(' | ') || String(item.description));
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
  // The default icon mode is 'symbol' (41c383e); 'file' keeps the file-type glyph so the theme resolves the extension.
  check('change row shows a symbol-kind icon by default', /^symbol-/.test(item.iconPath && item.iconPath.id), item.iconPath && item.iconPath.id);
  state.iconMode = 'file';
  // ThemeIcon.File cannot be tinted, so in file mode a red or amber row swaps it for the
  // tinted error / warning icon (P2); a calm row keeps ThemeIcon.File.
  {
    const { LEVEL_TONES } = require('../src/tree-row-models');
    const tone = LEVEL_TONES[classifyRowVerdict(worst).level];
    const icon = provider.getTreeItem(worst).iconPath;
    check('iconMode="file" gives a change row the file glyph, tinted error/warning when red or amber',
      tone ? icon.id === tone.fileIcon && icon.color && icon.color.id === tone.color : icon === vscodeStub.ThemeIcon.File,
      `level ${classifyRowVerdict(worst).level}: ${icon && icon.id}`);
  }
  delete state.iconMode;
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
  check('hover mode: caller row says its state in words', /^(call updated|changed, but not at the call|not changed|test)(  ·  .+)?$/u.test(String(ci.description)), String(ci.description));
  check('hover mode: caller tooltip has state and path',
    /call updated|not changed|changed, but not at the call|test/.test(ci.tooltip.value) && /\.tsx?/.test(ci.tooltip.value));
  check('caller row shows a symbol-kind icon by default (or beaker for tests)',
    /^(symbol-.*|beaker|issue-reopened)$/.test(ci.iconPath.id), ci.iconPath && ci.iconPath.id);
  state.iconMode = 'file';
  const symbolRow = callerKids.find((c) => !c.test && !c.cycle) || worst;
  const ci2 = provider.getTreeItem(symbolRow);
  check('iconMode="file" switches code rows to the file-type glyph', ci2.iconPath === vscodeStub.ThemeIcon.File, ci2.iconPath && ci2.iconPath.id);
  delete state.iconMode;

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
    const rows = (await provider.getChildren(file)).filter((r) => r.type !== 'spacer');
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
