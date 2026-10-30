# Impact Tree

![Impact Tree icon](images/icon.png)

Review a diff as an **inverted call graph**: changes rooted at the deepest changed
symbol and expanded *upward* through their callers, so the blast radius of a change is
on screen instead of in your head.

Ordinary review tools sort changed files alphabetically. That tells you *what* changed
and nothing about *how the changes relate* — or which callers you forgot to update.

> **Status: early.** Local change review, GitHub PR browsing, no-checkout previews,
> review progress, and GitHub review comments are implemented. Detailed change analysis
> supports TypeScript and JavaScript everywhere, and Go, Python and Java in the editor; see
> [Languages](#languages) and [Limitations](#limitations).

## What it shows

```
 [TS]  lockRow          2 of 3 callers not updated        M    <- red icon
 [TS]    ├ saveSnapshot   call updated                      M
 [TS]    ├ appendEntry    not changed
 [TS]    └ renameRow      changed, but not at the call           <- amber icon
 [🧪]    └ lockRow.test   test
 [MD]  design-notes.md                                        M
```

- **Icon** — file type, from your icon theme; on a change row its colour is the state:
  **red** = Callers not updated (a signature or throw change; review these first) ·
  **amber** = Check by hand (callers unknown, a deleted symbol, or a caller changed but
  not on the call line) · **no colour** = Fine (callers updated, a body-only change, or
  nothing calls it) · beaker = a test that reaches this code · reopened-issue = a cycle,
  already shown higher up
- **Badge** — git status against the **review base** (not `HEAD`, so it stays correct on a PR)
- **Words** — the exact state next to the name: `2 of 3 callers not updated`, `callers unknown`,
  `all callers updated`, `called from 3 places`, `no callers`, `deleted`; on a caller,
  `call updated`, `changed, but not at the call` or `not changed`
- **Hover** — signatures before/after, added `throw`s, and the callers not updated, by name

Findings are ranked by **damage × invisibility to the compiler**: a new `throw` path or a
silently-omitted optional parameter outranks a signature break that `tsc` already rejects.

## Why it is not just "call hierarchy"

- **Roots are seeded from the diff.** A changed symbol that calls another changed symbol
  nests under it instead of appearing twice.
- **"Callers not updated" means the call site was not updated**, not merely that the symbol changed — a
  caller edited on the lines either side of a call is flagged, not cleared.
- **Framework edges are recovered.** A NestJS-style `bus.execute(new FooCommand())` has no
  static edge to `@CommandHandler(FooCommand)`; those are reconnected, and the
  interface-derived false callers they otherwise attract are suppressed.

## Languages

| Language | Editor (local review, checked-out PR) | No-checkout PR preview | CLI |
| --- | --- | --- | --- |
| TypeScript, JavaScript | Analysed: the bundled TypeScript compiler finds changes, the editor's language server finds callers | Analysed from the PR's own files only (syntax) | Analysed with its own TypeScript language service |
| Go | Analysed through the [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.go)'s language server, gopls | Changed functions and signature kinds from the PR's text; callers from **syntax only**, in the PR's own Go files and changed tests (check out the PR to find them all) | Changed functions and signature kinds from the text; callers from **syntax only**, across the Go module(s) the changed files are in |
| Python | Analysed through the editor's Python language server, Pyright ([Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) in VS Code, Cursor's Python extension in Cursor) | Changed functions and signature kinds from the PR's text; callers from **syntax only**, in the PR's own files and changed tests (check out the PR to find them all) | Changed functions and signature kinds from the text; callers from **syntax only**, across the repository's Python files |
| Java | Analysed through Red Hat's [Language Support for Java](https://marketplace.visualstudio.com/items?itemName=redhat.java) (Eclipse JDT LS, "jdtls") | Changed methods and signature kinds from the PR's text; callers from **syntax only**, in the PR's own Java files and changed tests (check out the PR to find them all) | Changed methods and signature kinds from the text; callers from **syntax only**, across the repository's Java files |
| Kotlin, C#, Ruby, Rust, PHP, Swift, C, C++, Scala | Listed as "*Language* · not analysed yet" | Same | Same |

A file that was not analysed never reads as having no impact. A Go, Python or Java file Impact
Tree could not analyse (its language server gave no answer, for example) is amber, counts toward **needs attention**
until you mark it reviewed, and its tooltip and Details say why.

### Go

- **Needs the Go extension.** Changed functions come from gopls's outline of each file,
  callers from its call hierarchy. Without the extension, Go files are listed as not
  analysed with a note to install it.
