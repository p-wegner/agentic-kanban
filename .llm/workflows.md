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

## Diagnosing a Stopped Agent Session

When an agent session stops unexpectedly (workspace shows `idle`, no commits), use this workflow to find out why.

### 1. Check session status and exit code

```powershell
# Find the workspace ID from the CLI
pnpm cli -- workspace list

# Get sessions for that workspace
Invoke-RestMethod "http://localhost:3001/api/workspaces/<workspaceId>/sessions" | ConvertTo-Json -Depth 3
```

Key fields to look at:
- `status: "stopped"` + `exitCode: null` → user-stopped (not a crash)
- `status: "stopped"` + `exitCode: 1` → crash or error
- Very short duration (< 60s) → likely stopped before doing real work

### 2. Get a quick summary of what the agent did

```powershell
Invoke-RestMethod "http://localhost:3001/api/sessions/<sessionId>/summary" | ConvertTo-Json -Depth 5
```

Check `keyExcerpts` for the last thing the agent said, `filesEdited`/`filesWritten` to see if it produced output, and `errors` for any failures.

### 3. Read the raw Claude Code session transcript

Claude Code stores full JSONL transcripts under `~/.claude/projects/`, keyed by the worktree path. The directory name is the path with `/` and `\` replaced by `--`:

```powershell
# Find the session dir for a worktree
Get-ChildItem "$env:USERPROFILE\.claude\projects\" -Directory | Where-Object { $_.Name -like "*ak-<N>*" }

# List files inside (the .jsonl is the transcript)
Get-ChildItem "$env:USERPROFILE\.claude\projects\<dir>\"
```

Parse the last entries to find the final tool call and result:

```powershell
$lines = Get-Content "$env:USERPROFILE\.claude\projects\<dir>\<session-id>.jsonl"
$parsed = $lines | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} }
$parsed | Select-Object -Last 10 | ForEach-Object {
    $toolUse = $_.message.content | Where-Object { $_.type -eq "tool_use" }
    [PSCustomObject]@{
        type       = $_.type
        stop_reason = $_.message.stop_reason
        tool_name  = $toolUse.name
        tool_input = ($toolUse.input | ConvertTo-Json -Compress -Depth 2)
    }
} | ConvertTo-Json -Depth 3
```

### 4. Common failure patterns

| Symptom | Likely cause |
|---|---|
| Last tool call was `get_context` returning wrong project | MCP active-project bug (fixed in 21dff41) — agent saw wrong board |
| `exitCode: null`, very short duration, no file writes | User-stopped before agent started working |
| Agent produced a plan in `keyExcerpts` but wrote nothing | Session was stopped during the planning phase |
| `errors` array non-empty | Check error message — usually a tool call failure |
| `exitCode: 1`, "Invalid API key" in session output, 0 tokens | `ANTHROPIC_API_KEY` set in shell env leaked into agent spawn (fixed in 816fe20). Restart the dev server to pick up the fix — the old server process still passes the leaked key. |

### 5. Deciding what to do with the worktree

After diagnosing, for worktrees with **no commits ahead of master**:
- Check `git status` for uncommitted changes
- If the changes are superseded by a fix already on master → discard and clean up (see "Cleaning Up Git Worktrees")
- If the changes are valuable and not on master → commit them or cherry-pick

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

**Impact**: 246+ directories, 120+ MB accumulated over time. Each contains JSONL conversation transcripts and session metadata.

**Before deleting**, decide whether any session history is worth keeping (e.g. an important investigation or design discussion). You can review individual sessions by opening the `.jsonl` files.

**Important: preserve non-kanban project sessions.** The `~/.claude/projects/` folder also contains sessions from other projects. The filter below uses two patterns to target only agentic-kanban worktree sessions while leaving everything else untouched.

**Two path patterns produce worktree session dirs:**
- `C:/andrena/.worktrees/...` encodes as `C--andrena--worktrees-*` (no "kanban" in the name)
- `C:/andrena/agentic-kanban/packages/.worktrees/...` encodes as `C--andrena-agentic-kanban-packages--worktrees-*`
- Claude Code's internal worktrees at `.claude/worktrees/` encode as `C--andrena-agentic-kanban--claude-worktrees-*`

Both patterns are needed — a single `*kanban*worktrees*` filter misses the first category.

**What gets preserved (not matched by filter):**
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
# Preview: list all agentic-kanban worktree session dirs
Get-ChildItem "$env:USERPROFILE\.claude\projects\" -Directory |
    Where-Object {
        ($_.Name -like "*kanban*worktrees*") -or
        ($_.Name -like "*andrena--worktrees*")
    } |
    ForEach-Object { Write-Output $_.Name }

# Check total size
$dirs = Get-ChildItem "$env:USERPROFILE\.claude\projects\" -Directory |
    Where-Object {
        ($_.Name -like "*kanban*worktrees*") -or
        ($_.Name -like "*andrena--worktrees*")
    }
$size = ($dirs | ForEach-Object {
    (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
     Measure-Object -Property Length -Sum).Sum
} | Measure-Object -Sum).Sum
Write-Output "Dirs: $($dirs.Count), Size: $([math]::Round($size / 1MB, 1)) MB"

# Delete all agentic-kanban worktree session history
Get-ChildItem "$env:USERPROFILE\.claude\projects\" -Directory |
    Where-Object {
        ($_.Name -like "*kanban*worktrees*") -or
        ($_.Name -like "*andrena--worktrees*")
    } |
    Remove-Item -Recurse -Force
```

