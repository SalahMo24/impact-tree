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
every added and deleted function the diff shows, nothing more. Go rows got a conservative
review identity (any edit to the file unticked them) until G5 replaced it.


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

### G4. Go callers and their blind spots (done)

Done 2026-10-24: `src/languages/go/editor-extras.js` (`goProvider.editorCallers`), applied by
the editor resolver and, the same way, by the harness resolver. A site is a call when the
text after its identifier (past space, same-line comments and a generic `[...]`, within
4096 characters; a newline ends the expression) is `(` (`src/languages/go/call-sites.js`);
caller files are read through `textpos` up to 2 MiB, and a site that cannot be read is kept.
Callers that only use the function as a value are dropped, mixed ones keep only their
calls, and any value use makes the answer incomplete with `referenced-as-value` (so a
function used only as a value is unknown, never "no callers"). A "no package metadata"
rejection reads "not in the active build (build tags); callers were not searched", not
retryable (`EditorCallerExtras.explainIncomplete`). On cli/cli: `noArgsConstraint` goes from
11 callers, complete, to unknown / `referenced-as-value`; `debug.Config` in
`config_enabled.go` shows the build-tag reason.

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
  (G7: it holds for interfaces in the workspace only; a method sharing an interface with code
  outside the repository is now incomplete, `implements-outside-interface`.)

### G5. Row identity and warm-up for Go (done)

Done 2026-10-24. Two optional provider hooks and one extra, no Go in the shared code:
- **Identity.** `prepareFromServerSymbols` returns `extras.reviewSymbols`: per analysed file,
  each side's text hash and every function's `key`, `namePos`, `start`/`end` and lines (the
  `CollectedSymbol` offsets, no re-parse). `analyze()` merges them into the result's
  non-enumerable `reviewSymbols` (kept on the early result too), and `localRevisions`
  hands them to `createReviewIdentity`, which builds the same ids as for TypeScript from
  them: `rel#key:<head declaration hash>:<base declaration hash>` for a change row,
  `deleted:rel#key:<base declaration hash>`, and the outside row from each side's text
  without its functions' lines (runs of blank lines count as one). If the text on disk no
  longer hashes to the analysed one, that file's rows fall back to its whole text until the
  next analysis; a caller row in a Go file the analysis did not record (unchanged) is
  identified by its whole file. TypeScript ids are byte-identical (no `reviewSymbols` for
  it, so its files are still parsed). `test/go-review-identity.test.js`.
- **Warm-up.** `LanguageProvider.warmUpTarget({ repo, files, services, log })`: readiness asks
  each language in registry order with changed files until one gives `{ file, pos }`, then
  `resolver.warmUp` as before. TypeScript's wraps the old parser walk; Go's asks
  `available('go')`, then `documentSymbols` of the first changed Go file only, and takes the
  first function or method's name. A rejection is logged ("warm-up: no Go target — …") and the
  analysis runs unwarmed; no Go support is logged once ("warm-up: Go skipped — …") and adds
  no notice: the analysis already says "N changed Go file(s) NOT analysed — Install the Go
  extension to analyse Go files (…)" once, with each file marked not analysed (G1/G6).
- **Progress.** `LanguageProvider.serverLabel` (Go: "the Go language server (gopls)"): while the
  first run waits, the Changes view and status bar read "Waiting for the Go language server
  (gopls)… 12 s"; a timed-out caller retry reads "retrying when the Go language server
  (gopls) has loaded… N s". TypeScript's wording is unchanged. `test/go-warm-up.test.js`.
- On cli/cli PR #14752 with gopls: 22 Go rows, all content-identified, all distinct.

Acceptance: through T3's provider hooks, a Go row's identity is `rel#key` plus a hash of
its declaration text, so a tick survives a refresh and a push that does not touch the
function; the warm-up target is the first changed Go function; the "Indexing…" message
names the Go language server and the elapsed time.

### G6. Go in the other modes

Acceptance: per L2, a Go file in the CLI or a no-checkout preview is listed as "Go: not
analysed in this mode — check out the pull request in the editor", and the preview's
limits note says so; nothing in those modes reads a Go file as having no impact.

### G7. Verification against cli/cli (done, manual pass pending)

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

