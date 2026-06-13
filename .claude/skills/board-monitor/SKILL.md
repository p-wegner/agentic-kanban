---
name: board-monitor
description: System-level board health — conflict scan, server/frontend health check. Board operations (relaunch/merge/nudge/auto-start) are handled by the app's built-in monitor (Settings → Workflow → Board Monitoring). Run Sections 1-3 every cycle; only do Section 4 if the app monitor is OFF.
---

You are the board monitor. The app's built-in server-side monitor (`runMonitorCycle` in `server-start.ts`) handles board operations automatically when enabled. Your job is the system-level checks it can't do itself: run Sections 1–3 every cycle; run Section 4 only when `auto_monitor` is `false`.

## SECTION 1 — Conflict marker scan & auto-fix

Scan for `<<<<<<< HEAD` markers injected by tsx hot-reload (exclude this skill's own dir — its SKILL.md contains the literal string):

```bash
grep -rl "<<<<<<< HEAD" packages/server/src/ packages/client/src/ packages/shared/src/ \
  packages/shared/drizzle/meta/_journal.json 2>/dev/null
```

For each file found:
1. Resolve keeping HEAD only:
   ```
   node -e "const fs=require('fs'),f=process.argv[1];let c=fs.readFileSync(f,'utf-8').replace(/\r\n/g,'\n');const r=c.replace(/<<<<<<< HEAD\n([\s\S]*?)\n=======\n[\s\S]*?\n>>>>>>> [^\n]+/g,(_,h)=>h);fs.writeFileSync(f,r.replace(/\n/g,'\r\n'),'utf-8');console.log(f+': fixed');" <file>
   ```
2. If `_journal.json` was fixed, verify valid JSON: `node -e "JSON.parse(require('fs').readFileSync('packages/shared/drizzle/meta/_journal.json','utf-8'));console.log('OK')"`
3. `git add` the fixed files, commit `"fix: resolve tsx hot-reload conflict markers [monitor auto-fix]"`, set `$conflictsFixed = $true`.

## SECTION 2 — Server health check & restart

```powershell
try { Invoke-RestMethod "http://127.0.0.1:3001/health" -TimeoutSec 5 | Out-Null; "UP" } catch { "DOWN" }
```

**If DOWN:**
1. Restart via Bash: `cd packages/server && pnpm dev > /tmp/kanban-monitor-srv.log 2>&1 &`
2. **Poll `/health` until UP — never assume-up after a fixed sleep.** A cold start binds slower than any constant sleep; a blind `Start-Sleep` then single recheck races the bind and makes every REST call this cycle fail with connection-refused. Poll:
   ```powershell
   $up = $false
   foreach ($i in 1..20) {
     Start-Sleep -Seconds 2
     try { Invoke-RestMethod "http://127.0.0.1:3001/health" -TimeoutSec 3 | Out-Null; $up = $true; break } catch {}
   }
   if ($up) { "UP after $($i*2)s" } else { "STILL DOWN after 40s" }
   ```
3. **Only proceed when `$up`.** Still down after the poll → read `/tmp/kanban-monitor-srv.log`, report the error, and **skip Sections 3–4** (don't fire REST at a server that never bound).

**If UP but `$conflictsFixed = $true`:** the tsx watcher may be restarting after the edits — re-run the poll loop (it returns immediately once `/health` answers), then continue.

## SECTION 3 — Frontend smoke check (real render, not just HTTP)

HTTP 200 is not enough: a blank page from a React crash (`ReferenceError`, missing useState) still returns 200. Read rendered DOM:

```powershell
.\scripts\board-monitor\frontend-smoke.ps1 -Url "http://127.0.0.1:5173"
```

- Contains `Todo`, `In Progress`, `No issues`, or `No projects registered` before timeout → **OK**.
- Times out with empty/irrelevant content → app crashed or failed to hydrate (the smoke command already printed console output + rendered snippets). Diagnose:
  1. Vite module errors: `GET http://127.0.0.1:5173/src/routes/BoardPage.tsx` — HTTP 500 = client compile error.
  2. Server watcher log: `tail -20 /tmp/kanban-monitor-srv.log` for `SyntaxError`, `Cannot find`, `error TS`.
  3. Re-run Section 1 (markers may have slipped through).
  4. Check the captured console errors from the timeout output.
  5. Report findings — do not proceed to Section 4 if the server is broken.

## SECTION 4 — Board operations (only if `auto_monitor` is `false`)

When enabled, the app's built-in monitor already handles: idle→relaunch, reviewing→merge, active+stopped→mark_idle, dead process→mark_idle, running>5min→nudge, auto-start with WIP limit, dependency check, branch naming (`feature/ak-{N}-{slug}`), and ghost detection (empty workingDir → delete + reset to In Progress). Run this section manually only when `auto_monitor` is off.

Get the board:
```powershell
$proj = (Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/active-project" -TimeoutSec 10).projectId
if (-not $proj) { throw "Active project is not set" }
$board = Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$proj/board" -TimeoutSec 10
@($board) | Where-Object { $_.name -in @("Backlog","In Progress","In Review") } |
  ForEach-Object { "COLUMN $($_.name): $($_.issues.Count)" }
```

For each issue in `In Progress` / `In Review`, check `workspaceSummary.main`. **The action depends on the column** — `idle` means "continue work" in In Progress but "ready to land" in In Review:

| Column | Workspace status | Session status | Action |
|---|---|---|---|
| **In Review** | `idle` or `active`+`stopped`, committed diff | — | **Merge if prefs allow** — see Auto-merge decision table |
| **In Review** | `reviewing` | `stopped` | **Merge** (if `auto_merge` on): `POST /merge` (60s) — see Merge procedure |
| In Progress | `idle` | any | **Relaunch**: `POST /api/workspaces/:id/launch` |
| any | `reviewing`, workingDir empty | — | **Ghost**: delete workspace, reset issue to In Progress, create fresh |
| In Progress | `active` | `stopped` | Mark idle: `PATCH /api/workspaces/:id` `{"status":"idle"}` |
| In Progress | `active` | `running`, age >5min | **Nudge**: `POST /api/workspaces/:id/turn` `{"content":"Please continue..."}` (field is `content`, not `message`) |
| In Progress | `active` | `running`, age >25min, same `lastAssistantMessage` 2 cycles | **Stop** the loop: `POST /api/workspaces/:id/stop` (graceful; only when diff committed / tree clean), then it falls to the In-Review rule once moved |
| In Progress | `active` | `running`, age ≤5min | Leave — too fresh |

### Auto-merge In Review (configurable)

Two app-owned prefs decide whether the monitor lands not-yet-ready In-Review work — read both every cycle (also in `GET /api/preferences/settings`; unset → defaults):

```powershell
$autoMerge        = (Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/auto_merge" -EA SilentlyContinue).value           # default "true"
$autoMergeInReview = (Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/auto_merge_in_review" -EA SilentlyContinue).value # default "false"
```

For an `In Review` issue whose `main` is `idle` (or `active`+`stopped`) with a committed diff (`diffStats.filesChanged > 0`):

| `auto_merge` | `auto_merge_in_review` | `readyForMerge` | Action |
|---|---|---|---|
| `false` | any | any | **Do nothing** — operator froze merging. Report under "Idle / awaiting". |
| `true` | any | `true` | **Merge** — agent marked it ready. |
| `true` | `true` | `false` | **Merge** — policy lands committed work without the ready gate. |
| `true` | `false` (default) | `false` | **Do nothing** — report under "Idle / awaiting". |

**User override:** if the `/board-monitor` argument asks to merge In-Review work ("merge in review to master", "no human gating"), treat as `auto_merge_in_review=true` for this run regardless of the stored pref, and persist it so the app monitor agrees:
```powershell
Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/settings" -Method Put -ContentType "application/json" -Body '{"auto_merge_in_review":"true"}'
```
Conversely "stop auto-merging review" / "require manual merge" → set it `"false"`.

### Merge procedure (the app owns all merging)

**Never run `git merge`/`cherry-pick`/`rebase`/`checkout`/`reset`/`stash` in the main checkout to land a branch** — that corrupts the DB and abandons half-finished merges (see end note). The endpoints do the same work safely in the worktree. Always this order:

1. **Merge**: `POST /api/workspaces/:id/merge` (90s).
   - **200** → merged. **Verify master advanced** (`git log --oneline -3 master` shows the merge commit — a "merged" response doesn't guarantee code on master) and the issue left In Review (→ Done / AI Reviewed).
   - **409** `conflictingFiles` → `POST /api/workspaces/:id/fix-and-merge` `{"mergeError":"<the 409 body>"}` — launches an agent inside the worktree to rebase/resolve/merge (returns 201 + `sessionId`). Wait for that session, re-check next cycle. Never resolve by hand.
   - **5xx / timeout** → retry once; still failing → check `workingDir` (empty = ghost), else report under "Needs attention". Never fall back to manual git.
2. Never **relaunch** an idle In-Review workspace — its work is already committed; relaunching just restarts whatever loop stopped it.

Two branches that both edit one file (e.g. both append to `CLAUDE.md`) conflict even when neither is wrong; `fix-and-merge` handles these, and for additive changes (docs, tables, lists) the right resolution is **keep both**. Optional pre-merge for a long-lived branch: `POST /api/workspaces/:id/update-base` `{"mode":"rebase"}` (shrinks conflict surface; `POST .../abort-rebase` if it sticks).

This mirrors the app's built-in monitor exactly (`monitor-cycle.ts` reads the same two prefs) — same policy, same gates.

**Auto-start:** if fewer than 3 issues In Progress, start the highest-priority Todo:
```powershell
$slug = ($issue.title -replace '[^a-zA-Z0-9\s]','' -replace '\s+','-').ToLower().Substring(0,[Math]::Min(40,$issue.title.Length))
$branch = "feature/ak-$($issue.issueNumber)-$slug"
# POST /api/workspaces with { issueId, branch }
```

## SECTION 5 — Summary

Write a concise Slack-style summary so someone without board access understands the state at a glance.

```
[monitor] {yyyy-MM-ddTHH:mm}
🟢 Server OK  |  ✅ Merged: N  |  🚀 Started: N  |  🔁 Relaunched: N  |  ⚠️ Conflicts: N

▶ Started:
  • #N  <one-line title, max ~60 chars>
✅ Merged:
  • #N  <one-line title>
🔁 Relaunched / nudged:
  • #N  <one-line title>  (reason: idle / stuck Xmin)
⚠️ Needs attention:
  • #N  <title>  — <what's wrong, e.g. "merge conflicts in Layout.tsx">
💤 Idle / stopped:
  • #N  <title>  — <last agent message, first line, max ~80 chars>
```

Rules:
- Always include ticket number AND a short title (never numbers alone). Strip boilerplate ("E2E: cover", "Add", "Show") to keep the core noun phrase — "#253 Estimate badge on issue cards", not "#253 Show estimate badge on kanban issue cards".
- Omit empty sections; keep the whole summary under ~25 lines.
- For idle/stopped: include the `last:` line from `pnpm cli -- status`. For full context on a stop, `pnpm cli -- issue status <N>`.

## Known patterns & fixes

| Pattern | Symptom | Fix |
|---|---|---|
| **ZAI / glm-5.1** | Session stops immediately, `exitCode: null` | Relaunch every cycle |
| **Ghost workspace** | `status: reviewing`, `workingDir: ""`, merge fails "not something we can merge" | Delete workspace, reset issue to In Progress, create fresh |
| **Merge conflict (409)** | `POST /merge` returns 409 `conflictingFiles` | `POST /fix-and-merge` (resolves in worktree) — never by hand |
| **Merge timeout** | No conflicts but merge times out | Retry once; still failing → "Needs attention", no manual git |
| **tsx conflict injection** | `<<<<<<< HEAD` in .ts/.tsx after a cherry-pick | Section 1 auto-fix; then check if shared needs rebuild (`pnpm --filter @agentic-kanban/shared build`) |
| **React blank page** | HTTP 200 but `main` empty, no console errors | Missing useState — check recent conflict resolutions in BoardPage.tsx |
| **`scheduledRuns` not exported** | Crash: `SyntaxError: does not provide an export named 'scheduledRuns'` | `pnpm --filter @agentic-kanban/shared build` |
| **Active project not set** | "No projects registered" despite projects existing | `GET /api/preferences/active-project`; fix via `PUT /api/preferences` `{"active_project":"<id>"}` |

## Why manual merges are banned

On 2026-05-26 the monitor fell back to manual `git merge`/`checkout`/`reset` in the main checkout and caused two failures: (1) git touched the live SQLite WAL/SHM sidecars the running server held open → `kanban.db` corruption ("disk image is malformed") → full DB reset + data loss; (2) a two-branch `CLAUDE.md` conflict was left with `MERGE_HEAD` + markers at cycle end. Both are impossible if you only ever merge through the app endpoints (`/merge` → `/fix-and-merge`), which operate in the worktree and never leave dangling state.
