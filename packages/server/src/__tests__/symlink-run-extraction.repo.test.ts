// @gate:always-run — the backfill assertion reads the 0136 migration .sql off disk, which is
// not in this file's import graph (#798).
// @covers workspaces.provisioning.symlink-bootstrap [persistence,migration]
/**
 * #798 — the dependency-symlink bootstrap run lives in `workspace_symlink_run`, not in eight
 * `latest_symlink_*` columns on `workspaces`.
 *
 * This family carried the ticket's ONE OPEN QUESTION — extract, or retire? Dependency
 * Symlinks is off by default, so the eight columns look like a legacy feature paying rent on
 * every row. The answer is EXTRACT, and the first test here is the evidence in executable
 * form: the run record still round-trips through the read path the diagnostics panel
 * consumes, which is only interesting because that path is live. See the header of
 * `0136_workspace_symlink_run.sql` for the full argument.
 *
 * What must hold after the move:
 *  - `getWorkspaceDetails` still projects `latestSymlink` from the run — the reads alias the
 *    new columns back to the old field names, so the DTO and the client never see the change;
 *  - a workspace with no run row still projects (LEFT JOIN), with `latestSymlink: null`;
 *  - the migration backfills every existing run.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceSymlinkRun, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  getWorkspaceSymlinkRun,
  insertWorkspaceSymlinkRun,
} from "../repositories/workspace-symlink-run.repository.js";
import { getWorkspaceDetails } from "../repositories/workspace-reads.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0136 = "0136_workspace_symlink_run.sql";

const RUN = {
  state: "success",
  startedAt: T0,
  endedAt: "2026-08-23T00:00:02.000Z",
  dirs: '["node_modules"]',
  linked: '["node_modules"]',
  skipped: "[]",
  failed: "[]",
  error: null,
};

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

describe("symlink-run extraction (#798)", () => {
  it("the eight latest_symlink_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("latest_symlink_"))).toEqual([]);
    // `latest_setup_*` is a DIFFERENT family and stays — the prefixes are one character apart.
    expect(columnNames(info.rows).filter((n) => n.startsWith("latest_setup_"))).toHaveLength(8);
    const moved = await client.execute('PRAGMA table_info("workspace_symlink_run")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "dirs", "ended_at", "error", "failed", "linked", "skipped", "started_at", "state", "workspace_id",
    ]);
  });

  it("a recorded run still reaches the workspace-details read under its old field names", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await insertWorkspaceSymlinkRun(workspaceId, RUN, db);

    expect(await db.select().from(workspaceSymlinkRun)
      .where(eq(workspaceSymlinkRun.workspaceId, workspaceId)))
      .toEqual([{ workspaceId, ...RUN }]);

    // The aliasing is the whole reason the projection, the DTO and the client are untouched.
    const row = await getWorkspaceDetails(workspaceId, db);
    expect(row?.latestSymlink).toEqual({
      state: "success",
      dirs: ["node_modules"],
      linked: ["node_modules"],
      skipped: [],
      failed: [],
      startedAt: RUN.startedAt,
      endedAt: RUN.endedAt,
      error: null,
    });
  });

  it("a workspace with no run still reads, with the symlink fields null", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    // The LEFT JOIN case: an inner join would make the whole workspace unreadable.
    const row = await getWorkspaceDetails(workspaceId, db);
    expect(row).not.toBeNull();
    expect(row?.latestSymlink).toBeNull();
    expect(await getWorkspaceSymlinkRun(workspaceId, db)).toBeUndefined();
  });

  it("the run dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await insertWorkspaceSymlinkRun(workspaceId, RUN, db);

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceSymlinkRun)).toHaveLength(0);
  });
});

describe("migration 0136 backfills the extracted family (#798)", () => {
  it("carries the run into workspace_symlink_run, and drops nothing else", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0136);
    expect(upTo, `${MIGRATION_0136} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const linked = randomUUID();
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
    for (const [id, branch] of [[linked, "feature/linked"], [untouched, "feature/clean"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET latest_symlink_state = ?, latest_symlink_started_at = ?,
            latest_symlink_ended_at = ?, latest_symlink_dirs = ?, latest_symlink_linked = ?,
            latest_symlink_skipped = ?, latest_symlink_failed = ? WHERE id = ?`,
      args: [RUN.state, RUN.startedAt, RUN.endedAt, RUN.dirs, RUN.linked, RUN.skipped, RUN.failed, linked],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0136, MIGRATIONS_DIR)) await client.execute(stmt);

    expect(await db.select().from(workspaceSymlinkRun)).toEqual([{ workspaceId: linked, ...RUN }]);
    // The drop took only the eight columns — and left the neighbouring `latest_setup_` family.
    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("latest_symlink_"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("latest_setup_"))).toHaveLength(8);
    expect(names).toContain("latest_launch_error");
    // And left the rows whole.
    const both = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(both.rows.map((r) => String(r[0]))).toEqual([untouched, linked]); // ordered by branch
    client.close();
  });
});