- **The first review waits for gopls** to load the module ("Waiting for the Go language
  server (gopls)… N s"); Impact Tree starts it in the background when Go files change.
- **Old versions of a file** are read through a temporary copy in the extension's storage
  (gopls reads only files on disk), removed as soon as gopls has answered.
- **Signatures** compare receiver, type parameters, parameters and results. Renaming a
  receiver or a named result is not a change; `T` to `*T` is. `interface{}` and `any` are
  the same type.
- **Callers that only use a function as a value** (`Args: noArgsConstraint`, a function
  passed as an argument) are not counted as calls; the change reads "passed around as a
  value, so the call sites cannot be followed".
- **A method that implements an interface declared outside the repository** (such as
  `http.RoundTripper`) may have callers gopls cannot list; it reads as incomplete rather
  than "all callers updated".
- **A file excluded by the current build tags** reads "not in the active build (build
  tags); callers were not searched".
- **Calls through interfaces are matched by type**, as gopls does: a caller can be listed
  that never reaches this particular implementation, and calls on another implementation
  of the same interface method can be listed too. These err towards showing more callers.
- **No `panic` tracking**: a new `error` result shows as a result change; a new `panic(` in
  a body is not tracked.
- **Measured** on 10 merged cli/cli pull requests (816 changed functions): every changed
  function found with no extras, every signature change classified, no caller that Go's
  static call graph finds missed, and no change shown as fine while a caller was not
  updated. See [the verification report](test/lsp-harness/G7-REPORT.md).
- **Without gopls** (the no-checkout PR preview, the CLI): changed, added and deleted
  functions and their signature kinds are read from the text, keyed as gopls keys them (on
  the 10 cli/cli pull requests, the same 816 changed functions as `go/parser`, every kind
  right). Callers come from a **syntax index**: the PR's own Go files and changed tests in
  the preview, every Go file of the module(s) the changed files are in in the CLI
  (`vendor/`, `testdata/` and nested modules left out; at most 3000 files / 64 MiB, then
  the changed packages and the files that mention a changed name). A call is matched
  through imports (aliases and dot-imports too), in the same package, on a method's own
  receiver, and on a receiver whose type is written: a typed parameter, `var x T`,
  `x := T{…}` or `&T{…}`, a struct or embedded field, or a constructor's result
  (`x := pkg.NewT()`). Every answer stays incomplete and says why ("syntax only"), never
  "no callers"; a method that an interface in the indexed files declares, a function used
  as a value, another build-tag variant of a function, and calls on receivers whose type
  is not written add their reason. Not resolved: calls through an interface or a function
  value, receivers from a method's result, a `range` variable or an index expression; an
  interface declared outside the indexed files (`fmt.Stringer`, `error`) is covered only by
  the general note. In the preview, a package's files outside the PR are not read, and an
  import of a nested module whose path does not end in its directory (no `go.mod` is
  fetched) is not mapped. Checked against Go's static call graph within the indexed files:
  98.9% precision and 97.5% recall in the CLI, 99.4% and 92.0% in the preview, every
  caller listed that the call graph does not have a call into a file behind build tags
  (which it does not build), and every miss on an answer marked incomplete.

### Python

