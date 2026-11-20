# Roslyn syntax oracle (Part C, C0a-1)

Dev tool for `test/lsp-harness/csharp-verify.js --syntactic`; not part of `npm test`. It parses
every `.cs` file of a repository at one commit with Roslyn (`CSharpSyntaxTree.ParseText`,
`LanguageVersion.Preview`, no references, no preprocessor symbols, so inactive `#if` code is
trivia) and writes the C-D4 members of each file, keyed per C-D6. Shares no code with `src/`.
Files are read from git objects (`git ls-tree`, `git cat-file --batch`); nothing is checked
out, built or run. `.cs` files under a `bin/` or `obj/` directory are skipped.

Built and run by csharp-verify.js into `~/Projects/impact-tree-scratchpad/csharp-tools/oracle-syntax/`
with the SDK in `csharp-tools/dotnet` (`csharp-tools/env.sh`). By hand:

    dotnet SyntaxOracle.dll <repo> <commit> <out.json>
    dotnet SyntaxOracle.dll <repo> --list=<file> <out.json>   # lines `<commit>:<path>`

Cache (csharp-verify.js): `csharp-tools/cache/syntax-<repo>-<sha12>-<toolhash>.json`, toolhash =
sha256 of `Program.cs` + `SyntaxOracle.csproj` (which pins the Roslyn version).

## Output

```
{ "oracle": "csharp-syntax", "roslyn": "<assembly version>", "languageVersion": "Preview",
  "commit": "<sha>",                       // absent in --list mode (per file instead)
  "files": [ {
    "path": "src/A/B.cs", "commit"?: "<sha>",
    "diagnostics": 0,                      // parse errors
    "topLevelStatements": false, "hasIf": false,
    "members": [ Member, … ]               // source order
  } ] }
```

Member:

| field | meaning |
| --- | --- |
| `kind` | `method`, `constructor`, `primary-constructor`, `static-constructor`, `property`, `indexer`, `operator`, `conversion`, `top-level` |
| `key` | C-D6 key (below); a repeat in the file gets `#2`, `#3` in source order |
| `name` | identifier; `this` for indexers, `operator +`, `implicit operator X`; the file name for `top-level` |
| `container` | the type path, outermost first, with arity: `Outer<1>.Inner` (namespaces dropped) |
| `explicitInterface` | for explicit implementations: `IFoo` / `IEnumerable<1>` |
| `nameOffset` | UTF-16 offset of the name token (`operator` keyword for operators/conversions, `this` for indexers, the type name for a primary constructor) |
| `start`, `end` | UTF-16 offsets = Roslyn `Span`: attributes in, leading trivia (XML doc comments, comments) out; a primary constructor is its parameter list; `top-level` runs from the first to the last global statement |
| `startLine`, `endLine` | 1-based lines of `start` and of `end` |
| `modifiers`, `attributes` | as written (attribute lists `[A, B(1)]`, one string each) |
| `typeParameters` | method type parameter names |
| `returns` | return / property / indexer type text; `null` for constructors |
| `params` | `{ name, type, keyType, modifiers, default, attributes }`: `type` and `default` as written, `keyType` the key's form |
| `header` | tokens from the first modifier (after attributes) to before the body (`{`, `=>`, accessor list or `;`), joined by one space where the source had trivia (comments dropped) |
| `body` | `block`, `expression`, `accessors` or `none` |

Members (C-D4): methods (body-less interface, `abstract`, `partial`, `extern` ones too),
constructors, a primary constructor (class, struct or record parameter list), static
constructors, properties and indexers only when an accessor has a body or the member is `=>`
bodied, operators, conversions, explicit interface implementations of any of these, and the
file's top-level statements. Not members: local functions and lambdas (their method's body),
finalizers, events, fields, auto-properties, delegates, enum members.

`Oracle.MembersOf(root, path)` returns a file's members with their keys; the semantic oracle
(`../csharp-semantic-oracle/`) compiles this file in and keys callers and targets with it.

## Keys (C-D6)

- Type path: enclosing types with arity when > 0 (`Result<1>.Map(…)`), namespaces dropped; a
  C# 14 `extension(…)` block adds no segment.
- Methods `Type.Name<arity>(T1, T2)` (arity shown when > 0); constructors `Type.<init>(…)`;
  static constructor `Type.<cinit>()`; properties `Type.Name`; indexers `Type.this[int]`;
  operators `Type.operator +(T, T)`; conversions `Type.implicit operator X(Y)`; explicit
  implementations insert the interface: `Type.IFoo.M(…)`, `Type.IEnumerable<1>.GetEnumerator()`;
  top-level statements: the file's basename (`Program.cs`).
- Parameter types: as written minus namespaces and alias qualifiers, generic arguments erased
  (`List<int>?` → `List?`), `?`, arrays (`[]`, `[,]`) and pointers kept, a tuple's element
  names dropped (`(int, string)`); modifiers `ref`, `out`, `in`, `params`, `this`,
  `ref readonly` kept in front, `scoped` dropped.
