# Performance audit before the next release (2026-11-09, main at cb97338, build 1.0.3)

Status: findings 1–4 and the reveal crash of finding 5 are fixed in the working tree (see the
Unreleased section of CHANGELOG.md). Measured after the fix on this machine: module load
180–370 ms → 95–99 ms (0 node_modules files at activation); entry facts on t3code 1.6 s cold →
82–89 ms warm; the CLI's paths, callers and stats are identical before and after the engine
change. The open-PR paging, the `textpos` cache bound and the per-item `viewOf()` remain.

Scope: the extension as a user runs it. Evidence comes from three places: the extension's own
log channel in Cursor (`~/Library/Application Support/Cursor/logs/*/window*/exthost/SalahMo24.impact-tree/Impact Tree.log`,
builds 1.0.2 and 1.0.3, 29 local runs and 5 previews on the t3code checkout), the CLI timed on
this repository (checkpoint v1.0.3: 36 changed functions in 14 files; checkpoint v1.0.0: 75 in 28),
and a module-load measurement of `src/extension.js` against the test stub.

Nothing merged after 1.0.3 (call diff, pseudocode shape, PR search, agent button, folders-only
list) runs per analysis or per tree row; each runs on demand. The slowdown comes from 1.0.0:
the entry-point walk every analysis now runs for the cards, plus two older costs it exposed.

## What the logs show

Local run of the t3code PR (26 files, 1 finding), four runs on 2026-11-08/09:

| run | WALL | queries | cache hits | timed-out queries (5 s each) |
| --- | --- | --- | --- | --- |
| 19:58 | 39.6 s | 182 | 113 | 3 |
| 07:44 | 31.8 s | 174 | 113 | 4 |
| 08:27 | 29.7 s | 182 | 113 | 4 |
| 09:21 | 22.9 s | 182 | 113 | 2 |

"changed files ready" came 3.1–7.2 s into each run (git fetch of the base, the diff, the
TypeScript preparation). The rest is caller resolution plus the entry-point walk. The caller
retry that follows takes 3.3–6.1 s for the same 26 files, which is what the resolve phase alone
costs once the server is warm.

