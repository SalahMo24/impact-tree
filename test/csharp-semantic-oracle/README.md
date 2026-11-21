# Roslyn semantic caller oracle (Part C, C0a-2)

Dev tool for caller verification (C8a's `csharp-verify.js` caller modes, C7's oracle (b));
not part of `npm test`. It loads a repository's **non-test** projects with `MSBuildWorkspace`
(Roslyn 5.12.0), binds every call site of every in-repo `.cs` file and writes each call edge
with its caller and target keyed per C-D6. Keys come from the syntax oracle's own function
(`Oracle.MembersOf` in `../csharp-syntax-oracle/Program.cs`, compiled into this project), so a
key here is byte-for-byte a key of `syntax-*.json` for the same file. Shares no code with `src/`.

The repository must be restored (`dotnet restore <solution>`); nothing is built or run. Test
projects (a path with a `test/` or `tests/` folder, or a `*.Test(s).csproj`) are not opened, and
no non-test project references them, so they are out of the load. Source generators run (in
this process), so generated members bind; generated files are not walked.

    bash run.sh <repo> <solution (.slnx/.sln) or project> [name]

`run.sh` builds the oracle into the scratchpad's `csharp-tools/oracle-semantic/` (test/lsp-harness/scratchpad.js)
(when the tool hash changed), then writes
`csharp-tools/cache/semantic-<name>-<sha12>-<toolhash>.json` unless it exists, and prints its
path. toolhash = sha256 of `Program.cs`, `SemanticOracle.csproj` (pins Roslyn) and the syntax
oracle's `Program.cs`. It refuses a repository with uncommitted tracked changes (the cache is
by commit). The caller holds the heavy-run lock (`with-repo-lock.sh`). By hand:
`dotnet SemanticOracle.dll <repo> <entry> <out.json>`.

## Output

```
{ "oracle": "csharp-semantic", "roslyn": "<assembly version>", "commit": "<sha>", "dirty": false,
  "entry": "cs-a.slnx",
  "timings": { "openMs", "compileMs", "bindMs", "totalMs" },
  "projects": [ { "name", "path", "files", "errors" } ],   // files walked, binding errors
  "excludedProjects": [ "tests/…csproj" ],
  "diagnostics": { "workspace": [ "<kind>: <message>" ], "declarationErrors": 0, "bindErrors": 0, "errorSample": [] },
  "skipped": { "<reason>": count },                        // bound sites that are not edges
  "edges": [ Edge, … ],
  "interfaces": [ { "member", "file", "implementations": [ { "key", "file" } ] } ],
  "overrides":  [ { "member", "file", "overrides": [ { "key", "file" } ] } ] }
```

Edge:

| field | meaning |
| --- | --- |
| `caller` | key of the member the site is in; a lambda or local function belongs to its member; top-level statements: the file's basename. `null` with `callerContext` when the site is in no C-D4 member: `field-initializer`, `property-initializer-not-a-member` (an auto-property's initializer), `finalizer`, `event-accessor`, `attribute`, `enum-member`, `type` |
| `target`, `targetFile` | key and file of the bound symbol's original definition (generic definition; an extension method's static method; a partial method's defining part). In-repo targets only. Keys drop namespaces, so `targetFile` (and `file` for the caller) tell same-named types apart |
| `kind` | `invocation`, `object-creation` (incl. target-typed `new()`), `initializer` (`: this(…)`, `: base(…)`, a primary-constructor base `: B(…)`), `property-get`, `property-set` (an indexer too; `+=`/`++`/`??=` give both), `method-group` (a method used as a value) |
| `file`, `start`, `end`, `line` | call site: UTF-16 offsets of the name (`b` of `a.b(…)`, the type's last name in `new N.T()`, `new` for `new()`, `this`/`base` of an initializer, the `[…]` of an indexer); a BOM counts as one unit, as in the syntax oracle and JavaScript; `line` 1-based |
| `via` | `interface`: bound to an instance member of an interface, with `implementations` = number of in-repo implementing members (listed in `interfaces`). `override-base`: a virtual dispatch (not `base.M()`) bound to a virtual/abstract/override member that has in-repo overrides, with `overrides` = their number (listed in `overrides`, transitive). Absent: a direct call |

`interfaces`: every in-repo interface member (method or property with a key) and its in-repo
implementing members, through base classes too (`FindImplementationForInterfaceMember` on every
in-repo class/struct). Implementations with no key (an auto-property implementing an interface
property) are not listed; their number is `unkeyedImplementations` (also on the edge, when > 0).
Body-less interface and `abstract` properties and indexers are members (C-D4), so they are edge
targets: an interface property gets `via: interface`, an abstract one `override-base`. `overrides`: every in-repo member and all in-repo members overriding it,
transitively. Members are keyed with `file` beside `member`, as targets.

`skipped` reasons: `external` (target outside the repo: framework, packages, test projects),
`auto-property` (of a class, struct or record), `record-property`, `anonymous-type-property` (properties that are not C-D4 members, so have no
key), `implicit` (an implicit default constructor, a record's synthesized members),
`local-function`, `delegate-invoke`, `delegate-creation`, `type-parameter-new`, `nameof`,
`dynamic`, `unresolved`, `generated-or-external`.

Not edges (listed limits): implicit calls (`foreach` → `GetEnumerator`, `using` → `Dispose`,
`await` → `GetAwaiter`, collection-initializer `Add`, deconstruction, user-defined operators and
conversions, `with`), event `+=` (the method group on its right is an edge), reflection, Razor.
`#if`: keys are computed on the trees the project parsed (its preprocessor symbols), the syntax
oracle parses with none; a member active only under a project symbol (or a `#2` numbering that
shifts) would have a key here that `syntax-*.json` lacks (none in cs-a at 821b849e6: every
caller and target key of the 16 343 edges is in the syntax oracle's output).
