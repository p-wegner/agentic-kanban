// @gate:always-run — the backfill assertion reads the 0139 migration .sql off disk, which is
// not in this file's import graph (#815).
// @covers workspaces.merge.conflict-cache [persistence,migration]
/**
 * #815 — the cached merge-tree conflict probe lives in `workspace_conflict_cache`, not in
 * three `conflict_cache_*` columns on `workspaces`.
 *
 * This family is a genuine CACHE, and the first test is why that is an argument FOR its own
 * table rather than for deleting it: the memo still reaches the workspace-details read under
 * its old field names, which is the read the board serves without spawning git. "Rebuildable"
 * is not "retirable" — #798 settled that when `latest_symlink_*` looked retirable and was not.
 *
 * What must hold after the move:
 *  - a memo still reaches the read path aliased back to `conflictCache*`;
 *  - a workspace with NO memo still reads (LEFT JOIN) and presents as never-probed, which is
 *    what a NULL `checked_at` meant — the revalidation path then runs;
 *  - the memo dies with its workspace;
 *  - the migration backfills every existing memo and drops nothing else.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceConflictCache, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  getWorkspaceConflictCache,
  updateWorkspaceConflictCache,
} from "../repositories/conflict-cache.repository.js";
import { getWorkspaceDetails } from "../repositories/workspace-reads.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0139 = "0139_workspace_conflict_cache.sql";

const MEMO = { checkedAt: T0, hasConflicts: true, files: '["src/a.ts","src/b.ts"]' };

type Db = ReturnType<typeof createTestDb>["db"];

function columnNames(rows: readonly unknown[]): string[] {
  return rows.map((r) => String((r as { name: string }).name));
}

async function seedWorkspace(db: Db): Promise<string> {
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
  return workspaceId;
}

describe("conflict-cache extraction (#815)", () => {
  it("the three conflict_cache_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("conflict_cache_"))).toEqual([]);
    // `diff_stat_cache_*` is a DIFFERENT family and stays — both end in `_cache_`.
    expect(columnNames(info.rows).filter((n) => n.startsWith("diff_stat_cache_"))).toHaveLength(5);
    const moved = await client.execute('PRAGMA table_info("workspace_conflict_cache")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "checked_at", "files", "has_conflicts", "workspace_id",
    ]);
  });

  it("a memo still reaches the workspace-details read under its old field names", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await updateWorkspaceConflictCache(workspaceId, MEMO, db);
    expect(await getWorkspaceConflictCache(workspaceId, db)).toEqual({ workspaceId, ...MEMO });

    // The aliasing is the whole reason the projection, the DTO and the client are untouched.
    const row = await getWorkspaceDetails(workspaceId, db);
    expect(row?.conflicts).toEqual({ hasConflicts: true, conflictingFiles: ["src/a.ts", "src/b.ts"] });
  });

  it("re-probing replaces the memo rather than duplicating it", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await updateWorkspaceConflictCache(workspaceId, MEMO, db);

    const reprobed = { checkedAt: "2026-08-23T01:00:00.000Z", hasConflicts: false, files: "[]" };
    await updateWorkspaceConflictCache(workspaceId, reprobed, db);

    expect(await db.select().from(workspaceConflictCache)
      .where(eq(workspaceConflictCache.workspaceId, workspaceId)))
      .toEqual([{ workspaceId, ...reprobed }]);
  });

  it("a never-probed workspace still reads, with no conflicts projected", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    // The LEFT JOIN case: an inner join would make the whole workspace unreadable, and the
    // absent row is exactly the "never probed" state a NULL checked_at used to mean.
    const row = await getWorkspaceDetails(workspaceId, db);
    expect(row).not.toBeNull();
    expect(row?.conflicts).toBeNull();
    expect(await getWorkspaceConflictCache(workspaceId, db)).toBeUndefined();
  });

  it("the memo dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await updateWorkspaceConflictCache(workspaceId, MEMO, db);

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceConflictCache)).toHaveLength(0);
  });
});

describe("migration 0139 backfills the extracted family (#815)", () => {
  it("carries the memo into workspace_conflict_cache, and drops nothing else", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0139);
    expect(upTo, `${MIGRATION_0139} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const probed = randomUUID();
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
    for (const [id, branch] of [[probed, "feature/probed"], [untouched, "feature/clean"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET conflict_cache_checked_at = ?, conflict_cache_has_conflicts = ?,
            conflict_cache_files = ? WHERE id = ?`,
      args: [MEMO.checkedAt, 1, MEMO.files, probed],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0139, MIGRATIONS_DIR)) await client.execute(stmt);

    expect(await db.select().from(workspaceConflictCache)).toEqual([{ workspaceId: probed, ...MEMO }]);
    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("conflict_cache_"))).toEqual([]);
    // The neighbouring families are untouched — `diff_stat_cache_` is one char class away.
    expect(names.filter((n) => n.startsWith("diff_stat_cache_"))).toHaveLength(5);
    expect(names.filter((n) => n.startsWith("latest_setup_"))).toHaveLength(8);
    expect(names).toContain("scorecard_score");
    // And left the rows whole.
    const both = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(both.rows.map((r) => String(r[0]))).toEqual([untouched, probed]); // ordered by branch
    client.close();
  });
});
