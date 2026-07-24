import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  projects,
  projectStatuses,
  issues,
  workspaces,
  sessions,
  preferences,
  diffComments,
} from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockProc } from "./helpers/mocks.js";
import { createSessionState } from "../services/session-manager/types.js";
import { createSessionLifecycle, type AgentService } from "../services/session-manager/session-lifecycle.js";
import type { AgentOutputCallback } from "../services/agent.service.js";
import type { workspaceLaunchPreflight } from "../services/preflight-check.js";
import { WorkspaceError } from "../services/workspace-internals.js";

/**
 * #160: containerization prerequisite failures used to fall back to host
 * execution with only a console.warn. These tests exercise the surfaced
 * behavior end to end through the real session lifecycle + an in-memory DB:
 * a devcontainer declared but unprovisionable must (a) persist a downgrade
 * flag + reason onto the workspace, (b) post a workspace comment naming the
 * reason, and (c) in strict mode, refuse the launch instead.
 *
 * `hasDevcontainerConfig`/`devcontainerAvailable`/`devcontainerUp` are the
 * devcontainer CLI adapter — mocked so the "declared but the CLI cannot
 * provision it" prerequisite failure is deterministic in CI (no real Docker).
 */
const devcontainerAvailable = vi.fn(async () => false);
const devcontainerUp = vi.fn(async () => null);
vi.mock("@agentic-kanban/shared/lib/devcontainer-exec", () => ({
  hasDevcontainerConfig: () => true,
  devcontainerAvailable: (...args: unknown[]) => devcontainerAvailable(...args),
  devcontainerUp: (...args: unknown[]) => devcontainerUp(...args),
}));

async function seedWorkspace(db: TestDb): Promise<string> {
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
    id: issueId, issueNumber: 1, title: "T", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/tmp/repo/.worktrees/ak-1",
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

function createFakeAgentService(): AgentService {
  return {
    launch: vi.fn(() => createMockProc()),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput: vi.fn(() => true),
    isPidAlive: vi.fn(() => true),
  } as unknown as AgentService;
}

function okPreflight(): typeof workspaceLaunchPreflight {
  return vi.fn(async () => ({ ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] })) as unknown as typeof workspaceLaunchPreflight;
}

async function flush(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    if (await predicate()) return;
  }
}

describe("session-lifecycle — isolation downgrade (#160)", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
    devcontainerAvailable.mockReset().mockResolvedValue(false);
    devcontainerUp.mockReset().mockResolvedValue(null);
  });

  it("a provisioning failure persists the downgrade flag + reason and posts a workspace comment", async () => {
    const workspaceId = await seedWorkspace(db);
    const now = new Date().toISOString();
    await db.insert(preferences).values({ key: "devcontainer_builders", value: "true", updatedAt: now });

    const agentService = createFakeAgentService();
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    expect(sessionId).toBeTruthy();
    expect(agentService.launch).toHaveBeenCalledOnce();

    await flush(async () => {
      const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      return rows[0]?.isolationDowngraded === true;
    });

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].isolationDowngraded).toBe(true);
    expect(wsRows[0].isolationDowngradeReason).toMatch(/devcontainers\/cli/i);

    const comments = await db.select().from(diffComments).where(eq(diffComments.workspaceId, workspaceId));
    expect(comments).toHaveLength(1);
    expect(comments[0].filePath).toBe(".devcontainer-isolation");
    expect(comments[0].body).toMatch(/Isolation downgrade/i);
    expect(comments[0].body).toMatch(/devcontainers\/cli/i);
  });

  it("strict mode refuses the launch instead of falling back to the host", async () => {
    const workspaceId = await seedWorkspace(db);
    const now = new Date().toISOString();
    await db.insert(preferences).values({ key: "devcontainer_builders", value: "true", updatedAt: now });
    await db.insert(preferences).values({ key: "devcontainer_strict", value: "true", updatedAt: now });

    const agentService = createFakeAgentService();
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    await expect(lifecycle.startSession({ workspaceId, prompt: "do it" })).rejects.toThrow(WorkspaceError);
    expect(agentService.launch).not.toHaveBeenCalled();

    // The session row inserted before provisioning must not linger as "running".
    const sessionRows = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0].status).toBe("stopped");

    // Strict mode refuses rather than silently falling back — no downgrade flag is set.
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].isolationDowngraded).toBe(false);
  });

  it("no downgrade when the feature is off (the default)", async () => {
    const workspaceId = await seedWorkspace(db);
    const agentService = createFakeAgentService();
    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService, preflight: okPreflight() });

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    expect(sessionId).toBeTruthy();
    expect(devcontainerAvailable).not.toHaveBeenCalled();

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].isolationDowngraded).toBe(false);
    const comments = await db.select().from(diffComments).where(eq(diffComments.workspaceId, workspaceId));
    expect(comments).toHaveLength(0);
  });
});
