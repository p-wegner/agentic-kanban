---
name: cleanup
description: "Clean up stale agentic-kanban resources including git worktrees, Claude Code sessions, and E2E test artifacts."
argument-hint: "[--worktrees] [--sessions] [--e2e]"
---

# Cleanup Skill

Cleans up stale resources related to the agentic-kanban project:
- Stale git worktrees (closed/merged workspaces whose worktree dirs still exist)
- Stale Claude Code chat sessions (`.claude/projects/` dirs for removed worktrees)
- E2E test data artifacts (leaked issues/projects from Playwright test runs)

By default, spawns a subagent to do the work.

---

## Input

Optional flags in the user's message:
- `--worktrees` — only clean worktrees
- `--sessions` — only clean Claude chat sessions
- `--e2e` — only clean E2E test data
- (no flag) — clean all three

---

## Execution

Spawn a subagent with this prompt (substituting active flags):

```
You are working on the agentic-kanban project at C:\andrena\agentic-kanban.
Server runs at http://localhost:3001. Run the cleanup tasks marked below.

## TASK 1 — Stale git worktrees [always run unless --sessions or --e2e only]

Worktrees live at C:\andrena\.worktrees\.

1. Get all workspaces: GET http://localhost:3001/api/workspaces
   Active = status in (idle, active, reviewing). Others = closed/merged.
2. Run: git -C C:\andrena\agentic-kanban worktree list --porcelain
   Parse each "worktree <path>" line.
3. Skip the main worktree (C:\andrena\agentic-kanban itself).
4. For each non-main worktree path:
   a. If the path doesn't exist on disk → prune only (git worktree prune)
   b. If it exists but has NO matching active workspace → git worktree remove --force <path>
   c. If it exists and HAS an active workspace → leave it alone
5. Run: git -C C:\andrena\agentic-kanban worktree prune
6. Report: N removed, N pruned, N kept.

### TASK 1b — Orphaned worktree DIRECTORIES git no longer tracks (Windows EBUSY residue)

CRITICAL: steps 2–5 above only see worktrees git still tracks. On Windows, `git worktree
remove` routinely prunes its admin entry but the subsequent `rmdir` FAILS on a locked
`node_modules`, leaving the **directory** behind. git no longer lists it, so `git worktree
list` / `git worktree prune` — and therefore steps 2–5 — are blind to it. These orphans
accumulate fast: each carries a ~300–500 MB `node_modules`, and a busy board can leave
300+ of them (~74 GB) silently filling the disk until the server crashes with ENOSPC.

Detect: count `C:\andrena\.worktrees\feature_ak-*` dirs and compare to `git worktree list`
(it'll show ~8 while disk has hundreds). The gap is the orphan set.

Sweep them with the dedicated, idempotent, triple-guarded script (re-derives the active set
from git at runtime, so it can never delete a live worktree):

```powershell
powershell -NoProfile -File C:\andrena\agentic-kanban\scripts\cleanup-orphan-worktrees.ps1
```

The script's guards (all must hold to delete a dir): name matches `feature_ak-*`, NOT in the
live `git worktree list`, and has NO `.git` entry. It uses `cmd /c rd /s /q` — *vastly* faster
than `Remove-Item -Recurse` over node_modules' tens of thousands of tiny files. Re-run it later
to sweep dirs that were locked by a live process at delete time (it's safe to re-run).

## TASK 2 — Stale Claude Code chat sessions [always run unless --worktrees or --e2e only]

Session dirs: C:\Users\pwegner\.claude\projects\

1. List subdirs whose names contain "worktrees" or "feature--ak" or "feature_ak".
2. Decode dir name back to path: replace "--" with "\" and leading "C-" with "C:\"
   e.g. "C--andrena--worktrees-feature_ak-132-..." → "C:\andrena\.worktrees\feature_ak-132-..."
3. For each: if the decoded path does NOT exist on disk → delete the whole session dir.
4. Report: N deleted, N kept.

## TASK 3 — E2E test data [always run unless --worktrees or --sessions only]

Test artifacts are issues/projects created by Playwright tests that leaked into the main project.
Active project ID: 24c4b3f2-bab8-478c-9ce9-5f87478e20b6

1. GET http://localhost:3001/api/projects — delete any project whose name matches:
   - Starts with "e2e-" or "E2E"
   - Matches /^[a-z]{2,4}[0-9a-z]{6,10}$/ (random slug pattern like "mpic1234")
   Keep: the main project (id 24c4b3f2-bab8-478c-9ce9-5f87478e20b6) and named projects.

2. GET issues for main project, delete any whose title matches:
   - Starts with "e2e-", "E2E", "mpib", "mpic", "mpid", "mpie"
   - Matches /^[A-Z][a-z]+ [a-z]+ test [a-z0-9]+$/ (e.g. "Session stats test mpic1234")
   - Matches /^RT \d+ test/ or /ReadyBadge|HoverResume|MdVerify|MarkdownVerify/
   - Contains "⏰ e2e-"
   Use: DELETE http://localhost:3001/api/issues/:id

3. GET http://localhost:3001/api/scheduled-runs (or similar) — delete any scheduled run
   whose name starts with "e2e-".

4. Report: N projects deleted, N issues deleted, N scheduled runs deleted.

## Summary

Print a final summary table:
  Worktrees removed:       N
  Session dirs deleted:    N  
  E2E issues deleted:      N
  E2E projects deleted:    N
```

---

## After subagent completes

Report the summary numbers back to the user.
