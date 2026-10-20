# Correctness and performance fixes

Status: implemented on `fix/correctness-and-perf`, not committed or packaged.

## Reported bugs addressed

- Shared/local analysis: map all affected callables in a hunk, distinguish accessors/overloads/nested declarations, collect anonymous default and CommonJS exports, label modified constructors correctly, and support older TypeScript modifier/decorator APIs.
- Git/diff handling: preserve rename identity, Unicode and spaced paths; ignore external diff/textconv/color output; distinguish deletion gaps from surviving lines; include untracked working files while excluding their callers from committed reviews, including lazy expansion.
- Graphs: retain recursive components and self-recursive roots; match constructor caller aliases; use the same root selection in local and remote analysis.
- Resolution: follow solution tsconfig references, report excluded files as unknown, classify tests relative to the repository, clear analysis caches and editor statistics, and retain callers when inheritance cannot be established reliably. Lexical bindings and inherited tsconfig aliases no longer cause genuine inherited callers to disappear.
- PR analysis: refresh metadata, compare against the merge base, detect revision changes during file-list loading, resolve named/default/namespace/CommonJS imports and renamed re-exports, and read path-alias configuration from the pinned PR head. Missing package-based tsconfig extensions are reported rather than silently assumed.
- CQRS: associate dispatches only with the handler entry method and include all declared events; do not attach dispatches to helper methods.
- GitHub client: paginate open PRs, detect file-list truncation at an exact cap, preserve authentication on 403/rate limits, and reject unsupported JSON file responses instead of parsing them as source.
- Editor: isolate preview documents by PR and revisions, preserve earlier previews, refresh the selected PR, persist checkpoints in workspace state, save mode selection at workspace scope, and normalize relative paths.
- Review progress: scope caller/file-group ticks to their parent; identify symbols by qualified name and hashes of both revisions; retain ticks after unrelated offset/base movement and invalidate changed content; update tooltip and summary counts immediately.
- Performance: batch diff ranges and base blobs, fetch asynchronously with a timeout and explicit remote-tracking refspec, and avoid blocking the extension host during checkout commands.

## Verification

- `npm test`: passes, including the previously omitted local-analysis suite and 22 new regression tests.
- New tests cover synthetic cases with expected results, a real TypeScript language service for CQRS, mocked GitHub responses, extension command/provider integration, checkpoint reload, resolver statistics, Windows path semantics, and async Git timeout/event-loop behavior.
- The default public target has no diff against main, so its caller/tree checks skip in the default run. They were also explicitly run against a non-empty range in the existing sibling T3 Code clone (HEAD `9a609a4e`):
  - `IMPACT_TREE_BASE=HEAD~20 node --max-old-space-size=8192 test/callsites.test.js`: passed; 288 call-site offsets checked, zero wrong.
  - `IMPACT_TREE_BASE=HEAD~20 node --max-old-space-size=8192 test/tree-smoke.js`: passed, including lazy expansion, file grouping, review state, and root visibility.
- `node spike/tier-a-git.js ../t3code HEAD~20`: completed against the same public history. This is an integration exercise, not a precision/recall ground-truth measurement or a before/after performance benchmark.
- `git diff --check`: passes.

The tree smoke test previously used the highest-scored finding's project resolver for every visible root. It now routes each query to the correct project. Its warning and icon assertions were also corrected to handle valid no-warning results and test callers; production assertions remain enabled.

No live VS Code/Cursor UI session was exercised, and the checked-in VSIX has not been rebuilt. Existing offset-based saved review ticks are not migrated to the new content-based format because they contain no content fingerprint to validate.

## Newly found issue left outside this change

Tier A still misses static class-method calls:

```ts
// store.ts
export class Store { static save() {} }
// use.ts
import { Store } from './store';
export function caller() { Store.save(); }
```

Querying callers of `Store.save` returns an empty list instead of `caller`. This is separate from the reported instance-receiver/import fixes and does not block them; it was reproduced and deliberately left unchanged under the requested scope boundary.

## Follow-up report fixes (2026-09-27)

Implemented the six remaining confirmed issues, without expanding language support:

- Removed the per-package `node_modules` gate from analysis and editor warm-up. Compiler loading now uses its existing project/root/bundled fallback; hoisted packages are analysed.
- Retained rename base paths in results and findings. Symbol, file, and caller diff navigation all use the old path for local base content.
- Stopped attributing nested callable bodies' throws to their enclosing function. This is syntactic ownership, not exception propagation analysis.
- Aligned parameters before comparing signatures, so middle insertions do not misclassify shifted parameters. Making a parameter optional or adding its default receives a distinct `optional-param-changed` category with the existing optional-risk weight (70); making it required retains weight 25.
- Editor empty results become `none` only after successful call hierarchy and reference queries find no references outside the declaration. Callbacks, unavailable providers, and failed queries remain `unknown`; constructor/DI and CQRS handling remain conservative.
- Guarded the test-reachability command in PR preview with an explanatory message, preserving the selected preview.

Validation:

