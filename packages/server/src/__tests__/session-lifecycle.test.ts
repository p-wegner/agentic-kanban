import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, sessions, agentSkills } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createMockProc } from "./helpers/mocks.js";
import { createSessionState } from "../services/session-manager/types.js";
import { createSessionLifecycle, type AgentService } from "../services/session-manager/session-lifecycle.js";
import type { AgentOutputCallback } from "../services/agent.service.js";

/**
 * Unit tests for the session lifecycle using an in-memory SQLite DB plus an
 * injected fake agent service. No real subprocess spawn (no vi.mock of
 * node:child_process) — the process factory is injected.
 */

/**
 * Seed a project + issue + an active worktree workspace; returns the workspace id.
 * Pass `skill` to attach an agent skill to the workspace.
 */
async function seedWorkspace(
  db: TestDb,
  skill?: { id: string; name: string },
): Promise<string> {
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
  if (skill) {
    await db.insert(agentSkills).values({
      id: skill.id, name: skill.name, description: "d", prompt: "p",
      createdAt: now, updatedAt: now,
    });
  }
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-1", workingDir: "/tmp/repo/.worktrees/ak-1",
    baseBranch: "main", isDirect: false, status: "active", provider: "claude",
    skillId: skill?.id ?? null,
    createdAt: now, updatedAt: now,
  });
  return workspaceId;
}

/**
 * Build a fake agent service. `launch` records the onOutput callback so tests can
 * later drive lifecycle events (e.g. fire an "exit") deterministically.
 */
function createFakeAgentService(): { service: AgentService; getOnOutput: () => AgentOutputCallback | undefined } {
  let captured: AgentOutputCallback | undefined;
  const service = {
    launch: vi.fn((_dir, _sid, _prompt, _args, onOutput: AgentOutputCallback) => {
      captured = onOutput;
      return createMockProc();
    }),
    kill: vi.fn(() => true),
    closeStdin: vi.fn(() => true),
    getProcess: vi.fn(() => undefined),
    sendInput: vi.fn(() => true),
    isPidAlive: vi.fn(() => true),
  } as unknown as AgentService;
  return { service, getOnOutput: () => captured };
}

/** Flush pending microtasks so fire-and-forget DB writes (`.catch()`) settle. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("session-lifecycle", () => {
  let db: TestDb;

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("startSession inserts a running session row and launches the agent process", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();
    const broadcast = vi.fn();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, broadcast, { db, agentService });

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });

    expect(sessionId).toBeTruthy();
    expect(agentService.launch).toHaveBeenCalledOnce();
    // The agent runs in the workspace's working directory
    const launchArgs = (agentService.launch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(launchArgs[0]).toBe("/tmp/repo/.worktrees/ak-1");

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
    expect(rows[0].workspaceId).toBe(workspaceId);
  });

  it("records the workspace's skill (id + snapshotted name) on the session row", async () => {
    const skill = { id: randomUUID(), name: "code-review" };
    const workspaceId = await seedWorkspace(db, skill);
    const { service: agentService } = createFakeAgentService();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService });
    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].skillId).toBe(skill.id);
    expect(rows[0].skillName).toBe("code-review");
  });

  it("leaves skill fields null when the workspace has no skill", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();

    const lifecycle = createSessionLifecycle(createSessionState(), undefined, vi.fn(), { db, agentService });
    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].skillId).toBeNull();
    expect(rows[0].skillName).toBeNull();
  });

  it("marks the session completed and fires onSessionExit when the process exits cleanly", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const onSessionExit = vi.fn();
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(
      state,
      { onSessionExit },
      vi.fn(),
      { db, agentService },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it" });
    state.sessionSubstantiveOutput.add(sessionId);

    // Drive the exit event the way agent.service would
    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({ type: "exit", exitCode: 0 } as never);

    await flush();

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].status).toBe("completed");
    expect(rows[0].exitCode).toBe("0");
    expect(onSessionExit).toHaveBeenCalledWith(workspaceId, sessionId, 0, undefined);
  });

  it("marks a fast provider exit with no model output as a stopped launch failure", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService, getOnOutput } = createFakeAgentService();
    const onSessionExit = vi.fn();

    const lifecycle = createSessionLifecycle(
      createSessionState(),
      { onSessionExit },
      vi.fn(),
      { db, agentService },
    );

    const sessionId = await lifecycle.startSession({ workspaceId, prompt: "do it", provider: "codex" });

    const onOutput = getOnOutput();
    expect(onOutput).toBeDefined();
    onOutput!({ type: "exit", exitCode: 0 } as never);

    await flush();

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0].status).toBe("stopped");
    expect(rows[0].exitCode).toBe("1");
    const stats = JSON.parse(rows[0].stats!);
    expect(stats.launchFailure).toBe(true);
    expect(stats.success).toBe(false);
    expect(stats.numTurns).toBe(0);
    expect(stats.agentSummary).toContain("provider process exited");

    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsRows[0].status).toBe("idle");
    expect(onSessionExit).toHaveBeenCalledWith(workspaceId, sessionId, 1, undefined);
  });

  it("marks the session stopped and rethrows when the agent fails to launch", async () => {
    const workspaceId = await seedWorkspace(db);
    const { service: agentService } = createFakeAgentService();
    (agentService.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
    });
    const state = createSessionState();

    const lifecycle = createSessionLifecycle(state, undefined, vi.fn(), { db, agentService });

    await expect(lifecycle.startSession({ workspaceId, prompt: "do it" })).rejects.toThrow("spawn ENOENT");

    // A row was inserted before launch; on failure it is flipped to "stopped"
    const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("stopped");
    // In-memory zombie state was cleaned up
    expect(state.sessionContexts.size).toBe(0);
  });
});
