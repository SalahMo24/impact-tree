// @ts-check
'use strict';
// The contracts between the analysis pipeline, the language services of an environment
// and the per-language providers (docs/MULTI_LANGUAGE_PLAN.md, "Design"). Contracts only.
//
// - The pipeline (`src/engine/analyze.js`) is the same for every language. It asks the
//   registry (`./index.js`) which provider handles a file.
// - A `LanguageServices` adapter supplies what a language server answers. There is one per
//   environment (the editor, a test harness), not one per language.
// - A `LanguageProvider` supplies what differs between languages. It is handed the
//   services and never talks to a server itself.
//
// Offsets are UTF-16 code-unit offsets into the text they refer to, with an exclusive
// end. Lines are one-based unless a name says otherwise. Paths named `relPath` are
// repository-relative with `/` separators; paths named `file` are absolute.

/**
 * A document the services are asked about: its absolute path, which side of the diff it
 * is, and the exact text the offsets refer to. The head side is the file on disk; the
 * base side is the text at the review's base, which is not on disk.
 * @typedef {object} DocRef
 * @property {string} file Absolute path the document has (or had) in the repository.
 * @property {'head'|'base'} side
 * @property {string} [text] Required for the base side. For the head side the services
 *   convert offsets from the file on disk (or the text registered with
 *   `src/engine/textpos.js`); `text`, when given, must equal it.
 */

/**
 * A place a language server pointed at, converted to offsets into `file` as it is on disk.
 * `start`/`end` are null when that file could not be read to convert the position; the
 * location was still reported, so it still counts as found.
 * @typedef {object} ServerLocation
 * @property {string} file Absolute path.
 * @property {number|null} start
 * @property {number|null} end Exclusive.
 */

/**
 * A symbol as a language server reports it (`DocumentSymbol`), converted to offsets into
 * the `DocRef`'s text.
 * @typedef {object} ServerSymbol
 * @property {string} name
 * @property {string} detail Server-chosen extra text; may be empty. Its meaning differs by server.
 * @property {number} kind The LSP `SymbolKind` number.
 * @property {{ start: number, end: number }} range The whole declaration.
 * @property {{ start: number, end: number }} selectionRange The name.
 * @property {ServerSymbol[]} children
 */

/**
 * A changed-symbol candidate in the shape `src/engine/symbols.js` already produces, so the
 * pipeline's hunk mapping, base/head matching and `diffSignature` serve every language.
 * @typedef {object} CollectedSymbol
 * @property {string} label Display name, such as `Class.method` or `(*T).Name`.
 * @property {string} key Unique within its file and stable between base and head.
 * @property {string} simpleName
 * @property {number} namePos Offset of the name; the position callers are asked at.
 * @property {number} startLine One-based, inclusive.
 * @property {number} endLine One-based, inclusive.
 * @property {number} span `endLine - startLine`; the hunk mapping prefers the smallest.
 * @property {number} start Offset of the declaration's start.
 * @property {number} end Offset just past the declaration.
 * @property {boolean} isConstructor
 * @property {boolean} exported
 * @property {{ async: boolean, params: Array<{ name: string, type: string|null, optional: boolean, rest: boolean }>, returns: string|null }|null} sig
 *   Null when the language's header parser could not read the declaration; the provider
 *   then decides the signature kinds itself (Go: `kindsOf` in src/languages/go/provider.js).
 * @property {Set<string>} throws
 */

/**
 * One symbol of one side of a file as the review identity (src/review-identity.js) reads
 * it: the part of a `CollectedSymbol` that locates its declaration. Offsets are into the
 * text whose hash `RecordedSide.textHash` holds.
 * @typedef {object} ReviewSymbol
 * @property {string} key As the `CollectedSymbol`'s: matches a deleted row's `key`.
 * @property {number} namePos Where a change or caller row of this symbol points (`pos`).
 * @property {number} start Offset of the declaration's start.
 * @property {number} end Offset just past the declaration.
 * @property {number} startLine One-based, inclusive.
 * @property {number} endLine One-based, inclusive.
 */

