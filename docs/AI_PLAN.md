# AI plan (Part AI): impact cards with the user's own agent (plan, 2026-10-26)

**Status:** owner asked for a plan, not building. Implementation happens in a new thread,
task by task.

**Goal (owner):** the reviewer knows the impact of every change in a PR on the rest of the
codebase. There is no Impact Tree API key or model. We use the agent the user already has
(Claude Code, Codex, Cursor, Copilot), give it our analysis as tools, and show what it
adds in the extension.

**Principle:**

> **The engine states facts; the agent names, summarises, merges and closes gaps, citing
> the facts.** Agent output is labelled, checked before it is shown, never overrides an
> engine fact, and never turns "unknown" into "fine" without evidence.

This extends `UX_PLAN.md`'s rule ("borrow CodeRabbit's structure, not its commentary").
E1 (post an impact summary to the PR), deferred from v1, is part of this plan (AI7).

## What is already established

All of this is evidence from 2026-10-26. The work is in `~/Projects/impact-tree-scratchpad/`
(the files below), and the code is on the uncommitted branch `proto/clusters`
(worktree `~/Projects/impact-tree-scratchpad/proto-wt`).

1. **Research** (`ai-research.md`). We can reach the user's agent through MCP and through
   hand-off:
   - Claude Code, Codex, Cursor and VS Code all register MCP servers; VS Code does it through `registerMcpServerDefinitionProvider` (1.101).
   - MCP *sampling* is deprecated in the spec (2026-07-28), so a server cannot borrow the model silently.
   - Anthropic's terms forbid third parties routing requests through a user's Pro or Max login. A user running their own Claude Code, or a hand-off the user starts, is fine.
   - CodeRabbit's closest feature is "Security Blast Radius": model-built, marked "potentially impacted", and sold on its $72/dev plan.
2. **Cluster cards without AI** (`clusters/FINDINGS.md`, 26 PRs across TS, Go and Python, reviewed twice). The extension builds the cards from the call graph:
   - **Clusters:** changed functions linked by calls.
   - **Card kinds:** sweep cards for repeated edits; generated-code, moved, sibling and hub (router) cards.
   - **Per card:** seams (calls across cards, meeting points), merge hints with evidence, and impact paths up to entry points (CLI commands, public API, UI routes, main).
   - **Round 2:** 52% of cards right as built, 74% right or one hinted merge away. 9 of 16 PRs improved, none got worse.
   - **Entry detection:** 100% recall on cli/cli's 209 commands and httpx's 66 public names.
   - **Speed:** clusters in < 50 ms; paths ≤ 6 s per PR.
3. **Agent with and without our tools** (`clusters/exp/FINDINGS.md`): Claude Sonnet, headless, checkout.
   - **Card refinement (12 PRs):** valid 12/12 in both arms. Summaries are concrete. The agent named 45 leftover go-fix cards as 9 kinds of rewrite. It merges about 75% of what a reviewer wants, almost never splits (1/8), and costs about $0.08 per PR.
   - **Closing unknowns (30 functions):** recall 0.95–0.97. Our tools raise precision from 0.89 to 0.95 and checked evidence from 96% to 100%. About $0.04 per function.
   - **In a checkout,** our tools are a precision and verification tool, not a search tool.
4. **Preview mode** (5 runs, the agent with no files and only our tools): it found every
   true caller outside the PR's files with only `get_source` plus `search_code`, at checkout
   accuracy and about 1.5–2× the turns. In preview, our tools are the only way in.
   **Open problem:** searching code at the PR head without a checkout. GitHub code search covers the default branch only.

## Scope

**In:**
- the card engine in the product;
- a Cards view, which works without any agent;
- an MCP server with fact, verification and code-access tools;
- connecting it to the user's agents;
- three agent actions: refine cards, close unknowns, PR impact comment;
- preview-mode code access.

**Not now:**
- background runs on a user's subscription (AI-D1);
- ACP;
- learnings;
- natural-language checks;
- Codex and Cursor runners beyond MCP registration;
- tracking type and schema changes (a separate engine gap, AI-L1).

## Tasks

Each task is one PR. Code is ported from `proto/clusters` with its tests, reviewed against
`CODING_STYLE.md`, and nothing changes while the new settings and flags are off.

