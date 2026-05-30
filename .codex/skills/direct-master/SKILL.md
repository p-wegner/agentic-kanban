---
name: direct-master
description: Make a change directly on master in the main checkout, committing aggressively so the working tree never stays dirty and blocks other workspaces from merging
argument-hint: "[short description of the change]"
---

# direct-master

Use this when you're asked to change something **directly on master** in the main checkout (`C:\andrena\agentic-kanban`) — a quick doc fix, a small config tweak, a skill edit — rather than going through a kanban issue + worktree.

## Why aggressive commits matter here

The board's auto-merge **refuses to land an approved workspace if the main checkout has ANY uncommitted tracked change** (see `pitfall_automerge_blocked_dirty_main.md`). A dirty working tree on master is not just your problem — it silently blocks every other workspace from merging. So on master the rule is inverted from a feature branch: **don't batch up a big WIP. Commit and push each logical, working unit the moment it's done, and leave the tree clean between units.**

## Step 1 — Confirm you're on master in the main checkout

```bash
git -C C:/andrena/agentic-kanban rev-parse --abbrev-ref HEAD   # must print: master
git -C C:/andrena/agentic-kanban status --short
```

If you're not on `master` or not in the main checkout, stop — this skill is only for direct main-checkout work.

If the tree is **already dirty** before you start, that pre-existing churn is itself blocking merges. Surface it to the user before adding more — don't bury someone else's uncommitted work under your changes.

## Step 2 — Make the change in small, self-contained units

Break the work so each unit leaves the repo in a working, committable state. Prefer several small commits over one large one. After each unit, immediately go to Step 3 — do not move on to the next unit while the previous one sits uncommitted.

## Step 3 — Commit each unit the moment it works

Stage **only** the files this unit touched (never `git add .` / `git add -A` — that can sweep up `kanban.db-wal`, other agents' artifacts, or unrelated churn):

```bash
git -C C:/andrena/agentic-kanban add <specific files>
git -C C:/andrena/agentic-kanban commit -m "<concise message>"
```

End every commit message with the trailer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Never stage or commit `kanban.db`, `kanban.db-shm`, or `kanban.db-wal`.

## Step 4 — Push immediately

```bash
git -C C:/andrena/agentic-kanban push
```

Push after each commit (or each tight batch). An unpushed master commit doesn't dirty the tree, but pushing promptly keeps worktrees that rebase onto `origin/master` current and avoids a pile-up.

## Step 5 — Verify the tree is clean before you stop

```bash
git -C C:/andrena/agentic-kanban status --short    # must be empty
```

The tree **must** be clean when you finish. If `status` shows anything you created, commit or revert it now. Report the commits you made (short SHAs + messages) and confirm the working tree is clean so auto-merge is unblocked.

## Hard rules

- **Never land a feature branch by hand here.** Manual `git merge` / `cherry-pick` / `rebase` / `reset` / `checkout` in the main checkout to land work is banned — the app owns merging via `POST /api/workspaces/:id/merge`. This skill is for *originating* small changes on master, not for merging branches.
- **Never touch `kanban.db*`** — no reset, no truncate, no staging it. The PreToolUse guard will block destructive db commands; if it fires, stop and ask.
- **Don't expand scope.** A "direct on master" change should be small by definition. If it's growing past a few files or starts to look like a feature, stop and file a kanban issue instead.
