# Workflows

## Starting the App (Clean State)

Use this when you want a fully initialized app with no stale issues, workspaces, or sessions.

### First-time setup (no DB exists yet)

```powershell
pnpm install              # install dependencies
pnpm db:migrate           # create DB and apply all migrations
pnpm db:seed              # seed 4 default tags (bug, feature, improvement, docs)
pnpm cli -- register .    # register current repo as a project (sets active project)
pnpm dev                  # start server (port 3001) + client (port 5173)
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
1. Open `http://localhost:5173` — board should show the registered project with 3 active columns
2. Run `pnpm cli -- list` to confirm the project is registered and marked `(active)`

---

## Stopping the Server

The dev server runs node processes. To stop:

```powershell
# PowerShell — kill all node processes
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
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

```powershell
# Server health (port 3001)
curl http://localhost:3001/health               # {"status":"ok"}

# List projects
curl http://localhost:3001/api/projects

# Active project ID
curl http://localhost:3001/api/preferences/active-project

# Board for a project
curl http://localhost:3001/api/projects/<projectId>/board

# List workspaces
curl http://localhost:3001/api/workspaces

# Create a direct workspace (no worktree)
curl -X POST http://localhost:3001/api/workspaces `
  -H "Content-Type: application/json" `
  -d '{"issueId":"<id>","isDirect":true}'
```

---

## Debugging Runtime Errors

### `no such column` errors

See "Diagnosing migration issues" above.

### `EBUSY: resource busy or locked`

The DB is locked — a node process is holding it open. Stop all node processes first:

```powershell
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
```

### Port already in use

The server (3001) or client (5173) ports may still be bound from a prior run:

```powershell
# Find and kill processes on port 3001
$proc = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($proc) { Stop-Process -Id $proc -Force }
```
