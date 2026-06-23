import { describe, it, expect } from "vitest";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "@agentic-kanban/shared/schema";
import { MIGRATIONS_DIR } from "./helpers/migrations.js";
import { applyMigrationsToClient } from "./helpers/test-db.js";
import {
  diffForeignKeyActions,
  expectedForeignKeyActions,
  readForeignKeyActions,
} from "@agentic-kanban/shared/lib/fk-actions";

/**
 * Schema ↔ migrations drift gate (arch-review #871).
 *
 * The Drizzle schema (`packages/shared/src/schema/*`) and the live DB are joined
 * ONLY by the sequential migration files — there was no check that applying every
 * migration to an empty DB actually reproduces the schema. Two failure modes had
 * already bitten the repo:
 *
 *   1. An ORPHANED, un-journaled migration file (`0039_direct_workspace_base_commit.sql`
 *      alongside `0039_nullable_default_branch.sql`): drizzle-kit silently skips the
 *      un-journaled file, but anyone reading the directory assumes it ran. A duplicate
 *      `NNNN` number is the tell.
 *   2. Schema/DDL divergence (the FK onDelete drift, #858): a column or table in the
 *      schema that no migration ever created, or vice-versa.
 *
 * This gate fails on BOTH. It is pure (in-memory libsql, no network, no drizzle-kit
 * subprocess) so it runs in the normal vitest suite.
 *
 * Scope note: the drift check compares the TABLE + COLUMN sets (catches "schema added a
 * field with no migration" and the reverse) AND the FK ACTIONS (`ON DELETE`/`ON UPDATE`)
 * per foreign key (arch-review #881). It still does not diff arbitrary column types /
 * column defaults — SQLite stores those loosely and the existing migrations predate a
 * snapshot chain (drizzle `meta/NNNN_snapshot.json` froze at 0006), so a full DDL diff
 * would be noise. But FK actions are high-signal: services rely on cascade/set-null
 * behaviour (e.g. `issue_dependencies` cascade, #858), so a schema that declares a
 * cascade with no matching migration — leaving live DBs on RESTRICT/NO ACTION — must
 * break the build. FK-action parity logic lives in the shared `lib/fk-actions` module
 * so the same comparison powers the db:repair alignment path.
 */

/** Matches a drizzle migration filename: NNNN_some_name.sql */
const MIGRATION_RE = /^(\d{4})_(.+)\.sql$/;

function migrationNumber(file: string): number {
  return parseInt(file.match(MIGRATION_RE)![1], 10);
}

