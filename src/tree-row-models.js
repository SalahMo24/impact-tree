// @ts-check
'use strict';
const path = require('path');
const { classifyCallerUpdateState } = require('./engine/call-sites');

// Row models for the change tree: plain objects describing each row, built from an
// analysis result. Pure: nothing here reads session state, registers a decoration or
// touches the editor. A builder whose rows need a decoration returns it as data, and
// the provider publishes it under its analysis-ownership check.
//
// Rows are also the objects handed to commands and to the review identity, so their
// fields are a contract with those consumers, not just with the renderer.

/** @typedef {{ type: string, label: string, [key: string]: any }} TreeRow */
/** @typedef {{ uri: any, status: string|undefined, tooltip: string }} DecorationRequest */
/**
 * Maps a file and an optional offset to the row's resource URI. Supplied by the
 * provider, which knows whether the result is a PR preview.
 * @typedef {(file: string, pos: number|null) => any} ResourceUriOf
 */

const LEGEND = [
  ['file', 'Icon = file type', 'from your file-icon theme, on code rows and file rows alike'],
  ['symbol-method', 'impactTree.iconMode = "symbol"', 'switch code rows to method/function icons instead'],
  ['tag', 'Badge M / A / D / R', 'git status against the review base, not HEAD — hover for the word'],
  ['error', '⛔  a signature or throw change whose callers were NOT updated', 'review these first'],
  ['pass', '✓  signature or throw change, all callers updated', 'every caller found was changed on the call line'],
  ['circle-filled', '●  body-only change that reaches callers', 'the signature is the same, so callers still compile; their untouched call sites are expected'],
  ['circle-slash', '∅  body-only change, no callers found', 'in the code searched — dynamic calls and unloaded projects are not seen'],
  ['warning', '△  caller changed, but NOT on the call line', 'looks handled and is not'],
  ['circle-outline', '○  caller not changed at all', 'affected but untouched'],
  ['question', '?  callers unknown', 'the search failed or could not tell — e.g. passed as a value or DI-constructed; on a signature or throw change, review it'],
  ['beaker', '🧪  test that reaches this code', ''],
  ['issue-reopened', '↑  cycle — already shown higher up', ''],
];

// Three states, because "the symbol changed" and "the call was updated" are different
// questions. A caller edited just above and below the call line is the dangerous case:
// it looks handled and is not.
/** @type {Record<string, { token: string, text: string }>} */
const CALL_STATE = {
  'updated-at-call':   { token: '✓', text: 'call updated' },
  'changed-elsewhere': { token: '△', text: 'changed, but not at the call' },
  unchanged:           { token: '○', text: 'not changed' },
};

// What a caller row knows about its call sites when the view state cannot classify them.
const NO_SITE_EVIDENCE = { updated: [], untouched: [], unknown: [] };

// Rows that only group changes; their review state is derived from their members.
const GROUP_TYPES = new Set(['changeFile', 'insideGroup']);
/** @typedef {{ level: number, token: string, text: string, sentence: string }} Verdict */

// What the analysis could not say about a caller search, in words a reviewer can act on.
/** @type {Record<string, string>} */
const INCOMPLETE_REASON_TEXT = { 'referenced-as-value': 'passed around as a value, so the call sites cannot be followed' };

/**
 * Why a caller search could not list the callers, as a clause for a sentence.
 * @param {any} change
 * @returns {string}
 */
function describeUnknownCallers(change) {
  if (change.callerState === 'di') return 'it is built by a DI container, so its callers are not visible';
  const reason = change.callersIncompleteReason;
  if (INCOMPLETE_REASON_TEXT[reason]) return `it is ${INCOMPLETE_REASON_TEXT[reason]}`;
  return reason ? `the search reported "${reason}"` : 'the search did not say why';
}

/**
 * Whether the caller search answered: it found callers or finished and found none.
 * `unknown`, `di` and any state a result does not define are not answers.
 * @param {any} change
 * @returns {boolean}
 */