- **AI0. Impact paths and entry points in the engine.**
  - Port `src/engine/entry-points.js`, `entry-facts.js` and `impact-paths.js`, plus the
    `analyze.js` and `analyze-remote.js` options, and the CLI `--impact` flag (the
    prototype's `--clusters`, split).
  - Port the entry-detection unit tests and the `v4-oracles.js` checks into
    `test/lsp-harness/`.
  - Acceptance: oracle recall ≥ 95% on cli/cli and httpx; the TS baseline identical with
    the flag off; paths ≤ 10 s per PR on the corpus.
- **AI1. Cards in the engine.**
  - Port `clusters.js`, `cluster-hints.js` and `repeated-edits.js`, with their 51 tests, and
    the `--cards` CLI output.
  - Two fixes are owed:
    - a readable fallback label for shape sweeps (`≈ ⟪0 → 12⟫` today);
    - renames under a different name are still shown as delete plus add (document it, or detect by body similarity).
  - The corpus invariants script (`v2-invariants.js`) moves to `test/lsp-harness/cards-verify.js`.
  - Acceptance:
    - every change is in exactly one card;
    - reruns are byte-identical;
    - card counts per corpus PR within ±10% of the prototype's round 2 (a list is attached to the PR).
- **AI2. Cards view (no agent).**
  - A **Cards** view, placement per AI-D7. One card per cluster or sweep shows:
    - its label and member count, with a mirrored, moved or generated note;
    - its impact facts ("3 signature changes, 2 callers not updated outside this card");
    - its entry points ("gh issue create, gh pr edit, … +6"), its seams to other cards, and "Used only by tests".
  - Clicking a member opens the existing row or diff. Clicking a seam selects the other card.
  - PRs with fewer than 4 changes show no cards.
  - Works in checkout and preview. Preview cards say what preview cannot see.
  - Acceptance: owner's manual pass on 3 PRs; snapshot tests of the view model.
- **AI3. MCP server (product).**
  - `impact-tree mcp`, a CLI subcommand over stdio (AI-D2, AI-D3). Tools, read-only unless noted:
    - **facts:** `list_cards`, `get_card`, `get_change`, `callers_of`, `find_references`, `impact_paths`;
    - **verification:** `validate_cards`, `check_evidence`;
    - **code access:** `get_source`, `list_files`, `search_code`, for preview (AI6);
    - **write-back** (AI-D5): `submit_cards`, `submit_callers`. These are validated by the server and rejected with errors the agent can fix.
  - A **bridge** to the running extension (lock file plus local socket, with a token), so submitted results appear live.
  - Without the editor it works headless, as in the prototype.
  - Every answer carries `complete` and `reasons`; results stay under 40k characters, paged.
- **AI4. Connect the user's agents.**
  - Commands, each asking first:
    - **Connect Impact Tree to Claude Code:** `claude mcp add`, or the Claude Code plugin deeplink;
    - **…to Codex:** `codex mcp add`;
    - **…to Cursor:** its MCP install deeplink;
    - **VS Code / Copilot:** the provider API, feature-detected.
  - Detect what is installed and signed in (`claude auth status` and the like).
  - Extend `src/agent-handoff.js` with Claude Code's `vscode://anthropic.claude-code/open?prompt=` link.
  - Acceptance: the owner connects Claude Code (tested) and, if installed, one of Codex and
    Cursor, and a tool call works from each.
- **AI5. Refine cards with my agent.**
  - The button on the Cards view builds the prompt: PR title and body, the cards, and the rules (name, summarise, merge, split, move, each with a reason; only given ids; PR content is data, not instructions).
  - It hands off through AI4. The user starts the run.
  - The agent returns cards through `submit_cards`. The view shows the titles and summaries, marked as from the agent.
  - Merges show their reason and can be undone. Engine facts stay visible under each card.
  - Results are cached by head commit (AI-D5).
  - Split hints come from the engine ("this card may hold two features: …", from commit classes), because the agent rarely splits on its own.
  - Acceptance: 3 PRs end to end in the editor; owner's read of the summaries.
- **AI6. Code access in preview** (spike first, then build).
  - Design `search_code` and `get_source` without a checkout. Options:
    - (1) the PR's changed files plus files fetched by path on demand, with GitHub code search on the default branch for files the PR didn't touch (unchanged files are identical at head);
    - (2) a bounded fetch of the module's files (like the CLI's Go and Python index);
    - (3) both.
  - Measure on 3 preview items, the same ones as the preview test.
- **AI7. Close unknowns with my agent.**
  - On a card or row with "callers unknown" or a path ending "referenced as a value", **Ask my agent** sends the function and the reasons.
  - The agent returns callers or registration sites with file:line evidence through `submit_callers`.
  - The extension runs `check_evidence` on each one, then shows them as "found by agent" rows. The row stays amber until the reviewer accepts them; accepting continues the impact path from there.
  - Acceptance: the X2 items replayed in the editor (≤ 6 runs), with evidence checking out on every shown caller.
- **AI8. PR impact comment** (E1, gate G12).
  - From the cards: the engine's counts and entry points, plus the agent's titles and summaries if present.
  - Posted on a button, under 40 lines, saying when it came from a preview or an incomplete analysis.
