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
      iconMode: (st && st.iconMode) || 'file',
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
   * @param {number|null} pos
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
   */
  const mark = (analysisId, uri, status, tooltip) => {
    if (decorate && uri && isCurrentAnalysis(analysisId)) decorate.register(uri, { status, tooltip });
    return uri;
  };
  /**
   * @param {number} analysisId
   * @param {DecorationRequest[]} requests
   */
  const publishDecorations = (analysisId, requests) => {
    for (const d of requests) mark(analysisId, d.uri, d.status, d.tooltip);
  };
  const scheduleDecorationFlush = () => {
    if (decorate) setTimeout(() => decorate.flush(), 0);
  };
  const _emitter = new vscode.EventEmitter();

  /** @param {ProviderState} state */
  const buildFiles = (state) => reviewTree.buildFileRows(state.result, { uriOf: uriFor, absPath: state.absPath });

  /**
   * @param {ProviderState|null} state
   * @param {number} analysisId
   */
  function rootRows(state, analysisId) {
    const placeholder = models.buildPlaceholderRows({ phase: getPhase(), busy: isBusy(), state });
    if (placeholder) return placeholder;
    // A missing state got the placeholder above.
    const st = /** @type {ProviderState} */ (state);
    const built = buildFiles(st);
    scheduleDecorationFlush();
    publishDecorations(analysisId, built.decorations);
    // Only the worst file starts open, so the first thing on screen is the thing to look at.
    const files = built.rows.map((r, i) => (i === 0 && r.type === 'reviewFile' ? { ...r, expanded: true } : r));
    return [...models.buildNoticeRows(st.result), ...files];
  }

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

  return {
    onDidChangeTreeData: _emitter.event,
    refresh() { _emitter.fire(); },
    /** @param {TreeRow} n */
    getTreeItem: (n) => renderTreeItem(vscode, n, viewOf()),
    /** @param {TreeRow} [node] */
    async getChildren(node) {
      const analysisId = getAnalysisId();
      if (!node) return rootRows(getState(), analysisId);
      switch (node.type) {
        case 'reviewFile': return node.rows;
        case 'finding': return impactRows(node, analysisId);
        case 'caller': return node.cycle ? [] : callerRows(node, analysisId);
        case 'callerFile': return node.callers;
        // a file without a call graph, a deleted symbol, outside lines and messages
        default: return [];
      }
    },
    /**
     * Ticks or unticks what a row's checkbox stands for: a file's rows, or the row itself.
     * A row without a checkbox changes nothing. The caller refreshes the view.
     * @param {TreeRow} row
     * @param {boolean} on
     * @returns {void}
     */
    setChecked(row, on) {
      const ids = tickIdsOf(row);
      if (review && ids.length) review.setAll(ids, on);
    },
    /**
     * The view's message and badge for what the tree shows: none while a placeholder row
     * is shown or there is no result, else `buildReviewSummary` with the current ticks.
     * @returns {{ message: string|undefined, badge: { value: number, tooltip: string }|undefined }}
     */
    summarize() {
      const state = getState();
      if (models.buildPlaceholderRows({ phase: getPhase(), busy: isBusy(), state }) || !state || !state.result) {
        return { message: undefined, badge: undefined };
      }
      const counts = reviewTree.countReview(buildFiles(state).rows, (r) => checkedOf(r) === true);
      return reviewTree.buildReviewSummary(state.result, state.source, counts);
    },
  };
}
module.exports = { createTreeProvider, LEGEND: models.LEGEND };