### 7. Verify cleanup

```bash
git worktree list          # Should show only main checkout
git worktree prune         # Clean up any dangling refs
ls C:/andrena/.worktrees/  # Should be empty (or contain only locked empty dirs)
```

---

## Agent Monitoring Loop

The board has a built-in auto-monitor (Settings → Workflow → Board Monitoring, or the **Monitor** toggle button in the board header). When enabled, the server re-launches idle workspaces and nudges waiting agents automatically every configured interval.

For a session-level monitoring loop driven by Claude Code itself, use `/loop`:

```
/loop 3m check for stuck agents on the kanban board and make them continue their work flow if they are waiting for input or appear stuck. Check workspace statuses via the DB or API. For idle workspaces on non-Done issues, re-launch via POST /api/workspaces/:id/launch. For reviewing workspaces with stopped sessions, trigger merge via POST /api/workspaces/:id/merge. For active workspaces with waiting agents, nudge via POST /api/workspaces/:id/turn.
```

This schedules a cron that fires every 3 minutes for the duration of the session (auto-expires after 7 days). To stop it:

```
/cron list        # find the job ID
/cron delete <id>
```

Or type `pause cron` and Claude will cancel it.

### What the monitor does each cycle

1. **Board scan** — fetches active columns (Todo, In Progress, In Review, AI Reviewed)
2. **Fix stale statuses** — issues already implemented but stuck in In Progress get moved to Done using `PATCH /api/issues/:id` with the correct `statusId`
3. **Re-launch idle workspaces** — `POST /api/workspaces/:id/launch` with the issue title as prompt (agents using `claude_profile=zai` stop every ~90s with null exit code; re-launch is the fix)
4. **Nudge waiting agents** — `POST /api/workspaces/:id/turn` for active workspaces whose session is running but waiting for input
5. **Trigger merge** — `POST /api/workspaces/:id/merge` for workspaces in reviewing state with a stopped session
6. **Implement directly** — when agents consistently fail (glm-5.1 model stops immediately), implement the feature directly in code, commit, and mark Done

### Note on `claude_profile=zai`

The `zai` profile maps to a non-Claude model (glm-5.1) that exits after 13–101s with `exitCode: null`. These sessions never produce output. The monitoring loop works around this by re-launching repeatedly, but the reliable fix is to implement features directly or switch to a Claude profile for agent work.

---

## Codex Profile Naming Convention

`codex exec --profile-v2 <name>` looks for `<name>.config.toml` in `~/.codex/`.

**Legacy files** use the pattern `config_<name>.toml` and need a one-time rename:

| Before (legacy) | After (new convention) |
|---|---|
| `config_andrena-azure.toml` | `andrena-azure.config.toml` |
| `config_orig.toml` | `orig.config.toml` |
| `config.toml` | `config.toml` (base config, **do NOT rename**) |

To rename:

```powershell
Rename-Item "$env:USERPROFILE\.codex\config_andrena-azure.toml" "andrena-azure.config.toml"
Rename-Item "$env:USERPROFILE\.codex\config_orig.toml" "orig.config.toml"
```

The board discovers both naming conventions and shows them in the profile dropdown (Settings → Agent → Agent Profile, under the "Codex" optgroup). The hint text in the UI also documents the convention.
