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

Only what differs between languages. Revised in T3 (2026-10-24): TypeScript analyses per
tsconfig project in batches, each with its own resolver, so per-symbol hooks did not fit.
A provider has one coarse method instead (`src/languages/types.js` is authoritative):

```js
/** @typedef {LanguageFileRules & {
 *   needsServer: boolean,                     // false: works in the CLI and preview
 *   prepare(ctx: PrepareContext): Promise<{ units: AnalysisUnit[],
 *     extras?: { notes?(): string[], dispose?(): void, resultProperties?: object } }>,
 *   editorCallers?(options): EditorCallerExtras,   // editor only, optional
 * }} LanguageProvider
 * AnalysisUnit: { component, projectRoot?, changed, deleted, outside, resolver } —
 * a batch of changed symbols with the resolver that finds their callers. */
```

- `prepare` gets this provider's changed (non-test) files and the run's base texts, hunk
  ranges, warning sinks, progress, cancellation and environment hooks (`makeResolver`,
  `makeModuleCallers`). A provider whose `prepare` rejects has its files reported as not
  analysed, with the reason; the other languages still run.
- `editorCallers` lets a language adjust the editor's caller answers for its own files
  (TypeScript's inheritance filter, command-bus edges and unseen users; Go's value uses and
  build tags in G4). The editor resolver applies it only to that language's targets.
- Server-backed languages (Go, Python, Java) implement `prepare` with a shared helper,
  built in G2: document symbols for base and head → the `CollectedSymbol` shape
  (`src/engine/symbols.js`'s) → the existing hunk mapping and matching; a per-language
  header parser → `sig` → the shared `diffSignature`; callers from `callersFromHierarchy`
  (`src/languages/callers-from-hierarchy.js`).
- **Registry** (`src/languages/index.js`): an ordered list of providers;
  `languageFor(relPath)` returns the first whose `handles` is true. TypeScript is first.
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

- **L1. Base-side symbols.** **Decided after G0: (b).** gopls and the Go extension only
  serve `file:` documents. (c) stays the fallback when the file cannot be written. Options, in order of preference:
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

### T1. Interfaces and the registry (done)

Acceptance: `LanguageServices`, `LanguageProvider`, `DocRef`, `CollectedSymbol` and
`CallerAnswer` typedefs in `src/languages/types.js`; `src/languages/index.js` with the
registry and `providerFor`; `diff.js`'s `isSourcePath` / `isTestPath` delegate to it;
tests for the registry order and for a path no provider handles.

### T2. The services adapter for the editor (done)

Acceptance: `services-vscode.js` implements `LanguageServices` from the editor commands;
the deadline, retry, warm-up and cancellation code moves there from `resolver-vscode.js`;
`callersFromHierarchy` (shared default) is built on it and gives the same answers as
today's resolver on the existing resolver tests; base-side `DocRef`s are refused with
`null` until L1 is decided.

### T3. TypeScript behind its provider (done)

Verified 2026-10-24: the full suite (82 files) passes with no expected value changed, and
the CLI's `--json` output is identical before and after on 14 cases (12 merged PRs or
merges of `pingdotgg/t3code` and `honojs/hono`, up to 245 changed files and 639 changed
functions, plus the synthetic fixture), timings aside.

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

