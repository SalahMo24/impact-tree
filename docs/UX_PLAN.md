# UX plan: less confusing, and hard to give up

Written 2026-10-19 from a read of `main` at a06c08a and a study of CodeRabbit's review
UI and feature set (docs.coderabbit.ai, October 2026). Users are sometimes confused by
the extension; this plan says what confuses them, what to borrow from CodeRabbit, and
in what order. It follows the rules in `docs/RELEASE_PLAN.md` ("Rules for every task")
and reuses its task ids where a task already exists there.

## Where we stand against CodeRabbit

CodeRabbit is an AI reviewer. What its users praise most is not the inline comments
but the *structure* around them:

- **Understand before reading code.** A walkthrough comment: a summary, one row per
  changed file, a sequence diagram of changed call flows, and an "estimated review
  effort" from 1 to 5.
- **A reading order.** Change Stack (preview, 2026) replaces the alphabetical file list
  with numbered layers, "foundations before the code that depends on them", and a
  "Needs your attention" list.
- **Only what's new.** Incremental reviews on each push; fixed findings resolve
  themselves; repeats are folded into "duplicate comments".
- **One step to act.** Each finding carries a committable suggestion and a
  "🤖 Prompt for AI agents" block; the IDE extension has "Fix with AI", which hands the
  finding to Claude Code, Codex, Copilot or the clipboard.
- **Review before the PR.** The CLI's `--agent` mode emits findings as NDJSON so a
  coding agent can review and fix its own work before a human sees it.

What its users complain about: noise (an audit of 28 PRs found about 35% of comments
useful), long emoji-heavy walkthroughs, a re-review on every push, guesses that are
wrong, and missing context outside the diff.

Impact Tree's answers are exact (callers come from the language server, not a model),
fast and free, and they *are* the context outside the diff. So the rule for this plan:

> **Borrow CodeRabbit's structure, not its commentary.** Every new surface shows facts
> the engine already proved, says so when it doesn't know (`CODING_STYLE.md` §1), and
> stays silent when nothing is wrong.

Not borrowed: model-written inline comments, severity emoji on everything, poems,
re-review on every push, "learnings". They need a model, and they are what CodeRabbit
users turn off.

## What confuses users today

Found in the code; each has a task below.

1. **No first-run guidance.** No `viewsWelcome` or walkthrough in `package.json`. A new
   user meets "Ready — click to analyse" and an empty Changes view. (P5, already U7)
2. **One idea, several names.**
   - "Needs attention" (filter, Details) / "changes needing attention" (pre-approve
     check) / "stale" / ⛔.
   - "Mark reviewed" / "tick" / "viewed" (GitHub).
   - Details verdict words "Risk handled", "Reaches callers", "Quiet"
     (`detail-panel-html.js:20`) never appear in the tree.
   - The local mode `pr` (`package.json` `impactTree.mode`) is a branch diff, and is
     easily mistaken for the "Pull requests" group in the Review view.
   - "Analyse" in the UI, "analyze" in the CLI. (P1)
3. **Too many symbols.** `LEGEND` (`tree-row-models.js:25`) has 9 status glyphs
   (⛔ ✓ ● ∅ △ ○ ? 🧪 ↑); the README explains 5 (`README.md:28`). (P2)
4. **Command titles that explain the implementation.** "Show everything (now showing
   only what needs attention)", "Show callers of this change (rebind it in Keyboard
   Shortcuts)" (`package.json` commands). (P1)
5. **Hidden features.** Show callers is right-click or `Shift+Alt+C` only; test
   reachability is a tree row or the palette; the legend and log are in the overflow
   menu; Submit appears only while a PR is under review. (P4)
6. **Raw errors and unstated limits.** Checkpoint mode without a checkpoint throws
   `checkpoint mode requires opts.checkpoint` (`engine/analyze.js:95`). A no-checkout
   preview finds no callers outside the PR and no tests, stated in one warning row.
   Only the top 6 roots get a blast radius (`analyze.js:614`), which no surface says. (P3)
7. **A silent slow first run.** The first index takes 10–34 s (`README.md:98`) behind
   "Preparing…". (P3)

## Gates (owner decisions)

Numbered after `RELEASE_PLAN.md`'s G1–G7.

- **G8. The vocabulary.** One word per idea, used in the tree, Details, PR tab, status
  bar, commands, README and CLI. Proposal:

  | Idea | Word | Retired |
  | --- | --- | --- |
  | ⛔ signature/throw change with callers not updated | **Callers not updated** | stale, needs attention (as a state) |
  | the filter / summary bucket for ⛔ and ? | **Needs attention** | changes needing attention |
  | the checkbox | **Reviewed** (verb: mark reviewed) | tick, done |
  | GitHub's per-file flag | **Viewed on GitHub** | viewed (alone) |
  | the local mode `pr` | **Branch vs base** | pr |
  | the local mode `branch` | **Branch + uncommitted** | branch |
  | the local mode `working` | **Uncommitted (agent)** | working |
  | the no-checkout PR view | **Preview** | Tier A (user-facing) |
  | spelling | **Analyse** everywhere user-facing; `analyze` stays in code and CLI flags | |

  Setting values (`"pr"`, `"branch"`…) stay for compatibility; only labels change.
