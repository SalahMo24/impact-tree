// @ts-check
'use strict';
// `prepare` for a language whose symbols come from a language server (Go, and later Python
// and Java; docs/MULTI_LANGUAGE_PLAN.md, "Design" and G2). The provider supplies only what
// differs by language (`ServerSymbolSpec`): how a server's symbols become
// `CollectedSymbol`s, how signatures compare and render, and which unit a file belongs to.
// Everything else is shared: reading each side's text, asking the environment's
// `LanguageServices` for both sides' symbols, the hunk mapping and base/head matching of
// `changedFromSymbols` (src/engine/changed-symbols.js), and grouping files into units with
// the environment's resolver.
//
// What a reviewer can rely on: a file whose symbols the server did not give (no answer, a
// failed request, an unreadable side) is never shown as "nothing changed". It is counted
// as not analysed, with a warning naming the file and the reason, and stays listed as a
// file. Engine modules are required where they are used: the registry (./index.js) loads
// the providers, and src/engine/diff.js loads the registry.

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { messageOf } = require('./text');

/** @typedef {import('./types').PrepareContext} PrepareContext */
/** @typedef {import('./types').ServerSymbol} ServerSymbol */
/** @typedef {import('./types').CollectedSymbol} CollectedSymbol */
/** @typedef {import('./types').AnalysisUnit} AnalysisUnit */
/** @typedef {import('./types').RecordedSymbols} RecordedSymbols */
/** @typedef {import('../engine/analyze').ChangedPath} ChangedPath */

/**
 * What a server-backed language tells the shared `prepare`.
 * @typedef {object} ServerSymbolSpec
 * @property {import('./types').LanguageFileRules} rules The language's file rules; `id`
 *   names it to the services and the resolver, `displayName` to the reviewer, and
 *   `isGenerated` picks the files listed but not analysed.
 * @property {string} serverName As the reviewer reads it in a reason ("the Go language server").
 * @property {string} installHint Why a language the editor does not know is not analysed
 *   ("Install the Go extension to analyse Go files").
 * @property {(symbols: ServerSymbol[], text: string) => CollectedSymbol[]} collect The
 *   server's symbols of one side, as the changed-symbol candidates of that side. Pure.
 * @property {(symbol: CollectedSymbol) => string} renderSig The signature as shown.
 * @property {(base: CollectedSymbol|undefined, head: CollectedSymbol) => object[]} [kindsOf]
 *   The signature kinds of a change; `diffSignature` by default.
 * @property {RegExp} [trivia] A comment-or-blank line; `//` and block comments by default.
 * @property {(base: CollectedSymbol[], head: CollectedSymbol[]) => CollectedSymbol[]} [pairSymbols]
 *   Optional, Java only (J-D3): the head side's symbols with some given the key of a base
 *   symbol they continue (an overload whose parameter list changed keeps its old key), so
 *   the matching reads them as one changed symbol. Pure. Absent: keys are matched as given.
 * @property {(relPath: string, repo: string) => { component: string, projectRoot: string }} componentOf
 *   The unit a file belongs to: its name as shown and its repository-relative directory
 *   (`''` for the repository root). Files of one unit share one resolver.
 * @property {(text: string) => boolean} [declaresSymbols] Whether a side's text declares
 *   something `collect` keeps. An empty symbol list for such a text is no answer, not
 *   "nothing there": a server that has not loaded the file can answer `[]`.
 */

/**
 * Document-symbol requests one `prepare` has in flight at once. Unit: files (each asks for
 * at most two sides, one after the other). Default and only value: 4. The editor's services
 * cap all outstanding requests at 32 (src/services-vscode.js) and caller queries share that
 * cap, so this leaves them room; warm symbol answers take tens of milliseconds (G0), so 4
 * keeps a 200-file review to a few seconds. Owner and enforcement: `mapLimit` in
 * `prepareFromServerSymbols`. There is no exhaustion: it bounds simultaneous work, and the
 * total is the number of changed files, which the diff bounds.
 */
const SYMBOL_CONCURRENCY = 4;

/**
 * One side as the review identity reads it (`RecordedSide`): the text's hash and where
 * each symbol is, nothing else, since the result keeps it as long as the review.
 * @param {string} text
 * @param {CollectedSymbol[]} symbols
 * @returns {import('./types').RecordedSide}
 */
const recordedSide = (text, symbols) => ({
  textHash: createHash('sha256').update(text).digest('hex'),
  symbols: symbols.map(({ key, namePos, start, end, startLine, endLine }) => ({ key, namePos, start, end, startLine, endLine })),
});


/**
 * How one file ended: analysed, skipped as generated, or not analysed with the reason.
 * @typedef {{ kind: 'analysed', changed: object[], deleted: object[], outside: Array<[number, number]>, recorded: RecordedSymbols }
 *   | { kind: 'generated' } | { kind: 'failed', reason: string }} FileOutcome
 */

