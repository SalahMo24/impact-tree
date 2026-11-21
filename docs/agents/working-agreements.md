# Working agreements

How the owner wants work planned, delegated and verified.

## Verification is planned, not discovered

- In the plan, list each check per task: the command, what it proves, its expected time, how often
  it runs (while iterating vs once at the end), and a budget for the whole verification. Agree it
  with the owner before work starts. Runs of tens of minutes are not acceptable.
- The defaults: `npm run check -- --quick` and the touched test files while iterating;
  `npm run check`, plus `npm run check:baseline` when the engine changed, once at the end.
- A test file over ~5–10 s is too slow. Build test repositories from the template helpers
  (`test/local-repo.js`, `test/extension-env.js`), keep fixtures small, pin `lib`/`types: []`/
  `skipLibCheck` in fixture tsconfigs.
- Exploratory experiments stay small: about 3–6 agent runs, reuse earlier results as the
  baseline, scale up only when a decision depends on it.

## Delegating to subagents

- Model by task: Sonnet for clear steps and a defined end, Haiku for search and classification,
  Opus for design and judgement.
- Give each agent the agreed checks and budget verbatim; anything extra needs a reason in its report.
  Over budget: stop and report.
- Ask for evidence, not a verdict: exact commands, exit codes, wall times, output or log paths.
  Re-run a check yourself only when the evidence is weak or inconsistent.
- Cap the report at ~300 words; details go in a file outside the repository, and the report names it.
- Reviews put a "Must fix" section first.
- An agent in its own worktree: `npm run setup` first. One simple command per call with literal
  absolute paths (`git -C /abs/path …`), no `cd "$VAR"`, no `source`; edit files with the edit
  tool rather than sed or python heredocs. The isolation guard refuses commands it cannot read.
- Changes to the caller index or caller answers get an independent review before they are pushed;
  every such review so far has found real problems.

## The repository is public

Tracked files name no machine paths, user names or the local test codebases the oracles run
against. Write `<clone>`, "the test repositories", or point to `npm run -s local-notes`;
`check:public` (in the pre-commit hook) enforces it.

## Status and notes

One place for a task's status: its plan file. Notes elsewhere point to it instead of repeating it.
