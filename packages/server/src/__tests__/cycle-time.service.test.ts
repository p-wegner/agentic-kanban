import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { getIssueCycleTime } from "../services/cycle-time.service.js";

let db: TestDb;
let projectId: string;
let statusId: string;
let templateId: string;

async function seedBase() {
  const now = new Date().toISOString();
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test",
    repoName: "test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });

  templateId = randomUUID();
  await db.insert(schema.workflowTemplates).values({
    id: templateId,
    name: "Simple",
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  db = createTestDb().db;
  await seedBase();
});

describe("getIssueCycleTime", () => {
  it("returns null for unknown issue", async () => {
    const result = await getIssueCycleTime(randomUUID(), db);
    expect(result).toBeNull();
  });

  it("returns totalAgeMs and empty breakdowns for issue with no workspaces", async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 100,
      title: "No workspace issue",
      statusId,
      projectId,
      createdAt,
      updatedAt: createdAt,
    });

    const nowOverride = new Date().toISOString();
    const result = await getIssueCycleTime(issueId, db, nowOverride);
    expect(result).not.toBeNull();
    expect(result!.statusBreakdowns).toHaveLength(0);
    expect(result!.isOpen).toBe(true);
    const expectedAge = new Date(nowOverride).getTime() - new Date(createdAt).getTime();
    expect(result!.totalAgeMs).toBeCloseTo(expectedAge, -2);
  });

  it("aggregates durations across two transitions", async () => {
    const t0 = new Date(Date.now() - 4 * 60 * 60 * 1000); // 4h ago
    const t1 = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago — transition to node2
    const nowOverride = new Date().toISOString();

    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 101,
      title: "Two-transition issue",
      statusId,
      projectId,
      createdAt: t0.toISOString(),
      updatedAt: t0.toISOString(),
    });

    const wsId = randomUUID();
    await db.insert(schema.workspaces).values({
      id: wsId,
      issueId,
      branch: "feature/test-cycle",
      status: "active",
      createdAt: t0.toISOString(),
      updatedAt: t0.toISOString(),
    });

    // Two workflow nodes: Backlog → In Progress
    const node1Id = randomUUID();
    const node2Id = randomUUID();
    await db.insert(schema.workflowNodes).values([
      { id: node1Id, templateId, name: "Backlog", statusName: "Backlog", sortOrder: 0, createdAt: t0.toISOString() },
      { id: node2Id, templateId, name: "In Progress", statusName: "In Progress", sortOrder: 1, createdAt: t0.toISOString() },
    ]);

    // Transition 1: entered Backlog at t0
    await db.insert(schema.workflowTransitions).values({
      id: randomUUID(),
      workspaceId: wsId,
      toNodeId: node1Id,
      triggeredBy: "system",
      createdAt: t0.toISOString(),
    });

    // Transition 2: moved to In Progress at t1
    await db.insert(schema.workflowTransitions).values({
      id: randomUUID(),
      workspaceId: wsId,
      toNodeId: node2Id,
      triggeredBy: "agent",
      createdAt: t1.toISOString(),
    });

    const result = await getIssueCycleTime(issueId, db, nowOverride);
    expect(result).not.toBeNull();

    const backlog = result!.statusBreakdowns.find((s) => s.statusName === "Backlog");
    const inProgress = result!.statusBreakdowns.find((s) => s.statusName === "In Progress");

    expect(backlog).toBeDefined();
    expect(inProgress).toBeDefined();

    // Backlog: t0 → t1 = 2h
    const expectedBacklogMs = t1.getTime() - t0.getTime();
    expect(backlog!.durationMs).toBeCloseTo(expectedBacklogMs, -3);

    // In Progress: t1 → now ≈ 2h
    const expectedInProgressMs = new Date(nowOverride).getTime() - t1.getTime();
    expect(inProgress!.durationMs).toBeCloseTo(expectedInProgressMs, -3);
  });

  it("reports closedAt and isOpen=false for Done issues", async () => {
    const createdAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const closedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

    const doneStatusId = randomUUID();
    await db.insert(schema.projectStatuses).values({
      id: doneStatusId,
      projectId,
      name: "Done",
      sortOrder: 10,
      isDefault: false,
      createdAt: createdAt,
    });

    const issueId = randomUUID();
    await db.insert(schema.issues).values({
      id: issueId,
      issueNumber: 102,
      title: "Done issue",
      statusId: doneStatusId,
      projectId,
      createdAt,
      updatedAt: closedAt,
      statusChangedAt: closedAt,
    });

    const result = await getIssueCycleTime(issueId, db);
    expect(result).not.toBeNull();
    expect(result!.isOpen).toBe(false);
    expect(result!.closedAt).toBe(closedAt);
  });
});
