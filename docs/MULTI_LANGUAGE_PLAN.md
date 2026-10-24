# Multi-language plan: Go first, then Python and Java

Written 2026-10-24 from `main` at 74fe842. Follows the rules in `CODING_STYLE.md` and the
task style of `UX_PLAN.md` (gates are owner decisions; every task has acceptance).

## Where we stand

Impact Tree analyses TypeScript and JavaScript only. On a Go pull request
([cli/cli#14752](https://github.com/cli/cli/pull/14752)) the CLI reported **0 changed
source files**: every `.go` file is dropped at `src/engine/analyze.js:253` by
`isSourcePath` (`src/engine/diff.js:155`) and shown as a file with no call graph. The
README's "the caller graph is multi-language" is true of the caller lookup only; the
extension never reaches it for other languages.

Already language-agnostic: the caller lookup in `src/resolver-vscode.js` (call hierarchy at
a UTF-16 offset, no extension filter; gopls answered correctly for
`simulateRefreshTokenExpired` in that PR, first query ~100 s while indexing on an Intel
Mac), call-site classification (`call-sites.js`), test reach and blast radius
(`test-reach.js`, `forest.js`), signature diffing given a `sig` object (`signature.js`)
and offsets (`textpos.js`).

TypeScript-only today, and spread through the engine rather than in one place:

| Piece | Where |
| --- | --- |
| Source / test / generated file rules | `diff.js:155-161`, `analyze.js:253,277,480`, `readiness.js:36` |
| Changed symbols and signatures | `symbols.js`, `changed-symbols.js:94-143` (TS AST) |
| Per-project TS load and tsconfig grouping | `analyze.js:32-76, 252-268, 514` |
| Caller extras: inheritance filter, CQRS, unseen users, module callers | `inheritance.js`, `edges-cqrs.js`, `unseen-users.js`, `module-callers*.js`, wired in `resolver-vscode.js:90,284,330-369` |
| Row identity | `review-identity.js:58-68`, `session.js:397` |
| Language-server warm-up target | `readiness.js:19-54` |
| `outside` trivia lines | `changed-symbols.js:10` |
| No-checkout preview, CLI | `analyze-remote.js`, `syntactic-index.js`, `resolver-ts.js`, `cli.js` |

## Design

Three parts, each with one job. A new **language** adds a provider; a new **environment**
(the editor, a test harness, the CLI) adds a services adapter; the pipeline changes for
neither.

```
            ┌──────────────────────── Pipeline (engine, one) ────────────────────────┐
 git diff → │ files → changed symbols → signature kinds → callers → call-site check →│ → result → tree
            │         verdicts → test reach / blast radius                            │
            └───────┬───────────────────────────────────────────┬─────────────────────┘
                    │ asks, per file                            │ passes in
          ┌─────────▼─────────┐                       ┌─────────▼──────────┐
          │ LanguageRegistry  │ ── provider for ──▶   │  LanguageServices  │
          │ (by extension)    │    this file          │  (one per env.)    │
          └─────────┬─────────┘                       └─────────▲──────────┘
     ┌──────────┬───┴──────┬───────────┐                        │ uses
     │TypeScript│    Go    │  Python   │  Java  … LanguageProviders (one per language)
     └──────────┴──────────┴───────────┘
```

### The pipeline (one, language-blind)

`analyze()` keeps its stages and result shape. It stops testing extensions, loading
TypeScript, or grouping by tsconfig itself. For each changed file it asks the registry
for a provider; a file with none is a "no call graph" file row that names the language
when it is a known one ("Python files are not analysed yet"). Everything it needs to know
about a language, it asks the provider; everything it needs from a language server, the
provider asks the services. The engine still never imports `vscode`.

### LanguageServices (one adapter per environment)

What a language server supplies, and nothing language-specific:

```js
/** @typedef {{
 *   available(languageId: string): Promise<{ ok: true }|{ ok: false, reason: string }>,
 *   documentSymbols(doc: DocRef): Promise<ServerSymbol[]|null>,
 *   prepareCallHierarchy(doc: DocRef, pos: number): Promise<CallItem[]>,
 *   incomingCalls(item: CallItem): Promise<IncomingCall[]>,
 *   references(doc: DocRef, pos: number): Promise<Location[]>,
 *   implementations(doc: DocRef, pos: number): Promise<Location[]>,
 *   warmUp(doc: DocRef, pos: number, signal: AbortSignal): Promise<void>,
 * }} LanguageServices
 * `DocRef` is `{ file, side: 'head'|'base', text }`; positions are UTF-16 offsets into
 * `text`. `null` means the server gave no answer, which is never read as "nothing". */
```

- `services-vscode.js`: the editor's commands (`vscode.executeDocumentSymbolProvider`,
  `vscode.prepareCallHierarchy`, …). The deadlines, retries, warm-up tracking and
  cancellation now in `resolver-vscode.js` move here, since they are about talking to a
  server, not about a language. Base-side documents are served as gate L1 decides.
- `test/lsp-harness/`: a small LSP client over stdio (spawns `gopls`) implementing the
  same interface, for G7. Not shipped (gate L2).

### LanguageProvider (one per language) and the registry

Only what differs between languages. A provider is handed `services` and never talks to
a server itself: it decides what to ask and how to read the answer.

```js
/** @typedef {{
 *   id: string, displayName: string, serverHint: string,   // "Install the Go extension"
 *   handles(relPath: string): boolean,
 *   isTest(relPath: string): boolean,
 *   isGenerated(relPath: string, text: string): boolean,
 *   trivia: RegExp,                                          // comment-only lines
 *   collectSymbols(doc: DocRef, services: LanguageServices): Promise<CollectedSymbol[]|null>,
 *   signatureKinds(base: CollectedSymbol, head: CollectedSymbol): Kind[],
 *   callers(symbol: CollectedSymbol, services: LanguageServices, ctx): Promise<CallerAnswer>,
 *   needsServer: boolean,                                    // false: works in CLI / preview
 * }} LanguageProvider */
```

- `CollectedSymbol` is today's `symbols.js` shape (`key`, `label`, `namePos`,
  `startLine`/`endLine`, `start`/`end`, `sig`, `throws`, `isConstructor`, `exported`), so
  `changedSymbolsIn`'s hunk mapping and matching are reused for every language.
