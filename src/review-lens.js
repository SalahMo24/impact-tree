// @ts-check
'use strict';
const { classifyRowVerdict } = require('./tree-row-models');
const { treeItemId } = require('./review-tree-model');
const { listCallerRows } = require('./detail-panel-html');
const { headRelPath } = require('./detail-panel');

/** @typedef {import('./tree-row-models').TreeRow} TreeRow */
/** @typedef {{ line: number, character: number }} TextPosition */

// The review diff flags the changes that need action, and any change's callers are one
// command away. The lens is on a change that needs attention (level 0 or 1) in a document
// that is the head side of a file the shown result reviews; the callers peek works on any
// changed function. What the lens says and where the peek points are decided by the pure
// functions here; `createReviewLens` connects them to the editor.

/**
 * What the lens of one change is made of.
 * @typedef {{ id: string, line: number, verdict: string, hasCallers: boolean, reviewed: boolean }} LensEntry
 */

/**
 * The lenses a file's rows get: one entry for each change at level 0 or 1, on the change's
 * first line. A deleted symbol has no line in the head file, and an outside or file row is
 * not a function, so none of them gets a lens.
 * @param {TreeRow[]} rows The rows of one file from the shown review.
 * @param {(row: TreeRow) => boolean} isReviewed Whether a counting row is ticked.
 * @returns {LensEntry[]} In the order of `rows`; `line` is 0-based.
 */
function lensPlan(rows, isReviewed) {
  /** @type {LensEntry[]} */
  const plan = [];
  for (const row of rows) {
    const id = treeItemId(row);
    if (row.type !== 'finding' || !id) continue;
    const verdict = classifyRowVerdict(row);
    if (verdict.level > 1) continue;
    plan.push({ id, line: row.finding.startLine - 1, verdict: `${verdict.token} ${verdict.text}`,
      hasCallers: (row.finding.callers || []).length > 0, reviewed: isReviewed(row) });
  }
  return plan;
}

/**
 * The titles of a change's three lenses. A change without callers has nothing to peek at,
 * so it gets no callers lens.
 * @param {LensEntry} entry
 * @returns {{ verdict: string, callers: string|null, tick: string }}
 */
const lensTitles = (entry) => ({
  verdict: entry.verdict,
  callers: entry.hasCallers ? 'Show callers' : null,
  tick: entry.reviewed ? '✓ Reviewed' : 'Mark reviewed',
});

/**
 * One location for each call site of the callers among a change's impact rows; a file
 * group stands for the callers it holds, and rows that are not callers add nothing. A
 * caller whose call sites are unknown is taken to its own position, as opening it does, and
 * a site whose file cannot be read is left out.
 * @template Uri
 * @param {TreeRow[]} impactRows The rows under a change.
 * @param {{ uriOf: (caller: TreeRow) => Uri, positionOf: (file: string, offset: number) => TextPosition|null }} read
 *   `uriOf` is the document a caller opens in; `positionOf` turns an offset of a file into a position.
 * @returns {Array<{ uri: Uri, start: TextPosition, end: TextPosition }>}
 */
function callerLocations(impactRows, { uriOf, positionOf }) {
  const locations = [];
  for (const caller of listCallerRows(impactRows)) {
    const sites = caller.callSites && caller.callSites.length ? caller.callSites : [{ start: caller.pos, end: caller.pos }];
    for (const site of sites) {
      const start = positionOf(caller.file, site.start), end = positionOf(caller.file, site.end);
      if (start && end) locations.push({ uri: uriOf(caller), start, end });
    }
  }
  return locations;
}

/**
 * What the reviewer is told when a change has no callers to peek at. A search that did not
 * finish is not a search that found nobody, and the message says so.
 * @param {{ label: string, callersComplete?: boolean }} change
 * @returns {string}
 */
const noCallersMessage = (change) => `Impact Tree: No callers found for ${change.label}${change.callersComplete === false ? ' — the search did not finish' : ''}`;

/**
 * Registers the CodeLens provider and the commands it and the peek run.
 *
 * `showCallers` takes the tree id of a change (from a lens or the panel), a change row (from
 * the tree's context menu), or nothing, which means the change under the cursor.
 * @param {any} vscode
 * @param {{
 *   provider: ReturnType<typeof import('./tree-provider').createTreeProvider>,
 *   getState: () => { result: any, rel: (file: string) => string }|null,
 *   callerUri: (caller: TreeRow) => any,
 *   positionOf: (file: string, offset: number) => TextPosition|null,
 *   log: (message: string) => void,
 * }} deps `callerUri` is the document opening a caller shows (`open-review`); `positionOf`
 *   turns a file's offset into a position.
 * @returns {{ disposables: Array<{ dispose(): any }> }}
 */
