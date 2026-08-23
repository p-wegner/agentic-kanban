// @gate:always-run — asserts a property of the whole migrated SQLite schema, which arrives via
// migration .sql files read from MIGRATIONS_DIR; none of that is in this file's import graph (#812/#813).
import { describe, it, expect } from "vitest";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

/**
 * Index hygiene, in the two directions the FK ratchet (#740) does not look.
 *
 * #740 asks "does every foreign key have a LEADING index?" and reads the migrated DB, which
 * is the authority. Two other things can be wrong, and nothing checked either:
 *
 *   1. DRIFT (#812). An index can exist in the migrations but not in the Drizzle schema
 *      files. Nothing breaks at runtime, so it goes unnoticed — but every tool that reads
 *      the SCHEMA rather than the DB then sees a table missing indexes it actually has.
 *      That is exactly how #812 was filed: three foreign keys reported as unindexed, all
 *      three indexed in reality — two by a migration-only index, one by the implicit index
 *      of a composite PRIMARY KEY. Acting on it would have created three DUPLICATE indexes,
 *      which is the defect #813 is about.
 *
 *   2. REDUNDANCY (#813). An index whose column list is a strict PREFIX of a wider index on
 *      the SAME table serves no lookup the wider one does not, and is maintained on every
 *      write for nothing. Nine of those existed when migration 0137 dropped them.
 *
 * The two are the same defect seen from opposite sides, which is why they share a file: it
 * was the DRIFT that made #813's own candidate list incomplete (it named seven; two more
 * were hidden behind covering indexes the schema files did not declare).
 *
 * Every assertion is EQUALITY against a grandfathered list, not a subset check, so a stale
 * entry fails too and no list can rot into a permanent exemption.
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

/**
 * Narrow indexes kept despite being a strict column prefix of a wider index on the same table.
 *
 * Empty as of #813 / migration 0137, which dropped the nine that existed. A UNIQUE index is
 * never in scope — it enforces a constraint, not a lookup — and is excluded by the check
 * itself rather than listed here.
 */
const GRANDFATHERED_REDUNDANT_INDEXES: string[] = [];

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

  it("no index is a strict column prefix of a wider index on the same table (#813)", async () => {
    const migrated = await migratedIndexes();

    const byTable = new Map<string, { name: string; cols: string[]; unique: boolean }[]>();
    for (const [name, ix] of migrated) {
      const list = byTable.get(ix.table) ?? [];
      list.push({ name, cols: ix.cols, unique: ix.unique });
      byTable.set(ix.table, list);
    }

    const redundant: string[] = [];
    for (const list of byTable.values()) {
      for (const narrow of list) {
        // A UNIQUE index enforces a constraint, not a lookup: unique `(a)` is a strictly
        // stronger statement than non-unique `(a, b)` and can never be replaced by it.
        // Only a non-unique narrow index is a drop candidate.
        if (narrow.unique) continue;
        for (const wide of list) {
          if (wide.name === narrow.name) continue;
          if (wide.cols.length <= narrow.cols.length) continue;
          // STRICT PREFIX, in order: (a) is covered by (a, b); (b) is NOT.
          const isPrefix = narrow.cols.every((c, i) => wide.cols[i] === c);
          if (isPrefix) {
            redundant.push(`${narrow.name} (${narrow.cols.join(",")}) covered by ${wide.name} (${wide.cols.join(",")})`);
            break;
          }
        }
      }
    }

    expect(redundant.map((r) => r.split(" ")[0]).sort()).toEqual([...GRANDFATHERED_REDUNDANT_INDEXES].sort());
  });

  it("the reads whose narrow index 0137 dropped are still a SEARCH, not a SCAN (#813)", async () => {
    const { client } = createTestDb();
    // This is the check that turns "a prefix is covered" from a claim about SQLite in general
    // into an assertion about THIS schema: every read that used to have its own narrow index
    // must still be served by an index.
    //
    // Deliberately NOT pinned to a specific index name. `issues` carries five indexes leading
    // on `project_id`, and which one the planner picks for a bare `WHERE project_id = ?` is
    // its business — it chose `idx_issues_project_sort_order` here, which is just as good.
    // Asserting the name would pin an implementation detail of the query planner and go red
    // on an unrelated index being added.
    const reads = [
      "SELECT * FROM issues WHERE project_id = 'x'",
      "SELECT * FROM issues WHERE status_id = 'x'",
      "SELECT * FROM issues WHERE project_id = 'x' AND status_id = 'y'",
      "SELECT * FROM workspaces WHERE issue_id = 'x'",
      "SELECT * FROM sessions WHERE workspace_id = 'x'",
      "SELECT * FROM project_statuses WHERE project_id = 'x'",
      "SELECT * FROM base_branch_health WHERE project_id = 'x'",
      "SELECT * FROM issue_comments WHERE issue_id = 'x'",
      "SELECT * FROM issue_dependencies WHERE issue_id = 'x'",
    ];
    const dropped = [
      "idx_workspaces_issue_id",
      "idx_issues_project_id",
      "idx_issues_status_id",
      "idx_issues_project_id_status_id",
      "idx_sessions_workspace_id",
      "idx_project_statuses_project_id",
      "idx_base_branch_health_project_id",
      "idx_issue_comments_issue_id",
      "idx_issue_deps_issue_id",
    ];
    const existing = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const present = new Set(existing.rows.map((r) => String(r[0])));
    // Migration 0137 really removed them (and did not merely fail to run).
    expect(dropped.filter((n) => present.has(n))).toEqual([]);

    for (const sql of reads) {
      const plan = await client.execute(`EXPLAIN QUERY PLAN ${sql}`);
      const text = plan.rows.map((r) => Object.values(r).join(" ")).join(" ; ");
      expect(text, `${sql} => ${text}`).toContain("SEARCH");
      expect(text, `${sql} => ${text}`).not.toContain("SCAN");
    }
  });
});
