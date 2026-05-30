import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/repo",
    repoName: "repo",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [idx, name] of ["In Review", "AI Reviewed", "Done"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder: idx,
      isDefault: false,
      createdAt: now,
    });
  }
  return { projectId, statusIds };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    projectId: string;
    statusId: string;
    readyForMerge?: boolean;
    workspaceStatus?: string;
    isDirect?: boolean;
  },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Issue",
    priority: "medium",
    sortOrder: 0,
    statusId: opts.statusId,
    projectId: opts.projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: `feature/${workspaceId}`,
    workingDir: `/tmp/repo/.worktrees/${workspaceId}`,
    baseBranch: "main",
    isDirect: opts.isDirect ?? false,
    status: opts.workspaceStatus ?? "idle",
    readyForMerge: opts.readyForMerge ?? false,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

describe("auto-merge orchestrator", () => {
  it("finds idle reviewed workspaces and excludes direct, closed, and in-progress workspaces", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const ready = await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: true });
    const aiReviewed = await seedWorkspace(db, { projectId, statusId: statusIds["AI Reviewed"] });
    await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: true, isDirect: true });
    await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: true, workspaceStatus: "closed" });
    await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: false });
    await seedWorkspace(db, { projectId, statusId: statusIds["Done"], readyForMerge: true });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    await expect(orchestrator.findCompletedWorkspaceIds()).resolves.toEqual(expect.arrayContaining([ready, aiReviewed]));
    const ids = await orchestrator.findCompletedWorkspaceIds();
    expect(ids).toHaveLength(2);
  });

  it("includes idle In Review workspaces only when auto_merge_in_review is enabled", async () => {
    const { db } = createTestDb();
    const { projectId, statusIds } = await seedProject(db);
    const inReview = await seedWorkspace(db, { projectId, statusId: statusIds["In Review"], readyForMerge: false });

    const orchestrator = createAutoMergeOrchestrator({ database: db });
    await expect(orchestrator.findCompletedWorkspaceIds()).resolves.not.toContain(inReview);

    await db.insert(preferences).values({
      key: "auto_merge_in_review",
      value: "true",
      updatedAt: new Date().toISOString(),
    });

    await expect(orchestrator.findCompletedWorkspaceIds()).resolves.toContain(inReview);
  });
});