- `npm test` passed; the focused regression suite now contains 24 tests. New/expanded cases cover all six fixes, including actual base-document content for all three rename navigation commands. The final provider-no-result guard was additionally verified with the focused suite.
- Explicit T3 Code `HEAD~20` tree smoke validation passed, including lazy expansion and review state.
- Explicit T3 Code `HEAD~20` caller-location validation: 288 locations checked, zero mismatches (HEAD `9a609a4e`). The default suite still skips caller/tree checks when its target has no diff.
- Independently inspected pinned PR diffs before comparing output: #12745 (`e1cbb705`, locale week start) and #12954 (`742173a1`, project settings). Local and preview pipelines produced respectively 2 and 26 changed symbols. The new locale helper, enclosing UI change, and settings optional-parameter classification matched expectations. The locale constant use did not invent a direct UI-to-helper call.
- The external checks also exposed missing cross-project callers, described below. Therefore the external validation is **not** a clean graph-completeness pass.
- Reproduce the pinned snapshots with `node --max-old-space-size=8192 test/t3-pr-snapshots.js`. It reads the existing target clone, creates/removes a temporary shared clone, and reuses installed dependencies. It preserves missing-caller expectations as failures (nonzero exit); it is deliberately separate from the default suite. Dependencies come from the existing clone rather than a fresh historical install.

### Additional out-of-scope finding

In T3 Code PR #12954, `packages/shared/src/projectSettings.ts` exports `resolveProjectSettings`. The changed `apps/web/src/components/settings/scopedSettings.ts` contains real calls from `resolveScopedSettingsTargets` and `planScopedSettingsPatch`, but neither pipeline reports those callers:

- Local analysis only queries the shared package's language-service project; it does find the same-package `resolveWorktreeCleanup` caller and test letreferences.
- PR preview reports no callers for the target across the workspace package import (`@t3tools/shared/projectSettings`).

These are cross-project/cross-package resolution gaps, independent of whether a hoisted package is admitted to analysis. They do not block the six scoped fixes and were left unchanged. The external harness retains four failing expectations (two callers across two pipelines), rather than weakening its oracle to accept the omissions. PR preview also reports the unavailable package-based `expo/tsconfig.base` extension explicitly.

The previously noted static-method preview gap remains outside scope. The report's stale README status and fork tooltip are also noted but unchanged in this bug-only pass. No live editor session, packaging, commit, or push was performed.

## Workspace and static-call follow-up (2026-09-27)

The preceding changes were staged at the user's request before this work began.
The following changes are intentionally left unstaged; no commit was created.

The three resolution gaps documented above are now addressed:

- Local analysis builds a reverse project-import/reference graph, including test configurations, and queries consuming projects even when their files are unchanged. TypeScript resolves package imports and aliases; callers and individual call sites are deduplicated. Services and document registries are reused within an analysis and disposed afterward. Standalone/lazy resolvers use the same project discovery. Changed-state labels are finalized across all components.
- PR preview reads ancestor package manifests at the pinned head and exposes workspace package exports to TypeScript's virtual module resolver. Explicit subpaths, wildcard exports, and import/require conditions are covered. Metadata alone never adds a source file to caller coverage; only available PR sources supply edges. Unavailable metadata is reported and ambiguous package names are not guessed.
- Static calls resolve class bindings, including aliased and namespace imports and inherited static methods. Static `this`/`super` are distinguished from instance receivers. Shadowed variables, unrelated classes, and instance access to static methods do not invent edges.

Validation includes unchanged consuming projects, lazy queries, duplicate callers,
private/unexported package paths, pinned metadata reads, distinct import/require
exports, and static receiver negatives. The focused suite now has 29 passing tests.
The full default suite passed before the final conditional-export case; that case
and the affected preview suite were then rerun successfully.

