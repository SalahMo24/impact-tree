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
//   interface's member is not asked (its calls on other type arguments would be listed): a
//   reason. Overrides: Roslyn's base-method callers are not asked; an override, a virtual
//   method or one hiding a base member is incomplete with the index's reason.
// - The index is built once per session in the extension host (`sessionIndex`), from the
//   repository's C# files in the working tree, and rebuilt when HEAD or the working tree's
//   C# files change (uncommitted edits included, checked once per analysis). Its build is
//   timed and traced. Without it (no repository, a failure) an implementing method cannot be
//   told apart: every instance method's answer is incomplete, saying so.
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
 * @returns {{ member: string, name: string, className: string|null }|null}
 */
function memberAtIn(symbols, pos) {
  for (const s of symbols) {
    if (s.csharp && s.selectionRange.start === pos) {
      const info = s.csharp;
      return { member: info.member, name: info.decl ? info.decl.name : info.typeName || s.name, className: info.typeName };
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
  /** @type {Map<string, Promise<{ targets: import('../types').CallerTarget[], reasons: string[] }>>} */
  const dispatches = new Map();
  /** @param {string} file @param {number} pos */
  const dispatchOf = (file, pos) => {
    const id = `${file}#${pos}`;
    let d = dispatches.get(id);
    if (!d) {
      d = (async () => {
        const m = memberAt(file, pos);
        if (!m || m.member !== 'method') return { targets: [], reasons: [] };
        let idx = null;
        try { idx = await getIndex(); } catch (e) { trace(`csharp: syntax index failed: ${e && /** @type {any} */ (e).message}`); }
        if (!idx) return { targets: [], reasons: [NO_INDEX_REASON] };
        const found = idx.dispatchOf({ file, pos, name: m.name, className: m.className });
        if (!found) return { targets: [], reasons: [NOT_INDEXED_REASON] };
        // A target is asked only where the file's current text has that member (M3): an
        // index older than the text would send Roslyn into another member.
        /** @type {import('../types').CallerTarget[]} */
        const targets = [];
        const reasons = [...found.reasons];
        for (const t of found.targets) {
          const there = memberAt(t.file, t.pos);
          if (there && there.member === 'method' && there.name === m.name) targets.push(t);
          else reasons.push(`${STALE_TARGET_REASON} (${t.text || relOf(t.file)})`);
        }
        return { targets, reasons };
      })();
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
      let sawValueUse = false;
      let kept = 0;
      return {
        isSuppressed: () => !!notComputed || primary,
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
        async moreCallers() {
          if (notComputed) return { callers: [], incompleteReason: notComputed };
          if (primary && m) return primaryConstructorCallers(file, pos, m);
          // Asked after the query answered: a reload that began before it may have cut it short.
          if (!serverSteady()) return { callers: [], incompleteReason: SERVER_CHANGED_REASON };
          if (m && (m.member === 'property' || m.member === 'indexer')) return { callers: [], incompleteReason: PROPERTY_REASON };
          /** @type {string[]} */
          const reasons = [];
          if (sawValueUse) reasons.push(VALUE_USE_REASON);
          const d = await dispatchOf(file, pos);
          reasons.push(...d.reasons);
          if (!kept && d.reasons.length && !d.reasons.includes(NO_INDEX_REASON) && !d.reasons.includes(NOT_INDEXED_REASON)) reasons.push(EMPTY_ANSWER_REASON);
          return { callers: [], incompleteReason: reasons.length ? reasons.join('; ') : null };
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
   * @returns {Promise<{ callers: CallerRow[], incompleteReason: string }>}
   */
  async function primaryConstructorCallers(file, pos, m) {
    const idx = await getIndex().catch(() => null);
    if (!idx) return { callers: [], incompleteReason: `${PRIMARY_CONSTRUCTOR_REASON}, which is not available` };
    const { isTestFile } = require('../../engine/diff');
    const answer = idx.callersOfWithStatus({ file, pos, name: m.name, className: m.className });
    /** @type {CallerRow[]} */
    const callers = answer.callers.map((/** @type {import('../types').SyntacticCaller} */ c) => ({
      file: c.file, label: c.label, pos: c.pos, sites: c.callSites.length, callSites: c.callSites,
      test: repoRoot ? isTestFile(repoRoot, c.file) : false,
      ...(c.via ? { via: c.via, text: c.text } : {}),
    }));
    return { callers, incompleteReason: [PRIMARY_CONSTRUCTOR_REASON, answer.incompleteReason].filter(Boolean).join('; ') };
  }
}

// ---- the session's syntax index (the extension host) -----------------------------------------

// Cache: per repository root, the index built for one HEAD commit, as a promise. Owner: this
// module, for the extension host's life (the session); one entry per repository analysed.
// Invalidation: the tree state changed (`treeStateOf`: HEAD, `git status`, the dirty C# files'
// size and time), checked at most once per `clear()` (each analysis), through `checked`. An
// edit made during an analysis is seen at the next one; meanwhile a target the current
// outline does not confirm is not asked (STALE_TARGET_REASON), and a member not at its
// indexed position is found by name only when it has no overload.
/** @type {Map<string, { head: string|null, index: Promise<any>, checked: boolean }>} */
const sessionIndexes = new Map();

/**
 * The repository's C# syntax index for the session, built once per tree state (the CLI's
 * `indexRepository`: every C# file the rules handle, bounded). Resolves null when it cannot
 * be built. The build is synchronous once the files are listed (C8b: ~1.4 s on the corpus);
 * its time is traced.
 * @param {string} repoRoot @param {(message: string) => void} trace
 * @returns {Promise<any>}
 */
async function sessionIndex(repoRoot, trace) {
  const { makeGit } = require('../../engine/git');
  const git = makeGit(repoRoot);
  const had = sessionIndexes.get(repoRoot);
  if (had && had.checked) return had.index;
  // Set before the first await, so queries that start together share one check and one build.
  const entry = { head: had ? had.head : null, index: /** @type {Promise<any>} */ (Promise.resolve(null)), checked: true };
  entry.index = (async () => {
    const head = await treeStateOf(repoRoot, git);
    if (had && head && had.head === head) return had.index;
    entry.head = head;
    const started = Date.now(); // wall-clock: log-only — the build time is traced
    try {
      const idx = require('./provider').indexRepository(/** @type {any} */ ({ repo: repoRoot, files: [], git }), []);
      trace(`csharp: syntax index for dispatch built in ${Date.now() - started}ms (${idx.size} file(s))`); // wall-clock: log-only — the build time is traced
      return idx;
    } catch (e) {
      trace(`csharp: syntax index could not be built: ${e && /** @type {any} */ (e).message}`);
      return null;
    }
  })();
  sessionIndexes.set(repoRoot, entry);
  return entry.index;
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
  SERVER_CHANGED_REASON, STALE_TARGET_REASON,
  VALUE_USE_REASON, EMPTY_ANSWER_REASON, NO_INDEX_REASON, NOT_INDEXED_REASON, PROPERTY_REASON,
  PRIMARY_CONSTRUCTOR_REASON, NOT_LOADED_REASON, NOT_COMPUTED, MAX_CSHARP_FILE_BYTES,
};
