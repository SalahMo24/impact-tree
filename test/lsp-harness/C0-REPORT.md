# C0b spike: Roslyn's language server in the harness and in VS Code

Part C, step C0b (plan: `impact-tree-scratchpad/csharp-plan/PLAN.md`). Dev tools only; nothing
in `src/` changed. Run on 2026-11-20 on the shared Intel i7 / 16 GB machine, every heavy run
under `with-repo-lock.sh`.

**Answers in one paragraph.** Roslyn's call hierarchy answers in the harness and in VS Code,
for methods, constructors (incl. `new()`, `: this()`, `: base()`), properties and their
accessors, extension methods, method groups and local functions; it does **not** answer for a
primary constructor. **`Impl.M` does not list calls made through `IFoo.M`, and `IFoo.M` does
not list calls on `Impl` receivers**; the two sets are disjoint (jellyfin: 120 vs 32 sites,
overlap 0); the same for `virtual` / `override`. So C-D5's labelled rows need `callerTargets`
at the interface member, not a receiver reading. In VS Code, "no provider" and "C# extension
not ready" both answer `[]`, and "still loading" answers a **partial non-empty** list; the C#
extension exports a promise and an event that tell when the projects have loaded
(`initializationFinished()`, `experimental.languageServerEvents.onServerStateChange`, state 3).
**Recommendation: C-D3 (a) confirmed**, with the probe changed: the provider waits on the
C# extension's `initializationFinished()` and does not read a prepare answer during the load.

## Setup

| | |
| --- | --- |
| Server (harness) | MIT `roslyn-language-server` 5.13.0-1.26514.10 osx-x64, `dotnet …/Microsoft.CodeAnalysis.LanguageServer.dll --stdio --logLevel Information --telemetryLevel off --extensionLogDirectory …` on the scratchpad SDK 10.0.404 (runtime 10.0.15); `serverInfo.name` = `CSharpVisualBasicLanguageServerFactory` |
| Server (editor) | the one in the C# extension 2.160.4 VSIX: 5.12.0-1.26452.1 (`C#.log`), only inside the pinned VS Code 1.146.0 of `drive.js` |
| jellyfin | `impact-tree-test-repos/jellyfin-c0b` (shared clone of `jellyfin`, checkout 821b849e6, `Jellyfin.slnx`, 41 projects incl. 18 test projects); `jellyfin` and its `origin` untouched |
| fixture | `impact-tree-scratchpad/csharp-tools/c0b-fixture/` — `Fixture.sln`: `Lib` (class library) + `App` (console, top-level statements, references `Lib`) |
| Tools | `test/lsp-harness/roslyn-services.js` (services adapter), `test/lsp-harness/c0-spike.js` (the run); outputs in `csharp-tools/c0b-runs/` (`run1.*` cold, `run2.*` warm, `probe/`, `drive/`) |

## 1. Launch protocol and load times

- **stdio**, standard `initialize` → `initialized`. `initialize` answers in 0.8–1.5 s and
  advertises `callHierarchyProvider: true`, `implementationProvider: true`,
  `referencesProvider: {workDoneProgress: true}`, `documentSymbolProvider: true`.
- **Opening:** the client sends the notification `solution/open { solution: <uri> }`
  (`.sln` and `.slnx` both load) or `project/open { projects: [<uri>…] }`. The DLL also knows
  `--autoLoadProjects` (README: a single root `.sln`/`.slnx`, else every `.csproj`, or
  `dotnet.defaultSolution` from `.vscode/settings.json`); the harness does not use it.
  VS Code's C# extension sends `project/open` ("Workspace projects" in its state events).
- **Load finished:** the server sends `workspace/projectInitializationComplete` (no params).
  Progress `$/progress` "Loading <solution>..." / "Loading 41 project(s)..." comes before it;
  `window/logMessage` lines "Successfully completed load of <csproj>" per project.