const callersKnown = (change) => change.callerState === 'resolved' || change.callerState === 'none';

/**
 * The verdict of a change that has a risky kind: level 0 when a caller was left alone,
 * 1 when the callers cannot be told, otherwise 2.
 * @param {any} change
 * @param {any[]} risky The non-body kinds.
 * @returns {Verdict}
 */
function classifyRiskyVerdict(change, risky) {
  const n = (change.callers ?? []).length;
  const stale = change.staleCallers;
  const what = `The ${risky.map((k) => k.label).join(', ')}`;
  // Results from before `callersComplete` existed have no such field and read as complete.
  const mayBeMissing = change.callersComplete === false;
  if (stale > 0) {
    const of = `${stale} of ${n} caller${n === 1 ? '' : 's'}`;
    const nearby = change.staleChangedElsewhere || 0;
    return { level: 0, token: '⛔', text: `${of} not updated${nearby ? ` (${nearby} edited nearby)` : ''}${mayBeMissing ? ' — more may be missing' : ''}`,
      sentence: `${what}, and ${of} ${stale === 1 ? 'was' : 'were'} not changed on the call line. Check that ${stale === 1 ? 'it still works' : 'they still work'}.${mayBeMissing ? ' More callers may be missing.' : ''}` };
  }
  if (mayBeMissing || !callersKnown(change)) {
    const found = change.callerState === 'resolved';
    return { level: 1, token: '?', text: change.callerState === 'di' ? 'DI-constructed' : 'callers unknown',
      sentence: `${what}, ${found ? 'and the callers found so far are updated, but more may be missing' : 'but its callers could not be found'}: ${describeUnknownCallers(change)}. Check its users by hand.` };
  }
  const none = change.callerState === 'none';
  return { level: 2, token: '✓', text: none ? 'no callers' : 'all callers updated',
    sentence: `${what}. ${none ? 'Nothing calls it in the code searched.' : 'Every caller was updated on the call line.'}` };
}

/**
 * The verdict of a change whose signature and throws did not change: level 3 when it
 * reaches callers or they are unknown, 4 when nothing calls it.
 * @param {any} change
 * @returns {Verdict}
 */
function classifyBodyOnlyVerdict(change) {
  const callers = change.callers ?? [];
  const n = callers.length;
  const mayBeMissing = change.callersComplete === false;
  // A finished search that found nothing is `none`; one that was cut short may have missed callers.
  if (!callersKnown(change) || (mayBeMissing && change.callerState === 'none')) {
    return { level: 3, token: '?', text: change.callerState === 'di' ? 'DI-constructed' : 'callers unknown',
      sentence: `Only the body changed. Its callers could not be found: ${describeUnknownCallers(change)}.` };
  }
  if (change.callerState === 'none') {
    return { level: 4, token: '∅', text: 'no callers', sentence: 'Only the body changed, and nothing calls it in the code searched.' };
  }
  const untouched = callers.filter((/** @type {any} */ c) => c.callState !== 'updated-at-call').length;
  return { level: 3, token: '●', text: `reaches ${n} caller${n === 1 ? '' : 's'}`,
    sentence: `Only the body changed: the signature is the same, so callers still compile. ${untouched} of ${n} caller${n === 1 ? '' : 's'} ${untouched === 1 ? 'is' : 'are'} unchanged, which is expected; check they still get the behaviour they rely on.${mayBeMissing ? ' More callers may be missing.' : ''}` };
}

/**
 * What a changed symbol's row leads with. Needs attention (level 0, `⛔`) means a risky
 * change met a caller that was not updated; a risky kind is any kind but `body`, because
 * a body-only edit leaves callers untouched as a matter of course. Levels: 0 breaks
 * callers, 1 risk unknown, 2 risk handled, 3 behaviour reaches callers, 4 quiet.
 * Lower is worse; the level orders rows and decides which groups start open.
 * @param {any} change A changed symbol from the result.
 * @returns {Verdict} `sentence` is the one-paragraph explanation for the detail panel.
 */
