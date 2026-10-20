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
- **G10. Review effort score.** Dropped with S1 (2026-10-20). Was: show a 1–5 effort score in the summary (S1)? If yes, the
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
- **G3 / G4 from `RELEASE_PLAN.md`**: decided 2026-10-20. No per-agent turn hook; feedback
  rounds with a snapshot checkpoint and a feedback file per round instead (Part F).

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

## 1. src/session.js:212 · runAnalysis
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

## Order, and changes to `RELEASE_PLAN.md`

`RELEASE_PLAN.md` runs C → B → A → U → R, with U after A0. Proposed:

1. **P1–P5** right after C. Cheap, independent, and it's what confuses users now. P2
   replaces U3; P5 is U7; P4 absorbs U6. Needs G8 and G9 first.
2. ~~S1~~ dropped.
3. **F1–F5** (feedback rounds), ahead of B. Replaces A1–A2.
4. **W1–W2**, then **E1** and **I1**. Needs G11 and G12.
5. **B** (review loop part 2), the rest of U (U2 rows, U4, U5, U8), then R.

S2 is optional and can drop out of v1.

If the owner agrees, `RELEASE_PLAN.md` gets a short note pointing here and its U section
is updated to say which tasks moved; nothing in C or R changes.
