// @gate:always-run — the backfill assertion reads the 0135 migration .sql off disk, which is
// not in this file's import graph (#798).
// @covers workspaces.summary.code-metrics [persistence,migration]
/**
 * #798 — the workspace code-metrics artifact lives in `workspace_code_metrics`, not in two
 * `code_metrics_*` columns on `workspaces`.
 *
 * The third of #739's eleven families, and the one whose published coupling count was most
 * wrong: #739 said 14 non-test files and ordered it seventh; three files actually name the
 * columns, because the rest of the hits are PROSE (two comments citing `code_metrics_json` as
 * an example of a fat column their query deliberately skips). Same failure mode #781 found
 * in #739's own `merge_backoff_*` count, which is why every count in this ticket was
 * re-derived rather than trusted.
 *
 * What must hold after the move:
 *  - the read still hands consumers `codeMetricsJson` / `codeMetricsComputedAt` on the
 *    projected row, so `workspace-summary.service.ts` is untouched;
 *  - a workspace with no artifact projects both as null, rather than dropping out of the
 *    projection — the read is a LEFT JOIN, and an inner join here would silently hide every
 *    workspace whose metrics were never computed, which is most of them;
 *  - the migration backfills, because `computed_at` is the staleness stamp: losing it
 *    schedules a metrics recompute for every workspace that already had one.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceCodeMetrics, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import { updateWorkspaceCodeMetrics } from "../repositories/workspace-code-metrics.repository.js";
import { fetchWorkspaceDetailRows } from "../repositories/workspace-summary.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const T1 = "2026-08-23T01:00:00.000Z";
const MIGRATION_0135 = "0135_workspace_code_metrics.sql";
const METRICS = JSON.stringify({ files: 3, loc: 420 });

type Db = ReturnType<typeof createTestDb>["db"];

function columnNames(rows: readonly unknown[]): string[] {
  return rows.map((r) => String((r as { name: string }).name));
}

async function seedWorkspace(db: Db): Promise<{ issueId: string; workspaceId: string }> {
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: T0, updatedAt: T0,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: T0,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: T0, updatedAt: T0,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/repo/.worktrees/ws",
    baseBranch: "master", status: "idle", provider: "claude", createdAt: T0, updatedAt: T0,
  });
  return { issueId, workspaceId };
}

describe("code-metrics extraction (#798)", () => {
  it("the two code_metrics_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("code_metrics_"))).toEqual([]);
    const moved = await client.execute('PRAGMA table_info("workspace_code_metrics")');
    expect(columnNames(moved.rows).sort()).toEqual(["computed_at", "metrics_json", "workspace_id"]);
  });

  it("a computed artifact is stored in the new table and still reaches the projected row", async () => {
    const { db } = createTestDb();
    const { issueId, workspaceId } = await seedWorkspace(db);

    await updateWorkspaceCodeMetrics(workspaceId, METRICS, T1, db);

    expect(await db.select().from(workspaceCodeMetrics)
      .where(eq(workspaceCodeMetrics.workspaceId, workspaceId)))
      .toEqual([{ workspaceId, metricsJson: METRICS, computedAt: T1 }]);

    // The field names the consumers read are unchanged — that is what makes the move
    // invisible to `workspace-summary.service.ts`.
    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row.codeMetricsJson).toBe(METRICS);
    expect(row.codeMetricsComputedAt).toBe(T1);
  });

  it("a recompute replaces the artifact instead of adding a second row", async () => {
    const { db } = createTestDb();
    const { issueId, workspaceId } = await seedWorkspace(db);

    await updateWorkspaceCodeMetrics(workspaceId, METRICS, T0, db);
    await updateWorkspaceCodeMetrics(workspaceId, '{"files":9}', T1, db);

    expect(await db.select().from(workspaceCodeMetrics)).toHaveLength(1);
    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row.codeMetricsJson).toBe('{"files":9}');
    expect(row.codeMetricsComputedAt).toBe(T1);
  });

  it("a workspace with no artifact still appears in the projection, with nulls", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedWorkspace(db);

    // The LEFT JOIN case: an inner join would drop this row entirely, and with it every
    // workspace whose metrics have never been computed.
    const rows = await fetchWorkspaceDetailRows([issueId], db);
    expect(rows).toHaveLength(1);
    expect(rows[0].codeMetricsJson).toBeNull();
    expect(rows[0].codeMetricsComputedAt).toBeNull();
  });

  it("the artifact dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await updateWorkspaceCodeMetrics(workspaceId, METRICS, T1, db);

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceCodeMetrics)).toHaveLength(0);
  });
});

describe("migration 0135 backfills the extracted family (#798)", () => {
  it("carries the computed artifact into workspace_code_metrics, and drops nothing else", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0135);
    expect(upTo, `${MIGRATION_0135} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const computed = randomUUID();
    const untouched = randomUUID();
    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
      defaultBranch: "master", createdAt: T0, updatedAt: T0,
    });
    await db.insert(projectStatuses).values({
      id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: T0,
    });
    await db.insert(issues).values({
      id: issueId, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0,
      statusId, projectId, createdAt: T0, updatedAt: T0,
    });
    // Raw SQL on purpose: the Drizzle schema no longer knows these columns.
    for (const [id, branch] of [[computed, "feature/computed"], [untouched, "feature/clean"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: "UPDATE workspaces SET code_metrics_json = ?, code_metrics_computed_at = ? WHERE id = ?",
      args: [METRICS, T1, computed],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0135, MIGRATIONS_DIR)) await client.execute(stmt);

    expect(await db.select().from(workspaceCodeMetrics))
      .toEqual([{ workspaceId: computed, metricsJson: METRICS, computedAt: T1 }]);
    // The drop took only the two columns.
    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("code_metrics_"))).toEqual([]);
    expect(names).toContain("merge_gate_ran_at");
    expect(names).toContain("scorecard_json");
    // And left the rows whole.
    const both = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(both.rows.map((r) => String(r[0]))).toEqual([untouched, computed]); // ordered by branch
    client.close();
  });
});
