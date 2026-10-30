# Changelog

## Unreleased

- **Java** (`.java`), in the editor through Red Hat's Language Support for Java (jdtls),
  and in the PR preview and the CLI from the text. Changed methods and constructors are
  keyed by their parameter types, so each overload is its own row and an overload whose
  parameter list changed stays reviewed; signatures compare parameters, return
  types, type parameters and `throws`, a new `throws` type or `throw new` is a new throw
  path, and reduced visibility or a `static` change is the new **access changed** kind.
  Callers read as incomplete, never as "all callers updated", for overrides, overridable
  methods, method references, Lombok and other generated members, dependency-injection
  factories, while jdtls imports the project or reports a broken build path, and when VS
  Code turns a failed request into an empty answer. Without jdtls, callers come from a
  syntax index (the PR's files in the preview, the repository in the CLI). Checked on 12
  google/gson pull requests against the JDK's parser and `javac`: 224 of 224 changed
  methods, every kind right; syntax-only callers 100% precision and 99.2% recall.
  In the editor, on the same pull requests: 224 of 224 changed methods, and every caller
  `javac` finds that is not listed sits on an answer marked incomplete. Java files are no longer listed as "not analysed yet".

- **One Review view**: the review opens under the row it came from (the pull request, or the
  mode under Local changes), and the separate Changes view is gone. The reviewed row holds
  the review's controls and, in its hover, the review's notices; clicking it still offers
  preview, check out or open on GitHub. Pull request rows no longer have a hover.
- **Review tab** (experimental, with `impactTree.cards.enabled`): **Open review** shows the
  cards, grouped under Needs your attention, Behaviour changes and No behaviour change, the
  chosen card's changes with their diff hunks cut to the function, and the chosen change's
  context (your agent's before / after / when and who it affects; Impact Tree's verdict,
  callers and entry points) in a column that follows the scroll. ⚠ marks only the changes
  to look at first; `j` / `k` and `n` / `p` move between changes and cards. Read-only for now.
- **Analyse with my agent** (experimental, with `impactTree.agents.enabled`): **Connect my
  agent…** registers Impact Tree's MCP server with Claude Code, Codex, Cursor or VS Code /
  Copilot; the agent gets the review's facts with the prompt and answers in one
  `submit_cards` call with cards in reading order and a behaviour review of each change
  (changed, may change, new or same; before / after / when; what it affects; at most five
  that need attention). Its one-line note shows on the change rows and in the diff's
  CodeLens, after the engine's text. The MCP server restarts itself on new extension code
  instead of answering from an old build.
- A TypeScript project that does not hold a file is no longer reported as a failed caller
  query.

- **Go in the PR preview and the CLI**, without gopls: the changed, added and deleted
  functions and methods and their signature kinds, read from the text with the same keys
  as in the editor (so review ticks carry over), and callers from a syntax index: the PR's
  own Go files and changed tests in the preview, the changed files' Go module(s) in the
  CLI. Calls are matched through imports, the package, a method's receiver and receivers
  whose type is written (parameters, `var`, composite literals, fields, constructor
  results); every answer stays incomplete with its reason, never "no callers". Checked on
  the 10 cli/cli pull requests: 816 of 816 changed functions, every kind right; callers
  98.9% precision and 97.5% recall in the CLI, 99.4% and 92.0% in the preview, against Go's
  static call graph. Go files are no longer listed as not analysed there.
- **The preview's notice says what each language's syntax-only search leaves unresolved**
  (Go: calls through an interface or a function value); a changed required parameter reads
  "old calls fail loudly" instead of naming tsc, which was wrong for Go and Python.
- The no-checkout preview now runs every language through its provider; adding a language
  to it no longer touches the preview itself.

- **Python callers in the PR preview and the CLI**, without a language server, from a syntax
  index: the PR's own Python files and changed tests in the preview, the whole repository in
  the CLI. Calls are matched through imports, modules, `self`/`cls`/`super()`, constructions
  and annotated or assigned receivers; every answer stays incomplete with its scope ("syntax
  only"), never "no callers". Checked against Jedi on 22 httpx pull requests (99.9–100%
  precision, 98% recall across the repository) and pydantic #13070.
- **Python in the PR preview and the CLI**, without a language server: the changed, added
  and deleted functions and methods and their signature kinds, read from the text (the
  same keys as in the editor, so review ticks carry over). Checked against Python's `ast` on the same 10 httpx pull requests: 141 of
  141 changed functions, no extra, every kind right. The editor still uses Pyright. Go is
  still listed as not analysed there. `--json` output to a pipe is no longer cut at 8 KiB.
- **The base branch defaults to the remote's own default** (`origin/HEAD`), so a repository
  whose default branch is `master` reviews without a setting; it had stopped with "cannot
  resolve origin/main". A base branch set in `impactTree.baseBranch` is used as given, and a
  missing one now names the remote's default branch.
- **Python support** in the editor, through its Python language server (Pyright, from
  Pylance or Cursor's Python extension): changed functions and methods, including the
  definitions Pyright leaves out of its outline (a property getter with a setter, `@overload`
  stubs); signature changes (parameters, defaults, `*args`/`**kwargs`, positional-only and
  keyword-only, annotations, return, `@property`/`@staticmethod`/`@classmethod`) and new
  `raise` paths; callers with "updated at the call" or not; test callers from `test_*.py`,
  `*_test.py`, `conftest.py` and `tests/`; review ticks that survive edits to other functions.
  Calls on untyped objects that the server could not resolve, values, decorator
  registrations, protocol methods and constructors read as incomplete with the reason,
  never as "no callers". Checked on 10 merged encode/httpx pull requests (141 changed
  functions; see `test/lsp-harness/P7-REPORT.md`).
- **Go support** in the editor, through the Go extension's language server (gopls): changed
  functions and methods, signature changes (receiver, type parameters, parameters,
  results), callers with "updated at the call" or not, test callers from `_test.go`, and
  review ticks that survive edits to other functions. Callers that only use a function as
  a value are not counted as calls; methods implementing an interface declared outside the
  repository, and files outside the active build tags, read as incomplete with the reason.
  Checked on 10 merged cli/cli pull requests (816 changed functions; see
  `test/lsp-harness/G7-REPORT.md`). The PR preview and the CLI list Go files as not analysed.
- **A file that was not analysed says so on its row**: amber, counted toward "needs
  attention", with the reason in its tooltip and Details, in the editor, the preview and the
  CLI. A changed file of a language not analysed yet (Python, Java, …) names its language
  instead of reading like a docs or config file.
- **Partial clones** (`git clone --filter=blob:none`): their GitHub remote is found again;
  the Review view had said no remote points at github.com.
- **A quieter Changes title bar**: only Refresh, the tree/list toggle and Submit review (or
  Send feedback, while you have drafts) stay as icons. The filters, Previous/Next unreviewed
  and the legend moved to the `…` menu; `⌥N` / `⇧⌥N` still move between unreviewed changes.
- **A smaller Details view**: the progress bar with the reviewed and needs-attention counts,
  the selected row's name and path, and, for a red or amber row, the sentence saying why.
  A preview keeps its limits note and **Check out and analyse**. The callers table,
  signatures, tests line, threads, feedback and action buttons are gone from Details; each
  is still in the tree, its context menu or the diff.
- **Comment on this call** in a caller row's right-click menu starts a comment about that
  call: a GitHub review comment for a pull request under review, or a feedback draft for a
  local review. It goes on the call's line when the diff shows it, else on the change with
  the caller named. This replaces the 💬 that was in Details' callers table.
- **View as tree** in the Changes view folds the changed files into their folders, with the
  worst-first order kept at every level; **View as list** returns to the flat list. The
  choice is the `impactTree.fileListLayout` setting.
- The **Pull Request tab** renders the description and the timeline's comments as
  markdown (headings, lists, code, tables, task lists, links; `#123` links to that issue or
  pull request), shows who opened the pull request and when, and has a Refresh button in
  its header. The description sits beside the reviewers and labels column.
- The **Pull Request tab** also renders the raw HTML GitHub allows in a description or
  comment: a `<details>` fold, `<kbd>`, `<sub>`, a centred paragraph of badges, a template's
  `<!-- comment -->` (hidden). The output passes an allowlist sanitizer, so no tag or
  attribute outside the list, no inline style or handler, and no link other than
  http(s) or mailto reaches the tab. An image GitHub hosts (a screenshot, an attachment,
  an avatar) is shown; one from anywhere else is drawn as a link to it.
- The **Pull Request tab** loads its side column again when the GitHub sign-in lacks the
  `read:org` scope: team reviewers' names are asked for only when the scope is there
  (otherwise a requested team is listed as "A team" with a note), as the GitHub extension
  does. The tab also shows avatars, assignees and the milestone, coloured label chips,
  the timeline as comment cards with approvals and change requests marked, an "Open on
  GitHub" link, and one note instead of four when the side column cannot load.

## 0.1.0

Initial release.

- Build an impact tree from changed TypeScript and JavaScript symbols and their callers.
- Review committed branch changes, uncommitted changes, or changes since a checkpoint.
- Browse GitHub pull requests and preview changed files without checking out the branch.
- Analyse a checked-out pull request using the editor's call hierarchy.
- Track review progress with checkboxes and filters for attention, unreviewed changes,
  and unresolved conversations.
- Inspect changes and callers through the Details view, diffs, and editor navigation.
- Create GitHub review comments, manage conversations, and submit pull request reviews.
- Compute test reachability within a configurable caller depth.
- Include the Impact Tree extension icon.
