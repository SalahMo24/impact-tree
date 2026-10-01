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