The pinned T3 Code snapshots (#12745 and #12954) now pass with **zero missing caller
expectations**. Both local and preview analysis find `resolveScopedSettingsTargets`
and `planScopedSettingsPatch`, with `updated-at-call` and `changed-elsewhere` states
respectively. Preview was rechecked after adding conditional export handling. The
known unavailable `expo/tsconfig.base` warning remains explicit; support for external
package-based configuration is not part of these fixes.

The external harness now preserves workspace package symlinks inside its temporary
historical checkout rather than directing them into the original clone. It also
uses the canonical temporary path so TypeScript's realpath resolution matches file
identities. Installed third-party dependencies are still reused from the existing
clone; this is not a historical dependency reinstall.

The explicit T3 Code `HEAD~20` caller-location check now verifies **422 locations,
zero mismatches**, versus 288 before workspace caller discovery. These counts verify
reported locations, not complete graph recall. The tree smoke test now selects a
root with known callers for its expansion and review checks; the top-ranked root
can legitimately be a React callback with no direct incoming calls.

Final tree verification: `IMPACT_TREE_BASE=HEAD~20 node --max-old-space-size=8192
test/tree-smoke.js` passed, including lazy expansion, file grouping, review state,
and cycle handling. The test expands file groups and checks that all 22 known
callers remain reachable. It defers test-reachability computation because this
suite exercises tree rendering/navigation; test reach remains covered by the
local engine suite. Workspace-wide local queries load more projects and can take
longer; no before/after performance benchmark is claimed.

## Invented and hidden callers (2026-09-29)

Five review findings where the tree stated a wrong answer as fact:

- **Shadowed imports.** `bindingAt` now sees every enclosing declaration form: destructured parameters, `for-of` and `catch` patterns, `switch` clauses (one scope per `switch`), hoisted `var`, nested class/function/enum declarations and a named function expression's own name. A static call on a class declared in scope resolves to that class, not an import of the same name.
- **Typed locals in `switch` clauses** keep their receiver type in PR preview.
- **Export conditions.** Preview asks TypeScript for each importer's module format (nearest `package.json` `type`) and each import's resolution mode, instead of guessing from the extension. A `.ts` importer in a CommonJS package now takes the `require` condition. Unnamed manifests are kept for format detection only.
- **Untracked callers** in `pr` mode are filtered at the resolver, so the caller list, the test-reach walk and the tree agree.
- **Editor labels.** `callerState: 'none'` shows `∅ no callers found`, not `✓ all call sites updated`. Editor resolvers expose `incomingWithStatus`. A caller query that failed or did not finish is not cached, and the expanded row says "Callers could not be loaded" or "More callers may be missing". A failed command-bus lookup no longer yields `none`.

Verification:

- The export-condition test uses real TypeScript on disk as its oracle across nodenext/node16/bundler × package type × `.ts`/`.mts`/`.cts`.
- Each new test was checked to fail against the previous code.
- `npm test` passes.
- `IMPACT_TREE_BASE=HEAD~20` tree smoke and call-site checks against T3 Code pass (422 locations, 0 mismatches), as do both pinned PR snapshots (0 missing callers).
- No live editor session was run.

## Review ticks, first render and checkout ownership (2026-10-01)

- **One tick, one row.** Deleted rows are identified by their own base slice (by symbol key), not the file. A caller the symbol collector does not record (a named function expression, module-level code) is identified by its own declaration text. Before, both fell back to the whole file, so ticking one ticked every such row in it.
- **Preview identities come from the PR.** A preview builds identities from the fetched head/base texts only. Files it did not fetch are identified by GitHub's blob sha plus a hash of the listed patch, and get no persisted identity when GitHub gave neither. The local checkout is never read.
- **First render.** Local identities reuse `result.baseTexts`, which now also holds changed tests and sources outside a project. Whole-file rows use one `git cat-file --batch-check`. Identity entries keep ids and hashes, not syntax trees.
- **Checkout ownership.** A checkout refuses to start, or to continue after its confirmation dialog, while another checkout or an analysis runs. Refresh and preview are refused while a checkout runs. The checkout pins `FETCH_HEAD^{commit}` and checks out that sha.
- **Refresh repeats what is being viewed.** The source (local, or a PR) is recorded before the run, so Refresh after a failed preview retries the preview.
- **Completeness.** A resolver that cannot report whether its search finished is shown as incomplete ("More callers may be missing"), not complete. The untracked-caller filter also covers `incomingWithStatus`.

Measured on T3 Code at `HEAD~20` (161 rows, 92 changed files, Apple Silicon, node 22, 5 cold runs each; the analysis itself is excluded):

| | Before | After |
| --- | --- | --- |
| Identity build, median | 4.29 s | 1.45 s |
| git processes | 92 (`git show` per file) | 1 |
| Heap retained by identities | +6 MB | +4.8 MB |
| Rows with an identity | 125 | 125 |

Verification:

- New tests for each bug in `test/bug-regressions.test.js` and `test/extension-commands.test.js`. The extension tests use hand-resolved promises for every interleaving. Each test was checked to fail against the previous code or a targeted mutation of the fix.
- `npm test` passes. With `IMPACT_TREE_BASE=HEAD~20`, the tree smoke and call-site checks (422 exact, 0 wrong) pass against T3 Code, as do both pinned PR snapshots.
- No live editor session was run.

## Projects without a config, and CommonJS (2026-10-01)

The extension found no call graph on its own source: a plain CommonJS repository with no
`tsconfig.json`.

- **Projects are found the way the TypeScript server finds them.** The nearest
  `tsconfig.json` or `jsconfig.json` defines a project (tsconfig wins in the same
  directory; jsconfig gets the server's JavaScript defaults). A file with neither belongs
  to one inferred project per repository, and the run says so. Before, such files were
  dropped before analysis, with no warning.
- **Cross-file callers TypeScript cannot report come from the syntactic index.** This
  applies to a target file in two cases, both properties of the file:
  - it exports through `module.exports` / `exports.x` (TypeScript's call hierarchy does
    not follow `require()` back to a declaration);
  - no config claims it (the editor's inferred project holds only open files).

  The index covers every source file git lists in the worktree and is built only when a
  query needs it. Its callers are merged with TypeScript's, in analysis and in the
  editor's lazy expansion.
- **Scope:** static `import`, and `require()` with a string literal (destructured,
  namespace, and `require('./m').fn()`), resolved through relative paths and workspace
  package names. Not covered: tsconfig `paths` and bundler aliases for these files. A
  `require()` with a computed path is named in the run's warnings. Files over 1 MB, or
  beyond 20,000 files, are not indexed; the answer is then incomplete, never "no callers".

Verification:

- New cases in `test/local-analysis.test.js`. Each was checked to fail with its fix
  removed: no index, jsconfig ignored, no `require('./m').fn()` receiver, a shadowed
  `require` parameter counted, no-config files dropped, and an unfinished index search
  treated as complete.
- `npm test` passes. With `IMPACT_TREE_BASE=HEAD~20` against T3 Code, the call-site check
  (422 exact, 0 wrong) and tree smoke pass. No file there qualified for the index, so it
  was never built.
- On this repository's uncommitted split of `extension.js`, every split module now
  resolves to its real caller, for example `registerCommands` → `activate`.
- No live editor session was run. The editor path is covered by a stub resolver that
  answers "no callers", as the server's inferred project does for closed files.

## Progressive review loading (2026-10-06)

Local and checked-out PR reviews publish changed files and symbols before waiting
for language-server warm-up or caller resolution. PR previews publish their pinned
texts and changed rows before configuration/package lookups and caller indexing.
The tree says **Resolving callers…** and pending symbols have explicitly incomplete
caller coverage. Early rows are detached snapshots; late resolver mutations cannot
change their verdicts. Review identity is configured at both publications, retaining
checkboxes ticked while callers load. Replaced, cancelled and disposed runs cannot
publish either stage.

Language-provider commands have a 5-second wait deadline; warm-up has a 15-second
total deadline, including an in-flight command. The editor API cannot cancel commands,
so their eventual rejection/result is observed and dropped. At most 32 underlying
commands remain outstanding across runs; timeouts do not free those admission slots.
Failures/timeouts appear as incomplete caller evidence, including CQRS lookups.

The editor's repository-wide module caller index now runs in a session-owned worker.
Each prepare/query has a 30-second deadline and the worker has a 1 GiB old-generation
heap limit. Source admission remains capped at 20,000 files and 1 MiB per file, with
an additional 64 MiB aggregate limit. Exhaustion reports incomplete coverage. A
completed index is reused only after the worker checks HEAD, compiler identity,
source/config/package paths, sizes and nanosecond modification/change times. New
analyses reset symbol hints. Cancellation terminates the worker; session disposal
terminates it and rejects pending requests. The CLI retains its synchronous adapter.

Verification: `test/loading.test.js` covers early opening/ticking, final checkbox
retention, stale publication, real worker callers and cache invalidation, cancellation,
worker/provider deadlines, late rejection and outstanding-provider admission. It runs
in `npm test` and `test:smoke`. Lint/typecheck and the available test suite pass. The
default recorded-fixture and target caller/tree checks skip because their target has
no suitable diff or recorded fixtures. These checks do not replace validation
of the new build in a reloaded live Cursor session.

## Targeted review progress updates

Checkbox state belongs to the review store; an analysis result is unchanged by a
mark. `tree-provider` now publishes an immutable review-progress notification with
its analysis ID, affected row/file IDs and changed-function file paths. A checkbox
gesture is applied as one batch against canonical rows of the displayed result;
no-op gestures and rows from an older analysis publish nothing. Consumers do not
receive the entire analysis object to diff.

Tree repaint and full presentation invalidation are separate events. Progress
refreshes each affected visible file once. A root refresh is required when a filter
adds/removes a file or changes the empty-filter hint. The first file retains its
canonical row object, and caller/message TreeItems have parent-scoped IDs so
repeated expansion reads can preserve editor-owned expansion state. These IDs are
UI identities; persisted review identities remain based on content.

Details retains its document for progress, repeated selections and tree filters.
A pure display model supplies both initial HTML and later button/count patches.
Only a relevant changed ID computes that model; an unchanged model posts nothing.
Patches update text/attributes and preserve DOM nodes, focus and scroll. New
selection or analysis still builds a fresh document/token. Both patch delivery and
actions validate the current token, and actions additionally check the owning
analysis. A ready handshake resends current fields if progress happened before the
browser installed its listener. Hiding/showing the webview can still reload it.

Decoration registration compares badge, color and tooltip values. Changed URIs
are deduplicated and flushed by one provider-owned timer per event-loop turn;
unchanged decorations fire no event. CodeLens invalidation remains global because
that is the editor API's contract, but function marks batch into one notification
per turn. Plain-file marks and tree filters do not invalidate lenses. Disposal
cancels both timers and releases provider-owned maps/emitters.

`test/review-updates.test.js` exercises all three marking routes, group/no-op marks,
filtered removal/restoration, canonical and child IDs, stale analysis rows,
CodeLens/decoration batching and disposal, and the webview ready handshake. The
Details harness executes the generated browser script against a small DOM adapter.
In the controlled expanded-tree reproduction, an ordinary mark now causes zero
Details document replacements, one affected-file tree event, and zero decoration
events after initial decorations have settled. The characterization fixture's
only changed expectations are decoration flush counts: 36 -> 1 for local states
and 9 -> 1 for preview states. This verifies event behavior, not live pixel flicker
or the separate intermittent loss of editor diff highlighting.

## CQRS parsed-file lifetime across editor refreshes (2026-10-11)

The editor resolver kept one CQRS helper for the whole window. Its parsed-file
map retained full syntax trees for every queried file, including ordinary files
checked for handler decorators. Clearing caller answers on refresh did not release
that map, so visiting different files across analyses accumulated ASTs.

The editor now creates a helper per analysis generation. A query captures its
generation's helper before awaiting any provider. Refresh replaces the current
helper; an obsolete query can finish using its own cache, and the existing
generation check rejects its answer. Its ASTs become collectible when the last
query using that helper settles. This avoids allowing late provider completions to
populate the new generation's cache. The parser, CQRS matching rules, file metadata
checks, provider admission limits, and same-generation reuse are unchanged. The
CLI still creates helpers per project resolver. There is no new size cap within a
single generation; this change addresses retention across refreshes only.

Measured from baseline `681c75ef48c981e7f50c16b61680f9ebfa353aa4`, Node 22.18.0,
arm64, five fresh processes per workload and version, each under a 512 MiB old-space
limit. Each process queries three disjoint groups of 100 files. Heap is the increase
over process baseline, measured after an event-loop turn and forced GC. The real
workload is the first 300 eligible tracked T3 Code source files (excluding `.d.ts`,
at most 128 KiB each), at `9a609a4e444ba739d6fcd607769d68b679b0bcc5`.
The synthetic workload contains 300 named functions per file. Immediate empty
editor-provider responses isolate host parsing and cache costs; these numbers do
not measure language-server indexing, a live editor, or low-spec hardware.

| Measurement, median | Before | After |
| --- | --- | --- |
| T3 source admitted, 300 files | 0.76 MiB | 0.76 MiB |
| T3 retained heap after clearing generation 1 / 2 / 3 | 8.38 / 13.79 / 21.56 MiB | 1.77 / 2.21 / 2.56 MiB |
| T3 populated heap in generation 3 | 21.62 MiB | 10.17 MiB |
| T3 cold query batch, first 100 files | 71.66 ms | 71.03 ms |
| T3 same-generation query batch, 100 files | 4.65 ms | 4.34 ms |
| T3 query batch after refresh, same 100 files | 4.52 ms | 34.31 ms |
| Synthetic source admitted, 300 files | 4.49 MiB | 4.49 MiB |
| Synthetic retained heap after clearing generation 1 / 2 / 3 | 66.07 / 131.01 / 195.95 MiB | 1.45 / 1.77 / 0.18 MiB |
| Synthetic populated heap in generation 3 | 196.01 MiB | 64.87 MiB |
| Synthetic query batch after refresh, same 100 files | 19.72 ms | 118.59 ms |

Reproduce with `node --expose-gc --max-old-space-size=512
test/measure-cqrs-cache.js synthetic` or replace `synthetic` with the T3 clone path.
The script is a manual benchmark, outside `npm test`; timings and GC are not CI
assertions. The memory benefit costs reparsing after refresh: about 30 ms per 100
T3 files in this isolated workload. Residual heap includes line-position data and
runtime allocations; the measurement is not an assertion of zero total retention.

Validation before and after:

- Full `npm test`, lint, and typecheck passed. Default target-dependent call-site
  and tree cases skipped on the empty diff against `main`; no recorded fixtures
  were present. The separate nonempty-range checks below were also run.
- `IMPACT_TREE_BASE=HEAD~20` call-site validation checked 427 locations with zero
  mismatches on both versions; its output was byte-identical.
- The new `test/cqrs-cache.test.js` lifetime and obsolete-query tests failed against
  the original implementation and passed after the change. Its independent
  behavior check passed on both, covering command/event dispatches, nested callers,
  multiple sites, test filtering, non-entry methods, and incomplete lookup recovery.
- Pinned T3 PR #12745 local/preview checks passed on both versions. The snapshot
  suite then failed on #12954: `resolveScopedSettingsTargets` was classified
  `changed-elsewhere`, where the existing check expects `updated-at-call`.
- The nonempty-range tree smoke failed on both versions with an outside-row
  `ranges.filter` exception in `describeOutsideRanges`. Both failing suites' full
  outputs were byte-identical before and after; their expectations were not changed.
- New test/benchmark files passed ESLint, and `git diff --check` passed. No live
  Extension Development Host acceptance run was performed.

Recommendation: retain this narrowly scoped change. It removes the demonstrated
cross-refresh AST accumulation, preserves checked CQRS behavior, and has a measured
refresh parsing cost. The two existing external validation failures remain open.

## Rejecting irrelevant CQRS handler files before parsing (2026-10-11)

Baseline: `67ae82cf0ccc0b39896911ef0fdd4c2065c874eb`, after the cache-lifetime fix
above. Both editor and CLI caller queries ask the shared CQRS helper whether a
symbol is a handler. Previously, even a file with no supported decorator name was
parsed and traversed for that check, then traversed again for extra callers.

The helper now skips handler parsing only when all three names recognized by the
existing exact matcher (`CommandHandler`, `QueryHandler`, `EventsHandler`) are
absent from the source. This is a necessary-condition check, not a new decorator
parser: names in comments, strings, imports or unsupported expressions still fall
back to the existing AST path. The list is shared with the exact matcher to avoid
two independently maintained sets of supported decorators.

Skipped entries retain only file metadata and a null AST, under the helper's
existing lifetime and mtime/size invalidation. A construction or enclosing-callable
lookup still parses the file, including one previously rejected as a handler.
Failed reads are not stored as negative checks. No source text is retained for a
negative entry. Source admission limits, matching/coverage rules, provider calls,
analysis ownership, reviewed identities and checkpoints are unchanged.

Measurements use the same manual harness for both implementations, Node 22.18.0
arm64, a 512 MiB old-space limit, and the pinned T3 revision/workloads documented
above. The harness now records cold/warm parser admissions and adds `handlers`:
the synthetic ordinary source with a real command-handler decorator in every file.
Its queries remain outside the handler method, isolating the parsing fallback;
actual dispatch resolution is verified by the correctness suite.

After separate five-process before/after runs, a second comparison alternated
versions within five pairs for each workload, rotating workload order, with no
validation suites running concurrently. Only the shared CQRS helper was substituted
with its saved baseline module in the before process; the benchmark/editor adapter
were identical. The table reports first-generation medians from that alternating
comparison. Heap is the populated increase over process baseline after forced GC,
before clearing the current generation; it is not whole-extension memory.

| Measurement, first 100 files | Before | After |
| --- | --- | --- |
| T3 CQRS parser admissions, cold / warm / after refresh | 100 / 0 / 100 | 0 / 0 / 0 |
| T3 populated heap | 8.41 MiB | 0.34 MiB |
| T3 cold query batch | 114.26 ms | 27.22 ms |
| T3 same-generation query batch | 6.35 ms | 2.34 ms |
| T3 query batch after refresh | 59.45 ms | 4.24 ms |
| Ordinary synthetic populated heap | 66.14 MiB | 0.53 MiB |
| Ordinary synthetic cold query batch | 250.46 ms | 28.28 ms |
| Handler-containing control parser admissions, cold / warm / after refresh | 100 / 0 / 100 | 100 / 0 / 100 |
| Handler-containing control populated heap | 66.47 MiB | 66.47 MiB |

Handler-containing timing was noisy: alternating cold medians were 250.51 / 244.24
ms and warm medians 18.48 / 18.43 ms, while refresh medians were 156.77 / 176.34 ms.
To investigate that refresh difference, a separate shared-process experiment used
20 alternating pairs after warming both helpers, each parsing the same 100
handler-containing files with 300 functions per file. Its median was 161.57 / 166.46
ms, mean 177.71 / 175.16 ms, and ranges 139.65–241.77 / 143.72–252.06 ms. These
samples do not establish a consistent handler-file speed change; no speedup is
claimed for the fallback. The extra name scan is additional work on candidate
files. Timings are not CI assertions.

Reproduce workloads with `node --expose-gc --max-old-space-size=512
test/measure-cqrs-cache.js synthetic`, `handlers`, or the T3 clone path. Use the same
benchmark revision when comparing implementations. The host-side harness excludes
language-server indexing and other analysis work. Removing synchronous parsing
reduces host work; editor responsiveness and low-spec hardware performance were not
measured by this harness.

Validation before and after:

- Full `npm test`, lint, typecheck and the 15-test smoke suite passed. Default
  callsite/tree checks skipped on the empty diff; no recorded fixtures were present.
- The two new parser-admission regressions failed before the optimization and
  passed after. Other focused checks passed on both. The prior lifetime regression
  now uses a handler-containing file that must still allocate an AST, preserving
  that regression's purpose rather than requiring unnecessary ordinary-file parsing.
- The eight CQRS tests cover ordinary language-server callers, negative-entry
  promotion for dispatches, all three decorators, comments/whitespace, Unicode
  positions, multiple commands, false positives, same-size edits, missing files,
  deletion/recreation, test filtering, incomplete recovery and obsolete queries.
- Direct comparison with the original helper checked 1,152 handler/coverage queries
  over 64 deterministic syntax fixtures, with zero differences.
- Review/checkpoint, editor, loading and CQRS suites: 53 tests passed, zero skips.
- Additional live VS Code controls used real definition, reference and incoming-call
  providers to check all three handler decorators, ordinary callers, nested dispatch
  owners, test filtering, initial/cached/refreshed results, decorator edits and
  obsolete queries completing after a refresh. Those controls passed before and
  after. The later focused regression run passed 70 tests, with zero skips.
- Nonempty T3 `HEAD~20` callsite validation: 427 exact locations, zero mismatches,
  with byte-identical output. The #12954 snapshot mismatch and nonempty tree-smoke
  `ranges.filter` exception documented above remain unchanged; both complete logs
  are byte-identical. PR #12745 local/preview checks passed on both versions.
- Changed tests/benchmark passed ESLint; `git diff --check` passed.

## PR #50 inheritance fixes and measured cost (2026-10-12)

The local fixes preserve imported binding names (named aliases, defaults and
namespace qualification) and separate physical class identity from the path
context used to resolve ancestry. A file reached through two symlink contexts can
have different relative dependencies. Ancestry caching and traversal retain both
contexts; class comparisons use canonical physical paths and declared names.
The four reproductions are permanent tests in `test/engine-regressions.test.js`,
including both symlink query orders. Nearby export/scope controls from the preceding
review remain in the fix.

### Separate optimization review

The optional optimization short-circuited comparisons on matching lexical paths
and lazily indexed ancestors by name to avoid some canonical-path lookups. It was
removed: it is unnecessary for the regression fix and adds comparison paths and a
lazy cache. The final implementation compares canonical identities directly and
keeps an eager identity set alongside the context-keyed ancestry declarations.
No performance enhancement is required or claimed.

A separate five-pair comparison used snapshots of the same corrected code,
differing only in that optimization. Both passed the inheritance controls; the
version without it also passed all 25 engine regression tests and the existing
75-case path matrix, 80-level hierarchy, cycle, missing-file and cache-clear probes.
Every benchmark produced identical kept-caller signatures. Median milliseconds
per 100-target batch:

| Workload | Optimization cold / warm / refresh | Without optimization cold / warm / refresh |
| --- | --- | --- |
| Ordinary | 72.016 / 1.874 / 26.898 | 78.766 / 2.032 / 31.298 |
| Barrels | 212.327 / 1.859 / 148.223 | 219.349 / 1.966 / 143.256 |
| Deep hierarchy | 86.172 / 1.897 / 34.408 | 91.628 / 2.007 / 36.604 |

These observations show modest savings on most batches, with an inconsistent
refresh benefit. They do not make the optimization necessary for correctness.
Source hashes and all 30 observations are in
`benchmarks/pr50-2026-10-12-optimization-review.json`.

### Exact final-code comparison

The final inheritance source SHA-256 is
`2f580d07f6dd6f59dcf314eecbbd81c623dd0cfd2432fe2a9774993fddd83eda`.
The driver checked that it stayed unchanged throughout the run. All 80 observations
and the harness hash are in `benchmarks/pr50-2026-10-12.json`.
The before version is local commit `b1381c64facf50dbae723f72a481717e18de4192`,
before these two regression fixes. Original PR revision
`fff798ab820d2b6ce3876f3a862908bec15aff49` is an additional ordinary/barrel
control; its depth cutoff makes the deep fixture incorrect, so it is excluded there.

Environment: Node 22.18.0, arm64 macOS, Apple M3 Pro, 18 GiB RAM, 512 MiB old-space
limit, five fresh processes per version/workload. Workload and version order rotate
across rounds; children run serially, with no validation suites running concurrently.
The inheritance harness queries 100 target methods and 400 typed call sites.
Ordinary/deep fixtures have 201 files; barrels have 302. Deep subclasses have 16
intermediate classes. Every batch asserts 300 genuine caller edges kept and 100
sibling edges dropped, with identical output signatures across versions and
cold/warm/refresh. Warm samples average 50 repetitions per process. Cold means a
fresh process/filter, not a deliberately flushed OS file cache. These isolate
inheritance-filter work; they do not measure language-server indexing or live
whole-extension responsiveness.

| Workload | Before cold / warm / refresh (ms) | Final cold / warm / refresh (ms) | Median change cold / warm / refresh |
| --- | --- | --- | --- |
| Ordinary | 77.800 / 1.883 / 30.062 | 74.483 / 2.019 / 31.385 | −4.3% / +7.2% / +4.4% |
| Barrels | 216.137 / 1.889 / 144.526 | 232.167 / 1.996 / 144.463 | +7.4% / +5.7% / −0.04% |
| Deep hierarchy | 90.278 / 1.930 / 35.956 | 96.231 / 2.114 / 38.299 | +6.6% / +9.5% / +6.5% |

The barrel cold slowdown occurs in all five pairs (6.813–20.758 ms extra), with
a median-batch increase of 16.030 ms. Deep warm and refresh batches are slower in
all five pairs: 0.062–0.263 ms and 1.646–6.321 ms extra, respectively. These are
observed performance regressions in the isolated workloads. Deep cold timing is
mixed (three slower, two faster); its median alone does not establish a consistent
slowdown. Ordinary warm is slower in four pairs. Ordinary refresh and barrel
warm/refresh are mixed. Ordinary cold is faster in this run, but unchanged controls
also vary substantially, so no general speedup is claimed. Five samples are not a
statistical significance test.

| Workload | Before populated / cleared heap (MiB) | Final populated / cleared heap (MiB) |
| --- | --- | --- |
| Ordinary | 3.760 / 1.150 | 3.998 / 1.200 |
| Barrels | 4.123 / 1.224 | 4.394 / 1.282 |
| Deep hierarchy | 7.306 / 1.290 | 7.870 / 1.329 |

Populated retained heap increases by 0.238 / 0.271 / 0.564 MiB for ordinary /
barrels / deep. Values are increases over process baseline after an event-loop turn
and forced GC, not whole-extension memory. Warm parser admissions remain zero;
cold and refresh admissions remain 201 / 302 / 201 files. Median cold event-loop
delay changes from 78.314 / 217.329 / 90.911 ms to 74.911 / 232.975 / 97.070 ms,
consistent with synchronous batch duration.

### Previously recorded results

The earlier intermediate run is preserved in
`benchmarks/pr50-2026-10-12-intermediate.json`. Its source hash differs from the
final code and predates the latest correctness changes. This historical comparison
does not isolate the optimization as the paired snapshot comparison above does.

| Workload | Earlier recorded cold / warm / refresh (ms) | Exact final cold / warm / refresh (ms) |
| --- | --- | --- |
| Ordinary | 76.667 / 1.929 / 31.637 | 74.483 / 2.019 / 31.385 |
| Barrels | 216.748 / 1.883 / 140.206 | 232.167 / 1.996 / 144.463 |
| Deep hierarchy | 90.302 / 1.912 / 38.206 | 96.231 / 2.114 / 38.299 |

Compared with the original PR in this final run, ordinary cold / warm / refresh
medians increase from 66.265 / 1.654 / 25.216 ms to 74.483 / 2.019 / 31.385 ms;
barrel medians increase from 179.195 / 1.652 / 106.076 ms to
232.167 / 1.996 / 144.463 ms. This includes the earlier identity/canonical-path
fixes as well as the latest fixes. The original version is not a correctness-equivalent
baseline for the new regressions, though these benchmark fixtures return the same
expected results.

The existing CQRS and syntactic-index fixtures were rerun as controls against
recorded performance. The CQRS harness disables inheritance filtering, so it does
not measure these changes. The T3 target remains pinned at
`9a609a4e444ba739d6fcd607769d68b679b0bcc5`; environment and fixtures match the
2026-10-11 recorded CQRS measurements. First-generation median batches:

| Control | Previously recorded final | Current before | Exact final |
| --- | --- | --- | --- |
| T3 CQRS cold / warm / refresh (ms) | 27.22 / 2.34 / 4.24 | 21.92 / 1.56 / 3.57 | 9.15 / 1.42 / 3.40 |
| Ordinary synthetic CQRS cold (ms) | 28.28 | 22.75 | 22.41 |
| Handler CQRS cold / warm / refresh (ms) | 244.24 / 18.43 / 176.34 | 200.33 / 17.64 / 131.14 | 198.61 / 17.67 / 130.93 |
| T3 / synthetic / handler populated heap (MiB) | 0.34 / 0.53 / 66.47 | 0.34 / 0.53 / 66.46 | 0.34 / 0.53 / 66.46 |
| Syntactic barrel fixture (ms) | approximately 160 | 159 | 161 |

CQRS parser admissions remain 0 / 0 / 0 for ordinary sources and 100 / 0 / 100
for handler sources (cold / warm / refresh). The syntactic fixture returns identical
SHA-1 `353caecf6c3e56d225d9b5a20f55b3f4cb46a68f` and 139 callers.
These controls do not establish a speed change caused by this fix. The unchanged
T3 control has noisy cold ranges of 8.93–27.18 ms before and 8.76–41.32 ms after.
No general improvement is claimed from lower historical-control timings.

Reproduce inheritance with `node --expose-gc --max-old-space-size=512
test/measure-inheritance.js ordinary` (or `barrels` / `deep`). An optional second
argument loads the filter from an archived source root, allowing the same harness
to compare revisions. For CQRS use `test/measure-cqrs-cache.js` with `synthetic`,
`handlers`, or the pinned T3 path. For the syntactic control use
`PRINT_BARREL_SIGNATURE=1 node test/syntactic-index.test.js`.

Final-code validation: full `npm test`, separate nonempty `HEAD~20` tree checks,
scoped snapshots (zero missing cross-project expectations), and `git diff --check`
passed. Default full-suite tree/callsite integration stages skip on the target's
empty diff; nonempty tree checks were run separately. All 25 engine regression
tests pass. Lint/typecheck from the preceding review passed, but `inheritance.js`
is not enrolled in their configuration; those commands are not evidence of coverage
for this changed file. Nothing was committed or pushed.

Recommendation: keep the optimization. It removes demonstrated unnecessary AST
allocations and traversal for irrelevant files, with substantially less populated
heap and faster isolated ordinary-file queries. Candidate files retain the existing
parsing path; its measured latency variation remains a limitation of this evaluation.
