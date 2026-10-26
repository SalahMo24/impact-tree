# J0 spike: jdtls on google/gson

Date 2026-10-26. Script: `test/lsp-harness/j0-spike.js`. Full output of the final (cold)
run: `~/Projects/impact-tree-scratchpad/java-tools/j0-final-run.log`. A second, warm run
after a fix to the branch-switch probe: `…/java-tools/j0-switch-run.log` (only its §4d is
quoted here).

## Setup

- Machine: macOS (Darwin 25.6.0) x64, Intel i7-9750H, 12 CPUs, 16 GiB. Node v22.16.0.
- Tools (all in `~/Projects/impact-tree-scratchpad/java-tools/`, every checksum checked
  against the published one):
  - **jdtls 1.63.0-202610191322** (`jdtls/`, sha256 checked).
  - **Temurin JDK 25.0.5+8** (`jdk25/`) runs jdtls. **J-D1 is out of date here:** jdtls
    1.63 needs Java 25 to run. On JDK 21 Equinox stops with exit 13 because bundles
    require `osgi.ee JavaSE 25`.
  - Temurin JDK 21.0.13+9 (`jdk/`), downloaded as J-D1 says. jdtls does not use it (it
    lists the Homebrew JDK 17 it finds as the project JRE). It stays available for the
    J3/J6 oracles.
  - Maven 3.9.16 (`maven/`, sha512 checked). Not run: jdtls' embedded m2e resolves
    dependencies itself.
- jdtls launch: `java -jar plugins/org.eclipse.equinox.launcher_*.jar -configuration
  java-tools/jdtls-config` (a copy of `config_mac`) `-data java-tools/jdtls-data/gson`,
  plus `-Duser.home=java-tools/home -Dmaven.repo.local=java-tools/m2`.
  Init options: `java.configuration.maven.userSettings` and `globalSettings` →
  `java-tools/maven-settings.xml` (`<localRepository>java-tools/m2`). Result: the m2
  folder grew to 115 MB on the first import, and `~/.m2` did not exist before or after
  any run.
- Repository: `~/Projects/impact-tree-test-repos/gson`, a full clone at `main` 57731049.
  Its modules are gson, test-jpms, test-graal-native-image, test-shrinker, extras,
  metrics and proto. All of them were imported.
- Scratch Maven project (`java-tools/scratch-proj`, release 21), added as a second
  workspace folder. It covers what gson's main code lacks: records, compact constructors,
  default and static interface methods, generic methods, arrays, a local class, lambdas,
  an anonymous class and annotated parameters.

## 1. documentSymbol

Answers are hierarchical `DocumentSymbol`s, in this shape: Package, then the top-level
type, then its members.

**Method and constructor `name` = simple name + parameter types *as written in source*:**
- Generics are kept, not erased: `getAdapter(TypeToken<T>) <T>`,
  `fromJson(String, Class<T>) <T>` and `isAssignableFrom(TypeToken<?>)`.
- Type parameters of a generic method come after the list, separated by a space:
  `getDelegateAdapter(TypeAdapterFactory, TypeToken<T>) <T>`.
- Other examples:
  `group(List<? extends V>, Function<V, K>, T[], int[][]) <K, V>`,
  `isAssignableFrom(Type, ParameterizedType, Map<String, Type>)`.
- Types are written as in the source: `java.util.function.Function<V, K>` is shown as
  `Function<V, K>`. In gson all types are imported, so this is the simple name, but a
  fully qualified type in the source probably stays qualified (not measured).
- Varargs are kept as `...`: `excludeFieldsWithModifiers(int...)`,
  `getParameterized(Type, Type...)` and `describe(String, int...)`.
- Arrays are kept: `T[]`, `int[][]`.
- Annotations, `final` and parameter names are dropped: `annotated(String)` for
  `final @Deprecated String s`.
- Overloads are distinct and stable, e.g. the 8 `toJson(…)` and 13 `fromJson(…)` of
  `Gson.java`.

