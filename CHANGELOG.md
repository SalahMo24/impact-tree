# Changelog

## Unreleased

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