- **Restore:** 5.13 restores **by itself** (no client request: `workspace/configuration` was
  answered null and `dotnet.projects.enableAutomaticRestore` defaults to on): a project that
  loads with "has unresolved dependencies" gets `Restoring X.csproj: Running dotnet restore…`
  under a `Restore` progress. On the unrestored fixture, `projectInitializationComplete`
  came at 7.70 s while `App.csproj` was still being found unresolved (7.697 s) — **load
  complete does not mean restore complete**. jellyfin was restored beforehand
  (`dotnet restore Jellyfin.slnx`, cold NuGet cache, downloads included: **256 s**), so no
  solution project restored during the timed loads. Every run also restored a throwaway
  `Canonical.csproj` (the "file-based programs" misc project Roslyn makes for a file opened
  before its project loads — here the query sent during the load), ~1.5 s, in a temp folder.
- No `workspace/_roslyn_projectNeedsRestore` request was ever sent (0 server requests about
  restore); the DLL has `workspace/_roslyn_restore` and `workspace/_roslyn_restorableProjects`
  for a client that wants to drive restore itself.
- The server's MSBuild `BuildHost` children keep the stdio pipes open after the server exits:
  the first fixture run's harness hung ~3 min after "total 7.75 s". `roslyn-services.js`
  `close()` now kills the server's descendants (pgrep -P) after shutdown.

| Load (launch → `projectInitializationComplete`) | run 1 (cold) | run 2 (warm) |
| --- | --- | --- |
| fixture (2 projects) | 5.3 s | 5.5 s |
| jellyfin (41 projects, restored) | **25.1 s** | **18.9 s** |
| first call-hierarchy answer after load (jellyfin, `ILibraryManager.GetItemById`: prepare + incoming) | 2.4 s + 5.6 s | 1.7 s + 4.3 s |
| whole spike (both corpora, ~100 requests) | 65 s | 55 s |

"Cold" = first Roslyn load of jellyfin on this machine after restore (OS file cache warm from
the restore); Roslyn keeps no workspace cache on disk between runs, so warm is mostly the OS
cache. **5.13 vs 5.12:** the answers compared in both (fixture `IFoo.M` / `Impl.M` prepare and
incoming calls) were the same in the editor's 5.12 as in the harness's 5.13 (section 4).
References at `Impl.M` were 8 in VS Code vs 6 in the harness: VS Code's reference command
includes the declarations (`Impl.M`, `IFoo.M`), the harness asks with `includeDeclaration:
false`. Only the fixture was compared; no difference that matters was seen.

## 2. documentSymbol (cross-check of C2 only)

- Hierarchical (`DocumentSymbol` with children): Namespace → Class/Interface → members.
- **Names carry parameter types and return type**: `M(int) : int`, `GetUserById(Guid) : User?`,
  `OnChanged(object?, EventArgs) : void`; `detail` repeats the name. Types as written in short
  form, generic arguments kept (`ILogger<ItemsController>`), `?` kept; an extension method
  shows **no** `this` (`Twice(int) : int`).
- **Constructors have kind Method (6)**, not Constructor (9): `Base()`, `Base(int)`.
- Properties: one symbol `Doubled : int` (kind 7), **no accessor children**; fields (8),
  constants (14) and events (24) are listed too.
- **No symbol for a primary constructor** (`class Svc(IFoo foo)` has only `Run()`), and
  **none for top-level statements**: `App/Program.cs` answers `[]` (its local function
  `Local()` is not listed either).
- **Ranges = the C0a-1 syntax oracle's**: attributes in, XML doc comments out (`[Serializable]`
  class `Svc`: range starts at the attribute line 50, doc comment on 49 left out).

| File (jellyfin) | oracle members | paired by name offset | range equal | starts at an attribute | includes the doc comment |
| --- | --- | --- | --- | --- | --- |
| `Jellyfin.Api/Controllers/ItemsController.cs` | 9 | 9 | 9 | 8 | 0 |
| `Jellyfin.Server.Implementations/Users/UserManager.cs` | 43 | 43 | 43 | 1 | 0 |
| `MediaBrowser.Controller/Entities/InternalItemsQuery.cs` | 6 | 6 | 6 | 0 | 0 |
| `Emby.Server.Implementations/Library/LibraryManager.cs` | 166 | 166 | 165 | 0 | 0 |

