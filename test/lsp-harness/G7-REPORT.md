# G7 report: the Go pipeline against cli/cli, checked by go/parser and callgraph

Reproduce with `node test/lsp-harness/go-verify.js <cli clone>` (see the script's header for
the flags; the corpus is `go-verify-corpus.json`). Every number below is from that script.

## Revision, configuration, environment

- **Impact Tree:** branch `feat/go-g7`, from `c0ec253` (G5) plus the G7 commits; the numbers
  are for the tree with the fixes below applied ("after"), with the "before" numbers where a
  fix changed them.
- **Target:** cli/cli partial clone (`blob:none`), local branches `base-<n>` / `pr-<n>` per PR
  (table below). `pr` mode against `base-<n>` with `allowLocalBase`; the merge base of the
  two is `base-<n>` itself, so the diff is exactly the PR's.
- **Pipeline options:** the editor's: `skipForest: true`, `deferTestReach: true`, depth 2,
  concurrency 8. Go provider, the harness's gopls services (`gopls-services.js`, base sides
  through a temporary file outside the module, as gate L1), the harness resolver with
  `goProvider.editorCallers(...)` applied in the editor resolver's order
  (`harness-languages.js`). The real VS Code Go extension was not run.
- **Oracles:** (a) a go/parser program (standard library; Go 1.24.2 `go/ast`, `go/parser`,
  `go/printer`); (b) cmd/callgraph's `-test -algo static` and `-algo vta` from
  golang.org/x/tools **v0.52.0**, built with **go1.27.3** (cli/cli's go.mod asks for 1.27; the
  installed `~/go/bin/callgraph` was built with go1.26.10 and refuses the module: "package
  requires newer Go version go1.27"). Both algorithms run from one load and SSA build
  (`GRAPHS_PROGRAM` in the script: cmd/callgraph's `doCallgraph` configuration, twice), over
  `./...` of every module the PR changes (cli/cli has a nested module under
  `.github/skills/cli-exercise/tool`). Build tags: none (darwin/amd64 defaults), the same as
  gopls.
- **Machine:** Intel Core i7-9750H (6 cores / 12 threads), 16 GiB, macOS 26.6.2, Node 22.16.0,
  gopls v0.21.0 (built with go1.25.5), go 1.24.2 (switching to go1.27.3 for cli/cli), gopls'
  disk cache warm. Other applications were running (load average 8–40 during the runs), so
  times are indicative, not benchmarks.

## Corpus

Merged PRs on `trunk`: head = merge^2, base = merge-base(merge^1, merge^2). Go files counts
all changed `.go` files; the pipeline and oracle (a) analyse the non-test ones.

| PR | merge | base | head | Go files (tests) | why |
| --- | --- | --- | --- | --- | --- |
| #14752 | ae7b97159 | 547bf81aa | a1d166798 | 11 (4) | the G2 PR: removed and added functions, build-tagged files (`internal/debug/config_enabled.go` `ghdebug`, `config_disabled.go` `!ghdebug`) |
| #14390 | ae1ba3288 | cba9646b8 | 1ba640d1c | 46 (19) | a renamed interface method on its implementations (`(NoOpService).Flush` → `Finish`), a method signature change (`(Uploader).UploadAndAttach`), 9 removed functions, cobra `runF` values |
| #14104 | adda317c1 | 0da5ee860 | 6865464458 | 60 (25) | removed functions (`getHost`, `handleHTTPError`), a method signature change (`(Client).GraphQL`), 17 header changes, an added func type, an `http.RoundTripper` implementation |
| #14475 | 8eba30474 | 38316c1c4 | 9b6f66363 | 56 (25) | generics (`readRecords[T]` added), a build-tagged pair (`process_unix.go` `unix` / `process_other.go` `!unix`), a nested module, 209 added functions |
| #14327 | 6e82bc505 | adda317c1 | 5b02f9abc | 17 (7) | cobra `RunE`/`runF`: eight `NewCmd*(f, runF)` constructors gain a parameter; callers updated |
| #14278 | 2ea46117e | 606cda4a9 | 88684c200 | 251 (107) | the largest: `go fix` cleanup, 142 headers `interface{}` → `any`, removed helpers (`min`, `stringInSlice`) |
| #14663 | 4a289a9e1 | 316e7a80f | 153adc66e | 29 (14) | a method signature change (`(AuthConfig).withFreshConfigForRefresh`), a method moved between files (`(Credential).IsRefreshable`) |
| #10811 | 3fc362b27 | 0ef0c4266 | 55d3b1eaa | 24 (11) | a renamed exported function used across packages (`findIssueOrPR` → `FindIssueOrPR`), a method signature change, `NewCmd*` passed as values, a generic helper (`TestArgParsing[T]`), a func type |
| #14720 | 407842514 | 3d7967df5 | 4537a92f3 | 16 (7) | a method signature change (`(source).artifactType`), a removed method (`(CreateOptions).documentType`) |
| #14128 | a526307b6 | c624f0ac7 | 5dfc6b06b | 86 (83) | `_test.go`-heavy: removed constructors with many test callers (`NewBlankConfig`, `NewFromString`) |

Full SHAs are in `go-verify-corpus.json`. **No receiver change (`T` ↔ `*T`) was found:** the
go/parser scan of every merged PR with Go changes among the last ~730 merges on `trunk`
(~410 PRs, non-test files) found none; the receiver case is covered only by G3's unit tests.
Generics are covered by added generic functions only; no existing generic function changed.

## What is compared

- **Changed functions:** rows `(path, key, changed|added|removed)` of `allChanged` and
  `deleted` (Go files only) against oracle (a)'s FuncDecls whose text from `func` to `}`
  differs, or exist on one side only. Generated files: go/ast's `IsGenerated`.
- **Signature kinds:** for every change both see, from go/parser's parameter and result types
  (go/printer text, white space removed, `interface{}` ≡ `any`): a receiver change requires
  `type-changed`, more parameters (type parameters included) `required-param`/`optional-param`,
  fewer `param-removed`, the same number but different types `type-changed` (or a removal and
  an addition), different results `return-changed`; a header that differs only in names or
  layout must be `body` alone, and no kind may be reported that no difference justifies.
- **Callers:** per changed or added function, the set of functions enclosing a call site in
  the head commit (`F.func()` and `F$1` both count as `F`; outside every function, the file).
  "static" is calls by name: callgraph's static edges plus vta's statically dispatched sites
  (static.CallGraph only walks from package members along static calls, so it never visits a
  function literal that is stored or passed, such as a cobra `RunE`: 6 such callers in #14752
  alone). False positives (we list, static does not) and missed callers (static lists, we do
  not) are counted separately.
- **"May be missing":** every vta caller (in the repository or a dependency) we do not list
  must sit on a change whose answer is incomplete (`callersComplete: false`).
- **Fine:** no change with a caller-visible kind may be drawn without colour
  (`toneOf(classifyChangeVerdict(c)) === null`, the tree's own functions) while vta finds a
  non-test caller whose call line the PR did not touch.

## Results (after the fixes)

| PR | functions (oracle) | precision | recall | header changes right | body-only right | callers ours / static | caller precision | caller recall | vta-missed on incomplete | fine with non-updated vta caller | first / full result, fresh gopls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #14752 | 15 | 100% | 100% | 0/0 | 4/4 | 19 / 19 | 100.0% | 100% | 0/0 | 0 | 2.7 s / 3.4 s |
| #14390 | 56 | 100% | 100% | 17/17 | 11/11 | 244 / 124 | 50.8% | 100% | 0/0 | 0 | 4.3 s / 6.9 s |
| #14104 | 80 | 100% | 100% | 17/17 | 34/34 | 278 / 268 | 96.4% | 100% | 1/1 | 0 | 4.7 s / 7.6 s |
| #14475 | 209 | 100% | 100% | 0/0 | 0/0 | 645 / 619 | 96.0% | 100% | 10/10 | 0 | 6.3 s / 10.6 s |
| #14327 | 10 | 100% | 100% | 8/8 | 1/1 | 26 / 26 | 100.0% | 100% | 0/0 | 0 | 3.8 s / 4.7 s |
| #14278 | 361 | 100% | 100% | 142/142 | 213/213 | 1531 / 1268 | 82.8% | 100% | 5/5 | 0 | 14.0 s / 29.4 s |
| #14663 | 28 | 100% | 100% | 1/1 | 20/20 | 200 / 171 | 85.5% | 100% | 2/2 | 0 | 3.7 s / 5.8 s |
| #10811 | 37 | 100% | 100% | 1/1 | 22/22 | 82 / 82 | 100.0% | 100% | 7/7 | 0 | 3.4 s / 4.7 s |
| #14720 | 13 | 100% | 100% | 2/2 | 9/9 | 21 / 21 | 100.0% | 100% | 1/1 | 0 | 3.3 s / 4.0 s |
| #14128 | 7 | 100% | 100% | 1/1 | 1/1 | 153 / 153 | 100.0% | 100% | 0/0 | 0 | 3.3 s / 3.8 s |
| **total** | **816** | **100%** | **100%** | **189/189** | **315/315** | **3199 / 2751** | **86.0%** | **100%** | **26/26** | **0** | |

Against the plan's targets: changed-function detection 100% precision (target 100%) and 100%
recall (target ≥ 98%); every header change has the right kind (189/189) and every body-only
change is `body` (315/315); caller recall against static 100% (0 missed of 2751), precision
86.0% (448 extra, explained below); every one of the 26 changes with a vta caller we do not
list is marked incomplete; no change is drawn as fine while vta finds a non-updated caller.

Of 786 changes with callers compared, 33 answers are incomplete: `referenced-as-value` 19,
`implements-outside-interface` 13, the build-tag reason 1 (`debug.Config` in
`config_enabled.go`, #14752).

### Before the fixes

| metric | before | after |
| --- | --- | --- |
| function precision | 98.6% (12 extra rows: 3 func types, 9 from a harness filter, see D1 and H1) | 100% |
| vta callers missed on a **complete** answer | 2 changes (D2) | 0 |
| header changes right | 189/189, but 142 of them because both sides read `interface{}` → `any` as a type change (D3) | 189/189, those 142 now `body` |
| #14278 rows drawn red ("callers not updated") | 132 | 0 |

## Disagreements and defects

### Fixed

- **D1. A func type was a function** (`src/languages/go/provider.js`). gopls gives
  `type RequestOption func(*requestConfig)` (#14104), `type renderFunc func(...)` (#14475) and
  `type newCmdFunc ...` (#10811) the Function symbol kind, with the range at the type's name;
  each was listed as an added function. `collectGoSymbols` now keeps only declarations whose
  range starts with `func`. Test: `server-symbols.test.js`, "a type whose underlying type is a
  function is not a function".
- **D2. Calls through an interface declared outside the workspace were not listed, and the
  answer read complete** (`src/languages/go/editor-extras.js`). `(telemetryDisablerTransport).RoundTrip`
  (#14104, an `http.RoundTripper`): vta has 6 callers we did not list, one in the repository
  (`(capiTransport).RoundTrip` calls it through its wrapped `http.RoundTripper`), and the
  answer was complete ("reaches 5 callers"). `(GhEditor).Prompt` (#14278, survey's `Prompt`
  interface, called by `survey.Ask`): complete, "all callers updated" — drawn as fine.
  G4 assumed gopls lists interface callers; it does for interfaces in the workspace (G0), not
  for these. Now, for a method, the Go extras ask the server for its implementations; if any
  is outside the repository, the answer is incomplete with `implements-outside-interface`
  ("it is a method that shares an interface with code outside this repository, so calls
  through that interface are not listed"); a failed or empty-handed implementations query is
  incomplete too, with its reason. Cost: one `implementations` query per changed method
  (0.06–4.3 s on cli/cli); 13 changes in the corpus are now incomplete for this reason, all of
  them methods of standard-library or dependency interfaces (`error`, `io.Reader`,
  `io.Writer`, `io.Closer`, `flag.Value`, `json.Marshaler`/`Unmarshaler`,
  `http.RoundTripper`, survey's `Prompt` and `WriteAnswer`); 7 have vta callers we do not
  list, 6 have none in vta's graph. Tests: `go-editor-extras.test.js` (outside, inside only, none, no answer,
  rejection, function not asked, unreadable not asked, value use first) and
  `tree-row-models.test.js` (the sentence).
- **D3. `interface{}` → `any` read as a type change** (`src/languages/go/provider.js`, `goKindsOf`).
  `any` is an alias of `interface{}`; #14278's `go fix` rewrite changed 142 headers and nothing
  for any caller, but each was `type-changed` and 132 rows were red because their callers were
  not edited. Both sides' types are compared with every empty interface written `any` (the
  signature shown is unchanged). The oracle had agreed only because go/printer prints each as
  written; it now compares `interface{}` and `any` as the same type. A package that declares
  its own `any` would read its change as none (not seen in cli/cli). Test:
  `server-symbols.test.js`, "interface{} and any are the same type to a caller".

### In the harness (no product change)

- **H1.** The pipeline's rows of other languages (#14475's `.mjs` files, through the
  TypeScript provider) were compared as Go rows; the comparison now takes `.go` rows only.
- **H2.** gopls answers `textDocument/implementation` with `null` for a method that
  implements nothing; VS Code turns that into `[]`, the harness passed `null` on, which the
  D2 check read as "no answer" (139 changes). `harness-languages.js` now returns `[]`, as the
  editor's services see it.
- **H3.** Oracle (b) first ran in the clone's root module only; #14475's functions live in a
  nested module, so static had 0 callers for 645 of ours. Each changed module is now run.

### Explained, not fixed: the 448 callers static does not have

- **308 are vta edges:** calls through an interface or a function value that do reach the
  function (gopls lists interface callers with direct ones, G0). Real callers.
- **107 are interface calls that vta shows never reach this type** (measured once with
  `-algo cha`, since dropped to keep the run short: all 107 are cha edges). 75 are `ExportData`
  methods called through `cmdutil`'s exporter interface, where vta finds no value of that type
  flowing; the rest are telemetry `Finish`/`Begin`/`Upsert*` calls. gopls answers by type
  (CHA), which is sound and over-reports. Effect: such a caller can count as "not updated"
  (conservative direction).
- **23 are sibling implementations:** a call on a concrete type that gopls reports for every
  other method implementing the same interface method. E.g. `TestServiceCopiesRecordedEvents`
  calls `(*service).Record` on the concrete type, and is listed as a caller of
  `(EventRecorderSpy).Record`; `hash.Write(...)` on a `hash.Hash` is listed for
  `(tailBuffer).Write`. Wrong callers, over-reported; a signature change to a spy would show
  callers that are not its own as not updated. Follow-up F1.
- **10 are in an inactive build file of the nested module:** `process_other.go` (`!unix`) in
  #14475. gopls answered the call hierarchy there (at the root module it rejects such a file
  with "no package metadata", G0), listing the callers of the shared name, which on darwin
  call `process_unix.go`'s functions. Those calls do reach `process_other.go` on non-unix
  builds, so the list is right for the file's own build; it is complete only for that build,
  and the row does not say so. Follow-up F2.

### Missed callers

None against static (0 of 2751). Every vta caller we do not list (26 changes) sits on an
incomplete answer: 19 `referenced-as-value` (constructors passed to test helpers, functions
stored in struct fields or passed on), 7 `implements-outside-interface` (D2).

## Timings

Fresh gopls per PR, gopls' disk cache warm, oracles cached (so the machine is otherwise
idle): first result (changed rows published by `onPrepared`) 2.7–6.3 s for most PRs and 14.0 s
for #14278 (251 files); full result 3.4–10.6 s and 29.4 s. Cold vs warm, measured with
`--timings` on two PRs, idle machine:

| PR | gopls start | cold first / full | warm first / full |
| --- | --- | --- | --- |
| #14752 (11 Go files) | 0.15 s | 2.4 s / 3.1 s | 0.5 s / 0.6 s |
| #14278 (251 Go files) | 0.17 s | 11.1 s / 23.3 s | 8.0 s / 20.6 s |

Warm results equal cold ones. #14278 stays slow warm: 251 base-side symbol requests through
temporary files and 361 caller queries (plus one `implementations` per method).
"Cold" is a fresh gopls process with a warm disk cache, as in G0; a cold disk cache was not
measured.

## Running it

| run | wall time |
| --- | --- |
| uncached, 10 PRs (oracles and pipeline side by side; 3 PRs' oracles at once) | 154 s |
| cached oracles (a re-run after a src/ fix: the pipeline only) | 77–90 s |
| first version (callgraph per algorithm and cha, serial, cold + warm every PR) | ~18 min |

The run's budget is 9 min (`--deadline-ms`); past it every child is killed, the clone goes
back to its branch and the run exits 2.

## Follow-ups

- **F1.** Sibling implementations in gopls' callers (23 here): drop a caller whose call
  site's definition (`definitions` at the site) is neither the target nor an interface method
  it implements. Needs a `definitions` query per caller site; measure the cost first.
- **F2.** A function in a file outside the active build is answered in a nested module
  (gopls lists the shared name's callers) but rejected at the root (G0). Decide whether such
  an answer should say "for the build that includes this file", and check with the real Go
  extension, which may pass build flags.
- **F3.** No receiver change in ~410 recent PRs: the `T` ↔ `*T` path is unit-tested only.
- **F4.** The harness's base-side symbol requests dominate warm time on large PRs (#14278:
  8 s of 20 s); worth measuring in the editor before optimising.
- The owner's manual pass in VS Code (plan G7) has not been done.