Other fields:
- **`detail`** is `" : ReturnType"` for methods (`" : TypeAdapter<T>"`, `" : void"`) and
  `""` for constructors, classes and fields.
- **Type names** carry their type parameters: `TypeToken<T>`, `FutureTypeAdapter<T>`,
  `Generic<T extends Comparable<T>>`.
- **Constructors:** kind Constructor, named `Gson()` and `Gson(GsonBuilder)` (no return
  type). Record compact constructors appear as the canonical one: `Point(int, int)`.
- **`range`** includes the Javadoc, annotations and a leading `//` comment. Starts seen:
  `/**`, `@Override`, `@Test`, and a `// fromJson(JsonReader, Clas…` line comment before
  `fromJson(JsonReader, Type)`. It ends at the closing `}`.
- **`selectionRange`** is the bare name (`toJson`, `Gson`).
- **Nested types:** nested and inner classes are Class children of their class
  (`Gson.FutureTypeAdapter<T>`). A local class (`Local`) is a child of its method.
- **Anonymous classes:** a Class named `new TypeAdapter() {...}` (type arguments
  dropped) or `new Object() {...}`, a child of the enclosing method, with its methods
  inside.
- **Enums:** the enum is kind Enum and its constants are EnumMember. A constant body is a
  child Enum named `{...}` that holds the overriding method, e.g. `FieldNamingPolicy`:
  EnumMember `IDENTITY` → Enum `{...}` → Method `translateName(Field)`.
- **Interfaces:** kind Interface. Default and static methods are plain Methods
  (`describe(String, int...)`, `unit()`), with nothing to mark them as default or static.
- **Lambdas** never appear as symbols.
- **Records**, in the release-21 scratch project: a Class `Point`, components as Fields
  `x` and `y`, then the constructors and methods. In gson's
  `src/test/…/Java17RecordTest.java` (the gson module compiles at release 8) nested
  records show up wrongly: Method `RecordWithCustomNames(String, String)` with
  `detail " : record"`, and no members. Records therefore depend on the module's
  language level.

Call-hierarchy item names use another format: `toJson(Object, Appendable) : void`.
`detail` is the declaring type, qualified, with `$` for nested and anonymous types
(`com.google.gson.internal.bind.TypeAdapters$1`). To pair an item with a symbol, strip
` : Ret`.

## 2. Base side

Measured from Gson.java at three URIs (final run):

| URI | documentSymbol | Names vs the project file | prepareCallHierarchy | incomingCalls |
| --- | --- | --- | --- | --- |
| `file:` copy at `java-tools/tmp-base/Gson.java`, outside every project | 70 symbols in 437 ms (again 8 ms) | identical (70/70) | 1 item, detail `com.google.gson.Gson`, URI of the copy | 0 callers |
| `untitled:Gson.java` | 0 symbols | — | null | — |
| `untitled:/…/Untitled-1.java` | 0 symbols | — | null | — |

For the `file:` copy, jdtls treats the file as a standalone source file, not as part of
the gson project, so it has no callers. In the development run, the first open of the
copy took 21.65 s (the later answer took 6 ms). The final run took 437 ms. My guess is
that the first time jdtls opens a file outside every project it creates its
default-project for standalone files, so allow for up to ~20 s once per `-data`.

## 3. Call hierarchy (final run; counts = caller methods / call sites)

Calls from tests (`src/test/`) and from the other modules (extras, proto, metrics,
test-shrinker, test-graal-native-image) were all found, through m2e's workspace
resolution of the gson module.

