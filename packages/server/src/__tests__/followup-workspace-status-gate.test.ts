import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { issueDependencies, issues, issueTags, projectStatuses, projects, tags, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers/test-db.js";

vi.mock("../services/git.service.js", () => ({
  createWorktree: vi.fn(async () => "/tmp/fake-worktree"),
}));

async function seedProject(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Followup Project",
    repoPath: "/tmp/followup-project",
    repoName: "followup-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusIds: Record<string, string> = {};
  for (const [index, name] of ["Backlog", "Todo", "In Progress", "Done", "Cancelled"].entries()) {
    const id = randomUUID();
    statusIds[name] = id;
    await db.insert(projectStatuses).values({
      id,
      projectId,
      name,
      sortOrder: index,
      isDefault: name === "Todo",
      createdAt: now,
    });
  }
  return { projectId, statusIds };
}

async function insertIssue(db: TestDb, input: { projectId: string; statusId: string; title: string; issueNumber: number }) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: input.issueNumber,
    title: input.title,
    priority: "medium",
    sortOrder: input.issueNumber,
    statusId: input.statusId,
    projectId: input.projectId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function insertDependency(db: TestDb, issueId: string, dependsOnId: string) {
  await db.insert(issueDependencies).values({
    id: randomUUID(),
    issueId,
    dependsOnId,
    type: "depends_on",
    createdAt: new Date().toISOString(),
  });
}

async function insertTag(db: TestDb, issueId: string, name: string) {
  const tagId = randomUUID();
  await db.insert(tags).values({ id: tagId, name, color: "#6B7280", isBuiltin: name === "no-auto-start", createdAt: new Date().toISOString() });
  await db.insert(issueTags).values({ id: randomUUID(), issueId, tagId });
}

function fakeSessionManager() {
  return { startSession: vi.fn(async () => ({})) } as unknown as import("../services/session.manager.js").SessionManager;
}

describe("autoStartFollowups status gate (#219)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT resurrect a Cancelled dependent issue once its blocker merges", async () => {
    const { autoStartFollowups } = await import("../services/followup-workspace.service.js");
    const { db, dispose } = createTestDb();
    try {
      const { projectId, statusIds } = await seedProject(db);
      const blocker = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "round 10", issueNumber: 46 });
      const cancelledDependent = await insertIssue(db, { projectId, statusId: statusIds.Cancelled, title: "round 11", issueNumber: 47 });
      await insertDependency(db, cancelledDependent, blocker);

      await autoStartFollowups(blocker, projectId, db, fakeSessionManager, new Map());

      const [issueRow] = await db.select().from(issues).where(eq(issues.id, cancelledDependent));
      expect(issueRow.statusId).toBe(statusIds.Cancelled);

      const ws = await db.select().from(workspaces).where(eq(workspaces.issueId, cancelledDependent));
      expect(ws).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("does NOT start a no-auto-start-tagged dependent even if it sits in Todo", async () => {
    const { autoStartFollowups } = await import("../services/followup-workspace.service.js");
    const { db, dispose } = createTestDb();
    try {
      const { projectId, statusIds } = await seedProject(db);
      const blocker = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "round 10", issueNumber: 46 });
      const taggedDependent = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "round 11", issueNumber: 47 });
      await insertDependency(db, taggedDependent, blocker);
      await insertTag(db, taggedDependent, "no-auto-start");

      await autoStartFollowups(blocker, projectId, db, fakeSessionManager, new Map());

      const [issueRow] = await db.select().from(issues).where(eq(issues.id, taggedDependent));
      expect(issueRow.statusId).toBe(statusIds.Todo);

      const ws = await db.select().from(workspaces).where(eq(workspaces.issueId, taggedDependent));
      expect(ws).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("still auto-starts a Todo dependent once its blocker merges (happy path unchanged)", async () => {
    const { autoStartFollowups } = await import("../services/followup-workspace.service.js");
    const { db, dispose } = createTestDb();
    try {
      const { projectId, statusIds } = await seedProject(db);
      const blocker = await insertIssue(db, { projectId, statusId: statusIds.Done, title: "round 10", issueNumber: 46 });
      const dependent = await insertIssue(db, { projectId, statusId: statusIds.Todo, title: "round 11", issueNumber: 47 });
      await insertDependency(db, dependent, blocker);

      await autoStartFollowups(blocker, projectId, db, fakeSessionManager, new Map());

      const [issueRow] = await db.select().from(issues).where(eq(issues.id, dependent));
      expect(issueRow.statusId).toBe(statusIds["In Progress"]);

      const ws = await db.select().from(workspaces).where(eq(workspaces.issueId, dependent));
      expect(ws).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
