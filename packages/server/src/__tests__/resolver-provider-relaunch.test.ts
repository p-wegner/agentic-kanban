/**
 * Unit tests for #762: a relaunched resolver session (fix-and-merge / conflict
 * resolver / batch reconciler) must honor the board's CURRENT default provider
 * (Strategy Bullseye) at launch time, not the provider baked into the workspace
 * record at original creation.
 *
 * Covers `resolveRelaunchAgentSelection`, the helper both relaunch paths now call
 * instead of `applyWorkspaceAgentSelection(loadAgentSettings(...))`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { resolveRelaunchAgentSelection } from "../services/workspace-internals.js";
import type { ProviderProfilePolicy } from "../services/strategy-objective.service.js";

function policy(provider: "claude" | "codex" | "copilot", profileName: string): ProviderProfilePolicy {
  return {
    id: `${provider}:${profileName}`,
    provider,
    profileName,
    label: `${provider} (${profileName})`,
    mode: "fill",
    headroomPct: 0,
  };
}

/** Seed a project + issue + workspace with a baked-in provider/profile. */
async function seed(
  db: ReturnType<typeof createTestDb>["db"],
  baked: { provider: string | null; claudeProfile: string | null },
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 762,
    title: "Test issue",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-762-test",
    workingDir: "/repo/.worktrees/feature_ak-762-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    provider: baked.provider,
    claudeProfile: baked.claudeProfile,
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, workspaceId };
}

async function setStrategy(
  db: ReturnType<typeof createTestDb>["db"],
  projectId: string,
  policies: ProviderProfilePolicy[],
) {
  await db.insert(preferences).values({
    key: `board_strategy_${projectId}`,
    value: JSON.stringify({ version: 1, providerPolicies: policies }),
  });
}

describe("resolveRelaunchAgentSelection — honors current board default (#762)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("overrides the workspace's baked provider with the current Strategy default", async () => {
    // Workspace was originally created under claude:zai, but the board default is now codex:default.
    const { projectId, workspaceId } = await seed(db, { provider: "claude", claudeProfile: "zai" });
    await setStrategy(db, projectId, [policy("codex", "default")]);

    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    const sel = await resolveRelaunchAgentSelection(db, projectId, ws);

    expect(sel.provider).toBe("codex");
    expect(sel.profile).toEqual({ provider: "codex", name: "default" });
    // codex must not inherit the stale claude profile
    expect(sel.claudeProfile).toBeUndefined();
  });

  it("resolves claude profile from the current Strategy default", async () => {
    const { projectId, workspaceId } = await seed(db, { provider: "codex", claudeProfile: null });
    await setStrategy(db, projectId, [policy("claude", "anth")]);

    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    const sel = await resolveRelaunchAgentSelection(db, projectId, ws);

    expect(sel.provider).toBe("claude");
    expect(sel.claudeProfile).toBe("anth");
    expect(sel.profile).toEqual({ provider: "claude", name: "anth" });
  });

  it("falls back to the workspace's baked provider when no Strategy is configured", async () => {
    // No board_strategy_<projectId> pref → relaunch should keep the baked provider (also
    // preserves an explicitly-pinned per-workspace provider).
    const { projectId, workspaceId } = await seed(db, { provider: "claude", claudeProfile: "zai" });

    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    const sel = await resolveRelaunchAgentSelection(db, projectId, ws);

    expect(sel.provider).toBe("claude");
    expect(sel.claudeProfile).toBe("zai");
  });

  it("falls back to the baked provider when the Strategy selects nothing", async () => {
    // Strategy exists but has no provider policies → selection is null → baked value used.
    const { projectId, workspaceId } = await seed(db, { provider: "codex", claudeProfile: null });
    await setStrategy(db, projectId, []);

    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    const sel = await resolveRelaunchAgentSelection(db, projectId, ws);

    expect(sel.provider).toBe("codex");
  });
});
