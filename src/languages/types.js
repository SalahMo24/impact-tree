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
 * @property {number} start Offset of the declaration's start.
 * @property {number} end Offset just past the declaration.
 * @property {boolean} isConstructor
 * @property {boolean} exported
 * @property {{ async: boolean, params: Array<{ name: string, type: string|null, optional: boolean, rest: boolean }>, returns: string|null }} sig
 * @property {Set<string>} throws
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
 * A language: its file rules plus what the pipeline asks it about a file it handles.
 * Each method is written once per language, so the interface stays small; a need only one
 * language has belongs inside that provider.
 * @typedef {LanguageFileRules & {
 *   needsServer: boolean,
 *   trivia: RegExp,
 *   collectSymbols: (doc: DocRef, services: LanguageServices|null) => Promise<CollectedSymbol[]|null>,
 *   signatureKinds: (base: CollectedSymbol, head: CollectedSymbol) => Array<{ id: string, weight: number, label: string, short: string }>,
 *   callers: (symbol: CollectedSymbol & { file: string }, services: LanguageServices|null) => Promise<import('../engine/caller-contract').CallerState>,
 * }} LanguageProvider
 * `needsServer` false: works without a language server (the CLI, the no-checkout
 * preview). `trivia` matches a line that holds only a comment, for changes outside
 * functions.
 */

module.exports = {};