/**
 * The symbols a provider found on one side of a file, with the text they refer to.
 * @typedef {object} RecordedSide
 * @property {string} textHash SHA-256 (hex) of that side's text, so a reader can tell
 *   whether the text it holds is the one the offsets refer to.
 * @property {ReviewSymbol[]} symbols Every symbol of that side the provider collected,
 *   changed or not.
 */

/**
 * Both sides of one analysed file: `head` null for a file absent on the head side
 * (deleted), `base` null for one absent on the base side (added).
 * @typedef {{ head: RecordedSide|null, base: RecordedSide|null }} RecordedSymbols
 */

/**
 * What a language server supplies. Every method's answer `null` means the server gave no
 * answer (not installed, not ready, timed out, refused the document); it is never read as
 * "nothing found". A failed request rejects; when the error has `retryable: true`, it
 * failed because the server did not answer in time or was not ready, and the same request
 * may succeed later. The error's `message` is the reason shown to the reviewer.
 * @typedef {object} LanguageServices
 * @property {(languageId: string) => Promise<{ ok: true }|{ ok: false, reason: string }>} available
 * @property {(doc: DocRef) => Promise<ServerSymbol[]|null>} documentSymbols
 * @property {(doc: DocRef, pos: number) => Promise<unknown[]|null>} prepareCallHierarchy
 *   Opaque call-hierarchy items, passed back to `incomingCalls` unchanged. Empty: the
 *   server is up and has no item at `pos`.
 * @property {(item: unknown) => Promise<import('../engine/caller-contract').CallerRow[]|null>} incomingCalls
 * @property {(doc: DocRef, pos: number) => Promise<ServerLocation[]|null>} references
 * @property {(doc: DocRef, pos: number) => Promise<ServerLocation[]|null>} implementations
 * @property {(doc: DocRef, pos: number) => Promise<ServerLocation[]|null>} definitions
 *   Where the symbol used at `pos` is declared.
 * @property {<T>(run: (scope: LanguageServices) => Promise<T>) => Promise<T>} [callerQuery]
 *   Runs one caller query (a `prepareCallHierarchy` and the `incomingCalls` of its item)
 *   as a unit, asking through `scope`, so an adapter can schedule and bound the whole
 *   query while the server is still loading. Absent: `run` is given the services.
 */

/**
 * The file rules of a language: which files it analyses, which are tests and which are
 * generated. Pure and synchronous; the registry asks them for every changed file.
 * @typedef {object} LanguageFileRules
 * @property {string} id Stable identifier, such as `typescript` or `go`.
 * @property {string} displayName As shown to a reviewer.
 * @property {(relPath: string) => boolean} handles Whether this language analyses the file.
 * @property {(relPath: string) => boolean} isTest Asked only for a file this language handles.
 * @property {(relPath: string, text: string) => boolean} isGenerated Generated files are
 *   listed but not analysed.
 */

/**
 * What the pipeline hands a provider's `prepare`: the changed files that provider handles
 * and the diff the pipeline already read for them. The provider reads no diff itself.
 * @typedef {object} PrepareContext
 * @property {string} repo Absolute path of the repository root.
 * @property {any} git The run's `makeGit(repo)` (src/engine/git.js).
 * @property {import('../engine/analyze').ChangedPath[]} files The changed files this provider
 *   handles, tests left out, in diff order. Never empty.
 * @property {Map<string, string|null>} baseTexts Base-side text by base-side path, for every
 *   changed source file that existed at the base; null when git could not read it.
 * @property {Record<string, Array<[number, number]>>} changedRanges New-side changed lines by
 *   path, one-based inclusive; a pure deletion is the marker `[N + 0.5, N + 0.5]`.
 * @property {Record<string, Array<{ at: number, oldStart: number, oldEnd: number, newEnd?: number }>>} deletions
 *   The base lines each hunk removed, by path (see `changedSymbolsIn`).
 * @property {string[]} warnings Sink for warnings, shown in order after the run's own.
 * @property {Map<string, number>} unanalysable Sink: changed files not analysed, counted by
 *   the component (project) they belong to.
 * @property {Map<string, string>} notAnalysedFiles Sink: the reason, by path, for each changed
 *   file this language could not analyse. The result carries it on the file's `otherFiles`
 *   entry (`notAnalysed`), so a file that was not analysed never reads as one with no impact.
 *   A file listed here is also counted in `unanalysable`.
 * @property {(event: { phase: string, component?: string, done?: number, total?: number }) => void} report Progress.
 * @property {AbortSignal|undefined} signal Checked between steps; an aborted run rejects
 *   with `AnalysisCancelledError`, which the pipeline never reads as a provider failure.
 * @property {{ makeResolver?: Function, makeModuleCallers?: Function, services?: LanguageServices }} hooks The
 *   environment's `analyze()` options that choose how callers are found (the editor passes
 *   its language-server resolver) and, as `services`, the environment's language servers
 *   (`analyze()`'s `languageServices`; absent in the CLI). Each provider documents the ones
 *   it reads.
 */

