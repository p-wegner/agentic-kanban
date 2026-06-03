import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces, sessions } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createInsightsRoute } from "../routes/insights.js";

interface SeedOpts {
  provider?: string | null;
  claudeProfile?: string | null;
  wsStatus?: string;
  startedAt?: string;
  stats?: Record<string, unknown>;
}

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
    baseBranch: "main", isDirect: false, status: opts.wsStatus ?? "closed",
    provider: opts.provider ?? null, claudeProfile: opts.claudeProfile ?? null,
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: sessionId, workspaceId, executor: "claude-code", status: "completed",
    startedAt, endedAt: now, exitCode: "0",
    stats: opts.stats ? JSON.stringify(opts.stats) : null,
  });
  return { workspaceId, sessionId };
}

async function seedActiveWorkspace(db: TestDb, projectId: string, opts: SeedOpts = {}) {
  const now = new Date().toISOString();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: Math.floor(Math.random() * 1e9), title: "T", priority: "medium",
    sortOrder: 0, statusId, projectId, issueType: "feature", createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak", workingDir: "/tmp/repo/.worktrees/ak",
    baseBranch: "main", isDirect: false, status: opts.wsStatus ?? "active",
    provider: opts.provider ?? null, claudeProfile: opts.claudeProfile ?? null,
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

type ProviderProfileRow = {
  provider: string;
  profile: string;
  sessionCount: number;
  successCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  activeWorkspaceCount: number;
};

async function getByProviderProfile(db: TestDb, projectId: string): Promise<ProviderProfileRow[]> {
  const app = createInsightsRoute(db);
  const res = await app.request(`/?projectId=${projectId}&range=all`);
  expect(res.status).toBe(200);
  const body = await res.json() as { byProviderProfile: ProviderProfileRow[] };
  return body.byProviderProfile;
}

describe("insights by-provider-profile ledger (AK-354)", () => {
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

  const defaultStats = {
    durationMs: 5000,
    totalCostUsd: 0.1,
    inputTokens: 1000,
    outputTokens: 500,
    numTurns: 3,
    model: "claude-opus",
    success: true,
  };

  it("groups sessions by provider and profile", async () => {
    await seedSession(db, projectId, { provider: "claude", claudeProfile: "anth", stats: defaultStats });
    await seedSession(db, projectId, { provider: "claude", claudeProfile: "anth", stats: defaultStats });
    await seedSession(db, projectId, { provider: "codex", claudeProfile: null, stats: defaultStats });

    const rows = await getByProviderProfile(db, projectId);
    const claude = rows.find((r) => r.provider === "claude" && r.profile === "anth");
    const codex = rows.find((r) => r.provider === "codex");

    expect(claude).toBeDefined();
    expect(claude!.sessionCount).toBe(2);
    expect(claude!.totalCostUsd).toBeCloseTo(0.2);
    expect(claude!.totalInputTokens).toBe(2000);

    expect(codex).toBeDefined();
    expect(codex!.sessionCount).toBe(1);
    expect(codex!.profile).toBe("");
  });

  it("falls back to 'unknown' provider when workspace has no provider set", async () => {
    await seedSession(db, projectId, { provider: null, claudeProfile: null, stats: defaultStats });

    const rows = await getByProviderProfile(db, projectId);
    const unknown = rows.find((r) => r.provider === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.sessionCount).toBe(1);
  });

  it("counts active workspaces separately per provider/profile bucket", async () => {
    await seedSession(db, projectId, { provider: "claude", claudeProfile: "anth", stats: defaultStats });
    await seedActiveWorkspace(db, projectId, { provider: "claude", claudeProfile: "anth", wsStatus: "active" });
    await seedActiveWorkspace(db, projectId, { provider: "claude", claudeProfile: "anth", wsStatus: "fixing" });

    const rows = await getByProviderProfile(db, projectId);
    const claude = rows.find((r) => r.provider === "claude" && r.profile === "anth");
    expect(claude).toBeDefined();
    expect(claude!.activeWorkspaceCount).toBe(2);
  });

  it("includes active workspaces that have no sessions in range", async () => {
    await seedActiveWorkspace(db, projectId, { provider: "copilot", claudeProfile: null, wsStatus: "active" });

    const rows = await getByProviderProfile(db, projectId);
    const copilot = rows.find((r) => r.provider === "copilot");
    expect(copilot).toBeDefined();
    expect(copilot!.sessionCount).toBe(0);
    expect(copilot!.activeWorkspaceCount).toBe(1);
  });

  it("does not count closed workspaces as active", async () => {
    await seedSession(db, projectId, { provider: "claude", claudeProfile: "dev", wsStatus: "closed", stats: defaultStats });

    const rows = await getByProviderProfile(db, projectId);
    const claude = rows.find((r) => r.provider === "claude");
    expect(claude).toBeDefined();
    expect(claude!.activeWorkspaceCount).toBe(0);
    expect(claude!.sessionCount).toBe(1);
  });

  it("sorts by totalCostUsd descending by default", async () => {
    await seedSession(db, projectId, { provider: "codex", stats: { ...defaultStats, totalCostUsd: 0.05 } });
    await seedSession(db, projectId, { provider: "claude", claudeProfile: "anth", stats: { ...defaultStats, totalCostUsd: 0.5 } });

    const rows = await getByProviderProfile(db, projectId);
    expect(rows[0].provider).toBe("claude");
    expect(rows[1].provider).toBe("codex");
  });

  it("includes byProviderProfile in the response shape", async () => {
    const app = createInsightsRoute(db);
    const res = await app.request(`/?projectId=${projectId}&range=30d`);
    expect(res.status).toBe(200);
    const body = await res.json() as { byProviderProfile: unknown };
    expect(Array.isArray(body.byProviderProfile)).toBe(true);
  });
});