- **G9. How many tree states.** Proposal: three colours in the tree (red = callers not
  updated, amber = unknown or changed-not-at-call, none = fine), with the exact state
  (● ∅ ✓ ○ △) as the row's description text and in the tooltip. Or keep all glyphs and
  only switch to theme icons (U3 as written).
- **G10. Review effort score.** Show a 1–5 effort score in the summary (S1)? If yes, the
  formula is fixed in the PR from inputs the engine has (risk scores, number of changes,
  callers outside the PR, incomplete searches) and documented in the README. A score
  nobody can explain is worse than none.
- **G11. Reading order rule (W1).** Proposal: changed callees before their changed
  callers (a topological order of the changed symbols on the call graph), ties broken by
  risk score; tests last; cycles kept together. Alternative: risk first, which is today's
  file order.
- **G12. Posting to the PR (E1).** Off by default and posted on a button press only, or
  also a setting to post on every submit? One comment, edited in place on re-post, or a
  new one each time?
- **G3 / G4 from `RELEASE_PLAN.md`** decide F3 and F4 below. This plan proposes: G3 (d),
  a Claude Code `Stop` hook when configured, else the "Checkpoint now" button; G4 both
  clipboard and a git-ignored `.impact-tree/feedback.md`, plus the terminal hand-off in F4.

## Part P: plain first run (confusion fixes)

Small and independent. These come first: they cost little and fix what users already
hit.

### P1. One vocabulary (gate G8)

Acceptance: every user-facing string (tree, Details, PR tab, status bar, command titles,
CodeLens, settings descriptions, README, CLI help) uses the G8 words; a test greps the
built strings and `package.json` for the retired words and fails on any; toggle commands
have plain titles ("Show only needs attention" / "Show all"), with state shown by the
icon, not the title; "(rebind it in Keyboard Shortcuts)" removed from titles.

### P2. Fewer tree states (gate G9; replaces U3)

Acceptance: as G9 decides, rows use `ThemeIcon` with theme colours; `LEGEND` and the
README list the same states; the Details verdict sentence uses the tree's words; the
characterization snapshot changes only for this, each difference explained.

### P3. Errors and limits in words

Acceptance:
- Checkpoint mode with no checkpoint shows "No checkpoint yet" with a **Set checkpoint
  now** button instead of throwing.
- Preview shows its limits in the summary (S1) and in Details for every row whose
  callers may be incomplete because of it: "Preview: callers outside this PR and tests
  are not searched. **Check out and analyse** for the full picture."
- Roots past `rankedRoots` say "blast radius not computed (top N only) — **compute**".
- The first index shows progress ("Indexing 412 files, first run only… 38%") in the
  view message and a `window` progress notification that can be hidden.

### P4. Features you can find

Acceptance: Show callers is an inline action on change rows and a link in Details; test
reachability is a Details button; the legend is a `?` icon in the Changes title bar;
"Submit review…" is visible (disabled with a tooltip saying why) whenever a PR is open;
Previous unreviewed (U6) ships with this.

### P5. First-run and empty states (= U7)

As U7 in `RELEASE_PLAN.md`, plus: the Changes view's empty state offers the three ways
in as buttons — **Review my branch**, **Review uncommitted (agent) changes**, **Open a
pull request** — with one line each on when to use it.

Owner check: U8's usability walk, run after P1–P5.

## Part S: understand before reading

### S1. Summary card (extends U1; gate G10)

A fixed block at the top of Details when no row is selected, and pinned above the
per-row content otherwise (collapsed to one line):

```
PR #51 · 12 changes in 7 files · Effort 3/5
  ⛔ 2 callers not updated      → filter
  ?  1 caller search incomplete → filter (reason)
  ↗ 3 changes reach callers outside this diff
  🧪 1 change has no test reaching it
  8 of 12 reviewed · 2 unresolved threads
```

Acceptance: every count is the same number the tree's filters produce (one function
computes both, tested); clicking a count applies that filter and shows it as active and
clearable (U1); counts that are zero are hidden; an incomplete or preview analysis says
so on the first line; the effort score, if G10 says yes, is a pure function with tests
and a README entry; repaint rules hold (the card patches, it does not re-render Details).

### S2. Call-flow diagram for a change (optional)

