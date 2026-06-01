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
  copyFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
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

interface LiveRowCounts {
  projects: number;
  issues: number;
}

interface CreateBackupOptions {
  verify?: (path: string) => Promise<true>;
}

async function unlinkIfExists(path: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if (existsSync(path)) unlinkSync(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export function backupDir(): string {
  return BACKUP_DIR;
}

/** Count key rows in the LIVE database (0 for a table if unreadable). */
export async function liveRowCounts(): Promise<LiveRowCounts> {
  if (!existsSync(DB_PATH) || statSync(DB_PATH).size === 0) {
    return { projects: 0, issues: 0 };
  }
  const c = createClient({ url: getDbUrl() });
  try {
    const projects = await c
      .execute("SELECT count(*) c FROM projects")
      .catch(() => ({ rows: [{ c: 0 }] }));
    const issues = await c
      .execute("SELECT count(*) c FROM issues")
      .catch(() => ({ rows: [{ c: 0 }] }));
    return {
      projects: Number(projects.rows[0]?.c ?? 0),
      issues: Number(issues.rows[0]?.c ?? 0),
    };
  } catch {
    return { projects: 0, issues: 0 };
  } finally {
    c.close();
  }
}

/** Count rows in the `projects` table of the LIVE database (0 if unreadable). */
export async function liveProjectCount(): Promise<number> {
  return (await liveRowCounts()).projects;
}

/**
 * Verify a backup file is restorable. Throws on any failure:
 *  - PRAGMA integrity_check must report "ok"
 *  - if the backup has 0 projects/issues while the LIVE db has any, refuse it
 *    (the exact "empty-when-live-is-not" trap that caused a silent data loss).
 */
export async function verifyBackup(path: string): Promise<true> {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`backup missing or empty: ${path}`);
  }
  const c = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = c
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check?: string } | undefined;
    const verdict = String(integrity?.integrity_check ?? "");
    if (verdict !== "ok") {
      throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
    }
    const projects = c
      .prepare("SELECT count(*) c FROM projects")
      .get() as { c?: number } | undefined;
    const backupProjects = Number(projects?.c ?? 0);
    const issues = c
      .prepare("SELECT count(*) c FROM issues")
      .get() as { c?: number } | undefined;
    const backupIssues = Number(issues?.c ?? 0);
    const live = await liveRowCounts();
    if (backupIssues === 0 && live.issues > 0) {
      throw new Error(
        "backup has 0 issues but live DB has >0 - refusing as corrupt/empty",
      );
    }
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
export async function createBackup(
  reason: string,
  options: CreateBackupOptions = {},
): Promise<BackupResult | null> {
  if (!existsSync(DB_PATH) || statSync(DB_PATH).size === 0) return null;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dest = join(BACKUP_DIR, `kanban-${stamp}-${safeReason}.db`);
  const tmpDest = `${dest}.tmp`;

  const client = createClient({ url: getDbUrl() });
  try {
    // VACUUM INTO produces a consistent single-file snapshot even while the DB
    // is in WAL mode and being written to. The path must be a literal in the SQL,
    // so escape single quotes.
    await client.execute(`VACUUM INTO '${tmpDest.replace(/'/g, "''")}'`);
  } finally {
    client.close();
  }

  try {
    await (options.verify ?? verifyBackup)(tmpDest); // throws on failure
    copyFileSync(tmpDest, dest);
    await unlinkIfExists(tmpDest);
  } catch (err) {
    await unlinkIfExists(tmpDest);
    throw err;
  }
  pruneBackups(KEEP_LAST);
  return { path: dest, bytes: statSync(dest).size, verified: true };
}