The one difference: `LibraryManager.ExtraCandidate.<init>(…)` (a positional record): the
oracle's range is the parameter list (C0a-1's primary-constructor rule), the server's the
whole record declaration. documentSymbol took 48–431 ms per file.

## 3. Call hierarchy

### Fixture (every case; run 2, same as run 1)

| Target | prepare item (name / detail / kind) | incoming callers → call sites |
| --- | --- | --- |
| `IFoo.M` (interface) | `IFoo.M(int)` / `Lib.IFoo` / 6 | `Callers.ViaInterface(Lib.IFoo)` `f.M(1)`; `Svc.Run()` `foo.M(1)`; `AppUser.Use(Lib.IFoo)` (App project) `f.M(3)`; top-level `f.M(9)` — **only calls typed `IFoo`** |
| `Impl.M` (implements `IFoo.M`) | `Impl.M(int)` / `Lib.Impl` / 6 | `Callers.ViaImpl(Lib.Impl)` `i.M(2)`; top-level `new Impl().M(5)` — **none of the 4 calls through `IFoo`** |
| `Base()` | `Base.Base()` | `Base.Base(int)` via `: this()` |
| `Base(int)` | `Base.Base(int)` | `Derived.Derived()` via `: base(1)` |
| `Derived()` | `Derived.Derived()` | `Callers.Ctors()` `new Derived()`; `AppUser.UseBase()` (cross-project) |
| `Point()` | `Point.Point()` | `Callers.Ctors()` 2 sites: `new Point()` and target-typed `Point b = new()`; `Point.Point(int)` via `: this()` |
| `Point(int)` | `Point.Point(int)` | `Callers.Ctors()` `Point c = new(3)` |
| `Base.V` (virtual) | `Base.V()` | `Callers.ViaBase` `b.V()` only — not `d.V()` / `new Derived().V()` |
| `Derived.V` (override) | `Derived.V()` | `Callers.ViaDerived` `d.V()`, `AppUser.UseBase()` — not `b.V()` |
| `Point.Doubled` (at the name) | `Point.Doubled` / kind **7** | `Callers.Props` 2 sites (read and write) |
| `Doubled` `get` / `set` (at the keyword) | `Point.Doubled.get` / `.set`, kind 6 | the read site / the write site only |
| `Ext.Twice` (extension) | `Ext.Twice(this int)` | `Callers.Extension()` `3.Twice()`; `Program.Local()` `Ext.Twice(2)` |
| `Svc` primary constructor (at `Svc` or at `(`) | **`null`** | — (references: 1, `new Svc(new Impl())`) |
| `Handlers.Handler` | `Handlers.Handler()` | `Callers.Groups` `Router.Map("/x", Handlers.Handler)` (method group) |
| `Handlers.OnChanged` | `Handlers.OnChanged(object, System.EventArgs)` | `Callers.Groups` `bus.Changed += Handlers.OnChanged` |
| `Callers.ViaInterface` | | `Program.<top-level-statements-entry-point>` `c.ViaInterface(new Impl())` |
| `Local()` (local function in top-level statements) | `Program.Local()` / `Program` | `Program.<top-level-statements-entry-point>` `Local();` |
| a doc comment (no symbol) | **`null`** | references `[]`, implementation `[]` |

- **Top-level callers** are named **`Program.<top-level-statements-entry-point>`**, detail
  `Program`, kind 6; `range` and `selectionRange` are both the **whole file** (0:0 → 13:0,
  `using` lines included), so a caller's position is line 1 of `Program.cs`. Not `<Main>$`.
  `fromRanges` point at the real call lines. A local function in them is `Program.Local()`.
- Names: `Type.Member(fully.qualified.ParamTypes)` (`LibraryManager.GetItemById(System.Guid)`,
  `InternalItemsQuery.InternalItemsQuery(Jellyfin.Database.Implementations.Entities.User)` —
  nullable reference `?` dropped, `this` kept for extensions); constructors `Type.Type(…)`;
  detail = the containing type's full name. Constructor items are kind 6.
