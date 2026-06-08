import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createFlakeClassifierService } from "../services/flake-classifier.service.js";

async function seedMinimal(db: TestDb) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/tmp/x",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  } as any);
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  await db.insert(schema.issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Test issue",
    issueType: "bug",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/t",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.sessions).values({
    id: sessionId,
    workspaceId,
    startedAt: now,
  });

  return { projectId, workspaceId, sessionId };
}

describe("FlakeClassifierService — classifyFailure", () => {
  let db: TestDb;
  let svc: ReturnType<typeof createFlakeClassifierService>;

  beforeEach(() => {
    ({ db } = createTestDb());
    svc = createFlakeClassifierService(db);
  });

  it("classifies an unknown test as real (not in registry)", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    const result = await svc.classifyFailure({
      testName: "SomeUnknownTest > should pass",
      projectId,
      workspaceId,
      sessionId,
    });

    expect(result.decision).toBe("real");
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.matchedFlakyTestId).toBeUndefined();
  });

  it("classifies a known flaky test with non-overlapping files as flake", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    await svc.createFlakyTest({
      projectId,
      testName: "board > loads",
      testFilePath: "packages/e2e/tests/ui/board.test.ts",
      reason: "Race condition in animation",
    });

    const result = await svc.classifyFailure({
      testName: "board > loads",
      projectId,
      workspaceId,
      sessionId,
      changedFiles: ["packages/server/src/services/unrelated.service.ts"],
    });

    expect(result.decision).toBe("flake");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.changesOverlapWithSubject).toBe(false);
    expect(result.matchedFlakyTestId).toBeDefined();
  });

  it("classifies a known flaky test with overlapping files as suspicious", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    await svc.createFlakyTest({
      projectId,
      testName: "board > loads",
      testFilePath: "packages/e2e/tests/ui/board.test.ts",
      reason: "Race condition",
    });

    const result = await svc.classifyFailure({
      testName: "board > loads",
      projectId,
      workspaceId,
      sessionId,
      changedFiles: ["packages/client/src/components/board.tsx"],
    });

    expect(result.decision).toBe("suspicious");
    expect(result.changesOverlapWithSubject).toBe(true);
  });

  it("persists the decision and retrieves it by workspace", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    const result = await svc.classifyFailure({
      testName: "SomeTest > thing",
      projectId,
      workspaceId,
      sessionId,
    });

    const decisions = await svc.getDecisionsForWorkspace(workspaceId);
    expect(decisions.length).toBe(1);
    expect(decisions[0].decision).toBe(result.decision);
    expect(decisions[0].id).toBe(result.decisionId);
  });

  it("matches by error pattern regex when registry entry has errorPattern", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    await svc.createFlakyTest({
      projectId,
      testName: "auth > login",
      errorPattern: "timeout.*exceeded",
      reason: "Network flakiness",
    });

    const result = await svc.classifyFailure({
      testName: "auth > login",
      errorMessage: "timeout was exceeded after 5000ms",
      projectId,
      workspaceId,
      sessionId,
      changedFiles: [],
    });

    expect(result.decision).toBe("flake");
    expect(result.matchedFlakyTestId).toBeDefined();
  });
});

describe("FlakeClassifierService — flaky test CRUD", () => {
  let db: TestDb;
  let svc: ReturnType<typeof createFlakeClassifierService>;

  beforeEach(() => {
    ({ db } = createTestDb());
    svc = createFlakeClassifierService(db);
  });

  it("creates and lists flaky tests for a project", async () => {
    const { projectId } = await seedMinimal(db);

    await svc.createFlakyTest({ projectId, testName: "foo > bar", reason: "timing" });
    await svc.createFlakyTest({ projectId, testName: "baz > qux" });

    const list = await svc.listFlakyTests(projectId);
    expect(list.length).toBe(2);
    expect(list.map(t => t.testName)).toContain("foo > bar");
  });

  it("deletes a flaky test entry", async () => {
    const { projectId } = await seedMinimal(db);

    const entry = await svc.createFlakyTest({ projectId, testName: "delete > me" });
    await svc.deleteFlakyTest(entry.id);

    const list = await svc.listFlakyTests(projectId);
    expect(list.find(t => t.id === entry.id)).toBeUndefined();
  });
});

describe("FlakeClassifierService — recordRetryOutcome", () => {
  let db: TestDb;
  let svc: ReturnType<typeof createFlakeClassifierService>;

  beforeEach(() => {
    ({ db } = createTestDb());
    svc = createFlakeClassifierService(db);
  });

  it("marks outcome as confirmed_real when retry passes", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    const result = await svc.classifyFailure({
      testName: "unknown > test",
      projectId,
      workspaceId,
      sessionId,
    });

    const updated = await svc.recordRetryOutcome(result.decisionId, "passed", 1, 3);
    expect(updated.finalOutcome).toBe("confirmed_real");
    expect(updated.retryCount).toBe(1);
  });

  it("marks outcome as confirmed_flake when retries exhausted", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    const result = await svc.classifyFailure({
      testName: "unknown > test2",
      projectId,
      workspaceId,
      sessionId,
    });

    const updated = await svc.recordRetryOutcome(result.decisionId, "failed", 3, 3);
    expect(updated.finalOutcome).toBe("confirmed_flake");
  });

  it("keeps outcome as pending when retries not exhausted and still failing", async () => {
    const { projectId, workspaceId, sessionId } = await seedMinimal(db);

    const result = await svc.classifyFailure({
      testName: "unknown > test3",
      projectId,
      workspaceId,
      sessionId,
    });

    const updated = await svc.recordRetryOutcome(result.decisionId, "failed", 1, 3);
    expect(updated.finalOutcome).toBe("pending");
  });
});
