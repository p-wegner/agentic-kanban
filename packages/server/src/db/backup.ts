/**
 * Single source of truth for database backups.
 *
 * Uses SQLite `VACUUM INTO` to write an internally-consistent, defragmented,
 * single-file snapshot of the live (WAL-mode) database — no -wal/-shm sidecars,
 * no mid-write/mid-migration inconsistency. Every backup is verified before it
 * is accepted, and a rotation of the last `KEEP_LAST` good copies is retained.
 *
 * Replaces the old raw `copyFileSync` approach in db-repair.ts.
 */
import { createClient } from "@libsql/client";
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, getDbUrl } from "./data-dir.js";

/** Number of most-recent verified backups to retain. */
export const KEEP_LAST = 5;

const BACKUP_DIR =
  process.env.AGENTIC_KANBAN_BACKUP_DIR || resolve(DATA_DIR, ".db-backups");
const DB_PATH = resolve(DATA_DIR, "kanban.db");

export interface BackupResult {
  path: string;
  bytes: number;
  verified: true;
}

export function backupDir(): string {
  return BACKUP_DIR;
}

/** Count rows in the `projects` table of the LIVE database (0 if unreadable). */
export async function liveProjectCount(): Promise<number> {
  if (!existsSync(DB_PATH) || statSync(DB_PATH).size === 0) return 0;
  const c = createClient({ url: getDbUrl() });
  try {
    const res = await c.execute("SELECT count(*) c FROM projects");
    return Number(res.rows[0]?.c ?? 0);
  } catch {
    return 0;
  } finally {
    c.close();
  }
}

/**
 * Verify a backup file is restorable. Throws on any failure:
 *  - PRAGMA integrity_check must report "ok"
 *  - if the backup has 0 projects while the LIVE db has >0, refuse it
 *    (the exact "empty-when-live-is-not" trap that caused a silent data loss).
 */
export async function verifyBackup(path: string): Promise<true> {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`backup missing or empty: ${path}`);
  }
  const c = createClient({ url: pathToFileURL(path).href });
  try {
    const integrity = await c.execute("PRAGMA integrity_check");
    const verdict = String(integrity.rows[0]?.integrity_check ?? "");
    if (verdict !== "ok") {
      throw new Error(`integrity_check failed: ${JSON.stringify(integrity.rows[0])}`);
    }
    const projects = await c.execute("SELECT count(*) c FROM projects");
    const backupProjects = Number(projects.rows[0]?.c ?? 0);
    if (backupProjects === 0 && (await liveProjectCount()) > 0) {
      throw new Error(
        "backup has 0 projects but live DB has >0 — refusing as corrupt/empty",
      );
    }
    return true;
  } finally {
    c.close();
  }
}

/**
 * Keep the `keep` most recent `kanban-*.db` files; delete the rest.
 * Never deletes if doing so would leave zero backups.
 */
export function pruneBackups(keep: number): void {
  try {
    if (!existsSync(BACKUP_DIR)) return;
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => /^kanban-.+\.db$/.test(f))
      .map((f) => ({ f, m: statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m); // newest first
    if (files.length <= keep) return;
    const toDelete = files.slice(Math.max(keep, 0));
    // Safety: never delete down to zero.
    if (files.length - toDelete.length < 1) return;
    for (const { f } of toDelete) {
      try {
        unlinkSync(join(BACKUP_DIR, f));
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Create an internally-consistent backup of the live DB via `VACUUM INTO`.
 * Verifies the result before returning (throws if verification fails) and
 * prunes old backups afterward. Returns null if the live db is missing/empty.
 */
export async function createBackup(reason: string): Promise<BackupResult | null> {
  if (!existsSync(DB_PATH) || statSync(DB_PATH).size === 0) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dest = join(BACKUP_DIR, `kanban-${stamp}-${safeReason}.db`);

  const client = createClient({ url: getDbUrl() });
  try {
    // VACUUM INTO produces a consistent single-file snapshot even while the DB
    // is in WAL mode and being written to. The path must be a literal in the SQL,
    // so escape single quotes.
    await client.execute(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    client.close();
  }

  await verifyBackup(dest); // throws on failure
  pruneBackups(KEEP_LAST);
  return { path: dest, bytes: statSync(dest).size, verified: true };
}
