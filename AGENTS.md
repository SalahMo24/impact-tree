# Impact Tree: agent index

Impact Tree is a VS Code/Cursor extension, CLI and MCP server for a human reviewing a pull request:
for each changed function it lists the callers and walks impact paths up to entry points
(TypeScript/JS, Go, Python, Java, C#). Plain CommonJS JavaScript, typed with JSDoc.

Mechanical work is a command, not something to do by hand: checks, test runs, oracle runs, the
UI driver, worktree setup and PR links all live in [docs/agents/commands.md](docs/agents/commands.md).

Read the file that matches what you are about to do:

| When you… | Read |
|---|---|
| run a check, a test, an oracle, the UI driver, or open a PR | [docs/agents/commands.md](docs/agents/commands.md) |
| look for where something lives in the code | [docs/agents/repo-map.md](docs/agents/repo-map.md) |
| need the test repositories, language tools or editor logs | `npm run -s local-notes` (machine-specific notes, kept outside the repository) |
| plan a task, brief a subagent, or decide what to verify | [docs/agents/working-agreements.md](docs/agents/working-agreements.md) |
| hit something odd in the editor, the driver or the shell | [docs/agents/gotchas.md](docs/agents/gotchas.md) |
| write or review code | [docs/CODING_STYLE.md](docs/CODING_STYLE.md) |
| work on a language's analysis | [docs/MULTI_LANGUAGE_PLAN.md](docs/MULTI_LANGUAGE_PLAN.md) |

A new worktree: run `npm run setup` first. Before you report a task done: `npm run check`.
