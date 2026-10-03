'use strict';
const { nodeId } = require('./review-state');
const { prQuery } = require('./pr-documents');
const models = require('./tree-row-models');
const { groupChangesByLocation, groupCallerRowsByFile, buildFileTreeRows, buildDirectoryChildRows } = require('./tree-grouping');
const { renderTreeItem } = require('./tree-item-renderer');

// Tree nodes resolve their callers on expand. That laziness is the whole reason the
// extension is cheap where the CLI is not: the CLI pre-walked 152 positions (123s);
// a reviewer expands maybe a dozen.
//
// The provider owns what has a lifetime: reading the view state, scheduling caller
// queries, checking that their answers still belong to the current analysis, and
// publishing decorations. Rows are built and grouped by pure functions
// (tree-row-models, tree-grouping) and rendered by tree-item-renderer.

// `getAnalysisId` and `isCurrentAnalysis` come from the session: rows and decorations
// belong to the analysis that was current when they were requested. Without a session
// every request is current.
//
// Longer than the 70-line review trigger only because it is a factory: its length is
// the closures it defines over the injected dependencies, each well under 30 lines.
function createTreeProvider(vscode, {
  getState, resolver, isBusy = () => false, decorate = null, getPhase = () => 'ready', review = null,
  getAnalysisId = () => 0, isCurrentAnalysis = () => true,
}) {
  // A finding's direct callers are already resolved, so checking it can clear them too
  // and report real progress. Deeper levels are lazy and are not counted.
  const idOf = (n) => review?.id ? review.id(n) : nodeId(n);
  const childIdsOf = (n) => review?.childIds ? review.childIds(n) : [];
  const checkedOf = (n) => {
    if (!review) return null;
    const id = idOf(n);
    if (!id) return null;
    // A grouping row is reviewed exactly when everything in it is, so unticking one
    // change inside it unticks the group too.
    const members = models.GROUP_TYPES.has(n.type) ? childIdsOf(n) : null;
    return members ? members.length > 0 && review.remaining(members) === 0 : review.isReviewed(id);
  };
  const reviewNoteOf = (n) => {
    const kids = childIdsOf(n);
    const left = review ? review.remaining(kids) : 0;
    return review && kids.length ? (left ? `${left}/${kids.length} callers left to review` : 'all callers reviewed') : null;
  };
  // Read at render time, so a settings change shows on the next refresh.
  const viewOf = () => {
    const st = getState();
    return {
      layout: (st && st.fileListLayout) || 'tree',
      rowDetail: (st && st.rowDetail) || 'hover',
      iconMode: (st && st.iconMode) || 'file',
      checkedOf, reviewNoteOf,
    };
  };
  // file:///path#offset — unique per symbol so decorations do not collide, while the
  // icon theme still matches on the extension.
  // Tier A must NOT use a file:// URI. The editor's git decoration provider keys on
  // those and paints the worktree status (U for untracked, M for a local edit) on
  // top of the PR status. A non-file scheme is invisible to git, so the only badge
  // is the one we register from the pull request.
  const uriFor = (file, pos) => {
    if (!file) return null;
    const st = getState();
    let u;
    if (st && st.result && st.result.tierA && st.rel) {
      const rel = String(st.rel(file) || file).replace(/\\/g, '/').replace(/^\/+/, '');
      u = vscode.Uri.from({ scheme: 'impacttree-pr', path: `/${rel}`, query: prQuery(st.result, 'head') });
    } else {
      u = vscode.Uri.file(file);
    }
    return pos == null ? u : u.with({ fragment: String(pos) });
  };
  // Registers a row's decoration only while the analysis it was built for is current.
  const mark = (analysisId, uri, status, tooltip) => {
    if (decorate && uri && isCurrentAnalysis(analysisId)) decorate.register(uri, { status, tooltip });
    return uri;
  };
  const publishDecorations = (analysisId, requests) => {
    for (const d of requests) mark(analysisId, d.uri, d.status, d.tooltip);
  };
  const scheduleDecorationFlush = () => {
    if (decorate) setTimeout(() => decorate.flush(), 0);
  };
  const _emitter = new vscode.EventEmitter();

  function rootRows(state) {
    const placeholder = models.buildPlaceholderRows({ phase: getPhase(), busy: isBusy(), state });
    if (placeholder) return placeholder;
    const r = state.result;
    const leftToReview = review ? review.remaining(models.collectTopLevelChangeRefs(r).map(idOf)) : null;
    return models.buildRootRows(r, { leftToReview });
  }

  // The rows of one section, with the decorations they should carry.
  function buildSectionContent(node, state) {
    const r = state.result;
    const changes = (list, opts = {}) => models.buildChangeRows(list, { result: r, uriOf: uriFor, ...opts });
    switch (node.key) {
      case 'findings': return changes(r.findings.filter(models.isRootChange));
      case 'other': {
        const built = changes(models.otherChangesOf(r).filter(models.isRootChange));
        const grouped = groupChangesByLocation(built.rows, { layout: viewOf().layout, result: r, uriOf: uriFor });
        return { rows: grouped.rows, decorations: [...built.decorations, ...grouped.decorations] };
      }
      case 'untested':
        if (!r.testReachComputed) return { rows: [models.buildComputeTestReachRow()], decorations: [] };
        return changes(r.untested, { scopeNote: models.buildReachScopeNote(r) });
      case 'testUnknown':
        return changes(r.testUnknown || [], { reachReasonOf: (c) => c.testReachIncompleteReason || 'the test search did not finish' });
      case 'deleted': return models.buildDeletedRows(r.deleted, { result: r, uriOf: uriFor });
      case 'files': {
        const leaves = models.buildFileLeafRows(r.otherFiles || [], { absPath: state.absPath, uriOf: uriFor });
        return { rows: viewOf().layout === 'flat' ? leaves.rows : buildFileTreeRows(leaves.rows), decorations: leaves.decorations };
      }
      default: return { rows: [], decorations: [] };
    }
  }

  // Asks the resolver for a row's callers. A query that failed or did not finish must
  // not look like a symbol nobody calls, so the answer says why it is incomplete.
  async function queryCallers(node) {
    try {
      if (resolver.incomingWithStatus) {
        const answer = await resolver.incomingWithStatus(node.file, node.pos, true);
        return { callers: answer.callers, incomplete: answer.complete ? null : answer.reason || 'the caller query did not complete' };
      }
      const callers = await resolver.incoming(node.file, node.pos, true);
      return { callers, incomplete: 'this resolver does not report whether its caller search finished' };
    } catch (e) {
      return { callers: [], incomplete: (e && e.message) || 'the caller query failed' };
    }
  }

  async function callerRows(node, analysisId) {
    const state = getState();
    const answer = await queryCallers(node);
    // A newer analysis replaced the result while the query ran, so these callers belong
    // to a result no longer shown. The language server cannot cancel the query; it has
    // finished by now, and only its answer is dropped.
    if (!isCurrentAnalysis(analysisId)) return [];
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
      ancestry, reviewParent: idOf(node), changedKeys: (state && state.changedKeys) || new Set(),
      rel: state ? (f) => state.rel(f) : null, result: state && state.result, uriOf: uriFor,
    });
    publishDecorations(analysisId, built.decorations);
    const grouped = groupCallerRowsByFile(built.rows, { reviewParent: idOf(node), ancestry, uriOf: uriFor });
    if (answer.incomplete) grouped.push(models.buildIncompleteCallersRow(answer.incomplete, grouped.length > 0));
    if (node.inside && node.inside.length) grouped.unshift(models.buildInsideGroupRow(node));
    return grouped;
  }

  return {
    onDidChangeTreeData: _emitter.event,
    refresh() { _emitter.fire(); },
    getTreeItem: (n) => renderTreeItem(vscode, n, viewOf()),
    async getChildren(node) {
      const analysisId = getAnalysisId();
      if (!node) return rootRows(getState());
      if (node.type === 'section') {
        const state = getState();
        scheduleDecorationFlush();
        const content = buildSectionContent(node, state);
        publishDecorations(analysisId, content.decorations);
        return content.rows;
      }
      if (node.type === 'legend') return models.buildLegendRows();
      if (node.type === 'dir') return buildDirectoryChildRows(node);
      if (node.type === 'callerFile') return node.callers;
      if (models.GROUP_TYPES.has(node.type)) return node.rows;
      if (node.type === 'message' || node.type === 'summary' || node.type === 'legendItem'
        || node.type === 'deleted' || node.type === 'file' || node.cycle) return [];
      return callerRows(node, analysisId);
    },
  };
}
module.exports = { createTreeProvider, LEGEND: models.LEGEND };