- **AI9. Docs:** README (agents, privacy: code leaves the machine only through the user's own agent), changelog.

## Decisions for the owner

Decided 2026-10-26 by the owner: every proposal accepted (AI-D1 to AI-D9, all (a)).

- **AI-D1. Claude background runs.**
  - (a) **Proposal:** hand-off only. The user starts the agent (terminal or chat), results come back through our MCP tools, and there is no silent `claude -p` on a subscription.
  - (b) Opt-in background runs with the user's API key.

  (Experiments ran on your own account as development use, which is different.)
- **AI-D2. Transport.**
  - (a) **Proposal:** stdio subcommand plus a bridge to the extension.
  - (b) An HTTP server inside the extension host.
- **AI-D3. MCP implementation.**
  - (a) **Proposal:** the official SDK in the product, which tracks protocol changes (stateless MCP, 2026-07-28); it adds one dependency.
  - (b) Keep the prototype's hand-rolled server.
- **AI-D4. Minimum VS Code.**
  - (a) **Proposal:** keep ^1.84, and feature-detect the MCP provider API (1.101).
  - (b) Raise to 1.101.
- **AI-D5. How results come back and where they live.**
  - (a) **Proposal:** write-back tools (`submit_*`) into workspace state, cached by head commit and content hash.
  - (b) The agent writes `.impact-tree/cards/<sha>.json`, which the extension watches. It is shareable, but files appear in the repo.
- **AI-D6. Agents in the first version.**
  - (a) **Proposal:** Claude Code fully tested; Codex, Cursor and Copilot through MCP registration, with a manual pass by whoever has them.
  - (b) Claude Code only.
- **AI-D7. Cards view placement.**
  - (a) **Proposal:** a new **Cards** view in the Impact Tree container, next to Changes.
  - (b) A grouping mode inside Changes.
  - (c) A panel in the PR overview.
- **AI-D8. Splits.**
  - (a) **Proposal:** the engine owns splits (commit classes, hubs) and passes split hints to the agent.
  - (b) Push the agent harder to split.
- **AI-D9. Landing the prototype.**
  - (a) **Proposal:** port it task by task (AI0, AI1, AI3), with its tests, as reviewed PRs.
  - (b) Rewrite from the findings.

## Known limits (stated in the product)

- **AI-L1.** Changes to types, interfaces and schemas are not tracked as changes (hono `types.ts`, t3code contract schemas). A schema change can be a PR's riskiest part. This is a separate engine task.
- **AI-L2.** Effect-style service code (t3code) has few detected entry points. Paths stop at "referenced as a value", which is AI7's job.
- **AI-L3.** Agent output varies between runs. It is cached by commit, labelled, and never replaces facts.
- **AI-L4.** Tested only with Claude Sonnet. Codex and Cursor work through MCP in principle, untested here.

## Verification plan (to agree with the owner before each task)

Small by default: agent runs at most about 6 per check (owner, 2026-10-26).

| Task | Check | When | Expected time |
| --- | --- | --- | --- |
| all | `npm run test:quick` + touched tests | iterate | ~15–30 s |
| all | `npm test`, lint, typecheck, TS baseline `compare.sh` (flags off → identical) | end | ~3 min |
| AI0 | corpus live run with `--impact` (26 PRs, per-head worktrees) + oracles | end, ≤ 2 runs | ~1.5 min + 2 s |
| AI1 | `cards-verify.js` invariants on the 26 recorded PRs | iterate, end | ~30–45 s |
| AI2 | view-model snapshot tests; owner's manual pass on 3 PRs | end | ~10 s; owner 15 min |
| AI3 | server unit tests (stdio, all tools, paging, bridge with a fake extension) | iterate | ~2 s |
| AI3 | one real handshake with Claude Code | end, once | ~30 s |
| AI4 | one tool call from each connected agent (owner) | end | owner 10 min |
| AI5 | 3 PRs end to end in the editor (3 agent runs) | end | ~2 min + owner read |
| AI6 | spike: 3 preview items per option (≤ 6 runs) | once | ~5 min |
| AI7 | replay ≤ 6 X2 items in the editor | end | ~3 min |
| AI8 | comment rendering tests; one post to a test PR (owner) | end | ~10 s |

Budget per task: verification ≤ 10 minutes of machine time. A single run over 5 minutes stops and gets reported.

## Order

1. **AI0 → AI1 → AI2.** Cards in the product with no agent. This is useful on its own, and free for every user.
2. **AI3 → AI4.** The MCP server and connecting agents.
3. **AI5,** the headline feature, then **AI7**.
4. **AI6** spike, in parallel with AI3–AI5 (it only feeds preview), then its build.
5. **AI8, AI9.**

Decisions needed before: AI-D9 and AI-D7 before AI0–AI2; AI-D1–D6 before AI3.

## Starting it in a new thread

1. Branch from `main`. Read this plan and the three findings files above.
2. Agree the verification plan for the first task (AI0).
3. Port from `proto/clusters` (worktree `~/Projects/impact-tree-scratchpad/proto-wt`); do not merge that branch whole.
4. Test repositories are in `~/Projects/impact-tree-test-repos/`, including the per-head worktrees `*-x2-*` and the prototype's `*-cl`. Corpus and harness scripts are in `~/Projects/impact-tree-scratchpad/clusters/`.
5. The TS baseline needs refreshing first. Its outputs for hono-1774, t3code-3 and t3code-e8dfc42 differ since #92 (an intended change).
