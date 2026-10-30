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
8. **The review starts eight rows deep.** With a pull request open, the first change sits
   under Pull requests → a group → the PR → three folder rows → the file → the symbol.
   `review-sidebar.js` nests the review under its source by design (2026-10-29); in the
   tree layout `folder-tree.js` compacts only single-child chains, so `apps` stays its own
   row above `server/src` whenever `apps` has a second child. In a 300 px sidebar the
   indentation takes half the width and every label truncates. (L1, L3)
9. **Two definitions of done.** The view's message reads "0 need attention · 107 of 107
   left": `countReview` (`review-tree-model.js:279`) counts every counting row as work,
   while attention counts only ⛔ and ?. A clean PR is a 107-item chore. The filter starts
   at `all` (`tree-provider.js:255`). (L2)
10. **Mechanics shown as rows.** "Compute test reachability · extra caller queries — run on
    demand" (`tree-row-models.js:530`), "Outside functions lines 1–19, 30–111", "no call
    graph" on every file without one (`tree-item-renderer.js:273`), "Merge hints loading…"
    (`cards-view-model.js:580`) sit among the findings at the same weight, with icons, so
    a reader cannot tell a finding from a file from a button. (L3)
11. **Six signals per row.** Checkbox, file icon, label, description, an inline Show
    callers icon, the git badge letter, and colour. Folder rows repeat the checkbox and
    the attention colour (`tree-item-renderer.js:217`), so one signal is drawn three times
    down a path. (L3)
12. **Internal names.** "K1 · commandLabel and 2 related", "merge hints", "call graph",
    "test reachability", "reaches 1 caller", "extra caller queries", "Everyone else 1000".
    G8 unifies synonyms; it does not replace jargon. (L5)
13. **Three panels in one sidebar.** Review, Cards (with `impactTree.cards.enabled`) and
    Details split the height in thirds. Details, kept small by the minimal pass, shows a
    name and a path for a quiet row while the tree it serves is squeezed to a few rows. (L4)

14. **The Cards view hides the feature.** With an agent result, the view opens with three
    housekeeping rows (Undo, Show engine cards, the summary cut to one line), then a
    "Needs your attention (4)" group that repeats changes drawn again under their card,
    while Details says "2 need attention" (the engine's set, not the agent's). The card
    itself is collapsed at the bottom. What the agent produces (summary, before/after,
    who is affected, entry points, seams) needs width a 300 px tree does not have.
    (L4 revised, L6)

Items 8–13 were found 2026-10-30 on a screenshot of t3code PR #27095 (107 changes, none
needing attention, cards and agents on); item 14 the same day on a second screenshot
with an agent result. Part L below has their tasks.

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
- **G10. Review effort score.** Dropped with S1 (2026-10-20). Was: show a 1–5 effort score in the summary (S1)? If yes, the
  formula is fixed in the PR from inputs the engine has (risk scores, number of changes,
  callers outside the PR, incomplete searches) and documented in the README. A score
  nobody can explain is worse than none.
- **G11. Reading order rule (W1).** Proposal: changed callees before their changed
  callers (a topological order of the changed symbols on the call graph), ties broken by
  risk score; tests last; cycles kept together. Alternative: risk first, which is today's
  file order.
- **G12. Posting to the PR (E1).** Deferred with E1 (2026-10-24). Was: off by default and posted on a button press only, or
  also a setting to post on every submit? One comment, edited in place on re-post, or a
  new one each time?
- **G3 / G4 from `RELEASE_PLAN.md`**: decided 2026-10-20. No per-agent turn hook; feedback
  rounds with a snapshot checkpoint and a feedback file per round instead (Part F).
- **G13. Where the review lives once it is open (L1).** Decided 2026-10-30 (owner): the
  proposal, host row as root. The nesting decided 2026-10-29 stays
  the model. Proposal: while a review is shown, the view's root is one row **Choose what
  to review…** (the picker, opened on click) and the host row, expanded; the Pull requests
  and Local changes groups are not drawn above it. Alternative: a second view, **Review**,
  under a **Start** picker view that collapses itself when a review opens. Either way, in
  list layout a change row is at depth 2 (file, change) and a caller at depth 3.
