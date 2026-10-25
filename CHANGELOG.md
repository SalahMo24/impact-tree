# Changelog

## Unreleased

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
