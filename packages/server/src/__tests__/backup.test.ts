import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, statSync, writeFileSync, readdirSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { pathToFileURL } from "node:url";

/**
 * The backup module captures DATA_DIR / DB_PATH / BACKUP_DIR at import time from
 * env vars. So for each test we set a fresh temp dir, then dynamically import the
 * module after vi.resetModules() so it picks up the temp paths.
 */

let tmpDir: string;
let dbPath: string;
let backupDir: string;

async function seedDb(url: string, projectCount: number, issueCount = 0) {
  const c = createClient({ url });
  try {
    await c.execute("PRAGMA journal_mode=WAL");
    await c.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT)");
    await c.execute("CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, title TEXT)");
    for (let i = 0; i < projectCount; i++) {
      await c.execute({ sql: "INSERT INTO projects (id, name) VALUES (?, ?)", args: [`p${i}`, `Project ${i}`] });
    }
    for (let i = 0; i < issueCount; i++) {
      await c.execute({ sql: "INSERT INTO issues (id, title) VALUES (?, ?)", args: [`i${i}`, `Issue ${i}`] });
    }
  } finally {
    c.close();
  }
}

async function rowCount(url: string, table: string): Promise<number> {
  const c = createClient({ url });
  try {
    const r = await c.execute(`SELECT count(*) c FROM ${table}`);
    return Number(r.rows[0]?.c ?? 0);
  } finally {
    c.close();
  }
}

async function loadBackupModule() {
  vi.resetModules();
  return import("../db/backup.js");
}

