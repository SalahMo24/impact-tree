// @ts-check
'use strict';
// What the editor's resolver adds for a C# target to the callers Roslyn's call hierarchy
// reports (Part C, C5; `EditorCallerExtras` in ../types.js). Applied by the editor's resolver
// (src/session/resolver-vscode.js) and, the same way, by the harness
// (test/lsp-harness/harness-languages.js, csharp-e2e.js). What C0b measured and this follows:
//
// - Calls through an interface (C-D5). Roslyn's incoming calls at `Impl.M` list only calls on
//   receivers typed `Impl`, and at `IFoo.M` only those typed `IFoo`: the two are disjoint
//   (C0b: 32 vs 120 sites on one method of a test repository). `callerTargets` gives the interface members
//   a method implements, found by the syntax index (./syntactic-index.js `dispatchOf`), so the
//   shared step asks Roslyn there too and labels those rows "through IFoo"; a caller reached
//   both ways is one unlabelled row. Such an answer is always incomplete (owner, 2026-11-21:
//   other implementations may be what those calls run), with the index's reasons. A generic
//   interface's member is not asked (its calls on other type arguments would be listed): the
//   index's calls through it, whose receiver's type arguments may be this implementation's,
//   are labelled rows from `moreCallers` (S3, owner 2026-11-22), the CLI's rows. An explicit
//   implementation (`void IFoo.M()`) is not asked itself (S4: as primary constructors); its
//   interface member is, as a target, or, generic, gives the index's rows. Overrides:
//   Roslyn's base-method callers are not asked; an override, a virtual method or one hiding
//   a base member is incomplete with the index's reason.
// - The index is built once per session in a worker thread (`sessionIndex`, ./index-pool.js),
//   from the repository's C# files in the working tree within the editor's bound (8 000
//   files / 96 MiB; past it, no index), and rebuilt when HEAD or the working tree's C# files
//   change (uncommitted edits included, checked once per analysis). Its build is timed and
//   traced. Without it (no repository, past the bound, a failure or a timeout) an
//   implementing method cannot be told apart: every instance method's answer is incomplete,
//   saying why. A lookup is awaited, from the worker or from an index given (`indexOf`).
// - Value uses. Roslyn lists a method group (`Map("/x", Handler)`, `bus.E += OnChanged`) as an
//   incoming call (C0b). A site of a method whose text is its name not followed by `(` or a
//   type argument list is a value use: a caller whose every site is one is dropped, and the
//   answer is incomplete (`referenced-as-value`), as Java's and Go's.
// - Caller rows. Roslyn names a caller `Type.M(Fully.Qualified.Types)` within its type's full
//   name; a row is shown and keyed as the outline member that holds its name position instead
//   (`asOutlineRow`: the CLI's label, the member's name position), so a local function's or
//   an accessor's calls are its member's (C-D4) and a row matches the changed rows. A row no
//   member holds keeps a short `Type.Member` name (`shortCallerName`).
// - Top-level statements. Roslyn names their caller `Program.<top-level-statements-entry-point>`
//   with the whole file as its range (C0b); the row becomes the file's module row (the
//   outline's top-level symbol: the first statement's position, the file's basename), as the
//   syntax index lists it. The module symbol itself, operators and
//   conversions are never asked of Roslyn (`isSuppressed`): "not computed", as the index says.
// - Primary constructors get no call-hierarchy item (C0b): not asked; the syntax index's
//   callers, always incomplete.
// - Properties and indexers: Roslyn lists reads and writes at the name, but not those through
//   an interface or a base property: incomplete.
// - An empty answer for a method whose callers may come through dispatch is incomplete
//   (EMPTY_ANSWER_REASON): VS Code's `provideIncomingCalls` returns `[]` when the provider
//   fails, so a failed query can reach the editor as "no callers" (Java's J6 guard).
// - No call-hierarchy item at a member the outline lists: the file is not in a loaded project
//   (C0b: such a file is answered from Roslyn's misc-files project, partially) or the server
//   failed; `explainIncomplete` says so (not retryable).
// - No query cap: C0b saw 0 errors at 4 and 8 parallel queries.
// - Callers outside the repository are dropped and traced (not a row of the review).

