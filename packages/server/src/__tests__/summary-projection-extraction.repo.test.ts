// @gate:always-run — the backfill assertion reads the 0141 migration .sql off disk, which is
// not in this file's import graph (#815).
// @covers workspaces.summary.git-projection [persistence,migration]
/**
 * #815 — the workspace-summary git projection lives in `workspace_summary`, not in five
 * `summary_*` columns on `workspaces`.
 *
 * This family is the one that INVERTS the convention the seven landed before it use. Their
 * columns were nullable, so "no row" and "no value" were the same answer. `summary_dirty` was
 * `NOT NULL DEFAULT TRUE`, so here an ABSENT ROW MEANS DIRTY — and every read has to coalesce
 * to say so. The tests below pin that inversion from both ends, because it is exactly the kind
 * of thing that would otherwise fail silently as a board that stops refreshing (absence read as
 * clean) or one that re-spawns git forever (a write-through that cannot create a row).
 *
 * What must hold after the move:
 *  - the hot board read still projects the five facts under their OLD field names;
 *  - a workspace with NO row still reads (LEFT JOIN) and reads as DIRTY, not clean;
 *  - `setWorkspaceStatus` — the single status-write authority — still dirties the projection,
 *    and still dirties NOTHING when its guarded UPDATE matched no row (#966);
 *  - the write-through upserts, so a never-projected workspace can become clean;
 *  - the heal pass ranks a never-projected workspace WITH the dirty ones, not after them
 *    (SQLite sorts NULL last under DESC — the trap the coalesce in the ORDER BY exists for);
 *  - `repos` keeps its own parallel `summary_*` block, deliberately;
 *  - the migration backfills EVERY row, including the clean ones.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceSummary, workspaces } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  markWorkspaceSummaryDirty,
  selectSummaryHealCandidates,
  updateWorkspaceSummaryGitProjection,
} from "../repositories/workspace-summary-projection.repository.js";
import { fetchWorkspaceDetailRows } from "../repositories/workspace-summary.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0141 = "0141_workspace_summary.sql";

type Db = ReturnType<typeof createTestDb>["db"];

function columnNames(rows: readonly unknown[]): string[] {
  return rows.map((r) => String((r as { name: string }).name));
}

async function seedWorkspace(db: Db, opts: { status?: string } = {}): Promise<{ workspaceId: string; issueId: string }> {
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
    baseBranch: "master", status: opts.status ?? "idle", provider: "claude",
    createdAt: T0, updatedAt: T0,
  });
  return { workspaceId, issueId };
}

describe("summary-projection extraction (#815)", () => {
  it("the five summary_* columns are gone from workspaces, and repos keeps its own", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("summary_"))).toEqual([]);

    const moved = await client.execute('PRAGMA table_info("workspace_summary")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "commit_count", "dirty", "git_refreshed_at", "head_message", "head_sha", "workspace_id",
    ]);

    // The PARALLEL projection on `repos` is deliberately NOT part of this move: different
    // columns, different freshness predicate, its own heal pass, and a 23-column table with no
    // width ratchet on it. If someone extracts it later this assertion is the thing to update
    // on purpose rather than a symmetry that quietly rotted.
    const repoCols = columnNames((await client.execute('PRAGMA table_info("repos")')).rows);
    expect(repoCols.filter((n) => n.startsWith("summary_")).sort()).toEqual([
      "summary_ahead", "summary_dirty", "summary_git_refreshed_at", "summary_historic",
    ]);
  });

  it("the hot board read serves the projection under its OLD field names", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedWorkspace(db);
    await db.insert(workspaceSummary).values({
      workspaceId, headSha: "abc1234", headMessage: "feat: land it",
      commitCount: 3, gitRefreshedAt: T0, dirty: false,
    });

    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row).toMatchObject({
      summaryHeadSha: "abc1234",
      summaryHeadMessage: "feat: land it",
      summaryCommitCount: 3,
      summaryGitRefreshedAt: T0,
      summaryDirty: false,
    });
  });

  it("a workspace with no row still reads — and reads as DIRTY, not clean", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedWorkspace(db);

    // The LEFT JOIN case. An inner join would drop every brand-new workspace off the board;
    // an un-coalesced `dirty` would report it CLEAN and it would never be refreshed.
    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row).toBeDefined();
    expect(row.summaryHeadSha).toBeNull();
    expect(row.summaryGitRefreshedAt).toBeNull();
    expect(row.summaryDirty).toBe(true);
    expect(await db.select().from(workspaceSummary)
      .where(eq(workspaceSummary.workspaceId, workspaceId))).toEqual([]);
  });

  it("the write-through UPSERTS, so a never-projected workspace can become clean", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);

    // An UPDATE here would no-op and leave the workspace dirty forever, re-spawning git on
    // every heal tick — the exact failure the absence-is-dirty inversion sets up.
    await updateWorkspaceSummaryGitProjection(workspaceId, {
      summaryHeadSha: "def5678",
      summaryHeadMessage: "chore: first projection",
      summaryCommitCount: 1,
      summaryGitRefreshedAt: T0,
    }, db);
    expect(await db.select().from(workspaceSummary)).toEqual([{
      workspaceId, headSha: "def5678", headMessage: "chore: first projection",
      commitCount: 1, gitRefreshedAt: T0, dirty: false,
    }]);

    // ...and a second refresh REPLACES rather than duplicating or failing the PK.
    await updateWorkspaceSummaryGitProjection(workspaceId, {
      summaryHeadSha: "999aaaa", summaryHeadMessage: "next", summaryCommitCount: 2,
      summaryGitRefreshedAt: "2026-08-23T01:00:00.000Z",
    }, db);
    expect(await db.select().from(workspaceSummary)).toMatchObject([
      { workspaceId, headSha: "999aaaa", commitCount: 2, dirty: false },
    ]);
  });

  it("marking dirty is a plain UPDATE — a missing row is a no-op that is ALREADY dirty", async () => {
    const { db } = createTestDb();
    const { workspaceId, issueId } = await seedWorkspace(db);

    await markWorkspaceSummaryDirty(workspaceId, db);

    // No row was invented, and the read still says dirty. Inserting one here would be the
    // "correct-looking" mistake: it writes a row whose only content is the default.
    expect(await db.select().from(workspaceSummary)).toEqual([]);
    const [row] = await fetchWorkspaceDetailRows([issueId], db);
    expect(row.summaryDirty).toBe(true);
  });

  it("setWorkspaceStatus dirties the projection, and dirties nothing on a guarded no-op", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db, { status: "active" });
    await db.insert(workspaceSummary).values({
      workspaceId, headSha: "abc1234", headMessage: "m", commitCount: 1,
      gitRefreshedAt: T0, dirty: false,
    });

    expect(await setWorkspaceStatus(db, workspaceId, "reviewing", { caller: "test" })).toBe(true);
    expect((await db.select().from(workspaceSummary))[0].dirty).toBe(true);

    // A CAS miss must dirty NOTHING — the property the atomic column write used to give for
    // free, and the reason the new UPDATE sits after the `affected === 0` return.
    await db.update(workspaceSummary).set({ dirty: false })
      .where(eq(workspaceSummary.workspaceId, workspaceId));
    expect(await setWorkspaceStatus(db, workspaceId, "idle", {
      caller: "test", onlyIfCurrentStatus: "active",
    })).toBe(false);
    expect((await db.select().from(workspaceSummary))[0].dirty).toBe(false);
  });

  it("the heal pass ranks a never-projected workspace WITH the dirty ones, not after them", async () => {
    const { db } = createTestDb();
    const { workspaceId: dirtyWs, issueId } = await seedWorkspace(db);
    await db.insert(workspaceSummary).values({
      workspaceId: dirtyWs, headSha: "aaa", gitRefreshedAt: T0, dirty: true,
    });
    // A second workspace on the same issue, with NO row at all.
    const neverWs = randomUUID();
    await db.insert(workspaces).values({
      id: neverWs, issueId, branch: "feature/ak-2", workingDir: "/repo/.worktrees/ws2",
      baseBranch: "master", status: "idle", createdAt: T0, updatedAt: T0,
    });
    // A third that is CLEAN but STALE — a legitimate candidate that must rank BEHIND both
    // dirty ones. It is what makes the ordering assertion below actually test the ORDER BY:
    // with only the two dirty rows in play, any order passes.
    const staleWs = randomUUID();
    await db.insert(workspaces).values({
      id: staleWs, issueId, branch: "feature/ak-3", workingDir: "/repo/.worktrees/ws3",
      baseBranch: "master", status: "idle", createdAt: T0, updatedAt: T0,
    });
    await db.insert(workspaceSummary).values({
      workspaceId: staleWs, headSha: "ccc", gitRefreshedAt: "2020-01-01T00:00:00.000Z", dirty: false,
    });
    // A fourth that is genuinely CLEAN and FRESH — it must not be picked up at all.
    const cleanWs = randomUUID();
    await db.insert(workspaces).values({
      id: cleanWs, issueId, branch: "feature/ak-4", workingDir: "/repo/.worktrees/ws4",
      baseBranch: "master", status: "idle", createdAt: T0, updatedAt: T0,
    });
    await db.insert(workspaceSummary).values({
      workspaceId: cleanWs, headSha: "ddd", gitRefreshedAt: "2999-01-01T00:00:00.000Z", dirty: false,
    });

    const picked = await selectSummaryHealCandidates(10, "2026-08-22T00:00:00.000Z", db);
    const ids = picked.map((c) => c.id);
    expect(ids).toContain(neverWs);
    expect(ids).toContain(dirtyWs);
    expect(ids).toContain(staleWs);
    expect(ids).not.toContain(cleanWs);
    expect(picked.find((c) => c.id === neverWs)!.summaryDirty).toBe(true);
    // The ordering claim, and the reason the ORDER BY coalesces: SQLite sorts NULL LAST under
    // DESC, so ordering on the raw column would put the never-projected workspace BEHIND the
    // merely-stale one — last in a `limit`-bounded worklist instead of first.
    expect(ids.indexOf(neverWs)).toBeLessThan(ids.indexOf(staleWs));
    expect(ids.indexOf(dirtyWs)).toBeLessThan(ids.indexOf(staleWs));
  });

  it("the projection dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await db.insert(workspaceSummary).values({ workspaceId, headSha: "abc", dirty: false });

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceSummary)).toHaveLength(0);
  });
});

describe("migration 0141 backfills the extracted family (#815)", () => {
  it("carries EVERY row's projection state across, and leaves the neighbours alone", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0141);
    expect(upTo, `${MIGRATION_0141} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const projected = randomUUID();
    const clean = randomUUID();
    const never = randomUUID();
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
    for (const [id, branch] of [[projected, "a"], [clean, "b"], [never, "c"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET summary_head_sha = ?, summary_head_message = ?,
            summary_commit_count = ?, summary_git_refreshed_at = ?, summary_dirty = 0 WHERE id = ?`,
      args: ["abc1234", "feat: land it", 3, T0, projected],
    });
    // Facts NULL but explicitly CLEAN — the row a "skip the empty ones" WHERE clause would have
    // dropped, silently turning a clean projection back into "absent, therefore dirty".
    await client.execute({
      sql: "UPDATE workspaces SET summary_dirty = 0 WHERE id = ?", args: [clean],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0141, MIGRATIONS_DIR)) await client.execute(stmt);

    const rows = await db.select().from(workspaceSummary);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.workspaceId === projected)).toEqual({
      workspaceId: projected, headSha: "abc1234", headMessage: "feat: land it",
      commitCount: 3, gitRefreshedAt: T0, dirty: false,
    });
    expect(rows.find((r) => r.workspaceId === clean)).toEqual({
      workspaceId: clean, headSha: null, headMessage: null,
      commitCount: null, gitRefreshedAt: null, dirty: false,
    });
    // The never-touched row carried the column default, which is TRUE — and it must arrive as
    // TRUE, not as an absent row that merely happens to read the same way.
    expect(rows.find((r) => r.workspaceId === never)).toMatchObject({ dirty: true });

    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("summary_"))).toEqual([]);
    // The neighbouring families are untouched.
    expect(names.filter((n) => n.startsWith("diff_stat_cache_"))).toHaveLength(5);
    expect(names).toContain("scorecard_score");
    // And `repos` kept its own parallel block.
    const repoCols = columnNames((await client.execute('PRAGMA table_info("repos")')).rows);
    expect(repoCols.filter((n) => n.startsWith("summary_"))).toHaveLength(4);

    const all = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(all.rows.map((r) => String(r[0]))).toEqual([projected, clean, never]);
    client.close();
  });
});
