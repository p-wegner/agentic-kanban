import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { MIGRATION_FILES, MIGRATIONS_DIR } from "./helpers/migrations.js";
import type { TestDb } from "./helpers/test-db.js";
import { finalizeMergeCleanup, reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import type { BoardEvents } from "../services/board-events.js";

const tempClients: ReturnType<typeof createClient>[] = [];

afterEach(async () => {
  for (const client of tempClients.splice(0)) {
    await client.close();
  }
});

async function createMergeCleanupTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "ak-merge-cleanup-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  tempClients.push(client);
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
  }
  const db = drizzle(client, { schema });
  return { client, db };
}

async function seedMergeCleanupRows(db: TestDb) {
  const now = "2026-06-06T10:00:00.000Z";
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Merge cleanup test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 640,
    title: "Extract merge cleanup",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-640-test",
    workingDir: "/repo/.worktrees/feature_ak-640-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    mergedAt: null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, inReviewStatusId, doneStatusId };
}

describe("finalizeMergeCleanup", () => {
  it("closes the workspace, moves the issue to Done, and broadcasts once for repeated cleanup", async () => {
    const { db } = await createMergeCleanupTestDb();
    const { projectId, issueId, workspaceId, doneStatusId } = await seedMergeCleanupRows(db);
    const boardEvents = { broadcast: vi.fn() } as unknown as BoardEvents;

    const first = await finalizeMergeCleanup({
      database: db,
      boardEvents,
      workspaceId,
      issueId,
      projectId,
      now: "2026-06-06T10:05:00.000Z",
      mergedAt: "2026-06-06T10:05:00.000Z",
      workingDir: null,
    });
    const second = await finalizeMergeCleanup({
      database: db,
      boardEvents,
      workspaceId,
      issueId,
      projectId,
      now: "2026-06-06T10:06:00.000Z",
      mergedAt: "2026-06-06T10:06:00.000Z",
      workingDir: null,
    });

    expect(first).toMatchObject({
      projectId,
      workspaceUpdated: true,
      issueTransitioned: true,
      broadcasted: true,
      mergedAt: "2026-06-06T10:05:00.000Z",
    });
    expect(second).toMatchObject({
      workspaceUpdated: false,
      issueTransitioned: false,
      broadcasted: false,
      mergedAt: "2026-06-06T10:05:00.000Z",
    });
    expect(boardEvents.broadcast).toHaveBeenCalledTimes(1);
    expect(boardEvents.broadcast).toHaveBeenCalledWith(projectId, "workspace_merged");

    const [workspace] = await db
      .select({
        status: workspaces.status,
        readyForMerge: workspaces.readyForMerge,
        workingDir: workspaces.workingDir,
        closedAt: workspaces.closedAt,
        mergedAt: workspaces.mergedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const [issue] = await db
      .select({ statusId: issues.statusId, statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(workspace).toEqual({
      status: "closed",
      readyForMerge: false,
      workingDir: null,
      closedAt: "2026-06-06T10:05:00.000Z",
      mergedAt: "2026-06-06T10:05:00.000Z",
    });
    expect(issue.statusId).toBe(doneStatusId);
    expect(issue.statusChangedAt).toBe("2026-06-06T10:05:00.000Z");
  });

  it("keeps issue Done when workspace close fails (#668: no rollback)", async () => {
    // #668 regression: previously, a workspace DB update failure would roll back
    // the issue → Done transition, stranding the issue In Review even though the
    // git merge had already landed. The fix: don't roll back — the issue stays
    // Done, the workspace failure is logged, and the startup reconciler can close
    // the workspace on next boot.
    const { client, db } = await createMergeCleanupTestDb();
    const { issueId, workspaceId, doneStatusId } = await seedMergeCleanupRows(db);
    await client.execute(`
      CREATE TRIGGER fail_workspace_update
      BEFORE UPDATE ON workspaces
      BEGIN
        SELECT RAISE(ABORT, 'workspace update failed');
      END
    `);

    // #668 fix: finalizeMergeCleanup no longer throws when workspace close fails.
    // The issue transition to Done is preserved.
    const result = await finalizeMergeCleanup({
      database: db,
      workspaceId,
      issueId,
      now: "2026-06-06T10:05:00.000Z",
      mergedAt: "2026-06-06T10:05:00.000Z",
      workingDir: null,
    });

    // Issue was transitioned (not rolled back)
    expect(result.issueTransitioned).toBe(true);

    const [workspace] = await db
      .select({
        status: workspaces.status,
        readyForMerge: workspaces.readyForMerge,
        workingDir: workspaces.workingDir,
        closedAt: workspaces.closedAt,
        mergedAt: workspaces.mergedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const [issue] = await db
      .select({ statusId: issues.statusId, statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId));

    // Workspace stays not-closed (DB update failed) — reconciler will fix this
    expect(workspace).toMatchObject({
      status: "idle",
      readyForMerge: true,
      workingDir: "/repo/.worktrees/feature_ak-640-test",
      closedAt: null,
      mergedAt: null,
    });
    // Issue is Done — NOT rolled back to In Review
    expect(issue.statusId).toBe(doneStatusId);
    expect(issue.statusChangedAt).toBe("2026-06-06T10:05:00.000Z");
  });
});

/**
 * A merged issue that a human deliberately REOPENED must stay reopened. The monitor's
 * already-merged sweep (`reconcileStaleMergedIssue`) runs every cycle, so an unconditional
 * "force it to Done" silently undid the operator over and over. The catch-up reconcile is
 * therefore recency-aware: it converges only when the status predates the merge.
 */
describe("reconcileMergedIssue — reopened after merge", () => {
  /** Relative timestamps (never hardcoded absolutes that age out) around a single merge. */
  const mergedAt = new Date(Date.now() - 60_000).toISOString();
  const beforeMerge = new Date(Date.now() - 120_000).toISOString();
  const afterMerge = new Date(Date.now() - 30_000).toISOString();

  async function seedWithTodo() {
    const { db } = await createMergeCleanupTestDb();
    const seeded = await seedMergeCleanupRows(db);
    const todoStatusId = randomUUID();
    await db.insert(projectStatuses).values({
      id: todoStatusId, projectId: seeded.projectId, name: "Todo", sortOrder: 1, isDefault: true,
      createdAt: "2026-06-06T10:00:00.000Z",
    });
    return { db, todoStatusId, ...seeded };
  }

  async function statusOf(db: TestDb, issueId: string) {
    const [row] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    return row.statusId;
  }

  it("leaves a ticket that was moved to Todo AFTER the merge alone", async () => {
    const { db, issueId, projectId, todoStatusId } = await seedWithTodo();
    // The merge landed, then a human reopened the ticket.
    await db.update(issues).set({ statusId: todoStatusId, statusChangedAt: afterMerge }).where(eq(issues.id, issueId));

    const result = await reconcileMergedIssue({ database: db, issueId, projectId, mergedAt });

    expect(result.issueTransitioned).toBe(false);
    expect(result.reopenedAfterMerge).toBe(true);
    expect(await statusOf(db, issueId)).toBe(todoStatusId);
  });

  it("stays put across REPEATED cycles (the sweep runs forever)", async () => {
    const { db, issueId, projectId, todoStatusId } = await seedWithTodo();
    await db.update(issues).set({ statusId: todoStatusId, statusChangedAt: afterMerge }).where(eq(issues.id, issueId));

    for (let cycle = 0; cycle < 3; cycle++) {
      await reconcileMergedIssue({ database: db, issueId, projectId, mergedAt });
    }

    expect(await statusOf(db, issueId)).toBe(todoStatusId);
  });

  it("STILL converges a status that never caught up with the merge (#190 behaviour preserved)", async () => {
    const { db, issueId, projectId, doneStatusId, inReviewStatusId } = await seedWithTodo();
    await db.update(issues).set({ statusId: inReviewStatusId, statusChangedAt: beforeMerge }).where(eq(issues.id, issueId));

    const result = await reconcileMergedIssue({ database: db, issueId, projectId, mergedAt });

    expect(result.issueTransitioned).toBe(true);
    expect(result.reopenedAfterMerge).toBeUndefined();
    expect(await statusOf(db, issueId)).toBe(doneStatusId);
  });

  it("converges unconditionally when the caller passes NO mergedAt (merge path / hand-merge reconciler)", async () => {
    const { db, issueId, projectId, doneStatusId, todoStatusId } = await seedWithTodo();
    await db.update(issues).set({ statusId: todoStatusId, statusChangedAt: afterMerge }).where(eq(issues.id, issueId));

    const result = await reconcileMergedIssue({ database: db, issueId, projectId });

    expect(result.issueTransitioned).toBe(true);
    expect(await statusOf(db, issueId)).toBe(doneStatusId);
  });
});
