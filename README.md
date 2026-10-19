# Impact Tree

![Impact Tree icon](images/icon.png)

Review a diff as an **inverted call graph**: changes rooted at the deepest changed
symbol and expanded *upward* through their callers, so the blast radius of a change is
on screen instead of in your head.

Ordinary review tools sort changed files alphabetically. That tells you *what* changed
and nothing about *how the changes relate* — or which callers you forgot to update.

> **Status: early.** Local change review, GitHub PR browsing, no-checkout previews,
> review progress, and GitHub review comments are implemented. Detailed change analysis
> supports TypeScript and JavaScript; see [Limitations](#limitations) for analysis coverage.

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
  `all callers updated`, `reaches 3 callers`, `no callers`, `deleted`; on a caller,
  `call updated`, `changed, but not at the call` or `not changed`
- **Hover** — signatures before/after, added `throw`s, and the un-updated callers by name

Findings are ranked by **damage × invisibility to the compiler**: a new `throw` path or a
silently-omitted optional parameter outranks a signature break that `tsc` already rejects.

## Why it is not just "call hierarchy"

- **Roots are seeded from the diff.** A changed symbol that calls another changed symbol
  nests under it instead of appearing twice.
- **"Stale" means the call site was not updated**, not merely that the symbol changed — a
  caller edited on the lines either side of a call is flagged, not cleared.
- **Framework edges are recovered.** A NestJS-style `bus.execute(new FooCommand())` has no
  static edge to `@CommandHandler(FooCommand)`; those are reconnected, and the
  interface-derived false callers they otherwise attract are suppressed.

## Review workflow

- Open **Impact Tree** in the Activity Bar. The **Review** view lists local change
  modes and, after signing in to GitHub, open pull requests for the workspace repository.
- Review local changes in `pr`, `branch`, `working`, or `checkpoint` mode. The
  `working` mode is useful for reviewing uncommitted edits made by a coding agent.
- Preview a GitHub pull request without a checkout, or check out its branch for
  analysis using the editor's language server. A no-checkout preview searches the
  files supplied by the PR and cannot establish callers outside those files.
- Use the **Changes** and **Details** views to inspect findings, open diffs, and
  navigate to callers. Track progress with review checkboxes and filter for changes
  needing attention, unreviewed changes, or unresolved conversations.
- For a GitHub PR, add review comments, reply to or resolve conversations, and
  submit a review from the pull request tab.

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

Modes: `pr` (committed branch vs base) · `branch` (includes uncommitted) ·
`working` (uncommitted only) · `checkpoint` (since a recorded SHA).

## Settings

| setting | default | |
|---|---|---|
| `impactTree.mode` | `pr` | which diff to review |
| `impactTree.baseBranch` | `main` | always resolved to `origin/<branch>` |
| `impactTree.iconMode` | `symbol` | `file` glyphs or `symbol` kinds on code rows |
| `impactTree.rowDetail` | `hover` | a change row's verdict words and kinds in the tooltip, or `inline` |
| `impactTree.prewarm` | `true` | index at startup so the first run is fast |
| `impactTree.reachDepth` | `2` | caller levels searched for test reachability, from 1 to 6 |
| `impactTree.tierA.maxFiles` | `300` | maximum files fetched for a no-checkout PR preview |

## Performance

Caller resolution needs the language server's project index. That build dominates
everything else, so the extension warms it at startup rather than on your click.

```
language server index   10–34s   once per window, in the background
analysis after that     ~3.5s    median query ~300ms
```

The extension reuses the editor's running server, so it never builds a second program.

## Tests

See [the coding style guide](docs/CODING_STYLE.md) for implementation requirements,
their rationale, examples, and verification expectations.

The suite analyses a real repository; point it at one:

```bash
IMPACT_TREE_TARGET_REPO=/path/to/repo npm test
```

Recorded fixtures embed real paths and symbol names from whatever repo they were captured
against, so they are gitignored. Regenerate locally with `npm run record`.

## Limitations

1. **TypeScript / JavaScript only** for signature and throw analysis. The caller graph is
   multi-language through the editor's call-hierarchy API; the diff-side parsing is not.
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

- Extend detailed change analysis beyond TypeScript and JavaScript.
- Add filters for untested blast radius and changes crossing project boundaries.
- Export the impact tree as a PR comment.

For the scope of the initial release, see [the changelog](CHANGELOG.md). For the
coverage of no-checkout previews, see [the preview analysis documentation](docs/tier-a.md).

## License

[MIT](LICENSE)