/**
 * The changed, deleted and outside symbols of every changed file of a server-backed
 * language, in units of `spec.componentOf`, each with the environment's resolver.
 *
 * Reads, from `ctx.hooks`:
 * - `services` (required): the environment's `LanguageServices`. Absent (the CLI): rejects,
 *   so the pipeline reports every file of this language as not analysed, with the reason.
 * - `makeResolver({ language, component, repoRoot, projectRoot })` (required): the resolver
 *   for one unit's symbols (the editor's: its language-server resolver). A null return
 *   reports that unit's files as not analysed.
 *
 * Per file: the head text is read from disk (`ctx.files` are the worktree's or the head
 * commit's paths), or from `ctx.headTexts` when given (the preview's fetched text), the base
 * text comes from `ctx.baseTexts`. `ctx.unit`, when given, is the one unit every file is in
 * (the preview's "pull request"), instead of `spec.componentOf`'s. A generated file is listed and
 * not analysed (one warning counts them). A side whose text cannot be read, or whose
 * symbols the server does not give (`null`, a rejection, or an empty list for a text that
 * declares symbols), makes the file not analysed: counted in `ctx.unanalysable` under its
 * unit, named in a warning with the reason, and given to `ctx.notAnalysedFiles` with that
 * reason, so the result carries it on the file itself.
 *
 * Every analysed file's symbols, both sides, are returned as `extras.reviewSymbols` (see
 * `PreparedLanguage`), so its review rows are identified by content without a re-parse.
 *
 * Rejects with the reason when the services are absent or the editor does not know the
 * language, and with `AnalysisCancelledError` when `ctx.signal` aborts. An error thrown by
 * `spec.collect` (a bug) rejects too, rather than hiding one file.
 * @param {PrepareContext} ctx
 * @param {ServerSymbolSpec} spec
 * @returns {Promise<import('./types').PreparedLanguage>}
 */