| Target | Result |
| --- | --- |
| Constructor `Gson(GsonBuilder)` | 2/2: `GsonBuilder.create()` (`new Gson(this)`) and `Gson()` (`this(GsonBuilder.DEFAULT)`) ✓ |
| Constructor `LinkedTreeMap(Comparator, boolean)` | 2/2: the two `this(…)` calls in the other constructors |
| Constructor `JsonParseException(String)` | 10/13: `super(msg)` from `JsonSyntaxException(String)` and `JsonIOException(String)`, plus `new JsonParseException(` in gson main and test, extras (2) and proto main and test ✓ |
| Interface method `TypeAdapterFactory.create` | 5/5: the calls through the interface (`Gson.getAdapter`, `getDelegateAdapter`, tests) |
| Abstract `TypeAdapter.write` | 31/39, across gson, extras, proto and tests |
| Base `JsonWriter.beginArray` | 47/54 |
| Override `JsonTreeWriter.beginArray` | 59/69, more than the base. Calls through the base type `JsonWriter` are counted as callers of the override. |
| `super.appendFields(sb)` (target `TestTypes.Nested.appendFields`) | 2/2, including `InheritanceTest$SubTypeOfNested.appendFields` at InheritanceTest.java:166 (the `super.` call) ✓ |
| Override `SubTypeOfNested.appendFields` | 1/1: the base class's own `appendFields(sb)` call (dynamic dispatch, attributed to the override) |
| Method reference `JsonStreamParser.next` (`parser::next`) | 28/42 in 11.0 s. `parser::next` sites are included as call sites (JsonStreamParserTest:76/82/94/103). The 28 also include **`Iterator.next()` calls on unrelated iterators** (LinkedTreeMapTest, JsonObjectTest keySet, JsonTreeReader:142), because `JsonStreamParser.next` implements `Iterator.next`. `references`: 42 in 1.15 s, 6 of them `::next` sites. |
| Method reference `JsonElement.isJsonNull` | 17/17, including the method reference `JsonElement::isJsonNull` (JsonArrayAsListTest:182). `references`: 18 in 99 ms, 1 `::` site. |
| `Gson.getDelegateAdapter` | 15/18: extras 3, gson main 2, tests 10 ✓ |
| Overload `Gson.toJson(Object, Appendable)` | 4/4, all in tests. Only this exact overload is returned ✓ |
| Scratch: record `Point` (position on `record Point(`) | Prepare gives the Class item. 2 callers: `this(both, both)` and `new Point(0, 0)` |
| Scratch: `Shape.area()` | 1/1, from the default method `describe` |

What this means:
- Constructors, `this(` / `super(`, exact overloads, tests and other modules all work.
- Method references and value uses are returned as callers too. J4 should label `::`
  sites as value uses (G4).
- Over-reporting for overrides: incomingCalls on a method that overrides or implements
  another one returns the callers of the method it overrides (an interface or base
  method, even a JDK one such as `Iterator.next`). This confirms the plan's J4 rule to
  mark overriding methods incomplete. It also means their callers are a superset, not
  exact.
- A position on a class name (or on `record X(`) gives the Class, not a constructor. J2
  should send prepare at the constructor's own `selectionRange`.

## 4. Times

Final run, cold (emptied `-data`, m2 already filled):

| Phase | Time |
| --- | --- |
| spawn → initialize reply | 2.72 s |
| ServiceReady | 8.42 s |
| all `$/progress` tokens ended (builds and module-path updates) | 27.95 s |
| first documentSymbol (Gson.java) after that | 447 ms (spawn → first symbols: 28.4 s) |

- **First import ever (empty m2, development run):** ServiceReady at **78.3 s**. That
  time is mostly downloading 115 MB of Maven plugins and dependencies. It only happens
  once per m2.
- **Warm restart (same `-data`):** initialize 3.16 s, ServiceReady 3.48 s, first
  documentSymbol 911 ms. The first prepare + incoming is 255 ms + **4.79 s** (index
  warm-up). In the second run, the start right after the branch switch (its poms had
  changed) needed ServiceReady 22.8 s and quiet 27.8 s: an m2e re-import.
- **Per query after warm-up** (median of 7):

  | Query | Median |
  | --- | --- |
  | documentSymbol Gson.java (1288 lines) | 5 ms |
  | documentSymbol GsonBuilder.java | 4 ms |
  | prepareCallHierarchy | 3 ms |
  | incomingCalls toJson(Object, Appendable) | 297 ms |
  | incomingCalls getAdapter(TypeToken) | 191 ms |
  | incomingCalls JsonStreamParser.next (Iterator implementer) | 11 s, single run |