- **Cross-project** callers come back (`AppUser.Use` in `App` for `IFoo.M` in `Lib`; in jellyfin
  e.g. `ILibraryManager.GetItemById` in `MediaBrowser.Controller` called from
  `MediaBrowser.XbmcMetadata`, `Jellyfin.Api`, the test projects).
- **References** cascade through interface/override both ways: at `IFoo.M` **or** at `Impl.M`
  they list all 6 sites; at `Base.V` or `Derived.V` all 3. **Implementation** at `IFoo.M` →
  `Impl.M`, at `Base.V` → `Derived.V`; at a concrete member, the member itself. References take
  a flat ~500 ms each (its work-done progress), the others 1–20 ms warm.

### jellyfin (run 1 cold / run 2 warm; answers identical)

| Target | prepare | incoming: callers / sites (ms run 1 / run 2) | references | implementation |
| --- | --- | --- | --- | --- |
| `ILibraryManager.GetItemById(Guid)` | 2.36 s / 1.72 s (first query) | 100 / 120 (5.55 s / 4.34 s), 24 callers in `tests/` | 152 | `LibraryManager.cs:1689` |
| `LibraryManager.GetItemById(Guid)` (DI singleton) | 8 ms | 25 / 32 (183 / 162 ms), all inside `LibraryManager` | 152 | itself |
| `IUserManager.GetUserById(Guid)` | 117 / 78 ms | 135 / 143 (1.52 s / 932 ms) | 147 | `UserManager.cs:123` |
| `UserManager.GetUserById(Guid)` (DI singleton) | 4 ms | **3 / 4** (12 / 9 ms), all in tests | 147 | itself |
| `ItemsController.GetItems` (action, 85 params) | 3 ms | 2 / 2 (`GetItemsByUserIdLegacy`, `TrailersController`) | 2 | itself |
| `ClaimsPrincipalExtensions.GetUserId` (extension) | 13 ms | 64 / 66 (288 / 223 ms) | 66 | itself |
| `InternalItemsQuery(User?)` ctor | 7 ms | 85 / 94 (323 / 216 ms) | 94 | itself |
| `Folder.GetChildren(User, bool, InternalItemsQuery)` virtual | 658 / 511 ms | 22 / 23 | 26 | 5 overrides |
| `UserView.GetChildren` override | 614 / 512 ms | 2 / 2 (calls on `UserView` receivers only) | 25 (cascades to the base) | itself |
| `Program.StartApp` (method group `MapResult(StartApp, …)`) | 137 / 99 ms | 1 / 1 `Program.Main(string[])` | 1 | itself |
| `ILibraryManager.RootFolder` (interface property) | 2 ms | 17 / 17 | 22 | `LibraryManager.cs:218` |

- **Interface vs implementation on jellyfin:** `ILibraryManager.GetItemById` 120 sites,
  `LibraryManager.GetItemById` 32 sites, **overlap 0**, union = the 152 references;
  `IUserManager.GetUserById` 143 vs `UserManager.GetUserById` 4, overlap 0 (147 references).
  A PR changing `UserManager.GetUserById` would show 3 test callers from the call hierarchy
  while 135 callers reach it through DI.
- The test projects are in `Jellyfin.slnx`, so test callers come back (24 of 100 on
  `ILibraryManager.GetItemById`).
- **Parallel** (incoming calls, 8 queries over the jellyfin items, already asked once, so warm):

| at a time | run 1: wall / median / max / errors | run 2: wall / median / max / errors |
| --- | --- | --- |
| 1 | 2.39 s / 154 ms / 1.21 s / **0** | 2.05 s / 132 ms / 1.01 s / **0** |
| 2 | 467 ms / 132 ms / 209 ms / **0** | 409 ms / 114 ms / 185 ms / **0** |
| 4 | 372 ms / 186 ms / 306 ms / **0** | 317 ms / 158 ms / 268 ms / **0** |

  No error of any kind (no -32603 as jdtls gave) in ~200 requests over the two runs. The
  queries repeated warm items, so this shows the server takes 4 at a time without errors, not
  the cost of 4 cold queries (one cold query: up to 5.6 s, above).