async function prepareFromServerSymbols(ctx, spec) {
  const { repo, files, baseTexts, changedRanges, deletions, warnings, unanalysable, notAnalysedFiles, report, signal, hooks, headTexts, unit } = ctx;
  const { throwIfCancelled } = require('../engine/cancellation');
  const { mapLimit } = require('../engine/concurrency');
  const { changedFromSymbols } = /** @type {any} */ (require('../engine/changed-symbols'));
  const { rules } = spec;
  const services = hooks.services;
  if (!services) throw new Error(`${rules.displayName} needs the editor's language server; open the repository in the editor to analyse it`);
  if (!hooks.makeResolver) throw new Error(`no caller search for ${rules.displayName} in this environment`);
  const availability = await services.available(rules.id);
  if (!availability.ok) throw new Error(`${spec.installHint} (${availability.reason})`);
  throwIfCancelled(signal);

  /** @type {Map<string, { projectRoot: string, files: ChangedPath[] }>} */
  const groups = new Map();
  for (const f of files) {
    const { component, projectRoot } = unit || spec.componentOf(f.path, repo);
    let group = groups.get(component);
    if (!group) { group = { projectRoot, files: [] }; groups.set(component, group); }
    group.files.push(f);
  }

  /**
   * One side's symbols, or why there are none.
   * @param {import('./types').DocRef} doc
   * @param {string} text
   * @returns {Promise<{ ok: true, symbols: CollectedSymbol[] }|{ ok: false, reason: string }>}
   */
  async function symbolsOf(doc, text) {
    const which = doc.side === 'base' ? ' for its base version' : '';
    /** @type {ServerSymbol[]|null} */
    let answer;
    try {
      answer = await /** @type {import('./types').LanguageServices} */ (services).documentSymbols(doc);
    } catch (e) {
      return { ok: false, reason: `${spec.serverName} could not list the symbols${which}: ${messageOf(e)}` };
    }
    if (answer == null) return { ok: false, reason: `${spec.serverName} gave no symbols${which}` };
    if (!answer.length && spec.declaresSymbols && spec.declaresSymbols(text)) {
      return { ok: false, reason: `${spec.serverName} listed no symbols${which}, though the file declares functions` };
    }
    return { ok: true, symbols: spec.collect(answer, text) };
  }

  /**
   * @param {ChangedPath} f
   * @param {string} component
   * @param {string} projectRoot
   * @returns {Promise<FileOutcome>}
   */
  async function outcomeOf(f, component, projectRoot) {
    const abs = path.join(repo, f.path);
    const basePath = f.oldPath || f.path;
    /** @type {string|null} */
    let headText = null;
    if (f.status !== 'deleted') {
      if (headTexts) {
        headText = headTexts.get(f.path) ?? null;
        if (headText == null) return { kind: 'failed', reason: 'its head version could not be read' };
      } else {
        try { headText = fs.readFileSync(abs, 'utf8'); }
        catch (e) { return { kind: 'failed', reason: `it could not be read from disk: ${messageOf(e)}` }; }
      }
    }
    /** @type {string|null} */
    let baseText = null;
    if (f.status !== 'added') {
      baseText = baseTexts.get(basePath) ?? null;
      if (baseText == null) return { kind: 'failed', reason: 'its base version could not be read from git' };
    }
    if (rules.isGenerated(f.path, /** @type {string} */ (headText ?? baseText))) return { kind: 'generated' };

    /** @type {CollectedSymbol[]|null} */
    let headCallables = null;
    if (headText != null) {
      const head = await symbolsOf({ file: abs, side: 'head', text: headText }, headText);
      if (!head.ok) return { kind: 'failed', reason: head.reason };
      headCallables = head.symbols;
    }
    /** @type {CollectedSymbol[]} */
    let baseCallables = [];
    if (baseText != null) {
      const base = await symbolsOf({ file: path.join(repo, basePath), side: 'base', text: baseText }, baseText);
      if (!base.ok) return { kind: 'failed', reason: base.reason };
      baseCallables = base.symbols;
    }
    // The pairing runs before the matching and the recorded sides, so a row's key and the
    // review identity's agree.
    if (spec.pairSymbols && headCallables) headCallables = spec.pairSymbols(baseCallables, headCallables);
    const result = changedFromSymbols({
      absPath: abs, relPath: f.path, oldPath: f.oldPath, status: f.status, baseText, headText,
      hunkRanges: changedRanges[f.path] || [], hunkDeletions: deletions[f.path] || [],
      component, projectRoot,
    }, {
      headCallables, baseCallables, renderSig: spec.renderSig,
      ...(spec.kindsOf ? { kindsOf: spec.kindsOf } : {}),
      ...(spec.trivia ? { trivia: spec.trivia } : {}),
    });
    const recorded = {
      head: headText == null ? null : recordedSide(headText, /** @type {CollectedSymbol[]} */ (headCallables)),
      base: baseText == null ? null : recordedSide(baseText, baseCallables),
    };
    return { kind: 'analysed', ...result, recorded };
  }

  /** @param {string} component @param {number} count */
  const notAnalysed = (component, count) => unanalysable.set(component, (unanalysable.get(component) || 0) + count);
  /** @type {string[]} */
  const generated = [];
  /** @type {AnalysisUnit[]} */
  const units = [];
  /** @type {Map<string, RecordedSymbols>} */
  const reviewSymbols = new Map();
  let done = 0;
  for (const [component, group] of groups) {
    throwIfCancelled(signal);
    report({ phase: 'component', component, done: done++, total: groups.size });
    const outcomes = await mapLimit(group.files, SYMBOL_CONCURRENCY,
      (/** @type {ChangedPath} */ f) => outcomeOf(f, component, group.projectRoot), { signal });
    /** @type {object[]} */
    const changed = [];
    /** @type {object[]} */
    const deleted = [];
    /** @type {AnalysisUnit['outside']} */
    const outside = [];
    /** @type {string[]} */
    const analysedPaths = [];
    /** @type {Array<[string, RecordedSymbols]>} */
    const recorded = [];
    group.files.forEach((f, i) => {
      const outcome = /** @type {FileOutcome} */ (outcomes[i]);
      if (outcome.kind === 'generated') { generated.push(f.path); return; }
      if (outcome.kind === 'failed') {
        notAnalysed(component, 1);
        warnings.push(`${f.path}: NOT analysed — ${outcome.reason}`);
        notAnalysedFiles.set(f.path, outcome.reason);
        return;
      }
      analysedPaths.push(f.path);
      recorded.push([f.path, outcome.recorded]);
      changed.push(...outcome.changed);
      deleted.push(...outcome.deleted);
      if (outcome.outside.length) outside.push({ file: path.join(repo, f.path), relPath: f.path, ranges: outcome.outside });
    });
    const analysed = analysedPaths.length;
    if (!analysed) continue;
    const resolver = hooks.makeResolver({ language: rules.id, component, repoRoot: repo, projectRoot: group.projectRoot });
    if (!resolver) {
      notAnalysed(component, analysed);
      const reason = 'no caller search is available for it';
      warnings.push(`${analysed} changed ${rules.displayName} file(s) in '${component}' NOT analysed — no caller search is available for them`);
      for (const p of analysedPaths) notAnalysedFiles.set(p, reason);
      continue;
    }
    units.push({ component, projectRoot: group.projectRoot, changed, deleted, outside, resolver });
    for (const [relPath, sides] of recorded) reviewSymbols.set(relPath, sides);
  }
  if (generated.length) {
    const shown = generated.slice(0, 3).join(', ');
    warnings.push(`${generated.length} generated ${rules.displayName} file(s) listed but not analysed: ${shown}${generated.length > 3 ? ', …' : ''}`);
  }
  return { units, extras: { reviewSymbols } };
}

module.exports = { prepareFromServerSymbols, SYMBOL_CONCURRENCY };
