import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectService } from "../services/project.service.js";

let db: TestDb;
let projectId: string;
let backlogStatusId: string;
let todoStatusId: string;

beforeAll(async () => {
  db = createTestDb().db;

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Stale Test Project",
    repoPath: "/tmp/stale-test",
    repoName: "stale-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  backlogStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: backlogStatusId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
    isDefault: false,
    createdAt: now,
  });

  todoStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: todoStatusId,
    projectId,
    name: "Todo",
    sortOrder: 1,
    isDefault: true,
    createdAt: now,
  });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("stale backlog flagging", () => {
  it("flags backlog issue as stale when updatedAt is beyond threshold", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 1,
      title: "Old backlog issue",
      statusId: backlogStatusId,
      projectId,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(20),
      statusChangedAt: null,
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const backlogColumn = board.find((col) => col.name === "Backlog");
    const issue = backlogColumn?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isStale).toBe(true);
    expect(issue?.staleDays).toBeGreaterThanOrEqual(20);
  });

  it("does not flag backlog issue as stale when updatedAt is within threshold", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 2,
      title: "Fresh backlog issue",
      statusId: backlogStatusId,
      projectId,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(3),
      statusChangedAt: null,
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const backlogColumn = board.find((col) => col.name === "Backlog");
    const issue = backlogColumn?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isStale).toBeUndefined();
  });

  it("prefers statusChangedAt over updatedAt for staleness", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 3,
      title: "Backlog issue with recent statusChangedAt",
      statusId: backlogStatusId,
      projectId,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(20),
      statusChangedAt: daysAgo(5),
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const backlogColumn = board.find((col) => col.name === "Backlog");
    const issue = backlogColumn?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isStale).toBeUndefined();
  });

  it("does not flag non-backlog issues as stale", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 4,
      title: "Old todo issue",
      statusId: todoStatusId,
      projectId,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(20),
      statusChangedAt: null,
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const todoColumn = board.find((col) => col.name === "Todo");
    const issue = todoColumn?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isStale).toBeUndefined();
  });

  it("respects backlog_stale_days preference", async () => {
    await db.insert(schema.preferences).values({
      key: "backlog_stale_days",
      value: "30",
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({ target: schema.preferences.key, set: { value: "30" } });

    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 5,
      title: "20-day-old backlog issue, 30-day threshold",
      statusId: backlogStatusId,
      projectId,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(20),
      statusChangedAt: null,
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const backlogColumn = board.find((col) => col.name === "Backlog");
    const issue = backlogColumn?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isStale).toBeUndefined();

    // Restore default
    await db.insert(schema.preferences).values({
      key: "backlog_stale_days",
      value: "14",
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({ target: schema.preferences.key, set: { value: "14" } });
  });
});
