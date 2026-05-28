---
name: db-doctor
description: Diagnose & repair kanban.db migration/lock/WAL issues in place — never deletes, truncates, or resets the DB
---

# db-doctor

Safe recovery for the vital dev database (`packages/server/kanban.db`). The DB holds all issues, workspaces, sessions, and settings. It has been wiped twice by agents reaching for deletion — that is NEVER the fix. Follow this procedure instead.

## HARD CONSTRAINTS — read first

- **NEVER delete, truncate, reset, move, or overwrite the DB.** No `pnpm db:reset`, no `rm`/`Remove-Item`/`del`, no `Out-File`/`Set-Content`/`Clear-Content`/`New-Item -Force`/`>` redirect, no `Move-Item`/`mv`, in ANY path form (including `/mnt/c/...`).
- A **PreToolUse hook** (`.claude/hooks/validate-command-safety.js`) blocks these. **When it fires, STOP and ask the user.** Do NOT weaken the hook, change the verb/path to dodge it, or set `ALLOW_DB_DESTROY=1`. A control you route around is not a control.
- Deletion does NOT fix "migrations won't apply" — that is a lock/tooling problem.
- Backups (db + `-wal` + `-shm`) live in `packages/server/.db-backups/`. `pnpm db:repair` writes one before doing anything.
- Windows/PowerShell machine: use `Invoke-RestMethod` (not `curl`), `127.0.0.1` (not `localhost`).

## Step 1 — Identify the failure mode

Match the symptom to a section below:

| Symptom | Go to |
|---|---|
| Migrations won't apply / "no such column" / `db locked` / `EBUSY` / stale WAL | Step 2 |
| DB locked even though `/health` responds | Step 3 |
| Server crashes on start; `<<<<<<<` markers in `_journal.json`; `MERGE_HEAD` present | Step 4 |
| Need to un-add a migration that isn't wanted | Step 5 |
| Just need to confirm DB is alive | Step 6 |

## Step 2 — Migrations won't apply / locked / stale WAL → `pnpm db:repair`

**This is the FIRST move for any migration/lock/WAL problem.** Do not reach for deletion.

1. Stop the dev server first (see Step 3 kill commands) — a running server holds the SQLite handle and causes `EBUSY`.
2. Run:
   ```powershell
   pnpm db:repair
   ```
   It (in order): backs up db+wal+shm to `packages/server/.db-backups/`, probes for a lock, `PRAGMA wal_checkpoint(TRUNCATE)` to flush stale WAL, `PRAGMA integrity_check`, then runs the **programmatic** drizzle migrator in place.
3. **Do NOT use `drizzle-kit migrate` (the CLI) — it can hang.** The programmatic migrator inside `db:repair` is the one that works.
4. If `db:repair` reports the DB is **LOCKED** (exit 3), it refused to touch it — go to Step 3, kill the holder, then re-run.
5. If it reports the DB is **unusable** (zero-byte / `SQLITE_NOTADB`, exit 2): a backup was already taken. **STOP and ask the user** before considering `--force` (which recreates an empty DB). Do not run `--force` autonomously.
6. Restart the server (see Step 6) and verify.

## Step 3 — DB locked but `/health` responds → orphaned tsx/node process

A live or orphaned server process holds the SQLite file open. Kill it **by signature** — **NEVER kill all node processes.**

```powershell
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*dev.mjs*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*vite/bin/vite.js*" } |
    ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>$null }
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*agentic-kanban*tsx*src/index*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```

The third command catches orphaned `tsx` server processes — they hold the DB open and make `/api/projects` hang even when `/health` answers. After killing, re-run `pnpm db:repair` (Step 2) if migrations were the issue, then restart.

## Step 4 — Journal merge crash (server won't start, conflicted `_journal.json`)

Two branches each added the next migration (e.g. both `0045_*`); a `/merge` ran `git merge --no-ff` in the **main checkout**, conflicted in `packages/shared/drizzle/meta/_journal.json`, and left it mid-merge. The conflicted journal is invalid JSON, so the server crashes on start.

**The server MUST be DOWN first** — git operations in a live main checkout are what corrupt the DB. Then:

1. Stop the server (Step 3 kill commands).
2. Abort the merge in the main checkout:
   ```powershell
   git merge --abort
   ```
   This clears `MERGE_HEAD`, restores a valid `_journal.json`, and leaves the branch intact.
3. Verify the journal is valid JSON with no conflict markers:
   ```powershell
   node -e "JSON.parse(require('fs').readFileSync('packages/shared/drizzle/meta/_journal.json','utf-8')); console.log('journal OK')"
   ```
4. Restart (Step 6).
5. **Do NOT re-trigger a direct `/merge` on the same branch** — it re-breaks main. Rebase the branch first (`POST /api/workspaces/:id/update-base`) so migrations renumber, or resolve in the worktree, then merge.

> Note: as of #42 (commit 36d4596) `mergeBranch` now aborts conflicting merges automatically (returns 409). These recovery steps apply only if an old pre-fix mid-merge state is encountered.

## Step 5 — Revert an unwanted migration (remove ALL three)

Missing any one of these causes `SQLITE_ERROR: no such column` at runtime or a TS build error:

1. Delete the SQL file: `packages/shared/drizzle/NNNN_name.sql`.
2. Remove its entry from `packages/shared/drizzle/meta/_journal.json`.
3. Remove every reference to the changed column from the Drizzle schema (`packages/shared/src/schema/*.ts`) and any `.select()` calls in route files. Grep the repo for the column name to catch all sites.

Then rebuild shared (`pnpm --filter @agentic-kanban/shared build`) and restart.

## Step 6 — Verify DB state

Start the server headlessly, then check:

```powershell
# After: nohup pnpm dev > /tmp/kanban-dev.log 2>&1 & disown   (Bash tool), wait ~16s
try { $r = Invoke-RestMethod "http://127.0.0.1:3001/api/projects" -TimeoutSec 10; Write-Host "OK: $($r.Count) projects" } catch { Write-Host "FAILED: $_" }
```

`/api/projects` returning the project list (not hanging, not 500) confirms the DB is readable and migrations applied. If it hangs, an orphaned process likely holds the lock — return to Step 3. In a worktree, use `$env:KANBAN_SERVER_PORT` instead of `3001`.