- `signatureKinds` returns `signature.js` kinds (`param-removed`, `type-changed`,
  `return-changed`, `new-throw`, …). Most providers build a `sig` from the declaration
  header and call the shared `diffSignature`; the method exists so a language can add its
  own (Java's checked `throws`).
- `callers` returns the existing resolver answer (`{ state, callers, complete, reason }`).
  The shared default (`callersFromHierarchy`) asks `prepareCallHierarchy` /
  `incomingCalls` / `references` and marks test callers with `isTest`; a provider wraps it
  for its blind spots (Go interfaces, Python dynamic calls) or replaces it (TypeScript's
  own language service in the CLI).
- **Registry** (`src/languages/index.js`): an ordered list of providers;
  `providerFor(relPath)` returns the first whose `handles` is true. TypeScript is first.
  Each language lives in `src/languages/<id>/` with its tests.

Keep the provider interface small: every method is written once per language. A need
that only one language has goes inside that provider, not on the interface.

### TypeScript is a provider too

`src/languages/typescript/` wraps what exists: the file rules, `symbols.js` /
`changed-symbols.js`, `signature.js`, and the caller extras (inheritance filter, CQRS,
unseen users, module callers), which leave the pipeline and the services adapter. It
is the one provider with `needsServer: false`: it parses with the bundled compiler and,
without an editor, finds callers with `resolver-ts.js`. That is why the CLI and the
no-checkout preview stay TypeScript/JavaScript only (gate L2). Moving it is the test of
the design: TypeScript results must not change.

## Gates (owner decisions)

- **L1. Base-side symbols.** Depends on G0's findings. Options, in order of preference:
  (a) a virtual document, if the servers answer for it; (b) the base text written to a
  temporary file in the extension's storage, with the same file name, asked once and
  deleted; (c) no base symbols: match the head symbol's header against the removed lines
  of its hunk, and find deleted functions from removed header lines with the language's
  header pattern. (c) is the most fragile and is the fallback only. Whichever is chosen
  lives in the services adapter (`DocRef.side`), not in providers.
- **L2. CLI and no-checkout preview.** Providers with `needsServer: true` are "not
  analysed in this mode" there, or the CLI gets the LSP harness as a shipped adapter.
  Proposal: not analysed for now; the harness stays a test tool.
- **L3. Go's "error" contract.** No Go-specific kind: a new `error` result is already a
  `return-changed`; a new `panic(` in a body is not tracked.
- **L4. After Go.** Python or Java next. Proposal: Python.

## Part T: the structure, with TypeScript in it

No new language yet. Every task leaves TypeScript's results identical: the
characterization snapshot (`tree-characterization.test.js`), `run-fixtures.js` and the
`t3-pr-snapshots` suite pass unchanged.

### T1. Interfaces and the registry

Acceptance: `LanguageServices`, `LanguageProvider`, `DocRef`, `CollectedSymbol` and
`CallerAnswer` typedefs in `src/languages/types.js`; `src/languages/index.js` with the
registry and `providerFor`; `diff.js`'s `isSourcePath` / `isTestPath` delegate to it;
tests for the registry order and for a path no provider handles.

### T2. The services adapter for the editor

Acceptance: `services-vscode.js` implements `LanguageServices` from the editor commands;
the deadline, retry, warm-up and cancellation code moves there from `resolver-vscode.js`;
`callersFromHierarchy` (shared default) is built on it and gives the same answers as
today's resolver on the existing resolver tests; base-side `DocRef`s are refused with
`null` until L1 is decided.

### T3. TypeScript behind its provider

Acceptance: `src/languages/typescript/` provides every method from the current modules;
the inheritance filter, CQRS, unseen users and module callers are called from its
`callers`, no longer from the pipeline or the adapter; `analyze()` asks the registry and
loads TypeScript only through this provider, so a review with no TS files never loads it;
`review-identity.js` and `readiness.js` get symbols and the warm-up target through the
provider; `cli.js` and `analyze-remote.js` use the provider with `resolver-ts.js` /
`resolver-syntactic.js` as its callers. No TypeScript result changes.

## Part G: Go

### G0. Spike: what the editor's Go support gives us

Answer, with numbers recorded here, on `cli/cli` in VS Code with the Go extension and
through the harness:

1. `documentSymbols` on a `.go` file: kinds, `range` (whole body?), `selectionRange`,
   `detail` (signature?), the receiver in method names, nested function literals.
2. The same on a virtual document, an `untitled:` document and a temporary file: answered
   or not, and how long. Decides L1.
3. `incomingCalls` at a method's name: calls through an interface included? From
   `_test.go` files? From another build tag's file (`config_enabled.go` vs
   `config_disabled.go`)?
