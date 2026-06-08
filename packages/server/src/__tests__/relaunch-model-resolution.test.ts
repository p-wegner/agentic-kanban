import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createWorkspaceSessionService } from "../services/workspace-session.service.js";

/**
 * Regression tests for #698: relaunch reuses baked-in model instead of re-reading
 * the current default_model preference.
 *
 * The bug: POST /api/workspaces/:id/launch passed no model to startSession, so
 * session-lifecycle fell back to workspace.model (captured at creation). Clearing or
 * changing the default_model pref had no effect until the workspace was deleted and
 * recreated.
 *
 * The fix: launchSession now re-reads default_model on every relaunch.
 */

async function seedWorkspace(
  db: TestDb,
  opts: { bakedModel?: string | null; provider?: string } = {},
): Promise<{ workspaceId: string; projectId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const statusId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "P", repoPath: "/tmp/repo", repoName: "repo",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Progress", sortOrder: 0, isDefault: true, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 1, title: "Fix bug", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1-fix",
    workingDir: "/tmp/repo/.worktrees/fix",
    baseBranch: "main", isDirect: false, status: "idle",
    provider: opts.provider ?? "claude",
    model: opts.bakedModel !== undefined ? opts.bakedModel : "old-model",
    createdAt: now, updatedAt: now,
  });

  return { workspaceId, projectId };
}

describe("relaunch model resolution (#698)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("picks up the current default_model pref instead of the workspace's baked-in model", async () => {
    const { workspaceId } = await seedWorkspace(db, { bakedModel: "old-baked-model" });
    // Simulate user having cleared the old pref and set a new one
    await db.insert(preferences).values({ key: "default_model", value: "claude-opus-4-5" });

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
    });

    await service.launchSession(workspaceId);

    const startCall = (sessionManager.startSession as ReturnType<typeof import("vitest").vi.fn>).mock.calls[0][0];
    expect(startCall.model).toBe("claude-opus-4-5");
  });

  it("uses no model when default_model pref is cleared (not baked-in model)", async () => {
    // Workspace was created with gpt-5.5 baked in while using codex, then user switched to claude
    // and cleared default_model — relaunch should NOT pass gpt-5.5 to claude
    const { workspaceId } = await seedWorkspace(db, { bakedModel: "gpt-5.5", provider: "claude" });
    // No default_model pref set (cleared)

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
    });

    await service.launchSession(workspaceId);

    const startCall = (sessionManager.startSession as ReturnType<typeof import("vitest").vi.fn>).mock.calls[0][0];
    // model should be undefined (session-lifecycle will use provider default, not baked-in gpt-5.5)
    expect(startCall.model).toBeUndefined();
  });

  it("drops a cross-provider model id from the pref to prevent failed launches (#696)", async () => {
    // User has default_model=gpt-5.5 leftover from codex but workspace provider is claude
    const { workspaceId } = await seedWorkspace(db, { bakedModel: null, provider: "claude" });
    await db.insert(preferences).values({ key: "default_model", value: "gpt-5.5" });

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
    });

    await service.launchSession(workspaceId);

    const startCall = (sessionManager.startSession as ReturnType<typeof import("vitest").vi.fn>).mock.calls[0][0];
    // gpt-5.5 is not a claude model — must be dropped, not forwarded
    expect(startCall.model).toBeUndefined();
  });

  it("respects a model passed explicitly in the request body", async () => {
    const { workspaceId } = await seedWorkspace(db, { bakedModel: "old-model" });
    await db.insert(preferences).values({ key: "default_model", value: "claude-haiku-4-5-20251001" });

    const sessionManager = createMockSessionManager();
    const service = createWorkspaceSessionService({
      database: db,
      getSessionManager: () => sessionManager,
    });

    await service.launchSession(workspaceId, { model: "claude-opus-4-8" });

    const startCall = (sessionManager.startSession as ReturnType<typeof import("vitest").vi.fn>).mock.calls[0][0];
    expect(startCall.model).toBe("claude-opus-4-8");
  });
});
