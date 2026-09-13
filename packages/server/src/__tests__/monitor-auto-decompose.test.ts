/**
 * #1134 — the monitor's auto-decompose step advances a planned-but-undecomposed drive/epic
 * ticket (split into children, or mark right-sized) instead of leaving it excluded from start
 * scoring with nothing to pick it up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeClaudePrompt = vi.fn();
vi.mock("../services/claude-cli.service.js", () => ({
  invokeClaudePrompt: (...args: Parameters<typeof invokeClaudePrompt>) => invokeClaudePrompt(...args),
}));

import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createBoardEvents } from "../services/board-events.js";
import { runAutoDecompose } from "../startup/monitor-decompose.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedProject(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "P", repoPath: "/tmp/p", repoName: "p",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId, projectId, name: "Backlog", sortOrder: 0, isDefault: true, createdAt: now,
  });
  return { projectId, statusId };
}

async function seedEpic(db: Db, projectId: string, statusId: string, num: number) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id, issueNumber: num, title: `Epic ${num}`, description: "", priority: "high",
    issueType: "feature", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  const epicTagId = randomUUID();
  await db.insert(schema.tags).values({ id: epicTagId, name: "epic", isBuiltin: true, createdAt: now });
  await db.insert(schema.issueTags).values({ id: randomUUID(), issueId: id, tagId: epicTagId });
  return id;
}

function makeDeps(allowAll = true) {
  return {
    boardEvents: createBoardEvents(),
    logMonitorAction: vi.fn(),
    allowProject: () => allowAll,
  };
}

describe("runAutoDecompose", () => {
  beforeEach(() => {
    invokeClaudePrompt.mockReset();
  });

  it("splits an undecomposed epic into children when the model proposes some", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const epicId = await seedEpic(db, projectId, statusId, 1);

    invokeClaudePrompt.mockResolvedValue(JSON.stringify({
      children: [
        { tempId: "t1", title: "Build the shell", description: "", priority: "medium" },
        { tempId: "t2", title: "Wire the sync", description: "", priority: "medium" },
      ],
      dependencies: [],
    }));

    const advanced = await runAutoDecompose({ ...makeDeps(), projectIds: [projectId], database: db as any });
    expect(advanced).toBe(1);

    const childOfEdges = await db.select().from(schema.issueDependencies)
      .where(and(eq(schema.issueDependencies.dependsOnId, epicId), eq(schema.issueDependencies.type, "child_of")));
    expect(childOfEdges).toHaveLength(2);
  });

  it("marks the epic right-sized (no children created) when the model proposes none", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const epicId = await seedEpic(db, projectId, statusId, 1);

    invokeClaudePrompt.mockResolvedValue(JSON.stringify({ children: [], dependencies: [] }));

    const advanced = await runAutoDecompose({ ...makeDeps(), projectIds: [projectId], database: db as any });
    expect(advanced).toBe(1);

    const rightSizedTag = await db.select().from(schema.tags).where(eq(schema.tags.name, "right-sized"));
    expect(rightSizedTag).toHaveLength(1);
    const link = await db.select().from(schema.issueTags)
      .where(and(eq(schema.issueTags.issueId, epicId), eq(schema.issueTags.tagId, rightSizedTag[0].id)));
    expect(link).toHaveLength(1);

    // No children were created.
    const childOfEdges = await db.select().from(schema.issueDependencies)
      .where(and(eq(schema.issueDependencies.dependsOnId, epicId), eq(schema.issueDependencies.type, "child_of")));
    expect(childOfEdges).toHaveLength(0);
  });

  it("does not act on a project the cycle disallows", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    await seedEpic(db, projectId, statusId, 1);

    const advanced = await runAutoDecompose({
      boardEvents: createBoardEvents(),
      logMonitorAction: vi.fn(),
      allowProject: () => false,
      projectIds: [projectId],
      database: db as any,
    });
    expect(advanced).toBe(0);
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
  });

  it("leaves an already-decomposed epic alone (has children)", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db);
    const epicId = await seedEpic(db, projectId, statusId, 1);
    const now = new Date().toISOString();
    const childId = randomUUID();
    await db.insert(schema.issues).values({
      id: childId, issueNumber: 2, title: "child", statusId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.issueDependencies).values({
      id: randomUUID(), issueId: epicId, dependsOnId: childId, type: "parent_of", createdAt: now,
    });

    const advanced = await runAutoDecompose({ ...makeDeps(), projectIds: [projectId], database: db as any });
    expect(advanced).toBe(0);
    expect(invokeClaudePrompt).not.toHaveBeenCalled();
  });
});
