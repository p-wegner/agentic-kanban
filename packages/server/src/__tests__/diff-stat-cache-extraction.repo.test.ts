// @gate:always-run — the backfill assertion reads the 0142 migration .sql off disk, which is
// not in this file's import graph (#815).
// @covers workspaces.diff-stat.cache [persistence,migration]
/**
 * #815 — the memoized `git diff --shortstat` lives in `workspace_diff_stat_cache`, not in five
 * `diff_stat_cache_*` columns on `workspaces`.
 *
 * This is the family AFTER the one that inverted the convention, and the contrast is the point:
 * `summary_dirty` was `NOT NULL DEFAULT TRUE`, so 0141 had to coalesce absence back to the
 * default in every read (and `.mapWith(Boolean)` to undo the mode-mapping bypass a raw `sql`
 * expression causes). All five columns here were NULLABLE WITH NO DEFAULT, so "no row" and
 * "five NULLs" are literally the same answer — no read coalesces, and none needs to. The
 * tests below pin that, because "absence is neutral" is a claim about the STALENESS
 * predicates, not a claim about the schema, and it is the kind of thing that fails silently
 * as a board serving stale numbers.
 *
 * What must hold after the move:
 *  - the hot board read still projects the five facts under their OLD field names;
 *  - a workspace with NO row still reads (LEFT JOIN) and reads as NEVER-DIFFED, i.e. stale;
 *  - the writer UPSERTS — an UPDATE would no-op for exactly the never-diffed workspace the
 *    refresh runs for;
 *  - the migration backfills the rows that HAVE a memo, and invents none for those that don't.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceDiffStatCache, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  getWorkspaceDiffStatCache,
  updateWorkspaceDiffStatCache,
} from "../repositories/diff-stat-cache.repository.js";
import { fetchWorkspaceDetailRows } from "../repositories/workspace-summary.repository.js";
import { isDiffCacheStale } from "../lib/workspace-diff-cache.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0142 = "0142_workspace_diff_stat_cache.sql";

type Db = ReturnType<typeof createTestDb>["db"];

function columnNames(rows: readonly unknown[]): string[] {
  return rows.map((r) => String((r as { name: string }).name));
}

async function seedWorkspace(db: Db): Promise<{ workspaceId: string; issueId: string }> {
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
  return { workspaceId, issueId };
}

describe("diff-stat-cache extraction (#815)", () => {
  it("the five diff_stat_cache_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("diff_stat_cache_"))).toEqual([]);

    const moved = await client.execute('PRAGMA table_info("workspace_diff_stat_cache")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "checked_at", "deletions", "files_changed", "head_sha", "insertions", "workspace_id",
    ]);
  });

  it("the hot board read serves the memo under its OLD field names", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedWorkspace(db);
    await db.insert(workspaceDiffStatCache).values({
      workspaceId, checkedAt: T0, headSha: "abc1234",
      filesChanged: 4, insertions: 120, deletions: 7,
    });

    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row).toMatchObject({
      diffStatCacheCheckedAt: T0,
      diffStatCacheHeadSha: "abc1234",
      diffStatCacheFilesChanged: 4,
      diffStatCacheInsertions: 120,
      diffStatCacheDeletions: 7,
    });
  });

  it("a workspace with no row still reads, as NEVER-DIFFED — no coalesce needed", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedWorkspace(db);

    // The LEFT JOIN case. An inner join would drop every brand-new workspace off the board.
    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row).toBeDefined();
    expect(row.diffStatCacheCheckedAt).toBeNull();
    expect(row.diffStatCacheHeadSha).toBeNull();
    expect(row.diffStatCacheFilesChanged).toBeNull();
    expect(await db.select().from(workspaceDiffStatCache)
      .where(eq(workspaceDiffStatCache.workspaceId, workspaceId))).toEqual([]);

    // ...and that IS the previous semantics: the staleness predicate every consumer runs
    // reads the absent row exactly as it read five NULL columns — stale, therefore refresh.
    // This is the assertion that makes "absence is neutral" a checked claim rather than prose.
    expect(isDiffCacheStale(row, "abc1234", 30_000, Date.parse(T0))).toBe(true);
  });

  it("the writer UPSERTS, so a never-diffed workspace gets its first memo", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);

    // An UPDATE here would no-op — and the never-diffed workspace is precisely the one the
    // refresh path runs for, so it would never acquire a memo and would re-spawn git forever.
    await updateWorkspaceDiffStatCache(workspaceId, {
      checkedAt: T0, headSha: "def5678", filesChanged: 2, insertions: 10, deletions: 1,
    }, db);
    expect(await db.select().from(workspaceDiffStatCache)).toEqual([{
      workspaceId, checkedAt: T0, headSha: "def5678",
      filesChanged: 2, insertions: 10, deletions: 1,
    }]);

    // ...and a second refresh REPLACES rather than duplicating or failing the PK.
    await updateWorkspaceDiffStatCache(workspaceId, {
      checkedAt: "2026-08-23T01:00:00.000Z", headSha: "999aaaa",
      filesChanged: 9, insertions: 90, deletions: 3,
    }, db);
    expect(await db.select().from(workspaceDiffStatCache)).toMatchObject([
      { workspaceId, headSha: "999aaaa", filesChanged: 9 },
    ]);
    expect((await getWorkspaceDiffStatCache(workspaceId, db))!.insertions).toBe(90);
    expect(await getWorkspaceDiffStatCache(randomUUID(), db)).toBeUndefined();
  });

  it("the memo dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await db.insert(workspaceDiffStatCache).values({ workspaceId, checkedAt: T0, filesChanged: 1 });

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceDiffStatCache)).toHaveLength(0);
  });
});

describe("migration 0142 backfills the extracted family (#815)", () => {
  it("carries every MEMOIZED row across, invents none for the never-diffed, and leaves the neighbours alone", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0142);
    expect(upTo, `${MIGRATION_0142} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const memoized = randomUUID();
    const zeroDiff = randomUUID();
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
    for (const [id, branch] of [[memoized, "a"], [zeroDiff, "b"], [never, "c"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET diff_stat_cache_checked_at = ?, diff_stat_cache_head_sha = ?,
            diff_stat_cache_files_changed = ?, diff_stat_cache_insertions = ?,
            diff_stat_cache_deletions = ? WHERE id = ?`,
      args: [T0, "abc1234", 4, 120, 7, memoized],
    });
    // A REAL memo whose numbers are all zero — a plan-only session. `0` is falsy, so a
    // backfill filter written as a truthiness test rather than `IS NOT NULL` would drop it
    // and silently turn "verified empty diff" back into "never diffed".
    await client.execute({
      sql: `UPDATE workspaces SET diff_stat_cache_checked_at = ?, diff_stat_cache_files_changed = 0,
            diff_stat_cache_insertions = 0, diff_stat_cache_deletions = 0 WHERE id = ?`,
      args: [T0, zeroDiff],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0142, MIGRATIONS_DIR)) await client.execute(stmt);

    const rows = await db.select().from(workspaceDiffStatCache);
    // TWO rows, not three: the never-diffed workspace gets NO row, because an all-NULL row
    // would be a record whose only content is the absence it replaced.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.workspaceId === memoized)).toEqual({
      workspaceId: memoized, checkedAt: T0, headSha: "abc1234",
      filesChanged: 4, insertions: 120, deletions: 7,
    });
    expect(rows.find((r) => r.workspaceId === zeroDiff)).toEqual({
      workspaceId: zeroDiff, checkedAt: T0, headSha: null,
      filesChanged: 0, insertions: 0, deletions: 0,
    });
    expect(rows.find((r) => r.workspaceId === never)).toBeUndefined();

    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("diff_stat_cache_"))).toEqual([]);
    // The neighbouring family is untouched — `scorecard_*` is the next cut, not this one.
    expect(names.filter((n) => n.startsWith("scorecard_"))).toHaveLength(3);
    // And no workspace was lost.
    const all = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(all.rows.map((r) => String(r[0]))).toEqual([memoized, zeroDiff, never]);
    client.close();
  });
});
