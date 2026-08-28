// @gate:always-run — the backfill assertion reads the 0140 migration .sql off disk, which is
// not in this file's import graph (#815).
// @covers workspaces.provisioning.setup-script [persistence,migration]
/**
 * #815 — the setup-script run lives in `workspace_setup_run`, not in eight `latest_setup_*`
 * columns on `workspaces`.
 *
 * This is the `latest_symlink_*` case again (#798) and follows it almost verbatim: a run
 * record written at creation, in the workspace's own transaction, whose HISTORY is the point
 * — a workspace that comes up `blocked` is diagnosed from exactly this, and
 * `born-blocked-reconciler.ts` restamps it on a retry precisely so the operator reads a dated
 * verdict rather than one from five days ago.
 *
 * What must hold after the move:
 *  - `getWorkspaceDetails` still projects `latestSetup` from the run — the reads alias the
 *    new columns back to the old field names, so the DTO and the client never see the change;
 *  - a workspace with no run row still projects (LEFT JOIN), with `latestSetup: null`;
 *  - the reconciler's PARTIAL restamp still updates four fields and leaves the rest;
 *  - the migration backfills every existing run.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaceSetupRun, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { MIGRATION_FILES, MIGRATIONS_DIR, readMigrationStatements } from "./helpers/migrations.js";
import {
  getWorkspaceSetupRun,
  insertWorkspaceSetupRun,
  restampWorkspaceSetupRun,
  updateWorkspaceSetupRun,
} from "../repositories/workspace-setup-run.repository.js";
import { getWorkspaceDetails } from "../repositories/workspace-reads.repository.js";

const T0 = "2026-08-23T00:00:00.000Z";
const MIGRATION_0140 = "0140_workspace_setup_run.sql";

const RUN = {
  command: "pnpm install -r",
  state: "failed",
  startedAt: T0,
  endedAt: "2026-08-23T00:00:09.000Z",
  exitCode: 1,
  durationMs: 9000,
  stdoutTail: "resolving...",
  stderrTail: "ERR_PNPM_FETCH_404",
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
    baseBranch: "master", status: "blocked", provider: "claude", createdAt: T0, updatedAt: T0,
  });
  return workspaceId;
}

describe("setup-run extraction (#815)", () => {
  it("the eight latest_setup_* columns are gone from workspaces", async () => {
    const { client } = createTestDb();
    const info = await client.execute('PRAGMA table_info("workspaces")');
    expect(columnNames(info.rows).filter((n) => n.startsWith("latest_setup_"))).toEqual([]);
    // `latest_launch_error` is a neighbour, not a member of this family — it stays.
    expect(columnNames(info.rows)).toContain("latest_launch_error");
    const moved = await client.execute('PRAGMA table_info("workspace_setup_run")');
    expect(columnNames(moved.rows).sort()).toEqual([
      "command", "duration_ms", "ended_at", "exit_code", "started_at", "state",
      "stderr_tail", "stdout_tail", "workspace_id",
    ]);
  });

  it("a recorded run still reaches the workspace-details read under its old field names", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    await insertWorkspaceSetupRun(workspaceId, RUN, db);

    expect(await db.select().from(workspaceSetupRun)
      .where(eq(workspaceSetupRun.workspaceId, workspaceId)))
      .toEqual([{ workspaceId, ...RUN }]);

    // The aliasing is the whole reason the projection, the DTO and the client are untouched.
    const row = await getWorkspaceDetails(workspaceId, db);
    expect(row?.latestSetup).toEqual({
      command: RUN.command,
      state: "failed",
      startedAt: RUN.startedAt,
      endedAt: RUN.endedAt,
      exitCode: 1,
      durationMs: 9000,
      stdoutTail: RUN.stdoutTail,
      stderrTail: RUN.stderrTail,
    });
  });

  it("a workspace with no run still reads, with latestSetup null", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    // The LEFT JOIN case: an inner join would make the whole workspace unreadable.
    const row = await getWorkspaceDetails(workspaceId, db);
    expect(row).not.toBeNull();
    expect(row?.latestSetup).toBeNull();
    expect(await getWorkspaceSetupRun(workspaceId, db)).toBeUndefined();
  });

  it("a re-run replaces the whole record; a restamp updates only the verdict", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await insertWorkspaceSetupRun(workspaceId, RUN, db);

    const rerun = { ...RUN, state: "succeeded", exitCode: 0, stderrTail: null, durationMs: 4000 };
    await updateWorkspaceSetupRun(workspaceId, rerun, db);
    expect(await getWorkspaceSetupRun(workspaceId, db)).toEqual({ workspaceId, ...rerun });

    // The born-blocked restamp is deliberately PARTIAL — command/startedAt/durationMs/
    // stdoutTail keep their values, exactly as the four-column UPDATE left them.
    await restampWorkspaceSetupRun(workspaceId, {
      state: "failed", endedAt: "2026-08-23T02:00:00.000Z", exitCode: 7, stderrTail: "again",
    }, db);
    expect(await getWorkspaceSetupRun(workspaceId, db)).toEqual({
      workspaceId,
      command: RUN.command,
      state: "failed",
      startedAt: RUN.startedAt,
      endedAt: "2026-08-23T02:00:00.000Z",
      exitCode: 7,
      durationMs: 4000,
      stdoutTail: RUN.stdoutTail,
      stderrTail: "again",
    });
  });

  it("a restamp on a workspace with no record inserts one", async () => {
    const { db } = createTestDb();
    const workspaceId = await seedWorkspace(db);

    // The old four-column UPDATE could never miss — the columns were always on the row. The
    // upsert is what keeps that true now that the row can be absent.
    await restampWorkspaceSetupRun(workspaceId, {
      state: "failed", endedAt: T0, exitCode: 1, stderrTail: "first verdict",
    }, db);
    expect(await getWorkspaceSetupRun(workspaceId, db)).toMatchObject({
      state: "failed", exitCode: 1, stderrTail: "first verdict", command: null,
    });
  });

  it("the run dies with its workspace (ON DELETE CASCADE)", async () => {
    const { db, client } = createTestDb();
    const workspaceId = await seedWorkspace(db);
    await insertWorkspaceSetupRun(workspaceId, RUN, db);

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({ sql: "DELETE FROM workspaces WHERE id = ?", args: [workspaceId] });

    expect(await db.select().from(workspaceSetupRun)).toHaveLength(0);
  });
});

describe("migration 0140 backfills the extracted family (#815)", () => {
  it("carries the run into workspace_setup_run, and drops nothing else", async () => {
    const client = createClient({ url: ":memory:" });
    const upTo = MIGRATION_FILES.indexOf(MIGRATION_0140);
    expect(upTo, `${MIGRATION_0140} must be in the journal`).toBeGreaterThan(0);
    for (const file of MIGRATION_FILES.slice(0, upTo)) {
      for (const stmt of readMigrationStatements(file, MIGRATIONS_DIR)) await client.execute(stmt);
    }
    const db = drizzle(client, { schema });

    const projectId = randomUUID();
    const statusId = randomUUID();
    const issueId = randomUUID();
    const ran = randomUUID();
    const untouched = randomUUID();
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
    for (const [id, branch] of [[ran, "feature/ran"], [untouched, "feature/clean"]]) {
      await client.execute({
        sql: "INSERT INTO workspaces (id, issue_id, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, issueId, branch, "idle", T0, T0],
      });
    }
    await client.execute({
      sql: `UPDATE workspaces SET latest_setup_command = ?, latest_setup_state = ?,
            latest_setup_started_at = ?, latest_setup_ended_at = ?, latest_setup_exit_code = ?,
            latest_setup_duration_ms = ?, latest_setup_stdout_tail = ?, latest_setup_stderr_tail = ?
            WHERE id = ?`,
      args: [RUN.command, RUN.state, RUN.startedAt, RUN.endedAt, RUN.exitCode, RUN.durationMs,
        RUN.stdoutTail, RUN.stderrTail, ran],
    });

    for (const stmt of readMigrationStatements(MIGRATION_0140, MIGRATIONS_DIR)) await client.execute(stmt);

    expect(await db.select().from(workspaceSetupRun)).toEqual([{ workspaceId: ran, ...RUN }]);
    const names = columnNames((await client.execute('PRAGMA table_info("workspaces")')).rows);
    expect(names.filter((n) => n.startsWith("latest_setup_"))).toEqual([]);
    // The neighbours are untouched — including the similarly-named `latest_launch_error`.
    expect(names).toContain("latest_launch_error");
    expect(names.filter((n) => n.startsWith("diff_stat_cache_"))).toHaveLength(5);
    expect(names).toContain("summary_head_sha");
    // And left the rows whole.
    const both = await client.execute("SELECT id FROM workspaces ORDER BY branch");
    expect(both.rows.map((r) => String(r[0]))).toEqual([untouched, ran]); // ordered by branch
    client.close();
  });
});
