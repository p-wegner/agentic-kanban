import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createProjectService } from "../services/project.service.js";

let db: TestDb;
let projectId: string;
let inProgressStatusId: string;
let todoStatusId: string;

beforeAll(async () => {
  db = createTestDb().db;

  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Column Staleness Test Project",
    repoPath: "/tmp/col-stale-test",
    repoName: "col-stale-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  inProgressStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: inProgressStatusId,
    projectId,
    name: "In Progress",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  todoStatusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: todoStatusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("column age badge", () => {
  it("provides columnAgeDays for all issues based on statusChangedAt", async () => {
    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 100,
      title: "Todo issue entered 5 days ago",
      statusId: todoStatusId,
      projectId,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(5),
      statusChangedAt: daysAgo(5),
    });

    // Capture `now` AFTER seeding so the elapsed span is a clean >= 5 days — capturing it
    // before daysAgo(5) leaves elapsed a few ms under 5 days, which Math.floor() rounds to 4.
    const now = new Date().toISOString();
    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const col = board.find((c) => c.name === "Todo");
    const issue = col?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.columnAgeDays).toBeGreaterThanOrEqual(5);
  });

  it("falls back to createdAt when statusChangedAt is null", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 101,
      title: "Todo issue no statusChangedAt",
      statusId: todoStatusId,
      projectId,
      createdAt: daysAgo(7),
      updatedAt: daysAgo(2),
      statusChangedAt: null,
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const col = board.find((c) => c.name === "Todo");
    const issue = col?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.columnAgeDays).toBeGreaterThanOrEqual(7);
  });
});

describe("In Progress column staleness warning", () => {
  it("flags In Progress issue as column stale past default threshold (3d)", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 102,
      title: "In Progress issue entered 5 days ago",
      statusId: inProgressStatusId,
      projectId,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(5),
      statusChangedAt: daysAgo(5),
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const col = board.find((c) => c.name === "In Progress");
    const issue = col?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isColumnStale).toBe(true);
    expect(issue?.columnAgeDays).toBeGreaterThanOrEqual(5);
  });

  it("does not flag fresh In Progress issue", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 103,
      title: "In Progress issue entered 1 day ago",
      statusId: inProgressStatusId,
      projectId,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(1),
      statusChangedAt: daysAgo(1),
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const col = board.find((c) => c.name === "In Progress");
    const issue = col?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isColumnStale).toBeUndefined();
    expect(issue?.columnAgeDays).toBeGreaterThanOrEqual(1);
  });

  it("does not flag Todo issue as column stale", async () => {
    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 104,
      title: "Old Todo issue",
      statusId: todoStatusId,
      projectId,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(10),
      statusChangedAt: daysAgo(10),
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const col = board.find((c) => c.name === "Todo");
    const issue = col?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isColumnStale).toBeUndefined();
    expect(issue?.columnAgeDays).toBeGreaterThanOrEqual(10);
  });

  it("respects inprogress_stale_days preference", async () => {
    await db.insert(schema.preferences).values({
      key: "inprogress_stale_days",
      value: "7",
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({ target: schema.preferences.key, set: { value: "7" } });

    const issueId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 105,
      title: "In Progress issue entered 5 days ago, 7d threshold",
      statusId: inProgressStatusId,
      projectId,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(5),
      statusChangedAt: daysAgo(5),
    });

    const service = createProjectService({ database: db });
    const board = await service.getBoard(projectId, now);
    const col = board.find((c) => c.name === "In Progress");
    const issue = col?.issues.find((i) => i.id === issueId);

    expect(issue).toBeDefined();
    expect(issue?.isColumnStale).toBeUndefined();

    // Restore default
    await db.insert(schema.preferences).values({
      key: "inprogress_stale_days",
      value: "3",
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({ target: schema.preferences.key, set: { value: "3" } });
  });
});
