# Implementation Plan: Backup System Hardening

**Date:** 2026-05-27
**Context:** Post-mortem in `docs/learnings/2026-05-27-autonomous-monitor-merge-crashes.md`. The board DB was wiped and no backup saved us: backups are reactive-only (no periodic backup), the one substantial pre-incident backup was corrupt (copied mid-migration), and no backup is ever verified.

**Goal:** A backup system that (a) runs on a schedule and on shutdown, (b) produces internally-consistent copies, (c) verifies every backup, and (d) keeps a rotation of last-known-good copies — so a corruption/wipe always has a recent, restorable backup behind it.

---

## Root failures being fixed

| # | Failure | Fix phase |
|---|---------|-----------|
| 1 | No periodic backup — only fires on manual `db:repair` or the destructive-command hook | Phase 2 |
| 2 | Raw `copyFileSync` of live `.db`+`-wal`+`-shm` captures inconsistent/mid-migration state | Phase 1 |
| 3 | No backup is ever verified; empty/corrupt files silently become "latest" | Phase 3 |
| 4 | Hard `taskkill /F` mid-write corrupts the DB; no checkpoint on shutdown | Phase 2 (shutdown hook) |

---

## Relevant existing code

- **DB driver/client:** `packages/server/src/db/index.ts` — libsql via `@libsql/client`; exports `db`, `rawClient`. WAL mode + `busy_timeout=10000` already set.
- **DB path:** `packages/server/src/db/data-dir.ts` — `getDbUrl()` → `file:${DATA_DIR}/kanban.db`; `DATA_DIR` exported.
- **Current (flawed) backup:** `packages/server/src/scripts/db-repair.ts` → `backup()` (raw `copyFileSync` of `.db`/`-wal`/`-shm`) + `pruneBackups(keep)`. Backup dir: `packages/server/.db-backups`.
- **Startup tasks:** `packages/server/src/startup/startup-tasks.ts` → `runStartupTasks()`.
- **Shutdown:** `packages/server/src/startup/process-handlers.ts` → `shutdown(signal)` handling `SIGTERM`/`SIGINT`.
- **Reactive hook:** `.claude/hooks/validate-command-safety.js` (auto-backup before blocking).

---

## Phase 1 — A consistent backup primitive (new module)

**New file: `packages/server/src/db/backup.ts`** — the single source of truth for backups. Replaces the raw-copy approach.

```ts
import { createClient } from "@libsql/client";
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR } from "./data-dir.js";

const BACKUP_DIR = resolve(DATA_DIR, ".db-backups");
const DB_PATH = resolve(DATA_DIR, "kanban.db");

export interface BackupResult { path: string; bytes: number; verified: true; }

/**
 * Create an internally-consistent backup using SQLite `VACUUM INTO`, which writes
 * a single checkpointed file (no -wal/-shm sidecars, no mid-write inconsistency).
 * Verifies the result before returning; throws if verification fails.
 */
export async function createBackup(reason: string): Promise<BackupResult | null> {
  if (!existsSync(DB_PATH) || statSync(DB_PATH).size === 0) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(BACKUP_DIR, `kanban-${stamp}-${reason}.db`);

  const client = createClient({ url: getDbUrl() }); // live DB, read path
  try {
    // VACUUM INTO produces a consistent, defragmented single-file snapshot even while
    // the DB is in WAL mode and being written to. Path must be a literal in the SQL.
    await client.execute(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    client.close();
  }

  const result = await verifyBackup(dest); // throws on failure
  pruneBackups(KEEP_LAST);
  return { path: dest, bytes: statSync(dest).size, verified: true };
}
```

Notes:
- **`VACUUM INTO`** is the key change. It is the libsql/SQLite-supported way to take a consistent online backup of a live WAL database into one file — no sidecars, no half-written pages, no mid-migration temp tables.
- Keep using the live client (read access is safe; `VACUUM INTO` does not block readers materially and respects `busy_timeout`).
- Filenames gain a `-${reason}` suffix (`periodic`, `shutdown`, `pre-repair`, `pre-destructive`) for forensics.

## Phase 2 — Run backups automatically (periodic + shutdown + pre-risky-op)

**a) Periodic scheduler.** New `packages/server/src/startup/backup-scheduler.ts`:

```ts
import { createBackup } from "../db/backup.js";

export function startBackupScheduler(intervalMin = 30): NodeJS.Timeout {
  const run = () => createBackup("periodic").catch((e) =>
    console.warn("[backup] periodic backup failed:", e instanceof Error ? e.message : e));
  // One shortly after boot (captures the just-recovered state), then on interval.
  setTimeout(run, 60_000);
  return setInterval(run, intervalMin * 60_000);
}
```
Wire from `runStartupTasks()` (or `index.ts` after server start). Interval configurable (Phase «config» below). Default 30 min.

