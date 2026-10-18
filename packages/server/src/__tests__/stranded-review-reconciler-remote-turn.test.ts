/**
 * #1615: a remote follow-up session assigned between the reconciler's candidate scan and its
 * write must keep readyForMerge false — a live session means the workspace is not stranded.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileStrandedReviews } from "../startup/stranded-review-reconciler.js";

vi.spyOn(console, "log").mockImplementation(() => {});

async function seed(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID(), statusId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "T", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now });
  await db.insert(issues).values({ id: issueId, issueNumber: 1613, title: "t", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1613-t", workingDir: "/repo/.worktrees/ws", baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: false, provider: "claude", createdAt: now, updatedAt: now,
  });
  await db.insert(preferences).values({ key: "auto_review", value: "false", updatedAt: now });
  return { projectId, workspaceId };
}

describe("reconcileStrandedReviews — remote follow-up turn (#1615)", () => {
  it("does not mark ready when a remote session is assigned mid-pass", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);
    const hasCommittedWork = vi.fn(async () => {
      await db.insert(sessions).values({
        id: randomUUID(), workspaceId, executor: "claude-code", status: "running", workerId: "worker-1", triggerType: "chat",
      });
      return true;
    });

    await reconcileStrandedReviews({
      database: db, getSessionManager: () => ({}) as never, boardEvents: { broadcast: vi.fn() } as never,
      reviewSessionIds: new Set(), hasCommittedWork,
    });

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(hasCommittedWork).toHaveBeenCalled();
    expect(ws.readyForMerge).toBe(false);
  });

  it("still marks a genuinely stranded workspace ready", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);
    await reconcileStrandedReviews({
      database: db, getSessionManager: () => ({}) as never, boardEvents: { broadcast: vi.fn() } as never,
      reviewSessionIds: new Set(), hasCommittedWork: async () => true,
    });
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(true);
  });
});
