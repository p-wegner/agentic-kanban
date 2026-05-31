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
try { Invoke-RestMethod "http://127.0.0.1:3001/health" -TimeoutSec 5 | Out-Null; "UP" } catch { "DOWN" }
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
playwright-cli open http://127.0.0.1:5173
# Poll for hydrated board content instead of treating a slow first render as blank.
deadline=$((SECONDS + 20))
found=""
while [ "$SECONDS" -lt "$deadline" ]; do
  main_text=$(playwright-cli eval "document.querySelector('main')?.innerText || ''" 2>&1)
  if printf '%s' "$main_text" | grep -Eq "Todo|In Progress|No issues|No projects registered"; then
    printf '%s\n' "$main_text" | head -c 500
    echo
    found="yes"
    break
  fi
  sleep 1
done

if [ -z "$found" ]; then
  echo "Timed out waiting for hydrated board content."
  echo "--- console ---"
  playwright-cli console || true
  echo "--- main text ---"
  playwright-cli eval "document.querySelector('main')?.innerText?.substring(0,1000) || '<missing main>'" || true
  echo "--- main html ---"
  playwright-cli eval "document.querySelector('main')?.innerHTML?.substring(0,1500) || '<missing main>'" || true
  playwright-cli close
  exit 1
fi

playwright-cli close
```

**Interpret result:**
- Contains `Todo`, `In Progress`, `No issues`, or `No projects registered` before the timeout → **OK**
- Times out with empty/missing/irrelevant `<main>` content → app may have crashed or failed to hydrate. The smoke command has already printed console output and the current `<main>` text/html snippets. Diagnose:
  1. Check Vite module errors: `GET http://127.0.0.1:5173/src/routes/BoardPage.tsx` — HTTP 500 = compile error in client source
  2. Check server watcher log: `tail -20 /tmp/kanban-monitor-srv.log` for `SyntaxError`, `Cannot find`, `error TS`
  3. Re-run Section 1 scan (conflict markers may have slipped through)
  4. Check the captured console errors from the timeout output
  5. Report findings — do not proceed to Section 4 if server is broken

---

## SECTION 4 — Board operations (only if app monitor is OFF)

The app's built-in monitor handles: idle→relaunch, reviewing→merge, active+stopped→mark_idle, dead process→mark_idle, running>5min→nudge (with smart re-nudge check), auto-start with WIP limit, dependency check, branch name generation (`feature/ak-{N}-{slug}`), and ghost workspace detection (empty workingDir → delete + reset to In Progress).

**Only run this section manually if `auto_monitor` preference is `false`.**

Get the board:
```powershell
$proj = "<active-project-id>"  # read from GET /api/preferences/active-project if unknown
$board = Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$proj/board" -TimeoutSec 10
```

For each issue in `In Progress` and `In Review` columns, check `workspaceSummary.main`. **The action depends on which column the issue is in** — `idle` means "continue work" in In Progress but "ready to land" in In Review:

| Column | Workspace status | Session status | Action |
|---|---|---|---|
| **In Review** | `idle` or `active`+`stopped`, has committed diff | — | **Merge if the prefs allow it** — see "Auto-merge In Review (configurable)" below for the `auto_merge` / `auto_merge_in_review` decision table |
| **In Review** | `reviewing` | `stopped` | **Merge** (if `auto_merge` on): `POST /api/workspaces/:id/merge` (60s timeout) — see "Merging branches safely" below |
| In Progress | `idle` | any | **Relaunch**: `POST /api/workspaces/:id/launch` |
| any | `reviewing`, workingDir empty | — | **Ghost**: delete workspace, reset issue to In Progress, create fresh workspace |
| In Progress | `active` | `stopped` | Mark idle: `PATCH /api/workspaces/:id` `{"status":"idle"}` |
| In Progress | `active` | `running`, age >5min | **Nudge**: `POST /api/workspaces/:id/turn` `{"content": "Please continue with the task..."}` (field is `content`, not `message`) |
| In Progress | `active` | `running`, age >25min, same `lastAssistantMessage` 2 cycles | **Stop** the runaway loop: `POST /api/workspaces/:id/stop` (graceful, no PID kill; only safe when diff is committed / tree clean), then it falls to the In-Review auto-merge rule once moved |
| In Progress | `active` | `running`, age ≤5min | Leave alone — too fresh |

### Auto-merge In Review (configurable — pick up the preference, allow override)

Whether the monitor lands not-yet-ready In-Review work is driven by **two preferences** the app owns — read them every cycle and honor them automatically:

```powershell
$autoMerge        = (Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/auto_merge" -EA SilentlyContinue).value          # default "true"
$autoMergeInReview = (Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/auto_merge_in_review" -EA SilentlyContinue).value # default "false"
```
(Both are also in `GET /api/preferences/settings`. Unset → use the defaults above.)

**Decision for an issue in `In Review` whose `workspaceSummary.main` is `idle` (or `active`+session `stopped`) with a committed diff (`diffStats.filesChanged > 0`):**

| `auto_merge` | `auto_merge_in_review` | `readyForMerge` | Action |
|---|---|---|---|
| `false` | any | any | **Do nothing** — operator froze merging. Report under "Idle / awaiting". |
| `true` | any | `true` | **Merge** — agent marked it ready. |
| `true` | `true` | `false` | **Merge** — policy lands committed In-Review work without the ready gate. |
| `true` | `false` (default) | `false` | **Do nothing** — leave it waiting; report under "Idle / awaiting". |