- **Queries during the load:** a prepare + incoming sent right after `solution/open` answered
  at 3.3 s with 1 item and **0** incoming calls on jellyfin (load complete at 18.9–25.1 s), and
  1 item with 1 of 4 callers on the fixture: during the load the file is answered from the
  misc-files project, so an early answer is partial, not an error.

## 4. Editor (one probe run in the driver's VS Code)

**How it ran.** `scripts/drive.js` gained three options and one step (documented in
`docs/driving-the-extension.md`): `--extensions-dir DIR` (here
`.vscode-test/ext-csharp-c0b/` of the C0b worktree at the time, since moved to
`csharp-tools/vscode-ext/`, see "The C# extensions folder" below: the VSIX's `extension/` folder
copied in, never the owner's editors), `--settings FILE`, `--extension-dev PATH` (a 70-line probe extension in
`csharp-tools/c0b-probe/`, never shipped) and `pause:SECONDS`. `.NET` came from the scratchpad
(env.sh sourced: `DOTNET_ROOT`, `PATH`, `NUGET_PACKAGES`); telemetry off
(`telemetry.telemetryLevel: off`, which the C# extension follows).

```
. csharp-tools/env.sh; C0B_PROBE_OUT=…/c0b-runs/probe node scripts/drive.js \
  --repo …/c0b-fixture --extensions-dir …/csharp-tools/vscode-ext \
  --settings …/c0b-probe/settings.json --extension-dev …/c0b-probe pause:20 pause:18 shot:csharp
```

**Install problems (4 runs instead of 1; each 43–45 s; the first three measured nothing about
call hierarchy).** The C# extension declares a dependency on `ms-dotnettools.vscode-dotnet-runtime`
(the .NET Install Tool), which is not in the scratchpad and would be a marketplace download.
A local stub with that id stands in for it: (1) version `0.0.0-stub` → the C# extension shows
"requires at least 2.2.3 of the .NET Install Tool" and never starts; (2) renaming the folder
made VS Code mark the stub obsolete and drop both extensions (its `extensions.json`); (3)
version 3.0.0 → the C# extension activates but `initializationFinished()` rejects with
"command 'dotnet.findPath' not found" (without C# Dev Kit it ignores `dotnet.toolingRuntimePath`
and asks the Install Tool for .NET); (4) the stub registers `dotnet.findPath` → returns
`$DOTNET_ROOT/dotnet`: the server started. Later steps (C7) can reuse this folder and stub as
they are; the real Install Tool (a download needing the owner's yes) would also work.

**The C# extensions folder** (moved after the C0–C2 review, finding 19). It lives at
`~/Projects/impact-tree-scratchpad/csharp-tools/vscode-ext/` (about 340 MB, outside any
worktree; `drive.js --extensions-dir` accepts only folders under `.vscode-test/` or the
scratchpad and refuses an editor's own). It holds:

- `ms-dotnettools.csharp-2.160.4-darwin-x64/`: the `extension/` folder of
  `csharp-tools/vsix/ms-dotnettools.csharp-2.160.4-darwin-x64.vsix` (unzipped in
  `csharp-tools/vsix/unzipped/`), copied as is. It runs only inside the driver's VS Code; no
  committed code starts its server (licence, see §1).
- `ms-dotnettools.vscode-dotnet-runtime-3.0.0-stub/`: the local stand-in for the .NET Install
  Tool, two files. `package.json`: `name` `vscode-dotnet-runtime`, `publisher`
  `ms-dotnettools`, `version` `3.0.0` (the C# extension needs at least 2.2.3; keep the folder
  name, a rename made VS Code drop it), `main` `./stub.js`, `activationEvents`
  `["onCommand:dotnet.findPath"]`, `contributes.commands` `dotnet.findPath`. `stub.js`:
  `activate` registers `dotnet.findPath`, returning `{ dotnetPath: path.join(process.env.DOTNET_ROOT, 'dotnet') }`
  (or `undefined` without `DOTNET_ROOT`), so the C# extension uses the scratchpad's .NET
  (source `csharp-tools/env.sh` before the run).
- `extensions.json`: VS Code's list of the two, by `relativeLocation` (the folder names above);
  its absolute `location` paths were rewritten to the new folder.

To rebuild it: make the folder, unzip the VSIX and copy its `extension/` folder in under the
name above, write the stub's two files as described, and write `extensions.json` with one entry
per folder (`identifier.id`, `version`, `location` as a file URI, `relativeLocation`), or start
the driver once with the folder and let VS Code list them.

**What the probe saw** (ms from the probe's activation, run 4; `probe/probe.json`, `probe/csharp-logs/C#.log`):

| ms | event |
| --- | --- |
| 11 | `vscode.prepareCallHierarchy` on a **plaintext** document (no provider): **`[]`** |
| 23 – 18 353 | at `IFoo.M` in `Lib/Shapes.cs`, every 500 ms, C# extension active, server not started: **`[]`** |
| 19 901 | `onServerStateChange` state **1** (server started) |
| 20 113 | state **2** "Workspace projects" (`project/open` sent) |
| 21 141 – 23 694 | prepare → `IFoo.M(int) | Lib.IFoo`, incoming → **1 caller (`Svc.Run()`) of 4**: partial |
| 23 989 | state **3** (`workspace/projectInitializationComplete`) and `initializationFinished()` resolves |
| 25 171 | incoming → all 4 (`Callers.ViaInterface`, `Svc.Run`, `AppUser.Use`, `Program.<top-level-statements-entry-point>`) |
| 25 186 | `Impl.M` → 2 (`Callers.ViaImpl`, top-level): same as the harness's 5.13 |
| 25 774 | references at `Impl.M`: 8 (the 6 call sites + both declarations) |

- **A call-hierarchy provider is registered for `csharp`**: `vscode.prepareCallHierarchy` and
  `vscode.provideIncomingCalls` answer through the C# extension, same answers as the MIT server.
- **"No provider" and "not ready yet" look the same: `[]`** (plaintext, and C# before its server
  started); **"still loading" is a partial non-empty answer** (1 of 4 callers). So no probe that
  reads answers can tell them apart; the C# extension's state can.
- **State an extension can read** (`vscode.extensions.getExtension('ms-dotnettools.csharp').exports`):
  keys `isLimitedActivation, initializationFinished, profferBrokeredServices, logDirectory,
  determineBrowserType, experimental, getComponentFolder, tryToUseVSDbgForMono,
  languageServerProcessId, captureActivityLogs`; `experimental` = `sendServerRequest,
  sendServerRequestWithProgress, languageServerEvents, activeDocumentLanguageSupport`.
  - `initializationFinished()`: a promise; resolved at the same ms as state 3 (projects loaded);
    **rejects** when the server cannot start (run 3). Usable by a late caller.
  - `experimental.languageServerEvents.onServerStateChange`: `{ state, workspaceLabel }`,
    0 stopped, 1 started, 2 project initialization started, 3 complete (the extension's
    source: 3 fires on `workspace/projectInitializationComplete`). An event only: a late
    subscriber does not get the current state. "experimental" in the name.
  - `experimental.sendServerRequest(type, params, token)` would let us send our own LSP request.
  - Commands: `dotnet.restore.project`, `dotnet.restore.all`, `dotnet.openSolution`,
    `dotnet.restartServer`, `csharp.showOutputWindow`, `csharp.collectLogs`, … No restore state
    is exported; restore shows only in its ".NET NuGet Restore" output channel and as progress.
- In VS Code the server took ~20 s from activation to start (process info at +7 s, "initialized"
  at +19 s in `C#.log`) on the busy machine with the editor starting; the harness's initialize
  took 1.5 s. Loading the fixture then took 4 s.
- Not done: a run with the C# extension disabled (the plaintext answer stands in for "no
  provider"); Cursor (`anysphere.csharp` / DotRush) is the owner's manual check per C-D3.

## Recommendations

**C-D3: (a) confirmed, with the probe redesigned.** Roslyn answers call hierarchy in VS Code,
for every shape C# needs except primary constructors. But C-D3's probe as written ("a
positive answer is kept for the session; an empty answer while the solution loads looks like
no extension") is not safe: during the load the answer is **partial and non-empty**, so a
"positive" probe during the load would be cached and its incomplete caller lists trusted.
The editor provider should instead:
1. If `ms-dotnettools.csharp` is not installed or not enabled → syntax index, note "no C# call
   hierarchy". (No answer-reading needed.)
2. Else `await exports.initializationFinished()` (with a deadline, e.g. the warm-up budget);
   rejected or past the deadline → syntax index with a note "the C# extension's server did not
   finish loading". Resolved → ask call hierarchy; an empty answer then means no callers.
3. Optionally listen to `onServerStateChange` for a later reload (state 2 again after a
   project change) and mark answers in flight incomplete.
Also: `projectInitializationComplete` can come before a project's own restore finished (fixture,
unrestored), so on a repository never restored, answers just after the load can still be
partial; C6/C7 should restore (or wait for the restore progress) before measuring.

**C-D5's editor half: `callerTargets` at the interface member.** Roslyn does what jdtls and
gopls do *not*: `incomingCalls` on `Impl.M` lists only calls whose receiver is typed `Impl`
(and on `IFoo.M` only those typed `IFoo`); the same split for `virtual`/`override`. Reading
each row's receiver cannot recover the interface calls because they are not in the rows. C5
must ask a second prepare + incoming at `IFoo.M` (found by the syntax index from `class Impl :
IFoo`, or by the editor's type hierarchy) and label those rows "through `IFoo`" — the plan's
`callerTargets` route. For overrides the same at the base member ("through `Base`"). The rows
from the two queries never overlap (jellyfin: 0 shared sites), so C-D5's "reached both ways →
one unlabelled row" merge is by caller, not by site. References are a usable cross-check
(they cascade both ways: interface ∪ implementation = 152 on `GetItemById`).

## What changes later steps

- **C2/C3:** documentSymbol agrees with the oracle's ranges, but it has no primary constructor,
  no top-level symbol, constructors as kind 6 and names with types: symbols must come from the
  outline (as planned), not from documentSymbol.
- **C4/C5 keys:** call-hierarchy names are `Type.Member(Fully.Qualified.Types)` with `?` on
  reference types dropped, constructors `Type.Type(…)`, accessors `Type.Prop.get`; top-level
  callers `Program.<top-level-statements-entry-point>` spanning the whole file → map a row to
  a key by its `selectionRange` against the outline (not by name), and map the top-level item
  to the file's module symbol (`Program.cs`, C-D4/C-D6).
- **C5:** a changed primary constructor gets `null` from prepare: fall back to the syntax index
  (or to `references` at the type, which listed `new Svc(…)`), marked incomplete.
- **C5/C7:** the solution includes test projects; callers in `tests/` come back as in Java.
- **C6 (warm-up):** budget ~20–25 s for jellyfin's load in the harness (restored), plus up to
  ~6 s for the first incoming query on a heavily used interface member; in VS Code add the
  C# extension's own start (~20 s seen on the loaded machine).
- **C7 (editor verify):** reuse `csharp-tools/vscode-ext/` (stub Install Tool with
  `dotnet.findPath`) and `drive.js --extensions-dir/--settings/--extension-dev`; the 60 s
  `drive.js` deadline was enough for the fixture (43 s), not for jellyfin (would need
  ~20 s start + ~20 s load + queries): C7 needs a longer deadline option.
- **Harness:** `roslyn-services.js` must kill the server's BuildHost children on close (done);
  the server does not need a restore request from the client.