- **G14. What "left" counts (L2).** Decided 2026-10-30 (owner): the proposal, attention
  rows only. Proposal: progress counts the rows that need attention
  (⛔ and ?); the message, badge and Details strip say "3 need attention · 1 looked at",
  or "107 changes · nothing needs attention" when there are none; ticking stays on every
  row for reviewers who read everything, but is not counted against them. Alternative:
  keep counting every row and start the filter at **Needs attention** instead of all.
- **G15. One attention set (L4, L6).** Decided 2026-10-30 (owner): the proposal. Proposal: a change needs attention when the engine
  flags it (level 0 or 1) or the agent named it in `attention`; the tree's order and badge,
  the Details strip, the review tab's first column and the diff notes all count that one
  set. Alternative: keep the agent's list separate under its own word ("Your agent
  suggests looking at"), never "attention".
- **G16. Where the agent's note shows in the diff (L6).** Decided 2026-10-30 (owner): the
  proposal. Proposal: a read-only comment
  thread per change the agent described, expanded when the change needs attention and
  collapsed to its gutter glyph otherwise; the CodeLens agent line goes, since the thread's
  first line says the same. Alternative: keep the CodeLens line as the headline and start
  every thread collapsed.

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

### S1. Summary card (dropped)

Dropped 2026-10-20 by the owner: too much information that isn't useful. G10 and
the summary half of U2 go with it.

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

## Part F: feedback rounds with any agent

Decided 2026-10-20 (owner): no per-agent turn hooks (no generic way exists). Instead the
reviewer leaves feedback on local changes, sends it as a markdown file to whichever agent
they use, and the next review shows what happened to each item. The files stay in the
repo; after several rounds the owner may ask an agent to extract rules from them (not
part of this plan). Replaces the earlier F3 (turn hooks) and F4 (send to agent),
`RELEASE_PLAN.md` A1–A2, and gates G3/G4. The earlier F1 (a fix prompt per unupdated
caller) and F2 (`--agent` NDJSON output) are deferred, not dropped.
Mockup reviewed 2026-10-20.

Research behind it: CodeRabbit's IDE extension hands fixes to an agent through a
`coderabbit.agentType` setting (native chat, clipboard, `claude`/`codex` in a terminal,
other extensions) but keeps nothing between local reviews; GitHub, Bitbucket and
CodeRabbit's PR reviews track "since last review" by commit, which misses uncommitted
agent work and breaks on rebase; Claude Code's checkpoints track only its own edit tools.
A content snapshot of the working tree covers all of these.

### F1. Feedback drafts on local reviews

Acceptance: in Uncommitted (agent), Since checkpoint and Branch + uncommitted results,
the diff offers a comment box labelled **Feedback** (its own comment controller; PR
reviews keep theirs), and Details' 💬 on a change or caller starts a draft there too.
Drafts are listed in a **Feedback to send** group at the top of Changes (click opens the
line; context menu Edit / Delete / Send feedback…), counted in the status bar, and kept
in workspace state (`impactTree.feedbackDrafts`, `{ version: 1, items: FeedbackItem[] }`,
at most 200 items, body at most 10 000 characters; an unrecognised stored value is
dropped with one log line, never half-read).