/**
 * One batch of changed symbols that share a caller resolver: what the pipeline's caller,
 * test-reach, scoring and forest stages run on. TypeScript makes one per tsconfig project.
 * @typedef {object} AnalysisUnit
 * @property {string} component Name shown for the batch (a project directory, `(root)`).
 * @property {string} [projectRoot] Repository-relative directory of that project.
 * @property {object[]} changed Changed symbols: `CollectedSymbol`s with the fields
 *   `changedSymbolsIn` adds (`file`, `relPath`, `kinds`, `baseSig`, `headSig`, …).
 * @property {object[]} deleted Symbols only on the base side.
 * @property {Array<{ file: string, relPath: string, ranges: Array<[number, number]> }>} outside
 *   Per file with a changed or deleted symbol, the changed lines no changed symbol contains.
 * @property {{ callerState: Function, incoming: Function, incomingWithStatus?: Function, stats?: Function, dispose?: Function }} resolver
 *   Answers caller queries for `changed` (src/engine/caller-contract.js). The pipeline
 *   calls `dispose` when it is done with the unit.
 */

/**
 * What a provider's `prepare` returns. `extras` is the provider's own business the
 * pipeline only passes along:
 * - `notes()`: warnings the provider can only give once callers are known, appended after
 *   the caller stage.
 * - `dispose()`: releases what the units' resolvers share; called once the caller stage is
 *   over, on failure and cancellation too.
 * - `resultProperties`: put on the result as non-enumerable properties (live objects an
 *   environment uses, not part of the JSON result), such as TypeScript's `moduleCallers`.
 * - `reviewSymbols`: by repository-relative (head-side) path, the symbols of both sides
 *   of each file this provider analysed. The pipeline merges every provider's into the
 *   result's non-enumerable `reviewSymbols` Map, and the review identity reads a file's
 *   rows from it instead of parsing the file, so a language whose symbols come from a
 *   server is identified by content without asking the server again. A provider that
 *   leaves it out (TypeScript) has its files parsed by the identity itself.
 * @typedef {object} PreparedLanguage
 * @property {AnalysisUnit[]} units
 * @property {{ notes?: () => string[], dispose?: () => void, resultProperties?: Record<string, unknown>, reviewSymbols?: Map<string, RecordedSymbols> }} [extras]
 */

/**
 * What the editor's resolver adds, for one language, to the shared caller default
 * (`callersFromHierarchy`) for that language's targets: a language's blind spots and
 * over-reports. Created once per resolver by `LanguageProvider.editorCallers`.
 * @typedef {object} EditorCallerExtras
 * @property {(file: string, pos: number) => EditorCallerQuery} query One per caller query,
 *   taken when the query starts, so a query that outlives `clear()` keeps its own state.
 * @property {string} suppressedReason Why a suppressed query's empty answer is unknown.
 * @property {'inheritedDropped'|'valueUsesDropped'} droppedStat The resolver stat that counts
 *   the callers `filter` drops for this language, so the resolver names no language.
 * @property {(file: string, pos: number) => Promise<string|null>} unseenUsers Asked before
 *   "none": the reason the answer is unknown after all, or null. Never rejects.
 * @property {() => void} clear A new analysis starts: drop what was learnt.
 * @property {(reason: string, file: string, pos: number) => string|null} [explainIncomplete]
 *   For a query the server did not answer (a rejection, no item, no incoming-call result)
 *   at `pos` in `file`: the reason to show instead of the server's, when the language knows
 *   what that failure means (Go: a file outside the active build; Python: a protocol method
 *   or a decorator-registered function, whose callers no answer could list), or null to
 *   keep the server's reason. Synchronous. An explained failure is a lasting condition of the
 *   workspace, so the answer is incomplete and not retryable. Absent: never explained.
 */