Preview of PR #27345 (4 files, 6 symbols, 0 findings): 66.8 s, "changed files ready" after 24.1 s.
Preview of PR #32298 (1 file, 4 symbols): 25.2 s, ready after 4.1 s. Both logs are full of
`fetch failed` (undici's connection error, cause not shown), each costing ~10 s.

## Findings, ranked

### 1. The entry-point walk is on the critical path of every analysis and re-asks the server

`src/engine/analyze.js:582` awaits `impactWalker.walk` for each component before the result
is returned, and `src/session/session.js:677` turns it on for every local run (`impactPaths: true`).
The final findings therefore wait for a breadth-first walk of up to 8 caller levels and 300
nodes per changed function, one sequential call-hierarchy query per node, under a shared 30 s
deadline (`src/engine/impact-paths.js:33`).

The walk also misses the resolver's cache. The resolve phase asks with tests
(`callerState` → `incomingWithStatus(file, pos)`, key `A…`, `src/session/resolver-vscode.js:176`);
the walk asks without (`incomingWithStatus(file, pos, false)`, key `P…`, `impact-paths.js:46`).
So every changed function is asked a second time, and a query that timed out at 5 s times out
again: the logs show the same two positions (`CommandPolicy.ts@2846`,
`ThreadRelationshipsControl.tsx@26616`) hitting 5001 ms twice in one run, 10–20 s of the WALL.
`walkOne` filters tests out itself (`prod = answer.callers.filter((x) => !x.test)`), so the
`P` answer is derivable from the `A` one.

CLI on this repository (in-process TypeScript resolver, so the editor's IPC cost is absent):

| checkpoint | without walk | with walk | caller queries | walk alone |
| --- | --- | --- | --- | --- |
| v1.0.3 (36 changed) | 7.6 s | 10.7 s | 64 → 162 | 3.7 s |
| v1.0.0 (75 changed) | 9.1 s | 14.2 s | 109 → 256 | 5.3 s |

In the editor each extra query is a round trip to the TypeScript server (median 6–38 ms, up to
the 5 s timeout), so the same 2.5× in queries costs far more than the 40–55% seen here.

Fixes, in order of value:
- Serve a `P` query from an `A` cache entry by filtering `.test`, and from a `queryStates` entry
  that is not ready without asking again. One-line change each in `resolver-vscode.js`; removes
  the duplicate timeouts outright.
- Publish the result before the walk and walk afterwards, the way cards and hints already
  arrive (`publishCards` → `findHints`). The impact paths feed the cards, so they can land with
  the cards' second publish. `impactPathsMeta` is already carried separately on the result.
- Log `impactPathsMeta.walkMs` in `logLocalRun`, so the next log answers this question directly.

### 2. A preview waits ~10 s per failed connection, serially up each directory

`remoteOptions` (`src/engine/remote-config.js:43`) climbs from each changed file's folder to the
root, fetching `tsconfig.json` at every level; `remotePackages` does the same for
`package.json`. A request that cannot connect fails after undici's 10 s connect timeout as
`TypeError: fetch failed`, and `fetchBounded` (`src/github/github-request.js:216`) rethrows it
without its `cause`, so the log says only "fetch failed". In PR #27345, six configuration files
and `package.json` failed that way after "changed files ready": ~43 s for 4 files whose own
texts had already arrived. The first attempt at that preview failed outright the same way.

From a shell on this machine the API answers in 60–310 ms, so the failures were intermittent
inside the editor host, not a steady fault. The extension should still not stall on them:
- Attach and log `e.cause` (`code`, `message`) so the next report names the network error.
- Retry a connection error once, quickly; these are not rate limits or 4xx answers.
- After one connection failure in a preview, stop fetching optional configuration (tsconfig
  chain, package metadata) and warn once, instead of paying 10 s per directory level.

### 3. Entry-point facts read up to 4000 files synchronously on every run

`createImpactWalkerFor` (`analyze.js:725`) calls `gatherEntryFacts`, which runs `git ls-files`
and then `fs.readFileSync` on up to 4000 files (`src/engine/entry-facts.js:18`) on the extension
host's thread, each run and each caller retry. Measured on t3code: 1.75 s cold, 0.9–1.0 s warm,
and the facts are partial anyway ("6866 file(s) not read"). On this repository: 50 ms.

Fixes: cache the facts per repository, keyed by the `ls-files` listing and the head commit, and
reuse them across runs and retries; or gather them off the thread (a worker, or the async
readers the cards already use). The cache also removes the cost from the retry run.

### 4. Activation loads 169 modules, 53 of them for a webview that may never open

`require('./src/extension.js')` takes 180–370 ms and +7.4 MiB heap on this machine
(169 modules: 115 from `src/`, 53 from `node_modules`). `markdown-it` and `sanitize-html` (which
brings `postcss`, 41 files) cost ~120 ms of that and are only used by
`src/views/pr-tab/markdown-html.js` to render PR descriptions. Requiring them inside the render
function removes them from activation. The extension is not bundled (`"main": "./src/extension.js"`,
`vsce package` as is); bundling `src/` with esbuild while keeping `typescript` external would
cut the remaining 115 file reads to one, which matters most on a cold start.

### 5. Smaller items

- **Reveal of the reviewed row fails**: `review: could not show the reviewed row: The "path"
  argument must be of type string. Received undefined` at the start of each run on 2026-11-09.
  `folderNote` (`src/views/changes/tree-item-renderer.js:109`) calls `lastFolder(row.relPath)` in the
  flat layout (the By card order) for a row that has no `relPath`. The reviewed row then does
  not open on a new review. Guard the undefined, and find which row reaches it.
- **Open PR list**: `listOpenPullRequests` pages sequentially; t3code loads 10 pages (1000 PRs,
  truncated) at every activation, ~5 s before the list shows. Pages after the first could be
  fetched in parallel, or the cap lowered for the sidebar.
- **`textpos` line-start cache** (`src/engine/textpos.js:15`) is never evicted; it grows with every
  file the walk and the tree touch over a long window. Bound it (an LRU of a few thousand entries).
- **`viewOf()` is rebuilt for every tree item** (`tree-provider.js:171`), reading the configuration
  and the agent review each time. Cheap today because `agentReviewNow` memoises by key, but it
  belongs once per repaint.

## Checked and fine

- Agent threads reconcile incrementally (`agent-threads.js:177`); viewed-sync batches writes in
  a bounded queue; decorations flush once per turn; the lens repaints on a 0 ms timer.
- Cards and hints run after the result is published; hints' `git grep` is one async process.
- Telemetry flushes once a minute; the agent bridge is a local socket; the launcher is rewritten
  only when its text changed.
- The caller retry, the warm-up (8–12 s, once per window) and `git fetch` of the base per run
  are as designed and visible in the log.
