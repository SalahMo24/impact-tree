// @ts-check
'use strict';
const { nodeId } = require('./review-state');
const { prQuery } = require('./pr-documents');
const models = require('./tree-row-models');
const reviewTree = require('./review-tree-model');
const { groupCallerRowsByFile } = require('./tree-grouping');
const { renderTreeItem } = require('./tree-item-renderer');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/** @typedef {import('./tree-row-models').DecorationRequest} DecorationRequest */
/** @typedef {import('./engine/caller-contract').CallerRow} CallerRow */
/**
 * The session state the provider reads; null before the first analysis. `source` is what
 * is being reviewed (a local mode, a PR preview or a checked-out PR).
 * @typedef {{
 *   result: any, rowDetail?: string, iconMode?: string, source?: { kind: string, pr?: { number: number } },
 *   rel: (file: string) => string, absPath?: ((relPath: string) => string)|null,
 *   classifyCallSiteUpdates?: (file: string, callSites: Array<{ start: number, end: number }>) => { updated: object[], untouched: object[], unknown: object[] },
 *   changedKeys?: Set<string>,
 * }} ProviderState
 */
/**
 * What the provider needs of a caller resolver. `incomingWithStatus` is optional: a
 * resolver without it cannot say whether its search finished.
 * @typedef {{
 *   incoming: (file: string, pos: number, withTests?: boolean) => Promise<CallerRow[]>,
 *   incomingWithStatus?: (file: string, pos: number, withTests?: boolean) => Promise<import('./engine/caller-contract').CallerAnswer>,
 * }} CallerResolver
 */

/**
 * Review progress is separate from analysis/filter invalidation. IDs include changed
 * counting rows and their file parents; filePaths includes only changed functions.
 * @typedef {{ readonly analysisId: number, readonly changedIds: readonly string[], readonly filePaths: readonly string[] }} ReviewProgress
 */

// The view is file first: one row per changed file, worst first, holding that file's
// changes; under a change, its callers and what is known of its tests. A caller row
// resolves its own callers on expand. That laziness is the whole reason the extension
// is cheap where the CLI is not: the CLI pre-walked 152 positions (123s); a reviewer
// expands maybe a dozen.
//
// The provider owns what has a lifetime: reading the view state, scheduling caller
// queries, checking that their answers still belong to the current analysis, and
// publishing decorations. Rows are built by pure functions (review-tree-model,
// tree-row-models, tree-grouping) and rendered by tree-item-renderer.

// `getAnalysisId` and `isCurrentAnalysis` come from the session: rows and decorations
// belong to the analysis that was current when they were requested. Without a session
// every request is current.
//
// Longer than the 70-line review trigger only because it is a factory: its length is
// the closures it defines over the injected dependencies, each well under 30 lines.
/**
 * @param {any} vscode
 * @param {{
 *   getState: () => ProviderState|null, resolver: CallerResolver, isBusy?: () => boolean,
 *   decorate?: ReturnType<typeof import('./decorations').createDecorationProvider>|null,
 *   getPhase?: () => string,
 *   review?: ReturnType<typeof import('./review-state').createReviewState>|null,
 *   getAnalysisId?: () => number, isCurrentAnalysis?: (analysisId: number) => boolean,
 * }} deps
 */
