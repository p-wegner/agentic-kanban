// #917 — scored ticket selection: real-DB tests for computeUnblockCounts and the
// end-to-end sort/persist behaviour of orderCandidatesByStartScore.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { issueDependencies, issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb, ensureTestStatus, type TestDb } from "./helpers/test-db.js";
import { computeUnblockCounts } from "../repositories/start-scoring.repository.js";
import { orderCandidatesByStartScore } from "../startup/monitor-start-scoring.js";

async function seedProject(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/start-scoring-repo", repoName: "start-scoring-repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return projectId;
}

async function seedIssue(
  db: TestDb,
  args: { projectId: string; statusId: string; issueNumber: number; title: string; priority?: string; ageHours?: number },
): Promise<string> {
  const now = new Date();
  const createdAt = new Date(now.getTime() - (args.ageHours ?? 0) * 60 * 60 * 1000).toISOString();
  const id = randomUUID();
  await db.insert(issues).values({
    id,
    issueNumber: args.issueNumber,
    title: args.title,
    statusId: args.statusId,
    projectId: args.projectId,
    priority: args.priority ?? "medium",
    createdAt,
    updatedAt: createdAt,
    statusChangedAt: createdAt,
  });
  return id;
}

async function addDependency(db: TestDb, dependentId: string, dependsOnId: string): Promise<void> {
  await db.insert(issueDependencies).values({
    id: randomUUID(),
    issueId: dependentId,
    dependsOnId,
    type: "depends_on",
    createdAt: new Date().toISOString(),
  });
}

describe("computeUnblockCounts (#917)", () => {
  it("counts other open issues that name the candidate as a blocker", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const todoId = await ensureTestStatus(db, projectId, "Todo", { sortOrder: 1 });
    const doneId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 2 });

    const blocker = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 1, title: "Blocker" });
    const dependentA = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 2, title: "Dependent A" });
    const dependentB = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 3, title: "Dependent B" });
    const dependentDone = await seedIssue(db, { projectId, statusId: doneId, issueNumber: 4, title: "Already done" });

    await addDependency(db, dependentA, blocker);
    await addDependency(db, dependentB, blocker);
    await addDependency(db, dependentDone, blocker);

    const counts = await computeUnblockCounts(projectId, [blocker], new Set([doneId]), db);
    // dependentDone is already resolved (Done), so it must not count as a live unblock.
    expect(counts.get(blocker)).toBe(2);
  });

  it("returns an empty map when given no candidate ids", async () => {
    const { db } = createTestDb();
    const counts = await computeUnblockCounts("proj-x", [], new Set(), db);
    expect(counts.size).toBe(0);
  });

  it("does not count a dependent from a different project", async () => {
    const { db } = createTestDb();
    const projectA = await seedProject(db);
    const projectB = await seedProject(db);
    const todoA = await ensureTestStatus(db, projectA, "Todo", { sortOrder: 1 });
    const todoB = await ensureTestStatus(db, projectB, "Todo", { sortOrder: 1 });

    const blocker = await seedIssue(db, { projectId: projectA, statusId: todoA, issueNumber: 1, title: "Blocker" });
    const crossProjectDependent = await seedIssue(db, { projectId: projectB, statusId: todoB, issueNumber: 1, title: "Other project dependent" });
    await addDependency(db, crossProjectDependent, blocker);

    const counts = await computeUnblockCounts(projectA, [blocker], new Set(), db);
    expect(counts.get(blocker)).toBeUndefined();
  });
});

describe("orderCandidatesByStartScore (#917 acceptance criterion)", () => {
  it("a high-priority ticket that unblocks 3 others starts before a lower-numbered low leaf", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const todoId = await ensureTestStatus(db, projectId, "Todo", { sortOrder: 1 });
    const doneId = await ensureTestStatus(db, projectId, "Done", { sortOrder: 2 });

    // Lower issue number, but low priority and unblocks nothing.
    const lowLeaf = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 1, title: "Low leaf", priority: "low" });
    // Higher issue number, high priority, unblocks 3 others.
    const highUnblocker = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 5, title: "High unblocker", priority: "high" });
    const dependent1 = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 6, title: "Dep 1" });
    const dependent2 = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 7, title: "Dep 2" });
    const dependent3 = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 8, title: "Dep 3" });
    await addDependency(db, dependent1, highUnblocker);
    await addDependency(db, dependent2, highUnblocker);
    await addDependency(db, dependent3, highUnblocker);

    const candidates = await db
      .select({
        id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType,
        priority: issues.priority, createdAt: issues.createdAt, statusChangedAt: issues.statusChangedAt,
      })
      .from(issues)
      .where(eq(issues.projectId, projectId));

    // Query order is arbitrary/PK order — sort by issueNumber first to prove the
    // reorder is what the scorer did, not incidental row order.
    candidates.sort((a, b) => a.id.localeCompare(b.id));

    await orderCandidatesByStartScore(candidates, projectId, new Set([doneId]), new Map(), db);

    expect(candidates[0].id).toBe(highUnblocker);
    const lowLeafIndex = candidates.findIndex((c) => c.id === lowLeaf);
    expect(lowLeafIndex).toBeGreaterThan(0);
  });

  it("persists lastStartScore and its components on each scored issue", async () => {
    const { db } = createTestDb();
    const projectId = await seedProject(db);
    const todoId = await ensureTestStatus(db, projectId, "Todo", { sortOrder: 1 });
    const issueId = await seedIssue(db, { projectId, statusId: todoId, issueNumber: 1, title: "Solo", priority: "high" });

    const candidates = await db
      .select({
        id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType,
        priority: issues.priority, createdAt: issues.createdAt, statusChangedAt: issues.statusChangedAt,
      })
      .from(issues)
      .where(eq(issues.projectId, projectId));

    await orderCandidatesByStartScore(candidates, projectId, new Set(), new Map(), db);

    const [row] = await db.select({
      lastStartScore: issues.lastStartScore,
      lastStartScoreComponentsJson: issues.lastStartScoreComponentsJson,
      lastStartScoredAt: issues.lastStartScoredAt,
    }).from(issues).where(eq(issues.id, issueId));

    expect(row.lastStartScore).not.toBeNull();
    expect(row.lastStartScoredAt).not.toBeNull();
    const components = JSON.parse(row.lastStartScoreComponentsJson!);
    expect(components.priority).toBe("high");
  });

  it("does nothing for an empty candidate list", async () => {
    const { db } = createTestDb();
    await expect(orderCandidatesByStartScore([], "proj-x", new Set(), new Map(), db)).resolves.toBeUndefined();
  });
});
