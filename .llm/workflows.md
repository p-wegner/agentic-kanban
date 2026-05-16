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