function classifyChangeVerdict(change) {
  const risky = change.kinds.filter((/** @type {any} */ k) => k.id !== 'body');
  return risky.length ? classifyRiskyVerdict(change, risky) : classifyBodyOnlyVerdict(change);
}

/**
 * The verdict of a deleted symbol: always level 1, because the analysis does not search a
 * deleted symbol's former callers and so cannot say that no one still uses it.
 * @returns {Verdict}
 */
const classifyDeletedVerdict = () => ({ level: 1, token: '−', text: 'deleted',
  sentence: 'This symbol was removed. Its former callers were not searched, so check that nothing still uses it, including dynamic users.' });

/**
 * The verdict of an "outside functions" row: always level 4, with its line ranges as text.
 * @param {Array<[number, number]>} ranges The changed line ranges outside every callable.
 * @returns {Verdict}
 */
const classifyOutsideVerdict = (ranges) => ({ level: 4, token: '≡', text: describeOutsideRanges(ranges),
  sentence: 'Changed lines that are not inside any function: imports, constants, type comments and top-level statements. They have no callers, so read them in the diff.' });

/**
 * The verdict of a change row, a deleted row or an outside row.
 * @param {TreeRow} row A row with a `finding`, or of type `deleted` or `outside`.
 * @returns {Verdict}
 */
const classifyRowVerdict = (row) => (row.finding ? classifyChangeVerdict(row.finding)
  : row.type === 'deleted' ? classifyDeletedVerdict() : classifyOutsideVerdict(row.ranges));

/**
 * A change row followed by every change nested inside it, at any depth.
 * @param {TreeRow} row
 * @returns {TreeRow[]}
 */
const collectRowAndNested = (row) => [row, ...(row.inside || []).flatMap(collectRowAndNested)];

/**
 * The worst verdict among `rows`; the first wins a tie.
 * @param {TreeRow[]} rows Non-empty list of change, deleted or outside rows.
 * @returns {Verdict}
 */
const classifyWorstRowVerdict = (rows) => rows.map(classifyRowVerdict).reduce((w, v) => (v.level < w.level ? v : w));

/**
 * The git status the result records for a repo-relative path, trying the path with
 * forward slashes when the exact key is absent.
 * @param {any} result
 * @param {string|null|undefined} relPath
 * @returns {string|undefined}
 */
function getFileStatus(result, relPath) {
  const table = result && result.fileStatus;
  if (!table || relPath == null) return undefined;
  if (table[relPath]) return table[relPath];
  const slash = String(relPath).replace(/\\/g, '/');
  return table[slash];
}

/**
 * "Untested" is only true inside the searched scope, so the note says how far it went.
 * @param {{ reachDepth?: number }} result
 * @returns {string}
 */
const buildReachScopeNote = (result) => `no test within ${result.reachDepth ? `${result.reachDepth} caller level(s)` : 'the searched caller levels'}`;

/**
 * The single row the view shows while there is no result to draw, or null when there is.
 * Never leaves the view looking idle while prerequisites are still resolving: a user
 * should not have to know that an index is warming.
 * @param {{ phase: string, busy: boolean, state: any }} view
 * @returns {TreeRow[]|null}
 */
function buildPlaceholderRows({ phase, busy, state }) {
  if (phase === 'starting' || phase === 'preparing') {
    return [{ type: 'message', label: 'Preparing…', icon: 'loading~spin',
      desc: 'indexing the workspace — this happens once per window' }];
  }
  if (phase === 'analysing' || busy) {
    return [{ type: 'message', label: 'Analysing…', icon: 'loading~spin',
      desc: 'resolving callers through the language server' }];
  }
  if (!state || (!state.result && !state.error)) {
    return [{ type: 'message', label: 'Ready — click to analyse', icon: 'play',
      desc: 'Impact Tree: Refresh', command: 'impactTree.refresh' }];
  }
  if (state.error) return [{ type: 'message', label: state.error, icon: 'error' }];
  return null;
}