/** All `NNNN_*.sql` basenames physically present in the drizzle dir. */
function migrationFilesOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_RE.test(f));
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(): JournalEntry[] {
  const raw = readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

describe("migration journal structural gate", () => {
  it("has no duplicate migration numbers on disk (catches the orphaned 0039 collision)", () => {
    const byNumber = new Map<number, string[]>();
    for (const file of migrationFilesOnDisk()) {
      const n = migrationNumber(file);
      const list = byNumber.get(n) ?? [];
      list.push(file);
      byNumber.set(n, list);
    }
    const dups = [...byNumber.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([n, files]) => `${String(n).padStart(4, "0")}: ${files.join(", ")}`);

    expect(
      dups,
      `Two migration files share one NNNN number. Drizzle journals exactly one of them; ` +
        `the other is an orphan that drizzle-kit silently skips but readers assume ran. ` +
        `Renumber or delete the un-journaled one:\n${dups.join("\n")}`,
    ).toEqual([]);
  });

  it("every migration file on disk is referenced by the journal (no orphans)", () => {
    const journaledTags = new Set(readJournal().map((e) => e.tag));
    const orphans = migrationFilesOnDisk()
      .map((f) => f.replace(/\.sql$/, ""))
      .filter((tag) => !journaledTags.has(tag));

    expect(
      orphans,
      `These migration files are NOT in meta/_journal.json, so drizzle-kit skips them ` +
        `while the directory makes them look applied. Delete them or add a journal entry:\n` +
        orphans.map((t) => `${t}.sql`).join("\n"),
    ).toEqual([]);
  });

  it("every journal entry has a migration file on disk", () => {
    const onDisk = new Set(migrationFilesOnDisk().map((f) => f.replace(/\.sql$/, "")));
    const missing = readJournal()
      .map((e) => e.tag)
      .filter((tag) => !onDisk.has(tag));

    expect(
      missing,
      `These journal entries reference a .sql file that does not exist on disk — ` +
        `migration would crash at apply time:\n${missing.map((t) => `${t}.sql`).join("\n")}`,
    ).toEqual([]);
  });

  it("journal tags and indices are unique", () => {
    const entries = readJournal();
    const tagCounts = new Map<string, number>();
    const idxCounts = new Map<number, number>();
    for (const e of entries) {
      tagCounts.set(e.tag, (tagCounts.get(e.tag) ?? 0) + 1);
      idxCounts.set(e.idx, (idxCounts.get(e.idx) ?? 0) + 1);
    }
    const dupTags = [...tagCounts].filter(([, c]) => c > 1).map(([t]) => t);
    const dupIdx = [...idxCounts].filter(([, c]) => c > 1).map(([i]) => i);

    expect(dupTags, `Duplicate journal tags: ${dupTags.join(", ")}`).toEqual([]);
    expect(dupIdx, `Duplicate journal idx values: ${dupIdx.join(", ")}`).toEqual([]);
  });
});

describe("schema ↔ migrations drift gate", () => {
  /** The schema's expected tables → column DB-names, from drizzle table configs. */
  function schemaTableColumns(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const value of Object.values(schema)) {
      if (!is(value, SQLiteTable)) continue;
      const config = getTableConfig(value);
      result.set(config.name, new Set(config.columns.map((c) => c.name)));
    }
    return result;
  }

  it("applies all migrations to an empty DB without error", async () => {
    const client = createClient({ url: ":memory:" });
    expect(() => applyMigrationsToClient(client)).not.toThrow();
    // Sanity: at least the core tables exist.
    const rows = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'",
    );
    expect(rows.rows.length).toBe(1);
  });

  it("migrated DB and Drizzle schema agree on tables and columns", async () => {
    const client = createClient({ url: ":memory:" });
    applyMigrationsToClient(client);

    const migrated = new Map<string, Set<string>>();
    const tableRows = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' " +
        "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_drizzle\\_%' ESCAPE '\\'",
    );
    for (const row of tableRows.rows) {
      const tableName = String((row as { name: string }).name);
      const cols = await client.execute(`PRAGMA table_info(${tableName})`);
      migrated.set(
        tableName,
        new Set(cols.rows.map((c) => String((c as { name: string }).name))),
      );
    }

    const expected = schemaTableColumns();

    // Tables in schema but missing from the migrated DB (or vice-versa).
    const expectedTables = [...expected.keys()].sort();
    const migratedTables = [...migrated.keys()].sort();
    const missingTables = expectedTables.filter((t) => !migrated.has(t));
    const extraTables = migratedTables.filter((t) => !expected.has(t));

    expect(
      { missingTables, extraTables },
      `Schema/migrations table drift.\n` +
        `In schema but never created by a migration: ${missingTables.join(", ") || "(none)"}\n` +
        `Created by a migration but absent from the schema: ${extraTables.join(", ") || "(none)"}`,
    ).toEqual({ missingTables: [], extraTables: [] });

    // Per-table column drift, only for tables present on both sides.
    const columnDrift: string[] = [];
    for (const table of expectedTables) {
      const expCols = expected.get(table)!;
      const migCols = migrated.get(table);
      if (!migCols) continue; // already reported as a missing table
      const missingCols = [...expCols].filter((c) => !migCols.has(c)).sort();
      const extraCols = [...migCols].filter((c) => !expCols.has(c)).sort();
      if (missingCols.length || extraCols.length) {
        columnDrift.push(
          `${table}: in schema but not migrated [${missingCols.join(", ") || "—"}]; ` +
            `migrated but not in schema [${extraCols.join(", ") || "—"}]`,
        );
      }
    }

    expect(
      columnDrift,
      `Schema/migrations COLUMN drift — a schema column with no migration (or the ` +
        `reverse). Add the migration (or update the schema) so they reproduce each other:\n` +
        columnDrift.join("\n"),
    ).toEqual([]);
  });

  it("migrated DB and Drizzle schema agree on FK actions (ON DELETE / ON UPDATE)", async () => {
    const client = createClient({ url: ":memory:" });
    applyMigrationsToClient(client);

    const expected = expectedForeignKeyActions();
    const actual = await readForeignKeyActions(client, [...expected.keys()]);
    const mismatches = diffForeignKeyActions(expected, actual);

    expect(
      mismatches,
      `Schema/migrations FK-ACTION drift (arch-review #881). The Drizzle schema declares ` +
        `an ON DELETE/ON UPDATE action that the migrations never reproduce, so services ` +
        `that rely on the cascade (e.g. issue-dependency deletes, #858) will behave ` +
        `differently against a freshly-migrated DB. Add/fix the migration so a fresh apply ` +
        `produces the schema's FK action:\n` +
        mismatches
          .map((m) => `  ${m.table}: ${m.fk} ${m.field} — schema=${m.expected} migrated=${m.actual}`)
          .join("\n"),
    ).toEqual([]);
  });
});
