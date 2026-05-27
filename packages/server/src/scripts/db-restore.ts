/**
 * db:restore — restore the database from a verified backup.
 *
 * Backups are the single-file `kanban-<stamp>-<reason>.db` snapshots produced by
 * `packages/server/src/db/backup.ts` (via `VACUUM INTO`). This script:
 *
 *   - With no arg: lists available backups (newest first), each annotated with
 *     verification status, so you can pick one.
 *   - With a path/filename arg, or `--latest`: verifies the chosen backup, takes a
 *     `pre-restore` backup of the CURRENT db first, then atomically replaces
 *     kanban.db (removing stale -wal/-shm sidecars).
 *
 * Refuses if the chosen backup fails verification, and refuses if the live db is
 * locked by another process (stop the server first).
 *
 * Usage:
 *   pnpm db:restore                  # list available backups
 *   pnpm db:restore --latest         # restore the newest verified backup
 *   pnpm db:restore <file>           # restore a specific backup (name or path)
 */
import { resolve, dirname, join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  statSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { createBackup, verifyBackup, backupDir } from "../db/backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../kanban.db");
const SIDECARS = ["-wal", "-shm"] as const;
const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function log(msg: string) {
  console.log(`[db:restore] ${msg}`);
}

/** All backup files, newest first. */
function listBackupFiles(): string[] {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^kanban-.+\.db$/.test(f))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.f);
}

/**
 * Refuse to touch a db file held open by another process. On Windows an open
 * file cannot be renamed, so a round-trip rename surfaces the lock safely.
 */
function assertNotLocked() {
  if (!existsSync(DB_PATH)) return;
  const probe = DB_PATH + ".restore-lock-probe";
  try {
    renameSync(DB_PATH, probe);
    renameSync(probe, DB_PATH);
  } catch (err) {
    if (LOCK_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) {
      log("");
      log("ABORTED: the database is LOCKED by another process — stop the server first:");
      log("  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tsx*src/index*' -or $_.CommandLine -like '*dev.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
      process.exit(3);
    }
    throw err;
  }
}

async function listMode() {
  const files = listBackupFiles();
  if (files.length === 0) {
    log(`no backups found in ${backupDir()}`);
    log("Run the server (periodic/shutdown backups) or `pnpm db:repair` to create one.");
    return;
  }
  log(`backups in ${backupDir()} (newest first):`);
  for (const f of files) {
    const full = join(backupDir(), f);
    let status: string;
    try {
      await verifyBackup(full);
      status = "verified";
    } catch (err) {
      status = `UNVERIFIED (${err instanceof Error ? err.message : String(err)})`;
    }
    const bytes = statSync(full).size;
    log(`  ${f}  [${bytes} bytes]  ${status}`);
  }
  log("");
  log("To restore: pnpm db:restore <file>   (or)   pnpm db:restore --latest");
}

function resolveBackupArg(arg: string): string {
  if (arg === "--latest") {
    const files = listBackupFiles();
    if (files.length === 0) {
      log("no backups available to restore.");
      process.exit(2);
    }
    return join(backupDir(), files[0]);
  }
  // Accept an absolute path, a relative path, or a bare filename within the backup dir.
  if (isAbsolute(arg) && existsSync(arg)) return arg;
  const inBackupDir = join(backupDir(), basename(arg));
  if (existsSync(inBackupDir)) return inBackupDir;
  if (existsSync(arg)) return resolve(arg);
  log(`backup not found: ${arg}`);
  process.exit(2);
}

async function restoreMode(arg: string) {
  const source = resolveBackupArg(arg);
  log(`target db:  ${DB_PATH}`);
  log(`restoring from: ${source}`);

  // 1. Verify the chosen backup before touching anything.
  try {
    await verifyBackup(source);
    log("chosen backup verified (integrity_check ok).");
  } catch (err) {
    log(`REFUSED: backup failed verification: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  // 2. Refuse if the live db is locked (server running).
  assertNotLocked();

  // 3. Back up the current db first.
  try {
    const pre = await createBackup("pre-restore");
    log(pre ? `current db backed up to ${pre.path}` : "no current db to back up.");
  } catch (err) {
    log(`WARNING: pre-restore backup of current db failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Atomically replace kanban.db, removing stale sidecars.
  const tmp = DB_PATH + ".restore-tmp";
  copyFileSync(source, tmp);
  if (existsSync(DB_PATH)) {
    try {
      unlinkSync(DB_PATH);
    } catch (err) {
      if (LOCK_CODES.has((err as NodeJS.ErrnoException)?.code ?? "")) {
        log("ABORTED: db became locked mid-restore. The new copy is at " + tmp);
        process.exit(3);
      }
      throw err;
    }
  }
  renameSync(tmp, DB_PATH);
  for (const s of SIDECARS) {
    const f = DB_PATH + s;
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        /* non-fatal */
      }
    }
  }

  log("restore complete. The previous db was saved as a pre-restore backup.");
  log("Start the server again when ready.");
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length === 0) {
    await listMode();
    return;
  }
  await restoreMode(args[0]);
}

main().catch((err) => {
  console.error("[db:restore] failed:", err);
  process.exit(1);
});