// A changed symbol that calls another changed symbol appears only under it; otherwise
// every such symbol shows twice, once nested and once at top level.
/** @param {any} change */
const isRootChange = (change) => change.isRoot !== false;
/** @param {any} result */
const otherChangesOf = (result) => (result.allChanged || []).filter((/** @type {any} */ c) => !result.findings.includes(c));

/**
 * Stand-ins for the top-level change rows, enough for the review identity to name them,
 * so the summary can count what is left to review.
 * @param {any} result
 * @returns {TreeRow[]}
 */
const collectTopLevelChangeRefs = (result) => [
  ...(result.allChanged || []).filter(isRootChange)
    .map((/** @type {any} */ c) => ({ type: 'finding', file: c.file, pos: c.namePos })),
  // changed lines outside functions are reviewed like any other change
  ...(result.outside || []).map((/** @type {any} */ o) => ({ type: 'outside', file: o.file, relPath: o.relPath })),
];

/**
 * The summary row: counts, mode and base, and review progress when it is tracked.
 * @param {any} r The result.
 * @param {number|null} leftToReview Unreviewed top-level changes, or null without review.
 * @returns {TreeRow}
 */
function buildSummaryRow(r, leftToReview) {
  const stale = r.findings.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + f.staleCallers, 0);
  const changed = (r.allChanged || []).length;
  return {
    type: 'summary',
    label: `${changed} changed symbol${changed === 1 ? '' : 's'}`
      + (leftToReview === null ? '' : leftToReview === 0 ? '  ·  all reviewed' : `  ·  ${leftToReview} left to review`),
    desc: `${r.findings.length} finding(s)  ·  ${stale} call site(s) not updated  ·  ${r.mode}  ·  ${r.base.ref}`,
    tooltip: `mode '${r.mode}'${r.requestedMode && r.requestedMode !== r.mode ? ` (requested '${r.requestedMode}')` : ''}\nbase ${r.base.ref} @ ${String(r.base.sha).slice(0, 10)}\n${r.changedFileCount} analysed file(s), ${(r.otherFiles || []).length} not analysed`,
  };
}

/**
 * The section rows, in display order. Sections keep a body-only change visible without
 * competing with findings.
 * @param {any} r The result.
 * @returns {TreeRow[]}
 */
function buildSectionHeaderRows(r) {
  const findingRoots = r.findings.filter(isRootChange);
  const otherAll = otherChangesOf(r);
  const other = otherAll.filter(isRootChange);
  const nestedFindings = r.findings.length - findingRoots.length;
  const nestedOther = otherAll.length - other.length;
  /** @type {TreeRow[]} */
  const rows = [
    { type: 'section', key: 'findings', label: 'Findings', count: findingRoots.length, icon: 'warning',
      desc: `signature, throw or deletion risk${nestedFindings ? `  ·  ${nestedFindings} nested under its callee` : ''}` },
    { type: 'section', key: 'other', label: 'Other changes', count: other.length + (r.outside || []).length, icon: 'edit',
      desc: `body-only edits${nestedOther ? `  ·  ${nestedOther} nested under their callee` : ''}` },
    { type: 'section', key: 'deleted', label: 'Deleted', count: r.deleted.length, icon: 'trash', desc: '' },
  ];
  if (!r.tierA) {
    rows.push({ type: 'section', key: 'untested', label: 'No test reaches',
      count: r.testReachComputed ? r.untested.length : 0, icon: 'beaker',
      computed: r.testReachComputed,
      desc: r.testReachComputed ? buildReachScopeNote(r) : 'not computed — expand to run' });
    // Kept apart from the section above, which only holds symbols the walk proved
    // untested: a walk that failed or was cut short proves nothing either way.
    const unknownReach = r.testReachComputed ? (r.testUnknown || []) : [];
    if (unknownReach.length) {
      rows.push({ type: 'section', key: 'testUnknown', label: 'Test reach unknown',
        count: unknownReach.length, icon: 'question',
        desc: 'the search failed or stopped early — not the same as untested' });
    }
  }
  rows.push({ type: 'section', key: 'files', label: 'Files without a call graph', count: (r.otherFiles || []).length,
    icon: 'files', desc: 'migrations, config, docs' });
  return rows;
}

