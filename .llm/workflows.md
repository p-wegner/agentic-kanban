# Workflows

## Starting the App (Clean State)

Use this when you want a fully initialized app with no stale issues, workspaces, or sessions.

### First-time setup (no DB exists yet)

```powershell
pnpm install              # install dependencies
pnpm db:migrate           # create DB and apply all migrations
pnpm db:seed              # seed 4 default tags (bug, feature, improvement, docs)
pnpm cli -- register .    # register current repo as a project (sets active project)
pnpm dev                  # start server + client (auto-detects worktree ports; default: 3001/5173)
```

Or as a one-liner (skips `pnpm install`):
```powershell
pnpm db:setup             # equivalent: db:migrate + db:seed + cli register .
pnpm dev
```

### Reset to clean state (DB already exists)

**Stop the dev server first** — the DB will be locked (`EBUSY`) if the server is running.

```powershell
pnpm db:reset             # deletes kanban.db (all 3 locations), re-migrates, re-seeds tags
pnpm cli -- register .    # re-register the agentic-kanban repo itself as a project
pnpm dev
```

`pnpm db:reset` deletes these DB files if they exist:
- `packages/server/kanban.db` (primary)
- `packages/mcp-server/kanban.db`
- `kanban.db` (repo root, legacy)

### What `pnpm cli -- register .` does

- Detects git info (repo name, default branch, remote URL) from the path
- Creates a project record in the DB
- Adds 5 default statuses: Todo, In Progress, In Review, Done, Cancelled
- Sets the project as the active project

If the repo is already registered (same `repoPath`), it skips without error.

### Verifying the state

After starting:
1. Open the client URL from the dev banner (default `http://localhost:5173`, worktrees use different ports)
2. Run `pnpm cli -- list` to confirm the project is registered and marked `(active)`

### Starting in a Worktree

When working in a git worktree (agents working on issues), `pnpm dev` automatically detects the worktree and assigns unique ports:
- Issue #2 → server:3003, client:5175
- Issue #5 → server:3006, client:5178
- Main checkout → server:3001, client:5173 (default)

The dev script prints a banner showing the detected ports:
```
[dev] Worktree detected (feature/2-proper-devserver-setup) — server:3003 client:5175
```

Each worktree gets its own database (`packages/server/kanban.db` resolved within the worktree).

---

## Stopping the Server

**Never kill ALL node processes** — other agents may be running in separate worktrees with their own dev servers.

To stop a specific dev server, kill by port:

```powershell
# Stop server on a specific port (e.g. 3003 for issue #2)
$proc = Get-NetTCPConnection -LocalPort 3003 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { $proc | ForEach-Object { Stop-Process -Id $_ -Force } }
```

To stop the main checkout server (port 3001):

```powershell
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { $proc | ForEach-Object { Stop-Process -Id $_ -Force } }
```

Always stop the server before running `pnpm db:reset` or `pnpm db:migrate` to avoid `EBUSY` lock errors.

---

## Migrations

### How migrations work

- Migration SQL files live in `packages/shared/drizzle/*.sql`
- The journal at `packages/shared/drizzle/meta/_journal.json` tracks which migrations are registered
- `pnpm db:migrate` runs `drizzle-kit migrate` from `packages/server`, applying any unapplied entries from the journal
- **The journal must include an entry for every SQL file** — if a file exists but has no journal entry, `drizzle-kit migrate` will silently skip it

### Running migrations

```powershell
# Stop server first, then:
pnpm db:migrate
```

### Adding a new migration

When adding a new `packages/shared/drizzle/NNNN_name.sql` file, also add an entry to `_journal.json`:

```json
{
  "idx": N,
  "version": "6",
  "when": <unix-ms timestamp>,
  "tag": "NNNN_name",
  "breakpoints": true
}
```

Without the journal entry the SQL file will be ignored by `drizzle-kit migrate`.

### Diagnosing migration issues

**Symptom**: `SQLITE_ERROR: no such column: <col>` at runtime despite migration file existing.

**Cause**: The SQL file exists but has no entry in `_journal.json`, so drizzle-kit never applied it.

