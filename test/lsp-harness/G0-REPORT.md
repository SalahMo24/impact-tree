# G0 report: what the editor's Go support gives us

Measured with `node test/lsp-harness/g0-spike.js <cli clone>` on cli/cli, branch `pr-14752`
(base `base-14752`). Machine: Intel Mac (MacBook, i7-9750H, 12 threads, 16 GiB, Darwin 25.6),
`gopls v0.21.0`, go 1.27.3, node 22.16. One run; the gopls on-disk cache was already warm
(earlier indexing of this repo), so "cold" below means a fresh gopls process, not a cold disk cache.
The VS Code side (item 2's real-editor half) is from vscode-go source, not run in the editor.

## 1. documentSymbols on `internal/config/refreshable.go`

- Hierarchical `DocumentSymbol`s. Top-level kinds: Function 12, Method 16, Constant 4,
  Variable 3, Struct 1. All 28 `func` declarations are present, no extras.
- `range` covers the whole declaration: starts at `func` and ends at the closing `}` for 28/28.
  It does NOT include the doc comment above (18 of the 28 have one; it is outside `range`).
- `selectionRange` is exactly the bare name (28/28), so `namePos = selectionRange.start` works,
  also for methods (it points past the receiver, at `withFreshConfigForRefresh`).
- `name` for methods includes the receiver: `(*AuthConfig).withFreshConfigForRefresh`
  (kind Method). Plain functions: `flockRefreshLock` (kind Function).
- `detail` is the signature without name or receiver, e.g.
  `func(hostname, username string, credential gh.Credential, gitProtocol string, secureStorage bool) (bool, error)`
  (grouped params kept as written). The receiver is only in `name`. Parsing the header from the
  source text between `range.start` and the body is still needed for generics and exactness.
- Nested function literals: not listed. 0 of 28 functions have children, though the file has 5
  `func(` literals. A literal is simply part of its parent's body, as G2 assumes.

## 2. Base-side documents (refreshable.go at `base-14752`, 30 funcs)

| variant | result | time |
| --- | --- | --- |
| (a) `impacttree-base:/internal/config/refreshable.go?ref=...` via didOpen | error `-32700 DocumentURI scheme is not 'file'` | 1 ms |
| (b) `untitled:Untitled-1` | same error | 1 ms |
| (c) temp file outside the module (os.tmpdir) | 38 symbols, 30 funcs, correct; prepareCallHierarchy works | 684 ms (first file outside the workspace) |
| (d) same name in a scratch dir under the module | 38 symbols, 30 funcs, correct; prepareCallHierarchy works | 110 ms |

gopls only accepts `file:` URIs. In the real editor it never sees (a)/(b) anyway: vscode-go's
`GoDocumentSelector` (extension/src/goMode.ts) is `{ language: 'go', scheme: 'file' }` (plus go.mod,
go.sum, go.work, go.asm, gotmpl, all `file`), with the comment "gopls handles only file URIs". So
`vscode.executeDocumentSymbolProvider` on a virtual or untitled document gets nothing from the Go
extension. Symbols are syntactic, so a temp file outside the module is answered correctly.

## 3. incomingCalls

- `simulateRefreshTokenExpired`: 1 caller, `refreshCredentialForUser` (as expected).
- Calls through an interface ARE included. `(*AuthConfig).ActiveTokenWithRefresh` (config.go) gave
  7 callers, among them `AddAuthTokenHeaderWithRefresh` in `api/http_client.go`, which calls it
  only through the `refreshingConfig` interface, and `RoundTrip`/`helperRun` (other interfaces).
  The interface method `gh.AuthConfig.ActiveTokenWithRefresh` gives the same 7. So for
  a concrete method the answer is not missing interface callers, but the callers also cannot be
  told apart from direct ones. `implementations` works (concrete: 4 locations, 1.5 s; interface: 2).
  Not tested: calls through an interface whose method set is satisfied only structurally by an
  external package.
- `_test.go` callers ARE included (`TestActiveTokenWithRefresh`, `TestConfigIgnoresEnvironment`).
  Only the file URI tells them apart, as G4 plans.
- Build tags: `debug.Config` in `config_disabled.go` (`!ghdebug`, active under default tags): 4
  callers (refreshable.go x2, factory/default.go, a test). In `config_enabled.go` (`ghdebug`):
  `prepareCallHierarchy` fails with `no package metadata for file`, a real error (not an empty
  answer), while `documentSymbols` still returns the 2 symbols. So callers for the inactive
  variant are neither found nor silently empty; the callers listed for the active one are the
  call sites of the shared name. G4's "other tags not searched" note is justified, and
  `prepareCallHierarchy` rejecting must map to "incomplete", not "no callers". Check in editor:
  the Go extension may pass build flags; not tested.

## 4. references vs call hierarchy for values

`noArgsConstraint` is only ever used as a value (`Args: noArgsConstraint`, 11 files). gopls'
`incomingCalls` returned 11 callers (the enclosing `NewCmd*` functions) and `references` returned
11 locations, matching `git grep` (12 files incl. the definition). So gopls' call hierarchy already
includes non-call references; it does NOT miss value uses. Consequence for G4: `incomingCalls`
cannot say whether a caller calls or merely mentions the function, so "referenced as a value" has to
be derived by comparing `fromRanges` with the source text at those ranges (is the next char `(`?),
not by comparing counts against `references`. (`deleteRun`, called in a closure: 1 caller,
`NewCmdDelete`, 1 reference. The `runF` parameter is not a reference to anything.)

## 5. Timings

| step | time |
| --- | --- |
| spawn + initialize | 216 ms |
| first documentSymbols (refreshable.go), incl. gopls "Setting up workspace" | 2.20 s |
| first prepareCallHierarchy / first incomingCalls | 19 ms / 85 ms |
| spawn to first incomingCalls answer | 2.9 s |

gopls loads packages lazily per file: "Finished loading packages" at 2.8 s. The ~100 s seen
earlier was not reproduced here (it likely was a cold gopls disk cache or whole-workspace work).
Warm, n=10 each: prepareCallHierarchy median 2 ms; incomingCalls median 5 ms (max 422 ms);
references median 5 ms (max 179 ms); implementations median 59 ms (max 1.19 s); documentSymbols on
a newly opened other file median 27 ms (max 2.78 s when its package loads); on an open file 14 ms.
Deadlines of 30-60 s per request stay far above these; first calls into a not-yet-loaded package
can take seconds.

## Recommendation for gate L1

Choose (b): write the base text to a temp file with the SAME file name and ask once. Reasoning:
(a) is impossible both in gopls (hard error on non-`file:` URIs) and in the editor (the Go
extension's selector is file-only), so a virtual document gets no symbols from it; (c) fails only on
nothing measured. Put the temp file outside the module (extension storage), not in the repo:
symbols are syntactic and came back correct (30/30 funcs) and it keeps the working tree clean; (d)
is faster (110 ms vs 684 ms for the first one) but writes into the user's module and can disturb
the package. Keep (c) header matching as the fallback when writing fails. Base symbols only need
`documentSymbols`; call hierarchy always runs on the head. Open point to confirm in a real editor:
that `executeDocumentSymbolProvider` on a freshly written temp `file:` URI outside the workspace is
answered by the Go extension (vscode-go's selector accepts it by scheme; workspace membership was
not required by gopls here).
