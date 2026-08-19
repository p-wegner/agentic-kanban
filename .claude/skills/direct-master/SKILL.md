---
name: direct-master
description: Change master in the main checkout without the board's workspace machinery — from a quick doc fix to implementing full tickets in-session. Covers choosing between four execution modes (main agent direct, subagents on shared master, subagents in worktrees, board workspace) by time criticality, traceability, and context budget; grouping adjacent tickets (including ones pulled forward from Backlog) so the expensive gates run once per group instead of once per ticket; plus the commit discipline (aggressive pathspec commits, tree never left dirty) that keeps auto-merge unblocked.
argument-hint: "[short description of the change]"
---

# direct-master

Use this when you're asked to change something **directly on master** in the main checkout (the repo root) — a quick doc fix, a small config tweak, a skill edit — rather than going through a kanban issue + worktree. It ALSO covers implementing full board tickets outside the board's workspace machinery, e.g. in an interactive session with the user: pick an execution mode first (next section), then apply this skill's commit discipline to whichever agent(s) touch master.

## Choosing the execution mode

Tickets can be implemented four ways. Pick by time criticality, traceability needs, context budget, and file overlap — not by habit:

| Mode | What | Reach for it when |
|---|---|---|
| **1. Main agent, direct** | The orchestrating agent edits master itself | The change is cheap and fully understood — e.g. the orchestrator just wrote the ticket and already knows exactly which lines change. Fastest, zero handoff loss. |
| **2. Subagents on shared master** | Main agent fans tickets out to subagents that edit the ONE main checkout concurrently | Several tickets at once, each sizeable enough to burn real context. Subagents are context management: the orchestrator keeps only the reports. REQUIRES partitioning tickets into waves by file overlap — two agents editing one file corrupts both. |
| **3. Subagents in worktrees** | Each subagent gets an isolated git worktree (Agent tool `isolation: "worktree"`) | Same as mode 2 but the tickets' file sets overlap, the work is experimental, or a half-done state on master would be harmful. Isolation costs a landing step per ticket. |
| **4. Board workspace** | Agent triggers `POST /api/workspaces` per ticket — or per GROUP: pass `memberIssueIds` to run N coupled tickets in one workspace (#661), which is this skill's grouping discipline made board-native (one review + one gate per group, commits still per ticket) | Time is NOT critical and traceability/safety matter most: full transcript, review gate, merge preflight, recoverable by monitors. Slowest path — worktree + agent launch + review cycle per ticket/group. |

Rules of thumb: board = slow but safe and best traceable; worktree subagents next-safest; shared-master subagents when file sets are provably disjoint and speed matters; direct only for changes the main agent can hold entirely in its head. Escalate one level whenever you're unsure — and de-escalate consciously, never by default.

**Mode 2 operating rules** (shared checkout, concurrent writers):
- Partition by file overlap BEFORE launching: agents in the same wave must have disjoint file sets. Overlapping tickets run in later waves, sequentially.
- Every agent commits **by pathspec, never via the shared index**: `git commit -F msg.txt -- <exact paths>` (new files: targeted `git add <path>` first). Never `git add -A`/`-a`/`.`, never `git reset`. On `index.lock` contention: wait and retry. (Same rule as the root CLAUDE.md "Several agents committing in ONE checkout" section — it exists because a swept-index commit already happened once.)
- Give each agent its allowed file list explicitly and forbid everything else.
- Orchestrator verifies BETWEEN waves: typecheck + targeted tests on the combined result, before the next wave builds on it.
- Reflect state on the board: move tickets In Progress at launch, Done only after the orchestrator has verified the commit (never on the subagent's word alone).

**Mode 3 landing rule:** a scratch worktree's branch is landed by the orchestrator with a rebase onto master + `git merge --ff-only` (or by re-applying the diff on master). This does NOT contradict the "never land a feature branch by hand" rule below — that rule protects **board-owned `feature/ak-<N>` branches**, whose merging the app owns. An orchestrator scratch branch was never the board's to merge. Prefer mode 4 outright if you find yourself wanting review gates on the landing.

## Group tickets so the gates run once per GROUP

The dominant cost of landing tickets this way is not writing the code — it is re-running
the same expensive gates for each ticket. Measured in this repo: `pnpm check:arch` ~1 min,
the full client suite ~35–95 s, a full `pnpm typecheck` ~30–60 s, and `pnpm test:mine`
26–42 min. Eight tickets landed one-at-a-time pay all of that eight times over, and the
runs are near-identical because the tickets touch the same packages.

So when you have several tickets in hand — including ones still sitting in **Backlog** —
**batch them into groups that share a gate surface, and run the full gates once per group.**
Pulling an adjacent backlog ticket forward into a group you are already paying for is close
to free; leaving it for its own pass costs a whole gate cycle later.

**Commit granularity and gate granularity are different decisions.** Keep commits per
ticket (traceability, clean revert, honest messages) and run the expensive gates per group.
Grouping the gates NEVER means holding uncommitted work — see the dirty-tree rule below.

**Build a group from tickets that share a blast radius:**

| Group by | Because |
|---|---|
| Same package (`client`-only, `server`-only, docs/skills-only) | One suite covers the group; a client-only group never needs the server suite. |
| Same gate needs | A `shared/` change forces a `shared/dist` rebuild + full typecheck across packages; don't hide one inside a client-only group. |
| Overlapping files | Two tickets touching one file MUST be in the same group and done sequentially — split across groups, the second group re-validates the first anyway. |

Keep a group to what you can still debug as a unit — roughly 3–6 tickets, or fewer if any
is behaviour-changing rather than mechanical.

**Per-ticket you still get a safety net for free:** the PostToolUse hook typechecks on every
edit, so a broken ticket surfaces immediately, not at group end. That is exactly what makes
deferring the *expensive* gates safe.

**Sequence for a group:**
1. Implement ticket A → commit A (pathspec) → implement ticket B → commit B → …
2. Run the full gates ONCE for the group: `pnpm check:arch`, the relevant suite(s), `pnpm typecheck`.
3. Green → close all the group's tickets with evidence, naming the shared gate run.
4. Red → the per-ticket commits are what make this cheap: the failure is attributable by
   inspection, and you fix FORWARD with another commit. Never uncommit to isolate.

**Don't group when** a ticket changes behaviour in a way you want isolated evidence for, when
it touches a migration or the DB, or when it's the first use of a new pattern. Land those
alone and say so — an isolated gate run is the evidence.

**Report honestly.** A group's evidence line must name the group: "gates run once for
#514/#515/#516 (client-only)" — never imply each ticket got its own verification when it
did not.

## Why aggressive commits matter here

The board's auto-merge **refuses to land an approved workspace if the main checkout has ANY uncommitted tracked change** (see `pitfall_automerge_blocked_dirty_main.md`). A dirty working tree on master is not just your problem — it silently blocks every other workspace from merging. So on master the rule is inverted from a feature branch: **don't batch up a big WIP. Commit and push each logical, working unit the moment it's done, and leave the tree clean between units.**

## Step 1 — Confirm you're on master in the main checkout

```bash
git -C "$(git rev-parse --show-toplevel)" rev-parse --abbrev-ref HEAD   # must print: master
git -C "$(git rev-parse --show-toplevel)" status --short
```

If you're not on `master` or not in the main checkout, stop — this skill is only for direct main-checkout work.

If the tree is **already dirty** before you start, that pre-existing churn is itself blocking merges. Surface it to the user before adding more — don't bury someone else's uncommitted work under your changes.

## Step 2 — Make the change in small, self-contained units

Break the work so each unit leaves the repo in a working, committable state. Prefer several small commits over one large one. After each unit, immediately go to Step 3 — do not move on to the next unit while the previous one sits uncommitted.

This holds unchanged when you are batching tickets: grouping defers the **gates**, never the
**commits**. Each ticket in a group is committed as it lands, so the tree is clean between
tickets and the group's shared gate run happens on top of committed work.

## Step 3 — Commit each unit the moment it works

Stage **only** the files this unit touched (never `git add .` / `git add -A` — that can sweep up `kanban.db-wal`, other agents' artifacts, or unrelated churn). If ANY other agent may be working in this checkout (mode 2, or a Conductor/builder active), skip the index entirely and commit by pathspec:

```bash
git -C "$(git rev-parse --show-toplevel)" commit -F msg.txt -- <specific files>
```

Solo in the checkout, plain staging is fine:

```bash
git -C "$(git rev-parse --show-toplevel)" add <specific files>
git -C "$(git rev-parse --show-toplevel)" commit -m "<concise message>"
```

End every commit message with the current model's co-author trailer, e.g.:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

Never stage or commit `kanban.db`, `kanban.db-shm`, or `kanban.db-wal`.

## Step 4 — Push immediately

```bash
git -C "$(git rev-parse --show-toplevel)" push
```

Push after each commit (or each tight batch). An unpushed master commit doesn't dirty the tree, but pushing promptly keeps worktrees that rebase onto `origin/master` current and avoids a pile-up.

## Step 5 — Verify the tree is clean before you stop

```bash
git -C "$(git rev-parse --show-toplevel)" status --short    # must be empty
```

The tree **must** be clean when you finish. If `status` shows anything you created, commit or revert it now. Report the commits you made (short SHAs + messages) and confirm the working tree is clean so auto-merge is unblocked.

## Hard rules

- **Never land a feature branch by hand here.** Manual `git merge` / `cherry-pick` / `rebase` / `reset` / `checkout` in the main checkout to land work is banned — the app owns merging via `POST /api/workspaces/:id/merge`. This skill is for *originating* small changes on master, not for merging branches.
- **Never touch `kanban.db*`** — no reset, no truncate, no staging it. The PreToolUse guard will block destructive db commands; if it fires, stop and ask.
- **Don't expand scope.** In mode 1 a "direct on master" change should be small by definition — if it's growing past a few files or starts to look like a feature, stop and file a kanban issue (or escalate to mode 2/3/4 for an existing ticket). In the subagent modes, scope discipline is per ticket: each agent stays inside its ticket's file list, and anything discovered outside it gets filed, not fixed inline.
