---
name: unstuck
description: Drive a stuck kanban issue all the way to master. Diagnose why the agent stopped, answer pending questions, run the agent to commit, then merge via the kanban endpoint and verify master actually advanced.
---

# /unstuck N

You are unblocking issue `#N` and landing it on `master`. Be persistent. Only abort if the work is genuinely infeasible (truly broken branch, unsolvable conflict, missing prerequisites) — never abort just because the agent asked a question.

## Step 0 — Before launching MORE than one workspace in a batch

**Gate:** if you're about to start ≥2 workspaces in parallel, list the files each ticket will likely touch. If any two share a file, **STOP** and consolidate them into a single combined ticket or sequence them. Parallel branches editing the same component never merge cleanly — agents refactor differently, structural conflicts pile up, and you burn more time rebasing than you saved on parallelism.

Cheap prediction methods:
- Grep ticket descriptions / titles for file paths and component names — overlap is usually obvious (e.g. all five "AgentQuestionsPanel: …" titles touch one file).
- If the ticket has a `## Files touched` section (preferred — see `kanban-workflow` skill), trust it.
- If neither yields a confident answer, call `POST /api/issues/:id/analyze-touched-files` (per the analyze-dependencies pattern) for a Haiku-cheap prediction.

When in doubt, sequence > parallelize. Single-component refactors are almost always one workspace, not five.

## Step 1 — Diagnose

```bash
pnpm cli -- issue status N
```

Read the workspace status, session status, last agent message. Then fetch the latest session output to capture any structured `permission_denials[*].tool_name === "AskUserQuestion"` payload:

```powershell
$proj = "d28f01c9-3fd3-488b-9eb4-d66268c4f7d4"  # or GET /api/preferences/active-project
$issues = Invoke-RestMethod "http://127.0.0.1:3001/api/issues?projectId=$proj"
$issue = $issues | Where-Object { $_.issueNumber -eq N } | Select-Object -First 1
$ws = Invoke-RestMethod "http://127.0.0.1:3001/api/issues/$($issue.id)/workspaces"
$wsId = $ws[0].id
$sessions = Invoke-RestMethod "http://127.0.0.1:3001/api/workspaces/$wsId/sessions"
$sid = $sessions[0].id
$out = Invoke-RestMethod "http://127.0.0.1:3001/api/sessions/$sid/output"
# inspect last `type:result` event for permission_denials + result text
```

Classify the stuck reason:

| Symptom | Treatment |
|---|---|
| `ws=idle`, `sess=completed`, agent asked plain-text question | Answer via `/turn`, see Step 2 |
| `ws=idle`, agent has `permission_denials[*].AskUserQuestion` | Pick best option per question, answer via `/turn` |
| `ws=active`, `sess=running`, age >5min, no recent output | Nudge: "Please continue with the task..." |
| `sess=running/stopped`, provider transcript is ~1s with 0 tokens or no assistant output | Treat as launch failure/stale board state: stop the workspace session, do not wait longer, and inspect/rebuild the branch manually in the worktree |
| `ws=reviewing`, `sess=stopped` | Skip to Step 4 (merge) |
| `ws=closed`, already merged in kanban | Verify master, jump to Step 5 |
| Worktree gone, no commit on branch | ABORT — surface to user |

## Step 2 — Answer the question

Be a decisive proxy. The agent usually offers a recommendation — accept it unless it conflicts with `CLAUDE.md` scope constraints. Prefer behavior-preserving choices, prefer single PR over staged delivery, prefer extending existing test harnesses, prefer narrower scope.

**Critical:** the turn endpoint takes `content`, NOT `message`. This is a recurring mistake.

```powershell
$body = @{ content = "Approved. Proceed with your recommendation. Goal: land on master. After implementation: run tsc -b --noEmit (server+client), commit on current branch, then mark workspace ready for merge — the kanban merge endpoint handles the rest. Don't expand scope." } | ConvertTo-Json
Invoke-RestMethod "http://127.0.0.1:3001/api/workspaces/$wsId/turn" -Method Post -Body $body -ContentType "application/json"
```

## Step 3 — Wait for the agent to finish

Poll the workspace status with a background `until` loop — don't busy-wait, don't ScheduleWakeup every minute (the Stop hook will hammer you):

```bash
until curl -s "http://127.0.0.1:3001/api/workspaces/$WSID" 2>/dev/null \
    | grep -q '"status":"idle"\|"status":"ready_for_merge"\|"status":"reviewing"\|"status":"closed"'; do
    sleep 10
done
echo "WORKSPACE LEFT ACTIVE"
```

Run this via Bash `run_in_background: true`. You get a single notification when the workspace flips out of `active`. Refactors of large files can take 10–15 minutes — don't panic, don't kill it.

Do not stack synchronous `Start-Sleep 120/180/240` loops; if a session has no provider output after one check, inspect the session transcript before waiting again.

When the notification fires, re-run `pnpm cli -- issue status N`. If the agent asked another question, loop back to Step 2. If it completed cleanly with a commit, go to Step 4.

## Step 3.5 — Check the feature branch is on current master

A workspace created hours/days ago is based on whatever `master` was *then*. Before merging, check that the branch is up to date — otherwise the merge will revert master's recent commits.

```bash
git -C "C:/andrena/.worktrees/<branch>" log master..HEAD --oneline
git -C "C:/andrena/.worktrees/<branch>" diff --stat master..HEAD | tail -5
```

