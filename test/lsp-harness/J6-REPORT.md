# J6 report: the Java editor path (jdtls) against google/gson, checked by the Tree API and javac

Reproduce with

```
node test/lsp-harness/java-verify.js            # all 12 PRs of java-verify-corpus.json
J6_ROWS=1 node test/lsp-harness/java-verify.js 2072   # one PR, with a row per target
```

Pass 4 comes first, then passes 3 and 2; the pass 1 sections after them are kept as they were.

## Pass 4: clean starts and first imports

Pass 3's open risk: with no record, or a clean start, jdtls may send no import event after
ready, so every Java answer would read incomplete for the session.

### Measured (`test/lsp-harness/java-measure-start.js`, gson-verify at 6b9db2e = #1700, 120 s after ServiceReady)

| Start | Events 200/100 | `$/progress` after ready | Status at 120 s |
| --- | --- | --- | --- |
| (a1) `-data` gson-verify, no record (pass 3 code) | one 200 before ready; **none after** | Update project ×9, Building, Register Watchers: 0.0–5.0 s | "no import … seen yet; not confirmed within 120 s" |
| (a2) clean start: same `-data` again, no record | one 200 before ready; **none after** | the same: 0.0–5.2 s | not busy (settled at 30 s, record written) |
| (b) first import: new empty `-data`, no record (deleted after) | one 200 before ready; **none after** | Updating module path, Building, Searching: 0.1–7.3 s | not busy |
| stale: `-data` at #1700, checkout #2944, record of #1700 (20 s window) | one 200 before ready; none in 20 s | – | "a build file changed since …" (mismatch path) |

So the risk was real: neither a clean start nor a first import sends an import event after
ready (jdtls re-updates its projects for ~5–7 s after ready with progress only, which the
editor cannot see).

### Fix (`server-status.js`)

