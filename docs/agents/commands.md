# Commands

Every repeatable check and run is one command. Run the command; do not rebuild its steps by hand
(chained `npm run` calls, `source` lines, hand-made locks, hand-written diff scripts). If a step
you need has no command, add one here rather than scripting it inline in a task.

## Setup and local notes

| Command | What it does |
|---|---|
| `npm run setup` | Sets `core.hooksPath` to `.githooks`; in a worktree, links `node_modules` and `.vscode-test` to the main checkout's (both are git-ignored, links included). Run it first in every new worktree. `npm install` runs the hooks part. |
| `npm run -s local-notes` | prints the maintainer's machine notes (test repositories, tool installs, log locations), kept outside the repository; exits 1 where there are none |

## Checks

| Command | When | Time |
|---|---|---|
| `npm run check -- --quick` | while iterating | ~25 s |
| `npm run check` | once, before you report a task done; the same steps as CI (lint, typecheck, full suite) | ~1 min |
| `npm run check:baseline` | once at the end, when `src/engine/` or a language's analysis changed: TypeScript CLI baseline + preview goldens, prints `same` or the differing cases. Needs the maintainer's local test repositories (`npm run -s local-notes`). `--cli` (~35 s) / `--preview` (~2 min) run one half. | ~2.5 min |

`npm run -s check:public [-- <ref>]` refuses added lines that name the maintainer's machine or the
local test codebases (a denylist kept outside the repository; this repository is public).

`check` runs every step even after one fails and prints only the failing steps' output.

Git hooks (installed by `npm run setup`): `pre-commit` runs `check:public`, lint and typecheck (~10 s), `pre-push`
runs the quick tests (~16 s). `--no-verify` skips them for one commit or push; say so if you do.

## Tests

| Command | Use |
|---|---|
| `npm run t -- <name…>` | the test files whose path contains each name: one line per file (pass/fail counts, time), failing lines included; `--verbose` prints a failing file's whole output |
| `npm test` | the full suite, parallel, with a per-file deadline |
| `npm run test:quick` | the quick tier |
| `node test/run.js --only <substring>` | the manifest files whose path contains it (repeatable) |
| `node test/run.js --file <path>` | one ad-hoc file through the runner's deadline |

A new test file goes in `test/suite.js` (SUITE, or EXCLUDED with a reason); the runner fails on an
unlisted file. Run tests through `test/run.js`, not bare `node --test`: the runner sets deadlines,
heap limits and a fast `git` on macOS, and strips git's hook variables. A PreToolUse hook
(`.claude/settings.json`, `scripts/agent-guard.js`) refuses a bare test-file run and names the
`npm run t` command instead; `IT_RAW_TEST=1` in front of the command runs a file directly on purpose.
A test file over ~5–10 s is too slow; see
[working-agreements.md](working-agreements.md).

## Oracles and end-to-end runs

`npm run oracle -- <harness script> [args…]` (scripts/oracle.sh) runs a script in
`test/lsp-harness/` under the test-repository lock, with the .NET SDK on PATH for C#. Every oracle
or e2e run goes through it: they check out branches in the shared test repositories. Each
script's header lists its flags, for example:

```
npm run oracle -- test/lsp-harness/csharp-verify.js --syntactic --callers --repo <clone> --commit <sha>
```

The oracles run against the maintainer's local clones; `npm run -s local-notes` names them and
says which ones a claim needs. Without local notes, the oracle runs are not available.

## The extension in a real editor

`node scripts/drive.js [--repo PATH] <steps…>` starts a pinned VS Code with this working tree as
the extension and writes screenshots, text dumps, `summary.json` and the extension log to
`.vscode-test/out/latest/`. Reference: [docs/driving-the-extension.md](../driving-the-extension.md).
One run per check with every step in it; a second run while one is going is refused (a lock under
`/tmp`). Read `summary.json` first, then `failure.png`.

## The CLI

`npm run analyze -- --repo <path> --mode <mode> --base <ref> --json` prints one analysis as JSON
(`node src/cli.js --help` for the modes and flags). Pipe large JSON to a file and read the keys you
need; a whole analysis is tens of kilobytes.

## Pull requests

Push the branch, then `gh pr create`, or, where `gh` is not installed,
`npm run pr-link -- <branch> "<title>" [body.md]`, which prints the link that opens the PR with
title and body filled in.

## Packaging

`npm run package` builds `impact-tree.vsix`. Releases go through `.github/workflows/release.yml`.