If the diff stat shows many removals of files you know are on master (e.g. `-1257` lines on `workspace.service.ts` that you saw landed in #32), the branch is stale. Rebase before merging.

**Rebase directly in the worktree** — NOT via `/update-base`. The kanban rebase endpoint prefers `origin/<base>` over local `<base>` (see `rebaseOntoBase` in `packages/shared/src/lib/git-service.ts:489`). Since recent commits often live only on **local master** (we advance with `git update-ref` and never push), `origin/master` is stale and `/update-base` becomes a no-op:

```bash
cd "C:/andrena/.worktrees/<branch>" && git rebase master
```

The worktree is safe to mutate — the DB-corruption ban in CLAUDE.md only applies to git operations in the **main checkout** while the server is running. Worktrees have their own working tree and don't touch the main checkout's SQLite files. If the rebase conflicts, abort and use the kanban `/fix-and-merge` endpoint as usual.

After a successful rebase, re-check `master..HEAD` shows only the intended feature commit(s).

## Step 4 — Merge via the kanban endpoint

Before calling `/merge`, the main checkout must be **clean of uncommitted tracked changes** AND HEAD must be on `master` (the project's defaultBranch). Two pitfalls:

1. **Uncommitted tracked changes** (e.g. `.claude/scheduled_tasks.lock`) → endpoint returns 409 with "Cannot merge: the main checkout has N uncommitted tracked change(s)". Run `git checkout -- <path>` for runtime files (lock files, build artifacts) or commit/stash anything real.
2. **HEAD on a non-default branch** → the merge endpoint silently writes into HEAD's branch instead of `master` (bug #68) and returns 200 with `mergeOutput: "Already up to date."`. Always check HEAD first:

   ```bash
   git branch --show-current  # must be 'master' before /merge
   ```

   If not on master, switch BEFORE calling /merge (cheaper than the update-ref repair afterwards). The working tree should be the same (just-pulled master + the about-to-merge feature branch's parent), so checkout is usually a near-no-op:
   ```bash
   git checkout master
   ```
   But verify file changes are minimal before doing this — if the current branch has unmerged work, save it first.

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{}' \
    "http://127.0.0.1:3001/api/workspaces/$WSID/merge" \
    --max-time 120 -w "\n[HTTP %{http_code}]\n"
```

- **200** → kanban says merged. Verify in Step 5.
- **409 conflictingFiles** → POST `/fix-and-merge` with `{ "mergeError": "<the error>" }`, then back to Step 3 with the new session. Never resolve conflicts by hand in the main checkout.
- **409 uncommitted changes** → clean as above, retry once.
- **5xx / timeout** → retry once. Still failing → ABORT and surface to user.

## Step 5 — VERIFY master actually moved

The kanban merge endpoint can succeed while master stays at its old tip if the main checkout's HEAD wasn't on master. Always verify:

```bash
git log master --oneline -3
# look for the feature commit; if missing, master did NOT advance
git branch --show-current  # should be master, often isn't
```

If master is stale, the feature commit will be reachable from the current HEAD (typically a synthetic merge commit). Fast-forward master via a **ref-only pointer move** — this does not touch the working tree, so it's safe with the live server holding the SQLite DB open:

```bash
# Find the feature's actual commit (the one with the work):
git log master..HEAD --oneline
# Then advance master to it (or to the synthetic merge if present):
git update-ref refs/heads/master <commit-sha>
```

**NEVER** run `git checkout master && git merge ...` in the main checkout while the server is running — that's the banned manual-merge path (see CLAUDE.md "Why manual merges are banned"). `git update-ref` is the safe pointer-only operation and is the correct tool here.

After advancing master, verify the dev server is still healthy:

```bash
curl -s http://127.0.0.1:3001/health
```

## Step 6 — Confirm

```bash
git log master --oneline -2  # should show the feature commit at master tip (or one below the merge)
pnpm cli -- issue status N    # workspace status: closed, readyForMerge: true
```

Report to the user: commit SHA, branch landing path (clean merge or update-ref repair), any caveats.

## When to abort (and ONLY then)

Abort and surface to the user only if:
- The worktree is gone AND no commit exists on the feature branch — there's literally nothing to merge.
- A `/fix-and-merge` agent stops asking the same conflict question twice in a row — the agent can't resolve it.
- The agent's question requires a substantive product/architecture decision the user must own (e.g. "should we drop feature X?" or "which API should we break?"). Don't fake an answer to these.
- Multiple retries of `/merge` return non-conflict 5xx errors — the merge subsystem itself is broken.

Otherwise: keep going. Answer questions, nudge stuck agents, wait through long refactors. The default is **persistence**.

## Recurring traps

- `/turn` body uses `content`, NOT `message`. Returns 400 "content is required" otherwise.
- Curl on Windows: backslashes in URLs break things; quote URLs single, use forward slashes in paths.
- Workspace `workingDir: null` after the kanban merge is normal — endpoint deletes the worktree.
- `Already up to date` from the merge endpoint usually means the merge happened against the wrong target — go to Step 5 and verify master.
- Don't run `pnpm db:reset` or delete `kanban.db` — the PreToolUse guard will block it.
- **Slash-leading ticket titles** (e.g. "/merge endpoint ...") used to make the agent treat the first prompt line as a slash command and exit in 3s with "Unknown command: /...". Fixed in `workspace-crud.service.ts buildAgentPrompt` (1753a62c), but if you see it recur, rename the ticket via PATCH `/api/issues/:id` to strip the leading slash.
- **Stale `claudeSessionId` → "No conversation found" error.** If a `/turn` lands on a workspace whose previous session aborted before persisting a real claude session id, the resume fails and the new session errors out in seconds. Recover with `POST /api/workspaces/:id/launch` to start fresh.
- **Stale `origin/<base>` defeats `/update-base`.** Local master advances via `git update-ref` never reach the real GitHub remote, so `origin/master` lags. The kanban rebase prefers `origin/<base>` and silently no-ops. Always rebase in the worktree directly (`git -C <worktree> rebase master`) when the branch is behind local master.