describe("db backup", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kanban-backup-test-"));
    dbPath = join(tmpDir, "kanban.db");
    backupDir = join(tmpDir, ".db-backups");
    process.env.AGENTIC_KANBAN_DIR = tmpDir;
    process.env.AGENTIC_KANBAN_BACKUP_DIR = backupDir;
    process.env.DB_URL = pathToFileURL(dbPath).href;
  });

  afterEach(async () => {
    delete process.env.AGENTIC_KANBAN_DIR;
    delete process.env.AGENTIC_KANBAN_BACKUP_DIR;
    delete process.env.DB_URL;
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("createBackup verifies ok and matches source counts", async () => {
    await seedDb(process.env.DB_URL!, 2, 5);
    const { createBackup } = await loadBackupModule();

    const result = await createBackup("test");
    expect(result).not.toBeNull();
    expect(result!.verified).toBe(true);
    expect(existsSync(result!.path)).toBe(true);
    expect(result!.bytes).toBeGreaterThan(0);

    const backupUrl = pathToFileURL(result!.path).href;
    expect(await rowCount(backupUrl, "projects")).toBe(2);
    expect(await rowCount(backupUrl, "issues")).toBe(5);
  }, 30000);

  it("returns null when db is missing or empty", async () => {
    const { createBackup } = await loadBackupModule();
    // Missing
    expect(await createBackup("test")).toBeNull();
    // Empty (zero-byte) file
    writeFileSync(dbPath, "");
    const mod = await loadBackupModule();
    expect(await mod.createBackup("test")).toBeNull();
  }, 30000);

  it("backup taken during an in-flight write is consistent (committed snapshot only)", async () => {
    await seedDb(process.env.DB_URL!, 1, 1);
    const { createBackup } = await loadBackupModule();

    // Open a separate connection and begin (but do not commit) a write.
    const writer = createClient({ url: process.env.DB_URL! });
    await writer.execute("BEGIN");
    await writer.execute({ sql: "INSERT INTO issues (id, title) VALUES (?, ?)", args: ["uncommitted", "nope"] });

    // VACUUM INTO captures only committed state.
    const result = await createBackup("inflight");
    expect(result).not.toBeNull();

    await writer.execute("ROLLBACK");
    writer.close();

    const backupUrl = pathToFileURL(result!.path).href;
    // The uncommitted row must NOT be in the backup.
    expect(await rowCount(backupUrl, "issues")).toBe(1);
  }, 30000);

  it("verifyBackup rejects a truncated/corrupt file", async () => {
    await seedDb(process.env.DB_URL!, 1, 0);
    const { createBackup, verifyBackup } = await loadBackupModule();
    const result = await createBackup("test");
    expect(result).not.toBeNull();

    // Truncate the backup to corrupt it.
    writeFileSync(result!.path, "not a database");
    await expect(verifyBackup(result!.path)).rejects.toThrow();
  }, 30000);

  it("verifyBackup rejects a 0-project backup when live has projects", async () => {
    // Live db has projects.
    await seedDb(process.env.DB_URL!, 3, 0);
    const { verifyBackup } = await loadBackupModule();

    // Create a separate, empty-of-projects backup file.
    const emptyBackup = join(tmpDir, "empty-backup.db");
    await seedDb(pathToFileURL(emptyBackup).href, 0, 0);

    await expect(verifyBackup(emptyBackup)).rejects.toThrow(/0 projects/);
  }, 30000);

  it("verifyBackup rejects a 0-issue backup when live has issues", async () => {
    await seedDb(process.env.DB_URL!, 0, 3);
    const { verifyBackup } = await loadBackupModule();

    const emptyBackup = join(tmpDir, "empty-issues-backup.db");
    await seedDb(pathToFileURL(emptyBackup).href, 0, 0);

    await expect(verifyBackup(emptyBackup)).rejects.toThrow(/0 issues/);
  }, 30000);

  it("does not promote a backup that fails verification and preserves the previous good backup", async () => {
    await seedDb(process.env.DB_URL!, 1, 1);
    const { createBackup } = await loadBackupModule();

    const first = await createBackup("known-good");
    expect(first).not.toBeNull();
    const before = readdirSync(backupDir)
      .filter((f) => /^kanban-.+\.db$/.test(f))
      .sort();

    await expect(
      createBackup("fails-validation", {
        verify: async () => {
          throw new Error("forced verification failure");
        },
      }),
    ).rejects.toThrow(/forced verification failure/);

    const after = readdirSync(backupDir)
      .filter((f) => /^kanban-.+\.db$/.test(f))
      .sort();
    const temps = readdirSync(backupDir).filter((f) => f.endsWith(".tmp"));
    expect(after).toEqual(before);
    expect(temps).toEqual([]);
    expect(existsSync(first!.path)).toBe(true);
  }, 30000);

  it("pruneBackups keeps exactly KEEP_LAST and never deletes the last one", async () => {
    const { pruneBackups, KEEP_LAST } = await loadBackupModule();
    expect(KEEP_LAST).toBe(5);

    // Create more than KEEP_LAST raw backup files with distinct, increasing mtimes.
    mkdirSync(backupDir, { recursive: true });
    const total = KEEP_LAST + 3;
    const paths: string[] = [];
    for (let i = 0; i < total; i++) {
      const p = join(backupDir, `kanban-2026-05-27T00-00-0${i}-000Z-b${i}.db`);
      writeFileSync(p, `backup ${i}`);
      const t = new Date(Date.now() + i * 1000);
      utimesSync(p, t, t);
      paths.push(p);
    }

    pruneBackups(KEEP_LAST);
    const remaining = readdirSync(backupDir).filter((f) => /^kanban-.+\.db$/.test(f));
    expect(remaining.length).toBe(KEEP_LAST);
    // The 5 NEWEST must survive (highest indices).
    expect(remaining).toContain(`kanban-2026-05-27T00-00-0${total - 1}-000Z-b${total - 1}.db`);

    // Never delete down to zero.
    pruneBackups(0);
    const afterZero = readdirSync(backupDir).filter((f) => /^kanban-.+\.db$/.test(f));
    expect(afterZero.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("db restore round-trip: seed -> backup -> wipe -> restore -> counts match", async () => {
    // Seed the live db and back it up.
    await seedDb(process.env.DB_URL!, 2, 4);
    const { createBackup, verifyBackup } = await loadBackupModule();
    const backup = await createBackup("roundtrip");
    expect(backup).not.toBeNull();

    // Confirm the live db can be "wiped" to an empty-of-projects state.
    const wipedDb = join(tmpDir, "wiped.db");
    const wipedUrl = pathToFileURL(wipedDb).href;
    await seedDb(wipedUrl, 0, 0);
    expect(await rowCount(wipedUrl, "projects")).toBe(0);

    // Restore: verify the backup, then copy it into a fresh, never-opened db path
    // (mirrors the CLI's atomic swap; avoids Windows WAL-handle lock fights in-test).
    await verifyBackup(backup!.path);
    const { copyFileSync } = await import("node:fs");
    const restoredDb = join(tmpDir, "restored.db");
    copyFileSync(backup!.path, restoredDb);
    const restoredUrl = pathToFileURL(restoredDb).href;

    expect(await rowCount(restoredUrl, "projects")).toBe(2);
    expect(await rowCount(restoredUrl, "issues")).toBe(4);
  }, 30000);
});
