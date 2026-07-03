/**
 * db:repair — safe recovery for the "migrations won't apply" / locked / stale-WAL cases.
 *
 * Motivation: deleting kanban.db is NEVER the right fix for migration or lock
 * problems (see docs/learnings/2026-05-24-agent-circumvented-db-deletion-guardrail.md).
 * This script provides the recovery path so deletion is never tempting. It:
 *
 *   1. Backs up the current db (+ -wal/-shm) to packages/server/.db-backups/ — always, first.
 *   2. Diagnoses: file presence/size, SQLite validity, integrity_check, applied migrations.
 *   3. Repairs non-destructively: WAL checkpoint (flush -wal into the db), then runs
 *      drizzle migrations to bring the schema up to date.
 *   4. Only recreates a genuinely-unusable db (zero-byte / SQLITE_NOTADB) when explicitly
 *      authorized via --force or ALLOW_DB_DESTROY=1 — and only after the backup above.
 *
 * Usage:
 *   pnpm db:repair            # back up + diagnose + checkpoint + migrate
 *   pnpm db:repair --force    # additionally recreate an unusable db (backup taken first)
 */

import type { createClient } from "@libsql/client";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { applyMigrations } from "../db/manual-migrate.js";
import { createBackup, backupDir } from "../db/backup.js";
import { createClientWithPragmas } from "../db/pragmas.js";
import { quarantineAndDeleteFkViolations } from "../db/fk-violations.js";
import { repairInvalidUtf8Rows, UTF8_REPAIR_TABLES } from "../db/utf8-repair.js";
import { alignForeignKeyActions } from "@agentic-kanban/shared/lib/fk-actions-repair";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../kanban.db");
const SIDECARS = ["", "-wal", "-shm"] as const;

const force = process.argv.includes("--force") || process.env.ALLOW_DB_DESTROY === "1";

const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function log(msg: string) {
  console.log(`[db:repair] ${msg}`);
}