- **Needs the editor's Python language server** (Pylance in VS Code, Cursor's Python
  extension in Cursor; both are Pyright). Without it, Python files are listed as not
  analysed with a note to install it. The first review waits for it ("Waiting for the
  Python language server (Pyright)… N s").
- **Changed functions** are module functions and methods (`Class.method`, nested classes
  too). A `def` inside a function is part of its parent's body. Definitions Pyright leaves
  out of its outline (a property getter that has a setter, `@overload` stubs, one of two
  definitions in an `if`/`else`) are read from the text, so a change in them is not lost.
- **Signatures** compare parameters (`self`/`cls` left out, so renaming them is no change),
  defaults, `*args`/`**kwargs`, positional-only and keyword-only markers, annotations and
  the return annotation. Changing `@property`, `@staticmethod` or `@classmethod` is a
  signature change; other decorators are not. A new `raise SomeError` in a function's own
  body is a new throw path. Reformatting an annotation is no change; changing its quote
  style is.
- **Callers on untyped objects.** Pyright finds `obj.method()` only when it knows `obj`'s
  type. Impact Tree searches the repository for calls by the method's name that Pyright
  could not resolve; if there are any, the answer reads as incomplete ("N calls by this
  name that the language server could not resolve"), never as complete. Common names
  (`get`, `items`) can make this amber more often than needed, and the search checks at
  most 50 calls per method ("more than 50 calls by this name; N not checked").
- **Read as incomplete, never "no callers":** a function used as a value (a callback, a
  dict entry, `functools.partial`); a function registered by a decorator (`@app.route`,
  `@pytest.fixture`) with no caller found; a method Python calls itself (`__hash__`, `__eq__`, `__enter__`, …);
  and a class's `__init__`, whose constructions (`Client(...)`) Pyright does not list as
  its callers.
- **Not detectable:** `getattr(obj, "name")()`, `operator.methodcaller`, calls built from
  strings, and calls through a base class's method that reach an override at run time.
- **Measured** on 10 merged encode/httpx pull requests (141 changed functions): every
  changed function found with no extras, every signature change classified, and every
  caller the Jedi analyser finds that Impact Tree does not list sits on an answer marked
  incomplete. See [the verification report](test/lsp-harness/P7-REPORT.md).
- **Without the language server** (the no-checkout PR preview, the CLI): changed, added and
  deleted functions and their signature kinds are read from the text, the same way (on the
  10 httpx pull requests, the same 141 changed functions as Python's `ast`, every kind right).
  Callers come from a **syntax index**: the PR's own Python files and changed tests in the
  preview, every Python file of the repository in the CLI (at most 3000 files / 64 MiB).
  A call is matched by name through imports and modules, `self.`/`cls.`/`super()` in a
  class and its indexed bases, `Cls(...)` constructions, and receivers annotated or assigned
  as a class; a property read on such a receiver counts. Every answer stays incomplete and
  says why ("syntax only", calls on receivers it could not resolve), never "no callers".
  Not resolved: `Cls.m(`, `Cls().m(`, `self.x.m(`, `with … as x` receivers, f-string fields.
  Checked against Jedi: on 22 httpx pull requests, 99.9–100% precision and 98% recall
  across the repository (69–90% in the preview, which sees only the PR's files); on
  pydantic #13070, recall 96.8%, and every caller listed that Jedi's reference search
  missed is a real call (Jedi's own `goto` confirms all 456 sites).

### Java

- **Needs Language Support for Java by Red Hat** (`redhat.java`, which bundles its own Java
  runtime). Without it, Java files are listed as not analysed with a note to install it.
  The first review waits for it ("Waiting for the Java language server (jdtls)… N s"); a
  project's first import, with its Maven or Gradle dependencies, can take over a minute.
- **Changed methods** are the methods and constructors of every class, interface, enum and
  record, nested types included, keyed by their parameter types (`Gson.toJson(Object,
  Appendable)`; generics erased, so `getAdapter(TypeToken<T>)` is `getAdapter(TypeToken)`),
  so each overload is its own row. When one overload of a name disappears from a file and
  one appears, they read as one signature change, and a reviewed row stays reviewed. An enum
  constant's body and an anonymous class in a field are keyed by that member; anonymous and
  local classes and lambdas inside a method are part of its body. Editing only a method's
  Javadoc does not mark it changed.
- **Signatures** compare parameters (varargs and arrays as written), the return type, type
  parameters and `throws`. A new type in `throws`, or a new `throw new X(…)` in the method's
  own body (not in its lambdas or anonymous classes), is a new throw path. Reduced
  visibility, or `static` added or removed, is **access changed**: old callers stop
  compiling. Widening access is no change.
- **Read as incomplete, never "all callers updated":** a method that overrides or implements
  another (jdtls lists the supertype method's callers with its own, so the list is too
  wide), or that is overridden in the workspace; a method used through a method reference
  (`Foo::bar`); a no-argument constructor of a class that is not final (a subclass's
  implicit `super()` is not a listed call); `@Bean`/`@Provides`/`@Produces` factory methods;
  members of a class processed by Lombok, AutoValue or another annotation processor (the
  generated members are not read); an empty answer for an overridable method (VS Code turns
  a failed call-hierarchy request into an empty one); and any answer taken while the
  language server is still importing the project, after a build file changed, or while it
  reports a broken build path (it lists no calls in a project that targets Java 6 or older).
  A dependency-injected class's constructor with no caller reads as built by the container.
- **Not followed:** reflection (`Method.invoke`, `Class.forName`), objects built or called
  by a dependency-injection container, and an override in a named class written without
  `@Override` (other than `equals`, `hashCode`, `toString`).
- **Old versions of a file** are read through a temporary copy in the extension's storage,
  removed as soon as jdtls has answered.
- **Measured** on 12 merged google/gson pull requests (224 changed methods): every changed
  method found with no extras, every signature change classified, no change shown as fine
  while a caller was not updated, and every caller `javac` resolves that Impact Tree does
  not list sits on an answer marked incomplete (overall recall 94.1%). Most extra callers
  are jdtls listing a supertype method's callers for an override, on answers already marked
  incomplete. See [the verification report](test/lsp-harness/J6-REPORT.md).
- **The first answers after the language server starts** read incomplete until it has
  settled: 30 s after it reports ready with no project import, or, when a build file
  changed since its last import, until it re-imports the project.
- **Without the language server** (the no-checkout PR preview, the CLI): changed, added and
  deleted methods and their signature kinds are read from the text with the same keys as in
  the editor (on 12 gson pull requests, 224 of 224 changed methods as the JDK's own parser
  finds them, every kind right). Callers come from a **syntax index**: the PR's own Java
  files and changed tests in the preview, every Java file of the repository in the CLI
  (`target/`, `build/`, `out/` and generated sources left out; at most 3000 files / 64 MiB,
  then the changed packages and the files that mention a changed name). A call is matched
  through imports (single-type, on-demand and static) and the package, on `this`, `super`
  and inherited methods within the index, on static `T.m(`, constructors (`new T(`,
  `this(`, `super(`, enum constants), and on receivers whose type is written: parameters,
  fields, locals (`var x = new T(…)`, casts, `instanceof T x`), and a method's declared
  return type. Overloads are matched by the number of arguments; when several match, each
  is listed and the answer says so. Every answer stays incomplete and says why ("syntax
  only"), never "no callers". Not resolved: calls through an interface or an override,
  untyped lambda parameters, `var x = f()`, type parameters and array elements. In the
  preview, files outside the PR are not read. Checked against `javac`'s own resolution
  within the indexed files on the 12 pull requests: 100% precision and 99.2% recall in
  the CLI and in the preview, every miss on an answer marked incomplete.

## Review workflow

- Open **Impact Tree** in the Activity Bar. The **Review** view lists local change
  modes and, after signing in to GitHub, open pull requests for the workspace repository.
- Review local changes in **Branch vs base**, **Branch + uncommitted**, **Uncommitted
  (agent)**, or **Since checkpoint** mode. **Uncommitted (agent)** is useful for reviewing
  edits made by a coding agent.
- Preview a GitHub pull request without a checkout, or check out its branch for
  analysis using the editor's language server. A no-checkout preview searches the
  files supplied by the PR and cannot establish callers outside those files; it analyses
  TypeScript, JavaScript, Python, Go and Java (Python, Go and Java callers from syntax
  only).
- Pick a mode or a pull request: its review opens **under that row** in the Review view, as
  the GitHub Pull Requests extension nests a pull request's files. While a review is open the
  view shows that row alone, with **Review something else…** above it to bring the pull
  requests and local modes back (the next review of another source hides them again); so a
  change sits two levels deep, not eight. The reviewed row carries
  the review's controls (Open review, the tree/list toggle, Show only needs attention,
  Refresh, **Find the tests that cover this review** until that search has run, Submit
  review or Send feedback; the rest in its right-click menu), and its hover
  lists the review's notices, such as a fetched base, files not analysed or a Preview's
  limits (a Preview says `preview` on the row). A change whose tests were not searched says
  so in its hover, not in a row of its own. Clicking it
  again still offers preview, check out or open on GitHub. Other pull request rows have no
  hover. **Details** below shows your review progress and, for a change that needs a look,
  why. Changed files are listed worst first; **View as tree** (or
  `impactTree.fileListLayout`) folds them into their folders, with folders and files still
  ordered worst first at every level and a folder ranked by its worst file (a folder has no
  checkbox; its files keep theirs). Changed lines in no function are a **Top-level changes**
  row, last under their file; a file with nothing else is that one row. Track progress
  by marking changes reviewed, and filter for what needs attention (callers not updated, or
  callers to check by hand), unreviewed changes, or unresolved conversations. Progress
  counts only the changes that need attention: the view reads `2 need attention · 3 of 5
  looked at`, and the status bar and Details say the same. A review where nothing needs
  attention says `nothing needs attention` and keeps its files in one collapsed
  **Browse all** row (`Nothing to flag in what was searched` when the analysis was
  incomplete, such as a Preview); any change can still be marked reviewed.
  Previous/Next unreviewed (`⇧⌥N` / `⌥N`) and the legend are also in the view's `…` menu.
- For a GitHub PR, add review comments (in the diff, or **Comment on this call** on a
  caller row, which names the caller when its call is outside the diff), reply to or resolve conversations, and
  submit a review from the pull request tab. Picking a PR from the list, to preview or to
  check out, opens that tab with its description, checks, reviewers, labels and merge state.

### Feedback rounds with a coding agent

- While reviewing local changes or a checked-out pull request, leave **feedback** in the
  diff's comment box, or right-click a caller in the tree and pick **Comment on this call**.
  Drafts collect in **Feedback to send** at the
  top of the review. In a checked-out pull request, VS Code asks whether a new comment is a
  GitHub review comment or feedback for your agent.
- **Send feedback** (✈ on the reviewed row; hold ⌥ for **Send feedback to…**) writes the drafts
  to `.impact-tree/feedback/<date>-<n>.md`, records a checkpoint, and hands the round to
  Claude Code or Codex (in a terminal), the editor's chat (Copilot Chat, Cursor; you press
  Enter), or the clipboard. The agent is asked to write `Status: done` or
  `Status: skipped — reason` under each item.
- The next review shows **Feedback round N** first: for each item, what the agent wrote and
  whether the code near it changed. "Done" with no code change, skipped, or anything unknown
  is amber. **Reply in next round** starts a new draft at the same place.
- The feedback files are yours: Impact Tree never deletes them. Kept together they record
  how you want code written, and can later be turned into rules for your agents.
- Checkpoints are snapshots of the working tree, kept in the editor's storage for this
  workspace, not in `.git`. Old ones are removed automatically; **Clean up stored data**
  (the reviewed row's right-click menu) shows what is stored and deletes it on confirmation.

### Your coding agent and the review tab (experimental)

Off by default; turn on `impactTree.cards.enabled` and `impactTree.agents.enabled`.

- **Cards** group a review's changes into related cards, with the entry points each card
  reaches. **Open review** (on the reviewed row, or the Cards view) opens the **review tab**:
  the cards listed to the left under Needs your attention, Behaviour changes and No
  behaviour change; the chosen card's changes in the middle, each with its diff hunk (cut to
  the function's lines) and ⚠ on the ones to look at first; and the chosen change's context
  to the right: what your agent said (before / after / when, who it affects) and what Impact
  Tree found (verdict, callers, entry points). `j` / `k` and `n` / `p` move between changes
  and cards. The tab is read-only.
- **Connect my agent…** registers Impact Tree's MCP server with Claude Code, Codex, Cursor
  or VS Code / Copilot. **Analyse with my agent** then hands your agent the review's facts
  (inline in the prompt, or in a file when they are large) and the agent answers in one
  `submit_cards` call: cards in reading order and, for each change, whether its behaviour
  changed, may change, is new or is the same, with before / after / when and what it
  affects, plus at most five changes that need your attention.
- The agent's one-line note shows on the change rows and in the diff's CodeLens, after the
  engine's own text; the engine's order and counts do not change. **Undo the agent's
  result** goes back to the engine's cards.
- Results are kept in this workspace. The window listens on a local socket in a private
  temporary folder, guarded by a token; nothing leaves your machine. Only a checked-out
  branch takes part, not a pull request preview. The MCP server restarts itself when the
  extension's code changes.

## Install (from source)

```bash
git clone https://github.com/SalahMo24/impact-tree
cd impact-tree
npm ci
ln -s "$PWD" ~/.vscode/extensions/SalahMo24.impact-tree-0.1.0
# or ~/.cursor/extensions/... for Cursor
```

Restart the editor, open a git repository, and run **Impact Tree: Refresh**.

## CLI

```bash
npm run analyze -- --repo /path/to/repo --mode pr --base main
```

Modes (the `--mode` value, then the name the extension shows): `pr` (Branch vs base) ·
`branch` (Branch + uncommitted) · `working` (Uncommitted (agent)) · `checkpoint` (Since
checkpoint, from a recorded SHA).

## Settings

| setting | default | |
|---|---|---|
| `impactTree.mode` | `pr` | which diff to review: `pr` = Branch vs base, `branch` = Branch + uncommitted, `working` = Uncommitted (agent), `checkpoint` = Since checkpoint |
| `impactTree.baseBranch` | empty: the remote's default branch (`origin/HEAD`, such as `main` or `master`) | always resolved to `origin/<branch>` |
| `impactTree.iconMode` | `symbol` | `file` glyphs or `symbol` kinds on code rows |
| `impactTree.rowDetail` | `hover` | a change row's verdict words and kinds in the tooltip, or `inline` |
| `impactTree.prewarm` | `true` | index at startup so the first run is fast |
| `impactTree.reachDepth` | `2` | caller levels searched for the tests that cover a change, from 1 to 6 |
| `impactTree.tierA.maxFiles` | `300` | maximum files fetched for a no-checkout PR preview |
| `impactTree.openPullRequestTab` | `true` | open the pull request tab when you preview or check out a PR from the list |
| `impactTree.agent` | `ask` | where **Send feedback** hands a round: `claude`, `codex`, `chat`, `clipboard`, `save`, or `ask` |
| `impactTree.cards.enabled` | `false` | the Cards view, the review tab and the entry-point search (experimental) |
| `impactTree.agents.enabled` | `false` | let your connected coding agent read the shown review and hand back cards (experimental) |

## Performance

Caller resolution needs the language server's project index. That build dominates
everything else, so the extension warms it at startup rather than on your click.

```
language server index   10–34s   once per window, in the background
analysis after that     ~3.5s    median query ~300ms
```

The extension reuses the editor's running server, so it never builds a second program.

The index is rebuilt after a checkout, and in a large monorepo that can take a minute.
While it loads, caller searches go one at a time and may each wait up to 60 s (2 minutes in
total), instead of all timing out after 5 s. Any that still time out are retried once the
server answers, while the review stays open; the view says so. Refresh asks again at any time.

## Tests

See [the coding style guide](docs/CODING_STYLE.md) for implementation requirements,
their rationale, examples, and verification expectations.

`npm test` is self-contained: the stages that analyse a repository run against a small
TypeScript monorepo that `test/fixture-repo.js` builds in a temporary directory, with a
branch that changes signatures, bodies, a `.tsx` component and a README. To aim those
stages at a real repository instead:

```bash
IMPACT_TREE_TARGET_REPO=/path/to/repo npm test
```

`npm test` runs every file in `test/suite.js` in parallel child processes, slowest first
(about 90 s on 12 cores; `--concurrency N`, `--only <substring>`, `--verbose` and `--deadline-s N`
tune it). `npm run test:quick` runs only the files that finish in a few seconds, and
`npm run test:serial` runs one file at a time. A test file missing from `test/suite.js` fails
the run, so list new files there.

Against the built-in fixture, or with `CI` set, a stage that finds nothing to check fails
rather than skipping. Recorded fixtures embed real paths and symbol names from whatever
repo they were captured against, so they are gitignored. Regenerate locally with
`npm run record`.

## Limitations

1. **TypeScript, JavaScript, Go, Python and Java only.** Go, Python and Java are analysed
   in the editor, with its language server for each; previews and the CLI read them from
   their text, with callers from syntax only. Throw analysis is TypeScript, JavaScript,
   Python (`raise`) and Java (`throws`, `throw new`). See
   [Languages](#languages).
2. **Cross-service edges do not exist statically.** HTTP, queue and workflow boundaries
   cannot be resolved, and shared type names are not call edges.
3. **Full project analysis may require the project's dependencies and language server.**
   No-checkout previews use syntax-only analysis of the PR files. The extension ships
   its own TypeScript parser, but a preview does not establish the full project call graph.
4. **Value-passed functions report `unknown`, not zero** — a function handed to
   `transaction(fn)` is referenced without being called, so call hierarchy sees nothing.
5. **Deleted symbols have no current AST**, so their surviving callers are approximate.
6. **CommonJS and config-less projects use a syntactic index for cross-file callers.**
   It follows static `import` and string-literal `require()` only; tsconfig `paths` and
   bundler aliases are not applied there. See [correctness and performance](docs/correctness-and-perf.md).
7. **Framework edges from test files may be missing**, since a project's `tsconfig.json`
   usually excludes tests and the editor never loads them.

## Roadmap

- Add filters for untested blast radius and changes crossing project boundaries.
- Export the impact tree as a PR comment.

For the scope of the initial release, see [the changelog](CHANGELOG.md). For the
coverage of no-checkout previews, see [the preview analysis documentation](docs/tier-a.md).

## License

[MIT](LICENSE)