- **No record, or a matching record:** after `serverReady()` the status *settles*: answers read
  incomplete ("no import … seen yet" / "the Java language server had just started and may still
  be re-importing the project") until `IMPORT_SETTLE_MS` = 30 000 ms (injected clock) pass with
  no import/classpath event and no build-file change; each one restarts the period. Then the
  record is written and answers read complete. Past the 120 s deadline without settling, the
  reason adds "not confirmed"; settling still ends it later.
- **Why 30 s is safe:** the longest silent stretch after ready seen is 11.7 s (pass 3's stale
  start: first event 100 at 11.7 s, re-import ~14 s); clean starts and first imports end their
  progress by 7.3 s. 30 s is over twice the longest. A matching record now also waits out the
  period (before: complete at ready).
- **Unchanged:** a mismatch (a build file differs from the record) or unknown build files stay
  incomplete until an import event after ready; events before ready are ignored.
- **Tests:** `test/java-build-file-record.test.js` (7 tests, ~0.2 s): matching → settles at
  exactly 30 s; no record / unknown format → settles and records (time before ready does not
  count); an event at 11.7 s and a later one restart the period, and a later build-file change
  is incomplete until an import; events that keep coming → "not confirmed", then settles.

### Editor run (final code, depth 24; `-data` imported at #2944, no record; first PR #1700)

211 s, exit 0. #1700's first answers: "no import … seen yet" (the settling path, no record);
the first post-ready event 100 came at 17.6 s.

| PR | switch | quiet | functions | kinds | targets | TP | FP | FN | pipeline | states |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1700 | (start) | – | 13 / 13 | 9/9 | 13 | 555 | 0 | 42 | 10.1 s | 12 resolved, 1 unknown |
| #1904 | 163 | 8.7 s | 14 / 14 | 13/13 | 14 | 339 | 6 | 46 | 12.3 s | 13 resolved, 1 unknown |
| #2072 | 122 | 8.2 s | 13 / 13 | 9/9 | 11 | 177 | 4 | 11 | 1.6 s | 11 resolved |
| #2498 | 282 | 11.3 s | 12 / 12 | 6/6 | 8 | 35 | 8 | 0 | 2.6 s | 8 resolved |
| #2588 | 179 | 9.5 s | 3 / 3 | 1/1 | 3 | 19 | 0 | 0 | 0.9 s | 3 resolved |
| #2759 | 79 | 8.3 s | 5 / 5 | 5/5 | 5 | 58 | 0 | 0 | 1.0 s | 5 resolved |
| #2776 | 75 | 9.3 s | 2 / 2 | 1/1 | 2 | 2 | 0 | 0 | 1.1 s | 2 resolved |
| #2838 | 16 | 8.7 s | 105 / 105 | 17/17 | 61 | 549 | 233 | 9 | 39.7 s | 58 resolved, 3 unknown |
| #2879 | 49 | 8.6 s | 9 / 9 | 7/7 | 7 | 205 | 0 | 0 | 1.7 s | 7 resolved |
| #2951 | 93 | 18.3 s | 25 / 25 | 3/3 | 17 | 15 | 193 | 0 | 3.0 s | 17 resolved |
| #2950 | 23 | 13.4 s | 10 / 10 | 6/6 | 10 | 18 | 26 | 0 | 1.4 s | 10 resolved |
| #2944 | 4 | 4.6 s | 13 / 13 | 13/13 | 13 | 60 | 10 | 19 | 1.6 s | 13 resolved |
| **total** | | | **224 / 224** | **90/90** | 164 | 2032 | 480 | 127 | | 159 resolved, 5 unknown |

- **0 misses on a complete answer** (no exclusion needed); 0 outside jdtls' view; 0 shown as
  fine. #1700's 42 and #1904's 46 misses are all on incomplete answers.
- -32603: 1 of 165 (`equals(Object)`).

### Pass 4 end checks (sequential)

| Check | Result | Wall time |
| --- | --- | --- |
| `npm test` | 141 files, 0 failed | 32 s |
| `npm run lint` | exit 0 | 4 s |
| `npm run typecheck` | exit 0 | 5 s |
| `preview-golden.js --compare` | exit 0, 21 same | 114 s |
| `java-verify.js --syntactic` | exit 0, 224/224, 90/90 | 7 s |
| `java-e2e.js` | exit 0 | 13 s |
| baseline `compare.sh` | exit 0, ALL SAME | 32 s |

## Pass 3: a build file changed while the server was down

Pass 2's gap: jdtls starts from a `-data` imported at another state, reports ready, then
re-imports, and the editor saw no signal (run 3: 5 misses on complete answers in #1700).

### What the editor does now (`src/languages/java/server-status.js`)

- **Record:** a SHA-256 over every build file (pom.xml, build.gradle(.kts), settings.gradle(.kts))
  in the workspace folders: relative path and content (not mtime). Kept in the extension's
  `workspaceState` (`impactTree.java.buildFileRecord`, `{ version: 1, stamp }`), given at
  activation (`setEditorJavaBuildFileStore`, `src/extension.js`).
- **Written** at every `onDidProjectsImport` / `onDidClasspathUpdate` after `serverReady()`.
  Events before ready are not recorded (measured below: jdtls sends one from its old `-data`).
- **Compared** when Java's status is made and again at `serverReady()`. A different stamp: "a
  build file changed since the Java language server last imported the project". No record:
  "no import … has been seen yet in this workspace". Either holds until an import event after
  ready.
- **Deadline:** 120 000 ms from ready (injected clock). After it the answer stays incomplete,
  with "; the re-import was not confirmed within 120 s"; only an import event ends it.
- **Caps** (`BUILD_FILE_LIMITS`, checked before each admission): 200 build files, depth 24,
  5000 folders, 1 MiB per build file; `target/`, `build/`, `node_modules/`, `out/` and
  dot-folders skipped. A cap or a read error: "the build files could not all be read (…)",
  incomplete until an import event after ready. gson-verify: 8 build files, 18 ms.
- **Residual:** an import that ended before the status existed is not seen; such a window
  stays incomplete (not confirmed) until the next import event.
- **Harness mirror** (`jdtls-services.js`): `serverReady` resolves at ServiceReady, the record
  is `<-data>.build-file-record.json`, and `importEvents` lists every 200/100 with its time
  from ServiceReady.
- **Tests:** `test/java-build-file-record.test.js` (5 tests, ~0.1 s): changed → incomplete until
  an import, which records; unchanged → complete; no record / unknown format → incomplete until
  the first import after ready (one before ready does not count); deadline → stays incomplete
  with its reason; caps (files at and over, depth, folders, size, read error).

### Does jdtls fire an import event after a startup re-import?

Yes, as `onDidClasspathUpdate` (event 100), not `onDidProjectsImport` (200). Full run from
`-data` at #2944 with #1700 checked out: one 200 **before** ServiceReady, then the first 100
at 11.7 s after it, and 100s at every later switch; no 200 after ready. So both events end
the check, and the pre-ready 200 must not (it is the old `-data`'s).

### Editor run (once, from a stale `-data`: imported at #2944, first PR #1700)

167 s, exit 0. The build-file limit was then depth 8, so the check read "could not all be read
(folders deeper than 8)" from the start until the first 100 after ready: incomplete, as for a
change. Depth is now 24 (gson's source trees are 12+ deep).

| PR | switch | quiet | functions | kinds | targets | TP | FP | FN | pipeline | states |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1700 | (start) | – | 13 / 13 | 9/9 | 13 | 591 | 0 | 6 | 6.7 s | 12 resolved, 1 unknown |
| #1904 | 163 | 6.9 s | 14 / 14 | 13/13 | 14 | 339 | 6 | 46 | 8.8 s | 13 resolved, 1 unknown |
| #2072 | 122 | 5.1 s | 13 / 13 | 9/9 | 11 | 177 | 4 | 11 | 1.0 s | 11 resolved |
| #2498 | 282 | 7.5 s | 12 / 12 | 6/6 | 8 | 35 | 8 | 0 | 1.5 s | 8 resolved |
| #2588 | 179 | 8.2 s | 3 / 3 | 1/1 | 3 | 19 | 0 | 0 | 0.6 s | 3 resolved |
| #2759 | 79 | 7.8 s | 5 / 5 | 5/5 | 5 | 58 | 0 | 0 | 0.7 s | 5 resolved |
| #2776 | 75 | 8.5 s | 2 / 2 | 1/1 | 2 | 2 | 0 | 0 | 0.9 s | 2 resolved |
| #2838 | 16 | 7.4 s | 105 / 105 | 17/17 | 61 | 549 | 233 | 9 | 32.0 s | 58 resolved, 1 none, 2 unknown |
| #2879 | 49 | 7.7 s | 9 / 9 | 7/7 | 7 | 205 | 0 | 0 | 1.3 s | 7 resolved |
| #2951 | 93 | 13.7 s | 25 / 25 | 3/3 | 17 | 15 | 193 | 0 | 2.6 s | 17 resolved |
| #2950 | 23 | 11.3 s | 10 / 10 | 6/6 | 10 | 18 | 26 | 0 | 1.2 s | 10 resolved |
| #2944 | 4 | 4.2 s | 13 / 13 | 13/13 | 13 | 60 | 10 | 19 | 1.3 s | 13 resolved |
| **total** | | | **224 / 224** | **90/90** | 164 | 2068 | 480 | 91 | | 159 resolved, 4 unknown, 1 none |

- **0 misses on a complete answer** (no exclusion needed: jdtls attributed the 11 proto sites
  as javac did, as in pass 2 run 3); 0 outside jdtls' view; 0 shown as fine.
- -32603: 1 of 165 (`equals(Object)`).
- **Single-PR check with depth 24** (`java-verify.js 1700`, 19 s, exit 0; `-data` at #2944, no
  record): status "no import … seen yet" from the start; #1700 had 44 misses (the re-import had
  not finished: run 3 saw 5), all on incomplete answers; 0 on complete. No import event came
  before the run ended, so no record was written; the record-mismatch path in a live run is
  covered by the unit tests only.

### Pass 3 end checks (sequential)

| Check | Result | Wall time |
| --- | --- | --- |
| `npm test` | exit 0, 141 files, 0 failed | 35 s |
| `npm run lint` | exit 0 | 4 s |
| `npm run typecheck` | exit 0 | 7 s |
| baseline `compare.sh` | ALL SAME | – |
| `preview-golden.js --compare` | exit 0, 21 same | 113 s |
| `java-verify.js --syntactic` | exit 0, 224/224, 90/90 | 8 s |
| `java-e2e.js` | exit 0 | 17 s |

## Pass 2

### #1904: the cause

- **Not the quiet window.** #1904 alone, with a fresh jdtls that did the whole import before
  `ServiceReady` and no switch at all, missed the same 46 calls (45 + the `examples/` one) as
  the full run.
- **Not a failed import either.** jdtls imported every module (`language/eventNotification`
  200 with gson, codegen, extras, metrics, proto; `ProjectStatus OK`). Only test-jpms,
  test-shrinker and test-graal-native-image logged "Error updating … digest".
- **The cause: Java 6.** At #1904 the root pom sets `<java.version>1.6</java.version>`. jdtls
  published a project diagnostic on extras, metrics, proto and codegen: "Build path specifies
  execution environment JavaSE-1.6. There are no JREs installed in the workspace that are
  strictly compatible with this environment". Those are exactly the modules whose calls were
  missed. Even `GraphAdapterBuilder.addType` lost its callers in extras' own tests, so this is
  not a missing link to the workspace's gson. At the later commits the same modules get the
  same warning for JavaSE-1.7 (#2072, single run), and there jdtls lists every call (#2072
  alone: FN 0). So jdtls lists no calls in a project at Java 6 or older.
- **A stale project:** after #1904, jdtls keeps `codegen` (only `target/` is left on disk)
  together with its JavaSE-1.6 diagnostic.

### What the editor does now (src)

- `src/languages/java/server-status.js`, which reads redhat.java's exported API:
  - `serverMode` LightWeight: incomplete.
  - Hybrid, or `serverReady()` not yet resolved: "the Java language server was still
    importing the project".
  - A build-file watcher (pom.xml, Gradle): from a change until the next
    `onDidProjectsImport` / `onDidClasspathUpdate`, answers are incomplete. The API has no
    "import started" event.
  - jdtls' project diagnostics (`vscode.languages.getDiagnostics()`): an execution
    environment of Java 6 or older, or an unbound or incomplete build path, makes every Java
    answer incomplete ("…broken build path for <folder>…"). A folder with no build file left
    is ignored, as stale.
- Java's editor extras read the status at the start and at the end of each query, plus an
  epoch for an import that ended in between ("re-imported the project while the query ran").
- The harness mirrors the editor; it does not read progress, which the editor cannot see.
  jdtls' `language/eventNotification` 200 and 100 stand for `onDidProjectsImport` and
  `onDidClasspathUpdate`, the checkout stands for the watcher, and the diagnostics are the
  ones jdtls published. Progress-based busy (pass 2 full run 1) marked answers of unrelated PRs
  incomplete, because jdtls reports "Building" during queries.
- **Not covered:** a pom changed while VS Code was closed. jdtls re-imports after
  `ServiceReady` (seen in the trace: "Updating Maven projects" ran for about 14 s after it),
  and the API gives no signal for that. Proposal: treat the first N s after `serverReady` as
  importing, or ask redhat.java for a status event.

### Java caller-query cap

- **Budget:** `JAVA_CALLER_QUERY_LIMIT = 2` (`src/languages/java/editor-extras.js`): a count,
  per resolver, owned by Java's extras.
- **Enforcement:** `queryGate` (`createQueryGate` in `callers-from-hierarchy.js`).
  `queryHierarchy` runs every attempt through it, retries and caller targets included. It is
  used by the resolver and by the harness.
- **Exhaustion:** the query waits in a first-come queue. The queue's length is bounded by the
  analysis' concurrency.
- Other languages have no gate and are unchanged. The -32603 retry is kept.

### VS Code's error mapping

- **Source:** VS Code's workbench code, read in the installed Cursor build at
  `/Applications/Cursor.app/…/workbench.desktop.main.js`. VS Code itself is not installed.
  - `CallHierarchyModel.resolveIncomingCalls` is
    `try { r = await provider.provideIncomingCalls(...); if (isNonEmptyArray(r)) return r } catch (e) { onUnexpectedExternalError(e) } return []`.
  - `_executeProvideIncomingCalls` also returns `[]` when the item's model is no longer in
    its cache.
  - `_executePrepareCallHierarchy` keeps only 10 models (`size > 10` → dispose).
- **So a jdtls -32603 reaches our services as `[]`:** `incomingCallsWithin` gets an Array and
  reads ready with no rows. The -32603 retry therefore never fires in the editor; only the
  harness sees the rejection.
- **Guard:** for Java, an empty answer for an override or an overridable method is incomplete
  (`EMPTY_ANSWER_REASON`).
- **For the other languages (not changed):** more than 10 call hierarchies prepared before
  their incoming calls are asked can turn the oldest into a silent `[]`. At concurrency 8 plus
  caller targets this is possible.

### Pass 2 results

Three full runs with the cap; the code changed between them:

- **Run 1:** progress-based busy in the harness.
- **Run 2:** the editor-equivalent status, with the build-path rule matching any execution
  environment.
- **Run 3:** the final code, with Java ≤ 6 only and stale projects ignored.

The table is from run 3 (206.5 s); run 2 took 193.2 s.

| PR | switch | quiet | functions ours / oracle | kinds | targets | TP | FP | FN | c.prec | c.recall | pipeline | states |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1700 | (start) | – | 13 / 13 | 9/9 | 13 | 591 | 0 | 6 | 100% | 99.0% | 7.5 s | 12 resolved, 1 unknown |
| #1904 | 163 | 8.1 s | 14 / 14 | 13/13 | 14 | 339 | 6 | 46 | 98.3% | 88.1% | 11.8 s | 13 resolved, 1 unknown |
| #2072 | 122 | 7.0 s | 13 / 13 | 9/9 | 11 | 177 | 4 | 11 | 97.8% | 94.1% | 1.2 s | 11 resolved |
| #2498 | 282 | 8.3 s | 12 / 12 | 6/6 | 8 | 35 | 8 | 0 | 81.4% | 100% | 2.4 s | 8 resolved |
| #2588 | 179 | 9.4 s | 3 / 3 | 1/1 | 3 | 19 | 0 | 0 | 100% | 100% | 1.4 s | 3 resolved |
| #2759 | 79 | 9.7 s | 5 / 5 | 5/5 | 5 | 58 | 0 | 0 | 100% | 100% | 1.2 s | 5 resolved |
| #2776 | 75 | 10.9 s | 2 / 2 | 1/1 | 2 | 2 | 0 | 0 | 100% | 100% | 1.3 s | 2 resolved |
| #2838 | 16 | 10.7 s | 105 / 105 | 17/17 | 61 | 549 | 233 | 9 | 70.2% | 98.4% | 40.6 s | 58 resolved, 1 none, 2 unknown |
| #2879 | 49 | 9.3 s | 9 / 9 | 7/7 | 7 | 205 | 0 | 0 | 100% | 100% | 1.8 s | 7 resolved |
| #2951 | 93 | 16.1 s | 25 / 25 | 3/3 | 17 | 15 | 193 | 0 | 7.2% | 100% | 2.7 s | 17 resolved |
| #2950 | 23 | 13.5 s | 10 / 10 | 6/6 | 10 | 18 | 26 | 0 | 40.9% | 100% | 2.0 s | 10 resolved |
| #2944 | 4 | 4.9 s | 13 / 13 | 13/13 | 13 | 60 | 10 | 19 | 85.7% | 75.9% | 2.2 s | 13 resolved |
| **total** | | | **224 / 224** | **90/90** | 164 | 2068 | 480 | 91 | 81.2% | 95.8% | | 159 resolved, 4 unknown, 1 none |

- **Functions:** 100% precision and recall; all 20 header changes classified; no change shown
  as fine while a non-updated caller is known.
- **FPs (480):**
  - 470 are jdtls override over-reports, each on an answer marked incomplete (overrides).
  - 10 are `@Expose(serialize/deserialize = …)` annotation-element uses (#2944).
  - In run 3, jdtls attributed the #1700 proto sites as javac did, to `fromJson(String, Type)`,
    so those 11 FP/FN pairs did not appear. In run 2 they did (11 FP and 11 misses).
- **Misses (91):**
  - 46 (#1904): incomplete, "broken build path" (Java 6).
  - 20: incomplete, implicit `super()`.
  - 19: incomplete, overridden (#2944: calls on an interface inside lambdas).
  - 1: `examples/` (no pom), reported apart.
  - **5 on complete answers, all in #1700, the run's first PR:**
    - `RawCollectionsExample.java:49–51` (`fromJson(JsonElement, Class)`)
    - `ParseBenchmark.java:277`
    - `CollectionsDeserializationBenchmark.java:60`
- **Why those 5:**
  - jdtls started from a `-data` imported at #2072 (the last single run), with #1700 checked
    out, so the poms had changed while the server was down. jdtls re-imports those modules after
    `ServiceReady`, and nothing the editor sees says so: this is the case listed as not
    covered above.
  - In run 2, #1700 started from #2944's state and these 5 were found.
  - **Acceptance:** met in run 2 (0 misses on complete answers once the 11 javac overload
    artefacts are excluded) but **not in run 3** (5 misses).
- **The 11 javac artefacts (run 2), excluded with this evidence:**
  - Each call passes a class literal, which makes `fromJson(String, Class)` the right
    overload. javac picked `fromJson(String, Type)` because the class is protoc-generated and
    missing, and the file has javac errors.
  - `ProtosWithAnnotationsTest.java:102`: `gson.fromJson(json, ProtoWithAnnotations.class)`;
    lines 149, 158, 169, 177: `…fromJson(json, InnerMessage.class)`; line 223:
    `gsonWithLowerHyphen.fromJson(json, ProtoWithAnnotations.class)`.
  - `ProtosWithComplexAndRepeatedFieldsTest.java:75`:
    `gson.fromJson(json, ProtoWithRepeatedFields.class)`; line 96:
    `upperCamelGson.fromJson(json, ProtoWithDifferentCaseFormat.class)`.
  - `ProtosWithPrimitiveTypesTest.java:47, 64, 70`: `gson.fromJson("…", SimpleProto.class)`.
- **-32603 with the cap:** 1 of 165 incomingCalls (0.6%) in each of the 3 runs, always
  `equals(Object)`, against 3.0–5.9% at 8 in pass 1. #2838's pipeline took 36–41 s, against
  55 s at 8 in pass 1.
- **Harness fixes:**
  - A `require` broken by main's regroup (`src/tree-row-models` →
    `src/views/changes/tree-row-models`): the first #1904 debug run crashed on it.
  - Over-report labelling matches `OVERRIDES_REASON` anywhere in the reason.
  - `J6_TRACE=1` prints jdtls' notifications.
  - The quiet wait was not the cause of #1904 and is unchanged.

### Pass 2 end checks (run one at a time, after the editor runs)

| Check | Result | Wall time |
| --- | --- | --- |
| `npm test` | exit 0, 140 files, 0 failed (pass 1's `not-analysed` failure is gone on main) | 30 s |
| `npm run lint` | exit 0 | 4 s |
| `npm run typecheck` | exit 0, after a fix to `server-status.js`; first run exit 2 on `require('vscode')` | 6 s |
| `java-verify.js --syntactic` | exit 0, 224/224, 90/90 | 8 s |
| `java-verify.js --syntactic --callers` | exit 0, 2142/0/17 | 15 s |
| `preview-golden.js --compare` | exit 1, 18 same, 3 DIFFERENT; see below | 128 s |
| `java-e2e.js` | exit 0, 8 of 8 checks yes | 14 s |
| `go-e2e.js` (cli) | exit 0 | 7 s |
| `py-e2e.js` (httpx-seams) | exit 0 | 12 s |
| baseline `compare.sh` | exit 0, ALL SAME | 35 s |

- **The 3 DIFFERENT golden cases** are t3code-3, t3code-e8dfc42 and hono-1774. Each one is a
  TypeScript `new Error(`…`)` whose message was reworded, which now reads as a body change
  instead of a new throw.
- **Why that is not from this branch:** main's 6621656 ("no false change kinds for … reworded
  throws") changed exactly that, and this branch touches no signature or TypeScript code. Not
  re-run on main.

### Still open after pass 2

- **A pom changed while the server was down (the 5 misses above).** The editor sees no
  re-import after `serverReady`. Options:
  - a grace period after `serverReady`;
  - comparing build-file mtimes with the last `onDidProjectsImport`;
  - asking redhat.java for a status event.
  - For the harness alone: make `start()` wait as `waitQuiet` does.
- The status's watcher and listeners are made the first time a Java target is asked about,
  and live as long as the window. A pom change before that is not seen.

Every number in the pass 1 sections below is from the third full run of pass 1 (run 3), unless
a row says otherwise.

## Revision, configuration, environment

- **Impact Tree:** branch `feat/j6-java-verify` from `b930856` (J1–J5, J7, J8) plus the J6 commit.
- **Target:** a dedicated clone `~/Projects/impact-tree-test-repos/gson-verify`
  (`git clone --local` of `gson`). It is checked out (detached) at each PR's head in turn; `gson`,
  `gson-e2e` and `gson-j5` are not touched. `pr` mode against the PR's base (`allowLocalBase`).
- **Pipeline:** the editor's: `analyze()` with `skipForest`, `deferTestReach`, depth 1,
  concurrency 8 (the editor's default); `javaProvider.prepareFromServerSymbols` on jdtls'
  documentSymbol answers, base sides through G2's temporary copies; callers from the call
  hierarchy with Java's caller extras (J4) through `harness-languages.js`
  (`applyCallerExtras`, as `resolver-vscode.js`).
- **jdtls:** one server for the whole run, `-data`
  `~/Projects/impact-tree-scratchpad/java-tools/jdtls-data/gson-verify` (kept between runs).
  Between PRs: checkout, every open document closed, one `workspace/didChangeWatchedFiles` with
  every changed path, then wait until no `$/progress` is open and none came for 2 s.
- **Oracles:** (a) `Members.java` (Tree API; J7's cache `java-oracle/verify/`); (b)
  `Callers.java` (javac attribution of the head tree, `-proc:none`, 24-jar classpath; J8's
  cache `java-oracle/callers/<head>/`), every file of the tree. All 24 oracle answers were cached.
- **Nothing of gson ran:** no script, test or `mvn`; jdtls' own m2e import only (J0).

## Results (run 3)

| PR | changed paths at switch | quiet wait | functions ours / oracle | precision | recall | kinds | caller targets | TP | FP | FN | caller precision | caller recall | states |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1700 | (start) | – | 13 / 13 | 100% | 100% | 9/9 | 13 | 585 | 11 | 12 | 98.2% | 98.0% | 12 resolved, 1 unknown |
| #1904 | 163 | 8.2 s | 14 / 14 | 100% | 100% | 13/13 | 14 | 339 | 6 | 46 | 98.3% | 88.1% | 13 resolved, 1 none |
| #2072 | 122 | 7.7 s | 13 / 13 | 100% | 100% | 9/9 | 11 | 177 | 4 | 11 | 97.8% | 94.1% | 11 resolved |
| #2498 | 282 | 15.9 s | 12 / 12 | 100% | 100% | 6/6 | 8 | 35 | 8 | 0 | 81.4% | 100% | 8 resolved |
| #2588 | 179 | 13.3 s | 3 / 3 | 100% | 100% | 1/1 | 3 | 19 | 0 | 0 | 100% | 100% | 3 resolved |
| #2759 | 79 | 15.8 s | 5 / 5 | 100% | 100% | 5/5 | 5 | 58 | 0 | 0 | 100% | 100% | 5 resolved |
| #2776 | 75 | 10.7 s | 2 / 2 | 100% | 100% | 1/1 | 2 | 2 | 0 | 0 | 100% | 100% | 2 resolved |
| #2838 | 16 | 9.2 s | 105 / 105 | 100% | 100% | 17/17 | 61 | 549 | 219 | 9 | 71.5% | 98.4% | 57 resolved, 1 none, 3 unknown |
| #2879 | 49 | 14.1 s | 9 / 9 | 100% | 100% | 7/7 | 7 | 205 | 0 | 0 | 100% | 100% | 7 resolved |
| #2951 | 93 | 20.5 s | 25 / 25 | 100% | 100% | 3/3 | 17 | 15 | 193 | 0 | 7.2% | 100% | 17 resolved |
| #2950 | 23 | 16.9 s | 10 / 10 | 100% | 100% | 6/6 | 10 | 18 | 26 | 0 | 40.9% | 100% | 10 resolved |
| #2944 | 4 | 5.0 s | 13 / 13 | 100% | 100% | 13/13 | 13 | 75 | 10 | 4 | 88.2% | 94.9% | 13 resolved |
| **total** | | | **224 / 224** | **100%** | **100%** | **90/90** | 164 | 2077 | 477 | 82 | 81.3% | 96.2% | 158 resolved, 4 unknown, 2 none |

- **Functions:** 100% precision and recall; every kind right; all 20 header changes classified.
- **Callers:** precision is low on purpose: 456 of the 477 FPs are jdtls' over-report on an
  override (it lists the supertype method's callers), each on an answer marked incomplete with
  `OVERRIDES_REASON` (J0 §3, J4). Without them: 2077 / 2098 = 99.0%.

### False positives (477)

| Count | Verdict |
| --- | --- |
| 191 | Override over-report: javac resolved the call to `TypeAdapter.read/write`; answer incomplete (overrides). |
| 207 | Override over-report of a JDK method (`Object.equals/hashCode/toString`, `ParameterizedType.*`, …): javac's target is outside the tree, so oracle (b) lists no call; answer incomplete (overrides). |
| 28 / 26 / 2 / 2 | Override over-report via `TypeAdapterFactory.create`, `ObjectConstructor.construct`, `InstanceCreator.createInstance`, `LongSerializationPolicy`; incomplete (overrides). |
| 11 | **javac artefact**, #1700, `proto/src/test/…`: `gson.fromJson(json, ProtoWithAnnotations.class)`. The message classes are generated by protoc and missing from the tree, so javac (with errors in those files) resolved the call to `fromJson(String, Type)`. jdtls says `fromJson(String, Class)`, which is right. The same 11 sites are 11 of the misses. |
| 10 | **Oracle artefact**, #2944, `@Expose(serialize = false)` in tests: jdtls lists setting an annotation element as a use of `Expose.serialize()`/`deserialize()`; javac records invocations only. A real dependent, not a call. |

No FP needed a fix in src.

### Misses (82) and the incomplete check

- **On an incomplete answer (24):** 20 implicit `super()` (anonymous `new TypeToken<…>() {}`
  and subclasses, in gson, extras and metrics; `IMPLICIT_SUPER_REASON`), 4 dispatch on an
  overridden method (`OVERRIDDEN_REASON`).
- **Outside jdtls' projects (2), reported apart:** `examples/android-proguard-example`
  has no pom.xml, so jdtls imports no project there (#1700, #1904).
- **On a complete answer (56): the acceptance check fails here.**
  - 11 (#1700, proto): the javac artefact above (same sites as the 11 FPs).
  - 45 (#1904): every one is in `extras/`, `metrics/` or `proto/` (e.g.
    `GsonBuilder.create()` <- `extras/src/test/…/GraphAdapterBuilderTest.java:47`). Even
    `GraphAdapterBuilder.addType` (a target inside extras) misses its callers in extras' tests.
    Those modules depend on `${project.parent.version}`, the workspace's version, so they should
    resolve to the workspace. #1904 is the one switch where the version goes backwards
    (2.9.2-SNAPSHOT → 2.9.0-SNAPSHOT) and a module (`codegen`) appears. Most likely jdtls had not
    yet rebuilt those modules' links when the 2 s quiet window ended, or their import failed at
    that commit. I did not have time to tell which (see "Open").
- History of this check across the runs: run 1 had 97 misses on complete answers; run 2 had 84
  (after the retry fix). Run 3 had 56, after the harness answered jdtls' pom-update question:
  `updateBuildConfiguration: automatic`, see "Fixes" 2. For example, #2879's misses went from 14
  to 0.

### "Shown as fine while a non-updated caller is known"

0 in run 3. Run 1 flagged one row: #1904 `Gson.<init>(Excluder, …)` [required-param] "all
callers updated". That was a **harness artefact**. The `this(…)` and `new Gson(…)` calls span
several lines, and the PR edited an argument line, not the call's first line. The check now
counts every line of the call, up to its closing parenthesis.

## -32603 (incomingCalls `Internal error`)

| Run | queries | failed | rate | targets left unknown |
| --- | --- | --- | --- | --- |
| 1 (no retry) | 164 | 6 | 3.7% | 9 |
| 2 (retry once) | 170 | 10 (6 first tries, 4 retries) | 5.9% | 7 |
| 3 (retry once) | 168 | 5 (4 first tries, 1 retry) | 3.0% | 4 |
| #2838 alone, concurrency 8 | 61 | 3 | 4.9% | 5 |
| #2838 alone, concurrency 1 | 61 | **0** | 0% | 2 |

- **Which targets fail:** every failure is on an override of `Object.equals` or
  `Object.toString` (#2838's `GsonTypes.*Impl`, #1700). These are huge hierarchies.
- **Cause:** concurrent queries. At concurrency 1 the same PR had no failure.
- **Fix (src, small):** a rejection that Java's extras call transient (`(code -32603)` or
  `Internal error`) is asked once more at once (`EditorCallerExtras.retryRejected`, used by
  `queryHierarchy` in `resolver-vscode.js` and the harness). It recovers some failures, not
  all: the retry runs while the other 7 queries are still going.
- **Still incomplete:** a second rejection stays incomplete with jdtls' message, and so does
  any other error (unit test in `test/java-callers.test.js`).
- **Proposed next fix:** a per-language concurrency cap for Java caller queries (1–2 for
  targets that override an `Object` method, or for all Java). Its cost: #2838's pipeline took
  76 s at concurrency 1 against 55 s at 8.

## Fixes

1. **src:** the bounded -32603 retry above (`src/languages/callers-from-hierarchy.js`,
   `src/languages/types.js`, `src/resolver-vscode.js`, `src/languages/java/editor-extras.js`),
   with its regression test.
2. **Harness:**
   - jdtls setting `java.configuration.updateBuildConfiguration: automatic`. jdtls' default,
     `interactive`, asks the client before re-importing a changed pom, and the harness never
     answers, so the modules kept the previous commit's versions.
   - `closeAll()` in `stdio-server-services.js`: no open document keeps an old commit's text.
   - `waitQuiet()` in `jdtls-services.js`.
   - Implicit-`super()` sites are matched by line; multi-line calls count as updated in the
     "fine" check.
   - Labels: annotation-element uses, javac errors in the file, modules outside the project.

## Times and caches

| Run | wall time | notes |
| --- | --- | --- |
| single #2072 (cold `-data`) | 87 s | jdtls ready in 66 s |
| run 1 | 296 s | quiet waits ≈ 218 s |
| run 2 | 288 s | `npm test` and the syntactic checks ran at the same time |
| run 3 | 234 s | the golden comparison ran at the same time for part of it |

- Every full run was over the 3-minute budget for a cached run. Almost all of the time is
  jdtls refreshing and re-importing after each switch (3.6–20.5 s per PR); the pipeline
  itself took 0.7–37 s per PR.
- **Caches:** oracle (a) `~/Projects/impact-tree-scratchpad/java-oracle/verify/`, oracle (b)
  `~/Projects/impact-tree-scratchpad/java-oracle/callers/`, jdtls
  `~/Projects/impact-tree-scratchpad/java-tools/jdtls-data/gson-verify`.

## Open

- **The 45 misses on complete answers in #1904 (extras, metrics, proto).** First tell a short
  quiet window apart from a failed import: rerun #1904 alone with a fresh server, which gets
  the full import. If it is a failed or partial import, the editor is exposed too. A Maven
  module jdtls cannot build reads as complete.
  - Proposed fix: mark Java answers incomplete when jdtls reports a project with build errors,
    or a workspace `.java` file outside every project (as `examples/` here).
- **Not verified:** whether VS Code turns a provider error from `vscode.provideIncomingCalls`
  into `[]`. If it does, a -32603 in the editor would read as "no callers", not as a
  rejection.
  - The retry regex accepts VS Code's bare `Internal error.` message, but that message was not
    checked against a live VS Code.
- **Pre-existing failure:** `npm test` fails one test on main, unrelated to J6:
  `test/not-analysed.test.js` "the command line analyses a Java file from its text". It
  expects "not computed: Java callers", but since J8 the CLI computes them from syntax.
  Checked at `b930856` in a scratch worktree.
