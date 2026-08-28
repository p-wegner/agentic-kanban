// @gate:always-run — the backfill assertion reads the 0143 migration .sql off disk, which is
// not in this file's import graph (#815).
// @covers workspaces.scorecard.artifact [persistence,migration]
/**
 * #815 — the computed PR-quality scorecard lives in `workspace_scorecard`, not in three
 * `scorecard_*` columns on `workspaces`. This is the TENTH and last family in scope: after it,
 * the only prefix left on `workspaces` is `fork_*`/`showdown_*`, which is permanently out of
 * scope (index-encumbered and all-NULL on the live instance, so no local data can prove a
 * backfill).
 *
 * Like `diff_stat_cache_*` and unlike `summary_*`, absence is the neutral value: all three
 * columns were nullable with no default and every consumer already branches on
 * `scorecardScore === null`. So no read coalesces and none needs `.mapWith(...)`.
 *
 * What must hold after the move:
 *  - the hot board read still projects the score under its OLD field name;
 *  - an UNSCORED workspace still reads (LEFT JOIN) — it is most of the board at any moment;
 *  - the histogram's `IS NOT NULL` filter still means the same thing on the new table;
 *  - `persistScorecard` UPSERTS, because the first scoring run has no row to update;
 *  - `getStoredScorecard` returns null for an unscored workspace, where it used to read a row
 *    of three NULLs and return null from the field check instead;
 *  - the migration backfills the scored rows, invents none for the unscored, and keeps a
 *    score of ZERO (a real, terrible scorecard) rather than treating it as falsy;
 *  - this really is the LAST family: `workspaces` has exactly one prefix group left.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceScorecard, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import { getScorecardColumns, persistScorecard } from "../repositories/workspace-scorecard.repository.js";
import { getScorecardScores } from "../repositories/workspace-analytics.repository.js";
import { fetchWorkspaceDetailRows } from "../repositories/workspace-summary.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0143 = "0143_workspace_scorecard.sql";
const DIMENSIONS = '[{"name":"Tests","score":10,"maxScore":10,"signal":"all green"}]';

type Db = ReturnType<typeof createTestDb>["db"];

function columnNames(rows: readonly unknown[]): string[] {
  return rows.map((r) => String((r as { name: string }).name));
}

async function seedWorkspace(db: Db): Promise<{ projectId: string; workspaceId: string; issueId: string }> {
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
    baseBranch: "master", status: "idle", provider: "claude",
    createdAt: T0, updatedAt: T0,
  });
  return { projectId, workspaceId, issueId };
}

describe("scorecard extraction (#815)", () => {
  it("the three scorecard_* columns are gone — and this was the LAST family in scope", async () => {
    const { client } = createTestDb();
    const cols = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(cols.filter((n) => n.startsWith("scorecard_"))).toEqual([]);

    const moved = await client.execute('PRAGMA table_info("workspace_scorecard")');
    expect(columnNames(moved.rows).sort()).toEqual(["computed_at", "json", "score", "workspace_id"]);

    // Every extracted family's prefix, gone in one assertion. `fork_`/`showdown_` remain and
    // are deliberately permanent — if a later ticket extracts one, this list is the thing to
    // update on purpose rather than a claim that quietly rotted.
    for (const prefix of [
      "merge_backoff_", "review_preflight_", "code_metrics_", "latest_symlink_",
      "merge_gate_", "conflict_cache_", "latest_setup_", "summary_", "diff_stat_cache_",
      "scorecard_",
    ]) {
      expect(cols.filter((n) => n.startsWith(prefix)), `${prefix} must be extracted`).toEqual([]);
    }
    expect(cols.filter((n) => n.startsWith("fork_") || n.startsWith("showdown_"))).toHaveLength(5);
  });

  it("the hot board read serves the score under its OLD field name", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedWorkspace(db);
    await db.insert(workspaceScorecard).values({
      workspaceId, score: 88, json: DIMENSIONS, computedAt: T0,
    });

    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row).toMatchObject({ scorecardScore: 88 });
  });

  it("an UNSCORED workspace still reads — the LEFT JOIN is most of the board", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedWorkspace(db);

    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row).toBeDefined();
    expect(row.scorecardScore).toBeNull();
    expect(await db.select().from(workspaceScorecard)
      .where(eq(workspaceScorecard.workspaceId, workspaceId))).toEqual([]);

    // ...and the stored-scorecard read collapses absence to the same `null` the three-NULL
    // row used to produce, so `getStoredScorecard`'s caller is untouched by the move.
    expect(await getScorecardColumns(workspaceId, db)).toBeNull();
  });

  it("persistScorecard UPSERTS — the first scoring run has no row to update", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);

    await persistScorecard(workspaceId, {
      scorecardScore: 72, scorecardJson: DIMENSIONS, scorecardComputedAt: T0,
    }, db);
    expect(await db.select().from(workspaceScorecard)).toEqual([
      { workspaceId, score: 72, json: DIMENSIONS, computedAt: T0 },
    ]);

    // A re-score REPLACES rather than duplicating or failing the PK...
    await persistScorecard(workspaceId, {
      scorecardScore: 95, scorecardJson: "[]", scorecardComputedAt: "2026-08-23T01:00:00.000Z",
    }, db);
    expect(await db.select().from(workspaceScorecard)).toMatchObject([{ workspaceId, score: 95 }]);
    // ...and the reader aliases it back to the old field names.
    expect(await getScorecardColumns(workspaceId, db)).toMatchObject({
      scorecardScore: 95, scorecardJson: "[]", scorecardComputedAt: "2026-08-23T01:00:00.000Z",
    });
  });

  it("the histogram's IS NOT NULL filter still means 'has a score'", async () => {
    const { db } = createTestDb();
    const { projectId, workspaceId, issueId } = await seedWorkspace(db);
    // A second workspace on the same issue, never scored. The INNER join in
    // `getScorecardScores` is deliberate: no row means no score, which is what the pre-#815
    // `IS NOT NULL` on the column meant. If that ever needs to become a LEFT join, the
    // filter has to move with it.
    const unscored = randomUUID();
    await db.insert(workspaces).values({
      id: unscored, issueId, branch: "feature/ak-2", status: "idle",
      createdAt: T0, updatedAt: T0,
    });
    // A ZERO score is a real, terrible scorecard and MUST be counted — `0` is falsy.
    await db.insert(workspaceScorecard).values({ workspaceId, score: 0, computedAt: T0 });

    const scores = await getScorecardScores(projectId, "2020-01-01", db);
    expect(scores).toEqual([{ score: 0 }]);
  });

  it("the scorecard dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await db.insert(workspaceScorecard).values({ workspaceId, score: 50, computedAt: T0 });

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceScorecard)).toHaveLength(0);
  });
});

describe("migration 0143 backfills the extracted family (#815)", () => {
  it("carries every SCORED row across (zero included), invents none for the unscored", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0143);
    expect(upTo, `${MIGRATION_0143} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const scored = randomUUID();
    const zeroScore = randomUUID();
    const never = randomUUID();
    // Raw SQL on purpose: the live Drizzle schema binds every column it declares (including
    // ones added to `issues` after this migration's cutoff, e.g. #917's start-score columns),
    // so `db.insert(issues)` here would fail with "table issues has no column named ...".
    await client.execute({
      sql: `INSERT INTO projects (id, name, repo_path, repo_name, default_branch, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [projectId, "Test", "/repo", "repo", "master", T0, T0],
    });
    await client.execute({
      sql: `INSERT INTO project_statuses (id, project_id, name, sort_order, is_default, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [statusId, projectId, "In Progress", 1, 0, T0],
    });
    await client.execute({
      sql: `INSERT INTO issues (id, issue_number, title, priority, sort_order, status_id, project_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [issueId, 1, "Issue 1", "medium", 0, statusId, projectId, T0, T0],
    });
    for (const [id, branch] of [[scored, "a"], [zeroScore, "b"], [never, "c"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET scorecard_score = ?, scorecard_json = ?,
            scorecard_computed_at = ? WHERE id = ?`,
      args: [88, DIMENSIONS, T0, scored],
    });
    // A REAL scorecard that scored 0. `0` is falsy, so a backfill filter written as a
    // truthiness test rather than `IS NOT NULL` drops it and silently un-scores the worst
    // workspace on the board.
    await client.execute({
      sql: "UPDATE workspaces SET scorecard_score = 0, scorecard_computed_at = ? WHERE id = ?",
      args: [T0, zeroScore],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0143, MIGRATIONS_DIR)) await client.execute(stmt);

    const rows = await db.select().from(workspaceScorecard);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.workspaceId === scored)).toEqual({
      workspaceId: scored, score: 88, json: DIMENSIONS, computedAt: T0,
    });
    expect(rows.find((r) => r.workspaceId === zeroScore)).toEqual({
      workspaceId: zeroScore, score: 0, json: null, computedAt: T0,
    });
    expect(rows.find((r) => r.workspaceId === never)).toBeUndefined();

    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("scorecard_"))).toEqual([]);
    // The out-of-scope family is untouched, and stays that way.
    expect(names.filter((n) => n.startsWith("fork_") || n.startsWith("showdown_"))).toHaveLength(5);
    // And no workspace was lost.
    const all = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(all.rows.map((r) => String(r[0]))).toEqual([scored, zeroScore, never]);
    client.close();
  });
});