Acceptance: Details for a change row offers "Show call flow", rendering the change and
its callers to depth `reachDepth` as a small graph (Mermaid or inline SVG, no network),
with ⛔ / ? edges coloured, nodes clickable to open the call site; capped at a stated
node count with "+N more".

## Part W: a reading order

### W1. Review path (gate G11)

Today files are sorted by worst verdict, which says what's risky but not where to start.

Acceptance: a "Review path" order (title-bar toggle between **Path** and **Files**) numbers
the changes 1…N by the G11 rule and groups each change with its changed callers, like
Change Stack's layers; the order is a pure function of the analysis result, tested on
fixtures including a cycle and two unconnected groups; ticks, filters and the summary
work the same in both orders.

### W2. Next follows the path

Acceptance: in Path order, Next/Previous unreviewed (`Alt+N`, U6's key) follow the path;
the status bar shows "step 4 of 12"; Details shows "why here": "changes `foo`, called by
steps 6 and 9".

## Part F: the agent loop

The feature most likely to make the tool hard to give up. CodeRabbit sells this as "Fix
with AI" and a paid CLI that takes minutes; Impact Tree can do the core of it exactly
and in seconds. Builds on Part A of `RELEASE_PLAN.md`; A1–A2 come first.

### F1. A fix prompt for every unupdated caller

Acceptance: each ⛔ change and each △/○ caller under it has **Copy fix prompt** (inline
action and Details button). The prompt is built only from engine facts: the symbol, old
and new signature (or the new throw), and each caller not updated with `file:line` and
the call line's text, ending with an instruction to update those calls or explain why not.
No guessed fix. Pure function, snapshot-tested on a fixture; a change with an incomplete
search says so in the prompt.

### F2. Machine-readable output for agents

Acceptance: `impact-tree --agent` (CLI) writes NDJSON events: `status`, one `finding`
per ⛔ or ? change (fields: severity from the verdict, file, symbol, kind of change,
callers not updated with `file:line`, `prompt` from F1, `complete: false` when the
search was incomplete), then `complete` with counts. Exit code 0 when nothing needs
attention, 1 when something does, 2 on error. Documented in the README with a sample.

### F3. Run after every agent turn (gate G3)

Acceptance: a documented Claude Code `Stop` hook (and a Codex equivalent if it has one)
that runs `impact-tree --agent --mode working` and, when findings exist, returns them to
the agent so it fixes them before stopping; the same hook records the turn's checkpoint
(A2). An install command writes the hook config after showing it and asking. Owner check:
a real session where the agent fixes a missed caller on its own.

### F4. Send to an agent from the editor (gate G4; extends A5)

Acceptance: next to Copy fix prompt (F1) and on A5's exported review, **Send to agent**
offers what's available: a running Claude Code / Codex terminal (sends the text, doesn't
press enter), the clipboard, and the feedback file from G4; the last choice is remembered
as a setting.

## Part E: share the result

### E1. Post an impact summary to the PR (gate G12; README roadmap)

Acceptance: from the PR tab, **Post impact summary** posts S1's numbers and a table of
⛔ and ? changes (symbol, file, callers not updated) as one comment inside a collapsed
`<details>`, under 40 lines whatever the PR size; it states when it came from a preview
or an incomplete analysis, and which commit it describes; re-posting follows G12; it
ends with one line naming the extension and linking to it. Ownership checked before
editing an existing comment (`CODING_STYLE.md` §5).

## Part I: only what's new

### I1. Since your last review

A4 (re-edited rows) covers agent edits. This extends it to PR pushes.

Acceptance: for a PR, the extension remembers the head SHA at the reviewer's last
submitted review (or last mark-reviewed); when the PR has moved, a **Since your last
review** filter shows only changes whose content changed since then, the summary
says "3 changes since your review on Oct 14", and rows reviewed before and unchanged stay
reviewed. Tested with two heads of a fixture repo.

## Order, and changes to `RELEASE_PLAN.md`

`RELEASE_PLAN.md` runs C → B → A → U → R, with U after A0. Proposed:

1. **P1–P5** right after C. Cheap, independent, and it's what confuses users now. P2
   replaces U3; P5 is U7; P4 absorbs U6. Needs G8 and G9 first.
2. **S1** (absorbs U1 and the summary half of U2). Needs G10.
3. **A0–A2, then F1–F4.** The agent loop, ahead of B. Needs G3 and G4.
4. **W1–W2**, then **E1** and **I1**. Needs G11 and G12.
5. **B** (review loop part 2), the rest of U (U2 rows, U4, U5, U8), then R.

S2 is optional and can drop out of v1.

If the owner agrees, `RELEASE_PLAN.md` gets a short note pointing here and its U section
is updated to say which tasks moved; nothing in C or R changes.
