import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { generateBoardRiskDigest } from "../services/board-risk-digest.service.js";

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Risk Test Project",
    repoPath: `C:/tmp/${projectId}`,
    repoName: "risk-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  // seed statuses
  const todoId = randomUUID();
  const inProgressId = randomUUID();
  const inReviewId = randomUUID();
  const doneId = randomUUID();
  await db.insert(schema.projectStatuses).values([
    { id: todoId, projectId, name: "Todo", sortOrder: 0, createdAt: now, updatedAt: now },
    { id: inProgressId, projectId, name: "In Progress", sortOrder: 1, createdAt: now, updatedAt: now },
    { id: inReviewId, projectId, name: "In Review", sortOrder: 2, createdAt: now, updatedAt: now },
    { id: doneId, projectId, name: "Done", sortOrder: 3, createdAt: now, updatedAt: now },
  ]);

  return { projectId, todoId, inProgressId, inReviewId, doneId };
}

async function createIssue(
  db: ReturnType<typeof createTestDb>["db"],
  projectId: string,
  statusId: string,
  title: string,
  issueNumber: number,
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  await db.insert(schema.issues).values({
    id: issueId,
    projectId,
    statusId,
    title,
    issueNumber,
    createdAt: now,
    updatedAt: now,
  });
  return issueId;
}

async function createWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  issueId: string,
  status: string,
  opts: {
    readyForMerge?: boolean;
    workingDir?: string | null;
  } = {},
) {
  const now = new Date().toISOString();
  const wsId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: wsId,
    issueId,
    branch: `feature/test-${wsId.slice(0, 8)}`,
    status,
    readyForMerge: opts.readyForMerge ?? false,
    workingDir: opts.workingDir ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return wsId;
}

async function createSession(
  db: ReturnType<typeof createTestDb>["db"],
  workspaceId: string,
  sessionStatus: string,
  startedAt: string,
) {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  await db.insert(schema.sessions).values({
    id: sessionId,
    workspaceId,
    status: sessionStatus,
    startedAt,
    createdAt: now,
    updatedAt: now,
  });
  return sessionId;
}

describe("generateBoardRiskDigest", () => {
  it("returns empty digest for a project with no issues", async () => {
    const { db } = createTestDb();
    const { projectId } = await seedProject(db);

    const digest = await generateBoardRiskDigest(projectId, db as never);

    expect(digest.projectId).toBe(projectId);
    expect(digest.summary.mergeBlockers).toBe(0);
    expect(digest.summary.staleSessions).toBe(0);
    expect(digest.summary.healthIssues).toBe(0);
    expect(digest.summary.backlogCount).toBe(0);
    expect(digest.summary.lowBacklog).toBe(true);
    expect(digest.topItems).toHaveLength(1); // the synthetic low_backlog item
    expect(digest.topItems[0].category).toBe("low_backlog");
    expect(digest.allItems).toHaveLength(1);
  });

  it("detects error workspace as stale_session", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);

    const issueId = await createIssue(db, projectId, inProgressId, "Broken task", 5);
    await createWorkspace(db, issueId, "error");

    const digest = await generateBoardRiskDigest(projectId, db as never);

    expect(digest.summary.staleSessions).toBe(1);
    const errorItem = digest.allItems.find((i) => i.category === "stale_session");
    expect(errorItem).toBeDefined();
    expect(errorItem!.issueNumber).toBe(5);
    expect(errorItem!.severity).toBe("high");
    expect(errorItem!.reason).toMatch(/error state/i);
  });

  it("detects stale running session (no activity for 2+ hours, uses startedAt as fallback)", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);

    const issueId = await createIssue(db, projectId, inProgressId, "Hung agent", 7);
    const wsId = await createWorkspace(db, issueId, "active");

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await createSession(db, wsId, "running", threeHoursAgo);

    const digest = await generateBoardRiskDigest(projectId, db as never);

    expect(digest.summary.staleSessions).toBe(1);
    const staleItem = digest.allItems.find((i) => i.category === "stale_session");
    expect(staleItem).toBeDefined();
    expect(staleItem!.issueNumber).toBe(7);
    expect(staleItem!.reason).toMatch(/3h/);
  });

  it("does NOT flag a recently started running session as stale", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);

    const issueId = await createIssue(db, projectId, inProgressId, "Active task", 8);
    const wsId = await createWorkspace(db, issueId, "active");

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await createSession(db, wsId, "running", tenMinutesAgo);

    const digest = await generateBoardRiskDigest(projectId, db as never);

    const staleItems = digest.allItems.filter((i) => i.category === "stale_session");
    expect(staleItems).toHaveLength(0);
  });

  it("flags low backlog when fewer than 3 todo items", async () => {
    const { db } = createTestDb();
    const { projectId, todoId } = await seedProject(db);

    await createIssue(db, projectId, todoId, "Task 1", 1);
    await createIssue(db, projectId, todoId, "Task 2", 2);

    const digest = await generateBoardRiskDigest(projectId, db as never);

    expect(digest.summary.lowBacklog).toBe(true);
    expect(digest.summary.backlogCount).toBe(2);
    const lowItem = digest.allItems.find((i) => i.category === "low_backlog");
    expect(lowItem).toBeDefined();
    expect(lowItem!.reason).toMatch(/2/);
  });

  it("does NOT flag low backlog with 3 or more todo items", async () => {
    const { db } = createTestDb();
    const { projectId, todoId } = await seedProject(db);

    for (let i = 1; i <= 4; i++) {
      await createIssue(db, projectId, todoId, `Task ${i}`, i);
    }

    const digest = await generateBoardRiskDigest(projectId, db as never);

    expect(digest.summary.lowBacklog).toBe(false);
    const lowItems = digest.allItems.filter((i) => i.category === "low_backlog");
    expect(lowItems).toHaveLength(0);
  });

  it("returns top 3 items sorted by severity (high first)", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);

    // Create 4 error workspaces to generate 4 high-severity stale_session items
    for (let i = 1; i <= 4; i++) {
      const issueId = await createIssue(db, projectId, inProgressId, `Error task ${i}`, i);
      await createWorkspace(db, issueId, "error");
    }

    const digest = await generateBoardRiskDigest(projectId, db as never);

    expect(digest.topItems).toHaveLength(3);
    expect(digest.allItems.length).toBeGreaterThan(3);
    for (const item of digest.topItems) {
      expect(item.severity).toBe("high");
    }
  });

  it("summary counts match allItems", async () => {
    const { db } = createTestDb();
    const { projectId, inProgressId } = await seedProject(db);

    // 2 stale sessions
    for (let i = 1; i <= 2; i++) {
      const issueId = await createIssue(db, projectId, inProgressId, `Error ${i}`, i);
      await createWorkspace(db, issueId, "error");
    }

    const digest = await generateBoardRiskDigest(projectId, db as never);

    const countedStaleSessions = digest.allItems.filter((i) => i.category === "stale_session").length;
    const countedMergeBlockers = digest.allItems.filter((i) => i.category === "merge_blocker").length;
    const countedHealth = digest.allItems.filter((i) => i.category === "health").length;

    expect(digest.summary.staleSessions).toBe(countedStaleSessions);
    expect(digest.summary.mergeBlockers).toBe(countedMergeBlockers);
    expect(digest.summary.healthIssues).toBe(countedHealth);
  });

  it("throws for a non-existent project", async () => {
    const { db } = createTestDb();

    await expect(
      generateBoardRiskDigest("non-existent-project-id", db as never),
    ).rejects.toThrow();
  });
});
