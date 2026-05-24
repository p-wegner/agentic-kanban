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

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, statSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { getMigrationsFolder } from "../db/migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../kanban.db");
const BACKUP_DIR = resolve(__dirname, "../../.db-backups");
const SIDECARS = ["", "-wal", "-shm"] as const;

const force = process.argv.includes("--force") || process.env.ALLOW_DB_DESTROY === "1";

function log(msg: string) {
  console.log(`[db:repair] ${msg}`);
}

/** Copy db + sidecars to a timestamped backup. Returns the backup dir, or null if nothing to back up. */
function backup(): string | null {
  if (!existsSync(DB_PATH) || statSync(DB_PATH).size === 0) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const s of SIDECARS) {
    const src = DB_PATH + s;
    if (existsSync(src)) copyFileSync(src, join(BACKUP_DIR, `kanban-${stamp}.db${s}`));
  }
  pruneBackups(10);
  return BACKUP_DIR;
}

function pruneBackups(keep: number) {
  try {
    const stamps = new Set<string>();
    for (const f of readdirSync(BACKUP_DIR)) {
      const m = f.match(/^kanban-(.+?)\.db(?:-wal|-shm)?$/);
      if (m) stamps.add(m[1]);
    }
    const sorted = [...stamps].sort();
    for (const stamp of sorted.slice(0, Math.max(0, sorted.length - keep))) {
      for (const s of SIDECARS) {
        const f = join(BACKUP_DIR, `kanban-${stamp}.db${s}`);
        if (existsSync(f)) unlinkSync(f);
      }
    }
  } catch {
    /* non-fatal */
  }
}

function dbUrl(): string {
  return pathToFileURL(DB_PATH).href;
}

async function runMigrations(): Promise<void> {
  const client = createClient({ url: dbUrl() });
  const db = drizzle({ client });
  try {
    await migrate(db, { migrationsFolder: getMigrationsFolder() });
    log("migrations applied (schema up to date).");
  } catch (err: unknown) {
    // Known libsql@0.4.7 + Node bug: CREATE TABLE IF NOT EXISTS on an existing table
    // returns SQLITE_OK which libsql misreports as an error. Safe to ignore.
    const spurious =
      err instanceof Error &&
      err.message.includes("not an error") &&
      (err as NodeJS.ErrnoException).code === "SQLITE_OK";
    if (!spurious) throw err;
    log("ignored known libsql SQLITE_OK false-error — db already up to date.");
  } finally {
    client.close();
  }
}

async function main() {
  log(`target: ${DB_PATH}`);

  // 1. Back up first, always.
  const backupDir = backup();
  log(backupDir ? `backup written to ${backupDir}` : "no backup needed (db missing or empty).");

  // 2. Diagnose validity.
  const exists = existsSync(DB_PATH);
  const size = exists ? statSync(DB_PATH).size : 0;
  let usable = exists && size > 0;

  if (usable) {
    const client = createClient({ url: dbUrl() });
    try {
      // Flush any stale WAL into the main db; truncates the -wal file on success.
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      log("WAL checkpoint complete.");
      const res = await client.execute("PRAGMA integrity_check");
      const verdict = String(res.rows[0]?.integrity_check ?? "");
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
        client.close();
        process.exit(1);
      } else {
        throw err;
      }
    } finally {
      client.close();
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
    for (const s of SIDECARS) {
      const f = DB_PATH + s;
      if (existsSync(f)) unlinkSync(f);
    }
    writeFileSync(DB_PATH, "");
  }

  // 4. Bring schema up to date.
  await runMigrations();
  log("done. If you recreated the db, run `pnpm db:seed` next.");
}

main().catch((err) => {
  console.error("[db:repair] failed:", err);
  process.exit(1);
});