A checked-out pull request takes feedback too: its files are on disk. Both comment
controllers then offer the same lines and VS Code asks which a new comment is for, by
their labels ("Impact Tree: GitHub review comment", "Impact Tree: feedback for your
agent"). Details keeps 💬 for GitHub comments there and adds a separate Feedback button.
Sending from a checked-out pull request names it in the round file ("Pull request #N
(checked out)") and switches to Since checkpoint, as from a local review.

### F2. Snapshot checkpoints, stored outside the repository

A snapshot records the working tree (tracked, modified and untracked files; `.gitignore`
respected; `.impact-tree/` excluded) as a commit whose objects are written to a folder
of the extension's workspace storage, never to `.git`:

```
cp $(git rev-parse --git-path index) <tmp>/index
GIT_INDEX_FILE=<tmp>/index GIT_OBJECT_DIRECTORY=<snap>/objects \
  GIT_ALTERNATE_OBJECT_DIRECTORIES=<repo objects> git add -A -- . ':(exclude).impact-tree'
… git write-tree; … git commit-tree <tree> [-p HEAD]
```

Reading a snapshot passes `GIT_ALTERNATE_OBJECT_DIRECTORIES=<snap>/objects` to the git
commands that read it (engine, base-side documents, review identity), through an
explicit `objectDirs` option of `makeGit`; nothing in the user's shell changes. Checkpoint
mode diffs with a temporary index in which untracked files are added intent-to-add
(`git add -N`), so a file untracked at snapshot time is not reported as deleted. The
user's index, HEAD, refs, stash and `.git/objects` are never written.
"Set checkpoint now" takes a snapshot too. A stored checkpoint that is an ordinary commit
(older builds) keeps working.

Acceptance: tests on throwaway repos prove the above, including that `.git` is
unchanged; a missing snapshot folder gives the existing "The checkpoint is gone" row;
time and size measured on t3code and recorded here.

Measured (Apple M3 Pro, Node v22.18.0, `take()` on t3code, 23 078 tracked files, three runs each): clean tree 179-186 ms and 160 bytes (one commit object; every blob and tree already exists in the repository's own objects, so the snapshot holds only what is new). A local clone of t3code with 5 modified and 3 untracked small files: 198-206 ms and 7 110 bytes (the changed blobs, the trees above them and the commit). Size grows with the content changed since the repository last stored it, not with repository size. `.git` of the measured repository was not touched (`git status --porcelain` identical before and after).

### F3. Send feedback

Acceptance: **Send feedback** (title bar ✈ when drafts exist, the group's context menu)
asks where to send it, remembering the answer in `impactTree.agent`
(`ask` | `claude` | `codex` | `chat` | `clipboard` | `save`; ⌥ asks again). It then:
writes `.impact-tree/feedback/<YYYY-MM-DD>-<n>.md` (format below; never overwrites),
takes a snapshot (F2) and makes it the checkpoint, clears the drafts, switches to Since
checkpoint, and hands off: Claude Code / Codex run `claude "<prompt>"` / `codex "<prompt>"`
in a new terminal; editor chat only where a spike proved it can fill the chat (else not
offered); clipboard copies the prompt. The prompt names the file and asks for a
`Status:` line under each item. If the file or snapshot step fails nothing is cleared
and the reason is shown.

Once per repo, after the first send: offer to add one line pointing agents at
`.impact-tree/feedback/` to `AGENTS.md` and `CLAUDE.md` (Add / Not now / Never).

File format (one round), parsed back by F4:

```
# Feedback round 2 · 2026-10-20 14:32
<!-- impact-tree feedback v1 round=2 checkpoint=<sha|none> -->
Branch: feat/x · Reviewed: Uncommitted (agent)

For the agent: address each item. Under each one, write `Status: done` or
`Status: skipped — reason`. Don't change anything else in this file.

## 1. src/session/session.js:212 · runAnalysis
<!-- item id=<id> -->
> } catch { /* ignore */ }
Don't swallow errors here.
Status:
```

### F4. What happened to each item

Acceptance: when the checkpoint is a feedback round's snapshot, Changes shows a
**Feedback round N** group first. Each item states, in words, two separate facts: the
agent's status (`Agent: done`, `Agent: skipped`, `No status written`, or `Status
unreadable` when the item's marker is gone) and whether the code near the item changed
since the snapshot (`Code changed` / `No code change` / `Change unknown` when the diff
could not be read). Amber when they disagree or anything is unknown (done with no code
change, skipped, unreadable); never shown as fine on missing evidence. Details shows the
text, status and reason, with Open change and **Reply in next round** (new draft at the
same place).

### F5. Cleanup of stored data

Feedback files are never deleted, moved or rewritten by cleanup. Everything else
Impact Tree stores has a retention rule, applied in the background (bounded, after
startup and after each send) and by **Impact Tree: Clean up stored data**, which lists
what it will delete with sizes and asks first:

| Stored | Rule |
| --- | --- |
| Snapshots | Keep the current checkpoint and the latest 2 rounds; delete others older than 30 days or whose branch no longer exists. |
| Temporary index files | Deleted after each use; leftovers deleted on startup. |
| Review progress (`impactTree.reviewed.*`) | Delete keys unused for 90 days, and branch keys whose branch is gone. |
| Checkpoint id | Cleared when its snapshot is deleted. |

Remote-tracking refs fetched for a base and branches made by "Check out and analyse" are
the user's git data and are left alone.

### Status (2026-10-20)

F1–F5 are implemented on `feat/ux-p1-p5`, with tests, lint and type checks; not yet tried
in a live editor. Differences from the mockup: Details shows nothing for a round's items
(their tooltip has the text, status and reason, and their menu has Reply in next round);
"Reply in next round" takes the text in an input box, since the item's file may have no
change in the review shown; the cleanup dialog is a multi-select list plus a confirmation,
VS Code's native equivalent of the mocked checkbox dialog.

### Shared contracts (F1–F5)

```js
/** @typedef {{ id: string, file: string, line: number|null, symbol: string|null,
 *   caller: { label: string, file: string, line: number }|null, quote: string,
 *   body: string, createdAtMs: number }} FeedbackItem
 *   `file` repo-relative, `line` one-based (null: the whole change or file),
 *   `quote` the code the reviewer saw (at most 5 lines / 400 characters). */
/** @typedef {{ id: string, sha: string, objectsDir: string, createdAtMs: number,
 *   branch: string|null, headSha: string|null, round: number|null, bytes: number }} SnapshotRecord
 *   `objectsDir` absolute; `round` set when the snapshot was taken by Send feedback. */
```

## Part E: share the result

### E1. Post an impact summary to the PR (gate G12; README roadmap)

Deferred 2026-10-24 by the owner: not in v1. It moves to the later version that adds the
AI integration and MCP server, and will be designed as part of that.

Acceptance: from the PR tab, **Post impact summary** posts the result's counts and a table of
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
## Part L: layout and hierarchy

The screenshot study (items 8–13 above) says the sidebar's problem is not the words but
the shape: navigation and content in one tree, every row counted as work, mechanics drawn
as findings, and three panels sharing one column. P1–P5 fix the words and the hidden
features; nothing in the plan fixes the shape. Rule for this part, after the minimal
pass of 2026-10-24: a feature is foreground only if it is a finding; everything the
engine did, did not do, or can do on demand is background (a hover, a description, the
`…` menu), and Details gets no new buttons.

### L1. The review at the top (gate G13)

Acceptance: as G13 decides. With the proposal: while a review is shown, the root of the
Review view is **Choose what to review…** (a row; its click, and the host's `…` menu
entry, draw the picker again without discarding the review) and the host row, expanded,
whose label names the review ("PR #27095 · feat: ADHD mode answers…", "Branch vs base")
and whose description keeps the counts; the groups above the host are not drawn; a
change is at depth 2 in list layout; reveal, ticks, filters, Next unreviewed and the
title-bar actions on the host row work unchanged (the characterization snapshot changes
only above the host, each difference explained); `review-sidebar.js` tests cover no
review, review shown, picker reopened, and a PR that is not in the list.

### L2. One definition of done (gate G14)

Acceptance: as G14 decides. With the proposal: `countReview` returns attention counts as
the progress, the message reads "<subject> · 3 need attention · 1 looked at" or
"<subject> · 107 changes · nothing needs attention", the badge counts attention rows
left, and the Details strip shows the same numbers; the pre-approve check lists the same
rows as before. When nothing needs attention the tree shows one calm row first, "Nothing
to flag: every caller updated, or a body-only change", with the files under a collapsed
**Browse all 107 changes** row below it, and the submit action enabled; a preview or an
incomplete analysis says so in that row instead ("Nothing to flag in what was searched;
check out and analyse for the full picture"), never "nothing to flag" on missing evidence
(`CODING_STYLE.md` §1).

### L3. Findings foreground, mechanics background

Acceptance:
- **Compute test reachability** leaves the tree: it is an entry in the host row's `…`
  menu and, while not computed, an inline ▷ on the host row with that tooltip. A finding
  whose tests were not searched says so in its tooltip only.
- **Outside functions** is renamed **Top-level changes** (L5) and drawn last under its
  file with no icon; a file whose only change rows are top-level has no child rows, and
  the file row is the counting row (its tick, decoration and diff open unchanged).
- **no call graph** is dropped: a file with nothing to analyse (Markdown, JSON, a test
  config) is a file row with its git badge and nothing else. **not analysed** stays for a
  file of a supported language that could not be analysed, with the reason in its tooltip.
- Folder rows carry no checkbox and no attention colour; their description is the
  attention count ("3") or nothing. The list layout stays the default.
- At most one inline action and one badge per row kind: Show callers on a change row,
  Retry on a failed viewed-sync row, the git badge on a file row; a test over the renderer
  counts them.
- Notices (preview limits, warnings, files not analysed, "Merge hints loading…") are
  never rows among the files: the host row's hover and description carry them, and the
  Cards view's title carries its spinner.

### L4. The Cards panel retired: one tree, two orders (revised 2026-10-30; gate G15)

Revised after item 14: the Cards panel is not slimmed, it goes. The sidebar's job is
navigation; the review tab (U1) is where the agent's text has room. No longer waits for
W1: an order of the tree stands on its own, and **Path** joins the toggle when W1 lands.

Acceptance:
- The `impactTree.cards` view and `cards-provider.js` are removed; `cards-view-model.js`
  keeps what the review tab and the By card order share.
- The Review view's title gets an order toggle, **Files** / **By card** (By card offered
  when the result has cards, so with `impactTree.cards.enabled` and a review of at least
  `MIN_CHANGES_FOR_CARDS` changes). The order is a workspace setting
  (`impactTree.reviewOrder`, default `files`).
- By card: one row per card (sparkle icon; the card's title; description
  `4 changes · 2 need attention`), cards that hold an attention change first, then by
  size, sweeps last; under a card its changes, worst first, each with its kind icon and the
  agent's one line (the engine's verdict text when there is no agent result), and a
  deleted symbol with its minus. A change in two cards is drawn once, under the first.
  Files without a card ("Other changes") close the list.
- The kind icons are the agent's own and never the engine's: pencil for changed, question
  mark for may change, plus for new, none for same behaviour, minus for deleted; the legend
  lists them.
- Ticks, filters, the calm state, Next/Previous unreviewed, reveal from the diff and the
  Details panel work in both orders (the counting rows are the same objects); the
  characterization snapshot gains a By card state for the hono fixture with an agent
  result.
- The three housekeeping rows move: **Analyse with my agent** is an inline sparkle on the
  reviewed row and in its `…` menu; **Undo agent result** and **Show engine cards** are in
  that menu while a result exists; the agent's summary (first line) joins the reviewed
  row's hover, and the whole of it the review tab. **Open review** stays a title action.
- "Needs your attention" is not a group: as G15 decides, the attention set orders the
  cards, feeds the badge and the Details strip, and decides which notes open (L6).
- The sidebar then holds Review and Details only; README and the legend say so.

### L5. Words a reviewer knows (extends G8)

Acceptance: as P1 (one vocabulary; the grep test fails on a retired string), with these
rows added to the G8 table:

| Today | Proposed |
| --- | --- |
| reaches N callers | called from N places |
| no call graph | (nothing; see L3) |
| Outside functions · lines 1–19, 30–111 | Top-level changes · lines 1–19, 30–111 |
| Compute test reachability · extra caller queries — run on demand | Find the tests that cover this |
| Merge hints loading… / Merge hints are incomplete | Grouping cards… / Some cards may belong together (hover) |
| K1 · commandLabel and 2 related | commandLabel + 2 related (the number only in Path order, W2) |
| Everyone else · 1000 | Everyone else · first 1000 |
| 107 of 107 left | as G14 |

### L6. The agent's notes beside the code (gates G15, G16)

Proposed 2026-10-30 (owner's idea): the per-change text the agent writes (what changed,
before, after, when, who is affected) is read best next to the hunk it explains, as
CodeRabbit's inline comments are, but kept for the reviewer and never posted.

Acceptance:
- A third comment controller, id `impactTree.agent`, label "Impact Tree: your agent's
  notes", with no `commentingRangeProvider` (it never competes with the GitHub and
  feedback controllers when the reviewer adds a comment) and `canReply: false`.
- One thread per change the agent described, in the review diff at the change's head-side
  range (the side and URI `review-comments.js` uses for GitHub threads), author "Your
  agent" with the sparkle, one comment whose markdown body is: `**Changed** — what` (or
  May change / New / Same behaviour, new way), then **Before**, **After**, **When** as
  short paragraphs when given, then **Affects** as a list where each name is a command link
  that opens the call site (the caller row's "Open caller"), then the engine's verdict
  sentence in italics, then "Written by your agent; the facts come from the engine." Nothing
  the agent did not say is added, and an `affects` name the engine does not know is left
  out, as `agent-cards.js` already does.
- Threads are made when a review diff opens and a result for the shown head exists, rebuilt
  on a new analysis or result, and disposed on Undo or when the result no longer fits the
  branch (the stale case of `agent-cards.js`); a thread never outlives the result it came
  from. The pattern is `review-comments.js`.
- Expansion as G16 decides. With the proposal: expanded for a change in the attention set
  (G15), collapsed otherwise; the CodeLens agent line (`agent-notes.js`) is removed for
  changes that have a thread.
- Thread title actions: **Mark reviewed** (the row's tick), **Reply in next round** (a
  feedback draft at that line, F1; local reviews and checked-out pull requests only), and,
  for a pull request under review, **Post to the PR** (the existing review-comment path,
  with the note's text prefilled for editing; never automatic). Local reviews have no
  Post.
- The Comments panel lists the notes under the controller's label; the Changes rows and
  Details keep the agent's one line (step 2 of Part AI) so the tree and the diff agree.
- Tests: placement per change on the hono e2e fixture (range, side, body text recorded as
  a characterization); rebuild and dispose on result change, Undo and a stale result; no
  commenting ranges offered; each action wired; nothing posted by any path a test can
  reach without the explicit Post action.

Owner check: U8's usability walk, repeated after L1–L3 with the one question "what do you
look at first?", on the same t3code PR; repeated after L4 and L6 with an agent result.

## Order, and changes to `RELEASE_PLAN.md`

`RELEASE_PLAN.md` runs C → B → A → U → R, with U after A0. Proposed:

1. **P1–P5** right after C. Cheap, independent, and it's what confuses users now. P2
   replaces U3; P5 is U7; P4 absorbs U6. Needs G8 and G9 first.
2. ~~S1~~ dropped.
3. **F1–F5** (feedback rounds), ahead of B. Replaces A1–A2.
4. **W1–W2**, then **E1** and **I1**. Needs G11 and G12.
5. **B** (review loop part 2), the rest of U (U2 rows, U4, U5, U8), then R.

S2 is optional and can drop out of v1.

**v1 scope (decided 2026-10-24, owner).** v1 ships what is merged on `main` (P1–P5,
F1–F5, B1–B5, the PR-tab work), with no new features before release. W1–W2, I1 (with
A4) and S2 come after v1. E1 moves to the version that adds the AI integration and MCP
server.

**Minimal pass (2026-10-24, owner).** After reviewing several PRs and agent runs, the owner
used only Details' progress bar. So:
- The Changes title bar keeps only Refresh, the tree/list toggle and the submit action
  (Submit review…, or Send feedback while drafts exist). Filters, Previous/Next unreviewed
  and the legend move to the `…` menu. This undoes P4's legend icon in the title bar.
- Details keeps the progress strip (bar, reviewed count, attention count), the row's name
  and path, the verdict sentence for red/amber rows only, and a Preview's limits note with
  Check out and analyse. Removed: the origin header, percentage, source line, signatures,
  new throws, callers table, tests line, Threads section, Feedback button, and the Mark
  reviewed / Next unreviewed / Show callers / Compute test reachability buttons. This
  undoes P4's Details link and button and F1's 💬 in Details; each action stays in the
  tree, its context menu, the keyboard or the diff. The callers' 💬 moved to **Comment on
  this call** on a direct caller row's context menu (PR review comment, else feedback draft).

**Review view merged (2026-10-29, owner).** The Changes view is folded into the Review view:
the review nests under the pull request or mode it came from, and the title-bar controls
above moved onto that row. The review tab (U1) and the agent's behaviour review are behind
`impactTree.cards.enabled` and `impactTree.agents.enabled`.

**Part L (proposed 2026-10-30; G13 and G14 decided the same day; L1 merged as PR #108,
L2 as #109, L5 as #110 and L3 as #111, all 2026-10-30; L4 revised and L6 proposed the same
day after a second screenshot; L4 no longer waits for W1 and runs next, then L6; G15 and
G16 decided as proposed the same day; the editor walk on the t3code PR is the owner's next check).** L1–L3 and L5 fix what the screenshot study found and
touch only the sidebar's shape and words, so they can run next, before W1, once G13 and
G14 are decided; L4 waits for W1. If v1 ships first, L1–L3 go in the first release after
it, ahead of W1–W2.

If the owner agrees, `RELEASE_PLAN.md` gets a short note pointing here and its U section
is updated to say which tasks moved; nothing in C or R changes.
