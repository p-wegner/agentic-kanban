import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createWorkspacesRoute } from "../routes/workspaces.js";

interface SeedOpts {
  provider?: string | null;
  startedAt?: string;
  stats?: Record<string, unknown> | null;
  projectId?: string;
}

const COST_STATS = (cost: number) => ({
  durationMs: 5000,
  totalCostUsd: cost,
  inputTokens: 1000,
  outputTokens: 500,
  numTurns: 3,
  model: "claude-opus",
  success: true,
});

/**
 * Seed one session (with its status/issue/workspace) attributed to `provider`,
 * incurring `cost` at `startedAt`. Cost comes from the session's `stats` JSON,
 * matching how the endpoint reads it.
 */
async function seedSession(db: TestDb, projectId: string, opts: SeedOpts = {}) {
  const now = new Date().toISOString();
  const startedAt = opts.startedAt ?? now;
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();

  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: Math.floor(Math.random() * 1e9), title: "T", priority: "medium",
    sortOrder: 0, statusId, projectId, issueType: "feature", createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak", workingDir: "/tmp/repo/.worktrees/ak",
    baseBranch: "main", isDirect: false, status: "closed",
    provider: opts.provider ?? null, claudeProfile: null,
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "completed",
    startedAt, endedAt: now, exitCode: "0",
    stats: opts.stats === undefined ? JSON.stringify(COST_STATS(0.1)) : opts.stats === null ? null : JSON.stringify(opts.stats),
  });
  return { workspaceId, sessionId };
}

async function getCostOverTime(db: TestDb, projectId: string, days = 30) {
  const app = createWorkspacesRoute(db);
  const res = await app.request(`/cost-over-time?projectId=${projectId}&days=${days}`);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ series: string[]; points: Array<{ date: string; costs: Record<string, number> }> }>;
}

const todayKey = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("GET /api/workspaces/cost-over-time (#509)", () => {
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

  it("sums cost per provider per day and stacks providers separately", async () => {
    await seedSession(db, projectId, { provider: "claude", stats: COST_STATS(0.1) });
    await seedSession(db, projectId, { provider: "claude", stats: COST_STATS(0.1) });
    await seedSession(db, projectId, { provider: "codex", stats: COST_STATS(0.05) });

    const body = await getCostOverTime(db, projectId, 7);
    const today = body.points.find((p) => p.date === todayKey());
    expect(today).toBeDefined();
    expect(today!.costs.claude).toBeCloseTo(0.2, 5);
    expect(today!.costs.codex).toBeCloseTo(0.05, 5);
    expect(body.series.sort()).toEqual(["claude", "codex"]);
  });

  it("returns a continuous date axis spanning the window", async () => {
    await seedSession(db, projectId, { provider: "claude", stats: COST_STATS(0.1) });

    const body = await getCostOverTime(db, projectId, 7);
    expect(body.points).toHaveLength(7);
    // Axis is contiguous UTC days ending today.
    expect(body.points.at(-1)!.date).toBe(todayKey());
    for (let i = 1; i < body.points.length; i++) {
      expect(body.points[i].date > body.points[i - 1].date).toBe(true);
    }
  });

  it("falls back to 'unknown' provider when the workspace has none", async () => {
    await seedSession(db, projectId, { provider: null, stats: COST_STATS(0.3) });

    const body = await getCostOverTime(db, projectId, 30);
    expect(body.series).toContain("unknown");
    const today = body.points.find((p) => p.date === todayKey());
    expect(today!.costs.unknown).toBeCloseTo(0.3, 5);
  });

  it("excludes sessions outside the requested window", async () => {
    await seedSession(db, projectId, { provider: "claude", startedAt: daysAgoIso(30), stats: COST_STATS(5) });
    await seedSession(db, projectId, { provider: "codex", stats: COST_STATS(0.05) });

    const body = await getCostOverTime(db, projectId, 7);
    // Old claude session is outside the 7-day window: not in series, no cost.
    expect(body.series).not.toContain("claude");
    expect(body.series).toContain("codex");
  });

  it("isolates by projectId (other projects' sessions are ignored)", async () => {
    const otherProjectId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(projects).values({
      id: otherProjectId, name: "Other", repoPath: "/tmp/other", repoName: "other",
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    await seedSession(db, otherProjectId, { provider: "claude", stats: COST_STATS(99) });
    await seedSession(db, projectId, { provider: "claude", stats: COST_STATS(0.1) });

    const body = await getCostOverTime(db, projectId, 7);
    const today = body.points.find((p) => p.date === todayKey());
    expect(today!.costs.claude).toBeCloseTo(0.1, 5);
  });

  it("treats missing stats and zero-cost sessions as $0", async () => {
    await seedSession(db, projectId, { provider: "claude", stats: null });
    await seedSession(db, projectId, { provider: "codex", stats: COST_STATS(0) });
    await seedSession(db, projectId, { provider: "claude", stats: COST_STATS(0.2) });

    const body = await getCostOverTime(db, projectId, 7);
    const today = body.points.find((p) => p.date === todayKey());
    expect(today!.costs.claude).toBeCloseTo(0.2, 5);
    expect(today!.costs.codex).toBe(0);
  });
});
