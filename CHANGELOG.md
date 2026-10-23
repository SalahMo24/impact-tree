# Changelog

## Unreleased

- **View as tree** in the Changes view folds the changed files into their folders, with the
  worst-first order kept at every level; **View as list** returns to the flat list. The
  choice is the `impactTree.fileListLayout` setting.

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