**Fix**:
1. Check which columns are actually in the DB:
   ```powershell
   $script = @'
   import { DatabaseSync } from "node:sqlite";
   const db = new DatabaseSync("kanban.db");
   const cols = db.prepare("PRAGMA table_info(<table>)").all();
   console.log(cols.map(c => c.name).join(", "));
   '@
   $script | Out-File -Encoding utf8 "$env:TEMP\check_schema.mjs"
   Set-Location packages\server
   node --experimental-sqlite "$env:TEMP\check_schema.mjs"
   ```
2. Check `packages/shared/drizzle/meta/_journal.json` — compare entries against SQL files on disk
3. Add missing entries to the journal
4. Stop the server, run `pnpm db:migrate`

### Checking what drizzle-kit actually ran

Drizzle tracks applied migrations in a `__drizzle_migrations` table in the DB:

```powershell
$script = @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("kanban.db");
const rows = db.prepare("SELECT * FROM __drizzle_migrations ORDER BY created_at").all();
console.log(JSON.stringify(rows, null, 2));
'@
$script | Out-File -Encoding utf8 "$env:TEMP\check_migrations.mjs"
Set-Location packages\server
node --experimental-sqlite "$env:TEMP\check_migrations.mjs"
```

---

## API Health Checks

Replace `<port>` with the server port from the dev banner (default: 3001, worktree: 3001+N).

```powershell
# Server health
curl http://localhost:<port>/health               # {"status":"ok"}

# List projects
curl http://localhost:<port>/api/projects

# Active project ID
curl http://localhost:<port>/api/preferences/active-project

# Board for a project
curl http://localhost:<port>/api/projects/<projectId>/board

# List workspaces
curl http://localhost:<port>/api/workspaces

# Create a direct workspace (no worktree)
curl -X POST http://localhost:<port>/api/workspaces `
  -H "Content-Type: application/json" `
  -d '{"issueId":"<id>","isDirect":true}'
```

---

## Debugging Runtime Errors

### `no such column` errors

See "Diagnosing migration issues" above.

### `EBUSY: resource busy or locked`

The DB is locked — a node process is holding it open. Stop the specific server by port:

```powershell
$proc = Get-NetTCPConnection -LocalPort <port> -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { $proc | ForEach-Object { Stop-Process -Id $_ -Force } }
```

### Port already in use

The server or client port may still be bound from a prior run:

```powershell
# Find and kill processes on a specific port
$proc = Get-NetTCPConnection -LocalPort <port> -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { $proc | ForEach-Object { Stop-Process -Id $_ -Force } }
```

---

## Cleaning Up Git Worktrees

When worktrees accumulate from completed or abandoned agent sessions, use this workflow to audit and clean them up.

### 1. Audit: list all worktrees with their status

```bash
# List registered worktrees
git worktree list

# For each worktree, check commits ahead of master and uncommitted changes
for wt in $(git worktree list --porcelain | grep "^worktree " | cut -d' ' -f2); do
  name=$(basename "$wt")
  ahead=$(git -C "$wt" rev-list --count master..HEAD 2>/dev/null)
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null)
  dirty_count=$(echo "$dirty" | grep -c . 2>/dev/null || echo 0)
  echo "$name  ahead=$ahead  dirty=$dirty_count"
done
```

### 2. Decide what to keep

For each worktree with commits ahead of master:

```bash
# Show commit messages
git -C "<worktree-path>" log --oneline master..HEAD

# Show actual file changes (use --stat for summary, --name-only for file list)
git -C "<worktree-path>" diff --stat master..HEAD
```

**Before merging a branch, verify the changes aren't already on master** — old agent branches can contain hundreds of stale diffs from rebases that were already merged through other paths:

```bash
# Check if the fix/feature is already on master
git log --oneline master --grep="<keyword from commit message>"
git grep "<unique function name>" HEAD -- "*.ts"
```

### 3. Cherry-pick useful commits (if needed)

If a branch has a real fix not yet on master, cherry-pick just that commit:

```bash
git cherry-pick <commit-sha>
```