/**
 * @typedef {object} EditorCallerQuery
 * @property {() => boolean} isSuppressed True: do not ask the server; an empty answer stands
 *   and its verdict is unknown (`suppressedReason`).
 * @property {(callers: import('../engine/caller-contract').CallerRow[]) => { kept: import('../engine/caller-contract').CallerRow[], dropped: number }} filter
 *   Removes callers the server reports wrongly. `kept` replaces the callers, so a kept
 *   caller may be a copy with fewer `callSites` (Go keeps only a caller's calls);
 *   `dropped` counts the callers removed.
 * @property {(() => Promise<{ callers: import('../engine/caller-contract').CallerRow[], incompleteReason: string|null }>)|null} moreCallers
 *   Callers the server cannot see; `incompleteReason` when that search failed. Never rejects.
 *   Null when there is nothing to search, so the answer needs no wait.
 */

/**
 * A language: its file rules plus how the pipeline analyses the files it handles.
 *
 * `prepare` is one coarse step rather than per-symbol hooks: TypeScript analyses per
 * tsconfig project, in batches that each have their own resolver, so it finds the changed
 * symbols and builds the resolvers for all its files at once. The pipeline then runs the
 * same caller, test-reach, scoring and forest stages on every provider's units. A
 * rejection other than cancellation reports every file of this provider as not analysed,
 * with the reason; other providers' units are still analysed.
 *
 * Server-backed languages (Go, …) implement `prepare` with the shared helper
 * `prepareFromServerSymbols` (./server-symbols.js): symbols through `LanguageServices`'
 * `documentSymbols`, hunks mapped with `changedSymbolsIn`'s rules (`changedFromSymbols`),
 * and callers from the environment's resolver.
 *
 * - `needsServer` false: works without a language server (the CLI, the no-checkout
 *   preview).
 * - `editorCallers` (optional, editor only): the extras the editor's resolver applies to
 *   this language's targets (`EditorCallerExtras`). The options are the resolver's: the
 *   TypeScript module it was given (`ts`, may be null), its `services`, `repoRoot`,
 *   `trace`, `filterInherited`, `onWarmupRetry`, called when a lookup waits for the
 *   server, and `clock`, which times those waits (src/engine/clock.js; omitted: the real
 *   clock).
 * - `warmUpTarget` (optional, editor only): where to warm the editor's language server for
 *   this language (src/readiness.js): a function or method name in one of `files` (this
 *   language's changed files, repository-relative, in diff order), so the server loads
 *   the project that file is in. The language decides how many files it tries. Null: none
 *   found, or the server is not available (no notice: the analysis reports that). May
 *   reject; readiness logs the reason and analyses without warming.
 * - `serverLabel` (optional): the language server as named while the first run waits for
 *   it ("Waiting for the Go language server (gopls)…"). Absent: TypeScript's wording.
 * @typedef {LanguageFileRules & {
 *   needsServer: boolean,
 *   prepare: (ctx: PrepareContext) => Promise<PreparedLanguage>,
 *   editorCallers?: (options: { ts: any, services: any, repoRoot: string|null, trace: (message: string) => void, filterInherited: boolean, onWarmupRetry: () => void, clock?: import('../engine/clock').Clock }) => EditorCallerExtras,
 *   warmUpTarget?: (ctx: WarmUpContext) => Promise<{ file: string, pos: number }|null>,
 *   serverLabel?: string,
 * }} LanguageProvider
 */

/**
 * What readiness hands a provider's `warmUpTarget`.
 * @typedef {object} WarmUpContext
 * @property {string} repo Absolute repository root.
 * @property {string[]} files This language's changed files that exist on the head side,
 *   repository-relative, in diff order. Never empty.
 * @property {LanguageServices|null} services The editor's language services; null when the
 *   resolver has none.
 * @property {(message: string) => void} log The output channel.
 */

module.exports = {};