- **Branch switch** (`git checkout HEAD~40` = aebc51a56c: 74 files, 57 .java, 8 pom.xml;
  then one `workspace/didChangeWatchedFiles` with every changed path; the probe file is
  not open):
  - documentSymbol of the probe `stream/JsonReader.java` (110 lines shorter) matched the
    old text **0.87 s** after checkout. This is from the second run, j0-switch-run.log.
    In the final run the probe was Gson.java, whose symbols were the same on both
    commits, so its check could never pass ("NEVER").
  - Call hierarchy `toJson(Object, Appendable)` after the switch: in the second run it
    answered 4 callers at 2.46 s, 3.67 s and 5.58 s. My freshness check (each fromRange's
    text = `toJson`) never passed, so I could not confirm the answer reflected the old
    tree. The final run answered **0 callers for the whole 3-minute window**. The two
    runs disagree; this is still open. In the second run jdtls showed "Refreshing
    workspace" at 0.3 s, a build at 0.5 s and background tasks until about 4 s. In the
    final run it also sent a classpath-update event at 13 s, i.e. a Maven re-import
    because poms changed.
  - The clone was restored to `main` afterwards and is clean.
- **Wall time of the whole spike:** 244 s cold (cold import, both starts, the queries and
  the 3-minute switch window that timed out). The switch window is 3 of those minutes;
  without it about 55 s.

## Conclusions

**(a) J-D3: confirmed in principle, but the names are not erased.** jdtls gives one
distinct, stable name per overload, made of the simple name and the parameter types.
Those types are written as in the source, not erased, and a generic method gets a
`<T>` suffix. To build `Class.method(T1, T2)` keys, J2 should normalise as follows:
1. Drop the trailing ` <…>` type-parameter suffix.
2. Erase the type arguments in each parameter: `Class<T>` → `Class`,
   `Map<String, Type>` → `Map`, `TypeToken<?>` → `TypeToken`,
   `List<? extends V>` → `List`. Match `<>` with nesting.
3. Keep `[]`, and turn varargs `T...` into `T[]` or keep it consistently. J3's header
   parser must make the same choice.
4. Reduce a qualified type to its last segment if one is ever written.
5. Leave type variables as written (`T`), with no erasure to their bound. This makes
   `write(JsonWriter, T)` keys stable.
6. For enum constant bodies, key by the constant (`FieldNamingPolicy.IDENTITY.translateName(Field)`).
7. Anonymous classes stay in their method's body, per P-D5.

Erased and simple types would also make adding a generic argument a type change without
moving the key. I recommend that, rather than keeping generics in the key.

**(b) L1 for Java:** a temporary-copy base side (G2's approach) works for documentSymbol.
A `file:` copy outside the project gives the same 70 names as the project file, and the
answer is fast after the first open. `untitled:` does not work: it gives 0 symbols. Base
callers are not needed, and are not available: the copy has 0 callers. Recommendation:
the editor uses G2's temporary copy, outside the workspace folders, and the first-open
cost (up to ~20 s once per `-data`) is covered by warm-up. The S3-style text outline
(J7) stays the base side for the preview and the CLI, as planned.

**(c) Numbers for the J2–J5 `java-e2e.js` row (fresh jdtls, kept `-data`):**

| Phase | Time |
| --- | --- |
| warm start, ServiceReady | ≈ 3.5 s |
| … after a pom change | ≈ 23–28 s |
| first symbols | ≈ 1 s |
| first incomingCalls | ≈ 5 s |
| each later query | 5 ms (symbols) to 0.3 s (callers); up to 11 s on an implementer of a JDK interface method |

The ≤ 1.5 min budget holds with margin for one PR. A cold `-data` adds about 30 s, and an
empty m2 adds about 80 s once. One caution for the waiting notice: a first import with
downloads takes over a minute.