/**
 * The top level of a tree with a result: summary, preview notice, warnings, sections
 * and the legend.
 * @param {any} r The result.
 * @param {{ leftToReview: number|null }} progress
 * @returns {TreeRow[]}
 */
function buildRootRows(r, { leftToReview }) {
  /** @type {TreeRow[]} */
  const rows = [buildSummaryRow(r, leftToReview)];
  // Tier A cannot see a caller in a file the PR does not touch. Presenting a truncated
  // tree as if it were complete is the one failure mode that would make this feature
  // worse than useless, so it is stated on the face of it.
  if (r.tierA) {
    rows.push({
      type: 'message', icon: 'eye',
      label: `Preview — PR files only (${r.changedFileCount} file(s))`,
      desc: 'callers outside this PR are NOT shown  ·  check out for full impact',
      tooltip: 'Built from the pull request\'s own files via the GitHub API.\n'
        + 'Your worktree was not touched.\n\n'
        + 'Any caller living in a file this PR does not change is invisible here.\n'
        + 'Use "Check out and analyse" on the PR for the complete tree.',
    });
  }
  for (const w of r.warnings) rows.push({ type: 'message', label: w, icon: 'warning' });
  for (const u of r.unanalysable) {
    rows.push({ type: 'message', icon: 'circle-slash',
      label: `${u.count} file(s) in '${u.component}' not analysed`, desc: 'see analysis warning' });
  }
  rows.push(...buildSectionHeaderRows(r));
  rows.push({ type: 'legend', label: 'Legend' });
  return rows;
}

/**
 * One row per changed symbol, with the decoration each should carry. `ambiguous` marks a
 * label that more than one changed symbol shares, so the row can name its component.
 * @param {any[]} changes Changed symbols, in display order.
 * @param {{ result: any, uriOf: ResourceUriOf, reachReasonOf?: (change: any) => string|null, scopeNote?: string|null }} opts
 *   `reachReasonOf` gives a row's test-reach-unknown reason; `scopeNote` is shown on every row.
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }}
 */
function buildChangeRows(changes, { result, uriOf, reachReasonOf = () => null, scopeNote = null }) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const c of result.allChanged || []) seen.set(c.label, (seen.get(c.label) || 0) + 1);
  /** @type {DecorationRequest[]} */
  const decorations = [];
  const rows = changes.map((c) => {
    const uri = uriOf(c.file, c.namePos);
    decorations.push({ uri, status: getFileStatus(result, c.relPath), tooltip: `${c.relPath}:${c.startLine}` });
    return {
      type: 'finding', label: c.label, finding: c, file: c.file, pos: c.namePos, score: c.score,
      ambiguous: (seen.get(c.label) || 0) > 1, decorationUri: uri, reachReason: reachReasonOf(c), scopeNote,
    };
  });
  return { rows, decorations };
}

/**
 * The changed lines of an "Outside functions" row in words: `lines 1–4, 22`, and for a pure
 * deletion, the gap marker `N - 0.5`, `deleted before line N`.
 * Every range is named: the row is the only place these lines are listed, so none is
 * summarised away.
 * @param {Array<[number, number]>} ranges
 * @returns {string}
 */
