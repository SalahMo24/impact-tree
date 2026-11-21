# Driving the extension in a real editor

`scripts/drive.js` runs the extension from this working tree inside a real VS Code, performs a few steps, and writes screenshots and text you can read afterwards. It gives an agent (Claude Code, Cursor) or a person the same check-it-yourself loop a website has. Use it to see a UI change working; the unit tests (`npm test`) remain the way to check behaviour.

```bash
node scripts/drive.js view click:lockRow "wait:Callers not updated" shot:details dump
```

Each run starts a throwaway profile under `/tmp/itd-*`, so it never touches the editor you work in. It opens the demo repository (`scripts/demo-repo.js`, built fresh for each run) unless you pass `--repo`. A warm run takes 10–20 s. The first run also downloads VS Code 1.146.0 (about 380 MB) into `.vscode-test/`, which can take a few minutes.

## Usage

```
node scripts/drive.js [--repo PATH] [--out DIR] [--keep-open] [--extensions-dir DIR] [--settings FILE] [--extension-dev PATH]… <steps…>
```

| Option | Meaning |
|---|---|
| `--repo PATH` | Open this repository instead of the demo. |
| `--out DIR` | Where to write the output. The default is `.vscode-test/out/latest/`, replaced each run. The tool refuses a folder that is not empty and was not written by it. |
| `--keep-open` | Leave the editor open after the steps, for looking around by hand. Close its window or press Ctrl+C to end the run. Agents never need this. |
| `--extensions-dir DIR` | Run with the extensions installed in DIR (kept between runs), for example another language's extension. DIR must be a folder inside this repository's `.vscode-test/` or the scratchpad (`IMPACT_TREE_SCRATCHPAD`, else `~/Projects/impact-tree-scratchpad/`); anything else is refused, and so is an editor's own folder (`~/.vscode/extensions`, `~/.vscode-insiders/extensions`, `~/.cursor/extensions`, …) even through a symlink, because VS Code rewrites the folder's `extensions.json`. Without it, the run has an empty folder of its own. |
| `--settings FILE` | A JSON object of settings added to (or overriding) the run's own, for example that extension's. The safety settings are applied after it and cannot be overridden: `telemetry.telemetryLevel: off`, `update.mode: none`, `extensions.autoUpdate: false`, `extensions.autoCheckUpdates: false`, `security.workspace.trust.enabled: false`. |
| `--extension-dev PATH` | Also load the extension in PATH from source, beside Impact Tree (a small probe, say). Repeatable. |

## Steps

Steps run in order. The run stops at the first one that fails, saving `failure.png` and the dumps. Mistakes in the steps (an unknown verb, a missing argument, an unknown command id) fail before the editor starts.

TEXT matches what a row shows (its label and description), ignoring case. The first row on screen that contains it wins, so use specific text: `click:rows.ts` may match a caller row that mentions `rows.ts` before the file row itself. The ok line prints the row that was matched.

| Step | What it does |
|---|---|
| `view` | Open the Impact Tree side bar. |
| `cmd:ID` | Run a command by its id, such as `cmd:impactTree.refresh`, through the command palette. Commands hidden from the palette, or that share a title with another command, are refused. |
| `pick:TEXT` | Choose the entry containing TEXT in an open quick pick, after a `cmd` that asks something. |
| `key:KEY` | Press a key: `Escape`, `Enter`, `ArrowDown`… (Playwright's key names). |
| `click:TEXT` | Select the first Review row containing TEXT. Waits up to 20 s for it to appear. |
| `expand:TEXT` | Open the first Review row containing TEXT without selecting it. Fails on a row with no children. |
| `wait:TEXT` | Wait up to 20 s until TEXT shows in the Review tree, the Details view or the review tab. |
| `pause:SECONDS` | Wait that long (1 to 20 s), for work the views do not show, such as another extension loading. |
| `shot:NAME` | Save the window as `NAME.png`. |
| `dump` or `dump:NAME` | Write `tree.txt`, `details.txt` and `review.txt`, or the same names with a `NAME-` prefix. |

Details renders a moment after a row is selected, and analysis keeps running after the tree first appears. **After a `click`, `wait:` for the text you expect before `shot` or `dump`.**

## Output

| File | What it holds |
|---|---|
| `summary.json` | `ok`, `exitCode`, each step with its time, its note (the matched row) or its error, and the files written. Read this first. |
| `*.png` | Screenshots at 1400×900. On a failure there is also `failure.png`. |
| `tree.txt` | The Review rows **on screen**, indented by level. `v` marks an open row, `>` a closed one, and `[selected]` the selection. The list is virtualised, so rows scrolled out of view are not in it. When the screen reader's text says something the row does not show, it is added in brackets. |
| `details.txt` | The Details view's text, or a note that its pane is not open. |
| `review.txt` | The review tab's text (open it with `cmd:impactTree.openReview`): the cards, the selected change, its callers and the entry points it reaches. A note instead when the tab is closed or behind another editor tab, which drops its page. |
| `Impact Tree.log` | The extension's log for the run: activation, timings, warnings. |

Exit codes: `0` passed, `1` a step or the launch failed, `2` the run passed its 60 s deadline, `130` interrupted with Ctrl+C. Every way out closes the editor, kills what is left of it and removes the run's folder.

## Examples

Check that the planted change in the demo is flagged and its callers are listed:

```bash
node scripts/drive.js view expand:lockRow wait:appendEntry dump
```

`tree.txt` then holds a line like `> appendEntry  not changed  ·  journal.ts`.

Before and after picking another review mode:

```bash
node scripts/drive.js view wait:lockRow dump:before cmd:impactTree.selectMode "pick:Branch + uncommitted" "wait:whole branch vs base" wait:lockRow dump:after
```

The `wait:` after the pick names text only the new review shows. Waiting for `lockRow` alone would pass at once on the old tree, before the new review is drawn.

Check where a change's impact path ends, from the review tab (its text is in `review.txt`; CSS shows headings in capitals, so the file has `REACHES`):

```bash
node scripts/drive.js --repo ../my-app view cmd:impactTree.openReview wait:Reaches dump shot:review
```

## Limits

- **macOS and Linux only.** The run folder lives in `/tmp`, and cleanup uses `pkill`.
- **The window shows on screen and takes focus** while the run lasts.
- **A run is a full VS Code:** about 1.4 GB of memory and two to three busy cores for 10–20 s. Built-in extensions the review does not need (git, GitHub, Copilot, debuggers, npm…) are switched off to keep it lighter. Put all the steps you need into one run rather than several, and don't start runs in parallel.
- **One run at a time on the machine.** A second run while one is going is refused (`/tmp/impact-tree-drive.lock`, taken over when its process has gone): each run is a full editor, and two at once heat the machine.
- **No GitHub or pull request flows:** the throwaway profile is not signed in.
- **VS Code only.** Cursor is not a target yet. Its sign-in screen and a possibly disabled debugging hook would need work first.
- **The pinned VS Code version (`VSCODE_VERSION` in the script) fixes the workbench's markup the selectors rely on.** After changing it, run the examples above once.