**User override:** if the user's `/board-monitor` argument explicitly asks to merge In-Review work (e.g. "merge in review to master", "no human gating", "unblock and merge review"), treat it as `auto_merge_in_review = true` for this run **regardless of the stored preference** — and persist it so the app monitor agrees:
```powershell
Invoke-RestMethod "http://127.0.0.1:3001/api/preferences/settings" -Method Put -ContentType "application/json" -Body '{"auto_merge_in_review":"true"}'
```
Conversely, if they say "stop auto-merging review" / "require manual merge", set it back to `"false"`.

**To merge (when the table says Merge):**
1. `POST /api/workspaces/:id/merge` (90s timeout).
   - **200** → merged. **Verify master actually advanced** (`git log --oneline -3 master` shows the merge commit) — a "merged" response does not guarantee the code is on master. Confirm the issue left In Review (→ Done / AI Reviewed).
   - **409** `conflictingFiles` → `POST /api/workspaces/:id/fix-and-merge` `{ "mergeError": "<the 409 body>" }`; re-check next cycle. Never resolve by hand.
   - **5xx / timeout** → retry once; if it still fails, check `workingDir` (empty = ghost), else report under "Needs attention".
2. Never **relaunch** an idle In-Review workspace — its work is already committed; relaunching just restarts whatever loop stopped it (e.g. an unsatisfiable visual-verification Stop hook).

> This mirrors the app's built-in monitor exactly (`monitor-cycle.ts` reads the same two prefs). When `auto_monitor` is ON, the app does this itself; when it's OFF (current default), this skill is the one carrying it out — same policy, same gates.

### Merging branches safely

**The app owns all merging. Never run `git merge`, `git cherry-pick`, `git rebase`, `git checkout`, `git reset`, or `git stash` in the main checkout to land a branch.** Manual git in the main repo is what corrupts the database and abandons half-finished merges (see "Why manual merges are banned" below). The endpoints below do the same work safely, in the worktree, without touching the main checkout's working tree.

**Procedure — always this order:**
1. **Merge**: `POST /api/workspaces/:id/merge`.
   - **200** → merged. Done.
   - **409** with `conflictingFiles` → the branch conflicts with the base. Go to step 2. (The endpoint leaves the repo clean — there is no dangling merge to finish or abort.)
   - **5xx / timeout** → transient. Retry once. If it still fails, check `workingDir` — empty = ghost workspace (see Known patterns), otherwise report under "Needs attention" and move on. Do **not** fall back to manual git.
2. **Resolve in the worktree, not the main repo**: `POST /api/workspaces/:id/fix-and-merge` with `{ "mergeError": "<the 409 message / conflicting files>" }`. This launches an agent **inside the workspace's worktree** to rebase/resolve and merge. It returns `201` with a `sessionId`.
3. **Wait for that session**, then re-check the workspace next cycle. If `fix-and-merge` succeeds the workspace closes itself; if it stalls, surface it under "Needs attention" with the conflicting files — never resolve by hand.

**Optional before merging a long-lived branch:** `POST /api/workspaces/:id/update-base` `{ "mode": "rebase" }` brings the branch up to date with the base first, shrinking the conflict surface. If a rebase gets stuck, `POST /api/workspaces/:id/abort-rebase`.

**Never leave a merge half-finished.** If you somehow find yourself mid-merge (a `.git/MERGE_HEAD` exists or files contain `<<<<<<<` markers in the main checkout), that is a bug to clean up immediately: either complete it or `git merge --abort` — never end a cycle with a dangling merge.

**Two branches editing the same file** (e.g. both add a section to `CLAUDE.md`) will conflict even though neither is "wrong". `fix-and-merge` handles these; when both sides are additive (docs, tables, lists), the correct resolution is almost always to **keep both**, not pick one side.

**Auto-start:** If fewer than 3 issues In Progress, start the highest-priority Todo:
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
| **Merge conflict (409)** | `POST /merge` returns 409 `conflictingFiles` | Use `POST /fix-and-merge` (resolves in the worktree) — never resolve by hand in the main checkout |
| **Merge timeout** | No conflicts detected but merge times out | Retry once; if still failing, report under "Needs attention" — do NOT fall back to manual git |
| **tsx conflict injection** | `<<<<<<< HEAD` appears in .ts/.tsx files after a cherry-pick | Section 1 auto-fix; then check if shared package needs rebuild (`pnpm --filter @agentic-kanban/shared build`) |
| **React blank page** | HTTP 200 but `main` is empty; no console errors | Missing useState declarations — check recent conflict resolutions in BoardPage.tsx |
| **`scheduledRuns` not exported** | Server crash: `SyntaxError: does not provide an export named 'scheduledRuns'` | Run `pnpm --filter @agentic-kanban/shared build` to rebuild shared package dist |
| **Active project not set** | Board shows "No projects registered" despite projects existing | `GET /api/preferences/active-project` to check; `PUT /api/preferences` `{"active_project": "<id>"}` to fix |

---

## Why manual merges are banned

On 2026-05-26 the monitor hit a merge conflict and fell back to manual `git merge` / `git checkout` / `git reset` in the main checkout. Two failures resulted:

1. **Database corruption + full reset.** Git operations touched the live SQLite sidecar files the running server had open, corrupting `kanban.db` ("disk image is malformed"). Recovery escalated to a full DB reset and lost data. (Root cause: the WAL/SHM files were tracked in git — now fixed — but the trigger was running git mutations in the main checkout while the server was live.)
2. **Abandoned half-finished merge.** A `git merge` of two branches that both edited `CLAUDE.md` conflicted and was left with `MERGE_HEAD` + conflict markers when the cycle ended, leaving the repo in a broken state for the next session to clean up.

Both are impossible if you only ever merge through the app endpoints (`/merge` → `/fix-and-merge`), which operate in the worktree and never leave dangling state. That is why manual git merging is prohibited above.
