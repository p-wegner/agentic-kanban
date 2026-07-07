import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  applyMigrations,
  LEGACY_IDEMPOTENCY_CUTOFF_IDX,
} from "../db/manual-migrate.js";

/**
 * Runner-behaviour tests for the manual migrator (#954):
 *  - a mid-file failure rolls the whole migration file back atomically and
 *    stops the run (later migrations are not attempted),
 *  - a journaled-but-missing .sql file is a hard error (no silent skip),
 *  - the "duplicate column/already exists" idempotency shim only fires for
 *    legacy migrations (idx <= LEGACY_IDEMPOTENCY_CUTOFF_IDX).
 *
 * Uses a synthetic migrations folder injected via the `folder` option and a
 * file-backed temp DB (in-memory libsql loses state across transactions on
 * newer Node — see helpers/test-db.ts).
 */

interface SyntheticMigration {
  idx: number;
  tag: string;
  sql?: string; // omit to journal the entry WITHOUT writing the file
}

let tempPaths: string[] = [];

function makeMigrationsFolder(migrations: SyntheticMigration[]): string {
  const folder = join(tmpdir(), `manual-migrate-test-${randomUUID()}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const entries = migrations.map((m, i) => ({
    idx: m.idx,
    version: "6",
    when: 1780906800000 + i,
    tag: m.tag,
    breakpoints: true,
  }));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
  for (const m of migrations) {
    if (m.sql !== undefined) writeFileSync(join(folder, `${m.tag}.sql`), m.sql);
  }
  tempPaths.push(folder);
  return folder;
}

function makeDb(): Client {
  const file = join(tmpdir(), `manual-migrate-test-${randomUUID()}.db`);
  tempPaths.push(file, `${file}-wal`, `${file}-shm`);
  return createClient({ url: `file:${file}` });
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const res = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return res.rows.length === 1;
}

async function appliedTags(client: Client): Promise<string[]> {
  const res = await client.execute("SELECT hash FROM __drizzle_migrations ORDER BY id");
  return res.rows.map((r) => String((r as { hash?: string }).hash));
}

describe("applyMigrations (#954)", () => {
  let client: Client;

  beforeEach(() => {
    tempPaths = [];
    client = makeDb();
  });

  afterEach(() => {
    try {
      client.close();
    } catch { /* ignore */ }
    for (const p of tempPaths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    vi.restoreAllMocks();
  });

  it("applies a well-formed migration and records it", async () => {
    const folder = makeMigrationsFolder([
      { idx: 0, tag: "0000_good", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO a (id) VALUES (1);" },
    ]);
    await applyMigrations(client, { folder });
    expect(await tableExists(client, "a")).toBe(true);
    expect(await appliedTags(client)).toEqual(["0000_good"]);
    // Idempotent: re-run skips by tag without error.
    await applyMigrations(client, { folder });
    expect(await appliedTags(client)).toEqual(["0000_good"]);
  });

  it("rolls back the whole file atomically on a mid-file failure and stops the run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: "0000_bad_middle",
        sql: [
          "CREATE TABLE b (id INTEGER PRIMARY KEY);",
          "INSERT INTO b (id) VALUES (1);",
          "INSERT INTO no_such_table (id) VALUES (1);", // fails
        ].join("\n--> statement-breakpoint\n"),
      },
      { idx: 1, tag: "0001_never_reached", sql: "CREATE TABLE c (id INTEGER PRIMARY KEY);" },
    ]);

    await expect(applyMigrations(client, { folder })).rejects.toThrow(/0000_bad_middle/);
    // Atomic rollback: neither the DDL nor the data statement survived.
    expect(await tableExists(client, "b")).toBe(false);
    // Stopped: the later migration was never attempted.
    expect(await tableExists(client, "c")).toBe(false);
    expect(await appliedTags(client)).toEqual([]);
  });

  it("throws a hard error for a journaled-but-missing SQL file (no silent skip)", async () => {
    const folder = makeMigrationsFolder([
      { idx: 0, tag: "0000_present", sql: "CREATE TABLE d (id INTEGER PRIMARY KEY);" },
      { idx: 1, tag: "0001_missing_file" }, // journaled, no .sql on disk
    ]);
    await expect(applyMigrations(client, { folder })).rejects.toThrow(/0001_missing_file.*no SQL file/s);
  });

  it("tolerates 'already exists' for a LEGACY migration (idx <= cutoff) with a loud warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await client.execute("CREATE TABLE legacy_t (id INTEGER PRIMARY KEY)"); // pre-applied state
    const folder = makeMigrationsFolder([
      {
        idx: LEGACY_IDEMPOTENCY_CUTOFF_IDX,
        tag: "0096_legacy_partial",
        sql: "CREATE TABLE legacy_t (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nCREATE TABLE legacy_t2 (id INTEGER PRIMARY KEY);",
      },
    ]);
    await applyMigrations(client, { folder });
    // Remaining statements still ran, migration recorded.
    expect(await tableExists(client, "legacy_t2")).toBe(true);
    expect(await appliedTags(client)).toEqual(["0096_legacy_partial"]);
    // The shim never fires silently.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0096_legacy_partial"));
  });

  it("does NOT tolerate 'already exists' for a post-cutoff migration — rolls back and throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await client.execute("CREATE TABLE new_t (id INTEGER PRIMARY KEY)");
    const folder = makeMigrationsFolder([
      {
        idx: LEGACY_IDEMPOTENCY_CUTOFF_IDX + 1,
        tag: "0097_new_migration",
        sql: "CREATE TABLE new_t (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nCREATE TABLE new_t2 (id INTEGER PRIMARY KEY);",
      },
    ]);
    await expect(applyMigrations(client, { folder })).rejects.toThrow(/0097_new_migration/);
    expect(await tableExists(client, "new_t2")).toBe(false);
    expect(await appliedTags(client)).toEqual([]);
  });
});

/**
 * Regression for arch-review 2026-07-07 §3.1 (CRITICAL):
 *
 * The runner wrapped EVERY migration file in `client.transaction("write")`, but
 * SQLite documents `PRAGMA foreign_keys` as a NO-OP while a transaction is open.
 * The FK-toggling "table rebuild" migrations (0010/0039/0096: OFF → create `_new`
 * → copy → DROP the old table → rename → ON) therefore ran under the connection's
 * ambient FK state. The live server connection has `foreign_keys=ON` (pragmas.ts),
 * so on a POPULATED pre-0039 DB the `DROP TABLE projects` fired implicit-delete FK
 * checks against the still-populated children and ABORTED the migration — masked
 * only because fresh DBs replay the rebuild on empty tables.
 *
 * These tests reproduce that populated-DB scenario with FK enforcement ON and
 * assert the fix: FK-toggling migrations run outside the transaction so the pragma
 * actually takes effect, the rebuild succeeds, data is preserved, and the
 * connection's FK-enforcement state is restored afterward.
 */
describe("applyMigrations — FK-toggling migrations on a populated DB (arch-review §3.1)", () => {
  let client: Client;

  beforeEach(() => {
    tempPaths = [];
    client = makeDb();
  });

  afterEach(() => {
    try {
      client.close();
    } catch { /* ignore */ }
    for (const p of tempPaths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    vi.restoreAllMocks();
  });

  async function foreignKeysOn(c: Client): Promise<boolean> {
    const res = await c.execute("PRAGMA foreign_keys");
    return Number(Object.values(res.rows[0] as Record<string, unknown>)[0]) === 1;
  }

  it("runs a PRAGMA-toggling parent-table rebuild on a populated DB with FK ON, preserving data", async () => {
    // Mirror the live server connection: FK enforcement ON (pragmas.ts). Under the
    // old tx-wrapped runner the PRAGMA foreign_keys=OFF below was a no-op, so the
    // DROP TABLE parent aborted with a FOREIGN KEY constraint failure.
    await client.execute("PRAGMA foreign_keys=ON");
    expect(await foreignKeysOn(client)).toBe(true);

    const folder = makeMigrationsFolder([
      {
        idx: 0,
        tag: "0000_seed_populated",
        sql: [
          "CREATE TABLE parent (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
          // ON DELETE no action (default/restrict), mirroring 0039's projects children:
          // dropping the parent while a child row still references it must raise an FK error
          // when enforcement is genuinely ON.
          "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL, FOREIGN KEY (parent_id) REFERENCES parent(id) ON UPDATE no action ON DELETE no action)",
          "INSERT INTO parent (id, name) VALUES ('p1', 'Project One')",
          "INSERT INTO child (id, parent_id) VALUES (1, 'p1')",
          "INSERT INTO child (id, parent_id) VALUES (2, 'p1')",
        ].join("\n--> statement-breakpoint\n"),
      },
      {
        idx: 1,
        tag: "0001_rebuild_parent",
        // The 0039 shape: FK off, rebuild the parent table (adding a nullable column),
        // DROP the old parent, rename, FK on.
        sql: [
          "PRAGMA foreign_keys=OFF",
          "CREATE TABLE parent_new (id TEXT PRIMARY KEY, name TEXT, extra TEXT)",
          "INSERT INTO parent_new (id, name) SELECT id, name FROM parent",
          "DROP TABLE parent",
          "ALTER TABLE parent_new RENAME TO parent",
          "PRAGMA foreign_keys=ON",
        ].join("\n--> statement-breakpoint\n"),
      },
    ]);

    await applyMigrations(client, { folder });

    // Both migrations recorded — the rebuild did not abort.
    expect(await appliedTags(client)).toEqual(["0000_seed_populated", "0001_rebuild_parent"]);

    // Parent data preserved and the new column exists.
    const parent = await client.execute("SELECT id, name, extra FROM parent");
    expect(parent.rows).toHaveLength(1);
    expect(String((parent.rows[0] as { name?: unknown }).name)).toBe("Project One");

    // Child rows preserved (not cascade-deleted, not orphaned) and still resolve to the parent.
    const children = await client.execute("SELECT parent_id FROM child ORDER BY id");
    expect(children.rows).toHaveLength(2);
    expect(children.rows.map((r) => String((r as { parent_id?: unknown }).parent_id))).toEqual(["p1", "p1"]);

    // FK enforcement is genuinely restored ON after the migration run.
    expect(await foreignKeysOn(client)).toBe(true);
  });

  it("restores the connection's prior FK state (ON) even when a FK-toggling migration aborts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await client.execute("PRAGMA foreign_keys=ON");

    const folder = makeMigrationsFolder([
      {
        // Above the legacy cutoff so the idempotency shim cannot mask the failure.
        idx: LEGACY_IDEMPOTENCY_CUTOFF_IDX + 1,
        tag: "0097_fk_toggle_fails",
        sql: [
          "PRAGMA foreign_keys=OFF",
          "CREATE TABLE t (id INTEGER PRIMARY KEY)",
          "INSERT INTO no_such_table (id) VALUES (1)", // fails
          "PRAGMA foreign_keys=ON",
        ].join("\n--> statement-breakpoint\n"),
      },
    ]);

    await expect(applyMigrations(client, { folder })).rejects.toThrow(/0097_fk_toggle_fails/);
    // Migration not recorded (aborted before the bookkeeping insert).
    expect(await appliedTags(client)).toEqual([]);
    // Prior FK-enforcement state restored despite the mid-migration abort (the ON
    // statement never ran) — a broken migration must not leave FK silently OFF.
    expect(await foreignKeysOn(client)).toBe(true);
  });
});
