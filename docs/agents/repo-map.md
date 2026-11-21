# Repository map

| Path | What is there |
|---|---|
| `src/extension.js` | activation: wires the session, views and commands |
| `src/engine/` | the language-blind analysis: `analyze.js` (local), `analyze-remote.js` (PR preview without a checkout), diff, callers, `impact-paths.js` + `entry-points.js` + `entry-facts.js` (entry-point walk) |
| `src/languages/<lang>/` | one provider per language (`typescript`, `go`, `python`, `java`, `csharp`): outline, signature, syntactic index, rules; `index.js` is the registry, `types.js` the contracts |
| `src/session/` | editor-side state: the review session, commands, readiness, review identity |
| `src/views/` | the side bar (`sidebar/`, `changes/`), Details panel, review tab, PR tab |
| `src/diff-editor/` | the review editor: navigation, comments, decorations, agent threads |
| `src/github/` | GitHub API: PR data, search, remotes |
| `src/agent/`, `src/mcp/` | agent integration: the bridge to the editor and the MCP server (`server.js`, `tools.js`) |
| `src/feedback/` | feedback rounds between reviewer and agent |
| `src/cli.js`, `src/cli/` | the command-line entry |
| `test/` | unit and integration tests; `test/suite.js` is the manifest, `test/run.js` the runner |
| `test/lsp-harness/` | oracles and e2e runs against real language servers and test repositories, plus their reports (`*-REPORT.md`) |
| `scripts/` | development tools: `drive.js`, `setup.js`, `check.js`, `check-baseline.js`, `oracle.sh`, `pr-link.js`, `demo-repo.js`, `package.js` |
| `demo/` | the demo repository's sources, built by `npm run demo:build` |
| `docs/` | `CODING_STYLE.md`, `MULTI_LANGUAGE_PLAN.md`, `UX_PLAN.md`, `driving-the-extension.md`, perf and correctness notes |

Lint and typecheck cover only files whose first line is `// @ts-check` (one enrolment list,
`eslint.config.js`). Add the marker to a file you create; enrolling an existing file is its own change.