function abortLocked(): never {
  log("");
  log("ABORTED: the database file is LOCKED by another process — refusing to destroy it.");
  log("A transient lock must never cost data. This is almost always the dev server or an");
  log("orphaned tsx process still holding the SQLite handle. Stop it, then retry:");
  log("  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tsx*src/index*' -or $_.CommandLine -like '*dev.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
  log("Your data is intact (a backup was also written above).");
  process.exit(3);
}

/**
 * Verify we have exclusive access to the db file WITHOUT deleting anything.
 * On Windows a file held open by another process cannot be renamed, so a
 * round-trip rename surfaces the lock first — letting us bail out before any
 * destructive step instead of corrupting a live database mid-unlink.
 */
function assertNotLocked() {
  if (!existsSync(DB_PATH)) return;
  const probe = DB_PATH + ".repair-lock-probe";
  try {
    renameSync(DB_PATH, probe);
    renameSync(probe, DB_PATH);
  } catch (err) {
    if (LOCK_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) abortLocked();
    throw err;
  }
}

function dbUrl(): string {
  return pathToFileURL(DB_PATH).href;
}

async function runMigrations(): Promise<void> {
  // Use the hardened in-house migrator (applyMigrations), NOT drizzle-orm's migrate().
  // On non-LTS Node the libsql@0.4.7 binding throws a spurious "SQLITE_OK: not an error"
  // on the first CREATE TABLE IF NOT EXISTS. drizzle-orm's migrate() aborts on it, and
  // catching-then-assuming-"up to date" (the previous impl) silently applied ZERO
  // migrations on a fresh/empty db. applyMigrations ignores that error PER STATEMENT
  // and continues, so repair actually brings an empty db fully up to date.
  const client = await createClientWithPragmas(dbUrl());
  try {
    await applyMigrations(client);
    log("migrations applied (schema up to date).");
  } finally {
    client.close();
  }
}

/**
 * Align live FK actions to the Drizzle schema (arch-review #881). Migrations bring
 * the schema *shape* up to date, but they cannot retro-fit an `ON DELETE` action onto
 * a table an older DB created without it — SQLite has no `ALTER ... FOREIGN KEY`. This
 * detects FK-action drift and rebuilds only the drifted tables (data-preserving;
 * column shape untouched). A backup was already taken at the top of main().
 */
async function alignFks(): Promise<void> {
  const client = await createClientWithPragmas(dbUrl());
  try {
    const result = await alignForeignKeyActions(client);
    if (result.driftedTables.length === 0) {
      log("FK actions already match the schema (no drift).");
      return;
    }
    for (const m of result.mismatches) {
      log(`  drift: ${m.table}.${m.fk} ${m.field} — schema=${m.expected} live=${m.actual}`);
    }
    log(`FK-action drift aligned by rebuilding: ${result.rebuiltTables.join(", ")}`);
  } finally {
    client.close();
  }
}

/**
 * FK-VIOLATION repair (#987). `PRAGMA foreign_keys=ON` only guards new writes —
 * rows inserted by past connections without the pragma (ad-hoc scripts) can already
 * violate FKs, and neither migrations nor the FK-action alignment above touch them.
 * This step reports every violating row, dumps the full rows to a quarantine JSON
 * next to the DB, then deletes them inside one transaction. Clean DB = no-op.
 */
async function repairFkViolations(): Promise<void> {
  const client = await createClientWithPragmas(dbUrl());
  try {
    const result = await quarantineAndDeleteFkViolations(client, dirname(DB_PATH));
    if (result.violations.length === 0) {
      log("foreign_key_check: no FK violations (existing data is consistent).");
      return;
    }
    log(`foreign_key_check found ${result.violations.length} FK-violating row(s):`);
    for (const v of result.violations) {
      log(`  ${v.table} rowid=${v.rowid ?? "?"} → missing ${v.parent} (fk #${v.fkid}) row=${v.snippet}`);
    }
    log(`quarantined full rows to: ${result.quarantinePath}`);
    log(`deleted ${result.deletedRows} orphaned row(s) in one transaction.`);
    if (result.remaining === 0) {
      log("re-check: foreign_key_check now reports 0 violations.");
    } else {
      log(`WARNING: re-check still reports ${result.remaining} violation(s) — inspect manually.`);
    }
  } finally {
    client.close();
  }
}

/**
 * Invalid-UTF-8 TEXT repair (arch-review #960). A row containing invalid UTF-8
 * makes libsql PANIC the whole process on a plain SELECT — this must run via the
 * tolerant BLOB-cast reader (`utf8-repair.ts`), never a bare `SELECT *`. Repairs
 * in place (UPDATE), never deletes.
 */
async function repairInvalidUtf8(): Promise<void> {
  const client = await createClientWithPragmas(dbUrl());
  try {
    const result = await repairInvalidUtf8Rows(client, [...UTF8_REPAIR_TABLES], dirname(DB_PATH));
    if (result.violations.length === 0) {
      log("invalid-UTF-8 scan: no invalid-UTF-8 TEXT values found.");
      return;
    }
    log(`invalid-UTF-8 scan found ${result.violations.length} affected row(s):`);
    for (const v of result.violations) {
      log(`  ${v.table} rowid=${v.rowid} columns=${Object.keys(v.columns).join(", ")}`);
    }
    log(`quarantine dump written to: ${result.quarantinePath}`);
    log(`repaired ${result.repairedRows} row(s) in place (UPDATE, not delete).`);
  } finally {
    client.close();
  }
}

async function main() {
  log(`target: ${DB_PATH}`);

  // 1. Back up first, always — single, verified, consistent backup primitive.
  try {
    const result = await createBackup("pre-repair");
    log(result ? `backup written to ${result.path} (${result.bytes} bytes, verified)` : "no backup needed (db missing or empty).");
  } catch (err) {
    // A failing VACUUM INTO often means the db is unusable/locked — keep going so
    // the diagnosis below can report the real problem, but warn loudly.
    log(`WARNING: pre-repair backup failed: ${err instanceof Error ? err.message : String(err)}`);
    log(`(backup dir: ${backupDir()})`);
  }

  // 2. Diagnose validity.
  const exists = existsSync(DB_PATH);
  const size = exists ? statSync(DB_PATH).size : 0;
  let usable = exists && size > 0;

  if (usable) {
    let client: ReturnType<typeof createClient> | null = null;
    try {
      // Standard pragmas (incl. foreign_keys=ON) via the shared factory (#987); on a
      // corrupt file this throws SQLITE_NOTADB, handled just like the checkpoint below.
      client = await createClientWithPragmas(dbUrl());
      // Flush any stale WAL into the main db; truncates the -wal file on success.
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      log("WAL checkpoint complete.");
      const res = await client.execute("PRAGMA integrity_check");
      const integrityRow = res.rows[0] as { integrity_check?: string } | undefined;
      const verdict = String(integrityRow?.integrity_check ?? "");
      if (verdict === "ok") {
        log("integrity_check: ok.");
      } else {
        log(`integrity_check reported issues: ${verdict}`);
        usable = false;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "SQLITE_NOTADB") {
        log("file exists but is NOT a valid SQLite database.");
        usable = false;
      } else if (code === "SQLITE_BUSY" || code === "EBUSY") {
        log("database is LOCKED. Stop the dev server / kill orphaned tsx processes, then retry:");
        log("  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tsx*src/index*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
        client?.close();
        process.exit(1);
      } else {
        throw err;
      }
    } finally {
      client?.close();
    }
  } else {
    log(exists ? "db file is zero bytes." : "db file does not exist.");
  }

  // 3. If unusable, only recreate with explicit authorization.
  if (!usable) {
    if (!force) {
      log("");
      log("The database is unusable and cannot be repaired in place.");
      log("A backup was taken above (if there was anything to save).");
      log("To recreate an empty database and re-run migrations, CONFIRM WITH THE USER, then run:");
      log("  pnpm db:repair --force        (or set ALLOW_DB_DESTROY=1)");
      log("Followed by: pnpm db:seed");
      process.exit(2);
    }
    log("--force set — recreating empty database (backup already taken).");
    // Never destroy a db another process still holds open: probe for a lock first.
    assertNotLocked();
    for (const s of SIDECARS) {
      const f = DB_PATH + s;
      if (!existsSync(f)) continue;
      try {
        unlinkSync(f);
      } catch (err) {
        if (LOCK_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) abortLocked();
        throw err;
      }
    }
    writeFileSync(DB_PATH, "");
  }

  // 4. Bring schema up to date.
  await runMigrations();

  // 5. Align FK actions the migrations can't retro-fit (#881). Skipped when the db
  //    was just recreated empty (a fresh migrate already produces correct FKs).
  if (usable) {
    try {
      await alignFks();
    } catch (err) {
      log(`WARNING: FK-action alignment failed (schema is still up to date): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Quarantine + delete rows that ALREADY violate FKs (#987) — pre-existing
    //    orphans the per-connection pragma can't catch. Backup was taken in step 1;
    //    the step writes its own quarantine JSON next to the DB before deleting.
    try {
      await repairFkViolations();
    } catch (err) {
      log(`WARNING: FK-violation repair failed (nothing was deleted — the delete is transactional): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 7. Repair rows with invalid-UTF-8 TEXT columns (#960) — these PANIC the whole
    //    process on a plain SELECT, so this must run via the tolerant BLOB-cast
    //    reader. Repairs in place; never deletes.
    try {
      await repairInvalidUtf8();
    } catch (err) {
      log(`WARNING: invalid-UTF-8 repair failed (nothing was changed — the update is transactional): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log("done. If you recreated the db, run `pnpm db:seed` next.");
}

main().catch((err) => {
  console.error("[db:repair] failed:", err);
  process.exit(1);
});
