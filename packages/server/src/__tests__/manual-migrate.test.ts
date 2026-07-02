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
