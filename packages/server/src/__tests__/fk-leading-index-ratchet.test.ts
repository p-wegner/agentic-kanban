// @gate:always-run — asserts a property of the whole migrated SQLite schema; a new table with an un-indexed FK arrives via a migration .sql file, which is not in this file's import graph (#740).
import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/test-db.js";

/**
 * Shrink-only ratchet on foreign keys with no supporting index (#740).
 *
 * SQLite creates NO index for a foreign key. With `foreign_keys = ON` (which this board
 * runs with — see db-client pragmas), every child-row lookup the FK forces — the integrity
 * check on a parent DELETE or key UPDATE, and any join in the child->parent direction —
 * falls back to a FULL SCAN of the referencing table unless some index has the referencing
 * column as its LEADING column. A composite index that merely CONTAINS the column in a
 * later position does not help.
 *
 * #740 measured 12 such FKs out of 54, the worst being `issue_comments.workspace_id` on a
 * ~100k-row table. Migration 0127 added all 12, so the expected set is now EMPTY.
 *
 * This asserts EQUALITY with the grandfathered list, not a subset: a new un-indexed FK
 * fails, and a stale entry (one that has since been indexed) fails too, so the list cannot
 * rot into a permanent exemption.
 */
const GRANDFATHERED_UNINDEXED_FKS: string[] = [
  // Intentionally empty. If a new table legitimately cannot carry the index, add
  // "<table>.<leading_column>" here WITH a one-line reason.
];

interface UnindexedFk {
  table: string;
  columns: string;
  references: string;
}

async function findUnindexedForeignKeys(): Promise<{ total: number; unindexed: UnindexedFk[] }> {
  const { client } = createTestDb();
  const tablesResult = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
  );
  const tables = tablesResult.rows.map((r) => String(r[0]));

  let total = 0;
  const unindexed: UnindexedFk[] = [];

  for (const table of tables) {
    const quoted = JSON.stringify(table);
    const fkRows = await client.execute(`PRAGMA foreign_key_list(${quoted})`);
    if (fkRows.rows.length === 0) continue;

    // Collect the LEADING column of every index on this table.
    const leadingColumns = new Set<string>();
    const indexRows = await client.execute(`PRAGMA index_list(${quoted})`);
    for (const ix of indexRows.rows) {
      const indexName = String((ix as unknown as Record<string, unknown>).name);
      const info = await client.execute(`PRAGMA index_info(${JSON.stringify(indexName)})`);
      const entries = info.rows
        .map((r) => r as unknown as { seqno: number; name: string | null })
        .sort((a, b) => Number(a.seqno) - Number(b.seqno));
      const first = entries[0];
      if (first?.name) leadingColumns.add(String(first.name));
    }

    // A composite FK shares one `id` across several rows; group them and take the
    // first column in `seq` order, which is the one an index must lead on.
    const byId = new Map<number, { seq: number; from: string; table: string }[]>();
    for (const row of fkRows.rows) {
      const fk = row as unknown as { id: number; seq: number; from: string; table: string };
      const list = byId.get(Number(fk.id)) ?? [];
      list.push({ seq: Number(fk.seq), from: String(fk.from), table: String(fk.table) });
      byId.set(Number(fk.id), list);
    }

    for (const cols of byId.values()) {
      total++;
      const ordered = cols.sort((a, b) => a.seq - b.seq);
      const leading = ordered[0].from;
      if (!leadingColumns.has(leading)) {
        unindexed.push({
          table,
          columns: ordered.map((c) => c.from).join(","),
          references: ordered[0].table,
        });
      }
    }
  }

  return { total, unindexed };
}

describe("foreign keys have a leading index (#740)", () => {
  it("every foreign key is supported by an index leading on its referencing column", async () => {
    const { total, unindexed } = await findUnindexedForeignKeys();

    // Sanity: the walk actually found the schema's foreign keys. If this drops to a
    // handful the pragma walk broke and the assertion below would pass vacuously.
    expect(total).toBeGreaterThan(40);

    const keys = unindexed.map((u) => `${u.table}.${u.columns.split(",")[0]}`).sort();
    expect(keys).toEqual([...GRANDFATHERED_UNINDEXED_FKS].sort());
  });

  it("the twelve indexes from #740 exist", async () => {
    const { client } = createTestDb();
    const expected = [
      "idx_agent_skills_project_id",
      "idx_issue_comments_workspace_id",
      "idx_issue_dependencies_depends_on_id",
      "idx_plugin_loop_events_project_id",
      "idx_plugin_view_processes_project_id",
      "idx_projects_default_skill_id",
      "idx_scheduled_runs_project_id",
      "idx_scheduled_runs_skill_id",
      "idx_workflow_edges_to_node_id",
      "idx_workflow_nodes_skill_id",
      "idx_workspace_provisioning_project_id",
      "idx_workspaces_skill_id",
    ];
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const present = new Set(result.rows.map((r) => String(r[0])));
    expect(expected.filter((n) => !present.has(n))).toEqual([]);
  });

  it("the big one is actually used: workspace-scoped comment lookups hit the new index", async () => {
    const { client } = createTestDb();
    const plan = await client.execute(
      "EXPLAIN QUERY PLAN SELECT * FROM issue_comments WHERE workspace_id = 'x'",
    );
    const planText = plan.rows.map((r) => Object.values(r).join(" ")).join("\n");
    expect(planText).toContain("idx_issue_comments_workspace_id");
  });
});
