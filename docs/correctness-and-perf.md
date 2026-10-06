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

Read-only measurements on the Mylo worktree, using Node on this machine:

- Git diff and changed-row preparation: **2.139 s**, 48 source files, 90 total paths
  and 65 symbols. The benchmark aborted at the prepared callback before any caller
  query; it excludes base fetch, editor warm-up, identity rendering and UI painting.
- A cold module lookup: **14.942 s**, with 1,369 host timer ticks and a maximum
  10-ms timer gap of **28 ms**. The previous synchronous scan blocked the host for
  approximately 11.5 s. Cold indexing is moved off the host, not eliminated.
- A second lookup with unchanged metadata: **464 ms**, retaining the same index.
  Both searches retained the two found callers and marked eight oversized skipped
  files as incomplete; the computed-require warning was retained.

Verification: `test/loading.test.js` covers early opening/ticking, final checkbox
retention, stale publication, real worker callers and cache invalidation, cancellation,
worker/provider deadlines, late rejection and outstanding-provider admission. It runs
in `npm test` and `test:smoke`. Lint/typecheck and the available test suite pass. The
default recorded-fixture and target caller/tree checks skip because their target has
no suitable diff or recorded fixtures. These measurements do not replace validation
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