function createTreeProvider(vscode, {
  getState, resolver, isBusy = () => false, decorate = null, getPhase = () => 'ready', review = null,
  getAnalysisId = () => 0, isCurrentAnalysis = () => true,
}) {
  /** @param {TreeRow} n */
  const idOf = (n) => review?.id ? review.id(n) : nodeId(n);
  // The review ids a row's checkbox stands for; none for a row without a checkbox.
  /** @param {TreeRow} n @returns {string[]} */
  const tickIdsOf = (n) => /** @type {string[]} */ (reviewTree.collectTickTargets(n).map(idOf).filter(Boolean));
  // A file's checkbox is reviewed exactly when all its rows are, so unticking one change
  // inside it unticks the file too.
  /** @param {TreeRow} n */
  const checkedOf = (n) => {
    if (!review) return null;
    const ids = tickIdsOf(n);
    return ids.length ? review.remaining(ids) === 0 : null;
  };
  // Read at render time, so a settings change shows on the next refresh.
  const viewOf = () => {
    const st = getState();
    return {
      rowDetail: (st && st.rowDetail) || 'hover',
      iconMode: (st && st.iconMode) || 'symbol',
      checkedOf,
    };
  };
  // file:///path#offset — unique per symbol so decorations do not collide, while the
  // icon theme still matches on the extension.
  // Tier A must NOT use a file:// URI. The editor's git decoration provider keys on
  // those and paints the worktree status (U for untracked, M for a local edit) on
  // top of the PR status. A non-file scheme is invisible to git, so the only badge
  // is the one we register from the pull request.
  /**
   * @param {string} file
   * @param {number|string|null} pos An offset, or a name for a row that has none (`outside`).
   */
  const uriFor = (file, pos) => {
    if (!file) return null;
    const st = getState();
    let u;
    if (st && st.result && st.result.tierA && st.rel) {
      const rel = String(st.rel(file) || file).replace(/\\/g, '/').replace(/^\/+/, '');
      // An identity for the row's icon and badge; no command opens it, so it does not
      // need the file's old path or status that a tab's address carries.
      u = vscode.Uri.from({ scheme: 'impacttree-pr', path: `/${rel}`, query: prQuery(st.result, 'head') });
    } else {
      u = vscode.Uri.file(file);
    }
    return pos == null ? u : u.with({ fragment: String(pos) });
  };
  // Registers a row's decoration only while the analysis it was built for is current.
  /**
   * @param {number} analysisId
   * @param {any} uri
   * @param {string|undefined} status
   * @param {string} tooltip
   * @param {boolean} [tint] False for the badge without the label colour.
   */
  const mark = (analysisId, uri, status, tooltip, tint = true) => {
    if (decorate && uri && isCurrentAnalysis(analysisId)) decorate.register(uri, { status, tooltip, tint });
    return uri;
  };
  /**
   * @param {number} analysisId
   * @param {DecorationRequest[]} requests
   */
  const publishDecorations = (analysisId, requests) => {
    for (const d of requests) mark(analysisId, d.uri, d.status, d.tooltip, d.tint);
  };
  let disposed = false;
  // One provider-owned timer batches all row reads in this event-loop turn. Disposal
  // cancels it; the decoration provider filters unchanged values and scopes the event.
  /** @type {NodeJS.Timeout|null} */
  let decorationTimer = null;
  const scheduleDecorationFlush = () => {
    if (disposed || !decorate || decorationTimer !== null) return;
    decorationTimer = setTimeout(() => { decorationTimer = null; decorate.flush(); }, 0);
  };
  const _emitter = new vscode.EventEmitter();
  const presentation = new vscode.EventEmitter();
  const progress = new vscode.EventEmitter();
  // The filter the reviewer chose. Held for the window only: it is not persisted, so a new
  // window opens on everything.
  /** @type {import('./review-tree-model').ReviewFilter} */
  let filter = 'all';
  /** @param {TreeRow} row */
  const isReviewed = (row) => checkedOf(row) === true;

  // Cache: the file rows built from the shown result, and the parent of every row handed
  // out under them. Owner: this provider. Key: the analysis id and the result object; a
  // build depends on nothing else, because ticks are read at render time through
  // `checkedOf`. Invalidation: replaced by the next read after either part of the key
  // changes, so until then it holds the previous result; the parents are a WeakMap, so
  // a row nobody holds anymore is not kept. Disposal: garbage with the provider; the rows
  // hold no resource, and their decorations belong to the decoration provider. Rows
  // handed to consumers are borrowed: only this provider may change their UI metadata.
  /** @type {{ analysisId: number, result: any, rows: TreeRow[], decorations: DecorationRequest[], parents: WeakMap<TreeRow, TreeRow>, childIds: WeakMap<TreeRow, string> }|null} */
  let built = null;
  /**
   * The file rows of the shown result, built once per analysis and result.
   * @param {ProviderState} state
   */
  function builtFor(state) {
    const analysisId = getAnalysisId();
    if (built && built.analysisId === analysisId && built.result === state.result) return built;
    const made = reviewTree.buildFileRows(state.result, { uriOf: uriFor, absPath: state.absPath });
    const parents = new WeakMap();
    for (const file of made.rows) for (const row of file.rows || []) parents.set(row, file);
    built = { analysisId, result: state.result, rows: made.rows, decorations: made.decorations, parents, childIds: new WeakMap() };
    return built;
  }
  // The state of a review that is shown, or null while a placeholder row or nothing is.
  const shownState = () => {
    const state = getState();
    return !state || !state.result || models.buildPlaceholderRows({ phase: getPhase(), busy: isBusy(), state }) ? null : state;
  };
  /**
   * Remembers where rows came from, so `getParent` can answer for rows built on demand.
   * @param {TreeRow} parent
   * @param {TreeRow[]} children
   * @returns {TreeRow[]} `children`.
   */
  const adopt = (parent, children) => {
    const parentId = reviewTree.treeItemId(parent) || built?.childIds.get(parent);
    for (const [index, child] of children.entries()) {
      built?.parents.set(child, parent);
      // Caller/message identities are scoped to their parent: the same caller can
      // occur under several changes. Position and sibling index distinguish repeats.
      if (parentId && !reviewTree.treeItemId(child)) {
        const key = JSON.stringify([child.type, child.file || child.relPath || '', child.pos ?? null, index]);
        built?.childIds.set(child, `${parentId}/child:${key}`);
      }
    }
    return children;
  };

  /**
   * @param {ProviderState|null} state
   * @param {number} analysisId
   */
  function rootRows(state, analysisId) {
    const placeholder = models.buildPlaceholderRows({ phase: getPhase(), busy: isBusy(), state });
    if (placeholder) return placeholder;
    // A missing state got the placeholder above.
    const st = /** @type {ProviderState} */ (state);
    const made = builtFor(st);
    scheduleDecorationFlush();
    publishDecorations(analysisId, made.decorations);
    const kept = reviewTree.filterFileRows(made.rows, filter, isReviewed).map((e) => e.file);
    // Only the worst file starts open, so the first thing on screen is the thing to look at.
    // These rows are provider-owned. Keep the canonical objects so getParent,
    // actions and subsequent reads all refer to the same file, including the first.
    const files = kept;
    for (const [index, file] of files.entries()) file.expanded = index === 0 && file.type === 'reviewFile';
    const notices = models.buildNoticeRows(st.result);
    if (filter !== 'all' && files.length === 0) return [...notices, reviewTree.buildEmptyFilterRow(filter)];
    return [...notices, ...files];
  }

  /**
   * The rows of a file that the filter shows.
   * @param {TreeRow} file
   * @returns {TreeRow[]}
   */
  const visibleRows = (file) => reviewTree.filterFileRows([file], filter, isReviewed).flatMap((e) => e.rows);
  // The children of an open file: its visible rows and the gap after them, or nothing
  // when the filter hides every row.
  /** @param {TreeRow} file @returns {TreeRow[]} */
  const fileChildren = (file) => {
    const rows = visibleRows(file);
    return rows.length ? [...rows, reviewTree.buildSpacerRow(file)] : rows;
  };

  // The callers and tests row under a change, from the result: no query.
  /**
   * @param {TreeRow} node A change row.
   * @param {number} analysisId
   */
  function impactRows(node, analysisId) {
    const state = getState();
    if (!state || !state.result) return [];
    const built = reviewTree.buildImpactRows(node, { result: state.result, uriOf: uriFor, rel: state.rel ? (f) => state.rel(f) : null });
    scheduleDecorationFlush();
    publishDecorations(analysisId, built.decorations);
    return built.rows;
  }

  // Asks the resolver for a row's callers. A query that failed or did not finish must
  // not look like a symbol nobody calls, so the answer says why it is incomplete.
  /** @param {TreeRow} node */
  async function queryCallers(node) {
    try {
      if (resolver.incomingWithStatus) {
        const answer = await resolver.incomingWithStatus(node.file, node.pos, true);
        return { callers: answer.callers, incomplete: answer.complete ? null : answer.reason || 'the caller query did not complete' };
      }
      const callers = await resolver.incoming(node.file, node.pos, true);
      return { callers, incomplete: 'this resolver does not report whether its caller search finished' };
    } catch (e) {
      // A rejection can be any value; one without a message gets the default text.
      const failure = /** @type {{ message?: string }|null|undefined} */ (e);
      return { callers: [], incomplete: (failure && failure.message) || 'the caller query failed' };
    }
  }

  // A caller row's own callers, queried when it is expanded. Callers are not reviewed,
  // so they carry no review parent.
  /**
   * @param {TreeRow} node A caller row.
   * @param {number} analysisId
   */
  async function callerRows(node, analysisId) {
    const state = getState();
    const answer = await queryCallers(node);
    // A newer analysis replaced the result while the query ran, so these callers belong
    // to a result no longer shown. The language server cannot cancel the query; it has
    // finished by now, and only its answer is dropped.
    if (!isCurrentAnalysis(analysisId)) return [];
    // The analysis already left untracked files out of the result's callers; the
    // resolver answering here does not, so they are dropped from its answer.
    const callers = models.dropExcludedCallers(answer.callers, state?.result?.excludedCallerPaths, state?.rel ? (f) => state.rel(f) : null);
    scheduleDecorationFlush();
    // Classifying call sites reads line positions from disk, so it happens here.
    const classified = callers.map((c) => ({
      caller: c,
      callSiteUpdates: state && state.classifyCallSiteUpdates
        ? state.classifyCallSiteUpdates(c.file, c.callSites) : models.NO_SITE_EVIDENCE,
    }));
    const ancestry = models.collectAncestry(node);
    const built = models.buildCallerRows(classified, {
      ancestry, reviewParent: null, changedKeys: (state && state.changedKeys) || new Set(),
      rel: state ? (f) => state.rel(f) : null, result: state && state.result, uriOf: uriFor,
    });
    publishDecorations(analysisId, built.decorations);
    const grouped = groupCallerRowsByFile(built.rows, { reviewParent: null, ancestry, uriOf: uriFor });
    if (answer.incomplete) grouped.push(models.buildIncompleteCallersRow(answer.incomplete, grouped.length > 0));
    return grouped;
  }

  /**
   * Full presentation invalidation, reserved for analysis, phase and filter changes.
   * @param {'analysis'|'filter'} [reason]
   */
  function refresh(reason = 'analysis') {
    if (disposed) return;
    _emitter.fire();
    presentation.fire({ reason });
  }

  /**
   * Applies one checkbox gesture against canonical rows of the shown result. Work and
   * temporary maps are bounded by its materialized counting rows. Old analysis rows
   * and no-op marks publish nothing. The batch persists at most once per boolean value.
   * @param {Array<{ row: TreeRow, on: boolean }>} changes
   */
  function setCheckedBatch(changes) {
    const state = shownState();
    if (disposed || !state || !review) return;
    const current = builtFor(state);
    const rootsBefore = reviewTree.filterFileRows(current.rows, filter, isReviewed).map((e) => e.file);
    const canonical = new Set(current.rows.flatMap((file) => [file, ...(file.rows || [])]));
    /** @type {Map<TreeRow, boolean>} */
    const requested = new Map();
    for (const { row, on } of changes) {
      if (!canonical.has(row)) continue;
      for (const target of reviewTree.collectTickTargets(row)) requested.set(target, on);
    }
    const changed = [...requested].filter(([row, on]) => idOf(row) && isReviewed(row) !== on);
    if (!changed.length) return;
    for (const on of [true, false]) {
      const ids = changed.filter((entry) => entry[1] === on).map(([row]) => idOf(row)).filter(Boolean);
      if (ids.length) review.setAll(ids, on);
    }
    const files = new Set(changed.map(([row]) => current.parents.get(row) || row));
    const ids = [...new Set([...changed.map(([row]) => row), ...files].map(reviewTree.treeItemId).filter(Boolean))];
    /** @type {ReviewProgress} */
    const event = Object.freeze({ analysisId: current.analysisId, changedIds: Object.freeze(/** @type {string[]} */ (ids)),
      filePaths: Object.freeze([...new Set(changed.filter(([row]) => row.type === 'finding').map(([row]) => row.finding.relPath))]) });
    progress.fire(event);
    if (disposed || !isCurrentAnalysis(current.analysisId) || getState()?.result !== current.result) return;
    const rootsAfter = reviewTree.filterFileRows(current.rows, filter, isReviewed).map((e) => e.file);
    if (rootsBefore.length !== rootsAfter.length || rootsBefore.some((row, i) => row !== rootsAfter[i])) {
      _emitter.fire(); // A file appeared/disappeared, including the empty-filter hint.
      return;
    }
    for (const file of files) if (rootsAfter.includes(file)) _emitter.fire(file);
  }

  return {
    onDidChangeTreeData: _emitter.event,
    onDidChangePresentation: presentation.event,
    onDidChangeReview: progress.event,
    refresh,
    dispose() {
      disposed = true;
      if (decorationTimer !== null) clearTimeout(decorationTimer);
      decorationTimer = null;
      built = null;
      _emitter.dispose(); presentation.dispose(); progress.dispose();
    },
    /** @param {TreeRow} n */
    getTreeItem(n) {
      const item = renderTreeItem(vscode, n, viewOf());
      const id = reviewTree.treeItemId(n) || built?.childIds.get(n);
      if (id) item.id = id;
      return item;
    },
    /**
     * The row a row sits under, for the rows this provider handed out; undefined for a file
     * row, and for a row of an analysis that is no longer shown.
     * @param {TreeRow} n
     * @returns {TreeRow|undefined}
     */
    getParent: (n) => built?.parents.get(n),
    /** @param {TreeRow} [node] */
    async getChildren(node) {
      const analysisId = getAnalysisId();
      if (disposed) return [];
      if (!node) return rootRows(getState(), analysisId);
      switch (node.type) {
        case 'reviewFile': return adopt(node, fileChildren(node));
        case 'finding': return adopt(node, impactRows(node, analysisId));
        case 'caller': return node.cycle ? [] : adopt(node, await callerRows(node, analysisId));
        case 'callerFile': return adopt(node, node.callers);
        // a file without a call graph, a deleted symbol, outside lines and messages
        default: return [];
      }
    },
    /** @param {TreeRow} row @param {boolean} on */
    setChecked(row, on) { setCheckedBatch([{ row, on }]); },
    setCheckedBatch,
    clearReviewed() {
      if (disposed) return;
      const state = shownState();
      if (state) setCheckedBatch(reviewTree.collectCountingRows(builtFor(state).rows).map((row) => ({ row, on: false })));
      // Also discard stored identities for content no longer in the displayed result.
      review?.clear();
    },
    /**
     * The view's message and badge for what the tree shows: none while a placeholder row
     * is shown or there is no result, else `buildReviewSummary` with the current ticks.
     * @returns {{ message: string|undefined, badge: { value: number, tooltip: string }|undefined }}
     */
    summarize() {
      const state = shownState();
      if (!state) return { message: undefined, badge: undefined };
      const counts = reviewTree.countReview(builtFor(state).rows, isReviewed);
      return reviewTree.buildReviewSummary(state.result, state.source, counts, filter);
    },
    /**
     * How far the shown review has got.
     * @returns {{ total: number, left: number, attention: number }|null} Null when no review is shown.
     */
    reviewCounts() {
      const state = shownState();
      return state ? reviewTree.countReview(builtFor(state).rows, isReviewed) : null;
    },
    /**
     * The analysis that owns actions drawn for the shown review. Stable across ticks and
     * filters; null while no result is shown. A later analysis invalidates old actions.
     * @returns {number|null}
     */
    reviewVersion: () => (shownState() ? getAnalysisId() : null),
    /** @returns {import('./review-tree-model').ReviewFilter} */
    getFilter: () => filter,
    /**
     * Turns a filter on, turning the other off, or returns to all when it was on, and
     * repaints the view.
     * @param {'attention'|'unreviewed'} name
     * @returns {void}
     */
    toggleFilter(name) {
      filter = reviewTree.toggleFilter(filter, name);
      refresh('filter');
    },
    /**
     * The first unreviewed row after `after` in the order the view shows, under the active
     * filter; see `findNextUnreviewed`.
     * @param {TreeRow|null} after A counting row or a file row, or null to start at the top.
     * @returns {TreeRow|null} Null when no review is shown or nothing is left.
     */
    nextUnreviewed(after) {
      const state = shownState();
      return state ? reviewTree.findNextUnreviewed(builtFor(state).rows, { after, isReviewed, filter }) : null;
    },
    /**
     * Whether a counting row is ticked.
     * @param {TreeRow} row
     * @returns {boolean}
     */
    isReviewed,
    /**
     * The file row or counting row of the shown review with this tree id (`treeItemId`),
     * whether or not the filter shows it.
     * @param {string} id
     * @returns {TreeRow|null} Null when no review is shown or no row has the id.
     */
    rowById(id) {
      const state = shownState();
      if (!state) return null;
      const rows = builtFor(state).rows.flatMap((f) => [f, ...(f.rows || [])]);
      return rows.find((r) => reviewTree.treeItemId(r) === id) || null;
    },
    /**
     * The row of the shown review for a line of a file's head side; see `findRowAtLine`.
     * @param {string} relPath Repo-relative path.
     * @param {number} line 1-based head-side line.
     * @returns {TreeRow|null} Null when no review is shown or the file is not in it.
     */
    rowAtLine(relPath, line) {
      const state = shownState();
      return state ? reviewTree.findRowAtLine(builtFor(state).rows, relPath, line) : null;
    },
    /**
     * The rows of a changed file in the shown review: its changes, deleted symbols and
     * outside-functions row, in the order the tree shows them.
     * @param {string} relPath Repo-relative path.
     * @returns {TreeRow[]} Empty when no review is shown, or the file is not in it or has no call graph.
     */
    changeRowsOf(relPath) {
      const state = shownState();
      const file = state && builtFor(state).rows.find((f) => f.relPath === relPath);
      return file && file.type === 'reviewFile' ? file.rows : [];
    },
    /**
     * The callers and tests row under a change row, as the tree shows them when it is expanded.
     * @param {TreeRow} row A change row.
     * @returns {TreeRow[]} Empty when no review is shown.
     */
    impactRowsOf: (row) => (shownState() ? impactRows(row, getAnalysisId()) : []),
  };
}
module.exports = { createTreeProvider, LEGEND: models.LEGEND };