**Measured (2026-10-24, done).** Full numbers in `test/lsp-harness/G0-REPORT.md`, reproduced
by `node test/lsp-harness/g0-spike.js <cli clone>` (gopls v0.21.0, Intel i7-9750H, warm
gopls disk cache; the real VS Code Go extension was not run).
1. Symbols: hierarchical; functions and methods all present; `range` is `func` to `}` (doc
   comment excluded); `selectionRange` is the bare name; methods are named with their
   receiver (`(*AuthConfig).reload`); `detail` is the signature without name or receiver;
   function literals are not listed (they are part of the parent's body).
2. Base side: gopls refuses any non-`file:` URI (`-32700`), and the Go extension only
   forwards `file:` documents. A temporary file outside the module is answered correctly
   (first one 684 ms, then fast). **L1 decided: (b)**, temporary file outside the module.
3. Callers: calls through an interface are included (concrete and interface method give the
   same 7 callers) but are not marked as such; `_test.go` callers are included; a function in
   a file excluded by build tags fails `prepareCallHierarchy` with "no package metadata".
4. Values: the call hierarchy already lists value uses (`Args: noArgsConstraint`: 11 callers,
   11 references), so it does not miss them, but it cannot tell a call from a mention.
5. Time: spawn + initialize 216 ms; first symbols 2.2 s; warm queries a few ms
   (`implementations` median 16–59 ms, up to 1.5 s).

### G1. The Go provider: file rules (done)

Acceptance: `src/languages/go/` registered after TypeScript; `handles` `.go`; `isTest`
`_test.go` (and `testdata/` is neither source nor test); `isGenerated` for `.pb.go`,
`_gen.go`, `zz_generated*.go` and a `// Code generated … DO NOT EDIT.` first line
(listed as files, not analysed); `trivia` for `//` and `/* */`; `services.available('go')`
failing gives one "Install the Go extension to analyse Go files" note, not a row of
unknowns; tests for each rule.

### G2. Go symbols (done)

Done 2026-10-24. `src/languages/server-symbols.js` (`prepareFromServerSymbols`) is the
shared `prepare` for server-backed languages; `src/engine/changed-symbols.js` was split so
its matcher (`changedFromSymbols`) takes collected symbols, TypeScript output unchanged
(14-case baseline). Base sides go through a temporary copy in the extension's storage
(`src/services-vscode.js`, at most 2 Mi characters, removed in `finally`, leftovers swept
at startup). A Go method's key uses its receiver's base type (`(Config).Size` for
`(*Config).Size`), so a `T` ↔ `*T` change is one `type-changed` method, not a delete and an
add. Checked end to end against gopls on cli/cli PR #14752 (`test/lsp-harness/go-e2e.js`):
every added and deleted function the diff shows, nothing more. Go rows get a conservative
review identity (any edit to the file unticks them) until G5.


Acceptance: `collectSymbols` builds `CollectedSymbol`s from `documentSymbols`: functions
and methods only; `namePos` from `selectionRange.start`; methods labelled `(*T).Name` and
keyed by receiver type and name; a function literal counts as its parent's body; `null`
from the server makes the file a "no call graph" row with the reason ("the Go language
server gave no symbols"), never "nothing changed". The pipeline then lists changed, added,
deleted and outside-function changes for Go as for TS. Unit tests run on recorded
`ServerSymbol` fixtures, no editor needed.

### G3. Go signatures (done)

Done 2026-10-24: `src/languages/go/signature.js`. Agrees with `go/parser` on 6621 of 6621
declarations in cli/cli and 61356 of 61356 in the Go standard library
(`test/go-signature-oracle.js`). Known limit: type text is compared as written, so
reformatting a multi-line struct type in a signature reads as a type change.


Acceptance: `signatureKinds` parses each declaration header —
`func (r *T) Name(a, b int, opts ...Opt) (T, error)` — into a `sig` (grouped names
expanded, unnamed params named by position, variadic as `rest`, results as `returns`,
generics `[T any]` parsed) and calls the shared `diffSignature`; a receiver change
(`T` ↔ `*T`) is `type-changed`; tests cover each form from real `cli/cli` headers.

### G4. Go callers and their blind spots

G0 changed this task: gopls lists interface calls and value uses as callers, so the risk
is not missing them but reading them wrongly.

Acceptance: `callers` wraps `callersFromHierarchy`:
- callers in `_test.go` are tests (from `isTest`), so they don't count as not updated and
  they feed test reach;
- a caller whose range is not followed by a call (`(` after the name, generics allowed) is a
  value use, not a call: the change is amber "used as a value, its calls cannot be traced",
  as TS's `referenced-as-value`, and that caller is not counted as "not updated at the call";
- a function in a file the current build tags exclude ("no package metadata") is amber
  "not in the active build; callers were not searched", never "no callers";
- a method that implements an interface needs no extra state (its interface callers are
  listed), but G7 checks against `callgraph -algo=vta` that this holds beyond PR #14752.

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
