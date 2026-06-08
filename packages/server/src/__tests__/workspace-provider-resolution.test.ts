/**
 * Regression tests for POST /api/workspaces provider-resolution — ticket #702.
 *
 * Observed bug: creating a workspace with only issueId+projectId (no profile/claudeProfile)
 * resolved provider=codex via the strategy-bullseye fallback even though the project pref
 * was provider=claude/anth — causing failed launches when codex was credit-exhausted.
 *
 * Covers:
 *   (a) explicit claudeProfile forces provider=claude regardless of global prefs
 *   (b) no profile override falls back to the project provider pref (provider=claude in
 *       global prefs), NOT a hardcoded or stale-strategy codex
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projects, projectStatuses, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceCrudService } from "../services/workspace-crud.service.js";

// Minimal git mock: only the calls needed for direct (isDirect=true) workspace creation.
function makeMinimalGit() {
  return {
    getCurrentBranch: vi.fn(async () => "master"),
    getHeadCommitSha: vi.fn(async () => "abc1234"),
    revParse: vi.fn(async () => "abc1234"),
    createWorktree: vi.fn(async (_repo: string, branch: string) => `/tmp/${branch}`),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    syncBranchToHead: vi.fn(async () => false),
    ensureOnBranch: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
  };
}

async function seedScenario(
  db: ReturnType<typeof createTestDb>["db"],
  prefs: Record<string, string> = {},
) {
  const now = new Date(Date.now() - 60_000).toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/tmp/test-repo",
    repoName: "test-repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "In Progress",
    isDefault: true,
    sortOrder: 0,
    createdAt: now,
  });

  await db.insert(issues).values({
    id: issueId,
    issueNumber: 1,
    title: "Test Issue",
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  for (const [key, value] of Object.entries(prefs)) {
    await db.insert(preferences).values({ key, value, updatedAt: now });
  }

  return { projectId, statusId, issueId };
}

describe("workspace provider resolution — ticket #702", () => {
  it("(a) explicit claudeProfile forces provider=claude even when global provider=codex", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedScenario(db, {
      provider: "codex",
      codex_profile: "ki14",
      claude_profile: "anth",
    });

    const svc = createWorkspaceCrudService({
      database: db as Parameters<typeof createWorkspaceCrudService>[0]["database"],
      gitService: makeMinimalGit() as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      isDirect: true,
      claudeProfile: "anth",
    });

    expect(result.provider).toBe("claude");
  });

  it("(b) no profile override uses global provider=claude pref, NOT codex", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedScenario(db, {
      provider: "claude",
      claude_profile: "anth",
    });

    const svc = createWorkspaceCrudService({
      database: db as Parameters<typeof createWorkspaceCrudService>[0]["database"],
      gitService: makeMinimalGit() as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      isDirect: true,
    });

    expect(result.provider).toBe("claude");
  });

  it("(b-codex) no profile override with global provider=codex resolves to codex", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedScenario(db, {
      provider: "codex",
      codex_profile: "ki14",
    });

    const svc = createWorkspaceCrudService({
      database: db as Parameters<typeof createWorkspaceCrudService>[0]["database"],
      gitService: makeMinimalGit() as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      isDirect: true,
    });

    expect(result.provider).toBe("codex");
  });

  it("explicit profile.provider=codex forces provider=codex regardless of global prefs", async () => {
    const { db } = createTestDb();
    const { issueId } = await seedScenario(db, {
      provider: "claude",
      claude_profile: "anth",
    });

    const svc = createWorkspaceCrudService({
      database: db as Parameters<typeof createWorkspaceCrudService>[0]["database"],
      gitService: makeMinimalGit() as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      isDirect: true,
      profile: { provider: "codex", name: "ki14" },
    });

    expect(result.provider).toBe("codex");
  });

  it("strategy with codex fill-policy overrides global provider=codex pref to codex", async () => {
    const { db } = createTestDb();
    const { issueId, projectId } = await seedScenario(db, {
      provider: "codex",
      codex_profile: "default",
    });

    const strategyWithCodex = JSON.stringify({
      version: 1,
      segments: [],
      providerPolicies: [{ provider: "codex", profileName: "ki14", mode: "fill" }],
    });
    const now = new Date().toISOString();
    await db.insert(preferences).values({ key: `board_strategy_${projectId}`, value: strategyWithCodex, updatedAt: now });

    const svc = createWorkspaceCrudService({
      database: db as Parameters<typeof createWorkspaceCrudService>[0]["database"],
      gitService: makeMinimalGit() as never,
    });

    const result = await svc.createWorkspace({
      issueId,
      isDirect: true,
    });

    expect(result.provider).toBe("codex");
  });
});
