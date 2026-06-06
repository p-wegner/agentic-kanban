import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { finalizeMergeCleanup } from "../services/merge-cleanup.service.js";
import type { BoardEvents } from "../services/board-events.js";

async function seedMergeCleanupRows(db: ReturnType<typeof createTestDb>["db"]) {
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

  return { projectId, issueId, workspaceId, doneStatusId };
}

describe("finalizeMergeCleanup", () => {
  it("closes the workspace, moves the issue to Done, and broadcasts once for repeated cleanup", async () => {
    const { db } = createTestDb();
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
});