**b) Shutdown backup + WAL checkpoint.** In `packages/server/src/startup/process-handlers.ts` `shutdown(signal)`, before exit:
```ts
try {
  await rawClient.execute("PRAGMA wal_checkpoint(TRUNCATE)"); // flush WAL into main db
  await createBackup("shutdown");
} catch (e) { console.warn("[backup] shutdown backup failed:", e); }
```
This both protects against the next start *and* leaves the main `.db` checkpointed so a subsequent hard-kill can't strand committed data only in the WAL. (Note: `shutdown` currently only runs on SIGINT/SIGTERM, not on `taskkill /F` — see Phase 4 for reducing hard-kills.)

**c) Pre-risky-operation backup.** Call `createBackup("pre-merge")` immediately before the monitor/endpoint performs a merge, and `createBackup("pre-migration")` before `runMigrations()` in `db-repair.ts`/startup. Cheap insurance around the operations that historically caused loss.

**d) Reuse in `db-repair.ts`.** Replace `db-repair.ts`’s local `backup()` with `createBackup("pre-repair")` from the new module so there is exactly one backup implementation.

## Phase 3 — Verify, rotate, protect last-known-good

**New `verifyBackup(path)` in `backup.ts`:**
```ts
export async function verifyBackup(path: string): Promise<true> {
  const c = createClient({ url: pathToFileURL(path).href });
  try {
    const integrity = await c.execute("PRAGMA integrity_check");
    if (integrity.rows[0]?.integrity_check !== "ok")
      throw new Error(`integrity_check failed: ${JSON.stringify(integrity.rows[0])}`);
    // Sanity: a healthy board has >=1 project. Guard against backing up an empty/wiped DB
    // as if it were good. (Compare against the live row count, see below.)
    const projects = await c.execute("SELECT count(*) c FROM projects");
    if (Number(projects.rows[0].c) === 0 && (await liveProjectCount()) > 0)
      throw new Error("backup has 0 projects but live DB has >0 — refusing as corrupt/empty");
    return true;
  } finally { c.close(); }
}
```
- **Reject empty-when-live-is-not:** the exact trap that bit us — a backup taken after a wipe must not be accepted/rotated in as the newest good copy.
- **`pruneBackups(KEEP_LAST)`** keeps the N most recent *verified* backups (default `KEEP_LAST = 24`, ~12h at 30-min cadence). Never delete the last-known-good to make room for an unverified one.
- Optionally keep a separate `last-known-good.db` pointer/copy that is only updated after successful verification.

## Phase 4 — Restore tooling + reduce hard-kills

- **Restore CLI:** `pnpm db:restore [<backup-file>]` — verifies the chosen (or latest verified) backup, backs up the current DB first (`pre-restore`), then atomically swaps it in (server stopped). Add to `package.json` scripts; implement in `src/scripts/db-restore.ts`. Make it list available verified backups when run with no arg.
- **Reduce hard kills:** the dev-stop procedure uses `taskkill /F`. Prefer sending SIGTERM and letting `shutdown()` checkpoint+backup before exit; only escalate to `/F` if it doesn't exit in N seconds. Document in CLAUDE.md’s stop procedure.
- **Stretch:** investigate why `deduplicateProjects()` can cascade to an empty board on a damaged DB; guard it to refuse running if the DB failed integrity_check at startup.

## Configuration

Add settings (whitelist in `preference.service.ts` `SETTINGS_KEYS`, plus `SettingsPanel.tsx` if surfaced):
- `backup_interval_min` (default 30; 0 disables periodic).
- `backup_keep_last` (default 24).
Env override `AGENTIC_KANBAN_BACKUP_DIR` (defaults to `${DATA_DIR}/.db-backups`).

## Tests (`packages/server/src/__tests__/backup.test.ts`)

1. `createBackup` on a seeded temp DB → returns a path; the backup opens and `integrity_check = ok`; project/issue counts match the source.
2. `createBackup` while a write txn is in flight → backup is still consistent (no partial rows; counts equal a committed snapshot).
3. `verifyBackup` rejects: (a) a truncated/corrupt file, (b) a 0-project backup when the live DB has projects.
4. `pruneBackups` keeps exactly `KEEP_LAST` newest and never deletes the only verified backup.
5. `db:restore` round-trip: seed → backup → wipe → restore → counts match.
> Per CLAUDE.md, this suite touches the filesystem; add `test.setTimeout(30000)` and use temp dirs.

## Rollout order

1. Phase 1 (`backup.ts` with `VACUUM INTO` + `verifyBackup`) + point `db-repair.ts` at it. *(Consistent, verified backups — immediate value.)*
2. Phase 3 verification/rotation guards.
3. Phase 2 periodic scheduler + shutdown hook + pre-risky-op calls. *(Closes the 17-hour-gap hole.)*
4. Phase 4 restore CLI + hard-kill reduction.
5. Tests alongside each phase.

## Out of scope (tracked elsewhere)

- The deeper architectural fix — **don’t run the orchestrator on the live working tree** (separate checkout / built artifact) — is the real root cause of the hard-kill churn. See the systemic list in the post-mortem. Backups are the safety net; that change removes the thing that keeps tearing the net.
