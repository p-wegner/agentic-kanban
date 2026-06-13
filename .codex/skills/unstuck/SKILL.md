---
name: unstuck
description: Drive a stuck kanban issue all the way to master. Diagnose why the agent stopped, answer pending questions, run the agent to commit, then merge via the kanban endpoint and verify master actually advanced.
---

# /unstuck N

Unblock issue `#N` and land it on `master`. Be persistent — abort only if the work is genuinely infeasible (broken branch, unsolvable conflict, missing prerequisites), never just because the agent asked a question.

## Step 0 — Before launching ≥2 workspaces in a batch

**Gate:** if you're about to start ≥2 workspaces in parallel, list the files each ticket will touch. Any two sharing a file → **STOP** and consolidate into one ticket or sequence them. Parallel branches editing the same component never merge cleanly — agents refactor differently and you burn more time rebasing than you saved. Cheap prediction:
- Grep ticket descriptions/titles for file paths and component names (e.g. five "AgentQuestionsPanel: …" titles all touch one file).
- A `## Files touched` section (see `kanban-workflow`) — trust it.
- Else `POST /api/issues/:id/analyze-touched-files` (Haiku-cheap).

When in doubt, sequence > parallelize. Single-component refactors are one workspace, not five.

## Step 1 — Diagnose

```bash
pnpm cli -- issue status N
```

Read workspace status, session status, last agent message. Then fetch session output for any `permission_denials[*].tool_name === "AskUserQuestion"` payload:

```powershell
$proj = (Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/active-project").projectId
$issues = Invoke-RestMethod "http://127.0.0.1:3001/api/issues?projectId=$proj"
$issue = $issues | Where-Object { $_.issueNumber -eq N } | Select-Object -First 1
$ws = Invoke-RestMethod "http://127.0.0.1:3001/api/issues/$($issue.id)/workspaces"
$sessions = Invoke-RestMethod "http://127.0.0.1:3001/api/workspaces/$($ws[0].id)/sessions"
$out = Invoke-RestMethod "http://127.0.0.1:3001/api/sessions/$($sessions[0].id)/output"
# inspect last type:result event for permission_denials + result text
```

Classify:

| Symptom | Treatment |
|---|---|
| `ws=idle`, `sess=completed`, plain-text question | Answer via `/turn` (Step 2) |
| `ws=idle`, `permission_denials[*].AskUserQuestion` | Pick best option per question, answer via `/turn` |
| `ws=active`, `sess=running`, age >5min, no recent output | Nudge: "Please continue with the task..." |
| `sess=running/stopped`, transcript ~1s with 0 tokens / no assistant output | Launch failure/stale: stop the session, don't wait, inspect/rebuild the branch in the worktree |
| `ws=reviewing`, `sess=stopped` | Skip to Step 4 (merge) |
| `ws=closed`, already merged in kanban | Verify master, jump to Step 5 |
| Worktree gone, no commit on branch | ABORT — surface to user |

## Step 2 — Answer the question

Be a decisive proxy. The agent usually offers a recommendation — accept it unless it conflicts with `CLAUDE.md` scope constraints. Prefer behavior-preserving choices, single PR over staged delivery, extending existing test harnesses, narrower scope.

**The `/turn` endpoint takes `content`, NOT `message`** (400 "content is required" otherwise) — recurring mistake.

```powershell
$body = @{ content = "Approved. Proceed with your recommendation. Goal: land on master. After implementation: run tsc -b --noEmit (server+client), commit on current branch, then mark workspace ready for merge — the kanban merge endpoint handles the rest. Don't expand scope." } | ConvertTo-Json
Invoke-RestMethod "http://127.0.0.1:3001/api/workspaces/$wsId/turn" -Method Post -Body $body -ContentType "application/json"
```

## Step 3 — Wait for the agent to finish

Poll with a background `until` loop — don't busy-wait, don't ScheduleWakeup every minute (the Stop hook will hammer you):

```bash
until curl -s "http://127.0.0.1:3001/api/workspaces/$WSID" 2>/dev/null \
    | grep -q '"status":"idle"\|"status":"ready_for_merge"\|"status":"reviewing"\|"status":"closed"'; do
    sleep 10
done
echo "WORKSPACE LEFT ACTIVE"
```

Run via Bash `run_in_background: true` — you get one notification when the workspace flips out of `active`. Large-file refactors take 10–15 min; don't panic or kill it. Don't stack synchronous `Start-Sleep 120/180/240` loops; if a session has no provider output after one check, inspect the transcript before waiting again. When the notification fires, re-run `pnpm cli -- issue status N`: another question → back to Step 2; clean commit → Step 4.

## Step 3.5 — Check the branch is on current master

A workspace created hours/days ago is based on the `master` of *then*. Verify before merging or the merge reverts master's recent commits:

```bash
git -C "C:/andrena/.worktrees/<branch>" log master..HEAD --oneline
git -C "C:/andrena/.worktrees/<branch>" diff --stat master..HEAD | tail -5
```