4. `references` for a function passed as a value (cobra's `RunE: runF`,
   `opts.HttpClient`): does it see the value use the call hierarchy misses?
5. Time to first answer and per query after warm-up, on this machine.

Acceptance: a "Measured" section under G0 with the answers; L1 decided.

### G1. The Go provider: file rules

Acceptance: `src/languages/go/` registered after TypeScript; `handles` `.go`; `isTest`
`_test.go` (and `testdata/` is neither source nor test); `isGenerated` for `.pb.go`,
`_gen.go`, `zz_generated*.go` and a `// Code generated … DO NOT EDIT.` first line
(listed as files, not analysed); `trivia` for `//` and `/* */`; `services.available('go')`
failing gives one "Install the Go extension to analyse Go files" note, not a row of
unknowns; tests for each rule.

### G2. Go symbols

Acceptance: `collectSymbols` builds `CollectedSymbol`s from `documentSymbols`: functions
and methods only; `namePos` from `selectionRange.start`; methods labelled `(*T).Name` and
keyed by receiver type and name; a function literal counts as its parent's body; `null`
from the server makes the file a "no call graph" row with the reason ("the Go language
server gave no symbols"), never "nothing changed". The pipeline then lists changed, added,
deleted and outside-function changes for Go as for TS. Unit tests run on recorded
`ServerSymbol` fixtures, no editor needed.

### G3. Go signatures

Acceptance: `signatureKinds` parses each declaration header —
`func (r *T) Name(a, b int, opts ...Opt) (T, error)` — into a `sig` (grouped names
expanded, unnamed params named by position, variadic as `rest`, results as `returns`,
generics `[T any]` parsed) and calls the shared `diffSignature`; a receiver change
(`T` ↔ `*T`) is `type-changed`; tests cover each form from real `cli/cli` headers.

### G4. Go callers and their blind spots

Acceptance: `callers` wraps `callersFromHierarchy`:
- callers in `_test.go` are tests (from `isTest`), so they don't count as not updated and
  they feed test reach;
- a method that implements an interface (`implementations` says so) is amber "callers may
  be missing: calls through the interface are not listed", never "no callers";
- a function referenced as a value (references beyond the call sites) is amber with that
  reason;
- a function in a build-tagged file says the other tags' callers were not searched, if G0
  shows gopls skips them.

### G5. Row identity and warm-up for Go

Acceptance: through T3's provider hooks, a Go row's identity is `rel#key` plus a hash of
its declaration text, so a tick survives a refresh and a push that does not touch the
function; the warm-up target is the first changed Go function; the "Indexing…" message
names the Go language server and the elapsed time.

### G6. Go in the other modes

Acceptance: per L2, a Go file in the CLI or a no-checkout preview is listed as "Go: not
analysed in this mode — check out the pull request in the editor", and the preview's
limits note says so; nothing in those modes reads a Go file as having no impact.

### G7. Verification against cli/cli

The harness adapter (`test/lsp-harness/`) runs the real pipeline and Go provider against
`gopls`. Two independent oracles:

- **Changed functions:** a short Go program using `go/parser` on base and head that lists
  each `FuncDecl` whose text changed, was added or was removed, and its header.
- **Callers:** `golang.org/x/tools/cmd/callgraph -algo=static` (calls by name, like the
  call hierarchy) and `-algo=vta` (adds interface and function-value calls, to measure
  what G4's "may be missing" covers).

Corpus: 10 merged `cli/cli` PRs, chosen to include a renamed and a removed function,
a method signature change, an interface implementation, a build-tagged file, a cobra
`RunE` function value, generics and `_test.go` changes. PR #14752 is the first.

Acceptance, recorded here per PR and in total:
- changed-function detection: 100% precision, ≥ 98% recall against `go/parser`;
- signature kinds: every header change the oracle sees has the right kind;
- callers: precision and recall against `callgraph -algo=static`; every caller `vta` finds
  that we miss sits on a change marked amber "may be missing";
- no Go change is shown as fine while `vta` finds a caller that was not updated;
- time to first result and to full result, cold and warm.

Then a manual pass in VS Code on three of those PRs (one review, one checked-out PR, one
agent run), as U8's walk, by the owner.

### G8. Say what is supported

Acceptance: the README lists the languages analysed and, per mode, what works (editor:
TS/JS and Go; preview and CLI: TS/JS, per L2); the Changes view's "no call graph" row
for a known but unsupported language names it; `package.json` keywords and description
mention Go only once it ships.

## Part P and Part J: Python, then Java (after L4)

Each is a new provider in `src/languages/<id>/` with G1–G8's tasks; the pipeline and the
services adapter do not change. What differs:

- **Python** (Pylance or Jedi): `.py` / `.pyi`; tests `test_*.py`, `*_test.py`,
  `tests/`, `conftest.py`; headers `def` / `async def` with defaults (`optional`),
  `*args` / `**kwargs` (`rest`), type hints; decorators; `#` comments as trivia; dynamic
  calls make "may be missing" common, which must stay amber, not fine. Oracle: `ast`
  for changed functions; callers checked against the server plus `pyan` on a sample.
- **Java** (Red Hat's Java extension, jdtls): `.java`; tests `src/test/java/`,
  `*Test.java`, `*Tests.java`, `*IT.java`; overloads keyed by parameter types;
  `signatureKinds` adds `new-throw` for a new checked exception in `throws`; interface and
  abstract dispatch as G4; Lombok-generated members have no source. Oracle: a JavaParser
  diff and `javacg` (static call graph) on a sample repo.

## Order

1. T1 → T2 → T3: the structure in place, TypeScript unchanged. Can start before G0.
2. G0 spike, then decide L1 (and L2/L3 with it).
3. G1 → G2 → G3: Go changes appear with correct kinds.
4. G4 → G5 → G6: callers trustworthy, ticks persistent, other modes honest.
5. G7 verification on cli/cli; fix what it finds; owner's manual pass.
6. G8 docs, then release Go support (v1.1 or later; v1 stays TS/JS per the v1 scope
   decision in `UX_PLAN.md`).
7. L4 → Python or Java, as a provider each.
