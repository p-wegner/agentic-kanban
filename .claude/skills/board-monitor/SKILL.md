---
name: board-monitor
description: System-level board health — conflict scan, server/frontend health check. Board operations (relaunch/merge/nudge/auto-start) are handled by the app's built-in monitor (Settings → Workflow → Board Monitoring). Run Sections 1-3 every cycle; only do Section 4 if the app monitor is OFF.
---

You are the board monitor. The app has a built-in server-side monitor (`runMonitorCycle` in `server-start.ts`) that handles board operations automatically when enabled. Your job is the system-level checks it cannot do itself.

---

## SECTION 1 — Conflict marker scan & auto-fix

Scan for `<<<<<<< HEAD` conflict markers injected by tsx hot-reload. Exclude `.claude/skills/board-monitor/` (SKILL.md itself contains the literal string as documentation).

```bash
grep -rl "<<<<<<< HEAD" packages/server/src/ packages/client/src/ packages/shared/src/ \
  packages/shared/drizzle/meta/_journal.json 2>/dev/null
```

If any files found:
1. For each file, resolve keeping HEAD only:
   ```
   node -e "const fs=require('fs'),f=process.argv[1];let c=fs.readFileSync(f,'utf-8').replace(/\r\n/g,'\n');const r=c.replace(/<<<<<<< HEAD\n([\s\S]*?)\n=======\n[\s\S]*?\n>>>>>>> [^\n]+/g,(_,h)=>h);fs.writeFileSync(f,r.replace(/\n/g,'\r\n'),'utf-8');console.log(f+': fixed');" <file>
   ```
2. If `_journal.json` was fixed: verify valid JSON — `node -e "JSON.parse(require('fs').readFileSync('packages/shared/drizzle/meta/_journal.json','utf-8'));console.log('OK')"`
3. `git add` all fixed files, commit `"fix: resolve tsx hot-reload conflict markers [monitor auto-fix]"`
4. Set `$conflictsFixed = $true`

---

## SECTION 2 — Server health check & restart

```powershell
try { Invoke-RestMethod "http://localhost:3001/health" -TimeoutSec 5 | Out-Null; "UP" } catch { "DOWN" }
```

**If DOWN:**
1. Restart via Bash: `cd packages/server && pnpm dev > /tmp/kanban-monitor-srv.log 2>&1 &`
2. Wait 15s, recheck
3. If still down: read `/tmp/kanban-monitor-srv.log`, report error, skip Sections 3 and 4

**If UP but `$conflictsFixed = $true`:** wait 5s and recheck — tsx watcher may be restarting after file changes.

---

## SECTION 3 — Frontend smoke check (real render, not just HTTP)

**Why HTTP 200 is not enough:** A blank page from a React crash (e.g. `ReferenceError`, missing useState) still returns 200. The real check reads rendered DOM content.

```bash
playwright-cli open http://localhost:5173
# wait 4 seconds for React to hydrate
sleep 4
playwright-cli eval "document.querySelector('main')?.innerText?.substring(0,200)"
playwright-cli close
```

**Interpret result:**
- Contains `Todo`, `In Progress`, or `No projects` → **OK**
- Empty or missing → app crashed. Diagnose:
  1. Check Vite module errors: `GET http://localhost:5173/src/routes/BoardPage.tsx` — HTTP 500 = compile error in client source
  2. Check server watcher log: `tail -20 /tmp/kanban-monitor-srv.log` for `SyntaxError`, `Cannot find`, `error TS`
  3. Re-run Section 1 scan (conflict markers may have slipped through)
  4. Check console errors: `playwright-cli console`
  5. Report findings — do not proceed to Section 4 if server is broken

---

## SECTION 4 — Board operations (only if app monitor is OFF)

The app's built-in monitor handles: idle→relaunch, reviewing→merge, active+stopped→mark_idle, dead process→mark_idle, running>5min→nudge (with smart re-nudge check), auto-start with WIP limit, dependency check, branch name generation (`feature/ak-{N}-{slug}`), and ghost workspace detection (empty workingDir → delete + reset to In Progress).

**Only run this section manually if `auto_monitor` preference is `false`.**

### Completion-first priority

**Goal: close tickets, not open new ones.** Process columns in this exact order:

1. **In Review** → merge or unblock first. These are closest to Done.
2. **In Progress (idle/stuck)** → relaunch or escalate. Agents already did work — salvage it.
3. **In Progress (active, running)** → nudge if stuck, leave alone if fresh.
4. **Auto-start new work** → only after everything above is handled and WIP allows.

Never start new work while reviews or idle agents are piling up.

### Stuck-review escalation

Track consecutive cycles a workspace stays stuck. Use a simple counter stored in the agent prompt context (re-read board state each cycle to detect staleness).

| Stuck cycles | Action |
|---|---|
| 1 cycle | Normal: relaunch idle or merge reviewing |
| 2 cycles | Re-merge or re-relaunch with a follow-up turn: `POST /api/workspaces/:id/turn` with `"Please finish now — summarize what you have and commit."` |
| 3+ cycles | **Escalate**: spawn a subagent (Agent tool, `general-purpose` type) to investigate the session and resolve it. See escalation protocol below. |