If the diff stat removes files you know are on master (e.g. `-1257` on `workspace.service.ts` from #32), the branch is stale — rebase first. **Rebase directly in the worktree, NOT via `/update-base`:** the kanban rebase endpoint prefers `origin/<base>` over local `<base>` (`rebaseOntoBase`, `packages/shared/src/lib/git-service.ts:489`), but recent commits often live only on **local master** (we advance via `git update-ref`, never push), so `origin/master` is stale and `/update-base` no-ops.

```bash
cd "C:/andrena/.worktrees/<branch>" && git rebase master
```

The worktree is safe to mutate — the DB-corruption ban applies only to git in the **main checkout** while the server runs; worktrees have their own working tree and don't touch the main checkout's SQLite files. Rebase conflicts → abort and use `/fix-and-merge`. After a clean rebase, re-check `master..HEAD` shows only the intended commit(s).

## Step 4 — Merge via the kanban endpoint

Before `/merge`, the main checkout must be **clean of uncommitted tracked changes** AND HEAD on `master` (the defaultBranch):

1. **Uncommitted tracked changes** (e.g. `.claude/scheduled_tasks.lock`) → 409 "Cannot merge: the main checkout has N uncommitted tracked change(s)". `git checkout -- <path>` for runtime/build files, or commit/stash anything real.
2. **HEAD on a non-default branch** → the endpoint silently writes into HEAD's branch instead of `master` (bug #68) and returns 200 with `mergeOutput: "Already up to date."`. Check first — `git branch --show-current` must be `master`. If not, `git checkout master` BEFORE `/merge` (cheaper than the update-ref repair); the working tree is usually a near-no-op, but verify changes are minimal first and save any unmerged work.

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{}' \
    "http://127.0.0.1:3001/api/workspaces/$WSID/merge" --max-time 120 -w "\n[HTTP %{http_code}]\n"
```

- **200** → kanban says merged. Verify in Step 5.
- **409 conflictingFiles** → `POST /fix-and-merge` `{"mergeError":"<the error>"}`, then back to Step 3 with the new session. Never resolve conflicts by hand in the main checkout.
- **409 uncommitted changes** → clean as above, retry once.
- **5xx / timeout** → retry once; still failing → ABORT and surface to user.

## Step 5 — VERIFY master actually moved

The merge endpoint can succeed while master stays at its old tip (if HEAD wasn't on master). Always:

```bash
git log master --oneline -3       # look for the feature commit; if missing, master did NOT advance
git branch --show-current         # should be master, often isn't
```

If master is stale, the feature commit is reachable from current HEAD (usually a synthetic merge commit). Fast-forward master via a **ref-only pointer move** — doesn't touch the working tree, safe with the live server holding the DB open:

```bash
git log master..HEAD --oneline          # find the feature's actual commit
git update-ref refs/heads/master <commit-sha>
```

**NEVER** `git checkout master && git merge ...` in the main checkout while the server runs — that's the banned manual-merge path (CLAUDE.md "Why manual merges are banned"). `git update-ref` is the safe pointer-only operation. Then confirm the server is healthy: `curl -s http://127.0.0.1:3001/health`.

## Step 6 — Confirm

```bash
git log master --oneline -2   # feature commit at master tip (or one below the merge)
pnpm cli -- issue status N    # workspace: closed, readyForMerge: true
```

Report to the user: commit SHA, landing path (clean merge or update-ref repair), any caveats.

## When to abort (and ONLY then)

- The worktree is gone AND no commit exists on the branch — nothing to merge.
- A `/fix-and-merge` agent asks the same conflict question twice in a row — it can't resolve it.
- The agent's question needs a substantive product/architecture decision the user must own ("should we drop feature X?", "which API should we break?"). Don't fake these.
- Multiple `/merge` retries return non-conflict 5xx — the merge subsystem itself is broken.

Otherwise keep going. The default is **persistence**.

## Recurring traps

- Curl on Windows: backslashes in URLs break things; single-quote URLs, forward slashes in paths.
- Workspace `workingDir: null` after a kanban merge is normal — the endpoint deletes the worktree.
- `Already up to date` from `/merge` usually means it merged against the wrong target — go to Step 5 and verify master.
- Don't run `pnpm db:reset` or delete `kanban.db` — the PreToolUse guard blocks it.
- **Slash-leading ticket titles** ("/merge endpoint …") used to make the agent treat line 1 as a slash command and exit in 3s with "Unknown command". Fixed in `workspace-crud.service.ts buildAgentPrompt` (1753a62c); if it recurs, PATCH `/api/issues/:id` to strip the leading slash.
- **Stale `claudeSessionId` → "No conversation found".** A `/turn` on a workspace whose previous session aborted before persisting a real session id fails the resume and errors out in seconds. Recover with `POST /api/workspaces/:id/launch` (fresh session).