**Measured (2026-10-25).** Full report: `test/lsp-harness/G7-REPORT.md`, reproduced by
`node test/lsp-harness/go-verify.js <cli clone>` (corpus `test/lsp-harness/go-verify-corpus.json`;
oracles cached by commit and tool, about 1.5 min a re-run, 2.5 min uncached). 10 PRs, 816
function changes, 786 with callers compared; gopls v0.21.0, x/tools v0.52.0, go1.27.3.
- Changed functions: 100% precision, 100% recall against go/parser.
- Kinds: 189/189 header changes right, 315/315 body-only changes `body`.
- Callers against static: recall 100% (0 of 2751 missed), precision 86.0% (448 extra: 308
  vta edges through interfaces or values, 107 interface calls vta shows never reach the type,
  23 sibling implementations, 10 from an inactive build file of a nested module).
- Every one of the 26 changes with a vta caller we do not list is incomplete ("may be
  missing"); none is drawn as fine while vta finds a non-updated caller.
- Time to first / full result, fresh gopls, warm disk cache: 2.7–6.3 s / 3.4–10.6 s, 14 s /
  29 s for 251 files; warm gopls 0.5 s / 0.6 s (11 files) and 8 s / 21 s (251 files).
- Fixed on the way: a func type (`type X func(...)`) was listed as a function; calls through
  an interface declared outside the workspace were missing from an answer that read complete
  (now `implements-outside-interface`); `interface{}` → `any` read as a type change (132 red
  rows in one PR). No receiver change was found in ~410 recent PRs (unit-tested only).
- Follow-ups: drop gopls' sibling-implementation callers (a `definitions` check per site);
  say when an inactive-build file's callers are for its own build only (nested modules).
  The owner's manual pass is still to do.

### G8. Say what is supported (done)

Done 2026-10-25: the README has a Languages section (each language in each mode, what Go
needs, its known limits from G7), its status line, Limitations and Roadmap say the same,
the changelog has the Go entry, and `package.json`'s description and keywords name Go. A
changed file of a common language no provider analyses (Python, Java, …) reads
"*Language* · not analysed yet" instead of "no call graph" (`unsupportedLanguageOf` in
`src/languages/index.js`), quiet rather than amber since it is expected.

Acceptance: the README lists the languages analysed and, per mode, what works (editor:
TS/JS and Go; preview and CLI: TS/JS, per L2); the Changes view's "no call graph" row
for a known but unsupported language names it; `package.json` keywords and description
mention Go only once it ships.

## Part P: Python (approved 2026-10-25)

**Approved by the owner as proposed:** P-D1 `pyright` (MIT) in the scratchpad, P-D2
`encode/httpx`, P-D3 Jedi + 30 hand-checked callers, P-D4 (B) duck-typing evidence search,
P-D5 nested defs in the parent's body, P-D6 raises as `new-throw`; the verification plan
and budgets below as written.

Python becomes a third provider (`src/languages/python/`), built like Go on the shared
server-symbols helper, the editor services and `callersFromHierarchy`. The pipeline, the
services adapter, review identity (G5), warm-up hooks and the "not analysed" handling (G6)
are reused unchanged; Python only adds its rules, symbol collection, signature parser and
caller extras. Editor only, like Go: the CLI and the no-checkout preview list Python files
as not analysed (G6 does this for any provider that needs a server).

### The language server

Both editors answer Python with Pyright: Cursor ships **Cursor Pyright**
(`anysphere.cursorpyright`, installed here, proprietary licence), VS Code ships **Pylance**
(Microsoft, also Pyright-based; its licence forbids use outside Microsoft's editors). Both
expose the editor commands Impact Tree uses (document symbols, call hierarchy, references).
The plan targets Pyright's behaviour. The test harness needs an open-source server it can
run outside the editor: the MIT-licensed `pyright` npm package (decision P-D1).

### Decisions (approved)

- **P-D1. Harness server.** Install the MIT `pyright` npm package (its `pyright-langserver`)
  into `~/Projects/impact-tree-scratchpad/py-tools/`, not into the repo. One download,
  ~15 MB. Alternative: `basedpyright` (a Pyright fork, also MIT). Proposal: `pyright`, the
  common base of both editors' servers.
- **P-D2. Test repository.** A typed, mid-sized Python project with many merged PRs, so the
  server resolves most calls. Proposal: **`encode/httpx`** (fully type-annotated, ~60 source
  files, active). Alternatives: `pallets/flask` (lightly typed, decorator-heavy: a harder
  test of value uses), `psf/black`.
- **P-D3. Callers oracle.** Python has no maintained static call-graph tool like Go's
  `callgraph`. Proposal: **Jedi** (`pip install jedi` into a scratchpad virtualenv): its
  `get_references()` is a separate engine from Pyright, so agreement means something; plus
  a hand-checked sample of 30 callers. Alternative: hand-checked sample only (weaker).
- **P-D4. Duck typing (the main honesty question).** Pyright only finds `obj.method()` when
  it can infer `obj`'s type; calls on untyped objects are silently missing. Options:
  (A) every Python method's caller answer reads "may be missing callers" (always honest,
  noisy); (B) **proposal**: after the server answers, search the repository's Python files
  for `.<method_name>(` call text outside the listed call sites (the same idea as
  TypeScript's "unseen users" grep, bounded); if any is found the answer is incomplete with
  "N calls by this name that the language server could not resolve". Quiet when typing is
  good, amber exactly when there is evidence.
  **Narrowed after P0 (owner, 2026-10-25):** a text hit counts only when it is in code (not
  a string or comment) and the server's `definition` at it does not resolve to another
  function; one `definition` query per hit, bounded like the search itself.
- **P-D5. Nested functions.** A `def` inside a function: part of its parent's body (as Go's
  function literals; proposal), or its own row (as TypeScript's nested helpers). Methods
  in classes are always their own rows (`Class.method`).
- **P-D6. Raised exceptions.** Python's contract includes what it raises. Proposal: a new
  `raise SomeError` type in a function's body is the existing `new-throw` kind, as for
  TypeScript (cheap: read from the function's own text, nested defs excluded). Alternative:
  skip, as Go does with `panic`.

### Tasks

- **P0. Spike** (what Pyright gives): symbol shape (methods as class children, nested
  defs, decorators inside or outside `range`, `selectionRange`), base side via temporary
  file outside the workspace, call hierarchy for functions/methods with typed and untyped
  receivers, decorator registrations (`@app.route`) and callbacks as value uses,
  references, timings cold/warm. Output: a "Measured" note; confirms or changes P-D4/P-D5.

  **Measured (2026-10-25).** Full numbers in `test/lsp-harness/P0-REPORT.md`, reproduced by
  `node test/lsp-harness/p0-spike.js <httpx clone>` (pyright 1.1.414, httpx `b5addb6`, Intel
  i7-9750H; Cursor Pyright / Pylance not run).
  1. Symbols: hierarchical; methods (also class/static methods, properties) are `Method`
     children of their class; nested defs are `Function` children of their parent; parameters
     and locals are listed too (`Variable` children). `range` starts at the first decorator and
     includes the docstring; `selectionRange` is the bare name; `detail` is always empty. A
     property getter + setter pair, and `@overload` stubs + implementation, give **one** symbol
     (the setter / the implementation): 11 getters in `_client.py`/`_models.py` are in no
     function symbol's range. P2 must recover them from the text.
  2. Base side: virtual URI, `untitled:` and a temp file outside the workspace are all answered
     correctly (the same 74 of 81 defs as on the head side, ~0.5 s; the first document outside
     the workspace 2.3 s). G2's temp copy works unchanged.
  3. Callers: typed receivers, `self.`, classmethods, staticmethods, properties (attribute uses),
     re-exports and `tests/` callers are listed; untyped receivers are silently not. Method
     calls come back with duplicated `fromRanges`. No-callers answer is `null`.
  4. Values: unlike gopls, the call hierarchy lists **no** value uses (callback, dict entry,
     `functools.partial`, decorator application); `references` does (1 each).
  5. Duck typing, 4 methods: `raise_for_status` 2 real misses of 13 calls (untyped hook
     parameter); `multi_items`, `read`, `send` none. Raw `.<name>(` text hits outside listed
     sites: 6, 4, 32, 29 — mostly unrelated same-name methods and docstrings. After dropping
     strings/comments and hits that `definition` resolves to another function: 3 (2 real + 1
     planted), 0, 4 (all unrelated), 0.
  6. Time: spawn + initialize 0.3 s; first symbols 2.6 s; first incomingCalls 0.4 s; warm
     incomingCalls median 45 ms (max 105 ms), references 25 ms, symbols on a new file 13 ms.

  **Recommendation (accepted by the owner 2026-10-25).** P-D4: keep (B), but count only text hits in code (not
  strings/comments) that the server's `definition` does not resolve to another function; raw
  text hits would flag 4 of 4 methods (3 false alarms), the filtered count flags 2 of 4 (1
  false: `read`). P-D5: stands; nested defs are available as children but skipping them matches
  Go and keeps a nested helper's change in its parent. New for G4/P4: value uses need
  `references`, since the call hierarchy never lists them.
- **P1. Rules:** `.py`/`.pyi`; tests `test_*.py`, `*_test.py`, `conftest.py` (and the
  shared `tests/` directory rule); generated `_pb2.py`, `_pb2_grpc.py`, a `# Generated by` /
  `@generated` header; ignored `venv/`, `.venv/`, `site-packages/`, `__pycache__/`, `.tox/`,
  and `build/`, `dist/` at the repository root only (a package named `build` deeper down is
  source). Unit = nearest `pyproject.toml` / `setup.py` / `setup.cfg` directory.
  Removes "Python" from the "not analysed yet" list.
- **P2. Symbols:** functions and methods (class children) from document symbols; keys
  `Class.method` / `func` with repeats `#2` (overloads via `@overload`, redefinitions);
  nested defs per P-D5.
- **P3. Signatures:** parse `def`/`async def` headers (multi-line, to the `:` at depth 0):
  `self`/`cls` dropped for methods (renaming them is no change); defaults → `optional`;
  `*args`/`**kwargs` → `rest`; keyword-only (after `*`) and positional-only (before `/`)
  recorded in the parameter's type so moving a parameter across them is a change;
  annotations as types; `-> T` as returns; `async` as async. A change to
  `@property`/`@staticmethod`/`@classmethod` is a signature change; other decorators are
  not. Raises per P-D6. Oracle-checked against Python's `ast` on the test repo (like G3).
- **P4. Callers:** Python's `editorCallers`: duck-typing evidence per P-D4; value uses
  (a callback or decorator reference listed as a caller is not a call, as Go's G4);
  `getattr`/dynamic dispatch noted in the README limits.
- **P5. Identity and warm-up:** reuse G5 (recorded symbols, `warmUpTarget`); the
  "Waiting for …" text names the Python server.
- **P6. Other modes:** nothing new expected (G6 covers it); check and test.
- **P7. Verification** on 10 merged PRs of the P-D2 repo (plan below).

  **Measured (2026-10-25).** Full report: `test/lsp-harness/P7-REPORT.md`, reproduced by
  `node test/lsp-harness/py-verify.js <httpx clone> --worktree <httpx worktree>` (corpus
  `test/lsp-harness/py-verify-corpus.json`; oracles cached by commit and tool, 59 s a cached
  run, 75–78 s uncached). 10 PRs, 141 function changes, 112 with callers compared; pyright
  1.1.414, Jedi 0.20.1 (parso 0.8.7), Python 3.12.8; no httpx code imported or run (checked
  in the Jedi process: no module from the export, `sys.path` unchanged).
  - Changed functions: 100% precision, 100% recall against `ast` (99.3% before F2).
  - Kinds: 77/77 header changes right, 22/22 body-only changes `body`; no `new-throw` case in
    the corpus (unit-tested only).
  - Callers against Jedi: precision 72.2% (98 extra: all real calls on a `with … as x` target,
    which Jedi does not type), recall 26.2% (714 missed: all constructions of a changed
    `__init__`). Every one of the 18 changes with a Jedi caller we miss is incomplete; none is
    drawn as fine while Jedi has a non-updated caller. 30 callers hand-checked, all agree.
  - Time to first / full result, fresh Pyright: 2.0–4.8 s / 2.7–13.0 s.
  - Fixed on the way: F1, `__init__` read "no incoming-call result" (Pyright answers `null`
    there and lists constructions only at the class), and could read complete "no callers"
    where the editor turns `null` into `[]`: now always incomplete with a constructor reason.
    F2, a function defined in both branches of an `if`/`try` lost its second definition
    (httpx `_compat.py`): now recovered.
  - Follow-ups: list an `__init__`'s constructions by asking at the class name (needs a
    provider hook or the extras to ask after a `null`: shared code); a `new-throw` PR if it
    should be measured; a clearer reason than "no incoming-call result" for methods reached
    through a base class or protocol (`stream.close()`).
- **P8. Docs:** README Languages row and Python limits, changelog, `package.json`
  keywords.

  **Done (2026-10-25):** the README's Languages table has a Python row and a Python section
  (what it needs, how changes and callers are read, what reads as incomplete, what is not
  detectable, the P7 numbers); its status line, Limitations and Roadmap say the same; the
  changelog has the Python entry; `package.json`'s description and keywords name Python.

### Verification plan (agreed)

Times are measured or estimated on this machine (Intel i7, 12 threads) when idle.
"Iterate" checks run while working; "end" checks run once, when the task is done, and I
re-run them before committing. Every agent brief carries its task's rows verbatim, plus the
agent time budget; past it the agent stops and reports.

| Check | Proves | When | Expected time |
| --- | --- | --- | --- |
| `npm run test:quick` + the touched test files | nothing obvious broke | iterate | ~10 s |
| full `npm test` | no regression anywhere | end | ~1 min |
| TypeScript `--json` baseline (`compare.sh`) | TypeScript output unchanged | end | ~45 s |
| Go end-to-end (`go-e2e.js`, cli/cli #14752) | Go unchanged | end | ~15 s |
| Python end-to-end (`py-e2e.js`, one test-repo PR) | the provider works on real code with Pyright | end of P2–P6 | ~20 s (estimate) |
| Signature oracle (`py-signature-oracle.js` vs `ast`, whole test repo) | P3 parser agrees with Python | end of P3 | ~5 s |
| P7 verification (`py-verify.js`, 10 PRs; `ast` + Jedi oracles cached by commit + tool version; 3 PRs' oracles in parallel; hard deadline) | changed functions, kinds, callers on real PRs | end of P7 | uncached ≤ 5 min, cached ≤ 2 min |

Per-task budgets (agent wall time, including its verification):

| Task | Agent budget | Verification phase |
| --- | --- | --- |
| P0 spike (+ install per P-D1) | 30 min | spike script ≤ 2 min |
| P1 rules | 15 min | ~2 min (quick, full, baselines) |
| P2 symbols | 30 min | ~3 min (+ Python e2e) |
| P3 signatures | 30 min | ~3 min (+ signature oracle) |
| P4 callers | 30 min | ~3 min |
| P5 + P6 | 30 min | ~3 min |
| P7 verification | corpus pick: separate step for approval (15 min); run + fixes: 45 min | run ≤ 5 min uncached, ≤ 2 min cached, at most 3 full runs |
| P8 docs | me, 15 min | ~2 min |

P1 runs alone first; then P2 and P3 can run in parallel (separate worktrees, different
files); P4 after P2; P5/P6 after P4; P7 after all; P8 last.

Acceptance targets (as Go's G7): changed-function detection 100% precision, ≥ 98% recall
vs `ast`; every header change classified; callers: precision/recall vs Jedi reported with
false positives and misses listed separately; every caller Jedi finds that we miss sits
on an answer marked incomplete; no Python change shown as fine while a non-updated caller
is known.

## Part J: Java (after Python)

Original sketch for both languages (Python's is superseded by Part P above):

### Python and Java sketch

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

## Part A: the architecture after three languages (review, 2026-10-25)

TypeScript, Go and Python fit the provider model: Python was added almost entirely as
new files under `src/languages/python/`, with the pipeline (`src/engine/analyze.js`)
unchanged, and the TypeScript baseline and Go end to end stayed identical. The model stays.
Three small cleanups are done (A1–A3); A4–A6 are decisions for the owner.

### Cleanups (done 2026-10-25)

Checked unchanged before and after: `npm test`, the TypeScript baseline, Go's end to end on
cli/cli #14752, Python's end to end on httpx #1600 (output identical), `py-verify.js` on
the 10 httpx PRs (every per-PR result identical), and the signature oracle (httpx
1134/1134, standard library 61098/61098).

- **A1. One caller-extras step.** The order in which a language's `EditorCallerExtras`
  apply to a call-hierarchy answer (`explainIncomplete`, `filter`, `moreCallers`) is written
  once (`applyCallerExtras` in `src/languages/callers-from-hierarchy.js`), shared by
  `src/resolver-vscode.js` and the harness (`test/lsp-harness/harness-languages.js`), so G7
  and P7 verify the code the editor runs. The harness now de-duplicates `moreCallers`'
  callers as the editor does.
- **A2. Shared text helpers, one Python lexer.** Line starts and offset → line, path
  slashes and error messages in `src/languages/text.js`; one Python string/comment scanner,
  `src/languages/python/lexer.js`, for the header parser, the definition recovery and the
  caller checks. Fixed on the way: the caller checks ended a raw f-string at an escaped
  quote, and the header parser now reads a 3.12 f-string with its own quote in a field.
- **A3. Go-first leftovers.** The value-use log line names Go and Python; the harness's
  stdio services are `stdio-server-services.js` with thin `gopls-services.js` and
  `pyright-services.js`; the extension tests' fake hooks are `serverSymbols` /
  `serverAvailable`.

### Decisions (owner, 2026-10-25: A4 (b) Python first, A5 (a), A6 (a))

- **A4. Go and Python outside the editor.** Today the PR preview and the CLI list Go and
  Python files as not analysed. Options: (a) keep it; (b) a syntax-only tier per language
  (an optional `prepareSyntactic`): changed functions and their kinds from the text, callers
  "not computed", the level TypeScript's preview has. Python has most of it already (its
  definition scanner, the recovery of unlisted defs, the header parser at 100% against
  `ast`); Go needs a declaration scanner on top of its header parser; (c) tree-sitter as one
  syntax layer for every language: uniform, but a new dependency (WASM grammars) and a
  larger package; (d) running language servers in the CLI ourselves: needs gopls/Pyright
  shipped or found; not proposed. Proposal: (b), Python first.
- **A5. Ask callers at another position.** Python's `__init__` callers are the class's
  incoming calls (P7), and no hook lets a language say "ask here instead". Options:
  (a) an optional `callerTargets(file, pos) → positions` on `EditorCallerExtras`, the
  answers merged; (b) leave `__init__` incomplete (today). Proposal: (a); no other change
  to the extras interface, though it grew one hook at a time (`query`, `filter`,
  `moreCallers`, `explainIncomplete`, `unseenUsers`, suppression).
- **A6. Duck-typing search per analysis.** Each changed Python method runs its own
  repository search and up to 50 `definition` queries; httpx stays under 13 s per PR, but
  a PR with 100 changed methods repeats it 100 times. Options: (a) one index of
  `.<name>(` call sites per analysis, built on first use and dropped at `clear()`; (b) keep
  per target. Proposal: measure first on a large typed repository, then (a) if the time is
  noticeable.

### Tasks from the decisions

- **A5. `callerTargets`.** An optional `EditorCallerExtras.callerTargets(file, pos)` returns
  other positions whose incoming calls are also this target's callers; `applyCallerExtras`
  asks them and merges the answers (each caller once, the answer incomplete if any part is).
  Python answers the class name for a class's `__init__`, so `Client(...)` constructions are
  listed. The constructor answer is then read like any other method's: a class used as a
  value (`transport_cls=Client`), a subclass's `super().__init__()` through dispatch, and
  factory calls (`cls(...)`) keep it incomplete with their reason. Measured on P7's corpus:
  Jedi's 714 constructions should become listed callers.

  **Done (2026-10-25).** `callerTargets` in `EditorCallerExtras`, asked by
  `applyCallerExtras` through `askAt` (both resolvers), at most 4 targets
  (`MAX_CALLER_TARGETS`, past it incomplete); rows merged per caller with call sites merged;
  any unanswered part keeps the answer incomplete with its reason. A `null` incoming-call
  result at a position with targets, or at a target, reads as no calls there (the editor's
  `[]`). Python: the class name for a class's `__init__` (none for a class in a function,
  which keeps CONSTRUCTOR_REASON); then value uses of the `__init__` and of the class
  (annotations, `isinstance`/`issubclass` and `except` are not), subclassing
  (SUBCLASS_REASON) and `cls(...)`/`type(self)(...)` (FACTORY_REASON); no duck typing.
  `py-verify.js` (cached, 10 PRs): callers 1066 ours / 968 Jedi, precision 90.8% (the 98
  `with … as x` extras of P7), recall 100% (was 26.2%; 0 constructions missed, was 714);
  every other per-PR result as P7; Client/AsyncClient `__init__` incomplete as
  `referenced-as-value` (`parametrize("client_class", [httpx.Client, …])`).
- **A6. Measure the duck-typing search.** One merged PR with many changed methods in a large
  typed repository (proposal: `pydantic/pydantic`), through `py-verify.js`'s pipeline phase
  only: time per caller query with and without the search, the number of searches, files
  read and `definition` queries. "Slow" means the search adds more than 25% or more than
  10 s to the time to full result; then build the per-analysis index (A6b), else close A6.

  **Measured (2026-10-25): not slow, A6 closed.** pydantic #13070 (b36eaeb, 47 changed
  functions, 30 duck searches), fresh Pyright per run, search on vs off (`grep` stubbed):
  full result 30.8 s vs 29.1 s (+1.7 s, +5.9%); a second pair was within noise (ON 32.5 s,
  OFF 37.4 s; the machine was loaded). 30 `git grep`s about 3 s and 36 `definition` queries
  3–8 s in all, concurrent; no budget reached (at most 14 hits per name). Script and raw
  runs: `~/Projects/impact-tree-scratchpad/a6/`.
  Found on the way: pydantic's `[tool.pyright] include = ['pydantic', 'tests/test_pipeline.py']`
  leaves most tests out of Pyright's project, so their callers are not listed. For methods
  the duck search catches them ("N calls the language server resolves to it but did not
  list": 9 in `tests/test_color.py` for `Color.as_rgb_tuple`), but a **module function**
  called only from such a file reads complete. Follow-up **A7**: Python's `unseenUsers`
  (as TypeScript's), a bounded search for the function's name in Python files outside
  Pyright's project (its `include`/`exclude` in `pyrightconfig.json` or `[tool.pyright]`),
  making the answer incomplete when found; after A5 (same file).

  **A7 done (2026-10-25).** Done in `moreCallers` (last rule) rather than `unseenUsers`:
  `src/languages/python/pyright-project.js` reads the project (JSONC, minimal TOML, Pyright's
  globs and default excludes); a module function, and a class's `__init__` by its class's
  name, is searched (`git grep` for the name as a word, then calls and imports in code, not at
  a listed site, in files outside the project; a file with its own module-level definition
  counts only `mod.name(`). Methods stay with the duck search. Budgets: 200 files, 1 MiB per
  file, 16 MiB, 10 s. An unreadable config searches every file and names the error. pydantic
  #13070: full result 34.0 s; `replace_types`, `get_function_type_hints`,
  `apply_discriminator`, `ValidatedFunction.__init__` now incomplete with the new reason; in
  the editor (`[]` for Pyright's `null`) `recursively_defined_type_refs` (5 uses in
  `tests/test_generics.py`) and `models_json_schema` (16) read incomplete, before "no callers".
  httpx (no `[tool.pyright]`): unchanged. Script: `~/Projects/impact-tree-scratchpad/a7/`.
- **A4. Python outside the editor.** An optional `prepareSyntactic` on a provider, used where
  there is no language server (the CLI, the no-checkout preview): Python's changed functions
  and their kinds from the text (the module-level and class-body def scan of P2's recovery,
  P3's header parser and `raisesOf`), callers "not computed" (as TypeScript's preview).
  The editor keeps Pyright. Go follows as its own task (a declaration scanner on top of G3's
  parser) once Python's is measured.

  **A4 done (2026-10-25).** `LanguageProvider.prepareSyntactic` (optional): used by
  `analyze()` for a `needsServer` provider when there are no `services` (the CLI), and by
  `analyzeRemote` for a file of such a language. Python's: `pythonOutline` (a text outline in
  Pyright's symbol shape: classes by `class` lines and indentation, their methods and nested
  classes, module functions; statement starts read outside strings, brackets and
  continuations, so a docstring `def` line is not taken; every def listed, so the recovery
  is off) fed through the shared `prepareFromServerSymbols` (new optional `ctx.headTexts`,
  `ctx.unit` for the preview) and `collectPythonSymbols`, so keys and review ids are the
  editor's. Callers: `src/engine/resolver-not-computed.js`, `callerState` `'unknown'`,
  incomplete, reason "not computed: Python callers need its language server; …", the state
  TypeScript's preview gives what it cannot see; test reach `'unknown'` with that reason;
  blast radius not computed (`blastNotComputedReason`). `py-verify.js --syntactic` (ast
  cached): 141/141 changed functions on the 10 PRs, 0 extra, kinds 99/99. Go unchanged.

Order: A5 and A6 side by side (A6 only measures; different files), then A7 (owner, 2026-10-25),
then A4.

### Verification plans (agreed by the owner, 2026-10-25)

| Task | Check | When | Expected time |
| --- | --- | --- | --- |
| A5 | `npm run test:quick` + touched test files | iterate | ~15 s |
| A5 | `npm test`, lint, typecheck | end | ~2.5 min |
| A5 | TypeScript baseline (`compare.sh`) and Go e2e (shared code changes) | end | ~70 s / ~10 s |
| A5 | `py-e2e.js` on httpx #1600 (`httpx-seams` worktree) | end | ~12 s |
| A5 | `py-verify.js` cached, 10 PRs: constructions now listed, every target still met | end, at most 2 runs | ~1 min each |
| A6 | clone the repo (shallow to the PR's base), pick the PR | once | ≤ 3 min |
| A6 | one timed pipeline run with the search on and one with it off | once each | ≤ 5 min each |
| A4 | `npm run test:quick` + touched test files | iterate | ~15 s |
| A4 | `npm test`, lint, typecheck, TypeScript baseline | end | ~3.5 min |
| A4 | syntactic oracle on the 10 httpx PRs (`ast` cached from P7): changed functions 100% precision, ≥ 98% recall; kinds right | end, at most 3 runs | ≤ 1 min each |
| A4 | CLI and preview on httpx #1600: Python rows listed with kinds, callers "not computed", nothing reads "no impact" | end | ~20 s |

| A7 | `npm run test:quick` + touched test files | iterate | ~15 s |
| A7 | `npm test`, lint, typecheck | end | ~2.5 min |
| A7 | `py-e2e.js` on httpx #1600 (`httpx-seams`) | end | ~12 s |
| A7 | `py-verify.js` cached, 10 PRs: every target still met, no new incomplete answer without a found unseen caller | end, at most 2 runs | ~1 min each |
| A7 | pydantic #13070 (`pydantic-a6` worktree, `a6/measure.js`-style run): a module function called only from a test outside Pyright's project reads incomplete with the new reason; the run stays within A6's time | end, once | ~40 s |

Agent budgets (wall time, verification included): A5 30 min (Opus); A6 20 min (Sonnet);
A7 30 min (Opus); A4 45 min (Opus). Past it the agent stops and reports.

## Order

1. T1 → T2 → T3: the structure in place, TypeScript unchanged. Can start before G0.
2. G0 spike, then decide L1 (and L2/L3 with it).
3. G1 → G2 → G3: Go changes appear with correct kinds.
4. G4 → G5 → G6: callers trustworthy, ticks persistent, other modes honest.
5. G7 verification on cli/cli; fix what it finds; owner's manual pass.
6. G8 docs, then release Go support (v1.1 or later; v1 stays TS/JS per the v1 scope
   decision in `UX_PLAN.md`).
7. Part P (Python): P0 → P1 → P2 ∥ P3 → P4 → P5/P6 → P7 → P8.
8. Part J (Java), as a provider.
