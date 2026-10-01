# Impact Tree

Review a diff as an **inverted call graph**: changes rooted at the deepest changed
symbol and expanded *upward* through their callers, so the blast radius of a change is
on screen instead of in your head.

Ordinary review tools sort changed files alphabetically. That tells you *what* changed
and nothing about *how the changes relate* — or which callers you forgot to update.

> **Status: early.** The engine and the tree work and are covered by tests. PR browsing,
> review state and multi-language support are not built yet. See *Roadmap*.

## What it shows

```
 [TS]  lockRow                            ⛔                     M
 [TS]    ├ saveSnapshot                   ✓                      M
 [TS]    ├ appendEntry                    ○
 [🧪]    └ describes lockRow               🧪
 [MD]  design-notes.md                                            M
```

- **Icon** — file type, from your icon theme
- **Badge** — git status against the **review base** (not `HEAD`, so it stays correct on a PR)
- **Glyph** — `⛔` call sites not updated · `✓` updated · `○` untouched · `△` changed but not at the call · `🧪` test
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

## Install (from source)

```bash
git clone https://github.com/SalahMo24/impact-tree
ln -s "$PWD/impact-tree" ~/.vscode/extensions/SalahMo24.impact-tree-0.1.0
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
| `impactTree.iconMode` | `file` | `file` glyphs or `symbol` kinds on code rows |
| `impactTree.rowDetail` | `hover` | detail in the tooltip, or `inline` |
| `impactTree.fileListLayout` | `tree` | folder hierarchy or `flat` |
| `impactTree.prewarm` | `true` | index at startup so the first run is fast |

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
3. **A project without installed dependencies cannot be analysed.** The extension says so
   explicitly rather than silently under-reporting.
4. **Value-passed functions report `unknown`, not zero** — a function handed to
   `transaction(fn)` is referenced without being called, so call hierarchy sees nothing.
5. **Deleted symbols have no current AST**, so their surviving callers are approximate.
6. **Framework edges from test files may be missing**, since a project's `tsconfig.json`
   usually excludes tests and the editor never loads them.

## Roadmap

Required before the first public release: see
[the distribution checklist](docs/distribution-checklist.md) (review loop, reviewing
local agent changes, and UI/UX).

- Browse and review open pull requests, with a no-checkout preview tier
- Review state: checkboxes with subtree propagation
- Filters: untested blast radius, call site not updated, crosses a project boundary
- Export the tree as a PR comment
- Go, Python and Rust via the editor's symbol providers

## License

MIT