**Do not merge stale branches** — they accumulate unrelated refactoring and deletions from the point they diverged. A branch 30+ commits behind master with 50+ changed files is not a clean merge; cherry-pick the specific commit instead.

### 4. Remove worktrees and branches

```bash
# Remove git worktree registration (stops if directory has untracked files)
git worktree remove --force <path>

# Prune stale refs (worktrees whose directories were already deleted)
git worktree prune

# Delete the local branch
git branch -D <branch-name>
```

### 5. Clean up leftover directories

On Windows, `git worktree remove --force` often fails with "Directory not empty" (leftover `node_modules/`, `dist/`, `kanban.db` from agent sessions). After removing the git registration, force-delete the directories:

```powershell
# Remove all leftover worktree directories at once
Get-ChildItem "C:/andrena/.worktrees/" -Directory | ForEach-Object {
    Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
    if (Test-Path $_.FullName) { Write-Output "LOCKED: $($_.Name)" } else { Write-Output "Removed: $($_.Name)" }
}
```

Locked directories (held by another process) are harmless once empty — they can be deleted after a reboot. Git no longer tracks them after `git worktree prune`.

### 6. Clean up Claude Code session history (optional)

Claude Code stores per-project conversation history under `~/.claude/projects/`, keyed by the working directory path. Each worktree gets its own project dir (e.g. `C--andrena--worktrees-feature-ak-114-prepare-npx-deployment-of-app`). After removing worktrees, these session logs are orphaned.

**Impact**: 200+ directories, 100+ MB accumulated over time. Each contains JSONL conversation transcripts and session metadata.

**Before deleting**, decide whether any session history is worth keeping (e.g. an important investigation or design discussion). You can review individual sessions by opening the `.jsonl` files.

**Important: preserve non-kanban project sessions.** The `~/.claude/projects/` folder also contains sessions from other projects. The filter below uses `-like "*kanban*worktrees*"` to target only agentic-kanban worktree sessions.

**What gets deleted:**
- `C--andrena--worktrees-feature-*` — git worktree agent sessions (181+ dirs)
- `C--andrena-agentic-kanban-packages--worktrees-feature-*` — nested worktree sessions
- `C--andrena-agentic-kanban--claude-worktrees-*` — Claude Code internal worktree sessions

**What gets preserved:**
- `C--andrena-agentic-kanban` — main checkout sessions
- `C--andrena-agentic-kanban-packages-server` — server package sessions
- `C--andrena-andrena-ai-blog` — other projects
- `C--andrena-beyond-vibe-coding` — other projects
- `C--andrena-beyond-vibe-coding-demo` — other projects
- `C--andrena-KI-Themen` — other projects
- `C--andrena-without-hook-demo` — other projects
- `C--Tools`, `C--Tools-claude-pick` — other projects
- `C--Users-pwegner` — other projects

```powershell
# Preview: list all kanban worktree session dirs (safe — won't match other projects)
Get-ChildItem "$env:USERPROFILE\.claude\projects\" -Directory |
    Where-Object { $_.Name -like "*kanban*worktrees*" } |
    ForEach-Object { Write-Output $_.Name }

# Check total size
$dirs = Get-ChildItem "$env:USERPROFILE\.claude\projects\" -Directory |
    Where-Object { $_.Name -like "*kanban*worktrees*" }
$size = ($dirs | ForEach-Object {
    (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
     Measure-Object -Property Length -Sum).Sum
} | Measure-Object -Sum).Sum
Write-Output "Dirs: $($dirs.Count), Size: $([math]::Round($size / 1MB, 1)) MB"

# Delete all kanban worktree session history
Get-ChildItem "$env:USERPROFILE\.claude\projects\" -Directory |
    Where-Object { $_.Name -like "*kanban*worktrees*" } |
    Remove-Item -Recurse -Force
```

### 7. Verify cleanup

```bash
git worktree list          # Should show only main checkout
git worktree prune         # Clean up any dangling refs
ls C:/andrena/.worktrees/  # Should be empty (or contain only locked empty dirs)
```
