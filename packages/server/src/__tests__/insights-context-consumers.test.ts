import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createInsightsRoute } from "../routes/insights.js";

interface SeedOpts {
  issueTitle?: string;
  startedAt?: string;
  stats?: Record<string, unknown>;
}

/** Seed a single completed session, returning the issue id so callers can
 *  aggregate multiple sessions onto the same issue. */
async function seedSession(
  db: TestDb,
  projectId: string,
  issueId: string,
  opts: SeedOpts = {},
) {
  const now = new Date().toISOString();
  const startedAt = opts.startedAt ?? now;
  const statusId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak", workingDir: "/tmp/repo/.worktrees/ak",
    baseBranch: "main", isDirect: false, status: "closed", provider: "claude",
    claudeProfile: "anth", createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "completed",
    startedAt, endedAt: now, exitCode: "0",
    stats: opts.stats ? JSON.stringify(opts.stats) : null,
  });
  return { workspaceId, sessionId };
}

async function seedIssue(db: TestDb, projectId: string, opts: { issueTitle?: string; issueNumber?: number } = {}) {
  const now = new Date().toISOString();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: opts.issueNumber ?? Math.floor(Math.random() * 1e9),
    title: opts.issueTitle ?? "T", priority: "medium", sortOrder: 0, statusId, projectId,
    issueType: "feature", createdAt: now, updatedAt: now,
  });
  return issueId;
}

type ContextConsumers = {
  windowFrom: string;
  totalContextTokens: number;
  rows: Array<{
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
    sessionCount: number;
    contextTokens: number;
    totalCostUsd: number;
  }>;
};

async function getContextConsumers(db: TestDb, projectId: string, range = "all"): Promise<ContextConsumers> {
  const app = createInsightsRoute(db);
  const res = await app.request(`/?projectId=${projectId}&range=${range}`);
  expect(res.status).toBe(200);
  const body = await res.json() as { topContextConsumers: ContextConsumers };
  return body.topContextConsumers;
}

const baseStats = {
  durationMs: 5000,
  totalCostUsd: 0.1,
  outputTokens: 500,
  numTurns: 3,
  model: "claude-opus",
  success: true,
};

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("insights topContextConsumers leaderboard (#751)", () => {
  let db: TestDb;
  let projectId: string;

  beforeEach(async () => {
    ({ db } = createTestDb());
    projectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(projects).values({
      id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
  });

  it("ranks issues by context tokens (input + cacheRead) descending", async () => {
    const big = await seedIssue(db, projectId, { issueTitle: "Big", issueNumber: 1 });
    const small = await seedIssue(db, projectId, { issueTitle: "Small", issueNumber: 2 });
    await seedSession(db, projectId, big, { stats: { ...baseStats, inputTokens: 10_000, cacheReadTokens: 90_000 } });
    await seedSession(db, projectId, small, { stats: { ...baseStats, inputTokens: 1_000, cacheReadTokens: 4_000 } });

    const result = await getContextConsumers(db, projectId);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].issueTitle).toBe("Big");
    expect(result.rows[0].contextTokens).toBe(100_000);
    expect(result.rows[1].issueTitle).toBe("Small");
    expect(result.rows[1].contextTokens).toBe(5_000);
    expect(result.totalContextTokens).toBe(105_000);
  });

  it("prefers explicit contextTokens over input+cacheRead when present", async () => {
    const issueId = await seedIssue(db, projectId);
    await seedSession(db, projectId, issueId, {
      stats: { ...baseStats, contextTokens: 42_000, inputTokens: 1, cacheReadTokens: 1 },
    });

    const result = await getContextConsumers(db, projectId);
    expect(result.rows[0].contextTokens).toBe(42_000);
  });

  it("aggregates multiple sessions of the same issue", async () => {
    const issueId = await seedIssue(db, projectId, { issueTitle: "Multi" });
    await seedSession(db, projectId, issueId, { stats: { ...baseStats, inputTokens: 10_000, cacheReadTokens: 0, totalCostUsd: 0.2 } });
    await seedSession(db, projectId, issueId, { stats: { ...baseStats, inputTokens: 5_000, cacheReadTokens: 0, totalCostUsd: 0.3 } });

    const result = await getContextConsumers(db, projectId);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sessionCount).toBe(2);
    expect(result.rows[0].contextTokens).toBe(15_000);
    expect(result.rows[0].totalCostUsd).toBeCloseTo(0.5);
  });

  it("only counts sessions within the fixed 7-day window even when range is wider", async () => {
    const recent = await seedIssue(db, projectId, { issueTitle: "Recent" });
    const old = await seedIssue(db, projectId, { issueTitle: "Old" });
    await seedSession(db, projectId, recent, { startedAt: daysAgo(2), stats: { ...baseStats, inputTokens: 20_000, cacheReadTokens: 0 } });
    await seedSession(db, projectId, old, { startedAt: daysAgo(20), stats: { ...baseStats, inputTokens: 99_000, cacheReadTokens: 0 } });

    // range=all would include the 20-day-old session for other blocks, but the
    // leaderboard window is hard-pinned to the last 7 days.
    const result = await getContextConsumers(db, projectId, "all");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].issueTitle).toBe("Recent");
    expect(result.totalContextTokens).toBe(20_000);
  });

  it("excludes issues with zero context tokens and caps at 10 rows", async () => {
    for (let i = 0; i < 12; i++) {
      const issueId = await seedIssue(db, projectId, { issueTitle: `Issue ${i}`, issueNumber: 100 + i });
      await seedSession(db, projectId, issueId, { stats: { ...baseStats, inputTokens: (i + 1) * 1_000, cacheReadTokens: 0 } });
    }
    // A zero-token session should not appear.
    const zero = await seedIssue(db, projectId, { issueTitle: "Zero", issueNumber: 999 });
    await seedSession(db, projectId, zero, { stats: { ...baseStats, inputTokens: 0, cacheReadTokens: 0 } });

    const result = await getContextConsumers(db, projectId);
    expect(result.rows).toHaveLength(10);
    expect(result.rows.some((r) => r.issueTitle === "Zero")).toBe(false);
    // Top row is the largest input (i=11 -> 12_000).
    expect(result.rows[0].contextTokens).toBe(12_000);
  });

  it("returns an empty leaderboard shape when there is no data", async () => {
    const result = await getContextConsumers(db, projectId);
    expect(result.rows).toEqual([]);
    expect(result.totalContextTokens).toBe(0);
    expect(typeof result.windowFrom).toBe("string");
  });
});
