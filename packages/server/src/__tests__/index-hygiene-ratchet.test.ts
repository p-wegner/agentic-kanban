// @gate:always-run — asserts a property of the whole migrated SQLite schema, which arrives via
// migration .sql files read from MIGRATIONS_DIR; none of that is in this file's import graph (#812).
import { describe, it, expect } from "vitest";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

/**
 * Index hygiene: schema/migration DRIFT (#812).
 *
 * The FK ratchet (#740) asks "does every foreign key have a LEADING index?" and reads the
 * migrated DB, which is the authority. Nothing checked the OTHER direction: an index can
 * exist in the migrations but not in the Drizzle schema files. Nothing breaks at runtime, so
 * it goes unnoticed — but every tool that reads the SCHEMA rather than the DB then sees a
 * table missing indexes it actually has.
 *
 * That is exactly how #812 was filed: three foreign keys reported as unindexed, all three
 * indexed in reality — two by an index the migration created and the schema never declared,
 * one by the implicit index of a composite PRIMARY KEY. Acting on that report would have
 * created three DUPLICATE indexes, which is the defect #813 is about.
 *
 * The assertion is EQUALITY against a grandfathered list, not a subset check, so a stale
 * entry fails too and the list cannot rot into a permanent exemption.
 */

interface MigratedIndex {
  table: string;
  cols: string[];
  unique: boolean;
}

/** Every explicitly-CREATEd index in the migrated DB, by name. */
async function migratedIndexes(): Promise<Map<string, MigratedIndex>> {
  const { client } = createTestDb();
  const out = new Map<string, MigratedIndex>();
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
  );
  for (const row of tables.rows) {
    const table = String((row as unknown as { name: string }).name);
    const list = await client.execute(`PRAGMA index_list(${JSON.stringify(table)})`);
    for (const ix of list.rows as unknown as { name: string; unique: number; origin: string }[]) {
      // origin 'c' = CREATE INDEX. 'pk'/'u' are the implicit indexes SQLite builds for a
      // PRIMARY KEY / UNIQUE constraint; they carry an auto-generated name that appears in
      // no schema file, and the schema declares the CONSTRAINT instead, so comparing them
      // would be pure noise. They still count for the FK ratchet, which reads them.
      if (String(ix.origin) !== "c") continue;
      const info = await client.execute(`PRAGMA index_info(${JSON.stringify(String(ix.name))})`);
      const cols = (info.rows as unknown as { seqno: number; name: string }[])
        .slice()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => String(c.name));
      out.set(String(ix.name), { table, cols, unique: Number(ix.unique) === 1 });
    }
  }
  return out;
}

/** Every index / unique constraint declared in the Drizzle schema, by name. */
function declaredIndexes(): Map<string, { table: string; cols: string[] }> {
  const out = new Map<string, { table: string; cols: string[] }>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value as SQLiteTable);
    for (const ix of config.indexes) {
      const cols = (ix.config.columns as unknown as { name?: string }[]).map((c) => String(c.name));
      out.set(String(ix.config.name), { table: config.name, cols });
    }
    for (const uq of config.uniqueConstraints ?? []) {
      const cols = (uq.columns as unknown as { name: string }[]).map((c) => String(c.name));
      out.set(String(uq.name), { table: config.name, cols });
    }
  }
  return out;
}

/**
 * Indexes the migrations create that the Drizzle schema does not declare.
 *
 * Empty as of #812, which declared the eight that had drifted. An entry here needs a
 * one-line reason — and "the schema file is awkward to edit" is not one, since the whole
 * point is that a schema reader sees the truth.
 */
const GRANDFATHERED_UNDECLARED_INDEXES: string[] = [];

describe("index hygiene", () => {
  it("every index in the migrations is declared in the Drizzle schema (#812)", async () => {
    const migrated = await migratedIndexes();
    const declared = declaredIndexes();

    // Sanity: the two walks actually found the schema's indexes. Without this the equality
    // below passes vacuously if the pragma walk or the drizzle reflection breaks.
    expect(migrated.size).toBeGreaterThan(60);
    expect(declared.size).toBeGreaterThan(60);

    const undeclared = [...migrated.keys()].filter((n) => !declared.has(n)).sort();
    expect(undeclared).toEqual([...GRANDFATHERED_UNDECLARED_INDEXES].sort());
  });

  it("every index declared in the Drizzle schema exists in the migrations (#812)", async () => {
    const migrated = await migratedIndexes();
    const declared = declaredIndexes();
    // No grandfathered set in this direction: a declared index that no migration creates is
    // a schema that lies about the live DB, and there is no benign version of that.
    const missing = [...declared.keys()].filter((n) => !migrated.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it("a declared index's columns match the migrated index's columns, in order (#812)", async () => {
    const migrated = await migratedIndexes();
    const declared = declaredIndexes();
    const mismatched: string[] = [];
    for (const [name, d] of declared) {
      const m = migrated.get(name);
      if (!m) continue; // covered by the test above
      if (m.table !== d.table || m.cols.join(",") !== d.cols.join(",")) {
        mismatched.push(`${name}: schema ${d.table}(${d.cols.join(",")}) vs db ${m.table}(${m.cols.join(",")})`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