const path = require('path');
const { readTextOfOffsets } = require('../../engine/textpos');
const { mergeCallerRows } = require('../callers-from-hierarchy');

/** @typedef {import('../../engine/caller-contract').CallerRow} CallerRow */

// The largest C# file read, for the target's outline or a caller's sites, in bytes on disk; the
// syntax index's own bound (MAX_FILE_BYTES there). A larger file's sites count as calls and its
// members are not recognised (asked of Roslyn as plain members).
const MAX_CSHARP_FILE_BYTES = 2 * 1024 * 1024;

const VALUE_USE_REASON = 'referenced-as-value';
const EMPTY_ANSWER_REASON = 'the language server returned no callers for a method that may be called through an interface or a base type; an empty answer can hide a failed query';
const NO_INDEX_REASON = 'the C# syntax index is not available, so calls through an interface this method may implement are not listed';
const LOOKUP_FAILED_REASON = 'the C# syntax index lookup failed, so calls through an interface this method may implement are not listed';
const NOT_INDEXED_REASON = 'the C# syntax index does not list this member, so calls through an interface it may implement are not listed';
const PROPERTY_REASON = 'a property or indexer: uses through an interface or a base property are not listed';
const PRIMARY_CONSTRUCTOR_REASON = 'a primary constructor: the C# language server lists no callers for it; callers from the syntax index';
const SERVER_CHANGED_REASON = 'the C# language server restarted or reloaded its projects during this analysis: answers given while it loads can be partial';
const STALE_TARGET_REASON = 'an interface member this method implements is not where the C# syntax index has it (the file changed since the index was built), so calls through it are not listed';
const NOT_LOADED_REASON = 'the C# language server gave no call-hierarchy item: its file may not be in a loaded project (not in the solution, or the project failed to load)';
const NOT_COMPUTED = {
  'top-level': 'not computed: callers of a C# file\'s top-level statements are not searched yet',
  operator: 'not computed: callers of a C# operator are not searched yet',
  conversion: 'not computed: callers of a C# conversion are not searched yet',
};
// Roslyn's caller name for top-level statements (C0b).
const TOP_LEVEL_CALLER = /<top-level-statements-entry-point>/;

/**
 * The outline member whose name is at `pos` (its `selectionRange.start`), with its type's
 * simple name; null when none. Pure.
 * @param {import('./outline').CsharpSymbol[]} symbols @param {number} pos
 * `explicit`: an explicit interface implementation (`void IFoo.M()`; `name` is `M`).
 * @returns {{ member: string, name: string, className: string|null, explicit: boolean }|null}
 */
