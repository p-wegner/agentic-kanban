import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestApp } from "./helpers/test-app.js";
import type { TestDb } from "./helpers/test-db.js";
import { estimateBudget } from "../services/budget-estimator.service.js";

const { db: database } = createTestApp(() => {});

const now = new Date().toISOString();

async function seedProject(db: TestDb) {
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: `Budget Test Project ${projectId.slice(0, 8)}`,
    repoPath: `/tmp/budget-test-${projectId.slice(0, 8)}`,
    repoName: `budget-test-${projectId.slice(0, 8)}`,
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Todo",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });
  return { projectId, statusId };
}

async function seedIssue(db: TestDb, projectId: string, statusId: string, description: string) {
  const id = randomUUID();
  await db.insert(schema.issues).values({
    id,
    projectId,
    statusId,
    issueNumber: Math.floor(Math.random() * 10000),
    title: "Budget test issue",
    description,
    priority: "medium",
    issueType: "task",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedWorkspaceWithSession(
  db: TestDb,
  issueId: string,
  stats: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
) {
  const wsId = randomUUID();
  await db.insert(schema.workspaces).values({
    id: wsId,
    issueId,
    branch: `feature/test-${wsId.slice(0, 8)}`,
    workingDir: null,
    baseBranch: "main",
    isDirect: false,
    requiresReview: false,
    thoroughReview: false,
    planMode: false,
    tddMode: false,
    includeVisualProof: false,
    readyForMerge: false,
    status: "closed",
    createdAt: now,
    updatedAt: now,
  });
  const sessId = randomUUID();
  await db.insert(schema.sessions).values({
    id: sessId,
    workspaceId: wsId,
    status: "stopped",
    startedAt: now,
    stats: JSON.stringify(stats),
  });
  return wsId;
}

describe("estimateBudget", () => {
  it("returns low risk for a short description with no history", async () => {
    const { projectId, statusId } = await seedProject(database);
    const issueId = await seedIssue(database, projectId, statusId, "Fix the button color.");
    const result = await estimateBudget(database, issueId, "claude");

    expect(result.risk).toBe("low");
    expect(result.sessionCount).toBe(0);
    expect(result.avgTokensFromHistory).toBeNull();
    expect(result.descriptionTokens).toBeGreaterThan(0);
  });

  it("uses historical session data when available", async () => {
    const { projectId, statusId } = await seedProject(database);
    const siblingIssueId = await seedIssue(database, projectId, statusId, "A sibling issue");
    await seedWorkspaceWithSession(database, siblingIssueId, {
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadTokens: 5_000,
    });

    const targetIssueId = await seedIssue(database, projectId, statusId, "A new issue for estimation");
    const result = await estimateBudget(database, targetIssueId, "claude");

    expect(result.sessionCount).toBeGreaterThan(0);
    expect(result.avgTokensFromHistory).not.toBeNull();
    expect(result.estimatedTokens).not.toBeNull();
  });

  it("assigns medium risk when estimated tokens exceed 25% of context limit", async () => {
    // Claude context limit = 180k, medium threshold = 25% = 45k
    // Seed sessions averaging 50k tokens → estimated = 50k * 1.1 = 55k (>45k)
    const { projectId, statusId } = await seedProject(database);
    const siblingIssueId = await seedIssue(database, projectId, statusId, "Heavy workload issue");
    await seedWorkspaceWithSession(database, siblingIssueId, {
      inputTokens: 30_000,
      outputTokens: 10_000,
      cacheReadTokens: 10_000, // total = 50k
    });

    const targetIssueId = await seedIssue(database, projectId, statusId, "Another medium-risk issue");
    const result = await estimateBudget(database, targetIssueId, "claude");

    expect(result.risk).toBe("medium");
  });

  it("assigns high risk when estimated tokens exceed 60% of context limit", async () => {
    // Claude context limit = 180k, high threshold = 60% = 108k
    // Seed sessions averaging 110k tokens → estimated = 110k * 1.1 = 121k (>108k)
    const { projectId, statusId } = await seedProject(database);
    const siblingIssueId = await seedIssue(database, projectId, statusId, "Very large task");
    await seedWorkspaceWithSession(database, siblingIssueId, {
      inputTokens: 70_000,
      outputTokens: 20_000,
      cacheReadTokens: 20_000, // total = 110k
    });

    const targetIssueId = await seedIssue(database, projectId, statusId, "High-risk target");
    const result = await estimateBudget(database, targetIssueId, "claude");

    expect(result.risk).toBe("high");
  });

  it("uses different context limits per provider", async () => {
    // Codex limit = 100k; medium threshold = 25k; Claude limit = 180k
    // Sessions average 30k → estimated = 30k * 1.1 = 33k
    // 33k / 180k = 18% → low (claude); 33k / 100k = 33% → medium (codex)
    const { projectId, statusId } = await seedProject(database);
    const siblingIssueId = await seedIssue(database, projectId, statusId, "Codex test sibling");
    await seedWorkspaceWithSession(database, siblingIssueId, {
      inputTokens: 15_000,
      outputTokens: 8_000,
      cacheReadTokens: 7_000, // total = 30k
    });

    const targetIssueId = await seedIssue(database, projectId, statusId, "Codex risk target");
    const claudeResult = await estimateBudget(database, targetIssueId, "claude");
    const codexResult = await estimateBudget(database, targetIssueId, "codex");

    expect(claudeResult.risk).toBe("low");
    expect(codexResult.risk).toBe("medium");
  });

  it("excludes the current issue's own workspaces from history", async () => {
    const { projectId, statusId } = await seedProject(database);
    const selfIssueId = await seedIssue(database, projectId, statusId, "Self issue");
    // Add a workspace + session for the same issue — must be excluded from own estimation
    await seedWorkspaceWithSession(database, selfIssueId, {
      inputTokens: 999_999,
      outputTokens: 0,
      cacheReadTokens: 0,
    });

    const result = await estimateBudget(database, selfIssueId, "claude");
    expect(result.sessionCount).toBe(0);
    expect(result.avgTokensFromHistory).toBeNull();
  });

  it("handles missing issue gracefully (returns low risk)", async () => {
    const fakeId = randomUUID();
    const result = await estimateBudget(database, fakeId, "claude");

    expect(result.risk).toBe("low");
    expect(result.descriptionTokens).toBe(0);
    expect(result.estimatedTokens).toBeNull();
  });

  it("returns a non-empty reason string always", async () => {
    const { projectId, statusId } = await seedProject(database);
    const issueId = await seedIssue(database, projectId, statusId, "Reason test");
    const result = await estimateBudget(database, issueId, "claude");

    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