**Escalation protocol (3+ cycles stuck):**
Spawn a subagent with this prompt structure:
```
Investigate kanban workspace <wsId> for issue #<N> "<title>".

The workspace has been stuck for <X> consecutive monitor cycles.
Current state: workspace status=<status>, session status=<sessionStatus>.

Steps:
1. Read the session output: GET http://localhost:3001/api/sessions/<sessionId>/output
2. Read the diff: GET http://localhost:3001/api/workspaces/<wsId>/diff
3. Determine why it's stuck (merge conflict? agent error? incomplete work? ghost workspace?)
4. Take the appropriate action:
   - If the diff has real, complete changes: manually merge the branch to master, then DELETE the workspace and move the issue to Done
   - If the diff is empty or broken: DELETE the workspace, move the issue back to Todo
   - If there's a merge conflict: resolve it on the feature branch, commit, then retry the merge
   - If the agent left unfinished work: commit what exists, merge if it's safe, otherwise move back to Todo
5. Report what you found and what you did

Use `curl` for API calls. For git operations, work in the worktree directory.
```

The subagent has full autonomy to resolve the stuck state — merge, delete, move, or fix.

Get the board:
```powershell
$proj = "<active-project-id>"  # read from GET /api/preferences/active-project if unknown
$board = Invoke-RestMethod "http://localhost:3001/api/projects/$proj/board" -TimeoutSec 10
```

For each issue in `In Review` and `In Progress` columns (in that order), check `workspaceSummary.main`:

| Workspace status | Session status | Action |
|---|---|---|
| `reviewing`, workingDir empty | — | **Ghost**: delete workspace, reset issue to In Progress, create fresh workspace |
| `reviewing` | `stopped` | **Merge**: `POST /api/workspaces/:id/merge` (60s timeout) |
| `idle` | any | **Relaunch**: `POST /api/workspaces/:id/launch` |
| `active` | `stopped` | Mark idle: `PATCH /api/workspaces/:id` `{"status":"idle"}` |
| `active` | `running`, age >5min | **Nudge**: `POST /api/workspaces/:id/turn` `{"message": "Please continue with the task..."}` |
| `active` | `running`, age ≤5min | Leave alone — too fresh |

**If merge times out repeatedly (3+ attempts):**
1. Check `GET /api/workspaces/:id/conflicts` — `hasConflicts: true` means branch diverged
2. If conflicts: cherry-pick the feature commit to master manually, resolve conflicts, commit, then delete the workspace and mark issue Done
3. If no conflicts but still timing out: check `workingDir` field — empty = ghost workspace.

**Auto-start:** Only if fewer than WIP-limit issues In Progress, start the highest-priority Todo:
```powershell
$slug = ($issue.title -replace '[^a-zA-Z0-9\s]','' -replace '\s+','-').ToLower().Substring(0, [Math]::Min(40, $issue.title.Length))
$branch = "feature/ak-$($issue.issueNumber)-$slug"
# POST /api/workspaces with { issueId, branch }
```

---

## SECTION 5 — Summary

Write a concise human-readable summary — imagine sending it to Slack. The goal is that someone without board access can immediately understand what's happening.

**Format:**
```
[monitor] {yyyy-MM-ddTHH:mm}
🟢 Server OK  |  ✅ Merged: N  |  🚀 Started: N  |  🔁 Relaunched: N  |  ⚠️ Conflicts: N

▶ Started:
  • #N  <one-line title summary, max ~60 chars>
  • #N  ...

✅ Merged:
  • #N  <one-line title summary>

🔁 Relaunched / nudged:
  • #N  <one-line title summary>  (reason: idle / stuck Xmin)

⚠️ Needs attention:
  • #N  <title>  — <what's wrong, e.g. "merge conflicts in Layout.tsx">

💤 Idle / stopped:
  • #N  <title>  — <last agent message, first line, max ~80 chars>
```

Rules:
- Always include ticket numbers AND a short title description (never numbers alone).
- Omit sections that are empty.
- Title summaries: strip "E2E: cover", "Add", "Show" boilerplate if it makes it shorter — keep the core noun phrase. E.g. "#253 Estimate badge on issue cards" not "#253 Show estimate badge on kanban issue cards".
- For idle/stopped workspaces: include the `last:` line from the `pnpm cli -- status` output so the reader knows what the agent was doing. If the reader asks "why did it stop?", use `pnpm cli -- issue status <N>` for the full context.
- Keep the whole summary under ~25 lines.

---

## Known patterns & fixes

| Pattern | Symptom | Fix |
|---|---|---|
| **ZAI / glm-5.1** | Session stops immediately, `exitCode: null` | Relaunch immediately every cycle |
| **Ghost workspace** | `status: reviewing`, `workingDir: ""`, merge fails "not something we can merge" | Delete workspace, reset issue to In Progress, create fresh workspace |
| **Merge timeout** | No conflicts detected but merge times out | Retry once; if branch diverged badly, cherry-pick to master and close workspace |
| **tsx conflict injection** | `<<<<<<< HEAD` appears in .ts/.tsx files after a cherry-pick | Section 1 auto-fix; then check if shared package needs rebuild (`pnpm --filter @agentic-kanban/shared build`) |
| **React blank page** | HTTP 200 but `main` is empty; no console errors | Missing useState declarations — check recent conflict resolutions in BoardPage.tsx |
| **`scheduledRuns` not exported** | Server crash: `SyntaxError: does not provide an export named 'scheduledRuns'` | Run `pnpm --filter @agentic-kanban/shared build` to rebuild shared package dist |
| **Active project not set** | Board shows "No projects registered" despite projects existing | `GET /api/preferences/active-project` to check; `PUT /api/preferences` `{"active_project": "<id>"}` to fix |