function memberAtIn(symbols, pos) {
  for (const s of symbols) {
    if (s.csharp && s.selectionRange.start === pos) {
      const info = s.csharp;
      return { member: info.member, name: info.decl ? info.decl.name : info.typeName || s.name, className: info.typeName, explicit: !!(info.decl && info.decl.explicitInterface) };
    }
    if (s.children && s.children.length) {
      const inner = memberAtIn(/** @type {any} */ (s.children), pos);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * A short name for a caller Roslyn names that no outline member holds (a field initializer,
 * a file the outline cannot read): the last two dotted parts of its name before the
 * parameter list (`Type.Member`), namespaces dropped inside type arguments, no parameters.
 * Roslyn's `Ns.Type.Type.M(Ns.T)` (detail and name joined, as VS Code labels the row) is
 * `Type.M`. Pure.
 * @param {string} label @returns {string}
 */
function shortCallerName(label) {
  const paren = label.indexOf('(');
  const head = paren < 0 ? label : label.slice(0, paren);
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of head) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === '.' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.slice(-2).map((p) => p.replace(/(?:[A-Za-z_@][\w@]*\.)+(?=[A-Za-z_@])/g, '')).join('.') || label;
}

/**
 * Whether a site of the method `name` in `text` is a call (true), a value use (false), or
 * unknown (null: no text, a range outside it, a site that does not end in the name). Pure.
 * @param {string|null} text @param {{ start: number, end: number }} site @param {string} name
 * @returns {boolean|null}
 */
function isCsharpCallSite(text, site, name) {
  if (typeof text !== 'string') return null;
  const { start, end } = site;
  if (!Number.isInteger(start) || !Number.isInteger(end) || !(0 <= start && start < end && end <= text.length)) return null;
  const bareName = name.replace(/^@/, '');
  if (!text.slice(start, end).replace(/^@/, '').endsWith(bareName)) return null;
  let i = end;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === '(' || text[i] === '<';
}

/**
 * C#'s caller extras. Keeps, until `clear()`, each file's outline and each target's dispatch.
 * @param {{ trace?: (message: string) => void, readText?: (file: string) => string|null,
 *   repoRoot?: string|null, indexOf?: (() => Promise<any>)|null, serverSteady?: () => boolean }} [options]
 *   `indexOf`: the syntax index for the dispatch lookup (`sessionIndex` by default, for
 *   `repoRoot`); resolves null when there is none. `readText` (tests): a file's text.
 *   `serverSteady`: false once the C# server reported a state change after the probe trusted
 *   it (the provider's); every answer is then incomplete (SERVER_CHANGED_REASON).
 * @returns {import('../types').EditorCallerExtras}
 */
function createCsharpEditorExtras({
  trace = () => {}, readText = (file) => readTextOfOffsets(file, { maxBytes: MAX_CSHARP_FILE_BYTES }),
  repoRoot = null, indexOf = null, serverSteady = () => true,
} = {}) {
  const getIndex = indexOf || (() => (repoRoot ? sessionIndex(repoRoot, trace) : Promise.resolve(null)));
  // Cache: per file, its outline (owner: these extras; cleared by `clear()`).
  /** @type {Map<string, import('./outline').CsharpSymbol[]|null>} */
  const outlines = new Map();
  /** @param {string} file */
  const outlineOf = (file) => {
    if (!outlines.has(file)) {
      const text = readText(file);
      /** @type {import('./outline').CsharpSymbol[]|null} */
      let symbols;
      try { symbols = typeof text === 'string' ? require('./outline').csharpOutline(text, { fileName: path.basename(file) }) : null; } catch { symbols = null; }
      outlines.set(file, symbols);
    }
    return outlines.get(file) || null;
  };
  /** @param {string} file @param {number} pos */
  const memberAt = (file, pos) => {
    const symbols = outlineOf(file);
    return symbols ? memberAtIn(symbols, pos) : null;
  };
  // Cache: per file, its outline's members with keys and labels (owner: these extras; cleared by `clear()`).
  /** @type {Map<string, import('./provider').CsharpCollected[]|null>} */
  const membersByFile = new Map();
  /** @param {string} file */
  const membersOf = (file) => {
    if (!membersByFile.has(file)) {
      const symbols = outlineOf(file);
      const text = symbols ? readText(file) : null;
      /** @type {import('./provider').CsharpCollected[]|null} */
      let members;
      try { members = symbols && typeof text === 'string' ? require('./provider').collectCsharpSymbols(symbols, text, { throws: false }) : null; } catch { members = null; }
      membersByFile.set(file, members);
    }
    return membersByFile.get(file) || null;
  };
  /**
   * The outline member whose declaration holds `pos` (the narrowest), or null. A local
   * function's or an accessor's position is inside its member's span (C-D4: their body).
   * @param {string} file @param {number} pos
   */
  const ownerAt = (file, pos) => {
    /** @type {import('./provider').CsharpCollected|null} */
    let best = null;
    for (const m of membersOf(file) || []) {
      if (m.start <= pos && pos < m.end && (!best || m.end - m.start < best.end - best.start)) best = m;
    }
    return best;
  };
  /**
   * Where a file's module row is: its top-level statements' symbol (the first statement, as
   * the outline and the syntax index place it); 0 when the outline has none.
   * @param {string} file
   */
  const modulePosOf = (file) => {
    const top = (outlineOf(file) || []).find((s) => s.csharp && s.csharp.member === 'top-level');
    return top ? top.selectionRange.start : 0;
  };
  // Cache: per target (file#pos), its dispatch lookup (owner: these extras; cleared by `clear()`).
  // `transient`: a reason comes from a missing or failed index, or from an index older than
  // the text (S8: such an answer is not kept by the resolver, so it is asked again); the
  // index's own dispatch reasons (an interface, a base, a generic interface) are lasting.
  /** @type {Map<string, Promise<{ targets: import('../types').CallerTarget[], reasons: string[], rows: CallerRow[], transient?: boolean }>>} */
  const dispatches = new Map();
  /** @param {string} file @param {number} pos */
  const dispatchOf = (file, pos) => {
    const id = `${file}#${pos}`;
    let d = dispatches.get(id);
    if (!d) {
      d = (async () => {
        const m = memberAt(file, pos);
        /** @type {CallerRow[]} */
        const none = [];
        if (!m || m.member !== 'method') return { targets: [], reasons: [], rows: none };
        let idx;
        try { idx = await getIndex(); } catch (e) {
          // No index: past the editor's bound, the worker failed or timed out (S1, S5).
          const message = e && /** @type {any} */ (e).message;
          trace(`csharp: syntax index failed: ${message}`);
          return { targets: [], reasons: [`${NO_INDEX_REASON} (${message})`], rows: none, transient: true };
        }
        if (!idx) return { targets: [], reasons: [NO_INDEX_REASON], rows: none, transient: true };
        let found;
        try { found = await idx.dispatchOf({ file, pos, name: m.name, className: m.className }); } catch (e) {
          const message = e && /** @type {any} */ (e).message;
          trace(`csharp: dispatch lookup failed at ${relOf(file)}@${pos}: ${message}`);
          return { targets: [], reasons: [`${LOOKUP_FAILED_REASON}: ${message}`], rows: none, transient: true };
        }
        if (!found) return { targets: [], reasons: [NOT_INDEXED_REASON], rows: none, transient: true };
        // A target is asked only where the file's current text has that member (M3): an
        // index older than the text would send Roslyn into another member.
        /** @type {import('../types').CallerTarget[]} */
        const targets = [];
        const reasons = [...found.reasons];
        let transient = false;
        for (const t of found.targets) {
          const there = memberAt(t.file, t.pos);
          if (there && there.member === 'method' && there.name === m.name) targets.push(t);
          else { reasons.push(`${STALE_TARGET_REASON} (${t.text || relOf(t.file)})`); transient = true; }
        }
        // S3: the index's calls through a generic interface member, as the CLI lists them; a
        // row kept only where the current text still has that member (its label at its name)
        // or the module row there.
        const { isTestFile } = require('../../engine/diff');
        /** @type {CallerRow[]} */
        const rows = [];
        let stale = 0;
        for (const c of /** @type {import('../types').SyntacticCaller[]} */ (found.rows || [])) {
          const same = (membersOf(c.file) || []).some((x) => x.namePos === c.pos && x.label === c.label);
          if (!same && c.pos !== modulePosOf(c.file)) { stale++; continue; }
          rows.push({
            file: c.file, label: c.label, pos: c.pos, sites: c.callSites.length, callSites: c.callSites,
            test: repoRoot ? isTestFile(repoRoot, c.file) : false,
            ...(c.via ? { via: c.via, text: c.text } : {}),
          });
        }
        if (stale) {
          reasons.push(`${stale} caller(s) through a generic interface are not where the C# syntax index has them (the file changed since the index was built) and are not listed`);
          transient = true;
        }
        return { targets, reasons, rows, transient };
      })().catch((e) => ({ targets: [], reasons: [`${LOOKUP_FAILED_REASON}: ${e && /** @type {any} */ (e).message}`], rows: [], transient: true }));
      dispatches.set(id, d);
    }
    return d;
  };
  /** @param {string} file */
  const outsideRepo = (file) => {
    if (!repoRoot) return false;
    const rel = path.relative(repoRoot, file);
    return rel.startsWith('..') || path.isAbsolute(rel);
  };
  /**
   * A row of Roslyn's as the review shows callers (C-D6, C0b's recommendation): the outline
   * member that holds its name position (`selectionRange.start`) gives its position (the
   * member's name, as the changed rows and the walk key it) and its label (the CLI's). Roslyn's
   * own name (namespaces, fully qualified parameter types) is never shown: a row no member
   * holds keeps its position with a short name (`shortCallerName`). Top-level statements are
   * the file's module row.
   * @param {CallerRow} c @returns {CallerRow}
   */
  const asOutlineRow = (c) => {
    if (TOP_LEVEL_CALLER.test(c.label)) return { ...c, pos: modulePosOf(c.file), label: path.basename(c.file) };
    const owner = ownerAt(c.file, c.pos);
    if (!owner) {
      trace(`csharp: caller "${c.label}" at ${relOf(c.file)}@${c.pos} is in no outline member: kept with a short name`);
      return { ...c, label: shortCallerName(c.label) };
    }
    if (owner.namePos !== c.pos) trace(`csharp: caller "${c.label}" at ${relOf(c.file)}@${c.pos} is in ${owner.label} (its body)`);
    return { ...c, pos: owner.namePos, label: owner.label };
  };
  /** @param {string} file */
  const relOf = (file) => (repoRoot ? path.relative(repoRoot, file) : file);

  return {
    suppressedReason: 'not computed: the C# language server is not asked about this member',
    droppedStat: 'valueUsesDropped',
    callerTargets: async (file, pos) => (await dispatchOf(file, pos)).targets,
    explainIncomplete(reason, file, pos) {
      if (reason !== 'no call hierarchy item') return null;
      return memberAt(file, pos) ? NOT_LOADED_REASON : null;
    },
    query(file, pos) {
      const m = memberAt(file, pos);
      const notComputed = m && Object.hasOwn(NOT_COMPUTED, m.member) ? /** @type {Record<string, string>} */ (NOT_COMPUTED)[m.member] : null;
      const primary = !!m && m.member === 'primary-constructor';
      // S4: an explicit implementation is called only through its interface (Roslyn's item
      // there is not known): its interface member is asked (`callerTargets`), or, generic,
      // the index's rows are its callers; the member itself is not asked.
      const explicit = !!m && m.member === 'method' && m.explicit;
      let sawValueUse = false;
      let kept = 0;
      return {
        isSuppressed: () => !!notComputed || primary || explicit,
        filter(callers) {
          /** @type {Map<string, string|null>} */
          const texts = new Map();
          const textOf = (/** @type {string} */ f) => { if (!texts.has(f)) texts.set(f, readText(f)); return texts.get(f) ?? null; };
          /** @type {CallerRow[]} */
          const out = [];
          let dropped = 0;
          let outside = 0;
          for (const c of callers) {
            if (outsideRepo(c.file)) { outside++; continue; }
            let row = asOutlineRow(c);
            const sites = row.callSites || [];
            if (m && m.member === 'method' && sites.length) {
              const text = textOf(row.file);
              const rest = sites.filter((s) => isCsharpCallSite(text, s, m.name) !== false);
              if (rest.length < sites.length) sawValueUse = true;
              if (!rest.length) { dropped++; continue; }
              if (rest.length < sites.length) row = { ...row, callSites: rest, sites: rest.length };
            }
            out.push(row);
          }
          if (outside) trace(`csharp: dropped ${outside} caller(s) outside the repository`);
          if (sawValueUse) trace(`csharp: method group use(s) among ${callers.length} caller(s) of ${file}@${pos}`);
          // Rows that land on one member (a method and its local functions, a property's
          // accessors, several top-level statements) are one row; its "through" label stays
          // only when every merged row carries it (C-D5).
          const merged = mergeCallerRows([out]);
          kept = merged.length;
          return { kept: merged, dropped };
        },
        // `lasting` (S8): the reason holds for the analysis (the member's kind, its dispatch,
        // a value use), so the resolver keeps the answer; a server reload or a missing,
        // failed or stale index is not lasting, and the query is asked again.
        async moreCallers() {
          if (notComputed) return { callers: [], incompleteReason: notComputed, lasting: true };
          if (primary && m) return primaryConstructorCallers(file, pos, m);
          // Asked after the query answered: a reload that began before it may have cut it short.
          if (!serverSteady()) return { callers: [], incompleteReason: SERVER_CHANGED_REASON };
          if (m && (m.member === 'property' || m.member === 'indexer')) return { callers: [], incompleteReason: PROPERTY_REASON, lasting: true };
          /** @type {string[]} */
          const reasons = [];
          if (sawValueUse) reasons.push(VALUE_USE_REASON);
          const d = await dispatchOf(file, pos);
          reasons.push(...d.reasons);
          const unknown = d.reasons.some((r) => r.startsWith(NO_INDEX_REASON) || r === NOT_INDEXED_REASON || r.startsWith(LOOKUP_FAILED_REASON));
          // An explicit implementation's own query was not asked: an empty answer is its targets'.
          if (!kept && (!explicit || d.targets.length) && d.reasons.length && !unknown) reasons.push(EMPTY_ANSWER_REASON);
          // An explicit implementation is never complete: its calls are its interface's.
          if (explicit && !reasons.length) reasons.push(NOT_INDEXED_REASON);
          if (!reasons.length) return { callers: d.rows, incompleteReason: null };
          return { callers: d.rows, incompleteReason: reasons.join('; '), ...(d.transient ? {} : { lasting: true }) };
        },
      };
    },
    // Roslyn answers for the loaded solution, tests included; calls through interfaces are
    // the dispatch reasons'.
    unseenUsers: async () => null,
    clear() { outlines.clear(); membersByFile.clear(); dispatches.clear(); recheckSessionIndexes(); },
  };

  /**
   * A primary constructor's callers from the syntax index, always incomplete.
   * @param {string} file @param {number} pos @param {{ name: string, className: string|null }} m
   * @returns {Promise<{ callers: CallerRow[], incompleteReason: string, lasting?: boolean }>}
   */
  async function primaryConstructorCallers(file, pos, m) {
    /** @type {any} */
    let idx;
    /** @type {any} */
    let answer;
    try {
      idx = await getIndex();
      if (idx) answer = await idx.callersOfWithStatus({ file, pos, name: m.name, className: m.className });
    } catch (e) {
      // S5: an index that failed (past the bound, a worker death or timeout, a lookup error) is a reason.
      const message = e && /** @type {any} */ (e).message;
      trace(`csharp: primary-constructor callers failed at ${relOf(file)}@${pos}: ${message}`);
      return { callers: [], incompleteReason: `${PRIMARY_CONSTRUCTOR_REASON}, which is not available (${message})` };
    }
    if (!idx) return { callers: [], incompleteReason: `${PRIMARY_CONSTRUCTOR_REASON}, which is not available` };
    const { isTestFile } = require('../../engine/diff');
    /** @type {CallerRow[]} */
    const callers = answer.callers.map((/** @type {import('../types').SyntacticCaller} */ c) => ({
      file: c.file, label: c.label, pos: c.pos, sites: c.callSites.length, callSites: c.callSites,
      test: repoRoot ? isTestFile(repoRoot, c.file) : false,
      ...(c.via ? { via: c.via, text: c.text } : {}),
    }));
    // The index answered: its reasons hold for this tree state (S8); a failed index above does not.
    return { callers, incompleteReason: [PRIMARY_CONSTRUCTOR_REASON, answer.incompleteReason].filter(Boolean).join('; '), lasting: true };
  }
}

// ---- the session's syntax index (the extension host) -----------------------------------------

// Cache: the index built for one tree state of one repository, as a promise, and the worker
// pool that holds it (./index-pool.js). Owner: this module, for the session. At most one
// repository at a time (as the TypeScript module-caller pool): indexing another repository
// disposes the previous one's worker and forgets its entry; `disposeSessionIndexes` (the
// provider's `dispose`, at the end of the session) stops the worker. Invalidation: the tree
// state changed (`treeStateOf`: HEAD, `git status`, the dirty C# files' size and time),
// checked at most once per `clear()` (each analysis), through `checked`; or the worker that
// built the index stopped since (`usable`). A failed build (out of memory, a deadline) and a
// repository past the bound are remembered for their tree state: not rebuilt until it changes.
// An edit made during an analysis is seen at the next one; meanwhile a target the current
// outline does not confirm is not asked (STALE_TARGET_REASON), and a member not at its
// indexed position is found by name only when it has no overload. A cancelled analysis does
// not stop a build in the worker: it finishes and the next analysis reuses it.
/** @type {Map<string, { state: string|null, index: Promise<any>, checked: boolean, usable: () => boolean }>} */
const sessionIndexes = new Map();
/** @type {Map<string, ReturnType<typeof import('./index-pool').createCsharpIndexPool>>} */
const sessionPools = new Map();

/**
 * The repository's C# syntax index for the session, built once per tree state in a worker
 * (./index-worker.js; ./provider.js `indexRepositoryWithin`: every C# file the rules handle,
 * within the editor's bound), as an object whose `dispatchOf` and `callersOfWithStatus`
 * resolve the worker's answers. Rejects with the reason when there is no index: past the
 * bound (the files and MiB found and the bound), or the worker failed or timed out. Where
 * the worker cannot start, the index is built in this thread within the CLI's smaller bound
 * (../repository-files.js). Build time, file count and the worker's peak heap are traced.
 * @param {string} repoRoot @param {(message: string) => void} trace
 * @param {{ makeWorker?: (file: string, options: any) => any, maxFiles?: number, maxBytes?: number,
 *   buildMs?: number, queryMs?: number, fallbackBound?: { maxFiles: number, maxBytes: number } }} [options]
 *   Tests: the worker, a smaller bound, deadlines, the in-thread fallback's bound (the CLI's).
 * @returns {Promise<any>}
 */
async function sessionIndex(repoRoot, trace, options = {}) {
  const had = sessionIndexes.get(repoRoot);
  if (had && had.checked) return had.index;
  const { makeGit } = require('../../engine/git');
  const git = makeGit(repoRoot);
  const pools = require('./index-pool');
  const bound = pools.checkBound({ maxFiles: options.maxFiles ?? pools.EDITOR_MAX_FILES, maxBytes: options.maxBytes ?? pools.EDITOR_MAX_BYTES });
  let pool = sessionPools.get(repoRoot);
  if (!pool) {
    // One repository at a time: another one's worker and index are let go.
    for (const [root, other] of sessionPools) { other.dispose(); sessionPools.delete(root); sessionIndexes.delete(root); }
    pool = pools.createCsharpIndexPool(repoRoot, {
      ...(options.makeWorker ? { makeWorker: options.makeWorker } : {}),
      ...(options.buildMs !== undefined ? { buildMs: options.buildMs } : {}),
      ...(options.queryMs !== undefined ? { queryMs: options.queryMs } : {}),
    });
    sessionPools.set(repoRoot, pool);
  }
  const owned = pool;
  // Set before the first await, so queries that start together share one check and one build.
  const entry = { state: had ? had.state : null, index: /** @type {Promise<any>} */ (Promise.resolve(null)), checked: true, usable: () => false };
  entry.index = (async () => {
    const state = await treeStateOf(repoRoot, git);
    if (had && state && had.state === state && had.usable()) { entry.usable = had.usable; return had.index; }
    entry.state = state;
    /** @type {any} */
    let built;
    try {
      built = await owned.build(state, bound);
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'WORKER_START') {
        trace(`csharp: syntax index could not be built: ${/** @type {any} */ (e).message}`);
        // Remembered for this tree state (a build that ran out of memory or time would again).
        entry.usable = () => state !== null;
        throw e;
      }
      trace(`csharp: ${/** @type {any} */ (e).message}; building the syntax index in this thread within the CLI's bound`);
      return inThreadIndex(repoRoot, git, entry, trace, options.fallbackBound);
    }
    if (built.reason) {
      trace(`csharp: no syntax index: ${built.reason}`);
      entry.usable = () => true;
      throw new Error(built.reason);
    }
    const mib = (/** @type {number} */ n) => Math.round(n / 1024 / 1024);
    trace(`csharp: syntax index for dispatch ${built.built ? 'built' : 'kept (built earlier for this tree state)'} in ${built.ms}ms in its worker (${built.size} of ${built.files} file(s), ${mib(built.bytes)} MiB; worker heap peak ${built.heapPeakMb} MiB, ${built.heapMb} MiB after)`);
    const build = built.build;
    entry.usable = () => owned.serves(build);
    /** @param {'dispatchOf'|'callersOfWithStatus'} kind @param {any} arg */
    const ask = (kind, arg) => owned.query(build, kind, state, arg);
    return { size: built.size, dispatchOf: (/** @type {any} */ arg) => ask('dispatchOf', arg), callersOfWithStatus: (/** @type {any} */ arg) => ask('callersOfWithStatus', arg) };
  })();
  sessionIndexes.set(repoRoot, entry);
  return entry.index;
}

/**
 * The fallback where the worker cannot start: the index built in this thread, only within
 * the CLI's bound (REPO_MAX_FILES / REPO_MAX_BYTES; `bound` in tests); past it, no index (a
 * rejection, the reason), nothing read.
 * @param {string} repoRoot @param {any} git
 * @param {{ usable: () => boolean }} entry @param {(message: string) => void} trace
 * @param {{ maxFiles: number, maxBytes: number }} [bound]
 */
function inThreadIndex(repoRoot, git, entry, trace, bound) {
  const { REPO_MAX_FILES, REPO_MAX_BYTES } = require('../repository-files');
  const started = Date.now(); // wall-clock: log-only — the build time is traced
  const out = require('./provider').indexRepositoryWithin(repoRoot, git, {
    ...(bound || { maxFiles: REPO_MAX_FILES, maxBytes: REPO_MAX_BYTES }), label: 'the bound of an index built without its worker',
  });
  entry.usable = () => true;
  if (!out.index) {
    trace(`csharp: no syntax index: ${out.reason}`);
    throw new Error(/** @type {string} */ (out.reason));
  }
  const ms = Date.now() - started; // wall-clock: log-only — the build time is traced
  trace(`csharp: syntax index for dispatch built in ${ms}ms in this thread (${out.index.size} file(s); heap ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MiB)`);
  return out.index;
}

/** Ends the session's index workers and forgets their indexes (the session ended). */
function disposeSessionIndexes() {
  for (const pool of sessionPools.values()) pool.dispose();
  sessionPools.clear();
  sessionIndexes.clear();
}

/**
 * What the index was built from, as one string: HEAD's commit, `git status` (uncommitted and
 * untracked files), and the size and modification time of each listed C# or project file, so
 * an edit to a file that was already modified changes it too. Null when HEAD cannot be read
 * (the index is then rebuilt at every check).
 * @param {string} repoRoot @param {ReturnType<typeof import('../../engine/git').makeGit>} git
 * @returns {Promise<string|null>}
 */
async function treeStateOf(repoRoot, git) {
  const head = await git.rawAsync(['rev-parse', 'HEAD'], { timeoutMs: 10000 }).then((out) => String(out).trim(), () => null);
  if (!head) return null;
  const status = await git.rawAsync(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 10000 }).then((out) => String(out), () => null);
  if (status == null) return null;
  const fs = require('fs');
  const stamps = await Promise.all(status.split('\0').filter((e) => /\.(cs|csproj)$/i.test(e)).map(async (e) => {
    // A status entry is `XY path`; a rename's source path follows as a bare entry.
    const rel = /^.. /.test(e) ? e.slice(3) : e;
    const st = await fs.promises.stat(path.join(repoRoot, rel)).catch(() => null);
    return st ? `${rel}:${st.size}:${st.mtimeMs}` : `${rel}:gone`;
  }));
  return [head, status, ...stamps].join('\n');
}

/** A new analysis: HEAD and the working tree are checked again at the next lookup. */
function recheckSessionIndexes() {
  for (const e of sessionIndexes.values()) e.checked = false;
}

module.exports = {
  createCsharpEditorExtras, isCsharpCallSite, memberAtIn, shortCallerName, sessionIndex, recheckSessionIndexes,
  disposeSessionIndexes, SERVER_CHANGED_REASON, STALE_TARGET_REASON, LOOKUP_FAILED_REASON,
  VALUE_USE_REASON, EMPTY_ANSWER_REASON, NO_INDEX_REASON, NOT_INDEXED_REASON, PROPERTY_REASON,
  PRIMARY_CONSTRUCTOR_REASON, NOT_LOADED_REASON, NOT_COMPUTED, MAX_CSHARP_FILE_BYTES,
};