function createReviewLens(vscode, { provider, getState, callerUri, positionOf, log }) {
  const changed = new vscode.EventEmitter();
  // This API invalidates the provider globally. Combine rapid marks in one turn;
  // plain-file progress has no lenses. Full analysis changes cancel a queued mark.
  /** @type {NodeJS.Timeout|null} */
  let progressTimer = null;
  const cancelProgress = () => {
    if (progressTimer !== null) clearTimeout(progressTimer);
    progressTimer = null;
  };
  const progressChanged = (/** @type {import('./tree-provider').ReviewProgress} */ event) => {
    if (!event.filePaths.length || progressTimer !== null) return;
    progressTimer = setTimeout(() => { progressTimer = null; changed.fire(); }, 0);
  };

  /** @param {{ uri: any }} document @returns {string|null} The reviewed file the document is the head side of. */
  const headPathOf = (document) => {
    const state = getState();
    return state && state.result ? headRelPath(document.uri, state) : null;
  };

  const lenses = {
    onDidChangeCodeLenses: changed.event,
    /** @param {{ uri: any }} document */
    provideCodeLenses(document) {
      const relPath = headPathOf(document);
      if (!relPath) return [];
      const analysisId = provider.reviewVersion();
      if (analysisId === null) return [];
      return lensPlan(provider.changeRowsOf(relPath), provider.isReviewed).flatMap((entry) => {
        const at = new vscode.Range(entry.line, 0, entry.line, 0);
        const titles = lensTitles(entry);
        return [
          new vscode.CodeLens(at, { title: titles.verdict, command: 'impactTree.showChange', arguments: [entry.id] }),
          ...(titles.callers ? [new vscode.CodeLens(at, { title: titles.callers, command: 'impactTree.showCallers', arguments: [entry.id] })] : []),
          new vscode.CodeLens(at, { title: titles.tick, command: 'impactTree.setReviewed', arguments: [entry.id, !entry.reviewed, analysisId] }),
        ];
      });
    },
  };

  // The change the command was asked about: the id it was given, the row of the context menu,
  // or the change under the cursor of the active review document.
  /** @returns {TreeRow|null} */
  function rowAtCursor() {
    const editor = vscode.window.activeTextEditor;
    const relPath = editor && headPathOf(editor.document);
    return relPath ? provider.rowAtLine(relPath, editor.selection.active.line + 1) : null;
  }
  /** @param {unknown} arg @returns {TreeRow|null} */
  function changeFor(arg) {
    const id = arg && typeof arg === 'object' ? treeItemId(/** @type {TreeRow} */ (arg)) : arg;
    const row = typeof id === 'string' ? provider.rowById(id) : arg == null ? rowAtCursor() : null;
    return row && row.type === 'finding' ? row : null;
  }

  // The editor whose document is the head side of the change's file, opening the change when
  // the active editor is not.
  /** @param {TreeRow} row @returns {Promise<any>} */
  async function editorShowing(row) {
    /** @param {any} editor */
    const shows = (editor) => !!editor && headPathOf(editor.document) === row.finding.relPath;
    if (!shows(vscode.window.activeTextEditor)) await vscode.commands.executeCommand('impactTree.openChange', row);
    const editor = vscode.window.activeTextEditor;
    return shows(editor) ? editor : null;
  }

  /** @param {unknown} [arg] */
  async function showCallers(arg) {
    const row = changeFor(arg);
    if (!row) return;
    const impact = provider.impactRowsOf(row);
    const callerRows = listCallerRows(impact);
    if (!callerRows.length) { vscode.window.showInformationMessage(noCallersMessage(row.finding)); return; }
    const found = callerLocations(impact, { uriOf: callerUri, positionOf });
    if (!found.length) {
      vscode.window.showWarningMessage(`Impact Tree: the call sites of ${row.finding.label} could not be read`);
      return;
    }
    const editor = await editorShowing(row);
    if (!editor) { log(`callers: ${row.finding.label} is not shown in an editor, so its callers were not peeked`); return; }
    const locations = found.map((l) => new vscode.Location(l.uri, new vscode.Range(l.start.line, l.start.character, l.end.line, l.end.character)));
    await vscode.commands.executeCommand('editor.action.peekLocations', editor.document.uri,
      new vscode.Position(row.finding.startLine - 1, 0), locations, 'peek');
  }

  // Tree ids persist across analyses. A delayed click may tick only the analysis the
  // lens was drawn for, even if a newer result has a row at exactly the same position.
  /** @param {unknown} id @param {unknown} on @param {unknown} analysisId */
  function setReviewed(id, on, analysisId) {
    if (typeof id !== 'string' || typeof on !== 'boolean') return;
    if (!Number.isSafeInteger(analysisId) || analysisId !== provider.reviewVersion()) return;
    const row = provider.rowById(id);
    if (!row || row.type !== 'finding') return;
    provider.setChecked(row, on);
  }

  return {
    disposables: [
      vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'impacttree-pr' }], lenses),
      provider.onDidChangePresentation((/** @type {{ reason: string }} */ event) => {
        if (event.reason === 'filter') return;
        cancelProgress(); changed.fire();
      }),
      provider.onDidChangeReview(progressChanged),
      { dispose: cancelProgress },
      vscode.commands.registerCommand('impactTree.showCallers', showCallers),
      vscode.commands.registerCommand('impactTree.setReviewed', setReviewed),
      changed,
    ],
  };
}

module.exports = { createReviewLens, lensPlan, lensTitles, callerLocations, noCallersMessage };