function describeOutsideRanges(ranges) {
  const lines = ranges.filter(([lo]) => Number.isInteger(lo)).map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`));
  const deletions = ranges.filter(([lo]) => !Number.isInteger(lo)).map(([lo]) => `deleted before line ${Math.ceil(lo)}`);
  const noun = lines.length === 1 && !lines[0].includes('–') ? 'line' : 'lines';
  return [...(lines.length ? [`${noun} ${lines.join(', ')}`] : []), ...deletions].join(', ');
}

/**
 * One "Outside functions" row per file whose changed lines include some outside every
 * callable, with the decoration it should carry. It has no callers and no expansion.
 * @param {any[]} outside `result.outside`.
 * @param {{ result: any, uriOf: ResourceUriOf }} opts
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }}
 */
function buildOutsideRows(outside, { result, uriOf }) {
  /** @type {DecorationRequest[]} */
  const decorations = [];
  const rows = outside.map((o) => {
    const uri = uriOf(o.file, null);
    const status = getFileStatus(result, o.relPath);
    decorations.push({ uri, status, tooltip: o.relPath });
    return {
      type: 'outside', label: 'Outside functions', file: o.file, relPath: o.relPath, ranges: o.ranges,
      status, desc: describeOutsideRanges(o.ranges), inGroup: false, decorationUri: uri,
    };
  });
  return { rows, decorations };
}

/**
 * Rows for symbols deleted by the change.
 * @param {any[]} deleted
 * @param {{ result: any, uriOf: ResourceUriOf }} opts
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }}
 */
function buildDeletedRows(deleted, { result, uriOf }) {
  /** @type {DecorationRequest[]} */
  const decorations = [];
  const rows = deleted.map((d) => {
    const uri = uriOf(d.file, d.namePos);
    decorations.push({ uri, status: getFileStatus(result, d.relPath) || 'deleted', tooltip: `${d.label} deleted` });
    return { type: 'deleted', label: d.label, key: d.key, relPath: d.relPath, file: d.file, decorationUri: uri };
  });
  return { rows, decorations };
}

/**
 * One row per changed file that has no call graph, sorted by path. A row has a resource
 * URI, and so a decoration, only when the path can be made absolute.
 * @param {Array<{ path: string, status: string }>} files
 * @param {{ absPath?: ((relPath: string) => string)|null, uriOf: ResourceUriOf }} opts
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }}
 */
function buildFileLeafRows(files, { absPath, uriOf }) {
  /** @type {DecorationRequest[]} */
  const decorations = [];
  const rows = files.map((f) => {
    const abs = absPath ? absPath(f.path) : null;
    const uri = abs ? uriOf(abs, null) : null;
    if (uri) decorations.push({ uri, status: f.status, tooltip: f.path });
    return {
      type: 'file', label: path.basename(f.path), relPath: f.path, status: f.status,
      absPath: abs, decorationUri: uri,
    };
  }).sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { rows, decorations };
}

/** @returns {TreeRow} The row that runs the deferred test-reach walk when clicked. */
const buildComputeTestReachRow = () => ({ type: 'message', label: 'Compute test reachability', icon: 'play',
  desc: 'extra caller queries — run on demand', command: 'impactTree.computeTestReach' });

/** @returns {TreeRow[]} One row per legend entry. */
const buildLegendRows = () => LEGEND.map(([icon, label, desc]) => ({ type: 'legendItem', icon, label, desc }));

/**
 * The callers a review shows: those in paths the review excludes (untracked files in a
 * committed review) are dropped. Without a path mapping nothing is dropped.
 * @param {any[]} callers
 * @param {string[]|undefined} excludedPaths Repo-relative paths.
 * @param {((file: string) => string)|null|undefined} rel
 * @returns {any[]}
 */
function dropExcludedCallers(callers, excludedPaths, rel) {
  const excluded = new Set(excludedPaths || []);
  if (!excluded.size || !rel) return callers;
  return callers.filter((c) => !excluded.has(rel(c.file)));
}

/**
 * The positions on the way from the top of the tree to an expanded row's callers,
 * including the row itself, as `file#pos`; a caller already on it is a cycle.
 * @param {TreeRow} row
 * @returns {string[]}
 */
function collectAncestry(row) {
  const seen = new Set(row.path || []);
  seen.add(`${row.file}#${row.pos}`);
  return [...seen];
}

/**
 * One row per caller of an expanded row, sorted by path then label, with their
 * decorations. Call-site evidence is supplied: classifying it can read the disk.
 * @param {Array<{ caller: any, callSiteUpdates: { updated: object[], untouched: object[], unknown: object[] } }>} classified
 * @param {{
 *   ancestry: string[], reviewParent: string|null, changedKeys: Set<string>,
 *   rel: ((file: string) => string)|null, result: any, uriOf: ResourceUriOf,
 * }} opts `rel` is null when there is no view state; the file is then its own path.
 * @returns {{ rows: TreeRow[], decorations: DecorationRequest[] }}
 */
function buildCallerRows(classified, { ancestry, reviewParent, changedKeys, rel, result, uriOf }) {
  /** @type {DecorationRequest[]} */
  const decorations = [];
  const rows = classified.map(({ caller: c, callSiteUpdates }) => {
    const symChanged = changedKeys.has(`${c.file}#${c.pos}`);
    const callState = classifyCallerUpdateState({ callSiteUpdates, callerChanged: symChanged });
    const relPath = rel ? rel(c.file) : c.file;
    const uri = uriOf(c.file, c.pos);
    decorations.push({ uri, status: getFileStatus(result, relPath), tooltip: relPath });
    return {
      type: 'caller', reviewParent, label: c.label, file: c.file, pos: c.pos, test: c.test,
      callSites: c.callSites || [], sites: c.sites,
      relPath, changed: symChanged, callState, callSiteUpdates, decorationUri: uri,
      cycle: ancestry.includes(`${c.file}#${c.pos}`),
      path: [...ancestry],
    };
  });
  rows.sort((a, b) => (a.relPath || '').localeCompare(b.relPath || '') || a.label.localeCompare(b.label));
  return { rows, decorations };
}

/**
 * The row closing a caller list whose query failed or did not finish: such a list must
 * not look like a symbol nobody calls.
 * @param {string} reason Why the list is incomplete.
 * @param {boolean} hasCallers Whether any caller rows precede it.
 * @returns {TreeRow}
 */
const buildIncompleteCallersRow = (reason, hasCallers) => ({
  type: 'message', icon: 'warning',
  label: hasCallers ? 'More callers may be missing' : 'Callers could not be loaded',
  desc: 'refresh to retry', tooltip: reason,
});

/**
 * The row holding the changes declared inside a change row. They are not its callers,
 * so they sit in their own row rather than among the rows that call it.
 * @param {TreeRow} row A change row with a non-empty `inside`.
 * @returns {TreeRow}
 */
const buildInsideGroupRow = (row) => ({
  type: 'insideGroup', label: 'Changed inside', container: row.finding.label,
  file: row.file, relPath: row.finding.relPath, rows: row.inside, members: row.inside.flatMap(collectRowAndNested),
});

module.exports = {
  LEGEND, CALL_STATE, NO_SITE_EVIDENCE, GROUP_TYPES,
  classifyChangeVerdict, classifyDeletedVerdict, classifyOutsideVerdict, classifyRowVerdict, classifyWorstRowVerdict, collectRowAndNested, getFileStatus,
  buildReachScopeNote, buildPlaceholderRows, collectTopLevelChangeRefs, buildRootRows,
  isRootChange, otherChangesOf, buildChangeRows, buildDeletedRows, buildFileLeafRows, buildOutsideRows, describeOutsideRanges,
  buildComputeTestReachRow, buildLegendRows, dropExcludedCallers, collectAncestry, buildCallerRows,
  buildIncompleteCallersRow, buildInsideGroupRow,
};
